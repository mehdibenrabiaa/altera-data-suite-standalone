import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ConfigProvider, Input } from "antd";
import type { AddColumnParams } from "./types";
import type { AddColumnWindowPayload } from "./vite-env";
import {
  tokenizeFormula,
  getFormulaCompletionContext,
  getFunctionCallContext,
  splitTokensAtCursor,
  validateFormula,
  formatFormula,
  mapCursorAfterFormat,
  FORMULA_FUNCTIONS,
  FUNCTION_SIGNATURES,
} from "./formulaHighlight";
import "./App.css";

// Configure window for the Add Column node -- Power Query's own "Add
// Custom Column": a formula referencing other columns as [Column Name]
// (PQ's own bracket syntax) computes one new column, one row at a time
// (backend/app/nodes.py's add_column, a safe AST-walking evaluator, not a
// raw eval() -- see its own comment). No live per-row preview grid here
// (unlike RegexWindow.tsx's client-mirrored preview) -- the formula
// language is open-ended enough that mirroring its evaluator in JS just to
// preview it isn't worth doubling the surface a bug can hide in; the real
// formula only ever runs in the backend, on Apply/Run, same as most other
// nodes here (Merge, Header Promoter, Filter Builder, ...) already work
// without one either.
//
// The formula box's syntax highlighting (formulaHighlight.ts's tokenizer)
// and autocomplete are hand-rolled, not backed by a real editor library
// (CodeMirror/Monaco) -- this environment's npm registry access is locked
// down (confirmed directly: even a trivial, unrelated package 403s), so
// there was no way to actually install one. The highlight is the classic
// "transparent textarea layered over a styled overlay, both scrolled in
// sync" technique real lightweight code-input widgets use when they can't
// pull in a full editor component; the floating autocomplete popup below
// reuses that SAME overlay to find the caret's actual screen position (see
// formulaHighlight.ts's splitTokensAtCursor), the standard trick for
// "where is the cursor" in a plain textarea.
const antTheme = {
  token: {
    borderRadius: 0,
    borderRadiusLG: 0,
    borderRadiusSM: 0,
    controlHeight: 28,
    controlHeightSM: 24,
    fontSize: 13,
    fontFamily: '"Google Sans Flex", sans-serif',
    colorBorder: "#e0e0e0",
    colorPrimaryHover: "#bbb",
    colorPrimary: "#FE4D41",
    colorText: "#1a1a1a",
    colorTextPlaceholder: "#999",
    colorBgContainer: "#ffffff",
    motionDurationFast: "0s",
    motionDurationMid: "0s",
    motionDurationSlow: "0s",
  },
};

// Ported verbatim from FilterBuilderWindow.tsx's own copy -- same empty-
// state icon every Configure/viewer window in the app shares.
function LinkIcon() {
  return (
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.3 }}>
      <path opacity="0.4" d="M10.9999 7.5V16.5C10.9999 17.05 10.5499 17.5 9.99989 17.5H7.49989C5.97989 17.5 4.60989 16.88 3.60989 15.89C2.66989 14.94 2.05989 13.65 1.99989 12.22C1.87989 9.08 4.61989 6.5 7.76989 6.5H9.99989C10.5499 6.5 10.9999 6.95 10.9999 7.5Z" fill="#292D32" />
      <path opacity="0.4" d="M21.9998 11.78C22.1298 14.93 19.3898 17.5 16.2398 17.5H14.0098C13.4598 17.5 13.0098 17.05 13.0098 16.5V7.5C13.0098 6.95 13.4598 6.5 14.0098 6.5H16.5098C18.0298 6.5 19.3998 7.12 20.3998 8.11C21.3298 9.06 21.9398 10.35 21.9998 11.78Z" fill="#292D32" />
      <path d="M16 12.75H8C7.59 12.75 7.25 12.41 7.25 12C7.25 11.59 7.59 11.25 8 11.25H16C16.41 11.25 16.75 11.59 16.75 12C16.75 12.41 16.41 12.75 16 12.75Z" fill="#292D32" />
    </svg>
  );
}
function EmptyState() {
  return (
    <div className="filter-empty-state">
      <LinkIcon />
      <h3>No Data Connected</h3>
      <p>Connect a data table to add a computed column</p>
    </div>
  );
}

