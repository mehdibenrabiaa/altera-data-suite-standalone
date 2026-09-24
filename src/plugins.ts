// First-party node plugins -- packages the team can ship and a user can
// install without a full app rebuild/reinstall. See backend/app/plugins.py
// for the loader this talks to and the manifest contract.
//
// Kept as a plain external store (not React state/context) with a tiny
// subscribe/notify pair, rather than prop-drilling a "plugins" prop through
// NodesPanel/SchemaView: those components read getAllNodes()/getPluginByName()
// directly wherever they already read the static NODE_CATALOG, and only the
// two spots that must re-render as soon as plugins load (the node palette,
// the quick-add picker) subscribe via usePlugins() below. Everywhere else
// (running/configuring an already-placed node) only matters after the node
// was already visible in the palette to be dragged in, i.e. after the
// initial load already resolved, so no subscription is needed there.
import { useSyncExternalStore } from "react";
import type { CategoryKey, NodeCatalogEntry } from "./nodeCatalog";

export interface PluginField {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "toggle" | "column" | "columns";
  options?: string[] | null;
  default?: unknown;
}

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  category: CategoryKey;
  hasInput: boolean;
  hasOutput: boolean;
  hasExtraInput: boolean;
  mainInputMax: number | null;
  fields: PluginField[];
}

export interface PluginListEntry {
  manifest: PluginManifest;
  error: string | null;
}

let entries: PluginListEntry[] = [];
let loadedManifests: PluginManifest[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function applyList(list: PluginListEntry[]) {
  entries = list;
  loadedManifests = list.filter((p) => !p.error).map((p) => p.manifest);
  notify();
}

export async function refreshPlugins(): Promise<void> {
  try {
    const res = await fetch(`${window.alteraStudio.backendUrl}/plugins/list`);
    const data = await res.json();
    applyList(data.plugins ?? []);
  } catch {
    applyList([]);
  }
}

// Called after install/uninstall, which reload the backend's registry --
// re-fetches the now-current list rather than assuming what changed.
export const reloadPlugins = refreshPlugins;

export function getPluginEntries(): PluginListEntry[] {
  return entries;
}

export function getPluginByName(name: string): PluginManifest | undefined {
  return loadedManifests.find((m) => m.name === name);
}

export function getPluginCatalog(): NodeCatalogEntry[] {
  return loadedManifests.map((m) => ({
    name: m.name,
    description: m.description,
    icon: `${window.alteraStudio.backendUrl}/plugins/${m.id}/icon.svg`,
    category: m.category,
    hasOutput: m.hasOutput,
    hasExtraInput: m.hasExtraInput,
    hasInput: m.hasInput,
    mainInputMax: m.mainInputMax ?? undefined,
  }));
}

export function getKindSlugForPlugin(name: string): string | undefined {
  const m = getPluginByName(name);
  return m ? `plugin:${m.id}` : undefined;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Re-renders the calling component whenever the plugin list changes
// (initial load, install, uninstall) -- see the module comment above for
// why this is only needed in a couple of places.
export function usePlugins(): PluginListEntry[] {
  return useSyncExternalStore(subscribe, getPluginEntries);
}
