// Shared by MergeWindow.tsx (Configure window's own initial state) and
// SchemaView.tsx (the auto-run path, so a brand-new Merge node produces
// real output the moment both inputs resolve -- no open-Configure-and-hit-
// Apply detour needed for the common case) so the one fallback rule lives
// in exactly one place.
//   1. Both tables have a column literally named "Page" (case-insensitive
//      -- this app's own PDF-table extraction always adds one, so it's
//      the single most likely shared column across two tables here) --
//      matches each table's own actual casing of it, not a hardcoded "Page".
//   2. Otherwise, the first column name that exists in both tables at all
//      (case-sensitive exact match, in the primary table's own column order).
//   3. Otherwise, no default -- leaves matchColumns empty/unconfigured.
export function computeDefaultMatchPair(primaryColumns: string[], extraColumns: string[]): { left: string; right: string } | null {
  const primaryPage = primaryColumns.find((c) => c.toLowerCase() === "page");
  const extraPage = extraColumns.find((c) => c.toLowerCase() === "page");
  if (primaryPage && extraPage) return { left: primaryPage, right: extraPage };
  const extraSet = new Set(extraColumns);
  const common = primaryColumns.find((c) => extraSet.has(c));
  return common ? { left: common, right: common } : null;
}
