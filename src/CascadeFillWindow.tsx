import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfigProvider, Select } from "antd";
import type { CascadeFillParams, CascadeFillDirection } from "./types";
import type { CascadeFillWindowPayload } from "./vite-env";
import "./App.css";

// Configure window for the Cascade Fill node -- ported from the original
// OWCascadeFill widget (devkit/orangecontrib/custom/widgets/
// cascade_fill.py) and its own React frontend (github.com/
// mehdibenrabiaa/Cascade-Fill). Same real-window/round-trips-on-Apply
// pattern as UniqueWindow.tsx (a plain column checklist + toggle, no grid
// preview) -- the original's own AG-Grid preview (click-to-select column
// headers, per-cell "will fill" highlighting) is deliberately NOT ported,
// same tradeoff UniqueWindow.tsx already made for its own original's
// equally elaborate AG-Grid preview: a checklist + toggle + a live
// Total/Cells-to-fill stat readout (computed client-side, mirroring what
// backend/app/nodes.py's cascade_fill actually does) covers the same "see
// the effect before committing" need with far less UI surface.
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

// Ported verbatim from FilterBuilderWindow.tsx's own copy (originally
// devkit/filter-builder/src/assets/link.svg) -- same empty-state icon
// every Configure/viewer window in the app now shares.
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
      <p>Connect a data table to start filling values</p>
    </div>
  );
}

const DIRECTION_OPTIONS: { value: CascadeFillDirection; label: string }[] = [
  { value: "down", label: "Down" },
  { value: "up", label: "Up" },
];
const DIRECTION_HELP_TEXT: Record<CascadeFillDirection, string> = {
  down: "Propagate values downward into empty cells",
  up: "Propagate values upward into empty cells",
};

// A cell counts as empty the exact same way backend/app/nodes.py's
// cascade_fill treats it as null: blank, "?", or a value in customNulls.
const isEmptyCell = (v: string, customNulls: string[]): boolean =>
  v === "" || v === "?" || customNulls.includes(v);

export default function CascadeFillWindow() {
  const [payload, setPayload] = useState<CascadeFillWindowPayload | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [direction, setDirection] = useState<CascadeFillDirection>("down");
  const [customNulls, setCustomNulls] = useState<string[]>([]);

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: CascadeFillWindowPayload) {
      if (!live) return;
      setPayload(p);
      setColumns(p.initialParams.columns ?? []);
      setDirection(p.initialParams.direction ?? "down");
      setCustomNulls(p.initialParams.customNulls ?? []);
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestCascadeFillInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onCascadeFillInit(loadPayload);
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

  // Mirrors backend/app/nodes.py's cascade_fill exactly, per column: scan
  // in the fill direction, tracking the last non-empty value seen so far;
  // an empty cell counts as "will be filled" only once a value has
  // actually been seen (a leading run with nothing above it to propagate
  // from -- or a trailing run for "up" -- is left empty, same as ffill/
  // bfill leaving those NaN). "up" scans bottom-to-top so "last seen" is
  // the next real value below/at the current row, matching bfill.
  const stats = useMemo(() => {
    const allColumns = payload?.columns ?? [];
    const rows = payload?.rows ?? [];
    const total = rows.length;
    const valid = columns.filter((c) => allColumns.includes(c));
    if (valid.length === 0) return { total, filled: 0, columnsCount: 0 };
    const idxs = valid.map((c) => allColumns.indexOf(c));
    const orderedRows = direction === "down" ? rows : [...rows].reverse();
    let filled = 0;
    for (const i of idxs) {
      let sawValue = false;
      for (const row of orderedRows) {
        const v = row[i] ?? "";
        if (isEmptyCell(v, customNulls)) {
          if (sawValue) filled++;
        } else {
          sawValue = true;
        }
      }
    }
    return { total, filled, columnsCount: valid.length };
  }, [payload, columns, direction, customNulls]);

  if (!payload) return null;
  const showEmpty = payload.columns.length === 0;

  const handleApply = () => {
    const params: CascadeFillParams = { columns, direction, customNulls };
    window.alteraStudio.applyCascadeFill({ nodeId: payload.nodeId, params });
  };

  return (
    <ConfigProvider theme={antTheme}>
      <div className="cascade-fill-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="unique-app-outer">
            <div className="unique-app">
              <div className="unique-section">
                <div className="unique-section-head">
                  <span className="unique-section-label">Columns</span>
                  {columns.length > 0 && (
                    <button className="unique-clear-btn" onClick={clearAll}>Clear all</button>
                  )}
                </div>
                <div className="unique-list">
                  {payload.columns.map((col) => (
                    <label key={col} className="unique-option">
                      <input type="checkbox" checked={columns.includes(col)} onChange={() => toggleColumn(col)} />
                      <span className="unique-option-label">{col}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="unique-section">
                <div className="unique-section-label">Fill direction</div>
                <div className="match-toggle">
                  {DIRECTION_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      className={`match-toggle-btn${direction === opt.value ? " active" : ""}`}
                      onClick={() => setDirection(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="change-type-hint">{DIRECTION_HELP_TEXT[direction]}</p>
              </div>

              <div className="unique-section">
                <div className="unique-section-label">Treat as empty</div>
                <p className="change-type-hint">Additional values to fill (besides blank/"?")</p>
                <Select
                  mode="tags"
                  style={{ width: "100%" }}
                  placeholder='e.g. "N/A", "unknown"'
                  value={customNulls}
                  onChange={(vals: string[]) => setCustomNulls(vals)}
                  tokenSeparators={[","]}
                  notFoundContent={null}
                />
              </div>

              <div className="unique-stats">
                <div className="unique-stat"><span className="unique-stat-label">Total rows</span><span className="unique-stat-value">{stats.total}</span></div>
                <div className="unique-stat"><span className="unique-stat-label">Cells to fill</span><span className="unique-stat-value">{stats.filled}</span></div>
                <div className="unique-stat"><span className="unique-stat-label">Selected columns</span><span className="unique-stat-value">{stats.columnsCount}</span></div>
              </div>
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeCascadeFillWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty || columns.length === 0}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
