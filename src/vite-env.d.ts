/// <reference types="vite/client" />

import type { SettingsPayload, PersistedSettings, FilterBuilderParams, FilterColumnDefinition, HeaderPromoterParams, MergeParams, ShiftColumnsParams, CleanerParams, UniqueParams, ColumnEditParams, ChangeTypeParams, RegexParams } from "./types";
import type { AppliedColumnType } from "./columnTypeDetection";

// Mirrors the original devkit/filter-builder project's own ExtraColumnDef
// (just a name today -- kept as its own type, not a bare string[], in case
// a future field is ever needed there too).
export interface FilterExtraColumnDef {
  name: string;
}

export interface FilterBuilderWindowPayload {
  nodeId: string;
  nodeName: string;
  initialParams: FilterBuilderParams;
  inputColumns: FilterColumnDefinition[];
  extraColumns: FilterExtraColumnDef[];
}
export interface FilterBuilderAppliedPayload {
  nodeId: string;
  params: FilterBuilderParams;
}

// Browse (nodeCatalog.ts's hasOutput: false) is a pure data viewer --
// its window just needs the resolved input table to display, nothing
// editable to send back (no *AppliedPayload counterpart).
export interface BrowseWindowPayload {
  nodeId: string;
  nodeName: string;
  columns: string[];
  rows: string[][];
  // Only ever present when this window's input is the direct output of a
  // Change Type node -- see columnTypeDetection.ts's resolveDisplayColumnType
  // for why the header icon reads this instead of re-guessing from content.
  columnTypes?: Record<string, AppliedColumnType>;
}

// Header Promoter's Configure window needs the resolved primary input's
// columns/rows to show the row-picker grid, plus whatever's already saved
// for this node so reopening the window restores the prior selection.
export interface HeaderPromoterWindowPayload {
  nodeId: string;
  nodeName: string;
  columns: string[];
  rows: string[][];
  initialParams: HeaderPromoterParams;
}
export interface HeaderPromoterAppliedPayload {
  nodeId: string;
  params: HeaderPromoterParams;
}

// Merge's Configure window needs both resolved inputs' columns (for the
// primary/extra-data match-column pickers) plus whatever's already saved
// for this node so reopening restores the prior configuration.
export interface MergeWindowPayload {
  nodeId: string;
  nodeName: string;
  primaryColumns: string[];
  extraColumns: string[];
  initialParams: MergeParams;
}
export interface MergeAppliedPayload {
  nodeId: string;
  params: MergeParams;
}

// Shift Columns' Configure window just needs the resolved input's column
// names (no rows -- there's no grid preview, matching the original
// widget's own column-checklist-only UI) plus whatever's already saved
// for this node so reopening restores the prior selection.
export interface ShiftColumnsWindowPayload {
  nodeId: string;
  nodeName: string;
  columns: string[];
  initialParams: ShiftColumnsParams;
}
export interface ShiftColumnsAppliedPayload {
  nodeId: string;
  params: ShiftColumnsParams;
}

// Cleaner's Configure window just needs the resolved input's column
// names (no rows -- there's no grid preview, matching the original
// widget's own operation-card-only UI) plus whatever's already saved for
// this node so reopening restores the prior operation list.
export interface CleanerWindowPayload {
  nodeId: string;
  nodeName: string;
  columns: string[];
  initialParams: CleanerParams;
}
export interface CleanerAppliedPayload {
  nodeId: string;
  params: CleanerParams;
}

// Unique's Configure window needs the resolved input's columns AND rows
// (unlike Shift Columns/Cleaner) -- the live Total/Duplicates/Output
// stat readout is computed client-side from the actual row values, see
// UniqueWindow.tsx's own stats useMemo.
export interface UniqueWindowPayload {
  nodeId: string;
  nodeName: string;
  columns: string[];
  rows: string[][];
  initialParams: UniqueParams;
}
export interface UniqueAppliedPayload {
  nodeId: string;
  params: UniqueParams;
}

