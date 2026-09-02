import { useEffect, useState } from "react";
import { ConfigProvider, Select } from "antd";
import type { PivotColumnsParams } from "./types";
import type { PivotColumnsWindowPayload } from "./vite-env";
import "./App.css";

// Configure window for the Pivot Columns node -- Power Query's own "Pivot
// Column" command, the reverse of Unpivot Columns (backend/app/nodes.py's
// pivot_columns): pick which column's own values become new column
// headers (labelColumn) and which column's values land under them
// (valueColumn). Same real-window/round-trips-on-Apply pattern as every
// other Configure window here; two plain Select pickers is all this
// needs (no grid preview, matching Shift Columns/Merge's own simpler
// pickers), since there's no per-column config beyond which two to pick.
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
      <p>Connect a data table to pivot its columns</p>
    </div>
  );
}

export default function PivotColumnsWindow() {
  const [payload, setPayload] = useState<PivotColumnsWindowPayload | null>(null);
  const [labelColumn, setLabelColumn] = useState<string | undefined>(undefined);
  const [valueColumn, setValueColumn] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: PivotColumnsWindowPayload) {
      if (!live) return;
      setPayload(p);
      setLabelColumn(p.initialParams.labelColumn || undefined);
      setValueColumn(p.initialParams.valueColumn || undefined);
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestPivotColumnsInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onPivotColumnsInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Configure — ${payload.nodeName}` : "Configure Node";
  }, [payload]);

  if (!payload) return null;
  const showEmpty = payload.columns.length === 0;

  const handleApply = () => {
    if (!labelColumn || !valueColumn) return;
    const params: PivotColumnsParams = { labelColumn, valueColumn };
    window.alteraStudio.applyPivotColumns({ nodeId: payload.nodeId, params });
  };

  const labelOptions = payload.columns.filter((c) => c !== valueColumn).map((c) => ({ value: c, label: c }));
  const valueOptions = payload.columns.filter((c) => c !== labelColumn).map((c) => ({ value: c, label: c }));

  return (
    <ConfigProvider
      theme={antTheme}
      getPopupContainer={(triggerNode) => (triggerNode?.closest(".pivot-columns-window") as HTMLElement) ?? document.body}
    >
      <div className="pivot-columns-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="unique-app-outer">
            <div className="unique-app">
              <div className="unique-section">
                <div className="unique-section-label">Labels column</div>
                <p className="change-type-hint">Its unique values become new column headers.</p>
                <Select
                  style={{ width: "100%" }}
                  value={labelColumn}
                  placeholder="Column…"
                  options={labelOptions}
                  onChange={(v) => setLabelColumn(v)}
                  allowClear
                  onClear={() => setLabelColumn(undefined)}
                />
              </div>

              <div className="unique-section">
                <div className="unique-section-label">Values column</div>
                <p className="change-type-hint">Its values land under the new columns above.</p>
                <Select
                  style={{ width: "100%" }}
                  value={valueColumn}
                  placeholder="Column…"
                  options={valueOptions}
                  onChange={(v) => setValueColumn(v)}
                  allowClear
                  onClear={() => setValueColumn(undefined)}
                />
              </div>

              <div className="unique-section">
                <p className="change-type-hint">
                  Every other column stays as an identifier rows are grouped by. With no other columns, rows are matched up in the order the labels appeared -- useful for reconstructing an Unpivot Columns output back to its original shape.
                </p>
              </div>
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closePivotColumnsWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty || !labelColumn || !valueColumn}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
