import React from "react";
import ReactDOM from "react-dom/client";
import TextParserWindow from "./TextParserWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <TextParserWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
