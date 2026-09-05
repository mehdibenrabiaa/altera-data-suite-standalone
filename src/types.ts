export type Tool = "select" | "hand" | "rectangle" | "guide" | "region";

export interface SmartOffset {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
export interface KeywordSettings {
  occRule?: { action: "keep" | "ignore"; from: number; to: number };
  secRule?: { action: "keep" | "ignore"; cells: number[] };
}
export interface SmartRawPageEntry {
  bboxes: [number, number, number, number][];
  union_bbox: [number, number, number, number];
  by_keyword: Record<string, [number, number, number, number][]>;
  page_w: number;
  page_h: number;
}
export interface SmartConfig {
  keywords: string[];
  offset: SmartOffset;
  keywordSettings?: Record<string, KeywordSettings>;
}
export const DEFAULT_SMART_CONFIG: SmartConfig = {
  keywords: [],
  offset: { top: 0, bottom: 0, left: 0, right: 0 },
};

export interface SampleConfig {
  enabled: boolean;
  mode: "range" | "first_n";
  startPage: number;
  endPage: number;
  firstN: number;
}

// Shape passed between the main window and the separate Settings window
// over IPC (see electron/main.ts's settings:open/settings:applied).
export interface SettingsPayload {
  sample: SampleConfig;
  closeAfterConvert: boolean;
  schemaSampleRowLimit: number;
  schemaPageLimit: number;
  autoExpandOutputDrawer: boolean;
  // Caps how sharp the Canvas view's PDF page render gets at high zoom
  // (App.tsx's renderScale = min(max(scale * devicePixelRatio,
  // devicePixelRatio), pdfRenderDpi / 72) -- 72 is the PDF-point-to-DPI
  // baseline pdf.js's own scale:1.0 viewport already uses). Purely a
  // render-quality/speed tradeoff -- confirmed both in the frontend
  // (rectangles are stored in the separate, DPI-independent scale:1.0
  // viewport) and the backend (pdf_converter.py's own _DPI constant is
  // never actually used by extraction, which works in PDF point space
  // regardless) that this has zero effect on annotation/extraction
  // accuracy, only on-screen sharpness while zoomed in.
  pdfRenderDpi: number;
  numPages: number;
}

// What actually gets written to disk (see electron/main.ts's
// settings:save/settings:load) -- numPages is contextual to whichever PDF
// happens to be open, not a real preference, so it's excluded here.
export type PersistedSettings = Omit<SettingsPayload, "numPages">;

export interface QtBridge {
  saveHtmlState: (htmlState: string) => void;
  getCoordinatesFromJs: (data: string, breaklines: number) => void;
  openFileDialog: () => void;
  receivePdfData: (filename: string, base64Data: string) => void;
  generateInkOverlay: (pdfPath: string, opacity: number, zoom: number) => void;
  findKeywords: (dataJson: string) => void;
  previewSchema: (dataJson: string) => void;
}

// One message from a processor node's last run -- see SchemaView.tsx's
// selectedProcessorNodeLog/onSelectedNodeLogChange (reports the currently
// selected node's full log up to App.tsx's Log dock panel) for where
// these come from.
export interface NodeLogEntry {
  type: "error" | "warning" | "info";
  message: string;
}

export interface SchemaPreviewTable {
  // The rectangle's own stable id, echoed straight back through the Python
  // round-trip (see build_schema_preview_payload) -- the real identity to
  // match this entry back to its rectangle by. `name` is a mutable display
  // label; using it for identity was the root cause of an entire class of
  // rename bugs (edges/converted data/card position all keyed off a string
  // the user can freely retype), so it's kept here for display only.
  rectId?: string;
  name: string;
  color: string;
  columns: string[];
  rowCount: number;
  sampleRows: string[][];
}

export interface Rectangle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  name?: string;
  mode?: "free" | "smart";
  smartConfig?: SmartConfig;
  smartRawData?: Record<string, SmartRawPageEntry | null>;
  smartPageData?: Record<string, { bboxes: [number,number,number,number][]; union_bbox: [number,number,number,number] } | null>;
  autoDetectColumns?: boolean;
  locked?: boolean;
  hidden?: boolean;
  groupId?: string;
  // User-assigned display names for this table's columns in the Schema
  // Preview, keyed by the original generated name (e.g. "Column_1"). Preview
  // only for now -- not yet applied to the real conversion output.
  columnRenames?: Record<string, string>;
  // Which of the widget's 20 fixed output sockets (1-20) this table's data
  // should be sent through -- auto-assigned by this table's top-to-bottom
  // position among all Schema Preview cards (see schemaY below), computed
  // in App.tsx's computeAnnotationData. Undefined means the table ranked
  // beyond the 20th card and won't be sent anywhere.
  outputSlot?: number;
  // Absolute position of this table's card on the Schema Preview canvas,
  // written on drag-stop or align/distribute (see SchemaView.tsx). Also the
  // source of truth for outputSlot ordering above. Undefined = never
  // positioned in Schema yet -- ordering falls back to canvas y (below).
  schemaX?: number;
  schemaY?: number;
}

