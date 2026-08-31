import { useCallback, useEffect, useState } from "react";
import type { CellContextMenuEvent, CellKeyDownEvent } from "ag-grid-community";

// Ctrl+C-to-copy and a right-click "Copy" menu for a single AG-Grid cell,
// shared by every grid in the app (BrowseWindow.tsx, SchemaView.tsx's
// output drawer, RegexWindow.tsx, HeaderPromoterWindow.tsx). Hand-built
// rather than using AG-Grid's own clipboard/context-menu features because
// both are Enterprise-only modules in the installed ag-grid-community
// version (ClipboardModule/ContextMenuModule -- confirmed in the
// package's own ENTERPRISE_MODULE_NAMES list), and this app only has the
// free Community edition (no ag-grid-enterprise package, no license key).
// Copies the ONE focused/right-clicked cell's value -- there's no multi-
// cell range selection to copy either, same Enterprise gate
// (CellSelectionModule), so this deliberately doesn't try to fake one.
function cellTextValue(e: { value?: unknown }): string {
  return e.value == null ? "" : String(e.value);
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The Clipboard API can reject in an unfocused window or a non-secure
    // context -- silently no-op rather than surface an error for a copy
    // the user may not even notice failed; they can just try again.
  }
}

interface GridCopyMenuState {
  x: number;
  y: number;
  text: string;
}

export function useGridCellCopy() {
  const [menu, setMenu] = useState<GridCopyMenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Dismiss on any click elsewhere, losing window focus, or a resize
  // (a stale menu pinned to a now-wrong position reads as broken, not
  // "still open") -- same "click outside closes it" convention every
  // other context menu in this app already follows.
  useEffect(() => {
    if (!menu) return;
    window.addEventListener("click", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
    };
  }, [menu, closeMenu]);

  const onCellKeyDown = useCallback((e: CellKeyDownEvent) => {
    const ke = e.event as KeyboardEvent | undefined;
    if (!ke || !(ke.ctrlKey || ke.metaKey) || ke.key.toLowerCase() !== "c") return;
    copyText(cellTextValue(e));
  }, []);

  // `suppressContextMenu` (a plain grid option, not gated to the
  // Enterprise ContextMenuModule -- see gridOptions.d.ts's own comment on
  // it) stops the grid from doing anything else with the event so only
  // this custom menu shows; the native browser menu is blocked by this
  // handler's own preventDefault below regardless.
  const onCellContextMenu = useCallback((e: CellContextMenuEvent) => {
    const me = e.event as MouseEvent | undefined;
    if (!me) return;
    me.preventDefault();
    setMenu({ x: me.clientX, y: me.clientY, text: cellTextValue(e) });
  }, []);

  const contextMenu = menu ? (
    <div className="grid-cell-ctx-menu" style={{ left: menu.x, top: menu.y }}>
      <button
        type="button"
        className="grid-cell-ctx-menu-item"
        onClick={() => {
          copyText(menu.text);
          closeMenu();
        }}
      >
        Copy
      </button>
    </div>
  ) : null;

  return { onCellKeyDown, onCellContextMenu, suppressContextMenu: true as const, contextMenu };
}
