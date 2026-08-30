import { useState, useRef, useEffect } from "react";
import type { DragEvent, MouseEvent, KeyboardEvent, CSSProperties } from "react";
import { Input, ColorPicker } from "antd";
import type { Rectangle, Group, Guide } from "../types";
import { fillAlpha, fillToHex } from "../colorUtils";
import { uniqueRectName } from "../rectUtils";
import unlockedIcon from "../../public/unlocked.svg";

interface GroupsPanelProps {
  groups: Group[];
  rectangles: Rectangle[];
  guides: Guide[];
  selectedIds: string[];
  handleAddGroup: () => void;
  handleToggleGroupHidden: (id: string) => void;
  handleRenameGroup: (id: string, name: string) => void;
  handleDeleteGroup: (id: string) => void;
  handleDuplicateGroup: (id: string) => void;
  handleReorderGroups: (groupId: string, targetId: string, position: "before" | "after", parentId: string | undefined) => void;
  handleNestGroup: (groupId: string, parentId: string) => void;
  handleUnnestGroup: (groupId: string) => void;
  handleToggleRectLocked: (id: string) => void;
  handleToggleRectHidden: (id: string) => void;
  handleToggleGuideLocked: (id: string) => void;
  handleToggleGuideHidden: (id: string) => void;
  handleSelectRect: (id: string) => void;
  handleSelectRects: (ids: string[]) => void;
  handleAssignRectsToGroup: (ids: string[], groupId: string | undefined) => void;
  handleReorderRects: (ids: string[], targetId: string, position: "before" | "after", groupId: string | undefined) => void;
  handleMoveRectsToRootEnd: (ids: string[]) => void;
  handleRenameRect: (id: string, name: string) => void;
  pushHistory: () => void;
  onNameCollision?: (typedName: string, finalName: string) => void;
  handleChangeRectsOpacity: (ids: string[], alpha: number) => void;
  handleChangeRectColor: (id: string, hex: string) => void;
  handleToggleRectsLocked: (ids: string[]) => void;
  pendingEditRectId: string | null;
  clearPendingEditRectId: () => void;
}

const RECT_DRAG_MIME = "application/x-pdf-converter-rect-ids";
const GROUP_DRAG_MIME = "application/x-pdf-converter-group-id";
// Must match `.layer-children`'s TOTAL per-level shift in App.css — its
// padding-left (24px) PLUS its border-left width (2px), since both push a
// nested row's content to the right. Every level of nesting shifts a row by
// exactly this much, and the eye toggle below cancels it out (via its own
// absolute `left`) so all eyes stay in one fixed-position column regardless
// of how deep their row is nested.
const INDENT_PX = 26;

// Mirrors the reference mockup's drag-and-drop model: dragging over a
// group's header (in its vertical center, away from the 5px top/bottom
// edge) highlights it as a "drop into this folder" target; dragging over
// any row's top/bottom edge instead shows a thin insertion line and
// reorders relative to that row (staying within whichever group or
// Unassigned section it belongs to). The group-* kinds mirror the same
// model for dragging a folder itself: "group-nest" drops onto a top-level
// folder's header to nest inside it, "group-line" reorders before/after
// another folder row (inheriting that row's own parent, so this doubles as
// how a folder moves between top-level and nested), and "group-root" drops
// anywhere that isn't a specific folder row to un-nest back to top-level.
type DropIndicator =
  | { kind: "folder"; groupId: string }
  | { kind: "line"; rectId: string; position: "before" | "after"; groupId: string | undefined }
  | { kind: "section"; groupId: string | undefined }
  | { kind: "group-nest"; groupId: string }
  | { kind: "group-line"; groupId: string; position: "before" | "after" }
  | { kind: "group-root" }
  | { kind: "root-end" };

// fa-solid fa-chevron-down, rotated -90deg when collapsed — matches the
// reference mockup's `.group-arrow` / `.group-arrow.collapsed` exactly.
function ExpandArrow({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 448 512" fill="currentColor"
      style={{ transform: expanded ? "none" : "rotate(-90deg)", transition: "transform 200ms" }}
    >
      <path d="M201.4 374.6c12.5 12.5 32.8 12.5 45.3 0l160-160c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 306.7 86.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l160 160z" />
    </svg>
  );
}

// fa-solid fa-chevron-down, matching the reference mockup's Opacity dropdown chevron.
function ChevronDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 448 512" fill="currentColor">
      <path d="M201.4 374.6c12.5 12.5 32.8 12.5 45.3 0l160-160c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 306.7 86.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l160 160z" />
    </svg>
  );
}

// Inline SVGs (not <img>) using the exact fa-solid path data from the
// provided assets, so `fill="currentColor"` picks up the surrounding
// button's grey/hover color instead of always rendering flat black —
// <img>-loaded SVGs can't be recolored via CSS.
function LockGlyph({ height = 12 }: { height?: number }) {
  const width = height * (13.64 / 18);
  return (
    <svg width={width} height={height} viewBox="0 0 13.64 18" fill="none">
      <path
        d="M3.03,7.06v-2.27c0-2.09,1.7-3.79,3.79-3.79s3.79,1.7,3.79,3.79v2.27"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.14,7.06H.5c-.28,0-.5.22-.5.5v9.94c0,.28.22.5.5.5h12.63c.28,0,.5-.22.5-.5V7.56c0-.28-.22-.5-.5-.5ZM6.82,13.94c-.74,0-1.34-.6-1.34-1.34s.6-1.34,1.34-1.34,1.34.6,1.34,1.34-.6,1.34-1.34,1.34Z"
        fill="currentColor"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 640 640" fill="currentColor">
      <path d="M232.7 69.9C237.1 56.8 249.3 48 263.1 48L377 48C390.8 48 403 56.8 407.4 69.9L416 96L512 96C529.7 96 544 110.3 544 128C544 145.7 529.7 160 512 160L128 160C110.3 160 96 145.7 96 128C96 110.3 110.3 96 128 96L224 96L232.7 69.9zM128 208L512 208L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 208zM216 272C202.7 272 192 282.7 192 296L192 488C192 501.3 202.7 512 216 512C229.3 512 240 501.3 240 488L240 296C240 282.7 229.3 272 216 272zM320 272C306.7 272 296 282.7 296 296L296 488C296 501.3 306.7 512 320 512C333.3 512 344 501.3 344 488L344 296C344 282.7 333.3 272 320 272zM424 272C410.7 272 400 282.7 400 296L400 488C400 501.3 410.7 512 424 512C437.3 512 448 501.3 448 488L448 296C448 282.7 437.3 272 424 272z" />
    </svg>
  );
}

