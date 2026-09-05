import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { ConfigProvider, Select, Input, InputNumber } from "antd";
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
import type { TextParserParams, TextParseOperation, TextParseOperationType } from "./types";
import type { TextParserWindowPayload } from "./vite-env";
import "./App.css";

// Configure window for the Text Parser node -- Power Query's own no-code
// text-extraction toolset (Transform > Extract, and Split Column by
// Delimiter), for the common cases that don't need a real regex pattern
// (see the Regular Expressions node for that). Same dnd-kit sortable
// operation-card list/round-trips-on-Apply pattern as CleanerWindow.tsx,
// with one structural difference: Cleaner's operations MUTATE an
// existing column in place (so they take a multi-select of target
// columns), while every operation here ADDS new column(s) computed from
// ONE source column (so it's a single-column picker + a "New column
// name" field instead). See backend/app/nodes.py's parse_text for
// exactly what each operation does and which `params` keys it reads.
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
      <p>Connect a data table to start parsing text</p>
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

interface OperationDefinition {
  value: TextParseOperationType;
  label: string;
  params: string[];
}

// Must stay in sync with backend/app/nodes.py's parse_text, the actual
// source of truth for what each one does.
const OPERATIONS: OperationDefinition[] = [
  { value: "text_before", label: "Text Before Delimiter", params: ["delimiter", "occurrence"] },
  { value: "text_after", label: "Text After Delimiter", params: ["delimiter", "occurrence"] },
  { value: "text_between", label: "Text Between Delimiters", params: ["startDelimiter", "startOccurrence", "endDelimiter", "endOccurrence"] },
  { value: "split_delimiter", label: "Split by Delimiter", params: ["delimiter", "splitAt"] },
  { value: "first_chars", label: "First Characters", params: ["count"] },
  { value: "last_chars", label: "Last Characters", params: ["count"] },
  { value: "range", label: "Range (start + length)", params: ["start", "length"] },
];
const OPERATION_OPTIONS = OPERATIONS.map((op) => ({ label: op.label, value: op.value }));

const PARAM_LABELS: Record<string, string> = {
  delimiter: "Delimiter",
  startDelimiter: "Start delimiter",
  endDelimiter: "End delimiter",
  occurrence: "Occurrence",
  startOccurrence: "Start occurrence",
  endOccurrence: "End occurrence",
  splitAt: "Split",
  count: "Characters",
  start: "Start position",
  length: "Length",
};
const PARAM_PLACEHOLDERS: Record<string, string> = {
  delimiter: "e.g. , or /",
  startDelimiter: "e.g. (",
  endDelimiter: "e.g. )",
};

// "First"/"Last"/a specific 1-based occurrence number -- matching how a
// non-programmer would actually describe "which delimiter", not a raw
// index. Picking "Occurrence #" reveals a small number field next to it;
// the resolved value (param.occurrence) is always just "first"/"last"/a
// plain number string either way, so backend/app/nodes.py's own
// _resolve_occurrence never needs to know which UI state produced it.
function OccurrenceInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const isCustom = value !== "" && value !== "first" && value !== "last";
  return (
    <div className="cleaner-param-row">
      <span className="cleaner-param-label">{label}:</span>
      <Select
        style={{ width: 130 }}
        value={isCustom ? "custom" : (value || "first")}
        onChange={(v) => onChange(v === "custom" ? "2" : v)}
        options={[
          { value: "first", label: "First" },
          { value: "last", label: "Last" },
          { value: "custom", label: "Occurrence #" },
        ]}
      />
      {isCustom && (
        <InputNumber style={{ width: 64 }} min={1} value={Number(value) || 1} onChange={(v) => onChange(String(v ?? 1))} />
      )}
    </div>
  );
}

