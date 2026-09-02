import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfigProvider } from "antd";
import type { UnpivotColumnsParams } from "./types";
import type { UnpivotColumnsWindowPayload } from "./vite-env";
import "./App.css";

// Configure window for the Unpivot Columns node -- Power Query's own
// "Unpivot Columns" command (backend/app/nodes.py's unpivot_columns): pick
// the columns to CONVERT into Attribute/Value row pairs; every other
// column stays as an identifier. Same real-window/round-trips-on-Apply
// pattern as CascadeFillWindow.tsx (a plain checklist + a live stat
// readout, no grid preview needed).
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

// Ported verbatim from FilterBuilderWindow.tsx's own copy -- same empty-
// state icon every Configure/viewer window in the app shares.
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
      <p>Connect a data table to start unpivoting columns</p>
    </div>
  );
}

export default function UnpivotColumnsWindow() {
  const [payload, setPayload] = useState<UnpivotColumnsWindowPayload | null>(null);
  const [columns, setColumns] = useState<string[]>([]);

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: UnpivotColumnsWindowPayload) {
      if (!live) return;
      setPayload(p);
      setColumns(p.initialParams.columns ?? []);
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestUnpivotColumnsInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onUnpivotColumnsInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Configure — ${payload.nodeName}` : "Configure Node";
  }, [payload]);

  const toggleColumn = useCallback((col: string) => {
    setColumns((prev) => (prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]));
  }, []);
  const clearAll = useCallback(() => setColumns([]), []);

  // Mirrors backend/app/nodes.py's unpivot_columns exactly: one output row
  // per original row x selected column, everything else (the identifier
  // columns) just repeats across those rows rather than adding any.
  const stats = useMemo(() => {
    const totalRows = payload?.rowCount ?? 0;
    const validColumns = columns.filter((c) => (payload?.columns ?? []).includes(c));
    return {
      totalRows,
      newRows: totalRows * validColumns.length,
      columnsCount: validColumns.length,
      idColumnsCount: (payload?.columns.length ?? 0) - validColumns.length,
    };
  }, [payload, columns]);

  if (!payload) return null;
  const showEmpty = payload.columns.length === 0;

  const handleApply = () => {
    const params: UnpivotColumnsParams = { columns };
    window.alteraStudio.applyUnpivotColumns({ nodeId: payload.nodeId, params });
  };

  return (
    <ConfigProvider theme={antTheme}>
      <div className="unpivot-columns-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="unique-app-outer">
            <div className="unique-app">
              <div className="unique-section">
                <div className="unique-section-head">
                  <span className="unique-section-label">Columns to unpivot</span>
                  {columns.length > 0 && (
                    <button className="unique-clear-btn" onClick={clearAll}>Clear all</button>
                  )}
                </div>
                <p className="change-type-hint">
                  Selected columns become "Attribute"/"Value" row pairs. Every other column stays as-is.
                </p>
                <div className="unique-list">
                  {payload.columns.map((col) => (
                    <label key={col} className="unique-option">
                      <input type="checkbox" checked={columns.includes(col)} onChange={() => toggleColumn(col)} />
                      <span className="unique-option-label">{col}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="unique-stats">
                <div className="unique-stat"><span className="unique-stat-label">Total rows</span><span className="unique-stat-value">{stats.totalRows}</span></div>
                <div className="unique-stat"><span className="unique-stat-label">Rows after unpivot</span><span className="unique-stat-value">{stats.newRows}</span></div>
                <div className="unique-stat"><span className="unique-stat-label">Columns to unpivot</span><span className="unique-stat-value">{stats.columnsCount}</span></div>
                <div className="unique-stat"><span className="unique-stat-label">Identifier columns</span><span className="unique-stat-value">{stats.idColumnsCount}</span></div>
              </div>
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeUnpivotColumnsWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty || columns.length === 0}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
