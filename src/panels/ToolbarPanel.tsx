import React from "react";
import { Switch } from "antd";
import type { Rectangle, Tool } from "../types";

// Inline SVGs (not <img>) using the real fa-solid path data from the public/
// icon files, so `fill="currentColor"` picks up .ps-tool-btn's #333333 icon
// color — <img>-loaded SVGs default to solid black and can't be recolored
// via CSS, which is why these looked too dark before.
function OpenFileGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 640 640" fill="currentColor">
      <path d="M88 289.6L64.4 360.2L64.4 160C64.4 124.7 93.1 96 128.4 96L267.1 96C280.9 96 294.4 100.5 305.5 108.8L343.9 137.6C349.4 141.8 356.2 144 363.1 144L480.4 144C515.7 144 544.4 172.7 544.4 208L544.4 224L179 224C137.7 224 101 250.4 87.9 289.6zM509.8 512L131 512C98.2 512 75.1 479.9 85.5 448.8L133.5 304.8C140 285.2 158.4 272 179 272L557.8 272C590.6 272 613.7 304.1 603.3 335.2L555.3 479.2C548.8 498.8 530.4 512 509.8 512z" />
    </svg>
  );
}

function ConvertGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 640 640" fill="currentColor">
      <path d="M434.8 54.1C446.7 62.7 451.1 78.3 445.7 91.9L367.3 288L512 288C525.5 288 537.5 296.4 542.1 309.1C546.7 321.8 542.8 336 532.5 344.6L244.5 584.6C233.2 594 217.1 594.5 205.2 585.9C193.3 577.3 188.9 561.7 194.3 548.1L272.7 352L128 352C114.5 352 102.5 343.6 97.9 330.9C93.3 318.2 97.2 304 107.5 295.4L395.5 55.4C406.8 46 422.9 45.5 434.8 54.1z" />
    </svg>
  );
}

function OverlayGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 640 640" fill="currentColor">
      <path d="M296.5 69.2C311.4 62.3 328.6 62.3 343.5 69.2L562.1 170.2C570.6 174.1 576 182.6 576 192C576 201.4 570.6 209.9 562.1 213.8L343.5 314.8C328.6 321.7 311.4 321.7 296.5 314.8L77.9 213.8C69.4 209.8 64 201.3 64 192C64 182.7 69.4 174.1 77.9 170.2L296.5 69.2zM112.1 282.4L276.4 358.3C304.1 371.1 336 371.1 363.7 358.3L528 282.4L562.1 298.2C570.6 302.1 576 310.6 576 320C576 329.4 570.6 337.9 562.1 341.8L343.5 442.8C328.6 449.7 311.4 449.7 296.5 442.8L77.9 341.8C69.4 337.8 64 329.3 64 320C64 310.7 69.4 302.1 77.9 298.2L112 282.4zM77.9 426.2L112 410.4L276.3 486.3C304 499.1 335.9 499.1 363.6 486.3L527.9 410.4L562 426.2C570.5 430.1 575.9 438.6 575.9 448C575.9 457.4 570.5 465.9 562 469.8L343.4 570.8C328.5 577.7 311.3 577.7 296.4 570.8L77.9 469.8C69.4 465.8 64 457.3 64 448C64 438.7 69.4 430.1 77.9 426.2z" />
    </svg>
  );
}

function SelectGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 640 640" fill="currentColor">
      <path d="M173.3 66.5C181.4 62.4 191.2 63.3 198.4 68.8L518.4 308.7C526.7 314.9 530 325.7 526.8 335.5C523.6 345.3 514.4 351.9 504 351.9L351.7 351.9L440.6 529.6C448.5 545.4 442.1 564.6 426.3 572.5C410.5 580.4 391.3 574 383.4 558.2L294.5 380.5L203.2 502.3C197 510.6 186.2 513.9 176.4 510.7C166.6 507.5 160 498.3 160 488L160 88C160 78.9 165.1 70.6 173.3 66.5z" />
    </svg>
  );
}

function HandGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 640 640" fill="currentColor">
      <path d="M352 96C352 78.3 337.7 64 320 64C302.3 64 288 78.3 288 96L288 304C288 312.8 280.8 320 272 320C263.2 320 256 312.8 256 304L256 128C256 110.3 241.7 96 224 96C206.3 96 192 110.3 192 128L192 400C192 401.5 192 403.1 192.1 404.6L131.6 347C115.6 331.8 90.3 332.4 75 348.4C59.7 364.4 60.4 389.7 76.4 405L188.8 512C231.9 553.1 289.2 576 348.8 576L368 576C465.2 576 544 497.2 544 400L544 192C544 174.3 529.7 160 512 160C494.3 160 480 174.3 480 192L480 304C480 312.8 472.8 320 464 320C455.2 320 448 312.8 448 304L448 128C448 110.3 433.7 96 416 96C398.3 96 384 110.3 384 128L384 304C384 312.8 376.8 320 368 320C359.2 320 352 312.8 352 304L352 96z" />
    </svg>
  );
}

function RectangleGlyph() {
  return (
    <svg className="rect-tool-icon" viewBox="0 0 23.84 24.49" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="3" cy="3" r="2" />
      <circle cx="20.84" cy="3" r="2" />
      <circle cx="3" cy="21.49" r="2" />
      <circle cx="20.84" cy="21.49" r="2" />
      <line x1="5.5" y1="3" x2="18.7" y2="3" />
      <line x1="20.84" y1="5.2" x2="20.84" y2="18.87" />
      <line x1="18.83" y1="21.49" x2="5.5" y2="21.49" />
      <line x1="3" y1="19.06" x2="3" y2="5.53" />
    </svg>
  );
}

function RegionGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 640 640" fill="currentColor">
      <path d="M480 144C488.8 144 496 151.2 496 160L496 480C496 488.8 488.8 496 480 496L160 496C151.2 496 144 488.8 144 480L144 160C144 151.2 151.2 144 160 144L480 144zM160 96C124.7 96 96 124.7 96 160L96 480C96 515.3 124.7 544 160 544L480 544C515.3 544 544 515.3 544 480L544 160C544 124.7 515.3 96 480 96L160 96z" />
    </svg>
  );
}

function RulerGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 640 640" fill="currentColor">
      <path d="M192 80C192 53.5 213.5 32 240 32L400 32C426.5 32 448 53.5 448 80L448 104L344 104C330.7 104 320 114.7 320 128C320 141.3 330.7 152 344 152L448 152L448 200L376 200C362.7 200 352 210.7 352 224C352 237.3 362.7 248 376 248L448 248L448 296L344 296C330.7 296 320 306.7 320 320C320 333.3 330.7 344 344 344L448 344L448 392L376 392C362.7 392 352 402.7 352 416C352 429.3 362.7 440 376 440L448 440L448 488L344 488C330.7 488 320 498.7 320 512C320 525.3 330.7 536 344 536L448 536L448 560C448 586.5 426.5 608 400 608L240 608C213.5 608 192 586.5 192 560L192 80z" />
    </svg>
  );
}

interface ToolbarPanelProps {
  handleOpenPdf: () => void;
  handleConvert: () => void;
  isConverting: boolean;
  rectangles: Rectangle[];
  inkOverlayImage: HTMLImageElement | null;
  showInkOverlay: boolean;
  setShowInkOverlay: (v: boolean) => void;
  activeTool: Tool;
  setActiveTool: (t: Tool) => void;
  schemaMode?: boolean;
}

export default function ToolbarPanel({
  handleOpenPdf,
  handleConvert,
  isConverting,
  rectangles,
  inkOverlayImage,
  showInkOverlay,
  setShowInkOverlay,
  activeTool,
  setActiveTool,
  schemaMode = false,
}: ToolbarPanelProps) {
  const dimmed: React.CSSProperties = schemaMode
    ? { pointerEvents: "none", opacity: 0.35 }
    : {};
  return (
    <div className="toolbar-panel-body">
      <div style={dimmed}>
        <button onClick={handleOpenPdf} className="toolbar-btn ps-tool-btn" title="Open PDF (Ctrl + O)">
          <OpenFileGlyph />
        </button>
      </div>
      <button
        onClick={handleConvert}
        className="toolbar-btn ps-tool-btn"
        disabled={rectangles.length === 0 || isConverting}
        title={isConverting ? "Converting…" : "Convert (Ctrl + Enter)"}
      >
        <ConvertGlyph />
      </button>

      <div className="toolbar-tool-group" style={dimmed}>
        {/* Generate Overlay Button */}
        {!inkOverlayImage && (
          <button className="toolbar-btn ps-tool-btn" disabled style={{ opacity: 0.35, cursor: "not-allowed" }} title="Generate Ink Overlay (coming soon)">
            <OverlayGlyph />
          </button>
        )}

        {/* Overlay Toggle Switch - only shows after overlay is generated */}
        {inkOverlayImage && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "2px 0" }}>
            <span style={{ color: "#666", opacity: 0.7, display: "flex" }}>
              <OverlayGlyph />
            </span>
            <Switch checked={showInkOverlay} onChange={setShowInkOverlay} size="small" />
          </div>
        )}

        <div className="toolbar-group-gap" />
        <button
          className={`toolbar-btn ps-tool-btn ${activeTool === "select" ? "active-tool" : ""}`}
          onClick={() => setActiveTool("select")}
          title="Select (V)"
        >
          <SelectGlyph />
        </button>
        <button
          className={`toolbar-btn ps-tool-btn ${activeTool === "hand" ? "active-tool" : ""}`}
          onClick={() => setActiveTool("hand")}
          title="Hand (H / Space)"
        >
          <HandGlyph />
        </button>
        <div className="toolbar-group-gap" />
        <button
          onClick={() => setActiveTool("rectangle")}
          className={`toolbar-btn ps-tool-btn ${activeTool === "rectangle" ? "active-tool" : ""}`}
          title="Rectangle (D)"
        >
          <RectangleGlyph />
        </button>
        <button className="toolbar-btn ps-tool-btn" disabled style={{ opacity: 0.35, cursor: "not-allowed" }} title="Region (coming soon)">
          <RegionGlyph />
        </button>

        <div style={{ position: "relative" }}>
          <button
            onClick={() => setActiveTool("guide")}
            className={`toolbar-btn ps-tool-btn ${activeTool === "guide" ? "active-tool" : ""}`}
            disabled={rectangles.length === 0}
            title={rectangles.length === 0 ? "Draw a rectangle first" : "Draw Guide (G)"}
          >
            <RulerGlyph />
          </button>
        </div>
      </div>
    </div>
  );
}