interface ParamInputProps {
  param: string;
  value: unknown;
  onChange: (param: string, value: unknown) => void;
}
const ParamInput = memo(function ParamInput({ param, value, onChange }: ParamInputProps) {
  const handleText = useCallback((e: { target: { value: string } }) => onChange(param, e.target.value), [onChange, param]);
  const handleValue = useCallback((v: string) => onChange(param, v), [onChange, param]);
  const handleNumber = useCallback((v: number | null) => onChange(param, v == null ? "" : String(v)), [onChange, param]);

  if (param === "occurrence" || param === "startOccurrence" || param === "endOccurrence") {
    return <OccurrenceInput label={PARAM_LABELS[param]} value={(value as string) || "first"} onChange={handleValue} />;
  }
  if (param === "splitAt") {
    return (
      <div className="cleaner-param-row">
        <span className="cleaner-param-label">Split:</span>
        <Select
          style={{ width: 170 }}
          value={(value as string) || "each"}
          onChange={handleValue}
          options={[
            { value: "each", label: "At every occurrence" },
            { value: "left", label: "Leftmost occurrence only" },
            { value: "right", label: "Rightmost occurrence only" },
          ]}
        />
      </div>
    );
  }
  if (param === "count" || param === "start" || param === "length") {
    return (
      <div className="cleaner-param-row">
        <span className="cleaner-param-label">{PARAM_LABELS[param]}:</span>
        <InputNumber style={{ width: 80 }} min={0} value={value ? Number(value) : undefined} onChange={handleNumber} placeholder="0" />
      </div>
    );
  }
  // Plain text: delimiter / startDelimiter / endDelimiter
  return (
    <div className="cleaner-param-row">
      <span className="cleaner-param-label">{PARAM_LABELS[param] ?? param}:</span>
      <Input style={{ width: 140 }} value={(value as string) || ""} onChange={handleText} placeholder={PARAM_PLACEHOLDERS[param] ?? ""} />
    </div>
  );
});

interface SortableOperationCardProps {
  operation: TextParseOperation;
  index: number;
  columns: string[];
  isMissing: boolean;
  onColumnChange: (id: string, column: string) => void;
  onOperationChange: (id: string, operationType: TextParseOperationType) => void;
  onParamChange: (id: string, paramName: string, value: unknown) => void;
  onNameChange: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}