export interface Guide {
  id: string;
  x: number;
  y: number;
  color: string;
  // Which table this guide belongs to, matched by NAME (not a specific
  // rectangle's id) — so it applies to every rectangle that currently has
  // this name, regardless of each one's own color. `color` here is just the
  // guide's own display color (a snapshot taken from a matching rect at
  // assignment time), independent of the matching itself.
  rectName?: string;
  locked?: boolean;
  hidden?: boolean;
}

export interface Group {
  id: string;
  name: string;
  hidden?: boolean;
  // Parent group's id, for one level of folder nesting. A group that has a
  // parentId can never itself be a parent (max nesting depth is 1) — that
  // invariant is enforced wherever parentId is assigned, not here.
  parentId?: string;
  // Absolute position of this group's container box on the Schema Preview
  // canvas (see SchemaView.tsx) -- computed from its members' positions on
  // first appearance, then persisted like any dragged position.
  schemaX?: number;
  schemaY?: number;
}

// A placeholder instance of a catalog widget (see NodesPanel.tsx) dropped
// or click-added onto the Schema Preview canvas -- purely visual/structural
// for now, not yet wired to real data flow or the Python side.
export interface ProcessorNodeInstance {
  id: string;
  catalogName: string;
  icon: string;
  color: string;
  hasOutput?: boolean;
  hasExtraInput?: boolean;
  hasInput?: boolean;
  x: number;
  y: number;
  // Set via the node's right-click context menu (Rename / Add description)
  // -- catalogName stays the original widget kind, `name` is the display
  // override (falls back to catalogName when unset).
  name?: string;
  description?: string;
  // A generic per-node settings bag, set via the node's Configure dialog
  // (see FilterBuilderDialog.tsx) -- not filter-specific, so future
  // configurable nodes reuse the same field. Shape is whatever that node
  // kind's own params model is (e.g. FilterBuilderParams for a "Filter
  // Builder" node); nothing here enforces which.
  params?: Record<string, unknown>;
}

// Filter Builder's rule model -- ported from the original widget's own
// React frontend (devkit/filter-builder, the un-minified source behind
// devkit/orangecontrib/custom/widgets/UI/filter_ui's bundle) verbatim
// where possible, adapted only where this app has no Orange Domain (see
// FilterBuilderWindow.tsx). Two levels: groups are always OR'd together; a
// group's own `match` decides whether ITS conditions are AND'd ("all") or
// OR'd ("or") -- see backend/app/nodes.py's filter_builder/
// build_filter_mask (ported from
// devkit/orangecontrib/custom/widgets/auxiliary_functions.py).
export type FilterOperator =
  | "is_defined" | "is_not_defined"
  | "equals" | "not_equals"
  | "greater_than" | "less_than" | "greater_or_equal" | "less_or_equal" | "between"
  | "contains" | "not_contains" | "starts_with" | "ends_with";

// A condition's value is normally a plain scalar (or a {from,to} pair for
// "between") -- but for "equals"/"not_equals" it can instead reference a
// column in the node's Extra Data input (the square handle), meaning
// "match any value found in that column" (isin()-style), ported from the
// original widget's extra_ref value type. See backend/app/nodes.py's
// _apply_condition for how this is evaluated. `null` is the original's own
// "no value yet / not applicable" default (e.g. for is_defined).
export type FilterConditionValue =
  | string
  | number
  | null
  | { from: number | string | null; to: number | string | null }
  | { type: "extra_ref"; column: string };

export interface FilterCondition {
  id: string;
  column: string;
  operator: FilterOperator;
  value: FilterConditionValue;
}

export interface FilterGroup {
  id: string;
  match: "all" | "or";
  conditions: FilterCondition[];
}

