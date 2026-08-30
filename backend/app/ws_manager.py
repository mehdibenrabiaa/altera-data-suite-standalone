import asyncio

from fastapi import WebSocket

# Single general-purpose push channel from backend to renderer -- not
# specific to PDF Converter. Extraction runs in a threadpool (see
# routers/pdf_converter.py), so progress callbacks fire from a worker
# thread; run_coroutine_threadsafe is what actually gets the send back onto
# the event loop safely from there.
class ConnectionManager:
    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._loop = asyncio.get_running_loop()
        self._connections.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._connections.discard(ws)

    async def _broadcast(self, message: dict) -> None:
        dead = []
        for ws in self._connections:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._connections.discard(ws)

    def broadcast_threadsafe(self, message: dict) -> None:
        if self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(self._broadcast(message), self._loop)


manager = ConnectionManager()