// Column Edit's Configure window needs the resolved input's column
// names (no rows -- there's no grid preview) plus whatever's already
// saved for this node so reopening restores the prior column list
// (order, renames, deletions, added columns) instead of starting over.
export interface ColumnEditWindowPayload {
  nodeId: string;
  nodeName: string;
  columns: string[];
  initialParams: ColumnEditParams;
}
export interface ColumnEditAppliedPayload {
  nodeId: string;
  params: ColumnEditParams;
}

// Change Type's Configure window needs the resolved input's ROWS too
// (not just column names) -- each field's type dropdown is pre-selected
// to whatever that column's values currently look like, computed
// client-side in ChangeTypeWindow.tsx from a sample of these rows.
export interface ChangeTypeWindowPayload {
  nodeId: string;
  nodeName: string;
  columns: string[];
  rows: string[][];
  initialParams: ChangeTypeParams;
}
export interface ChangeTypeAppliedPayload {
  nodeId: string;
  params: ChangeTypeParams;
}

// Regular Expressions' Configure window needs the resolved input's ROWS
// too (not just column names) -- the live match-preview grid highlights
// matches inline as you type the pattern, computed client-side in
// RegexWindow.tsx (JS RegExp, best-effort -- the actual extraction
// always runs authoritatively in Python on Apply, see backend/app/
// nodes.py's extract_regex).
export interface RegexWindowPayload {
  nodeId: string;
  nodeName: string;
  columns: string[];
  rows: string[][];
  initialParams: RegexParams;
}
export interface RegexAppliedPayload {
  nodeId: string;
  params: RegexParams;
}

