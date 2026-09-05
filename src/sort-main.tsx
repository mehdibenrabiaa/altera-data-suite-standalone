import React from "react";
import ReactDOM from "react-dom/client";
import SortWindow from "./SortWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SortWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
