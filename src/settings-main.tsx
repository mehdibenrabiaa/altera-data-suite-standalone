import React from "react";
import ReactDOM from "react-dom/client";
import SettingsWindow from "./SettingsWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SettingsWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
