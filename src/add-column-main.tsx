import React from "react";
import ReactDOM from "react-dom/client";
import AddColumnWindow from "./AddColumnWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AddColumnWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
