"""First-party node plugins -- packages the team can ship and a user can
install without a full app rebuild, instead of every node living in
nodes.py's hardcoded NODE_TRANSFORMS. Trust model is unchanged from the
rest of this app (no sandboxing): plugins are team-authored, not an open
third-party ecosystem, so a plugin's transform.py runs with the same
privileges as any other backend code.

A plugin is a folder under PLUGIN_DIR containing:
  manifest.json -- node metadata (see PluginManifest below)
  transform.py  -- a module with a `run(dfs, params) -> (df, warnings, info)`
                    function, identical contract to every function in
                    nodes.py's NODE_TRANSFORMS
  icon.svg       -- single-color stroke icon, same convention as
                    public/node-icons/*.svg on the frontend

Loaded transforms are namespaced "plugin:<id>" so they can never collide
with the built-in slugs in nodes.py.
"""

import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Callable

import pandas as pd
import requests
from pydantic import BaseModel, ValidationError

from app.nodes import NODE_TRANSFORMS

# Same production license server this app's own licensing already talks to
# (backend/app/license_logic.py's _BASE) -- plugin catalog/download now
# lives there too (altera-license-server's /plugins/* routes), so this app
# never talks to the internet from anywhere BUT this one backend, same as
# every other remote call it makes.
REMOTE_BASE = "https://backend.alteradatasuite.com"

PluginTransform = Callable[[list[pd.DataFrame], dict[str, Any]], tuple[pd.DataFrame, list[str], list[str]]]


class PluginField(BaseModel):
    key: str
    label: str
    type: str  # "text" | "number" | "select" | "toggle" | "column" | "columns"
    options: list[str] | None = None
    default: Any = None


class PluginManifest(BaseModel):
    id: str
    name: str
    description: str = ""
    category: str
    hasInput: bool = True
    hasOutput: bool = True
    hasExtraInput: bool = False
    mainInputMax: int | None = None
    fields: list[PluginField] = []


class LoadedPlugin(BaseModel):
    manifest: PluginManifest
    error: str | None = None

    class Config:
        arbitrary_types_allowed = True


def _plugin_dir() -> Path:
    # Mirrors the Electron main process's own userData convention
    # (window-state.json/settings.json) rather than duplicating that
    # path-resolution logic here -- Electron passes it down as an env var
    # when it spawns this backend (see electron/main.ts's startBackend()).
    # Falls back to a local ./plugins folder for `uvicorn app.main:app`
    # run directly outside Electron (dev/debugging).
    base = os.environ.get("ALTERA_USER_DATA_DIR")
    root = Path(base) if base else Path(__file__).resolve().parent.parent
    return root / "plugins"


PLUGIN_DIR = _plugin_dir()

# Populated by reload_plugins(); kept separate from NODE_TRANSFORMS itself
# so a broken reload can never partially clobber the built-in registry.
_plugin_transforms: dict[str, PluginTransform] = {}
_loaded: list[LoadedPlugin] = []


def _load_one(plugin_path: Path) -> LoadedPlugin:
    manifest_path = plugin_path / "manifest.json"
    transform_path = plugin_path / "transform.py"

    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest = PluginManifest(**raw)
    except (OSError, json.JSONDecodeError, ValidationError) as e:
        return LoadedPlugin(
            manifest=PluginManifest(id=plugin_path.name, name=plugin_path.name, category="transform"),
            error=f"Invalid manifest.json: {e}",
        )

    if manifest.id != plugin_path.name:
        return LoadedPlugin(manifest=manifest, error=f"manifest id '{manifest.id}' must match folder name '{plugin_path.name}'")

    if not transform_path.exists():
        return LoadedPlugin(manifest=manifest, error="Missing transform.py")

    module_name = f"altera_plugin_{manifest.id}"
    try:
        spec = importlib.util.spec_from_file_location(module_name, transform_path)
        if spec is None or spec.loader is None:
            raise ImportError("could not load transform.py")
        module = importlib.util.module_from_spec(spec)
        # Registered in sys.modules before exec so transform.py's own
        # top-level imports (if any reference its own module by name)
        # resolve the same way a normal package import would.
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        run = getattr(module, "run", None)
        if not callable(run):
            raise AttributeError("transform.py has no callable run(dfs, params)")
    except Exception as e:
        return LoadedPlugin(manifest=manifest, error=f"Failed to load transform.py: {e}")

    _plugin_transforms[f"plugin:{manifest.id}"] = run
    return LoadedPlugin(manifest=manifest, error=None)


def reload_plugins() -> list[LoadedPlugin]:
    """Rescans PLUGIN_DIR from scratch. A single broken plugin is reported
    and skipped -- it never prevents the others (or the 24+ built-in
    nodes) from loading/running."""
    global _loaded
    _plugin_transforms.clear()
    PLUGIN_DIR.mkdir(parents=True, exist_ok=True)

    loaded: list[LoadedPlugin] = []
    for entry in sorted(PLUGIN_DIR.iterdir()):
        if entry.is_dir():
            loaded.append(_load_one(entry))
    _loaded = loaded
    return loaded


def list_plugins() -> list[LoadedPlugin]:
    return _loaded


def get_all_transforms() -> dict[str, PluginTransform]:
    # Built-ins first so a plugin id can never shadow one -- moot in
    # practice since plugin keys are "plugin:<id>"-namespaced, but keeps
    # the merge order obviously safe either way.
    return {**NODE_TRANSFORMS, **_plugin_transforms}


def fetch_remote_catalog() -> list[dict[str, Any]]:
    """Plugins currently published on altera-license-server, for Studio's
    Settings -> Plugins -> Browse Plugins list. Raises on a network/server
    error -- the router turns that into a clean error response rather than
    a raw traceback."""
    resp = requests.get(f"{REMOTE_BASE}/plugins/catalog", timeout=10)
    resp.raise_for_status()
    return resp.json().get("plugins", [])


def install_from_remote(plugin_id: str) -> str | None:
    """Downloads and installs one plugin from altera-license-server.
    Returns an error string on failure, None on success (mirrors
    electron/main.ts's plugin:install IPC return convention, even though
    this path never goes through Electron -- the renderer calls this
    endpoint directly, same as it does for a local-folder install)."""
    try:
        resp = requests.get(f"{REMOTE_BASE}/plugins/download/{plugin_id}", timeout=30)
        resp.raise_for_status()
    except requests.RequestException as e:
        return f"Couldn't download plugin: {e}"

    if not resp.content:
        return "Downloaded package was empty."

    # Extracted into a scratch dir first and validated BEFORE touching
    # PLUGIN_DIR -- a bad zip (wrong id inside, missing manifest.json)
    # should never partially overwrite/corrupt an already-installed
    # plugin of the same id.
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        try:
            with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                zf.extractall(tmp_path)
        except zipfile.BadZipFile:
            return "Downloaded file is not a valid .zip."

        manifest_path = tmp_path / "manifest.json"
        if not manifest_path.exists():
            return "Downloaded package is missing manifest.json."
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            return f"Invalid manifest.json in downloaded package: {e}"
        if manifest.get("id") != plugin_id:
            return f"manifest.json id ('{manifest.get('id')}') doesn't match the requested plugin ('{plugin_id}')."

        target = PLUGIN_DIR / plugin_id
        PLUGIN_DIR.mkdir(parents=True, exist_ok=True)
        if target.exists():
            shutil.rmtree(target)
        # copytree (not move) -- tmp_path stays in place for the
        # TemporaryDirectory context manager's own cleanup on exit below.
        shutil.copytree(tmp_path, target)

    reload_plugins()
    return None
