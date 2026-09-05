// Catalog of Orange widgets that already have both a ported Python
// transform (auxiliary_functions.py, or self-contained in the widget's own
// .py file) and a cloned/redesigned Vite frontend under devkit/ -- the
// widgets that are actually ready to become real node types here, once the
// node graph itself exists. Excludes PDF Converter (this app already is
// that node) and Settings (a preferences dialog, not a data-transform
// node). A few other widgets (Column Builder, Horizontal Stack, Pivot
// Table) have Python logic but no cloned frontend yet, so aren't listed.
// Icons are the widgets' own (orangecontrib/custom/widgets/icons/), copied
// as-is into public/node-icons. Grouped into categories (each with its own
// accent color) the way a KNIME-style node repository does.
//
// Shared between NodesPanel.tsx (the dock-panel catalog) and SchemaView.tsx
// (the right-click / spacebar quick-add picker) so both list the exact same
// nodes from one source of truth.
//
// Categories modeled on Alteryx Designer's own tool-palette categories
// (verified against its real per-category tool list, not guessed): "io"
// mirrors In/Out (Browse/Input Data/Output Data); "preparation" mirrors
// Preparation (Select, Record ID, Data Cleansing, Filter, Unique, etc. --
// which is where most single-table column/row-shape tools actually live
// in Alteryx, not a separate "transform" bucket); "join" mirrors Join
// (Join, Append Fields, Union -- anything combining two tables); "parse"
// mirrors Parse (RegEx, Text To Columns). "transform" mirrors Alteryx's
// own Transform category (Cross Tab, Transpose, Running Total) -- left
// unused until Pivot Columns/Unpivot Columns existed to put in it (the
// exact reshape shape that category is for); Preparation had grown to 13
// nodes by the time those landed, so splitting them out is both truer to
// Alteryx's own grouping and keeps Preparation from becoming a catch-all.
// "analysis" has no Alteryx equivalent used here -- see its own comment
// further down, by Summary/Aggregate's entries.
export type CategoryKey = "io" | "preparation" | "transform" | "join" | "parse" | "analysis";

export interface NodeCatalogEntry {
  name: string;
  description: string;
  icon: string;
  category: CategoryKey;
  // Every widget here takes an input table; only a sink like Excel
  // Exporter (writes to a file, doesn't hand a table onward) lacks an
  // output socket.
  hasOutput?: boolean;
  // A second, square-shaped input port (visually distinct from the
  // regular arrow one) for a node whose transform takes a second,
  // differently-used table -- currently just Filter Builder's "Extra
  // Data" (its rules can match a condition against any value found in a
  // column of this second table, see backend/app/nodes.py's
  // filter_builder/_apply_condition extra_ref handling).
  hasExtraInput?: boolean;
  // False for the catalog's one graph SOURCE node (Input Data) -- hides
  // the regular round/triangle input port entirely (see SchemaView.tsx's
  // ProcessorNode rendering, gated the same way hasOutput below already
  // gates the output port), since a source's data always originates in
  // its own Configure window, never from an upstream edge. Undefined
  // means true, same convention as hasOutput.
  hasInput?: boolean;
  // Caps how many edges the node's MAIN (round/triangle) input handle
  // accepts. Undefined means unlimited -- e.g. Horizontal Stack, which
  // wants 2+ ordered tables. When set, connecting a new edge past the cap
  // replaces the oldest edge(s) already on that handle instead of just
  // adding another one xyflow will happily allow but the transform will
  // never look at -- see getInputPortMax and App.tsx's handleConnect,
  // which is the one general place this is enforced. A future node with
  // a single-table transform just sets `mainInputMax: 1` here and gets
  // that enforcement for free, no other code to write.
  mainInputMax?: number;
}

// The Extra Data port (see hasExtraInput above) is *always* singular
// wherever it exists -- not something individual nodes opt into, since a
// node either has one differently-used second table or it doesn't. See
// getInputPortMax.
export const EXTRA_INPUT_MAX = 1;

