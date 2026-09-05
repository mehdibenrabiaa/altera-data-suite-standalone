import { useEffect, useMemo, useState } from "react";
import { ConfigProvider } from "antd";
import type { SummaryWindowPayload } from "./vite-env";
import "./App.css";

// Per-column stats/distribution view -- a quick health check of a table
// without opening Browse and scrolling through every row by hand. Same
// pure-viewer pattern as BrowseWindow.tsx (see its own comment: no
// editable state, no *AppliedPayload round-trip), and computed entirely
// client-side from the already-resolved rows this window's payload
// carries -- no backend round-trip needed, the same reasoning Browse's
// own column-type detection already uses.
const antTheme = {
  token: {
    borderRadius: 0,
    fontSize: 13,
    fontFamily: '"Google Sans Flex", sans-serif',
    colorText: "#1a1a1a",
  },
};

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
      <p>Connect a table to see its summary</p>
    </div>
  );
}

// A value counts as numeric here if EVERY non-empty cell in the column
// parses cleanly as a plain number -- deliberately different (and looser)
// than SchemaView.tsx's own inferColumnDefinition, which stays
// conservative on purpose because a wrong guess there breaks a real
// operator choice in Filter Builder. Here a wrong guess just means one
// column shows as text instead of getting a histogram -- much lower
// stakes, so it's fine to actually look at the values.
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

interface ColumnStats {
  name: string;
  total: number;
  missingCount: number;
  missingPct: number;
  uniqueCount: number;
  isNumeric: boolean;
  min?: number;
  max?: number;
  mean?: number;
  sum?: number;
  histogram?: { label: string; count: number }[];
  gaps?: number[];
  gapsTruncated?: boolean;
  topValues?: { value: string; count: number }[];
}

function computeColumnStats(name: string, values: string[]): ColumnStats {
  const total = values.length;
  const trimmed = values.map((v) => v.trim());
  const nonEmpty = trimmed.filter((v) => v !== "");
  const missingCount = total - nonEmpty.length;
  const uniqueCount = new Set(nonEmpty).size;
  const isNumeric = nonEmpty.length > 0 && nonEmpty.every((v) => NUMERIC_RE.test(v));

  const base: ColumnStats = { name, total, missingCount, missingPct: total ? (missingCount / total) * 100 : 0, uniqueCount, isNumeric };

  if (isNumeric) {
    const nums = nonEmpty.map(Number);
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const sum = nums.reduce((a, b) => a + b, 0);
    const mean = sum / nums.length;

    // Histogram: 8 equal-width bins across [min, max]. A column with only
    // one distinct value (min === max) gets a single bin instead of
    // dividing by zero.
    const binCount = 8;
    const span = max - min;
    const bins = new Array(binCount).fill(0);
    if (span === 0) {
      bins[0] = nums.length;
    } else {
      for (const n of nums) {
        const idx = Math.min(binCount - 1, Math.floor(((n - min) / span) * binCount));
        bins[idx]++;
      }
    }
    const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
    const histogram = bins.map((count, i) => ({
      label: span === 0 ? fmt(min) : `${fmt(min + (span * i) / binCount)}–${fmt(min + (span * (i + 1)) / binCount)}`,
      count,
    }));

    // Gap detection: only meaningful for a column of whole numbers --
    // e.g. a "Page" column that should be a continuous run but has a hole
    // where the extractor missed a table on some page. Every integer in
    // [min, max] not actually present in the column is a "gap". Capped at
    // 500 to keep this cheap and the list itself renderable -- a column
    // with more holes than that has bigger problems than a UI list can
    // usefully show anyway.
    let gaps: number[] | undefined;
    let gapsTruncated = false;
    if (nums.every((n) => Number.isInteger(n)) && max - min < 100000) {
      const present = new Set(nums);
      const found: number[] = [];
      for (let v = min; v <= max; v++) {
        if (!present.has(v)) {
          found.push(v);
          if (found.length >= 500) { gapsTruncated = true; break; }
        }
      }
      gaps = found;
    }

    return { ...base, min, max, mean, sum, histogram, gaps, gapsTruncated };
  }

  const freq = new Map<string, number>();
  for (const v of nonEmpty) freq.set(v, (freq.get(v) ?? 0) + 1);
  const topValues = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([value, count]) => ({ value, count }));

  return { ...base, topValues };
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="summary-bar-track">
      <div className="summary-bar-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }} />
    </div>
  );
}

