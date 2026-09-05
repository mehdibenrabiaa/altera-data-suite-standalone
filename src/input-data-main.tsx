import React from "react";
import ReactDOM from "react-dom/client";
import InputDataWindow from "./InputDataWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <InputDataWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
