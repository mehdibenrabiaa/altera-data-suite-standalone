import { useCallback, useEffect, useRef, useState, memo } from "react";
import { ConfigProvider, Input } from "antd";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ColumnEditParams, ColumnEditEntry } from "./types";
import type { ColumnEditWindowPayload } from "./vite-env";
import "./App.css";

// Configure window for the Column Edit node -- ported from the original
// OWColumnManager widget (devkit/orangecontrib/custom/widgets/
// columns_manager.py), renamed and with its UI adapted to this app's own
// dnd-kit sortable-card convention (CleanerWindow.tsx) rather than the
// original's AG-Grid column-header-drag interface. One ordered list IS
// the entire desired state: drag to reorder, edit a name in place to
// rename (the underlying `field` never changes), trash to delete (moves
// to the Deleted section below, restorable). The original also supported
// adding a brand-new constant-value column -- deliberately left out
// here; it'll get its own dedicated node later instead. Same real-
// window/round-trips-on-Apply pattern as every other Configure window
// here. See backend/app/nodes.py's column_edit for exactly how each
// entry resolves.
const antTheme = {
  token: {
    borderRadius: 0,
    borderRadiusLG: 0,
    borderRadiusSM: 0,
    controlHeight: 28,
    controlHeightSM: 24,
    fontSize: 13,
    fontFamily: '"Google Sans Flex", sans-serif',
    colorBorder: "#e0e0e0",
    colorPrimaryHover: "#bbb",
    colorPrimary: "#FE4D41",
    colorText: "#1a1a1a",
    colorTextPlaceholder: "#999",
    colorBgContainer: "#ffffff",
    motionDurationFast: "0s",
    motionDurationMid: "0s",
    motionDurationSlow: "0s",
  },
};

// Ported verbatim from FilterBuilderWindow.tsx's own copy (originally
// devkit/filter-builder/src/assets/link.svg) -- same empty-state icon
// every Configure/viewer window in the app now shares.
function LinkIcon() {
  return (
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.3 }}>
      <path opacity="0.4" d="M10.9999 7.5V16.5C10.9999 17.05 10.5499 17.5 9.99989 17.5H7.49989C5.97989 17.5 4.60989 16.88 3.60989 15.89C2.66989 14.94 2.05989 13.65 1.99989 12.22C1.87989 9.08 4.61989 6.5 7.76989 6.5H9.99989C10.5499 6.5 10.9999 6.95 10.9999 7.5Z" fill="#292D32" />
      <path opacity="0.4" d="M21.9998 11.78C22.1298 14.93 19.3898 17.5 16.2398 17.5H14.0098C13.4598 17.5 13.0098 17.05 13.0098 16.5V7.5C13.0098 6.95 13.4598 6.5 14.0098 6.5H16.5098C18.0298 6.5 19.3998 7.12 20.3998 8.11C21.3298 9.06 21.9398 10.35 21.9998 11.78Z" fill="#292D32" />
      <path d="M16 12.75H8C7.59 12.75 7.25 12.41 7.25 12C7.25 11.59 7.59 11.25 8 11.25H16C16.41 11.25 16.75 11.59 16.75 12C16.75 12.41 16.41 12.75 16 12.75Z" fill="#292D32" />
    </svg>
  );
}
function EmptyState() {
  return (
    <div className="filter-empty-state">
      <LinkIcon />
      <h3>No Data Connected</h3>
      <p>Connect a data table to reorder, rename, or delete columns</p>
    </div>
  );
}

// Ported verbatim from CleanerWindow.tsx's own static icons.
const DRAG_HANDLE_ICON = (
  <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
    <circle cx="3" cy="2" r="1.5" />
    <circle cx="9" cy="2" r="1.5" />
    <circle cx="3" cy="7" r="1.5" />
    <circle cx="9" cy="7" r="1.5" />
    <circle cx="3" cy="12" r="1.5" />
    <circle cx="9" cy="12" r="1.5" />
  </svg>
);
const TRASH_ICON = (
  <svg width="13" height="13" viewBox="0 0 640 640" fill="currentColor">
    <path d="M232.7 69.9C237.1 56.8 249.3 48 263.1 48L377 48C390.8 48 403 56.8 407.4 69.9L416 96L512 96C529.7 96 544 110.3 544 128C544 145.7 529.7 160 512 160L128 160C110.3 160 96 145.7 96 128C96 110.3 110.3 96 128 96L224 96L232.7 69.9zM128 208L512 208L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 208zM216 272C202.7 272 192 282.7 192 296L192 488C192 501.3 202.7 512 216 512C229.3 512 240 501.3 240 488L240 296C240 282.7 229.3 272 216 272zM320 272C306.7 272 296 282.7 296 296L296 488C296 501.3 306.7 512 320 512C333.3 512 344 501.3 344 488L344 296C344 282.7 333.3 272 320 272zM424 272C410.7 272 400 282.7 400 296L400 488C400 501.3 410.7 512 424 512C437.3 512 448 501.3 448 488L448 296C448 282.7 437.3 272 424 272z" />
  </svg>
);

interface SortableColumnRowProps {
  entry: ColumnEditEntry;
  index: number;
  onRename: (field: string, name: string) => void;
  onDelete: (field: string) => void;
}
const SortableColumnRow = memo(function SortableColumnRow({ entry, index, onRename, onDelete }: SortableColumnRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.field });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="column-edit-row">
      <div className="column-edit-drag-handle" {...attributes} {...listeners}>{DRAG_HANDLE_ICON}</div>
      <div className="column-edit-number">{index + 1}</div>
      <Input
        value={entry.name}
        onChange={(e) => onRename(entry.field, e.target.value)}
        style={{ flex: 1 }}
      />
      <button className="btn btn-ghost btn-icon" onClick={() => onDelete(entry.field)} title="Delete column">
        {TRASH_ICON}
      </button>
    </div>
  );
});

