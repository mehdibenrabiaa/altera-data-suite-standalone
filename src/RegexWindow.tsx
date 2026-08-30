import { useEffect, useMemo, useRef, useState } from "react";
import { ConfigProvider, Input, Select } from "antd";
import { AgGridReact } from "ag-grid-react";
import { ModuleRegistry, AllCommunityModule, themeQuartz, type ColDef, type GridApi, type ICellRendererParams } from "ag-grid-community";
import type { RegexParams, RegexMode } from "./types";
import type { RegexWindowPayload } from "./vite-env";
import "./App.css";

ModuleRegistry.registerModules([AllCommunityModule]);

// Configure window for the Regular Expressions node -- ported from the
// original regex.py widget (devkit/orangecontrib/custom/widgets/
// regex.py) and its process_regex_pattern helper (auxiliary_functions.py),
// minus the original's AI-assist (describe-it-in-English -> external
// license-gated API call -- no equivalent infrastructure exists here) and
// its dead preset library (shipped in the original's own backend but
// never wired into its own UI). Unlike every other Configure window in
// this app, this one keeps the original's live-preview grid -- testing a
// regex blind is genuinely painful, so seeing matches highlighted as you
// type is worth the extra build here. The highlighting itself is
// computed CLIENT-SIDE with JS's own RegExp (best-effort -- Python's `re`
// and JS's RegExp aren't perfectly identical in every edge case), purely
// for this live preview; the actual extraction that gets applied always
// runs authoritatively in Python on Apply (backend/app/nodes.py's
// extract_regex is the single source of truth for real behavior).
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

// Same theme/params as this app's other Configure/Browse grids
// (HeaderPromoterWindow.tsx's hpGridTheme, SchemaView.tsx's
// outputGridTheme, BrowseWindow.tsx's browseGridTheme).
const regexGridTheme = themeQuartz.withParams({
  headerBackgroundColor: "#f0f2f5",
  headerTextColor: "#333333",
  headerFontSize: 11,
  headerFontWeight: 600,
  cellFontSize: 11,
  fontSize: 11,
  borderColor: "#f0f0f0",
  borderRadius: 0,
  wrapperBorderRadius: 0,
  rowHeight: 26,
  headerHeight: 28,
  cellHorizontalPadding: 12,
  spacing: 4,
  backgroundColor: "#ffffff",
  oddRowBackgroundColor: "#ffffff",
  rowHoverColor: "#fff5f0",
  headerColumnResizeHandleColor: "#cccccc",
  headerColumnResizeHandleHeight: "60%",
  headerColumnResizeHandleWidth: 1,
});
const regexGridDefaultColDef: ColDef = { resizable: true, sortable: false, suppressMovable: true };
// Same Community-compatible row-number column as HeaderPromoterWindow.tsx's
// own makeRowNumberColDef (AG-Grid's `rowNumbers` grid option is
// Enterprise-only) -- widened by actual row count so it never truncates
// ("11…") past 2 digits.
function makeRowNumberColDef(rowCount: number): ColDef {
  const digits = String(Math.max(rowCount, 1)).length;
  return {
    colId: "__rowNumber",
    headerName: "",
    pinned: "left",
    width: 32 + digits * 10,
    resizable: false,
    sortable: false,
    suppressMovable: true,
    cellClass: "schema-row-number-cell",
    valueGetter: (params) => (params.node?.rowIndex ?? -1) + 1,
  };
}

// Capped so the live preview stays cheap even against a very large
// table -- matches the original's own PREVIEW_ROWS=500 cap. The real
// Apply always runs against the full table regardless.
const PREVIEW_ROWS = 500;

