import requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app import plugins

router = APIRouter(prefix="/plugins", tags=["plugins"])


@router.get("/list")
def list_plugins():
    return {
        "plugins": [
            {"manifest": p.manifest.model_dump(), "error": p.error}
            for p in plugins.list_plugins()
        ]
    }


@router.post("/reload")
def reload_plugins():
    loaded = plugins.reload_plugins()
    return {
        "plugins": [
            {"manifest": p.manifest.model_dump(), "error": p.error}
            for p in loaded
        ]
    }


# Browse/install from altera-license-server (see plugins.py's REMOTE_BASE) --
# the renderer's Settings -> Plugins -> Browse Plugins tab calls these two
# directly, same "only this local backend talks to the internet" boundary
# every other remote call in this app already keeps.
@router.get("/remote-catalog")
def remote_catalog():
    try:
        return {"plugins": plugins.fetch_remote_catalog()}
    except requests.RequestException as e:
        raise HTTPException(502, f"Couldn't reach the plugin server: {e}")


@router.post("/install/{plugin_id}")
def install_plugin(plugin_id: str):
    error = plugins.install_from_remote(plugin_id)
    if error:
        raise HTTPException(400, error)
    return {"ok": True}


# Consumed straight as an <img src> by the frontend's getPluginCatalog()
# (src/plugins.ts) -- a plugin's icon.svg is never bundled into the app
# build, so unlike public/node-icons/*.svg for the built-ins, it has to be
# served over HTTP from wherever it actually lives on disk.
@router.get("/{plugin_id}/icon.svg")
def plugin_icon(plugin_id: str):
    # plugin_id only ever reaches here as a path segment FastAPI already
    # url-decoded/split on "/" -- can't itself contain a "/" to escape
    # PLUGIN_DIR, but reject ".."/empty defensively anyway.
    if not plugin_id or "/" in plugin_id or plugin_id in (".", ".."):
        raise HTTPException(400, "Invalid plugin id")
    icon_path = plugins.PLUGIN_DIR / plugin_id / "icon.svg"
    if not icon_path.is_file():
        raise HTTPException(404, "Icon not found")
    return FileResponse(icon_path, media_type="image/svg+xml")
