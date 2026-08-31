import React from "react";
import ReactDOM from "react-dom/client";
import CascadeFillWindow from "./CascadeFillWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <CascadeFillWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
