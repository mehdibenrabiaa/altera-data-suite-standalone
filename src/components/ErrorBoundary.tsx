import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  label?: string;
  // Renders inside the fallback's fixed-position overlay -- pass a smaller,
  // scoped fallback for boundaries wrapping just part of the UI.
  compact?: boolean;
}
interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
  showDetails: boolean;
}

// No error boundary existed anywhere in this app -- any uncaught render
// error in ANY component unmounts the entire React tree with nothing left
// on screen, which is the classic cause of a sudden blank white page. This
// converts that into a visible, recoverable error instead of silence.
export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null, showDetails: false };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ""}]`, error, info.componentStack);
    // This build ships minified, so the message alone (e.g. "Minified React
    // error #185") isn't enough to locate the bug without a source map --
    // the component stack pinpoints which component was rendering when it
    // threw, so it's shown inline (users running this packaged app have no
    // way to open devtools to see the console.error above).
    this.setState({ componentStack: info.componentStack ?? null });
  }

  reset = () => this.setState({ error: null, componentStack: null, showDetails: false });

  toggleDetails = () => this.setState((s) => ({ showDetails: !s.showDetails }));

  render() {
    const { error, componentStack, showDetails } = this.state;
    if (!error) return this.props.children;

    const label = this.props.label ? ` in ${this.props.label}` : "";
    return (
      <div
        style={{
          position: this.props.compact ? "absolute" : "fixed",
          inset: 0,
          zIndex: 300,
          background: "#ffffff",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          fontFamily: "'Google Sans Flex', sans-serif",
          padding: 24,
          textAlign: "center",
          overflow: "auto",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: "#c0392b" }}>Something went wrong{label}.</div>
        <div style={{ fontSize: 12, color: "#666", maxWidth: 480, whiteSpace: "pre-wrap" }}>{error.message}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={this.reset}
            style={{ padding: "6px 16px", fontSize: 12, background: "#FE4D41", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}
          >
            Try again
          </button>
          {componentStack && (
            <button
              onClick={this.toggleDetails}
              style={{ padding: "6px 16px", fontSize: 12, background: "#f0f0f0", color: "#333", border: "1px solid #ccc", borderRadius: 4, cursor: "pointer" }}
            >
              {showDetails ? "Hide details" : "Show details"}
            </button>
          )}
        </div>
        {showDetails && componentStack && (
          <pre
            style={{
              fontSize: 10,
              color: "#444",
              background: "#f7f7f7",
              border: "1px solid #e0e0e0",
              borderRadius: 4,
              padding: 10,
              maxWidth: 560,
              maxHeight: 240,
              overflow: "auto",
              textAlign: "left",
              whiteSpace: "pre-wrap",
            }}
          >
            {componentStack.trim()}
          </pre>
        )}
      </div>
    );
  }
}
