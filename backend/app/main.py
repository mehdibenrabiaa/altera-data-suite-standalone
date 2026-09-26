import os

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import plugins
from app.routers import pdf_converter, licensing, nodes, plugins as plugins_router
from app.ws_manager import manager

app = FastAPI(title="Altera Data Suite Backend")

# Populates plugins.list_plugins()/get_all_transforms() before the first
# /nodes/run or /plugins/list request -- without this, a freshly started
# backend would report zero plugins until something calls /plugins/reload.
plugins.reload_plugins()

# allow_origins stays "*" on purpose -- CORS alone was never the real
# boundary here (a malicious page can send a "blind" cross-origin POST
# whether or not it can read the response, and file:// pages get an
# opaque "null" origin that's trivially spoofable via a sandboxed
# iframe anyway). LOCAL_TOKEN below is the actual protection: every
# request this app's own windows make already carries it (injected
# centrally by electron/main.ts's webRequest.onBeforeSendHeaders), so a
# page that doesn't know it gets rejected regardless of origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Set by electron/main.ts's startBackend() (a fresh random value every
# launch, never persisted) -- absent entirely when this backend is run
# directly outside Electron (dev/debugging via `uvicorn app.main:app`),
# in which case the check below is skipped rather than locking out a
# developer who has no way to supply it.
LOCAL_TOKEN = os.environ.get("ALTERA_LOCAL_TOKEN")


@app.middleware("http")
async def require_local_token(request: Request, call_next):
    if LOCAL_TOKEN and request.headers.get("x-altera-local-token") != LOCAL_TOKEN:
        return JSONResponse({"detail": "Forbidden"}, status_code=403)
    return await call_next(request)


app.include_router(pdf_converter.router)
app.include_router(licensing.router)
app.include_router(nodes.router)
app.include_router(plugins_router.router)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # @app.middleware("http") above only wraps HTTP-scope requests --
    # Starlette routes WebSocket connections through an entirely separate
    # scope, so the same check needs repeating here explicitly.
    if LOCAL_TOKEN and websocket.headers.get("x-altera-local-token") != LOCAL_TOKEN:
        await websocket.close(code=4403)
        return
    await manager.connect(websocket)
    try:
        while True:
            # Nothing expected from the renderer on this channel yet -- just
            # keeps the connection open until it closes.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
