import React from "react";
import ReactDOM from "react-dom/client";
import AggregateWindow from "./AggregateWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AggregateWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
