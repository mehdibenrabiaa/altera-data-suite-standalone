import { useCallback, useEffect, useRef, useState } from "react";
import { ConfigProvider, Select } from "antd";
import type { MergeParams, MergeType, MergeMatchBy, MergeColumnPair } from "./types";
import type { MergeWindowPayload } from "./vite-env";
import { computeDefaultMatchPair } from "./mergeDefaults";
import "./App.css";

// Configure window for the Merge node -- modeled on Orange's own Merge
// Data widget (https://orangedatamining.com/widget-catalog/transform/mergedata/),
// same real-window/round-trips-on-Apply pattern as FilterBuilderWindow.tsx/
// HeaderPromoterWindow.tsx. See backend/app/nodes.py's merge_data for the
// actual join logic and why "by Instance ID" (one of Orange's three
// matching modes) isn't offered here.
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
      <p>Connect a primary table and an Extra Data table to merge them</p>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
      <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 640 640" fill="currentColor">
      <path d="M232.7 69.9C237.1 56.8 249.3 48 263.1 48L377 48C390.8 48 403 56.8 407.4 69.9L416 96L512 96C529.7 96 544 110.3 544 128C544 145.7 529.7 160 512 160L128 160C110.3 160 96 145.7 96 128C96 110.3 110.3 96 128 96L224 96L232.7 69.9zM128 208L512 208L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 208zM216 272C202.7 272 192 282.7 192 296L192 488C192 501.3 202.7 512 216 512C229.3 512 240 501.3 240 488L240 296C240 282.7 229.3 272 216 272zM320 272C306.7 272 296 282.7 296 296L296 488C296 501.3 306.7 512 320 512C333.3 512 344 501.3 344 488L344 296C344 282.7 333.3 272 320 272zM424 272C410.7 272 400 282.7 400 296L400 488C400 501.3 410.7 512 424 512C437.3 512 448 501.3 448 488L448 296C448 282.7 437.3 272 424 272z" />
    </svg>
  );
}

const MERGE_TYPE_OPTIONS: { value: MergeType; label: string; join: string }[] = [
  { value: "append", label: "Append Columns", join: "Left Join" },
  { value: "matching", label: "Find Matching Pairs", join: "Inner Join" },
  { value: "concatenate", label: "Concatenate Tables", join: "Outer Join" },
];

export default function MergeWindow() {
  const [payload, setPayload] = useState<MergeWindowPayload | null>(null);
  const [mergeType, setMergeType] = useState<MergeType>("append");
  const [matchBy, setMatchBy] = useState<MergeMatchBy>("attributes");
  const [matchColumns, setMatchColumns] = useState<MergeColumnPair[]>([]);
  const pairCounterRef = useRef(0);

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // FilterBuilderWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: MergeWindowPayload) {
      if (!live) return;
      setPayload(p);
      setMergeType(p.initialParams.mergeType ?? "append");
      setMatchBy(p.initialParams.matchBy ?? "attributes");
      const savedPairs = p.initialParams.matchColumns ?? [];
      if (savedPairs.length > 0) {
        setMatchColumns(savedPairs);
        pairCounterRef.current = savedPairs.length;
      } else {
        const defaultPair = computeDefaultMatchPair(p.primaryColumns, p.extraColumns);
        setMatchColumns(defaultPair ? [{ id: "pair_0", ...defaultPair }] : []);
        pairCounterRef.current = defaultPair ? 1 : 0;
      }
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestMergeInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onMergeInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Configure — ${payload.nodeName}` : "Configure Node";
  }, [payload]);

  const addPair = useCallback(() => {
    setMatchColumns((prev) => [
      ...prev,
      { id: `pair_${pairCounterRef.current++}`, left: payload?.primaryColumns[0] ?? "", right: payload?.extraColumns[0] ?? "" },
    ]);
  }, [payload, pairCounterRef]);
  const removePair = useCallback((id: string) => {
    setMatchColumns((prev) => prev.filter((p) => p.id !== id));
  }, []);
  const updatePair = useCallback((id: string, side: "left" | "right", value: string) => {
    setMatchColumns((prev) => prev.map((p) => (p.id === id ? { ...p, [side]: value } : p)));
  }, []);

  if (!payload) return null;
  const showEmpty = payload.primaryColumns.length === 0 || payload.extraColumns.length === 0;

  const handleApply = () => {
    const params: MergeParams = { mergeType, matchBy, matchColumns };
    window.alteraStudio.applyMerge({ nodeId: payload.nodeId, params });
  };

  const primaryOptions = payload.primaryColumns.map((c) => ({ value: c, label: c }));
  const extraOptions = payload.extraColumns.map((c) => ({ value: c, label: c }));
  const canApply = !showEmpty && (matchBy === "row_index" || matchColumns.length > 0);

  return (
    <ConfigProvider
      theme={antTheme}
      getPopupContainer={(triggerNode) => (triggerNode?.closest(".merge-window") as HTMLElement) ?? document.body}
    >
      <div className="merge-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="merge-app-outer">
            <div className="merge-app">
              <div className="merge-section">
                <div className="merge-section-label">Merge type</div>
                <div className="merge-type-group">
                  {MERGE_TYPE_OPTIONS.map((opt) => (
                    <label key={opt.value} className="merge-type-option">
                      <input
                        type="radio"
                        name="mergeType"
                        checked={mergeType === opt.value}
                        onChange={() => setMergeType(opt.value)}
                      />
                      <span className="merge-type-option-label">{opt.label}</span>
                      <span className="merge-type-option-join">{opt.join}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="merge-section">
                <div className="merge-section-label">Match rows by</div>
                <div className="match-toggle">
                  <button className={`match-toggle-btn${matchBy === "attributes" ? " active" : ""}`} onClick={() => setMatchBy("attributes")}>
                    Matching row values
                  </button>
                  <button className={`match-toggle-btn${matchBy === "row_index" ? " active" : ""}`} onClick={() => setMatchBy("row_index")}>
                    Row position
                  </button>
                </div>
              </div>

              {matchBy === "attributes" && (
                <div className="merge-section">
                  <div className="merge-section-label">Match columns</div>
                  {matchColumns.length > 0 && (
                    <div className="merge-pair-head">
                      <span>Primary table</span>
                      <span>Extra Data table</span>
                      <span />
                    </div>
                  )}
                  {matchColumns.map((pair) => (
                    <div className="merge-pair-row" key={pair.id}>
                      <Select style={{ width: "100%" }} value={pair.left || undefined} placeholder="Column…" options={primaryOptions} onChange={(v) => updatePair(pair.id, "left", v)} />
                      <Select style={{ width: "100%" }} value={pair.right || undefined} placeholder="Column…" options={extraOptions} onChange={(v) => updatePair(pair.id, "right", v)} />
                      <button className="btn btn-ghost btn-icon" onClick={() => removePair(pair.id)} title="Remove pair">
                        <TrashIcon />
                      </button>
                    </div>
                  ))}
                  <button className="btn-add-condition" onClick={addPair}>
                    <PlusIcon /> Add column pair
                  </button>
                  {matchColumns.length === 0 && (
                    <p className="merge-hint">Add at least one column pair to match rows on.</p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="filter-builder-footer">
          <button className="filter-builder-btn-secondary" onClick={() => window.alteraStudio.closeMergeWindow()}>Cancel</button>
          <button className="filter-builder-btn-primary" onClick={handleApply} disabled={!canApply}>Apply</button>
        </div>
      </div>
    </ConfigProvider>
  );
}
