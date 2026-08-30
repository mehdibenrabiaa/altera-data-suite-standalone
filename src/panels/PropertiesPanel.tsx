import type { Dispatch, SetStateAction } from "react";
import type { Rectangle, Group } from "../types";
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
  const groupName = groups.find(g => g.id === rect.groupId)?.name ?? "None";
  const colorHex = fillToHex(rect.fill);

  return (
    <div className="properties-panel-body">
      {/* Extraction engine toggle */}
      <div className="properties-row" style={{ justifyContent: "space-between" }}>
        <div className="properties-label" style={{ display: "flex", alignItems: "center", gap: 5 }}>
          Adaptive Engine
          <a
            href="https://alteradatasuite.com/en/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="properties-help-btn"
            title="What's the difference between Precision and Adaptive?"
            onClick={(e) => e.stopPropagation()}
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
