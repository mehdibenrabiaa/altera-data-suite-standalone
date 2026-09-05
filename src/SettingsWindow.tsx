import { useEffect, useState, useCallback } from "react";
import { ConfigProvider, Tabs, Button } from "antd";
import "antd/dist/reset.css";
import "./App.css";
import PreferencesTab from "./components/PreferencesTab";
import AppearanceTab from "./components/AppearanceTab";
import ActivationTab from "./components/ActivationTab";
import AboutTab from "./components/AboutTab";
import type { SystemVersionInfo } from "./components/ActivationTab";
import type { SettingsPayload } from "./types";
import type { AppearanceSettings, LicenseStatus, LicenseInfo } from "./settingsAppTypes";
import styles from "./styles/Settings.module.css";

const ANT_THEME_BASE = {
  borderRadius: 0,
  borderRadiusLG: 0,
  borderRadiusSM: 0,
  controlHeight: 28,
  controlHeightSM: 24,
  fontSize: 13,
  fontFamily: '"Google Sans Flex", sans-serif',
  paddingSM: 8,
  motionDurationFast: "0s",
  motionDurationMid: "0s",
  motionDurationSlow: "0s",
};

// Rendered in its own native BrowserWindow (see electron/main.ts's
// settings:open handler and src/main.tsx's ?view=settings routing) instead
// of the in-page modal this replaced -- there's no backdrop/overlay to
// manage here since the window itself is the dialog. Shell ported from
// devkit/settings (Tabs + SectionCard chrome) -- "Preferences" is this
// app's own real, wired settings (unchanged content, just restyled).
// Activation is also real: it talks to this app's own FastAPI backend
// (backend/app/routers/licensing.py), a direct port of the Qt widgets'
// real licensing logic and the same production license server. Appearance
// is still a demo -- its toggles aren't wired to anything yet.
// Dev-only fallback so this window is inspectable in a plain browser tab
// (window.alteraStudio doesn't exist outside Electron's preload bridge) --
// same spirit as ActivationTab's own window.qt-less dev simulation.
const DEV_FALLBACK_VALUES: SettingsPayload = {
  sample: { enabled: false, mode: "first_n", startPage: 1, endPage: 1, firstN: 10 },
  closeAfterConvert: false,
  schemaSampleRowLimit: 10,
  schemaPageLimit: 10,
  autoExpandOutputDrawer: true,
  pdfRenderDpi: 288,
  numPages: 0,
  theme: "light",
};

// Same light/dark tokens as App.css's [data-theme] block (see that file's
// "Theme tokens" comment) -- this window is a separate document that
// doesn't inherit the main window's CSS custom properties, so antd's own
// ConfigProvider tokens need the equivalent values duplicated here.
const ANT_THEME_TOKENS = {
  light: {
    colorBorder: "#e0e0e0",
    // Tabs' own nav-underline divider reads from this, separately from
    // colorBorder above -- left at antd's own light default until now, so
    // dark mode never actually touched it either.
    colorBorderSecondary: "#e0e0e0",
    colorPrimaryHover: "#bbb",
    colorPrimary: "#FE4D41",
    colorText: "#1a1a1a",
    colorTextPlaceholder: "#999",
    colorBgContainer: "#ffffff",
    colorBgElevated: "#ffffff",
  },
  dark: {
    colorBorder: "#454545",
    colorBorderSecondary: "#454545",
    colorPrimaryHover: "#ff8177",
    colorPrimary: "#FE4D41",
    colorText: "#e8e8e8",
    colorTextPlaceholder: "#8a8a8a",
    colorBgContainer: "#2b2b2b",
    colorBgElevated: "#333333",
  },
};

