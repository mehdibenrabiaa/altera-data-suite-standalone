import React from "react";
import { Segmented, InputNumber, Typography } from "antd";
import { ScissorOutlined, ApartmentOutlined, FileImageOutlined, BgColorsOutlined } from "@ant-design/icons";
import SectionCard from "./SectionCard";
import Toggle from "./Toggle";
import type { SettingsPayload } from "../types";
import styles from "../styles/Settings.module.css";

const { Text } = Typography;

interface PreferencesTabProps {
  values: SettingsPayload;
  onChange: (patch: Partial<SettingsPayload>) => void;
}

// The app's own real, wired preferences (unlike Appearance/Activation,
// which are ported demo/placeholder tabs) -- same fields the old single-
// page SettingsWindow rendered, just restyled onto the SectionCard/
// settingRow chrome the rest of these tabs use, for a consistent look.
const PreferencesTab: React.FC<PreferencesTabProps> = ({ values, onChange }) => {
  const { sample, schemaSampleRowLimit, schemaPageLimit, autoExpandOutputDrawer, pdfRenderDpi, numPages, theme } = values;

  return (
    <>
      <SectionCard title="Theme" icon={<BgColorsOutlined />}>
        <div className={styles.settingRow}>
          <Text strong className={styles.settingLabel}>Appearance</Text>
          <Segmented
            size="small"
            options={[{ label: "Light", value: "light" }, { label: "Dark", value: "dark" }]}
            value={theme}
            onChange={(v) => onChange({ theme: v as "light" | "dark" })}
          />
        </div>
      </SectionCard>

      <SectionCard title="Sample Mode" icon={<ScissorOutlined />}>
        <div className={styles.settingRow}>
          <Text strong className={styles.settingLabel}>Enable</Text>
          <Toggle checked={sample.enabled} onChange={(v) => onChange({ sample: { ...sample, enabled: v } })} />
        </div>
        <div style={{ opacity: sample.enabled ? 1 : 0.35, pointerEvents: sample.enabled ? "all" : "none" }}>
          <div className={styles.settingRow}>
            <Text strong className={styles.settingLabel}>Mode</Text>
            <Segmented
              size="small"
              options={[{ label: "Page Range", value: "range" }, { label: "First N Pages", value: "first_n" }]}
              value={sample.mode}
              onChange={(v) => onChange({ sample: { ...sample, mode: v as "range" | "first_n" } })}
            />
          </div>
          <div className={styles.settingRow} style={{ display: sample.mode === "range" ? "flex" : "none" }}>
            <Text strong className={styles.settingLabel}>Start / End</Text>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <InputNumber
                size="small" min={1} max={numPages || undefined}
                value={sample.startPage}
                onChange={(v) => onChange({ sample: { ...sample, startPage: v ?? 1 } })}
                style={{ width: 65 }}
              />
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>to</span>
              <InputNumber
                size="small" min={sample.startPage} max={numPages || undefined}
                value={sample.endPage}
                onChange={(v) => onChange({ sample: { ...sample, endPage: v ?? 1 } })}
                style={{ width: 65 }}
              />
              {numPages > 0 && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>/ {numPages}</span>}
            </div>
          </div>
          <div className={styles.settingRow} style={{ display: sample.mode === "first_n" ? "flex" : "none" }}>
            <Text strong className={styles.settingLabel}>First N</Text>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <InputNumber
                size="small" min={1} max={numPages || undefined}
                value={sample.firstN}
                onChange={(v) => onChange({ sample: { ...sample, firstN: v ?? 1 } })}
                style={{ width: 65 }}
              />
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>pages</span>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Workflow Preview" icon={<ApartmentOutlined />}>
        <div className={styles.settingRow}>
          <div>
            <Text strong className={styles.settingLabel}>Sample rows per table</Text>
          </div>
          <InputNumber
            size="small" min={1} max={100}
            value={schemaSampleRowLimit}
            onChange={(v) => onChange({ schemaSampleRowLimit: v ?? 10 })}
            style={{ width: 65 }}
          />
        </div>
        <div className={styles.settingRow}>
          <div>
            <Text strong className={styles.settingLabel}>Sample pages for preview</Text>
          </div>
          <InputNumber
            size="small" min={1} max={numPages || undefined}
            value={schemaPageLimit}
            onChange={(v) => onChange({ schemaPageLimit: v ?? 10 })}
            style={{ width: 65 }}
          />
        </div>
        <div className={styles.settingRow}>
          <div>
            <Text strong className={styles.settingLabel}>Auto-open output preview on select</Text>
          </div>
          <Toggle checked={autoExpandOutputDrawer} onChange={(v) => onChange({ autoExpandOutputDrawer: v })} />
        </div>
      </SectionCard>

      <SectionCard title="PDF Rendering" icon={<FileImageOutlined />}>
        <div className={styles.settingRow}>
          <div>
            <Text strong className={styles.settingLabel}>Render DPI</Text>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <InputNumber
              size="small" min={72} max={600} step={24}
              value={pdfRenderDpi}
              onChange={(v) => onChange({ pdfRenderDpi: v ?? 288 })}
              style={{ width: 70 }}
            />
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>dpi</span>
          </div>
        </div>
        <div className={styles.settingRow}>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Lower values render pages faster at lower on-screen sharpness. Does not affect annotation or extraction accuracy.
          </span>
        </div>
      </SectionCard>
    </>
  );
};

export default PreferencesTab;