export interface FilterBuilderParams {
  groups: FilterGroup[];
}

// Header Promoter's params -- which row (if any) becomes the new column
// headers, and whether every row at-or-above it gets dropped along with
// it (true) or just that single row (false). See backend/app/nodes.py's
// promote_row_to_header, ported from promote_row_to_header in
// devkit/orangecontrib/custom/widgets/auxiliary_functions.py.
export interface HeaderPromoterParams {
  rowIndex: number | null;
  removeAbove: boolean;
}

// Merge's params -- modeled on Orange's own Merge Data widget
// (https://orangedatamining.com/widget-catalog/transform/mergedata/).
// mergeType maps to a join kind in backend/app/nodes.py's merge_data:
// "append" = left join (every primary row kept), "matching" = inner join
// (only rows found in both), "concatenate" = outer join (every row from
// both, blanks where one side has no counterpart). matchBy picks whether
// matchColumns (one or more primary/extra column PAIRS, supporting a
// composite key) or plain row position decides which rows correspond --
// matchColumns is ignored when matchBy is "row_index". Orange's own third
// matching mode ("by Instance ID") has no equivalent here, see that
// function's own comment for why.
export type MergeType = "append" | "matching" | "concatenate";
export type MergeMatchBy = "attributes" | "row_index";
export interface MergeColumnPair {
  id: string;
  left: string;
  right: string;
}
export interface MergeParams {
  mergeType: MergeType;
  matchBy: MergeMatchBy;
  matchColumns: MergeColumnPair[];
}

// Shift Columns' params -- ported from the original OWMultiShiftColumns
// widget (devkit/orangecontrib/custom/widgets/multishift.py) and its
// apply_column_shift helper (auxiliary_functions.py). Shifts VALUES
// within each selected column up or down by `steps` rows (a lag/lead,
// like pandas' own Series.shift) -- not a column-position move. Columns
// left out of selectedColumns are untouched; vacated boundary cells
// become blank, same as the original (no separate configurable fill
// value there either).
export type ShiftDirection = "down" | "up";
export interface ShiftColumnsParams {
  selectedColumns: string[];
  direction: ShiftDirection;
  steps: number;
}

// Cleaner's params -- ported from the original OWCleaner widget
// (devkit/orangecontrib/custom/widgets/cleaner.py) and its
// apply_cleaning_operation/apply_all_cleaning_operations helpers
// (auxiliary_functions.py). An ORDERED list of operations, each targeting
// its own subset of columns -- operations run in list order, each fully
// applied (to all its target columns) before the next one starts, so the
// same column can be chained through multiple operations in sequence.
// See backend/app/nodes.py's clean_columns for exactly what each
// operation does and which `params` keys it reads.
export type CleaningOperationType =
  | "replace"
  | "remove_spaces"
  | "trim"
  | "remove_special"
  | "uppercase"
  | "lowercase"
  | "titlecase"
  | "remove_digits"
  | "keep_digits"
  | "remove_punctuation"
  | "strip_chars"
  | "remove_prefix"
  | "remove_suffix"
  | "fill_na";
export interface CleaningOperationParams {
  find?: string;
  replace?: string;
  caseSensitive?: boolean;
  chars?: string;
  prefix?: string;
  suffix?: string;
  fillValue?: string;
}
export interface CleaningOperation {
  id: string;
  columns: string[];
  operation: CleaningOperationType;
  params: CleaningOperationParams;
}
export interface CleanerParams {
  operations: CleaningOperation[];
}

// Text Parser's params -- Power Query's own no-code text-extraction
// toolset (Transform > Extract, and Split Column by Delimiter), as an
// alternative to writing a regex pattern by hand (see the Regular
// Expressions node for that). Same ordered-list-of-operations shape as
// Cleaner's own CleaningOperation above, but each operation ADDS new
// column(s) computed from one source column rather than mutating it in
// place -- see backend/app/nodes.py's parse_text for exactly what each
// one does and which `params` keys it reads. `occurrence`/
// `startOccurrence`/`endOccurrence` are "first" | "last" | a positive
// integer string (1-based, "which occurrence of the delimiter") --
// matching how a non-programmer would actually describe it, not a raw
// 0-based index.
export type TextParseOperationType =
  | "text_before"
  | "text_after"
  | "text_between"
  | "split_delimiter"
  | "first_chars"
  | "last_chars"
  | "range";
