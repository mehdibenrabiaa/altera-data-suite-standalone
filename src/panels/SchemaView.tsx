import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Controls,
  Handle,
  Position,
  SelectionMode,
  applyNodeChanges,
  getNodesBounds,
  getBezierPath,
  BaseEdge,
  EdgeToolbar,
  useStore,
  useViewport,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type NodeChange,
  type NodeMouseHandler,
  type EdgeProps,
  type EdgeChange,
  type ReactFlowInstance,
  type ReactFlowState,
  type ConnectionLineComponentProps,
  type FinalConnectionState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Spin } from "antd";
import { LoadingOutlined } from "@ant-design/icons";
import { AgGridReact } from "ag-grid-react";
import { ModuleRegistry, AllCommunityModule, themeQuartz, type ColDef } from "ag-grid-community";
import type { Rectangle, Group, SchemaPreviewTable, ProcessorNodeInstance, FilterBuilderParams, FilterColumnDefinition, HeaderPromoterParams, MergeParams, ShiftColumnsParams, CleanerParams, UniqueParams, ColumnEditParams, ChangeTypeParams, RegexParams, NodeLogEntry } from "../types";
import { computeDefaultMatchPair } from "../mergeDefaults";
import {
  NODE_DRAG_MIME,
  CATEGORY_META,
  CATEGORY_ORDER,
  NODE_CATALOG,
  toDraggedNodeEntry,
  type DraggedNodeEntry,
} from "../nodeCatalog";
import { runProcessorNode, type NodeTableInput } from "../nodeExecution";
import { detectColumnType, DETECTION_SAMPLE_ROWS } from "../columnTypeDetection";
import { TypedColumnHeader } from "../columnTypeIcons";

// Catalog widget names that actually have a wired-up backend transform
// (backend/app/nodes.py's NODE_TRANSFORMS registry) -- gates the "Run"
// context-menu item so it only appears on nodes that can really execute.
// Extend both maps together as more real nodes come online.
const RUNNABLE_NODE_KINDS = new Set(["Horizontal Stack", "Filter Builder", "Header Promoter", "Index Column", "Merge", "Shift Columns", "Cleaner", "Unique", "Column Edit", "Change Type", "Regular Expressions"]);
const NODE_KIND_SLUGS: Record<string, string> = {
  "Horizontal Stack": "horizontal_stack",
  "Filter Builder": "filter_builder",
  "Header Promoter": "header_promoter",
  "Index Column": "index_column",
  "Merge": "merge_data",
  "Shift Columns": "shift_columns",
  "Cleaner": "clean_columns",
  "Unique": "deduplicate_rows",
  "Column Edit": "column_edit",
  "Change Type": "change_type",
  "Regular Expressions": "extract_regex",
};
// Minimum resolved (primary) inputs a kind needs before it's worth
// running -- Horizontal Stack needs 2+ tables to combine, Filter Builder
// only ever filters a single primary table (its Extra Data input is
// optional and resolved separately, see resolveExtraDataInput), Header
// Promoter likewise only ever promotes a row within a single table, Index
// Column likewise only ever numbers the rows of a single table. Merge
// also only needs its single primary input resolved here -- its second
// table comes through the Extra Data port and is checked separately by
// the backend (merge_data raises if fewer than 2 tables arrive). Shift
// Columns, Cleaner, Unique, Column Edit, Change Type, and Regular
// Expressions likewise only ever transform a single table.
const NODE_MIN_INPUTS: Record<string, number> = { "Horizontal Stack": 2, "Filter Builder": 1, "Header Promoter": 1, "Index Column": 1, "Merge": 1, "Shift Columns": 1, "Cleaner": 1, "Unique": 1, "Column Edit": 1, "Change Type": 1, "Regular Expressions": 1 };

// Catalog widget names with their own dedicated window -- every node here
// gets a real separate BrowserWindow (see FilterBuilderWindow.tsx/
// BrowseWindow.tsx and electron/main.ts's filterBuilder:*/browse:* IPC
// handlers), not an in-page modal; this is this app's established
// pattern for ANY node with its own UI, not a special case for just one
// node. Gates the context-menu item and the icon's double-click handler
// the same way RUNNABLE_NODE_KINDS gates "Run". The label shown in the
// context menu differs per kind (Filter Builder edits rules, Browse just
// views data), so it's threaded through this same map rather than a
// separate lookup.
const NODE_WINDOW_LABEL: Record<string, string> = {
  "Filter Builder": "Configure…",
  "Browse": "Browse Data…",
  "Header Promoter": "Configure…",
  "Merge": "Configure…",
  "Shift Columns": "Configure…",
  "Cleaner": "Configure…",
  "Unique": "Configure…",
  "Column Edit": "Configure…",
  "Change Type": "Configure…",
  "Regular Expressions": "Configure…",
};
const NODE_KINDS_WITH_WINDOW = new Set(Object.keys(NODE_WINDOW_LABEL));

// Column "type" for a Configure dialog's per-column operator/value-editor
// choice -- mirrors the original widget's build_columns_json_for_filter
// (devkit/orangecontrib/custom/widgets/auxiliary_functions.py), which
// reads this straight off the Orange Domain (ContinuousVariable ->
// "float", DiscreteVariable -> "categorical", else "text"). This app has
// no Domain and, for now, no column-type system at all: every table
// card's columns are plain strings until a future node lets the user
// explicitly convert one ("float"/"categorical" stay real, reachable
// FilterColumnDefinition/operator-set variants for when that lands --
// just never produced here yet). Guessing a type from the raw values
// instead (an earlier version of this function did exactly that) was the
// actual bug behind "Contains" sometimes missing from the operator list:
// a perfectly ordinary string column with a few repeated values (a
// status flag, a category) would get silently reclassified as
// "categorical", which only offers Equals/Not equals.
function inferColumnDefinition(name: string, values: string[]): FilterColumnDefinition {
  const nonEmpty = values.map((v) => v.trim()).filter((v) => v !== "");
  const unique = Array.from(new Set(nonEmpty)).sort();
  // One deliberate exception: "Page" isn't user data -- it's a column the
  // backend always injects itself (backend/app/extraction.py's
  // `df["Page"] = page_num`, appended as a real trailing column on every
  // extracted table), always genuinely numeric. Checking the COLUMN NAME
  // rather than the values -- guessing types from values is exactly what
  // caused the Contains bug above, but "Page" is reserved/backend-owned,
  // not something a real extracted column could coincidentally collide
  // with the way an ordinary low-cardinality text column did.
  if (name === "Page") return { name, type: "float" };
  return { name, type: "text", values: unique.slice(0, 100) };
}

ModuleRegistry.registerModules([AllCommunityModule]);

const MAX_OUTPUT_SLOTS = 20;

// Spacebar press/release faster than this counts as a "tap" (opens the node
// picker) rather than a "hold" (temporary pan) -- see the spacePanning
// effect below.
const SPACE_TAP_MAX_MS = 300;

// Fixed size the quick-add node picker is styled at (see .schema-node-picker
// in App.css) -- used to clamp its open position against the canvas edges
// before it's mounted (and thus before it has a real measured size).
const NODE_PICKER_WIDTH = 240;
const NODE_PICKER_MAX_HEIGHT = 360;

const DRAWER_MIN_HEIGHT = 120;
const DRAWER_DEFAULT_HEIGHT = 260;
const DRAWER_MAX_HEIGHT = 640;
// However tall the wrapper is, always leave at least this much canvas
// showing above the drawer -- keeps the resize handle (and the toggle
// button right below it) from ever being pushed off screen.
const MIN_VISIBLE_CANVAS = 120;

// Flat/dense theme matching the app's chrome -- same params the card's own
// table preview used before it was dropped in favor of this drawer.
const outputGridTheme = themeQuartz.withParams({
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
  // Default AG-Grid resize-handle sizing, just recolored -- the house
  // accent at the earlier 3px width read as thick/out of place.
  headerColumnResizeHandleColor: "#cccccc",
  headerColumnResizeHandleHeight: "60%",
  headerColumnResizeHandleWidth: 1,
});

// Fully static -- hoisted out of JSX so it's the same object reference on
// every render (a fresh `{...}` literal there wouldn't itself force a
// row-model re-diff the way a new `rowData` reference does, but it's the
// same cheap-to-avoid churn as the rest of the fixes just above).
const outputGridDefaultColDef: ColDef = { resizable: true, sortable: false, suppressMovable: true };
// AG-Grid's own Excel-style row-number column (the `rowNumbers` grid
// option) is an Enterprise-only feature -- this project only has the
// Community package, so a plain pinned column reading the row's own index
// is the standard Community-compatible way to get the same look. A fixed
// width truncated ("11…") once row numbers grew past 2 digits -- widening
// with the actual row count (same as Excel's own row gutter) instead of
// guessing one static width that's wrong for most tables.
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

// ── Group box layout constants ──────────────────────────────────────────
// Cards/boxes don't have a real measured size until after their first
// render (React Flow's own ResizeObserver populates node.measured
// asynchronously) -- these are first-paint fallbacks used only until real
// measurements land, matching the same pattern tryFitView already uses
// below for its own "wait until measured" polling.
const CARD_ESTIMATED_WIDTH = 240;
const CARD_ESTIMATED_HEIGHT = 180;
// A processor node's own icon square (.schema-processor-node-core in
// App.css) -- fixed size, always the first, top, horizontally-centered
// child of the node's outer flex column (name/description stack below
// it, and can be wider than this if the text is long). Used by
// getAbsoluteRect below to align/distribute processor nodes by their icon
// alone, not by node.measured's full outer box (which would include the
// text and throw off centering whenever a node's name/description is
// wider than 42px).
const PROCESSOR_NODE_CORE_SIZE = 42;
const GROUP_BOX_HEADER_HEIGHT = 32;
const GROUP_BOX_PADDING = 16;
const GROUP_BOX_MEMBER_GAP = 16;

// Recomputes boxNode's width/height AND its own position so its padded
// content area exactly bounds `children` (whose `position` is relative to
// boxNode) -- used after a card drag, where cards are no longer clamped to
// stay inside their box (see the `extent` note on tableNode below), so the
// box must instead grow/shrink around wherever its members ended up. The
// box is shifted by the same delta applied with the opposite sign to every
// child's relative position, which keeps each child's ABSOLUTE screen
// position unchanged -- the box appears to grow around the drop, not the
// card jumping to stay inside a fixed box.
function fitBoxToChildren(boxNode: Node, children: Node[]): { box: Node; childDelta: { x: number; y: number } } {
  if (children.length === 0) {
    return {
      box: { ...boxNode, width: 260, height: GROUP_BOX_HEADER_HEIGHT + GROUP_BOX_PADDING * 2 },
      childDelta: { x: 0, y: 0 },
    };
  }
  const bounds = getNodesBounds(
    children.map((c) => ({
      ...c,
      width: c.width ?? c.measured?.width ?? CARD_ESTIMATED_WIDTH,
      height: c.height ?? c.measured?.height ?? CARD_ESTIMATED_HEIGHT,
    })),
  );
  const deltaX = GROUP_BOX_PADDING - bounds.x;
  const deltaY = GROUP_BOX_HEADER_HEIGHT + GROUP_BOX_PADDING - bounds.y;
  return {
    box: {
      ...boxNode,
      position: { x: boxNode.position.x - deltaX, y: boxNode.position.y - deltaY },
      width: bounds.width + GROUP_BOX_PADDING * 2,
      height: bounds.height + GROUP_BOX_HEADER_HEIGHT + GROUP_BOX_PADDING * 2,
    },
    childDelta: { x: deltaX, y: deltaY },
  };
}

// Orders a set of processor-node ids so every node comes after everything
// it depends on (Kahn's algorithm) -- used to run the whole pipeline
// strictly one node at a time, in an order the user can actually follow
// (see the sequential run queue below, and NodeStatusLights' red/amber/
// green cycle, which only reads as "the pipeline is executing in order"
// if runs genuinely never overlap). Nodes with no dependency relationship
// between them (independent branches, both eligible at the same point)
// break ties by canvas Y position, top to bottom -- same convention
// resolveNodeInputs already uses for a single node's own multiple inputs.
function topologicalRunOrder(nodeIds: string[], edges: Edge[], nodesForPosition: Node[]): string[] {
  const idSet = new Set(nodeIds);
  const inDegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const dependents = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    dependents.get(e.source)!.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }
  const posY = new Map(nodesForPosition.map((n) => [n.id, n.position.y]));
  const remaining = new Set(nodeIds);
  const ready = nodeIds.filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (posY.get(a) ?? 0) - (posY.get(b) ?? 0));
    const id = ready.shift()!;
    if (!remaining.has(id)) continue;
    remaining.delete(id);
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const left = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, left);
      if (left === 0 && remaining.has(next)) ready.push(next);
    }
  }
  // Only reachable via a cycle, which the canvas can't actually produce
  // (xyflow connections are one-directional and this app never lets an
  // edge close a loop back on itself) -- appended as-is just so no node
  // silently never runs if one somehow got through.
  for (const id of nodeIds) if (remaining.has(id)) order.push(id);
  return order;
}

type AlignIconMode = "hcenter" | "vcenter" | "distH" | "distV";

// Compact icon set for the align/distribute toolbar -- a few solid bars
// (plus a dashed guide line for the align modes) representing objects being
// aligned/distributed, consistent with NodeModeToggleIcon's stroke-icon style.
function AlignIcon({ mode }: { mode: AlignIconMode }) {
  const BARS: Record<AlignIconMode, { x: number; y: number; w: number; h: number }[]> = {
    hcenter: [{ x: 3, y: 1, w: 5, h: 1.6 }, { x: 1.5, y: 4.7, w: 8, h: 1.6 }, { x: 4, y: 8.4, w: 3, h: 1.6 }],
    vcenter: [{ x: 1, y: 3, w: 1.6, h: 5 }, { x: 4.7, y: 1.5, w: 1.6, h: 8 }, { x: 8.4, y: 4, w: 1.6, h: 3 }],
    distH:   [{ x: 0.5, y: 3, w: 1.8, h: 5 }, { x: 4.6, y: 3, w: 1.8, h: 5 }, { x: 8.7, y: 3, w: 1.8, h: 5 }],
    distV:   [{ x: 3, y: 0.5, w: 5, h: 1.8 }, { x: 3, y: 4.6, w: 5, h: 1.8 }, { x: 3, y: 8.7, w: 5, h: 1.8 }],
  };
  const GUIDES: Partial<Record<AlignIconMode, { x1: number; y1: number; x2: number; y2: number }>> = {
    hcenter: { x1: 5.5, y1: 0, x2: 5.5, y2: 11 },
    vcenter: { x1: 0, y1: 5.5, x2: 11, y2: 5.5 },
  };
  const guide = GUIDES[mode];
  return (
    <svg width="12" height="12" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="0.8">
      {guide && <line {...guide} strokeDasharray="1.4 1" opacity="0.6" />}
      {BARS[mode].map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill="currentColor" stroke="none" />
      ))}
    </svg>
  );
}

interface TableNodeData {
  name: string;
  color: string;
  columns: string[];
  rowCount?: number;
  // Keyed by the ORIGINAL extracted column name (matches `columns` above),
  // never by whatever's currently displayed -- so renaming an already-
  // renamed column a second time still overwrites the same entry instead
  // of orphaning it. See Rectangle.columnRenames in types.ts.
  columnRenames?: Record<string, string>;
  onRenameColumn?: (originalCol: string, newName: string) => void;
  [key: string]: unknown;
}

