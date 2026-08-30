import { Divider } from "antd";
import gearIcon from "../../public/gear.svg";
import GrooveSwitch from "../components/GrooveSwitch";

interface SettingsPanelProps {
  onOpenSettings: () => void;
  sampleEnabled: boolean;
  onToggleSample: (v: boolean) => void;
  showLabels: boolean;
  onToggleShowLabels: (v: boolean) => void;
}

export default function SettingsPanel({
  onOpenSettings,
  sampleEnabled,
  onToggleSample,
  showLabels,
  onToggleShowLabels,
}: SettingsPanelProps) {
  return (
    <div className="settingsbar-panel-body">
      <button className="toolbar-btn ps-tool-btn" onClick={onOpenSettings} title="Settings">
        <img src={gearIcon} alt="Settings" />
      </button>
      <Divider type="vertical" style={{ width: "1px", height: "28px", backgroundColor: "#cccccc", margin: "0 4px" }} />
      <div className="groove-toggle-group" title="Toggle page sampling (S)">
        <span className={`groove-toggle-label ${sampleEnabled ? "active" : ""}`}>SM</span>
        <GrooveSwitch checked={sampleEnabled} onChange={onToggleSample} />
      </div>
      <div className="groove-toggle-group" title="Toggle table name labels (T)">
        <span className={`groove-toggle-label ${showLabels ? "active" : ""}`}>TAG</span>
        <GrooveSwitch checked={showLabels} onChange={onToggleShowLabels} />
      </div>
    </div>
  );
}
