import React from "react";
import { Slider, Segmented, Space, Typography } from "antd";
import {
  BgColorsOutlined,
  DesktopOutlined,
} from "@ant-design/icons";
import SectionCard from "./SectionCard";
import type { AppearanceSettings, AppearanceSettingChangeHandler } from "../settingsAppTypes";
import styles from "../styles/Settings.module.css";

const { Text } = Typography;

interface AppearanceTabProps {
  settings: AppearanceSettings;
  onChange: AppearanceSettingChangeHandler;
  // Real, persisted setting (SettingsPayload.theme) -- unlike Widget Zoom
  // below, which is still the ported demo (see this file's own settings/
  // onChange props above, a separate AppearanceSettings shape that never
  // reaches disk). Passed in separately from SettingsWindow.tsx rather
  // than folded into AppearanceSettings, so it keeps writing to the same
  // real settings.json field PreferencesTab used to own.
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
}

const AppearanceTab: React.FC<AppearanceTabProps> = ({
  settings,
  onChange,
  theme,
  onThemeChange,
}) => {
  return (
    <>
      <SectionCard title="Theme" icon={<BgColorsOutlined />}>
        <div className={styles.settingRow}>
          <Text strong className={styles.settingLabel}>Appearance</Text>
          <Segmented
            size="small"
            options={[{ label: "Light", value: "light" }, { label: "Dark", value: "dark" }]}
            value={theme}
            onChange={(v) => onThemeChange(v as "light" | "dark")}
          />
        </div>
      </SectionCard>

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
              min={90}
              max={110}
              step={10}
              marks={{ 90: "90%", 100: "100%", 110: "110%" }}
              value={settings.zoom}
              onChange={(value) => onChange("zoom", value)}
              style={{ width: 130 }}
              tooltip={{ open: false }}
            />
            <Text className={styles.sliderValue}>{settings.zoom}%</Text>
          </Space>
        </div>
      </SectionCard>
    </>
  );
};

export default AppearanceTab;
