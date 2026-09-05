import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("alteraStudio", {
  backendUrl: "http://127.0.0.1:8756",
  openPdfDialog: (): Promise<string | null> => ipcRenderer.invoke("dialog:openPdf"),
  readFileBase64: (path: string): Promise<string> => ipcRenderer.invoke("fs:readFileBase64", path),

  // Project save/open -- the custom menu bar's File menu (see
  // src/components/MenuBar.tsx and App.tsx's handleSaveProject*/handleOpenProject).
  saveProjectAs: (jsonData: string): Promise<string | null> => ipcRenderer.invoke("project:saveAs", jsonData),
  saveProjectToPath: (filePath: string, jsonData: string): Promise<boolean> =>
    ipcRenderer.invoke("project:saveToPath", filePath, jsonData),
  openProjectDialog: (): Promise<{ path: string; data: string } | null> => ipcRenderer.invoke("project:open"),
  restartApp: (): void => {
    ipcRenderer.send("app:restart");
  },
  // Opens a URL in the user's default browser instead of navigating this
  // window -- used by the Help menu's About/Docs links (see MenuBar.tsx).
  openExternalUrl: (url: string): void => {
    ipcRenderer.send("shell:openExternal", url);
  },

  // Main window: open (or focus/reseed) the separate Settings window.
  openSettingsWindow: (payload: unknown): void => {
    ipcRenderer.invoke("settings:open", payload);
  },
  // Main window: loads whatever was persisted from the last session (null
  // if this is the first ever launch).
  loadPersistedSettings: (): Promise<unknown> => ipcRenderer.invoke("settings:load"),
  // Main window: fires when the Settings window saves.
  onSettingsApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("settings:applied", listener);
    return () => ipcRenderer.removeListener("settings:applied", listener);
  },

  // Settings window only: pulls the current values once actually mounted
  // (avoids racing did-finish-load -- see main.ts's settings:request-init).
  requestSettingsInit: (): Promise<unknown> => ipcRenderer.invoke("settings:request-init"),
  // Settings window only: receives pushed updates for the "already open,
  // reseeded by a second settings:open call" case.
  onSettingsInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("settings:init", listener);
    return () => ipcRenderer.removeListener("settings:init", listener);
  },
  saveSettings: (payload: unknown): void => {
    ipcRenderer.send("settings:save", payload);
  },
  closeSettingsWindow: (): void => {
    ipcRenderer.send("settings:close");
  },

  // Main window: open (or focus/reseed) the separate Filter Builder
  // configure window for one node.
  openFilterBuilderWindow: (payload: unknown): void => {
    ipcRenderer.invoke("filterBuilder:open", payload);
  },
  // Main window: fires when the Filter Builder window applies its edits.
  onFilterBuilderApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("filterBuilder:applied", listener);
    return () => ipcRenderer.removeListener("filterBuilder:applied", listener);
  },

  // Filter Builder window only: pulls the current payload once actually
  // mounted (avoids racing did-finish-load, same reasoning as
  // requestSettingsInit above). `nodeId` (read from this window's own
  // URL, see main.ts's createPerNodeWindowManager) is which node's
  // payload to pull, since a Filter Builder window is now one of
  // potentially several open at once, each for a different node.
  requestFilterBuilderInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("filterBuilder:request-init", nodeId),
  // Filter Builder window only: receives pushed updates for the "already
  // open, reseeded by a second filterBuilder:open call" case.
  onFilterBuilderInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("filterBuilder:init", listener);
    return () => ipcRenderer.removeListener("filterBuilder:init", listener);
  },
  applyFilterBuilder: (payload: unknown): void => {
    ipcRenderer.send("filterBuilder:apply", payload);
  },
  closeFilterBuilderWindow: (): void => {
    ipcRenderer.send("filterBuilder:close");
  },

  // Main window: open (or focus/reseed) the separate Browse data-viewer
  // window for one node. No onBrowseApplied counterpart -- it's a pure
  // viewer, nothing to write back.
  openBrowseWindow: (payload: unknown): void => {
    ipcRenderer.invoke("browse:open", payload);
  },
  // Browse window only: pulls the current payload once actually mounted
  // (avoids racing did-finish-load, same reasoning as requestSettingsInit
  // above). `nodeId` (read from this window's own URL) is which node's
  // payload to pull -- same reasoning as requestFilterBuilderInit above.
  requestBrowseInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("browse:request-init", nodeId),
  // Browse window only: receives pushed updates for the "already open,
  // reseeded by a second browse:open call" case.
  onBrowseInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("browse:init", listener);
    return () => ipcRenderer.removeListener("browse:init", listener);
  },
  closeBrowseWindow: (): void => {
    ipcRenderer.send("browse:close");
  },
  // Main window: silently refreshes an already-open Browse window's data
  // (no show/focus, unlike openBrowseWindow) -- called whenever the
  // node's resolved input actually changes, e.g. a real Convert finishing.
  pushBrowseUpdate: (payload: unknown): void => {
    ipcRenderer.send("browse:push-update", payload);
  },

  // Main window: open (or focus/reseed) the separate Summary data-profile
  // window for one node -- same pure-viewer shape as Browse above (no
  // onSummaryApplied counterpart, nothing to write back).
  openSummaryWindow: (payload: unknown): void => {
    ipcRenderer.invoke("summary:open", payload);
  },
  requestSummaryInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("summary:request-init", nodeId),
  onSummaryInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("summary:init", listener);
    return () => ipcRenderer.removeListener("summary:init", listener);
  },
  closeSummaryWindow: (): void => {
    ipcRenderer.send("summary:close");
  },
  pushSummaryUpdate: (payload: unknown): void => {
    ipcRenderer.send("summary:push-update", payload);
  },

  // Main window: open (or focus/reseed) the separate Header Promoter
  // configure window for one node -- same real-window, round-trips-on-
  // Apply pattern as Filter Builder above.
  openHeaderPromoterWindow: (payload: unknown): void => {
    ipcRenderer.invoke("headerPromoter:open", payload);
  },
  onHeaderPromoterApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("headerPromoter:applied", listener);
    return () => ipcRenderer.removeListener("headerPromoter:applied", listener);
  },
  requestHeaderPromoterInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("headerPromoter:request-init", nodeId),
  onHeaderPromoterInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("headerPromoter:init", listener);
    return () => ipcRenderer.removeListener("headerPromoter:init", listener);
  },
  applyHeaderPromoter: (payload: unknown): void => {
    ipcRenderer.send("headerPromoter:apply", payload);
  },
  closeHeaderPromoterWindow: (): void => {
    ipcRenderer.send("headerPromoter:close");
  },

  // Main window: open (or focus/reseed) the separate Merge configure
  // window for one node -- same real-window, round-trips-on-Apply pattern
  // as Filter Builder/Header Promoter above.
  openMergeWindow: (payload: unknown): void => {
    ipcRenderer.invoke("merge:open", payload);
  },
  onMergeApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("merge:applied", listener);
    return () => ipcRenderer.removeListener("merge:applied", listener);
  },
  requestMergeInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("merge:request-init", nodeId),
  onMergeInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("merge:init", listener);
    return () => ipcRenderer.removeListener("merge:init", listener);
  },
  applyMerge: (payload: unknown): void => {
    ipcRenderer.send("merge:apply", payload);
  },
  closeMergeWindow: (): void => {
    ipcRenderer.send("merge:close");
  },

  // Main window: open (or focus/reseed) the separate Shift Columns
  // configure window for one node -- same real-window, round-trips-on-
  // Apply pattern as Filter Builder/Header Promoter/Merge above.
  openShiftColumnsWindow: (payload: unknown): void => {
    ipcRenderer.invoke("shiftColumns:open", payload);
  },
  onShiftColumnsApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("shiftColumns:applied", listener);
    return () => ipcRenderer.removeListener("shiftColumns:applied", listener);
  },
  requestShiftColumnsInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("shiftColumns:request-init", nodeId),
  onShiftColumnsInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("shiftColumns:init", listener);
    return () => ipcRenderer.removeListener("shiftColumns:init", listener);
  },
  applyShiftColumns: (payload: unknown): void => {
    ipcRenderer.send("shiftColumns:apply", payload);
  },
  closeShiftColumnsWindow: (): void => {
    ipcRenderer.send("shiftColumns:close");
  },

  // Main window: open (or focus/reseed) the separate Cleaner configure
  // window for one node -- same real-window, round-trips-on-Apply pattern
  // as Filter Builder/Header Promoter/Merge/Shift Columns above.
  openCleanerWindow: (payload: unknown): void => {
    ipcRenderer.invoke("cleaner:open", payload);
  },
  onCleanerApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("cleaner:applied", listener);
    return () => ipcRenderer.removeListener("cleaner:applied", listener);
  },
  requestCleanerInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("cleaner:request-init", nodeId),
  onCleanerInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("cleaner:init", listener);
    return () => ipcRenderer.removeListener("cleaner:init", listener);
  },
  applyCleaner: (payload: unknown): void => {
    ipcRenderer.send("cleaner:apply", payload);
  },
  closeCleanerWindow: (): void => {
    ipcRenderer.send("cleaner:close");
  },

  // Same real-window, round-trips-on-Apply pattern as Cleaner above.
  openTextParserWindow: (payload: unknown): void => {
    ipcRenderer.invoke("textParser:open", payload);
  },
  onTextParserApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("textParser:applied", listener);
    return () => ipcRenderer.removeListener("textParser:applied", listener);
  },
  requestTextParserInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("textParser:request-init", nodeId),
  onTextParserInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("textParser:init", listener);
    return () => ipcRenderer.removeListener("textParser:init", listener);
  },
  applyTextParser: (payload: unknown): void => {
    ipcRenderer.send("textParser:apply", payload);
  },
  closeTextParserWindow: (): void => {
    ipcRenderer.send("textParser:close");
  },

  // Same real-window, round-trips-on-Apply pattern as Cleaner/Text Parser
  // above, plus its own native file-picker dialog.
  openInputDataWindow: (payload: unknown): void => {
    ipcRenderer.invoke("inputData:open", payload);
  },
  onInputDataApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("inputData:applied", listener);
    return () => ipcRenderer.removeListener("inputData:applied", listener);
  },
  requestInputDataInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("inputData:request-init", nodeId),
  onInputDataInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("inputData:init", listener);
    return () => ipcRenderer.removeListener("inputData:init", listener);
  },
  applyInputData: (payload: unknown): void => {
    ipcRenderer.send("inputData:apply", payload);
  },
  closeInputDataWindow: (): void => {
    ipcRenderer.send("inputData:close");
  },
  chooseInputDataFile: (): Promise<string | null> => ipcRenderer.invoke("inputData:chooseFile"),

  // Same real-window, round-trips-on-Apply pattern as every Configure
  // window above.
  openSortWindow: (payload: unknown): void => {
    ipcRenderer.invoke("sort:open", payload);
  },
  onSortApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("sort:applied", listener);
    return () => ipcRenderer.removeListener("sort:applied", listener);
  },
  requestSortInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("sort:request-init", nodeId),
  onSortInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("sort:init", listener);
    return () => ipcRenderer.removeListener("sort:init", listener);
  },
  applySort: (payload: unknown): void => {
    ipcRenderer.send("sort:apply", payload);
  },
  closeSortWindow: (): void => {
    ipcRenderer.send("sort:close");
  },

  openAggregateWindow: (payload: unknown): void => {
    ipcRenderer.invoke("aggregate:open", payload);
  },
  onAggregateApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("aggregate:applied", listener);
    return () => ipcRenderer.removeListener("aggregate:applied", listener);
  },
  requestAggregateInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("aggregate:request-init", nodeId),
  onAggregateInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("aggregate:init", listener);
    return () => ipcRenderer.removeListener("aggregate:init", listener);
  },
  applyAggregate: (payload: unknown): void => {
    ipcRenderer.send("aggregate:apply", payload);
  },
  closeAggregateWindow: (): void => {
    ipcRenderer.send("aggregate:close");
  },

  // Main window: open (or focus/reseed) the separate Unique configure
  // window for one node -- same real-window, round-trips-on-Apply pattern
  // as Filter Builder/Header Promoter/Merge/Shift Columns/Cleaner above.
  openUniqueWindow: (payload: unknown): void => {
    ipcRenderer.invoke("unique:open", payload);
  },
  onUniqueApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("unique:applied", listener);
    return () => ipcRenderer.removeListener("unique:applied", listener);
  },
  requestUniqueInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("unique:request-init", nodeId),
  onUniqueInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("unique:init", listener);
    return () => ipcRenderer.removeListener("unique:init", listener);
  },
  applyUnique: (payload: unknown): void => {
    ipcRenderer.send("unique:apply", payload);
  },
  closeUniqueWindow: (): void => {
    ipcRenderer.send("unique:close");
  },

  // Main window: open (or focus/reseed) the separate Column Edit
  // configure window for one node -- same real-window, round-trips-on-
  // Apply pattern as Filter Builder/Header Promoter/Merge/Shift Columns/
  // Cleaner/Unique above.
  openColumnEditWindow: (payload: unknown): void => {
    ipcRenderer.invoke("columnEdit:open", payload);
  },
  onColumnEditApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("columnEdit:applied", listener);
    return () => ipcRenderer.removeListener("columnEdit:applied", listener);
  },
  requestColumnEditInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("columnEdit:request-init", nodeId),
  onColumnEditInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("columnEdit:init", listener);
    return () => ipcRenderer.removeListener("columnEdit:init", listener);
  },
  applyColumnEdit: (payload: unknown): void => {
    ipcRenderer.send("columnEdit:apply", payload);
  },
  closeColumnEditWindow: (): void => {
    ipcRenderer.send("columnEdit:close");
  },

  // Main window: open (or focus/reseed) the separate Change Type
  // configure window for one node -- same real-window, round-trips-on-
  // Apply pattern as Filter Builder/Header Promoter/Merge/Shift Columns/
  // Cleaner/Unique/Column Edit above.
  openChangeTypeWindow: (payload: unknown): void => {
    ipcRenderer.invoke("changeType:open", payload);
  },
  onChangeTypeApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("changeType:applied", listener);
    return () => ipcRenderer.removeListener("changeType:applied", listener);
  },
  requestChangeTypeInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("changeType:request-init", nodeId),
  onChangeTypeInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("changeType:init", listener);
    return () => ipcRenderer.removeListener("changeType:init", listener);
  },
  applyChangeType: (payload: unknown): void => {
    ipcRenderer.send("changeType:apply", payload);
  },
  closeChangeTypeWindow: (): void => {
    ipcRenderer.send("changeType:close");
  },

  // Main window: open (or focus/reseed) the separate Regular Expressions
  // configure window for one node -- same real-window, round-trips-on-
  // Apply pattern as Filter Builder/Header Promoter/Merge/Shift Columns/
  // Cleaner/Unique/Column Edit/Change Type above.
  openRegexWindow: (payload: unknown): void => {
    ipcRenderer.invoke("regex:open", payload);
  },
  onRegexApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("regex:applied", listener);
    return () => ipcRenderer.removeListener("regex:applied", listener);
  },
  requestRegexInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("regex:request-init", nodeId),
  onRegexInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("regex:init", listener);
    return () => ipcRenderer.removeListener("regex:init", listener);
  },
  applyRegex: (payload: unknown): void => {
    ipcRenderer.send("regex:apply", payload);
  },
  closeRegexWindow: (): void => {
    ipcRenderer.send("regex:close");
  },

  // Main window: open (or focus/reseed) the separate Cascade Fill
  // configure window for one node -- same real-window, round-trips-on-
  // Apply pattern as Filter Builder/Header Promoter/Merge/Shift Columns/
  // Cleaner/Unique/Column Edit/Change Type/Regex above.
  openCascadeFillWindow: (payload: unknown): void => {
    ipcRenderer.invoke("cascadeFill:open", payload);
  },
  onCascadeFillApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("cascadeFill:applied", listener);
    return () => ipcRenderer.removeListener("cascadeFill:applied", listener);
  },
  requestCascadeFillInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("cascadeFill:request-init", nodeId),
  onCascadeFillInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("cascadeFill:init", listener);
    return () => ipcRenderer.removeListener("cascadeFill:init", listener);
  },
  applyCascadeFill: (payload: unknown): void => {
    ipcRenderer.send("cascadeFill:apply", payload);
  },
  closeCascadeFillWindow: (): void => {
    ipcRenderer.send("cascadeFill:close");
  },

  // Main window: open (or focus/reseed) the separate Export configure
  // window for one node -- same real-window, round-trips-on-Apply pattern
  // as Filter Builder/Header Promoter/Merge/Shift Columns/Cleaner/Unique/
  // Column Edit/Change Type/Regex/Cascade Fill above.
  openExportWindow: (payload: unknown): void => {
    ipcRenderer.invoke("export:open", payload);
  },
  onExportApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("export:applied", listener);
    return () => ipcRenderer.removeListener("export:applied", listener);
  },
  requestExportInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("export:request-init", nodeId),
  onExportInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("export:init", listener);
    return () => ipcRenderer.removeListener("export:init", listener);
  },
  applyExport: (payload: unknown): void => {
    ipcRenderer.send("export:apply", payload);
  },
  closeExportWindow: (): void => {
    ipcRenderer.send("export:close");
  },
  chooseExportFile: (): Promise<string | null> => ipcRenderer.invoke("export:chooseFile"),
  chooseExportFolder: (): Promise<string | null> => ipcRenderer.invoke("export:chooseFolder"),

  // Main window: open (or focus/reseed) the separate Unpivot Columns
  // configure window for one node -- same real-window, round-trips-on-
  // Apply pattern as every other Configure window above.
  openUnpivotColumnsWindow: (payload: unknown): void => {
    ipcRenderer.invoke("unpivotColumns:open", payload);
  },
  onUnpivotColumnsApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("unpivotColumns:applied", listener);
    return () => ipcRenderer.removeListener("unpivotColumns:applied", listener);
  },
  requestUnpivotColumnsInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("unpivotColumns:request-init", nodeId),
  onUnpivotColumnsInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("unpivotColumns:init", listener);
    return () => ipcRenderer.removeListener("unpivotColumns:init", listener);
  },
  applyUnpivotColumns: (payload: unknown): void => {
    ipcRenderer.send("unpivotColumns:apply", payload);
  },
  closeUnpivotColumnsWindow: (): void => {
    ipcRenderer.send("unpivotColumns:close");
  },

  // Main window: open (or focus/reseed) the separate Pivot Columns
  // configure window for one node -- same real-window, round-trips-on-
  // Apply pattern as every other Configure window above.
  openPivotColumnsWindow: (payload: unknown): void => {
    ipcRenderer.invoke("pivotColumns:open", payload);
  },
  onPivotColumnsApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("pivotColumns:applied", listener);
    return () => ipcRenderer.removeListener("pivotColumns:applied", listener);
  },
  requestPivotColumnsInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("pivotColumns:request-init", nodeId),
  onPivotColumnsInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("pivotColumns:init", listener);
    return () => ipcRenderer.removeListener("pivotColumns:init", listener);
  },
  applyPivotColumns: (payload: unknown): void => {
    ipcRenderer.send("pivotColumns:apply", payload);
  },
  closePivotColumnsWindow: (): void => {
    ipcRenderer.send("pivotColumns:close");
  },

  // Main window: open (or focus/reseed) the separate Add Column configure
  // window for one node -- same real-window, round-trips-on-Apply pattern
  // as every other Configure window above.
  openAddColumnWindow: (payload: unknown): void => {
    ipcRenderer.invoke("addColumn:open", payload);
  },
  onAddColumnApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("addColumn:applied", listener);
    return () => ipcRenderer.removeListener("addColumn:applied", listener);
  },
  requestAddColumnInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("addColumn:request-init", nodeId),
  onAddColumnInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("addColumn:init", listener);
    return () => ipcRenderer.removeListener("addColumn:init", listener);
  },
  applyAddColumn: (payload: unknown): void => {
    ipcRenderer.send("addColumn:apply", payload);
  },
  closeAddColumnWindow: (): void => {
    ipcRenderer.send("addColumn:close");
  },

  // Main window: open (or focus/reseed) the separate conditional Add
  // Column configure window for one node -- same real-window,
  // round-trips-on-Apply pattern as every other Configure window above.
  openConditionalColumnWindow: (payload: unknown): void => {
    ipcRenderer.invoke("conditionalColumn:open", payload);
  },
  onConditionalColumnApplied: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("conditionalColumn:applied", listener);
    return () => ipcRenderer.removeListener("conditionalColumn:applied", listener);
  },
  requestConditionalColumnInit: (nodeId: string): Promise<unknown> => ipcRenderer.invoke("conditionalColumn:request-init", nodeId),
  onConditionalColumnInit: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("conditionalColumn:init", listener);
    return () => ipcRenderer.removeListener("conditionalColumn:init", listener);
  },
  applyConditionalColumn: (payload: unknown): void => {
    ipcRenderer.send("conditionalColumn:apply", payload);
  },
  closeConditionalColumnWindow: (): void => {
    ipcRenderer.send("conditionalColumn:close");
  },

  // Main window: closes whichever kept-alive window (Configure or Browse)
  // is currently showing this node, if any -- called once per deleted
  // processor node so an open per-node window doesn't outlive the node
  // it represents.
  notifyNodeDeleted: (nodeId: string): void => {
    ipcRenderer.send("node:deleted", nodeId);
  },
});
