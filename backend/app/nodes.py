import ast
import operator
import re
import string
from pathlib import Path
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


def _merged_column_types(dfs: list[pd.DataFrame]) -> dict[str, str]:
    # Best-effort column_types (see routers/nodes.py's own comment) for a
    # transform whose surviving columns keep their ORIGINAL names --
    # unions every input df's own column_types (set on it by run_node from
    # the request's per-input columnTypes), later dfs winning on a name
    # collision. Callers whose transform renames and/or drops columns
    # (Horizontal Stack, Merge, Header Promoter, Column Edit, Index
    # Column, Cleaner) build their own mapping instead of using this
    # directly -- this is only correct when a df's column keeps its exact
    # original name straight through to the result.
    merged: dict[str, str] = {}
    for df in dfs:
        merged.update(df.attrs.get("column_types") or {})
    return merged


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
    # Positional, not name-based: _make_unique_column_names can rename a
    # column on collision (two input tables both have an "Amount"), so the
    # column_types map has to be rebuilt walking the SAME dfs/columns
    # order concat used, zipped against the post-rename names -- a
    # name-keyed merge (_merged_column_types) would silently lose whichever
    # column got renamed.
    new_cols = _make_unique_column_names(list(result.columns))
    merged_types: dict[str, str] = {}
    i = 0
    for df in dfs:
        types = df.attrs.get("column_types") or {}
        for col in df.columns:
            if col in types:
                merged_types[new_cols[i]] = types[col]
            i += 1
    result.columns = new_cols
    result.attrs["column_types"] = merged_types
    return result, warnings, []


