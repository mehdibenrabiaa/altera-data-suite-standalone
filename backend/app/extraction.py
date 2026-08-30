"""PDF table extraction, ported from orangecontrib/custom/widgets/auxiliary_functions.py.

Only the pure, Orange-independent functions are kept -- the original file's
_f2()/dataframe_to_orange_table_basic() etc. convert a DataFrame into an
Orange Table, which this standalone app has no use for (there's no Orange
Output socket here, just JSON back to the frontend). License gating
(verify_license/check_license) is also not carried over -- this is an early
prototype with no license-server integration yet.
"""

import json

import camelot
import fitz
import pandas as pd
from pypdfium2 import PdfDocument

_CM = {"rgb(49, 122, 185)": "Blue", "rgb(239, 68, 68)": "Red", "rgb(34, 197, 94)": "Green", "rgb(168, 85, 247)": "Purple", "rgb(249, 115, 22)": "Orange"}


def make_unique_column_names(columns) -> list:
    seen = {}
    unique = []
    for col in columns:
        name = str(col)
        if name not in seen:
            seen[name] = 0
            unique.append(name)
        else:
            seen[name] += 1
            unique.append(f"{name}_{seen[name]}")
    return unique


def _h2_fitz(file_path, page_num, table_area_coords, column_coords):
    """PyMuPDF text extraction that handles any page rotation (0/90/180/270).

    table_area_coords: [x0, cy0, x1, cy1] in Camelot/visual y-up space.
    column_coords: guide x-positions in visual x space.
    Returns pd.DataFrame or None.
    """
    doc = fitz.open(file_path)
    page = doc[page_num - 1]
    rot = page.rotation
    mw = page.mediabox.width
    mh = page.mediabox.height

    x0, cy0, x1, cy1 = [float(c) for c in table_area_coords]
    col_xs = sorted(float(c) for c in column_coords) if column_coords else []
    nc = len(col_xs) + 1
    bounds_v = [x0] + col_xs + [x1]

    if rot == 90:
        clip = fitz.Rect(mw - cy1, mh - x1, mw - cy0, mh - x0)
    elif rot == 270:
        clip = fitz.Rect(cy0, x0, cy1, x1)
    elif rot == 180:
        clip = fitz.Rect(mw - x1, cy0, mw - x0, cy1)
    else:
        clip = fitz.Rect(x0, mh - cy1, x1, mh - cy0)

    words = page.get_text("words", clip=clip)
    doc.close()
    if not words:
        return None

    if rot in (90, 270):
        avg_span = sum(w[2] - w[0] for w in words) / len(words)
        threshold = avg_span * 0.6

        if rot == 90:
            sw = sorted(words, key=lambda w: ((w[0] + w[2]) / 2, -((w[1] + w[3]) / 2)))

            def _row_key(w):
                return (w[0] + w[2]) / 2

            def _col_key(w):
                return -((w[1] + w[3]) / 2)

            def _word_vx(w):
                return mh - (w[1] + w[3]) / 2
        else:
            sw = sorted(words, key=lambda w: ((w[0] + w[2]) / 2, (w[1] + w[3]) / 2))

            def _row_key(w):
                return (w[0] + w[2]) / 2

            def _col_key(w):
                return (w[1] + w[3]) / 2

            def _word_vx(w):
                return (w[1] + w[3]) / 2

        rows = []
        cur = [sw[0]]
        anchor = _row_key(sw[0])
        for w in sw[1:]:
            rk = _row_key(w)
            if abs(rk - anchor) <= threshold:
                cur.append(w)
            else:
                rows.append(sorted(cur, key=_col_key))
                cur, anchor = [w], rk
        rows.append(sorted(cur, key=_col_key))

        def _ci(w):
            vx = _word_vx(w)
            for i in range(len(bounds_v) - 1):
                if vx < bounds_v[i + 1]:
                    return i
            return nc - 1

    elif rot == 180:
        avg_span = sum(w[3] - w[1] for w in words) / len(words)
        threshold = avg_span * 0.6

        sw = sorted(words, key=lambda w: (-((w[1] + w[3]) / 2), (w[0] + w[2]) / 2))

        rows = []
        cur = [sw[0]]
        anchor = (sw[0][1] + sw[0][3]) / 2
        for w in sw[1:]:
            yc = (w[1] + w[3]) / 2
            if abs(yc - anchor) <= threshold:
                cur.append(w)
            else:
                rows.append(sorted(cur, key=lambda ww: -((ww[0] + ww[2]) / 2)))
                cur, anchor = [w], yc
        rows.append(sorted(cur, key=lambda ww: -((ww[0] + ww[2]) / 2)))

        def _ci(w):
            vx = mw - (w[0] + w[2]) / 2
            for i in range(len(bounds_v) - 1):
                if vx < bounds_v[i + 1]:
                    return i
            return nc - 1

    else:
        avg_span = sum(w[3] - w[1] for w in words) / len(words)
        threshold = avg_span * 0.6

        sw = sorted(words, key=lambda w: ((w[1] + w[3]) / 2, w[0]))

        rows = []
        cur = [sw[0]]
        anchor = (sw[0][1] + sw[0][3]) / 2
        for w in sw[1:]:
            yc = (w[1] + w[3]) / 2
            if abs(yc - anchor) <= threshold:
                cur.append(w)
            else:
                rows.append(sorted(cur, key=lambda ww: ww[0]))
                cur, anchor = [w], yc
        rows.append(sorted(cur, key=lambda ww: ww[0]))

        def _ci(w):
            vx = (w[0] + w[2]) / 2
            for i in range(len(bounds_v) - 1):
                if vx < bounds_v[i + 1]:
                    return i
            return nc - 1

    data = []
    for rw in rows:
        cells = [""] * nc
        for w in rw:
            idx = _ci(w)
            cells[idx] = (cells[idx] + " " + w[4]).strip()
        data.append(cells)
    return pd.DataFrame(data, columns=[f"Column_{i+1}" for i in range(nc)])


