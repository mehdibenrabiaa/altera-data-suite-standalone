import React from "react";
import ReactDOM from "react-dom/client";
import UnpivotColumnsWindow from "./UnpivotColumnsWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <UnpivotColumnsWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