// Double-click a column name to rename it in place -- Enter/blur commits,
// Escape cancels. Local to one row so only the row being edited re-renders.
function TableColumnRow({ original, display, onRename }: { original: string; display: string; onRename?: (originalCol: string, newName: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(display);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(display);
      // Focus after the input has actually mounted, and select its text so
      // typing immediately replaces it (same "ready to type over" feel as
      // renaming a layer/table elsewhere in the app).
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, display]);

  const commit = () => {
    setEditing(false);
    onRename?.(original, draft);
  };

  if (editing) {
    return (
      <div className="schema-table-column-row editing nodrag">
        <input
          ref={inputRef}
          className="schema-column-name-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  }
  return (
    <div
      className="schema-table-column-row"
      onDoubleClick={(e) => {
        // Without this, the double-click bubbles up to react-flow's own
        // pane, which zooms in on double-click by default (zoomOnDoubleClick)
        // -- same reason the editing branch's wrapper above carries nodrag.
        e.stopPropagation();
        if (onRename) setEditing(true);
      }}
    >
      <span className="schema-column-name">{display}</span>
      {onRename && (
        <button
          type="button"
          className="schema-column-rename-btn nodrag"
          title="Rename column"
          onClick={(e) => {
            // Same stopPropagation reasoning as the double-click above --
            // a plain click landing on the pane (if it ever bubbled that
            // far) would otherwise be read as a canvas click, not a rename.
            e.stopPropagation();
            setEditing(true);
          }}
        >
          <img src="/pen-line.svg" alt="" width={12} height={12} />
        </button>
      )}
    </div>
  );
}

// Cards-only for now -- the table-preview/column-rename mode this used to
// toggle into is dropped pending a proper replacement. A table card is
// only ever a data source, never a destination, so it gets an output
// handle only -- no input side (see ProcessorNode for the in+out case).
function TableNode({ data }: NodeProps<Node<TableNodeData>>) {
  return (
    <div className="schema-table-card node-port-anchor">
      <div className="schema-table-header" style={{ borderLeftColor: data.color }}>
        <span className="schema-table-dot" style={{ background: data.color }} />
        <span className="schema-table-name">{data.name}</span>
      </div>
      {data.rowCount !== undefined && (
        <div className="schema-table-meta">{data.rowCount} row{data.rowCount === 1 ? "" : "s"} (sample)</div>
      )}
      <div className="schema-table-columns">
        {data.columns.map((col) => (
          <TableColumnRow
            key={col}
            original={col}
            display={data.columnRenames?.[col] ?? col}
            onRename={data.onRenameColumn}
          />
        ))}
      </div>
      <Handle type="source" position={Position.Right} className="node-port-triangle node-port-triangle-out" />
    </div>
  );
}

interface GroupBoxNodeData {
  name: string;
  groupId: string;
  [key: string]: unknown;
}

// A container box mirroring a canvas Group (Layers-panel folder) -- purely
// visual/read-only here: member table cards are clamped inside it
// (extent: 'parent' on the child node) but can't be dragged out, since
// group membership is only ever changed from the Layers panel itself.
function GroupBoxNode({ data }: NodeProps<Node<GroupBoxNodeData>>) {
  return (
    <div className="schema-group-box">
      <div className="schema-group-box-header">{data.name}</div>
    </div>
  );
}

interface ProcessorNodeData {
  name: string;
  // The catalog widget kind (e.g. "Horizontal Stack") -- distinct from
  // `name`, which is the user-editable display override. Needed here (not
  // just on the underlying ProcessorNodeInstance in App.tsx) so this
  // component can tell whether it's a runnable kind, for the KNIME-style
  // status lights below.
  catalogName: string;
  icon: string;
  color: string;
  hasOutput?: boolean;
  hasExtraInput?: boolean;
  description?: string;
  [key: string]: unknown;
}

// KNIME-style status light: three small dots below the node, only one lit
// at a time -- red (not yet executed, or the last run errored), amber
// (currently executing, pulsing), green (executed). Only rendered for
// nodes whose catalog kind actually has a wired-up backend transform (see
// RUNNABLE_NODE_KINDS) -- a node that can't run yet shouldn't show a
// status light implying it can.
// SVG circles rather than CSS border-radius divs -- a <circle> renders in
// one pass within its own viewBox coordinate system, immune to the
// "hollow ring's 1px border becomes a sub-pixel stroke under the canvas's
// zoom transform, anti-aliasing unevenly around the circumference" issue
// a CSS box's border-radius + border can hit at this size.
function StatusLightDot({ variant, lit }: { variant: "red" | "amber" | "green"; lit: boolean }) {
  return (
    <svg width="6" height="6" viewBox="0 0 6 6" className={`schema-processor-node-light ${variant}${lit ? " lit" : ""}`}>
      <circle cx="3" cy="3" r="2.5" />
    </svg>
  );
}
function NodeStatusLights({ status }: { status: ProcessorRunStatus | undefined }) {
  const lit = status?.state === "running" ? "running" : status?.state === "done" ? "done" : "idle";
  return (
    <div className="schema-processor-node-lights nodrag" title={status?.state === "error" ? status.error : undefined}>
      <StatusLightDot variant="red" lit={lit === "idle"} />
      <StatusLightDot variant="amber" lit={lit === "running"} />
      <StatusLightDot variant="green" lit={lit === "done"} />
    </div>
  );
}

// Lets a processor node's right-click context menu (rendered by SchemaView,
// well outside the individual node component) trigger that specific node's
// own inline rename/description editor -- avoids routing per-keystroke
// editing state through `data` (which is only rebuilt by the nodes-building
// effect on much coarser changes, see that effect's comment) and avoids
// threading callbacks through every intermediate node/prop.
const ProcessorNodeEditContext = createContext<{
  editingId: string | null;
  editingField: "name" | "description" | null;
  commitName: (id: string, name: string) => void;
  commitDescription: (id: string, description: string) => void;
  cancelEdit: () => void;
} | null>(null);

// Per-node Run status (see handleRunProcessorNode below), read by
// ProcessorNode for its spinner/error-outline states. A Context rather than
// routing through `data` for the same reason as ProcessorNodeEditContext:
// `data` is only rebuilt by the nodes-building effect on much coarser
// changes, and a status flip (idle -> running -> done) happening far more
// often than that would either force that whole effect to re-run constantly
// or just never reach the node. Read-only (Run itself is only ever
// triggered from the ancestor-rendered context menu), so no actions here.
// `info` is a third, neutral tier alongside `warnings` -- e.g. Filter
// Builder reports one when a valid rule still matches 0 rows (not a
// problem, just worth knowing).
type ProcessorRunStatus = { state: "idle" | "running" | "error" | "done"; error?: string; warnings?: string[]; info?: string[] };
const ProcessorNodeRunContext = createContext<Record<string, ProcessorRunStatus>>({});

// Lets a configurable node's icon (double-click) open its Configure window
// without threading handleOpenFilterBuilder through `data` -- same
// one-callback-via-Context reasoning as EdgeDeleteContext.
const ProcessorNodeConfigureContext = createContext<{ onConfigure: (id: string) => void } | null>(null);

// KNIME-style corner badge on a runnable node's icon: red "x" for a run that
// failed outright, amber triangle for a run that succeeded but reported
// warnings (e.g. Horizontal Stack's row-count-padding notice), blue "!" for
// a neutral note that isn't a problem. Hovering shows the message(s) as a
// tooltip -- same role as KNIME's own node badge, a short pointer at detail
// rather than the detail itself. A node can only be in one terminal state at
// a time here, so these never need to be arbitrated against each other --
// error beats warning beats info simply by checking in that order.
//
// Each variant is a single alert_*.svg file (dropped into public/, own
// circle background + glyph baked in) rendered as a plain <img> -- `title`
// gives the same hover tooltip a native <img title> does. Sized/positioned
// by .schema-processor-node-badge in App.css (18px, keep both in sync if
// this ever changes again).
function ErrorBadgeSvg({ title }: { title?: string }) {
  return <img src="/alert_red.svg" title={title} alt="Error" className="schema-processor-node-badge nodrag" width={18} height={18} />;
}
function WarningBadgeSvg({ title }: { title?: string }) {
  return <img src="/alert_yellow.svg" title={title} alt="Warning" className="schema-processor-node-badge nodrag" width={18} height={18} />;
}
function InfoBadgeSvg({ title }: { title?: string }) {
  return <img src="/alert_blue.svg" title={title} alt="Info" className="schema-processor-node-badge nodrag" width={18} height={18} />;
}
function NodeMessageBadge({ status }: { status: ProcessorRunStatus | undefined }) {
  if (status?.state === "error") {
    return <ErrorBadgeSvg title={status.error} />;
  }
  if (status?.state === "done" && status.warnings?.length) {
    return <WarningBadgeSvg title={status.warnings.join("\n")} />;
  }
  if (status?.state === "done" && status.info?.length) {
    return <InfoBadgeSvg title={status.info.join("\n")} />;
  }
  return null;
}

// A placeholder instance of a catalog widget (see NodesPanel.tsx), dropped
// or click-added onto the canvas. Real xyflow Handles so these can
// eventually be wired into edges once real data flow exists -- styled via
// the same .node-port-triangle classes the Nodes-panel tiles use (see
// App.css), so the connector glyph reads identically in both places.
function ProcessorNode({ id, data }: NodeProps<Node<ProcessorNodeData>>) {
  const editCtx = useContext(ProcessorNodeEditContext);
  const isEditingName = editCtx?.editingId === id && editCtx.editingField === "name";
  const isEditingDescription = editCtx?.editingId === id && editCtx.editingField === "description";
  const runStatus = useContext(ProcessorNodeRunContext)[id];
  const configureCtx = useContext(ProcessorNodeConfigureContext);

  const [nameDraft, setNameDraft] = useState(data.name);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (isEditingName) {
      setNameDraft(data.name);
      requestAnimationFrame(() => nameInputRef.current?.select());
    }
  }, [isEditingName, data.name]);

  const [descDraft, setDescDraft] = useState(data.description ?? "");
  const descInputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (isEditingDescription) {
      setDescDraft(data.description ?? "");
      requestAnimationFrame(() => descInputRef.current?.focus());
    }
  }, [isEditingDescription, data.description]);

  return (
    // This outer element's own size is now just its icon (+ status lights,
    // if runnable) -- name/description live in their own absolutely
    // positioned wrapper below (.schema-processor-node-labels) precisely
    // so growing text can never affect it. The connector handles live on
    // their own further-nested fixed-size wrapper sized to exactly the
    // icon (see .schema-processor-node-core in App.css) for the same
    // original reason this comment used to describe: anchoring them to
    // THIS element's edges instead would drag them sideways whenever it
    // grew (the "arrows moved away" bug from the first, incomplete fix) --
    // now doubly moot since this element doesn't grow with text at all.
    <div
      className="schema-processor-node"
      onDoubleClick={(e) => {
        // Without this, the double-click bubbles up to react-flow's own
        // pane, which zooms in on double-click by default
        // (zoomOnDoubleClick) -- the zoom would win the race on some
        // clicks, swallowing this one and requiring a second double-click
        // to actually open the node's window. Same fix as
        // TableColumnRow's rename double-click above. Lives on the WHOLE
        // node (not just the icon below) since the name/description text
        // has no double-click handler of its own -- a double-click
        // landing there instead of the icon used to fall straight through
        // to the pane every time.
        e.stopPropagation();
        if (NODE_KINDS_WITH_WINDOW.has(data.catalogName)) configureCtx?.onConfigure(id);
      }}
    >
      <div className="schema-processor-node-core node-port-anchor">
        <Handle type="target" position={Position.Left} className="node-port-triangle node-port-triangle-in" />
        {/* A second, square-shaped input -- visually distinct from the
            regular arrow so it doesn't read as "just another data input":
            it's Filter Builder's "Extra Data" port, used for the
            extra_ref condition value ("match against a column in this
            other table"), not another table to filter alongside the
            primary one. Its own id ("extra") is what lets
            resolveExtraDataInput below tell its edges apart from the
            primary input's. */}
        {data.hasExtraInput && (
          <Handle type="target" position={Position.Left} id="extra" className="node-port-square node-port-square-in" title="Extra Data" />
        )}
        <div
          className="node-icon-tile schema-processor-node-icon"
          style={{ background: data.color }}
        >
          {/* Same fix as NodesPanel's tile icon -- an <img> is natively
              draggable by default, which would otherwise fight React
              Flow's own pointer-based node dragging when a drag starts
              right on the icon. */}
          <img src={data.icon} alt="" draggable={false} />
        </div>
        {data.hasOutput !== false && (
          <Handle type="source" position={Position.Right} className="node-port-triangle node-port-triangle-out" />
        )}
        {RUNNABLE_NODE_KINDS.has(data.catalogName) && <NodeMessageBadge status={runStatus} />}
      </div>
      {RUNNABLE_NODE_KINDS.has(data.catalogName) && <NodeStatusLights status={runStatus} />}
      {/* Absolutely positioned (see .schema-processor-node-labels in
          App.css) so the name/description text -- which can be much wider
          than the 42px icon once it wraps -- never inflates THIS node's
          own measured size. That size feeds React Flow's marquee
          selection (getNodesInside/nodeToRect, always uses node.measured
          once mounted) and this file's own align/distribute math
          (getAbsoluteRect) alike; before this, a marquee drawn only over
          a node's name/description (nowhere near its icon) still selected
          it, and align/distribute centered on the icon+text box instead
          of the icon alone. Still a normal DOM descendant of this node
          (just not one that contributes to its layout box), so the
          double-click-to-configure handler above still fires normally
          when it's clicked. */}
      <div className="schema-processor-node-labels">
        {isEditingName ? (
          <input
            ref={nameInputRef}
            className="schema-processor-node-name-input nodrag"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => editCtx?.commitName(id, nameDraft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); editCtx?.commitName(id, nameDraft); }
              if (e.key === "Escape") { e.preventDefault(); editCtx?.cancelEdit(); }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="node-tile-name schema-processor-node-name">{data.name}</span>
        )}
        {isEditingDescription ? (
          <textarea
            ref={descInputRef}
            className="schema-processor-node-description-input nodrag"
            placeholder="Describe what this node does…"
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
            onBlur={() => editCtx?.commitDescription(id, descDraft)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); editCtx?.commitDescription(id, descDraft); }
              if (e.key === "Escape") { e.preventDefault(); editCtx?.cancelEdit(); }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : data.description ? (
          <p className="schema-processor-node-description">{data.description}</p>
        ) : null}
      </div>
    </div>
  );
}

// Lucide's plain "x" icon (public/circle-x.svg -- despite the filename, its
// actual content is just the two diagonal strokes, no circle) -- inlined
// (rather than an <img src>) so `stroke="currentColor"` can pick up the
// button's own CSS `color`, the same way MenuBar.tsx's Save/Undo/Redo
// glyphs do. Since the icon itself draws no circle, the button's own CSS
// supplies the round backdrop/border (see .schema-edge-delete-btn).
function CircleXGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

// Lets DeletableEdge (below) ask for its own removal/selection without a
// `data` closure -- `edges` is now App.tsx state, persisted via
// buildProjectData's JSON.stringify, and a function-valued `data.onDeleteEdge`
// would silently vanish on save/reload (JSON.stringify drops functions),
// leaving a restored edge's delete button rendered but inert. Same reasoning
// as ProcessorNodeEditContext below, applied to edges instead of nodes.
const EdgeDeleteContext = createContext<{ onDeleteEdge: (id: string) => void; onSelectEdge: (id: string) => void } | null>(null);

// A bezier edge with a small "x" button at its midpoint (via xyflow's own
// EdgeToolbar, which stays screen-size regardless of zoom) to cut a
// connection without hunting for a Delete key. Shown on hover OR once
// selected -- BaseEdge only forwards event props to the thin VISIBLE path,
// not the wider invisible `react-flow__edge-interaction` path it also
// renders for hit-testing (confirmed by reading its source), so the hover
// listeners go on a wrapping <g> instead: mouse events over either child
// path bubble up to it, giving the same generous ~20px hover band xyflow
// already uses for click/selection rather than just the 1.5px line itself.
// Hovering the button also keeps it visible -- otherwise the small gap
// between the edge's hover band and the toolbar (rendered separately, at
// the path's midpoint) could hide the button just as the cursor reaches it.
function DeletableEdge({ id, selected, style, markerEnd, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition }: EdgeProps) {
  const edgeDeleteCtx = useContext(EdgeDeleteContext);
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const [hoverEdge, setHoverEdge] = useState(false);
  const [hoverButton, setHoverButton] = useState(false);
  const groupRef = useRef<SVGGElement | null>(null);
  // Native listeners on the OUTER .react-flow__edge wrapper, not React's
  // onMouseEnter/onMouseLeave props on this component's own inner <g>.
  // Enabling drag-to-reconnect (App.tsx's onReconnect/onReconnectStart/
  // onReconnectEnd) makes xyflow render two ~25px invisible "edgeupdater"
  // grab circles at each endpoint as SIBLINGS of this <g>, not
  // descendants -- confirmed via direct DOM inspection. React's
  // onMouseEnter only fires when the pointer enters THIS element's own
  // bounds, so hovering an edgeupdater circle (very likely near either
  // end of a short edge) never reached it, silently making the delete
  // button seem broken. mouseenter/mouseleave on the shared ANCESTOR both
  // this <g> and the edgeupdater circles sit inside fires correctly
  // regardless of which descendant the pointer is actually over.
  useEffect(() => {
    const wrapper = groupRef.current?.closest(".react-flow__edge");
    if (!wrapper) return;
    const onEnter = () => setHoverEdge(true);
    const onLeave = () => setHoverEdge(false);
    wrapper.addEventListener("mouseenter", onEnter);
    wrapper.addEventListener("mouseleave", onLeave);
    return () => {
      wrapper.removeEventListener("mouseenter", onEnter);
      wrapper.removeEventListener("mouseleave", onLeave);
    };
  }, []);
  return (
    <>
      <g
        ref={groupRef}
        onClick={(e) => {
          e.stopPropagation();
          edgeDeleteCtx?.onSelectEdge(id);
        }}
      >
        <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      </g>
      <EdgeToolbar
        edgeId={id}
        x={labelX}
        y={labelY}
        isVisible={!!selected || hoverEdge || hoverButton}
        onMouseEnter={() => setHoverButton(true)}
        onMouseLeave={() => setHoverButton(false)}
      >
        <button
          className="schema-edge-delete-btn nodrag nopan"
          onClick={(e) => {
            e.stopPropagation();
            edgeDeleteCtx?.onDeleteEdge(id);
          }}
          title="Remove connection"
        >
          <CircleXGlyph />
        </button>
      </EdgeToolbar>
    </>
  );
}

function DrawerChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? "rotate(180deg)" : undefined }}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// KNIME-style in-progress connection line: the same dashed bezier xyflow
// would draw by default (same path math, same .react-flow__connection-path
// class so the existing dashed "marching ants" CSS animation still
// applies), plus a small arrowhead at the cursor end, plus a circle-plus
// "drop here to add a node" affordance just past it -- shown only while
// NOT hovering a real handle (toHandle null); once the drag is over a
// valid target, the plain arrowhead alone is enough, matching how KNIME's
// own connector drag drops the "+" the moment it's over a real port.
// Releasing over empty canvas (see onConnectEnd below) opens the same
// quick-add node picker as a right-click, then wires the new node in.
function ConnectionLineWithAddButton({ fromX, fromY, toX, toY, fromPosition, toPosition, toHandle }: ConnectionLineComponentProps) {
  const [path] = getBezierPath({ sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition, targetX: toX, targetY: toY, targetPosition: toPosition });
  return (
    <g>
      <path
        d={path}
        fill="none"
        stroke="#414959"
        strokeWidth={1.5}
        className="react-flow__connection-path"
        markerEnd="url(#schema-connection-arrow)"
      />
      {!toHandle && (
        <g transform={`translate(${toX + 20}, ${toY - 2})`}>
          <circle r="8" fill="#ffffff" stroke="#414959" strokeWidth="1.5" />
          <path d="M-4,0 H4 M0,-4 V4" stroke="#414959" strokeWidth="1.75" strokeLinecap="round" />
        </g>
      )}
    </g>
  );
}

// Arrowhead marker referenced by both ConnectionLineWithAddButton (the
// in-progress drag) and the "frozen" pending-connection edge drawn below
// once the node picker is open (see pendingConnectionSource/PENDING_*
// near openNodePicker) -- hoisted to its own always-mounted defs instead
// of living inside ConnectionLineWithAddButton, which only exists in the
// DOM while a drag is actually in progress and so can't back a marker
// reference from an edge rendered after the drag has already ended.
function SchemaConnectionMarkerDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        {/* orient="auto" is SVG's own native "point this along the path's
            end tangent" -- lets marker-end place a correctly-rotated
            arrowhead with no manual angle/rotate-transform math. */}
        <marker id="schema-connection-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M0,0 L10,5 L0,10 Z" fill="#414959" />
        </marker>
      </defs>
    </svg>
  );
}

const nodeTypes = { tableNode: TableNode, groupBoxNode: GroupBoxNode, processorNode: ProcessorNode };
const edgeTypes = { deletableEdge: DeletableEdge };

