import type { Dispatch, SetStateAction } from "react";
import { InputNumber } from "antd";
import type { CamelotSettings, Rectangle, Group } from "../types";
import { fillToHex } from "../colorUtils";
import GrooveSwitch from "../components/GrooveSwitch";

interface PropertiesPanelProps {
  singleSelectedRect: Rectangle | null;
  selectedCount: number;
  groups: Group[];
  setRectangles: Dispatch<SetStateAction<Rectangle[]>>;
}

export default function PropertiesPanel({
  singleSelectedRect,
  selectedCount,
  groups,
  setRectangles,
}: PropertiesPanelProps) {
  if (!singleSelectedRect) {
    return (
      <div className="properties-panel-body properties-empty">
        {selectedCount > 1
          ? "Multiple tables selected. Select a single table to edit its properties."
          : "Select a table to edit its properties."}
      </div>
    );
  }

  const rect = singleSelectedRect;
  const adaptive = rect.autoDetectColumns === true;
  const camelotSettings = rect.camelotSettings ?? {};
  const engineMode = camelotSettings.engineMode ?? "flow";
  const groupName = groups.find(g => g.id === rect.groupId)?.name ?? "None";
  const colorHex = fillToHex(rect.fill);
  const updateCamelotSettings = (changes: CamelotSettings) => {
    setRectangles(prev => prev.map(r => r.id === rect.id
      ? { ...r, camelotSettings: { ...r.camelotSettings, ...changes } }
      : r));
  };

  return (
    <div className="properties-panel-body">
      {/* Extraction engine toggle */}
      <div className="properties-row" style={{ justifyContent: "space-between" }}>
        <div className="properties-label" style={{ display: "flex", alignItems: "center", gap: 5 }}>
          Adaptive Engine
          <a
            href="https://alteradatasuite.com/en/docs"
            className="properties-help-btn"
            title="What's the difference between Precision and Adaptive?"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              window.alteraStudio.openExternalUrl("https://alteradatasuite.com/en/docs");
            }}
          >
            ?
          </a>
        </div>
        <div className="groove-toggle-group" title="Toggle adaptive column detection">
          <span className={`groove-toggle-label ${adaptive ? "active" : ""}`}>ADAPT</span>
          <GrooveSwitch
            checked={adaptive}
            onChange={(checked) => {
              setRectangles(prev => prev.map(r =>
                r.id === rect.id ? { ...r, autoDetectColumns: checked } : r
              ));
            }}
          />
        </div>
      </div>

      <div className={`properties-tuning-box${adaptive ? "" : " disabled"}`} aria-disabled={!adaptive}>
        <div className="properties-tuning-heading">Adaptive Engine tuning</div>
        <div className="properties-info-row">
          <span className="properties-info-label">Extraction mode</span>
          <div className="properties-mode-toggle" role="group" aria-label="Adaptive Engine extraction mode">
            <button type="button" className={engineMode === "flow" ? "active" : ""} disabled={!adaptive} onClick={() => updateCamelotSettings({ engineMode: "flow" })} title="Best for tables separated by whitespace">Flow</button>
            <button type="button" className={engineMode === "grid" ? "active" : ""} disabled={!adaptive} onClick={() => updateCamelotSettings({ engineMode: "grid" })} title="Best for tables with visible grid lines">Grid</button>
          </div>
        </div>
        {engineMode === "flow" ? <>
          <div className="properties-info-row">
            <label className="properties-info-label" htmlFor="adaptive-row-tolerance">Row tolerance</label>
            <InputNumber id="adaptive-row-tolerance" className="properties-number-input" min={0} max={50} disabled={!adaptive} value={camelotSettings.rowTolerance ?? 2} onChange={(value) => updateCamelotSettings({ rowTolerance: Math.max(0, Math.min(50, Number(value) || 0)) })} />
          </div>
          <div className="properties-info-row">
            <label className="properties-info-label" htmlFor="adaptive-column-tolerance">Column tolerance</label>
            <InputNumber id="adaptive-column-tolerance" className="properties-number-input" min={0} max={50} disabled={!adaptive} value={camelotSettings.columnTolerance ?? 0} onChange={(value) => updateCamelotSettings({ columnTolerance: Math.max(0, Math.min(50, Number(value) || 0)) })} />
          </div>
        </> : <>
          <div className="properties-info-row">
            <label className="properties-info-label" htmlFor="adaptive-line-sensitivity">Line sensitivity</label>
            <InputNumber id="adaptive-line-sensitivity" className="properties-number-input" min={1} max={50} disabled={!adaptive} value={camelotSettings.lineSensitivity ?? 15} onChange={(value) => updateCamelotSettings({ lineSensitivity: Math.max(1, Math.min(50, Number(value) || 1)) })} />
          </div>
          <div className="properties-info-row">
            <label className="properties-info-label" htmlFor="adaptive-line-tolerance">Line tolerance</label>
            <InputNumber id="adaptive-line-tolerance" className="properties-number-input" min={0} max={50} disabled={!adaptive} value={camelotSettings.lineTolerance ?? 2} onChange={(value) => updateCamelotSettings({ lineTolerance: Math.max(0, Math.min(50, Number(value) || 0)) })} />
          </div>
          <div className="properties-info-row">
            <label className="properties-info-label" htmlFor="adaptive-joint-tolerance">Joint tolerance</label>
            <InputNumber id="adaptive-joint-tolerance" className="properties-number-input" min={0} max={50} disabled={!adaptive} value={camelotSettings.jointTolerance ?? 2} onChange={(value) => updateCamelotSettings({ jointTolerance: Math.max(0, Math.min(50, Number(value) || 0)) })} />
          </div>
          <div className="properties-info-row">
            <span className="properties-info-label">Read background lines</span>
            <GrooveSwitch checked={camelotSettings.processBackground ?? false} onChange={(checked) => adaptive && updateCamelotSettings({ processBackground: checked })} />
          </div>
        </>}
        <div className="properties-info-row">
          <span className="properties-info-label">Split text across columns</span>
          <GrooveSwitch checked={camelotSettings.splitText ?? true} onChange={(checked) => updateCamelotSettings({ splitText: checked })} />
        </div>
        <div className="properties-info-row">
          <label className="properties-info-label" htmlFor="adaptive-strip-text">Remove characters</label>
          <input
            id="adaptive-strip-text"
            className="properties-text-input"
            type="text"
            maxLength={128}
            disabled={!adaptive}
            value={camelotSettings.stripText ?? ""}
            placeholder="None"
            onChange={(event) => updateCamelotSettings({ stripText: event.target.value })}
          />
        </div>
      </div>

      {/* Read-only info: Label / Group / Color */}
      <div className="properties-info-box">
        <div className="properties-info-row">
          <span className="properties-info-label">Label</span>
          <span className="properties-info-value">{rect.name || "—"}</span>
        </div>
        <div className="properties-info-row">
          <span className="properties-info-label">Group</span>
          <span className="properties-info-value">{groupName}</span>
        </div>
        <div className="properties-info-row">
          <span className="properties-info-label">Color</span>
          <span className="properties-info-value">
            <span className="properties-color-swatch" style={{ background: colorHex }} />
            {colorHex}
          </span>
        </div>
      </div>
    </div>
  );
}
