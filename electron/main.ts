import { app, BrowserWindow, dialog, ipcMain, Menu, MenuItemConstructorOptions, session, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";

// Only one copy of this app should ever run at once -- a second launch
// would spawn its own backend process fighting the first one for the same
// hardcoded BACKEND_PORT below. If another instance already holds the
// lock, this one has nothing useful to do: hand off to it (see
// second-instance below) and exit immediately, before any of the
// backend/window/IPC setup further down even runs.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Windows uses this to group this app's windows under one taskbar icon/
// identity (jump lists, notifications, etc.) instead of falling back to
// Electron's own default id, which reads as "electron.app" everywhere.
app.setAppUserModelId("com.alteradatasuite.studio");

const BACKEND_PORT = 8756;
// Generated fresh every launch, never persisted -- required on every
// request to the local backend (enforced by backend/app/main.py's own
// middleware) so a malicious webpage open in the user's regular browser
// can't drive-by attack the backend just by knowing it listens on
// 127.0.0.1:8756 (a real risk: that backend has real side effects --
// writing files via Export, installing plugins, etc. -- and CORS alone
// doesn't stop a "blind" cross-origin request, only reading its response).
// Injected into every one of THIS app's own requests centrally via
// session.defaultSession.webRequest below, so no renderer code has to
// remember to add it -- it can't be forgotten or bypassed by a future
// fetch call site.
const LOCAL_TOKEN = crypto.randomBytes(32).toString("hex");
// dist-electron/main.js -> ../public/favicon.ico. Works in dev as-is (public/
// is served/present at the repo root); if packaging is ever added, whatever
// sets that up needs to make sure this file (or a platform-specific icon
// built from it) ships alongside the app.
const APP_ICON = path.join(__dirname, "../public/favicon.ico");
let backendProc: ChildProcess | null = null;
let win: BrowserWindow | null = null;
let splashWin: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let closeConfirmWin: BrowserWindow | null = null;
let updateCheckWin: BrowserWindow | null = null;
let isQuitting = false;
// Mirrored from App.tsx (see "app:theme-state" below) -- lets
// openCloseConfirmWindow open already in the right theme, since that
// window is created by main itself, not asked for by the renderer the
// way Settings/Filter Builder/etc. are.
let currentTheme: "light" | "dark" = "light";

// A second launch (see requestSingleInstanceLock above) still starts an
// Electron process briefly before hitting its own lock check and exiting
// -- this only fires in the FIRST (already-running) instance, telling it
// someone tried to open the app again. Surfacing the existing window
// (rather than silently doing nothing) is what every other single-
// instance desktop app does.
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// ── Unsaved-changes guard ───────────────────────────────────────────────
// App.tsx mirrors its own dirty flag here on every change (see
// "app:dirty-state" below) so the close handlers can check it
// synchronously instead of needing an async round-trip at close time.
let isDirty = false;
// Set right before deliberately re-closing the window after the user has
// already confirmed (via App.tsx's own themed prompt) that closing is
// fine -- lets the "close" handler tell "the user just said yes" apart
// from "a normal close with nothing unsaved", both of which should let it
// through.
let allowMainWindowClose = false;

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
  // Dev/unpackaged: __dirname is dist-electron/ at the project root, so
  // ../backend is the real backend/ folder. Packaged: dist-electron/ lives
  // inside resources/app.asar, which the backend (a raw Python venv, not
  // something that can be crammed into an asar) was never part of --
  // electron-builder's own extraResources instead copies it to
  // resources/backend, a sibling of app.asar, which is what
  // process.resourcesPath always points at.
  const cwd = app.isPackaged
    ? path.join(process.resourcesPath, "backend")
    : path.join(__dirname, "../backend");
  const venvPython = path.join(
    cwd,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  backendProc = spawn(
    venvPython,
    ["-m", "uvicorn", "app.main:app", "--port", String(BACKEND_PORT)],
    {
      cwd,
      stdio: "inherit",
      // Tells the backend where to look for installed plugins
      // (backend/app/plugins.py's PLUGIN_DIR) -- the same userData folder
      // WINDOW_STATE_FILE/SETTINGS_FILE already use below, so plugin
      // packages live alongside this app's other per-user data instead of
      // inside the install directory.
      env: { ...process.env, ALTERA_USER_DATA_DIR: app.getPath("userData"), ALTERA_LOCAL_TOKEN: LOCAL_TOKEN },
    },
  );
  // stdio: "inherit" sends the backend's own errors to this process's
  // console -- invisible in a packaged build, which has none. Without
  // this, a backend that fails to start (missing venv, port already in
  // use, ...) left the app just silently non-functional: every PDF/data
  // operation would hang or fail with no indication why.
  backendProc.on("error", (err) => {
    dialog.showErrorBox(
      "Backend failed to start",
      `Altera Data Suite's backend process could not be launched.\n\n${err.message}`,
    );
  });
  backendProc.on("exit", (code, signal) => {
    // isQuitting means this is the app's own normal shutdown killing it
    // (see before-quit below) -- not a crash.
    if (isQuitting) return;
    dialog.showErrorBox(
      "Backend stopped unexpectedly",
      `The backend process exited unexpectedly (code ${code ?? signal}). PDF conversion and other data operations won't work until the app is restarted.`,
    );
  });
}

// ── Main window size/position persistence ───────────────────────────────
// A plain JSON file in the OS's per-app data directory, same place/
// reasoning as settings.json elsewhere in this file -- every other
// desktop app remembers where you left its window, rather than always
// reopening at a fixed 1440x900.
const WINDOW_STATE_FILE = path.join(app.getPath("userData"), "window-state.json");
interface WindowState { width: number; height: number; x?: number; y?: number; isMaximized: boolean }
const DEFAULT_WINDOW_STATE: WindowState = { width: 1440, height: 900, isMaximized: false };

function loadWindowState(): WindowState {
  try {
    const raw = JSON.parse(readFileSync(WINDOW_STATE_FILE, "utf-8"));
    if (typeof raw.width === "number" && typeof raw.height === "number") {
      return { ...DEFAULT_WINDOW_STATE, ...raw };
    }
  } catch {
    // First launch, or a corrupt/missing file -- fall back to defaults.
  }
  return DEFAULT_WINDOW_STATE;
}

function saveWindowState(target: BrowserWindow) {
  const isMaximized = target.isMaximized();
  // getBounds() while maximized reports the maximized size itself, which
  // would make the NEXT launch open pre-sized to fill the screen even if
  // later un-maximized -- getNormalBounds() keeps the pre-maximize size
  // so restoring works the way it would if the user un-maximized by hand.
  const bounds = isMaximized ? target.getNormalBounds() : target.getBounds();
  try {
    writeFileSync(WINDOW_STATE_FILE, JSON.stringify({ ...bounds, isMaximized }));
  } catch {
    // Best-effort -- losing the remembered size/position isn't worth
    // surfacing an error over.
  }
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

// Frameless, chromeless splash shown the instant the app launches --
// index.html itself takes a beat to load (esp. the first paint of the
// full PDF/canvas UI), and without this the app looked like it hadn't
// started at all for that window. A fully static page (see
// public/splash.html) rather than a React entry -- nothing on it needs
// state or IPC, so it doesn't need Vite's multi-page build/bundling at
// all, just plain loadAppInto like every other window here.
const SPLASH_MIN_VISIBLE_MS = 5000;
let splashShownAt = 0;

function createSplashWindow() {
  splashWin = new BrowserWindow({
    width: 440,
    height: 300,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    show: false,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });
  splashWin.once("ready-to-show", () => {
    splashShownAt = Date.now();
    splashWin?.show();
  });
  splashWin.on("closed", () => {
    splashWin = null;
  });
  loadAppInto(splashWin, "splash.html");
}

// Closes the splash and reveals the main window, but never before the
// splash has been on screen for SPLASH_MIN_VISIBLE_MS -- on a fast
// machine index.html can be ready in well under a second, which made the
// splash flash by too quickly to actually read.
function finishSplash() {
  const elapsed = Date.now() - splashShownAt;
  const remaining = Math.max(0, SPLASH_MIN_VISIBLE_MS - elapsed);
  setTimeout(() => {
    win?.show();
    if (splashWin && !splashWin.isDestroyed()) splashWin.close();
  }, remaining);
}

// Unsaved-changes prompt -- a real native window (CloseConfirmWindow.tsx),
// styled like every other Configure window instead of a plain OS message
// box, per the same modal/setUpSecondaryModal pattern Settings uses below.
// Opened directly by the "close" handler (not asked for by the renderer
// the way every other secondary window here is), so it also has to pass
// its own theme along explicitly (see currentTheme above) rather than
// pulling it from an "open" payload.
function openCloseConfirmWindow() {
  if (closeConfirmWin && !closeConfirmWin.isDestroyed()) {
    closeConfirmWin.focus();
    return;
  }
  closeConfirmWin = new BrowserWindow({
    width: 420,
    height: 170,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    parent: win ?? undefined,
    modal: true,
    title: "Altera Data Suite",
    icon: APP_ICON,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });
  closeConfirmWin.once("ready-to-show", () => closeConfirmWin?.show());
  setUpSecondaryModal(closeConfirmWin);
  closeConfirmWin.on("closed", () => {
    closeConfirmWin = null;
  });
  loadAppInto(closeConfirmWin, "close-confirm.html", { theme: currentTheme });
}

// File menu's "Check for Updates…" -- a small owned window (same shape as
// openCloseConfirmWindow above), not an inline status card in Settings,
// so checking for an update is a deliberate, visible action with its own
// focused result instead of something tucked away in a tab.
function openUpdateCheckWindow() {
  if (updateCheckWin && !updateCheckWin.isDestroyed()) {
    updateCheckWin.focus();
    return;
  }
  updateCheckWin = new BrowserWindow({
    width: 420,
    height: 190,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    parent: win ?? undefined,
    modal: true,
    title: "Check for Updates",
    icon: APP_ICON,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });
  updateCheckWin.once("ready-to-show", () => updateCheckWin?.show());
  setUpSecondaryModal(updateCheckWin);
  updateCheckWin.on("closed", () => {
    updateCheckWin = null;
  });
  loadAppInto(updateCheckWin, "update-check.html", { theme: currentTheme });
}

function createWindow() {
  const windowState = loadWindowState();
  win = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    icon: APP_ICON,
    // Stays hidden until index.html has actually painted its first frame
    // (see ready-to-show below) -- so the splash window above is the only
    // thing visible during that gap, instead of a blank white rectangle
    // appearing behind/before it.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });
  if (windowState.isMaximized) win.maximize();

  // Debounced (resize/move fire continuously while dragging) -- only the
  // settled size/position actually needs to hit disk.
  let saveWindowStateTimeout: ReturnType<typeof setTimeout> | null = null;
  const scheduleSaveWindowState = () => {
    if (saveWindowStateTimeout) clearTimeout(saveWindowStateTimeout);
    saveWindowStateTimeout = setTimeout(() => { if (win) saveWindowState(win); }, 500);
  };
  win.on("resize", scheduleSaveWindowState);
  win.on("move", scheduleSaveWindowState);

  // Unsaved-changes guard -- App.tsx mirrors its dirty flag to `isDirty`
  // above on every change (see "app:dirty-state" below). Without this,
  // closing the window (the X button, File > Exit's window.close(), or
  // Cmd+Q/native Quit by way of the before-quit handler further down) just
  // silently discarded any unsaved project edits, which no other desktop
  // app does. The actual Save/Don't Save/Cancel prompt is a real native
  // window (openCloseConfirmWindow above), styled like the rest of this
  // app rather than a plain OS message box.
  win.on("close", (event) => {
    if (win) saveWindowState(win);
    if (allowMainWindowClose || !isDirty) return;
    event.preventDefault();
    openCloseConfirmWindow();
  });

  // The settings window now hides instead of closing (see settings:open),
  // so it stays in Electron's window list and window-all-closed would
  // otherwise never fire once the main window closes -- quit explicitly
  // instead of relying on that.
  win.on("closed", () => {
    win = null;
    app.quit();
  });

  win.once("ready-to-show", finishSplash);

  loadAppInto(win, "index.html");
  if (process.env.VITE_DEV_SERVER_URL) {
    win.webContents.openDevTools();
  }
}

ipcMain.on("app:dirty-state", (_event, dirty: boolean) => {
  isDirty = dirty;
});

ipcMain.on("app:theme-state", (_event, theme: "light" | "dark") => {
  currentTheme = theme;
});

// CloseConfirmWindow.tsx's own Save/Don't Save/Cancel buttons all funnel
// through this one channel.
ipcMain.on("closeConfirm:choice", (_event, choice: "save" | "discard" | "cancel") => {
  if (choice === "cancel") {
    closeConfirmWin?.close();
    return;
  }
  if (choice === "discard") {
    closeConfirmWin?.close();
    allowMainWindowClose = true;
    win?.close();
    return;
  }
  // "save" -- handed to App.tsx (it owns the actual save logic, including
  // the Save-As dialog for a never-saved project); the confirm window
  // stays open showing "Saving…" until one of the two handlers below
  // tells it what happened.
  win?.webContents.send("app:save-before-close");
});

ipcMain.on("app:save-before-close-done", () => {
  closeConfirmWin?.close();
  allowMainWindowClose = true;
  win?.close();
});

ipcMain.on("app:save-before-close-failed", () => {
  closeConfirmWin?.webContents.send("closeConfirm:save-failed");
});

ipcMain.on("app:set-taskbar-progress", (_event, value: number) => {
  win?.setProgressBar(value);
});

ipcMain.handle("dialog:openPdf", async () => {
  if (!win) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Open PDF File",
    filters: [{ name: "PDF Files", extensions: ["pdf"] }],
  });
  return canceled ? null : filePaths[0];
});

