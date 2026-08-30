import { useCallback, useEffect, useState } from "react";
import { ConfigProvider, InputNumber } from "antd";
import type { ShiftColumnsParams, ShiftDirection } from "./types";
import type { ShiftColumnsWindowPayload } from "./vite-env";
import "./App.css";

// Configure window for the Shift Columns node -- ported from the original
// OWMultiShiftColumns widget (devkit/orangecontrib/custom/widgets/
// multishift.py): a column checklist plus a direction/steps control, no
// grid preview (the original had none either -- see backend/app/nodes.py's
// shift_columns for the actual shift logic). Same real-window/round-trips-
// on-Apply pattern as FilterBuilderWindow.tsx/HeaderPromoterWindow.tsx/
// MergeWindow.tsx, replacing the original's live auto-push on every
// checkbox/control change with this app's own explicit-Apply convention.
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
      <p>Connect a data table to start shifting columns</p>
    </div>
  );
}

// Lucide move-up/move-down (public/move-up.svg, public/move-down.svg),
// inlined rather than rendered via <img> so stroke="currentColor" picks
// up the toggle button's own text color (grey inactive, white on the red
// active background) instead of whatever color the file resolves to when
// loaded as a standalone image.
function MoveDownIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 18L12 22L16 18" />
      <path d="M12 2V22" />
    </svg>
  );
}
function MoveUpIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6L12 2L16 6" />
      <path d="M12 2V22" />
    </svg>
  );
}

export default function ShiftColumnsWindow() {
  const [payload, setPayload] = useState<ShiftColumnsWindowPayload | null>(null);
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [direction, setDirection] = useState<ShiftDirection>("down");
  const [steps, setSteps] = useState(1);

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: ShiftColumnsWindowPayload) {
      if (!live) return;
      setPayload(p);
      setSelectedColumns(p.initialParams.selectedColumns ?? []);
      setDirection(p.initialParams.direction ?? "down");
      setSteps(p.initialParams.steps ?? 1);
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestShiftColumnsInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onShiftColumnsInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Configure — ${payload.nodeName}` : "Configure Node";
  }, [payload]);

  const toggleColumn = useCallback((col: string) => {
    setSelectedColumns((prev) => (prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]));
  }, []);
  const clearAll = useCallback(() => setSelectedColumns([]), []);

  if (!payload) return null;
  const columns = payload.columns;
  const showEmpty = columns.length === 0;

  const handleApply = () => {
    const params: ShiftColumnsParams = { selectedColumns, direction, steps };
    window.alteraStudio.applyShiftColumns({ nodeId: payload.nodeId, params });
  };

  return (
    <ConfigProvider theme={antTheme}>
      <div className="shift-columns-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="shift-columns-app-outer">
            <div className="shift-columns-app">
              <div className="shift-columns-section">
                <div className="shift-columns-section-head">
                  <span className="shift-columns-section-label">Columns to shift</span>
                  {selectedColumns.length > 0 && (
                    <button className="shift-columns-clear-btn" onClick={clearAll}>Clear all</button>
                  )}
                </div>
                <div className="shift-columns-list">
                  {columns.map((col) => (
                    <label key={col} className="shift-columns-option">
                      <input type="checkbox" checked={selectedColumns.includes(col)} onChange={() => toggleColumn(col)} />
                      <span className="shift-columns-option-label">{col}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="shift-columns-section">
                <div className="shift-columns-section-label">Shift settings</div>
                <div className="shift-columns-settings-row">
                  <div className="match-toggle">
                    <button className={`match-toggle-btn${direction === "down" ? " active" : ""}`} onClick={() => setDirection("down")}>
                      <MoveDownIcon /> Shift Down
                    </button>
                    <button className={`match-toggle-btn${direction === "up" ? " active" : ""}`} onClick={() => setDirection("up")}>
                      <MoveUpIcon /> Shift Up
                    </button>
                  </div>
                  <InputNumber min={1} step={1} precision={0} value={steps} onChange={(v) => setSteps(v && v >= 1 ? v : 1)} />
                </div>
              </div>

              {selectedColumns.length > 0 && (
                <p className="shift-columns-summary">
                  {selectedColumns.length} column{selectedColumns.length === 1 ? "" : "s"} will shift {steps} step{steps === 1 ? "" : "s"}{" "}
                  {direction === "down" ? <MoveDownIcon /> : <MoveUpIcon />}
                </p>
              )}
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeShiftColumnsWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty || selectedColumns.length === 0}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
