import { useEffect, useState } from "react";
import { ConfigProvider } from "antd";
import { AgGridReact } from "ag-grid-react";
import { ModuleRegistry, AllCommunityModule, themeQuartz, type ColDef } from "ag-grid-community";
import type { BrowseWindowPayload } from "./vite-env";
import { resolveDisplayColumnType, DETECTION_SAMPLE_ROWS } from "./columnTypeDetection";
import { TypedColumnHeader } from "./columnTypeIcons";
import { useGridCellCopy } from "./gridCellCopy";
import "./App.css";

ModuleRegistry.registerModules([AllCommunityModule]);

// Same theme/params as the Workflow canvas's own output-preview drawer
// (SchemaView.tsx's outputGridTheme) -- Browse is Orange's Data Table
// widget, a pure viewer with nothing to configure, so its whole window is
// just that same grid at a bigger, dedicated size.
const browseGridTheme = themeQuartz.withParams({
  headerBackgroundColor: "#f0f2f5",
  headerTextColor: "#333333",
  headerFontSize: 11,
  headerFontWeight: 600,
  cellFontSize: 11,
  fontSize: 11,
  borderColor: "#f0f0f0",
  borderRadius: 0,
  wrapperBorderRadius: 0,
  rowHeight: 26,
  headerHeight: 28,
  cellHorizontalPadding: 12,
  spacing: 4,
  backgroundColor: "#ffffff",
  oddRowBackgroundColor: "#ffffff",
  rowHoverColor: "#fff5f0",
  headerColumnResizeHandleColor: "#cccccc",
  headerColumnResizeHandleHeight: "60%",
  headerColumnResizeHandleWidth: 1,
});
const browseGridDefaultColDef: ColDef = { resizable: true, sortable: false, suppressMovable: true };
// AG-Grid's own Excel-style row-number column (the `rowNumbers` grid
// option) is an Enterprise-only feature -- this project only has the
// Community package, so a plain pinned column reading the row's own index
// is the standard Community-compatible way to get the same look. Same
// colDef as the Workflow canvas's own output drawer (SchemaView.tsx) --
// including widening with the actual row count (Excel's own row gutter
// does the same), since a fixed width truncated ("11…") once row numbers
// grew past 2 digits.
function makeRowNumberColDef(rowCount: number): ColDef {
  const digits = String(Math.max(rowCount, 1)).length;
  return {
    colId: "__rowNumber",
    headerName: "",
    pinned: "left",
    width: 32 + digits * 10,
    resizable: false,
    sortable: false,
    suppressMovable: true,
    cellClass: "schema-row-number-cell",
    valueGetter: (params) => (params.node?.rowIndex ?? -1) + 1,
  };
}

const antTheme = {
  token: {
    borderRadius: 0,
    fontSize: 13,
    fontFamily: '"Google Sans Flex", sans-serif',
    colorText: "#1a1a1a",
  },
};

// Same empty state as FilterBuilderWindow.tsx/HeaderPromoterWindow.tsx
// (ported from devkit/filter-builder's own link.svg) -- this window used
// to just show a bare "No table connected." line, visibly inconsistent
// with every other Configure window in the app for the exact same "no
// input yet" state.
function LinkIcon() {
  return (
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.3 }}>
      <path opacity="0.4" d="M10.9999 7.5V16.5C10.9999 17.05 10.5499 17.5 9.99989 17.5H7.49989C5.97989 17.5 4.60989 16.88 3.60989 15.89C2.66989 14.94 2.05989 13.65 1.99989 12.22C1.87989 9.08 4.61989 6.5 7.76989 6.5H9.99989C10.5499 6.5 10.9999 6.95 10.9999 7.5Z" fill="#292D32" />
      <path opacity="0.4" d="M21.9998 11.78C22.1298 14.93 19.3898 17.5 16.2398 17.5H14.0098C13.4598 17.5 13.0098 17.05 13.0098 16.5V7.5C13.0098 6.95 13.4598 6.5 14.0098 6.5H16.5098C18.0298 6.5 19.3998 7.12 20.3998 8.11C21.3298 9.06 21.9398 10.35 21.9998 11.78Z" fill="#292D32" />
      <path d="M16 12.75H8C7.59 12.75 7.25 12.41 7.25 12C7.25 11.59 7.59 11.25 8 11.25H16C16.41 11.25 16.75 11.59 16.75 12C16.75 12.41 16.41 12.75 16 12.75Z" fill="#292D32" />
    </svg>
  );
}
function EmptyState() {
  return (
    <div className="filter-empty-state">
      <LinkIcon />
      <h3>No Data Connected</h3>
      <p>Connect a table to preview its rows and columns</p>
    </div>
  );
}

