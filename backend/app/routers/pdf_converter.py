import base64
import re
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from app import extraction
from app.ws_manager import manager

router = APIRouter(prefix="/pdf-converter", tags=["pdf-converter"])

_SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]")

# DPI used only for the (currently unported) rendering helpers in the
# original widget -- extraction itself works in PDF point space regardless
# of this value. Kept for parity with pdf_converter.py's _Br.dpi.
_DPI = 150

# Single-user local desktop app -- one PDF "open" at a time, mirroring the
# original OWWidget's self.file_path instance attribute. "converting" guards
# against two overlapping /convert calls, whose progress broadcasts would
# otherwise land on the same WebSocket channel with no way to tell them
# apart -- checked/set synchronously on the event loop (before the actual
# work moves to a threadpool below), so it's safe without an explicit lock.
_state: dict[str, Any] = {"path": None, "converting": False}


class UploadRequest(BaseModel):
    filename: str
    base64_data: str


class SetPathRequest(BaseModel):
    path: str


class ConvertRequest(BaseModel):
    tables: list[dict[str, Any]]
    occurrenceOrder: bool = False
    sampleMode: dict[str, Any] | None = None


class SchemaPreviewRequest(BaseModel):
    tables: list[dict[str, Any]]
    occurrenceOrder: bool = False
    sampleRowLimit: int = 10
    pageLimit: int = 10


class KeywordsRequest(BaseModel):
    rectId: str
    keywords: list[str]
    caseSensitive: bool = False


def _require_path() -> str:
    path = _state["path"]
    if not path or not Path(path).exists():
        raise HTTPException(400, "No PDF loaded")
    return path


@router.post("/upload")
def upload_pdf(req: UploadRequest):
    safe_name = _SAFE_NAME.sub("_", req.filename)
    dest = Path(tempfile.gettempdir()) / f"altera_studio_{safe_name}"
    dest.write_bytes(base64.b64decode(req.base64_data))
    _state["path"] = str(dest)
    return {"path": str(dest), "pages": extraction.page_count(str(dest))}


@router.post("/set-path")
def set_path(req: SetPathRequest):
    if not Path(req.path).exists():
        raise HTTPException(400, "File not found")
    _state["path"] = req.path
    return {"path": req.path, "pages": extraction.page_count(req.path)}


@router.post("/convert")
async def convert(req: ConvertRequest):
    path = _require_path()
    if _state["converting"]:
        raise HTTPException(409, "A conversion is already in progress")
    _state["converting"] = True
    try:
        total_pages = extraction.page_count(path)

        # extract_grouped runs synchronously in a threadpool (it's CPU-bound
        # and does blocking file I/O via camelot/fitz) -- this callback fires
        # from that worker thread, so it hands off to the event loop via
        # broadcast_threadsafe rather than awaiting anything directly.
        def progress_cb(current: int, total: int) -> None:
            pct = int(current / total * 100) if total else 0
            manager.broadcast_threadsafe({"type": "progress", "pct": pct})

        try:
            result = await run_in_threadpool(
                extraction.extract_grouped,
                path, req.tables, total_pages, _DPI,
                progress_cb, req.sampleMode, req.occurrenceOrder,
            )
        except Exception as e:
            raise HTTPException(500, str(e))
        if result is None:
            return {"slots": {}}
        slots = {}
        for slot, df in result.items():
            df = df.fillna("").astype(str)
            slots[str(slot)] = {"columns": list(df.columns), "rows": df.values.tolist()}
        return {"slots": slots}
    finally:
        _state["converting"] = False


@router.post("/schema-preview")
def schema_preview(req: SchemaPreviewRequest):
    path = _require_path()
    total_pages = extraction.page_count(path)
    sample_mode = {"mode": "first_n", "firstN": req.pageLimit}
    try:
        df = extraction.extract_merged(
            path, req.tables, total_pages, _DPI,
            sample_mode=sample_mode, occurrence_order=req.occurrenceOrder,
        )
        payload = extraction.build_schema_preview_payload(df, req.tables, sample_row_limit=req.sampleRowLimit)
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"tables": payload}


@router.post("/keywords")
def keywords(req: KeywordsRequest):
    path = _require_path()
    try:
        result = extraction.find_keywords(path, req.keywords, req.caseSensitive)
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"rectId": req.rectId, "result": result}
