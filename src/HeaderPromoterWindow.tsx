import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfigProvider } from "antd";
import { AgGridReact } from "ag-grid-react";
import { ModuleRegistry, AllCommunityModule, themeQuartz, type ColDef, type GridApi, type RowClickedEvent } from "ag-grid-community";
import type { HeaderPromoterParams } from "./types";
import type { HeaderPromoterWindowPayload } from "./vite-env";
import { useGridCellCopy } from "./gridCellCopy";
import "./App.css";

ModuleRegistry.registerModules([AllCommunityModule]);

// Same theme/params as this app's other Configure/Browse grids
// (SchemaView.tsx's outputGridTheme, BrowseWindow.tsx's browseGridTheme).
const hpGridTheme = themeQuartz.withParams({
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
const hpGridDefaultColDef: ColDef = { resizable: true, sortable: false, suppressMovable: true };
// Same Community-compatible row-number column as SchemaView.tsx's/
// BrowseWindow.tsx's own ROW_NUMBER_COL_DEF (AG-Grid's `rowNumbers` grid
// option is Enterprise-only) -- widened by actual row count so it never
// truncates ("11…") past 2 digits.
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
    borderRadiusLG: 0,
    borderRadiusSM: 0,
    controlHeight: 28,
    controlHeightSM: 24,
    fontSize: 13,
    fontFamily: '"Google Sans Flex", sans-serif',
    colorBorder: "#e0e0e0",
    colorPrimaryHover: "#bbb",
    colorPrimary: "#FE4D41",
    colorText: "#1a1a1a",
    colorTextPlaceholder: "#999",
    colorBgContainer: "#ffffff",
    motionDurationFast: "0s",
    motionDurationMid: "0s",
    motionDurationSlow: "0s",
  },
};

// Dual-track groove toggle -- ported verbatim from devkit/header-promoter/
// src/GrooveSwitch.tsx (also used elsewhere in the original pdf-converter
// widget for the same compact on/off control), inlined here since this is
// its only user in this app so far.
function GrooveSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={`groove-switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} role="switch" aria-checked={checked}>
      <div className="groove-switch-thumb" />
    </div>
  );
}

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
      <p>Connect a data table to promote a row to headers</p>
    </div>
  );
}

// Real, separate native window -- same pattern as FilterBuilderWindow.tsx
// (not an in-page modal), re-seeded via headerPromoter:init on every
// Configure open. Adapted from the original's own frontend
// (devkit/header-promoter): no QWebChannel/Qt bridge (Electron IPC
// instead, see the window-lifecycle comment on FilterBuilderWindow.tsx),
// no rc-dock (a fixed sidebar + grid needs no resizable/floatable panels),
// and edits commit on an explicit Apply rather than the original's live
// auto-push on every selection change -- matching this app's own Filter
// Builder convention (auto-run only re-fires on Apply).
export default function HeaderPromoterWindow() {
  const { onCellKeyDown, onCellContextMenu, suppressContextMenu, contextMenu } = useGridCellCopy();
  const [payload, setPayload] = useState<HeaderPromoterWindowPayload | null>(null);
  const [rowIndex, setRowIndex] = useState<number | null>(null);
  const [removeAbove, setRemoveAbove] = useState(true);
  const gridApiRef = useRef<GridApi | null>(null);

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: HeaderPromoterWindowPayload) {
      if (!live) return;
      setPayload(p);
      setRowIndex(p.initialParams.rowIndex);
      setRemoveAbove(p.initialParams.removeAbove);
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestHeaderPromoterInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onHeaderPromoterInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Configure — ${payload.nodeName}` : "Configure Node";
  }, [payload]);

  const columns = payload?.columns ?? [];
  const rows = payload?.rows ?? [];

  const rowData = useMemo(
    () => rows.map((row, i) => {
      const obj: Record<string, string | number> = { __rowIdx: i };
      columns.forEach((_col, j) => { obj[`col_${j}`] = row[j] ?? ""; });
      return obj;
    }),
    [rows, columns],
  );

  const colDefs = useMemo(() => {
    // Once a row is selected, its own values preview AS the headers --
    // same "see the promotion before committing" affordance the original
    // widget's grid gives (devkit/header-promoter's isPreview headerClass).
    const displayHeaders = rowIndex !== null ? (rows[rowIndex] ?? columns) : columns;
    const isPreview = rowIndex !== null;
    return [
      makeRowNumberColDef(rows.length),
      ...columns.map((_col, i): ColDef => ({
        field: `col_${i}`,
        headerName: displayHeaders[i] || `Col ${i + 1}`,
        headerClass: isPreview ? "hp-preview-header" : undefined,
      })),
    ];
  }, [columns, rows, rowIndex]);

  const handleRowClicked = useCallback((e: RowClickedEvent) => {
    if (e.data) setRowIndex((e.data as { __rowIdx: number }).__rowIdx);
  }, []);

  // rowClassRules reads gridApi's OWN row nodes each pass, not React
  // props, so selecting/toggling doesn't naturally re-run it -- same
  // "context changed, ask the grid to redraw" nudge the original widget
  // uses (its own useEffect -> gridRef.current.api.redrawRows()).
  useEffect(() => {
    gridApiRef.current?.redrawRows();
  }, [rowIndex, removeAbove]);

  if (!payload) return null;
  const showEmpty = columns.length === 0;

  const handleApply = () => {
    const params: HeaderPromoterParams = { rowIndex, removeAbove };
    window.alteraStudio.applyHeaderPromoter({ nodeId: payload.nodeId, params });
  };

  return (
    <ConfigProvider theme={antTheme}>
      <div className="header-promoter-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="hp-body">
            <div className="hp-controls-body">
              <div className="hp-ctrl-section">
                <div className="hp-ctrl-label">Selected row</div>
                {rowIndex !== null ? <span className="hp-row-badge">Row {rowIndex + 1}</span> : <span className="hp-ctrl-none">None</span>}
              </div>
              <div className="hp-ctrl-section">
                <div className="hp-switch-row">
                  <span className="hp-switch-label">Remove rows above</span>
                  <GrooveSwitch checked={removeAbove} onChange={setRemoveAbove} />
                </div>
              </div>
              {rowIndex === null && (
                <div className="hp-ctrl-hint">Click any row in the table to promote it to column headers.</div>
              )}
            </div>
            <div className="hp-grid-wrap">
              <AgGridReact
                theme={hpGridTheme}
                rowData={rowData}
                columnDefs={colDefs}
                defaultColDef={hpGridDefaultColDef}
                suppressFieldDotNotation
                rowStyle={{ cursor: "pointer" }}
                rowClassRules={{
                  "hp-selected-row": (p) => (p.data as { __rowIdx?: number } | undefined)?.__rowIdx === rowIndex,
                  "hp-removed-row": (p) => {
                    const ri = (p.data as { __rowIdx?: number } | undefined)?.__rowIdx;
                    if (rowIndex === null || ri === undefined) return false;
                    return removeAbove ? ri <= rowIndex : ri === rowIndex;
                  },
                }}
                onRowClicked={handleRowClicked}
                onGridReady={(e) => { gridApiRef.current = e.api; }}
                onCellKeyDown={onCellKeyDown}
                onCellContextMenu={onCellContextMenu}
                suppressContextMenu={suppressContextMenu}
              />
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeHeaderPromoterWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty || rowIndex === null}>Apply</button>
        </div>
      </div>
      {contextMenu}
    </ConfigProvider>
  );
}