export default function ColumnEditWindow() {
  const [payload, setPayload] = useState<ColumnEditWindowPayload | null>(null);
  const [columns, setColumns] = useState<ColumnEditEntry[]>([]);
  const [deletedColumns, setDeletedColumns] = useState<ColumnEditEntry[]>([]);
  // Mirrors of the two lists above, kept current via the effect below --
  // lets handleDelete/handleRestore read "the other" list's current
  // contents without needing it in their own useCallback deps, so their
  // identity stays stable across renders (same "stable per-card
  // handlers" reasoning CleanerWindow.tsx's own comment explains, which
  // matters here since SortableColumnRow is memoized).
  const columnsRef = useRef(columns);
  const deletedColumnsRef = useRef(deletedColumns);
  useEffect(() => { columnsRef.current = columns; }, [columns]);
  useEffect(() => { deletedColumnsRef.current = deletedColumns; }, [deletedColumns]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: ColumnEditWindowPayload) {
      if (!live) return;
      setPayload(p);
      // Reconcile the saved list against the CURRENT input's actual
      // columns every time this opens, not just the first time -- unlike
      // every other Configure window here, this one's own editable list
      // doubles as both "what's saved" and "what's available", so
      // without this a column that showed up later (the upstream got
      // rewired to a different node, or an upstream node like Horizontal
      // Stack started emitting a new column) would silently never appear
      // here again, no matter how many times the window is reopened --
      // reported as exactly that: a real column ("Rate") present on the
      // actual current input just missing from the list. Saved entries
      // whose field no longer exists get dropped (the backend already
      // treats a still-referenced-but-missing field as a skip+warning,
      // but there's no reason to keep showing it here once it's gone);
      // any column on the current input NOT already referenced by a
      // saved entry gets appended, in the order it appears on the input.
      const saved = p.initialParams.columns;
      const savedDeleted = p.initialParams.deletedColumns ?? [];
      const available = new Set(p.columns);
      // Must include deleted fields too -- otherwise a deleted column
      // that's still present upstream looks "not yet referenced" and
      // gets re-appended to the active list below, so it shows up both
      // there AND in the deleted list at once.
      const referenced = new Set([...saved.map((e) => e.field), ...savedDeleted.map((e) => e.field)]);
      setColumns([
        ...saved.filter((e) => available.has(e.field)),
        ...p.columns.filter((c) => !referenced.has(c)).map((c) => ({ field: c, name: c })),
      ]);
      setDeletedColumns(savedDeleted.filter((e) => available.has(e.field)));
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestColumnEditInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onColumnEditInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Configure — ${payload.nodeName}` : "Configure Node";
  }, [payload]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setColumns((items) => {
        const oldIndex = items.findIndex((e) => e.field === active.id);
        const newIndex = items.findIndex((e) => e.field === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  }, []);

  const handleRename = useCallback((field: string, name: string) => {
    setColumns((prev) => prev.map((e) => (e.field === field ? { ...e, name } : e)));
  }, []);
  // Deliberately NOT a functional setColumns((prev) => { ...; setDeletedColumns(...); return ... })
  // -- React 19 StrictMode double-invokes a functional updater in dev to
  // catch impure ones, so a setState call nested inside another
  // updater's body fires twice even though the outer update itself
  // applies once. Read the entry from the current `columns`/
  // `deletedColumns` state directly instead, and fire both updates as
  // separate, independent (pure) calls. Reported as exactly that: one
  // Delete click produced two entries in the Deleted list.
  const handleDelete = useCallback((field: string) => {
    const entry = columnsRef.current.find((e) => e.field === field);
    if (!entry) return;
    setColumns((prev) => prev.filter((e) => e.field !== field));
    setDeletedColumns((prev) => [...prev, entry]);
  }, []);
  const handleRestore = useCallback((field: string) => {
    const entry = deletedColumnsRef.current.find((e) => e.field === field);
    if (!entry) return;
    setDeletedColumns((prev) => prev.filter((e) => e.field !== field));
    setColumns((prev) => [...prev, entry]);
  }, []);

  const columnIds = columns.map((e) => e.field);

  if (!payload) return null;
  const showEmpty = payload.columns.length === 0;

  const handleApply = () => {
    const params: ColumnEditParams = { columns, deletedColumns };
    window.alteraStudio.applyColumnEdit({ nodeId: payload.nodeId, params });
  };

  return (
    <ConfigProvider theme={antTheme}>
      <div className="column-edit-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="column-edit-app-outer">
            <div className="column-edit-app">
              <div className="column-edit-section">
                <div className="column-edit-section-label">Columns</div>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={columnIds} strategy={verticalListSortingStrategy}>
                    {columns.map((entry, index) => (
                      <SortableColumnRow
                        key={entry.field}
                        entry={entry}
                        index={index}
                        onRename={handleRename}
                        onDelete={handleDelete}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
              </div>

              {deletedColumns.length > 0 && (
                <div className="column-edit-section">
                  <div className="column-edit-section-label">Deleted columns</div>
                  <div className="column-edit-deleted-list">
                    {deletedColumns.map((entry) => (
                      <div key={entry.field} className="column-edit-deleted-row">
                        <span className="column-edit-deleted-name">{entry.name}</span>
                        <button className="column-edit-restore-btn" onClick={() => handleRestore(entry.field)}>Restore</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeColumnEditWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