// The one general place a node's input-port cardinality rule is looked
// up from -- App.tsx's handleConnect (the only place edges actually get
// created) calls this to decide whether a new connection should replace
// an existing one. `handleId` is the target handle id from the
// connection event: null/undefined for the main input, "extra" for the
// square Extra Data port.
export function getInputPortMax(catalogName: string, handleId: string | null | undefined): number | undefined {
  if (handleId === "extra") return EXTRA_INPUT_MAX;
  return NODE_CATALOG.find((n) => n.name === catalogName)?.mainInputMax;
}

export const CATEGORY_META: Record<CategoryKey, { label: string; color: string }> = {
  io: { label: "In/Out", color: "#019B8A" },
  preparation: { label: "Preparation", color: "#155F98" },
  transform: { label: "Transform", color: "#E0A526" },
  join: { label: "Join", color: "#7753A0" },
  parse: { label: "Parse", color: "#E86F53" },
  analysis: { label: "Analysis", color: "#9BB058" },
};

export const CATEGORY_ORDER: CategoryKey[] = ["io", "preparation", "transform", "join", "parse", "analysis"];

// Shared with SchemaView.tsx's onDrop handler -- the dataTransfer mime type
// used to recognize a drag that originated from this catalog (as opposed to
// a stray OS file/text drag landing on the canvas).
export const NODE_DRAG_MIME = "application/altera-node";

export interface DraggedNodeEntry {
  name: string;
  icon: string;
  color: string;
  hasOutput?: boolean;
  hasExtraInput?: boolean;
  hasInput?: boolean;
}

