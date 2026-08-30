import React from "react";
import { Slider, Select, Space, Typography } from "antd";
import {
  BgColorsOutlined,
  ToolOutlined,
  DesktopOutlined,
} from "@ant-design/icons";
import SectionCard from "./SectionCard";
import Toggle from "./Toggle";
import type { AppearanceSettings, AppearanceSettingChangeHandler } from "../settingsAppTypes";
import styles from "../styles/Settings.module.css";

const { Text } = Typography;
const { Option } = Select;

interface AppearanceTabProps {
  settings: AppearanceSettings;
  onChange: AppearanceSettingChangeHandler;
}

interface AccentColor {
  name: string;
  value: string;
}

const AppearanceTab: React.FC<AppearanceTabProps> = ({
  settings,
  onChange,
}) => {
  const accentColors: AccentColor[] = [
    { name: "Light", value: "#d9d9d9" },
    { name: "Dark", value: "#262626" },
  ];

  const fontSizeOptions = [
    { label: "Small (12px)", value: "small" as const },
    { label: "Medium (14px)", value: "medium" as const },
    { label: "Large (16px)", value: "large" as const },
  ];

  return (
    <>
      <SectionCard
        title="Display"
        icon={<DesktopOutlined />}
      >
        <div className={styles.settingRow}>
          <div>
            <Text strong className={styles.settingLabel}>
              Widget Zoom
            </Text>
            <div className={styles.settingDesc}>Scale the widget interface</div>
          </div>
          <Space size="middle">
            <Slider
              className={styles.customSlider}
              min={70}
              max={130}
              step={5}
              value={settings.zoom}
              onChange={(value) => onChange("zoom", value)}
              style={{ width: 130 }}
              tooltip={{ open: false }}
            />
            <Text className={styles.sliderValue}>{settings.zoom}%</Text>
          </Space>
        </div>

        <div className={styles.settingRow}>
          <div>
            <Text strong className={styles.settingLabel}>
              Font Size
            </Text>
            <div className={styles.settingDesc}>
              Base text size across all widgets
            </div>
          </div>
          <Select
            value={settings.fontSize}
            onChange={(value) => onChange("fontSize", value)}
            className={styles.styledSelect}
          >
            {fontSizeOptions.map((opt) => (
              <Option key={opt.value} value={opt.value}>
                {opt.label}
              </Option>
            ))}
          </Select>
        </div>

        <div className={styles.settingRow}>
          <div>
            <Text strong className={styles.settingLabel}>
              Compact Mode
            </Text>
            <div className={styles.settingDesc}>
              Reduce padding and spacing in widgets
            </div>
          </div>
          <Toggle
            checked={settings.compact}
            onChange={(checked: boolean) => onChange("compact", checked)}
          />
        </div>
      </SectionCard>

      <SectionCard
        title="Accent Color"
        icon={<BgColorsOutlined />}
      >
        <div className={styles.settingRow}>
          <div>
            <Text strong className={styles.settingLabel}>
              Theme Color
            </Text>
            <div className={styles.settingDesc}>
              Applied across buttons and highlights
            </div>
          </div>
          <Space size="small" className={styles.swatchRow}>
            {accentColors.map((c) => (
              <div
                key={c.value}
                title={c.name}
                className={`${styles.swatch} ${settings.accentColor === c.value ? styles.activeSwatch : ""}`}
                style={{ backgroundColor: c.value }}
                onClick={() => onChange("accentColor", c.value)}
                role="button"
                tabIndex={0}
                onKeyPress={(e) =>
                  e.key === "Enter" && onChange("accentColor", c.value)
                }
              />
            ))}
          </Space>
        </div>
      </SectionCard>

      <SectionCard
        title="Behaviour"
        icon={<ToolOutlined />}
      >
        <div className={styles.settingRow}>
          <div>
            <Text strong className={styles.settingLabel}>
              Show Tooltips
            </Text>
            <div className={styles.settingDesc}>Display help text on hover</div>
          </div>
          <Toggle
            checked={settings.tooltips}
            onChange={(checked: boolean) => onChange("tooltips", checked)}
          />
        </div>

        <div className={styles.settingRow}>
          <div>
            <Text strong className={styles.settingLabel}>
              Auto-apply Changes
            </Text>
            <div className={styles.settingDesc}>
              Process output without clicking Apply
            </div>
          </div>
          <Toggle
            checked={settings.autoApply}
            onChange={(checked: boolean) => onChange("autoApply", checked)}
          />
        </div>

        <div className={styles.settingRow}>
          <div>
            <Text strong className={styles.settingLabel}>
              Confirm Destructive Actions
            </Text>
            <div className={styles.settingDesc}>
              Prompt before deleting operations
            </div>
          </div>
          <Toggle
            checked={settings.confirmDelete}
            onChange={(checked: boolean) => onChange("confirmDelete", checked)}
          />
        </div>
      </SectionCard>
    </>
  );
};

export default AppearanceTab;
