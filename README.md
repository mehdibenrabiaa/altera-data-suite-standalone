# Altera Data Suite

Standalone desktop app replacing Orange Canvas as the host: an Electron
shell around a React Flow graph (ported from PDF Converter's Schema
Preview), backed by a local FastAPI process that runs the same data
transforms currently living in `orangecontrib/custom/widgets/`.

Currently scaffolded: Electron ↔ FastAPI ↔ React wired end-to-end (see
the "Backend: connected" status on launch). Widgets are ported in one at
a time, starting with PDF Converter.

## Dev setup

```
npm install
python -m venv backend/.venv
backend/.venv/Scripts/pip install -r backend/requirements.txt
```

The backend venv's `python` needs to be on `PATH` (or update the
`spawn("python", ...)` call in `electron/main.ts`) when running `npm run
dev`, since Electron's main process spawns the backend as a child
process directly.

## Run

```
npm run dev
```
