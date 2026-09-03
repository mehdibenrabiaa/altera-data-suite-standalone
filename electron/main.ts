import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";

const BACKEND_PORT = 8756;
// dist-electron/main.js -> ../public/favicon.ico. Works in dev as-is (public/
// is served/present at the repo root); if packaging is ever added, whatever
// sets that up needs to make sure this file (or a platform-specific icon
// built from it) ships alongside the app.
const APP_ICON = path.join(__dirname, "../public/favicon.ico");
let backendProc: ChildProcess | null = null;
let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let isQuitting = false;

// Every secondary window below (Settings, Filter Builder, Browse) sets
// `modal: true` + `parent: win`, Electron's own declarative flag for
// "block input to the owner until this closes" -- but that flag alone
// doesn't reliably disable the parent's actual input in practice (a real,
// reproducible gap, confirmed live: the main window stayed fully
// clickable while a modal was open). `setEnabled()` is the same disable
// Windows' own native modal dialogs use, and doesn't depend on Electron's
// modal flag working correctly at all. Reference-counted since more than
// one of these can be open at once (e.g. Configure on one node, Browse on
// another) -- the main window should only re-enable once ALL of them are
// gone, not the first one that closes. Wired to each window's own native
// "show"/"hide" events (see setUpSecondaryModal below) rather than called
// at each individual .show()/.hide() call site, so it can't drift out of
// sync with the window's real visibility no matter how many places
// trigger a transition.
let openSecondaryModalCount = 0;
function onSecondaryModalShown() {
  openSecondaryModalCount++;
  win?.setEnabled(false);
}
function onSecondaryModalHidden() {
  openSecondaryModalCount = Math.max(0, openSecondaryModalCount - 1);
  if (openSecondaryModalCount === 0) win?.setEnabled(true);
}
function setUpSecondaryModal(secondaryWin: BrowserWindow) {
  secondaryWin.on("show", onSecondaryModalShown);
  secondaryWin.on("hide", onSecondaryModalHidden);
}

function startBackend() {
  const cwd = path.join(__dirname, "../backend");
  const venvPython = path.join(
    cwd,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  backendProc = spawn(
    venvPython,
    ["-m", "uvicorn", "app.main:app", "--port", String(BACKEND_PORT)],
    { cwd, stdio: "inherit" },
  );
}

// Loads one of the app's HTML entry points into `target` -- index.html
// (main window) and settings.html (Settings window, see vite.config.ts's
// multi-page build.rollupOptions.input) are genuinely separate Vite
// entries/bundles, not routes within a shared one, so each gets its own
// correct static <title> and never loads the other's dependency tree.
// `query` (e.g. `{ nodeId }`) is how a per-node window (Filter Builder's
// Configure dialog, Browse's viewer -- see createPerNodeWindowManager
// below) tells its own React tree which node it belongs to, available
// immediately on load with no IPC round-trip needed to learn it. Handled
// differently per branch since `target.loadURL` just wants it appended to
// the URL string, while `loadFile`'s own `query` option formats it onto
// the resulting `file://` URL correctly -- naively concatenating a "?..."
// onto the file PATH the way the dev branch does would make Node's
// path.join treat the query string as literal filename characters.
function loadAppInto(target: BrowserWindow, htmlFile = "index.html", query?: Record<string, string>) {
  if (process.env.VITE_DEV_SERVER_URL) {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
    target.loadURL(`${process.env.VITE_DEV_SERVER_URL}${htmlFile}${qs}`);
  } else {
    target.loadFile(path.join(__dirname, `../dist/${htmlFile}`), query ? { query } : undefined);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // The settings window now hides instead of closing (see settings:open),
  // so it stays in Electron's window list and window-all-closed would
  // otherwise never fire once the main window closes -- quit explicitly
  // instead of relying on that.
  win.on("closed", () => {
    win = null;
    app.quit();
  });

  loadAppInto(win, "index.html");
  if (process.env.VITE_DEV_SERVER_URL) {
    win.webContents.openDevTools();
  }
}

ipcMain.handle("dialog:openPdf", async () => {
  if (!win) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Open PDF File",
    filters: [{ name: "PDF Files", extensions: ["pdf"] }],
  });
  return canceled ? null : filePaths[0];
});

