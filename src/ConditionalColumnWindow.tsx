import { useCallback, useEffect, useRef, useState } from "react";
import { ConfigProvider, Select, Input, InputNumber, AutoComplete } from "antd";
import type { InputRef } from "antd";
import type { ConditionalColumnClause, ConditionalColumnParams, FilterCondition, FilterConditionValue, FilterGroup, FilterOperator } from "./types";
import type { ConditionalColumnWindowPayload } from "./vite-env";
import { getFormulaCompletionContext, FORMULA_FUNCTIONS } from "./formulaHighlight";
import "./App.css";

// Power Query's own "Add Conditional Column" -- the low-code sibling of
// the formula-based Add Column (now surfaced as "Formula"): an ORDERED
// list of clauses, each a Filter Builder-style condition group, paired
// with the value to output when it matches; first matching clause wins,
// with a required "Otherwise" value for every row that matches none.
// Deliberately reuses FilterBuilderWindow.tsx's own condition-editing UI
// wholesale -- same column/operator/value row, same AND/OR group toggle,
// same CSS (this window's outer wrapper is literally still
// ".filter-builder-window", not a new class, so every one of that
// window's existing single-scoped rules -- .filter-group, .filter-row,
// .btn, .inp, etc -- apply here with zero new CSS needed). Only real
// additions over Filter Builder: each clause has its own output value,
// clauses are ordered (first match wins, not OR'd together like Filter
// Builder's groups), and there's a trailing "Otherwise" default.
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
    paddingSM: 8,
    motionDurationFast: "0s",
    motionDurationMid: "0s",
    motionDurationSlow: "0s",
  },
};

const DEFINITION_OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: "is_defined", label: "Is defined" },
  { value: "is_not_defined", label: "Is not defined" },
];
const OPERATORS: Record<"float" | "text" | "categorical", { value: FilterOperator; label: string }[]> = {
  float: [
    ...DEFINITION_OPERATORS,
    { value: "equals", label: "Equals" },
    { value: "not_equals", label: "Not Equals" },
    { value: "greater_than", label: "Greater Than" },
    { value: "less_than", label: "Less Than" },
    { value: "greater_or_equal", label: "Greater or Equal" },
    { value: "less_or_equal", label: "Less or Equal" },
    { value: "between", label: "Between" },
  ],
  text: [
    ...DEFINITION_OPERATORS,
    { value: "equals", label: "Equals" },
    { value: "not_equals", label: "Not Equals" },
    { value: "contains", label: "Contains" },
    { value: "not_contains", label: "Does Not Contain" },
    { value: "starts_with", label: "Starts With" },
    { value: "ends_with", label: "Ends With" },
  ],
  categorical: [
    ...DEFINITION_OPERATORS,
    { value: "equals", label: "Equals" },
    { value: "not_equals", label: "Not Equals" },
  ],
};

function isBetweenValue(value: FilterConditionValue): value is { from: number | string | null; to: number | string | null } {
  return typeof value === "object" && value !== null && "from" in value;
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 640 640" fill="currentColor">
      <path d="M232.7 69.9C237.1 56.8 249.3 48 263.1 48L377 48C390.8 48 403 56.8 407.4 69.9L416 96L512 96C529.7 96 544 110.3 544 128C544 145.7 529.7 160 512 160L128 160C110.3 160 96 145.7 96 128C96 110.3 110.3 96 128 96L224 96L232.7 69.9zM128 208L512 208L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 208zM216 272C202.7 272 192 282.7 192 296L192 488C192 501.3 202.7 512 216 512C229.3 512 240 501.3 240 488L240 296C240 282.7 229.3 272 216 272zM320 272C306.7 272 296 282.7 296 296L296 488C296 501.3 306.7 512 320 512C333.3 512 344 501.3 344 488L344 296C344 282.7 333.3 272 320 272zM424 272C410.7 272 400 282.7 400 296L400 488C400 501.3 410.7 512 424 512C437.3 512 448 501.3 448 488L448 296C448 282.7 437.3 272 424 272z" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
      <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
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
      <p>Connect a data table to add a conditional column</p>
    </div>
  );
}

