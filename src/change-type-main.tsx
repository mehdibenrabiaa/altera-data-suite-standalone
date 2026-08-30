import React from "react";
import ReactDOM from "react-dom/client";
import ChangeTypeWindow from "./ChangeTypeWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ChangeTypeWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
