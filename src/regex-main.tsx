import React from "react";
import ReactDOM from "react-dom/client";
import RegexWindow from "./RegexWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <RegexWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
