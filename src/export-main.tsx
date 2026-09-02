import React from "react";
import ReactDOM from "react-dom/client";
import ExportWindow from "./ExportWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ExportWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
