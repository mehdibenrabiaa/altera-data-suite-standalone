import React from "react";
import ReactDOM from "react-dom/client";
import HeaderPromoterWindow from "./HeaderPromoterWindow.tsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <HeaderPromoterWindow />
    </ErrorBoundary>
  </React.StrictMode>,
);