export default function AddColumnWindow() {
  const [payload, setPayload] = useState<AddColumnWindowPayload | null>(null);
  const [columnName, setColumnName] = useState("");
  const [formula, setFormula] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [popupPos, setPopupPos] = useState<{ left: number; top: number } | null>(null);
  const [hintPos, setHintPos] = useState<{ left: number; bottom: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const caretMarkerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: AddColumnWindowPayload) {
      if (!live) return;
      setPayload(p);
      setColumnName(p.initialParams.columnName ?? "");
      setFormula(p.initialParams.formula ?? "");
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestAddColumnInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onAddColumnInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Configure — ${payload.nodeName}` : "Configure Node";
  }, [payload]);

  const tokens = useMemo(() => tokenizeFormula(formula), [formula]);
  const renderParts = useMemo(() => splitTokensAtCursor(tokens, cursorPos), [tokens, cursorPos]);

  // What autocomplete context (if any) the cursor is currently sitting in
  // -- an unclosed [Column reference or a bare function-name-shaped word.
  // null means "just browsing", not actively typing either -- no popup,
  // and the reference list below shows every column same as always.
  const completionCtx = useMemo(
    () => getFormulaCompletionContext(formula, cursorPos),
    [formula, cursorPos],
  );
  const columns = payload?.columns ?? [];
  const activeSuggestions = useMemo(() => {
    if (completionCtx?.kind === "column") {
      const q = completionCtx.query.toLowerCase();
      return { kind: "column" as const, items: columns.filter((c) => c.toLowerCase().includes(q)) };
    }
    if (completionCtx?.kind === "function") {
      const q = completionCtx.query.toUpperCase();
      return { kind: "function" as const, items: FORMULA_FUNCTIONS.filter((f) => f.startsWith(q)) };
    }
    return null;
  }, [completionCtx, columns]);
  const popupVisible = !!activeSuggestions && activeSuggestions.items.length > 0;

  // Excel-style argument tooltip: which function call (if any) the cursor
  // is inside the parens of, and which argument position -- shown above
  // the caret (the autocomplete popup above already owns below-caret) any
  // time the cursor sits inside a KNOWN function's args, independent of
  // whether autocomplete is also active (e.g. typing a [Column inside
  // ROUND(...) wants both at once).
  const functionCallCtx = useMemo(() => getFunctionCallContext(formula, cursorPos), [formula, cursorPos]);
  const functionSignature = functionCallCtx ? FUNCTION_SIGNATURES[functionCallCtx.name] : undefined;
  const hintVisible = !!functionSignature;

  // Live syntax check -- backend/app/nodes.py's own grammar, re-walked
  // client-side (see validateFormula's own comment for why this doesn't
  // just re-run the real evaluator). Empty formula is never an "error"
  // here -- the Apply button's own disabled state already covers that.
  const validationError = useMemo(
    () => (formula.trim() ? validateFormula(formula, columns) : null),
    [formula, columns],
  );

  // Auto-reformat, ~3s after the user stops typing -- re-running (thus
  // restarting the 3s wait) on every `formula` change is the debounce
  // itself: the effect's own cleanup clears whatever timer the PREVIOUS
  // keystroke started before this one sets a new one, so the timeout body
  // only ever actually fires once typing has genuinely paused. Skips
  // entirely while validationError is set -- reformatting something the
  // parser itself can't make sense of has no correct spacing to apply
  // (see formatFormula's own comment), and would be actively confusing to
  // have the box silently rewrite itself out from under a mistake the
  // user hasn't finished fixing yet.
  useEffect(() => {
    if (validationError || !formula.trim()) return;
    const timer = setTimeout(() => {
      const formatted = formatFormula(formula);
      if (formatted === formula) return;
      const el = textareaRef.current;
      const oldCursor = el?.selectionStart ?? cursorPos;
      const newCursor = mapCursorAfterFormat(formula, oldCursor, formatted);
      setFormula(formatted);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(newCursor, newCursor);
        setCursorPos(newCursor);
      });
    }, 3000);
    return () => clearTimeout(timer);
  }, [formula, validationError]);

  // Reseat the selected suggestion to the top every time the actual
  // candidate list changes (a new keystroke narrowing/widening it) --
  // otherwise an old index could point past the end of a now-shorter list,
  // or silently keep some earlier item "selected" that isn't even the top
  // match for what's now typed.
  useEffect(() => { setSelectedIndex(0); }, [activeSuggestions?.items.join(" ")]);

  // Finds the caret's actual on-screen position by measuring the zero-
  // width marker span splitTokensAtCursor placed in the highlight overlay
  // at the same text offset -- the overlay is styled identically to the
  // textarea (font, padding, line-height, wrapping), so the marker sits
  // exactly where the real caret renders. Recomputed after every render
  // that could move the caret (new text, cursor moved, popup about to
  // show/hide) and on scroll, since the marker's viewport position shifts
  // with the textarea's own scroll position.
  const measurePositions = useCallback(() => {
    const marker = caretMarkerRef.current;
    const editor = textareaRef.current?.parentElement;
    if (!marker || !editor) { setPopupPos(null); setHintPos(null); return; }
    const markerRect = marker.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    setPopupPos(popupVisible ? { left: markerRect.left, top: Math.min(markerRect.bottom, editorRect.bottom) } : null);
    setHintPos(hintVisible ? { left: markerRect.left, bottom: window.innerHeight - Math.max(markerRect.top, editorRect.top) } : null);
  }, [popupVisible, hintVisible]);

  useLayoutEffect(() => { measurePositions(); }, [measurePositions, formula, cursorPos]);

  const syncHighlightScroll = useCallback(() => {
    const ta = textareaRef.current;
    const hl = highlightRef.current;
    if (ta && hl) {
      hl.scrollTop = ta.scrollTop;
      hl.scrollLeft = ta.scrollLeft;
      measurePositions();
    }
  }, [measurePositions]);

  // Inserts a suggestion at the formula's current cursor position --
  // replacing whatever partial [Column/function text triggered it
  // (completionCtx.from..cursorPos) when actively autocompleting, or just
  // inserting fresh at the cursor when browsing the static reference list
  // below (completionCtx null, the original click-to-insert behavior).
  const insertSuggestion = (kind: "column" | "function", text: string) => {
    const el = textareaRef.current;
    const insertText = kind === "column" ? `[${text}]` : `${text}(`;
    const from = completionCtx ? completionCtx.from : (el?.selectionStart ?? formula.length);
    const to = completionCtx ? cursorPos : (el?.selectionEnd ?? formula.length);
    const next = formula.slice(0, from) + insertText + formula.slice(to);
    setFormula(next);
    const newCursor = from + insertText.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(newCursor, newCursor);
      setCursorPos(newCursor);
    });
  };

  // Arrow keys move the popup's selection, Tab/Enter accept it -- same
  // keyset a real editor's autocomplete uses. Only intercepted while the
  // popup is actually showing, so plain Tab/Enter/arrows behave normally
  // (move focus, insert a newline, move the caret) the rest of the time.
  const handleFormulaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!popupVisible || !activeSuggestions) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => (i + 1) % activeSuggestions.items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => (i - 1 + activeSuggestions.items.length) % activeSuggestions.items.length);
    } else if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      insertSuggestion(activeSuggestions.kind, activeSuggestions.items[selectedIndex]);
    } else if (e.key === "Escape") {
      // Nothing to "close" (there's no separate open/closed state, the
      // popup just tracks completionCtx) -- but swallow it anyway so
      // Escape doesn't do whatever this native textarea would otherwise
      // do while a popup reads as open.
      e.preventDefault();
    }
  };

  const updateCursor = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    setCursorPos(e.currentTarget.selectionStart ?? 0);
  };

  if (!payload) return null;
  const showEmpty = payload.columns.length === 0;

  const handleApply = () => {
    const params: AddColumnParams = { columnName: columnName.trim(), formula: formula.trim() };
    window.alteraStudio.applyAddColumn({ nodeId: payload.nodeId, params });
  };

  return (
    <ConfigProvider theme={antTheme}>
      <div className="add-column-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="unique-app-outer">
            <div className="unique-app">
              <div className="unique-section">
                <div className="unique-section-label">New column name</div>
                <Input
                  value={columnName}
                  onChange={(e) => setColumnName(e.target.value)}
                  placeholder="e.g. Full Name"
                />
              </div>

              <div className="unique-section">
                <div className="unique-section-label">Formula</div>
                <div className={`formula-editor${validationError ? " formula-editor-error" : ""}`}>
                  <div ref={highlightRef} className="formula-editor-highlight" aria-hidden="true">
                    {renderParts.map((p) =>
                      p.kind === "caret"
                        ? <span key={p.key} ref={caretMarkerRef} className="formula-caret-marker" />
                        : <span key={p.key} className={`formula-token formula-token-${p.type}`}>{p.text}</span>,
                    )}
                  </div>
                  <textarea
                    ref={textareaRef}
                    className="formula-editor-textarea"
                    value={formula}
                    onChange={(e) => { setFormula(e.target.value); updateCursor(e); }}
                    onScroll={syncHighlightScroll}
                    onKeyDown={handleFormulaKeyDown}
                    onKeyUp={updateCursor}
                    onClick={updateCursor}
                    onSelect={updateCursor}
                    placeholder='e.g. UPPER([First Name]) + " " + [Last Name]'
                    spellCheck={false}
                  />
                  {popupVisible && popupPos && activeSuggestions && (
                    <div className="formula-autocomplete-popup" style={{ left: popupPos.left, top: popupPos.top }}>
                      {activeSuggestions.items.map((item, i) => (
                        <div
                          key={item}
                          className={`formula-autocomplete-item${i === selectedIndex ? " active" : ""}`}
                          onMouseDown={(e) => { e.preventDefault(); insertSuggestion(activeSuggestions.kind, item); }}
                          onMouseEnter={() => setSelectedIndex(i)}
                        >
                          {item}
                        </div>
                      ))}
                    </div>
                  )}
                  {hintVisible && hintPos && functionCallCtx && functionSignature && (
                    <div className="formula-hint-popup" style={{ left: hintPos.left, bottom: hintPos.bottom }}>
                      <span className="formula-hint-name">{functionCallCtx.name}</span>(
                      {functionSignature.params.map((param, i) => (
                        <span key={param}>
                          {i > 0 && ", "}
                          <span className={i === functionCallCtx.argIndex ? "formula-hint-arg-active" : "formula-hint-arg"}>{param}</span>
                        </span>
                      ))}
                      )
                      <div className="formula-hint-description">{functionSignature.description}</div>
                    </div>
                  )}
                </div>
                {validationError ? (
                  <p className="formula-error-hint">{validationError}</p>
                ) : (
                  <p className="change-type-hint">
                    Reference a column with [Column Name]. Operators: + − × ÷ (+ also joins text). Functions: UPPER, LOWER, TRIM, LEN, CONCAT, ROUND, LEFT, RIGHT, ABS. ↑↓ to choose, Tab/Enter to accept.
                  </p>
                )}
              </div>

              <div className="unique-section">
                <div className="unique-section-label">Click to insert a column</div>
                <div className="export-table-list add-column-ref-list">
                  {payload.columns.map((col) => (
                    <button key={col} className="add-column-ref-item" onClick={() => insertSuggestion("column", col)}>
                      {col}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeAddColumnWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty || !columnName.trim() || !formula.trim() || !!validationError}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