// Closed/open folder pair, sharing the same outline path (the folder's back
// flap) — "open" adds a filled front-pocket rect on top of it. Both variants
// are kept mounted at once wherever the state can toggle (a group row's
// thumbnail) and switched purely via CSS `display`, per explicit instruction,
// instead of conditionally rendering one or the other — cheaper than a
// mount/unmount on every expand/collapse.
function FolderClosedIcon({ style, size = 13 }: { style?: CSSProperties; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 19" style={style}>
      <path
        d="M19,18c1.1,0,2-.9,2-2V6c0-1.1-.9-2-2-2h-7.9c-.68,0-1.32-.33-1.69-.9l-.81-1.2c-.37-.56-1-.9-1.67-.9h-3.93c-1.1,0-2,.9-2,2v13c0,1.1.9,2,2,2h16Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function FolderOpenIcon({ style }: { style?: CSSProperties }) {
  return (
    <svg width="13" height="13" viewBox="0 0 22 19" fill="none" style={style}>
      <path
        d="M19,18c1.1,0,2-.9,2-2V6c0-1.1-.9-2-2-2h-7.9c-.68,0-1.32-.33-1.69-.9l-.81-1.2c-.37-.56-1-.9-1.67-.9h-3.93c-1.1,0-2,.9-2,2v13c0,1.1.9,2,2,2h16Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="1.56" y="8" width="19.09" height="9.14" fill="currentColor" />
    </svg>
  );
}

function DuplicateIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 640 640" fill="currentColor">
      <path d="M352 512L128 512L128 288L176 288L176 224L128 224C92.7 224 64 252.7 64 288L64 512C64 547.3 92.7 576 128 576L352 576C387.3 576 416 547.3 416 512L416 464L352 464L352 512zM288 416L512 416C547.3 416 576 387.3 576 352L576 128C576 92.7 547.3 64 512 64L288 64C252.7 64 224 92.7 224 128L224 352C224 387.3 252.7 416 288 416z" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 640 640" fill="currentColor">
      <path d="M320 96C239.2 96 174.5 132.8 127.4 176.6C80.6 220.1 49.3 272 34.4 307.7C31.1 315.6 31.1 324.4 34.4 332.3C49.3 368 80.6 420 127.4 463.4C174.5 507.1 239.2 544 320 544C400.8 544 465.5 507.2 512.6 463.4C559.4 419.9 590.7 368 605.6 332.3C608.9 324.4 608.9 315.6 605.6 307.7C590.7 272 559.4 220 512.6 176.6C465.5 132.9 400.8 96 320 96zM176 320C176 240.5 240.5 176 320 176C399.5 176 464 240.5 464 320C464 399.5 399.5 464 320 464C240.5 464 176 399.5 176 320zM320 256C320 291.3 291.3 320 256 320C244.5 320 233.7 317 224.3 311.6C223.3 322.5 224.2 333.7 227.2 344.8C240.9 396 293.6 426.4 344.8 412.7C396 399 426.4 346.3 412.7 295.1C400.5 249.4 357.2 220.3 311.6 224.3C316.9 233.6 320 244.4 320 256z" />
    </svg>
  );
}