// The "drop here to add a node" affordance's home once a connection-drag
// ends on empty canvas -- kept alive for as long as the node picker stays
// open (see pendingConnectionSource near openNodePicker below), instead
// of vanishing the instant the drag ends like xyflow's own in-progress
// connectionLineComponent does.
//
// This is a plain SVG overlay, not a real xyflow Node+Edge pair. An
// earlier version tried exactly that (drop an invisible real node at the
// release point, connect a real animated Edge to it) since it's the
// pattern xyflow itself recommends for "connect to an arbitrary point" --
// but that new node's handle position never got measured by xyflow's own
// pipeline in this app (confirmed directly: the node rendered and sized
// correctly, `useUpdateNodeInternals` fired and found it in the DOM, yet
// its edge stayed unrendered even after 20 forced remeasure attempts
// across ~330ms -- not a timing issue, something deeper). Drawing it by
// hand sidesteps that node/edge machinery entirely: `useStore` reads the
// SOURCE node's already-correctly-measured handle position directly
// (real, long-lived nodes measure fine -- this app's other edges render
// off the exact same internals), `useViewport` gives the current pan/
// zoom, and `getBezierPath` (already used by ConnectionLineWithAddButton
// above) draws the same curve xyflow's own edges use.
function PendingConnectionLineOverlay({
  sourceNodeId,
  sourceHandleId,
  toFlowX,
  toFlowY,
}: {
  sourceNodeId: string;
  sourceHandleId: string | null;
  toFlowX: number;
  toFlowY: number;
}) {
  const sourcePoint = useStore(
    useCallback(
      (s: ReactFlowState) => {
        const node = s.nodeLookup.get(sourceNodeId);
        const bounds = node?.internals.handleBounds?.source;
        if (!bounds || bounds.length === 0) return null;
        const handle = (sourceHandleId ? bounds.find((h) => h.id === sourceHandleId) : bounds[0]) ?? bounds[0];
        // Matches xyflow's own internal getHandlePosition() for the
        // Position.Right case (the only position this app's source
        // handles ever use) -- outer-edge midpoint, not the handle's
        // own center, so the curve starts flush with the node's border.
        return {
          x: node!.internals.positionAbsolute.x + handle.x + handle.width,
          y: node!.internals.positionAbsolute.y + handle.y + handle.height / 2,
        };
      },
      [sourceNodeId, sourceHandleId],
    ),
    (a, b) => a?.x === b?.x && a?.y === b?.y,
  );
  const { x: vx, y: vy, zoom } = useViewport();
  if (!sourcePoint) return null;
  const [path] = getBezierPath({
    sourceX: sourcePoint.x,
    sourceY: sourcePoint.y,
    sourcePosition: Position.Right,
    targetX: toFlowX,
    targetY: toFlowY,
    targetPosition: Position.Left,
  });
  return (
    <svg className="schema-pending-connection-overlay" aria-hidden="true">
      <g transform={`translate(${vx}, ${vy}) scale(${zoom})`}>
        <path
          d={path}
          fill="none"
          stroke="#414959"
          strokeWidth={1.5}
          className="react-flow__connection-path"
          markerEnd="url(#schema-connection-arrow)"
        />
        <g transform={`translate(${toFlowX + 20}, ${toFlowY - 2})`}>
          <circle r="8" fill="#ffffff" stroke="#414959" strokeWidth="1.5" />
          <path d="M-4,0 H4 M0,-4 V4" stroke="#414959" strokeWidth="1.75" strokeLinecap="round" />
        </g>
      </g>
    </svg>
  );
}


interface SchemaViewProps {
  rectangles: Rectangle[];
  groups: Group[];
  // Placeholder catalog-widget instances dropped/click-added onto the
  // canvas (see NodesPanel.tsx) -- not real table data, just node shells.
  processorNodes: ProcessorNodeInstance[];
  // Connections between nodes -- owned by App.tsx (not local state here
  // anymore) so they survive buildProjectData()/project save-load.
  edges: Edge[];
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  onDeleteEdge: (edgeId: string) => void;
  // Native drag-an-edge-off-to-delete-it / drag-onto-a-new-target-to-
  // rewire-it -- see App.tsx's matching handlers for why they live there
  // (same reasoning as onConnect: edges are App.tsx state).
  onReconnectStart: () => void;
  onReconnect: (oldEdge: Edge, newConnection: Connection) => void;
  onReconnectEnd: (event: unknown, edge: Edge) => void;
  // Bumped by App.tsx on every project open -- see the effect that clears
  // nodeRunStatus/nodeOutputs below for why.
  workflowResetSignal: number;
  // Bumped by the menu bar's play button -- force-runs every runnable node.
  runAllSignal: number;
  previewTables: SchemaPreviewTable[] | null;
  // Full per-table extraction results from a real Convert run, keyed by
  // table name -- takes over from the capped preview sample in the output
  // drawer once a table has actually been converted.
  convertedTables: Record<string, { columns: string[]; rows: string[][] }>;
  loading: boolean;
  error: string | null;
  // Settings-panel toggle -- selecting a card auto-opens the output drawer
  // when true (the default); when false, it only opens via the handle.
  autoExpandOutputDrawer: boolean;
  onUpdateTablePosition: (rectId: string, x: number, y: number) => void;
  onUpdateGroupPosition: (groupId: string, x: number, y: number) => void;
  onAddProcessorNode: (entry: DraggedNodeEntry, position?: { x: number; y: number }) => string;
  onUpdateProcessorNodePosition: (id: string, x: number, y: number) => void;
  onDeleteProcessorNodes: (ids: string[]) => void;
  // Right-click context menu on a processor node -- see ProcessorNodeEditContext.
  onRenameProcessorNode: (id: string, name: string) => void;
  onUpdateProcessorNodeDescription: (id: string, description: string) => void;
  // Merge's auto-computed default match pair (handleRunProcessorNode) needs
  // to persist back into the node's real params -- same handler App.tsx
  // already wires up to Configure windows' own Apply IPC events.
  onUpdateProcessorNodeParams: (id: string, params: Record<string, unknown>) => void;
  // Double-click a column name on a table card -- see Rectangle.columnRenames.
  onRenameColumn: (rectId: string, originalCol: string, newName: string) => void;
  // App.tsx's Layers-panel selection (a mix of rect and guide ids) -- read
  // here to drive table-card nodes' own `selected` so a rectangle picked
  // in the Layers panel is visibly selected on the Workflow canvas too,
  // and written back to (via onTableSelectionChange) when a card is
  // selected directly on the canvas, so the two stay in sync in both
  // directions. See the matching comment on handleTableSelectionChange
  // in App.tsx for why this matters for Backspace/Delete specifically.
  selectedIds: string[];
  onTableSelectionChange: (changes: { id: string; selected: boolean }[]) => void;
  // Reports the currently selected processor node's run log (error +
  // every warning + every info message, not just the single
  // highest-priority one its own corner badge shows) up to the Log dock
  // panel in App.tsx, which lives outside this component entirely --
  // null whenever nothing selected/nothing to show.
  onSelectedNodeLogChange: (payload: { nodeName: string; entries: NodeLogEntry[] } | null) => void;
  visible: boolean;
}

