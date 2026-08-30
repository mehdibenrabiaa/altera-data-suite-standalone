import json
import platform
from pathlib import Path

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from app import license_logic

router = APIRouter(prefix="/licensing", tags=["licensing"])

# routers/licensing.py -> app -> backend -> altera-studio/package.json.
# Single source of truth for the version string -- this backend isn't
# pip-installed (importlib.metadata.version() has nothing to find), and the
# frontend's package.json is the one place a version already gets bumped.
_PACKAGE_JSON = Path(__file__).resolve().parents[3] / "package.json"


def _suite_version() -> str:
    try:
        return json.loads(_PACKAGE_JSON.read_text())["version"]
    except Exception:
        return "unknown"


def _os_label() -> str:
    if platform.system() != "Windows":
        return f"{platform.system()} {platform.release()}"
    # platform.release() reports "10" for Windows 11 too -- Windows 11 is
    # still NT 10.0 under the hood, and Python's platform module doesn't
    # look past the major.minor version to tell them apart. The build
    # number (from platform.version(), e.g. "10.0.22631") does: builds
    # >= 22000 are Windows 11.
    try:
        build = int(platform.version().split(".")[-1])
    except (ValueError, IndexError):
        build = 0
    release = "11" if build >= 22000 else platform.release()
    return f"Windows {release}"


class ActivateRequest(BaseModel):
    license_key: str


@router.get("/machine-id")
async def machine_id():
    # get_machine_id() can shell out to PowerShell on Windows (CPU-ID
    # fallback) and take well over a second -- run_in_threadpool so it
    # doesn't block the event loop, matching the original Qt widget's own
    # background-thread treatment of this same call.
    mid = await run_in_threadpool(license_logic.get_machine_id)
    return {"machine_id": mid}


@router.get("/check")
async def check():
    mid = await run_in_threadpool(license_logic.get_machine_id)
    # Auto-trial (not the plain check_license) -- matches what the real
    # Settings widget's "check_license" UI event actually invokes (_cwat).
    return await run_in_threadpool(license_logic.check_with_auto_trial, mid)


@router.post("/activate")
async def activate(req: ActivateRequest):
    mid = await run_in_threadpool(license_logic.get_machine_id)
    return await run_in_threadpool(license_logic.activate_license, req.license_key, mid)


@router.post("/deactivate")
async def deactivate():
    mid = await run_in_threadpool(license_logic.get_machine_id)
    return await run_in_threadpool(license_logic.deactivate_license, mid)


@router.get("/system-info")
def system_info():
    return {
        "suite_version": _suite_version(),
        "orange_version": "n/a (standalone)",
        "os": _os_label(),
    }
