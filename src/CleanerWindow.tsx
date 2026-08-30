import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { ConfigProvider, Select, Input } from "antd";
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
import type { CleanerParams, CleaningOperation, CleaningOperationType } from "./types";
import type { CleanerWindowPayload } from "./vite-env";
import "./App.css";

// Configure window for the Cleaner node -- ported from the original
// OWCleaner widget (devkit/orangecontrib/custom/widgets/cleaner.py) and
// its standalone frontend source (devkit/cleaner/src/App.tsx, a dnd-kit
// sortable operation-card list this window reuses almost verbatim). Same
// real-window/round-trips-on-Apply pattern as FilterBuilderWindow.tsx/
// HeaderPromoterWindow.tsx/MergeWindow.tsx/ShiftColumnsWindow.tsx --
// replacing the original's QWebChannel bridge + debounced live auto-push
// (bridge.cleaningChanged on every edit) with this app's own IPC
// (window.alteraStudio) and explicit Apply button. See
// backend/app/nodes.py's clean_columns for exactly what each operation
// does. Unlike the original (which only ever offered Orange
// StringVariable columns), this app has no real column-type system, so
// every column of the connected table is offered here, not just "text"
// ones -- matching Shift Columns' own no-type-filtering convention.
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
      <p>Connect a data table to start cleaning columns</p>
    </div>
  );
}

// Ported verbatim from devkit/cleaner/src/App.tsx's own static icons.
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
  value: CleaningOperationType;
  label: string;
  params: string[];
}

// Same 13 operations, same order, same param lists as devkit/cleaner's own
// OPERATIONS table -- must stay in sync with backend/app/nodes.py's
// _apply_cleaning_operation, which is the actual source of truth for what
// each one does.
const OPERATIONS: OperationDefinition[] = [
  { value: "replace", label: "Find & Replace", params: ["find", "replace", "caseSensitive"] },
  { value: "remove_spaces", label: "Remove Extra Spaces", params: [] },
  { value: "trim", label: "Trim Whitespace", params: [] },
  { value: "remove_special", label: "Remove Special Characters", params: [] },
  { value: "uppercase", label: "Convert to UPPERCASE", params: [] },
  { value: "lowercase", label: "Convert to lowercase", params: [] },
  { value: "titlecase", label: "Convert to Title Case", params: [] },
  { value: "remove_digits", label: "Remove Digits", params: [] },
  { value: "keep_digits", label: "Keep Digits Only", params: [] },
  { value: "remove_punctuation", label: "Remove Punctuation", params: [] },
  { value: "strip_chars", label: "Strip Specific Characters", params: ["chars"] },
  { value: "remove_prefix", label: "Remove Prefix", params: ["prefix"] },
  { value: "remove_suffix", label: "Remove Suffix", params: ["suffix"] },
  { value: "fill_na", label: "Fill Blank/Null Values", params: ["fillValue"] },
];
const OPERATION_OPTIONS = OPERATIONS.map((op) => ({ label: op.label, value: op.value }));

const PARAM_LABELS: Record<string, string> = {
  find: "Find:",
  replace: "Replace with:",
  chars: "Characters:",
  prefix: "Prefix:",
  suffix: "Suffix:",
  fillValue: "Fill with:",
};
const PARAM_PLACEHOLDERS: Record<string, string> = {
  find: "Text to find",
  replace: "Replacement text",
  chars: "e.g., .,!?",
  prefix: "Prefix to remove",
  suffix: "Suffix to remove",
  fillValue: "Replacement value",
};

interface ParamInputProps {
  param: string;
  value: unknown;
  onChange: (param: string, value: unknown) => void;
}
const ParamInput = memo(function ParamInput({ param, value, onChange }: ParamInputProps) {
  const handleCheck = useCallback((e: { target: { checked: boolean } }) => onChange(param, e.target.checked), [onChange, param]);
  const handleText = useCallback((e: { target: { value: string } }) => onChange(param, e.target.value), [onChange, param]);

  if (param === "caseSensitive") {
    // Plain native checkbox + accent-color, matching every other
    // checkbox in the app (Shift Columns'/Unique's column checklists,
    // Column Edit's own list) -- antd's own <Checkbox> renders a visibly
    // different style (its own SVG checkmark/fill) that stood out here
    // as the one inconsistent checkbox in the whole app.
    return (
      <label className="cleaner-checkbox-row">
        <input type="checkbox" checked={(value as boolean) || false} onChange={handleCheck} />
        <span>Case sensitive</span>
      </label>
    );
  }
  return (
    <div className="cleaner-param-row">
      <span className="cleaner-param-label">{PARAM_LABELS[param] ?? param}</span>
      <Input style={{ flex: 1 }} value={(value as string) || ""} onChange={handleText} placeholder={PARAM_PLACEHOLDERS[param] ?? ""} />
    </div>
  );
});

