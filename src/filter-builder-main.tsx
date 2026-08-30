import React from "react";
import ReactDOM from "react-dom/client";
import FilterBuilderWindow from "./FilterBuilderWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <FilterBuilderWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