// The renderer can't fetch() a file:// URL (Chromium blocks it for a page
// loaded from http://localhost or a packaged file:// origin doesn't get CORS
// headers either) -- read the bytes here on the Node side instead.
ipcMain.handle("fs:readFileBase64", async (_event, filePath: string) => {
  const data = await fs.readFile(filePath);
  return data.toString("base64");
});

// Persisted preferences (Sample Mode, Schema Preview, etc.) -- a plain JSON
// file in the OS's per-app data directory, the standard place for this in
// Electron rather than e.g. localStorage (survives independently of any
// browsing-data semantics, human-inspectable, doesn't depend on which
// window/origin wrote it).
const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");

ipcMain.handle("settings:load", async () => {
  try {
    return JSON.parse(await fs.readFile(SETTINGS_FILE, "utf-8"));
  } catch {
    return null;
  }
});

// ── Settings window -- a real, separate native window (not an in-page
// modal), matching how most desktop apps present Preferences. The main
// window sends its current settings as `payload` when opening; the
// settings window echoes edited values back via "settings:save", which
// gets relayed on to the main window as "settings:applied" and written to
// SETTINGS_FILE so it's there again on the next launch.
// Last payload the main window handed over, kept so a freshly-loaded
// settings window can pull it once it's actually ready to receive it (see
// settings:request-init below) instead of racing did-finish-load, which can
// fire before React has mounted and registered any IPC listener -- a push
// sent at did-finish-load previously arrived before anyone was listening
// and was silently dropped, leaving the window permanently blank.
let lastSettingsPayload: unknown = null;

// Measured: creating a fresh BrowserWindow + mounting a fresh React+antd
// tree from scratch costs roughly a second end to end (new renderer
// process spawn plus antd's first-render style injection), even in a
// built/minified production bundle -- not a dev-mode artifact. Kept alive
// (hidden, not destroyed) after the first open instead of being torn down
// on every Save/Cancel/close, so every open after the first is instant --
// only `.show()`/focus, no new process or React mount.
ipcMain.handle("settings:open", (_event, payload: unknown) => {
  lastSettingsPayload = payload;
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send("settings:init", payload);
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    // Bumped from 460x620 (sized for the old single-page content) now that
    // Settings has 4 tabs -- About's hero banner and Activation's forms
    // need more room than Preferences alone did.
    width: 560,
    height: 680,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    parent: win ?? undefined,
    // True modal (needs a parent to mean anything) -- blocks input to the
    // main window until this one closes, matching a native Preferences
    // dialog rather than a floating auxiliary window.
    modal: true,
    title: "Settings",
    icon: APP_ICON,
    // Stay hidden until the page has actually painted its first frame --
    // without this the window appears immediately as a blank white
    // rectangle and only fills in once React mounts, which reads as slow
    // even when the underlying load is quick. Only matters for this first
    // creation; later reopens skip straight to a plain .show().
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });
  settingsWin.once("ready-to-show", () => {
    settingsWin?.show();
  });
  setUpSecondaryModal(settingsWin);
  // Hide instead of destroy on every close path -- native close button
  // included -- so the window and its already-mounted React tree stay warm
  // for the next open. Only actually closes when the whole app is quitting.
  settingsWin.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    settingsWin?.hide();
  });
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
  loadAppInto(settingsWin, "settings.html");
});

ipcMain.handle("settings:request-init", () => lastSettingsPayload);

ipcMain.on("settings:save", (_event, payload) => {
  win?.webContents.send("settings:applied", payload);
  settingsWin?.hide();
  // numPages is contextual to whichever PDF happens to be open, not a real
  // preference -- stripped before it hits disk.
  const { numPages: _numPages, ...persisted } = payload as { numPages: number; [key: string]: unknown };
  fs.writeFile(SETTINGS_FILE, JSON.stringify(persisted, null, 2)).catch((err) => {
    console.error("[settings] failed to persist:", err);
  });
});

ipcMain.on("settings:close", () => {
  settingsWin?.hide();
});