interface SortableOperationCardProps {
  operation: CleaningOperation;
  index: number;
  columns: string[];
  missingCols: string[];
  onColumnsChange: (id: string, columns: string[]) => void;
  onOperationChange: (id: string, operationType: CleaningOperationType) => void;
  onParamChange: (id: string, paramName: string, value: unknown) => void;
  onDelete: (id: string) => void;
}
const SortableOperationCard = memo(function SortableOperationCard({
  operation, index, columns, missingCols,
  onColumnsChange, onOperationChange, onParamChange, onDelete,
}: SortableOperationCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: operation.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const opDef = OPERATIONS.find((o) => o.value === operation.operation);
  const isMissing = missingCols.length > 0;

  const columnOptions = useMemo(() => {
    const opts = columns.map((col) => ({ label: col, value: col }));
    missingCols.forEach((c) => opts.push({ label: `${c} (not found)`, value: c }));
    return opts;
  }, [columns, missingCols]);

  const handleColumnsChange = useCallback((v: string[]) => onColumnsChange(operation.id, v), [onColumnsChange, operation.id]);
  const handleOperationChange = useCallback((v: CleaningOperationType) => onOperationChange(operation.id, v), [onOperationChange, operation.id]);
  const handleParamChange = useCallback((p: string, v: unknown) => onParamChange(operation.id, p, v), [onParamChange, operation.id]);
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
            mode="multiple"
            value={operation.columns}
            onChange={handleColumnsChange}
            style={{ width: "100%" }}
            status={isMissing ? "error" : undefined}
            options={columnOptions}
            placeholder="Select columns…"
            maxTagCount="responsive"
          />
          <button className="btn btn-ghost btn-icon" onClick={handleDelete} title="Remove operation">
            {TRASH_ICON}
          </button>
          <Select className="cleaner-op-body-item" value={operation.operation} onChange={handleOperationChange} style={{ width: "100%" }} options={OPERATION_OPTIONS} />
          {opDef && opDef.params.length > 0 && opDef.params.map((param) => (
            <div key={param} className="cleaner-op-body-item">
              <ParamInput param={param} value={operation.params[param as keyof typeof operation.params]} onChange={handleParamChange} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

export default function CleanerWindow() {
  const [payload, setPayload] = useState<CleanerWindowPayload | null>(null);
  const [operations, setOperations] = useState<CleaningOperation[]>([]);
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
    function loadPayload(p: CleanerWindowPayload) {
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
    window.alteraStudio.requestCleanerInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onCleanerInit(loadPayload);
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
    setOperations((prev) => [...prev, { id: `op_${opCounterRef.current++}`, columns: [columns[0]], operation: OPERATIONS[0].value, params: {} }]);
  }, [payload]);

  const handleDeleteOperation = useCallback((id: string) => setOperations((ops) => ops.filter((op) => op.id !== id)), []);
  const handleColumnsChange = useCallback((id: string, columns: string[]) => setOperations((ops) => ops.map((op) => (op.id === id ? { ...op, columns } : op))), []);
  const handleOperationChange = useCallback((id: string, operationType: CleaningOperationType) => setOperations((ops) => ops.map((op) => (op.id === id ? { ...op, operation: operationType, params: {} } : op))), []);
  const handleParamChange = useCallback((id: string, paramName: string, value: unknown) => setOperations((ops) => ops.map((op) => (op.id === id ? { ...op, params: { ...op.params, [paramName]: value } } : op))), []);

  const operationIds = useMemo(() => operations.map((op) => op.id), [operations]);
  const columns = payload?.columns ?? [];

  const missingColsPerOp = useMemo(
    () => Object.fromEntries(operations.map((op) => [op.id, op.columns.filter((c) => !columns.includes(c))])),
    [operations, columns],
  );
  const totalMissing = useMemo(() => Object.values(missingColsPerOp).reduce((n, cols) => n + cols.length, 0), [missingColsPerOp]);

  if (!payload) return null;
  const showEmpty = columns.length === 0;

  const handleApply = () => {
    const params: CleanerParams = { operations };
    window.alteraStudio.applyCleaner({ nodeId: payload.nodeId, params });
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
                      missingCols={missingColsPerOp[operation.id] ?? []}
                      onColumnsChange={handleColumnsChange}
                      onOperationChange={handleOperationChange}
                      onParamChange={handleParamChange}
                      onDelete={handleDeleteOperation}
                    />
                  ))}
                </SortableContext>
              </DndContext>
              <button className="btn cleaner-btn-add-op" onClick={handleAddOperation}>
                + Add Cleaning Operation
              </button>
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeCleanerWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty || operations.length === 0}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
