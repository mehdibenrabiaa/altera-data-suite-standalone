import DockLayout from "rc-dock";

// rc-dock's drag-over "drop preview" rectangle size (how big the highlighted
// area looks while dragging toward an edge) is controlled by a hardcoded
// `ratio` local variable inside `setDropRect` (rc-dock/lib/DockLayout.js) —
// 0.5 for a plain panel, 0.3 for a box — and isn't exposed as a prop. Our
// whole-screen Canvas tab is the only real top-level drop target, so every
// left/right/top/bottom preview against it showed as half the screen, which
// is misleading: panels actually end up much narrower (see the toolbar's own
// width lock). This reimplements just that ratio at a quarter for drops
// against the Canvas tab specifically; every other drop scenario (float
// preview, tab merge, dropping next to an already-docked sibling) is
// untouched and keeps rc-dock's original sizing.
const CANVAS_TAB_CLASS = "dock-style-canvas-dock-panel";
const NARROW_RATIO = 0.25;

type Direction = "left" | "right" | "top" | "bottom" | "middle" | "float" | "remove" | "before-tab" | "after-tab" | string;

const proto = DockLayout.prototype as any;
const originalSetDropRect = proto.setDropRect;

proto.setDropRect = function patchedSetDropRect(
  element: HTMLElement | null,
  direction: Direction,
  source: any,
  event?: any,
  panelSize: [number, number] = [300, 300],
) {
  // Keep this in sync with the dockMove guard below: without it, dragging
  // the toolbar toward the top/bottom edge would still show a "you can drop
  // here" highlight that then silently does nothing on release.
  if (isRestrictedToolbarDrop(source, direction)) {
    if (this.state.dropRect) this.setState({ dropRect: null });
    return;
  }
  const isNarrowable = direction === "left" || direction === "right" || direction === "top" || direction === "bottom";
  if (element && isNarrowable && element.classList.contains(CANVAS_TAB_CLASS)) {
    const { dropRect } = this.state;
    if (dropRect && dropRect.element === element && dropRect.direction === direction) {
      return; // matches rc-dock's own duplicate-update skip
    }
    const layoutRect = this._ref.getBoundingClientRect();
    const scaleX = this._ref.offsetWidth / layoutRect.width;
    const scaleY = this._ref.offsetHeight / layoutRect.height;
    const elemRect = element.getBoundingClientRect();
    let left = (elemRect.left - layoutRect.left) * scaleX;
    let top = (elemRect.top - layoutRect.top) * scaleY;
    let width = elemRect.width * scaleX;
    let height = elemRect.height * scaleY;
    const ratio = NARROW_RATIO;
    switch (direction) {
      case "right":
        left += width * (1 - ratio);
        width *= ratio;
        break;
      case "left":
        width *= ratio;
        break;
      case "bottom":
        top += height * (1 - ratio);
        height *= ratio;
        break;
      case "top":
        height *= ratio;
        break;
    }
    this.setState({ dropRect: { left, top, width, height, element, source, direction } });
    return;
  }
  return originalSetDropRect.call(this, element, direction, source, event, panelSize);
};

// The *actual* dock (not just its preview above) also always splits 50/50
// against our Canvas tab. rc-dock's DockLayout.dockMove() is a real, mutable
// class method (same technique as setDropRect above) — wrap it to rebalance
// the result down to a quarter *synchronously*, immediately after rc-dock's
// own call returns, only for a fresh drop against the Canvas tab (docking
// next to an already-docked sibling later is untouched).
const CANVAS_TAB_ID = "canvas";
const NARROW_DOCK_RATIO = 0.25;

function isCanvasTabPanel(panelOrBox: any): boolean {
  return !!panelOrBox?.tabs?.some((t: any) => t.id === CANVAS_TAB_ID);
}