// ── Per-node windows (Filter Builder's Configure dialog, Browse's data
// viewer) -- same real-separate-window pattern as Settings above (not an
// in-page modal), but each NODE gets its own independent window, not one
// shared instance reused across every node of that kind. That single-
// shared-window design (still what Settings above uses, correctly --
// there's only ever one of those) was a real bug for these two: opening
// Configure on a second Filter Builder node silently replaced whatever
// the first node's window was showing instead of opening a second
// window, so you could never have two of them open side by side. Windows
// are still kept alive (hidden, not destroyed) on close for instant
// reopen, same reasoning as before -- just per-node now, keyed by nodeId
// in the Maps below. Actually destroyed (not just hidden) when the node
// itself is deleted (see node:deleted further down), since a deleted
// node's window can never be reopened and would otherwise leak forever.
function createPerNodeWindowManager(kind: "filterBuilder" | "browse" | "headerPromoter" | "merge" | "shiftColumns" | "cleaner" | "unique" | "columnEdit" | "changeType" | "regex" | "cascadeFill" | "export" | "unpivotColumns" | "pivotColumns" | "addColumn" | "conditionalColumn", opts: {
  width: number; height: number; minWidth: number; minHeight: number; title: string; htmlFile: string; icon?: string;
}) {
  const windows = new Map<string, BrowserWindow>();
  const lastPayloadByNode = new Map<string, unknown>();

  ipcMain.handle(`${kind}:open`, (_event, payload: { nodeId: string; [key: string]: unknown }) => {
    const { nodeId } = payload;
    lastPayloadByNode.set(nodeId, payload);
    const existing = windows.get(nodeId);
    if (existing && !existing.isDestroyed()) {
      existing.webContents.send(`${kind}:init`, payload);
      // `parent`-owned windows like these don't get their own taskbar
      // button on Windows, so once minimized there's nothing to click to
      // bring one back -- show() alone doesn't un-minimize, restore()
      // first or it stays minimized even though it's now "shown".
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    const newWin = new BrowserWindow({
      width: opts.width,
      height: opts.height,
      minWidth: opts.minWidth,
      minHeight: opts.minHeight,
      resizable: true,
      autoHideMenuBar: true,
      // Non-modal on purpose -- the user needs to keep editing the main
      // canvas (moving rectangles, comparing against other nodes) while
      // these stay open as reference/companion windows, not gate-keeping
      // dialogs like Settings. `parent` alone (no `modal`) still keeps
      // each one above the main window and closing/minimizing together,
      // without disabling the main window's own input.
      parent: win ?? undefined,
      title: opts.title,
      // Each node's own catalog icon (rasterized to PNG -- Electron's
      // nativeImage doesn't support SVG), matching Orange's own widget
      // windows using that widget's icon instead of the generic app one.
      icon: opts.icon ?? APP_ICON,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
      },
    });
    windows.set(nodeId, newWin);
    newWin.once("ready-to-show", () => {
      newWin.show();
    });
    newWin.on("close", (event) => {
      if (isQuitting) return;
      event.preventDefault();
      newWin.hide();
    });
    newWin.on("closed", () => {
      windows.delete(nodeId);
    });
    // `nodeId` in the URL is how the window's own React tree (see
    // FilterBuilderWindow.tsx/BrowseWindow.tsx) knows which node it
    // belongs to as soon as it loads -- available immediately, no IPC
    // round-trip needed just to learn it, and then passed right back as
    // the argument to request-init below.
    loadAppInto(newWin, opts.htmlFile, { nodeId });
  });

  ipcMain.handle(`${kind}:request-init`, (_event, nodeId: string) => lastPayloadByNode.get(nodeId) ?? null);

  ipcMain.on(`${kind}:close`, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.hide();
  });

  return {
    pushUpdate(payload: { nodeId: string; [key: string]: unknown }) {
      lastPayloadByNode.set(payload.nodeId, payload);
      const w = windows.get(payload.nodeId);
      if (w && !w.isDestroyed()) w.webContents.send(`${kind}:init`, payload);
    },
    closeForNode(nodeId: string) {
      const w = windows.get(nodeId);
      if (w && !w.isDestroyed()) w.destroy();
      windows.delete(nodeId);
      lastPayloadByNode.delete(nodeId);
    },
  };
}

// Nothing here persists to disk: applied params flow back to the main
// window (filterBuilder:applied) and live in `processorNodes`, already
// covered by the existing project save/open path -- no separate
// settings.json-style file needed.
const filterBuilderManager = createPerNodeWindowManager("filterBuilder", {
  width: 640, height: 640, minWidth: 520, minHeight: 420, title: "Configure Node", htmlFile: "filter-builder.html",
  icon: path.join(__dirname, "../public/node-icons/filter.png"),
});

