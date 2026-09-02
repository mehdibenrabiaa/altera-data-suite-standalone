import React from "react";
import ReactDOM from "react-dom/client";
import PivotColumnsWindow from "./PivotColumnsWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PivotColumnsWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
