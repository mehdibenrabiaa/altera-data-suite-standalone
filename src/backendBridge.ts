import type { QtBridge, SchemaPreviewTable } from "./types";

// Stand-in for the Python QWebChannel bridge (`_Br` in pdf_converter.py) that
// the Orange-hosted widget used. There is no Qt/QWebEngine host here, so each
// method talks to the local FastAPI backend directly, then feeds results back
// through the same `window.xxx` globals pdf_converter.py used to push into
// via runJavaScript -- that keeps App.tsx's own state machinery untouched.
export function createBackendBridge(): QtBridge {
  const base = window.alteraStudio.backendUrl;

  async function setBackendPath(path: string) {
    await fetch(`${base}/pdf-converter/set-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  }

  // General-purpose push channel from the backend (extraction progress for
  // now; any future node's live status later) -- one connection for the
  // app's lifetime, reconnecting on drop since the backend can briefly be
  // unreachable right after launch or during a dev restart.
  function connectProgressSocket() {
    const wsUrl = base.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "progress") {
          (window as unknown as { setConversionProgress?: (pct: number) => void })
            .setConversionProgress?.(msg.pct);
        }
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      setTimeout(connectProgressSocket, 1000);
    };
  }
  connectProgressSocket();

  return {
    saveHtmlState() {
      // TODO: persist rectangles/guides via the backend once there's a
      // project/session concept to save them into.
    },

    async getCoordinatesFromJs(data) {
      const parsed = JSON.parse(data);
      const tables = Array.isArray(parsed) ? parsed : parsed.tables ?? [];
      const occurrenceOrder = Array.isArray(parsed) ? false : !!parsed.occurrenceOrder;
      const sampleMode = Array.isArray(parsed) ? null : parsed.sampleMode ?? null;
      const receiveConvertResult = (window as unknown as {
        receiveConvertResult?: (byId: Record<string, { columns: string[]; rows: string[][] }>) => void;
      }).receiveConvertResult;
      try {
        const res = await fetch(`${base}/pdf-converter/convert`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tables, occurrenceOrder, sampleMode }),
        });
        if (!res.ok) throw new Error((await res.json()).detail ?? `HTTP ${res.status}`);
        const { slots } = await res.json();

        // Results come back keyed by output slot -- re-key by each table's
        // own stable rectId (not `name`, a mutable display label a rename
        // would otherwise orphan this entry under) before handing off.
        const slotToId = new Map<number, string>();
        for (const t of tables as { outputSlot?: number; rectId?: string }[]) {
          if (t.outputSlot && t.rectId) slotToId.set(t.outputSlot, t.rectId);
        }
        const byId: Record<string, { columns: string[]; rows: string[][] }> = {};
        for (const [slot, table] of Object.entries(slots as Record<string, { columns: string[]; rows: string[][] }>)) {
          const rectId = slotToId.get(Number(slot));
          if (rectId) byId[rectId] = table;
        }
        receiveConvertResult?.(byId);
        // Result now lands directly in the Schema drawer via
        // receiveConvertResult -- no separate completion dialog needed.
        console.log(`[bridge] Convert finished: ${Object.keys(slots).length} table(s) extracted`, slots);
      } catch (e) {
        alert(`Conversion failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        window.showLoaderHandler?.(0);
      }
    },

    async openFileDialog() {
      const path = await window.alteraStudio.openPdfDialog();
      if (!path) return;
      await setBackendPath(path);
      await (window as unknown as { loadPdfFromPath: (p: string) => Promise<void> }).loadPdfFromPath(path);
    },

    async receivePdfData(filename, base64Data) {
      const res = await fetch(`${base}/pdf-converter/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, base64_data: base64Data }),
      });
      await res.json();
    },

    generateInkOverlay() {
      // TODO: ink overlay generation — not ported yet.
      console.warn("[bridge] generateInkOverlay not wired up yet");
    },

    async findKeywords(dataJson) {
      const { rectId, keywords, caseSensitive } = JSON.parse(dataJson);
      const receive = (window as unknown as {
        receiveKeywordData?: (rid: string, payload: unknown, error: string | null) => void;
      }).receiveKeywordData;
      try {
        const res = await fetch(`${base}/pdf-converter/keywords`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rectId, keywords, caseSensitive }),
        });
        if (!res.ok) throw new Error((await res.json()).detail ?? `HTTP ${res.status}`);
        const { result } = await res.json();
        receive?.(rectId, result, null);
      } catch (e) {
        receive?.(rectId, null, e instanceof Error ? e.message : String(e));
      }
    },

    async previewSchema(dataJson) {
      const { tables, occurrenceOrder, sampleRowLimit, pageLimit } = JSON.parse(dataJson);
      const receive = (window as unknown as {
        receiveSchemaPreview?: (payload: SchemaPreviewTable[] | null, error: string | null) => void;
      }).receiveSchemaPreview;
      try {
        const res = await fetch(`${base}/pdf-converter/schema-preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tables, occurrenceOrder, sampleRowLimit, pageLimit }),
        });
        if (!res.ok) throw new Error((await res.json()).detail ?? `HTTP ${res.status}`);
        const { tables: payloadJson } = await res.json();
        receive?.(JSON.parse(payloadJson), null);
      } catch (e) {
        receive?.(null, e instanceof Error ? e.message : String(e));
      }
    },
  };
}