def _h2(file_path, page_num, tables_info, dpi, occurrence_order=False):
    if occurrence_order:
        def _yk(info):
            by_page = info.get("table_area_by_page")
            coords = by_page.get(str(page_num)) if by_page else info.get("table_area")
            return -coords[3] if coords and len(coords) == 4 else float("inf")
        tables_info = sorted(tables_info, key=_yk)
    page_dataframes = []
    for i, info in enumerate(tables_info):
        by_page = info.get("table_area_by_page")
        cols_by_page = info.get("columns_by_page", {})
        if by_page:
            table_area_coords = by_page.get(str(page_num))
            if not table_area_coords:
                continue
            column_coords = cols_by_page.get(str(page_num), info.get("columns", []))
        else:
            table_area_coords = info.get("table_area")
            column_coords = info.get("columns", [])
        if not table_area_coords or len(table_area_coords) != 4:
            continue
        table_label = info.get("name", "").strip()
        auto_detect = info.get("autoDetectColumns", True)
        if not auto_detect:
            df = _h2_fitz(file_path, page_num, table_area_coords, column_coords)
            if df is not None:
                if table_label:
                    df["Table Name"] = table_label
                df["Page"] = page_num
                page_dataframes.append(df)
        else:
            table_area = [",".join(map(str, table_area_coords))]
            columns = [",".join(column_coords)] if column_coords else None
            try:
                tables = camelot.read_pdf(file_path, flavor="stream", pages=str(page_num), table_areas=table_area, columns=columns, split_text=True)
                for table in tables:
                    df = table.df.copy()
                    df.columns = [f"Column_{i+1}" for i in range(len(df.columns))]
                    if table_label:
                        df["Table Name"] = table_label
                    df["Page"] = page_num
                    page_dataframes.append(df)
            except Exception:
                pass
    return page_dataframes


def _resolve_pages(total_pages, sample_mode=None):
    if not sample_mode:
        return list(range(1, total_pages + 1))
    _mode = sample_mode.get("mode", "range")
    if _mode == "range":
        _s = max(1, sample_mode.get("startPage", 1))
        _e = min(total_pages, sample_mode.get("endPage", total_pages))
        return list(range(_s, _e + 1))
    if _mode == "first_n":
        _n = min(total_pages, max(1, sample_mode.get("firstN", total_pages)))
        return list(range(1, _n + 1))
    return list(range(1, total_pages + 1))


def _reorder_trailing_columns(df):
    _trailing = (["Table Name"] if "Table Name" in df.columns else []) + ["Page"]
    cols = [c for c in df.columns if c not in _trailing]
    return df[cols + _trailing]


def extract_merged(file_path, tables_info, total_pages, dpi, progress_callback=None, sample_mode=None, occurrence_order=False):
    """Schema-preview extraction: every drawn table merged into one frame."""
    pages = _resolve_pages(total_pages, sample_mode)
    all_dataframes = []
    for i, page_num in enumerate(pages):
        page_tables = _h2(file_path, page_num, tables_info, dpi=dpi, occurrence_order=occurrence_order)
        all_dataframes.extend(page_tables)
        if progress_callback:
            progress_callback(i + 1, len(pages))
    if not all_dataframes:
        return None
    return _reorder_trailing_columns(pd.concat(all_dataframes, ignore_index=True))


