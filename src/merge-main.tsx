import React from "react";
import ReactDOM from "react-dom/client";
import MergeWindow from "./MergeWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <MergeWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
