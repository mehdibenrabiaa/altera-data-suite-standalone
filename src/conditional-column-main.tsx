import React from "react";
import ReactDOM from "react-dom/client";
import ConditionalColumnWindow from "./ConditionalColumnWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ConditionalColumnWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
