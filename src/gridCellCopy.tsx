import { useCallback, useEffect, useRef, useState } from "react";
import type { CellContextMenuEvent, CellKeyDownEvent, CellMouseDownEvent, CellMouseOverEvent, GridApi, GridReadyEvent } from "ag-grid-community";

// Ctrl+C-to-copy, a right-click "Copy" menu, AND Excel-style click-and-
// drag range selection for a block of cells -- shared by every grid in
// the app (BrowseWindow.tsx, SchemaView.tsx's output drawer,
// RegexWindow.tsx, HeaderPromoterWindow.tsx). Hand-built rather than
// using AG-Grid's own range-selection/clipboard/context-menu features
// because ALL THREE are Enterprise-only modules in the installed
// ag-grid-community version (CellSelectionModule/ClipboardModule/
// ContextMenuModule -- confirmed in the package's own
// ENTERPRISE_MODULE_NAMES list), and this app only has the free
// Community edition (no ag-grid-enterprise package, no license key, and
// npm installs are blocked in this environment regardless).
//
// Range tracking: onCellMouseDown sets an anchor cell (Shift+click
// extends the EXISTING anchor instead of resetting it, matching Excel);
// onCellMouseOver, while the mouse button is held, moves the far corner.
// The rectangular bounds between anchor and far-corner are recomputed
// from the grid's own CURRENT displayed column order (api.
// getAllDisplayedColumns()) every time either moves, then
// api.refreshCells({force:true}) re-invokes rangeCellClass on every
// cell so the highlight (and its perimeter border, for the Excel-style
// outline) repaints. Not scoped to just the changed cells -- simpler,
// and fine for this app's grid sizes (sample previews / moderate real
// tables); an exact-diff refresh would be the next optimization if a
// huge table ever made this feel slow.
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

interface CellCoord {
  rowIndex: number;
  colId: string;
}

interface RangeBounds {
  minRow: number;
  maxRow: number;
  colIds: string[];
}

const ROW_NUMBER_COL_ID = "__rowNumber";