declare global {
  interface Window {
    alteraStudio: {
      backendUrl: string;
      openPdfDialog: () => Promise<string | null>;
      readFileBase64: (path: string) => Promise<string>;
      saveProjectAs: (jsonData: string) => Promise<string | null>;
      saveProjectToPath: (filePath: string, jsonData: string) => Promise<boolean>;
      openProjectDialog: () => Promise<{ path: string; data: string } | null>;
      restartApp: () => void;
      openSettingsWindow: (payload: SettingsPayload) => void;
      loadPersistedSettings: () => Promise<PersistedSettings | null>;
      onSettingsApplied: (cb: (payload: SettingsPayload) => void) => () => void;
      requestSettingsInit: () => Promise<SettingsPayload>;
      onSettingsInit: (cb: (payload: SettingsPayload) => void) => () => void;
      saveSettings: (payload: SettingsPayload) => void;
      closeSettingsWindow: () => void;

      // Main window: open (or focus/reseed) the separate Filter Builder
      // configure window for one node -- same "real native window, not an
      // in-page modal" pattern as Settings above.
      openFilterBuilderWindow: (payload: FilterBuilderWindowPayload) => void;
      onFilterBuilderApplied: (cb: (payload: FilterBuilderAppliedPayload) => void) => () => void;
      // Filter Builder window only -- nodeId is which one of potentially
      // several open Configure windows this is (read from this window's
      // own URL, see BrowseWindowPayload's matching comment below).
      requestFilterBuilderInit: (nodeId: string) => Promise<FilterBuilderWindowPayload>;
      onFilterBuilderInit: (cb: (payload: FilterBuilderWindowPayload) => void) => () => void;
      applyFilterBuilder: (payload: FilterBuilderAppliedPayload) => void;
      closeFilterBuilderWindow: () => void;

      // Main window: open (or focus/reseed) the separate Browse data-
      // viewer window for one node -- same real-window pattern as Filter
      // Builder above, just no *Applied counterpart (nothing to save).
      openBrowseWindow: (payload: BrowseWindowPayload) => void;
      // Browse window only -- nodeId is which one of potentially several
      // open Browse windows this is (read from this window's own URL,
      // via main.ts's createPerNodeWindowManager -- each node now gets
      // its own independent window instead of one shared instance).
      requestBrowseInit: (nodeId: string) => Promise<BrowseWindowPayload>;
      onBrowseInit: (cb: (payload: BrowseWindowPayload) => void) => () => void;
      closeBrowseWindow: () => void;
      // Main window: silently refreshes an already-open Browse window
      // (no show/focus, unlike openBrowseWindow above).
      pushBrowseUpdate: (payload: BrowseWindowPayload) => void;

      // Main window: open (or focus/reseed) the separate Header Promoter
      // configure window for one node -- same real-window pattern as
      // Filter Builder above, including round-tripping edits back on Apply.
      openHeaderPromoterWindow: (payload: HeaderPromoterWindowPayload) => void;
      onHeaderPromoterApplied: (cb: (payload: HeaderPromoterAppliedPayload) => void) => () => void;
      // Header Promoter window only -- nodeId is which one of potentially
      // several open Configure windows this is (read from this window's
      // own URL, same reasoning as requestFilterBuilderInit above).
      requestHeaderPromoterInit: (nodeId: string) => Promise<HeaderPromoterWindowPayload>;
      onHeaderPromoterInit: (cb: (payload: HeaderPromoterWindowPayload) => void) => () => void;
      applyHeaderPromoter: (payload: HeaderPromoterAppliedPayload) => void;
      closeHeaderPromoterWindow: () => void;

      // Main window: open (or focus/reseed) the separate Merge configure
      // window for one node -- same real-window pattern as Filter
      // Builder/Header Promoter above, including round-tripping edits
      // back on Apply.
      openMergeWindow: (payload: MergeWindowPayload) => void;
      onMergeApplied: (cb: (payload: MergeAppliedPayload) => void) => () => void;
      // Merge window only -- nodeId is which one of potentially several
      // open Configure windows this is (read from this window's own URL,
      // same reasoning as requestFilterBuilderInit above).
      requestMergeInit: (nodeId: string) => Promise<MergeWindowPayload>;
      onMergeInit: (cb: (payload: MergeWindowPayload) => void) => () => void;
      applyMerge: (payload: MergeAppliedPayload) => void;
      closeMergeWindow: () => void;

      // Main window: open (or focus/reseed) the separate Shift Columns
      // configure window for one node -- same real-window pattern as
      // Filter Builder/Header Promoter/Merge above, including round-
      // tripping edits back on Apply.
      openShiftColumnsWindow: (payload: ShiftColumnsWindowPayload) => void;
      onShiftColumnsApplied: (cb: (payload: ShiftColumnsAppliedPayload) => void) => () => void;
      // Shift Columns window only -- nodeId is which one of potentially
      // several open Configure windows this is (read from this window's
      // own URL, same reasoning as requestFilterBuilderInit above).
      requestShiftColumnsInit: (nodeId: string) => Promise<ShiftColumnsWindowPayload>;
      onShiftColumnsInit: (cb: (payload: ShiftColumnsWindowPayload) => void) => () => void;
      applyShiftColumns: (payload: ShiftColumnsAppliedPayload) => void;
      closeShiftColumnsWindow: () => void;

      // Main window: open (or focus/reseed) the separate Cleaner
      // configure window for one node -- same real-window pattern as
      // Filter Builder/Header Promoter/Merge/Shift Columns above,
      // including round-tripping edits back on Apply.
      openCleanerWindow: (payload: CleanerWindowPayload) => void;
      onCleanerApplied: (cb: (payload: CleanerAppliedPayload) => void) => () => void;
      // Cleaner window only -- nodeId is which one of potentially several
      // open Configure windows this is (read from this window's own URL,
      // same reasoning as requestFilterBuilderInit above).
      requestCleanerInit: (nodeId: string) => Promise<CleanerWindowPayload>;
      onCleanerInit: (cb: (payload: CleanerWindowPayload) => void) => () => void;
      applyCleaner: (payload: CleanerAppliedPayload) => void;
      closeCleanerWindow: () => void;

      // Main window: open (or focus/reseed) the separate Unique
      // configure window for one node -- same real-window pattern as
      // Filter Builder/Header Promoter/Merge/Shift Columns/Cleaner
      // above, including round-tripping edits back on Apply.
      openUniqueWindow: (payload: UniqueWindowPayload) => void;
      onUniqueApplied: (cb: (payload: UniqueAppliedPayload) => void) => () => void;
      // Unique window only -- nodeId is which one of potentially several
      // open Configure windows this is (read from this window's own URL,
      // same reasoning as requestFilterBuilderInit above).
      requestUniqueInit: (nodeId: string) => Promise<UniqueWindowPayload>;
      onUniqueInit: (cb: (payload: UniqueWindowPayload) => void) => () => void;
      applyUnique: (payload: UniqueAppliedPayload) => void;
      closeUniqueWindow: () => void;

      // Main window: open (or focus/reseed) the separate Column Edit
      // configure window for one node -- same real-window pattern as
      // Filter Builder/Header Promoter/Merge/Shift Columns/Cleaner/
      // Unique above, including round-tripping edits back on Apply.
      openColumnEditWindow: (payload: ColumnEditWindowPayload) => void;
      onColumnEditApplied: (cb: (payload: ColumnEditAppliedPayload) => void) => () => void;
      // Column Edit window only -- nodeId is which one of potentially
      // several open Configure windows this is (read from this window's
      // own URL, same reasoning as requestFilterBuilderInit above).
      requestColumnEditInit: (nodeId: string) => Promise<ColumnEditWindowPayload>;
      onColumnEditInit: (cb: (payload: ColumnEditWindowPayload) => void) => () => void;
      applyColumnEdit: (payload: ColumnEditAppliedPayload) => void;
      closeColumnEditWindow: () => void;

      // Main window: open (or focus/reseed) the separate Change Type
      // configure window for one node -- same real-window pattern as
      // Filter Builder/Header Promoter/Merge/Shift Columns/Cleaner/
      // Unique/Column Edit above, including round-tripping edits back on
      // Apply.
      openChangeTypeWindow: (payload: ChangeTypeWindowPayload) => void;
      onChangeTypeApplied: (cb: (payload: ChangeTypeAppliedPayload) => void) => () => void;
      // Change Type window only -- nodeId is which one of potentially
      // several open Configure windows this is (read from this window's
      // own URL, same reasoning as requestFilterBuilderInit above).
      requestChangeTypeInit: (nodeId: string) => Promise<ChangeTypeWindowPayload>;
      onChangeTypeInit: (cb: (payload: ChangeTypeWindowPayload) => void) => () => void;
      applyChangeType: (payload: ChangeTypeAppliedPayload) => void;
      closeChangeTypeWindow: () => void;

      // Main window: open (or focus/reseed) the separate Regular
      // Expressions configure window for one node -- same real-window
      // pattern as Filter Builder/Header Promoter/Merge/Shift Columns/
      // Cleaner/Unique/Column Edit/Change Type above, including round-
      // tripping edits back on Apply.
      openRegexWindow: (payload: RegexWindowPayload) => void;
      onRegexApplied: (cb: (payload: RegexAppliedPayload) => void) => () => void;
      // Regex window only -- nodeId is which one of potentially several
      // open Configure windows this is (read from this window's own
      // URL, same reasoning as requestFilterBuilderInit above).
      requestRegexInit: (nodeId: string) => Promise<RegexWindowPayload>;
      onRegexInit: (cb: (payload: RegexWindowPayload) => void) => () => void;
      applyRegex: (payload: RegexAppliedPayload) => void;
      closeRegexWindow: () => void;

      // Main window: closes whichever kept-alive per-node window
      // (Configure, Browse, Header Promoter, Merge, Shift Columns,
      // Cleaner, Unique, Column Edit, Change Type, or Regular
      // Expressions) is currently showing this node, if any.
      notifyNodeDeleted: (nodeId: string) => void;
    };
  }
}
