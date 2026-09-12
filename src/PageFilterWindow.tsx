import { useEffect, useState } from "react";
import { ConfigProvider, Select } from "antd";
import type { PageFilterParams } from "./types";
import type { PageFilterWindowPayload } from "./vite-env";
import "./App.css";

const antTheme = { token: { borderRadius: 0, borderRadiusLG: 0, borderRadiusSM: 0, controlHeight: 28, fontSize: 13, fontFamily: '"Google Sans Flex", sans-serif', colorPrimary: "#FE4D41", colorText: "#1a1a1a", colorBgContainer: "#fff" } };
export default function PageFilterWindow() {
  const [payload, setPayload] = useState<PageFilterWindowPayload | null>(null);
  const [mode, setMode] = useState<PageFilterParams["mode"]>("keep");
  const [column, setColumn] = useState("");

  useEffect(() => {
    let live = true;
    const load = (next: PageFilterWindowPayload) => { if (live) { setPayload(next); setMode(next.initialParams.mode); setColumn(next.initialParams.column || next.columns[0] || ""); } };
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestPageFilterInit(nodeId).then((next) => next && load(next));
    const unsubscribe = window.alteraStudio.onPageFilterInit(load);
    return () => { live = false; unsubscribe(); };
  }, []);

  useEffect(() => { document.title = payload ? `Configure - ${payload.nodeName}` : "Configure Node"; }, [payload]);
  if (!payload) return null;
  const isValid = Boolean(column);

  return <ConfigProvider theme={antTheme}>
    <div className="cleaner-window">
      <div className="cleaner-app-outer"><div className="cleaner-app page-filter-config">
        <div className="cleaner-op-card">
          <div className="page-filter-field">
            <span className="cleaner-param-label">Action</span>
            <div className="match-toggle">
              <button className={`match-toggle-btn${mode === "keep" ? " active" : ""}`} onClick={() => setMode("keep")}>Keep only pages</button>
              <button className={`match-toggle-btn${mode === "exclude" ? " active" : ""}`} onClick={() => setMode("exclude")}>Exclude pages</button>
            </div>
          </div>
          <div className="page-filter-field">
            <label className="cleaner-param-label">Page-number column</label>
            <Select value={column || undefined} onChange={setColumn} options={payload.columns.map((name) => ({ value: name, label: name }))} placeholder="Select a column" />
          </div>
        </div>
      </div></div>
      <div className="filter-builder-footer">
        <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closePageFilterWindow()}>Cancel</button>
        <button className="filter-builder-btn-primary" disabled={!isValid} onClick={() => window.alteraStudio.applyPageFilter({ nodeId: payload.nodeId, params: { mode, column } })}>Apply</button>
      </div>
    </div>
  </ConfigProvider>;
}