# ── Concatenate ──────────────────────────────────────────────────────────
# Orange's own Concatenate widget: stacks every connected table's ROWS into
# one, matching columns by NAME across however many tables are connected
# (not just two) -- the opposite axis from Horizontal Stack above, which
# combines column-wise by position instead. A column present in only some
# of the input tables is blank ("", this app's own null marker -- see
# routers/nodes.py's fillna("").astype(str) on every other node's result
# too) for any row from a table that didn't have it, rather than dropping
# that column or erroring. No configurable params -- like Horizontal
# Stack's own allowPadding default, this always runs with the one sensible
# default behavior; nothing here has needed a Configure window yet.
def concatenate(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if len(dfs) < 2:
        raise ValueError("Concatenate needs at least 2 connected tables.")
    # sort=False keeps first-seen column order (every column from the
    # first table, then any new ones the next table introduces, ...)
    # rather than alphabetizing them.
    result = pd.concat(dfs, ignore_index=True, sort=False)
    result = result.fillna("")
    # Name-based (not positional -- unlike Horizontal Stack, Concatenate
    # matches columns by NAME across tables, never renames on collision),
    # so the plain union is correct here.
    result.attrs["column_types"] = {k: v for k, v in _merged_column_types(dfs).items() if k in result.columns}
    return result, [], []


# ── Bridge ────────────────────────────────────────────────────────────────
# A pure pass-through -- no config, no transformation, just hands its input
# straight to the next node. Exists purely for organizing/routing a
# workflow's connections (e.g. running one table's output to several
# downstream branches from a single tidy point) rather than doing any real
# data work, the same role a plain wire junction plays in a schematic.
def bridge(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Bridge needs a connected input table.")
    return dfs[0], [], []


# ── Input Data ───────────────────────────────────────────────────────────
# The one node in the catalog that's a graph SOURCE, not a transform -- it
# takes no upstream table (dfs is always empty; routers/nodes.py's run_node
# still calls it the same generic way, just with inputs=[]) and instead
# reads a local .csv/.xlsx/.xls file straight off disk, given its path (and,
# for a multi-sheet workbook, which sheet) in params. Read WITHOUT forcing
# dtype=str first (unlike most of this file's string-in-string-out
# transforms) specifically so pandas' own dtype inference is available to
# populate column_types below -- run_node's generic .fillna("").astype(str)
# still stringifies everything for the actual wire format afterward, same
# as every other node's result.
def file_input(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    path = params.get("path")
    if not path:
        raise ValueError("No file selected -- click Configure to choose an Excel or CSV file.")
    p = Path(path)
    if not p.exists():
        raise ValueError(f"File not found: {path}")

    ext = p.suffix.lower()
    try:
        if ext in (".xlsx", ".xls"):
            sheet = params.get("sheet") or 0
            df = pd.read_excel(path, sheet_name=sheet)
        elif ext in (".csv", ".tsv"):
            df = pd.read_csv(path, sep="\t" if ext == ".tsv" else ",")
        else:
            raise ValueError(f"Unsupported file type: '{ext}' -- choose a .csv or .xlsx file.")
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"Could not read '{p.name}': {e}")

    if isinstance(df, dict):  # sheet_name resolved to more than one sheet somehow
        raise ValueError("Choose a single sheet.")

    df = df.copy()
    df.columns = _make_unique_column_names([_denormalize_pandas_header(c) or "Column" for c in df.columns])

    column_types: dict[str, str] = {}
    for col in df.columns:
        dt = df[col].dtype
        if pd.api.types.is_datetime64_any_dtype(dt):
            column_types[col] = "date"
        elif pd.api.types.is_numeric_dtype(dt):
            column_types[col] = "number"
    df.attrs["column_types"] = column_types

    info = [f"Loaded {len(df)} row(s), {len(df.columns)} column(s) from {p.name}."]
    return df, [], info


_PANDAS_DUPE_SUFFIX = re.compile(r"\.\d+$")
_PANDAS_UNNAMED = re.compile(r"^Unnamed: \d+$")


def _denormalize_pandas_header(raw: Any) -> str:
    # A raw file's own header row can legitimately have duplicate or blank
    # column names -- pandas already renames those itself while reading
    # (blank -> "Unnamed: 2", a repeated "A" -> "A.1"), before this
    # function ever sees them, in a style that doesn't match this app's own
    # "_1"-suffix convention (_make_unique_column_names, used everywhere
    # else a column name could collide). Undoing pandas' own mangling first
    # and re-running it through that same shared helper keeps a file's
    # columns looking the same as any other node's, at the small cost of
    # also unmangling a genuinely-named "Foo.1" column back to "Foo" --
    # an acceptable trade for consistency, and still a real, usable name
    # either way.
    s = str(raw)
    if _PANDAS_UNNAMED.match(s):
        return ""
    return _PANDAS_DUPE_SUFFIX.sub("", s)


# ── Sort ─────────────────────────────────────────────────────────────────
# Multi-key row sort, Excel "Sort" dialog style -- an ordered list of
# {column, direction} keys, applied together (not one sort per key run in
# sequence, which would only honor the LAST key -- see the single
# result.sort_values(by=[...]) call below, not a loop of separate sorts).
def sort_rows(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Sort needs a connected input table.")
    df = dfs[0]
    keys = params.get("keys") or []
    warnings: list[str] = []
    valid_keys: list[tuple[str, bool]] = []
    for k in keys:
        col = k.get("column")
        if col not in df.columns:
            warnings.append(f"Column '{col}' not found -- skipped.")
            continue
        valid_keys.append((col, k.get("direction") != "desc"))
    if not valid_keys:
        return df, warnings, []  # nothing configured yet -- pass through unchanged

    result = df.copy()
    sort_columns: list[str] = []
    ascending: list[bool] = []
    for i, (col, asc) in enumerate(valid_keys):
        values = result[col].astype(str)
        non_blank = values.str.strip() != ""
        numeric = values.map(_to_number_or_none)
        # A column sorts numerically only when EVERY non-blank cell in it
        # parsed as a number -- one stray text cell (a "N/A", a stray
        # label) falls back to a plain lexicographic sort for the whole
        # column rather than silently treating that cell as smaller/larger
        # than every real number, which is what letting NaN sort naturally
        # would otherwise do.
        is_numeric_col = bool(non_blank.any()) and numeric[non_blank].notna().all()
        blank_key = f"__sort_blank_{i}"
        val_key = f"__sort_val_{i}"
        # Blank cells always sort last, regardless of this key's own
        # direction -- matches Excel's own sort behavior, and reads far
        # more sensibly than "" outranking real values under Descending.
        result[blank_key] = ~non_blank
        result[val_key] = numeric if is_numeric_col else values
        sort_columns.append(blank_key)
        ascending.append(True)
        sort_columns.append(val_key)
        ascending.append(asc)

    result = result.sort_values(by=sort_columns, ascending=ascending, kind="mergesort")
    result = result.drop(columns=sort_columns).reset_index(drop=True)
    result.attrs["column_types"] = {k: v for k, v in _merged_column_types(dfs).items() if k in result.columns}
    return result, warnings, []


# ── Aggregate ────────────────────────────────────────────────────────────
# Alteryx's own Summarize tool (see nodeCatalog.ts's Transform-category
# comment, which already names it) -- a table's worth of rows collapses
# into exactly one output row, one column per configured {column,
# aggregation} metric. No GROUP BY column here (that's a materially bigger
# feature -- a future node, not this one); every metric summarizes the
# WHOLE table.
_AGGREGATE_LABELS = {"sum": "Sum", "average": "Average", "count": "Count", "min": "Min", "max": "Max"}


def aggregate_columns(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Aggregate needs a connected input table.")
    df = dfs[0]
    metrics = params.get("metrics") or []
    if not metrics:
        raise ValueError("Add at least one column to aggregate.")

    warnings: list[str] = []
    labels: list[str] = []
    values: list[str] = []
    for m in metrics:
        col = m.get("column")
        agg = m.get("aggregation")
        if col not in df.columns:
            warnings.append(f"Column '{col}' not found -- skipped.")
            continue
        if agg not in _AGGREGATE_LABELS:
            raise ValueError(f"Unknown aggregation: {agg}")

        column_values = df[col]
        if agg == "count":
            # Count of non-blank cells -- not len(df), which would just be
            # the same number for every column and defeat the point of
            # picking a specific column to count.
            non_blank = column_values.astype(str).str.strip() != ""
            result_value = str(int(non_blank.sum()))
        else:
            numeric = [n for n in (_to_number_or_none(v) for v in column_values) if n is not None]
            if not numeric:
                result_value = ""
                warnings.append(f"'{col}' has no numeric values -- {_AGGREGATE_LABELS[agg]} left blank.")
            elif agg == "sum":
                result_value = _format_number(sum(numeric))
            elif agg == "average":
                result_value = _format_number(sum(numeric) / len(numeric))
            elif agg == "min":
                result_value = _format_number(min(numeric))
            else:  # "max"
                result_value = _format_number(max(numeric))

        labels.append(f"{_AGGREGATE_LABELS[agg]} of {col}")
        values.append(result_value)

    if not labels:
        raise ValueError("None of the configured columns exist in the input table.")

    labels = _make_unique_column_names(labels)
    result = pd.DataFrame([values], columns=labels)
    result.attrs["column_types"] = {label: "number" for label in labels}
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
    result.attrs["column_types"] = df.attrs.get("column_types") or {}
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
    orig_types = df.attrs.get("column_types") or {}
    result = df.iloc[row_index + 1:].copy() if remove_above else df.drop(df.index[row_index]).copy()
    result.columns = new_headers
    result.attrs["column_types"] = {new: orig_types[old] for old, new in zip(df.columns, new_headers) if old in orig_types}
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
    orig_cols = list(result.columns)
    unique_columns = _make_unique_column_names(["Index"] + orig_cols)
    new_index_name, new_other_cols = unique_columns[0], unique_columns[1:]
    orig_types = df.attrs.get("column_types") or {}
    result.columns = new_other_cols
    result.insert(0, new_index_name, range(1, len(result) + 1))
    # The new column is always genuinely a whole number, so it can be
    # tagged directly rather than inherited from anywhere.
    result.attrs["column_types"] = {
        new_index_name: "number",
        **{new: orig_types[old] for old, new in zip(orig_cols, new_other_cols) if old in orig_types},
    }
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
        # Same positional rename handling as Horizontal Stack's own -- see
        # its comment for why a name-keyed merge would lose a renamed
        # column here.
        new_cols = _make_unique_column_names(list(result.columns))
        merged_types: dict[str, str] = {}
        i = 0
        for src in (left, right):
            types = src.attrs.get("column_types") or {}
            for col in src.columns:
                if col in types:
                    merged_types[new_cols[i]] = types[col]
                i += 1
        result.columns = new_cols
        result.attrs["column_types"] = merged_types
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
    # pandas.merge's own column-survival rules (a shared join-key name
    # collapses to one column; any OTHER name collision gets the "_extra"
    # suffix on the right side, per suffixes= above) are well-documented
    # enough to reverse: a pre-rename name matching a left column is
    # left's; one ending "_extra" maps back to its right-side name minus
    # the suffix; anything else matches a right column directly (a
    # right_on column with no name collision on the left, so it passed
    # through unsuffixed).
    pre_rename_cols = list(result.columns)
    new_cols = _make_unique_column_names(pre_rename_cols)
    left_types = left.attrs.get("column_types") or {}
    right_types = right.attrs.get("column_types") or {}
    merged_types: dict[str, str] = {}
    for old, new in zip(pre_rename_cols, new_cols):
        if old in left_types:
            merged_types[new] = left_types[old]
        elif old.endswith("_extra") and old[:-len("_extra")] in right_types:
            merged_types[new] = right_types[old[:-len("_extra")]]
        elif old in right_types:
            merged_types[new] = right_types[old]
    result.columns = new_cols
    result.attrs["column_types"] = merged_types
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
    # Column names are untouched and every surviving cell is a real value
    # that already lived somewhere else in the same column -- shifting
    # WHERE a number sits doesn't change that it's still a number.
    result.attrs["column_types"] = df.attrs.get("column_types") or {}
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
    touched: set[str] = set()
    for op in operations:
        columns = op.get("columns") or []
        operation = op.get("operation")
        op_params = op.get("params") or {}
        for column in columns:
            if column not in result.columns:
                warnings.append(f"Cleaning operation skipped: column '{column}' not found.")
                continue
            result[column] = _apply_cleaning_operation(result[column], operation, op_params)
            touched.add(column)
    # Only columns NO operation ever actually touched can still trust
    # their inherited type -- an untouched "Amount" column is still
    # whatever it was; one that had UPPERCASE or Remove Digits run on it
    # is not something this node can vouch for anymore.
    orig_types = df.attrs.get("column_types") or {}
    result.attrs["column_types"] = {k: v for k, v in orig_types.items() if k not in touched}
    return result, warnings, []


# ── Text Parser ──────────────────────────────────────────────────────────
# Power Query's own no-code text-extraction toolset (Transform > Extract,
# and Split Column by Delimiter) -- an alternative to the Regular
# Expressions node for the common cases that don't need a real pattern.
# Same ordered-operations-list shape as Cleaner's clean_columns above, but
# each operation ADDS new column(s) computed from one source column
# rather than mutating it in place.
def _resolve_occurrence(occurrence: str, count: int) -> "int | None":
    # "first"/"last"/a 1-based number string -> a 0-based index into
    # `count` matches, or None if that occurrence doesn't exist (e.g.
    # "3rd" asked for on a value with only 1 delimiter). Matches how a
    # non-programmer would actually describe it ("the 2nd comma"), not a
    # raw 0-based index.
    if not occurrence or occurrence == "first":
        idx = 0
    elif occurrence == "last":
        idx = count - 1
    else:
        try:
            idx = int(occurrence) - 1
        except (TypeError, ValueError):
            idx = 0
    return idx if 0 <= idx < count else None


def _text_before(s: str, delimiter: str, occurrence: str) -> str:
    if not delimiter:
        return s
    parts = s.split(delimiter)
    if len(parts) < 2:
        return ""
    idx = _resolve_occurrence(occurrence, len(parts) - 1)
    return delimiter.join(parts[: idx + 1]) if idx is not None else ""


def _text_after(s: str, delimiter: str, occurrence: str) -> str:
    if not delimiter:
        return s
    parts = s.split(delimiter)
    if len(parts) < 2:
        return ""
    idx = _resolve_occurrence(occurrence, len(parts) - 1)
    return delimiter.join(parts[idx + 1 :]) if idx is not None else ""


def _text_between(s: str, start_delim: str, end_delim: str, start_occ: str, end_occ: str) -> str:
    middle = _text_after(s, start_delim, start_occ) if start_delim else s
    return _text_before(middle, end_delim, end_occ) if end_delim else middle


def _split_values(s: str, delimiter: str, split_at: str) -> list[str]:
    if not delimiter:
        return [s]
    if split_at == "left":
        return s.split(delimiter, 1)  # only the FIRST occurrence -- 2 parts max
    if split_at == "right":
        return s.rsplit(delimiter, 1)  # only the LAST occurrence -- 2 parts max
    return s.split(delimiter)  # "each" -- every occurrence


def parse_text(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Text Parser needs a connected input table.")
    df = dfs[0]
    operations = params.get("operations") or []
    if not operations:
        return df, [], []  # nothing configured yet -- pass through unchanged

    result = df.copy()
    warnings: list[str] = []
    existing_names = list(result.columns)

    for op in operations:
        column = op.get("column")
        operation = op.get("operation")
        op_params = op.get("params") or {}
        base_name = (op.get("newColumnName") or "Extracted").strip() or "Extracted"
        if column not in result.columns:
            warnings.append(f"Text parsing operation skipped: column '{column}' not found.")
            continue
        source = result[column].astype(str)

        if operation == "text_before":
            values_by_col = [[_text_before(s, op_params.get("delimiter", ""), op_params.get("occurrence", "first")) for s in source]]
            new_names = [base_name]
        elif operation == "text_after":
            values_by_col = [[_text_after(s, op_params.get("delimiter", ""), op_params.get("occurrence", "first")) for s in source]]
            new_names = [base_name]
        elif operation == "text_between":
            values_by_col = [[
                _text_between(
                    s, op_params.get("startDelimiter", ""), op_params.get("endDelimiter", ""),
                    op_params.get("startOccurrence", "first"), op_params.get("endOccurrence", "first"),
                )
                for s in source
            ]]
            new_names = [base_name]
        elif operation == "first_chars":
            try:
                count = max(0, int(op_params.get("count", 0)))
            except (TypeError, ValueError):
                count = 0
            values_by_col = [[s[:count] for s in source]]
            new_names = [base_name]
        elif operation == "last_chars":
            try:
                count = max(0, int(op_params.get("count", 0)))
            except (TypeError, ValueError):
                count = 0
            values_by_col = [[(s[-count:] if count > 0 else "") for s in source]]
            new_names = [base_name]
        elif operation == "range":
            try:
                start = max(0, int(op_params.get("start", 0)))
            except (TypeError, ValueError):
                start = 0
            try:
                length = max(0, int(op_params.get("length", 0)))
            except (TypeError, ValueError):
                length = 0
            values_by_col = [[s[start : start + length] for s in source]]
            new_names = [base_name]
        elif operation == "split_delimiter":
            delimiter = op_params.get("delimiter", "")
            split_at = op_params.get("splitAt", "each")
            split_rows = [_split_values(s, delimiter, split_at) for s in source]
            max_parts = max((len(r) for r in split_rows), default=1)
            new_names = [base_name] if max_parts <= 1 else [f"{base_name}_{i + 1}" for i in range(max_parts)]
            values_by_col = [[r[i] if i < len(r) else "" for r in split_rows] for i in range(max_parts)]
        else:
            raise ValueError(f"Unknown text parsing operation: {operation}")

        unique_new_names = _make_unique_column_names(existing_names + new_names)[len(existing_names):]
        for name, values in zip(unique_new_names, values_by_col):
            result[name] = values
        existing_names = existing_names + unique_new_names

    # Every existing column keeps its exact name and value -- only the
    # new extracted/split columns (untyped; they're freshly derived text)
    # get added.
    result.attrs["column_types"] = df.attrs.get("column_types") or {}
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
    result.attrs["column_types"] = df.attrs.get("column_types") or {}
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
    fields_used: list[str] = []
    for entry in columns:
        field = entry.get("field")
        if field not in df.columns:
            warnings.append(f"Column '{field}' not found -- skipped.")
            continue
        names.append(str(entry.get("name") or field))
        series_list.append(df[field].tolist())
        fields_used.append(field)

    if not names:
        return df, warnings, []  # every referenced column was missing -- pass through

    unique_names = _make_unique_column_names(names)
    result = pd.DataFrame({unique_names[i]: series_list[i] for i in range(len(unique_names))})
    orig_types = df.attrs.get("column_types") or {}
    result.attrs["column_types"] = {
        unique_names[i]: orig_types[fields_used[i]] for i in range(len(unique_names)) if fields_used[i] in orig_types
    }
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
    # Inherited types for whatever this run DIDN'T touch (a column not
    # listed in `fields` at all, or listed as "text" -- to_text's own
    # entries below still overwrite it, since re-running as Text is a
    # deliberate reset) come first so this node's own freshly-applied
    # conversions always win on conflict.
    result.attrs["column_types"] = {
        **(df.attrs.get("column_types") or {}),
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
    # Every original column keeps its exact name and value -- only brand-
    # new derived columns (untyped, since they're freshly computed text)
    # get added alongside them.
    result.attrs["column_types"] = df.attrs.get("column_types") or {}
    return result, [], []


# ── Cascade Fill ─────────────────────────────────────────────────────────
# Ported from OWCascadeFill (devkit/orangecontrib/custom/widgets/
# cascade_fill.py) -- fill up/down to propagate a column's last-seen value
# into empty cells below/above it. The original's own dtype branching
# (`if result[col].dtype == object: ...`) doesn't apply here: every column
# in this app's wire format is already string/object dtype (see
# routers/nodes.py's own fillna("").astype(str)), so this always treats a
# column's null markers as replaceable and always re-fills any leftover
# NaN (leading/trailing cells with nothing to propagate from) with "" at
# the end, unconditionally.
def cascade_fill(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Cascade Fill needs a connected input table.")
    df = dfs[0]
    columns = [c for c in (params.get("columns") or []) if c in df.columns]
    if not columns:
        return df, [], []  # nothing selected yet -- pass through unchanged

    direction = params.get("direction", "down")
    custom_nulls = params.get("customNulls") or []

    result = df.copy()
    for col in columns:
        result[col] = result[col].replace({"": np.nan, "?": np.nan})
        if custom_nulls:
            result[col] = result[col].replace(custom_nulls, np.nan)
        result[col] = result[col].ffill() if direction == "down" else result[col].bfill()
        result[col] = result[col].fillna("")
    # Filled cells copy an existing real value from elsewhere in the SAME
    # column, and untouched columns are untouched -- nothing here recomputes
    # a value into a different shape, so every column's type still holds.
    result.attrs["column_types"] = df.attrs.get("column_types") or {}
    return result, [], []


# ── Add Column ───────────────────────────────────────────────────────────
# Power Query's own "Add Custom Column": one new column computed from a
# formula referencing other columns as [Column Name] (PQ's own bracket
# syntax), one row at a time. Deliberately NOT a raw eval() of the user's
# formula -- this parses it into a real Python AST (ast.parse) and only
# ever walks/executes a small allow-listed subset of node types below,
# rejecting everything else (imports, attribute access, arbitrary function
# calls, ...) before a single row is touched. A local desktop app talking
# only to itself lowers the stakes of a raw eval() here, but a formula box
# a user pastes text into is still exactly the shape of input that
# shouldn't get a blank check to run arbitrary code.
class _FormulaError(ValueError):
    pass


_ALLOWED_BINOPS: dict[type, Callable[[Any, Any], Any]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_ALLOWED_UNARYOPS: dict[type, Callable[[Any], Any]] = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}
_ALLOWED_CMPOPS: dict[type, Callable[[Any, Any], bool]] = {
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
}


def _formula_to_number(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        raise _FormulaError(f'"{v}" isn\'t a number.')


# PQ's own function names, uppercased to match its convention -- a small,
# deliberately unsurprising set (string case/trim/length/slicing, string
# joining, rounding, absolute value), not an attempt to cover everything
# PQ's own M language offers.
_FORMULA_FUNCTIONS: dict[str, Callable[..., Any]] = {
    "UPPER": lambda s: str(s).upper(),
    "LOWER": lambda s: str(s).lower(),
    "TRIM": lambda s: str(s).strip(),
    "LEN": lambda s: len(str(s)),
    "CONCAT": lambda *args: "".join(str(a) for a in args),
    "ROUND": lambda n, d=0: round(_formula_to_number(n), int(d)),
    "LEFT": lambda s, n: str(s)[: int(n)],
    "RIGHT": lambda s, n: str(s)[-int(n):] if int(n) > 0 else "",
    "ABS": lambda n: abs(_formula_to_number(n)),
    "CONTAINS": lambda s, sub: str(sub) in str(s),
    "AND": lambda *args: _formula_bool_all(args, ok=all),
    "OR": lambda *args: _formula_bool_all(args, ok=any),
    "NOT": lambda a: _formula_not(a),
}


def _formula_bool_all(args: tuple, ok: Callable[[tuple], bool]) -> bool:
    for a in args:
        if not isinstance(a, bool):
            raise _FormulaError("AND/OR's arguments must be comparisons, like [A] = [B] or [A] > 10.")
    return ok(args)


def _formula_not(a: Any) -> bool:
    if not isinstance(a, bool):
        raise _FormulaError("NOT's argument must be a comparison, like [A] = [B] or CONTAINS([A], \"x\").")
    return not a


def _eval_formula_node(node: ast.AST, row_values: dict[str, Any]) -> Any:
    if isinstance(node, ast.Expression):
        return _eval_formula_node(node.body, row_values)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float, str)):
            return node.value
        raise _FormulaError("Unsupported value in formula.")
    if isinstance(node, ast.Name):
        if node.id in row_values:
            return row_values[node.id]
        raise _FormulaError(f"Unknown reference in formula: {node.id}")
    if isinstance(node, ast.BinOp) and type(node.op) in _ALLOWED_BINOPS:
        left = _eval_formula_node(node.left, row_values)
        right = _eval_formula_node(node.right, row_values)
        # `+` between two strings (or a string and anything else) means
        # concatenation, same as PQ's own `&` -- this app's [Column]
        # syntax is friendlier without also requiring a second operator
        # just for text.
        if isinstance(node.op, ast.Add) and (isinstance(left, str) or isinstance(right, str)):
            return str(left) + str(right)
        return _ALLOWED_BINOPS[type(node.op)](_formula_to_number(left), _formula_to_number(right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _ALLOWED_UNARYOPS:
        return _ALLOWED_UNARYOPS[type(node.op)](_formula_to_number(_eval_formula_node(node.operand, row_values)))
    if isinstance(node, ast.Compare):
        # Power Query's own `=`/`<>` equality operators are rewritten to
        # `==`/`!=` in _parse_formula before this ever runs (Python's own
        # `=` can't appear in an expression at all). Chained comparisons
        # (`1 < [x] < 10`) work the same way Python evaluates them.
        left = _eval_formula_node(node.left, row_values)
        for op, comparator in zip(node.ops, node.comparators):
            if type(op) not in _ALLOWED_CMPOPS:
                raise _FormulaError("Unsupported comparison operator.")
            right = _eval_formula_node(comparator, row_values)
            try:
                ok = _ALLOWED_CMPOPS[type(op)](left, right)
            except TypeError:
                raise _FormulaError(f'Can\'t compare "{left}" and "{right}".')
            if not ok:
                return False
            left = right
        return True
    if isinstance(node, ast.Call):
        func_name = node.func.id if isinstance(node.func, ast.Name) else None
        if func_name == "IF":
            # Handled here rather than as a plain _FORMULA_FUNCTIONS entry
            # so it can be LAZY -- only the branch actually taken gets
            # evaluated. That's not just an optimization: it's what makes
            # the classic spreadsheet pattern IF([x] <> 0, [y] / [x], 0)
            # safe, the same way it is in Excel. Eagerly evaluating both
            # branches (like every other function here) would run the
            # division on every row, including the [x] = 0 ones the IF is
            # there to guard against.
            if len(node.args) != 3 or node.keywords:
                raise _FormulaError("IF needs 3 arguments: IF(condition, value if true, value if false).")
            condition = _eval_formula_node(node.args[0], row_values)
            if not isinstance(condition, bool):
                raise _FormulaError("IF's first argument must be a comparison, like [A] = [B] or [A] > 10.")
            return _eval_formula_node(node.args[1] if condition else node.args[2], row_values)
        if not func_name or func_name not in _FORMULA_FUNCTIONS or node.keywords:
            raise _FormulaError(f"Unknown function: {func_name or '?'}")
        args = [_eval_formula_node(a, row_values) for a in node.args]
        return _FORMULA_FUNCTIONS[func_name](*args)
    raise _FormulaError("Unsupported formula syntax.")


_COLUMN_REF_RE = re.compile(r"\[([^\]]+)\]")


def _parse_formula(formula: str, columns: list[str]) -> tuple[ast.Expression, dict[str, str]]:
    # Rewrites each [Column Name] reference into a safe Python identifier
    # (ast.parse can't handle spaces/punctuation in names, which real
    # extracted column names are full of) before parsing -- ref_map is
    # handed to _eval_formula_node per row to resolve those back to real
    # column values. The same [Column Name] reused twice in one formula
    # reuses the same identifier rather than minting a new one each time.
    ref_map: dict[str, str] = {}
    id_by_column: dict[str, str] = {}

    def _replace(m: re.Match) -> str:
        col = m.group(1)
        if col not in columns:
            raise _FormulaError(f'Column "{col}" not found.')
        if col in id_by_column:
            return id_by_column[col]
        sid = f"__col{len(ref_map)}"
        ref_map[sid] = col
        id_by_column[col] = sid
        return sid

    rewritten = _COLUMN_REF_RE.sub(_replace, formula)
    # Power Query's own equality/inequality operators (`=`, `<>`) rather
    # than Python's (`==`, `!=`) -- this is Power Query's own "Add Custom
    # Column" in spirit, so `[a] = [b]` should work the way a PQ user
    # already expects, not require them to know Python's `==`. Bare `=`
    # only (the lookaround leaves `==`, `!=`, `<=`, `>=` alone).
    rewritten = rewritten.replace("<>", "!=")
    rewritten = re.sub(r"(?<![=!<>])=(?!=)", "==", rewritten)
    try:
        tree = ast.parse(rewritten, mode="eval")
    except SyntaxError as e:
        raise _FormulaError(f"Invalid formula: {e.msg}")
    return tree, ref_map


def add_column(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Add Column needs a connected input table.")
    df = dfs[0]
    new_column_name = (params.get("columnName") or "").strip()
    formula = (params.get("formula") or "").strip()
    if not new_column_name:
        raise ValueError("Give the new column a name.")
    if not formula:
        raise ValueError("Enter a formula for the new column.")

    try:
        tree, ref_map = _parse_formula(formula, list(df.columns))
        values = []
        for _, row in df.iterrows():
            row_values = {sid: row[col] for sid, col in ref_map.items()}
            values.append(_eval_formula_node(tree, row_values))
    except _FormulaError as e:
        raise ValueError(str(e))

    final_name = new_column_name
    n = 0
    while final_name in df.columns:
        n += 1
        final_name = f"{new_column_name}_{n}"

    result = df.copy()
    result[final_name] = [str(v) for v in values]
    # Every existing column keeps its exact name and value -- only the new
    # computed column (untyped; it's a fresh formula result, not something
    # to guess a type for) gets added.
    result.attrs["column_types"] = df.attrs.get("column_types") or {}
    return result, [], []


# ── Add Column (conditional) ─────────────────────────────────────────────
# Power Query's own "Add Conditional Column" -- the low-code sibling of
# Add Custom Column (the formula-based `add_column` above, now surfaced to
# the user as "Formula"): an ORDERED list of clauses, each a Filter
# Builder-style condition group (same AND/OR group model, same
# _apply_condition this module's own Filter Builder already uses) paired
# with an output value, evaluated top-to-bottom with the first matching
# clause winning (a row already claimed by an earlier clause is never
# reconsidered by a later one, same "first match wins" semantics PQ's own
# conditional column has) -- with a required Else value for whatever
# matches no clause at all.
def _resolve_output_values(value_str: str, df: pd.DataFrame, mask: "pd.Series[bool]") -> pd.Series:
    """Evaluates a clause's "Then set to"/"Otherwise" text as a formula --
    the SAME engine (and [Column] bracket syntax, operators, IF/AND/OR/
    CONTAINS/...) the Formula node's own add_column uses -- against every
    row `mask` selects, so the output can be a plain value, a column
    reference like [Amount], or an expression like [A] + [B]. Plain
    literal text (e.g. "High") is never valid formula syntax on its own
    (a bare, un-bracketed word isn't a recognized reference), so it falls
    straight through to being used as a literal for every row -- meaning
    a user who just wants to type an output value never needs to think
    about this at all, and only someone reaching for a column ref or an
    expression needs the [Column] syntax.
    """
    if not mask.any():
        return pd.Series([], index=df.index[mask], dtype=object)
    try:
        tree, ref_map = _parse_formula(value_str, list(df.columns))
    except _FormulaError:
        return pd.Series([value_str] * int(mask.sum()), index=df.index[mask])
    values = []
    for idx in df.index[mask]:
        row = df.loc[idx]
        row_values = {sid: row[col] for sid, col in ref_map.items()}
        try:
            values.append(_eval_formula_node(tree, row_values))
        except _FormulaError:
            values.append(value_str)
    return pd.Series(values, index=df.index[mask])


def conditional_column(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Add Column needs a connected input table.")
    df = dfs[0]
    new_column_name = (params.get("columnName") or "").strip()
    clauses = params.get("clauses") or []
    else_value = params.get("elseValue", "")
    if not new_column_name:
        raise ValueError("Give the new column a name.")
    if not clauses:
        raise ValueError("Add at least one condition.")

    warnings: list[str] = []
    values = pd.Series([None] * len(df), index=df.index, dtype=object)
    assigned = pd.Series(False, index=df.index)
    for clause in clauses:
        group = clause.get("group") or {}
        conditions = group.get("conditions") or []
        masks = [m for c in conditions if (m := _apply_condition(df, c, warnings)) is not None]
        if not masks:
            continue
        combine = np.logical_and.reduce if group.get("match", "all") == "all" else np.logical_or.reduce
        clause_mask = pd.Series(combine(masks), index=df.index) & ~assigned
        values.loc[clause_mask] = _resolve_output_values(clause.get("outputValue", ""), df, clause_mask)
        assigned = assigned | clause_mask
    else_mask = ~assigned
    values.loc[else_mask] = _resolve_output_values(else_value, df, else_mask)

    final_name = new_column_name
    n = 0
    while final_name in df.columns:
        n += 1
        final_name = f"{new_column_name}_{n}"

    result = df.copy()
    result[final_name] = values.astype(str)
    result.attrs["column_types"] = df.attrs.get("column_types") or {}
    return result, warnings, []


# ── Unpivot Columns ──────────────────────────────────────────────────────
# Power Query's own "Unpivot Columns" command: the selected columns become
# two new columns (an attribute-name column and a value column), one output
# row per original row x selected column -- every OTHER column stays as an
# identifier, repeated across each of its original row's new unpivoted
# rows. Selecting the columns to CONVERT (not the ones to keep) matches PQ's
# literal "Unpivot Columns" menu item, as opposed to its separate "Unpivot
# Other Columns" command.
def unpivot_columns(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Unpivot Columns needs a connected input table.")
    df = dfs[0]
    columns = [c for c in (params.get("columns") or []) if c in df.columns]
    if not columns:
        return df, [], []  # nothing selected yet -- pass through unchanged

    id_columns = [c for c in df.columns if c not in columns]

    # "Attribute"/"Value" are PQ's own default names for these two new
    # columns -- bumped with a numeric suffix only if the SOURCE table
    # already has an identifier column literally named that (renaming the
    # user's own column to make room would be far more surprising than a
    # slightly different name for the new one).
    existing = set(id_columns)
    def _pick_name(base: str) -> str:
        name = base
        n = 0
        while name in existing:
            n += 1
            name = f"{base}_{n}"
        return name
    attr_name = _pick_name("Attribute")
    existing.add(attr_name)
    value_name = _pick_name("Value")

    result = df.melt(id_vars=id_columns, value_vars=columns, var_name=attr_name, value_name=value_name)
    return result, [], []


# ── Pivot Columns ────────────────────────────────────────────────────────
# The reverse of Unpivot Columns above (Power Query's own separate "Pivot
# Column" command): pick a LABELS column (its own unique values become new
# column headers) and a VALUES column (what lands under them). Every OTHER
# column is an identifier -- rows sharing the same identifier(s) combine
# into one output row, with each one's chosen label/value pair landing in
# the matching new column.
#
# With NO other columns at all (this app's most common case in practice:
# reconstructing an Unpivot Columns output back into its original wide
# shape), there's no real identifier to group by -- rows are matched up
# purely by POSITION instead, via each label's own running occurrence
# count (groupby(...).cumcount()): the label sequence "amount, tax, net,
# amount, tax, net, ..." naturally becomes one output row per full cycle
# through the labels, values landing in the SAME order they appeared in
# the source, not re-sorted. When identifier columns DO exist, the exact
# same cumcount mechanism still applies (grouped by identifier+label this
# time) -- it just always comes out as 0 there, since a real identifier
# already makes each identifier+label combination naturally occur once.
def pivot_columns(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Pivot Columns needs a connected input table.")
    df = dfs[0]
    label_col = params.get("labelColumn")
    value_col = params.get("valueColumn")
    if not label_col or not value_col:
        return df, [], []  # nothing selected yet -- pass through unchanged
    if label_col not in df.columns or value_col not in df.columns:
        raise ValueError("The selected columns aren't in the connected table.")
    if label_col == value_col:
        raise ValueError("Pick two different columns for labels and values.")

    id_columns = [c for c in df.columns if c not in (label_col, value_col)]
    work = df.copy()
    group_keys = [*id_columns, label_col]
    work["__seq"] = work.groupby(group_keys).cumcount()

    index_cols = [*id_columns, "__seq"]
    pivoted = work.pivot(index=index_cols, columns=label_col, values=value_col)
    pivoted = pivoted.reset_index()
    pivoted.columns.name = None

    # pivot()'s own columns come back alphabetically sorted -- reordered to
    # the label column's own first-appearance order instead, so "amount,
    # tax, net" (the order they actually showed up in) doesn't silently
    # become "amount, net, tax". Also drops the purely-technical __seq
    # column here (by simply never including it), and index_cols'
    # ordering above already makes __seq the LAST sort key, so a real
    # identifier's own row order is preserved wherever ties exist.
    label_order = list(dict.fromkeys(df[label_col].astype(str)))
    ordered_cols = [*id_columns, *[c for c in label_order if c in pivoted.columns]]
    pivoted = pivoted[ordered_cols]
    pivoted.columns = _make_unique_column_names([str(c) for c in pivoted.columns])
    return pivoted, [], []


# ── Export ────────────────────────────────────────────────────────────────
# The one sink node (nodeCatalog.ts's hasOutput: false) -- writes real
# file(s) to disk on Run instead of producing a table for a downstream node
# (the empty DataFrame returned below is just this shared pipeline's own
# "no real output" value; routers/nodes.py's fillna/astype on it is a
# harmless no-op). Runs directly against this machine's filesystem: this is
# a desktop app, the backend and the Electron frontend it serves are always
# the same machine, so `outputPath` (chosen via a native dialog on the
# frontend, see electron/main.ts's export:chooseFile/chooseFolder) is
# already a real, directly-writable local path -- no upload/download step.
_INVALID_EXPORT_NAME_CHARS = re.compile(r'[\[\]:*?/\\]')


def _safe_export_name(raw: str, index: int, max_length: int | None) -> str:
    name = _INVALID_EXPORT_NAME_CHARS.sub("_", (raw or "").strip()) or f"Table_{index + 1}"
    return name[:max_length] if max_length else name


def export_data(dfs: list[pd.DataFrame], params: dict[str, Any]) -> tuple[pd.DataFrame, list[str], list[str]]:
    if not dfs:
        raise ValueError("Export needs at least one connected table.")
    output_path = (params.get("outputPath") or "").strip()
    if not output_path:
        raise ValueError("Choose an export location first.")
    fmt = params.get("format", "xlsx")

    raw_names = [df.attrs.get("name") or f"Table_{i + 1}" for i, df in enumerate(dfs)]
    # Excel sheet names can't contain [ ] : * ? / \ and are capped at 31
    # characters -- truncated to 28 here (not csv, which has no such cap)
    # so a _make_unique_column_names dedup suffix (_1, _2, ...) still fits
    # within that cap for any realistic table count.
    max_len = 28 if fmt == "xlsx" else None
    sanitized = [_safe_export_name(n, i, max_len) for i, n in enumerate(raw_names)]
    names = _make_unique_column_names(sanitized)

    info: list[str] = []
    try:
        if fmt == "csv":
            # A CSV can only ever hold one table -- one file per connected
            # table into the chosen folder, named after each table.
            folder = Path(output_path)
            for df, name in zip(dfs, names):
                df.to_csv(folder / f"{name}.csv", index=False)
            info.append(f"Exported {len(dfs)} file(s) to {output_path}")
        else:
            # Excel can hold all of them -- each connected table becomes
            # its own sheet in one workbook.
            with pd.ExcelWriter(output_path, engine="openpyxl") as writer:
                for df, name in zip(dfs, names):
                    df.to_excel(writer, sheet_name=name, index=False)
            info.append(f"Exported {len(dfs)} table(s) to {output_path}")
    except PermissionError:
        # The single most common reason a real file can't be overwritten:
        # it's currently open in Excel (or another program) holding an
        # exclusive lock -- there's no way to force that write through, so
        # this turns the OS's own cryptic [Errno 13] message into the
        # actual actionable instruction (this matters more here than for
        # any other node's transform: Export is the only one Autosave can
        # trigger unattended on every upstream data change, so this is the
        # error a user is most likely to see with no one having just
        # clicked Run themselves to explain the context).
        raise ValueError(f"Couldn't overwrite {output_path} -- close it if it's currently open, then try again.")

    return pd.DataFrame(), [], info


NODE_TRANSFORMS: dict[str, Callable[[list[pd.DataFrame], dict[str, Any]], tuple[pd.DataFrame, list[str], list[str]]]] = {
    "horizontal_stack": horizontal_stack,
    "filter_builder": filter_builder,
    "header_promoter": promote_row_to_header,
    "index_column": add_index_column,
    "merge_data": merge_data,
    "shift_columns": shift_columns,
    "clean_columns": clean_columns,
    "parse_text": parse_text,
    "deduplicate_rows": deduplicate_rows,
    "column_edit": column_edit,
    "change_type": change_type,
    "cascade_fill": cascade_fill,
    "extract_regex": extract_regex,
    "export_data": export_data,
    "unpivot_columns": unpivot_columns,
    "pivot_columns": pivot_columns,
    "add_column": add_column,
    "conditional_column": conditional_column,
    "concatenate": concatenate,
    "bridge": bridge,
    "file_input": file_input,
    "sort_rows": sort_rows,
    "aggregate_columns": aggregate_columns,
}
