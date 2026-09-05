import { useEffect, useState } from "react";
import { ConfigProvider, Select } from "antd";
import type { InputDataParams } from "./types";
import type { InputDataWindowPayload } from "./vite-env";
import { inspectDataFile } from "./nodeExecution";
import "./App.css";

// Configure window for the Input Data node -- the catalog's only graph
// SOURCE (nodeCatalog.ts's hasInput: false, backend/app/nodes.py's
// file_input), so unlike every other Configure window here there's no
// upstream table to preview/edit, just WHICH local .csv/.xlsx file to read
// (and, for a multi-sheet workbook, which sheet). Same real-window,
// round-trips-on-Apply pattern as every other node's Configure window --
// reuses ExportWindow.tsx's own wrapper class (the closest existing
// shape: a native file picker + Apply/Cancel, no operation-card list) for
// its CSS wholesale.
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

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function isExcelPath(path: string): boolean {
  return /\.xlsx?$/i.test(path);
}

export default function InputDataWindow() {
  const [payload, setPayload] = useState<InputDataWindowPayload | null>(null);
  const [path, setPath] = useState("");
  const [sheet, setSheet] = useState<string | undefined>(undefined);
  const [sheets, setSheets] = useState<string[] | null>(null);
  const [sheetsLoading, setSheetsLoading] = useState(false);
  const [sheetsError, setSheetsError] = useState<string | null>(null);

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: InputDataWindowPayload) {
      if (!live) return;
      setPayload(p);
      setPath(p.initialParams.path ?? "");
      setSheet(p.initialParams.sheet);
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestInputDataInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onInputDataInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Configure — ${payload.nodeName}` : "Configure Node";
  }, [payload]);

  // Re-inspects sheets whenever the chosen path changes -- including on
  // initial load, so reopening Configure on an already-configured .xlsx
  // node shows its sheet dropdown immediately, not just after re-picking
  // the same file. A .csv/.tsv path (or no path yet) always clears the
  // dropdown instead -- those formats have no sheets to choose between.
  useEffect(() => {
    if (!path || !isExcelPath(path)) {
      setSheets(null);
      setSheetsError(null);
      return;
    }
    let live = true;
    setSheetsLoading(true);
    setSheetsError(null);
    inspectDataFile(path)
      .then(({ sheets: found }) => {
        if (!live) return;
        setSheets(found);
        // A previously-chosen sheet that's no longer in this file (picked
        // a different workbook without resetting sheet) falls back to the
        // first one instead of silently keeping a now-invalid name around.
        if (found && found.length > 0 && !found.includes(sheet ?? "")) {
          setSheet(found[0]);
        }
      })
      .catch((e) => {
        if (!live) return;
        setSheets(null);
        setSheetsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setSheetsLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sheet` is
    // read but deliberately not a dependency: re-running this whenever the
    // user picks a DIFFERENT sheet from the dropdown below would re-fetch
    // the exact same file pointlessly. Only a changed `path` should ever
    // trigger a re-inspect.
  }, [path]);

  const choosePath = async () => {
    const chosen = await window.alteraStudio.chooseInputDataFile();
    if (chosen) {
      setPath(chosen);
      setSheet(undefined);
    }
  };

  if (!payload) return null;

  const handleApply = () => {
    const params: InputDataParams = { path, sheet: isExcelPath(path) ? sheet : undefined };
    window.alteraStudio.applyInputData({ nodeId: payload.nodeId, params });
  };

  return (
    <ConfigProvider theme={antTheme}>
      <div className="export-window">
        <div className="unique-app-outer">
          <div className="unique-app">
            <div className="unique-section">
              <div className="unique-section-label">File</div>
              <div className="export-path-row">
                <span className="export-path-value" title={path || undefined}>
                  {path ? fileName(path) : "No file chosen"}
                </span>
                <button className="btn-add-condition" onClick={choosePath}>Choose file…</button>
              </div>
              <p className="change-type-hint">Reads an Excel (.xlsx/.xls) or CSV/TSV file straight off disk, no upstream connection needed.</p>
            </div>

            {isExcelPath(path) && (
              <div className="unique-section">
                <div className="unique-section-label">Sheet</div>
                {sheetsError ? (
                  <p className="change-type-hint">Could not read sheets: {sheetsError}</p>
                ) : (
                  <Select
                    style={{ width: "100%" }}
                    value={sheet}
                    onChange={setSheet}
                    loading={sheetsLoading}
                    disabled={sheetsLoading || !sheets || sheets.length === 0}
                    placeholder={sheetsLoading ? "Reading sheets…" : "Choose a sheet…"}
                    options={(sheets ?? []).map((s) => ({ label: s, value: s }))}
                  />
                )}
              </div>
            )}
          </div>
        </div>
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeInputDataWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={!path || (isExcelPath(path) && (sheetsLoading || !!sheetsError))}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
