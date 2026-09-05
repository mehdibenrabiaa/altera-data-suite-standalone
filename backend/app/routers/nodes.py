from pathlib import Path
from typing import Any

import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.nodes import NODE_TRANSFORMS

router = APIRouter(prefix="/nodes", tags=["nodes"])


class TableInput(BaseModel):
    columns: list[str]
    rows: list[list[Any]]
    # The source table/node's own display name, echoed straight from the
    # frontend's resolveNodeInputs -- only export_data reads this (each
    # output sheet/file is named after its source), carried as a DataFrame
    # attr (same mechanism already used for column_types below) rather than
    # a transform-signature change, since every other transform just
    # ignores it.
    name: str | None = None
    # Whichever of this table's columns are known to be a real type (only
    # ever set by change_type's own output -- see NodeTableInput.columnTypes
    # in nodeExecution.ts) -- SchemaView.tsx's resolveNodeInputs already
    # forwards a node's own resolved columnTypes into whatever it feeds as
    # a downstream node's input, so this was already arriving on the wire
    # and being silently dropped (not declared on this model) until now.
    # Value-preserving transforms (Bridge, Horizontal Stack, Filter,
    # Unique, Column Edit, Shift Columns, Cascade Fill, Concatenate,
    # Merge, Index Column, Add Column/Formula for untouched columns) read
    # this off their own input df.attrs and carry it forward into their
    # own result -- see each one's own column_types handling.
    columnTypes: dict[str, str] | None = None


class RunNodeRequest(BaseModel):
    kind: str
    inputs: list[TableInput]
    params: dict[str, Any] = {}


@router.post("/run")
def run_node(req: RunNodeRequest):
    try:
        transform = NODE_TRANSFORMS[req.kind]
    except KeyError:
        raise HTTPException(400, f"Unknown node kind: {req.kind}")
    try:
        dfs = []
        for inp in req.inputs:
            df = pd.DataFrame(inp.rows, columns=inp.columns)
            df.attrs["name"] = inp.name
            df.attrs["column_types"] = inp.columnTypes or {}
            dfs.append(df)
        result, warnings, info = transform(dfs, req.params)
        # Captured before fillna/astype (which return a NEW DataFrame) --
        # only change_type sets this (see its own comment); every other
        # node kind's result.attrs is just the empty dict pandas defaults
        # to, so columnTypes comes back None for them.
        column_types = result.attrs.get("column_types") or None
        result = result.fillna("").astype(str)
        return {
            "columns": list(result.columns),
            "rows": result.values.tolist(),
            "warnings": warnings,
            "info": info,
            "columnTypes": column_types,
        }
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


class InspectFileRequest(BaseModel):
    path: str


# Called by the Input Data Configure window right after a file is picked --
# separate from /run since it's a stateless "what's inside this file"
# lookup that has to happen BEFORE Apply (to populate the sheet dropdown),
# not a real node run. Only .xlsx/.xls carry more than one sheet; every
# other supported extension always resolves to sheets: null so the
# frontend knows not to show a sheet picker at all.
@router.post("/inspect-file")
def inspect_file(req: InspectFileRequest):
    p = Path(req.path)
    if not p.exists():
        raise HTTPException(400, "File not found")
    if p.suffix.lower() not in (".xlsx", ".xls"):
        return {"sheets": None}
    try:
        return {"sheets": pd.ExcelFile(req.path).sheet_names}
    except Exception as e:
        raise HTTPException(400, f"Could not read '{p.name}': {e}")
