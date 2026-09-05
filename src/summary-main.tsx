import React from "react";
import ReactDOM from "react-dom/client";
import SummaryWindow from "./SummaryWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SummaryWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
