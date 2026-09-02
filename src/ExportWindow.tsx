import { useEffect, useState } from "react";
import { ConfigProvider } from "antd";
import type { ExportParams, ExportFormat } from "./types";
import type { ExportWindowPayload } from "./vite-env";
import "./App.css";

// Configure window for the Export node -- the one sink in the catalog
// (nodeCatalog.ts's hasOutput: false), so unlike every other Configure
// window here there's no column/row data to preview or edit, just WHERE
// and in WHAT FORMAT to write once the node is Run (backend/app/nodes.py's
// export_data does the actual writing). Same real-window/round-trips-on-
// Apply pattern as every other node's Configure window.
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
      <p>Connect one or more tables to export them</p>
    </div>
  );
}

const FORMAT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: "xlsx", label: "Excel (.xlsx)" },
  { value: "csv", label: "CSV" },
];

export default function ExportWindow() {
  const [payload, setPayload] = useState<ExportWindowPayload | null>(null);
  const [format, setFormatState] = useState<ExportFormat>("xlsx");
  const [outputPath, setOutputPath] = useState("");
  const [autosave, setAutosave] = useState(false);

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: ExportWindowPayload) {
      if (!live) return;
      setPayload(p);
      setFormatState(p.initialParams.format ?? "xlsx");
      setOutputPath(p.initialParams.outputPath ?? "");
      setAutosave(p.initialParams.autosave ?? false);
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestExportInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onExportInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Configure — ${payload.nodeName}` : "Configure Node";
  }, [payload]);

  // A file path and a folder path are never interchangeable -- switching
  // format clears whatever was already chosen instead of silently keeping
  // a now-wrong-kind-of path around until the user notices on Run.
  const setFormat = (next: ExportFormat) => {
    setFormatState(next);
    setOutputPath("");
  };

  const chooseLocation = async () => {
    const chosen = format === "xlsx"
      ? await window.alteraStudio.chooseExportFile()
      : await window.alteraStudio.chooseExportFolder();
    if (chosen) setOutputPath(chosen);
  };

  if (!payload) return null;
  const showEmpty = payload.tableNames.length === 0;

  const handleApply = () => {
    const params: ExportParams = { format, outputPath, autosave };
    window.alteraStudio.applyExport({ nodeId: payload.nodeId, params });
  };

  return (
    <ConfigProvider theme={antTheme}>
      <div className="export-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="unique-app-outer">
            <div className="unique-app">
              <div className="unique-section">
                <div className="unique-section-label">Format</div>
                <div className="match-toggle">
                  {FORMAT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      className={`match-toggle-btn${format === opt.value ? " active" : ""}`}
                      onClick={() => setFormat(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="change-type-hint">
                  {format === "xlsx"
                    ? "Each connected table becomes its own sheet in one workbook."
                    : "Each connected table is written as its own .csv file in the chosen folder."}
                </p>
              </div>

              <div className="unique-section">
                <div className="unique-section-label">{format === "xlsx" ? "Output file" : "Output folder"}</div>
                <div className="export-path-row">
                  <span className="export-path-value" title={outputPath || undefined}>
                    {outputPath || `No ${format === "xlsx" ? "file" : "folder"} chosen`}
                  </span>
                  <button className="btn-add-condition" onClick={chooseLocation}>
                    {format === "xlsx" ? "Choose file…" : "Choose folder…"}
                  </button>
                </div>
              </div>

              <div className="unique-section">
                <label className="unique-option">
                  <input type="checkbox" checked={autosave} onChange={(e) => setAutosave(e.target.checked)} />
                  <span className="unique-option-label">Autosave</span>
                </label>
                <p className="change-type-hint">
                  Re-export to this same {format === "xlsx" ? "file" : "folder"} automatically, overwriting it, whenever the connected data changes. Off by default -- Run it manually from the right-click menu instead whenever you want a fresh export. If the file is currently open elsewhere, the overwrite will fail until it's closed.
                </p>
              </div>

              <div className="unique-section">
                <div className="unique-section-label">Exporting {payload.tableNames.length} table{payload.tableNames.length === 1 ? "" : "s"}</div>
                <div className="export-table-list">
                  {payload.tableNames.map((name, i) => (
                    <div className="export-table-list-item" key={`${name}-${i}`}>{name}</div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeExportWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty || !outputPath}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