export default function SchemaView({
  rectangles,
  groups,
  processorNodes,
  edges,
  onEdgesChange,
  onConnect,
  onDeleteEdge,
  onReconnectStart,
  onReconnect,
  onReconnectEnd,
  workflowResetSignal,
  runAllSignal,
  previewTables,
  convertedTables,
  loading,
  error,
  autoExpandOutputDrawer,
  onUpdateTablePosition,
  onUpdateGroupPosition,
  onAddProcessorNode,
  onUpdateProcessorNodePosition,
  onDeleteProcessorNodes,
  onRenameProcessorNode,
  onUpdateProcessorNodeDescription,
  onUpdateProcessorNodeParams,
  onRenameColumn,
  selectedIds,
  onTableSelectionChange,
  onSelectedNodeLogChange,
  visible,
}: SchemaViewProps) {
  // Single source of truth for card content: real preview data once it has
  // landed, otherwise dummy columns + placeholder rows derived from the
  // actual rectangles (or a fully fake example set when none exist yet).
  // Looked up per table/node for its color, group membership, etc. -- keyed
  // by the rectangle's own stable id, which is also what identifies each
  // schema-preview entry back to its rectangle (see SchemaPreviewTable's
  // own rectId comment for why: a rename must never change this).
  const rectById = useMemo(() => {
    const map = new Map<string, Rectangle>();
    rectangles.forEach((r) => map.set(r.id, r));
    return map;
  }, [rectangles]);

  const displayTables = useMemo<SchemaPreviewTable[]>(() => {
    if (previewTables) {
      // Real sample extraction landed -- column list/counts/rows come
      // straight from Python; color comes from the matching rectangle,
      // found by rectId (falls back to name-matching only for legacy
      // preview data from before that field existed).
      return previewTables.map((t) => {
        const rect = t.rectId
          ? rectById.get(t.rectId)
          : rectangles.find((r) => (r.name ?? r.id) === t.name);
        return {
          ...t,
          name: t.name || "(unnamed)",
          color: rect?.stroke ?? "#888888",
        };
      });
    }
    return [];
  }, [rectangles, previewTables, rectById]);


  // Real, controlled node state (not a derived value) -- React Flow only
  // persists a dragged position if the change is written back via
  // onNodesChange; a plain useMemo-derived array snaps back to its computed
  // grid position on the next unrelated re-render, which is why dragging
  // looked like it "didn't work". Existing positions are preserved here;
  // only genuinely new/removed tables touch position.
  //
  // Nodes come in three kinds, built in this exact order -- React Flow
  // requires a parent node to appear before its children in the array, and
  // the canvas Group model caps nesting at one level (a group with a
  // parentId can never itself be a parent), so this fixed 3-bucket order
  // is always a valid topological sort, no general sort needed:
  //   1. top-level group boxes (mirrors a Layers-panel folder)
  //   2. subfolder group boxes (nested one level under a top box)
  //   3. table cards (parented to whichever box they belong to, if any)
  const [nodes, setNodes] = useState<Node[]>([]);
  // Set right before onNodesChange mirrors a canvas-originated selection
  // into selectedIds (see there), so this effect (which re-runs whenever
  // selectedIds changes) can tell the two directions apart: a selectedIds
  // change that came FROM the canvas itself (a click, marquee, or the
  // drag-restore logic) should leave processor-node selection alone --
  // the canvas's own onNodesChange already handled that correctly. A
  // selectedIds change from anywhere else (the Layers panel, most often)
  // should clear it, matching ordinary click-to-select-replaces-selection
  // behavior instead of silently ADDING the clicked rectangle's card to
  // whatever processor node(s) already happened to be selected on canvas
  // -- reported as surprising/bad UX otherwise. Consumed (reset to false)
  // the moment this effect reads it, so a stale `true` can never leak
  // into some later, unrelated selectedIds change.
  const selectionSyncedFromCanvasRef = useRef(false);
  // This effect also re-runs for reasons that have NOTHING to do with
  // selection -- e.g. a Configure window's Apply button changing a node's
  // `params`. The `fromCanvas` flag above only distinguishes WHERE a
  // selectedIds change came from, not WHETHER selectedIds actually changed
  // this pass -- so on a params-only update, `fromCanvas` was false (no
  // canvas interaction just happened) and the processor bucket's
  // `selected: fromCanvas ? prev?.selected : false` wiped every selected
  // node's highlight for no reason, reported as "the node gets deselected
  // after hitting Apply." Comparing selectedIds against what it was on the
  // PREVIOUS run tells the two apart: only clear processor-node selection
  // when selectedIds itself genuinely just changed (and didn't come from
  // the canvas, per the comment above).
  const prevSelectedIdsRef = useRef(selectedIds);
  useEffect(() => {
    const fromCanvas = selectionSyncedFromCanvasRef.current;
    selectionSyncedFromCanvasRef.current = false;
    const selectedIdsChanged = selectedIds !== prevSelectedIdsRef.current;
    prevSelectedIdsRef.current = selectedIds;
    const keepProcessorSelection = fromCanvas || !selectedIdsChanged;
    setNodes((prevNodes) => {
      const prevById = new Map(prevNodes.map((n) => [n.id, n]));
      const groupBoxId = (groupId: string) => `groupbox-${groupId}`;

      // `id` prefers the matched rect's own stable id (falling back to the
      // echoed rectId, then name, then position only if no rect could be
      // matched at all) -- this is THE fix for the whole class of rename
      // bugs a name-keyed node id caused: renaming a table no longer
      // changes its Workflow-canvas identity, so nothing keyed off this id
      // (edges, convertedTables, saved position) can ever go stale.
      const tableEntries = displayTables.map((t, i) => {
        const rect = t.rectId ? rectById.get(t.rectId) : rectangles.find((r) => (r.name ?? r.id) === t.name);
        return { id: rect?.id ?? t.rectId ?? t.name ?? `table-${i}`, table: t, rect };
      });

      // Which table node ids belong directly to each group id.
      const memberIdsByGroup = new Map<string, string[]>();
      tableEntries.forEach(({ id, rect }) => {
        if (!rect?.groupId) return;
        const arr = memberIdsByGroup.get(rect.groupId) ?? [];
        arr.push(id);
        memberIdsByGroup.set(rect.groupId, arr);
      });

      const topGroups = groups.filter((g) => !g.parentId);
      // Subfolders only get a box if they actually have a member -- an
      // empty subfolder has nothing to contain.
      const visibleSubGroups = groups.filter(
        (g) => !!g.parentId && (memberIdsByGroup.get(g.id)?.length ?? 0) > 0,
      );
      const subGroupsByParent = new Map<string, Group[]>();
      visibleSubGroups.forEach((g) => {
        const arr = subGroupsByParent.get(g.parentId!) ?? [];
        arr.push(g);
        subGroupsByParent.set(g.parentId!, arr);
      });
      // A top group needs a box if it has direct members OR contains a
      // (visible) subfolder -- otherwise there's nothing to draw.
      const visibleTopGroups = topGroups.filter(
        (g) =>
          (memberIdsByGroup.get(g.id)?.length ?? 0) > 0 ||
          (subGroupsByParent.get(g.id)?.length ?? 0) > 0,
      );
      const isVisibleGroup = (id: string) =>
        visibleTopGroups.some((g) => g.id === id) || visibleSubGroups.some((g) => g.id === id);

      // ── Bucket 1: top-level group boxes ──
      // Fresh boxes are laid out in a simple 2-column grid to the right of
      // the ungrouped-card grid (which starts at x=0) -- just a sane
      // starting point, freely draggable afterward like everything else.
      const topGroupBoxNodes: Node[] = visibleTopGroups.map((g, i) => {
        const boxId = groupBoxId(g.id);
        const prev = prevById.get(boxId);
        const position = prev
          ? prev.position
          : { x: g.schemaX ?? 900 + (i % 2) * 340, y: g.schemaY ?? Math.floor(i / 2) * 320 };
        return {
          id: boxId,
          type: "groupBoxNode",
          position,
          data: { name: g.name, groupId: g.id },
          selectable: false,
        } as Node;
      });

      // ── Bucket 2: subfolder group boxes ──
      const subGroupBoxNodes: Node[] = [];
      visibleTopGroups.forEach((topGroup) => {
        const subs = subGroupsByParent.get(topGroup.id) ?? [];
        subs.forEach((sub, subIndex) => {
          const boxId = groupBoxId(sub.id);
          const prev = prevById.get(boxId);
          // Members lay out left-to-right (a row), not stacked top-to-bottom.
          const position = prev
            ? prev.position
            : { x: GROUP_BOX_PADDING + subIndex * (CARD_ESTIMATED_WIDTH + GROUP_BOX_MEMBER_GAP), y: GROUP_BOX_HEADER_HEIGHT + GROUP_BOX_PADDING };
          subGroupBoxNodes.push({
            id: boxId,
            type: "groupBoxNode",
            // No `extent: 'parent'` here (see the tableNode comment below) --
            // a subfolder box can drag past its top box's current edge, and
            // handleNodeDragStop re-fits the top box to its members on drop
            // instead of clamping the drag while it's happening.
            parentId: groupBoxId(topGroup.id),
            position,
            data: { name: sub.name, groupId: sub.id },
            selectable: false,
          } as Node);
        });
      });

      // ── Bucket 3: table cards ──
      let ungroupedIndex = 0;
      const stackIndexByBox = new Map<string, number>();
      const tableCardNodes: Node[] = tableEntries.map(({ id, table: t, rect }) => {
        const prev = prevById.get(id);
        const boxId = rect?.groupId && isVisibleGroup(rect.groupId) ? groupBoxId(rect.groupId) : undefined;

        let position: { x: number; y: number };
        if (prev) {
          position = prev.position;
        } else if (boxId) {
          // Members of a group box lay out left-to-right (a row), not
          // stacked top-to-bottom -- matches the sibling subfolder-box
          // layout above.
          const stackIndex = stackIndexByBox.get(boxId) ?? 0;
          stackIndexByBox.set(boxId, stackIndex + 1);
          position = {
            x: GROUP_BOX_PADDING + stackIndex * (CARD_ESTIMATED_WIDTH + GROUP_BOX_MEMBER_GAP),
            y: GROUP_BOX_HEADER_HEIGHT + GROUP_BOX_PADDING,
          };
        } else {
          // Single vertical column by default, not a grid -- stacked
          // top-to-bottom in creation order.
          position = { x: 0, y: ungroupedIndex * 240 };
        }
        if (!boxId) ungroupedIndex++;

        return {
          id,
          type: "tableNode",
          // No `extent: 'parent'` here (unlike the group-box nesting above) --
          // cards are free to drag past their box's current edge, and
          // handleNodeDragStop below re-fits the box to its members on drop
          // instead of clamping the card while dragging.
          ...(boxId ? { parentId: boxId } : {}),
          position,
          // Driven by selectedIds (App.tsx's Layers-panel selection),
          // keyed by the underlying Rectangle's own `.id` -- NOT this
          // card's own node id, which is the table's *name* (see `id`
          // above) -- since that's what selectedIds/the Layers panel use
          // everywhere else. This is what keeps a card visibly selected
          // on the canvas when its rectangle is selected in Layers, and
          // (via onNodesChange below, which mirrors canvas selection back
          // into selectedIds) vice versa.
          selected: rect ? selectedIds.includes(rect.id) : false,
          data: {
            name: t.name || "(unnamed)",
            color: t.color,
            columns: t.columns,
            rowCount: t.rowCount,
            columnRenames: rect?.columnRenames,
            // Baked-in closure (data is a plain object, not serialized, so
            // this is fine) rather than threading rectId through and having
            // TableNode call a prop -- rect.id is only known here, where
            // this table's owning rectangle has already been resolved.
            onRenameColumn: rect ? (originalCol: string, newName: string) => onRenameColumn(rect.id, originalCol, newName) : undefined,
          },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        } as Node;
      });

      // ── Box sizing ──────────────────────────────────────────────────
      // Bottom-up: subfolder boxes first (their only possible children are
      // table cards), then top boxes (whose children can include an
      // already-sized subfolder box). No built-in auto-sizing group node
      // in this xyflow version -- getNodesBounds() over a box's own
      // children (in that box's local coordinate space, since children's
      // `position` is already relative to their immediate parent) gives
      // exactly the box's required content size.
      const sizeBox = (boxNode: Node, children: Node[]): Node => {
        if (children.length === 0) {
          return { ...boxNode, width: 260, height: GROUP_BOX_HEADER_HEIGHT + GROUP_BOX_PADDING * 2 };
        }
        const bounds = getNodesBounds(
          children.map((c) => ({
            ...c,
            width: c.width ?? c.measured?.width ?? CARD_ESTIMATED_WIDTH,
            height: c.height ?? c.measured?.height ?? CARD_ESTIMATED_HEIGHT,
          })),
        );
        return {
          ...boxNode,
          width: bounds.x + bounds.width + GROUP_BOX_PADDING,
          height: bounds.y + bounds.height + GROUP_BOX_PADDING,
        };
      };
      const sizedSubGroupBoxNodes = subGroupBoxNodes.map((boxNode) =>
        sizeBox(boxNode, tableCardNodes.filter((n) => n.parentId === boxNode.id)),
      );
      const sizedTopGroupBoxNodes = topGroupBoxNodes.map((boxNode) =>
        sizeBox(boxNode, [
          ...sizedSubGroupBoxNodes.filter((n) => n.parentId === boxNode.id),
          ...tableCardNodes.filter((n) => n.parentId === boxNode.id),
        ]),
      );

      // ── Bucket 4: processor-node instances ──
      // Unparented (no group-box nesting for these yet), absolute position
      // straight from ProcessorNodeInstance.x/y.
      const processorNodeNodes: Node[] = processorNodes.map((p) => {
        const prev = prevById.get(p.id);
        const position = prev ? prev.position : { x: p.x, y: p.y };
        return {
          id: p.id,
          type: "processorNode",
          position,
          selected: keepProcessorSelection ? prev?.selected : false,
          data: { name: p.name || p.catalogName, catalogName: p.catalogName, icon: p.icon, color: p.color, hasOutput: p.hasOutput, hasExtraInput: p.hasExtraInput, description: p.description, processorId: p.id },
        } as Node;
      });

      return [...sizedTopGroupBoxNodes, ...sizedSubGroupBoxNodes, ...tableCardNodes, ...processorNodeNodes];
    });
  }, [displayTables, rectById, rectangles, groups, processorNodes, onRenameColumn, selectedIds]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Mirrors table-card selection into App.tsx's selectedIds -- see the
    // `selected` comment on tableCardNodes above for why (Layers panel
    // sync, and Backspace/Delete not silently touching a card the user
    // can't see is selected). A "select" change's `id` is the card's own
    // node id, which (see tableEntries above) is the underlying
    // Rectangle's own `.id` -- changes for processor nodes/group boxes
    // just don't match any rect id here and are naturally dropped, no
    // explicit type check needed.
    const tableSelectionChanges = changes
      .filter((c): c is Extract<NodeChange, { type: "select" }> => c.type === "select")
      .flatMap((c) => {
        const rectId = rectById.get(c.id)?.id;
        return rectId ? [{ id: rectId, selected: c.selected }] : [];
      });
    if (tableSelectionChanges.length > 0) {
      selectionSyncedFromCanvasRef.current = true;
      onTableSelectionChange(tableSelectionChanges);
    }

    setNodes((nds) => {
      // Drop "dimensions" reports that just repeat a node's already-recorded
      // size. React Flow's own ResizeObserver re-reports a node's measured
      // size on every relevant DOM mutation (which now includes each per-
      // field Handle we render) -- applying a same-value dimensions change
      // still produces a brand-new `nodes` array/objects, which flows back
      // into <ReactFlow nodes={nodes}> as a changed prop, which its internal
      // StoreUpdater re-syncs into its own store on every such pass. If
      // anything about that resync ever re-triggers a remeasurement (e.g.
      // sub-pixel layout jitter), the two sides can keep re-confirming the
      // same "change" back and forth. Filtering out true no-ops here means
      // setNodes gets called with the exact same array reference once
      // measurements settle, which React treats as a no-op and doesn't even
      // re-render for -- breaking that loop before it can start, regardless
      // of whether this is actually what's behind the intermittent
      // "Maximum update depth exceeded" crash some users have hit.
      const meaningfulChanges = changes.filter((change) => {
        // Table cards/group boxes are purely a view of the underlying
        // rectangles/groups — deletions for those must go through the
        // canvas/Layers panel, not here, so drop remove events for anything
        // that isn't a processorNode (the one node type with no other home
        // to delete from -- see onNodesDelete below for the actual state
        // cleanup, since removing it from local `nodes` here alone isn't
        // enough: App.tsx's `processorNodes` array is the real source of
        // truth this effect rebuilds from).
        if (change.type === "remove") {
          return nds.find((n) => n.id === change.id)?.type === "processorNode";
        }
        if (change.type !== "dimensions" || !change.dimensions) return true;
        const node = nds.find((n) => n.id === change.id);
        const measured = node?.measured;
        return measured?.width !== change.dimensions.width || measured?.height !== change.dimensions.height;
      });
      if (meaningfulChanges.length === 0) return nds;
      return applyNodeChanges(meaningfulChanges, nds);
    });
  }, [rectById, onTableSelectionChange]);

  // Delete/Backspace with a processor node selected (xyflow's own default
  // deleteKeyCode) -- onNodesChange above already lets the "remove" change
  // for it through into local `nodes` state, but that alone isn't enough:
  // the nodes-building effect rebuilds from App.tsx's `processorNodes`
  // array on every unrelated re-render, so without also removing it there,
  // the "deleted" node would simply reappear on the next render.
  // onDeleteProcessorNodes (App.tsx) also drops any edge attached to a
  // deleted node -- folded in there since every caller wants that.
  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      const ids = deleted.filter((n) => n.type === "processorNode").map((n) => n.id);
      if (ids.length === 0) return;
      onDeleteProcessorNodes(ids);
    },
    [onDeleteProcessorNodes],
  );

  // The `fitView` prop only fits once, during React Flow's own initial
  // mount -- but SchemaView is always mounted behind a CSS display:none
  // (see the effect above's comment on why) until Schema is actually
  // opened, so at mount time its container is 0x0 AND the `nodes` state
  // effect hasn't populated real positions yet either. Either gap alone is
  // enough to make that one-shot fit meaningless -- it either fits an empty
  // node list, or fits real nodes against a zero-size viewport -- leaving
  // the cards pinned at the origin (top-left) the first time Schema opens.
  // Firing fitView() ourselves, once, only once BOTH nodes exist AND the
  // panel is actually visible (real dimensions), replaces that timing.
  const reactFlowInstanceRef = useRef<ReactFlowInstance | null>(null);
  const hasFitRef = useRef(false);
  const tryFitView = useCallback(() => {
    if (hasFitRef.current || !visible || nodes.length === 0 || !reactFlowInstanceRef.current) return;
    const instance = reactFlowInstanceRef.current;
    // The container being sized correctly isn't enough on its own -- React
    // Flow also measures each NODE's own rendered dimensions via its own
    // ResizeObserver (populating node.measured), asynchronously, and
    // fitView() computes its bounding box from that. Right when the panel
    // first becomes visible, that per-node measurement hasn't landed yet
    // (confirmed empirically: node.measured was still undefined one rAF
    // after becoming visible), so fitView() would fit an effectively-empty
    // box. Poll per-frame until every node reports real measured
    // dimensions (bounded, so a genuinely-stuck case still fits eventually
    // rather than silently never firing).
    let attempts = 0;
    const attemptFit = () => {
      if (hasFitRef.current || !reactFlowInstanceRef.current) return;
      const allMeasured = instance.getNodes().every((n) => (n.measured?.width ?? 0) > 0 && (n.measured?.height ?? 0) > 0);
      attempts += 1;
      if (allMeasured || attempts > 30) {
        instance.fitView();
        hasFitRef.current = true;
        return;
      }
      requestAnimationFrame(attemptFit);
    };
    requestAnimationFrame(attemptFit);
  }, [visible, nodes]);
  useEffect(() => { tryFitView(); }, [tryFitView]);

  // Walks up from a dragged card's box, or a dragged subfolder box's own top
  // box (at most one level per the Group model), re-fitting each to its
  // current children -- called after a drag now that neither cards nor
  // nested subfolder boxes are clamped to stay inside their container (see
  // the `extent` comments above) so the container must instead grow/shrink
  // around wherever its members ended up.
  const refitAncestorBoxes = useCallback((startBoxId: string) => {
    setNodes((prev) => {
      let working = prev;
      let boxId: string | undefined = startBoxId;
      while (boxId) {
        const boxNode = working.find((n) => n.id === boxId);
        if (!boxNode) break;
        const children = working.filter((n) => n.parentId === boxId);
        const { box, childDelta } = fitBoxToChildren(boxNode, children);
        working = working.map((n) => {
          if (n.id === boxId) return box;
          if (n.parentId === boxId && (childDelta.x !== 0 || childDelta.y !== 0)) {
            return { ...n, position: { x: n.position.x + childDelta.x, y: n.position.y + childDelta.y } };
          }
          return n;
        });
        boxId = boxNode.parentId;
      }
      return working;
    });
  }, []);

  // Persist a card/box's new absolute position on drag-stop -- this is also
  // what computeAnnotationData (App.tsx) ranks against for outputSlot
  // assignment, so a manual drag directly changes export order.
  const handleNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      const instance = reactFlowInstanceRef.current;
      const abs = instance?.getInternalNode(node.id)?.internals.positionAbsolute ?? node.position;
      if (node.type === "tableNode") {
        // A table card's node id IS its rectangle's own stable id (see
        // tableEntries in the nodes-building effect above) -- there never
        // was a separate data.rectId field actually set on this data
        // object, so this read the always-undefined property and silently
        // never persisted a dragged card's position at all (positions
        // only "worked" because xyflow's own local `nodes` state carries
        // them forward within a session; they'd be lost on save/reload).
        onUpdateTablePosition(node.id, abs.x, abs.y);
        if (node.parentId) refitAncestorBoxes(node.parentId);
      } else if (node.type === "groupBoxNode") {
        const groupId = (node.data as { groupId?: string }).groupId;
        if (groupId) onUpdateGroupPosition(groupId, abs.x, abs.y);
        // A subfolder box dragged past its own top box's edge -- re-fit that
        // top box the same way a card re-fits its box. Top-level boxes have
        // no parentId, so this is a no-op for them.
        if (node.parentId) refitAncestorBoxes(node.parentId);
      } else if (node.type === "processorNode") {
        const processorId = (node.data as { processorId?: string }).processorId;
        if (processorId) onUpdateProcessorNodePosition(processorId, abs.x, abs.y);
      }
    },
    [onUpdateTablePosition, onUpdateGroupPosition, onUpdateProcessorNodePosition, refitAncestorBoxes],
  );

  // With selectNodesOnDrag={false} below, xyflow's own drag internals
  // (@xyflow/system's startDrag) clear ALL current selection the instant a
  // drag starts on a node that ISN'T already selected -- by design, since
  // that node won't become selected either (drag is purely a move gesture
  // now). But that also wipes out an unrelated card/node the user already
  // had selected, which reads as a bug: dragging one card shouldn't drop
  // another card's selection. Restore whatever was selected right before
  // this drag started (reading nodesRef, since it still holds the
  // pre-unselect snapshot -- xyflow's internal clear has already fired by
  // the time this callback runs, but the effect that syncs nodesRef from
  // `nodes` hasn't caught up yet).
  const handleNodeDragStart = useCallback(
    (_: unknown, node: Node) => {
      const prevSelectedIds = nodesRef.current.filter((n) => n.selected && n.id !== node.id).map((n) => n.id);
      if (prevSelectedIds.length === 0) return;
      onNodesChange(prevSelectedIds.map((id) => ({ type: "select" as const, id, selected: true })));
    },
    [onNodesChange],
  );

  // Drag-from-Nodes-panel target: a plain HTML5 drag (not xyflow's own drag
  // system), so it's handled with native onDragOver/onDrop on the wrapper
  // rather than anything React Flow provides. screenToFlowPosition converts
  // the raw drop point into canvas coordinates so the new node lands right
  // under the cursor instead of at some fixed origin.
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(NODE_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      const raw = e.dataTransfer.getData(NODE_DRAG_MIME);
      const instance = reactFlowInstanceRef.current;
      if (!raw || !instance) return;
      e.preventDefault();
      const entry = JSON.parse(raw) as DraggedNodeEntry;
      const position = instance.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      onAddProcessorNode(entry, position);
    },
    [onAddProcessorNode],
  );

  // ── Quick-add node picker (right-click or spacebar on empty canvas,
  // Orange-Data-Mining style) ───────────────────────────────────────────
  // Tracked via a ref (not state) so it costs nothing on every mouse move --
  // only read at the moment the picker actually opens (spacebar has no
  // click position of its own to go on).
  const lastMouseScreenPos = useRef({ x: 0, y: 0 });
  const handleWrapperMouseMove = useCallback((e: React.MouseEvent) => {
    lastMouseScreenPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const [pickerOpen, setPickerOpen] = useState(false);
  // Position relative to .schema-flow-wrapper (an absolute-positioned
  // containing block) rather than the viewport -- avoids `position: fixed`
  // breaking if any dock-panel ancestor ever gets a CSS transform (which
  // would silently re-anchor a fixed element to that ancestor instead).
  const [pickerWrapperPos, setPickerWrapperPos] = useState({ x: 0, y: 0 });
  const [pickerFlowPos, setPickerFlowPos] = useState({ x: 0, y: 0 });
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerSearchRef = useRef<HTMLInputElement | null>(null);

  const openNodePicker = useCallback((screenX: number, screenY: number) => {
    // Nothing to build a workflow out of yet -- matches the "No tables
    // detected yet." empty state shown for the same condition.
    if (displayTables.length === 0) return;
    const instance = reactFlowInstanceRef.current;
    const wrapperRect = wrapperRef.current?.getBoundingClientRect();
    if (!instance || !wrapperRect) return;
    setPickerFlowPos(instance.screenToFlowPosition({ x: screenX, y: screenY }));
    // Clamped so the menu never opens off the right/bottom edge of the
    // canvas -- estimated against its own fixed CSS size (240x360, see
    // .schema-node-picker in App.css) since it isn't mounted yet to measure.
    const x = Math.min(screenX - wrapperRect.left, wrapperRect.width - NODE_PICKER_WIDTH - 8);
    const y = Math.min(screenY - wrapperRect.top, wrapperRect.height - NODE_PICKER_MAX_HEIGHT - 8);
    setPickerWrapperPos({ x: Math.max(8, x), y: Math.max(8, y) });
    setPickerQuery("");
    setPickerOpen(true);
  }, [displayTables.length]);
  const closeNodePicker = useCallback(() => setPickerOpen(false), []);

  // Set right before openNodePicker() when it's opened by dragging a
  // connection off a node's output (rather than a plain right-click/
  // spacebar, which have no source node) -- read once by handlePickNode
  // below to also wire an edge from that source to the newly created node,
  // KNIME's "drag to empty canvas -> pick a node -> it's already
  // connected" flow. Cleared (or left stale and simply ignored) once
  // consumed; a plain right-click open always overwrites it to null first.
  const pendingConnectionSourceRef = useRef<{ nodeId: string; handleId: string | null } | null>(null);

  // Recomputed fresh every render straight from the ref (not lifted to
  // state -- the ref is always written synchronously before the pickerOpen
  // state update that triggers the very re-render reading it here, in the
  // same event handler, so there's no stale/flash frame to worry about).
  // null whenever the picker is closed, or was opened by a plain
  // right-click/spacebar with no drag source -- both correctly render no
  // pending line below.
  const pendingConnectionSource = pickerOpen ? pendingConnectionSourceRef.current : null;

  // Fires whenever a connection-drag from a handle ends, successful or
  // not -- xyflow itself already calls onConnect separately when it lands
  // on a real target handle, so this only needs to act on the "dropped on
  // empty canvas" case (toHandle null): open the same quick-add picker a
  // right-click would, remembering the drag's source so the pick can wire
  // itself in.
  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (connectionState.toHandle || !connectionState.fromNode) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      pendingConnectionSourceRef.current = { nodeId: connectionState.fromNode.id, handleId: connectionState.fromHandle?.id ?? null };
      openNodePicker(point.clientX, point.clientY);
    },
    [openNodePicker],
  );

  // Right-click on empty canvas -- xyflow's onPaneContextMenu only fires for
  // the pane itself, not a node; right-clicking a node instead is handled
  // separately below (onNodeContextMenu).
  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      const e = event as React.MouseEvent;
      // A plain right-click has no drag source -- clears any leftover
      // pending connection from an earlier aborted connection-drag so
      // handlePickNode doesn't wire this unrelated add to it.
      pendingConnectionSourceRef.current = null;
      openNodePicker(e.clientX, e.clientY);
    },
    [openNodePicker],
  );

  // ── Processor-node right-click menu: Delete / Rename / Add description ──
  // Table cards and group boxes don't get this menu (their own rename/
  // delete paths already exist elsewhere -- Layers panel, canvas). Native
  // browser menu is still suppressed for every node type via preventDefault,
  // matching the rest of the app's no-native-menus convention.
  const [nodeCtxMenu, setNodeCtxMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const closeNodeCtxMenu = useCallback(() => setNodeCtxMenu(null), []);
  const onNodeContextMenu: NodeMouseHandler = useCallback((event, node) => {
    event.preventDefault();
    if (node.type !== "processorNode") return;
    const wrapperRect = wrapperRef.current?.getBoundingClientRect();
    if (!wrapperRect) return;
    setNodeCtxMenu({
      x: (event as React.MouseEvent).clientX - wrapperRect.left,
      y: (event as React.MouseEvent).clientY - wrapperRect.top,
      nodeId: node.id,
    });
  }, []);

  // Close on Escape or an outside click -- same pattern as the node picker
  // above, including the next-tick registration so the very click/right-click
  // that opened this menu doesn't immediately close it again.
  useEffect(() => {
    if (!nodeCtxMenu) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNodeCtxMenu();
    };
    const handleClickOutside = () => closeNodeCtxMenu();
    window.addEventListener("keydown", handleKeyDown);
    const id = window.setTimeout(() => window.addEventListener("mousedown", handleClickOutside), 0);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousedown", handleClickOutside);
      window.clearTimeout(id);
    };
  }, [nodeCtxMenu, closeNodeCtxMenu]);

  // Looked up to decide the "Add description" vs "Edit description" label.
  const nodeCtxMenuTarget = useMemo(
    () => (nodeCtxMenu ? processorNodes.find((p) => p.id === nodeCtxMenu.nodeId) ?? null : null),
    [nodeCtxMenu, processorNodes],
  );

  // Drives ProcessorNode's own inline editor via ProcessorNodeEditContext --
  // see that context's definition for why this isn't routed through `data`.
  const [editingProcessorId, setEditingProcessorId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<"name" | "description" | null>(null);
  const processorEditContextValue = useMemo(() => ({
    editingId: editingProcessorId,
    editingField,
    commitName: (id: string, name: string) => {
      onRenameProcessorNode(id, name);
      setEditingProcessorId(null);
      setEditingField(null);
    },
    commitDescription: (id: string, description: string) => {
      onUpdateProcessorNodeDescription(id, description);
      setEditingProcessorId(null);
      setEditingField(null);
    },
    cancelEdit: () => {
      setEditingProcessorId(null);
      setEditingField(null);
    },
  }), [editingProcessorId, editingField, onRenameProcessorNode, onUpdateProcessorNodeDescription]);

  // Edges are click-only selectable (see the `defaultEdgeOptions.selectable:
  // false` below, which keeps xyflow's own marquee/click selection off
  // edges entirely) -- this handler drives selection manually from
  // DeletableEdge's own onClick instead, single-selecting like a plain click
  // on a node would.
  const handleSelectEdge = useCallback((id: string) => {
    onEdgesChange(edges.map((e) => ({ type: "select" as const, id: e.id, selected: e.id === id })));
  }, [edges, onEdgesChange]);

  const edgeDeleteContextValue = useMemo(() => ({ onDeleteEdge, onSelectEdge: handleSelectEdge }), [onDeleteEdge, handleSelectEdge]);

  const startEditingProcessorNode = useCallback((id: string, field: "name" | "description") => {
    setEditingProcessorId(id);
    setEditingField(field);
    closeNodeCtxMenu();
  }, [closeNodeCtxMenu]);

  const handleDeleteProcessorNodeFromMenu = useCallback((id: string) => {
    onDeleteProcessorNodes([id]);
    closeNodeCtxMenu();
  }, [onDeleteProcessorNodes, closeNodeCtxMenu]);

  // ── Processor-node execution (Run) ────────────────────────────────────
  // Kept local to this component, not lifted to App.tsx -- run status/
  // output are cheap to recompute and don't need persisting, same
  // reasoning that already keeps other per-node UI state local (SchemaView
  // stays mounted behind CSS display:none across the Canvas<->Workflow
  // toggle specifically so this kind of local state survives).
  const [nodeRunStatus, setNodeRunStatus] = useState<Record<string, ProcessorRunStatus>>({});
  const [nodeOutputs, setNodeOutputs] = useState<Record<string, { columns: string[]; rows: string[][] }>>({});

  // Read at response time (not via the closure the request started with)
  // to check whether a node was deleted while its run was in flight.
  const processorNodesRef = useRef(processorNodes);
  useEffect(() => { processorNodesRef.current = processorNodes; }, [processorNodes]);

  // A node's real "running" phase (see handleRunProcessorNode below) can be
  // fast enough on a small table that it never renders visibly -- same
  // flash problem a per-node red/amber/green light has as any other status
  // indicator. heldRunStatus is what NodeStatusLights actually reads (fed
  // through ProcessorNodeRunContext below in place of raw nodeRunStatus):
  // once a node goes "running", that's held for at least
  // MIN_RUNNING_LIGHT_MS regardless of how fast the real run finishes,
  // then reveals whatever nodeRunStatus is by then -- a genuinely slow run
  // is unaffected, since the hold timer fires well before it's done.
  const MIN_RUNNING_LIGHT_MS = 350;
  const [heldRunStatus, setHeldRunStatus] = useState<Record<string, ProcessorRunStatus>>({});
  const nodeRunStatusRef = useRef(nodeRunStatus);
  useEffect(() => { nodeRunStatusRef.current = nodeRunStatus; }, [nodeRunStatus]);
  const runHoldTimersRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    setHeldRunStatus((prev) => {
      let next: Record<string, ProcessorRunStatus> | undefined;
      for (const [id, status] of Object.entries(nodeRunStatus)) {
        if (runHoldTimersRef.current.has(id)) continue; // reveal happens from the timer itself, once it fires
        if (prev[id] === status) continue;
        if (status.state === "running") {
          const timer = window.setTimeout(() => {
            runHoldTimersRef.current.delete(id);
            setHeldRunStatus((p) => ({ ...p, [id]: nodeRunStatusRef.current[id] }));
          }, MIN_RUNNING_LIGHT_MS);
          runHoldTimersRef.current.set(id, timer);
        }
        next = { ...(next ?? prev), [id]: status };
      }
      return next ?? prev;
    });
  }, [nodeRunStatus]);
  useEffect(() => () => {
    runHoldTimersRef.current.forEach((t) => window.clearTimeout(t));
  }, []);

  // `nodes` changes reference on every single frame of a drag (xyflow's own
  // onNodesChange -> setNodes for each mousemove) -- reading it through a
  // ref instead of as a reactive dependency of resolveNodeInputs below
  // keeps that callback (and therefore handleRunProcessorNode, and the
  // auto-run effect that depends on both) referentially STABLE while
  // dragging. Without this, dragging a processor node around re-fired the
  // auto-run effect on every frame, which JSON.stringify'd every runnable
  // node's full resolved input tables that often -- real, visible drag lag
  // once a node actually had converted data flowing into it. Position only
  // needs to be current at the moment resolveNodeInputs is actually
  // CALLED (to order sources top-to-bottom), not reactively on every
  // cosmetic move -- a drag alone was never a real "inputs changed" event.
  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  // A freshly (re)opened project has no relationship to whatever run
  // status/output this component happened to be holding for the PREVIOUS
  // project's node ids -- reopening the SAME file (stable persisted ids)
  // would otherwise leave stale done/error badges on nodes that, from the
  // just-loaded file's perspective, were never run this session.
  useEffect(() => {
    setNodeRunStatus({});
    setNodeOutputs({});
    lastAutoRunInputsRef.current = {};
  }, [workflowResetSignal]);

  // Resolves a table card's Workflow-canvas node id back to its
  // displayTables entry -- mirrors the nodes-building effect's own
  // tableEntries id computation above (rect.id, falling back to the
  // echoed rectId, then name, then position) so every place that needs
  // "which table does this edge's source refer to" agrees with how that
  // id was actually assigned.
  const findDisplayTableByNodeId = useCallback((nodeId: string) => {
    return displayTables.find((t, i) => {
      const rect = t.rectId ? rectById.get(t.rectId) : rectangles.find((r) => (r.name ?? r.id) === t.name);
      return (rect?.id ?? t.rectId ?? t.name ?? `table-${i}`) === nodeId;
    });
  }, [displayTables, rectById, rectangles]);

  // Which table cards feed a given processor node, resolved to their real
  // (Converted) data, ordered top-to-bottom by canvas position (no
  // labeled/id'd handles exist yet to express "first" vs "second" input
  // explicitly -- see the DeletableEdge/Handle comments above). Read
  // straight off the live `nodes` array rather than a table-name lookup,
  // which would silently miss an unnamed table (whose card id is
  // `table-${i}`, not a name). Shared by handleRunProcessorNode below
  // and the auto-run effect, so both agree on exactly what a node's
  // "current inputs" are.
  //
  // Deliberately requires every connected table to have gone through a
  // real Convert -- "Run" reads as a final action to a user, so silently
  // falling back to the 10-row schema-preview sample here (the way the
  // output drawer does for a plain table-card selection) would produce a
  // result that looks exactly as authoritative as a real one while
  // actually being a capped sample. `convertedTables` is keyed by each
  // table's own rect id (see TableData.rectId's comment in types.ts for
  // why that replaced name-keying) -- and a table card's node id already
  // IS that rect id, so it's read straight off `sourceId`, no
  // displayTables round-trip needed for this part.
  const resolveNodeInputs = useCallback((id: string): NodeTableInput[] => {
    // Excludes edges into the "extra" handle (Filter Builder's square
    // Extra Data port, see resolveExtraDataInput below) -- those aren't
    // another table to treat the same way as the primary inputs, so they
    // must never end up folded into this list.
    const sourceIds = Array.from(
      new Set(edges.filter((e) => e.target === id && e.targetHandle !== "extra").map((e) => e.source)),
    );
    const ordered = sourceIds
      .map((sourceId) => ({ sourceId, y: nodesRef.current.find((n) => n.id === sourceId)?.position.y ?? 0 }))
      .sort((a, b) => a.y - b.y)
      .map((s) => s.sourceId);
    const inputs: NodeTableInput[] = [];
    for (const sourceId of ordered) {
      const converted = convertedTables[sourceId];
      if (converted) {
        inputs.push(converted);
        continue;
      }
      // Not a table -- the source may be another processor node instead
      // (e.g. Horizontal Stack's output feeding into Filter Builder).
      // Node-to-node chaining was never wired up when Horizontal Stack was
      // the only real node (nothing to chain to yet); now that a second
      // one exists, an edge between two processor nodes is a completely
      // normal thing to draw, so its upstream run result needs to resolve
      // here too, not just raw converted tables.
      const upstreamOutput = nodeOutputs[sourceId];
      if (upstreamOutput) inputs.push(upstreamOutput);
    }
    return inputs;
  }, [edges, convertedTables, nodeOutputs]);

  // Resolves whatever's connected to a node's square "Extra Data" input
  // (currently just Filter Builder) -- kept separate from resolveNodeInputs
  // since it's a single, semantically different table (used for extra_ref
  // condition lookups), not another one to fold into the ordered list. Only
  // one edge is ever meaningful here; if more than one somehow exists,
  // the first one found wins.
  const resolveExtraDataInput = useCallback((id: string): NodeTableInput | undefined => {
    const sourceId = edges.find((e) => e.target === id && e.targetHandle === "extra")?.source;
    if (!sourceId) return undefined;
    return convertedTables[sourceId] ?? nodeOutputs[sourceId];
  }, [edges, convertedTables, nodeOutputs]);

  // Browse-specific input resolution -- unlike resolveNodeInputs above
  // (feeds a REAL backend run, which needs actually-converted data),
  // Browse just needs something to show, so it falls back to the same
  // capped schema-preview sample rows a plain table card's own drawer
  // preview already displays before anything's been Converted, instead
  // of showing nothing (or "No table connected") until a real Convert
  // happens for no real reason -- Browse never runs/transforms anything.
  const resolveBrowseInput = useCallback((id: string): (NodeTableInput & { isFullData: boolean }) | undefined => {
    const sourceId = edges.find((e) => e.target === id && e.targetHandle !== "extra")?.source;
    if (!sourceId) return undefined;
    const converted = convertedTables[sourceId];
    if (converted) return { ...converted, isFullData: true };
    const table = findDisplayTableByNodeId(sourceId);
    if (table) {
      // Pre-Convert sample -- displayTables.columns stays the raw
      // extracted names (App.tsx's handleRenameSchemaColumn keys renames
      // off them), so a rename made before ever hitting Convert has to be
      // applied here explicitly or Browse would show the stale name.
      const renames = rectById.get(sourceId)?.columnRenames;
      const columns = renames ? table.columns.map((c) => renames[c] ?? c) : table.columns;
      return { columns, rows: table.sampleRows, isFullData: false };
    }
    // An upstream processor node's own run result is always "final" data,
    // no partial/sample concept for those.
    const output = nodeOutputs[sourceId];
    return output ? { ...output, isFullData: true } : undefined;
  }, [edges, convertedTables, nodeOutputs, findDisplayTableByNodeId, rectById]);

  // Opens (or focuses/reseeds) the node's Configure window -- a real
  // separate native window (see electron/main.ts's filterBuilder:open),
  // not an in-page dialog. Column types are inferred once here, at open
  // time, from whatever's currently resolved as this node's primary/extra
  // input -- a snapshot, same as Settings' own payload; reopening later
  // (e.g. after reconverting an upstream table) reseeds with fresh values.
  const handleOpenFilterBuilder = useCallback((id: string) => {
    const proc = processorNodes.find((p) => p.id === id);
    if (!proc) return;
    const primary = resolveNodeInputs(id)[0];
    const inputColumns: FilterColumnDefinition[] = primary
      ? primary.columns.map((name, i) => inferColumnDefinition(name, primary.rows.map((r) => r[i] ?? "")))
      : [];
    const extra = proc.hasExtraInput ? resolveExtraDataInput(id) : undefined;
    window.alteraStudio.openFilterBuilderWindow({
      nodeId: id,
      nodeName: proc.name || proc.catalogName,
      // A brand-new node (never configured/applied yet, so proc.params is
      // still undefined) starts with one empty group already in place --
      // FilterBuilderWindow.tsx renumbers group ids on load regardless
      // (see its own loadPayload), so the id here is just a placeholder.
      // Without this, every new Filter Builder opened for the first time
      // needed an extra "Add Group" click before a condition could even
      // be added -- annoying busywork for something needed every time.
      initialParams: (proc.params as FilterBuilderParams | undefined) ?? { groups: [{ id: "group_0", match: "all", conditions: [] }] },
      inputColumns,
      extraColumns: extra ? extra.columns.map((name) => ({ name })) : [],
    });
    closeNodeCtxMenu();
  }, [processorNodes, resolveNodeInputs, resolveExtraDataInput, closeNodeCtxMenu]);

  // Opens (or focuses/reseeds) the node's Configure window -- same real-
  // window, snapshot-on-open pattern as Filter Builder above. Follows the
  // same "requires a real Convert" convention (resolveNodeInputs, not the
  // schema-preview-sample fallback resolveBrowseInput uses) since Header
  // Promoter runs a real backend transform, same as Filter Builder.
  const handleOpenHeaderPromoter = useCallback((id: string) => {
    const proc = processorNodes.find((p) => p.id === id);
    if (!proc) return;
    const primary = resolveNodeInputs(id)[0];
    window.alteraStudio.openHeaderPromoterWindow({
      nodeId: id,
      nodeName: proc.name || proc.catalogName,
      columns: primary?.columns ?? [],
      rows: primary?.rows ?? [],
      initialParams: (proc.params as HeaderPromoterParams | undefined) ?? { rowIndex: null, removeAbove: true },
    });
    closeNodeCtxMenu();
  }, [processorNodes, resolveNodeInputs, closeNodeCtxMenu]);

  // Opens (or focuses/reseeds) the node's Configure window -- same real-
  // window, snapshot-on-open pattern as Filter Builder/Header Promoter
  // above. Merge needs both its primary input (resolveNodeInputs, the
  // "requires a real Convert" convention) AND whatever's on its square
  // Extra Data port (resolveExtraDataInput) -- unlike Filter Builder,
  // where Extra Data is optional, Merge is meaningless without both.
  const handleOpenMerge = useCallback((id: string) => {
    const proc = processorNodes.find((p) => p.id === id);
    if (!proc) return;
    const primary = resolveNodeInputs(id)[0];
    const extra = resolveExtraDataInput(id);
    window.alteraStudio.openMergeWindow({
      nodeId: id,
      nodeName: proc.name || proc.catalogName,
      primaryColumns: primary?.columns ?? [],
      extraColumns: extra?.columns ?? [],
      initialParams: (proc.params as MergeParams | undefined) ?? { mergeType: "append", matchBy: "attributes", matchColumns: [] },
    });
    closeNodeCtxMenu();
  }, [processorNodes, resolveNodeInputs, resolveExtraDataInput, closeNodeCtxMenu]);

  // Opens (or focuses/reseeds) the node's Configure window -- same real-
  // window, snapshot-on-open pattern as Filter Builder/Header Promoter/
  // Merge above. Only needs the primary input's column NAMES (no rows --
  // there's no grid preview, matching the original OWMultiShiftColumns
  // widget's own column-checklist-only UI).
  const handleOpenShiftColumns = useCallback((id: string) => {
    const proc = processorNodes.find((p) => p.id === id);
    if (!proc) return;
    const primary = resolveNodeInputs(id)[0];
    window.alteraStudio.openShiftColumnsWindow({
      nodeId: id,
      nodeName: proc.name || proc.catalogName,
      columns: primary?.columns ?? [],
      initialParams: (proc.params as ShiftColumnsParams | undefined) ?? { selectedColumns: [], direction: "down", steps: 1 },
    });
    closeNodeCtxMenu();
  }, [processorNodes, resolveNodeInputs, closeNodeCtxMenu]);

  // Opens (or focuses/reseeds) the node's Configure window -- same real-
  // window, snapshot-on-open pattern as Filter Builder/Header Promoter/
  // Merge/Shift Columns above. Only needs the primary input's column
  // NAMES (no rows -- there's no grid preview, matching the original
  // OWCleaner widget's own operation-card-only UI).
  const handleOpenCleaner = useCallback((id: string) => {
    const proc = processorNodes.find((p) => p.id === id);
    if (!proc) return;
    const primary = resolveNodeInputs(id)[0];
    window.alteraStudio.openCleanerWindow({
      nodeId: id,
      nodeName: proc.name || proc.catalogName,
      columns: primary?.columns ?? [],
      // A brand-new node (never configured/applied yet, so proc.params is
      // still undefined) starts with one empty operation card already in
      // place (no column picked yet) -- same reasoning as Filter Builder's
      // default group above: needing an extra "+ Add" click every single
      // time before you can configure anything is just busywork.
      initialParams: (proc.params as CleanerParams | undefined) ?? { operations: [{ id: "op_0", columns: [], operation: "replace", params: {} }] },
    });
    closeNodeCtxMenu();
  }, [processorNodes, resolveNodeInputs, closeNodeCtxMenu]);

  // Opens (or focuses/reseeds) the node's Configure window -- same real-
  // window, snapshot-on-open pattern as the others above. Unlike Shift
  // Columns/Cleaner, this one also needs the primary input's ROWS (not
  // just column names) so the live Total/Duplicates/Output stat readout
  // can be computed client-side -- see UniqueWindow.tsx's own stats
  // useMemo, which mirrors backend/app/nodes.py's deduplicate_rows.
  const handleOpenUnique = useCallback((id: string) => {
    const proc = processorNodes.find((p) => p.id === id);
    if (!proc) return;
    const primary = resolveNodeInputs(id)[0];
    window.alteraStudio.openUniqueWindow({
      nodeId: id,
      nodeName: proc.name || proc.catalogName,
      columns: primary?.columns ?? [],
      rows: primary?.rows ?? [],
      initialParams: (proc.params as UniqueParams | undefined) ?? { columns: [], keep: "first" },
    });
    closeNodeCtxMenu();
  }, [processorNodes, resolveNodeInputs, closeNodeCtxMenu]);

  // Opens (or focuses/reseeds) the node's Configure window -- same real-
  // window, snapshot-on-open pattern as the others above. Only needs the
  // primary input's column NAMES (no rows -- there's no grid preview).
  const handleOpenColumnEdit = useCallback((id: string) => {
    const proc = processorNodes.find((p) => p.id === id);
    if (!proc) return;
    const primary = resolveNodeInputs(id)[0];
    window.alteraStudio.openColumnEditWindow({
      nodeId: id,
      nodeName: proc.name || proc.catalogName,
      columns: primary?.columns ?? [],
      initialParams: (proc.params as ColumnEditParams | undefined) ?? { columns: [], deletedColumns: [] },
    });
    closeNodeCtxMenu();
  }, [processorNodes, resolveNodeInputs, closeNodeCtxMenu]);

  // Opens (or focuses/reseeds) the node's Configure window -- same real-
  // window, snapshot-on-open pattern as the others above. Needs the
  // primary input's ROWS too (not just column names) so each field's
  // type dropdown can be pre-selected to what that column's values
  // currently look like.
  const handleOpenChangeType = useCallback((id: string) => {
    const proc = processorNodes.find((p) => p.id === id);
    if (!proc) return;
    const primary = resolveNodeInputs(id)[0];
    window.alteraStudio.openChangeTypeWindow({
      nodeId: id,
      nodeName: proc.name || proc.catalogName,
      columns: primary?.columns ?? [],
      rows: primary?.rows ?? [],
      initialParams: (proc.params as ChangeTypeParams | undefined) ?? { fields: [], fillUnconvertible: false, fallbackValue: "" },
    });
    closeNodeCtxMenu();
  }, [processorNodes, resolveNodeInputs, closeNodeCtxMenu]);

  // Opens (or focuses/reseeds) the node's Configure window -- same real-
  // window, snapshot-on-open pattern as the others above. Needs the
  // primary input's ROWS too (not just column names) so the live
  // match-preview grid has real data to highlight.
  const handleOpenRegex = useCallback((id: string) => {
    const proc = processorNodes.find((p) => p.id === id);
    if (!proc) return;
    const primary = resolveNodeInputs(id)[0];
    window.alteraStudio.openRegexWindow({
      nodeId: id,
      nodeName: proc.name || proc.catalogName,
      columns: primary?.columns ?? [],
      rows: primary?.rows ?? [],
      initialParams: (proc.params as RegexParams | undefined) ?? { column: "", pattern: "", mode: "smart_extract", literal: false, newColumnName: "Extracted" },
    });
    closeNodeCtxMenu();
  }, [processorNodes, resolveNodeInputs, closeNodeCtxMenu]);

  // Which nodes' Browse windows have been opened at least once, if any --
  // see the live-update effect right after handleOpenBrowse below. Each
  // node now gets its own independent window (electron/main.ts's
  // createPerNodeWindowManager), so several can be open at once and all
  // need to be tracked, not just the most recently opened one.
  const openBrowseNodeIdsRef = useRef<Set<string>>(new Set());

  // Opens (or focuses/reseeds) this node's own Browse data-viewer window --
  // same real-window pattern as Filter Builder above, just a plain snapshot
  // of whatever's currently resolved as this node's input (it has no
  // editable state, so no *AppliedPayload round-trip back into
  // processorNodes).
  const handleOpenBrowse = useCallback((id: string) => {
    const proc = processorNodes.find((p) => p.id === id);
    if (!proc) return;
    const input = resolveBrowseInput(id);
    window.alteraStudio.openBrowseWindow({
      nodeId: id,
      nodeName: proc.name || proc.catalogName,
      columns: input?.columns ?? [],
      rows: input?.rows ?? [],
    });
    // Tracked so the effect below keeps pushing live updates into this
    // node's (now non-modal, so it stays open during normal editing)
    // Browse window, alongside any other node's Browse window also open.
    openBrowseNodeIdsRef.current.add(id);
    closeNodeCtxMenu();
  }, [processorNodes, resolveBrowseInput, closeNodeCtxMenu]);

  // Keeps every already-open Browse window's data live instead of frozen
  // at whatever it showed on open -- reported as a real bug otherwise:
  // running Convert while Browse was open left it showing the stale
  // schema-preview sample until manually closed and reopened. Iterates
  // every node ever opened (not just the most recent) since several
  // Browse windows can now be open simultaneously, each its own real
  // window. Harmless (a little wasted IPC, nothing more) once a given
  // node's window has since been closed -- pushBrowseUpdate silently
  // no-ops there (electron/main.ts's pushUpdate only sends to a live,
  // non-destroyed window), and there's no signal back to stop tracking.
  const lastPushedBrowseInputRef = useRef<Map<string, { columns: string[]; rows: string[][] }>>(new Map());
  useEffect(() => {
    openBrowseNodeIdsRef.current.forEach((id) => {
      const proc = processorNodes.find((p) => p.id === id);
      if (!proc || proc.catalogName !== "Browse") return;
      const input = resolveBrowseInput(id);
      const columns = input?.columns ?? [];
      const rows = input?.rows ?? [];
      const last = lastPushedBrowseInputRef.current.get(id);
      if (last && last.columns === columns && last.rows === rows) return;
      lastPushedBrowseInputRef.current.set(id, { columns, rows });
      window.alteraStudio.pushBrowseUpdate({ nodeId: id, nodeName: proc.name || proc.catalogName, columns, rows });
    });
  }, [processorNodes, resolveBrowseInput]);

  // Single entry point for "open this node's window" (the icon double-
  // click and the context-menu item both go through this), dispatching to
  // whichever specific opener the node's catalog kind actually needs --
  // see NODE_KINDS_WITH_WINDOW/NODE_WINDOW_LABEL above for the full list.
  const handleOpenNodeWindow = useCallback((id: string) => {
    // Selects the node being configured (replacing whatever else was
    // selected), same as a plain double-click already does via react-
    // flow's own default click handling -- but opening Configure from the
    // right-click menu (onNodeContextMenu) never click-selects the node
    // it's on, so without this, whatever node happened to already be
    // selected (e.g. one the user checked the output of a minute earlier)
    // just silently stays selected through the whole Configure/Apply
    // round trip, reading as "a node I never touched got selected" --
    // reported as exactly that. Deselects are listed first so a redundant
    // select-false-then-select-true on the SAME id (already selected,
    // opened again) still nets out correctly.
    const alreadySelected = nodesRef.current.filter((n) => n.selected && n.id !== id).map((n) => n.id);
    onNodesChange([
      ...alreadySelected.map((otherId) => ({ type: "select" as const, id: otherId, selected: false })),
      { type: "select" as const, id, selected: true },
    ]);
    const proc = processorNodes.find((p) => p.id === id);
    if (proc?.catalogName === "Browse") handleOpenBrowse(id);
    else if (proc?.catalogName === "Header Promoter") handleOpenHeaderPromoter(id);
    else if (proc?.catalogName === "Merge") handleOpenMerge(id);
    else if (proc?.catalogName === "Shift Columns") handleOpenShiftColumns(id);
    else if (proc?.catalogName === "Cleaner") handleOpenCleaner(id);
    else if (proc?.catalogName === "Unique") handleOpenUnique(id);
    else if (proc?.catalogName === "Column Edit") handleOpenColumnEdit(id);
    else if (proc?.catalogName === "Change Type") handleOpenChangeType(id);
    else if (proc?.catalogName === "Regular Expressions") handleOpenRegex(id);
    else handleOpenFilterBuilder(id);
  }, [processorNodes, handleOpenBrowse, handleOpenHeaderPromoter, handleOpenMerge, handleOpenShiftColumns, handleOpenCleaner, handleOpenUnique, handleOpenColumnEdit, handleOpenChangeType, handleOpenRegex, handleOpenFilterBuilder, onNodesChange]);

  // `select`: only true for a user-initiated single-node run (the context
  // menu's "Run"), which is the one case selecting the node to show its
  // result in the output drawer actually makes sense. Auto-run and the
  // menu bar's "run everything" both call this too, but for THOSE, forcing
  // selection was a real bug: applying a Configure change cascades through
  // every downstream runnable node's own auto-run, each one calling this
  // and (before this flag existed) each one stealing selection from
  // whichever ran before it -- so whichever node happened to finish last in
  // the cascade (typically the last node in the flow, since runs cascade
  // downstream) ended up selected, with no relation to what the user
  // actually clicked. Reported as exactly that: "the last node in the flow
  // got automatically selected."
  const handleRunProcessorNode = useCallback(async (id: string, select = false) => {
    if (nodeRunStatus[id]?.state === "running") return;

    const proc = processorNodes.find((p) => p.id === id);
    if (!proc) return;
    const kind = NODE_KIND_SLUGS[proc.catalogName];
    if (!kind) return;

    const inputs = resolveNodeInputs(id);
    const minInputs = NODE_MIN_INPUTS[proc.catalogName] ?? 1;
    if (inputs.length < minInputs) {
      // Bails out to the exact same `prev` reference (a real React no-op,
      // no re-render) when the status is already this same error --
      // defense in depth against the auto-run effect (or a future caller)
      // re-invoking this repeatedly with no real change: an unconditional
      // setState here previously fed a real infinite-render loop, since a
      // new status object changes this callback's own identity, which
      // changes ITS callers' identities, which can retrigger whatever
      // called this in the first place.
      const message = minInputs > 1
        ? `Connect at least ${minInputs} converted tables (run Convert first).`
        : "Connect a converted table (run Convert first).";
      setNodeRunStatus((prev) =>
        prev[id]?.state === "error" && prev[id]?.error === message ? prev : { ...prev, [id]: { state: "error", error: message } },
      );
      // Drop this node's last successful output too -- otherwise a node
      // whose input got disconnected (or never had enough to begin with)
      // still shows its PREVIOUS run's data forever: in its own output
      // drawer if selected, and to any downstream node chained off it via
      // resolveNodeInputs' own nodeOutputs[sourceId] lookup, which has no
      // way to tell "genuinely still connected" from "stale leftover."
      // Reported as exactly that -- disconnecting a node's input still
      // showed its old output. Same no-op-if-already-clear guard as the
      // status update above, for the same infinite-render reason.
      setNodeOutputs((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    // Extra Data (Filter Builder's square input) rides along as a second
    // entry after the primary input(s) -- backend/app/nodes.py's
    // filter_builder reads it as dfs[1] if present. Silently omitted if
    // nothing's connected there or it hasn't been converted yet -- Extra
    // Data is always optional, unlike the primary input(s) above.
    if (proc.hasExtraInput) {
      const extra = resolveExtraDataInput(id);
      if (extra) inputs.push(extra);
    }

    // Merge otherwise sits unrunnable (or runs against an empty match
    // config) until the user opens Configure and hits Apply by hand, even
    // once both inputs resolve -- same default-pair rule Configure's own
    // initial state uses (computeDefaultMatchPair), applied here too so
    // the common case (an obvious shared join column) just works the
    // moment both tables are connected. Only kicks in while genuinely
    // unconfigured (no saved matchColumns yet) -- never overwrites a pair
    // the user picked or cleared by hand -- and persists what it finds so
    // this only computes once and Configure shows the same pair if opened
    // later.
    let runParams: Record<string, unknown> = proc.params ?? {};
    if (proc.catalogName === "Merge" && inputs.length >= 2) {
      const mergeParams = proc.params as MergeParams | undefined;
      const unconfigured = !mergeParams || (mergeParams.matchBy !== "row_index" && (mergeParams.matchColumns?.length ?? 0) === 0);
      if (unconfigured) {
        const defaultPair = computeDefaultMatchPair(inputs[0].columns, inputs[1].columns);
        if (defaultPair) {
          const newParams: MergeParams = {
            mergeType: mergeParams?.mergeType ?? "append",
            matchBy: "attributes",
            matchColumns: [{ id: "pair_0", ...defaultPair }],
          };
          runParams = newParams as unknown as Record<string, unknown>;
          onUpdateProcessorNodeParams(id, runParams);
        }
      }
    }

    setNodeRunStatus((prev) => ({ ...prev, [id]: { state: "running" } }));
    try {
      const result = await runProcessorNode(kind, inputs, runParams);
      if (!processorNodesRef.current.some((p) => p.id === id)) return; // deleted mid-run
      setNodeOutputs((prev) => ({ ...prev, [id]: { columns: result.columns, rows: result.rows } }));
      setNodeRunStatus((prev) => ({
        ...prev,
        [id]: {
          state: "done",
          warnings: result.warnings.length ? result.warnings : undefined,
          info: result.info.length ? result.info : undefined,
        },
      }));
      // Select the node so the output drawer opens the same way selecting
      // a table card already does -- only for an explicit single-node run,
      // see the `select` param comment above.
      if (select) setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === id })));
    } catch (e) {
      if (!processorNodesRef.current.some((p) => p.id === id)) return;
      setNodeRunStatus((prev) => ({ ...prev, [id]: { state: "error", error: e instanceof Error ? e.message : String(e) } }));
    }
  }, [nodeRunStatus, processorNodes, resolveNodeInputs, resolveExtraDataInput, onUpdateProcessorNodeParams]);

  // ── Sequential run queue ──────────────────────────────────────────────
  // Runs enqueued nodes strictly one at a time, in enqueue order --
  // without this, both auto-run below and the Run-all button used to fire
  // every eligible node in the same tick (fire-and-forget, not awaited),
  // so several would genuinely run concurrently. That's the actual reason
  // NodeStatusLights' red/amber/green cycle didn't read as "the pipeline
  // executing in order": multiple nodes really were mid-run at once. A
  // plain ref-backed queue (not React state -- nothing here needs to
  // trigger a render) drained by a single in-flight `await` loop, refilled
  // by whichever caller enqueues next.
  const runQueueRef = useRef<{ id: string; select?: boolean }[]>([]);
  const isDrainingRunQueueRef = useRef(false);
  // handleRunProcessorNode is a useCallback that changes identity after
  // EVERY run (it depends on nodeRunStatus/resolveNodeInputs, both of
  // which update once a run finishes) -- calling it directly from inside
  // the while loop below would close over whatever version existed when
  // THIS drainRunQueue() call started, for its entire lifetime, no matter
  // how many re-renders happen while it's draining. That stale closure's
  // resolveNodeInputs still has the *previous* nodeOutputs/convertedTables
  // baked in, so every node after the first would see its upstream as not
  // yet having run and fail to resolve its inputs, even though the real,
  // current state already has it -- a queue that appeared to do nothing
  // because everything past the first node was erroring out silently and
  // near-instantly. Routing through a ref that's kept in sync on every
  // render sidesteps this: each loop iteration calls whatever
  // handleRunProcessorNode currently is, not whatever it was when the
  // loop started.
  const handleRunProcessorNodeRef = useRef(handleRunProcessorNode);
  useEffect(() => { handleRunProcessorNodeRef.current = handleRunProcessorNode; }, [handleRunProcessorNode]);
  const drainRunQueue = useCallback(async () => {
    if (isDrainingRunQueueRef.current) return;
    isDrainingRunQueueRef.current = true;
    while (runQueueRef.current.length > 0) {
      const entry = runQueueRef.current.shift()!;
      await handleRunProcessorNodeRef.current(entry.id, entry.select);
    }
    isDrainingRunQueueRef.current = false;
  }, []);
  // `select` (auto-open the output drawer once done -- see
  // handleRunProcessorNode's own param) sticks if a duplicate enqueue asks
  // for it, even if the pending entry didn't originally.
  const enqueueRun = useCallback((id: string, select?: boolean) => {
    const existing = runQueueRef.current.find((e) => e.id === id);
    if (existing) {
      if (select) existing.select = true;
    } else {
      runQueueRef.current.push({ id, select });
    }
    drainRunQueue();
  }, [drainRunQueue]);

  // ── Auto-run ───────────────────────────────────────────────────────────
  // A runnable node runs automatically whenever its resolved inputs
  // actually change -- these are already coarse, deliberate events (a real
  // Convert finishing, an edge connected/disconnected, or a Configure
  // dialog Apply -- see params in the signature below), not something that
  // fires on every keystroke while editing (nothing commits until Apply,
  // see FilterBuilderWindow.tsx), so no debouncing is needed here.
  //
  // A per-node signature (not just "did inputs.length change") guards
  // against re-running a node whose inputs haven't actually changed just
  // because this effect's OTHER dependencies (e.g. `nodes`, touched by this
  // same run's own auto-select-on-success) changed for an unrelated reason.
  const lastAutoRunInputsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    processorNodes.forEach((proc) => {
      if (!RUNNABLE_NODE_KINDS.has(proc.catalogName)) return;
      if (nodeRunStatus[proc.id]?.state === "running") return;
      const inputs = resolveNodeInputs(proc.id);
      if (inputs.length < (NODE_MIN_INPUTS[proc.catalogName] ?? 1)) return; // not ready -- manual Run still explains why, no need to spam that here
      const extra = proc.hasExtraInput ? resolveExtraDataInput(proc.id) : undefined;
      const signature = JSON.stringify({ inputs, extra, params: proc.params });
      if (lastAutoRunInputsRef.current[proc.id] === signature) return;
      lastAutoRunInputsRef.current[proc.id] = signature;
      enqueueRun(proc.id);
    });
  }, [processorNodes, resolveNodeInputs, resolveExtraDataInput, nodeRunStatus, enqueueRun]);

  // ── Force-run (menu bar play button) ──────────────────────────────────
  // Runs every runnable node, regardless of whether auto-run already
  // thinks it's up to date -- unlike auto-run, this deliberately enqueues
  // every runnable node even with fewer than 2 resolved inputs, so a node
  // that can't run surfaces its own error state instead of being silently
  // skipped (a forced "run everything" should show the state of
  // everything, not just what was ready).
  //
  // Enqueued in topological order (topologicalRunOrder), not processorNodes'
  // own array order -- running strictly one at a time (the sequential
  // queue above) means a downstream node's turn only comes up once its
  // upstream has already finished and written fresh nodeOutputs, so this
  // is also what makes a single "Run" press correctly cascade real data
  // through the whole pipeline in one go, not just visually animate in
  // order.
  const handleRunAllProcessorNodes = useCallback(() => {
    const runnableIds = processorNodes.filter((p) => RUNNABLE_NODE_KINDS.has(p.catalogName)).map((p) => p.id);
    const order = topologicalRunOrder(runnableIds, edges, nodesRef.current);
    for (const id of order) {
      const proc = processorNodes.find((p) => p.id === id);
      if (!proc) continue;
      const extra = proc.hasExtraInput ? resolveExtraDataInput(id) : undefined;
      lastAutoRunInputsRef.current[id] = JSON.stringify({ inputs: resolveNodeInputs(id), extra, params: proc.params });
      enqueueRun(id);
    }
  }, [processorNodes, edges, resolveNodeInputs, resolveExtraDataInput, enqueueRun]);
  // Compares the actual runAllSignal VALUE, not "has this effect ever run
  // before" -- handleRunAllProcessorNodes (and therefore this effect's own
  // dependency array) changes reference whenever ANY of processorNodes/
  // resolveNodeInputs/handleRunProcessorNode do, which includes things
  // totally unrelated to the play button (e.g. nodeRunStatus updating from
  // a run this same effect just triggered). A boolean "already fired once"
  // guard doesn't protect against that -- it only skips the very first
  // invocation, so every later spurious re-fire would call the handler
  // again, which (for a node with unmet inputs) sets nodeRunStatus again,
  // which changes handleRunProcessorNode's identity, which changes this
  // effect's deps again -- a real infinite loop, caught live via React's
  // "Maximum update depth exceeded". Tracking the signal's own value
  // sidesteps this entirely: the effect can re-fire as often as it wants,
  // it only ever acts when runAllSignal itself has actually changed.
  const lastRunAllSignalRef = useRef(runAllSignal);
  useEffect(() => {
    if (runAllSignal === lastRunAllSignalRef.current) return;
    lastRunAllSignalRef.current = runAllSignal;
    handleRunAllProcessorNodes();
  }, [runAllSignal, handleRunAllProcessorNodes]);

  // Spacebar is overloaded, disambiguated by tap vs. hold (Blender/Figma
  // convention) instead of both firing on the same keydown, which is what
  // made them "conflict" before: a quick tap opens the node picker; holding
  // it down instead temporarily grants left-drag panning (spacePanning
  // below), same spirit as the Canvas view's own space-held hand tool (see
  // App.tsx's showSchema guard on that handler -- this is Workflow's own,
  // independent version of the same idea). Classified on keyUp by duration,
  // not on keyDown, since you can't know it was "just a tap" until released.
  // Scoped to `visible` so it only applies while Workflow is the active
  // view, and skipped while any text input has focus so it doesn't hijack
  // typing (including the picker's own search box, once open).
  const [spacePanning, setSpacePanning] = useState(false);
  const spaceDownAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!visible) return;
    const isTypingTarget = () => {
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!active?.isContentEditable;
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTypingTarget()) return;
      e.preventDefault();
      if (e.repeat) return; // OS key-repeat while held -- not a new press
      spaceDownAtRef.current = Date.now();
      setSpacePanning(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      setSpacePanning(false);
      const downAt = spaceDownAtRef.current;
      spaceDownAtRef.current = null;
      if (downAt !== null && Date.now() - downAt < SPACE_TAP_MAX_MS) {
        pendingConnectionSourceRef.current = null;
        openNodePicker(lastMouseScreenPos.current.x, lastMouseScreenPos.current.y);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [visible, openNodePicker]);

  // Auto-focus the search box on open, close on Escape or an outside click.
  useEffect(() => {
    if (!pickerOpen) return;
    pickerSearchRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNodePicker();
    };
    const handleClickOutside = () => closeNodePicker();
    window.addEventListener("keydown", handleKeyDown);
    // Capture phase + next-tick registration: the very click/contextmenu
    // that opened the picker would otherwise immediately bubble up to this
    // same listener and close it again in the same event loop turn.
    const id = window.setTimeout(() => window.addEventListener("mousedown", handleClickOutside), 0);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("mousedown", handleClickOutside);
      window.clearTimeout(id);
    };
  }, [pickerOpen, closeNodePicker]);

  const pickerResults = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const filtered = q ? NODE_CATALOG.filter((n) => n.name.toLowerCase().includes(q)) : NODE_CATALOG;
    return CATEGORY_ORDER.map((key) => ({
      key,
      meta: CATEGORY_META[key],
      items: filtered.filter((n) => n.category === key),
    })).filter((g) => g.items.length > 0);
  }, [pickerQuery]);

  const handlePickNode = useCallback(
    (entry: DraggedNodeEntry) => {
      const newId = onAddProcessorNode(entry, pickerFlowPos);
      const pending = pendingConnectionSourceRef.current;
      pendingConnectionSourceRef.current = null;
      if (pending) {
        onConnect({ source: pending.nodeId, sourceHandle: pending.handleId, target: newId, targetHandle: null });
      }
      closeNodePicker();
    },
    [onAddProcessorNode, onConnect, pickerFlowPos, closeNodePicker],
  );

  // ── Multi-select + Photoshop-style align/distribute toolbar ──────────
  // Node "select" changes already flow through onNodesChange unmodified
  // (its meaningfulChanges filter only special-cases "remove"/"dimensions"
  // above), so click/Shift-click/marquee-select on table cards work with no
  // extra wiring -- group boxes opt out via `selectable: false` above so a
  // box being "selected" alongside cards never gets treated as alignable.
  const selectedTableNodes = useMemo(
    () => nodes.filter((n) => n.selected && n.type === "tableNode"),
    [nodes],
  );
  // The align/distribute toolbar's own operand set -- table cards AND
  // processor nodes together, so multi-selecting either kind (or a mix)
  // aligns them. Kept separate from selectedTableNodes (which several
  // table-card-only things below still key off, e.g. the output drawer's
  // "exactly one card selected" check) rather than broadening that one in
  // place. applyAbsolutePositions above persists each node correctly per
  // its own type.
  const selectedAlignableNodes = useMemo(
    () => nodes.filter((n) => n.selected && (n.type === "tableNode" || n.type === "processorNode")),
    [nodes],
  );
  const selectedProcessorNode = useMemo(() => {
    const sel = nodes.filter((n) => n.selected && n.type === "processorNode");
    return sel.length === 1 ? sel[0] : null;
  }, [nodes]);

  // ── Output drawer -- previews the single selected card's (or a run
  // processor node's) data. Table lookups go through displayTables rather
  // than the node's own data, via findDisplayTableByNodeId (the same
  // rect-id-based scheme a table card's own node id is derived from).
  const [outputDrawerExpanded, setOutputDrawerExpanded] = useState(false);
  const [drawerHeight, setDrawerHeight] = useState(DRAWER_DEFAULT_HEIGHT);
  const selectedTable = useMemo(() => {
    if (selectedProcessorNode) {
      const proc = processorNodes.find((p) => p.id === selectedProcessorNode.id);
      // Browse (hasOutput: false in nodeCatalog.ts) is a pure viewer --
      // Orange's own Data Table widget, ported here as "just show
      // whatever's connected." It never runs and never writes to
      // nodeOutputs (nothing to produce), so its drawer preview is its
      // resolved INPUT instead, live-reflecting the connected table with
      // no separate "Run" step, same as a plain table card would.
      if (proc?.catalogName === "Browse") {
        const input = resolveBrowseInput(selectedProcessorNode.id);
        if (!input) return null;
        return {
          name: proc.name || proc.catalogName,
          columns: input.columns,
          sampleRows: input.rows,
          rowCount: input.rows.length,
          isFullData: input.isFullData,
        };
      }
      const output = nodeOutputs[selectedProcessorNode.id];
      if (!output) return null;
      return {
        name: proc?.name || proc?.catalogName || "Output",
        columns: output.columns,
        sampleRows: output.rows,
        rowCount: output.rows.length,
        isFullData: true as const,
      };
    }
    if (selectedTableNodes.length !== 1) return null;
    const id = selectedTableNodes[0].id;
    const preview = findDisplayTableByNodeId(id) ?? null;
    if (!preview) return null;
    // A real Convert run supersedes the schema-preview sample entirely --
    // once a table's been actually converted, the drawer should show what
    // was really extracted, not the 10-row/10-page preview cap. `id` here
    // already IS the table's rect id (its Workflow-canvas node id), which
    // is exactly what convertedTables is keyed by.
    const converted = convertedTables[id];
    if (converted) {
      return { ...preview, columns: converted.columns, sampleRows: converted.rows, rowCount: converted.rows.length, isFullData: true as const };
    }
    // Pre-Convert sample -- same rename patch as resolveBrowseInput's own
    // fallback above (displayTables.columns stays the raw extracted names).
    const renames = rectById.get(id)?.columnRenames;
    const columns = renames ? preview.columns.map((c) => renames[c] ?? c) : preview.columns;
    return { ...preview, columns, isFullData: false as const };
  }, [selectedProcessorNode, nodeOutputs, processorNodes, selectedTableNodes, findDisplayTableByNodeId, convertedTables, resolveBrowseInput, rectById]);

  // AG-Grid's own row-model diffing treats a new `rowData`/`columnDefs`
  // ARRAY REFERENCE as "the data changed", even if every cell is identical
  // -- and `selectedTable` above is always a freshly-spread object, so
  // depending on it directly would recompute these on every SchemaView
  // render. Depending on `selectedTable.sampleRows`/`.columns` INSTEAD --
  // the actual underlying arrays copied in by that spread (from
  // nodeOutputs/convertedTables/the schema-preview sample, all of which
  // stay referentially stable across a drag) -- lets these bail out to
  // their previous reference whenever the real cell data hasn't changed.
  // Without this, dragging any card or node while the output drawer was
  // open was visibly laggy: React Flow reports a new `nodes` array on
  // every single frame of a drag, which flowed through
  // selectedTableNodes/selectedProcessorNode into a freshly-rebuilt
  // `selectedTable` every frame, which (via the old inline .map() calls)
  // hand AG-Grid a "new" dataset ~60 times a second regardless of whether
  // the DISPLAYED table had anything to do with the node being dragged.
  const outputRowData = useMemo(() => {
    if (!selectedTable) return null;
    return selectedTable.sampleRows.map((row) =>
      Object.fromEntries(selectedTable.columns.map((col, ci) => [col, row[ci] ?? ""])),
    );
  }, [selectedTable?.sampleRows, selectedTable?.columns]);
  // colId defaults to `field` when unset -- since many extracted tables
  // here share the exact same generic column names ("Column_1", "Page",
  // from single-column PDF tables), AG-Grid's own column diffing (which
  // matches old->new columns by colId when it receives a new columnDefs
  // array) was treating a switch to a DIFFERENT table's "Column_1" as the
  // SAME column as before, sometimes keeping stale cell output rather
  // than refreshing it (confirmed via direct tracing: the underlying
  // rowData/columnDefs computed here were always correct, so the
  // staleness was AG-Grid's own internal reuse, not a data bug).
  // Scoping colId by table name forces AG-Grid to treat every table's
  // columns as genuinely distinct, fixing that without needing to force
  // a full grid remount on every switch (which fixed the same bug but
  // visibly flashed/redrew the whole grid each time).
  // Power-Query-style type icon before each header's name (see
  // columnTypeDetection.ts/columnTypeIcons.tsx), sampled from whatever
  // rows this table already has on hand (sampleRows -- already capped,
  // whether that's a 10-row schema-preview sample or a real Converted/run
  // result).
  const outputColumnDefs = useMemo(() => {
    if (!selectedTable) return null;
    return [
      makeRowNumberColDef(selectedTable.rowCount),
      ...selectedTable.columns.map((col, ci): ColDef => {
        const sample = selectedTable.sampleRows.slice(0, DETECTION_SAMPLE_ROWS).map((row) => row[ci] ?? "");
        return {
          field: col,
          headerName: col,
          colId: `${selectedTable.name}::${ci}::${col}`,
          headerComponentParams: {
            innerHeaderComponent: TypedColumnHeader,
            innerHeaderComponentParams: { detectedType: detectColumnType(sample) },
          },
        };
      }),
    ];
  }, [selectedTable?.columns, selectedTable?.name, selectedTable?.rowCount, selectedTable?.sampleRows]);

  // A processor node CAN be selected with no output yet (never run, still
  // running, or its last run errored) -- `selectedTable` is null in all
  // three cases, which without this would fall through to the same generic
  // "nothing selected" placeholder as an empty canvas, reading as broken
  // ("I connected two tables and selected the node, but nothing shows")
  // rather than explaining what's actually going on.
  const selectedProcessorNodeHint = useMemo(() => {
    if (!selectedProcessorNode || selectedTable) return null;
    // Browse never runs (see the `selectedTable` branch above) -- the
    // generic "not run yet, connect 2+ tables" copy below is about
    // RUNNABLE_NODE_KINDS's auto-run behavior, which doesn't apply to it
    // and would be actively misleading here.
    const proc = processorNodes.find((p) => p.id === selectedProcessorNode.id);
    if (proc?.catalogName === "Browse") return "Connect a table to preview it here.";
    const status = nodeRunStatus[selectedProcessorNode.id];
    if (status?.state === "running") return "Running…";
    if (status?.state === "error") return status.error ?? "That run failed.";
    // Idle here almost always means "not enough converted inputs yet" --
    // a node with 2+ already runs itself (see the auto-run effect above),
    // so telling the user to manually right-click -> Run would be
    // inaccurate/misleading now that auto-run exists.
    return "Not run yet -- connect at least 2 converted tables and it'll run automatically.";
  }, [selectedProcessorNode, selectedTable, nodeRunStatus, processorNodes]);

  // Every message from the selected node's last run, not just the single
  // highest-priority one the node's own corner badge shows (error beats
  // warning beats info there, so a run with both warnings AND info notes
  // silently hid whichever lost that tiebreak -- nowhere else surfaced
  // it). Reads the real nodeRunStatus (not heldRunStatus, the
  // minimum-visible-duration-padded version NodeStatusLights reads) --
  // that padding is only about making the amber light itself perceivable
  // on a fast run, not something log CONTENT needs.
  const selectedProcessorNodeLog = useMemo((): NodeLogEntry[] => {
    if (!selectedProcessorNode) return [];
    const status = nodeRunStatus[selectedProcessorNode.id];
    if (!status) return [];
    const entries: NodeLogEntry[] = [];
    if (status.state === "error" && status.error) entries.push({ type: "error", message: status.error });
    (status.warnings ?? []).forEach((message) => entries.push({ type: "warning", message }));
    (status.info ?? []).forEach((message) => entries.push({ type: "info", message }));
    return entries;
  }, [selectedProcessorNode, nodeRunStatus]);

  // Reports the above up to App.tsx's Log dock panel (see
  // onSelectedNodeLogChange's own comment) -- a plain useEffect rather
  // than firing onSelectedNodeLogChange straight from the memo above,
  // since App.tsx owning this as its own state (not just reading a value
  // computed here) is what lets the dock panel render it: dock panels are
  // siblings of this whole component in the tree, not descendants, so
  // there's no other way for one to see state that's only ever lived in
  // here.
  useEffect(() => {
    if (!selectedProcessorNode) {
      onSelectedNodeLogChange(null);
      return;
    }
    const nodeName = (selectedProcessorNode.data as { name?: string }).name ?? "Node";
    onSelectedNodeLogChange({ nodeName, entries: selectedProcessorNodeLog });
  }, [selectedProcessorNode, selectedProcessorNodeLog, onSelectedNodeLogChange]);

  // Auto-open the drawer when a NEW single card or run node gets selected
  // (setting-gated), and auto-close it again once selection is cleared --
  // but only if THIS open is the one auto-open caused. A manual open
  // (clicking the handle, or dragging it open) clears the flag, so
  // deselecting afterward leaves a manually-opened drawer alone rather
  // than yanking it shut.
  const prevAutoExpandIdRef = useRef<string | null>(null);
  const drawerOpenedByAutoRef = useRef(false);
  useEffect(() => {
    const currentId = selectedTableNodes.length === 1
      ? selectedTableNodes[0].id
      : selectedProcessorNode?.id ?? null;
    if (currentId && currentId !== prevAutoExpandIdRef.current && autoExpandOutputDrawer) {
      setOutputDrawerExpanded(true);
      drawerOpenedByAutoRef.current = true;
    } else if (!currentId && drawerOpenedByAutoRef.current) {
      setOutputDrawerExpanded(false);
      drawerOpenedByAutoRef.current = false;
    }
    prevAutoExpandIdRef.current = currentId;
  }, [selectedTableNodes, selectedProcessorNode, autoExpandOutputDrawer]);

  // The drawer grows upward from the bottom with no ceiling of its own --
  // capped only at a flat DRAWER_MAX_HEIGHT, dragging it past the actual
  // wrapper's height pushed its own handle bar (the only way to shrink or
  // collapse it) above the visible area, with nothing left on screen to
  // grab to get it back. Clamping against the wrapper's real measured
  // height, not just the flat constant, keeps the handle reachable.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const getMaxDrawerHeight = useCallback(() => {
    const wrapperHeight = wrapperRef.current?.getBoundingClientRect().height ?? DRAWER_MAX_HEIGHT;
    return Math.max(DRAWER_MIN_HEIGHT, Math.min(DRAWER_MAX_HEIGHT, wrapperHeight - MIN_VISIBLE_CANVAS));
  }, []);

  // Re-clamp if the window/wrapper shrinks after the fact (not just during
  // a drag) -- otherwise resizing the app smaller could reproduce the same
  // "handle pushed off screen" problem without the user ever dragging again.
  // Gated on `visible` too: switching to Canvas hides this view via CSS
  // `display: none` (SchemaView itself stays mounted -- see App.tsx), which
  // collapses the wrapper to 0x0 and fires this same ResizeObserver. Without
  // the `visible` check, that 0-height reading got permanently ratcheted in
  // as the new max (getMaxDrawerHeight() floors at DRAWER_MIN_HEIGHT), so
  // the drawer came back pinned at its minimum every time Workflow reopened
  // -- looking like its size kept silently resetting.
  useEffect(() => {
    if (!outputDrawerExpanded || !visible) return;
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setDrawerHeight((h) => Math.min(h, getMaxDrawerHeight()));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [outputDrawerExpanded, visible, getMaxDrawerHeight]);

  // Drag-to-resize on the drawer's top edge -- raw window-level
  // mousemove/mouseup (not React's synthetic handlers), same pattern the
  // rest of the app's own drag interactions use, since the pointer routinely
  // leaves the handle strip itself mid-drag. Dragging up from collapsed
  // opens the drawer straight to the dragged height, matching "expandable by
  // click OR drag" rather than requiring a click first.
  const handleDrawerResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startHeight = outputDrawerExpanded ? drawerHeight : DRAWER_DEFAULT_HEIGHT;
    const maxHeight = getMaxDrawerHeight();
    let dragged = false;

    const handleMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      if (!dragged && Math.abs(delta) < 3) return;
      dragged = true;
      setOutputDrawerExpanded(true);
      drawerOpenedByAutoRef.current = false;
      setDrawerHeight(Math.min(maxHeight, Math.max(DRAWER_MIN_HEIGHT, startHeight + delta)));
    };
    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }, [outputDrawerExpanded, drawerHeight]);

  // For a processor node, returns its own 42x42 icon square (see
  // PROCESSOR_NODE_CORE_SIZE's comment) instead of node.measured's full
  // outer box, which also includes the name/description text below it --
  // aligning/distributing by the full box would center or space nodes
  // using each one's text width, not the actual icon, so two nodes with
  // different-length names would visibly NOT line up by their icons even
  // though the toolbar reported them as "aligned." iconOffsetX/Y is how
  // far this returned rect's origin sits from the node's own -- 0 for a
  // table card (its measured box IS what should align), the horizontal
  // centering offset for a processor node -- applyAbsolutePositions below
  // subtracts it back out before writing the node's actual position.
  const getAbsoluteRect = useCallback((instance: ReactFlowInstance, node: Node) => {
    const abs = instance.getInternalNode(node.id)?.internals.positionAbsolute ?? node.position;
    if (node.type === "processorNode") {
      const fullWidth = node.measured?.width ?? PROCESSOR_NODE_CORE_SIZE;
      const iconOffsetX = (fullWidth - PROCESSOR_NODE_CORE_SIZE) / 2;
      return {
        node,
        x: abs.x + iconOffsetX,
        y: abs.y,
        width: PROCESSOR_NODE_CORE_SIZE,
        height: PROCESSOR_NODE_CORE_SIZE,
        iconOffsetX,
        iconOffsetY: 0,
      };
    }
    return {
      node,
      x: abs.x,
      y: abs.y,
      width: node.measured?.width ?? CARD_ESTIMATED_WIDTH,
      height: node.measured?.height ?? CARD_ESTIMATED_HEIGHT,
      iconOffsetX: 0,
      iconOffsetY: 0,
    };
  }, []);

  // Shared commit step for both align and distribute: given each selected
  // node's desired new ABSOLUTE position, convert it into that node's own
  // immediate-parent-relative frame (table cards can belong to different
  // group boxes, or none; processor nodes never do), write it into node
  // state, and persist every moved node -- exactly as a manual drag-stop
  // would (see handleNodeDragStop's own per-type persistence above), so
  // alignment actually affects output-slot order immediately and survives
  // a save/reload, for both table cards and processor nodes.
  const applyAbsolutePositions = useCallback(
    (
      instance: ReactFlowInstance,
      rects: ReturnType<typeof getAbsoluteRect>[],
      newAbsPosition: (r: ReturnType<typeof getAbsoluteRect>) => { x: number; y: number },
    ) => {
      const updates = rects.map((r) => {
        // newAbsPosition works in terms of the rect getAbsoluteRect
        // returned (the icon square for a processor node) -- translate
        // back to the actual node origin before writing/persisting it.
        const iconAbs = newAbsPosition(r);
        const abs = { x: iconAbs.x - r.iconOffsetX, y: iconAbs.y - r.iconOffsetY };
        const parentAbs = r.node.parentId
          ? instance.getInternalNode(r.node.parentId)?.internals.positionAbsolute
          : undefined;
        return {
          id: r.node.id,
          type: r.node.type,
          processorId: (r.node.data as { processorId?: string }).processorId,
          relPosition: { x: parentAbs ? abs.x - parentAbs.x : abs.x, y: parentAbs ? abs.y - parentAbs.y : abs.y },
          absPosition: abs,
        };
      });
      const updatesById = new Map(updates.map((u) => [u.id, u]));
      setNodes((prev) => prev.map((n) => {
        const u = updatesById.get(n.id);
        return u ? { ...n, position: u.relPosition } : n;
      }));
      updates.forEach((u) => {
        // A table card's node id already IS its rectangle's own id (see
        // handleNodeDragStop's own comment) -- no separate lookup needed.
        if (u.type === "tableNode") onUpdateTablePosition(u.id, u.absPosition.x, u.absPosition.y);
        else if (u.type === "processorNode" && u.processorId) onUpdateProcessorNodePosition(u.processorId, u.absPosition.x, u.absPosition.y);
      });
    },
    [onUpdateTablePosition, onUpdateProcessorNodePosition],
  );

  type AlignMode = "hcenter" | "vcenter";
  const ALIGN_CONFIGS: Record<AlignMode, {
    axis: "x" | "y";
    target: (rs: ReturnType<typeof getAbsoluteRect>[]) => number;
    apply: (r: ReturnType<typeof getAbsoluteRect>, target: number) => number;
  }> = {
    hcenter: { axis: "x", target: (rs) => (Math.min(...rs.map((r) => r.x)) + Math.max(...rs.map((r) => r.x + r.width))) / 2, apply: (r, t) => t - r.width / 2 },
    vcenter: { axis: "y", target: (rs) => (Math.min(...rs.map((r) => r.y)) + Math.max(...rs.map((r) => r.y + r.height))) / 2, apply: (r, t) => t - r.height / 2 },
  };

  const handleAlign = useCallback((mode: AlignMode) => {
    const instance = reactFlowInstanceRef.current;
    if (!instance || selectedAlignableNodes.length < 2) return;
    const rects = selectedAlignableNodes.map((n) => getAbsoluteRect(instance, n));
    const cfg = ALIGN_CONFIGS[mode];
    const target = cfg.target(rects);
    applyAbsolutePositions(instance, rects, (r) =>
      cfg.axis === "x" ? { x: cfg.apply(r, target), y: r.y } : { x: r.x, y: cfg.apply(r, target) },
    );
  }, [selectedAlignableNodes, getAbsoluteRect, applyAbsolutePositions]);

  // Distributes by evenly spacing centers between the first and last card
  // along the axis (Photoshop's default "distribute centers" behavior) --
  // the two extremes stay put, only the ones in between move.
  const handleDistribute = useCallback((axis: "horizontal" | "vertical") => {
    const instance = reactFlowInstanceRef.current;
    if (!instance || selectedAlignableNodes.length < 3) return;
    const rects = selectedAlignableNodes.map((n) => getAbsoluteRect(instance, n));
    const posKey = axis === "horizontal" ? "x" : "y";
    const sizeKey = axis === "horizontal" ? "width" : "height";
    const sorted = [...rects].sort((a, b) => a[posKey] - b[posKey]);
    const firstCenter = sorted[0][posKey] + sorted[0][sizeKey] / 2;
    const lastCenter = sorted[sorted.length - 1][posKey] + sorted[sorted.length - 1][sizeKey] / 2;
    const step = (lastCenter - firstCenter) / (sorted.length - 1);
    const newAbsById = new Map(sorted.map((r, i) => {
      if (i === 0 || i === sorted.length - 1) return [r.node.id, { x: r.x, y: r.y }];
      const center = firstCenter + step * i;
      return [r.node.id, axis === "horizontal" ? { x: center - r.width / 2, y: r.y } : { x: r.x, y: center - r.height / 2 }];
    }));
    applyAbsolutePositions(instance, rects, (r) => newAbsById.get(r.node.id)!);
  }, [selectedAlignableNodes, getAbsoluteRect, applyAbsolutePositions]);

  const configureContextValue = useMemo(() => ({ onConfigure: handleOpenNodeWindow }), [handleOpenNodeWindow]);

  return (
    <ProcessorNodeEditContext.Provider value={processorEditContextValue}>
    <ProcessorNodeRunContext.Provider value={heldRunStatus}>
    <ProcessorNodeConfigureContext.Provider value={configureContextValue}>
    <EdgeDeleteContext.Provider value={edgeDeleteContextValue}>
    <div
      className={`schema-flow-wrapper${spacePanning ? " space-panning" : ""}`}
      ref={wrapperRef}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onMouseMove={handleWrapperMouseMove}
    >
      {loading && (
        <div className="schema-status-banner">
          <Spin size="small" indicator={<LoadingOutlined spin />} />
          <span>Extracting sample (first 10 pages)…</span>
        </div>
      )}
      {error && !loading && (
        <div className="schema-status-banner schema-status-error">{error}</div>
      )}
      {!loading && displayTables.length > MAX_OUTPUT_SLOTS && (
        <div className="schema-status-banner schema-status-warning">
          Only the first {MAX_OUTPUT_SLOTS} tables will be exported — maximum output slots reached.
        </div>
      )}
      {/* Align/distribute toolbar -- table cards and processor nodes alike
          (selectedAlignableNodes), only worth showing once there's
          something to align. Distribute buttons stay individually disabled
          below 3 selected (can't distribute 2 points), same as before. */}
      {selectedAlignableNodes.length >= 2 && (
      <div className="schema-align-toolbar nodrag">
        <button onClick={() => handleAlign("hcenter")} disabled={selectedAlignableNodes.length < 2} title="Align center (horizontal)"><AlignIcon mode="hcenter" /></button>
        <button onClick={() => handleAlign("vcenter")} disabled={selectedAlignableNodes.length < 2} title="Align middle (vertical)"><AlignIcon mode="vcenter" /></button>
        <span className="schema-align-toolbar-sep" />
        <button
          onClick={() => handleDistribute("horizontal")}
          disabled={selectedAlignableNodes.length < 3}
          title="Distribute horizontally"
        >
          <AlignIcon mode="distH" />
        </button>
        <button
          onClick={() => handleDistribute("vertical")}
          disabled={selectedAlignableNodes.length < 3}
          title="Distribute vertically"
        >
          <AlignIcon mode="distV" />
        </button>
      </div>
      )}
      <SchemaConnectionMarkerDefs />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        // selectable: false keeps xyflow's own marquee-select and built-in
        // click-select from ever touching edges (marquee selects an edge
        // whenever either endpoint node is captured by the drag box, which
        // isn't what a "drag to select" gesture should mean here) -- edges
        // are selected only via DeletableEdge's own onClick, through
        // EdgeDeleteContext's onSelectEdge.
        defaultEdgeOptions={{ style: { strokeWidth: 1.5, stroke: "#414959" }, selectable: false }}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onReconnectStart={onReconnectStart}
        onReconnect={onReconnect}
        onReconnectEnd={onReconnectEnd}
        // Bezier is already xyflow's own default connection-line type, so
        // it's left unset -- the dashed "marching ants" look while dragging
        // reuses xyflow's own built-in `dashdraw` keyframes (see the
        // .react-flow__connection-path rule in App.css) rather than a
        // hand-rolled animation.
        connectionLineStyle={{ stroke: "#414959", strokeWidth: 1.5 }}
        // KNIME-style: an arrowhead + "add node" affordance at the drag
        // cursor (see ConnectionLineWithAddButton above), and dropping on
        // empty canvas opens the quick-add picker pre-wired to connect
        // (see handleConnectEnd above).
        connectionLineComponent={ConnectionLineWithAddButton}
        onConnectEnd={handleConnectEnd}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onNodesDelete={onNodesDelete}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onInit={(instance) => { reactFlowInstanceRef.current = instance; tryFitView(); }}
        proOptions={{ hideAttribution: true }}
        // Partial (not the default Full) so the marquee selects a card as
        // soon as it overlaps it at all, instead of requiring the drag box
        // to fully enclose the card before it counts as selected.
        selectionMode={SelectionMode.Partial}
        // Left-drag draws the marquee (xyflow's default is the reverse --
        // left-drag pans, Shift+left-drag selects); panning moves to the
        // middle mouse button instead (DOM button index 1) -- unless
        // spacebar is being held, which temporarily borrows left-drag for
        // panning too (matching the "hold" half of the tap/hold split above).
        selectionOnDrag={!spacePanning}
        panOnDrag={spacePanning ? [0, 1] : [1]}
        // xyflow's own default (true) selects a node the instant a drag on
        // it starts, not just on a plain click -- reported as "dragging a
        // card/node also selects it, but drag should only move it; only a
        // single click (no movement) should select." false switches
        // selection to fire from the click handler instead (mousedown+
        // mouseup with no drag), leaving drag purely a move gesture.
        selectNodesOnDrag={false}
      >
        {/* Lifted clear of the output drawer's collapsed handle bar (30px).
            xyflow's own .react-flow__panel already carries a default
            `margin: 15px`, which stacks on top of this `bottom` value (the
            actual visual gap ends up as bottom + 15) -- 30 here plus that
            margin lands on the same 45px visual gap App.tsx's
            canvas-zoom-controls uses (a plain div with no such default),
            so the zoom stack doesn't jump position between Canvas/Schema. */}
        <Controls showInteractive={false} style={{ bottom: 30 }} />
        {pendingConnectionSource && (
          <PendingConnectionLineOverlay
            sourceNodeId={pendingConnectionSource.nodeId}
            sourceHandleId={pendingConnectionSource.handleId}
            toFlowX={pickerFlowPos.x}
            toFlowY={pickerFlowPos.y}
          />
        )}
      </ReactFlow>
      {nodeCtxMenu && nodeCtxMenuTarget && (
        <div
          className="rect-ctx-menu"
          style={{ left: nodeCtxMenu.x, top: nodeCtxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {RUNNABLE_NODE_KINDS.has(nodeCtxMenuTarget.catalogName) && (
            <>
              <div
                className={`ctx-menu-item${nodeRunStatus[nodeCtxMenu.nodeId]?.state === "running" ? " disabled" : ""}`}
                onClick={() => {
                  if (nodeRunStatus[nodeCtxMenu.nodeId]?.state === "running") return;
                  // Through the same sequential queue as auto-run/Run-all
                  // -- a manual single-node Run still waits its turn if
                  // something else is already mid-run, so two nodes'
                  // lights are never both cycling at once.
                  enqueueRun(nodeCtxMenu.nodeId, true);
                  closeNodeCtxMenu();
                }}
              >
                <span>Run</span>
              </div>
              <div className="ctx-menu-divider" />
            </>
          )}
          {NODE_KINDS_WITH_WINDOW.has(nodeCtxMenuTarget.catalogName) && (
            <>
              <div
                className="ctx-menu-item"
                onClick={() => handleOpenNodeWindow(nodeCtxMenu.nodeId)}
              >
                <span>{NODE_WINDOW_LABEL[nodeCtxMenuTarget.catalogName]}</span>
              </div>
              <div className="ctx-menu-divider" />
            </>
          )}
          <div
            className="ctx-menu-item"
            onClick={() => startEditingProcessorNode(nodeCtxMenu.nodeId, "name")}
          >
            <span>Rename</span>
          </div>
          <div
            className="ctx-menu-item"
            onClick={() => startEditingProcessorNode(nodeCtxMenu.nodeId, "description")}
          >
            <span>{nodeCtxMenuTarget.description ? "Edit description" : "Add description"}</span>
          </div>
          <div className="ctx-menu-divider" />
          <div
            className="ctx-menu-item"
            onClick={() => handleDeleteProcessorNodeFromMenu(nodeCtxMenu.nodeId)}
          >
            <span>Delete</span>
          </div>
        </div>
      )}
      {pickerOpen && (
        <div
          className="schema-node-picker nodrag nowheel"
          style={{ left: pickerWrapperPos.x, top: pickerWrapperPos.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            ref={pickerSearchRef}
            className="schema-node-picker-search"
            placeholder="Search nodes…"
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeNodePicker();
            }}
          />
          <div className="schema-node-picker-list">
            {pickerResults.length === 0 && (
              <div className="schema-node-picker-empty">No matching nodes.</div>
            )}
            {pickerResults.map(({ key, meta, items }) => (
              <div key={key} className="schema-node-picker-group">
                <div className="schema-node-picker-group-label" style={{ color: meta.color }}>{meta.label}</div>
                {items.map((n) => (
                  <button
                    key={n.name}
                    className="schema-node-picker-item"
                    onClick={() => handlePickNode(toDraggedNodeEntry(n))}
                  >
                    <span className="schema-node-picker-item-icon" style={{ background: meta.color }}>
                      <img src={n.icon} alt="" draggable={false} />
                    </span>
                    <span className="schema-node-picker-item-name">{n.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className={`schema-output-drawer nodrag${outputDrawerExpanded ? " expanded" : ""}`}>
        <div
          className="schema-output-drawer-resize-handle"
          onMouseDown={handleDrawerResizeStart}
        />
        <button
          className="schema-output-drawer-handle"
          // React Flow deselects nodes on any click it deems "outside" the
          // pane/node -- this button lives outside <ReactFlow> in the DOM
          // (a sibling, not a child), so without stopping propagation here
          // the click both toggles the drawer AND clears the very selection
          // the drawer is about to render, landing on the "nothing selected"
          // placeholder instead of the table that was just selected.
          onClick={(e) => {
            e.stopPropagation();
            drawerOpenedByAutoRef.current = false;
            setOutputDrawerExpanded((v) => !v);
          }}
        >
          <DrawerChevronIcon expanded={outputDrawerExpanded} />
          <span>
            {selectedTable
              ? selectedTable.isFullData
                ? `Output — ${selectedTable.name} (${selectedTable.rowCount} rows)`
                : `Output — ${selectedTable.name} (${selectedTable.sampleRows.length} of ${selectedTable.rowCount} sample rows)`
              : selectedProcessorNodeHint ?? "Select a table or run node to preview its output"}
          </span>
        </button>
        {outputDrawerExpanded && (
          <div className="schema-output-drawer-body nodrag nowheel" style={{ height: drawerHeight }}>
            {selectedTable ? (
              <AgGridReact
                theme={outputGridTheme}
                rowData={outputRowData ?? []}
                columnDefs={outputColumnDefs ?? []}
                defaultColDef={outputGridDefaultColDef}
                // `field` is the real extracted column name, which can
                // contain a literal "." (e.g. a PDF header like "2023.01")
                // -- AG-Grid treats dots in `field` as nested-path
                // separators by default, which would render such a column
                // empty.
                suppressFieldDotNotation
              />
            ) : (
              <div className="schema-output-drawer-placeholder">
                {selectedProcessorNodeHint ?? "Select a table card, or a node you've run, to preview its output."}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
    </EdgeDeleteContext.Provider>
    </ProcessorNodeConfigureContext.Provider>
    </ProcessorNodeRunContext.Provider>
    </ProcessorNodeEditContext.Provider>
  );
}