// Clones every object along the path from the root down to the rebalanced
// panel (DockBox/DockPanel are PureComponents that shallow-compare props by
// reference, so an in-place mutation would never actually trigger a
// re-render), keeping `.parent` back-references in sync the same way
// rc-dock's own tree-mutation functions do.
function rebalanceDockSize(layout: any, tabId: string): any | null {
  if (!tabId || !layout?.dockbox) return null;
  function withNewBox(box: any, children: any[]): any {
    const newBox = { ...box, children };
    for (const c of children) c.parent = newBox;
    return newBox;
  }
  // rc-dock doesn't always wrap a fresh drop in its own new 2-child box: if the
  // drop lands in a box that already shares the drop's orientation (e.g.
  // docking right when something is already docked left splits the SAME root
  // box into 3+ siblings, rather than nesting a new pair), the target's box
  // can have any number of children with arbitrary existing sizes. Handle the
  // general case: shrink the target's slice to a quarter of the box's total,
  // and redistribute the freed space among its siblings in proportion to
  // their existing sizes (so any pre-existing relative balance between them,
  // e.g. from an earlier rebalance, is preserved rather than reset to equal).
  function withRebalancedChild(box: any, targetChild: any): any {
    const total = box.children.reduce((s: number, c: any) => s + c.size, 0);
    const targetNewSize = total * NARROW_DOCK_RATIO;
    const others = box.children.filter((c: any) => c !== targetChild);
    const othersOldTotal = others.reduce((s: number, c: any) => s + c.size, 0);
    const othersNewTotal = total - targetNewSize;
    const newChildren = box.children.map((c: any) => {
      if (c === targetChild) return { ...c, size: targetNewSize };
      const ratio = othersOldTotal > 0 ? c.size / othersOldTotal : 1 / others.length;
      return { ...c, size: othersNewTotal * ratio };
    });
    return withNewBox(box, newChildren);
  }
  function walk(box: any): any | null {
    if (!box?.children) return null;
    for (const child of box.children) {
      if (Array.isArray(child.tabs)) {
        if (child.tabs.some((t: any) => t.id === tabId)) {
          if (box.children.length < 2 || typeof child.size !== "number") return null;
          return withRebalancedChild(box, child);
        }
      } else {
        const newSubBox = walk(child);
        if (newSubBox) {
          return withNewBox(box, box.children.map((c: any) => (c === child ? newSubBox : c)));
        }
      }
    }
    return null;
  }
  const newDockbox = walk(layout.dockbox);
  if (!newDockbox) return null;
  return { ...layout, dockbox: newDockbox };
}

const originalDockMove = proto.dockMove;
proto.dockMove = function patchedDockMove(source: any, target: any, direction: string, floatPosition?: any) {
  if (isRestrictedToolbarDrop(source, direction)) {
    return; // reject: layout stays exactly as it was, nothing to rebalance
  }
  const targetIsCanvasTab =
    (direction === "left" || direction === "right" || direction === "top" || direction === "bottom") &&
    target && typeof target === "object" && isCanvasTabPanel(target);
  const result = originalDockMove.call(this, source, target, direction, floatPosition);
  if (targetIsCanvasTab) {
    const tabId = source && typeof source === "object"
      ? (Object.prototype.hasOwnProperty.call(source, "tabs") ? source.activeId : source.id)
      : null;
    if (tabId) {
      const live = this.getLayout();
      const rebalanced = rebalanceDockSize(live, tabId);
      if (rebalanced) {
        this.setLayout(rebalanced);
      }
    }
  }
  return result;
};

// The Toolbar is a fixed-width vertical icon column (see the width-lock CSS
// in App.css) — docking it to the top/bottom edge would turn it sideways
// into a useless sliver, since nothing about its content adapts to a
// horizontal layout. rc-dock has no declarative "restrict this panel to
// certain edges" option (only panelLock's style/min-size/flex overrides),
// so this blocks it the same way the two patches above work: intercepting
// the real mutation methods directly. left/right/float/tab-merge and
// dropping next to an existing sibling are all left untouched — only a
// fresh top/bottom edge-of-screen drop for the toolbar tab is rejected.
const TOOLBAR_TAB_ID = "toolbar";
const RESTRICTED_DIRECTIONS = new Set(["top", "bottom"]);

function sourceContainsTabId(source: any, tabId: string): boolean {
  if (!source || typeof source !== "object") return false;
  if (Array.isArray(source.tabs)) return source.tabs.some((t: any) => t.id === tabId);
  return source.id === tabId;
}

function isRestrictedToolbarDrop(source: any, direction: string): boolean {
  return RESTRICTED_DIRECTIONS.has(direction) && sourceContainsTabId(source, TOOLBAR_TAB_ID);
}
