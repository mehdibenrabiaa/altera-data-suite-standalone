import re
import string
from typing import Any, Callable

import numpy as np
import pandas as pd

# ── Processor-node transforms ────────────────────────────────────────────
# One shared functions module for every real node transform, mirroring
# auxiliary_functions.py's own "one shared functions module, thin per-widget
# wrapper on top" convention in devkit/orangecontrib/custom/widgets/ -- a
# flat NODE_TRANSFORMS registry is right-sized while there's a single node;
# split into a nodes/ package (one module per kind) once a node with a
# genuinely richer params model (e.g. Filter Builder's AND/OR tree) shows
# up, not before.


def _make_unique_column_names(columns: list[str]) -> list[str]:
    # Ported from auxiliary_functions.py's make_unique_column_names, with
    # one fix: the original only tracks collisions against ORIGINAL column
    # names, so e.g. ["A", "A", "A_1"] -> ["A", "A_1", "A_1"] there (the
    # third column is already literally named "A_1", which was never
    # recorded, so it passes through unchanged and still collides). This
    # version tracks every name it has actually EMITTED, looping the
    # suffix counter until a genuinely free name is found.
    emitted: set[str] = set()
    unique: list[str] = []
    for col in columns:
        name = str(col)
        candidate = name
        n = 0
        while candidate in emitted:
            n += 1
            candidate = f"{name}_{n}"
        emitted.add(candidate)
        unique.append(candidate)
    return unique