function ColumnCard({ stats }: { stats: ColumnStats }) {
  const maxBin = stats.histogram ? Math.max(1, ...stats.histogram.map((b) => b.count)) : 1;
  return (
    <div className="summary-col-card">
      <div className="summary-col-header">
        <span className="summary-col-name">{stats.name}</span>
        <span className={`summary-col-type-badge${stats.isNumeric ? " numeric" : ""}`}>{stats.isNumeric ? "Number" : "Text"}</span>
      </div>

      <div className="summary-stat-row">
        <span className="summary-stat-label">Missing</span>
        <Bar pct={stats.missingPct} color={stats.missingPct > 0 ? "#d4380d" : "#2e7d32"} />
        <span className="summary-stat-value">{stats.missingCount} ({stats.missingPct.toFixed(0)}%)</span>
      </div>
      <div className="summary-stat-row">
        <span className="summary-stat-label">Unique</span>
        <span className="summary-stat-value summary-stat-value-only">{stats.uniqueCount} of {stats.total}</span>
      </div>

      {stats.isNumeric ? (
        <>
          <div className="summary-numeric-grid">
            <div><span className="summary-mini-label">Min</span><span>{stats.min}</span></div>
            <div><span className="summary-mini-label">Max</span><span>{stats.max}</span></div>
            <div><span className="summary-mini-label">Mean</span><span>{stats.mean?.toFixed(2)}</span></div>
            <div><span className="summary-mini-label">Sum</span><span>{stats.sum}</span></div>
          </div>

          {stats.histogram && (
            <div className="summary-histogram">
              {stats.histogram.map((b, i) => (
                <div key={i} className="summary-histogram-bar-wrap" title={`${b.label}: ${b.count}`}>
                  <div className="summary-histogram-bar" style={{ height: `${(b.count / maxBin) * 100}%` }} />
                </div>
              ))}
            </div>
          )}

          <div className={`summary-gap-line${stats.gaps && stats.gaps.length > 0 ? " has-gaps" : ""}`}>
            {stats.gaps == null ? (
              "Not a whole-number sequence -- gap check skipped."
            ) : stats.gaps.length === 0 ? (
              `No gaps -- every whole number from ${stats.min} to ${stats.max} is present. ✓`
            ) : (
              <>
                {stats.gaps.length} missing value{stats.gaps.length === 1 ? "" : "s"} in range: {stats.gaps.slice(0, 30).join(", ")}
                {stats.gaps.length > 30 ? `, +${stats.gaps.length - 30} more` : ""}
                {stats.gapsTruncated ? " (stopped counting at 500)" : ""}
              </>
            )}
          </div>
        </>
      ) : (
        stats.topValues && stats.topValues.length > 0 && (
          <div className="summary-top-values">
            {stats.topValues.map((tv) => (
              <div key={tv.value} className="summary-top-value-row">
                <span className="summary-top-value-label" title={tv.value}>{tv.value}</span>
                <Bar pct={(tv.count / stats.topValues![0].count) * 100} color="#155F98" />
                <span className="summary-stat-value">{tv.count}</span>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

export default function SummaryWindow() {
  const [payload, setPayload] = useState<SummaryWindowPayload | null>(null);

  useEffect(() => {
    if (!window.alteraStudio) return;
    // React 19 StrictMode double-invokes effects in dev -- same race
    // BrowseWindow.tsx guards against (see its own comment).
    let live = true;
    function loadPayload(p: SummaryWindowPayload) {
      if (live) setPayload(p);
    }
    const nodeId = new URLSearchParams(window.location.search).get("nodeId") ?? "";
    window.alteraStudio.requestSummaryInit(nodeId).then((p) => p && loadPayload(p));
    const unsubscribe = window.alteraStudio.onSummaryInit(loadPayload);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.title = payload ? `Summary — ${payload.nodeName}` : "Summary";
  }, [payload]);

  const columnStats = useMemo(() => {
    if (!payload) return [];
    return payload.columns.map((col, ci) => computeColumnStats(col, payload.rows.map((r) => r[ci] ?? "")));
  }, [payload]);

  const duplicateRowCount = useMemo(() => {
    if (!payload) return 0;
    const seen = new Map<string, number>();
    for (const row of payload.rows) {
      const key = row.join("");
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    let dupes = 0;
    for (const count of seen.values()) if (count > 1) dupes += count - 1;
    return dupes;
  }, [payload]);

  if (!payload) return null;
  const showEmpty = payload.columns.length === 0;

  return (
    <ConfigProvider theme={antTheme}>
      <div className="summary-window">
        {showEmpty ? (
          <EmptyState />
        ) : (
          <>
            <div className="summary-table-header">
              <div className="summary-table-stat"><span className="summary-mini-label">Rows</span><span>{payload.rows.length}</span></div>
              <div className="summary-table-stat"><span className="summary-mini-label">Columns</span><span>{payload.columns.length}</span></div>
              <div className="summary-table-stat">
                <span className="summary-mini-label">Duplicate rows</span>
                <span className={duplicateRowCount > 0 ? "summary-warn-value" : ""}>{duplicateRowCount}</span>
              </div>
            </div>
            <div className="summary-col-list">
              {columnStats.map((stats) => (
                <ColumnCard key={stats.name} stats={stats} />
              ))}
            </div>
          </>
        )}
      </div>
    </ConfigProvider>
  );
}
