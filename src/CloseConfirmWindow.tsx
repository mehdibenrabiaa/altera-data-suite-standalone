import { useEffect, useState } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import "./App.css";

// Native window standing in for what other apps would draw as a plain OS
// message box -- main.ts opens one of these (see openCloseConfirmWindow)
// instead, so "unsaved changes?" looks like the rest of this app (same
// fonts/theme/button classes as every Configure window) rather than
// un-styled OS chrome, while still being a real native window/dialog like
// the user asked for -- not an in-page overlay.
export default function CloseConfirmWindow() {
  // Passed once via the URL when main.ts creates this window (see
  // loadAppInto's `query` -- this window is short-lived enough that a
  // live theme-change subscription isn't worth the extra IPC plumbing).
  const [theme] = useState<"light" | "dark">(
    () => (new URLSearchParams(window.location.search).get("theme") === "dark" ? "dark" : "light"),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // main.ts tells this window to drop back out of "Saving…" if the save
  // didn't actually happen (e.g. the user cancelled the Save-As dialog) --
  // otherwise it'd be stuck showing a spinner with no way to retry or
  // cancel.
  useEffect(() => {
    return window.alteraStudio.onCloseConfirmSaveFailed(() => setSaving(false));
  }, []);

  const choose = (choice: "save" | "discard" | "cancel") => {
    if (choice === "save") setSaving(true);
    window.alteraStudio.closeConfirmChoice(choice);
  };

  return (
    <ConfigProvider
      theme={{
        algorithm: theme === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { colorPrimary: "#FE4D41", fontFamily: '"Google Sans Flex", sans-serif' },
      }}
    >
      <div className="close-confirm-window">
        <h3>Save changes to this project before closing?</h3>
        <p>Your changes will be lost if you don't save them.</p>
        <div className="close-confirm-actions">
          <button className="filter-builder-btn-secondary" onClick={() => choose("discard")} disabled={saving}>
            Don't Save
          </button>
          <div className="close-confirm-actions-right">
            <button className="filter-builder-btn-secondary" onClick={() => choose("cancel")} disabled={saving}>
              Cancel
            </button>
            <button className="filter-builder-btn-primary" onClick={() => choose("save")} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </ConfigProvider>
  );
}
