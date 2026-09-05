import { Divider } from "antd";
import GrooveSwitch from "../components/GrooveSwitch";

interface CanvasTogglesProps {
  sampleEnabled: boolean;
  onToggleSample: (v: boolean) => void;
  showLabels: boolean;
  onToggleShowLabels: (v: boolean) => void;
}

// The SM (sample pages) / TAG (table name labels) toggles -- used to live in
// their own dock panel alongside a Settings gear button (removed; Settings
// is reachable from the File menu / Ctrl+, instead) -- rendered directly in
// the page-nav footer (App.tsx's .app-footer) so they stay visible
// regardless of which dock panel/tab is currently active.
export function CanvasToggles({
  sampleEnabled,
  onToggleSample,
  showLabels,
  onToggleShowLabels,
}: CanvasTogglesProps) {
  return (
    <div className="footer-canvas-toggles">
      <div className="groove-toggle-group" title="Toggle page sampling (S)">
        <span className={`groove-toggle-label ${sampleEnabled ? "active" : ""}`}>SM</span>
        <GrooveSwitch checked={sampleEnabled} onChange={onToggleSample} />
      </div>
      <Divider type="vertical" style={{ width: "1px", height: "20px", backgroundColor: "#cccccc", margin: "0 4px" }} />
      <div className="groove-toggle-group" title="Toggle table name labels (T)">
        <span className={`groove-toggle-label ${showLabels ? "active" : ""}`}>TAG</span>
        <GrooveSwitch checked={showLabels} onChange={onToggleShowLabels} />
      </div>
    </div>
  );
}