export interface TextParseOperationParams {
  delimiter?: string;
  occurrence?: string;
  startDelimiter?: string;
  endDelimiter?: string;
  startOccurrence?: string;
  endOccurrence?: string;
  splitAt?: "each" | "left" | "right";
  count?: string;
  start?: string;
  length?: string;
}
export interface TextParseOperation {
  id: string;
  column: string;
  operation: TextParseOperationType;
  params: TextParseOperationParams;
  newColumnName: string;
}
export interface TextParserParams {
  operations: TextParseOperation[];
}

// Input Data's own params -- unlike every other node's params, these don't
// describe a TRANSFORM (there's no upstream table to transform -- see
// backend/app/nodes.py's file_input), they're the only place this node's
// data comes from at all. `sheet` is only meaningful for an .xlsx/.xls
// `path` (undefined/omitted means "first sheet", same as the backend's own
// `params.get("sheet") or 0` default) -- a .csv/.tsv path just ignores it.
export interface InputDataParams {
  path?: string;
  sheet?: string;
}

// Sort's own params -- an ORDERED list of sort keys (Excel "Sort" dialog
// style, "Add Level"), applied together as one multi-key sort (see
// backend/app/nodes.py's sort_rows), not one sort per key run in sequence.
export interface SortKey {
  id: string;
  column: string;
  direction: "asc" | "desc";
}
export interface SortParams {
  keys: SortKey[];
}

// Aggregate's own params -- ordered list of {column, aggregation} metrics,
// each becoming one column ("Sum of Amount") in the single-row output (see
// backend/app/nodes.py's aggregate_columns). Order here IS the output
// column order, so -- like Text Parser's operations -- this list is
// reorderable, not just addable/removable.
export type AggregateType = "sum" | "average" | "count" | "min" | "max";
export interface AggregateMetric {
  id: string;
  column: string;
  aggregation: AggregateType;
}
export interface AggregateParams {
  metrics: AggregateMetric[];
}

// Unique's params -- ported from the original OWDeduplicator widget
// (devkit/orangecontrib/custom/widgets/deduplicator.py), renamed here
// since "keep only unique rows" reads clearer than the original's own
// widget name. Wraps pandas' own DataFrame.drop_duplicates over a
// user-selected SUBSET of columns (not automatically every column).
// "keep" picks which occurrence of each duplicate group survives:
// "first"/"last" match pandas directly, "none" means drop EVERY row in a
// duplicate group, including the first occurrence, not just the extras
// (pandas' own keep=False). See backend/app/nodes.py's deduplicate_rows.
export type UniqueKeepMode = "first" | "last" | "none";
export interface UniqueParams {
  columns: string[];
  keep: UniqueKeepMode;
}

// Column Edit's params -- ported from the original OWColumnManager widget
// (devkit/orangecontrib/custom/widgets/columns_manager.py), renamed and
// with its UI adapted to this app's own dnd-kit sortable-card convention
// (CleanerWindow.tsx) rather than the original's AG-Grid header-drag
// interface. One ordered list IS the entire desired state -- there's no
// separate reorder/rename/delete step: array order = column order, a
// `name` that differs from `field` = a rename, a column simply absent
// from the list = deleted. (The original also supported adding a brand-
// new constant-value column -- deliberately left out of this node; it'll
// get its own dedicated node later instead.) See backend/app/nodes.py's
// column_edit for exactly how each entry gets resolved, including the
// collision-safety net (the original never checked for two entries
// ending up with the same `name`) this port adds via the same
// _make_unique_column_names helper every other dedup-prone node here
// already uses.
export interface ColumnEditEntry {
  field: string; // stable identity key -- the ORIGINAL column name
  name: string; // current/output name -- what actually gets edited
}
export interface ColumnEditParams {
  columns: ColumnEditEntry[];
  // Kept alongside `columns` (not used by the transform itself -- see
  // backend/app/nodes.py's column_edit, which only ever reads `columns`)
  // purely so reopening this node's Configure window later still shows
  // what you deleted, with a Restore button, same as the original widget
  // persisting deletedColumns in its own Setting.
  deletedColumns: ColumnEditEntry[];
}