export const NODE_CATALOG: NodeCatalogEntry[] = [
  // Alteryx's own In/Out category leads with Input Data -- the catalog's
  // only graph SOURCE node (no upstream table; hasInput: false hides its
  // input port entirely, see SchemaView.tsx's ProcessorNode rendering).
  // Reads a local .csv/.xlsx file straight from disk (backend/app/nodes.py's
  // file_input) via its own Configure window's native file picker.
  { name: "Input Data", description: "Load a local Excel (.xlsx) or CSV file as a table -- no upstream connection needed.", icon: "./node-icons/input_data.svg", category: "io", hasInput: false, mainInputMax: 0 },
  { name: "Export", description: "Export one or more datasets to Excel (.xlsx) or CSV.", icon: "./node-icons/excel_exporter.svg", category: "io", hasOutput: false },
  { name: "Browse", description: "Preview a table's rows and columns without modifying the data.", icon: "./node-icons/browse.svg", category: "io", hasOutput: false, mainInputMax: 1 },
  // Preparation -- Alteryx's own Select tool covers exactly what Column
  // Edit and Change Type do (reorder/rename/delete columns; change a
  // column's type), and Record ID is exactly Index Column. Shift
  // Columns/Header Promoter/Filter Builder/Unique/Cascade Fill/Cleaner
  // have no 1:1 Alteryx tool but are all single-table row/column-shape
  // or cleanup operations, the same kind of work Preparation's own
  // Multi-Row Formula/Filter/Unique/Data Cleansing tools do.
  { name: "Column Edit", description: "Reorder, rename, and delete columns with a drag-and-drop interface.", icon: "./node-icons/column_manager.svg", category: "preparation", mainInputMax: 1 },
  { name: "Change Type", description: "Convert a column to Number or Text, with an option to fill values that can't convert.", icon: "./node-icons/change_type.svg", category: "preparation", mainInputMax: 1 },
  { name: "Shift Columns", description: "Shift selected columns up or down by N steps.", icon: "./node-icons/multishift.svg", category: "preparation", mainInputMax: 1 },
  { name: "Header Promoter", description: "Promote any row in a table to become column headers.", icon: "./node-icons/header_promoter.svg", category: "preparation", mainInputMax: 1 },
  { name: "Index Column", description: "Add a row-index column numbered 1 to N.", icon: "./node-icons/index.svg", category: "preparation", mainInputMax: 1 },
  { name: "Filter", description: "Advanced AND/OR filtering with full type preservation.", icon: "./node-icons/filter.svg", category: "preparation", hasExtraInput: true, mainInputMax: 1 },
  { name: "Unique", description: "Remove duplicate rows based on selected columns.", icon: "./node-icons/deduplicator.svg", category: "preparation", mainInputMax: 1 },
  { name: "Cascade Fill", description: "Fill up or fill down to propagate values vertically within columns.", icon: "./node-icons/cascade_fill.svg", category: "preparation", mainInputMax: 1 },
  { name: "Cleaner", description: "Clean and transform text columns with various operations.", icon: "./node-icons/cleaner.svg", category: "preparation", mainInputMax: 1 },
  { name: "Formula", description: "Add a new column computed from a formula, like Power Query's Add Custom Column.", icon: "./node-icons/formula.svg", category: "preparation", mainInputMax: 1 },
  { name: "Add Column", description: "Add a new column based on conditions, like Power Query's Add Conditional Column.", icon: "./node-icons/conditional_column.svg", category: "preparation", mainInputMax: 1 },
  { name: "Bridge", description: "Passes its input straight through unchanged -- useful for organizing or routing connections in a busy workflow.", icon: "./node-icons/bridge.svg", category: "preparation", mainInputMax: 1 },
  { name: "Sort", description: "Sort rows by one or more columns, like Excel's Sort dialog.", icon: "./node-icons/sort.svg", category: "preparation", mainInputMax: 1 },
  // Transform -- Alteryx's own Cross Tab/Transpose category. Pivot/
  // Unpivot Columns are exactly that reshape shape, not the single-table
  // cleanup Preparation's other tools do.
  { name: "Unpivot Columns", description: "Turn selected columns into Attribute/Value row pairs, like Power Query's Unpivot Columns.", icon: "./node-icons/unpivot.svg", category: "transform", mainInputMax: 1 },
  { name: "Pivot Columns", description: "Turn a labels column into new column headers and a values column into their contents, like Power Query's Pivot Column.", icon: "./node-icons/pivot.svg", category: "transform", mainInputMax: 1 },
  // Analysis -- the catalog's own category (no direct Alteryx equivalent
  // used here, unlike every other bucket above): Summary and Aggregate
  // both look AT a table rather than reshape/clean it -- Summary as a
  // per-column health check, Aggregate as sums/averages/counts collapsed
  // into one row. Summary used to sit in In/Out (it's a sink, like Browse)
  // and Aggregate in Transform (Alteryx's own Summarize tool lives there),
  // but grouping them here instead reads truer to what a user is actually
  // reaching for both for: understanding the data, not routing or
  // reshaping it.
  { name: "Summary", description: "Per-column stats, distributions, and missing-value/gap detection -- a quick health check of a table.", icon: "./node-icons/summary.svg", category: "analysis", hasOutput: false, mainInputMax: 1 },
  { name: "Aggregate", description: "Collapse a table into one row of sums, averages, counts, minimums, and maximums.", icon: "./node-icons/aggregate.svg", category: "analysis", mainInputMax: 1 },
  // Join -- Alteryx's own Join tool is exactly Merge's "match on shared
  // columns" mode, and its Append Fields tool is exactly Horizontal
  // Stack's "combine by position" mode.
  { name: "Horizontal Stack", description: "Combine two tables side by side, matching rows by position or a key column.", icon: "./node-icons/horizontal_stack.svg", category: "join" },
  { name: "Merge", description: "Combine two tables by matching rows on shared columns or row position.", icon: "./node-icons/merge.svg", category: "join", hasExtraInput: true, mainInputMax: 1 },
  // Orange's own Concatenate widget -- stacks any number of tables' ROWS
  // into one, matching columns by name (the opposite axis from Horizontal
  // Stack's column-wise-by-position combine above).
  { name: "Concatenate", description: "Stack two or more tables' rows into one, matching columns by name.", icon: "./node-icons/concatenate.svg", category: "join" },
  // Parse -- Alteryx's own RegEx tool.
  { name: "Regular Expressions", description: "Extract regex matches from a column, with a live match preview.", icon: "./node-icons/regex.svg", category: "parse", mainInputMax: 1 },
  { name: "Text Parser", description: "No-code text extraction and splitting -- text before/after/between delimiters, split by delimiter, and character-position ranges, like Power Query's own Extract commands.", icon: "./node-icons/text_parser.svg", category: "parse", mainInputMax: 1 },
];

export function toDraggedNodeEntry(n: NodeCatalogEntry): DraggedNodeEntry {
  return { name: n.name, icon: n.icon, color: CATEGORY_META[n.category].color, hasOutput: n.hasOutput, hasExtraInput: n.hasExtraInput, hasInput: n.hasInput };
}