function ConditionRow({
  condition,
  clauseId,
  columnDefinitions,
  onDeleteCondition,
  onUpdateColumn,
  onUpdateOperator,
  onUpdateValue,
}: {
  condition: FilterCondition;
  clauseId: string;
  columnDefinitions: ConditionalColumnWindowPayload["inputColumns"];
  onDeleteCondition: (clauseId: string, conditionId: string) => void;
  onUpdateColumn: (clauseId: string, conditionId: string, columnName: string) => void;
  onUpdateOperator: (clauseId: string, conditionId: string, operator: FilterOperator) => void;
  onUpdateValue: (clauseId: string, conditionId: string, value: FilterConditionValue) => void;
}) {
  const columnDef = columnDefinitions.find((col) => col.name === condition.column);
  const columnType = columnDef?.type || "text";
  const operators = OPERATORS[columnType] || [];
  const needsValue = !condition.operator.startsWith("is_");

  const columnOptions = columnDefinitions.map((col) => ({ value: col.name, label: col.name }));
  const operatorOptions = operators.map((op) => ({ value: op.value, label: op.label }));

  const renderValue = () => {
    if (!needsValue) return <div style={{ flex: 1 }} />;

    if (columnType === "categorical") {
      return (
        <div className="val-wrap">
          <Select
            style={{ width: "100%" }}
            value={typeof condition.value === "string" ? condition.value || undefined : undefined}
            onChange={(v) => onUpdateValue(clauseId, condition.id, v)}
            placeholder="Select value…"
            showSearch
            filterOption={(input, option) => String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
            options={(columnDef?.values || []).map((v) => ({ value: v, label: v }))}
          />
        </div>
      );
    }

    if (columnType === "float") {
      if (condition.operator === "between") {
        const between = isBetweenValue(condition.value) ? condition.value : { from: "", to: "" };
        return (
          <div className="val-wrap">
            <InputNumber
              style={{ flex: 1, minWidth: 0, width: "100%" }}
              value={between.from ?? ""}
              onChange={(v) => onUpdateValue(clauseId, condition.id, { ...between, from: v })}
              placeholder="From…"
            />
            <InputNumber
              style={{ flex: 1, minWidth: 0, width: "100%" }}
              value={between.to ?? ""}
              onChange={(v) => onUpdateValue(clauseId, condition.id, { ...between, to: v })}
              placeholder="To…"
            />
          </div>
        );
      }
      return (
        <div className="val-wrap">
          <InputNumber
            style={{ width: "100%" }}
            value={typeof condition.value === "number" || typeof condition.value === "string" ? condition.value : ""}
            onChange={(v) => onUpdateValue(clauseId, condition.id, v)}
            placeholder="Enter number…"
          />
        </div>
      );
    }

    const suggestions = (columnDef?.values || []).map((v) => ({ value: v }));
    const textValue = typeof condition.value === "string" ? condition.value : "";
    return (
      <div className="val-wrap">
        {suggestions.length > 0 ? (
          <AutoComplete
            style={{ width: "100%" }}
            options={suggestions}
            value={textValue}
            onChange={(v) => onUpdateValue(clauseId, condition.id, v)}
            placeholder="Type to search…"
            filterOption={(input, option) => String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())}
          />
        ) : (
          <Input
            style={{ width: "100%" }}
            value={textValue}
            onChange={(e) => onUpdateValue(clauseId, condition.id, e.target.value)}
            placeholder="Enter value…"
          />
        )}
      </div>
    );
  };

  return (
    <div className="filter-row">
      <div className="filter-row-inner">
        <Select
          className="col-select"
          style={{ width: 180, flexShrink: 0 }}
          value={condition.column}
          onChange={(v) => onUpdateColumn(clauseId, condition.id, v)}
          showSearch
          filterOption={(input, option) => String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
          options={columnOptions}
        />
        <Select
          style={{ width: 155, flexShrink: 0 }}
          value={condition.operator}
          onChange={(v) => onUpdateOperator(clauseId, condition.id, v)}
          options={operatorOptions}
        />
        {renderValue()}
        <button className="btn btn-ghost btn-icon" onClick={() => onDeleteCondition(clauseId, condition.id)} title="Remove condition">
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}

// A plain single-line Input with column/function autocomplete for the
// "Then set to"/"Otherwise" fields -- these now accept a literal value OR
// a formula (see backend/app/nodes.py's _resolve_output_values), so
// they get the same [Column reference and function-name completion the
// Formula node's own formula box has, reusing its exact detection logic
// (getFormulaCompletionContext) rather than a fresh implementation. Kept
// deliberately simpler than that box's own popup: no syntax highlighting,
// no caret-position math -- a single-line input's own bounding box is
// already exactly where a dropdown should hang, so there's no need to
// measure where the caret itself sits like the multi-line editor does.
function ColumnRefInput({
  value,
  onChange,
  columns,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  columns: string[];
  placeholder?: string;
}) {
  const inputRef = useRef<InputRef>(null);
  const [cursorPos, setCursorPos] = useState(0);
  const [open, setOpen] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const ctx = open ? getFormulaCompletionContext(value, cursorPos) : null;
  const items = ctx?.kind === "column"
    ? columns.filter((c) => c.toLowerCase().includes(ctx.query.toLowerCase()))
    : ctx?.kind === "function"
      ? FORMULA_FUNCTIONS.filter((f) => f.startsWith(ctx.query.toUpperCase()))
      : [];
  const popupVisible = ctx !== null && items.length > 0;

  useEffect(() => { setSelectedIndex(0); }, [items.join(" ")]);

  const syncCursor = (el: HTMLInputElement | null) => {
    setCursorPos(el?.selectionStart ?? 0);
    setOpen(true);
  };

  const insert = (text: string) => {
    if (!ctx) return;
    const insertText = ctx.kind === "column" ? `[${text}]` : `${text}(`;
    const next = value.slice(0, ctx.from) + insertText + value.slice(cursorPos);
    onChange(next);
    const newCursor = ctx.from + insertText.length;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.input?.setSelectionRange(newCursor, newCursor);
      setCursorPos(newCursor);
    });
  };

  return (
    <div style={{ position: "relative", flex: 1 }}>
      <Input
        ref={inputRef}
        className="inp"
        style={{ width: "100%" }}
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); syncCursor(e.target); }}
        onClick={(e) => syncCursor(e.currentTarget)}
        onKeyUp={(e) => syncCursor(e.currentTarget)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!popupVisible) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIndex((i) => (i + 1) % items.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIndex((i) => (i - 1 + items.length) % items.length);
          } else if (e.key === "Tab" || e.key === "Enter") {
            e.preventDefault();
            insert(items[selectedIndex]);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          }
        }}
      />
      {popupVisible && (
        <div className="formula-autocomplete-popup" style={{ position: "absolute", top: "100%", left: 0, marginTop: 2 }}>
          {items.map((item, i) => (
            <div
              key={item}
              className={`formula-autocomplete-item${i === selectedIndex ? " active" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); insert(item); }}
            >
              {ctx?.kind === "column" ? item : `${item}(...)`}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ClauseCard({
  clause,
  index,
  columnDefinitions,
  onUpdateMatch,
  onDeleteClause,
  onAddCondition,
  onDeleteCondition,
  onUpdateColumn,
  onUpdateOperator,
  onUpdateValue,
  onUpdateOutput,
}: {
  clause: ConditionalColumnClause;
  index: number;
  columnDefinitions: ConditionalColumnWindowPayload["inputColumns"];
  onUpdateMatch: (clauseId: string, match: "all" | "or") => void;
  onDeleteClause: (clauseId: string) => void;
  onAddCondition: (clauseId: string) => void;
  onDeleteCondition: (clauseId: string, conditionId: string) => void;
  onUpdateColumn: (clauseId: string, conditionId: string, columnName: string) => void;
  onUpdateOperator: (clauseId: string, conditionId: string, operator: FilterOperator) => void;
  onUpdateValue: (clauseId: string, conditionId: string, value: FilterConditionValue) => void;
  onUpdateOutput: (clauseId: string, value: string) => void;
}) {
  const group = clause.group;
  return (
    <div className="filter-group">
      <div className="group-header">
        <div className="group-header-left">
          <span className="group-label">{index === 0 ? "IF" : "ELSE IF"}</span>
          <div className="match-toggle">
            <button className={`match-toggle-btn${group.match === "all" ? " active" : ""}`} onClick={() => onUpdateMatch(clause.id, "all")}>
              AND
            </button>
            <button className={`match-toggle-btn${group.match === "or" ? " active" : ""}`} onClick={() => onUpdateMatch(clause.id, "or")}>
              OR
            </button>
          </div>
        </div>
        <button className="btn btn-danger" onClick={() => onDeleteClause(clause.id)}>
          Delete
        </button>
      </div>

      {group.conditions.length > 0 && (
        <div className="filter-rows">
          {group.conditions.map((condition) => (
            <ConditionRow
              key={condition.id}
              condition={condition}
              clauseId={clause.id}
              columnDefinitions={columnDefinitions}
              onDeleteCondition={onDeleteCondition}
              onUpdateColumn={onUpdateColumn}
              onUpdateOperator={onUpdateOperator}
              onUpdateValue={onUpdateValue}
            />
          ))}
        </div>
      )}

      <button className="btn-add-condition" onClick={() => onAddCondition(clause.id)}>
        <PlusIcon /> Add condition
      </button>

      <div className="cc-then-row">
        <span className="cc-then-label">Then set to</span>
        <ColumnRefInput
          value={clause.outputValue}
          onChange={(v) => onUpdateOutput(clause.id, v)}
          columns={columnDefinitions.map((c) => c.name)}
          placeholder='Output value… or [Column], or [A] + [B]'
        />
      </div>
    </div>
  );
}

export default function ConditionalColumnWindow() {
  const [payload, setPayload] = useState<ConditionalColumnWindowPayload | null>(null);
  const [columnName, setColumnName] = useState("");
  const [clauses, setClauses] = useState<ConditionalColumnClause[]>([]);
  const [elseValue, setElseValue] = useState("");
  const clauseCounterRef = useRef(0);
  const conditionCounterRef = useRef(0);

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: ConditionalColumnWindowPayload) {
      if (!live) return;
      setPayload(p);
      setColumnName(p.initialParams.columnName ?? "");
      setElseValue(p.initialParams.elseValue ?? "");
      clauseCounterRef.current = 0;
      conditionCounterRef.current = 0;
      setClauses(
        (p.initialParams.clauses ?? []).map((c) => ({
          ...c,
          id: `clause_${clauseCounterRef.current++}`,
          group: {
            ...c.group,
            id: `clausegroup_${clauseCounterRef.current}`,
            conditions: c.group.conditions.map((cond) => ({ ...cond, id: `condition_${conditionCounterRef.current++}` })),
          },
        })),
      );
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestConditionalColumnInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onConditionalColumnInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Configure — ${payload.nodeName}` : "Configure Node";
  }, [payload]);

  const addClause = useCallback(() => {
    setClauses((prev) => [
      ...prev,
      { id: `clause_${clauseCounterRef.current++}`, group: { id: `clausegroup_${clauseCounterRef.current}`, match: "all", conditions: [] }, outputValue: "" },
    ]);
  }, []);
  const deleteClause = useCallback((clauseId: string) => {
    setClauses((prev) => prev.filter((c) => c.id !== clauseId));
  }, []);
  const updateClauseMatch = useCallback((clauseId: string, match: "all" | "or") => {
    setClauses((prev) => prev.map((c) => (c.id === clauseId ? { ...c, group: { ...c.group, match } } : c)));
  }, []);
  const updateClauseOutput = useCallback((clauseId: string, value: string) => {
    setClauses((prev) => prev.map((c) => (c.id === clauseId ? { ...c, outputValue: value } : c)));
  }, []);
  const addCondition = useCallback((clauseId: string) => {
    setClauses((prev) => {
      const columnDefinitions = payload?.inputColumns ?? [];
      if (columnDefinitions.length === 0) return prev;
      return prev.map((c) => {
        if (c.id !== clauseId) return c;
        const conditions = c.group.conditions;
        let columnName: string;
        let operator: FilterOperator;
        if (conditions.length > 0) {
          const last = conditions[conditions.length - 1];
          columnName = last.column;
          operator = last.operator;
        } else {
          const col = columnDefinitions[0];
          columnName = col.name;
          operator = OPERATORS[col.type][0].value;
        }
        const initialValue: FilterConditionValue = operator === "between" ? { from: "", to: "" } : operator.startsWith("is_") ? null : "";
        return {
          ...c,
          group: {
            ...c.group,
            conditions: [...conditions, { id: `condition_${conditionCounterRef.current++}`, column: columnName, operator, value: initialValue }],
          },
        };
      });
    });
  }, [payload]);
  const deleteCondition = useCallback((clauseId: string, conditionId: string) => {
    setClauses((prev) => prev.map((c) => (c.id !== clauseId ? c : { ...c, group: { ...c.group, conditions: c.group.conditions.filter((cond) => cond.id !== conditionId) } })));
  }, []);
  const updateConditionColumn = useCallback((clauseId: string, conditionId: string, colName: string) => {
    const def = payload?.inputColumns.find((x) => x.name === colName);
    const type = def?.type || "text";
    setClauses((prev) => prev.map((c) => (c.id !== clauseId ? c : {
      ...c,
      group: { ...c.group, conditions: c.group.conditions.map((cond) => (cond.id !== conditionId ? cond : { ...cond, column: colName, operator: OPERATORS[type][0].value, value: null })) },
    })));
  }, [payload]);
  const updateConditionOperator = useCallback((clauseId: string, conditionId: string, operator: FilterOperator) => {
    setClauses((prev) => prev.map((c) => (c.id !== clauseId ? c : {
      ...c,
      group: {
        ...c.group,
        conditions: c.group.conditions.map((cond) => {
          if (cond.id !== conditionId) return cond;
          const oldOp = cond.operator;
          let newValue: FilterConditionValue = cond.value;
          if (operator.startsWith("is_")) newValue = null;
          else if (oldOp.startsWith("is_")) newValue = operator === "between" ? { from: "", to: "" } : "";
          else if (operator === "between" && oldOp !== "between") newValue = { from: "", to: "" };
          else if (operator !== "between" && oldOp === "between") newValue = "";
          return { ...cond, operator, value: newValue };
        }),
      },
    })));
  }, []);
  const updateConditionValue = useCallback((clauseId: string, conditionId: string, value: FilterConditionValue) => {
    setClauses((prev) => prev.map((c) => (c.id !== clauseId ? c : { ...c, group: { ...c.group, conditions: c.group.conditions.map((cond) => (cond.id !== conditionId ? cond : { ...cond, value })) } })));
  }, []);

  if (!payload) return null;
  const showEmpty = payload.inputColumns.length === 0;

  const handleApply = () => {
    const params: ConditionalColumnParams = {
      columnName: columnName.trim(),
      clauses: clauses.map((c): ConditionalColumnClause => ({ id: c.id, group: c.group as FilterGroup, outputValue: c.outputValue })),
      elseValue,
    };
    window.alteraStudio.applyConditionalColumn({ nodeId: payload.nodeId, params });
  };

  const canApply = !showEmpty && columnName.trim().length > 0 && clauses.length > 0;

  return (
    <ConfigProvider
      theme={antTheme}
      getPopupContainer={(triggerNode) => (triggerNode?.closest(".filter-builder-window") as HTMLElement) ?? document.body}
    >
      <div className="filter-builder-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="filter-app-outer">
            <div className="filter-app">
              <div className="unique-section">
                <div className="unique-section-label">New column name</div>
                <Input value={columnName} onChange={(e) => setColumnName(e.target.value)} placeholder="e.g. Tier" />
              </div>

              {clauses.map((clause, index) => (
                <ClauseCard
                  key={clause.id}
                  clause={clause}
                  index={index}
                  columnDefinitions={payload.inputColumns}
                  onUpdateMatch={updateClauseMatch}
                  onDeleteClause={deleteClause}
                  onAddCondition={addCondition}
                  onDeleteCondition={deleteCondition}
                  onUpdateColumn={updateConditionColumn}
                  onUpdateOperator={updateConditionOperator}
                  onUpdateValue={updateConditionValue}
                  onUpdateOutput={updateClauseOutput}
                />
              ))}

              <button className="btn btn-add-group" onClick={addClause}>
                + Add Clause
              </button>

              <div className="unique-section">
                <div className="unique-section-label">Otherwise</div>
                <ColumnRefInput
                  value={elseValue}
                  onChange={setElseValue}
                  columns={payload.inputColumns.map((c) => c.name)}
                  placeholder='Value for every other row… or [Column], or [A] + [B]'
                />
              </div>
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeConditionalColumnWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={!canApply}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
