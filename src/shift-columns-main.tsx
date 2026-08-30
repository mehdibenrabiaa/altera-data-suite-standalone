import React from "react";
import ReactDOM from "react-dom/client";
import ShiftColumnsWindow from "./ShiftColumnsWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ShiftColumnsWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