// Input Data's own file picker -- same shape as dialog:openPdf above, but
// an openFile+filters dialog (not save) restricted to the formats
// backend/app/nodes.py's file_input actually knows how to read. Scoped to
// the Configure window itself (BrowserWindow.fromWebContents(event.sender))
// rather than always the main window, matching export:chooseFile/
// chooseFolder below -- this dialog is always triggered from Input Data's
// own per-node window, never the main one.
ipcMain.handle("inputData:chooseFile", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? win;
  if (!owner) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
    title: "Choose Data File",
    filters: [
      { name: "Excel/CSV Files", extensions: ["xlsx", "xls", "csv", "tsv"] },
      { name: "Excel Workbook", extensions: ["xlsx", "xls"] },
      { name: "CSV/TSV", extensions: ["csv", "tsv"] },
      { name: "All Files", extensions: ["*"] },
    ],
    properties: ["openFile"],
  });
  return canceled || filePaths.length === 0 ? null : filePaths[0];
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

// Widget Zoom (Appearance tab) -- Chromium's own native page zoom, the
// same mechanism as a browser's Ctrl+/Ctrl- (crisp at any factor, reflows
// layout rather than blurrily scaling a rendered bitmap). Distinct from the
// Canvas view's own PDF-page zoom, which is plain React state
// (App.tsx's `scale`) and never touches webContents at all. App.tsx sends
// this once on launch (with the persisted value) and again immediately on
// every Appearance-tab change, live-previewed before Save like theme is.
ipcMain.on("zoom:set", (_event, factor: number) => {
  win?.webContents.setZoomFactor(factor);
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
function createPerNodeWindowManager(kind: "filterBuilder" | "browse" | "summary" | "headerPromoter" | "merge" | "shiftColumns" | "cleaner" | "textParser" | "unique" | "columnEdit" | "changeType" | "regex" | "cascadeFill" | "export" | "unpivotColumns" | "pivotColumns" | "addColumn" | "conditionalColumn" | "inputData" | "sort" | "aggregate" | "pageFilter" | "pluginNode", opts: {
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

// Summary -- same pure-viewer shape as Browse above (nothing to edit/
// apply back), just a per-column stats/distribution view instead of a
// raw data grid.
const summaryManager = createPerNodeWindowManager("summary", {
  width: 720, height: 680, minWidth: 480, minHeight: 400, title: "Summary", htmlFile: "summary.html",
  icon: path.join(__dirname, "../public/node-icons/summary.png"),
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

// Text Parser -- same real-Configure-window, round-trips-on-Apply shape
// as Cleaner above.
const textParserManager = createPerNodeWindowManager("textParser", {
  width: 720, height: 640, minWidth: 560, minHeight: 420, title: "Configure Node", htmlFile: "text-parser.html",
  icon: path.join(__dirname, "../public/node-icons/text_parser.png"),
});

ipcMain.on("textParser:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("textParser:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Input Data -- same real-Configure-window, round-trips-on-Apply shape as
// every other Configure window above. The one thing genuinely different
// from the rest: this is the catalog's only graph SOURCE node (no upstream
// table -- see backend/app/nodes.py's file_input and nodeCatalog.ts's
// `hasInput: false`), so its Configure window is also the ONLY place its
// data ever originates, not just a settings dialog for an already-flowing
// table.
const inputDataManager = createPerNodeWindowManager("inputData", {
  width: 560, height: 420, minWidth: 480, minHeight: 360, title: "Configure Node", htmlFile: "input-data.html",
  icon: path.join(__dirname, "../public/node-icons/input_data.png"),
});

ipcMain.on("inputData:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("inputData:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Sort -- same real-Configure-window, round-trips-on-Apply shape as every
// other Configure window above.
const sortManager = createPerNodeWindowManager("sort", {
  width: 560, height: 560, minWidth: 480, minHeight: 420, title: "Configure Node", htmlFile: "sort.html",
  icon: path.join(__dirname, "../public/node-icons/sort.png"),
});

const pageFilterManager = createPerNodeWindowManager("pageFilter", {
  width: 460, height: 340, minWidth: 400, minHeight: 300, title: "Configure Node", htmlFile: "page-filter.html",
  icon: path.join(__dirname, "../public/node-icons/filter.png"),
});

ipcMain.on("pageFilter:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("pageFilter:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

ipcMain.on("sort:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("sort:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// Aggregate -- same real-Configure-window, round-trips-on-Apply shape as
// every other Configure window above.
const aggregateManager = createPerNodeWindowManager("aggregate", {
  width: 920, height: 680, minWidth: 760, minHeight: 520, title: "Configure Node", htmlFile: "aggregate.html",
  icon: path.join(__dirname, "../public/node-icons/aggregate.png"),
});

ipcMain.on("aggregate:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("aggregate:applied", payload);
  BrowserWindow.fromWebContents(event.sender)?.hide();
});

// The one shared Configure window for every plugin node -- unlike every
// built-in node above, this ISN'T one manager per node kind: PluginNodeWindow.tsx
// renders a form purely from whatever manifest/fields payload openPluginNodeWindow
// was called with, so a newly installed plugin needs zero new code here.
// No per-kind icon (opts.icon omitted -- falls back to APP_ICON) since a
// plugin's own icon is an SVG served by the backend, and this window's OS
// icon can only be a rasterized PNG/ICO shipped with the app itself.
const pluginNodeManager = createPerNodeWindowManager("pluginNode", {
  width: 480, height: 560, minWidth: 400, minHeight: 380, title: "Configure Node", htmlFile: "plugin-node.html",
});

ipcMain.on("pluginNode:apply", (event, payload: { nodeId: string; [key: string]: unknown }) => {
  win?.webContents.send("pluginNode:applied", payload);
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

ipcMain.on("summary:push-update", (_event, payload: { nodeId: string; [key: string]: unknown }) => {
  summaryManager.pushUpdate(payload);
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
  textParserManager.closeForNode(nodeId);
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
  summaryManager.closeForNode(nodeId);
  inputDataManager.closeForNode(nodeId);
  sortManager.closeForNode(nodeId);
  pageFilterManager.closeForNode(nodeId);
  aggregateManager.closeForNode(nodeId);
  pluginNodeManager.closeForNode(nodeId);
});

// Windows/Linux: keep the in-page menu bar (src/panels/MenuBar.tsx) --
// null removes the native one entirely, including the Alt-key mnemonic
// access that would otherwise still reveal it. macOS: users expect a real
// menu bar at the top of the screen (and Cmd+Q/Cmd+H/etc. to just work),
// so it gets a native one instead -- App.tsx skips rendering its own
// in-page MenuBar there (see its isMac check) to avoid showing both.
// Each item forwards its action to the renderer over IPC rather than
// duplicating App.tsx's actual handler logic here.
function sendMenuAction(action: string) {
  win?.webContents.send("menu:action", action);
}

function buildNativeMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "Cmd+,", click: () => sendMenuAction("settings") },
        { label: "Check for Updates…", click: () => triggerUpdateCheck() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Open Project…", click: () => sendMenuAction("open-project") },
        // macOS's own built-in recent-documents list (fed by
        // app.addRecentDocument, see addRecentProject above) -- unlike
        // Windows/Linux's in-page MenuBar.tsx submenu, macOS has a native
        // role for this that needs no manual list-building here.
        { label: "Open Recent", role: "recentDocuments", submenu: [{ label: "Clear Menu", role: "clearRecentDocuments" }] },
        { label: "Save", accelerator: "Cmd+S", click: () => sendMenuAction("save-project") },
        { label: "Save As…", accelerator: "Cmd+Shift+S", click: () => sendMenuAction("save-project-as") },
        { type: "separator" },
        { label: "Restart", click: () => sendMenuAction("restart") },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "Cmd+Z", click: () => sendMenuAction("undo") },
        { label: "Redo", accelerator: "Cmd+Y", click: () => sendMenuAction("redo") },
        { type: "separator" },
        { label: "Cut", accelerator: "Cmd+X", click: () => sendMenuAction("cut") },
        { label: "Copy", accelerator: "Cmd+C", click: () => sendMenuAction("copy") },
        { label: "Paste", accelerator: "Cmd+V", click: () => sendMenuAction("paste") },
        { type: "separator" },
        { label: "Delete", accelerator: "Backspace", click: () => sendMenuAction("delete") },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "About Altera Data Suite", click: () => shell.openExternal("https://alteradatasuite.com/about") },
        { label: "Documentation", click: () => shell.openExternal("https://alteradatasuite.com/docs") },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

if (process.platform === "darwin") {
  Menu.setApplicationMenu(buildNativeMenu());
} else {
  Menu.setApplicationMenu(null);
}

// ── Project save/open -- the custom menu bar's File > Save/Save As/Open.
// A project file is just the JSON blob App.tsx already builds (PDF path +
// rectangles/groups/guides/etc.); this process only owns the native
// dialogs and the actual disk I/O, same division as the settings.json /
// PDF-path handlers above.
const PROJECT_FILTERS = [{ name: "Altera Project", extensions: ["altera"] }];

// Same userData-JSON-file convention as WINDOW_STATE_FILE/SETTINGS_FILE
// above -- File > Open Recent (src/panels/MenuBar.tsx) reads this back via
// recentProjects:list. Capped at 10, most-recent-first, deduplicated by
// path. app.addRecentDocument also feeds Windows' own taskbar jump list,
// a second, OS-level way to reach the same file.
const RECENT_PROJECTS_FILE = path.join(app.getPath("userData"), "recent-projects.json");
const RECENT_PROJECTS_MAX = 10;

function loadRecentProjects(): string[] {
  try {
    const list = JSON.parse(readFileSync(RECENT_PROJECTS_FILE, "utf-8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveRecentProjects(list: string[]) {
  try {
    writeFileSync(RECENT_PROJECTS_FILE, JSON.stringify(list));
  } catch (err) {
    console.error("[recent-projects] failed to save:", err);
  }
}

function addRecentProject(filePath: string) {
  const list = [filePath, ...loadRecentProjects().filter((p) => p !== filePath)].slice(0, RECENT_PROJECTS_MAX);
  saveRecentProjects(list);
  app.addRecentDocument(filePath);
}

function removeRecentProject(filePath: string) {
  saveRecentProjects(loadRecentProjects().filter((p) => p !== filePath));
}

ipcMain.handle("project:saveAs", async (_event, jsonData: string) => {
  if (!win) return null;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Save Project As",
    filters: PROJECT_FILTERS,
    defaultPath: "Untitled.altera",
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, jsonData, "utf-8");
  addRecentProject(filePath);
  return filePath;
});

ipcMain.handle("project:saveToPath", async (_event, filePath: string, jsonData: string) => {
  await fs.writeFile(filePath, jsonData, "utf-8");
  addRecentProject(filePath);
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
  addRecentProject(filePaths[0]);
  return { path: filePaths[0], data };
});

ipcMain.handle("recentProjects:list", () => loadRecentProjects());

// File > Open Recent's own entries -- same read-and-return shape as
// project:open above (so the renderer can reuse handleOpenProject's own
// "replace current project state" logic verbatim), but skipping the
// dialog and going straight to a known path. A file that's since moved
// or been deleted is pruned from the list rather than left to fail the
// same way every time it's clicked.
ipcMain.handle("recentProjects:open", async (_event, filePath: string) => {
  try {
    const data = await fs.readFile(filePath, "utf-8");
    addRecentProject(filePath);
    return { path: filePath, data };
  } catch {
    removeRecentProject(filePath);
    return null;
  }
});

ipcMain.on("recentProjects:clear", () => {
  saveRecentProjects([]);
  app.clearRecentDocuments();
});

// Plugin install/uninstall -- see backend/app/plugins.py for the loader
// this reload call feeds, and src/plugins.ts for the frontend side that
// re-fetches /plugins/list right after these resolve. Folder-only (not a
// .zip) for now: keeps this to plain fs.cp/fs.rm instead of pulling in a
// zip-extraction dependency, since v1 plugins are team-authored and handed
// out as a folder, not sold through any kind of store.
function pluginsDir() {
  return path.join(app.getPath("userData"), "plugins");
}

async function reloadBackendPlugins() {
  try {
    await fetch(`http://127.0.0.1:${BACKEND_PORT}/plugins/reload`, { method: "POST" });
  } catch {
    // Backend not up yet (e.g. install attempted during startup) -- it
    // scans PLUGIN_DIR on its own next startup anyway, so this is safe to
    // swallow rather than surface as an install failure.
  }
}

ipcMain.handle("plugin:install", async (): Promise<string | null> => {
  if (!win) return "Main window not available.";
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Install Plugin (select its folder)",
    properties: ["openDirectory"],
  });
  if (canceled || !filePaths[0]) return null;
  const source = filePaths[0];

  let manifest: { id?: unknown };
  try {
    const raw = await fs.readFile(path.join(source, "manifest.json"), "utf-8");
    manifest = JSON.parse(raw);
  } catch (err) {
    return `Couldn't read manifest.json in that folder: ${(err as Error).message}`;
  }
  const id = manifest.id;
  // A plugin id becomes a literal path segment below (userData/plugins/<id>)
  // -- rejects anything that isn't a plain slug so a malformed/malicious
  // manifest.json can't write outside the plugins folder (e.g. id: "../..").
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return "manifest.json's \"id\" must be a plain alphanumeric/underscore/hyphen string.";
  }

  const target = path.join(pluginsDir(), id);
  try {
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(pluginsDir(), { recursive: true });
    await fs.cp(source, target, { recursive: true });
  } catch (err) {
    return `Couldn't install plugin: ${(err as Error).message}`;
  }
  await reloadBackendPlugins();
  return null;
});

ipcMain.handle("plugin:uninstall", async (_event, pluginId: string): Promise<string | null> => {
  if (typeof pluginId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(pluginId)) {
    return "Invalid plugin id.";
  }
  try {
    await fs.rm(path.join(pluginsDir(), pluginId), { recursive: true, force: true });
  } catch (err) {
    return `Couldn't remove plugin: ${(err as Error).message}`;
  }
  await reloadBackendPlugins();
  return null;
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

// Splash window's own close button -- quits the whole app, same as
// closing the main window (see win's "closed" handler above), not just
// the splash itself.
ipcMain.on("app:quit", () => {
  app.quit();
});

// Help menu's About/Docs links -- opens in the user's default browser
// rather than navigating this window. Restricted to http(s)/mailto so a
// compromised renderer can't use this to launch an arbitrary local
// file/protocol handler.
ipcMain.on("shell:openExternal", (_event, url: string) => {
  if (/^(https?:\/\/|mailto:)/i.test(url)) shell.openExternal(url);
});

// Self-hosted (package.json's build.publish: generic, pointed at
// backend.alteradatasuite.com/updates -- see altera-license-server's own
// /updates/{filename} + /admin/updates/publish, and this repo's
// scripts/publish-update.mjs for how a new release actually gets there).
// Two independent paths share these same autoUpdater events:
//   1. A silent background check on launch (setupAutoUpdater, called from
//      app.whenReady below) -- no UI at all unless something is actually
//      ready to install, which gets the "Restart Now / Later" dialog.
//   2. File > Check for Updates -- opens the small updateCheckWin popup
//      (openUpdateCheckWindow above) and shows live status in it.
interface UpdaterStatus {
  state: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  version?: string;
  percent?: number;
  message?: string;
}

// Cached so the popup can pull the current status the moment it mounts
// (its own request-init, same pattern as every Configure window's
// lastPayloadByNode) instead of racing a push that might fire before its
// listener is registered.
let lastUpdaterStatus: UpdaterStatus | null = null;

function sendUpdaterStatus(status: UpdaterStatus) {
  lastUpdaterStatus = status;
  if (updateCheckWin && !updateCheckWin.isDestroyed()) {
    updateCheckWin.webContents.send("updater:status", status);
  }
}

// electron-updater's own error text is internal/technical (e.g. "Cannot
// find channel \"latest.yml\"" when nothing's been published yet, straight
// from its HTTP 404 handling) -- never shown to the user as-is. A missing
// latest.yml means "no release published," which reads the same to a user
// as "you're already up to date," not an error; anything else collapses
// to one plain, generic message. The real error still goes to console.
function updaterErrorStatus(err: Error): UpdaterStatus {
  console.error("[updater]", err);
  const msg = err.message.toLowerCase();
  if (msg.includes("cannot find channel") || msg.includes("404") || msg.includes("no published versions")) {
    return { state: "not-available" };
  }
  return { state: "error", message: "Couldn't check for updates. Please try again later." };
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => sendUpdaterStatus({ state: "checking" }));
  autoUpdater.on("update-available", (info) => sendUpdaterStatus({ state: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => sendUpdaterStatus({ state: "not-available" }));
  autoUpdater.on("download-progress", (p) => sendUpdaterStatus({ state: "downloading", percent: Math.round(p.percent) }));

  autoUpdater.on("update-downloaded", (info) => {
    sendUpdaterStatus({ state: "downloaded", version: info.version });
    // Only for the SILENT background path -- if the popup is already open
    // (a manual check), its own "Restart & Install" button covers this,
    // and a second native dialog on top of it would be redundant.
    if (updateCheckWin && !updateCheckWin.isDestroyed()) return;
    if (!win) return;
    dialog
      .showMessageBox(win, {
        type: "info",
        title: "Update Ready",
        message: `Altera Data Suite ${info.version} has been downloaded.`,
        detail: "Restart now to install it, or it'll install automatically the next time you quit.",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.on("error", (err) => {
    // Never a dialog for the silent background path -- an unreachable
    // update server (or none published yet) shouldn't look like the app
    // itself is broken. The popup (if open) still reflects it.
    sendUpdaterStatus(updaterErrorStatus(err));
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error("[updater] check failed:", err);
  });
}

// File > Check for Updates (src/panels/MenuBar.tsx on Windows/Linux, the
// native app-name menu on macOS below) -- opens the popup and kicks off a
// real check; the popup's own status flows back through sendUpdaterStatus
// above. A plain function (not just an ipcMain handler) so the native
// macOS menu item can call it directly, in-process, without a redundant
// renderer round trip.
function triggerUpdateCheck() {
  openUpdateCheckWindow();
  if (!app.isPackaged) {
    sendUpdaterStatus({ state: "error", message: "Updates aren't available in a dev build." });
    return;
  }
  sendUpdaterStatus({ state: "checking" });
  autoUpdater.checkForUpdates().catch((err) => {
    sendUpdaterStatus(updaterErrorStatus(err));
  });
}

ipcMain.handle("updater:check", () => triggerUpdateCheck());

ipcMain.handle("updater:request-init", () => lastUpdaterStatus);

ipcMain.on("updater:install", () => {
  autoUpdater.quitAndInstall();
});

ipcMain.on("updateCheck:close", () => {
  updateCheckWin?.close();
});

app.whenReady().then(() => {
  // Stamps LOCAL_TOKEN onto every outgoing request this app's own windows
  // make to the local backend -- covers fetch, the /ws WebSocket upgrade,
  // and plain <img src> icon loads alike, since it operates at the
  // network layer, not per-call-site. See LOCAL_TOKEN's own comment.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`http://127.0.0.1:${BACKEND_PORT}/*`] },
    (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, "X-Altera-Local-Token": LOCAL_TOKEN } });
    },
  );

  createSplashWindow();
  startBackend();
  createWindow();

  // Dev/unpackaged has no installer for electron-updater to update INTO --
  // it throws immediately otherwise.
  if (app.isPackaged) setupAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  backendProc?.kill();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  // before-quit fires before ANY window's own "close" event -- for a quit
  // that goes through app.quit() (Cmd+Q, the native macOS Quit menu item,
  // etc., as opposed to File > Exit's plain window.close()), this would
  // otherwise kill the backend out from under an unsaved-changes prompt
  // the user hasn't answered yet, or even one they go on to Cancel.
  // Redirecting to win.close() reuses that same prompt (see createWindow's
  // "close" handler) instead of duplicating it here; once the user
  // actually confirms, allowMainWindowClose lets this same check pass
  // through on the next before-quit app.quit() triggers.
  if (!allowMainWindowClose && isDirty && win) {
    event.preventDefault();
    win.close();
    return;
  }
  isQuitting = true;
  backendProc?.kill();
});