export default function SettingsWindow() {
  const [values, setValues] = useState<SettingsPayload | null>(null);

  // Live preview as the Preferences tab's own theme control is toggled
  // (see App.css's [data-theme="dark"] overrides, shared via that file's
  // import above) -- takes effect immediately, before Save is even clicked.
  useEffect(() => {
    if (values) document.documentElement.setAttribute("data-theme", values.theme);
  }, [values]);

  useEffect(() => {
    document.title = "Settings";
    if (!window.alteraStudio) {
      setValues(DEV_FALLBACK_VALUES);
      return;
    }
    // Pull the current values once this component has actually mounted,
    // rather than relying on the main process pushing them at
    // did-finish-load -- that fires before this (lazy-loaded) component
    // exists to listen, and the push gets silently dropped.
    window.alteraStudio.requestSettingsInit().then((v) => v && setValues(v));
    // Still listen for pushes too, for the "window already open, a second
    // settings:open call reseeds it" case -- no race there since the
    // listener's long since registered by then.
    return window.alteraStudio.onSettingsInit(setValues);
  }, []);

  const [activeTab, setActiveTab] = useState("preferences");

  // ── Appearance/Activation/About state -- ported verbatim from
  // devkit/settings/src/components/Settings.tsx. Not persisted anywhere
  // (Appearance's own comment there notes it's demo-only; a real
  // Electron-side wiring is a separate piece of work). ──
  const [appearance, setAppearance] = useState<AppearanceSettings>({
    zoom: 90,
    fontSize: "medium",
    compact: false,
    tooltips: true,
    autoApply: true,
    confirmDelete: true,
    accentColor: "#fd4728",
  });
  const [systemInfo, setSystemInfo] = useState<SystemVersionInfo | null>(null);
  // Only the setter is used -- ActivationTab now owns its own status (it
  // fetches from the real backend on mount) and just mirrors updates up via
  // onStatusChange for any future consumer; nothing here reads the value.
  const [, setLicenseStatus] = useState<LicenseStatus>({ state: "invalid" });

  const handleAppearanceChange = <K extends keyof AppearanceSettings>(key: K, value: AppearanceSettings[K]): void => {
    setAppearance((prev) => ({ ...prev, [key]: value }));
  };
  const handleActivate = (info: LicenseInfo): void => {
    setLicenseStatus({ state: "valid", ...info });
  };
  const handleDeactivate = (): void => {
    setLicenseStatus({ state: "invalid", email: undefined, plan: undefined, expiry: undefined });
  };
  const handleSystemInfo = useCallback((info: SystemVersionInfo): void => {
    setSystemInfo(info);
  }, []);

  if (!values) return null;

  const update = (patch: Partial<SettingsPayload>) => setValues((v) => (v ? { ...v, ...patch } : v));

  const antTheme = { token: { ...ANT_THEME_BASE, ...ANT_THEME_TOKENS[values.theme] } };

  const tabItems = [
    {
      key: "preferences",
      label: "Preferences",
      children: <PreferencesTab values={values} onChange={update} />,
    },
    {
      key: "appearance",
      label: "Appearance",
      children: <AppearanceTab settings={appearance} onChange={handleAppearanceChange} />,
    },
    {
      key: "activation",
      label: "Activation",
      children: (
        <ActivationTab
          onActivate={handleActivate}
          onDeactivate={handleDeactivate}
          onStatusChange={setLicenseStatus}
          onSystemInfo={handleSystemInfo}
        />
      ),
    },
    {
      key: "about",
      label: "About",
      children: <AboutTab systemInfo={systemInfo} />,
    },
  ];

  return (
    <ConfigProvider theme={antTheme}>
      {/* Keeps the "settings-window" class too -- App.css's existing
          .settings-window-scoped overrides (flattening ant-segmented/
          ant-input-number to the app's sharp-corner look, disabling
          transitions) still apply on top of the new styles.settingsRoot
          layout/tabs chrome from Settings.module.css. Explicit inline
          height (not just the two classes' own `height: 100vh`/`100%`,
          which tie in specificity and can lose the cascade depending on
          CSS import order) is what actually guarantees this div fills the
          window -- without a real height here, the flex column has
          nothing to grow the Tabs pane into, so it shrinks to fit its
          content and the Cancel/Save footer ends up stranded right under
          the last tab row instead of pinned to the window's bottom edge. */}
      <div className={`settings-window ${styles.settingsRoot}`} style={{ height: "100vh" }}>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={tabItems}
          className={styles.customTabs}
        />
        <div className="settings-panel-footer">
          <Button size="small" onClick={() => window.alteraStudio?.closeSettingsWindow()}>Cancel</Button>
          <Button size="small" type="primary" onClick={() => window.alteraStudio?.saveSettings(values)}>Save</Button>
        </div>
      </div>
    </ConfigProvider>
  );
}
