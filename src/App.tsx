import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import {
  Stage,
  Layer,
  Rect,
  Transformer,
  Line,
  Circle,
  Image as KonvaImage,
  Text as KonvaText,
  Label,
  Tag,
} from "react-konva";
import * as pdfjsLib from "pdfjs-dist";
import { addEdge, applyEdgeChanges, reconnectEdge, type Edge, type Connection, type EdgeChange } from "@xyflow/react";
import { ConfigProvider, Spin, InputNumber } from "antd";
import "antd/dist/reset.css";
import "./App.css";

import { LoadingOutlined } from "@ant-design/icons";
import DockLayout from "rc-dock";
import type { LayoutData } from "rc-dock";
import "rc-dock/dist/rc-dock.css";
import "./rcDockPatches";
import ToolbarPanel from "./panels/ToolbarPanel";
import PageNavPanel from "./panels/PageNavPanel";
import GroupsPanel from "./panels/GroupsPanel";
import PropertiesPanel from "./panels/PropertiesPanel";
import SettingsPanel from "./panels/SettingsPanel";
import NodesPanel from "./panels/NodesPanel";
import SchemaView from "./panels/SchemaView";
import MenuBar from "./panels/MenuBar";
import ErrorBoundary from "./components/ErrorBoundary";
import type {
  Tool,
  SmartOffset,
  KeywordSettings,
  SmartRawPageEntry,
  SmartConfig,
  SampleConfig,
  QtBridge,
  Rectangle,
  Guide,
  Group,
  TableData,
  SchemaPreviewTable,
  PersistedSettings,
  ProcessorNodeInstance,
  NodeLogEntry,
} from "./types";
import { DEFAULT_SMART_CONFIG } from "./types";
import { pickNextColor, fillToHex, hexToFillStroke, fillWithAlpha, fillAlpha } from "./colorUtils";
import { uniqueRectName } from "./rectUtils";
import { createBackendBridge } from "./backendBridge";
import { getInputPortMax } from "./nodeCatalog";

// Configure PDF.js worker - Use local file
pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdf.worker.min.js";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;

declare global {
  interface Window {
    showLoaderHandler?: (value: number) => void;
  }
}

// Altera Data Suite has no Qt/QWebEngine host, so there's no QWebChannel to wait
// for -- the bridge is the FastAPI-backed shim from backendBridge.ts, ready
// immediately.
const useQtBridge = () => {
  const [bridge] = useState<QtBridge>(() => createBackendBridge());
  return { bridge, isReady: true };
};

// ── Smart-panel sub-components ────────────────────────────────────────────────

function applyKeywordRules(
  rawData: Record<string, SmartRawPageEntry | null>,
  keywordSettings: Record<string, KeywordSettings>,
): Record<string, { bboxes: [number, number, number, number][]; union_bbox: [number, number, number, number] } | null> {
  const result: Record<string, { bboxes: [number, number, number, number][]; union_bbox: [number, number, number, number] } | null> = {};
  const hasSettings = Object.keys(keywordSettings).length > 0;

  for (const [pageKey, entry] of Object.entries(rawData)) {
    if (!entry) { result[pageKey] = null; continue; }

    if (!hasSettings || !entry.by_keyword || Object.keys(entry.by_keyword).length === 0) {
      result[pageKey] = { bboxes: entry.bboxes, union_bbox: entry.union_bbox };
      continue;
    }

    const allFiltered: [number, number, number, number][] = [];

    for (const [kw, bboxes] of Object.entries(entry.by_keyword)) {
      const ks = keywordSettings[kw];
      let filtered: [number, number, number, number][] = [...bboxes];

      // Section filter first — excluded occurrences must not count toward the index
      if (ks?.secRule && entry.page_w && entry.page_h && ks.secRule.cells.length > 0) {
        const r = ks.secRule;
        filtered = filtered.filter((bbox) => {
          const cx = (bbox[0] + bbox[2]) / 2;
          const cy = (bbox[1] + bbox[3]) / 2;
          const col = Math.min(2, Math.floor((cx / entry.page_w) * 3));
          const row = Math.min(2, Math.floor((cy / entry.page_h) * 3));
          const cellIdx = row * 3 + col;
          const inCells = r.cells.includes(cellIdx);
          return r.action === "keep" ? inCells : !inCells;
        });
      }

      // Occurrence rule applied after section filter so index is relative to visible occurrences only
      if (ks?.occRule) {
        const r = ks.occRule;
        const total = filtered.length;
        if (total > 0) {
          const fromIdx = r.from === 0 ? total - 1 : Math.max(0, r.from - 1);
          const toIdx   = r.to   === 0 ? total - 1 : Math.min(total - 1, r.to - 1);
          if (r.action === "keep") {
            filtered = filtered.filter((_, i) => i >= fromIdx && i <= toIdx);
          } else {
            filtered = filtered.filter((_, i) => i < fromIdx || i > toIdx);
          }
        }
      }

      allFiltered.push(...filtered);
    }

    if (allFiltered.length === 0) {
      result[pageKey] = null;
    } else {
      result[pageKey] = {
        bboxes: allFiltered,
        union_bbox: [
          Math.min(...allFiltered.map((b) => b[0])),
          Math.min(...allFiltered.map((b) => b[1])),
          Math.max(...allFiltered.map((b) => b[2])),
          Math.max(...allFiltered.map((b) => b[3])),
        ],
      };
    }
  }

  return result;
}

const ScrollKnob: React.FC<{
  value: number;
  onChange: (v: number) => void;
  axis: "x" | "y";
  invert?: boolean;
}> = ({ value, onChange, axis, invert = false }) => {
  const dragging = useRef(false);
  const startPos = useRef(0);
  const startVal = useRef(0);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const pos = axis === "x" ? e.clientX : e.clientY;
      const raw = axis === "x" ? pos - startPos.current : startPos.current - pos;
      onChange(Math.round(startVal.current + (invert ? -raw : raw)));
    };
    const onUp = () => { dragging.current = false; setActive(false); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [axis, invert, onChange]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.ctrlKey) { onChange(0); return; }
    dragging.current = true;
    startPos.current = axis === "x" ? e.clientX : e.clientY;
    startVal.current = value;
    setActive(true);
    e.preventDefault();
  };

  const isSet = value !== 0;
  const fill = active ? "#FE4D41" : isSet ? "#f0f0f0" : "#ffffff";
  const strokeC = active ? "#e03b2f" : isSet ? "#FE4D41" : "#bcbcbc";
  const ridgeClr = isSet ? "#FE4D41" : "#888888";
  const ridges = [-4, -1.3, 1.3, 4];

  return (
    <svg
      className="knob-svg"
      width={34} height={34}
      onMouseDown={onMouseDown}
      style={{ cursor: axis === "x" ? "ew-resize" : "ns-resize", userSelect: "none" }}
    >
      <circle cx={17} cy={17} r={14} fill={fill} stroke={strokeC} strokeWidth={1.3} />
      {!active && (axis === "y"
        ? ridges.map((d, i) => <line key={i} x1={6} y1={17 + d} x2={28} y2={17 + d} stroke={ridgeClr} strokeWidth={1.4} strokeLinecap="round" />)
        : ridges.map((d, i) => <line key={i} x1={17 + d} y1={6} x2={17 + d} y2={28} stroke={ridgeClr} strokeWidth={1.4} strokeLinecap="round" />)
      )}
    </svg>
  );
};

function MiniSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={`mini-switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <div className="mini-switch-knob" />
    </div>
  );
}

function MiniSegmented({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="mini-segmented">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className={value === opt ? "active" : ""}
          onClick={() => onChange(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

// fa-solid fa-gear (public/gear.svg), replacing antd's SettingOutlined so
// the Smart Rect panel has no antd dependency at all. Inlined with
// fill="currentColor" (not <img>) so it still picks up the surrounding
// button's color/hover/active states, same as every other icon in the app.
function GearIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 640 640" fill="currentColor">
      <path d="M259.1 73.5C262.1 58.7 275.2 48 290.4 48L350.2 48C365.4 48 378.5 58.7 381.5 73.5L396 143.5C410.1 149.5 423.3 157.2 435.3 166.3L503.1 143.8C517.5 139 533.3 145 540.9 158.2L570.8 210C578.4 223.2 575.7 239.8 564.3 249.9L511 297.3C511.9 304.7 512.3 312.3 512.3 320C512.3 327.7 511.8 335.3 511 342.7L564.4 390.2C575.8 400.3 578.4 417 570.9 430.1L541 481.9C533.4 495 517.6 501.1 503.2 496.3L435.4 473.8C423.3 482.9 410.1 490.5 396.1 496.6L381.7 566.5C378.6 581.4 365.5 592 350.4 592L290.6 592C275.4 592 262.3 581.3 259.3 566.5L244.9 496.6C230.8 490.6 217.7 482.9 205.6 473.8L137.5 496.3C123.1 501.1 107.3 495.1 99.7 481.9L69.8 430.1C62.2 416.9 64.9 400.3 76.3 390.2L129.7 342.7C128.8 335.3 128.4 327.7 128.4 320C128.4 312.3 128.9 304.7 129.7 297.3L76.3 249.8C64.9 239.7 62.3 223 69.8 209.9L99.7 158.1C107.3 144.9 123.1 138.9 137.5 143.7L205.3 166.2C217.4 157.1 230.6 149.5 244.6 143.4L259.1 73.5zM320.3 400C364.5 399.8 400.2 363.9 400 319.7C399.8 275.5 363.9 239.8 319.7 240C275.5 240.2 239.8 276.1 240 320.3C240.2 364.5 276.1 400.2 320.3 400z" />
    </svg>
  );
}

// fa-solid fa-rotate-left (public/reset.svg), replacing the plain "↺"
// glyph on the offset reset button. Same fill="currentColor" reasoning.
function ResetIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 640 640" fill="currentColor">
      <path d="M320 128C263.2 128 212.1 152.7 176.9 192L224 192C241.7 192 256 206.3 256 224C256 241.7 241.7 256 224 256L96 256C78.3 256 64 241.7 64 224L64 96C64 78.3 78.3 64 96 64C113.7 64 128 78.3 128 96L128 150.7C174.9 97.6 243.5 64 320 64C461.4 64 576 178.6 576 320C576 461.4 461.4 576 320 576C233 576 156.1 532.6 109.9 466.3C99.8 451.8 103.3 431.9 117.8 421.7C132.3 411.5 152.2 415.1 162.4 429.6C197.2 479.4 254.8 511.9 320 511.9C426 511.9 512 425.9 512 319.9C512 213.9 426 128 320 128z" />
    </svg>
  );
}


const SmartPanel = React.memo(function SmartPanel({ rect, isRunning, pageMatchCount, currentPageHasMatch, currentPageRawCount, currentPageFilteredCount, onConfigChange, onRun }: {
  rect: Rectangle;
  isRunning: boolean;
  pageMatchCount: number;
  currentPageHasMatch: boolean;
  currentPageRawCount: number;
  currentPageFilteredCount: number;
  onClose: () => void;
  onConfigChange: (cfg: SmartConfig) => void;
  onRun: () => void;
}) {
  const cfg      = rect.smartConfig ?? DEFAULT_SMART_CONFIG;
  const dotColor = rect.stroke;
  const colorName= rect.name ?? "Table";
  const canRun   = cfg.keywords.length > 0 && !isRunning;

  const offset = cfg.offset ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const hasOffsets = offset.top !== 0 || offset.bottom !== 0 || offset.left !== 0 || offset.right !== 0;
  const setOff = (key: keyof SmartOffset, v: number) =>
    onConfigChange({ ...cfg, offset: { ...offset, [key]: v } });

  const [activeKw, setActiveKw] = useState<string | null>(null);
  const [kwSearch, setKwSearch] = useState("");
  const kwSettings: Record<string, KeywordSettings> = cfg.keywordSettings ?? {};

  useEffect(() => {
    if (activeKw && !cfg.keywords.includes(activeKw)) setActiveKw(null);
  }, [cfg.keywords, activeKw]);

  const setKwSettings = (kw: string, ks: KeywordSettings) => {
    const updated = { ...kwSettings, [kw]: ks };
    onConfigChange({ ...cfg, keywordSettings: updated });
  };

  const addKeyword = () => {
    const v = kwSearch.trim();
    if (v && !cfg.keywords.includes(v)) onConfigChange({ ...cfg, keywords: [...cfg.keywords, v] });
    setKwSearch("");
  };
  const removeKeyword = (kw: string) => {
    onConfigChange({ ...cfg, keywords: cfg.keywords.filter((k) => k !== kw) });
    if (activeKw === kw) setActiveKw(null);
  };

  return (
    <div className="smart-panel">
      <div className="smart-panel-header">
        <div className="smart-panel-header-left">
          <div className="smart-panel-dot" style={{ background: dotColor }} />
          <span className="smart-panel-title">{colorName} — Smart</span>
        </div>
        <button className="smart-run-btn" onClick={onRun} disabled={!canRun}>
          {isRunning ? <span className="smart-spinner" /> : <span>▶  Run</span>}
        </button>
      </div>

      <div className="kw-section">
        <div className="smart-panel-label">Keywords</div>
        <div className="kw-input-box" onClick={(e) => { if (e.target === e.currentTarget) (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus(); }}>
          {cfg.keywords.map((kw) => {
            const ks = kwSettings[kw];
            const hasActive = !!(ks?.occRule || ks?.secRule);
            const isOpen = activeKw === kw;
            return (
              <span key={kw} className={`kw-tag ${isOpen ? "open" : ""}`}>
                <span className="kw-tag-label">{kw}</span>
                <button
                  type="button"
                  className={`kw-tag-gear ${hasActive ? "has-active" : ""}`}
                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setActiveKw(isOpen ? null : kw); }}
                  title="Keyword settings"
                >
                  <GearIcon />
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); removeKeyword(kw); }}
                  title="Remove"
                >✕</button>
              </span>
            );
          })}
          <input
            type="text"
            value={kwSearch}
            placeholder={cfg.keywords.length === 0 ? "Type a keyword and press Enter…" : ""}
            onChange={(e) => setKwSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); addKeyword(); }
              else if (e.key === "Backspace" && !kwSearch && cfg.keywords.length > 0) {
                removeKeyword(cfg.keywords[cfg.keywords.length - 1]);
              }
            }}
          />
        </div>

        {/* Inline keyword settings panel */}
        {activeKw && cfg.keywords.includes(activeKw) && (() => {
          const ks = kwSettings[activeKw] ?? {};
          const occ = ks.occRule;
          const sec = ks.secRule;
          return (
            <div className="kw-settings">
              <div className="kw-settings-header">
                <span className="kw-settings-title"><GearIcon /> <b>"{activeKw}"</b></span>
                <button className="smart-panel-icon-btn" onClick={() => setActiveKw(null)}>✕</button>
              </div>

              {/* Occurrence rule */}
              <div style={{ marginBottom: 6 }}>
                <div className="rule-row">
                  <MiniSwitch
                    checked={!!occ}
                    onChange={(checked) => setKwSettings(activeKw, { ...ks, occRule: checked ? { action: "keep", from: 1, to: 1 } : undefined })}
                  />
                  <span className="rule-label">Occurrence filter</span>
                </div>
                {occ && (
                  <div className="rule-body">
                    <MiniSegmented
                      options={["keep", "ignore"]}
                      value={occ.action}
                      onChange={(v) => setKwSettings(activeKw, { ...ks, occRule: { ...occ, action: v as "keep" | "ignore" } })}
                    />
                    <span style={{ fontSize: 11, color: "#666" }}>occ.</span>
                    <InputNumber
                      size="small" min={1} value={occ.from} style={{ width: 65 }}
                      onChange={(v) => {
                        const newFrom = v ?? 1;
                        const newTo = (occ.to !== 0 && newFrom > occ.to) ? newFrom : occ.to;
                        setKwSettings(activeKw, { ...ks, occRule: { ...occ, from: newFrom, to: newTo } });
                      }}
                    />
                    <span className="smart-dash">–</span>
                    <InputNumber
                      size="small" min={0} value={occ.to} style={{ width: 65 }}
                      onChange={(v) => {
                        const newTo = v ?? 0;
                        const newFrom = (occ.from !== 0 && newTo !== 0 && occ.from > newTo) ? newTo : occ.from;
                        setKwSettings(activeKw, { ...ks, occRule: { ...occ, from: newFrom, to: newTo } });
                      }}
                    />
                    <span className="smart-hint" title="Use 0 for last occurrence">0=last</span>
                  </div>
                )}
              </div>

              <div className="smart-panel-divider" style={{ margin: "8px 0" }} />

              {/* Section rule */}
              <div>
                <div className="rule-row">
                  <MiniSwitch
                    checked={!!sec}
                    onChange={(checked) => setKwSettings(activeKw, { ...ks, secRule: checked ? { action: "keep", cells: [] } : undefined })}
                  />
                  <span className="rule-label">Page section filter</span>
                </div>
                {sec && (
                  <div style={{ paddingLeft: 30, marginTop: 6 }}>
                    <div style={{ marginBottom: 8 }}>
                      <MiniSegmented
                        options={["keep", "ignore"]}
                        value={sec.action}
                        onChange={(v) => setKwSettings(activeKw, { ...ks, secRule: { ...sec, action: v as "keep" | "ignore" } })}
                      />
                    </div>
                    <div className="section-grid" title="Click cells to toggle page areas">
                      {[0,1,2,3,4,5,6,7,8].map((cellIdx) => {
                        const selected = sec.cells.includes(cellIdx);
                        return (
                          <div
                            key={cellIdx}
                            className={`section-cell ${selected ? "selected" : ""}`}
                            onClick={() => {
                              const newCells = selected
                                ? sec.cells.filter((c) => c !== cellIdx)
                                : [...sec.cells, cellIdx];
                              setKwSettings(activeKw, { ...ks, secRule: { ...sec, cells: newCells } });
                            }}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      <div className="smart-panel-divider" />

      <div className="smart-offset-section">
        <div className="offset-section-header">
          <div className="smart-panel-label" style={{ marginBottom: 0 }}>Rectangle Offset</div>
        </div>
        <div className="offset-grid">
          <div className="offset-cell" />
          <div className="offset-cell top">
            {offset.top !== 0 && <span className="offset-val">{offset.top > 0 ? "+" : ""}{offset.top}</span>}
            <ScrollKnob value={offset.top} onChange={(v) => setOff("top", v)} axis="y" />
          </div>
          <div className="offset-cell" />

          <div className="offset-cell left">
            {offset.left !== 0 && <span className="offset-val">{offset.left > 0 ? "+" : ""}{offset.left}</span>}
            <ScrollKnob value={offset.left} onChange={(v) => setOff("left", v)} axis="x" invert />
          </div>
          <div className="offset-cell">
            <button
              className={`offset-reset-btn ${hasOffsets ? "active" : ""}`}
              onClick={() => onConfigChange({ ...cfg, offset: { top: 0, bottom: 0, left: 0, right: 0 } })}
              disabled={!hasOffsets}
              title="Reset all offsets"
            ><ResetIcon /></button>
          </div>
          <div className="offset-cell right">
            <ScrollKnob value={offset.right} onChange={(v) => setOff("right", v)} axis="x" />
            {offset.right !== 0 && <span className="offset-val">{offset.right > 0 ? "+" : ""}{offset.right}</span>}
          </div>

          <div className="offset-cell" />
          <div className="offset-cell bottom">
            <ScrollKnob value={offset.bottom} onChange={(v) => setOff("bottom", v)} axis="y" invert />
            {offset.bottom !== 0 && <span className="offset-val">{offset.bottom > 0 ? "+" : ""}{offset.bottom}</span>}
          </div>
          <div className="offset-cell" />
        </div>
      </div>

      {pageMatchCount > 0 && (
        <div className="smart-results">
          <div className="smart-status-row">
            <span className="highlight">
              <CircleCheckIcon color={currentPageHasMatch ? "#2e7d32" : "#9ca3af"} />
              {pageMatchCount} page{pageMatchCount !== 1 ? "s" : ""} matched
            </span>
            <span className="subtle-info">
              {currentPageHasMatch ? "Current page included" : "Not on this page"}
            </span>
          </div>
          {currentPageRawCount > 0 && (
            <div className="smart-status-row">
              <span style={{ color: currentPageFilteredCount < currentPageRawCount ? "#b45309" : undefined, display: "flex", alignItems: "center" }}>
                <FilterIcon color={currentPageFilteredCount < currentPageRawCount ? "#b45309" : "#6b7280"} />
                {currentPageFilteredCount} of {currentPageRawCount} occurrences kept
              </span>
              <span className="subtle-info">
                {currentPageFilteredCount < currentPageRawCount
                  ? `${currentPageRawCount - currentPageFilteredCount} filtered`
                  : "None filtered"}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// ── Sortable color row for settings panel ─────────────────────────────────────


// ── Dockable panels (Photoshop-style floating windows) ─────────────────────────
// Panel content is read from context rather than passed through rc-dock's layout
// data, so tabs always show live app state regardless of rc-dock's own re-render
// timing, and `defaultLayout` itself can stay a stable, one-time-computed value.
interface DockPanelsContextValue {
  // True while the Schema Preview is open -- toolbar/layers/properties/smart
  // rectangles all act on the Canvas view's selection/tools, which don't
  // apply there, so they're shown greyed-out and non-interactive instead of
  // just hidden (keeps the dock layout's sizes stable across the toggle).
  disabled: boolean;
  toolbar: React.ComponentProps<typeof ToolbarPanel>;
  settingsBar: React.ComponentProps<typeof SettingsPanel>;
  groups: React.ComponentProps<typeof GroupsPanel>;
  properties: React.ComponentProps<typeof PropertiesPanel>;
  canvas: {
    setSlotEl: (el: HTMLDivElement | null) => void;
  };
  nodes: {
    onAddNode: (entry: { name: string; icon: string; color: string; hasOutput?: boolean }) => void;
  };
  smart: {
    rect: Rectangle | null;
    isRunning: boolean;
    pageMatchCount: number;
    currentPageHasMatch: boolean;
    currentPageRawCount: number;
    currentPageFilteredCount: number;
    onClose: () => void;
    onConfigChange: (cfg: SmartConfig) => void;
    onRun: () => void;
  };
  nodeLog: { nodeName: string; entries: NodeLogEntry[] } | null;
}
const DockPanelsContext = React.createContext<DockPanelsContextValue | null>(null);

// Six-dot drag-grip glyph used as the Toolbar tab's title (no text label) —
// signals "draggable" the way Photoshop's floating toolbox handle does.
function ToolbarGripIcon() {
  return (
    <svg className="toolbar-tab-grip" width="18" height="12" viewBox="0 0 18 12" fill="currentColor" style={{ display: "block" }}>
      <circle cx="3" cy="3" r="1.4" />
      <circle cx="3" cy="9" r="1.4" />
      <circle cx="9" cy="3" r="1.4" />
      <circle cx="9" cy="9" r="1.4" />
      <circle cx="15" cy="3" r="1.4" />
      <circle cx="15" cy="9" r="1.4" />
    </svg>
  );
}

// Same six-dot grip, rotated 90° (2 columns x 3 rows instead of 3x2) — used
// as the Settings tab's title, whose tab strip runs down a vertical rail
// instead of across a horizontal one.
function ToolbarGripIconVertical() {
  return (
    <svg className="toolbar-tab-grip" width="12" height="18" viewBox="0 0 12 18" fill="currentColor" style={{ display: "block" }}>
      <circle cx="3" cy="3" r="1.4" />
      <circle cx="9" cy="3" r="1.4" />
      <circle cx="3" cy="9" r="1.4" />
      <circle cx="9" cy="9" r="1.4" />
      <circle cx="3" cy="15" r="1.4" />
      <circle cx="9" cy="15" r="1.4" />
    </svg>
  );
}

// fa-solid fa-chevron-down, matching the guide-color dropdown reference mockup.
function GuideColorChevron() {
  return (
    <svg width="9" height="9" viewBox="0 0 448 512" fill="currentColor">
      <path d="M201.4 374.6c12.5 12.5 32.8 12.5 45.3 0l160-160c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 306.7 86.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l160 160z" />
    </svg>
  );
}

// Inline SVG (not <img>) using the real fa-solid fa-lock path data, so
// `fill="currentColor"` picks up .ps-icon-btn's grey/hover color instead of
// always rendering flat black.
function GuideLockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 640 640" fill="currentColor">
      <path d="M256 160L256 224L384 224L384 160C384 124.7 355.3 96 320 96C284.7 96 256 124.7 256 160zM192 224L192 160C192 89.3 249.3 32 320 32C390.7 32 448 89.3 448 160L448 224C483.3 224 512 252.7 512 288L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 288C128 252.7 156.7 224 192 224z" />
    </svg>
  );
}

// Inline SVG using the real fa-solid fa-circle-check path data, same
// reasoning as the icons above — used in the Smart panel's results status rows.
function CircleCheckIcon({ color }: { color: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 512 512" fill={color} style={{ marginRight: 4, flexShrink: 0 }}>
      <path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM369 209L241 337c-9.4 9.4-24.6 9.4-33.9 0l-64-64c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l47 47L335 175c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9z" />
    </svg>
  );
}

// Inline SVG using the real fa-solid fa-filter path data, same reasoning.
function FilterIcon({ color }: { color: string }) {
  return (
    <svg width="9" height="9" viewBox="0 0 512 512" fill={color} style={{ marginRight: 4, flexShrink: 0 }}>
      <path d="M3.9 54.9C10.5 40.9 24.5 32 40 32H472c15.5 0 29.5 8.9 36.1 22.9s4.6 30.5-5.2 42.5L320 320.9V416c0 12.1-6.8 23.2-17.7 28.6s-23.8 4.3-33.5-3l-64-48c-8.1-6-12.8-15.5-12.8-25.6V320.9L9 97.4C-.7 85.4-2.8 68.8 3.9 54.9z" />
    </svg>
  );
}

// Inline SVG using the real fa-solid fa-trash-can path data, same reasoning.
function GuideTrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 640 640" fill="currentColor">
      <path d="M232.7 69.9C237.1 56.8 249.3 48 263.1 48L377 48C390.8 48 403 56.8 407.4 69.9L416 96L512 96C529.7 96 544 110.3 544 128C544 145.7 529.7 160 512 160L128 160C110.3 160 96 145.7 96 128C96 110.3 110.3 96 128 96L224 96L232.7 69.9zM128 208L512 208L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 208zM216 272C202.7 272 192 282.7 192 296L192 488C192 501.3 202.7 512 216 512C229.3 512 240 501.3 240 488L240 296C240 282.7 229.3 272 216 272zM320 272C306.7 272 296 282.7 296 296L296 488C296 501.3 306.7 512 320 512C333.3 512 344 501.3 344 488L344 296C344 282.7 333.3 272 320 272zM424 272C410.7 272 400 282.7 400 296L400 488C400 501.3 410.7 512 424 512C437.3 512 448 501.3 448 488L448 296C448 282.7 437.3 272 424 272z" />
    </svg>
  );
}

// React Flow's own Controls icons (same path data), reused so the canvas
// zoom stack matches the Schema view's zoom stack exactly.
function CanvasZoomInIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 32 32" fill="currentColor">
      <path d="M32 18.133H18.133V32h-4.266V18.133H0v-4.266h13.867V0h4.266v13.867H32z" />
    </svg>
  );
}
function CanvasZoomOutIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 32 5" fill="currentColor">
      <path d="M0 0h32v4.2H0z" />
    </svg>
  );
}
function CanvasFitViewIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 32 30" fill="currentColor">
      <path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" />
    </svg>
  );
}

// Wraps a dock panel's content so it can be shown greyed-out and
// non-interactive (Schema Preview open) without unmounting it -- an
// invisible overlay blocks all pointer events while a sibling wrapper gets
// the actual grey/desaturated look, so the panel's own internal layout
// never has to know about this state.
function DockPanelDisableHost({ disabled, children }: { disabled: boolean; children: React.ReactNode }) {
  return (
    <div className="dock-panel-disable-host">
      <div className={`dock-panel-disable-content${disabled ? " disabled" : ""}`}>{children}</div>
      {disabled && <div className="dock-panel-disable-overlay" />}
    </div>
  );
}

function ToolbarPanelContainer() {
  const ctx = React.useContext(DockPanelsContext)!;
  return <ToolbarPanel {...ctx.toolbar} schemaMode={ctx.disabled} />;
}
function SettingsPanelContainer() {
  const ctx = React.useContext(DockPanelsContext)!;
  return <SettingsPanel {...ctx.settingsBar} />;
}
// Content of the dockbox's headerless "Canvas" tab. It stays invisible and
// click-through (see `.dock-style-canvas-dock-panel` in App.css) — its only
// job is to occupy a real, correctly-resizing slot in the dock tree so the
// actual Konva canvas (still a plain fixed-position sibling elsewhere) can
// mirror its live bounding rect and visually resize/reposition right along
// with whatever docks around it.
function CanvasSlotContainer() {
  const ctx = React.useContext(DockPanelsContext)!;
  return <div ref={ctx.canvas.setSlotEl} style={{ width: "100%", height: "100%" }} />;
}
function NodesPanelContainer() {
  const ctx = React.useContext(DockPanelsContext)!;
  // Inverted vs. the other DockPanelDisableHost users above: those disable
  // themselves ON Schema/Workflow (ctx.disabled = showSchema, since they
  // edit Canvas rectangles), but adding a workflow node only makes sense
  // ON that view -- so this one disables on Canvas instead.
  return (
    <DockPanelDisableHost disabled={!ctx.disabled}>
      <NodesPanel {...ctx.nodes} />
    </DockPanelDisableHost>
  );
}
function GroupsPanelContainer() {
  const ctx = React.useContext(DockPanelsContext)!;
  // Unlike the other dock panels, Layers stays live in Schema view -- it's
  // still useful for toggling visibility/selecting tables while looking at
  // the schema, not just for editing the Canvas rectangles it's named for.
  return <GroupsPanel {...ctx.groups} />;
}
function PropertiesPanelContainer() {
  const ctx = React.useContext(DockPanelsContext)!;
  return (
    <DockPanelDisableHost disabled={ctx.disabled}>
      <PropertiesPanel {...ctx.properties} />
    </DockPanelDisableHost>
  );
}
function SmartRectPanelContainer() {
  const ctx = React.useContext(DockPanelsContext)!;
  const s = ctx.smart;
  return (
    <DockPanelDisableHost disabled={ctx.disabled}>
      {!s.rect ? (
        <div className="smart-panel smart-panel-empty">Select a table that's in Smart mode to configure keyword extraction.</div>
      ) : (
        <SmartPanel
          rect={s.rect}
          isRunning={s.isRunning}
          pageMatchCount={s.pageMatchCount}
          currentPageHasMatch={s.currentPageHasMatch}
          currentPageRawCount={s.currentPageRawCount}
          currentPageFilteredCount={s.currentPageFilteredCount}
          onClose={s.onClose}
          onConfigChange={s.onConfigChange}
          onRun={s.onRun}
        />
      )}
    </DockPanelDisableHost>
  );
}

// Every message (error + all warnings + all info, not just the single
// highest-priority one the node's own corner badge shows -- see
// SchemaView.tsx's selectedProcessorNodeLog for why that distinction
// matters) from the Workflow view's currently selected processor node's
// last run. Disables on Canvas the same way NodesPanelContainer does
// (!ctx.disabled) -- this is a Workflow-only concept, there's no
// processor node selection to report while on Canvas.
function NodeLogPanelContainer() {
  const ctx = React.useContext(DockPanelsContext)!;
  const log = ctx.nodeLog;
  return (
    <DockPanelDisableHost disabled={!ctx.disabled}>
      {!log ? (
        <div className="node-log-panel node-log-panel-empty">Select a run node to see its log.</div>
      ) : (
        <div className="node-log-panel">
          <div className="node-log-panel-header">{log.nodeName}</div>
          {log.entries.length === 0 ? (
            <div className="node-log-panel-empty-body">No messages from its last run.</div>
          ) : (
            <div className="node-log-panel-list">
              {log.entries.map((entry, i) => (
                <div key={i} className={`node-log-entry ${entry.type}`}>
                  <img
                    src={entry.type === "error" ? "./alert_red.svg" : entry.type === "warning" ? "./alert_yellow.svg" : "./alert_blue.svg"}
                    alt={entry.type}
                    width={14}
                    height={14}
                  />
                  <span>{entry.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </DockPanelDisableHost>
  );
}

const DOCK_LAYOUT_STORAGE_KEY = "pdfConverter.dockLayout";
// Bump this whenever a panel's structural config changes (panelLock, group,
// closable, default size/position, etc.) — a mismatched version means the
// saved layout predates that change and must NOT be trusted, otherwise a
// browser holding an old snapshot would silently keep overriding fixes like
// the toolbar's resize-lock forever. Only tab positions/groupings are meant
// to survive across versions; structural panel config always comes fresh
// from buildDefaultDockLayout().
const DOCK_LAYOUT_VERSION = 11;

function buildDefaultDockLayout(): LayoutData {
  return {
    dockbox: {
      mode: "horizontal",
      size: 900,
      children: [
        {
          tabs: [{ id: "toolbar", group: "toolbar", title: <ToolbarGripIcon />, content: <ToolbarPanelContainer />, closable: false, cached: true }],
          size: 52,
        },
        // The Konva Stage itself is still rendered as a plain fixed-position
        // sibling outside this dock tree (Konva doesn't need to live inside
        // rc-dock's own box layout) — but it continuously mirrors this tab's
        // live bounding rect (see CanvasSlotContainer/setCanvasSlotEl), so it
        // visually resizes and repositions right along with whatever docks
        // around it. This tab itself stays invisible and click-through (see
        // the `.dock-style-canvas-dock-panel` rules in App.css) so it doesn't
        // paint over or intercept clicks meant for the real canvas.
        {
          tabs: [{ id: "canvas", title: "Canvas", content: <CanvasSlotContainer />, closable: false }],
          panelLock: { panelStyle: "canvas-dock-panel", minWidth: 0, minHeight: 0 },
          size: 958,
        },
        {
          mode: "vertical",
          size: 332,
          children: [
            {
              tabs: [
                { id: "groups", title: "Layers", content: <GroupsPanelContainer />, closable: false, cached: true },
                { id: "properties", title: "Properties", content: <PropertiesPanelContainer />, closable: false, cached: true },
                { id: "nodes", title: "Nodes", content: <NodesPanelContainer />, closable: false, cached: true },
              ],
              activeId: "groups",
              size: 356,
            },
            {
              tabs: [
                { id: "smartrect", title: "Smart Rectangles", content: <SmartRectPanelContainer />, closable: false, cached: true },
                { id: "nodeLog", title: "Log", content: <NodeLogPanelContainer />, closable: false, cached: true },
              ],
              activeId: "smartrect",
              size: 341,
            },
            // Settings/SM/TAG bar — a compact horizontal-content-row panel
            // (see the .settingsbar-panel-body / left-rail-tab overrides in
            // App.css) stacked here below Smart Rectangles, rather than a
            // separate strip spanning the top of the whole layout.
            {
              tabs: [{ id: "settingsBar", group: "settingsBar", title: <ToolbarGripIconVertical />, content: <SettingsPanelContainer />, closable: false, cached: true }],
              size: 341,
            },
          ],
        },
      ],
    },
    floatbox: {
      mode: "float",
      children: [],
    },
  } as unknown as LayoutData;
}

// ── Main editor ───────────────────────────────────────────────────────────────
const KonvaA4Editor = () => {
  const { bridge, isReady } = useQtBridge();

  const [scale, setScale] = useState(1);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [activeTool, setActiveTool] = useState<Tool>("select");
  const [spacePressed, setSpacePressed] = useState(false);
  const [rectangles, setRectangles] = useState<Rectangle[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // The Workflow view's currently-selected processor node's run log,
  // reported up via SchemaView's onSelectedNodeLogChange (see its own
  // comment) -- null whenever nothing's selected/nothing to show. Feeds
  // the "Log" dock tab (NodeLogPanelContainer below), which lives outside
  // SchemaView entirely so it needs this lifted up rather than reading
  // SchemaView's own internal state directly.
  const [selectedNodeLog, setSelectedNodeLog] = useState<{ nodeName: string; entries: NodeLogEntry[] } | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isTransforming, setIsTransforming] = useState(false);
  const [newRect, setNewRect] = useState<{ x: number; y: number } | null>(null);
  const [drawingColor, setDrawingColor] = useState<string | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [previewGuideX, setPreviewGuideX] = useState<number | null>(null);
  const [guideColor, setGuideColor] = useState<string>("__global__");
  const [guideColorMenuOpen, setGuideColorMenuOpen] = useState(false);
  useEffect(() => {
    if (!guideColorMenuOpen) return;
    const onClickOutside = () => setGuideColorMenuOpen(false);
    window.addEventListener("click", onClickOutside);
    return () => window.removeEventListener("click", onClickOutside);
  }, [guideColorMenuOpen]);
  const [guideToolMenuOpen, setGuideToolMenuOpen] = useState(false);
  useEffect(() => {
    if (!guideToolMenuOpen) return;
    const onClickOutside = () => setGuideToolMenuOpen(false);
    window.addEventListener("click", onClickOutside);
    return () => window.removeEventListener("click", onClickOutside);
  }, [guideToolMenuOpen]);
  useEffect(() => {
    if (activeTool !== "guide") setGuideToolMenuOpen(false);
  }, [activeTool]);
  const tableCounterRef = useRef(0);
  const [groups, setGroups] = useState<Group[]>(() => [{ id: `group-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: "Group_1" }]);
  const [processorNodes, setProcessorNodes] = useState<ProcessorNodeInstance[]>([]);
  // Connections on the Workflow canvas -- lifted here (rather than kept
  // local to SchemaView, as it was before) so they persist through
  // buildProjectData()/project save-load, mirroring processorNodes above.
  const [edges, setEdges] = useState<Edge[]>([]);
  // Bumped on every project open -- SchemaView's own local per-node run
  // status/output (never persisted, see its handleRunProcessorNode) has no
  // other way to learn "this is a freshly (re)loaded project, forget
  // whatever you knew about these node ids" -- reopening the SAME file
  // would otherwise leave stale done/error badges on nodes that, from the
  // just-loaded file's perspective, were never run this session.
  const [workflowResetSignal, setWorkflowResetSignal] = useState(0);
  // Bumped by the menu bar's play button -- force-runs every runnable
  // Workflow node right now, regardless of whether SchemaView's own
  // auto-run already thinks it's up to date. The actual run logic lives in
  // SchemaView (it owns edges/processorNodes-derived input resolution);
  // this is just the trigger, same "signal prop" pattern as
  // workflowResetSignal above.
  const [runAllSignal, setRunAllSignal] = useState(0);
  const handleRunAllProcessorNodes = useCallback(() => setRunAllSignal((v) => v + 1), []);
  const groupCounterRef = useRef(1);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [isPageRendering, setIsPageRendering] = useState(false);
  const rectanglesRef    = useRef<Rectangle[]>([]);
  const guidesRef        = useRef<Guide[]>([]);
  const historyRef       = useRef<Array<{ rectangles: Rectangle[]; guides: Guide[] }>>([]);
  // Redo stack -- populated only by handleUndo (an undone state goes here so
  // it can be reapplied), and cleared by every fresh pushHistory (a new
  // action invalidates whatever was available to redo, same as any other
  // undo/redo implementation).
  const futureRef        = useRef<Array<{ rectangles: Rectangle[]; guides: Guide[] }>>([]);
  // historyRef/futureRef are refs (not state) so pushHistory -- called on
  // nearly every edit -- doesn't force a re-render; this counter is bumped
  // alongside them purely to force one anyway, so the menu bar's Undo/Redo
  // buttons can reactively enable/disable (they read historyRef.current
  // .length/futureRef.current.length directly at render time -- the counter
  // value itself is never read, only its setter, which is what forces the
  // re-render that makes that read fresh).
  const [, setHistoryVersion] = useState(0);
  const clipboardRef     = useRef<Rectangle[]>([]);
  const isAltDuplicating = useRef(false);
  const dragOriginsRef   = useRef<Record<string, { x: number; y: number }>>({});
  const renderTaskRef    = useRef<any>(null);
  const handleRunSmartRef = useRef<(id: string) => void>(() => {});
  const [showLoader, setShowLoader] = useState<boolean>(false);
  const [conversionProgress, setConversionProgress] = useState<number | null>(null);
  // Synchronous re-entrancy guard for handleConvert -- `showLoader` (state)
  // only updates on the next render, so two clicks (or a click plus the
  // Ctrl+Enter shortcut) within the same tick could both read it as still
  // false and both fire, sending two overlapping conversions whose progress
  // broadcasts land on the same channel with no way to tell them apart --
  // exactly what made the progress toast jump around non-monotonically.
  const isConvertingRef = useRef(false);
  // Marquee selection
  const [isMarqueeSelecting, setIsMarqueeSelecting] = useState(false);
  const [marqueeStart, setMarqueeStart] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [marqueeEnd, setMarqueeEnd] = useState<{ x: number; y: number } | null>(
    null,
  );

  // PDF state
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [pageImage, setPageImage] = useState<HTMLImageElement | null>(null);
  const [pageWidth, setPageWidth] = useState(794);
  const [pageHeight, setPageHeight] = useState(1123);
  const [showPageInput, setShowPageInput] = useState(false);
  const [pageInputValue, setPageInputValue] = useState<number | null>(null);
  const [needsInitialCenter, setNeedsInitialCenter] = useState(false);
  const [inkOverlayImage, setInkOverlayImage] =
    useState<HTMLImageElement | null>(null);
  const [showInkOverlay, setShowInkOverlay] = useState(false);
  // The value was previously write-only (destructured away) -- now read by
  // buildProjectData() below so a saved project can record which PDF it
  // references.
  const [currentPdfPath, setCurrentPdfPath] = useState<string>("");

  const [isDragOver, setIsDragOver] = useState(false);
  const [sampleConfig, setSampleConfig] = useState<SampleConfig>({
    enabled: false,
    mode: "range",
    startPage: 1,
    endPage: 10,
    firstN: 10,
  });
  const [showLabels, setShowLabels] = useState(true);
  const [colorOrder, setColorOrder] = useState<string[]>([]);
  const [occurrenceOrder, setOccurrenceOrder] = useState<boolean>(true);
  const [showSchema, setShowSchema] = useState(false);
  const [schemaPreviewTables, setSchemaPreviewTables] = useState<SchemaPreviewTable[] | null>(null);
  // Full (not the 10-row schema-preview sample) extraction results from a
  // real Convert run, keyed by table name -- lets the Schema drawer show
  // the whole dataset for a table once it's actually been converted,
  // instead of staying stuck on the preview sample forever.
  const [convertedTables, setConvertedTables] = useState<Record<string, { columns: string[]; rows: string[][] }>>({});
  const [schemaPreviewLoading, setSchemaPreviewLoading] = useState(false);
  const [schemaPreviewError, setSchemaPreviewError] = useState<string | null>(null);
  const [closeAfterConvert, setCloseAfterConvert] = useState<boolean>(true);
  const [schemaSampleRowLimit, setSchemaSampleRowLimit] = useState<number>(10);
  const [schemaPageLimit, setSchemaPageLimit] = useState<number>(10);
  // Whether selecting a table card auto-opens the Schema output drawer.
  const [autoExpandOutputDrawer, setAutoExpandOutputDrawer] = useState<boolean>(true);
  // Caps the Canvas view's PDF render sharpness at high zoom -- see the
  // renderScale call sites below and SettingsPayload.pdfRenderDpi's own
  // comment for why this only trades render speed for on-screen crispness,
  // with zero effect on annotation/extraction accuracy. 288 preserves the
  // exact behavior this app already had before the setting existed (the
  // old hardcoded scale cap of 4, times 72 -- pdf.js's own scale:1.0
  // baseline).
  const [pdfRenderDpi, setPdfRenderDpi] = useState<number>(288);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; rectId: string } | null>(null);
  // Smart-rectangle state
  const [smartPanelRectId, setSmartPanelRectId] = useState<string | null>(null);
  const [smartRunning, setSmartRunning] = useState<Record<string, boolean>>({});

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<any>(null);
  const transformerRef = useRef<any>(null);
  const lastPointerPositionRef = useRef({ x: 0, y: 0 });
  const dockLayoutRef = useRef<DockLayout>(null);

  // The real canvas is a fixed-position sibling outside the dock tree, but it
  // mirrors the live bounding rect of the dockbox's invisible "Canvas" tab
  // (see CanvasSlotContainer above) so it visually resizes/repositions
  // whenever panels dock/undock/resize around it.
  const canvasSlotElRef = useRef<HTMLDivElement | null>(null);
  const canvasResizeObserverRef = useRef<ResizeObserver | null>(null);
  const [canvasRect, setCanvasRect] = useState(() => ({
    left: 0, top: 0, width: window.innerWidth, height: window.innerHeight,
  }));

  // Rect-rename collision toast — rendered next to the canvas zoom controls.
  // Visible for 4s, then fades out and unmounts. `visible` starts false and
  // flips to true a frame after mount so the opacity transition actually
  // plays (mounting already-visible skips it, since the browser never
  // paints the pre-transition state).
  const [nameToast, setNameToast] = useState<{ msg: string; visible: boolean } | null>(null);
  const nameToastHideTimer = useRef<number | undefined>(undefined);
  const nameToastRemoveTimer = useRef<number | undefined>(undefined);
  const handleRectNameCollision = useCallback(() => {
    clearTimeout(nameToastHideTimer.current);
    clearTimeout(nameToastRemoveTimer.current);
    setNameToast({ msg: "Table names must be unique.", visible: false });
    requestAnimationFrame(() => setNameToast((t) => (t ? { ...t, visible: true } : t)));
    nameToastHideTimer.current = window.setTimeout(() => {
      setNameToast((t) => (t ? { ...t, visible: false } : t));
      nameToastRemoveTimer.current = window.setTimeout(() => setNameToast(null), 300);
    }, 4000);
  }, []);
  useEffect(() => () => {
    clearTimeout(nameToastHideTimer.current);
    clearTimeout(nameToastRemoveTimer.current);
  }, []);

  const measureCanvasSlot = useCallback(() => {
    const el = canvasSlotElRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCanvasRect((prev) =>
      prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height
        ? prev
        : { left: r.left, top: r.top, width: r.width, height: r.height },
    );
  }, []);

  const setCanvasSlotEl = useCallback((el: HTMLDivElement | null) => {
    canvasResizeObserverRef.current?.disconnect();
    canvasResizeObserverRef.current = null;
    canvasSlotElRef.current = el;
    if (el) {
      measureCanvasSlot();
      const ro = new ResizeObserver(measureCanvasSlot);
      ro.observe(el);
      canvasResizeObserverRef.current = ro;
    }
  }, [measureCanvasSlot]);

  useEffect(() => {
    window.addEventListener("resize", measureCanvasSlot);
    return () => window.removeEventListener("resize", measureCanvasSlot);
  }, [measureCanvasSlot]);
  const [initialDockLayout] = useState<LayoutData>(() => {
    try {
      const raw = localStorage.getItem(DOCK_LAYOUT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.version === DOCK_LAYOUT_VERSION && parsed?.layout?.dockbox) {
          // Merge saved positions/sizes back with fresh (live) tab content —
          // content elements aren't JSON-serializable, so `saveLayout()` only
          // persisted structure; the containers below re-supply live content.
          return DockLayout.loadLayoutData(parsed.layout, { defaultLayout: buildDefaultDockLayout() });
        }
        // Version mismatch (or pre-versioning data): the saved snapshot may
        // carry stale panel-level config (e.g. missing panelLock), so discard
        // it rather than let it silently override current defaults forever.
      }
    } catch { /* ignore malformed saved layout */ }
    return buildDefaultDockLayout();
  });
  const handleDockLayoutChange = useCallback(() => {
    const dock = dockLayoutRef.current;
    if (!dock) return;
    localStorage.setItem(DOCK_LAYOUT_STORAGE_KEY, JSON.stringify({ version: DOCK_LAYOUT_VERSION, layout: dock.saveLayout() }));
    // The Canvas slot's ResizeObserver catches the vast majority of dock
    // changes (its own width/height changing), but a re-measure here too
    // covers the rare case of its position shifting without its size
    // changing (e.g. a sibling elsewhere in a nested box reflowing). Deferred
    // a frame so rc-dock's own re-render has already committed.
    requestAnimationFrame(measureCanvasSlot);
  }, [measureCanvasSlot]);
  const renderTimeoutRef = useRef<number | null>(null);
  // Set right before the initial-load renderPage() call so the debounced
  // "re-render at current zoom resolution" effect below doesn't immediately
  // re-render the page a second time right after it just finished loading
  // (that redundant re-render is what caused the reported load flicker).
  const skipNextAutoRenderRef = useRef(false);

  // Memoized derived values
  const selectedRectangles = useMemo(() => {
    return rectangles.filter((r) => selectedIds.includes(r.id));
  }, [rectangles, selectedIds]);

  const selectedGuides = useMemo(() => {
    return guides.filter((g) => selectedIds.includes(g.id));
  }, [guides, selectedIds]);

  const selectedItems = useMemo(() => {
    return [...selectedRectangles, ...selectedGuides];
  }, [selectedRectangles, selectedGuides]);

  const singleSelectedRect = useMemo(() => {
    return selectedRectangles.length === 1 ? selectedRectangles[0] : null;
  }, [selectedRectangles]);

  const ctxMenuRect = useMemo(() =>
    ctxMenu ? rectangles.find(r => r.id === ctxMenu.rectId) ?? null : null,
    [ctxMenu, rectangles]
  );

  // New memoized values for multi-guide selection
  const onlyGuidesSelected = useMemo(() => {
    return selectedGuides.length > 0 && selectedRectangles.length === 0;
  }, [selectedGuides, selectedRectangles]);

  // "Which table" the selected guide(s) currently follow, keyed by name
  // (or "__global__") — this is the dropdown's value, not a color.
  const selectedGuidesRectName = useMemo(() => {
    if (selectedGuides.length === 0) return guideColor;
    const first = selectedGuides[0];
    return first.rectName ?? "__global__";
  }, [selectedGuides, guideColor]);

  // Unique rect names for the guide-target dropdowns — several rectangles
  // can share a name, so this collapses them to one representative entry
  // per distinct name (used only for that entry's display color).
  const uniqueNamedRects = useMemo(() => {
    const seen = new Map<string, Rectangle>();
    for (const r of rectangles) {
      const name = r.name ?? r.id;
      if (!seen.has(name)) seen.set(name, r);
    }
    return Array.from(seen.values());
  }, [rectangles]);

  // Actual display color for `guideColor` (a rect NAME, or "__global__") —
  // used for the next-guide preview line and for newly-created guides.
  const guideColorPreviewStroke = useMemo(() => {
    if (guideColor === "__global__") return "black";
    return rectangles.find(r => (r.name ?? r.id) === guideColor)?.stroke ?? "black";
  }, [guideColor, rectangles]);

  const menuPosition = useMemo(() => {
    if (selectedItems.length === 0) return { left: 0, top: 0 };

    let totalX = 0;
    let totalY = 0;
    let count = 0;

    selectedRectangles.forEach((rect) => {
      totalX += rect.x + rect.width / 2;
      totalY += rect.y;
      count++;
    });

    selectedGuides.forEach((guide) => {
      totalX += guide.x;
      totalY += guide.y;
      count++;
    });

    if (count === 0) return { left: 0, top: 0 };

    const avgX = totalX / count;
    const avgY = totalY / count;

    const screenX = avgX * scale + stagePos.x;
    const screenY = avgY * scale + stagePos.y;

    return {
      left: screenX,
      top: screenY - 60,
    };
  }, [selectedItems, selectedRectangles, selectedGuides, scale, stagePos]);

  const cursor = useMemo(() => {
    if (isPanning) return "grabbing";
    if (activeTool === "hand" || spacePressed) return "grab";
    if (activeTool === "rectangle") return "crosshair";
    if (activeTool === "guide") return "crosshair";
    return "default";
  }, [isPanning, activeTool, spacePressed]);

  const computeAnnotationData = useCallback(
    (usePdfCoords: boolean = false): TableData[] => {
      console.warn(
        `[REACT] computeAnnotationData called with usePdfCoords=${usePdfCoords}`,
      );
      console.warn(`[REACT] Current pageHeight: ${pageHeight}`);

      // outputSlot is assigned by each table's reading-order position among
      // Schema Preview cards -- top-to-bottom (schemaY) first, then
      // left-to-right (schemaX) to break ties between cards that land on
      // the same row, so ranking always starts from the top-left origin and
      // proceeds outward from there. Independent of `occurrenceOrder`,
      // which is a separate flag still sent to Python below to control
      // Camelot's own column-detection sort order and is not touched by
      // this ranking. A rectangle never yet positioned in Schema
      // (schemaX/schemaY undefined) falls back to its canvas x/y, so
      // brand-new tables the user hasn't opened Schema for still get a
      // sane rank.
      const schemaRank = [...rectangles].sort((a, b) => {
        const ay = a.schemaY ?? a.y;
        const by = b.schemaY ?? b.y;
        if (ay !== by) return ay - by;
        return (a.schemaX ?? a.x) - (b.schemaX ?? b.x);
      });
      const slotByRectId = new Map(schemaRank.map((r, i) => [r.id, i]));

      const MAX_OUTPUT_SLOTS = 20;
      const data = rectangles.map((rect) => {
        const rectIndex = slotByRectId.get(rect.id)!;
        // Apply offset for smart rects
        const off = rect.mode === "smart"
          ? (rect.smartConfig?.offset ?? { top: 0, bottom: 0, left: 0, right: 0 })
          : { top: 0, bottom: 0, left: 0, right: 0 };

        const ex = rect.x - off.left;
        const ey = rect.y - off.top;
        const ew = rect.width + off.left + off.right;
        const eh = rect.height + off.top + off.bottom;

        const x1 = ex;
        const x2 = ex + ew;

        const tableName = rect.name ?? rect.id;

        // Named guides belong to this table by explicit user assignment — include
        // them unconditionally (no x-range check) so that smart-rect page changes
        // (which shift rect.x) never silently drop a guide the user placed on a
        // different page than the one currently in view.
        const namedGuides = guides
          .filter((g) => g.rectName === tableName)
          .sort((a, b) => a.x - b.x);

        // Global guides (no table assignment) are determined by x-range overlap
        // with the offset-adjusted table area on the current page.
        const globalGuides = guides
          .filter((g) => !g.rectName && g.x >= x1 && g.x <= x2)
          .sort((a, b) => a.x - b.x);

        const allRelevantGuides = [...namedGuides, ...globalGuides].sort((a, b) => a.x - b.x);

        // For smart rects with per-page data, build per-page table_area AND
        // per-page column positions.  Guide x-coords are stored as absolute canvas
        // values captured when the guide was placed.  When the keyword position
        // shifts on a different page, we translate each guide by the same delta so
        // it keeps the same relative position within that page's table area.
        let tableAreaByPage: Record<string, number[]> | undefined;
        let columnsByPage: Record<string, string[]> | undefined;
        if (rect.mode === "smart" && rect.smartPageData && usePdfCoords) {
          tableAreaByPage = {};
          if (allRelevantGuides.length > 0) columnsByPage = {};
          for (const [pageKey, entry] of Object.entries(rect.smartPageData)) {
            if (!entry?.union_bbox) continue;
            const [bx0, by0, bx1, by1] = entry.union_bbox;
            const pex = bx0 - off.left;
            const pey = by0 - off.top;
            const pew = (bx1 - bx0) + off.left + off.right;
            const peh = (by1 - by0) + off.top + off.bottom;
            tableAreaByPage[pageKey] = [pex, pageHeight - pey - peh, pex + pew, pageHeight - pey];
            if (columnsByPage) {
              // Translate guide from current-page absolute x → this page's absolute x
              // by preserving relative offset from the offset-adjusted left edge.
              const pageCols = allRelevantGuides
                .map((g) => pex + (g.x - x1))
                .filter((absX) => absX > pex && absX < pex + pew)
                .map(String);
              if (pageCols.length > 0) columnsByPage[pageKey] = pageCols;
            }
          }
          console.warn(`[REACT] Smart rect ${rect.id}: per-page table areas:`, tableAreaByPage);
        }

        // Canvas coordinates (offset-adjusted, current page)
        const canvasCoords = [ex, ey, ex + ew, ey + eh];

        // PDF coordinates (Y inverted, offset-adjusted, current page — fallback)
        const pdfCoords = [
          ex,
          pageHeight - ey - eh,
          ex + ew,
          pageHeight - ey,
        ];

        const tableArea = usePdfCoords ? pdfCoords : canvasCoords;

        const groupName = rect.groupId
          ? (groups.find((g) => g.id === rect.groupId)?.name ?? "").trim()
          : "";

        const result: TableData = {
          rectId: rect.id,
          ...(rect.name ? { name: rect.name } : {}),
          ...(groupName ? { group: groupName } : {}),
          table_area: tableArea,
          ...(tableAreaByPage ? { table_area_by_page: tableAreaByPage } : {}),
          columns: allRelevantGuides.map((g) => g.x.toString()),
          ...(columnsByPage ? { columns_by_page: columnsByPage } : {}),
          autoDetectColumns: rect.autoDetectColumns === true,
          ...(rectIndex < MAX_OUTPUT_SLOTS ? { outputSlot: rectIndex + 1 } : {}),
          ...(rect.columnRenames && Object.keys(rect.columnRenames).length
            ? { columnRenames: rect.columnRenames }
            : {}),
        };

        return result;
      });

      return data;
    },
    [rectangles, guides, pageHeight, groups],
  );

  // Save canvas state (for restoration when reopening Orange file)---------------
  const saveCanvasState = useCallback(() => {
    if (!bridge || !isReady) return;

    const rawUiData = {
      rectangles,
      guides,
      groups,
      colorOrder,
      occurrenceOrder,
      sampleConfig,
    };
    bridge.saveHtmlState(JSON.stringify(rawUiData));
  }, [bridge, isReady, rectangles, guides, groups, colorOrder, occurrenceOrder, sampleConfig]);

  // Auto-save state whenever anything that needs persisting changes
  useEffect(() => {
    saveCanvasState();
  }, [rectangles, guides, groups, colorOrder, occurrenceOrder, sampleConfig, saveCanvasState]);

  // ── Project save/open (menu bar's File menu) ──────────────────────────
  // The real project-file persistence saveHtmlState's own TODO comment
  // pointed at ("once there's a project/session concept to save them
  // into") -- a plain JSON file (.altera) capturing everything needed to
  // reopen this exact workspace: which PDF, and every rectangle/group/
  // guide/workflow-node built on top of it.
  const PROJECT_FILE_VERSION = 1;
  // Null until the workspace has been saved to (or opened from) a real
  // file -- plain "Save" prompts for a location (acts like "Save As") the
  // first time, then writes straight to this path on every save after.
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);

  const buildProjectData = useCallback(() => ({
    version: PROJECT_FILE_VERSION,
    pdfPath: currentPdfPath,
    rectangles,
    guides,
    groups,
    processorNodes,
    edges,
    colorOrder,
    occurrenceOrder,
    sampleConfig,
  }), [currentPdfPath, rectangles, guides, groups, processorNodes, edges, colorOrder, occurrenceOrder, sampleConfig]);

  const handleSaveProjectAs = useCallback(async () => {
    const path = await window.alteraStudio.saveProjectAs(JSON.stringify(buildProjectData(), null, 2));
    if (path) setCurrentProjectPath(path);
  }, [buildProjectData]);

  const handleSaveProject = useCallback(async () => {
    if (!currentProjectPath) {
      await handleSaveProjectAs();
      return;
    }
    await window.alteraStudio.saveProjectToPath(currentProjectPath, JSON.stringify(buildProjectData(), null, 2));
  }, [currentProjectPath, buildProjectData, handleSaveProjectAs]);

  const handleOpenProject = useCallback(async () => {
    const opened = await window.alteraStudio.openProjectDialog();
    if (!opened) return;
    let data: ReturnType<typeof buildProjectData>;
    try {
      data = JSON.parse(opened.data);
    } catch {
      alert("This file isn't a valid Altera project.");
      return;
    }

    // Re-load the PDF this project references first -- everything else
    // (rectangles, groups, ...) is drawn relative to it, and the backend
    // needs its own set-path call before Convert/Schema Preview will work
    // against it (same call bridge.openFileDialog makes for a fresh open).
    if (data.pdfPath) {
      try {
        await fetch(`${window.alteraStudio.backendUrl}/pdf-converter/set-path`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: data.pdfPath }),
        });
        await (window as unknown as { loadPdfFromPath: (p: string) => Promise<void> }).loadPdfFromPath(data.pdfPath);
      } catch {
        alert(`Couldn't reopen "${data.pdfPath}" -- it may have moved. The rest of the project loaded anyway.`);
      }
    }

    setRectangles(data.rectangles ?? []);
    setGuides(data.guides ?? []);
    setGroups(data.groups ?? []);
    setProcessorNodes(data.processorNodes ?? []);
    setEdges(data.edges ?? []);
    setColorOrder(data.colorOrder ?? []);
    setOccurrenceOrder(data.occurrenceOrder ?? true);
    if (data.sampleConfig) setSampleConfig(data.sampleConfig);
    setWorkflowResetSignal((v) => v + 1);
    // A freshly-opened project's edit history starts clean -- undoing past
    // its own load, back into whatever the PREVIOUS project's edits were,
    // wouldn't make sense.
    historyRef.current = [];
    futureRef.current = [];
    setHistoryVersion((v) => v + 1);
    setCurrentProjectPath(opened.path);
  }, [buildProjectData]);

  // Prevent browser zoom (Ctrl+scroll) everywhere in the webview
  useEffect(() => {
    const block = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); };
    document.addEventListener("wheel", block, { passive: false });
    return () => document.removeEventListener("wheel", block);
  }, []);

  // ── Smart rectangle: receive keyword locations from Python ───────────────────
  useEffect(() => {
    (window as any).receiveKeywordData = (
      rectId: string,
      pageData: Record<string, SmartRawPageEntry | null> | null,
      error: string | null,
    ) => {
      setSmartRunning((prev) => ({ ...prev, [rectId]: false }));
      if (error) { alert(`Smart search failed: ${error}`); return; }
      setRectangles((prev) =>
        prev.map((r) => {
          if (r.id !== rectId) return r;
          const rawData = pageData ?? {};
          const applied = applyKeywordRules(rawData, r.smartConfig?.keywordSettings ?? {});
          const entry = applied[String(pageNum)];
          const ub = entry?.union_bbox;
          return ub
            ? { ...r, smartRawData: rawData, smartPageData: applied, x: ub[0], y: ub[1], width: ub[2] - ub[0], height: ub[3] - ub[1] }
            : { ...r, smartRawData: rawData, smartPageData: applied };
        }),
      );
    };
    return () => { delete (window as any).receiveKeywordData; };
  }, [pageNum]);

  // ── Smart rectangle: adapt positions when page changes ───────────────────────
  useEffect(() => {
    setRectangles((prev) =>
      prev.map((r) => {
        if (r.mode !== "smart" || !r.smartPageData) return r;
        const entry = r.smartPageData[String(pageNum)];
        const ub = entry?.union_bbox;
        if (!ub) return r;
        return { ...r, x: ub[0], y: ub[1], width: ub[2] - ub[0], height: ub[3] - ub[1] };
      }),
    );
  }, [pageNum]);

  // Handle Convert button click - send PDF coordinates----------------------------
  const handleConvert = useCallback(() => {
    // Guards both the button (see ToolbarPanel's disabled prop below) and
    // the Ctrl+Enter shortcut against firing a second conversion while one
    // is already in flight -- a ref, not `showLoader` state, so it's read
    // synchronously and can't be raced by two calls in the same tick.
    if (isConvertingRef.current) return;
    console.warn("[REACT] ========== CONVERT CLICKED ==========");
    console.warn("[REACT] Bridge ready:", isReady);
    console.warn("[REACT] Rectangles count:", rectangles.length);
    console.warn("[REACT] Guides count:", guides.length);
    console.warn("[REACT] pageHeight:", pageHeight);
    if (!bridge || !isReady) {
      console.error("[REACT] Bridge not ready!");
      alert("Connection to Python not ready. Please try again.");
      return;
    }

    if (rectangles.length === 0) {
      console.warn("[REACT] No rectangles drawn");
      alert("Please draw at least one rectangle before converting.");
      return;
    }

    // Only past this point are we actually committed to sending the
    // request -- setting the guard/loader any earlier meant an early
    // return above (bridge not ready, no rectangles) left both stuck on
    // forever, since nothing after this point would ever reset them.
    isConvertingRef.current = true;
    showLoaderHandler(1);

    const pdfData = computeAnnotationData(true);
    console.warn("[REACT] PDF Data (should be inverted):", pdfData);

    const payload = {
      tables: pdfData,
      occurrenceOrder: occurrenceOrder,
      closeAfterConvert: closeAfterConvert,
      sampleMode: sampleConfig.enabled
        ? { mode: sampleConfig.mode, startPage: sampleConfig.startPage, endPage: sampleConfig.endPage, firstN: sampleConfig.firstN }
        : null,
    };
    const jsonData = JSON.stringify(payload);
    console.warn("[REACT] Payload JSON Data:", jsonData);

    console.warn("[REACT] Calling bridge.getCoordinatesFromJs...");
    bridge.getCoordinatesFromJs(jsonData, 1);
    console.warn("[REACT] Call complete");
  }, [bridge, isReady, rectangles, guides, computeAnnotationData, pageHeight, sampleConfig]);

  // ── Schema preview: receive per-table column/sample data from Python ─────────
  useEffect(() => {
    (window as any).receiveSchemaPreview = (
      payload: SchemaPreviewTable[] | null,
      error: string | null,
    ) => {
      setSchemaPreviewLoading(false);
      if (error) { setSchemaPreviewError(error); return; }
      setSchemaPreviewError(null);
      setSchemaPreviewTables(payload ?? []);
    };
    return () => { delete (window as any).receiveSchemaPreview; };
  }, []);

  // ── Convert: receive the real, full per-table extraction result ──────────
  // (backendBridge.ts correlates each output slot back to its table's own
  // stable rectId before calling this -- see TableData.rectId's comment --
  // so convertedTables stays keyed by that, immune to renames).
  useEffect(() => {
    (window as any).receiveConvertResult = (
      byId: Record<string, { columns: string[]; rows: string[][] }>,
    ) => {
      setConvertedTables((prev) => ({ ...prev, ...byId }));
    };
    return () => { delete (window as any).receiveConvertResult; };
  }, []);

  // Settings now live in a separate native window (see SettingsWindow.tsx) --
  // this applies whatever it saves back onto the main window's own state.
  const applyPersistedSettings = useCallback((saved: PersistedSettings) => {
    setSampleConfig(saved.sample);
    setCloseAfterConvert(saved.closeAfterConvert);
    setSchemaSampleRowLimit(saved.schemaSampleRowLimit);
    setSchemaPageLimit(saved.schemaPageLimit);
    setAutoExpandOutputDrawer(saved.autoExpandOutputDrawer);
    // Older persisted settings.json files predate this field -- fall back
    // to the pre-existing hardcoded behavior rather than rendering at an
    // undefined/NaN DPI.
    setPdfRenderDpi(saved.pdfRenderDpi ?? 288);
  }, []);

  useEffect(() => {
    return window.alteraStudio.onSettingsApplied(applyPersistedSettings);
  }, [applyPersistedSettings]);

  // Whatever was saved last session, loaded once on launch -- otherwise
  // every restart silently reverts to hardcoded defaults.
  useEffect(() => {
    window.alteraStudio.loadPersistedSettings().then((saved) => {
      if (saved) applyPersistedSettings(saved);
    });
  }, [applyPersistedSettings]);

  // Geometry-only key for rectangles — excludes `name` so renaming a table
  // doesn't re-trigger the schema preview (only geometry/config changes do).
  const rectGeometryKey = useMemo(
    // Exclude display-only fields (name, columnRenames) so renaming a table or
    // column header doesn't re-trigger the schema preview extraction. Also
    // exclude schemaX/schemaY -- those change on every Schema card drag or
    // align/distribute action, and re-extracting on every drag would both
    // waste a debounced Python round-trip and visibly stutter the drag once
    // the response lands and re-renders.
    () => rectangles.map(({ name: _n, columnRenames: _cr, schemaX: _sx, schemaY: _sy, ...rest }) => JSON.stringify(rest)).join("|"),
    [rectangles],
  );

  // Stable ref so the preview effect can always call the latest
  // computeAnnotationData (which captures current names) without listing it
  // as a dependency (which would cause name-change re-triggers).
  const computeAnnotationDataRef = useRef(computeAnnotationData);
  useEffect(() => { computeAnnotationDataRef.current = computeAnnotationData; }, [computeAnnotationData]);

  // ── Schema preview: debounced re-run on rect/guide changes while the Schema
  // view is open (sample-only, first 10 pages -- see process_schema_preview
  // on the Python side). Not triggered while on the Canvas view, so toggling
  // back and forth doesn't re-extract anything.
  // rectGeometryKey (not rectangles) is the dep so renaming alone doesn't re-run.
  useEffect(() => {
    if (!showSchema || !bridge || !isReady || !pdfDoc) return;
    if (rectangles.length === 0) {
      // Nothing left to preview -- clear any previous result instead of
      // just bailing out here (the old behavior): deleting the very last
      // rectangle left its card behind forever on the Workflow canvas,
      // since nothing ever told schemaPreviewTables to catch up (this
      // effect never re-ran, and displayTables in SchemaView.tsx has no
      // other way to know a table's rectangle is gone).
      setSchemaPreviewTables([]);
      setSchemaPreviewError(null);
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setSchemaPreviewLoading(true);
      setSchemaPreviewError(null);
      const tablesInfo = computeAnnotationDataRef.current(true);
      bridge.previewSchema(JSON.stringify({ tables: tablesInfo, occurrenceOrder, sampleRowLimit: schemaSampleRowLimit, pageLimit: schemaPageLimit }));
    }, 600);
    return () => window.clearTimeout(timeoutId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSchema, bridge, isReady, pdfDoc, rectGeometryKey, guides, occurrenceOrder, schemaSampleRowLimit, schemaPageLimit]);

  // A newly loaded PDF invalidates any previous preview (it was extracted
  // from a different document) -- drop it so stale cards can't linger.
  useEffect(() => {
    setSchemaPreviewTables(null);
    setSchemaPreviewError(null);
  }, [pdfDoc]);

  // --------------------------------------------------------------------------------------
  // change loader
  const showLoaderHandler = (value: number) => {
    if (Number(value) === 1) {
      setShowLoader(true);
      setConversionProgress(null);
    } else {
      setShowLoader(false);
      setConversionProgress(null);
      isConvertingRef.current = false;
    }
  };

  useEffect(() => {
    // expose to PyQt
    window.showLoaderHandler = showLoaderHandler;
    (window as any).setConversionProgress = (pct: number) => setConversionProgress(pct);
    (window as any).initCloseAfterConvert = (val: boolean) => setCloseAfterConvert(val);

    return () => {
      delete window.showLoaderHandler;
      delete (window as any).setConversionProgress;
      delete (window as any).initCloseAfterConvert;
    };
  }, []);

  // --------------------------------------------------------------------------------------
  // Add this function in the component
  const restoreFromSavedState = useCallback(
    (savedData: { rectangles: Rectangle[]; guides: Guide[]; groups?: Group[]; colorOrder?: string[]; occurrenceOrder?: boolean; sampleConfig?: SampleConfig }) => {
      setRectangles([]);
      setGuides([]);
      setGroups([]);
      setSelectedIds([]);

      if (savedData.rectangles?.length > 0) setRectangles(savedData.rectangles);
      if (savedData.guides?.length > 0) {
        // Migrate saves from before guides were matched to tables by name:
        // they carry a `rectId` pointing at one specific rectangle instance
        // instead of `rectName`. Without this, those guides would silently
        // become "global" on load instead of keeping their table.
        const migratedGuides = savedData.guides.map((g) => {
          const legacy = g as Guide & { rectId?: string };
          if (legacy.rectName || !legacy.rectId) return g;
          const rect = savedData.rectangles?.find((r) => r.id === legacy.rectId);
          const { rectId: _rectId, ...rest } = legacy;
          return { ...rest, rectName: rect?.name ?? rect?.id };
        });
        setGuides(migratedGuides);
      }
      if (savedData.groups && savedData.groups.length > 0) setGroups(savedData.groups);
      if (savedData.colorOrder && savedData.colorOrder.length > 0) setColorOrder(savedData.colorOrder);
      if (savedData.occurrenceOrder !== undefined) setOccurrenceOrder(savedData.occurrenceOrder);
      if (savedData.sampleConfig) setSampleConfig(savedData.sampleConfig);
    },
    [],
  );

  // Expose to window for Python to call
  useEffect(() => {
    (window as any).restoreAnnotations = restoreFromSavedState;

    return () => {
      delete (window as any).restoreAnnotations;
    };
  }, [restoreFromSavedState]);

  // Expose setInkOverlay for Python to send ink overlay image
  useEffect(() => {
    (window as any).setInkOverlay = async (base64Data: string) => {
      console.log(
        "[REACT] setInkOverlay called, data length:",
        base64Data.length,
      );

      const img = new window.Image();

      img.onload = () => {
        setInkOverlayImage(img);
        setShowInkOverlay(true);
      };

      img.onerror = () => {};

      img.src = base64Data;
      console.log("[REACT] Started loading image...");
    };

    (window as any).setInkOverlayError = () => {};
    (window as any).setOverlayProgress = () => {};

    return () => {
      delete (window as any).setInkOverlay;
      delete (window as any).setInkOverlayError;
      delete (window as any).setOverlayProgress;
    };
  }, []);

  // ------------------------------------------------------------------

  // ------------------------------------------------------------------

  const renderPage = useCallback(
    async (
      pdf: any,
      pageNumber: number,
      isInitialLoad = false,
      renderScale = 1,
    ) => {
      // Cancel any in-flight render so rapid zoom/page changes don't stack
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel(); } catch (_) { /* ignore */ }
        renderTaskRef.current = null;
      }

      setIsPageRendering(true);
      try {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.0 });
        const renderViewport = page.getViewport({ scale: renderScale });

        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d")!;
        canvas.width = renderViewport.width;
        canvas.height = renderViewport.height;

        const task = page.render({ canvasContext: context, viewport: renderViewport });
        renderTaskRef.current = task;
        await task.promise;
        renderTaskRef.current = null;

        const img = new window.Image();
        img.src = canvas.toDataURL();
        await new Promise((resolve) => { img.onload = resolve; });

        setPageImage(img);
        setPageWidth(viewport.width);
        setPageHeight(viewport.height);

        if (isInitialLoad && containerRef.current) {
          setScale(0.7);
          setNeedsInitialCenter(true);
        }
      } catch (error: any) {
        if (error?.name === "RenderingCancelledException") return;
        console.error("Error rendering page:", error);
      } finally {
        setIsPageRendering(false);
      }
    },
    [],
  );

  useEffect(() => {
    (window as any).loadPdfFromPath = async (pdfPath: string) => {
      console.warn("[REACT] Loading PDF from path:", pdfPath);

      setCurrentPdfPath(pdfPath);
      setInkOverlayImage(null);
      setShowInkOverlay(false);
      setIsFileLoading(true);

      try {
        // fetch() can't read a file:// URL from this renderer's origin --
        // read the bytes on the Electron main process side instead.
        const base64 = await window.alteraStudio.readFileBase64(pdfPath);
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;

        setPdfDoc(pdf);
        setNumPages(pdf.numPages);
        setPageNum(1);

        skipNextAutoRenderRef.current = true;
        await renderPage(pdf, 1, true, window.devicePixelRatio || 1);

        console.log("[REACT] PDF loaded successfully");

        // Auto-run smart rectangles that have keywords configured
        setTimeout(() => {
          rectanglesRef.current
            .filter(r => r.mode === "smart" && (r.smartConfig?.keywords?.length ?? 0) > 0)
            .forEach(r => handleRunSmartRef.current(r.id));
        }, 100);
      } catch (error) {
        console.error("[REACT] Error loading PDF:", error);
        alert("Failed to load PDF file");
      } finally {
        setIsFileLoading(false);
      }
    };

    return () => {
      delete (window as any).loadPdfFromPath;
    };
  }, [renderPage]);
  // Shared by every renderPage call site below -- how many actual raster
  // pixels the PDF gets rendered at for the current on-screen zoom. Always
  // at least devicePixelRatio (so it's never blurrier than a plain
  // scale:1 render would be on this display) and capped at
  // pdfRenderDpi / 72 (72 = pdf.js's own scale:1.0 baseline, i.e. how a
  // "DPI" number translates to a render scale multiplier) -- purely a
  // render speed/sharpness tradeoff, see SettingsPayload.pdfRenderDpi's
  // own comment for why this has no effect on annotation accuracy.
  const computeRenderScale = useCallback((currentScale: number) => {
    const devicePixelRatio = window.devicePixelRatio || 1;
    const baseRenderScale = currentScale * devicePixelRatio;
    return Math.min(Math.max(baseRenderScale, devicePixelRatio), pdfRenderDpi / 72);
  }, [pdfRenderDpi]);

  const handlePrevPage = useCallback(() => {
    if (pdfDoc && pageNum > 1) {
      const newPage = pageNum - 1;
      setPageNum(newPage);
      renderPage(pdfDoc, newPage, false, computeRenderScale(scale));
    }
  }, [pdfDoc, pageNum, scale, renderPage, computeRenderScale]);

  const handleNextPage = useCallback(() => {
    if (pdfDoc && pageNum < numPages) {
      const newPage = pageNum + 1;
      setPageNum(newPage);
      renderPage(pdfDoc, newPage, false, computeRenderScale(scale));
    }
  }, [pdfDoc, pageNum, numPages, scale, renderPage, computeRenderScale]);

  const handleGoToPage = useCallback(() => {
    const targetPage = pageInputValue;
    if (pdfDoc && targetPage != null && targetPage >= 1 && targetPage <= numPages) {
      setPageNum(targetPage);
      renderPage(pdfDoc, targetPage, false, computeRenderScale(scale));
      setShowPageInput(false);
      setPageInputValue(null);
    }
  }, [pdfDoc, pageInputValue, numPages, scale, renderPage, computeRenderScale]);

  const handleFileDrop = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".pdf")) return;
      setIsFileLoading(true);
      try {
        const arrayBuffer = await file.arrayBuffer();

        if (bridge && isReady) {
          const bytes = new Uint8Array(arrayBuffer);
          let binary = "";
          for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
          bridge.receivePdfData(file.name, btoa(binary));
        }

        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        setCurrentPdfPath(file.name);
        setPdfDoc(pdf);
        setNumPages(pdf.numPages);
        setPageNum(1);

        skipNextAutoRenderRef.current = true;
        await renderPage(pdf, 1, true, window.devicePixelRatio || 1);
        setNeedsInitialCenter(true);

        // Auto-run smart rectangles that have keywords configured
        setTimeout(() => {
          rectanglesRef.current
            .filter(r => r.mode === "smart" && (r.smartConfig?.keywords?.length ?? 0) > 0)
            .forEach(r => handleRunSmartRef.current(r.id));
        }, 100);
      } catch (error) {
        console.error("[REACT] Error loading dropped PDF:", error);
      } finally {
        setIsFileLoading(false);
      }
    },
    [bridge, isReady, renderPage],
  );

  const handleOpenPdf = useCallback(() => {
    if (bridge && isReady) {
      bridge.openFileDialog();
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".pdf";
      input.onchange = (e) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (f) handleFileDrop(f);
      };
      input.click();
    }
  }, [bridge, isReady, handleFileDrop]);

  useEffect(() => {
    if (containerRef.current && stageRef.current) {
      const container = containerRef.current;
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;

      setStagePos({
        x: (containerWidth - pageWidth) / 2,
        y: (containerHeight - pageHeight) / 2,
      });
    }
  }, [pageWidth, pageHeight]);

  useEffect(() => {
    if (needsInitialCenter && containerRef.current) {
      const container = containerRef.current;
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;

      setStagePos({
        x: (containerWidth - pageWidth * scale) / 2,
        y: (containerHeight - pageHeight * scale) / 2,
      });
      setNeedsInitialCenter(false);
    }
  }, [needsInitialCenter, scale, pageWidth, pageHeight]);

  useEffect(() => {
    if (!pdfDoc || !pageNum) return;

    if (renderTimeoutRef.current) {
      clearTimeout(renderTimeoutRef.current);
    }

    renderTimeoutRef.current = setTimeout(() => {
      if (skipNextAutoRenderRef.current) {
        skipNextAutoRenderRef.current = false;
        return;
      }
      renderPage(pdfDoc, pageNum, false, computeRenderScale(scale));
    }, 300);

    return () => {
      if (renderTimeoutRef.current) {
        clearTimeout(renderTimeoutRef.current);
      }
    };
  }, [scale, pdfDoc, pageNum, renderPage, computeRenderScale]);

  useEffect(() => {
    if (transformerRef.current) {
      const stage = stageRef.current;
      if (selectedIds.length > 0 && stage) {
        // Locked rects are now included here too (previously excluded
        // entirely, so a locked-and-selected rect got no on-canvas feedback
        // at all) — the Transformer below shows them with a dashed border
        // and no resize handles instead of a permanent lock-icon badge.
        const selectedRectIds = rectangles
          .filter((r) => selectedIds.includes(r.id) && r.mode !== "smart")
          .map((r) => r.id);

        const selectedNodes = selectedRectIds
          .map((id) => stage.findOne("#" + id))
          .filter((node) => node);

        if (selectedNodes.length > 0) {
          transformerRef.current.nodes(selectedNodes);
          transformerRef.current.getLayer().batchDraw();
        } else {
          transformerRef.current.nodes([]);
        }
      } else {
        transformerRef.current.nodes([]);
      }
    }
    // `activeTool` must stay a dependency even though this effect doesn't
    // read it directly: <Transformer> only mounts while activeTool==="select"
    // (see its conditional render below), so switching tools mounts a brand
    // new Konva Transformer instance whose internal `.nodes()` state was
    // never initialized. Without re-running this effect on that transition,
    // the fresh instance stays uninitialized until some unrelated selection
    // change happens to fire it — and clicking a rect in the meantime crashes
    // inside Konva's own Transformer._handleMouseDown (reads .forEach on the
    // still-undefined internal nodes array).
  }, [selectedIds, rectangles, activeTool]);

  const handleZoomIn = useCallback(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    const centerX = containerWidth / 2;
    const centerY = containerHeight / 2;

    setScale((prevScale) => {
      const newScale = Math.min(prevScale + ZOOM_STEP, MAX_ZOOM);

      const pointX = (centerX - stagePos.x) / prevScale;
      const pointY = (centerY - stagePos.y) / prevScale;

      const newX = centerX - pointX * newScale;
      const newY = centerY - pointY * newScale;

      setStagePos({ x: newX, y: newY });

      return newScale;
    });
  }, [stagePos.x, stagePos.y]);

  const handleZoomOut = useCallback(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    const centerX = containerWidth / 2;
    const centerY = containerHeight / 2;

    setScale((prevScale) => {
      const newScale = Math.max(prevScale - ZOOM_STEP, MIN_ZOOM);

      const pointX = (centerX - stagePos.x) / prevScale;
      const pointY = (centerY - stagePos.y) / prevScale;

      const newX = centerX - pointX * newScale;
      const newY = centerY - pointY * newScale;

      setStagePos({ x: newX, y: newY });

      return newScale;
    });
  }, [stagePos.x, stagePos.y]);


  const handleFitPage = useCallback(() => {
    if (containerRef.current) {
      const container = containerRef.current;
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;

      const toolbarHeight = 35;
      const padding = 40;
      const availableHeight = containerHeight - toolbarHeight - padding * 2;
      const availableWidth = containerWidth - padding * 2;

      const newScale = Math.min(availableWidth / pageWidth, availableHeight / pageHeight, MAX_ZOOM);
      setScale(newScale);
      setStagePos({
        x: (containerWidth - pageWidth * newScale) / 2,
        y: (containerHeight - pageHeight * newScale - toolbarHeight) / 2,
      });
    }
  }, [pageWidth, pageHeight]);

  // `rectanglesOverride` lets a caller snapshot a rectangles array other
  // than the live committed state -- needed when finalizing a new rect
  // (see handleStageMouseUp), where by the time we know the draw gesture
  // is done, state already contains the transient "temp-rect" placeholder
  // and we want history to remember "before this rect existed" instead.
  const pushHistory = useCallback((rectanglesOverride?: Rectangle[]) => {
    const snapshot = {
      rectangles: (rectanglesOverride ?? rectanglesRef.current).map((r) => ({ ...r })),
      guides:     guidesRef.current.map((g) => ({ ...g })),
    };
    historyRef.current = [...historyRef.current.slice(-49), snapshot];
    // A fresh action invalidates whatever was available to redo.
    if (futureRef.current.length > 0) futureRef.current = [];
    setHistoryVersion((v) => v + 1);
  }, []);

  const handleUndo = useCallback(() => {
    if (historyRef.current.length === 0) return;
    const current = {
      rectangles: rectanglesRef.current.map((r) => ({ ...r })),
      guides:     guidesRef.current.map((g) => ({ ...g })),
    };
    const prev = historyRef.current[historyRef.current.length - 1];
    historyRef.current = historyRef.current.slice(0, -1);
    futureRef.current = [...futureRef.current, current];
    setRectangles(prev.rectangles);
    setGuides(prev.guides);
    setHistoryVersion((v) => v + 1);
  }, []);

  const handleRedo = useCallback(() => {
    if (futureRef.current.length === 0) return;
    const current = {
      rectangles: rectanglesRef.current.map((r) => ({ ...r })),
      guides:     guidesRef.current.map((g) => ({ ...g })),
    };
    const next = futureRef.current[futureRef.current.length - 1];
    futureRef.current = futureRef.current.slice(0, -1);
    historyRef.current = [...historyRef.current, current];
    setRectangles(next.rectangles);
    setGuides(next.guides);
    setHistoryVersion((v) => v + 1);
  }, []);

  const handleColorChange = useCallback(
    (hex: string) => {
      if (!singleSelectedRect) return;
      pushHistory();
      const { fill, stroke } = hexToFillStroke(hex);
      setRectangles(prev => prev.map(r =>
        r.id === singleSelectedRect.id ? { ...r, fill, stroke } : r
      ));
      // Cosmetic only: guides are matched to tables by name, not color, so
      // this just refreshes the display color shown for guides following
      // this table's name — it never changes which guides apply to it.
      const name = singleSelectedRect.name ?? singleSelectedRect.id;
      setGuides(prev => prev.map(g =>
        g.rectName === name ? { ...g, color: stroke } : g
      ));
    },
    [singleSelectedRect, pushHistory],
  );

  // Same idea as handleColorChange, but keyed by id instead of "whatever is
  // currently selected" — used by the Groups tab's per-row color swatch,
  // which must be able to recolor a layer without needing it selected first.
  // Preserves the layer's existing opacity instead of resetting to the
  // palette default alpha.
  const handleChangeRectColor = useCallback(
    (id: string, hex: string) => {
      pushHistory();
      const { fill: paletteFill, stroke } = hexToFillStroke(hex);
      setRectangles(prev => prev.map(r =>
        r.id === id ? { ...r, fill: fillWithAlpha(paletteFill, fillAlpha(r.fill)), stroke } : r
      ));
      // Cosmetic only — see handleColorChange's comment above.
      const target = rectangles.find(r => r.id === id);
      const name = target?.name ?? id;
      setGuides(prev => prev.map(g =>
        g.rectName === name ? { ...g, color: stroke } : g
      ));
    },
    [pushHistory, rectangles],
  );

  // Assigns the currently selected guide(s) — or, if none are selected, the
  // "next guide to draw" default — to follow a table by NAME. `rectName` is
  // the matching key (used everywhere a table name is currently in scope);
  // `color` is just a display snapshot for the guide's own line color.
  const handleGuideRectNameChange = useCallback(
    (rectName: string) => {
      if (selectedGuides.length > 0) {
        pushHistory();
        if (rectName === "__global__") {
          setGuides((prev) =>
            prev.map((g) =>
              selectedIds.includes(g.id) ? { ...g, color: "#000000", rectName: undefined } : g,
            ),
          );
        } else {
          const assocRect = rectangles.find(r => (r.name ?? r.id) === rectName);
          setGuides((prev) =>
            prev.map((g) =>
              selectedIds.includes(g.id) ? { ...g, color: assocRect?.stroke ?? g.color, rectName } : g,
            ),
          );
        }
      } else {
        setGuideColor(rectName);
      }
    },
    [selectedGuides, selectedIds, rectangles, pushHistory],
  );

  const handleCopySelected = useCallback(() => {
    const selected = rectanglesRef.current.filter((r) => selectedIds.includes(r.id));
    if (selected.length > 0) {
      clipboardRef.current = selected.map((r) => ({ ...r }));
    }
  }, [selectedIds]);

  const handlePasteSelected = useCallback(() => {
    if (clipboardRef.current.length === 0) return;
    pushHistory();
    const base = rectanglesRef.current;
    const newRects: Rectangle[] = [];
    for (const r of clipboardRef.current) {
      const allSoFar = [...base, ...newRects];
      newRects.push({
        ...r,
        id: `rect-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        x: r.x + 20,
        y: r.y + 20,
        name: uniqueRectName(r.name ?? r.id, allSoFar),
      });
    }
    setRectangles((prev) => [...prev, ...newRects]);
    setSelectedIds(newRects.map((r) => r.id));
  }, [pushHistory]);

  const handleDuplicateSelected = useCallback(() => {
    const selected = rectanglesRef.current.filter((r) => selectedIds.includes(r.id));
    if (selected.length === 0) return;
    pushHistory();
    const base = rectanglesRef.current;
    const newRects: Rectangle[] = [];
    for (const r of selected) {
      const allSoFar = [...base, ...newRects];
      newRects.push({
        ...r,
        id: `rect-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        x: r.x + 20,
        y: r.y + 20,
        name: uniqueRectName(r.name ?? r.id, allSoFar),
      });
    }
    setRectangles((prev) => [...prev, ...newRects]);
    setSelectedIds(newRects.map((r) => r.id));
  }, [selectedIds, pushHistory]);

  const handleToggleRectLocked = useCallback((id: string) => {
    pushHistory();
    setRectangles((prev) => prev.map((r) => (r.id === id ? { ...r, locked: !r.locked } : r)));
  }, [pushHistory]);

  const handleSelectRect = useCallback((id: string) => {
    setSelectedIds([id]);
    // Same "selecting a smart rect opens its panel" feedback the canvas
    // click handler already has — without this, selecting one from the
    // Layers tab gave no visible sign it was even a smart rect at all.
    const rect = rectangles.find((r) => r.id === id);
    if (rect?.mode === "smart") setSmartPanelRectId(id);
  }, [rectangles]);

  // Set by the canvas context menu's Rename item: tells the Groups panel to
  // jump straight into rename mode for this rect, instead of the caller
  // needing to reach into GroupsPanel's local editingId state directly.
  const [pendingEditRectId, setPendingEditRectId] = useState<string | null>(null);
  const clearPendingEditRectId = useCallback(() => setPendingEditRectId(null), []);

  const handleRenameFromCanvas = useCallback((rectId: string) => {
    handleSelectRect(rectId);
    setPendingEditRectId(rectId);
    dockLayoutRef.current?.updateTab("groups", null, true);
  }, [handleSelectRect]);

  const handleSelectRects = useCallback((ids: string[]) => {
    setSelectedIds(ids);
  }, []);

  // Keeps the Workflow canvas's own table-card selection (react-flow's
  // internal node.selected, local to SchemaView) mirrored into this same
  // selectedIds the Layers panel uses -- so selecting a card on the
  // canvas highlights its row in Layers (and vice versa, via the
  // `selected` passed into SchemaView's table-card nodes), and so
  // Backspace/Delete (handleKeyDown below, driven entirely by
  // selectedIds) never silently deletes a rectangle whose selection the
  // user can't actually see. Surgical add/remove (not a wholesale
  // replace) so it doesn't clobber whatever else -- guides, rects
  // selected from the Layers panel itself -- already happens to be in
  // selectedIds.
  const handleTableSelectionChange = useCallback((changes: { id: string; selected: boolean }[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      changes.forEach((c) => (c.selected ? next.add(c.id) : next.delete(c.id)));
      return Array.from(next);
    });
  }, []);

  const handleAssignRectsToGroup = useCallback((ids: string[], groupId: string | undefined) => {
    if (ids.length === 0) return;
    pushHistory();
    setRectangles((prev) => prev.map((r) => (ids.includes(r.id) ? { ...r, groupId } : r)));
  }, [pushHistory]);

  // Mirrors the reference Layers-panel's drag-and-drop reordering: dropping
  // a table onto the top/bottom edge of another row inserts it right before/
  // after that row (within whichever group or Unassigned section the target
  // lives in), instead of just merging it broadly into a group.
  const handleReorderRects = useCallback((ids: string[], targetId: string, position: "before" | "after", groupId: string | undefined) => {
    if (ids.length === 0) return;
    pushHistory();
    setRectangles((prev) => {
      const moving = prev.filter((r) => ids.includes(r.id)).map((r) => ({ ...r, groupId }));
      const rest = prev.filter((r) => !ids.includes(r.id));
      const targetIdx = rest.findIndex((r) => r.id === targetId);
      if (targetIdx === -1) return [...rest, ...moving];
      const insertIdx = position === "before" ? targetIdx : targetIdx + 1;
      return [...rest.slice(0, insertIdx), ...moving, ...rest.slice(insertIdx)];
    });
  }, [pushHistory]);

  // Dropping a table onto genuinely empty space in the Layers list (below
  // every group/row, not onto any specific row or section) — pulls it out of
  // whatever folder it was in AND moves it to the very end of the underlying
  // order, so it lands last among Unassigned rather than just wherever it
  // already sat in the array.
  const handleMoveRectsToRootEnd = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    pushHistory();
    setRectangles((prev) => {
      const moving = prev.filter((r) => ids.includes(r.id)).map((r) => ({ ...r, groupId: undefined }));
      const rest = prev.filter((r) => !ids.includes(r.id));
      return [...rest, ...moving];
    });
  }, [pushHistory]);

  // Commits a rect rename to real state -- called once, when the rename
  // actually finishes (GroupsPanel's finalizeRectName, itself fired from
  // blur/Enter/Tab), not per keystroke. GroupsPanel keeps the live-typed
  // value in its own local renameDraft state while editing (cheap, no
  // re-render outside that one row) and only calls this once with the
  // final, de-duplicated name -- this used to run on every keystroke
  // instead, which re-rendered everything reading `rectangles` (the whole
  // Workflow canvas among them) on every character typed.
  //
  // Renaming used to also have to migrate edges/convertedTables/
  // schemaPreviewTables, all three previously keyed by the table's own
  // *name* -- any rename changed a table's Workflow-canvas identity out
  // from under everything pointing at it (grey/disconnected cards, a
  // rename-while-typing flicker, cards losing their group-box nesting
  // mid-edit). Fixed at the root instead: every one of those is now keyed
  // by the rectangle's own stable `id` (see SchemaPreviewTable.rectId's
  // comment, and SchemaView.tsx's tableEntries), which a rename never
  // touches -- so a rename is back to being just what it looks like: a
  // label edit, nothing else needs to react to it.
  const handleRenameRect = useCallback((id: string, name: string) => {
    // Guides associate to a rect by name (Guide.rectName), not a stable id
    // (see the filters that key column guides off `rectName` further up in
    // this file) -- without this, renaming a rect left every guide that
    // followed its old name stranded, matching nothing.
    const oldRect = rectanglesRef.current.find((r) => r.id === id);
    const oldName = oldRect?.name ?? oldRect?.id;
    setRectangles((prev) => prev.map((r) => (r.id === id ? { ...r, name } : r)));
    if (oldName !== undefined && oldName !== name) {
      setGuides((prev) => prev.map((g) => (g.rectName === oldName ? { ...g, rectName: name } : g)));
    }
  }, []);

  // Schema Preview card/group-box drag persistence -- written on drag-stop
  // or an align/distribute action (see SchemaView.tsx). This is also the
  // source of truth computeAnnotationData ranks against for outputSlot
  // assignment (top-to-bottom order), so a table/group that's never been
  // positioned in Schema simply has schemaX/schemaY left undefined.
  const handleUpdateSchemaTablePosition = useCallback((rectId: string, x: number, y: number) => {
    setRectangles((prev) => prev.map((r) => (r.id === rectId ? { ...r, schemaX: x, schemaY: y } : r)));
  }, []);
  const handleUpdateSchemaGroupPosition = useCallback((groupId: string, x: number, y: number) => {
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, schemaX: x, schemaY: y } : g)));
  }, []);

  // Double-click a column name on a Schema/Workflow table card -- keyed by
  // the ORIGINAL extracted column name so a second rename overwrites
  // rather than orphans the entry. Clearing back to the original name (or
  // to blank) removes the override instead of storing a no-op rename.
  //
  // A rename is just a header string -- it used to only update this
  // display-only map, leaving every downstream node reading the OLD name
  // out of `convertedTables` until a full re-Convert round-tripped through
  // the Python backend just to relabel a column. Now it also patches the
  // already-converted table's `columns` array directly (by position,
  // found via the stable/never-renamed schemaPreviewTables order -- the
  // convertedTables entry itself may already carry an earlier rename at
  // that slot, so searching it for `originalCol` would fail on a second
  // rename of the same column), so every node fed by this table sees the
  // new name immediately, with no Convert needed.
  const handleRenameSchemaColumn = useCallback((rectId: string, originalCol: string, newName: string) => {
    const trimmed = newName.trim();
    setRectangles((prev) => prev.map((r) => {
      if (r.id !== rectId) return r;
      const nextRenames = { ...(r.columnRenames ?? {}) };
      if (!trimmed || trimmed === originalCol) {
        delete nextRenames[originalCol];
      } else {
        nextRenames[originalCol] = trimmed;
      }
      return { ...r, columnRenames: Object.keys(nextRenames).length > 0 ? nextRenames : undefined };
    }));
    const finalName = trimmed || originalCol;
    // convertedTables is keyed by rectId (see TableData.rectId's comment),
    // so no name lookup needed for that part -- only schemaPreviewTables
    // still needs matching (by rectId, not name) to find which column
    // index this rename applies to.
    const originalIndex = schemaPreviewTables?.find((t) => t.rectId === rectId)?.columns.indexOf(originalCol);
    if (originalIndex === undefined || originalIndex === -1) return;
    setConvertedTables((prev) => {
      const existing = prev[rectId];
      if (!existing || existing.columns[originalIndex] === finalName) return prev;
      const nextColumns = [...existing.columns];
      nextColumns[originalIndex] = finalName;
      return { ...prev, [rectId]: { ...existing, columns: nextColumns } };
    });
  }, [schemaPreviewTables]);

  // Adds a new processor-node instance to the Schema Preview canvas, from
  // either a drop (real drop position, in flow coordinates) or a click on
  // its Nodes-panel tile (no position -- falls back to a simple cascading
  // grid so repeated clicks don't stack every instance on top of each other).
  // Returns the new node's id synchronously (computed before the state
  // update, not read back from it) so a caller can immediately wire an
  // edge to it -- see SchemaView.tsx's connection-drag-to-empty-canvas
  // flow, which creates the node and connects the in-progress connection
  // to it in one action, KNIME-style.
  const handleAddProcessorNode = useCallback(
    (entry: { name: string; icon: string; color: string; hasOutput?: boolean; hasExtraInput?: boolean }, position?: { x: number; y: number }): string => {
      const id = `proc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setProcessorNodes((prev) => {
        const pos = position ?? { x: 520 + (prev.length % 4) * 170, y: 40 + Math.floor(prev.length / 4) * 150 };
        const instance: ProcessorNodeInstance = {
          id,
          catalogName: entry.name,
          icon: entry.icon,
          color: entry.color,
          hasOutput: entry.hasOutput,
          hasExtraInput: entry.hasExtraInput,
          x: pos.x,
          y: pos.y,
        };
        return [...prev, instance];
      });
      return id;
    },
    [],
  );
  const handleUpdateProcessorNodePosition = useCallback((id: string, x: number, y: number) => {
    setProcessorNodes((prev) => prev.map((p) => (p.id === id ? { ...p, x, y } : p)));
  }, []);
  const handleDeleteProcessorNodes = useCallback((ids: string[]) => {
    // Also drops any edge attached to a deleted node, and closes that
    // node's Configure/Browse window if one happens to be open -- folded
    // in here (rather than left for each call site to remember
    // separately) since every caller that deletes processor nodes wants
    // both. Without the window close, deleting a node whose window was
    // open just left it sitting there showing a now-nonexistent node.
    setEdges((eds) => eds.filter((e) => !ids.includes(e.source) && !ids.includes(e.target)));
    setProcessorNodes((prev) => prev.filter((p) => !ids.includes(p.id)));
    ids.forEach((id) => window.alteraStudio.notifyNodeDeleted(id));
  }, []);
  const handleRenameProcessorNode = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    setProcessorNodes((prev) => prev.map((p) => (p.id === id ? { ...p, name: trimmed || undefined } : p)));
  }, []);
  const handleUpdateProcessorNodeDescription = useCallback((id: string, description: string) => {
    const trimmed = description.trim();
    setProcessorNodes((prev) => prev.map((p) => (p.id === id ? { ...p, description: trimmed || undefined } : p)));
  }, []);
  // Applied from a node's Configure window (FilterBuilderWindow.tsx) -- a
  // real separate native window, same pattern as Settings, not an in-page
  // dialog (see the onFilterBuilderApplied effect below for the IPC side
  // of this). Generic bag, not filter-specific, so future configurable
  // nodes reuse this same handler. Already covered by
  // buildProjectData/project-open (both persist the full processorNodes
  // array), so no extra plumbing is needed for params to save/restore
  // with the rest of the project.
  const handleUpdateProcessorNodeParams = useCallback((id: string, params: Record<string, unknown>) => {
    setProcessorNodes((prev) => prev.map((p) => (p.id === id ? { ...p, params } : p)));
  }, []);
  useEffect(() => {
    return window.alteraStudio.onFilterBuilderApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);
  useEffect(() => {
    return window.alteraStudio.onHeaderPromoterApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);
  useEffect(() => {
    return window.alteraStudio.onMergeApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);
  useEffect(() => {
    return window.alteraStudio.onShiftColumnsApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);
  useEffect(() => {
    return window.alteraStudio.onCleanerApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);
  useEffect(() => {
    return window.alteraStudio.onUniqueApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);
  useEffect(() => {
    return window.alteraStudio.onColumnEditApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);
  useEffect(() => {
    return window.alteraStudio.onChangeTypeApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);
  useEffect(() => {
    return window.alteraStudio.onRegexApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);
  useEffect(() => {
    return window.alteraStudio.onCascadeFillApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);
  useEffect(() => {
    return window.alteraStudio.onExportApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);
  useEffect(() => {
    return window.alteraStudio.onUnpivotColumnsApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);
  useEffect(() => {
    return window.alteraStudio.onPivotColumnsApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);
  useEffect(() => {
    return window.alteraStudio.onAddColumnApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);
  useEffect(() => {
    return window.alteraStudio.onConditionalColumnApplied(({ nodeId, params }) => {
      handleUpdateProcessorNodeParams(nodeId, params as unknown as Record<string, unknown>);
    });
  }, [handleUpdateProcessorNodeParams]);

  // Workflow-canvas edges -- see the `edges` state comment above for why
  // these live here now instead of as local SchemaView state.
  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);
  // Enforces each node type's input-port cardinality (see nodeCatalog.ts's
  // getInputPortMax/mainInputMax) -- the one general place this rule
  // applies, shared by both ways an edge can land on a target handle:
  // a brand new connection (handleConnect) and dragging an EXISTING
  // edge's endpoint onto a new target (handleReconnect, below) --
  // otherwise reconnect would bypass the cap entirely via its own
  // separate xyflow code path. When the target handle is already at its
  // cap, landing a new edge there REPLACES the oldest one(s) already
  // occupying it instead of xyflow's default of just adding another
  // (which the node's transform would never look at -- e.g. Filter
  // Builder's dfs[0]/dfs[1] convention would silently misread a second
  // main-input table as the Extra Data table). Uncapped ports (max
  // undefined, e.g. Horizontal Stack's main input) are untouched.
  // `excludeEdgeId` is the edge being reconnected itself, if any -- it
  // shouldn't count against its own port's occupancy while it's mid-move.
  const withinInputCap = useCallback((eds: Edge[], connection: Connection, excludeEdgeId?: string): Edge[] => {
    const targetProc = processorNodes.find((p) => p.id === connection.target);
    const max = targetProc ? getInputPortMax(targetProc.catalogName, connection.targetHandle) : undefined;
    if (max === undefined) return eds;
    const atThisPort = eds.filter(
      (e) => e.id !== excludeEdgeId && e.target === connection.target && (e.targetHandle ?? null) === (connection.targetHandle ?? null),
    );
    const overflow = atThisPort.length - max + 1;
    if (overflow <= 0) return eds;
    const toRemove = new Set(atThisPort.slice(0, overflow).map((e) => e.id));
    return eds.filter((e) => !toRemove.has(e.id));
  }, [processorNodes]);
  const handleConnect = useCallback((connection: Connection) => {
    setEdges((eds) => addEdge({ ...connection, type: "deletableEdge" }, withinInputCap(eds, connection)));
  }, [withinInputCap]);
  // Removes one edge by its own id -- the DeletableEdge "x" button (see
  // EdgeDeleteContext in SchemaView.tsx).
  const handleDeleteEdge = useCallback((edgeId: string) => {
    setEdges((eds) => eds.filter((e) => e.id !== edgeId));
  }, []);

  // Native xyflow drag-to-reconnect/drag-off-to-delete, alongside the
  // existing X-button (a second, more KNIME/n8n-familiar way to remove a
  // connection: grab either end and drag it onto empty canvas). Pattern
  // is xyflow's own documented one (reactflow.dev/examples/edges/
  // delete-edge-on-drop): onReconnectStart marks the drag as "not yet
  // successful," onReconnect flips that back to true only when it lands
  // on a real target, and onReconnectEnd deletes the edge if the flag
  // never flipped -- i.e. it was dropped on empty space.
  const edgeReconnectSuccessfulRef = useRef(true);
  const handleReconnectStart = useCallback(() => {
    edgeReconnectSuccessfulRef.current = false;
  }, []);
  const handleReconnect = useCallback((oldEdge: Edge, newConnection: Connection) => {
    edgeReconnectSuccessfulRef.current = true;
    setEdges((eds) => reconnectEdge(oldEdge, newConnection, withinInputCap(eds, newConnection, oldEdge.id)));
  }, [withinInputCap]);
  const handleReconnectEnd = useCallback((_event: unknown, edge: Edge) => {
    if (!edgeReconnectSuccessfulRef.current) {
      setEdges((eds) => eds.filter((e) => e.id !== edge.id));
    }
    edgeReconnectSuccessfulRef.current = true;
  }, []);

  const handleChangeRectsOpacity = useCallback((ids: string[], alpha: number) => {
    if (ids.length === 0) return;
    pushHistory();
    setRectangles((prev) => prev.map((r) => (ids.includes(r.id) ? { ...r, fill: fillWithAlpha(r.fill, alpha) } : r)));
  }, [pushHistory]);

  const handleToggleRectsLocked = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    pushHistory();
    // ids can be a mix of rect and guide ids (e.g. selectedIds passed
    // straight through) — .every() on the type that has none of these ids
    // vacuously returns true, so this still resolves correctly whether the
    // selection is rects-only, guides-only, or mixed.
    const allLocked =
      rectangles.filter((r) => ids.includes(r.id)).every((r) => r.locked) &&
      guides.filter((g) => ids.includes(g.id)).every((g) => g.locked);
    setRectangles((prev) => prev.map((r) => (ids.includes(r.id) ? { ...r, locked: !allLocked } : r)));
    setGuides((prev) => prev.map((g) => (ids.includes(g.id) ? { ...g, locked: !allLocked } : g)));
  }, [pushHistory, rectangles, guides]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    pushHistory();
    setRectangles((prev) => prev.filter((r) => !selectedIds.includes(r.id) || r.locked));
    setGuides((prev) => prev.filter((g) => !selectedIds.includes(g.id) || g.locked));
    setSelectedIds((prev) => prev.filter((id) => {
      const rect = rectangles.find(r => r.id === id);
      if (rect?.locked) return true;
      const guide = guides.find(g => g.id === id);
      if (guide?.locked) return true;
      return false;
    }));
  }, [selectedIds, rectangles, guides, pushHistory]);

  // Edit menu's Cut -- copy then delete, same as any other app's cut.
  const handleCutSelected = useCallback(() => {
    handleCopySelected();
    handleDeleteSelected();
  }, [handleCopySelected, handleDeleteSelected]);

  const handleAddGroup = useCallback(() => {
    const id = `group-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    groupCounterRef.current += 1;
    setGroups((prev) => [...prev, { id, name: `Group_${groupCounterRef.current}` }]);
  }, []);

  const handleRenameGroup = useCallback((id: string, name: string) => {
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, name } : g)));
  }, []);

  const handleToggleGroupHidden = useCallback((id: string) => {
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, hidden: !g.hidden } : g)));
  }, []);

  const handleToggleRectHidden = useCallback((id: string) => {
    // About to hide it — drop it from selection too, so per-selection UI
    // (canvas popup toolbar, transform handles) doesn't linger on something
    // that's no longer visible.
    const target = rectangles.find((r) => r.id === id);
    if (target && !target.hidden) {
      setSelectedIds((prev) => prev.filter((sid) => sid !== id));
    }
    setRectangles((prev) => prev.map((r) => (r.id === id ? { ...r, hidden: !r.hidden } : r)));
  }, [rectangles]);

  const handleToggleGuideHidden = useCallback((id: string) => {
    const target = guides.find((g) => g.id === id);
    if (!target) return;
    // Global guides (no rectName) don't appear anywhere in the Layers tab
    // — nothing to nest them under — so hiding one would leave no row
    // anywhere to click its eye back on. Block it at the source instead of
    // relying on every call site to remember the rule.
    if (!target.rectName && !target.hidden) return;
    if (!target.hidden) {
      setSelectedIds((prev) => prev.filter((sid) => sid !== id));
    }
    setGuides((prev) => prev.map((g) => (g.id === id ? { ...g, hidden: !g.hidden } : g)));
  }, [guides]);

  const handleToggleGuideLocked = useCallback((id: string) => {
    pushHistory();
    setGuides((prev) => prev.map((g) => (g.id === id ? { ...g, locked: !g.locked } : g)));
  }, [pushHistory]);

  const handleDeleteGroup = useCallback(
    (id: string) => {
      // Deleting a (top-level) folder also deletes any subfolder nested
      // inside it, along with all of their member tables.
      const childGroupIds = groups.filter((g) => g.parentId === id).map((g) => g.id);
      const allGroupIds = [id, ...childGroupIds];
      const members = rectangles.filter((r) => r.groupId && allGroupIds.includes(r.groupId));
      const memberIds = members.map((r) => r.id);
      pushHistory();
      setRectangles((prev) => prev.filter((r) => !memberIds.includes(r.id)));
      setSelectedIds((prev) => prev.filter((sid) => !memberIds.includes(sid)));
      setGroups((prev) => prev.filter((g) => !allGroupIds.includes(g.id)));
    },
    [rectangles, groups, pushHistory],
  );

  const handleDuplicateGroup = useCallback((id: string) => {
    const original = groups.find((g) => g.id === id);
    if (!original) return;
    pushHistory();
    const newGroupId = `group-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Cascade to subfolders too (only top-level groups can have any, by the
    // one-level-of-nesting invariant), so duplicating a folder doesn't
    // silently drop what's nested inside it.
    const childGroups = original.parentId ? [] : groups.filter((g) => g.parentId === id);
    const childIdMap = new Map(
      childGroups.map((g) => [g.id, `group-${Date.now()}-${Math.random().toString(36).slice(2)}-${g.id}`]),
    );
    const newGroups = [
      { ...original, id: newGroupId, name: `${original.name} copy` },
      ...childGroups.map((g) => ({ ...g, id: childIdMap.get(g.id)!, parentId: newGroupId })),
    ];
    setGroups((prev) => [...prev, ...newGroups]);

    const groupIdsToClone = [id, ...childGroups.map((g) => g.id)];
    const members = rectanglesRef.current.filter((r) => r.groupId && groupIdsToClone.includes(r.groupId));
    if (members.length > 0) {
      const base = rectanglesRef.current;
      const newRects: Rectangle[] = [];
      members.forEach((r, i) => {
        const allSoFar = [...base, ...newRects];
        newRects.push({
          ...r,
          id: `rect-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
          groupId: r.groupId === id ? newGroupId : (childIdMap.get(r.groupId as string) ?? newGroupId),
          x: r.x + 20,
          y: r.y + 20,
          name: uniqueRectName(r.name ?? r.id, allSoFar),
        });
      });
      setRectangles((prev) => [...prev, ...newRects]);
    }
  }, [groups, pushHistory]);

  // Drag-reorder for folders, mirroring handleReorderRects: dropping on the
  // top/bottom edge of another folder row inserts before/after it. `parentId`
  // is the target row's own parent, so dropping near a top-level folder keeps
  // the moved folder top-level, and dropping near a nested subfolder keeps it
  // nested under that same parent — which doubles as how a folder gets
  // nested or un-nested by drag alone, not just the dedicated handlers below.
  // Both invariants (max one level of nesting) are re-checked here too, since
  // this path can also change parentId.
  const handleReorderGroups = useCallback(
    (groupId: string, targetId: string, position: "before" | "after", parentId: string | undefined) => {
      if (groupId === targetId) return;
      pushHistory();
      setGroups((prev) => {
        const moving = prev.find((g) => g.id === groupId);
        if (!moving) return prev;
        const hasChildren = prev.some((g) => g.parentId === groupId);
        const targetParent = parentId ? prev.find((g) => g.id === parentId) : undefined;
        const effectiveParentId = !hasChildren && (!targetParent || !targetParent.parentId) ? parentId : undefined;
        const movingUpdated = { ...moving, parentId: effectiveParentId };
        const rest = prev.filter((g) => g.id !== groupId);
        const targetIdx = rest.findIndex((g) => g.id === targetId);
        if (targetIdx === -1) return [...rest, movingUpdated];
        const insertIdx = position === "before" ? targetIdx : targetIdx + 1;
        return [...rest.slice(0, insertIdx), movingUpdated, ...rest.slice(insertIdx)];
      });
    },
    [pushHistory],
  );

  // Dropping a folder directly onto another folder's header nests it inside
  // that folder. Blocked (silent no-op) if the target is itself already
  // nested, or if the folder being moved has children of its own — either
  // case would create more than one level of nesting.
  const handleNestGroup = useCallback((groupId: string, parentId: string) => {
    if (groupId === parentId) return;
    pushHistory();
    setGroups((prev) => {
      const parent = prev.find((g) => g.id === parentId);
      const hasChildren = prev.some((g) => g.parentId === groupId);
      if (!parent || parent.parentId || hasChildren) return prev;
      return prev.map((g) => (g.id === groupId ? { ...g, parentId } : g));
    });
  }, [pushHistory]);

  // Dropping a nested folder onto the top-level root area un-nests it back
  // to a top-level folder.
  const handleUnnestGroup = useCallback((groupId: string) => {
    pushHistory();
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, parentId: undefined } : g)));
  }, [pushHistory]);

  const handleToggleSmartMode = useCallback(
    (rectId: string) => {
      const rect = rectangles.find((r) => r.id === rectId);
      const wasSmart = rect?.mode === "smart";
      pushHistory();
      setRectangles((prev) =>
        prev.map((r) => {
          if (r.id !== rectId) return r;
          return wasSmart
            ? { ...r, mode: "free", smartConfig: undefined, smartPageData: undefined }
            : { ...r, mode: "smart", smartConfig: r.smartConfig ?? { ...DEFAULT_SMART_CONFIG } };
        }),
      );
      setSmartPanelRectId(wasSmart ? null : rectId);
    },
    [rectangles, pushHistory],
  );

  // Batch version for the right-click context menu: converts the whole
  // current selection uniformly, the same "compute an overall state, then
  // set everyone to the opposite" pattern as handleToggleRectsLocked — not a
  // per-rect toggle, since a mixed-mode selection has no well-defined
  // individual toggle result.
  const handleToggleRectsMode = useCallback(
    (ids: string[], focusRectId?: string) => {
      if (ids.length === 0) return;
      pushHistory();
      const allSmart = rectangles.filter((r) => ids.includes(r.id)).every((r) => r.mode === "smart");
      setRectangles((prev) =>
        prev.map((r) => {
          if (!ids.includes(r.id)) return r;
          return allSmart
            ? { ...r, mode: "free", smartConfig: undefined, smartPageData: undefined }
            : { ...r, mode: "smart", smartConfig: r.smartConfig ?? { ...DEFAULT_SMART_CONFIG } };
        }),
      );
      if (allSmart) {
        // Converting away from smart: close the panel if it was showing one
        // of these rects.
        setSmartPanelRectId((prevId) => (prevId && ids.includes(prevId) ? null : prevId));
      } else if (focusRectId && ids.includes(focusRectId)) {
        // Converting to smart, with a specific rect the caller wants
        // focused (e.g. the one just right-clicked) — select it and open
        // its panel, instead of leaving no visible sign the conversion did
        // anything. Auto-opening for the whole selection wouldn't make
        // sense (no single target to show), so this only fires when the
        // caller names one.
        setSelectedIds([focusRectId]);
        setSmartPanelRectId(focusRectId);
      }
    },
    [rectangles, pushHistory],
  );

  const handleUpdateSmartConfig = useCallback((rectId: string, cfg: SmartConfig) => {
    setRectangles((prev) =>
      prev.map((r) => {
        if (r.id !== rectId) return r;
        if (r.smartRawData && Object.keys(r.smartRawData).length > 0) {
          const applied = applyKeywordRules(r.smartRawData, cfg.keywordSettings ?? {});
          const entry = applied[String(pageNum)];
          const ub = entry?.union_bbox;
          return ub
            ? { ...r, smartConfig: cfg, smartPageData: applied, x: ub[0], y: ub[1], width: ub[2] - ub[0], height: ub[3] - ub[1] }
            : { ...r, smartConfig: cfg, smartPageData: applied };
        }
        return { ...r, smartConfig: cfg };
      }),
    );
  }, [pageNum]);

  const handleRunSmart = useCallback(
    (rectId: string) => {
      if (!bridge || !isReady) { alert("Bridge not ready"); return; }
      const rect = rectangles.find((r) => r.id === rectId);
      const cfg  = rect?.smartConfig;
      if (!cfg || cfg.keywords.length === 0) return;
      setSmartRunning((prev) => ({ ...prev, [rectId]: true }));
      bridge.findKeywords(JSON.stringify({ rectId, keywords: cfg.keywords, caseSensitive: true }));
    },
    [bridge, isReady, rectangles],
  );

  // Stable callbacks for SmartPanel — prevent re-renders during canvas panning
  const handleSmartClose = useCallback(() => setSmartPanelRectId(null), []);
  const handleSmartConfigChange = useCallback(
    (cfg: SmartConfig) => { if (smartPanelRectId) handleUpdateSmartConfig(smartPanelRectId, cfg); },
    [smartPanelRectId, handleUpdateSmartConfig],
  );
  const handleSmartRun = useCallback(
    () => { if (smartPanelRectId) handleRunSmart(smartPanelRectId); },
    [smartPanelRectId, handleRunSmart],
  );

  useEffect(() => { rectanglesRef.current = rectangles; }, [rectangles]);
  useEffect(() => { guidesRef.current = guides; }, [guides]);
  useEffect(() => { handleRunSmartRef.current = handleRunSmart; }, [handleRunSmart]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Single-letter tool hotkeys (v/h/d/r/g/t/s/...) below only guarded
      // against <input> -- typing into a <textarea> (e.g. a processor
      // node's description) or a contentEditable element hit the same
      // hotkeys instead of producing the typed character (reported: typing
      // "t" while writing a description toggled column-name labels instead
      // of inserting the letter).
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) return;

      // Tab switches Canvas <-> Workflow -- deliberately checked here, not
      // in GroupsPanel's own rename-input Tab handler, since the guard
      // above already bails out of this whole handler while any input/
      // textarea/contentEditable has focus. That means Tab keeps its other
      // job (jump to the next layer while renaming, see GroupsPanel's
      // handleRenameKeyDown) for free -- that handler runs first (the
      // rename <input> is below this window-level listener in the bubble
      // order) and this one never even sees the keydown while it's active.
      if (e.key === "Tab") {
        e.preventDefault();
        setShowSchema((v) => !v);
        return;
      }

      if (e.code === "Space" && !spacePressed && activeTool !== "hand" && !showSchema) {
        e.preventDefault();
        setSpacePressed(true);
      }

      if (e.key === "v" || e.key === "V") {
        e.preventDefault();
        setActiveTool("select");
      }
      if ((e.key === "h" || e.key === "H") && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setActiveTool("hand");
      }
      if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        setActiveTool("rectangle");
      }
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        setActiveTool("region");
      }
      if (e.key === "g" || e.key === "G") {
        e.preventDefault();
        if (rectangles.length > 0) setActiveTool("guide");
      }
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        setShowLabels((prev) => !prev);
      }
      // Plain S toggles Sample Mode -- guarded against Ctrl/Meta so Ctrl+S
      // (Save, see the menu bar) doesn't also flip this as a side effect.
      if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setSampleConfig((c) => ({ ...c, enabled: !c.enabled }));
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (e.shiftKey) handleSaveProjectAs();
        else handleSaveProject();
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        if (activeTool === "select") {
          const allIds = [
            ...rectangles.map((r) => r.id),
            ...guides.map((g) => g.id),
          ];
          setSelectedIds(allIds);
        }
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        handleZoomIn();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "-") {
        e.preventDefault();
        handleZoomOut();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        handleFitPage(); // Changed from handleResetZoom
      }
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedIds.length > 0
      ) {
        e.preventDefault();
        handleDeleteSelected();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleConvert();
      }
      if (e.key === "Escape") {
        setCtxMenu(null);
        setSelectedIds([]);
        setShowPageInput(false);
        if (activeTool === "rectangle" || activeTool === "guide") {
          setActiveTool("select");
        }
      }
      if (e.key === "Enter" && showPageInput) {
        handleGoToPage();
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrevPage();
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        handleNextPage();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
        if (selectedIds.length > 0) {
          e.preventDefault();
          handleCopySelected();
        }
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "x" || e.key === "X")) {
        if (selectedIds.length > 0) {
          e.preventDefault();
          handleCutSelected();
        }
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) {
        if (clipboardRef.current.length > 0) {
          e.preventDefault();
          handlePasteSelected();
        }
      }
      // Ctrl+Z undoes; Ctrl+Shift+Z or Ctrl+Y redoes (both bound -- Shift+Z
      // is the Photoshop/Figma convention, Y is the classic Windows one).
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        handleRedo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        pushHistory();
        setRectangles((prev) => prev.map((r) =>
          selectedIds.includes(r.id) ? { ...r, locked: !r.locked } : r
        ));
        setGuides((prev) => prev.map((g) =>
          selectedIds.includes(g.id) ? { ...g, locked: !g.locked } : g
        ));
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "h" || e.key === "H") && selectedIds.length > 0) {
        e.preventDefault();
        pushHistory();
        // Each selected item's own hidden flag flips independently (same
        // per-item toggle style as Ctrl+L above), then anything that just
        // became hidden also drops out of the selection — same reasoning as
        // the Layers tab's eye icon: no lingering canvas popup/transform
        // handles pointing at something no longer visible.
        const newlyHiddenIds = new Set<string>();
        rectangles.forEach((r) => { if (selectedIds.includes(r.id) && !r.hidden) newlyHiddenIds.add(r.id); });
        // Global guides (no rectName) can't be hidden — see
        // handleToggleGuideHidden's comment — so they're skipped here too.
        guides.forEach((g) => { if (selectedIds.includes(g.id) && !g.hidden && g.rectName) newlyHiddenIds.add(g.id); });
        setRectangles((prev) => prev.map((r) =>
          selectedIds.includes(r.id) ? { ...r, hidden: !r.hidden } : r
        ));
        setGuides((prev) => prev.map((g) => {
          if (!selectedIds.includes(g.id)) return g;
          if (!g.rectName && !g.hidden) return g;
          return { ...g, hidden: !g.hidden };
        }));
        if (newlyHiddenIds.size > 0) {
          setSelectedIds((prev) => prev.filter((id) => !newlyHiddenIds.has(id)));
        }
      }
      if ((e.key === "c" || e.key === "C") && activeTool === "guide") {
        e.preventDefault();
        setGuideColor((prev) => {
          const rectNames = [...new Set(rectanglesRef.current.map((r) => r.name ?? r.id))];
          if (rectNames.length === 0) return prev;
          const cycle = ["__global__", ...rectNames];
          const idx = cycle.indexOf(prev);
          const next = cycle[(idx + 1) % cycle.length];
          setGuides((gs) =>
            gs.map((g) => {
              if (!selectedIds.includes(g.id)) return g;
              if (next === "__global__") return { ...g, color: "#000000", rectName: undefined };
              const assocRect = rectanglesRef.current.find((r) => (r.name ?? r.id) === next);
              return { ...g, color: assocRect?.stroke ?? g.color, rectName: next };
            }),
          );
          return next;
        });
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setSpacePressed(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [
    [
      spacePressed,
      activeTool,
      showSchema,
      selectedIds,
      rectangles,
      guides,
      showPageInput,
      handleZoomIn,
      handleZoomOut,
      handleFitPage,
      handleDeleteSelected,
      handleCopySelected,
      handleGoToPage,
      pushHistory,
      handleUndo,
      handleRedo,
      handlePasteSelected,
      handleCutSelected,
      handleSaveProject,
      handleSaveProjectAs,
    ],
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // Plain wheel zooms directly -- no Ctrl/Meta needed.
      e.preventDefault();

      const stage = stageRef.current;
      if (!stage) return;

      const oldScale = scale;
      const pointerPos = stage.getPointerPosition();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      const newScale = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, oldScale + delta),
      );

      const mousePointTo = {
        x: (pointerPos.x - stagePos.x) / oldScale,
        y: (pointerPos.y - stagePos.y) / oldScale,
      };

      const newPos = {
        x: pointerPos.x - mousePointTo.x * newScale,
        y: pointerPos.y - mousePointTo.y * newScale,
      };

      setScale(newScale);
      setStagePos(newPos);
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [scale, stagePos]);

  const getCanvasPointerPos = useCallback((): { x: number; y: number } | null => {
    const pos = stageRef.current?.getPointerPosition();
    if (!pos) return null;
    return { x: (pos.x - stagePos.x) / scale, y: (pos.y - stagePos.y) / scale };
  }, [stagePos, scale]);

  const handleStageMouseDown = (e: any) => {
    if (ctxMenu) { setCtxMenu(null); return; }
    const clickedOnEmpty =
      e.target === e.target.getStage() || e.target.id() === "page-bg";

    if (activeTool === "hand" || spacePressed) {
      if (e.evt.button === 0) {
        setIsPanning(true);
        const stage = e.target.getStage();
        lastPointerPositionRef.current = stage.getPointerPosition();
      }
      return;
    }

    if (e.evt.button === 1) {
      e.evt.preventDefault();
      setIsPanning(true);
      const stage = e.target.getStage();
      lastPointerPositionRef.current = stage.getPointerPosition();
      return;
    }

    if (activeTool === "rectangle" && clickedOnEmpty && e.evt.button === 0) {
      const pos = getCanvasPointerPos();
      if (!pos) return;
      const { fill } = pickNextColor(rectangles.map(r => r.fill));
      setIsDrawing(true);
      setNewRect({ x: pos.x, y: pos.y });
      setDrawingColor(fill);
      return;
    }

    if (activeTool === "select" && clickedOnEmpty && e.evt.button === 0) {
      if (!e.evt.ctrlKey && !e.evt.metaKey) {
        setSelectedIds([]);
        const pos = getCanvasPointerPos();
        if (!pos) return;
        setIsMarqueeSelecting(true);
        setMarqueeStart({ x: pos.x, y: pos.y });
        setMarqueeEnd({ x: pos.x, y: pos.y });
      }
      return;
    }

    if (activeTool === "guide" && clickedOnEmpty) {
      const pos = getCanvasPointerPos();
      if (pos) {
        pushHistory();
        const { x, y } = pos;
        if (guideColor === "__global__") {
          setGuides((prev) => [
            ...prev,
            { id: Date.now().toString(), x, y, color: "#000000", rectName: undefined },
          ]);
        } else {
          const assocRect = rectangles.find(r => (r.name ?? r.id) === guideColor);
          setGuides((prev) => [
            ...prev,
            { id: Date.now().toString(), x, y, color: assocRect?.stroke ?? "#000000", rectName: guideColor },
          ]);
        }
        setPreviewGuideX(null);
      }
      return;
    }
  };

  const handleStageMouseMove = (e: any) => {
    if (isPanning) {
      const stage = e.target.getStage();
      const pos = stage.getPointerPosition();
      const dx = pos.x - lastPointerPositionRef.current.x;
      const dy = pos.y - lastPointerPositionRef.current.y;

      setStagePos((prev) => ({
        x: prev.x + dx,
        y: prev.y + dy,
      }));

      lastPointerPositionRef.current = pos;
      return;
    }

    if (isMarqueeSelecting && marqueeStart) {
      const pos = getCanvasPointerPos();
      if (!pos) return;
      setMarqueeEnd({ x: pos.x, y: pos.y });
      return;
    }

    if (isDrawing && newRect && drawingColor && activeTool === "rectangle") {
      const pos = getCanvasPointerPos();
      if (!pos) return;
      const { x: canvasX, y: canvasY } = pos;

      const width = canvasX - newRect.x;
      const height = canvasY - newRect.y;

      setRectangles((prev) => {
        const filtered = prev.filter((r) => r.id !== "temp-rect");
        return [
          ...filtered,
          {
            id: "temp-rect",
            x: width < 0 ? canvasX : newRect.x,
            y: height < 0 ? canvasY : newRect.y,
            width: Math.abs(width),
            height: Math.abs(height),
            fill: drawingColor,
            stroke: hexToFillStroke(fillToHex(drawingColor)).stroke,
          },
        ];
      });
    }

    if (activeTool === "guide" && !isPanning) {
      const pos = getCanvasPointerPos();
      if (pos) setPreviewGuideX(pos.x);
      return;
    }
  };

  // A hidden rect (directly, or via a hidden ancestor group) isn't rendered
  // on the canvas at all, so a single click already can't hit it — but the
  // marquee below tests raw coordinates, not actual shapes, so without this
  // check it could still scoop up something the user can't even see.
  const isRectEffectivelyHidden = (rect: Rectangle): boolean => {
    if (rect.hidden) return true;
    if (!rect.groupId) return false;
    let g = groups.find((gr) => gr.id === rect.groupId);
    while (g) {
      if (g.hidden) return true;
      g = g.parentId ? groups.find((gr) => gr.id === g!.parentId) : undefined;
    }
    return false;
  };

  const handleStageMouseUp = () => {
    if (isPanning) {
      setIsPanning(false);
      return;
    }

    if (isMarqueeSelecting && marqueeStart && marqueeEnd) {
      const minX = Math.min(marqueeStart.x, marqueeEnd.x);
      const maxX = Math.max(marqueeStart.x, marqueeEnd.x);
      const minY = Math.min(marqueeStart.y, marqueeEnd.y);
      const maxY = Math.max(marqueeStart.y, marqueeEnd.y);

      const selectedRectIds = rectangles
        .filter((rect) => {
          if (isRectEffectivelyHidden(rect)) return false;
          const rectCenterX = rect.x + rect.width / 2;
          const rectCenterY = rect.y + rect.height / 2;
          return (
            rectCenterX >= minX &&
            rectCenterX <= maxX &&
            rectCenterY >= minY &&
            rectCenterY <= maxY
          );
        })
        .map((r) => r.id);

      const selectedGuideIds = guides
        .filter((guide) => {
          if (guide.hidden) return false;
          return (
            guide.x >= minX &&
            guide.x <= maxX &&
            guide.y >= minY &&
            guide.y <= maxY
          );
        })
        .map((g) => g.id);

      setSelectedIds([...selectedRectIds, ...selectedGuideIds]);
      setIsMarqueeSelecting(false);
      setMarqueeStart(null);
      setMarqueeEnd(null);
      return;
    }

    if (isDrawing && newRect && drawingColor) {
      const tempRect = rectangles.find((r) => r.id === "temp-rect");
      if (tempRect && tempRect.width > 5 && tempRect.height > 5) {
        pushHistory(rectanglesRef.current.filter((r) => r.id !== "temp-rect"));
        setRectangles((prev) => {
          const filtered = prev.filter((r) => r.id !== "temp-rect");
          return [
            ...filtered,
            {
              ...tempRect,
              id: `rect-${Date.now()}`,
              name: `Table_${tableCounterRef.current += 1}`,
            },
          ];
        });
      } else {
        setRectangles((prev) => prev.filter((r) => r.id !== "temp-rect"));
      }
      setIsDrawing(false);
      setNewRect(null);
      setDrawingColor(null);
    }
  };

  const handleRectClick = (id: string, e: any) => {
    if (e.evt?.button === 1) return;

    if (activeTool === "select" && !isDragging && !isTransforming) {
      const ctrlKey = e.evt?.ctrlKey || e.evt?.metaKey;

      if (ctrlKey) {
        setSelectedIds((prev) =>
          prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id],
        );
      } else {
        setSelectedIds([id]);
        const clicked = rectangles.find((r) => r.id === id);
        if (clicked?.mode === "smart") setSmartPanelRectId(id);
      }
    }
  };

  const handleGuideClick = (id: string, e: any) => {
    if (e.evt?.button === 1) return;

    if (activeTool === "select" && !isDragging) {
      const ctrlKey = e.evt?.ctrlKey || e.evt?.metaKey;

      if (ctrlKey) {
        setSelectedIds((prev) =>
          prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id],
        );
      } else {
        setSelectedIds([id]);
      }
    }
  };

  const handleRectDragStart = (id: string, e: any) => {
    // Snapshot starting positions for all selected rects so DragMove and
    // DragEnd can compute displacement without relying on stale React state.
    const node = e.target;
    dragOriginsRef.current = {};
    const ids = selectedIds.includes(id) ? selectedIds : [id];
    for (const sid of ids) {
      const r = rectanglesRef.current.find((x) => x.id === sid);
      if (r) dragOriginsRef.current[sid] = { x: r.x, y: r.y };
    }
    // The dragged node's Konva position is authoritative.
    dragOriginsRef.current[id] = { x: node.x(), y: node.y() };

    if (e.evt?.altKey) {
      isAltDuplicating.current = true;
      pushHistory();
      const ids = selectedIds.includes(id)
        ? selectedIds.filter((sid) => rectanglesRef.current.some((r) => r.id === sid && !r.locked))
        : [id];
      setRectangles((prev) => {
        const clones: Rectangle[] = [];
        for (const sid of ids) {
          const r = prev.find((rect) => rect.id === sid);
          if (!r) continue;
          const allSoFar = [...prev, ...clones];
          clones.push({ ...r, id: `rect-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: uniqueRectName(r.name ?? r.id, allSoFar) });
        }
        return [...prev, ...clones];
      });
    } else {
      isAltDuplicating.current = false;
    }
    setIsDragging(true);
  };

  const handleRectDragMove = (id: string, e: any) => {
    if (selectedIds.length <= 1) return;
    const node = e.target;
    const origin = dragOriginsRef.current[id];
    if (!origin) return;
    const dx = node.x() - origin.x;
    const dy = node.y() - origin.y;
    // Move other selected rects via Konva node API — no React state update,
    // so React-Konva never overrides the dragged node's position mid-drag.
    const stage = node.getStage();
    if (!stage) return;
    let dirty = false;
    for (const sid of selectedIds) {
      if (sid === id) continue;
      const o = dragOriginsRef.current[sid];
      if (!o) continue;
      const other = stage.findOne("#" + sid);
      if (other) { other.x(o.x + dx); other.y(o.y + dy); dirty = true; }
    }
    if (dirty) node.getLayer()?.batchDraw();
  };

  const handleRectDragEnd = (id: string, e: any) => {
    if (!isAltDuplicating.current) pushHistory();
    isAltDuplicating.current = false;
    const node = e.target;

    // Use origin snapshot from DragStart — state may have been updated by
    // DragMove so draggedRect.x ≈ node.x(), giving dx ≈ 0 without this ref.
    const origin = dragOriginsRef.current[id];
    const dx = origin ? node.x() - origin.x : 0;
    const dy = origin ? node.y() - origin.y : 0;

    if (selectedIds.length > 1 && selectedIds.includes(id)) {
      setRectangles((prev) =>
        prev.map((r) => {
          if (!selectedIds.includes(r.id)) return r;
          const o = dragOriginsRef.current[r.id];
          return { ...r, x: (o?.x ?? r.x) + dx, y: (o?.y ?? r.y) + dy };
        }),
      );
      setGuides((prev) =>
        prev.map((g) =>
          selectedIds.includes(g.id)
            ? { ...g, x: g.x + dx, y: g.y + dy }
            : g,
        ),
      );
    } else {
      setRectangles((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, x: node.x(), y: node.y() } : r,
        ),
      );
    }
    dragOriginsRef.current = {};
    setTimeout(() => setIsDragging(false), 0);
  };

  const handleGuideDragEnd = (id: string, e: any) => {
    pushHistory();
    const node = e.target;
    const draggedGuide = guides.find((g) => g.id === id);
    if (!draggedGuide) return;

    const dx = node.x() - draggedGuide.x;
    const dy = node.y() - draggedGuide.y;

    if (selectedIds.length > 1 && selectedIds.includes(id)) {
      setGuides((prev) =>
        prev.map((g) =>
          selectedIds.includes(g.id)
            ? {
                ...g,
                x: g.x + dx,
                y: g.y + dy,
              }
            : g,
        ),
      );
      setRectangles((prev) =>
        prev.map((r) =>
          selectedIds.includes(r.id)
            ? {
                ...r,
                x: r.x + dx,
                y: r.y + dy,
              }
            : r,
        ),
      );
    } else {
      setGuides((prev) =>
        prev.map((g) => (g.id === id ? { ...g, x: node.x(), y: node.y() } : g)),
      );
    }
    setTimeout(() => setIsDragging(false), 0);
  };

  const handleRectTransformStart = () => {
    setIsTransforming(true);
  };

  const handleRectTransformEnd = (id: string, e: any) => {
    pushHistory();
    const node = e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();

    node.scaleX(1);
    node.scaleY(1);
    node.strokeWidth(1 / scale);

    setRectangles((prev) =>
      prev.map((r) =>
        r.id === id
          ? {
              ...r,
              x: node.x(),
              y: node.y(),
              width: Math.max(5, node.width() * scaleX),
              height: Math.max(5, node.height() * scaleY),
            }
          : r,
      ),
    );
    setTimeout(() => setIsTransforming(false), 0);
  };

  const smartRect = smartPanelRectId
    ? rectangles.find((r) => r.id === smartPanelRectId && r.mode === "smart") ?? null
    : null;
  const smartPageData = smartRect?.smartPageData ?? {};
  const smartRawData = smartRect?.smartRawData ?? {};
  const smartPageKey = String(pageNum);

  // Shared by the Settings-bar gear icon (below) and the menu bar's
  // File > Settings item -- same payload either way.
  const handleOpenSettings = useCallback(() => {
    window.alteraStudio.openSettingsWindow({
      sample: sampleConfig,
      closeAfterConvert,
      schemaSampleRowLimit,
      schemaPageLimit,
      autoExpandOutputDrawer,
      pdfRenderDpi,
      numPages,
    });
  }, [sampleConfig, closeAfterConvert, schemaSampleRowLimit, schemaPageLimit, autoExpandOutputDrawer, pdfRenderDpi, numPages]);

  const dockPanelsContextValue = useMemo<DockPanelsContextValue>(() => ({
    disabled: showSchema,
    toolbar: {
      handleOpenPdf,
      handleConvert,
      isConverting: showLoader,
      rectangles,
      inkOverlayImage,
      showInkOverlay,
      setShowInkOverlay,
      activeTool,
      setActiveTool,
    },
    settingsBar: {
      onOpenSettings: handleOpenSettings,
      sampleEnabled: sampleConfig.enabled,
      onToggleSample: (v) => setSampleConfig((c) => ({ ...c, enabled: v })),
      showLabels,
      onToggleShowLabels: setShowLabels,
    },
    groups: {
      groups,
      rectangles,
      guides,
      selectedIds,
      handleAddGroup,
      handleToggleGroupHidden,
      handleRenameGroup,
      handleDeleteGroup,
      handleDuplicateGroup,
      handleReorderGroups,
      handleNestGroup,
      handleUnnestGroup,
      handleToggleRectLocked,
      handleToggleRectHidden,
      handleToggleGuideLocked,
      handleToggleGuideHidden,
      handleSelectRect,
      handleSelectRects,
      handleAssignRectsToGroup,
      handleReorderRects,
      handleMoveRectsToRootEnd,
      handleRenameRect,
      pushHistory,
      onNameCollision: handleRectNameCollision,
      handleChangeRectsOpacity,
      handleChangeRectColor,
      handleToggleRectsLocked,
      pendingEditRectId,
      clearPendingEditRectId,
    },
    properties: {
      singleSelectedRect,
      selectedCount: selectedRectangles.length,
      groups,
      setRectangles,
    },
    canvas: {
      setSlotEl: setCanvasSlotEl,
    },
    nodes: {
      onAddNode: handleAddProcessorNode,
    },
    smart: {
      rect: smartRect,
      isRunning: !!(smartPanelRectId && smartRunning[smartPanelRectId]),
      pageMatchCount: Object.keys(smartPageData).length,
      currentPageHasMatch: !!smartPageData[smartPageKey],
      currentPageRawCount: smartRawData[smartPageKey]?.bboxes?.length ?? 0,
      currentPageFilteredCount: smartPageData[smartPageKey]?.bboxes?.length ?? 0,
      onClose: handleSmartClose,
      onConfigChange: handleSmartConfigChange,
      onRun: handleSmartRun,
    },
    nodeLog: selectedNodeLog,
  }), [
    showSchema,
    handleAddProcessorNode,
    handleOpenSettings,
    handleOpenPdf, handleConvert, showLoader, rectangles, inkOverlayImage, showInkOverlay, activeTool,
    sampleConfig, closeAfterConvert, showLabels, schemaSampleRowLimit, schemaPageLimit, numPages,
    groups, guides, selectedIds, handleAddGroup, handleToggleGroupHidden, handleRenameGroup, handleDeleteGroup, handleDuplicateGroup,
    handleReorderGroups, handleNestGroup, handleUnnestGroup,
    handleToggleRectLocked, handleToggleRectHidden, handleToggleGuideLocked, handleToggleGuideHidden, handleSelectRect, handleSelectRects, handleAssignRectsToGroup, handleReorderRects, handleMoveRectsToRootEnd, handleRenameRect,
    handleRectNameCollision,
    handleChangeRectsOpacity, handleChangeRectColor, handleToggleRectsLocked,
    pendingEditRectId, clearPendingEditRectId,
    singleSelectedRect, selectedRectangles, pushHistory, handleToggleSmartMode, handleColorChange,
    setCanvasSlotEl,
    smartRect, smartPanelRectId, smartRunning, smartPageData, smartRawData, smartPageKey,
    handleSmartClose, handleSmartConfigChange, handleSmartRun,
    autoExpandOutputDrawer,
    selectedNodeLog,
  ]);

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#FE4D41",
          borderRadius: 8,
          fontFamily: '"Google Sans Flex", sans-serif',
        },
      }}
    >
      <div
        className={`high-level-container${isDragOver ? " drop-active" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false); }}
        onDrop={(e) => { e.preventDefault(); setIsDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFileDrop(f); }}
      >
        {/* ── Custom menu bar, replacing Electron's native File/Edit/View/
            Window/Help menu (see main.ts's Menu.setApplicationMenu(null)).
            Fixed at the very top; .dock-overlay-root's `top: 28px` reserves
            the space below it, same pattern the footer's `bottom: 40px`
            already uses. ── */}
        <MenuBar
          onOpenProject={handleOpenProject}
          onSaveProject={handleSaveProject}
          onSaveProjectAs={handleSaveProjectAs}
          onOpenSettings={handleOpenSettings}
          onRestart={() => window.alteraStudio.restartApp()}
          onExit={() => window.close()}
          onUndo={handleUndo}
          onRedo={handleRedo}
          canUndo={historyRef.current.length > 0}
          canRedo={futureRef.current.length > 0}
          onCut={handleCutSelected}
          onCopy={handleCopySelected}
          onPaste={handlePasteSelected}
          onDelete={handleDeleteSelected}
          hasSelection={selectedIds.length > 0}
          hasClipboard={clipboardRef.current.length > 0}
          onRunAll={handleRunAllProcessorNodes}
        />

        {/* ── Footer: page navigation (left) + zoom controls (right), fixed & compact ── */}
        <div className={`app-footer${showSchema ? " disabled" : ""}`}>
          <div className="footer-pagenav">
            <PageNavPanel
              pdfDoc={pdfDoc}
              pageNum={pageNum}
              numPages={numPages}
              handlePrevPage={handlePrevPage}
              handleNextPage={handleNextPage}
              showPageInput={showPageInput}
              setShowPageInput={setShowPageInput}
              pageInputValue={pageInputValue}
              setPageInputValue={setPageInputValue}
              handleGoToPage={handleGoToPage}
            />
            {isPageRendering && !isFileLoading && (
              <Spin className="footer-render-spinner" indicator={<LoadingOutlined spin />} size="small" />
            )}
          </div>
        </div>

        {!pdfDoc && (
          <div
            className="drop-zone-wrap"
            style={{ position: "fixed", left: canvasRect.left, top: canvasRect.top, width: canvasRect.width, height: canvasRect.height }}
          >
            <div className="drop-zone-modal">
              <div
                className={`drop-zone-card${isDragOver ? " drag-over" : ""}`}
                onClick={handleOpenPdf}
              >
                <div className="drop-zone-icon-wrap">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="12" y1="12" x2="12" y2="18"/>
                    <line x1="9" y1="15" x2="15" y2="15"/>
                  </svg>
                </div>
                <p className="drop-zone-title">
                  {isDragOver ? "Release to open" : "Open a PDF to get started"}
                </p>
                <p className="drop-zone-sub">Drop file here or click to browse</p>
                <div className="drop-zone-badge">PDF</div>
              </div>
            </div>
          </div>
        )}

        <div
          ref={containerRef}
          className="canvas-container"
          style={{
            position: "fixed",
            left: canvasRect.left,
            top: canvasRect.top,
            width: canvasRect.width,
            height: canvasRect.height,
            cursor,
            display: pdfDoc ? undefined : "none",
          }}
        >
          <Stage
            ref={stageRef}
            width={canvasRect.width}
            height={canvasRect.height}
            scaleX={scale}
            scaleY={scale}
            x={stagePos.x}
            y={stagePos.y}
            onMouseDown={handleStageMouseDown}
            onMouseMove={handleStageMouseMove}
            onMouseUp={handleStageMouseUp}
            onMouseLeave={handleStageMouseUp}
            draggable={false}
          >
            {/* ── Layer 1 · static (PDF image + overlay) ───────────────────
                 Independent canvas that never redraws during interaction.
                 listening={false} so events fall through to Layer 2. */}
            <Layer listening={false}>
              {pageImage && (
                <KonvaImage
                  image={pageImage}
                  x={0}
                  y={0}
                  width={pageWidth}
                  height={pageHeight}
                  shadowColor="rgba(0, 0, 0, 0.15)"
                  shadowBlur={10 / scale}
                  shadowOpacity={0.15}
                  shadowOffsetX={0}
                  shadowOffsetY={2 / scale}
                />
              )}
              {showInkOverlay && inkOverlayImage && (
                <KonvaImage
                  image={inkOverlayImage}
                  x={0}
                  y={0}
                  width={pageWidth}
                  height={pageHeight}
                  opacity={0.3}
                  listening={false}
                />
              )}
            </Layer>

            {/* ── Layer 2 · content (rects, guides, transformer) ──────────── */}
            <Layer>
              {/* Page background — white fill when no image loaded (image lives
                  in Layer 1 above); always present for page-bg click detection */}
              <Rect
                id="page-bg"
                x={0}
                y={0}
                width={pageWidth}
                height={pageHeight}
                fill={pageImage ? "transparent" : "white"}
                shadowColor="rgba(0, 0, 0, 0.15)"
                shadowBlur={10 / scale}
                shadowOpacity={pageImage ? 0 : 0.15}
                shadowOffsetX={0}
                shadowOffsetY={2 / scale}
              />
              <Rect
                x={0}
                y={0}
                width={pageWidth}
                height={pageHeight}
                stroke="#ccc"
                strokeWidth={1 / scale}
                listening={false}
              />

              {rectangles.filter((rect) => !isRectEffectivelyHidden(rect)).map((rect) => {
                const isSmart = rect.mode === "smart";
                const noMatchOnPage = isSmart && rect.smartPageData != null && !rect.smartPageData[String(pageNum)];
                const hasMatchOnPage = isSmart && rect.smartPageData != null && !!rect.smartPageData[String(pageNum)];

                if (isSmart) {
                  const off = rect.smartConfig?.offset ?? { top: 0, bottom: 0, left: 0, right: 0 };
                  const hasOff = off.top !== 0 || off.bottom !== 0 || off.left !== 0 || off.right !== 0;
                  const pageEntry = rect.smartPageData?.[String(pageNum)];
                  const indivBboxes = pageEntry?.bboxes ?? [];
                  return (
                    <React.Fragment key={rect.id}>
                      {/* Individual keyword occurrences — tinted with rect color */}
                      {hasMatchOnPage && indivBboxes.map(([bx, by, bx2, by2], i) => (
                        <Rect
                          key={`bbox-${i}`}
                          x={bx}
                          y={by}
                          width={bx2 - bx}
                          height={by2 - by}
                          fill={rect.fill}
                          stroke={rect.stroke}
                          strokeWidth={0.8 / scale}
                          dashEnabled={false}
                          listening={false}
                        />
                      ))}
                      {/* Offset rect — dashed, same color as rect with low opacity */}
                      {hasOff && hasMatchOnPage && (
                        <Rect
                          x={rect.x - off.left}
                          y={rect.y - off.top}
                          width={rect.width + off.left + off.right}
                          height={rect.height + off.top + off.bottom}
                          fill={rect.stroke.startsWith("rgb(") ? rect.stroke.replace("rgb(", "rgba(").replace(")", ", 0.25)") : rect.fill}
                          stroke={rect.stroke}
                          strokeWidth={0.4 / scale}
                          dash={[5 / scale, 3 / scale]}
                          dashEnabled
                          listening={false}
                        />
                      )}
                      {/* Union bbox — rect color, clickable */}
                      <Rect
                        id={rect.id}
                        x={rect.x}
                        y={rect.y}
                        width={rect.width}
                        height={rect.height}
                        fill={rect.fill}
                        stroke={rect.stroke}
                        strokeWidth={1.5 / scale}
                        dashEnabled={false}
                        opacity={noMatchOnPage ? 0.25 : 1}
                        draggable={false}
                        listening={activeTool === "select"}
                        onClick={(e) => handleRectClick(rect.id, e)}
                        onTap={(e) => handleRectClick(rect.id, e)}
                        onContextMenu={(e) => {
                          e.evt.preventDefault();
                          const pos = e.target.getStage()!.getPointerPosition()!;
                          // Right-clicking a rect that's already part of the
                          // current multi-selection keeps that whole
                          // selection (so Duplicate/Lock/Delete apply to all
                          // of it); right-clicking outside it replaces the
                          // selection with just this rect, same as any GUI.
                          setSelectedIds((prev) => (prev.includes(rect.id) ? prev : [rect.id]));
                          setCtxMenu({ x: pos.x, y: pos.y, rectId: rect.id });
                        }}
                      />
                      {showLabels && rect.name && (
                        <Label
                          x={rect.x + 4 / scale}
                          y={rect.y + 4 / scale}
                          listening={false}
                        >
                          <Tag fill="#333333" />
                          <KonvaText
                            text={rect.name}
                            fontSize={12 / scale}
                            fill="white"
                            padding={3 / scale}
                          />
                        </Label>
                      )}
                    </React.Fragment>
                  );
                }

                // Free rect
                return (
                  <React.Fragment key={rect.id}>
                    <Rect
                      id={rect.id}
                      x={rect.x}
                      y={rect.y}
                      width={rect.width}
                      height={rect.height}
                      fill={rect.fill}
                      stroke={rect.stroke}
                      strokeWidth={1 / scale}
                      dashEnabled={false}
                      opacity={1}
                      draggable={activeTool === "select" && !isPanning && !rect.locked}
                      listening={activeTool === "select"}
                      onClick={(e) => handleRectClick(rect.id, e)}
                      onTap={(e) => handleRectClick(rect.id, e)}
                      onContextMenu={(e) => {
                        e.evt.preventDefault();
                        const pos = e.target.getStage()!.getPointerPosition()!;
                        // Right-clicking a rect that's already part of the
                        // current multi-selection keeps that whole selection
                        // (so Duplicate/Lock/Delete apply to all of it);
                        // right-clicking outside it replaces the selection
                        // with just this rect, same as any GUI.
                        setSelectedIds((prev) => (prev.includes(rect.id) ? prev : [rect.id]));
                        setCtxMenu({ x: pos.x, y: pos.y, rectId: rect.id });
                      }}
                      onDragStart={(e) => handleRectDragStart(rect.id, e)}
                      onDragMove={(e) => handleRectDragMove(rect.id, e)}
                      onDragEnd={(e) => handleRectDragEnd(rect.id, e)}
                      onTransformStart={handleRectTransformStart}
                      onTransform={(e: any) => {
                        const sx = e.target.scaleX();
                        const sy = e.target.scaleY();
                        e.target.strokeWidth(1 / (scale * Math.sqrt(sx * sy)));
                      }}
                      onTransformEnd={(e) => handleRectTransformEnd(rect.id, e)}
                    />
                    {showLabels && rect.name && (
                      <Label
                        x={rect.x + 4 / scale}
                        y={rect.y + 4 / scale}
                        listening={false}
                      >
                        <Tag fill="#333333" />
                        <KonvaText
                          text={rect.name}
                          fontSize={12 / scale}
                          fill="white"
                          padding={3 / scale}
                        />
                      </Label>
                    )}
                  </React.Fragment>
                );
              })}

              {/* Only mounted while something is actually selected: Konva's
                  Transformer keeps its internal "rotater" anchor in the
                  interactive hit-detection graph even with rotateEnabled=false
                  and zero attached nodes, sitting at a phantom default
                  position that can silently intercept clicks meant for real
                  shapes underneath (breaks the very first click that would
                  select something, since nothing was selected yet). */}
              {activeTool === "select" && (selectedRectangles.length > 0 || selectedGuides.length > 0) && (
                <Transformer
                  borderStroke="#000000"
                  // Locked rects get no resize handles and a dashed border
                  // instead of a permanent on-canvas lock badge — the same
                  // "selected but not editable" signal most design tools use
                  // (Figma included), read at the moment it's relevant
                  // rather than cluttering every locked shape at all times.
                  borderDash={selectedRectangles.some((r) => r.locked) ? [4, 4] : undefined}
                  anchorStroke="#000000"
                  anchorFill="white"
                  ref={transformerRef}
                  keepRatio={false}
                  rotateEnabled={false}
                  enabledAnchors={
                    selectedRectangles.length === 1 &&
                    selectedGuides.length === 0 &&
                    !selectedRectangles[0].locked
                      ? undefined
                      : []
                  }
                  boundBoxFunc={(oldBox, newBox) => {
                    if (newBox.width < 5 || newBox.height < 5) {
                      return oldBox;
                    }
                    return newBox;
                  }}
                />
              )}

              {guides.filter((guide) => !guide.hidden).map((guide) => {
                const isSelected = selectedIds.includes(guide.id);
                const isGlobal = !guide.rectName;
                const sw = isSelected ? 2 / scale : 1.5 / scale;
                const handleSize = (isSelected ? 20 : 16) / scale;
                const sharedHandleProps = {
                  draggable: activeTool === "select" && !isPanning && !guide.locked,
                  onClick: (e: any) => handleGuideClick(guide.id, e),
                  onTap: (e: any) => handleGuideClick(guide.id, e),
                  onDragStart: () => setIsDragging(true),
                  onDragMove: (e: any) => {
                    const node = e.target;
                    setGuides((prev) =>
                      prev.map((g) =>
                        g.id === guide.id
                          ? { ...g, x: node.x(), y: node.y() }
                          : g,
                      ),
                    );
                  },
                  onDragEnd: (e: any) => handleGuideDragEnd(guide.id, e),
                };
                const guideOpacity = guide.locked ? 0.5 : 1;
                return (
                  <React.Fragment key={guide.id}>
                    {isGlobal ? (
                      <Line
                        id={guide.id}
                        x={guide.x}
                        y={-99999}
                        points={[0, 0, 0, 199999]}
                        stroke="black"
                        strokeWidth={isSelected ? 2 / scale : 1.5 / scale}
                        listening={activeTool === "select"}
                        onClick={(e) => handleGuideClick(guide.id, e)}
                        onTap={(e) => handleGuideClick(guide.id, e)}
                        opacity={guideOpacity}
                      />
                    ) : (
                      <Line
                        id={guide.id}
                        x={guide.x}
                        y={-99999}
                        points={[0, 0, 0, 199999]}
                        stroke={guide.color}
                        strokeWidth={sw}
                        listening={activeTool === "select"}
                        onClick={(e) => handleGuideClick(guide.id, e)}
                        onTap={(e) => handleGuideClick(guide.id, e)}
                        opacity={guideOpacity}
                      />
                    )}

                    {isGlobal ? (
                      <Rect
                        x={guide.x}
                        y={guide.y}
                        offsetX={handleSize / 2}
                        offsetY={handleSize / 2}
                        width={handleSize}
                        height={handleSize}
                        fill="white"
                        stroke="black"
                        strokeWidth={sw}
                        opacity={guideOpacity}
                        {...sharedHandleProps}
                      />
                    ) : (
                      <Circle
                        x={guide.x}
                        y={guide.y}
                        radius={isSelected ? 10 / scale : 8 / scale}
                        fill="white"
                        stroke={guide.color}
                        strokeWidth={sw}
                        opacity={guideOpacity}
                        {...sharedHandleProps}
                      />
                    )}
                  </React.Fragment>
                );
              })}

            </Layer>

            {/* ── Layer 3 · overlay (marquee + guide preview) ─────────────────
                 Redraws on every mousemove during marquee/guide-tool hover;
                 keeping it isolated means Layer 2 (all rects + guides) stays
                 untouched during those high-frequency updates. */}
            <Layer listening={false}>
              {isMarqueeSelecting && marqueeStart && marqueeEnd && (
                <Rect
                  x={Math.min(marqueeStart.x, marqueeEnd.x)}
                  y={Math.min(marqueeStart.y, marqueeEnd.y)}
                  width={Math.abs(marqueeEnd.x - marqueeStart.x)}
                  height={Math.abs(marqueeEnd.y - marqueeStart.y)}
                  fill="rgba(0, 0, 0, 0.08)"
                  stroke="rgba(0, 0, 0, 0.5)"
                  strokeWidth={1 / scale}
                  listening={false}
                />
              )}

              {activeTool === "guide" && previewGuideX !== null && (
                guideColor === "__global__" ? (
                  <Line x={previewGuideX} y={-99999} points={[0, 0, 0, 199999]} stroke="black" strokeWidth={1 / scale} dash={[10 / scale, 5 / scale]} opacity={0.5} listening={false} />
                ) : (
                  <Line
                    x={previewGuideX}
                    y={-99999}
                    points={[0, 0, 0, 199999]}
                    stroke={guideColorPreviewStroke}
                    strokeWidth={1 / scale}
                    dash={[10 / scale, 5 / scale]}
                    opacity={0.5}
                    listening={false}
                  />
                )
              )}
            </Layer>
          </Stage>

          {/* Pop-up toolbar — multi-selection and guides only */}
          {(selectedItems.length > 1 || onlyGuidesSelected) && (
            <div
              className="pop-up-toolbar"
              style={{
                left: `${menuPosition.left}px`,
                top: `${menuPosition.top - 5}px`,
              }}
            >
              {selectedItems.length > 1 && (
                <div className="selection-count">
                  {selectedItems.length} selected
                </div>
              )}

              {onlyGuidesSelected && (
                <div className="guide-color-dropdown-wrapper">
                  <button
                    type="button"
                    className="guide-color-dropdown-toggle"
                    onClick={(e) => { e.stopPropagation(); setGuideColorMenuOpen((o) => !o); }}
                  >
                    <span
                      className="guide-color-dot"
                      style={{
                        background: selectedGuidesRectName === "__global__"
                          ? "linear-gradient(135deg, #333 50%, #fff 50%)"
                          : (selectedGuides[0]?.color ?? "#000000"),
                      }}
                    />
                    <span className="guide-color-dropdown-text">
                      {selectedGuidesRectName === "__global__" ? "Global (all tables)" : selectedGuidesRectName}
                    </span>
                    <GuideColorChevron />
                  </button>
                  {guideColorMenuOpen && (
                    <div className="guide-color-dropdown-menu">
                      <div
                        className={`guide-color-dropdown-item ${selectedGuidesRectName === "__global__" ? "active" : ""}`}
                        onClick={(e) => { e.stopPropagation(); handleGuideRectNameChange("__global__"); setGuideColorMenuOpen(false); }}
                      >
                        <span className="guide-color-dot" style={{ background: "linear-gradient(135deg, #333 50%, #fff 50%)" }} />
                        <span className="guide-color-dropdown-text">Global (all tables)</span>
                      </div>
                      {uniqueNamedRects.map((rect) => {
                        const name = rect.name ?? rect.id;
                        return (
                          <div
                            key={name}
                            className={`guide-color-dropdown-item ${selectedGuidesRectName === name ? "active" : ""}`}
                            onClick={(e) => { e.stopPropagation(); handleGuideRectNameChange(name); setGuideColorMenuOpen(false); }}
                          >
                            <span className="guide-color-dot" style={{ background: rect.stroke }} />
                            <span className="guide-color-dropdown-text">{name}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {onlyGuidesSelected && (() => {
                const allLocked = selectedGuides.every(g => g.locked);
                return (
                  <button
                    className={`ps-icon-btn ${allLocked ? "locked" : ""}`}
                    title={allLocked ? "Unlock (Ctrl+L)" : "Lock (Ctrl+L)"}
                    onClick={() => { pushHistory(); setGuides(prev => prev.map(g =>
                      selectedIds.includes(g.id) ? { ...g, locked: !g.locked } : g
                    )); }}
                  >
                    <GuideLockIcon />
                  </button>
                );
              })()}

              <button onClick={handleDeleteSelected} className="ps-icon-btn" title="Delete">
                <GuideTrashIcon />
              </button>
            </div>
          )}

          {/* Right-click context menu for rectangles — quick actions only;
              everything else (label, group, smart mode, engine, color) lives in the Properties panel */}
          {ctxMenu && ctxMenuRect && (
            <div
              className="rect-ctx-menu"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
              onMouseDown={e => e.stopPropagation()}
            >
              {/* Rename — only ever targets the specific rect that was
                  right-clicked, unlike Lock/Convert/Delete below: applying one
                  name to a whole multi-selection wouldn't make sense. Jumps to
                  the Groups tab and opens that row's name in edit mode there,
                  rather than editing inline in this quick-actions menu. */}
              <div className="ctx-menu-item" onClick={() => {
                handleRenameFromCanvas(ctxMenuRect.id);
                setCtxMenu(null);
              }}>
                <span>Rename</span>
              </div>

              {/* Duplicate */}
              <div className="ctx-menu-item" onClick={() => { handleDuplicateSelected(); setCtxMenu(null); }}>
                <span>Duplicate</span>
              </div>

              {/* Lock / Unlock — applies to the whole current selection, not
                  just the rect that was right-clicked */}
              <div className="ctx-menu-item" onClick={() => {
                handleToggleRectsLocked(selectedIds);
                setCtxMenu(null);
              }}>
                <span>{selectedRectangles.every(r => r.locked) ? "Unlock" : "Lock"}</span>
              </div>

              {/* Convert to Smart/Free mode — applies to the whole current
                  selection, same targeting as Lock/Unlock above. Converting
                  to smart also focuses the specific rect that was
                  right-clicked: selects it alone and opens its Smart panel,
                  so there's a clear sign the conversion actually did
                  something. */}
              <div className="ctx-menu-item" onClick={() => {
                handleToggleRectsMode(selectedIds, ctxMenuRect.id);
                setCtxMenu(null);
              }}>
                <span>{selectedRectangles.every(r => r.mode === "smart") ? "Convert to Free Mode" : "Convert to Smart Mode"}</span>
              </div>
              <div className="ctx-menu-divider" />

              {/* Delete */}
              <div className="ctx-menu-item" onClick={() => { handleDeleteSelected(); setCtxMenu(null); }}>
                <span>Delete</span>
              </div>
            </div>
          )}
        </div>

        {/* ── Docked / floating panels: Toolbar, Page Nav, Smart Rect, Groups, Properties ── */}
        <DockPanelsContext.Provider value={dockPanelsContextValue}>
          <div className="dock-overlay-root">
            <DockLayout
              ref={dockLayoutRef}
              defaultLayout={initialDockLayout}
              onLayoutChange={handleDockLayoutChange}
              groups={{
                toolbar: { floatable: true, maximizable: false },
                settingsBar: { floatable: true, maximizable: false },
              }}
              style={{ position: "absolute", inset: 0, pointerEvents: "none", background: "transparent" }}
            />
          </div>
        </DockPanelsContext.Provider>


        {/* ── Schema preview overlay ── */}
        {/* Mirrors canvasRect (same live-rect technique the real Konva
            canvas / drop-zone use) so it fills exactly the Canvas dock
            tab's slot instead of the whole viewport -- reads as "the
            canvas switched to schema view", not a separate full app modal. */}
        <div
          className={`schema-overlay${showSchema ? ' visible' : ''}`}
          style={{ position: "fixed", left: canvasRect.left, top: canvasRect.top, width: canvasRect.width, height: canvasRect.height }}
        >
          <div className="schema-overlay-body">
            {/* Always mounted (not gated on showSchema) -- the parent
                .schema-overlay already hides this via CSS display:none when
                inactive. Conditionally rendering here would unmount/remount
                SchemaView on every Canvas<->Schema toggle, wiping its
                internal node-position state (dragged card positions) each
                time. */}
            <ErrorBoundary label="Schema Preview" compact>
              <SchemaView
                rectangles={rectangles}
                groups={groups}
                processorNodes={processorNodes}
                edges={edges}
                onEdgesChange={handleEdgesChange}
                onConnect={handleConnect}
                onDeleteEdge={handleDeleteEdge}
                onReconnectStart={handleReconnectStart}
                onReconnect={handleReconnect}
                onReconnectEnd={handleReconnectEnd}
                workflowResetSignal={workflowResetSignal}
                runAllSignal={runAllSignal}
                previewTables={schemaPreviewTables}
                convertedTables={convertedTables}
                loading={schemaPreviewLoading}
                error={schemaPreviewError}
                autoExpandOutputDrawer={autoExpandOutputDrawer}
                onUpdateTablePosition={handleUpdateSchemaTablePosition}
                onUpdateGroupPosition={handleUpdateSchemaGroupPosition}
                onAddProcessorNode={handleAddProcessorNode}
                onUpdateProcessorNodePosition={handleUpdateProcessorNodePosition}
                onDeleteProcessorNodes={handleDeleteProcessorNodes}
                onRenameProcessorNode={handleRenameProcessorNode}
                onUpdateProcessorNodeDescription={handleUpdateProcessorNodeDescription}
                onUpdateProcessorNodeParams={handleUpdateProcessorNodeParams}
                onRenameColumn={handleRenameSchemaColumn}
                selectedIds={selectedIds}
                onTableSelectionChange={handleTableSelectionChange}
                onSelectedNodeLogChange={setSelectedNodeLog}
                visible={showSchema}
              />
            </ErrorBoundary>
          </div>
        </div>

        {/* Canvas/Schema view switcher -- pinned to the top-center of the
            canvas slot (same canvasRect anchor as the overlay above) rather
            than living as a toolbar icon, since it's a view toggle for the
            canvas area itself, not a tool. */}
        <div
          className="canvas-view-switcher"
          style={{ position: "fixed", left: canvasRect.left + canvasRect.width / 2, top: canvasRect.top + 12, transform: "translateX(-50%)" }}
        >
          <button
            className={`canvas-view-switcher-btn ${!showSchema ? "active" : ""}`}
            onClick={() => setShowSchema(false)}
          >
            Canvas
          </button>
          <button
            className={`canvas-view-switcher-btn ${showSchema ? "active" : ""}`}
            onClick={() => setShowSchema(true)}
          >
            Workflow
          </button>
        </div>

        {/* Canvas zoom controls -- styled after React Flow's own Controls
            widget (same vertical +/-/fit stack, same sizing/colors) so the
            Canvas and Schema views share one zoom-UI language. Floats over
            canvasRect's bottom-left corner; hidden in Schema view since
            SchemaView renders its own React Flow Controls instance there.
            45px offset matches SchemaView's own Controls `bottom` override
            (clear of the output drawer's collapsed handle bar there) so the
            stack doesn't jump position when switching views. */}
        {!showSchema && (
          <div
            className="canvas-zoom-controls"
            style={{ position: "fixed", left: canvasRect.left + 15, top: canvasRect.top + canvasRect.height - 45, transform: "translateY(-100%)" }}
          >
            <button onClick={handleZoomIn} className="canvas-zoom-btn" title="Zoom In (Ctrl + +)">
              <CanvasZoomInIcon />
            </button>
            <button onClick={handleZoomOut} className="canvas-zoom-btn" title="Zoom Out (Ctrl + -)">
              <CanvasZoomOutIcon />
            </button>
            <button onClick={handleFitPage} className="canvas-zoom-btn" title="Fit View">
              <CanvasFitViewIcon />
            </button>
          </div>
        )}

        {/* Rect-rename collision toast -- anchored to the canvas's right
            edge (10px in), same bottom alignment as the zoom controls.
            Custom-built (not antd): charcoal surface with an accent-color
            left rail, fades in via opacity. */}
        {!showSchema && nameToast && (
          <div
            style={{
              position: "fixed",
              right: window.innerWidth - (canvasRect.left + canvasRect.width) + 10,
              top: canvasRect.top + canvasRect.height - 15,
              transform: "translateY(-100%)",
              zIndex: 100000,
              background: "#2b2b2b",
              color: "#f2f2f2",
              borderLeft: "3px solid #FE4D41",
              padding: "18px 14px",
              borderRadius: 0,
              fontFamily: '"Google Sans Flex", sans-serif',
              fontSize: 13,
              lineHeight: 1.4,
              maxWidth: 320,
              boxShadow: "0 0 2px 1px rgba(0, 0, 0, 0.08)",
              opacity: nameToast.visible ? 1 : 0,
              transition: "opacity 0.25s ease",
              pointerEvents: "none",
            }}
          >
            {nameToast.msg}
          </div>
        )}

        {/* Conversion progress toast -- replaces the old full-screen
            blocking loader. Same charcoal/accent-rail visual language as
            the rename-collision toast above; non-blocking, since the
            backend already got a full snapshot of what it needs in the
            initial request, so leaving the canvas interactive during a
            conversion doesn't risk anything. Unlike the rename toast, this
            isn't gated to Canvas-only -- a conversion started from the
            toolbar can still be running after switching to Schema view,
            and the progress is just as relevant there. */}
        {showLoader && (
          <div
            style={{
              position: "fixed",
              right: window.innerWidth - (canvasRect.left + canvasRect.width) + 10,
              top: canvasRect.top + canvasRect.height - 15,
              transform: "translateY(-100%)",
              zIndex: 100000,
              background: "#2b2b2b",
              color: "#f2f2f2",
              borderLeft: "3px solid #FE4D41",
              padding: "14px 16px",
              borderRadius: 0,
              fontFamily: '"Google Sans Flex", sans-serif',
              fontSize: 13,
              lineHeight: 1.4,
              width: 220,
              boxShadow: "0 0 2px 1px rgba(0, 0, 0, 0.08)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              pointerEvents: "none",
            }}
          >
            <span>Converting{conversionProgress != null ? `… ${conversionProgress}%` : "…"}</span>
            <div className="conversion-toast-track">
              {conversionProgress != null ? (
                <div className="conversion-toast-fill" style={{ width: `${conversionProgress}%` }} />
              ) : (
                <div className="conversion-toast-fill-indeterminate" />
              )}
            </div>
          </div>
        )}

        {/* Guide tool target indicator — shows current guide target and lets
            the user change it. Rendered at canvas level so it isn't clipped
            by the toolbar dock panel's overflow:hidden. */}
        {activeTool === "guide" && !showSchema && (
          <div
            className="guide-tool-target"
            style={{ position: "fixed", left: canvasRect.left + 12, top: canvasRect.top + 12 }}
          >
            <div className="guide-color-dropdown-wrapper">
              <button
                type="button"
                className="guide-color-dropdown-toggle"
                onClick={(e) => { e.stopPropagation(); setGuideToolMenuOpen((o) => !o); }}
                title="Guide target (C to cycle)"
              >
                <span
                  className="guide-color-dot"
                  style={{
                    background: guideColor === "__global__"
                      ? "linear-gradient(135deg, #333 50%, #fff 50%)"
                      : guideColorPreviewStroke,
                  }}
                />
                <span className="guide-color-dropdown-text">
                  {guideColor === "__global__" ? "Global (all tables)" : guideColor}
                </span>
                <GuideColorChevron />
              </button>
              {guideToolMenuOpen && (
                <div className="guide-color-dropdown-menu">
                  <div
                    className={`guide-color-dropdown-item ${guideColor === "__global__" ? "active" : ""}`}
                    onClick={(e) => { e.stopPropagation(); setGuideColor("__global__"); setGuideToolMenuOpen(false); }}
                  >
                    <span className="guide-color-dot" style={{ background: "linear-gradient(135deg, #333 50%, #fff 50%)" }} />
                    <span className="guide-color-dropdown-text">Global (all tables)</span>
                  </div>
                  {uniqueNamedRects.map((rect) => {
                    const name = rect.name ?? rect.id;
                    return (
                      <div
                        key={name}
                        className={`guide-color-dropdown-item ${guideColor === name ? "active" : ""}`}
                        onClick={(e) => { e.stopPropagation(); setGuideColor(name); setGuideToolMenuOpen(false); }}
                      >
                        <span className="guide-color-dot" style={{ background: rect.stroke }} />
                        <span className="guide-color-dropdown-text">{name}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* File-loading toast -- same charcoal/accent-rail, non-blocking
            corner toast as the conversion-progress one above (see its
            comment), replacing the old full-screen blur overlay that
            covered the whole window while a PDF opened. */}
        {isFileLoading && (
          <div
            style={{
              position: "fixed",
              right: window.innerWidth - (canvasRect.left + canvasRect.width) + 10,
              top: canvasRect.top + canvasRect.height - 15,
              transform: "translateY(-100%)",
              zIndex: 100000,
              background: "#2b2b2b",
              color: "#f2f2f2",
              borderLeft: "3px solid #FE4D41",
              padding: "14px 16px",
              borderRadius: 0,
              fontFamily: '"Google Sans Flex", sans-serif',
              fontSize: 13,
              lineHeight: 1.4,
              width: 220,
              boxShadow: "0 0 2px 1px rgba(0, 0, 0, 0.08)",
              display: "flex",
              alignItems: "center",
              gap: 10,
              pointerEvents: "none",
            }}
          >
            <Spin indicator={<LoadingOutlined spin style={{ color: "#f2f2f2" }} />} size="small" />
            <span>Loading PDF…</span>
          </div>
        )}

      </div>
    </ConfigProvider>
  );
};

export default KonvaA4Editor;
