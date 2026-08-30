import React from "react";
import ReactDOM from "react-dom/client";
import BrowseWindow from "./BrowseWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowseWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
