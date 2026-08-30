import React from "react";
import ReactDOM from "react-dom/client";
import ColumnEditWindow from "./ColumnEditWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ColumnEditWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
