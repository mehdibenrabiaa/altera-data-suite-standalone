import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfigProvider, Select, Input, InputNumber, AutoComplete } from "antd";
import type { FilterBuilderParams, FilterCondition, FilterConditionValue, FilterGroup, FilterOperator } from "./types";
import type { FilterBuilderWindowPayload, FilterExtraColumnDef } from "./vite-env";
import "./App.css";

// Ported near-verbatim from the original widget's own React frontend
// (devkit/filter-builder -- the un-minified source behind
// devkit/orangecontrib/custom/widgets/UI/filter_ui's bundled build), so
// this Configure window looks and behaves the same as the Qt-embedded
// version. Adaptations from the original are called out inline as they
// come up; the two structural ones are: no QWebChannel/Qt bridge (this
// app talks over Electron IPC instead, see the window-lifecycle comment
// below), and edits commit on an explicit Apply rather than live-
// notifying on every keystroke (the original's bridge.filterChanged call
// on every change) -- this app's auto-run only re-fires on Apply, so there
// was never a need to replicate that live-push wiring or its debouncing.
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

function isExtraRef(value: FilterConditionValue): value is { type: "extra_ref"; column: string } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "extra_ref";
}
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

// Ported verbatim from the original widget's own frontend
// (devkit/filter-builder/src/assets/link.svg, rendered there as a plain
// <img>) -- the AntD LinkOutlined glyph this app used in its place read
// visibly different (single-tone, different proportions) from the
// original's two-tone chain-link icon.
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
      <p>Connect a data table to start building filters</p>
    </div>
  );
}

