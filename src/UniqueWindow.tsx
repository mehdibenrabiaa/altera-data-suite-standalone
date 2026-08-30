import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfigProvider } from "antd";
import type { UniqueParams, UniqueKeepMode } from "./types";
import type { UniqueWindowPayload } from "./vite-env";
import "./App.css";

// Configure window for the Unique node -- ported from the original
// OWDeduplicator widget (devkit/orangecontrib/custom/widgets/
// deduplicator.py), renamed since "keep only unique rows" reads clearer
// than the original widget's own name. Same real-window/round-trips-on-
// Apply pattern as ShiftColumnsWindow.tsx (a plain column checklist +
// toggle, no grid preview) -- the original's own AG-Grid preview
// (click-to-select column headers, duplicate rows highlighted) is
// deliberately NOT ported; a plain checklist + a live Total/Duplicates/
// Output stat readout (computed client-side from the resolved input
// rows, mirroring what backend/app/nodes.py's deduplicate_rows actually
// does) covers the same "see the effect before committing" need with far
// less UI surface.
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
      <p>Connect a data table to remove duplicate rows</p>
    </div>
  );
}

const KEEP_OPTIONS: { value: UniqueKeepMode; label: string }[] = [
  { value: "first", label: "First" },
  { value: "last", label: "Last" },
  { value: "none", label: "Remove all" },
];

export default function UniqueWindow() {
  const [payload, setPayload] = useState<UniqueWindowPayload | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [keep, setKeep] = useState<UniqueKeepMode>("first");

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: UniqueWindowPayload) {
      if (!live) return;
      setPayload(p);
      setColumns(p.initialParams.columns ?? []);
      setKeep(p.initialParams.keep ?? "first");
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestUniqueInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onUniqueInit(loadPayload);
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

  // Mirrors backend/app/nodes.py's deduplicate_rows exactly: group rows
  // by the tuple of values in the selected columns; "first"/"last" both
  // keep exactly one survivor per group (which ONE doesn't change the
  // COUNT), "none" keeps a group only if it was never duplicated at all
  // (size 1) -- an entire group of 2+ identical rows is dropped, not
  // just the extras.
  const stats = useMemo(() => {
    const allColumns = payload?.columns ?? [];
    const rows = payload?.rows ?? [];
    const valid = columns.filter((c) => allColumns.includes(c));
    const total = rows.length;
    if (valid.length === 0) return { total, duplicates: 0, output: total };
    const idxs = valid.map((c) => allColumns.indexOf(c));
    const groupSizes = new Map<string, number>();
    for (const row of rows) {
      const key = JSON.stringify(idxs.map((i) => row[i] ?? ""));
      groupSizes.set(key, (groupSizes.get(key) ?? 0) + 1);
    }
    let output = 0;
    for (const size of groupSizes.values()) {
      output += keep === "none" ? (size === 1 ? 1 : 0) : 1;
    }
    return { total, duplicates: total - output, output };
  }, [payload, columns, keep]);

  if (!payload) return null;
  const showEmpty = payload.columns.length === 0;

  const handleApply = () => {
    const params: UniqueParams = { columns, keep };
    window.alteraStudio.applyUnique({ nodeId: payload.nodeId, params });
  };

  return (
    <ConfigProvider theme={antTheme}>
      <div className="unique-window">
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
                <div className="unique-section-label">When duplicates found, keep</div>
                <div className="match-toggle">
                  {KEEP_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      className={`match-toggle-btn${keep === opt.value ? " active" : ""}`}
                      onClick={() => setKeep(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="unique-stats">
                <div className="unique-stat"><span className="unique-stat-label">Total rows</span><span className="unique-stat-value">{stats.total}</span></div>
                <div className="unique-stat"><span className="unique-stat-label">Duplicates found</span><span className="unique-stat-value">{stats.duplicates}</span></div>
                <div className="unique-stat"><span className="unique-stat-label">Output rows</span><span className="unique-stat-value">{stats.output}</span></div>
              </div>
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeUniqueWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty || columns.length === 0}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