const SortableOperationCard = memo(function SortableOperationCard({
  operation, index, columns, isMissing,
  onColumnChange, onOperationChange, onParamChange, onNameChange, onDelete,
}: SortableOperationCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: operation.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const opDef = OPERATIONS.find((o) => o.value === operation.operation);

  const columnOptions = useMemo(() => {
    const opts = columns.map((col) => ({ label: col, value: col }));
    if (isMissing) opts.push({ label: `${operation.column} (not found)`, value: operation.column });
    return opts;
  }, [columns, isMissing, operation.column]);

  const handleColumnChange = useCallback((v: string) => onColumnChange(operation.id, v), [onColumnChange, operation.id]);
  const handleOperationChange = useCallback((v: TextParseOperationType) => onOperationChange(operation.id, v), [onOperationChange, operation.id]);
  const handleParamChange = useCallback((p: string, v: unknown) => onParamChange(operation.id, p, v), [onParamChange, operation.id]);
  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => onNameChange(operation.id, e.target.value), [onNameChange, operation.id]);
  const handleDelete = useCallback(() => onDelete(operation.id), [onDelete, operation.id]);

  return (
    <div ref={setNodeRef} style={style}>
      <div className={`cleaner-op-card${isMissing ? " cleaner-op-card-missing" : ""}`}>
        <div className="cleaner-op-grid">
          <div className="cleaner-drag-handle" {...attributes} {...listeners}>
            {DRAG_HANDLE_ICON}
          </div>
          <div className="cleaner-op-number">{index + 1}</div>
          <Select
            value={operation.column}
            onChange={handleColumnChange}
            style={{ width: "100%" }}
            status={isMissing ? "error" : undefined}
            options={columnOptions}
            placeholder="Source column…"
            showSearch
          />
          <button className="btn btn-ghost btn-icon" onClick={handleDelete} title="Remove operation">
            {TRASH_ICON}
          </button>
          <Select className="cleaner-op-body-item" value={operation.operation} onChange={handleOperationChange} style={{ width: "100%" }} options={OPERATION_OPTIONS} />
          <div className="cleaner-op-body-item cleaner-param-row">
            <span className="cleaner-param-label">{operation.operation === "split_delimiter" ? "Column prefix:" : "New column:"}</span>
            <Input style={{ width: 160 }} value={operation.newColumnName} onChange={handleNameChange} placeholder="Extracted" />
          </div>
          {opDef && opDef.params.length > 0 && (
            <div className="cleaner-op-body-item textparser-param-wrap">
              {opDef.params.map((param) => (
                <ParamInput key={param} param={param} value={operation.params[param as keyof typeof operation.params]} onChange={handleParamChange} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default function TextParserWindow() {
  const [payload, setPayload] = useState<TextParserWindowPayload | null>(null);
  const [operations, setOperations] = useState<TextParseOperation[]>([]);
  const opCounterRef = useRef(0);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: TextParserWindowPayload) {
      if (!live) return;
      setPayload(p);
      const ops = p.initialParams.operations ?? [];
      setOperations(ops);
      const maxId = ops.reduce((max, op) => {
        const m = op.id.match(/^op_(\d+)$/);
        return m ? Math.max(max, parseInt(m[1], 10) + 1) : max;
      }, 0);
      opCounterRef.current = Math.max(maxId, ops.length);
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestTextParserInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onTextParserInit(loadPayload);
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
      setOperations((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  }, []);

  const handleAddOperation = useCallback(() => {
    const columns = payload?.columns ?? [];
    if (columns.length === 0) return;
    setOperations((prev) => [...prev, {
      id: `op_${opCounterRef.current++}`,
      column: columns[0],
      operation: OPERATIONS[0].value,
      params: {},
      newColumnName: "Extracted",
    }]);
  }, [payload]);

  const handleDeleteOperation = useCallback((id: string) => setOperations((ops) => ops.filter((op) => op.id !== id)), []);
  const handleColumnChange = useCallback((id: string, column: string) => setOperations((ops) => ops.map((op) => (op.id === id ? { ...op, column } : op))), []);
  const handleOperationChange = useCallback((id: string, operationType: TextParseOperationType) => setOperations((ops) => ops.map((op) => (op.id === id ? { ...op, operation: operationType, params: {} } : op))), []);
  const handleParamChange = useCallback((id: string, paramName: string, value: unknown) => setOperations((ops) => ops.map((op) => (op.id === id ? { ...op, params: { ...op.params, [paramName]: value } } : op))), []);
  const handleNameChange = useCallback((id: string, name: string) => setOperations((ops) => ops.map((op) => (op.id === id ? { ...op, newColumnName: name } : op))), []);

  const operationIds = useMemo(() => operations.map((op) => op.id), [operations]);
  const columns = payload?.columns ?? [];

  const missingByOp = useMemo(
    () => Object.fromEntries(operations.map((op) => [op.id, !columns.includes(op.column)])),
    [operations, columns],
  );
  const totalMissing = useMemo(() => Object.values(missingByOp).filter(Boolean).length, [missingByOp]);

  if (!payload) return null;
  const showEmpty = columns.length === 0;

  const handleApply = () => {
    const params: TextParserParams = { operations };
    window.alteraStudio.applyTextParser({ nodeId: payload.nodeId, params });
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
                <SortableContext items={operationIds} strategy={verticalListSortingStrategy}>
                  {operations.map((operation, index) => (
                    <SortableOperationCard
                      key={operation.id}
                      operation={operation}
                      index={index}
                      columns={columns}
                      isMissing={missingByOp[operation.id] ?? false}
                      onColumnChange={handleColumnChange}
                      onOperationChange={handleOperationChange}
                      onParamChange={handleParamChange}
                      onNameChange={handleNameChange}
                      onDelete={handleDeleteOperation}
                    />
                  ))}
                </SortableContext>
              </DndContext>
              <button className="btn cleaner-btn-add-op" onClick={handleAddOperation}>
                + Add Parsing Operation
              </button>
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeTextParserWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty || operations.length === 0}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