def extract_grouped(file_path, tables_info, total_pages, dpi, progress_callback=None, sample_mode=None, occurrence_order=False):
    """Real-conversion extraction: grouped by each table's outputSlot."""
    slotted_tables_info = [info for info in tables_info if info.get("outputSlot")]
    slot_to_info = {info["outputSlot"]: info for info in slotted_tables_info}
    pages = _resolve_pages(total_pages, sample_mode)
    by_slot = {}
    for i, page_num in enumerate(pages):
        for info in slotted_tables_info:
            slot = info["outputSlot"]
            page_tables = _h2(file_path, page_num, [info], dpi=dpi, occurrence_order=occurrence_order)
            if page_tables:
                by_slot.setdefault(slot, []).extend(page_tables)
        if progress_callback:
            progress_callback(i + 1, len(pages))
    if not by_slot:
        return None
    result = {}
    for slot, dfs in by_slot.items():
        df = _reorder_trailing_columns(pd.concat(dfs, ignore_index=True))
        df = df.drop(columns=["Table Name"], errors="ignore")
        rename_map = slot_to_info.get(slot, {}).get("columnRenames") or {}
        if rename_map:
            df = df.rename(columns=rename_map)
        result[slot] = df
    return result


def build_schema_preview_payload(df, tables_info, sample_row_limit=5):
    tables = []
    for info in tables_info:
        name = (info.get("name") or "").strip()
        color = info.get("color", "")
        fallback_n_cols = len(info.get("columns", [])) + 1
        if df is None:
            sub = None
        elif "Table Name" in df.columns:
            sub = df[df["Table Name"] == name] if name else df[df["Table Name"].isna()]
        else:
            sub = df if not name else df.iloc[0:0]
        if sub is not None and len(sub) > 0:
            candidates = [c for c in sub.columns if c.startswith("Column_")]
            real_cols = [c for c in candidates if sub[c].notna().any()]
            real_cols.sort(key=lambda c: int(c.split("_")[1]))
            if not real_cols:
                real_cols = [f"Column_{i+1}" for i in range(fallback_n_cols)]
        else:
            real_cols = [f"Column_{i+1}" for i in range(fallback_n_cols)]
        col_names = real_cols + ["Page"]
        if sub is not None:
            existing = [c for c in col_names if c in sub.columns]
            sub = sub[existing] if existing else pd.DataFrame(columns=col_names)
        else:
            sub = pd.DataFrame(columns=col_names)
        sample_rows = sub.head(sample_row_limit).fillna("").astype(str).values.tolist()
        # Echoed straight back from the request -- the frontend's real,
        # stable identity for this table (name is just a mutable label).
        rect_id = info.get("rectId", "")
        tables.append({"rectId": rect_id, "name": name, "color": color, "columns": col_names, "rowCount": int(len(sub)), "sampleRows": sample_rows})
    return json.dumps(tables)


def page_count(file_path) -> int:
    try:
        pdf_doc = PdfDocument(file_path)
        count = len(pdf_doc)
        pdf_doc.close()
        return count
    except Exception:
        return 0


def find_keywords(pdf_path, keywords, case_sensitive=False):
    """Find keyword bounding boxes per page for smart rectangles."""
    doc = fitz.open(pdf_path)
    page_results = {}
    for pi in range(len(doc)):
        page = doc[pi]
        all_bboxes = []
        by_keyword = {}
        for keyword in keywords:
            if not keyword:
                continue
            candidates = page.search_for(keyword)
            if case_sensitive:
                results = [r for r in candidates if keyword in page.get_text("text", clip=r).replace("\n", " ")]
            else:
                results = candidates
            if not results:
                continue
            occurrences = []
            current = [results[0]]
            for i in range(1, len(results)):
                if abs(results[i].y0 - results[i - 1].y0) < 5:
                    current.append(results[i])
                else:
                    occurrences.append(current)
                    current = [results[i]]
            occurrences.append(current)
            kw_bboxes = []
            for occ in occurrences:
                bbox = [
                    min(r.x0 for r in occ), min(r.y0 for r in occ),
                    max(r.x1 for r in occ), max(r.y1 for r in occ),
                ]
                kw_bboxes.append(bbox)
                all_bboxes.append(bbox)
            if kw_bboxes:
                by_keyword[keyword] = kw_bboxes
        if all_bboxes:
            page_results[str(pi + 1)] = {
                "bboxes": all_bboxes,
                "union_bbox": [
                    min(b[0] for b in all_bboxes), min(b[1] for b in all_bboxes),
                    max(b[2] for b in all_bboxes), max(b[3] for b in all_bboxes),
                ],
                "by_keyword": by_keyword,
                "page_w": page.rect.width,
                "page_h": page.rect.height,
            }
    doc.close()
    return page_results