def horizontal_stack(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    # Ported from OWHStack._p / dataframe_to_orange_table_stacked
    # (devkit/orangecontrib/custom/widgets/horizontal_stack.py,
    # auxiliary_functions.py) -- purely positional column-wise concat, not
    # a join-by-key. None of the Orange Table/ContinuousVariable/
    # StringVariable typing from the original applies here: every column
    # arriving over the wire is already a plain string (this app's
    # established {columns, rows} wire format), so the port is just the
    # concat + row-count + column-dedup logic, nothing else.
    if len(dfs) < 2:
        raise ValueError("Horizontal Stack needs at least 2 input tables.")

    row_counts = {len(df) for df in dfs}
    warnings: list[str] = []
    if len(row_counts) > 1:
        if not params.get("allowPadding", True):
            raise ValueError(
                "Input tables have different row counts. Enable padding to stack them anyway."
            )
        warnings.append(
            "Input tables had different row counts -- shorter table(s) padded with empty values."
        )

    # Every df was just built fresh via pd.DataFrame(rows, columns=columns)
    # (see routers/nodes.py), so each one always has a plain default
    # RangeIndex(0..n-1) with no prior filtering/reindexing -- concatenating
    # on axis=1 aligns by that index, which for two fresh RangeIndexes is
    # exactly positional alignment, NaN-padding whichever frame is shorter.
    result = pd.concat(dfs, axis=1)
    result.columns = _make_unique_column_names(list(result.columns))
    return result, warnings, []


# ── Filter Builder ───────────────────────────────────────────────────────
# Ported from OWAdvancedFilter / build_filter_mask / _apply_condition_mask
# (devkit/orangecontrib/custom/widgets/filter_builder.py,
# auxiliary_functions.py). Two-level rule model: a list of groups, always
# OR'd together, each holding a list of conditions combined by that group's
# own match ("all" = AND, "any" = OR). None of the Orange Domain/
# ContinuousVariable/DiscreteVariable type dispatch applies here -- column
# "type" (numeric vs text) is inferred on the fly from the plain-string
# {columns, rows} wire format instead.
#
# Deliberate differences from the original (see the plan's Scope Cuts):
# "between" is actually implemented (the original's frontend offers it but
# the backend never does, so it silently no-ops there); contains/
# not_contains/starts_with/ends_with are ALL case-insensitive here (the
# original is inconsistent -- contains is insensitive, starts/ends_with
# aren't, a pandas quirk rather than a deliberate design); a condition on a
# missing column or an uncoercible value is still dropped but now adds a
# warning instead of failing silently.
def _column_is_numeric(series: pd.Series) -> bool:
    non_empty = series[series.astype(str).str.strip() != ""]
    if non_empty.empty:
        return False
    return pd.to_numeric(non_empty, errors="coerce").notna().all()


def _apply_condition(
    df: pd.DataFrame,
    condition: dict[str, Any],
    warnings: list[str],
    extra_df: "pd.DataFrame | None" = None,
) -> "pd.Series[bool] | None":
    column = condition.get("column")
    operator = condition.get("operator")
    value = condition.get("value")
    if column not in df.columns:
        warnings.append(f"Condition on column '{column}' skipped: column not found.")
        return None
    s = df[column]
    if operator == "is_defined":
        return s.astype(str).str.strip() != ""
    if operator == "is_not_defined":
        return s.astype(str).str.strip() == ""

    numeric = _column_is_numeric(s)

    # extra_ref: "match any value found in a column of the Extra Data
    # input" (the square handle) -- an isin()-style lookup, ported from the
    # original's per-value OR/AND expansion but simplified to a direct
    # isin()/~isin() rather than looping a sub-mask per unique value. Only
    # equals/not_equals make sense for this (an "IN list" check), which the
    # frontend already only offers it for -- anything else is a malformed
    # payload, not a normal user path, so it's just dropped with a warning.
    if isinstance(value, dict) and value.get("type") == "extra_ref":
        if operator not in ("equals", "not_equals"):
            warnings.append(f"Condition on '{column}' skipped: 'Extra Data' matching only supports Equals/Not equals.")
            return None
        if extra_df is None:
            warnings.append(f"Condition on '{column}' skipped: no Extra Data table connected.")
            return None
        extra_col = value.get("column")
        if not extra_col or extra_col not in extra_df.columns:
            warnings.append(f"Condition on '{column}' skipped: Extra Data column '{extra_col}' not found.")
            return None
        if numeric:
            lookup = pd.to_numeric(extra_df[extra_col], errors="coerce").dropna().unique()
            s_cmp = pd.to_numeric(s, errors="coerce")
        else:
            lookup = extra_df[extra_col].dropna().astype(str).unique()
            s_cmp = s.astype(str)
        isin = s_cmp.isin(lookup)
        return ~isin if operator == "not_equals" else isin

    # contains/not_contains/starts_with/ends_with are inherently string
    # operations -- always evaluate them against the column's string
    # representation, even when _column_is_numeric classifies the column
    # as numeric. Checking this BEFORE the numeric branch matters: a
    # column that's numeric for every row except a stray leaked value
    # (e.g. an "REGULAR" hours column where one row's cell is literally
    # "HOURS", a repeated header row bleeding into the data) still counts
    # as numeric by _column_is_numeric's own "coerce and require .all()"
    # rule for every OTHER row, so a not_contains condition on it used to
    # fall into the numeric branch, try to coerce the search text itself
    # ("HOURS") to a float, fail, and silently drop the whole condition --
    # reported as "filtered on X not containing Y, but rows containing Y
    # were still kept" (the condition was never actually applied, not a
    # matching-logic bug).
    if operator in ("contains", "not_contains", "starts_with", "ends_with"):
        s_str = s.astype(str)
        val_str = "" if value is None else str(value)
        string_ops = {
            "contains": s_str.str.contains(val_str, case=False, na=False, regex=False),
            "not_contains": ~s_str.str.contains(val_str, case=False, na=False, regex=False),
            "starts_with": s_str.str.lower().str.startswith(val_str.lower(), na=False),
            "ends_with": s_str.str.lower().str.endswith(val_str.lower(), na=False),
        }
        return string_ops[operator]

    if numeric:
        s_num = pd.to_numeric(s, errors="coerce")
        if operator == "between":
            try:
                lo, hi = float(value["from"]), float(value["to"])
            except (TypeError, ValueError, KeyError):
                warnings.append(f"Condition on '{column}' skipped: 'between' needs two numbers.")
                return None
            return s_num.between(min(lo, hi), max(lo, hi))
        try:
            v = float(value)
        except (TypeError, ValueError):
            warnings.append(f"Condition on '{column}' skipped: '{value}' is not numeric.")
            return None
        ops = {
            "equals": s_num == v,
            "not_equals": s_num != v,
            "greater_than": s_num > v,
            "less_than": s_num < v,
            "greater_or_equal": s_num >= v,
            "less_or_equal": s_num <= v,
        }
    else:
        s_str = s.astype(str)
        val_str = "" if value is None else str(value)
        ops = {
            "equals": s_str == val_str,
            "not_equals": s_str != val_str,
        }
    if operator not in ops:
        warnings.append(f"Condition on '{column}' skipped: unsupported operator '{operator}'.")
        return None
    return ops[operator]


def filter_builder(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Filter Builder needs a connected input table.")
    df = dfs[0]
    # dfs[1], if present, is whatever's connected to the square Extra Data
    # input (see SchemaView.tsx's resolveExtraDataInput, which appends it
    # after the primary input before the run request goes out) -- always
    # optional, unlike df itself.
    extra_df = dfs[1] if len(dfs) > 1 else None
    groups = params.get("groups") or []
    warnings: list[str] = []
    if not groups:
        return df, warnings, []  # nothing configured -- pass through unfiltered

    group_masks = []
    for group in groups:
        masks = [m for c in group.get("conditions", []) if (m := _apply_condition(df, c, warnings, extra_df)) is not None]
        if not masks:
            continue
        combine = np.logical_and.reduce if group.get("match", "all") == "all" else np.logical_or.reduce
        group_masks.append(combine(masks))

    if not group_masks:
        warnings.append("All filter conditions were invalid -- no rows matched.")
        mask = pd.Series(False, index=df.index)
    else:
        mask = pd.Series(np.logical_or.reduce(group_masks), index=df.index)

    result = df[mask]
    info = [f"Filter matched 0 of {len(df)} rows."] if len(result) == 0 and group_masks else []
    return result, warnings, info


# ── Header Promoter ──────────────────────────────────────────────────────
# Ported from promote_row_to_header (devkit/orangecontrib/custom/widgets/
# auxiliary_functions.py) -- the original's Orange-Table round trip
# (df_to_orange_header_promoter's ContinuousVariable/DiscreteVariable
# dispatch) doesn't apply here, so this is just the actual row-promotion
# logic: pick a row, its values become the new column headers, then either
# drop everything at-or-above that row (remove_above) or just that one row.
def promote_row_to_header(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Header Promoter needs a connected input table.")
    df = dfs[0]
    row_index = params.get("rowIndex")
    if row_index is None:
        return df, [], []  # nothing configured yet -- pass through unchanged
    remove_above = params.get("removeAbove", True)
    if row_index < 0 or row_index >= len(df):
        raise ValueError(f"Row {row_index + 1} is out of range for a table with {len(df)} rows.")

    # Fall back to the column's existing name wherever the promoted row's
    # own cell is blank -- reported as "an empty column appeared", but it
    # was really just the SAME column losing its placeholder name (e.g.
    # extraction's auto-assigned "Column_1") the moment the picked row's
    # cell for it turned out empty in the source table. Keeping the old
    # name there instead of "" avoids ending up with an unnamed column.
    new_headers_raw = [
        (str(v).strip() if v is not None else "") or str(orig)
        for v, orig in zip(df.iloc[row_index].tolist(), df.columns)
    ]
    new_headers = _make_unique_column_names(new_headers_raw)
    result = df.iloc[row_index + 1:].copy() if remove_above else df.drop(df.index[row_index]).copy()
    result.columns = new_headers
    result.reset_index(drop=True, inplace=True)
    return result, [], []


# ── Index Column ─────────────────────────────────────────────────────────
# No params, no Configure window (nodeCatalog.ts has no entry for it in
# NODE_WINDOW_LABEL) -- connect a table, it runs automatically like
# Horizontal Stack does, prepending a plain 1..N row-index column.
def add_index_column(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Index Column needs a connected input table.")
    df = dfs[0]
    result = df.copy()
    # If the table already has a real column literally named "Index",
    # _make_unique_column_names bumps THAT one to "Index_1" (etc) so the
    # new column can claim the plain "Index" name -- but that's only a
    # computed list of names until it's actually applied back to
    # result.columns; skipping this rename and just calling .insert()
    # with the computed name would still collide with the untouched
    # original column and raise ValueError: cannot insert Index, already
    # exists.
    unique_columns = _make_unique_column_names(["Index"] + list(result.columns))
    result.columns = unique_columns[1:]
    result.insert(0, unique_columns[0], range(1, len(result) + 1))
    return result, [], []


# ── Merge ─────────────────────────────────────────────────────────────────
# Modeled on Orange's own Merge Data widget
# (https://orangedatamining.com/widget-catalog/transform/mergedata/) --
# same three merge strategies and the "match by attribute values (one or
# more column pairs) vs by row position" choice. The widget's third
# matching option ("by Instance ID") has no equivalent here -- this app's
# {columns, rows} wire format has no persistent per-row identity across
# nodes the way Orange's own Table does, so it isn't offered.
def merge_data(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if len(dfs) < 2:
        raise ValueError("Merge needs both a primary table and an Extra Data table.")
    left, right = dfs[0], dfs[1]
    merge_type = params.get("mergeType", "append")
    # append = "Append Columns" (left join): every primary row is kept,
    # unmatched ones get blanks for the Extra Data columns.
    # matching = "Find Matching Pairs" (inner join): only rows present in
    # both tables survive.
    # concatenate = "Concatenate Tables" (outer join): every row from
    # both tables is kept, missing values fill in wherever a row from one
    # side has no counterpart on the other.
    how = {"append": "left", "matching": "inner", "concatenate": "outer"}.get(merge_type)
    if how is None:
        raise ValueError(f"Unknown merge type: {merge_type}")
    match_by = params.get("matchBy", "attributes")

    if match_by == "row_index":
        left_aligned = left.reset_index(drop=True)
        right_aligned = right.reset_index(drop=True)
        if how == "inner":
            n = min(len(left_aligned), len(right_aligned))
            left_aligned = left_aligned.iloc[:n]
            right_aligned = right_aligned.iloc[:n]
        else:
            n = len(left_aligned) if how == "left" else max(len(left_aligned), len(right_aligned))
            left_aligned = left_aligned.reindex(range(n))
            right_aligned = right_aligned.reindex(range(n))
        result = pd.concat(
            [left_aligned.reset_index(drop=True), right_aligned.reset_index(drop=True)], axis=1
        )
        result.columns = _make_unique_column_names(list(result.columns))
        return result, [], []

    pairs = params.get("matchColumns") or []
    if not pairs:
        raise ValueError("Select at least one pair of columns to match on.")
    left_on = [p.get("left") for p in pairs]
    right_on = [p.get("right") for p in pairs]
    missing = [c for c in left_on if c not in left.columns] + [c for c in right_on if c not in right.columns]
    if missing:
        raise ValueError(f"Match column not found: {', '.join(missing)}")

    # suffixes=("", "_extra") -- rather than pandas' default "_x"/"_y",
    # since every OTHER column-collision spot in this app (Horizontal
    # Stack's dedup, Header Promoter's dedup) keeps the FIRST table's
    # names untouched and only decorates the incoming side.
    result = left.merge(right, how=how, left_on=left_on, right_on=right_on, suffixes=("", "_extra"))
    result.columns = _make_unique_column_names(list(result.columns))
    return result, [], []


# ── Shift Columns ─────────────────────────────────────────────────────────
# Ported from OWMultiShiftColumns / apply_column_shift (devkit/orangecontrib/
# custom/widgets/multishift.py, auxiliary_functions.py) -- shifts VALUES
# within each selected column up or down by `steps` rows (a lag/lead, like
# pandas' own Series.shift), not a column-position move: the column stays
# in the same place, only the values inside it move relative to the row
# index. Columns not in selectedColumns are left untouched. Vacated
# boundary cells become blank (pandas' own shift default when fill_value
# is None) -- no separate configurable fill value in the original either.
def shift_columns(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Shift Columns needs a connected input table.")
    df = dfs[0]
    selected = params.get("selectedColumns") or []
    if not selected:
        return df, [], []  # nothing configured yet -- pass through unchanged
    direction = params.get("direction", "down")
    if direction not in ("down", "up"):
        raise ValueError(f"Unknown shift direction: {direction}")
    try:
        steps = int(params.get("steps", 1))
    except (TypeError, ValueError):
        raise ValueError(f"Shift steps must be a whole number, got {params.get('steps')!r}.")
    if steps < 1:
        raise ValueError("Shift steps must be at least 1.")

    shift_amount = steps if direction == "down" else -steps
    result = df.copy()
    for col in selected:
        if col in result.columns:
            result[col] = result[col].shift(shift_amount, fill_value=None)
    return result, [], []


# ── Cleaner ───────────────────────────────────────────────────────────────
# Ported from OWCleaner / apply_cleaning_operation / apply_all_cleaning_
# operations (devkit/orangecontrib/custom/widgets/cleaner.py,
# auxiliary_functions.py). Every value is force-cast to a string before any
# operation runs (matching the original exactly), so this always produces
# text -- no attempt to preserve/restore a numeric dtype afterward, same as
# the original's own behavior on non-string columns.
def _apply_cleaning_operation(series: pd.Series, operation: str, params: dict[str, Any]) -> pd.Series:
    s = series.astype(str)
    if operation == "replace":
        find = params.get("find", "")
        replace = params.get("replace", "")
        if find:
            if params.get("caseSensitive", False):
                s = s.str.replace(find, replace, regex=False)
            else:
                s = s.str.replace(find, replace, case=False, regex=False)
    elif operation == "remove_spaces":
        s = s.str.replace(r"\s+", " ", regex=True)
    elif operation == "trim":
        s = s.str.strip()
    elif operation == "remove_special":
        s = s.str.replace(r"[^a-zA-Z0-9\s]", "", regex=True)
    elif operation == "uppercase":
        s = s.str.upper()
    elif operation == "lowercase":
        s = s.str.lower()
    elif operation == "titlecase":
        s = s.str.title()
    elif operation == "remove_digits":
        s = s.str.replace(r"\d", "", regex=True)
    elif operation == "keep_digits":
        s = s.str.replace(r"\D", "", regex=True)
    elif operation == "remove_punctuation":
        s = s.str.replace(f"[{re.escape(string.punctuation)}]", "", regex=True)
    elif operation == "strip_chars":
        chars = params.get("chars", "")
        if chars:
            s = s.str.replace(f"[{re.escape(chars)}]", "", regex=True)
    elif operation == "remove_prefix":
        prefix = params.get("prefix", "")
        if prefix:
            s = s.str.removeprefix(prefix)
    elif operation == "remove_suffix":
        suffix = params.get("suffix", "")
        if suffix:
            s = s.str.removesuffix(suffix)
    elif operation == "fill_na":
        # Fills real missing values (NaN/None/NaT) on the pre-cast series
        # AND cells that are blank/whitespace-only in the current chain
        # state -- covers both a truly-missing source cell and one left
        # blank by an earlier chained operation (e.g. Trim Whitespace).
        fill_value = params.get("fillValue", "")
        mask = series.isna() | (s.str.strip() == "")
        s = s.mask(mask, fill_value)
    else:
        raise ValueError(f"Unknown cleaning operation: {operation}")
    return s


def clean_columns(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Cleaner needs a connected input table.")
    df = dfs[0]
    operations = params.get("operations") or []
    if not operations:
        return df, [], []  # nothing configured yet -- pass through unchanged

    result = df.copy()
    warnings: list[str] = []
    for op in operations:
        columns = op.get("columns") or []
        operation = op.get("operation")
        op_params = op.get("params") or {}
        for column in columns:
            if column not in result.columns:
                warnings.append(f"Cleaning operation skipped: column '{column}' not found.")
                continue
            result[column] = _apply_cleaning_operation(result[column], operation, op_params)
    return result, warnings, []


# ── Unique ────────────────────────────────────────────────────────────────
# Ported from OWDeduplicator (devkit/orangecontrib/custom/widgets/
# deduplicator.py) -- renamed here since "keep only unique rows" reads
# clearer than the original widget's own name. Wraps pandas' own
# DataFrame.drop_duplicates over a user-selected SUBSET of columns (not
# automatically every column -- selecting every column by hand is
# equivalent to whole-row dedup, but that's a user choice, not the
# default). "keep" picks which occurrence of each duplicate group
# survives: "first"/"last" map straight to pandas; "none" maps to
# pandas' own keep=False, which drops EVERY row in a duplicate group --
# including the first occurrence, not just the extras. Row order of
# survivors is preserved (drop_duplicates never reorders); no marker/
# count column is added, same columns in, fewer rows out.
def deduplicate_rows(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Unique needs a connected input table.")
    df = dfs[0]
    columns = params.get("columns") or []
    warnings: list[str] = []
    valid = [c for c in columns if c in df.columns]
    for c in columns:
        if c not in df.columns:
            warnings.append(f"Column '{c}' not found -- skipped.")
    if not valid:
        return df, warnings, []  # nothing (valid) configured yet -- pass through unchanged

    keep = params.get("keep", "first")
    if keep not in ("first", "last", "none"):
        raise ValueError(f"Unknown keep mode: {keep}")
    keep_param: "str | bool" = False if keep == "none" else keep
    result = df.drop_duplicates(subset=valid, keep=keep_param).copy()
    return result, warnings, []


# ── Column Edit ──────────────────────────────────────────────────────────
# Ported from OWColumnManager (devkit/orangecontrib/custom/widgets/
# columns_manager.py), renamed with its UI adapted to this app's own
# dnd-kit sortable-card convention rather than the original's AG-Grid
# header-drag interface. One ordered list of entries IS the entire
# desired state -- there's no separate reorder/rename/delete step:
# - array order = column order
# - a `name` that differs from `field` = a rename (the ORIGINAL column,
#   `field`, is left untouched; only what it's later called changes)
# - a column simply absent from the list = deleted (excluded by omission,
#   same as the original -- nothing here actively "removes" anything)
# (The original also supported adding a brand-new constant-value column
# via an `isNew`/`defaultValue` entry -- deliberately left out of this
# node; it'll get its own dedicated node later instead.)
# Unlike the original, which never checked for two entries ending up with
# the same output `name` (an unhandled edge case there), this adds the
# same _make_unique_column_names safety net every other dedup-prone node
# here already uses.
def column_edit(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Column Edit needs a connected input table.")
    df = dfs[0]
    columns = params.get("columns") or []
    if not columns:
        return df, [], []  # nothing configured yet -- pass through unchanged

    warnings: list[str] = []
    names: list[str] = []
    series_list: list[list[Any]] = []
    for entry in columns:
        field = entry.get("field")
        if field not in df.columns:
            warnings.append(f"Column '{field}' not found -- skipped.")
            continue
        names.append(str(entry.get("name") or field))
        series_list.append(df[field].tolist())

    if not names:
        return df, warnings, []  # every referenced column was missing -- pass through

    unique_names = _make_unique_column_names(names)
    result = pd.DataFrame({unique_names[i]: series_list[i] for i in range(len(unique_names))})
    return result, warnings, []


# ── Change Type ──────────────────────────────────────────────────────────
# A brand-new node, not ported from an old Orange widget. This app's wire
# format has no real per-column type system (every value is always a
# plain string on the wire -- see SchemaView.tsx's own
# inferColumnDefinition comment), so "changing type" here means coercing
# a column's actual cell VALUES into a clean form of that type (e.g.
# "1,234.50" -> "1234.5"), not flipping a schema flag anywhere. "text" is
# a no-op-shaped passthrough (every value already has a string form, so
# it can never fail). "number" can genuinely fail per-cell -- not every
# string parses as a number -- and that's the one case this node has an
# explicit policy for: fillUnconvertible off means ANY failure blocks the
# whole run with an error naming which columns/how many cells failed (the
# "tell the user" the node was built for); on means failing cells get
# fallbackValue instead, reported as a warning (not an error) with the
# same per-column counts. UI modeled on Alteryx's own Select tool: every
# field gets its own row with its own type dropdown (Text/Number/Date),
# pre-selected to whatever that column's values currently look like --
# see ChangeTypeWindow.tsx.
def _to_number_or_none(value: Any) -> "float | None":
    s = str(value).strip()
    if s == "":
        return None
    # Tolerate thousands separators -- common in real extracted data
    # (invoice amounts, quantities), and stripping them can never turn a
    # genuinely-invalid value into a valid number, so it's a safe default.
    try:
        return float(s.replace(",", ""))
    except ValueError:
        return None


def _format_number(v: float) -> str:
    # Whole numbers print without a trailing ".0" -- matches how a human
    # would actually write "1234", not "1234.0".
    return str(int(v)) if v == int(v) else str(v)


def _format_float(v: float) -> str:
    # Unlike _format_number, always keeps the decimal form -- Float means
    # "show this as a decimal even if the value happens to be whole" (e.g.
    # a Page column deliberately converted to Float still reads "1.0").
    return str(v)


def _to_date_or_none(value: Any) -> "pd.Timestamp | None":
    s = str(value).strip()
    if s == "":
        return None
    # pandas' own date parser already tolerates most real-world formats
    # (MM/DD/YYYY, YYYY-MM-DD, "Jan 5, 2024", ...) without needing a
    # format string spelled out up front.
    try:
        return pd.to_datetime(s, errors="raise")
    except (ValueError, TypeError):
        return None


def _format_date(v: "pd.Timestamp") -> str:
    # Always normalizes to a plain date (YYYY-MM-DD), dropping any time
    # component -- this is "Date", not "DateTime".
    return v.strftime("%Y-%m-%d")


def change_type(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Change Type needs a connected input table.")
    df = dfs[0]
    fields = params.get("fields") or []
    warnings: list[str] = []
    info: list[str] = []

    to_number: list[str] = []
    to_float: list[str] = []
    to_text: list[str] = []
    to_date: list[str] = []
    buckets = {"number": to_number, "float": to_float, "text": to_text, "date": to_date}
    for entry in fields:
        target = entry.get("targetType")
        if target not in buckets:
            raise ValueError(f"Unknown target type: {target}")
        field = entry.get("field")
        if field not in df.columns:
            warnings.append(f"Column '{field}' not found -- skipped.")
            continue
        buckets[target].append(field)

    if not to_number and not to_float and not to_text and not to_date:
        return df, warnings, []  # nothing configured yet -- pass through unchanged

    result = df.copy()
    for col in to_text:
        result[col] = result[col].astype(str)

    fill = bool(params.get("fillUnconvertible", False))
    fallback = str(params.get("fallbackValue", ""))

    # Number, Float, and Date share the exact same "parse everything, then
    # either block on any failure or fill it in" policy -- only the
    # parse/format functions and the label in the error/warning message
    # differ.
    def _convert_parseable(columns: list[str], parse_fn: Any, format_fn: Any, type_label: str) -> None:
        if not columns:
            return
        parsed_by_col: dict[str, list[Any]] = {}
        failures: dict[str, int] = {}
        for col in columns:
            parsed = [parse_fn(v) for v in result[col]]
            bad = sum(1 for v in parsed if v is None)
            if bad:
                failures[col] = bad
            parsed_by_col[col] = parsed
        if failures and not fill:
            detail = ", ".join(f"'{c}': {n} cell(s)" for c, n in failures.items())
            raise ValueError(
                f"Some cells could not convert to {type_label} -- {detail}. "
                'Enable "Fill cells that can\'t convert" to proceed anyway.'
            )
        for col in columns:
            result[col] = [format_fn(v) if v is not None else fallback for v in parsed_by_col[col]]
        if failures:
            # Info, not a warning -- the user explicitly opted into this by
            # checking "Fill cells that can't convert", so a cell actually
            # getting filled is the anticipated outcome of their own
            # setting, not something-went-wrong. Same neutral tier Filter
            # Builder already uses for "a valid rule just matched 0 rows".
            detail = ", ".join(f"'{c}': {n} cell(s)" for c, n in failures.items())
            info.append(f"Filled cell(s) that couldn't convert to {type_label} with the fallback value -- {detail}.")

    _convert_parseable(to_number, _to_number_or_none, _format_number, "Number")
    _convert_parseable(to_float, _to_number_or_none, _format_float, "Float")
    _convert_parseable(to_date, _to_date_or_none, _format_date, "Date")
    # Side-channel metadata (pandas' own `.attrs`, not a DataFrame column) --
    # read by routers/nodes.py to tell the frontend which columns were
    # ACTUALLY converted, and to what, so the output-preview header icon
    # can show a column's real, current type instead of re-guessing it from
    # its string content (which every other node's output already gets no
    # icon at all for, having never gone through a real conversion). See
    # columnTypeDetection.ts's resolveDisplayColumnType for how "number"
    # still resolves to an Integer-vs-Float icon from these now-trustworthy
    # (backend-formatted, not raw-extracted) values.
    result.attrs["column_types"] = {
        **{c: "number" for c in to_number},
        **{c: "float" for c in to_float},
        **{c: "date" for c in to_date},
        **{c: "text" for c in to_text},
    }
    return result, warnings, info


# ── Regular Expressions ─────────────────────────────────────────────────
# Ported from OWRegex / process_regex_pattern (devkit/orangecontrib/
# custom/widgets/regex.py, auxiliary_functions.py), minus the original's
# AI-assist (describe-it-in-English -> external license-gated API call --
# no equivalent infrastructure exists here, so the pattern is always
# typed by hand) and its dead-code preset library (shipped in the
# original's own backend but never actually wired into its own UI).
# Single column, single pattern, three mutually exclusive modes:
# "smart_extract" -- first match per cell; 0 groups = one column (the
# whole match); N groups = the whole match PLUS one column per group
# (achieved by wrapping the whole pattern in an extra outer capture group
# so its own match becomes group 1, shifting the original groups to
# 2..N+1).
# "precision_capture" -- like smart_extract but only the group values (no
# whole-match column); 0 groups falls back to the same single
# whole-match column smart_extract would produce. Falsy/empty groups are
# filtered out and the survivors packed left-to-right, so which original
# group lands in which output column can shift row to row -- this
# mirrors the original exactly, not a bug in the port.
# "greedy_collect" -- ALL matches per cell (not just the first), one
# column per match INDEX across the whole column (row N's 2nd match
# lands in the same column as every other row's 2nd match) -- not a
# joined string and not one row per match. A match with capture groups
# joins the group values with a space (Python's own re.findall quirk:
# with groups present it returns tuples instead of the full match).
# A cell with no match always gets "" in the new column(s) -- never null,
# never the original value -- the original column is never touched,
# extraction only ever appends new ones. Output column names are always
# numbered positionally (_group1, _group2, ...), never by a regex named
# group's own name, same as the original. New column names are run
# through the same _make_unique_column_names safety net every other
# node here uses to avoid colliding with an existing column.
def extract_regex(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Regular Expressions needs a connected input table.")
    df = dfs[0]
    column = params.get("column")
    if not column or column not in df.columns:
        return df, [], []  # no column picked yet -- pass through unchanged
    pattern = params.get("pattern", "")
    if not pattern:
        return df, [], []  # no pattern typed yet -- pass through unchanged

    if params.get("literal", False):
        pattern = re.escape(pattern)
    try:
        compiled = re.compile(pattern)
    except re.error as exc:
        raise ValueError(f"Invalid regex pattern: {exc}")

    mode = params.get("mode", "smart_extract")
    new_col_base = str(params.get("newColumnName") or "Extracted")
    num_groups = compiled.groups
    col_names: list[str]
    values_by_col: list[list[str]]

    if mode in ("smart_extract", "precision_capture"):
        if num_groups == 0:
            col_names = [new_col_base]
            values_by_col = [[]]
            for v in df[column]:
                m = compiled.search(str(v))
                values_by_col[0].append(m.group(0) if m else "")
        elif mode == "smart_extract":
            # Wrap the whole pattern in an outer group -- group(1) becomes
            # the full match, groups 2..N+1 are the original groups.
            full_compiled = re.compile(f"({pattern})")
            col_names = [new_col_base] + [f"{new_col_base}_group{i}" for i in range(1, num_groups + 1)]
            values_by_col = [[] for _ in col_names]
            for v in df[column]:
                m = full_compiled.search(str(v))
                groups = m.groups() if m else [""] * len(col_names)
                for i, g in enumerate(groups):
                    values_by_col[i].append(g if g is not None else "")
        else:  # precision_capture with groups
            col_names = [new_col_base] + [f"{new_col_base}_group{i}" for i in range(1, num_groups)]
            values_by_col = [[] for _ in col_names]
            for v in df[column]:
                m = compiled.search(str(v))
                found = [g for g in m.groups() if g] if m else []
                for i in range(len(col_names)):
                    values_by_col[i].append(found[i] if i < len(found) else "")
    elif mode == "greedy_collect":
        def _findall_val(m: Any) -> str:
            return " ".join(m) if isinstance(m, tuple) else m
        all_matches = [[_findall_val(m) for m in compiled.findall(str(v))] for v in df[column]]
        max_len = max((len(m) for m in all_matches), default=0)
        col_names = [new_col_base] if max_len == 0 else [f"{new_col_base}_{i}" for i in range(1, max_len + 1)]
        values_by_col = [[] for _ in col_names]
        for found in all_matches:
            for i in range(len(col_names)):
                values_by_col[i].append(found[i] if i < len(found) else "")
    else:
        raise ValueError(f"Unknown extraction mode: {mode}")

    combined = _make_unique_column_names(list(df.columns) + col_names)
    unique_new_names = combined[len(df.columns):]
    result = df.copy()
    for name, values in zip(unique_new_names, values_by_col):
        result[name] = values
    return result, [], []


NODE_TRANSFORMS: dict[str, Callable[[list[pd.DataFrame], dict[str, Any]], tuple[pd.DataFrame, list[str], list[str]]]] = {
    "horizontal_stack": horizontal_stack,
    "filter_builder": filter_builder,
    "header_promoter": promote_row_to_header,
    "index_column": add_index_column,
    "merge_data": merge_data,
    "shift_columns": shift_columns,
    "clean_columns": clean_columns,
    "deduplicate_rows": deduplicate_rows,
    "column_edit": column_edit,
    "change_type": change_type,
    "extract_regex": extract_regex,
}
