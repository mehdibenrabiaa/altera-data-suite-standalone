import React from "react";
import ReactDOM from "react-dom/client";
import UpdateCheckWindow from "./UpdateCheckWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <UpdateCheckWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