// Rendered in its own native BrowserWindow (see electron/main.ts's
// browse:open handler and src/main.tsx-equivalent ?view routing via
// browse.html/browse-main.tsx) -- same "every node gets its own window"
// pattern as FilterBuilderWindow.tsx, just simpler: Browse has no editable
// state, so there's no Apply/Cancel footer, no *AppliedPayload round-trip
// back to the main window, just live-once-opened data.
export default function BrowseWindow() {
  const [payload, setPayload] = useState<BrowseWindowPayload | null>(null);
  const { onCellKeyDown, onCellContextMenu, suppressContextMenu, contextMenu } = useGridCellCopy();

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev (mount -> cleanup
    // -> mount again) -- same race FilterBuilderWindow.tsx guards against:
    // the first invocation's requestBrowseInit() promise can still resolve
    // after the second (kept) invocation already loaded real data.
    let live = true;
    function loadPayload(p: BrowseWindowPayload) {
      if (live) setPayload(p);
    }
    // nodeId identifies WHICH node's payload to pull -- this window is
    // now one of potentially several Browse windows open at once, each
    // dedicated to a different node (see electron/main.ts's
    // createPerNodeWindowManager), set in the window's own URL at
    // creation time rather than learned via IPC.
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestBrowseInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onBrowseInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    // nodeName falls back to the node's catalog name ("Browse") when it
    // hasn't been renamed (see SchemaView.tsx's handleOpenBrowse:
    // `proc.name || proc.catalogName`) -- for every OTHER node kind that
    // reads fine ("Configure — Filter Builder"), but for this window
    // specifically it collides with its own "Browse — " prefix, showing
    // the redundant "Browse — Browse" for the common unrenamed case.
    if (!payload) document.title = "Browse Data";
    else if (payload.nodeName === "Browse") document.title = "Browse";
    else document.title = `Browse — ${payload.nodeName}`;
  }, [payload]);

  // Power-Query-style type icon before each header's name (see
  // columnTypeDetection.ts/columnTypeIcons.tsx) -- shows the column's REAL
  // type, never a content-based guess: Text unless payload.columnTypes says
  // otherwise (only ever set when this window's input is the direct output
  // of a Change Type node -- see resolveDisplayColumnType's own comment).
  const columnDefs: ColDef[] = payload
    ? [
        makeRowNumberColDef(payload.rows.length),
        ...payload.columns.map((col, ci): ColDef => {
          const sample = payload.rows.slice(0, DETECTION_SAMPLE_ROWS).map((row) => row[ci] ?? "");
          return {
            field: col,
            headerName: col,
            colId: `${ci}::${col}`,
            // innerHeaderComponent swaps only the default header's own
            // label-rendering part (resize handle/sort space/etc. stay
            // exactly as AG-Grid's own default header renders them) --
            // this is why it goes inside headerComponentParams, not as a
            // top-level ColDef field like headerComponent itself.
            headerComponentParams: {
              innerHeaderComponent: TypedColumnHeader,
              innerHeaderComponentParams: { detectedType: resolveDisplayColumnType(col, payload.columnTypes?.[col], sample) },
            },
          };
        }),
      ]
    : [];
  const rowData = payload
    ? payload.rows.map((row) => Object.fromEntries(payload.columns.map((col, ci) => [col, row[ci] ?? ""])))
    : [];
  const showEmpty = !payload || payload.columns.length === 0;

  return (
    <ConfigProvider theme={antTheme}>
      <div className="browse-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <AgGridReact
            theme={browseGridTheme}
            rowData={rowData}
            columnDefs={columnDefs}
            defaultColDef={browseGridDefaultColDef}
            // `field` is the real extracted column name, which can contain
            // a literal "." (e.g. a PDF header like "2023.01") -- AG-Grid
            // treats dots in `field` as nested-path separators by default,
            // which would render such a column empty.
            suppressFieldDotNotation
            onCellKeyDown={onCellKeyDown}
            onCellContextMenu={onCellContextMenu}
            suppressContextMenu={suppressContextMenu}
          />
        )}
      </div>
      {contextMenu}
    </ConfigProvider>
  );
}