function EmptyState() {
  return (
    <div className="filter-empty-state">
      <svg width="52" height="52" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.3 }}>
        <path opacity="0.4" d="M10.9999 7.5V16.5C10.9999 17.05 10.5499 17.5 9.99989 17.5H7.49989C5.97989 17.5 4.60989 16.88 3.60989 15.89C2.66989 14.94 2.05989 13.65 1.99989 12.22C1.87989 9.08 4.61989 6.5 7.76989 6.5H9.99989C10.5499 6.5 10.9999 6.95 10.9999 7.5Z" fill="#292D32" />
        <path opacity="0.4" d="M21.9998 11.78C22.1298 14.93 19.3898 17.5 16.2398 17.5H14.0098C13.4598 17.5 13.0098 17.05 13.0098 16.5V7.5C13.0098 6.95 13.4598 6.5 14.0098 6.5H16.5098C18.0298 6.5 19.3998 7.12 20.3998 8.11C21.3298 9.06 21.9398 10.35 21.9998 11.78Z" fill="#292D32" />
        <path d="M16 12.75H8C7.59 12.75 7.25 12.41 7.25 12C7.25 11.59 7.59 11.25 8 11.25H16C16.41 11.25 16.75 11.59 16.75 12C16.75 12.41 16.41 12.75 16 12.75Z" fill="#292D32" />
      </svg>
      <h3>No Data Connected</h3>
      <p>Connect a data table to extract regex matches</p>
    </div>
  );
}

const MODE_OPTIONS: { value: RegexMode; label: string; description: string }[] = [
  { value: "smart_extract", label: "Smart Extract", description: "First match per cell. With capture groups, also adds one column per group." },
  { value: "precision_capture", label: "Precision Capture", description: "Only the capture-group values (no whole-match column), packed left to right." },
  { value: "greedy_collect", label: "Greedy Collect", description: "Every match per cell, one column per match position." },
];

// Escapes regex metacharacters -- JS has no built-in equivalent of
// Python's re.escape, mirrors backend/app/nodes.py's own use of
// re.escape for literal mode.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// JS's RegExp has no equivalent of Python's `re.compile(pattern).groups`
// (a plain int count of capturing groups) -- counts unescaped `(` that
// aren't a non-capturing/lookaround construct (`(?:`, `(?=`, `(?!`,
// `(?<=`, `(?<!`) and aren't inside a `[...]` character class, where `(`
// is a literal character, not group syntax. A named group (`(?<name>`)
// still counts as capturing in both languages, so it's deliberately NOT
// in the excluded-prefix list here.
function countCaptureGroups(source: string): number {
  let count = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") { i++; continue; }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") { inClass = true; continue; }
    if (c !== "(") continue;
    const next2 = source.slice(i + 1, i + 3);
    const next3 = source.slice(i + 1, i + 4);
    if (next2 === "?:" || next2 === "?=" || next2 === "?!" || next3 === "?<=" || next3 === "?<!") continue;
    count++;
  }
  return count;
}

// One output column extraction produces, with its per-row values -- see
// backend/app/nodes.py's extract_regex, which this mirrors exactly (same
// column-naming and value-packing rules per mode) so the preview shows
// precisely what Apply would actually create. Best-effort client-side
// (JS RegExp vs Python's `re`), same caveat as HighlightCell's own
// highlighting above.
interface ExtractedColumn {
  name: string;
  values: string[];
}
function computeExtractedColumns(
  values: string[],
  compiledPattern: RegExp | null,
  mode: RegexMode,
  newColumnBase: string,
): ExtractedColumn[] {
  if (!compiledPattern) return [];
  const base = newColumnBase || "Extracted";
  const numGroups = countCaptureGroups(compiledPattern.source);

  if (mode === "greedy_collect") {
    const flags = compiledPattern.flags.includes("g") ? compiledPattern.flags : compiledPattern.flags + "g";
    const globalRe = new RegExp(compiledPattern.source, flags);
    const allMatches = values.map((v) => {
      const found: string[] = [];
      globalRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = globalRe.exec(v)) !== null) {
        const groups = m.slice(1).filter(Boolean);
        found.push(groups.length > 0 ? groups.join(" ") : m[0]);
        if (m[0] === "") globalRe.lastIndex++; // avoid an infinite loop on a zero-width match
      }
      return found;
    });
    const maxLen = Math.max(0, ...allMatches.map((m) => m.length));
    const colNames = maxLen === 0 ? [base] : Array.from({ length: maxLen }, (_, i) => `${base}_${i + 1}`);
    return colNames.map((name, i) => ({ name, values: allMatches.map((m) => m[i] ?? "") }));
  }

  if (numGroups === 0) {
    // smart_extract or precision_capture with no groups -- just the
    // whole match, same as HighlightCell's own highlighted span.
    const values_ = values.map((v) => {
      const m = compiledPattern.exec(v);
      compiledPattern.lastIndex = 0;
      return m ? m[0] : "";
    });
    return [{ name: base, values: values_ }];
  }

  if (mode === "smart_extract") {
    // Wraps the WHOLE pattern in an extra outer group so the full match
    // becomes group 1 (col_names[0], named `base` not `base_group0`) and
    // the original groups shift to 2..N+1 -- exactly mirrors the
    // backend's own `re.compile(f"({pattern})")` trick.
    const fullRe = new RegExp(`(${compiledPattern.source})`, compiledPattern.flags);
    const colNames = [base, ...Array.from({ length: numGroups }, (_, i) => `${base}_group${i + 1}`)];
    const perCol: string[][] = colNames.map(() => []);
    for (const v of values) {
      fullRe.lastIndex = 0;
      const m = fullRe.exec(v);
      const groups = m ? m.slice(1) : new Array(colNames.length).fill("");
      groups.forEach((g, i) => perCol[i].push(g ?? ""));
    }
    return colNames.map((name, i) => ({ name, values: perCol[i] }));
  }

  // precision_capture with groups -- num_groups TOTAL columns (first
  // named `base`, not `base_group0`), values are the non-empty captured
  // groups packed left-to-right (an unmatched/empty group is dropped,
  // not left as a gap).
  const colNames = Array.from({ length: numGroups }, (_, i) => (i === 0 ? base : `${base}_group${i}`));
  const perCol: string[][] = colNames.map(() => []);
  for (const v of values) {
    compiledPattern.lastIndex = 0;
    const m = compiledPattern.exec(v);
    const found = m ? m.slice(1).filter((g) => g) : [];
    for (let i = 0; i < colNames.length; i++) perCol[i].push(found[i] ?? "");
  }
  return colNames.map((name, i) => ({ name, values: perCol[i] }));
}