// The one thing not covered by the generic open/request-init/close trio
// above -- Filter Builder round-trips edited params back to the main
// window on Apply; Browse (a pure viewer) never does.
ipcMain.on("filterBuilder:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("filterBuilder:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Browse (Orange's own Data Table widget, see nodeCatalog.ts's
// hasOutput: false) is a pure viewer -- there's nothing to edit or apply
// back to the main window, just open/reseed/close.
const browseManager = createPerNodeWindowManager("browse", {
  width: 820, height: 640, minWidth: 480, minHeight: 320, title: "Browse Data", htmlFile: "browse.html",
  icon: path.join(__dirname, "../public/node-icons/browse.png"),
});

// Header Promoter -- same "real Configure window, round-trips edited
// params back to the main window on Apply" shape as Filter Builder above.
const headerPromoterManager = createPerNodeWindowManager("headerPromoter", {
  width: 720, height: 620, minWidth: 560, minHeight: 420, title: "Configure Node", htmlFile: "header-promoter.html",
  icon: path.join(__dirname, "../public/node-icons/header_promoter.png"),
});

ipcMain.on("headerPromoter:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("headerPromoter:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Merge -- same real-Configure-window, round-trips-on-Apply shape as
// Filter Builder/Header Promoter above.
const mergeManager = createPerNodeWindowManager("merge", {
  width: 640, height: 560, minWidth: 520, minHeight: 420, title: "Configure Node", htmlFile: "merge.html",
  icon: path.join(__dirname, "../public/node-icons/merge.png"),
});

ipcMain.on("merge:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("merge:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Shift Columns -- same real-Configure-window, round-trips-on-Apply shape
// as Filter Builder/Header Promoter/Merge above.
const shiftColumnsManager = createPerNodeWindowManager("shiftColumns", {
  width: 480, height: 560, minWidth: 420, minHeight: 420, title: "Configure Node", htmlFile: "shift-columns.html",
  icon: path.join(__dirname, "../public/node-icons/multishift.png"),
});

ipcMain.on("shiftColumns:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("shiftColumns:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Cleaner -- same real-Configure-window, round-trips-on-Apply shape as
// Filter Builder/Header Promoter/Merge/Shift Columns above.
const cleanerManager = createPerNodeWindowManager("cleaner", {
  width: 720, height: 640, minWidth: 560, minHeight: 420, title: "Configure Node", htmlFile: "cleaner.html",
  icon: path.join(__dirname, "../public/node-icons/cleaner.png"),
});

ipcMain.on("cleaner:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("cleaner:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Unique -- same real-Configure-window, round-trips-on-Apply shape as
// Filter Builder/Header Promoter/Merge/Shift Columns/Cleaner above.
const uniqueManager = createPerNodeWindowManager("unique", {
  width: 480, height: 620, minWidth: 420, minHeight: 460, title: "Configure Node", htmlFile: "unique.html",
  icon: path.join(__dirname, "../public/node-icons/deduplicator.png"),
});

ipcMain.on("unique:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("unique:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Column Edit -- same real-Configure-window, round-trips-on-Apply shape
// as Filter Builder/Header Promoter/Merge/Shift Columns/Cleaner/Unique
// above.
const columnEditManager = createPerNodeWindowManager("columnEdit", {
  width: 620, height: 680, minWidth: 480, minHeight: 420, title: "Configure Node", htmlFile: "column-edit.html",
  icon: path.join(__dirname, "../public/node-icons/column_manager.png"),
});

ipcMain.on("columnEdit:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("columnEdit:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Change Type -- same real-Configure-window, round-trips-on-Apply shape
// as Filter Builder/Header Promoter/Merge/Shift Columns/Cleaner/Unique/
// Column Edit above.
const changeTypeManager = createPerNodeWindowManager("changeType", {
  width: 480, height: 640, minWidth: 420, minHeight: 460, title: "Configure Node", htmlFile: "change-type.html",
  icon: path.join(__dirname, "../public/node-icons/change_type.png"),
});

ipcMain.on("changeType:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("changeType:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Regular Expressions -- same real-Configure-window, round-trips-on-
// Apply shape as Filter Builder/Header Promoter/Merge/Shift Columns/
// Cleaner/Unique/Column Edit/Change Type above. Wider than the others by
// default since its Configure window includes a live-preview grid.
const regexManager = createPerNodeWindowManager("regex", {
  width: 900, height: 640, minWidth: 640, minHeight: 420, title: "Configure Node", htmlFile: "regex.html",
  icon: path.join(__dirname, "../public/node-icons/regex.png"),
});

ipcMain.on("regex:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("regex:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Cascade Fill -- same real-Configure-window, round-trips-on-Apply shape
// as Filter Builder/Header Promoter/Merge/Shift Columns/Cleaner/Unique/
// Column Edit/Change Type/Regex above. No dedicated node-icon PNG exists
// yet (only public/node-icons/cascade_fill.svg, and nativeImage doesn't
// support SVG -- see the icon option's own comment above), so this one
// falls back to the generic APP_ICON like every other opts.icon-less
// manager already does.
const cascadeFillManager = createPerNodeWindowManager("cascadeFill", {
  width: 480, height: 640, minWidth: 420, minHeight: 460, title: "Configure Node", htmlFile: "cascade-fill.html",
});

ipcMain.on("cascadeFill:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("cascadeFill:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Export -- same real-Configure-window, round-trips-on-Apply shape as
// every other Configure window above, but the one sink node: Apply saves
// where/how to write, the actual file(s) only get written when the node
// is Run (backend/app/nodes.py's export_data), same as any other node's
// transform only running on Run, not on Apply.
const exportManager = createPerNodeWindowManager("export", {
  width: 520, height: 420, minWidth: 460, minHeight: 380, title: "Configure Node", htmlFile: "export.html",
  icon: path.join(__dirname, "../public/node-icons/excel_exporter.png"),
});

ipcMain.on("export:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("export:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Export's own two output-location pickers -- a single .xlsx FILE
// (multiple connected tables become multiple sheets within it) vs an
// existing FOLDER (a CSV can only hold one table, so a multi-table export
// writes one file per table into it) are genuinely different native
// dialogs, not just a filter difference, so each gets its own handler
// rather than one that branches on a passed-in format.
ipcMain.handle("export:chooseFile", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? win;
  if (!owner) return null;
  const { canceled, filePath } = await dialog.showSaveDialog(owner, {
    title: "Choose Export File",
    filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
    defaultPath: "Export.xlsx",
  });
  return canceled || !filePath ? null : filePath;
});

ipcMain.handle("export:chooseFolder", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? win;
  if (!owner) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
    title: "Choose Export Folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return canceled || filePaths.length === 0 ? null : filePaths[0];
});

// Unpivot Columns -- same real-Configure-window, round-trips-on-Apply
// shape as every other Configure window above.
const unpivotColumnsManager = createPerNodeWindowManager("unpivotColumns", {
  width: 480, height: 620, minWidth: 420, minHeight: 460, title: "Configure Node", htmlFile: "unpivot-columns.html",
  icon: path.join(__dirname, "../public/node-icons/unpivot.png"),
});

ipcMain.on("unpivotColumns:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("unpivotColumns:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Pivot Columns -- same real-Configure-window, round-trips-on-Apply
// shape as every other Configure window above.
const pivotColumnsManager = createPerNodeWindowManager("pivotColumns", {
  width: 460, height: 380, minWidth: 400, minHeight: 340, title: "Configure Node", htmlFile: "pivot-columns.html",
  icon: path.join(__dirname, "../public/node-icons/pivot.png"),
});

ipcMain.on("pivotColumns:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("pivotColumns:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Add Column -- same real-Configure-window, round-trips-on-Apply shape as
// every other Configure window above.
const addColumnManager = createPerNodeWindowManager("addColumn", {
  width: 520, height: 560, minWidth: 440, minHeight: 460, title: "Configure Node", htmlFile: "add-column.html",
  icon: path.join(__dirname, "../public/node-icons/formula.png"),
});

ipcMain.on("addColumn:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("addColumn:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Add Column (conditional) -- Power Query's own "Add Conditional Column",
// the low-code sibling of the formula-based Add Column above (now
// surfaced as "Formula"). Same real-Configure-window,
// round-trips-on-Apply shape as every other Configure window here.
const conditionalColumnManager = createPerNodeWindowManager("conditionalColumn", {
  width: 640, height: 640, minWidth: 520, minHeight: 460, title: "Configure Node", htmlFile: "conditional-column.html",
  icon: path.join(__dirname, "../public/node-icons/conditional_column.png"),
});

ipcMain.on("conditionalColumn:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("conditionalColumn:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Silent live refresh -- distinct from browse:open, which also shows/
// focuses the window (fine for an explicit double-click, but would
// annoyingly steal focus/pop the window to front every time this fires,
// which is on every upstream data change: a real Convert finishing, an
// upstream node re-running, etc.). Reported as a real bug otherwise:
// Convert a table while its Browse window is open, and the window kept
// showing stale data until manually closed and reopened. Reuses the same
// browse:init channel the window already listens to via onBrowseInit --
// from the window's own perspective this is indistinguishable from a
// reseed on open, just without the show()/focus().
ipcMain.on("browse:push-update", (_event, payload: { nodeId: string; [key: string]: unknown }) => {
  browseManager.pushUpdate(payload);
});

// Closes (for real -- see createPerNodeWindowManager's closeForNode)
// whichever of these per-node windows exist for the given node, if any --
// called once per deleted processor node (see App.tsx's
// handleDeleteProcessorNodes). Without this, deleting a node whose
// Configure/Browse window was open left that window sitting there
// showing a now-nonexistent node's stale data forever, with no way to
// tell it was orphaned and no way it could ever be reopened to replace.
ipcMain.on("node:deleted", (_event, nodeId: string) => {
  filterBuilderManager.closeForNode(nodeId);
  browseManager.closeForNode(nodeId);
  headerPromoterManager.closeForNode(nodeId);
  mergeManager.closeForNode(nodeId);
  shiftColumnsManager.closeForNode(nodeId);
  cleanerManager.closeForNode(nodeId);
  uniqueManager.closeForNode(nodeId);
  columnEditManager.closeForNode(nodeId);
  changeTypeManager.closeForNode(nodeId);
  regexManager.closeForNode(nodeId);
  cascadeFillManager.closeForNode(nodeId);
  exportManager.closeForNode(nodeId);
  unpivotColumnsManager.closeForNode(nodeId);
  pivotColumnsManager.closeForNode(nodeId);
  addColumnManager.closeForNode(nodeId);
  conditionalColumnManager.closeForNode(nodeId);
});

// Native File/Edit/View/Window/Help menu replaced by an in-page menu bar
// (see src/components/MenuBar.tsx) -- null removes it entirely, including
// the Alt-key mnemonic access that would otherwise still reveal it.
Menu.setApplicationMenu(null);

// ── Project save/open -- the custom menu bar's File > Save/Save As/Open.
// A project file is just the JSON blob App.tsx already builds (PDF path +
// rectangles/groups/guides/etc.); this process only owns the native
// dialogs and the actual disk I/O, same division as the settings.json /
// PDF-path handlers above.
const PROJECT_FILTERS = [{ name: "Altera Project", extensions: ["altera"] }];

ipcMain.handle("project:saveAs", async (_event, jsonData: string) => {
  if (!win) return null;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Save Project As",
    filters: PROJECT_FILTERS,
    defaultPath: "Untitled.altera",
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, jsonData, "utf-8");
  return filePath;
});

ipcMain.handle("project:saveToPath", async (_event, filePath: string, jsonData: string) => {
  await fs.writeFile(filePath, jsonData, "utf-8");
  return true;
});

ipcMain.handle("project:open", async () => {
  if (!win) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Open Project",
    filters: PROJECT_FILTERS,
    properties: ["openFile"],
  });
  if (canceled || !filePaths[0]) return null;
  const data = await fs.readFile(filePaths[0], "utf-8");
  return { path: filePaths[0], data };
});

// File > Restart -- relaunch schedules a fresh instance to start once this
// one fully quits; app.exit() (not quit()) skips waiting on any in-flight
// async work and forces that quit immediately. before-quit above still
// fires either way, so the backend process gets killed before the new
// instance starts its own.
ipcMain.on("app:restart", () => {
  app.relaunch();
  app.exit();
});

app.whenReady().then(() => {
  startBackend();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  backendProc?.kill();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  backendProc?.kill();
});
