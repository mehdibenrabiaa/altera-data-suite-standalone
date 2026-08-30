// Shared column-type detection -- used by ChangeTypeWindow.tsx (to pick
// each column's pre-selected type) and BrowseWindow.tsx/SchemaView.tsx's
// output-drawer grid (to show a Power-Query-style type icon before each
// column's header name, see columnTypeIcons.tsx). Best-effort CLIENT-SIDE
// detection only -- the authoritative type conversion always happens in
// Python (backend/app/nodes.py's change_type), so a mismatch here only
// affects a starting UI default or a decorative icon, never actual data.

export function isNumericValue(v: string): boolean {
  const s = v.trim();
  return s !== "" && !Number.isNaN(Number(s.replace(/,/g, "")));
}

export function isIntegerValue(v: string): boolean {
  const s = v.trim().replace(/,/g, "");
  return /^-?\d+$/.test(s);
}

// Date.parse/`new Date(string)` is far too lenient on its own to trust
// directly -- confirmed live: Date.parse("INV-1") returns a valid
// timestamp (V8's fallback date grammar accepts far more than real
// dates). Requiring the value to match a real structured date shape
// FIRST, and only then confirming it with Date.parse, avoids that class
// of false positive entirely.
const DATE_MONTH_NAMES = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
const DATE_SHAPE_PATTERNS = [
  /^\d{4}-\d{1,2}-\d{1,2}$/, // 2021-03-05
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/, // 01/15/2021
  /^\d{1,2}-\d{1,2}-\d{2,4}$/, // 01-15-2021
  new RegExp(`^(${DATE_MONTH_NAMES})\\.?\\s+\\d{1,2},?\\s+\\d{4}$`, "i"), // March 5, 2021
  new RegExp(`^\\d{1,2}\\s+(${DATE_MONTH_NAMES})\\.?,?\\s+\\d{4}$`, "i"), // 5 March 2021
];
export function isDateValue(v: string): boolean {
  const s = v.trim();
  if (s === "" || !DATE_SHAPE_PATTERNS.some((re) => re.test(s))) return false;
  return !Number.isNaN(Date.parse(s));
}

// Capped so detection stays cheap even against a very large table -- a
// few hundred sample rows is already more than enough to tell whether a
// column is consistently numeric/date/text.
export const DETECTION_SAMPLE_ROWS = 200;

export type DetectedColumnType = "text" | "integer" | "float" | "date";

// Numeric check runs BEFORE the date check on purpose: JS's Date.parse
// treats a bare 4-digit string like "2021" as a valid year, which would
// otherwise misclassify an ordinary numeric ID/quantity column as a date.
export function detectColumnType(values: string[]): DetectedColumnType {
  const nonEmpty = values.map((v) => (v ?? "").trim()).filter((v) => v !== "");
  if (nonEmpty.length === 0) return "text";
  if (nonEmpty.every(isNumericValue)) {
    return nonEmpty.every(isIntegerValue) ? "integer" : "float";
  }
  if (nonEmpty.every(isDateValue)) return "date";
  return "text";
}

// What a Change Type node's run result (backend/app/routers/nodes.py's
// `columnTypes`, set from change_type's own result.attrs) reports a column
// was ACTUALLY converted to -- "number" stays undifferentiated the same
// way ChangeTypeTarget itself does (no separate Integer/Float target, see
// types.ts's own comment), so resolveDisplayColumnType below is what
// splits it back into Integer vs Float for the icon.
export type AppliedColumnType = "number" | "float" | "date" | "text";

// The one hardcoded exception to "every column defaults to Text" below --
// unlike every other column, `Page` is never extracted/parsed FROM the PDF
// at all: backend/app/extraction.py assigns it directly as a real Python
// int (`df["Page"] = page_num`) on every table, for every extraction path.
// There's no ambiguous string content to guess at here, so showing Text
// for it (the same way an unconverted, genuinely-still-text data column
// would) would be UNDER-stating what's actually known about it -- this
// isn't a content guess, it's a fixed fact about how this app's own
// backend builds that one specific column.
const ALWAYS_INTEGER_COLUMN_NAMES = new Set(["Page"]);

// The output-preview header icon (BrowseWindow.tsx/SchemaView.tsx's output
// drawer) shows a column's REAL, current type -- never a guess from its
// string content. Every column defaults to Text (this app's wire format
// has no real per-column type system; a column IS text until something
// actually converts it -- see types.ts's ChangeTypeTarget comment), and
// only a column a Change Type node genuinely ran gets anything else, read
// straight from `appliedType`. For "number" specifically, splitting into
// Integer vs Float by checking isIntegerValue against these particular
// values is still NOT guessing, unlike detectColumnType above -- these are
// backend-formatted output (_format_number in nodes.py), not raw
// extraction noise, so their shape is a fact about the data, not a guess.
export function resolveDisplayColumnType(
  columnName: string,
  appliedType: AppliedColumnType | undefined,
  sampleValues: string[],
): DetectedColumnType {
  if (ALWAYS_INTEGER_COLUMN_NAMES.has(columnName)) return "integer";
  if (!appliedType || appliedType === "text") return "text";
  if (appliedType === "date") return "date";
  if (appliedType === "float") return "float";
  const nonEmpty = sampleValues.map((v) => (v ?? "").trim()).filter((v) => v !== "");
  return nonEmpty.length > 0 && nonEmpty.every(isIntegerValue) ? "integer" : "float";
}