function HighlightCell(props: ICellRendererParams) {
  const value = String(props.value ?? "");
  const re = (props.context as { compiledPattern: RegExp | null } | undefined)?.compiledPattern;
  if (!re) return <>{value}</>;
  re.lastIndex = 0;
  const m = re.exec(value);
  if (!m) return <>{value}</>;
  const start = m.index;
  const end = start + m[0].length;
  return (
    <>
      {value.slice(0, start)}
      <mark className="regex-match-highlight">{value.slice(start, end)}</mark>
      {value.slice(end)}
    </>
  );
}

export default function RegexWindow() {
  const [payload, setPayload] = useState<RegexWindowPayload | null>(null);
  const [column, setColumn] = useState("");
  const [pattern, setPattern] = useState("");
  const [mode, setMode] = useState<RegexMode>("smart_extract");
  const [literal, setLiteral] = useState(false);
  const [newColumnName, setNewColumnName] = useState("Extracted");
  const gridApiRef = useRef<GridApi | null>(null);

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: RegexWindowPayload) {
      if (!live) return;
      setPayload(p);
      setColumn(p.initialParams.column || p.columns[0] || "");
      setPattern(p.initialParams.pattern ?? "");
      setMode(p.initialParams.mode ?? "smart_extract");
      setLiteral(p.initialParams.literal ?? false);
      setNewColumnName(p.initialParams.newColumnName || "Extracted");
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestRegexInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onRegexInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Configure — ${payload.nodeName}` : "Configure Node";
  }, [payload]);

  const { compiledPattern, patternError } = useMemo(() => {
    if (!pattern) return { compiledPattern: null as RegExp | null, patternError: null as string | null };
    try {
      const source = literal ? escapeRegExp(pattern) : pattern;
      return { compiledPattern: new RegExp(source), patternError: null };
    } catch (e) {
      return { compiledPattern: null, patternError: e instanceof Error ? e.message : String(e) };
    }
  }, [pattern, literal]);

  const columnIndex = payload?.columns.indexOf(column) ?? -1;
  const previewRows = useMemo(() => (payload?.rows ?? []).slice(0, PREVIEW_ROWS), [payload]);
  const columnValues = useMemo(
    () => previewRows.map((row) => (columnIndex >= 0 ? (row[columnIndex] ?? "") : "")),
    [previewRows, columnIndex],
  );
  // What Apply would actually produce -- computed separately from
  // `rowData` below (not baked directly into it) to avoid a circular
  // dependency, since rowData itself needs to fold these back in per row.
  const extractedColumns = useMemo(
    () => computeExtractedColumns(columnValues, compiledPattern, mode, newColumnName),
    [columnValues, compiledPattern, mode, newColumnName],
  );
  const rowData = useMemo(
    () => columnValues.map((value, i) => {
      const row: Record<string, string | number> = { __rowIdx: i, value };
      extractedColumns.forEach((col, ci) => { row[`__ext${ci}`] = col.values[i] ?? ""; });
      return row;
    }),
    [columnValues, extractedColumns],
  );
  const matchCount = useMemo(() => {
    if (!compiledPattern) return 0;
    let n = 0;
    for (const value of columnValues) {
      compiledPattern.lastIndex = 0;
      if (compiledPattern.test(value)) n++;
    }
    return n;
  }, [columnValues, compiledPattern]);

  const colDefs = useMemo<ColDef[]>(
    () => [
      makeRowNumberColDef(rowData.length),
      { field: "value", headerName: column || "Column", cellRenderer: HighlightCell },
      // The newly extracted column(s) -- exactly what Apply would add,
      // named/ordered the same way (see computeExtractedColumns above).
      ...extractedColumns.map((col, i): ColDef => ({
        field: `__ext${i}`,
        headerName: col.name,
        cellClass: "regex-extracted-cell",
      })),
    ],
    [rowData.length, column, extractedColumns],
  );
  const gridContext = useMemo(() => ({ compiledPattern }), [compiledPattern]);

  // cellRenderer components read `context` on their own render pass, not
  // as a React prop that naturally re-renders them -- same "context
  // changed, ask the grid to redraw" nudge HeaderPromoterWindow.tsx's own
  // rowClassRules effect uses.
  useEffect(() => {
    gridApiRef.current?.redrawRows();
  }, [gridContext]);

  if (!payload) return null;
  const showEmpty = payload.columns.length === 0;

  const handleApply = () => {
    const params: RegexParams = { column, pattern, mode, literal, newColumnName };
    window.alteraStudio.applyRegex({ nodeId: payload.nodeId, params });
  };

  return (
    <ConfigProvider theme={antTheme}>
      <div className="regex-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="regex-body">
            <div className="regex-sidebar">
              <div className="regex-ctrl-section">
                <div className="regex-ctrl-label">Column</div>
                <Select
                  value={column || undefined}
                  onChange={setColumn}
                  options={payload.columns.map((c) => ({ value: c, label: c }))}
                  placeholder="Select a column…"
                  style={{ width: "100%" }}
                />
              </div>

              <div className="regex-ctrl-section">
                <div className="regex-ctrl-label">Pattern</div>
                <Input
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder={String.raw`e.g. \d{3}-\d{4}`}
                  className="regex-pattern-input"
                />
                <label className="regex-checkbox-row">
                  <input type="checkbox" checked={literal} onChange={(e) => setLiteral(e.target.checked)} />
                  <span>Literal text (no regex)</span>
                </label>
                {patternError && <p className="regex-error">Invalid pattern: {patternError}</p>}
                {!patternError && pattern && (
                  <p className="regex-status">
                    {matchCount} of {rowData.length} row{rowData.length === 1 ? "" : "s"} matched
                    {(payload.rows.length > PREVIEW_ROWS) ? " (preview)" : ""}
                  </p>
                )}
              </div>

              <div className="regex-ctrl-section">
                <div className="regex-ctrl-label">Output column name</div>
                <Input value={newColumnName} onChange={(e) => setNewColumnName(e.target.value)} placeholder="Extracted" />
              </div>

              <div className="regex-ctrl-section">
                <div className="regex-ctrl-label">Extraction mode</div>
                <div className="match-toggle regex-mode-toggle">
                  {MODE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      className={`match-toggle-btn${mode === opt.value ? " active" : ""}`}
                      onClick={() => setMode(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="regex-mode-desc">{MODE_OPTIONS.find((o) => o.value === mode)?.description}</p>
              </div>
            </div>
            <div className="regex-grid-wrap">
              <AgGridReact
                theme={regexGridTheme}
                rowData={rowData}
                columnDefs={colDefs}
                defaultColDef={regexGridDefaultColDef}
                context={gridContext}
                suppressFieldDotNotation
                onGridReady={(e) => { gridApiRef.current = e.api; }}
              />
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeRegexWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty || !column || !pattern || !!patternError}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