// Change Type's params -- a brand-new node, not ported from an old Orange
// widget. UI modeled on Alteryx's own Select tool: every field in the
// table gets its own row with its own type dropdown, pre-selected to
// whatever that column's values currently look like (no separate
// "Unchanged" option -- same as Alteryx's own Select, which always shows
// a real type, never a placeholder). Picking the SAME type it's already
// in is a safe no-op (see backend/app/nodes.py's change_type -- applying
// "Text" to an already-text column or "Number" to an already-clean
// number column just reformats/passes through). This app's wire format
// has no real per-column type system (see SchemaView.tsx's own
// inferColumnDefinition comment) -- "changing type" here means coercing
// a column's actual cell values into a clean form of that type (e.g.
// "1,234.50" -> "1234.5"), not flipping a schema flag. "text" always
// succeeds (every value already has a string form). "number" can fail
// per-cell (not everything parses as a number); when `fillUnconvertible`
// is off, ANY failure across ANY field being converted to Number blocks
// the run with an error naming which columns/how many cells failed (the
// "tell the user" the request asked for); when on, failing cells get
// `fallbackValue` instead and a warning (not an error) reports the
// count. fillUnconvertible/fallbackValue are shared across every field
// converting to Number, Float, or Date, not per-field -- nothing in the
// request called for a different fallback per column. "date" normalizes to a
// plain YYYY-MM-DD string (see backend/app/nodes.py's _to_date_or_none/
// _format_date, built on pandas' own flexible date parser) and shares
// the exact same fail-vs-fill policy as Number.
// "float" shares Number's parser (same `_to_number_or_none`) and
// fail-vs-fill policy, but its formatter never strips a trailing ".0" --
// Number's does, since Number means "whichever of int/float reads
// naturally," while Float means "always show as a decimal."
export type ChangeTypeTarget = "number" | "float" | "text" | "date";
export interface ChangeTypeFieldEntry {
  field: string;
  targetType: ChangeTypeTarget;
}
export interface ChangeTypeParams {
  fields: ChangeTypeFieldEntry[];
  fillUnconvertible: boolean;
  fallbackValue: string;
}

// Regular Expressions' params -- ported from the original regex.py widget
// (devkit/orangecontrib/custom/widgets/regex.py) and its
// process_regex_pattern helper (auxiliary_functions.py), minus the
// original's AI-assist ("describe it, generate a pattern" via an
// external license-gated API) -- no equivalent infrastructure exists in
// this app, so the pattern is always typed by hand. Single column, single
// pattern, three mutually exclusive extraction modes (see backend/app/
// nodes.py's extract_regex for exactly what each one produces):
// "smart_extract" -- first match per cell; 0 groups = one column (the
// whole match), N groups = the whole match PLUS one column per group.
// "precision_capture" -- like smart_extract but only the group values
// (no whole-match column), with empty/falsy groups filtered out and the
// survivors packed left-to-right (so which group lands in which output
// column can shift row to row).
// "greedy_collect" -- ALL matches per cell (not just the first), laid
// out as one column per match index across the whole column (row N's
// 2nd match goes in the same column as every other row's 2nd match), not
// a joined string and not one row per match.
// `literal` escapes the pattern first, turning it into a plain substring
// search. A cell with no match always gets "" in the new column(s) --
// never null, never the original value -- the original column is never
// touched, extraction only ever appends new ones.
export type RegexMode = "smart_extract" | "precision_capture" | "greedy_collect";
export interface RegexParams {
  column: string;
  pattern: string;
  mode: RegexMode;
  literal: boolean;
  newColumnName: string;
}

// Cascade Fill's params -- ported from the original OWCascadeFill widget
// (devkit/orangecontrib/custom/widgets/cascade_fill.py)'s own fill_state
// Setting. "down" propagates each column's last-seen value forward into
// empty cells below it (ffill); "up" propagates the next value backward
// into empty cells above it (bfill) -- see backend/app/nodes.py's
// cascade_fill for exactly what counts as "empty" (blank, "?", or a value
// in customNulls) and how a leading/trailing run with nothing to
// propagate from is left as "".
export type CascadeFillDirection = "down" | "up";
export interface CascadeFillParams {
  columns: string[];
  direction: CascadeFillDirection;
  customNulls: string[];
}