export function useGridCellCopy() {
  const [menu, setMenu] = useState<GridCopyMenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const gridApiRef = useRef<GridApi | null>(null);
  const anchorRef = useRef<CellCoord | null>(null);
  const activeRef = useRef<CellCoord | null>(null);
  const isDraggingRef = useRef(false);
  const boundsRef = useRef<RangeBounds | null>(null);

  const onGridReady = useCallback((e: GridReadyEvent) => {
    gridApiRef.current = e.api;
  }, []);

  // Bounds are recomputed from the grid's own displayed column ORDER (not
  // colId string comparison) so the range is correct regardless of which
  // direction the drag went in either axis, and the row-number gutter
  // column is never itself part of a range.
  const recomputeBounds = useCallback(() => {
    const api = gridApiRef.current;
    const anchor = anchorRef.current;
    const active = activeRef.current;
    if (!api || !anchor || !active) {
      boundsRef.current = null;
      return;
    }
    const displayedCols = api.getAllDisplayedColumns().map((c) => c.getColId()).filter((id) => id !== ROW_NUMBER_COL_ID);
    const anchorIdx = displayedCols.indexOf(anchor.colId);
    const activeIdx = displayedCols.indexOf(active.colId);
    if (anchorIdx === -1 || activeIdx === -1) {
      boundsRef.current = null;
      return;
    }
    const [loIdx, hiIdx] = anchorIdx <= activeIdx ? [anchorIdx, activeIdx] : [activeIdx, anchorIdx];
    boundsRef.current = {
      minRow: Math.min(anchor.rowIndex, active.rowIndex),
      maxRow: Math.max(anchor.rowIndex, active.rowIndex),
      colIds: displayedCols.slice(loIdx, hiIdx + 1),
    };
  }, []);

  const refresh = useCallback(() => {
    gridApiRef.current?.refreshCells({ force: true });
  }, []);

  const onCellMouseDown = useCallback((e: CellMouseDownEvent) => {
    const me = e.event as MouseEvent | undefined;
    if (me && me.button !== 0) return; // left button only
    const colId = e.column.getColId();
    if (colId === ROW_NUMBER_COL_ID) return;
    const coord: CellCoord = { rowIndex: e.rowIndex ?? 0, colId };
    if (me?.shiftKey && anchorRef.current) {
      activeRef.current = coord;
    } else {
      anchorRef.current = coord;
      activeRef.current = coord;
    }
    isDraggingRef.current = true;
    recomputeBounds();
    refresh();
  }, [recomputeBounds, refresh]);

  const onCellMouseOver = useCallback((e: CellMouseOverEvent) => {
    if (!isDraggingRef.current) return;
    const colId = e.column.getColId();
    if (colId === ROW_NUMBER_COL_ID) return;
    activeRef.current = { rowIndex: e.rowIndex ?? 0, colId };
    recomputeBounds();
    refresh();
  }, [recomputeBounds, refresh]);

  useEffect(() => {
    const onMouseUp = () => { isDraggingRef.current = false; };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  // Merged into columnDefs/defaultColDef by every consumer below --
  // stable identity (empty deps, reads only refs) so it never forces AG-
  // Grid to treat column defs as "changed" on its own account.
  const rangeCellClass = useCallback((params: { node: { rowIndex: number | null }; column: { getColId(): string } }) => {
    const b = boundsRef.current;
    if (!b) return "";
    const rowIndex = params.node.rowIndex;
    const colId = params.column.getColId();
    if (rowIndex == null || rowIndex < b.minRow || rowIndex > b.maxRow) return "";
    const colPos = b.colIds.indexOf(colId);
    if (colPos === -1) return "";
    if (b.minRow === b.maxRow && b.colIds.length === 1) return ""; // a plain single-cell click isn't a "range"
    const classes = ["grid-range-cell"];
    if (rowIndex === b.minRow) classes.push("grid-range-top");
    if (rowIndex === b.maxRow) classes.push("grid-range-bottom");
    if (colPos === 0) classes.push("grid-range-left");
    if (colPos === b.colIds.length - 1) classes.push("grid-range-right");
    return classes.join(" ");
  }, []);

  // Builds the current range as Excel-paste-ready tab/newline-separated
  // text, in the grid's own DISPLAYED row order (so it matches whatever's
  // currently on screen, sorted or not) -- null when there's no real
  // (more-than-one-cell) range active.
  const rangeText = useCallback((): string | null => {
    const api = gridApiRef.current;
    const b = boundsRef.current;
    if (!api || !b) return null;
    if (b.minRow === b.maxRow && b.colIds.length === 1) return null;
    const lines: string[] = [];
    for (let r = b.minRow; r <= b.maxRow; r++) {
      const node = api.getDisplayedRowAtIndex(r);
      if (!node) continue;
      lines.push(b.colIds.map((colId) => {
        const value = api.getCellValue({ rowNode: node, colKey: colId });
        return value == null ? "" : String(value);
      }).join("\t"));
    }
    return lines.join("\n");
  }, []);

  const onCellKeyDown = useCallback((e: CellKeyDownEvent) => {
    const ke = e.event as KeyboardEvent | undefined;
    if (!ke || !(ke.ctrlKey || ke.metaKey) || ke.key.toLowerCase() !== "c") return;
    copyText(rangeText() ?? cellTextValue(e));
  }, [rangeText]);

  // `suppressContextMenu` (a plain grid option, not gated to the
  // Enterprise ContextMenuModule -- see gridOptions.d.ts's own comment on
  // it) stops the grid from doing anything else with the event so only
  // this custom menu shows; the native browser menu is blocked by this
  // handler's own preventDefault below regardless.
  const onCellContextMenu = useCallback((e: CellContextMenuEvent) => {
    const me = e.event as MouseEvent | undefined;
    if (!me) return;
    me.preventDefault();
    // Right-clicking a cell that's part of the current multi-cell range
    // copies the whole range (Excel's own behavior); right-clicking
    // outside it copies just that one cell.
    const b = boundsRef.current;
    const colId = e.column.getColId();
    const insideRange = b && colId !== ROW_NUMBER_COL_ID && e.rowIndex != null
      && e.rowIndex >= b.minRow && e.rowIndex <= b.maxRow && b.colIds.includes(colId);
    setMenu({ x: me.clientX, y: me.clientY, text: (insideRange ? rangeText() : null) ?? cellTextValue(e) });
  }, [rangeText]);

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

  return {
    onCellKeyDown, onCellContextMenu, suppressContextMenu: true as const, contextMenu,
    onGridReady, onCellMouseDown, onCellMouseOver, rangeCellClass,
  };
}
