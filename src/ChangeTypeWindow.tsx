import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfigProvider, Input, Select } from "antd";
import type { ChangeTypeParams, ChangeTypeTarget, ChangeTypeFieldEntry } from "./types";
import type { ChangeTypeWindowPayload } from "./vite-env";
import { detectColumnType as sharedDetectColumnType, DETECTION_SAMPLE_ROWS } from "./columnTypeDetection";
import "./App.css";

// Configure window for the Change Type node -- a brand-new node, not
// ported from an old Orange widget. UI modeled on Alteryx's own Select
// tool: every field in the table gets its own row with its own type
// dropdown, pre-selected to whatever that column's values currently look
// like -- no separate "Unchanged" placeholder, same as Alteryx's own
// Select. See backend/app/nodes.py's change_type for exactly what counts
// as a successful conversion and how the fill-vs-error policy works.
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
      <p>Connect a data table to change a column's type</p>
    </div>
  );
}

const TYPE_OPTIONS: { value: ChangeTypeTarget; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
];

// Best-effort CLIENT-SIDE detection, used only to pick which type shows
// pre-selected in each row's dropdown -- the actual conversion always
// runs authoritatively in Python on Apply (backend/app/nodes.py's
// _to_number_or_none/_to_date_or_none), so a mismatch here (e.g. a
// column JS happens to parse as a date differently than pandas would)
// only affects the starting selection, never correctness. Built on the
// same shared primitives columnTypeIcons.tsx's header icons use (see
// columnTypeDetection.ts) -- this window only ever offers three target
// types (no separate integer/float split, unlike the icon feature), so
// it keeps its own thin wrapper collapsing those two into "number".
function detectColumnType(values: string[]): ChangeTypeTarget {
  const detected = sharedDetectColumnType(values);
  return detected === "integer" || detected === "float" ? "number" : detected;
}

export default function ChangeTypeWindow() {
  const [payload, setPayload] = useState<ChangeTypeWindowPayload | null>(null);
  const [fields, setFields] = useState<ChangeTypeFieldEntry[]>([]);
  const [fillUnconvertible, setFillUnconvertible] = useState(false);
  const [fallbackValue, setFallbackValue] = useState("");

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: ChangeTypeWindowPayload) {
      if (!live) return;
      setPayload(p);
      // Reconcile against the CURRENT input every time this opens (same
      // reasoning as Column Edit's own fix): keep the saved target type
      // for any field that still exists, default any column not seen
      // before (new, or truly first open) to its own detected type.
      const saved = new Map(p.initialParams.fields?.map((f) => [f.field, f.targetType]) ?? []);
      const sample = p.rows.slice(0, DETECTION_SAMPLE_ROWS);
      setFields(
        p.columns.map((field, i) => ({
          field,
          targetType: saved.get(field) ?? detectColumnType(sample.map((row) => row[i] ?? "")),
        })),
      );
      setFillUnconvertible(p.initialParams.fillUnconvertible ?? false);
      setFallbackValue(p.initialParams.fallbackValue ?? "");
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestChangeTypeInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onChangeTypeInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Configure — ${payload.nodeName}` : "Configure Node";
  }, [payload]);

  const setFieldType = useCallback((field: string, targetType: ChangeTypeTarget) => {
    setFields((prev) => prev.map((f) => (f.field === field ? { ...f, targetType } : f)));
  }, []);

  const anyParseable = useMemo(() => fields.some((f) => f.targetType === "number" || f.targetType === "date"), [fields]);

  if (!payload) return null;
  const showEmpty = payload.columns.length === 0;

  const handleApply = () => {
    const params: ChangeTypeParams = { fields, fillUnconvertible, fallbackValue };
    window.alteraStudio.applyChangeType({ nodeId: payload.nodeId, params });
  };

  return (
    <ConfigProvider theme={antTheme}>
      <div className="change-type-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="change-type-app-outer">
            <div className="change-type-app">
              <div className="change-type-section">
                <div className="change-type-field-head">
                  <span>Field</span>
                  <span>Type</span>
                </div>
                <div className="change-type-field-list">
                  {fields.map((f) => (
                    <div key={f.field} className="change-type-field-row">
                      <span className="change-type-field-name">{f.field}</span>
                      <Select
                        value={f.targetType}
                        onChange={(v) => setFieldType(f.field, v)}
                        options={TYPE_OPTIONS}
                        style={{ width: "100%" }}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {anyParseable && (
                <div className="change-type-section">
                  <div className="change-type-section-label">If a cell can't convert</div>
                  <label className="change-type-fill-row">
                    <input type="checkbox" checked={fillUnconvertible} onChange={(e) => setFillUnconvertible(e.target.checked)} />
                    <span>Fill with a default value instead of stopping</span>
                  </label>
                  {fillUnconvertible ? (
                    <Input
                      value={fallbackValue}
                      onChange={(e) => setFallbackValue(e.target.value)}
                      placeholder="Default value (e.g. 0 or 1970-01-01)"
                    />
                  ) : (
                    <p className="change-type-hint">
                      If any cell can't convert to Number or Date, this node will stop and tell you which columns and how many cells failed.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeChangeTypeWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
