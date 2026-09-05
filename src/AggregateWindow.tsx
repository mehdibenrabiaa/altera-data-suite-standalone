import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { ConfigProvider, Select } from "antd";
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
import type { AggregateParams, AggregateMetric, AggregateType } from "./types";
import type { AggregateWindowPayload } from "./vite-env";
import "./App.css";

// Configure window for the Aggregate node -- Alteryx's own Summarize tool
// (see nodeCatalog.ts's own comment). An ordered list of {column,
// aggregation} metrics, each becoming one column in the single-row
// output (see backend/app/nodes.py's aggregate_columns) -- order here IS
// the output column order, so this is reorderable the same way Text
// Parser's operations are. Same dnd-kit sortable-card-list/round-trips-
// on-Apply pattern as CleanerWindow.tsx/TextParserWindow.tsx/SortWindow.tsx,
// reusing their exact CSS wholesale via the `.cleaner-window` wrapper
// class.
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

// Ported verbatim from CleanerWindow.tsx's own copy -- same empty-state
// icon every Configure/viewer window in the app shares.
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
      <p>Connect a data table to start aggregating</p>
    </div>
  );
}

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

const AGGREGATION_OPTIONS: { value: AggregateType; label: string }[] = [
  { value: "sum", label: "Sum" },
  { value: "average", label: "Average" },
  { value: "count", label: "Count" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
];

interface SortableMetricCardProps {
  entry: AggregateMetric;
  index: number;
  columns: string[];
  isMissing: boolean;
  onColumnChange: (id: string, column: string) => void;
  onAggregationChange: (id: string, aggregation: AggregateType) => void;
  onDelete: (id: string) => void;
}
const SortableMetricCard = memo(function SortableMetricCard({
  entry, index, columns, isMissing, onColumnChange, onAggregationChange, onDelete,
}: SortableMetricCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const columnOptions = useMemo(() => {
    const opts = columns.map((col) => ({ label: col, value: col }));
    if (isMissing) opts.push({ label: `${entry.column} (not found)`, value: entry.column });
    return opts;
  }, [columns, isMissing, entry.column]);

  const handleColumnChange = useCallback((v: string) => onColumnChange(entry.id, v), [onColumnChange, entry.id]);
  const handleAggregationChange = useCallback((v: AggregateType) => onAggregationChange(entry.id, v), [onAggregationChange, entry.id]);
  const handleDelete = useCallback(() => onDelete(entry.id), [onDelete, entry.id]);

  return (
    <div ref={setNodeRef} style={style}>
      <div className={`cleaner-op-card${isMissing ? " cleaner-op-card-missing" : ""}`}>
        <div className="cleaner-op-grid">
          <div className="cleaner-drag-handle" {...attributes} {...listeners}>
            {DRAG_HANDLE_ICON}
          </div>
          <div className="cleaner-op-number">{index + 1}</div>
          <Select
            value={entry.column}
            onChange={handleColumnChange}
            style={{ width: "100%" }}
            status={isMissing ? "error" : undefined}
            options={columnOptions}
            placeholder="Column…"
            showSearch
          />
          <button className="btn btn-ghost btn-icon" onClick={handleDelete} title="Remove metric">
            {TRASH_ICON}
          </button>
          <Select
            className="cleaner-op-body-item"
            value={entry.aggregation}
            onChange={handleAggregationChange}
            style={{ width: "100%" }}
            options={AGGREGATION_OPTIONS}
          />
        </div>
      </div>
    </div>
  );
});

export default function AggregateWindow() {
  const [payload, setPayload] = useState<AggregateWindowPayload | null>(null);
  const [metrics, setMetrics] = useState<AggregateMetric[]>([]);
  const metricCounterRef = useRef(0);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: AggregateWindowPayload) {
      if (!live) return;
      setPayload(p);
      const loaded = p.initialParams.metrics ?? [];
      setMetrics(loaded);
      const maxId = loaded.reduce((max, m) => {
        const match = m.id.match(/^metric_(\d+)$/);
        return match ? Math.max(max, parseInt(match[1], 10) + 1) : max;
      }, 0);
      metricCounterRef.current = Math.max(maxId, loaded.length);
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestAggregateInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onAggregateInit(loadPayload);
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
      setMetrics((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  }, []);

  const handleAddMetric = useCallback(() => {
    const columns = payload?.columns ?? [];
    if (columns.length === 0) return;
    setMetrics((prev) => [...prev, { id: `metric_${metricCounterRef.current++}`, column: columns[0], aggregation: "sum" }]);
  }, [payload]);

  const handleDeleteMetric = useCallback((id: string) => setMetrics((ms) => ms.filter((m) => m.id !== id)), []);
  const handleColumnChange = useCallback((id: string, column: string) => setMetrics((ms) => ms.map((m) => (m.id === id ? { ...m, column } : m))), []);
  const handleAggregationChange = useCallback((id: string, aggregation: AggregateType) => setMetrics((ms) => ms.map((m) => (m.id === id ? { ...m, aggregation } : m))), []);

  const metricIds = useMemo(() => metrics.map((m) => m.id), [metrics]);
  const columns = payload?.columns ?? [];

  const missingByMetric = useMemo(
    () => Object.fromEntries(metrics.map((m) => [m.id, !columns.includes(m.column)])),
    [metrics, columns],
  );
  const totalMissing = useMemo(() => Object.values(missingByMetric).filter(Boolean).length, [missingByMetric]);

  if (!payload) return null;
  const showEmpty = columns.length === 0;

  const handleApply = () => {
    const params: AggregateParams = { metrics };
    window.alteraStudio.applyAggregate({ nodeId: payload.nodeId, params });
  };

  return (
    <ConfigProvider theme={antTheme}>
      <div className="cleaner-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="cleaner-app-outer">
            <div className="cleaner-app">
              {totalMissing > 0 && (
                <div className="cleaner-warn-banner">
                  ⚠ {totalMissing} column reference(s) not found in current data — will be skipped.
                </div>
              )}
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={metricIds} strategy={verticalListSortingStrategy}>
                  {metrics.map((entry, index) => (
                    <SortableMetricCard
                      key={entry.id}
                      entry={entry}
                      index={index}
                      columns={columns}
                      isMissing={missingByMetric[entry.id] ?? false}
                      onColumnChange={handleColumnChange}
                      onAggregationChange={handleAggregationChange}
                      onDelete={handleDeleteMetric}
                    />
                  ))}
                </SortableContext>
              </DndContext>
              <button className="btn cleaner-btn-add-op" onClick={handleAddMetric}>
                + Add Metric
              </button>
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeAggregateWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty || metrics.length === 0}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