// Export's params -- the one sink node (nodeCatalog.ts's hasOutput: false),
// so unlike every other node's params these describe WHERE to write, not
// how to transform. "xlsx": outputPath is a single .xlsx FILE (every
// connected table becomes its own sheet, see backend/app/nodes.py's
// export_data). "csv": outputPath is a FOLDER instead (a CSV can only ever
// hold one table, so a multi-table export writes one file per table into
// it, named after each table -- see this node's own Configure window for
// why the picker itself already branches on format).
export type ExportFormat = "xlsx" | "csv";
export interface ExportParams {
  format: ExportFormat;
  outputPath: string;
  // Off by default -- Export re-writing a real file on disk is a bigger
  // deal than every other node's auto-run (which only ever touches
  // in-memory preview data), so unlike them it doesn't auto-run just
  // because RUNNABLE_NODE_KINDS includes it; SchemaView.tsx's auto-run
  // effect also requires this to be true. A manual right-click Run always
  // still works regardless of this setting.
  autosave?: boolean;
}

// Unpivot Columns' params -- Power Query's own "Unpivot Columns" command
// (backend/app/nodes.py's unpivot_columns): the selected columns become
// two new rows-per-original-row columns ("Attribute"/"Value", PQ's own
// default names), every OTHER column stays as an identifier repeated
// across its row's new unpivoted rows. Only the columns to CONVERT are
// picked here, matching PQ's literal "Unpivot Columns" command (as
// opposed to its separate "Unpivot Other Columns" one).
export interface UnpivotColumnsParams {
  columns: string[];
}

// Pivot Columns' params -- Power Query's own "Pivot Column" command, the
// reverse of Unpivot Columns above (backend/app/nodes.py's pivot_columns):
// labelColumn's own unique values become new column headers, valueColumn's
// values land under them. Every OTHER column is an identifier rows get
// grouped by -- with no other columns at all (this app's most common case:
// reconstructing an Unpivot Columns output back to its original wide
// shape), rows are matched up purely by each label's own occurrence
// position instead, see that function's own comment.
export interface PivotColumnsParams {
  labelColumn: string;
  valueColumn: string;
}

// Add Column's params -- Power Query's own "Add Custom Column": one new
// column computed from `formula`, which references other columns with
// PQ's own [Column Name] bracket syntax (backend/app/nodes.py's
// add_column parses and safely evaluates it, one row at a time -- see its
// own comment for the supported operators/functions and why it's not a
// raw eval()).
export interface AddColumnParams {
  columnName: string;
  formula: string;
}

// The low-code sibling of the formula-based Add Column above (now
// surfaced to the user as "Formula") -- Power Query's own "Add
// Conditional Column": an ORDERED list of clauses, each a Filter
// Builder-style condition group (reuses FilterGroup/FilterCondition
// wholesale -- same AND/OR model, same operators, same
// backend/app/nodes.py _apply_condition evaluates Filter Builder's own
// conditions with), paired with the value to output when it matches.
// First matching clause wins (a row already claimed by an earlier clause
// is never reconsidered by a later one); elseValue covers every row that
// matches no clause at all.
export interface ConditionalColumnClause {
  id: string;
  group: FilterGroup;
  outputValue: string;
}
export interface ConditionalColumnParams {
  columnName: string;
  clauses: ConditionalColumnClause[];
  elseValue: string;
}

// Column "type" for a Configure dialog's per-column operator/value-editor
// choice -- this app's tables are plain {columns, rows} strings with no
// schema (unlike the original's Orange Domain), so type is inferred from
// the actual values (see SchemaView.tsx's inferColumnDefinition): "float"
// if every non-empty value parses as a number, "categorical" if it's a
// small, low-cardinality set of distinct text values (offered as a
// dropdown, matching the original's DiscreteVariable columns), "text"
// otherwise (free typing, with autocomplete suggestions from sample
// values). `values` is the known value list for categorical (all of them)
// or text (a capped sample, for autocomplete) -- absent for float.
export interface FilterColumnDefinition {
  name: string;
  type: "float" | "text" | "categorical";
  values?: string[];
}

export interface TableData {
  // The rectangle's own stable id -- sent purely so the Python round-trip
  // can echo it back (schema-preview) or so the frontend can key Convert
  // results by it (see backendBridge.ts's slotToId) instead of by `name`.
  rectId: string;
  name?: string;
  group?: string;
  table_area: number[];
  table_area_by_page?: Record<string, number[]>;
  columns: string[];
  columns_by_page?: Record<string, string[]>;
  autoDetectColumns: boolean;
  outputSlot?: number;
  columnRenames?: Record<string, string>;
}
