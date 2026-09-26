import { useEffect, useState } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import { CheckCircleFilled, CloseCircleFilled, CloudDownloadOutlined, LoadingOutlined } from "@ant-design/icons";
import type { UpdaterStatus } from "./vite-env";
import "./App.css";

// File > Check for Updates opens this small owned window (electron/main.ts's
// openUpdateCheckWindow) -- same real-window-not-an-in-page-dialog pattern
// as CloseConfirmWindow.tsx, reusing its .close-confirm-window/-actions
// chrome wholesale since the shape (heading, one line of status, a couple
// of buttons) is identical.
function statusView(status: UpdaterStatus | null): { icon: React.ReactNode; text: string } {
  if (!status) return { icon: <LoadingOutlined spin />, text: "Checking for updates…" };
  switch (status.state) {
    case "checking":
      return { icon: <LoadingOutlined spin />, text: "Checking for updates…" };
    case "not-available":
      return { icon: <CheckCircleFilled style={{ color: "#2e7d32" }} />, text: "You're up to date." };
    case "available":
      return { icon: <CloudDownloadOutlined />, text: `Update v${status.version} found — downloading…` };
    case "downloading":
      return { icon: <LoadingOutlined spin />, text: `Downloading update… ${status.percent ?? 0}%` };
    case "downloaded":
      return { icon: <CheckCircleFilled style={{ color: "#2e7d32" }} />, text: `Update v${status.version} downloaded and ready to install.` };
    case "error":
      return { icon: <CloseCircleFilled style={{ color: "#c0392b" }} />, text: status.message ?? "Couldn't check for updates." };
  }
}

export default function UpdateCheckWindow() {
  const [theme] = useState<"light" | "dark">(
    () => (new URLSearchParams(window.location.search).get("theme") === "dark" ? "dark" : "light"),
  );
  const [status, setStatus] = useState<UpdaterStatus | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!window.alteraStudio) return;
    let live = true;
    window.alteraStudio.requestUpdaterStatus().then((s) => {
      if (live) setStatus(s);
    });
    const unsubscribe = window.alteraStudio.onUpdaterStatus((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  const { icon, text } = statusView(status);

  return (
    <ConfigProvider
      theme={{
        algorithm: theme === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { colorPrimary: "#FE4D41", fontFamily: '"Google Sans Flex", sans-serif' },
      }}
    >
      <div className="close-confirm-window">
        <h3>Software Update</h3>
        <div className="update-check-status">
          <span className="update-check-status-icon">{icon}</span>
          <span>{text}</span>
        </div>
        <div className="close-confirm-actions" style={{ justifyContent: "flex-end" }}>
          {status?.state === "downloaded" ? (
            <button className="filter-builder-btn-primary" onClick={() => window.alteraStudio.installUpdate()}>
              Restart & Install
            </button>
          ) : (
            <button
              className="filter-builder-btn-secondary"
              onClick={() => window.alteraStudio.closeUpdateCheckWindow()}
            >
              Close
            </button>
          )}
        </div>
      </div>
    </ConfigProvider>
  );
}
