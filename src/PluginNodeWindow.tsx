import { useEffect, useState } from "react";
import { ConfigProvider, Input, InputNumber, Select, Switch, theme as antdTheme } from "antd";
import type { PluginNodeWindowPayload } from "./vite-env";
import "./App.css";

// The one shared Configure window for every plugin node (src/plugins.ts) --
// renders a plain form from the manifest's own `fields` array instead of
// each plugin needing its own hand-written window like every built-in node
// (SortWindow.tsx etc.) has. Same overall chrome/lifecycle as those windows
// (see SortWindow.tsx for the fuller version this is trimmed from): fetch
// the current payload on mount, edit local state, round-trip on Apply.
function buildAntTheme(theme: "light" | "dark") {
  return {
    algorithm: theme === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      borderRadius: 0,
      borderRadiusLG: 0,
      borderRadiusSM: 0,
      controlHeight: 28,
      controlHeightSM: 24,
      fontSize: 13,
      fontFamily: '"Google Sans Flex", sans-serif',
      colorPrimaryHover: "#bbb",
      colorPrimary: "#FE4D41",
      motionDurationFast: "0s",
      motionDurationMid: "0s",
      motionDurationSlow: "0s",
    },
  };
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

export default function PluginNodeWindow() {
  const [payload, setPayload] = useState<PluginNodeWindowPayload | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", payload?.theme ?? "light");
  }, [payload?.theme]);

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race every
    // other Configure window guards against.
    let live = true;
    function loadPayload(p: PluginNodeWindowPayload) {
      if (!live) return;
      setPayload(p);
      setValues(p.initialParams ?? {});
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestPluginNodeInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onPluginNodeInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Configure — ${payload.nodeName}` : "Configure Node";
  }, [payload]);

  if (!payload) return null;
  const showEmpty = payload.fields.some((f) => f.type === "column" || f.type === "columns") && payload.columns.length === 0;

  const setField = (key: string, value: unknown) => setValues((v) => ({ ...v, [key]: value }));

  const handleApply = () => {
    window.alteraStudio.applyPluginNode({ nodeId: payload.nodeId, params: values });
  };

  return (
    <ConfigProvider theme={buildAntTheme(payload.theme)}>
      <div className="cleaner-window">
        {showEmpty ? (
          <div className="filter-empty-state">
            <LinkIcon />
            <h3>No Data Connected</h3>
            <p>Connect a data table to configure {payload.pluginName}</p>
          </div>
        ) : (
          <div className="cleaner-app-outer">
            <div className="cleaner-app">
              {payload.fields.length === 0 ? (
                <p style={{ opacity: 0.6, fontSize: 13 }}>This node has no settings.</p>
              ) : (
                payload.fields.map((field) => (
                  <div key={field.key} className="cleaner-op-card">
                    <div className="cleaner-param-row">
                      <span className="cleaner-param-label">{field.label}</span>
                      {field.type === "text" && (
                        <Input
                          style={{ width: "100%" }}
                          value={(values[field.key] as string) ?? ""}
                          onChange={(e) => setField(field.key, e.target.value)}
                        />
                      )}
                      {field.type === "number" && (
                        <InputNumber
                          style={{ width: "100%" }}
                          value={values[field.key] as number | undefined}
                          onChange={(v) => setField(field.key, v)}
                        />
                      )}
                      {field.type === "toggle" && (
                        <Switch
                          checked={!!values[field.key]}
                          onChange={(v) => setField(field.key, v)}
                        />
                      )}
                      {field.type === "select" && (
                        <Select
                          style={{ width: "100%" }}
                          value={values[field.key] as string | undefined}
                          onChange={(v) => setField(field.key, v)}
                          options={(field.options ?? []).map((o) => ({ label: o, value: o }))}
                          showSearch
                        />
                      )}
                      {field.type === "column" && (
                        <Select
                          style={{ width: "100%" }}
                          value={values[field.key] as string | undefined}
                          onChange={(v) => setField(field.key, v)}
                          options={payload.columns.map((c) => ({ label: c, value: c }))}
                          placeholder="Column…"
                          showSearch
                        />
                      )}
                      {field.type === "columns" && (
                        <Select
                          mode="multiple"
                          style={{ width: "100%" }}
                          value={(values[field.key] as string[]) ?? []}
                          onChange={(v) => setField(field.key, v)}
                          options={payload.columns.map((c) => ({ label: c, value: c }))}
                          placeholder="Columns…"
                        />
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closePluginNodeWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
