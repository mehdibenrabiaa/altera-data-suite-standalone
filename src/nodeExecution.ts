// Talks to the backend's generic /nodes/run endpoint (backend/app/routers/
// nodes.py), which dispatches by `kind` into backend/app/nodes.py's
// NODE_TRANSFORMS registry. Kept separate from backendBridge.ts -- that
// file's shape mirrors the old PyQt QWebChannel bridge's specific method
// surface (QtBridge in types.ts), which this isn't part of; this is a new,
// plain fetch helper, not a bridge method.
import type { AppliedColumnType } from "./columnTypeDetection";

export interface NodeTableInput {
  columns: string[];
  rows: string[][];
  // Only ever set on a table that's the direct output of a Change Type
  // node (see columnTypeDetection.ts's resolveDisplayColumnType) -- passed
  // straight through here so it survives an input round-trip (e.g. Change
  // Type's own output feeding into a downstream node's resolved input),
  // even though no node transform reads it; it's display-only metadata.
  columnTypes?: Record<string, AppliedColumnType>;
}

export interface RunNodeResult {
  columns: string[];
  rows: string[][];
  warnings: string[];
  info: string[];
  columnTypes?: Record<string, AppliedColumnType> | null;
}

export async function runProcessorNode(
  kind: string,
  inputs: NodeTableInput[],
  params: Record<string, unknown> = {},
): Promise<RunNodeResult> {
  const res = await fetch(`${window.alteraStudio.backendUrl}/nodes/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, inputs, params }),
  });
  // Matches backendBridge.ts's own fetch-error convention exactly.
  if (!res.ok) throw new Error((await res.json()).detail ?? `HTTP ${res.status}`);
  return res.json();
}
