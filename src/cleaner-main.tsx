import React from "react";
import ReactDOM from "react-dom/client";
import CleanerWindow from "./CleanerWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <CleanerWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
