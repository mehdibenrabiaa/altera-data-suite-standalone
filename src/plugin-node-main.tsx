import React from "react";
import ReactDOM from "react-dom/client";
import PluginNodeWindow from "./PluginNodeWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PluginNodeWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