function FilterRow({
  condition,
  groupId,
  columnDefinitions,
  extraColumns,
  onDeleteCondition,
  onUpdateColumn,
  onUpdateOperator,
  onUpdateValue,
}: {
  condition: FilterCondition;
  groupId: string;
  columnDefinitions: FilterBuilderWindowPayload["inputColumns"];
  extraColumns: FilterExtraColumnDef[];
  onDeleteCondition: (groupId: string, conditionId: string) => void;
  onUpdateColumn: (groupId: string, conditionId: string, columnName: string) => void;
  onUpdateOperator: (groupId: string, conditionId: string, operator: FilterOperator) => void;
  onUpdateValue: (groupId: string, conditionId: string, value: FilterConditionValue) => void;
}) {
  const columnDef = useMemo(
    () => columnDefinitions.find((col) => col.name === condition.column),
    [columnDefinitions, condition.column],
  );

  const columnType = columnDef?.type || "text";
  const operators = OPERATORS[columnType] || [];
  const needsValue = !condition.operator.startsWith("is_");
  const usingExtraRef = isExtraRef(condition.value);
  const hasExtraData = extraColumns.length > 0;

  const operatorLabel = operators.find((op) => op.value === condition.operator)?.label || condition.operator;

  const handleToggleExtraRef = (checked: boolean) => {
    if (checked) {
      onUpdateValue(groupId, condition.id, { type: "extra_ref", column: extraColumns[0]?.name ?? "" });
    } else {
      onUpdateValue(groupId, condition.id, condition.operator === "between" ? { from: "", to: "" } : "");
    }
  };

  const columnOptions = columnDefinitions.map((col) => ({ value: col.name, label: col.name }));
  const operatorOptions = operators.map((op) => ({ value: op.value, label: op.label }));

  const renderValue = () => {
    if (!needsValue) return <div style={{ flex: 1 }} />;

    if (usingExtraRef && isExtraRef(condition.value)) {
      const extraValue = condition.value;
      return (
        <div className="val-wrap">
          <Select
            style={{ width: "100%" }}
            value={extraValue.column || undefined}
            onChange={(v) => onUpdateValue(groupId, condition.id, { type: "extra_ref", column: v })}
            placeholder={hasExtraData ? "Select column from Extra Data…" : "Extra Data not connected"}
            disabled={!hasExtraData}
            options={extraColumns.map((col) => ({ value: col.name, label: col.name }))}
          />
        </div>
      );
    }

    if (columnType === "categorical") {
      return (
        <div className="val-wrap">
          <Select
            style={{ width: "100%" }}
            value={typeof condition.value === "string" ? condition.value || undefined : undefined}
            onChange={(v) => onUpdateValue(groupId, condition.id, v)}
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
              onChange={(v) => onUpdateValue(groupId, condition.id, { ...between, from: v })}
              placeholder="From…"
            />
            <InputNumber
              style={{ flex: 1, minWidth: 0, width: "100%" }}
              value={between.to ?? ""}
              onChange={(v) => onUpdateValue(groupId, condition.id, { ...between, to: v })}
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
            onChange={(v) => onUpdateValue(groupId, condition.id, v)}
            placeholder="Enter number…"
          />
        </div>
      );
    }

    // text
    const suggestions = (columnDef?.values || []).map((v) => ({ value: v }));
    const textValue = typeof condition.value === "string" ? condition.value : "";
    return (
      <div className="val-wrap">
        {suggestions.length > 0 ? (
          <AutoComplete
            style={{ width: "100%" }}
            options={suggestions}
            value={textValue}
            onChange={(v) => onUpdateValue(groupId, condition.id, v)}
            placeholder="Type to search…"
            filterOption={(input, option) => String(option?.value ?? "").toLowerCase().includes(input.toLowerCase())}
          />
        ) : (
          <Input
            style={{ width: "100%" }}
            value={textValue}
            onChange={(e) => onUpdateValue(groupId, condition.id, e.target.value)}
            placeholder="Enter value…"
          />
        )}
      </div>
    );
  };

  const extraColumn = isExtraRef(condition.value) ? condition.value.column : undefined;

  return (
    <div className="filter-row">
      <div className="filter-row-inner">
        <Select
          className="col-select"
          style={{ width: 180, flexShrink: 0 }}
          value={condition.column}
          onChange={(v) => onUpdateColumn(groupId, condition.id, v)}
          showSearch
          filterOption={(input, option) => String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
          options={columnOptions}
        />

        <Select
          style={{ width: 155, flexShrink: 0 }}
          value={condition.operator}
          onChange={(v) => onUpdateOperator(groupId, condition.id, v)}
          options={operatorOptions}
        />

        {renderValue()}

        {hasExtraData && needsValue && (
          <label className="extra-ref-label">
            <input type="checkbox" checked={usingExtraRef} onChange={(e) => handleToggleExtraRef(e.target.checked)} />
            Extra Data
          </label>
        )}

        <button className="btn btn-ghost btn-icon" onClick={() => onDeleteCondition(groupId, condition.id)} title="Remove condition">
          <TrashIcon />
        </button>
      </div>

      {usingExtraRef && extraColumn && (
        <div className="extra-ref-info">
          ℹ Rows where <strong>{condition.column}</strong> {operatorLabel.toLowerCase()} any value in column{" "}
          <strong>"{extraColumn}"</strong> from Extra Data
        </div>
      )}
    </div>
  );
}

function FilterGroupCard({
  group,
  index,
  columnDefinitions,
  extraColumns,
  onUpdateMatch,
  onDeleteGroup,
  onAddCondition,
  onDeleteCondition,
  onUpdateColumn,
  onUpdateOperator,
  onUpdateValue,
}: {
  group: FilterGroup;
  index: number;
  columnDefinitions: FilterBuilderWindowPayload["inputColumns"];
  extraColumns: FilterExtraColumnDef[];
  onUpdateMatch: (groupId: string, match: "all" | "or") => void;
  onDeleteGroup: (groupId: string) => void;
  onAddCondition: (groupId: string) => void;
  onDeleteCondition: (groupId: string, conditionId: string) => void;
  onUpdateColumn: (groupId: string, conditionId: string, columnName: string) => void;
  onUpdateOperator: (groupId: string, conditionId: string, operator: FilterOperator) => void;
  onUpdateValue: (groupId: string, conditionId: string, value: FilterConditionValue) => void;
}) {
  return (
    <div className="filter-group">
      <div className="group-header">
        <div className="group-header-left">
          <span className="group-label">GROUP {index + 1}</span>
          <div className="match-toggle">
            <button className={`match-toggle-btn${group.match === "all" ? " active" : ""}`} onClick={() => onUpdateMatch(group.id, "all")}>
              AND
            </button>
            <button className={`match-toggle-btn${group.match === "or" ? " active" : ""}`} onClick={() => onUpdateMatch(group.id, "or")}>
              OR
            </button>
          </div>
        </div>
        <button className="btn btn-danger" onClick={() => onDeleteGroup(group.id)}>
          Delete Group
        </button>
      </div>

      {group.conditions.length > 0 && (
        <div className="filter-rows">
          {group.conditions.map((condition) => (
            <FilterRow
              key={condition.id}
              condition={condition}
              groupId={group.id}
              columnDefinitions={columnDefinitions}
              extraColumns={extraColumns}
              onDeleteCondition={onDeleteCondition}
              onUpdateColumn={onUpdateColumn}
              onUpdateOperator={onUpdateOperator}
              onUpdateValue={onUpdateValue}
            />
          ))}
        </div>
      )}

      <button className="btn-add-condition" onClick={() => onAddCondition(group.id)}>
        <PlusIcon /> Add condition
      </button>
    </div>
  );
}

// A real, separate native window -- same pattern as SettingsWindow.tsx
// (not an in-page modal), re-seeded via filterBuilder:init on every
// Configure open rather than torn down and recreated, for the same
// warm-window perf reason Settings already established. Filter Builder is
// the first configurable node, and its own dedicated Vite entry (this
// file + filter-builder-main.tsx + filter-builder.html) is the pattern
// every future configurable node reuses -- each gets its own window/entry,
// not a shared generic "node config" bundle.
export default function FilterBuilderWindow() {
  const [payload, setPayload] = useState<FilterBuilderWindowPayload | null>(null);
  const [groups, setGroups] = useState<FilterGroup[]>([]);
  const groupCounterRef = useRef(0);
  const conditionCounterRef = useRef(0);

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode (see filter-builder-main.tsx) double-invokes
    // effects in dev: mount -> cleanup -> mount again. The FIRST
    // invocation's requestFilterBuilderInit() promise is still in flight
    // when its cleanup runs, and nothing cancels it -- if it resolves
    // AFTER the second (kept) invocation's own init has already loaded
    // real data and the user started editing, it would silently overwrite
    // those in-progress edits back to the stale original payload. `live`
    // makes the first invocation's late resolution a no-op.
    let live = true;
    function loadPayload(p: FilterBuilderWindowPayload) {
      if (!live) return;
      setPayload(p);
      groupCounterRef.current = 0;
      conditionCounterRef.current = 0;
      setGroups(
        p.initialParams.groups.map((g) => ({
          ...g,
          id: `group_${groupCounterRef.current++}`,
          conditions: g.conditions.map((c) => ({ ...c, id: `condition_${conditionCounterRef.current++}` })),
        })),
      );
    }
    // Pull the current payload once this component has actually mounted
    // (avoids racing did-finish-load -- see SettingsWindow.tsx's identical
    // reasoning for requestSettingsInit). nodeId identifies WHICH node's
    // payload to pull -- this window is now one of potentially several
    // Configure windows open at once, each dedicated to a different node
    // (see electron/main.ts's createPerNodeWindowManager), set in the
    // window's own URL at creation time rather than learned via IPC.
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestFilterBuilderInit(nodeId).then((p) => p && loadPayload(p));
    // Still listen for pushes too, for the "window already open, a second
    // openFilterBuilderWindow call reseeds it with a different node" case.
    const unsubscribe = window.alteraStudio.onFilterBuilderInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Configure — ${payload.nodeName}` : "Configure Node";
  }, [payload]);

  const addGroup = useCallback(() => {
    setGroups((prev) => [...prev, { id: `group_${groupCounterRef.current++}`, match: "all", conditions: [] }]);
  }, []);
  const deleteGroup = useCallback((groupId: string) => {
    setGroups((prev) => prev.filter((g) => g.id !== groupId));
  }, []);
  const updateGroupMatch = useCallback((groupId: string, match: "all" | "or") => {
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, match } : g)));
  }, []);
  const addCondition = useCallback((groupId: string) => {
    setGroups((prev) => {
      const columnDefinitions = payload?.inputColumns ?? [];
      if (columnDefinitions.length === 0) return prev;
      return prev.map((g) => {
        if (g.id !== groupId) return g;
        let columnName: string;
        let operator: FilterOperator;
        if (g.conditions.length > 0) {
          const last = g.conditions[g.conditions.length - 1];
          columnName = last.column;
          operator = last.operator;
        } else {
          const col = columnDefinitions[0];
          columnName = col.name;
          operator = OPERATORS[col.type][0].value;
        }
        const initialValue: FilterConditionValue = operator === "between" ? { from: "", to: "" } : operator.startsWith("is_") ? null : "";
        return {
          ...g,
          conditions: [...g.conditions, { id: `condition_${conditionCounterRef.current++}`, column: columnName, operator, value: initialValue }],
        };
      });
    });
  }, [payload]);
  const deleteCondition = useCallback((groupId: string, conditionId: string) => {
    setGroups((prev) => prev.map((g) => (g.id !== groupId ? g : { ...g, conditions: g.conditions.filter((c) => c.id !== conditionId) })));
  }, []);
  const updateConditionColumn = useCallback((groupId: string, conditionId: string, columnName: string) => {
    const def = payload?.inputColumns.find((x) => x.name === columnName);
    const type = def?.type || "text";
    setGroups((prev) => prev.map((g) => (g.id !== groupId ? g : {
      ...g,
      conditions: g.conditions.map((c) => (c.id !== conditionId ? c : { ...c, column: columnName, operator: OPERATORS[type][0].value, value: null })),
    })));
  }, [payload]);
  const updateConditionOperator = useCallback((groupId: string, conditionId: string, operator: FilterOperator) => {
    setGroups((prev) => prev.map((g) => (g.id !== groupId ? g : {
      ...g,
      conditions: g.conditions.map((c) => {
        if (c.id !== conditionId) return c;
        const oldOp = c.operator;
        let newValue: FilterConditionValue = c.value;
        if (operator.startsWith("is_")) newValue = null;
        else if (oldOp.startsWith("is_")) newValue = operator === "between" ? { from: "", to: "" } : "";
        else if (operator === "between" && oldOp !== "between") newValue = { from: "", to: "" };
        else if (operator !== "between" && oldOp === "between") newValue = "";
        return { ...c, operator, value: newValue };
      }),
    })));
  }, []);
  const updateConditionValue = useCallback((groupId: string, conditionId: string, value: FilterConditionValue) => {
    setGroups((prev) => prev.map((g) => (g.id !== groupId ? g : { ...g, conditions: g.conditions.map((c) => (c.id !== conditionId ? c : { ...c, value })) })));
  }, []);

  if (!payload) return null;

  const handleApply = () => {
    const params: FilterBuilderParams = { groups };
    window.alteraStudio.applyFilterBuilder({ nodeId: payload.nodeId, params });
  };

  const showEmpty = payload.inputColumns.length === 0;
  const finalLogic = groups.length > 0 ? groups.map((_, i) => `GROUP ${i + 1}`).join(" OR ") : "No groups";

  return (
    // getPopupContainer keeps every Select/AutoComplete dropdown mounted
    // inside .filter-builder-window instead of antd's default (a portal
    // appended straight to <body>) -- that default was why the existing
    // ".filter-builder-window ::-webkit-scrollbar" rule (matching the
    // table previewer's scrollbar) never reached a long dropdown's own
    // scrollbar: the popup was rendering outside that selector's subtree.
    <ConfigProvider
      theme={antTheme}
      getPopupContainer={(triggerNode) =>
        (triggerNode?.closest(".filter-builder-window") as HTMLElement) ?? document.body
      }
    >
      <div className="filter-builder-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="filter-app-outer">
            <div className="filter-app">
              {groups.map((group, index) => (
                <FilterGroupCard
                  key={group.id}
                  group={group}
                  index={index}
                  columnDefinitions={payload.inputColumns}
                  extraColumns={payload.extraColumns}
                  onUpdateMatch={updateGroupMatch}
                  onDeleteGroup={deleteGroup}
                  onAddCondition={addCondition}
                  onDeleteCondition={deleteCondition}
                  onUpdateColumn={updateConditionColumn}
                  onUpdateOperator={updateConditionOperator}
                  onUpdateValue={updateConditionValue}
                />
              ))}

              <button className="btn btn-add-group" onClick={addGroup}>
                + Add Group
              </button>

              <div className="final-logic">
                Final logic: <strong>{finalLogic}</strong>
              </div>
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeFilterBuilderWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={showEmpty}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
