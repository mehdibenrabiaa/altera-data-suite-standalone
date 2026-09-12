import React from "react";
import ReactDOM from "react-dom/client";
import PageFilterWindow from "./PageFilterWindow";
import ErrorBoundary from "./components/ErrorBoundary";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><ErrorBoundary><PageFilterWindow /></ErrorBoundary></React.StrictMode>,
);
