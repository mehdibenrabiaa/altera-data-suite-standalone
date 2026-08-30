from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app.routers import pdf_converter, licensing, nodes
from app.ws_manager import manager

app = FastAPI(title="Altera Data Suite Backend")

# Dev-only: the renderer is a Vite dev server on a different origin. Tighten
# this once the app is packaged and the renderer is loaded from disk instead.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(pdf_converter.router)
app.include_router(licensing.router)
app.include_router(nodes.router)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Nothing expected from the renderer on this channel yet -- just
            # keeps the connection open until it closes.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