export default function GroupsPanel({
  groups,
  rectangles,
  guides,
  selectedIds,
  handleAddGroup,
  handleToggleGroupHidden,
  handleRenameGroup,
  handleDeleteGroup,
  handleDuplicateGroup,
  handleReorderGroups,
  handleNestGroup,
  handleUnnestGroup,
  handleToggleRectLocked,
  handleToggleRectHidden,
  handleToggleGuideLocked,
  handleToggleGuideHidden,
  handleSelectRect,
  handleSelectRects,
  handleAssignRectsToGroup,
  handleReorderRects,
  handleMoveRectsToRootEnd,
  handleRenameRect,
  pushHistory,
  onNameCollision,
  handleChangeRectsOpacity,
  handleChangeRectColor,
  handleToggleRectsLocked,
  pendingEditRectId,
  clearPendingEditRectId,
}: GroupsPanelProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  // Separate from activeGroupId (the single "New/Duplicate group" target):
  // this is purely which group headers should render as highlighted when a
  // marquee drag swept up more than one of them at once — activeGroupId
  // alone can't represent that since it only ever holds one id.
  const [marqueeSelectedGroupIds, setMarqueeSelectedGroupIds] = useState<string[]>([]);
  const unassigned = rectangles.filter((r) => !r.groupId);

  // Windows-Explorer-style click-drag rubber-band selection over empty space
  // in the list. Hit-testing is done entirely in VIEWPORT coordinates
  // (e.clientX/Y vs. each row's own getBoundingClientRect()) — both sides of
  // that comparison come from the same coordinate space with zero manual
  // scroll-offset math, so it can't drift out of sync with where the rows
  // actually are. Scroll offset only matters for *rendering* the overlay
  // rectangle itself, which is computed separately, purely for display.
  const listRef = useRef<HTMLDivElement | null>(null);
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);
  const marqueeDraggedRef = useRef(false);
  const marqueeViewportRectRef = useRef<{ left: number; top: number; right: number; bottom: number } | null>(null);
  // Set right before a completed drag-select would otherwise be immediately
  // undone: mouseup fires our selection logic first, but the native "click"
  // that follows right after still reaches the list's own onClick (empty-
  // space-click-to-deselect) handler below — without this flag that would
  // wipe out the selection we just made in the same gesture.
  const suppressNextListClickRef = useRef(false);
  const [marqueeRect, setMarqueeRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  // Every row/group currently under the marquee rectangle, live during the
  // drag — rendered with the same look as :hover so dragging over items
  // previews what's about to be selected, the way Explorer's rubber-band
  // does. Cleared (along with the marquee itself) on mouseup.
  const [marqueeHoverIds, setMarqueeHoverIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Shared by the live preview (every mousemove) and the final commit on
    // mouseup — same intersection test, just what happens with the result
    // differs (preview-only vs. actually selecting).
    const findHits = (m: { left: number; top: number; right: number; bottom: number }) => {
      const hitIds: string[] = [];
      const hitGroupIds: string[] = [];
      const hitRectIds = new Set<string>();
      listRef.current!.querySelectorAll<HTMLElement>("[data-select-id]").forEach((el) => {
        const r = el.getBoundingClientRect();
        const intersects = r.left < m.right && r.right > m.left && r.top < m.bottom && r.bottom > m.top;
        if (!intersects) return;
        const id = el.dataset.selectId!;
        hitIds.push(id);
        if (el.dataset.selectKind === "group") {
          hitGroupIds.push(id);
          rectangles.filter((r2) => r2.groupId === id).forEach((r2) => hitRectIds.add(r2.id));
        } else {
          hitRectIds.add(id);
        }
      });
      return { hitIds, hitGroupIds, hitRectIds };
    };

    const onMove = (e: globalThis.MouseEvent) => {
      const start = marqueeStartRef.current;
      if (!start || !listRef.current) return;
      if (!marqueeDraggedRef.current && (Math.abs(e.clientX - start.x) > 3 || Math.abs(e.clientY - start.y) > 3)) {
        marqueeDraggedRef.current = true;
      }
      if (!marqueeDraggedRef.current) return;

      const vLeft = Math.min(start.x, e.clientX);
      const vTop = Math.min(start.y, e.clientY);
      const vRight = Math.max(start.x, e.clientX);
      const vBottom = Math.max(start.y, e.clientY);
      const m = { left: vLeft, top: vTop, right: vRight, bottom: vBottom };
      marqueeViewportRectRef.current = m;

      const containerRect = listRef.current.getBoundingClientRect();
      setMarqueeRect({
        left: vLeft - containerRect.left + listRef.current.scrollLeft,
        top: vTop - containerRect.top + listRef.current.scrollTop,
        width: vRight - vLeft,
        height: vBottom - vTop,
      });
      setMarqueeHoverIds(new Set(findHits(m).hitIds));
    };
    const onUp = () => {
      if (!marqueeStartRef.current) return;
      if (marqueeDraggedRef.current && listRef.current && marqueeViewportRectRef.current) {
        const { hitGroupIds, hitRectIds } = findHits(marqueeViewportRectRef.current);
        setActiveGroupId(hitGroupIds.length === 1 ? hitGroupIds[0] : null);
        setMarqueeSelectedGroupIds(hitGroupIds);
        handleSelectRects(Array.from(hitRectIds));
        suppressNextListClickRef.current = true;
      }
      marqueeStartRef.current = null;
      marqueeDraggedRef.current = false;
      marqueeViewportRectRef.current = null;
      setMarqueeRect(null);
      setMarqueeHoverIds(new Set());
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rectangles]);

  const handleListMouseDown = (e: MouseEvent) => {
    // Only when the mousedown lands on empty space (the container itself,
    // not a row/group bubbling up) — same guard as the existing click-to-
    // deselect handler below.
    if (e.target !== e.currentTarget || e.button !== 0 || !listRef.current) return;
    marqueeStartRef.current = { x: e.clientX, y: e.clientY };
    marqueeDraggedRef.current = false;
  };

  // The canvas context menu's Rename item routes here: it selects the rect
  // (which the auto-expand effect below reacts to) and sets this id, so we
  // just need to flip into that row's edit mode and consume the request.
  useEffect(() => {
    if (!pendingEditRectId) return;
    startEditingRect(pendingEditRectId);
    clearPendingEditRectId();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEditRectId, clearPendingEditRectId]);

  // F2 renames whatever's currently selected — a single layer if one's
  // selected, otherwise the active group (same targeting priority as the
  // Lock/Opacity controls below).
  useEffect(() => {
    const handleF2 = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "F2" || editingId) return;
      if (e.target instanceof HTMLInputElement) return;
      if (selectedIds.length === 1) {
        e.preventDefault();
        setEditingId(selectedIds[0]);
      } else if (selectedIds.length === 0 && activeGroupId) {
        e.preventDefault();
        setEditingId(activeGroupId);
      }
    };
    window.addEventListener("keydown", handleF2);
    return () => window.removeEventListener("keydown", handleF2);
  }, [selectedIds, activeGroupId, editingId]);

  // Mirrors the reference mockup's plain `draggedItem` variable: a mutable
  // ref updated synchronously on every dragover, read synchronously by the
  // drop handler. React state alone isn't safe here — a `setState` call
  // during dragover doesn't take effect until the next render, so a fast
  // drag-then-drop (dispatched faster than React's commit) could read a
  // stale (often null) value in the drop handler and silently no-op.
  const dropIndicatorRef = useRef<DropIndicator | null>(null);
  const [dropIndicator, setDropIndicatorState] = useState<DropIndicator | null>(null);
  const setDropIndicator = (
    next: DropIndicator | null | ((prev: DropIndicator | null) => DropIndicator | null),
  ) => {
    const resolved = typeof next === "function"
      ? (next as (prev: DropIndicator | null) => DropIndicator | null)(dropIndicatorRef.current)
      : next;
    dropIndicatorRef.current = resolved;
    setDropIndicatorState(resolved);
  };

  // The Opacity/Lock control rows act on "whatever is currently active" —
  // Photoshop's model for a selected layer (or the whole selection, if more
  // than one is selected). Falls back to the active group's members when
  // nothing is directly selected, same targeting rule as the Lock control.
  const lockTargetIds = selectedIds.length > 0 ? selectedIds : activeGroupId
    ? rectangles.filter((r) => r.groupId === activeGroupId).map((r) => r.id)
    : [];
  const lockTargetAllLocked = lockTargetIds.length > 0
    && rectangles.filter((r) => lockTargetIds.includes(r.id)).every((r) => r.locked)
    && guides.filter((g) => lockTargetIds.includes(g.id)).every((g) => g.locked);

  const opacityTargetIds = lockTargetIds;
  const opacityTargetRects = rectangles.filter((r) => opacityTargetIds.includes(r.id));
  const opacityPercentages = opacityTargetRects.map((r) => Math.round(fillAlpha(r.fill) * 100));
  const opacityMixed = opacityPercentages.length > 0 && !opacityPercentages.every((p) => p === opacityPercentages[0]);
  const activeOpacityPct = opacityPercentages.length > 0 && !opacityMixed ? opacityPercentages[0] : null;

  const [opacityDropdownOpen, setOpacityDropdownOpen] = useState(false);

  useEffect(() => {
    if (!opacityDropdownOpen) return;
    const onClickOutside = () => setOpacityDropdownOpen(false);
    window.addEventListener("click", onClickOutside);
    return () => window.removeEventListener("click", onClickOutside);
  }, [opacityDropdownOpen]);

  const handleOpacityBoxClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (opacityTargetIds.length === 0) return;
    setOpacityDropdownOpen((o) => !o);
  };

  const handleOpacityDropdownItemClick = (val: number) => {
    if (opacityTargetIds.length > 0) handleChangeRectsOpacity(opacityTargetIds, val / 100);
    setOpacityDropdownOpen(false);
  };

  const toggleExpanded = (id: string) => setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  // Local-only draft for the rect-rename <Input> -- typing no longer
  // touches the real `rectangles` state (and therefore never re-renders
  // the Workflow canvas/edges/etc.) per keystroke, only once on commit.
  // That per-keystroke global update was the actual cause of the "low
  // performance while typing" feeling: even after the identity-vs-name
  // split made it cheap in isolation, it still re-ran this whole panel's
  // (and every other consumer of `rectangles`') render on every character.
  const [renameDraft, setRenameDraft] = useState("");

  // A folder row's click selects its members (so e.g. opacity can be changed
  // for the whole group at once) -- but that same click is also the first
  // half of a double-click on the folder icon/name, which should rename it
  // instead. Debouncing the select by one double-click interval and having
  // the rename dblclick handlers cancel the pending timer (below) lets both
  // gestures coexist without needing stopPropagation to eat the vast
  // majority of the row (the name label alone covers ~90% of its width).
  const groupRowSelectTimerRef = useRef<Record<string, number>>({});
  const scheduleGroupMemberSelect = (g: Group, memberIds: string[]) => {
    clearTimeout(groupRowSelectTimerRef.current[g.id]);
    groupRowSelectTimerRef.current[g.id] = window.setTimeout(() => {
      setActiveGroupId(g.id);
      setMarqueeSelectedGroupIds([]);
      handleSelectRects(memberIds);
    }, 300);
  };
  const cancelGroupMemberSelect = (id: string) => clearTimeout(groupRowSelectTimerRef.current[id]);
  useEffect(() => () => {
    Object.values(groupRowSelectTimerRef.current).forEach(clearTimeout);
  }, []);

  const startEditingRect = (id: string) => {
    const rect = rectangles.find((r) => r.id === id);
    setRenameDraft(rect?.name ?? rect?.id ?? id);
    // One history entry per rename session (there's only one real commit
    // now -- see finalizeRectName below) so Undo cleanly reverts just the
    // name change instead of skipping past it to whatever action was
    // tracked before it.
    pushHistory();
    setEditingId(id);
  };

  // The one and only point a rect rename actually reaches global state --
  // de-dupes the typed draft against every other rect and commits via
  // handleRenameRect. Typing itself only ever touched renameDraft (local,
  // cheap); nothing downstream (Workflow canvas, guides, ...) sees this
  // rename until it lands here.
  const finalizeRectName = (rectId: string) => {
    const rect = rectangles.find((x) => x.id === rectId);
    const deduped = uniqueRectName(renameDraft, rectangles, rectId);
    if (rect && deduped !== (rect.name ?? rect.id)) handleRenameRect(rectId, deduped);
    if (deduped !== renameDraft) onNameCollision?.(renameDraft, deduped);
  };

  // `rectId` is passed only from rect-rename call sites (not group-rename,
  // which shares this same function/editingId state but has no name
  // collision concept).
  const stopEditing = (rectId?: string) => {
    if (rectId) finalizeRectName(rectId);
    setEditingId(null);
  };

  // Set right before programmatically moving `editingId` to the next row (Tab
  // during rename) — unmounting the current rename <Input> fires a native
  // blur, which would otherwise call stopEditing() and immediately cancel out
  // the rename we just started on the next row.
  const skipNextBlurRef = useRef(false);

  // Tab while renaming a layer jumps to the next layer in the same group (or
  // Unassigned) and opens its name for editing too, so a batch of layers can
  // be renamed one after another without repeatedly double-clicking each one.
  const handleRenameKeyDown = (e: KeyboardEvent, r: Rectangle) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // Nothing to revert -- typing never touched real state, only
      // renameDraft, so discarding it here is the whole cancel.
      setEditingId(null);
      return;
    }
    if (e.key === "Enter") {
      stopEditing(r.id);
      return;
    }
    if (e.key !== "Tab") return;
    e.preventDefault();
    const sectionIds = r.groupId
      ? rectangles.filter((x) => x.groupId === r.groupId).map((x) => x.id)
      : unassigned.map((x) => x.id);
    const idx = sectionIds.indexOf(r.id);
    const nextId = idx !== -1 && idx < sectionIds.length - 1 ? sectionIds[idx + 1] : null;
    if (nextId) {
      finalizeRectName(r.id);
      skipNextBlurRef.current = true;
      handleSelectRect(nextId);
      startEditingRect(nextId);
    } else {
      stopEditing(r.id);
    }
  };

  // Flat list of every visible rectangle row, in display order, for
  // Shift-click range selection — spans across group sections and Unassigned
  // the same way a normal file-explorer list would.
  const allVisibleRectIds = [
    ...groups.flatMap((g) => rectangles.filter((r) => r.groupId === g.id).map((r) => r.id)),
    ...unassigned.map((r) => r.id),
  ];
  const lastClickedIdRef = useRef<string | null>(null);

  const handleRowClick = (e: MouseEvent, rectId: string) => {
    setActiveGroupId(null);
    setMarqueeSelectedGroupIds([]);
    if (e.shiftKey && lastClickedIdRef.current) {
      const fromIdx = allVisibleRectIds.indexOf(lastClickedIdRef.current);
      const toIdx = allVisibleRectIds.indexOf(rectId);
      if (fromIdx !== -1 && toIdx !== -1) {
        const [start, end] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
        handleSelectRects(allVisibleRectIds.slice(start, end + 1));
        return; // anchor stays put, so further Shift-clicks extend from it
      }
    }
    if (e.ctrlKey || e.metaKey) {
      handleSelectRects(
        selectedIds.includes(rectId) ? selectedIds.filter((id) => id !== rectId) : [...selectedIds, rectId],
      );
      lastClickedIdRef.current = rectId;
      return;
    }
    lastClickedIdRef.current = rectId;
    handleSelectRect(rectId);
  };

  const handleRectDragStart = (e: DragEvent, rectId: string) => {
    const ids = selectedIds.includes(rectId) && selectedIds.length > 1 ? selectedIds : [rectId];
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(RECT_DRAG_MIME, JSON.stringify(ids));
    setDraggingId(rectId);
  };

  const handleRectDragEnd = () => {
    setDraggingId(null);
    setDropIndicator(null);
  };

  const handleGroupDragStart = (e: DragEvent, groupId: string) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(GROUP_DRAG_MIME, groupId);
    setDraggingGroupId(groupId);
  };

  const handleGroupDragEnd = () => {
    setDraggingGroupId(null);
    setDropIndicator(null);
  };

  // Group header: combines two independent drag sources on the same row —
  // dragging RECTS over it highlights "drop into this folder" (existing
  // behavior, unchanged); dragging a FOLDER over it hit-tests the top/bottom
  // 5px edges for "reorder before/after" vs. the vertical center for "nest
  // inside" (only offered when this row is itself top-level — nesting under
  // an already-nested folder would create a second level of nesting).
  const handleGroupHeaderDragOver = (e: DragEvent, g: Group) => {
    if (e.dataTransfer.types.includes(GROUP_DRAG_MIME)) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const offsetY = e.clientY - rect.top;
      const edge = 5;
      if (offsetY < edge) {
        setDropIndicator({ kind: "group-line", groupId: g.id, position: "before" });
      } else if (offsetY > rect.height - edge) {
        setDropIndicator({ kind: "group-line", groupId: g.id, position: "after" });
      } else if (!g.parentId) {
        setDropIndicator({ kind: "group-nest", groupId: g.id });
      } else {
        setDropIndicator({ kind: "group-line", groupId: g.id, position: offsetY < rect.height / 2 ? "before" : "after" });
      }
      return;
    }
    if (!e.dataTransfer.types.includes(RECT_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropIndicator({ kind: "folder", groupId: g.id });
  };

  // Any rectangle row: top half of the row means "insert before this row",
  // bottom half means "insert after" — reorders within whatever section
  // (group or Unassigned) that row already belongs to.
  const handleRectRowDragOver = (e: DragEvent, rectId: string, groupId: string | undefined) => {
    if (!e.dataTransfer.types.includes(RECT_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const position = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setDropIndicator((prev) =>
      prev?.kind === "line" && prev.rectId === rectId && prev.position === position
        ? prev
        : { kind: "line", rectId, position, groupId },
    );
  };

  // Fallback for empty space within a section (an empty group, or below the
  // last row in Unassigned) — highlights the whole section as the target.
  const handleSectionDragOver = (e: DragEvent, groupId: string | undefined) => {
    if (!e.dataTransfer.types.includes(RECT_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIndicator((prev) => (prev?.kind === "section" && prev.groupId === groupId ? prev : { kind: "section", groupId }));
  };

  const handleDropAnywhere = (e: DragEvent) => {
    e.preventDefault();
    const indicator = dropIndicatorRef.current;
    setDropIndicator(null);
    // Clear both dragging-row dim effects here too, not just in onDragEnd: a
    // successful drop reorders/reparents the dragged row, so React may
    // unmount/replace its DOM node during the resulting re-render before the
    // browser's native `dragend` event has a chance to fire on it — leaving
    // `draggingId`/`draggingGroupId` stuck forever and that row permanently
    // dimmed.
    setDraggingId(null);
    setDraggingGroupId(null);
    if (!indicator) return;

    const rectRaw = e.dataTransfer.getData(RECT_DRAG_MIME);
    if (rectRaw && (indicator.kind === "folder" || indicator.kind === "section" || indicator.kind === "line")) {
      const ids: string[] = JSON.parse(rectRaw);
      if (indicator.kind === "folder" || indicator.kind === "section") {
        handleAssignRectsToGroup(ids, indicator.groupId);
      } else {
        handleReorderRects(ids, indicator.rectId, indicator.position, indicator.groupId);
      }
      return;
    }

    if (rectRaw && indicator.kind === "root-end") {
      const ids: string[] = JSON.parse(rectRaw);
      handleMoveRectsToRootEnd(ids);
      return;
    }

    const groupRaw = e.dataTransfer.getData(GROUP_DRAG_MIME);
    if (groupRaw && (indicator.kind === "group-nest" || indicator.kind === "group-line" || indicator.kind === "group-root")) {
      if (indicator.kind === "group-nest") {
        handleNestGroup(groupRaw, indicator.groupId);
      } else if (indicator.kind === "group-line") {
        const targetGroup = groups.find((g) => g.id === indicator.groupId);
        handleReorderGroups(groupRaw, indicator.groupId, indicator.position, targetGroup?.parentId);
      } else {
        handleUnnestGroup(groupRaw);
      }
    }
  };

  // Extends a nested row's own box (background included) leftward by exactly
  // as much as its ancestors' `.layer-children` indent it, so its background
  // fully reaches under the eye toggle (which sits in a fixed column at the
  // true left edge) instead of leaving a gap where the darker gutter shows
  // through. Content padding grows by the same amount so the row's visible
  // content (after the eye) still lands at the correct indented position.
  const rowExtendStyle = (depth: number): CSSProperties | undefined => {
    if (depth === 0) return undefined;
    const pullback = depth * INDENT_PX;
    return { marginLeft: -pullback, width: `calc(100% + ${pullback}px)`, paddingLeft: 38 + pullback };
  };

  function renderGuideRow(g: Guide, depth: number) {
    return (
      <div key={g.id} className="layer-row-wrap">
        <div
          className={`layer-item guide-item ${selectedIds.includes(g.id) ? "selected" : ""} ${marqueeHoverIds.has(g.id) ? "marquee-hover" : ""}`}
          style={rowExtendStyle(depth)}
          data-select-id={g.id}
          onClick={(e) => { e.stopPropagation(); handleSelectRect(g.id); }}
        >
          <div
            className={`layer-eye ${!g.hidden ? "active" : ""}`}
            onClick={(e) => { e.stopPropagation(); handleToggleGuideHidden(g.id); }}
          >
            <EyeIcon />
          </div>
          <span className="guide-item-dot" style={{ background: g.color }} />
          <span className="guide-item-label">Delimiter</span>
          <div
            className={`layer-lock ${g.locked ? "visible" : ""}`}
            onClick={(e) => { e.stopPropagation(); handleToggleGuideLocked(g.id); }}
          >
            {g.locked ? <LockGlyph height={11} /> : <img src={unlockedIcon} alt="" style={{ height: 11 }} />}
          </div>
        </div>
      </div>
    );
  }

  function renderRectRow(r: Rectangle, depth: number, ancestorHidden: boolean) {
    const isEditing = editingId === r.id;
    const effectivelyHidden = ancestorHidden || !!r.hidden;
    const showLineBefore = dropIndicator?.kind === "line" && dropIndicator.rectId === r.id && dropIndicator.position === "before";
    const showLineAfter = dropIndicator?.kind === "line" && dropIndicator.rectId === r.id && dropIndicator.position === "after";
    // While dragging a multi-selection, dim every selected row, not just the
    // one actually grabbed — makes it visually clear they're moving together.
    const isDraggingRow = draggingId != null && (
      draggingId === r.id ||
      (selectedIds.length > 1 && selectedIds.includes(draggingId) && selectedIds.includes(r.id))
    );
    // Guides are matched by NAME, not by this specific rectangle's id (see
    // the Guide type comment) — so the same delimiter set already applies to
    // every other rectangle sharing this name, not just this one row.
    // Sorted left-to-right so their order here matches their order on the
    // page (first delimiter from the left listed first, and so on).
    const rName = r.name ?? r.id;
    const matchingGuides = guides.filter((g) => g.rectName === rName).sort((a, b) => a.x - b.x);
    const hasGuides = matchingGuides.length > 0;
    const expanded = !collapsed[r.id];
    return (
      <div key={r.id} className="layer-row-wrap">
        {showLineBefore && <div className="drop-line drop-line-before" />}
        <div
          className={`layer-item ${selectedIds.includes(r.id) ? "selected" : ""} ${isDraggingRow ? "dragging" : ""} ${marqueeHoverIds.has(r.id) ? "marquee-hover" : ""}`}
          style={rowExtendStyle(depth)}
          draggable={!isEditing}
          data-select-id={r.id}
          onDragStart={(e) => handleRectDragStart(e, r.id)}
          onDragEnd={handleRectDragEnd}
          onDragOver={(e) => handleRectRowDragOver(e, r.id, r.groupId)}
          onClick={(e) => handleRowClick(e, r.id)}
        >
          <div
            className={`layer-eye ${!effectivelyHidden ? "active" : ""}`}
            onClick={(e) => { e.stopPropagation(); handleToggleRectHidden(r.id); }}
          >
            <EyeIcon />
          </div>
          <div
            className="layer-expand"
            style={{ visibility: hasGuides ? "visible" : "hidden", cursor: hasGuides ? "pointer" : "default" }}
            onClick={hasGuides ? (e) => { e.stopPropagation(); toggleExpanded(r.id); } : undefined}
          >
            {hasGuides && <ExpandArrow expanded={expanded} />}
          </div>
          <ColorPicker
            size="small"
            value={fillToHex(r.fill)}
            onChange={(color) => handleChangeRectColor(r.id, color.toHexString())}
            disabledAlpha
          >
            <div
              className="layer-thumbnail layer-thumbnail-color"
              style={{ background: r.fill, borderColor: r.stroke }}
              onDoubleClick={(e) => { e.stopPropagation(); startEditingRect(r.id); }}
            />
          </ColorPicker>
          {isEditing ? (
            <Input
              size="small"
              autoFocus
              onFocus={(e) => e.target.select()}
              value={renameDraft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={() => {
                if (skipNextBlurRef.current) { skipNextBlurRef.current = false; return; }
                stopEditing(r.id);
              }}
              onKeyDown={(e) => handleRenameKeyDown(e, r)}
              className="layer-name-input"
            />
          ) : (
            <div className="layer-name" onDoubleClick={(e) => { e.stopPropagation(); startEditingRect(r.id); }}>
              {r.name ?? r.id}
            </div>
          )}
          <div
            className={`layer-lock ${r.locked ? "visible" : ""}`}
            onClick={(e) => { e.stopPropagation(); handleToggleRectLocked(r.id); }}
          >
            {r.locked ? <LockGlyph height={12} /> : <img src={unlockedIcon} alt="" style={{ height: 12 }} />}
          </div>
        </div>
        {hasGuides && expanded && (
          <div className="layer-children guide-children">
            {matchingGuides.map((g) => renderGuideRow(g, depth + 1))}
          </div>
        )}
        {showLineAfter && <div className="drop-line drop-line-after" />}
      </div>
    );
  }

  // A folder's own drag-reorder line indicator sits at the same level as its
  // row-wrap sibling (not inside layer-children), same pattern as
  // renderRectRow's before/after lines.
  function renderGroupRow(g: Group, depth: number, ancestorHidden: boolean) {
    const members = rectangles.filter((r) => r.groupId === g.id);
    const childGroups = g.parentId ? [] : groups.filter((cg) => cg.parentId === g.id);
    const effectivelyHidden = ancestorHidden || !!g.hidden;
    const expanded = !collapsed[g.id];
    const isEditingGroup = editingId === g.id;
    const isDraggingRow = draggingGroupId === g.id;
    const showLineBefore = dropIndicator?.kind === "group-line" && dropIndicator.groupId === g.id && dropIndicator.position === "before";
    const showLineAfter = dropIndicator?.kind === "group-line" && dropIndicator.groupId === g.id && dropIndicator.position === "after";
    return (
      <div key={g.id} className="layer-row-wrap">
        {showLineBefore && <div className="drop-line drop-line-before" />}
        <div
          className={`layer-item layer-group ${(activeGroupId === g.id || marqueeSelectedGroupIds.includes(g.id)) ? "selected" : ""} ${isDraggingRow ? "dragging" : ""} ${marqueeHoverIds.has(g.id) ? "marquee-hover" : ""} ${dropIndicator?.kind === "folder" && dropIndicator.groupId === g.id ? "drop-target" : ""} ${dropIndicator?.kind === "group-nest" && dropIndicator.groupId === g.id ? "drop-target" : ""}`}
          style={rowExtendStyle(depth)}
          draggable={!isEditingGroup}
          data-select-id={g.id}
          data-select-kind="group"
          onDragStart={(e) => handleGroupDragStart(e, g.id)}
          onDragEnd={handleGroupDragEnd}
          onClick={() => scheduleGroupMemberSelect(g, members.map((r) => r.id))}
          onDragOver={(e) => handleGroupHeaderDragOver(e, g)}
        >
          <div
            className={`layer-eye ${!effectivelyHidden ? "active" : ""}`}
            onClick={(e) => { e.stopPropagation(); handleToggleGroupHidden(g.id); }}
          >
            <EyeIcon />
          </div>
          <div className="layer-expand" onClick={(e) => { e.stopPropagation(); toggleExpanded(g.id); }}>
            <ExpandArrow expanded={expanded} />
          </div>
          <div
            className="layer-thumbnail"
            onDoubleClick={(e) => {
              e.stopPropagation();
              cancelGroupMemberSelect(g.id);
              setEditingId(g.id);
            }}
          >
            <FolderClosedIcon style={{ display: expanded ? "none" : "block" }} />
            <FolderOpenIcon style={{ display: expanded ? "block" : "none" }} />
          </div>
          {isEditingGroup ? (
            <Input
              size="small"
              autoFocus
              onFocus={(e) => e.target.select()}
              value={g.name}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => handleRenameGroup(g.id, e.target.value)}
              onBlur={() => stopEditing()}
              onKeyDown={(e) => { if (e.key === "Enter") stopEditing(); }}
              className="layer-name-input"
            />
          ) : (
            <div
              className="layer-name"
              onDoubleClick={(e) => {
                e.stopPropagation();
                cancelGroupMemberSelect(g.id);
                setEditingId(g.id);
              }}
            >
              {g.name}
            </div>
          )}
          <div
            className="layer-delete"
            onClick={(e) => { e.stopPropagation(); handleDeleteGroup(g.id); setActiveGroupId((prev) => (prev === g.id ? null : prev)); }}
          >
            <TrashIcon />
          </div>
        </div>

        <div
          className={`layer-children ${expanded ? "" : "hidden"} ${dropIndicator?.kind === "section" && dropIndicator.groupId === g.id ? "drop-target" : ""}`}
          onDragOver={(e) => handleSectionDragOver(e, g.id)}
        >
          {childGroups.length > 0 && childGroups.map((cg) => renderGroupRow(cg, depth + 1, effectivelyHidden))}
          {members.length > 0 && members.map((r) => renderRectRow(r, depth + 1, effectivelyHidden))}
        </div>
        {showLineAfter && <div className="drop-line drop-line-after" />}
      </div>
    );
  }

  return (
    <div className="layers-panel">
      <div className="layers-controls-row layers-controls-row-right">
        <div className="opacity-control">
          <span className="control-label">Opacity:</span>
          <div className="opacity-control-group">
            <div
              className={`opacity-input-box ${opacityTargetIds.length === 0 ? "disabled" : ""}`}
              onClick={handleOpacityBoxClick}
            >
              <span className="control-value">
                {activeOpacityPct !== null ? `${activeOpacityPct}%` : opacityMixed ? "Mixed" : "—"}
              </span>
              <ChevronDown />
            </div>
            {opacityDropdownOpen && opacityTargetIds.length > 0 && (
              <div className="opacity-dropdown-menu">
                {[100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0].map((val) => (
                  <div
                    key={val}
                    className="opacity-dropdown-item"
                    onClick={(e) => { e.stopPropagation(); handleOpacityDropdownItemClick(val); }}
                  >
                    {val}%
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="layers-controls-row layers-controls-row-between">
        <div className="lock-control">
          <span className="control-label">Lock:</span>
          <div className="lock-icons">
            <div
              className={`lock-icon-btn ${lockTargetAllLocked ? "toggled" : ""} ${lockTargetIds.length === 0 ? "disabled" : ""}`}
              onClick={() => lockTargetIds.length > 0 && handleToggleRectsLocked(lockTargetIds)}
              title="All"
            >
              <LockGlyph />
            </div>
          </div>
        </div>
        <div className="group-actions">
          <button className="icon-btn" onClick={handleAddGroup} title="New group">
            <FolderClosedIcon size={11} />
          </button>
          <button
            className="icon-btn"
            disabled={!activeGroupId}
            onClick={() => { if (activeGroupId) handleDuplicateGroup(activeGroupId); }}
            title="Duplicate group"
          >
            <DuplicateIcon />
          </button>
        </div>
      </div>

      <div
        ref={listRef}
        className={`layers-list ${dropIndicator?.kind === "group-root" || dropIndicator?.kind === "root-end" ? "drop-target-root" : ""}`}
        onMouseDown={handleListMouseDown}
        onDrop={handleDropAnywhere}
        onDragOver={(e) => {
          e.preventDefault();
          // Falls through here only when no more specific row/header handler
          // has already claimed the dragover (those call stopPropagation) —
          // i.e. hovering empty space below every row/section while dragging
          // a folder (-> move to top level) or a table (-> pull it out of
          // whatever folder it's in and drop it last, after everything else).
          if (e.dataTransfer.types.includes(GROUP_DRAG_MIME)) {
            setDropIndicator((prev) => (prev?.kind === "group-root" ? prev : { kind: "group-root" }));
          } else if (e.dataTransfer.types.includes(RECT_DRAG_MIME)) {
            setDropIndicator((prev) => (prev?.kind === "root-end" ? prev : { kind: "root-end" }));
          }
        }}
        onClick={(e) => {
          // A completed marquee drag ends with mouseup, immediately followed
          // by the browser's own native "click" on this same element —
          // consume that one click so it doesn't instantly wipe out the
          // selection the drag just made.
          if (suppressNextListClickRef.current) {
            suppressNextListClickRef.current = false;
            return;
          }
          // Only when the click lands on empty space (the container itself,
          // not a row/group bubbling up) — clicking a row/group sets its own
          // selection via its own onClick, which doesn't stopPropagation.
          if (e.target !== e.currentTarget) return;
          setActiveGroupId(null);
          setMarqueeSelectedGroupIds([]);
          handleSelectRects([]);
        }}
      >
        {groups.length === 0 && unassigned.length === 0 && (
          <div className="layers-empty">No tables yet — draw one on the canvas to get started.</div>
        )}

        {groups.filter((g) => !g.parentId).map((g) => renderGroupRow(g, 0, false))}

        {unassigned.length > 0 && (
          <div
            className={`layers-unassigned-section ${dropIndicator?.kind === "section" && dropIndicator.groupId === undefined ? "drop-target" : ""}`}
            onDragOver={(e) => handleSectionDragOver(e, undefined)}
          >
            {unassigned.map((r) => renderRectRow(r, 0, false))}
          </div>
        )}

        {marqueeRect && (
          <div
            className="layers-marquee"
            style={{ left: marqueeRect.left, top: marqueeRect.top, width: marqueeRect.width, height: marqueeRect.height }}
          />
        )}
      </div>
    </div>
  );
}
