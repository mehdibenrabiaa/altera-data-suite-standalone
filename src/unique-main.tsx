import React from "react";
import ReactDOM from "react-dom/client";
import UniqueWindow from "./UniqueWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <UniqueWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
