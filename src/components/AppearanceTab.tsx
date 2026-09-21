import React from "react";
import { Slider, Segmented, Space, Typography } from "antd";
import {
  BgColorsOutlined,
  DesktopOutlined,
} from "@ant-design/icons";
import SectionCard from "./SectionCard";
import styles from "../styles/Settings.module.css";

const { Text } = Typography;

interface AppearanceTabProps {
  // Both real, persisted SettingsPayload fields (widgetZoom/theme) --
  // passed in directly from SettingsWindow.tsx rather than through a
  // separate demo-only shape, so they keep writing to the same real
  // settings.json fields PreferencesTab's other controls use.
  zoom: number;
  onZoomChange: (zoom: number) => void;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
}

const AppearanceTab: React.FC<AppearanceTabProps> = ({
  zoom,
  onZoomChange,
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
              value={zoom}
              onChange={(value) => onZoomChange(value)}
              style={{ width: 130 }}
              tooltip={{ open: false }}
            />
            <Text className={styles.sliderValue}>{zoom}%</Text>
          </Space>
        </div>
      </SectionCard>
    </>
  );
};

export default AppearanceTab;
