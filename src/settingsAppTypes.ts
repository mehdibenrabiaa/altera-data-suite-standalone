// Types for the ported settings-app tabs (Appearance/Activation/About) --
// kept separate from the app's own src/types.ts (SettingsPayload etc.,
// which is the real, wired preferences data) since these are a distinct,
// mostly-demo surface ported wholesale from devkit/settings.
export interface AppearanceSettings {
  zoom: number;
  fontSize: "small" | "medium" | "large";
  compact: boolean;
  tooltips: boolean;
  autoApply: boolean;
  confirmDelete: boolean;
  accentColor: string;
}

// email/plan/expiry are optional on every state -- the real backend's JWT
// payload (see backend/app/license_logic.py) carries no email claim at all,
// only `activate`'s own response does. A page-load `check` on an
// already-activated machine genuinely has no email to show, so the type
// has to allow that rather than lying with an empty-string fallback.
export type LicenseStatus =
  | {
      state: "valid";
      email?: string;
      plan?: string;
      expiry?: string;
      message?: string;
    }
  | {
      state: "expired";
      email?: string;
      plan?: string;
      expiry?: string;
      message?: string;
    }
  | {
      state: "trial";
      email?: string;
      plan?: string;
      expiry?: string;
      message?: string;
    }
  | {
      state: "invalid";
      email?: string;
      plan?: string;
      expiry?: string;
      message?: string;
    };

export interface AppearanceSettingChangeHandler {
  (key: keyof AppearanceSettings, value: AppearanceSettings[keyof AppearanceSettings]): void;
}

export interface LicenseInfo {
  email: string;
  plan: string;
  expiry: string;
}
