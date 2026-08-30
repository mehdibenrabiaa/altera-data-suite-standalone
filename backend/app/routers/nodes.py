from typing import Any

import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.nodes import NODE_TRANSFORMS

router = APIRouter(prefix="/nodes", tags=["nodes"])


class TableInput(BaseModel):
    columns: list[str]
    rows: list[list[Any]]


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
        dfs = [pd.DataFrame(inp.rows, columns=inp.columns) for inp in req.inputs]
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
