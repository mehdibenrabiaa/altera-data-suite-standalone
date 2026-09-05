import { useCallback, useEffect, useRef, useState } from "react";

// Real Lucide icon paths (save.svg/undo-2.svg/redo-2.svg), replacing the
// earlier hand-drawn approximations.
function SaveGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
      <path d="M7 3v4a1 1 0 0 0 1 1h7" />
    </svg>
  );
}
function UndoGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
    </svg>
  );
}
function RedoGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" />
    </svg>
  );
}
// Lucide's play icon (public/play.svg) -- same stroke-only style as the
// three glyphs above.
function PlayGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
    </svg>
  );
}
interface MenuBarProps {
  onOpenProject: () => void;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  onOpenSettings: () => void;
  onOpenExternalUrl: (url: string) => void;
  onRestart: () => void;
  onExit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDelete: () => void;
  hasSelection: boolean;
  hasClipboard: boolean;
  // Force-runs every runnable Workflow node regardless of whether its
  // inputs already look up to date (nodes with a runnable kind normally
  // run automatically as their inputs change -- see SchemaView.tsx).
  onRunAll: () => void;
}

type OpenMenu = "file" | "edit" | "help" | null;

export default function MenuBar({
  onOpenProject,
  onSaveProject,
  onSaveProjectAs,
  onOpenSettings,
  onOpenExternalUrl,
  onRestart,
  onExit,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onCut,
  onCopy,
  onPaste,
  onDelete,
  hasSelection,
  hasClipboard,
  onRunAll,
}: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onEscape);
    };
  }, [openMenu]);

  const toggleMenu = useCallback((menu: OpenMenu) => {
    setOpenMenu((cur) => (cur === menu ? null : menu));
  }, []);
  // Once one top-level menu is open, hovering the other one swaps straight
  // over to it (standard menu-bar behavior) instead of requiring a click.
  const hoverToMenu = useCallback((menu: OpenMenu) => {
    setOpenMenu((cur) => (cur ? menu : cur));
  }, []);

  const runAndClose = useCallback((fn: () => void) => {
    fn();
    setOpenMenu(null);
  }, []);

  return (
    <div className="menu-bar" ref={wrapperRef}>
      <div className="menu-bar-item-wrap">
        <button
          className={`menu-bar-item ${openMenu === "file" ? "active" : ""}`}
          onClick={() => toggleMenu("file")}
          onMouseEnter={() => hoverToMenu("file")}
        >
          File
        </button>
        {openMenu === "file" && (
          <div className="menu-bar-dropdown">
            {/* No keyboard shortcut here -- Ctrl+O is already Open PDF
                (see ToolbarPanel's Open button), a separate, more common
                action than opening a saved .altera project file. */}
            <div className="ctx-menu-item" onClick={() => runAndClose(onOpenProject)}>
              <span>Open Project…</span>
            </div>
            <div className="ctx-menu-item" onClick={() => runAndClose(onSaveProject)}>
              <span>Save</span>
              <span className="ctx-menu-shortcut">Ctrl+S</span>
            </div>
            <div className="ctx-menu-item" onClick={() => runAndClose(onSaveProjectAs)}>
              <span>Save As…</span>
              <span className="ctx-menu-shortcut">Ctrl+Shift+S</span>
            </div>
            <div className="ctx-menu-divider" />
            <div className="ctx-menu-item" onClick={() => runAndClose(onOpenSettings)}>
              <span>Settings</span>
              <span className="ctx-menu-shortcut">Ctrl+,</span>
            </div>
            <div className="ctx-menu-divider" />
            <div className="ctx-menu-item" onClick={() => runAndClose(onRestart)}>
              <span>Restart</span>
            </div>
            <div className="ctx-menu-item" onClick={() => runAndClose(onExit)}>
              <span>Exit</span>
            </div>
          </div>
        )}
      </div>

      <div className="menu-bar-item-wrap">
        <button
          className={`menu-bar-item ${openMenu === "edit" ? "active" : ""}`}
          onClick={() => toggleMenu("edit")}
          onMouseEnter={() => hoverToMenu("edit")}
        >
          Edit
        </button>
        {openMenu === "edit" && (
          <div className="menu-bar-dropdown">
            <div className={`ctx-menu-item ${!canUndo ? "disabled" : ""}`} onClick={() => canUndo && runAndClose(onUndo)}>
              <span>Undo</span>
              <span className="ctx-menu-shortcut">Ctrl+Z</span>
            </div>
            <div className={`ctx-menu-item ${!canRedo ? "disabled" : ""}`} onClick={() => canRedo && runAndClose(onRedo)}>
              <span>Redo</span>
              <span className="ctx-menu-shortcut">Ctrl+Y</span>
            </div>
            <div className="ctx-menu-divider" />
            <div className={`ctx-menu-item ${!hasSelection ? "disabled" : ""}`} onClick={() => hasSelection && runAndClose(onCut)}>
              <span>Cut</span>
              <span className="ctx-menu-shortcut">Ctrl+X</span>
            </div>
            <div className={`ctx-menu-item ${!hasSelection ? "disabled" : ""}`} onClick={() => hasSelection && runAndClose(onCopy)}>
              <span>Copy</span>
              <span className="ctx-menu-shortcut">Ctrl+C</span>
            </div>
            <div className={`ctx-menu-item ${!hasClipboard ? "disabled" : ""}`} onClick={() => hasClipboard && runAndClose(onPaste)}>
              <span>Paste</span>
              <span className="ctx-menu-shortcut">Ctrl+V</span>
            </div>
            <div className="ctx-menu-divider" />
            <div className={`ctx-menu-item ${!hasSelection ? "disabled" : ""}`} onClick={() => hasSelection && runAndClose(onDelete)}>
              <span>Delete</span>
              <span className="ctx-menu-shortcut">Del</span>
            </div>
          </div>
        )}
      </div>

      <div className="menu-bar-item-wrap">
        <button
          className={`menu-bar-item ${openMenu === "help" ? "active" : ""}`}
          onClick={() => toggleMenu("help")}
          onMouseEnter={() => hoverToMenu("help")}
        >
          Help
        </button>
        {openMenu === "help" && (
          <div className="menu-bar-dropdown">
            <div className="ctx-menu-item" onClick={() => runAndClose(() => onOpenExternalUrl("https://alteradatasuite.com/about"))}>
              <span>About Altera Data Suite</span>
            </div>
            <div className="ctx-menu-item" onClick={() => runAndClose(() => onOpenExternalUrl("https://alteradatasuite.com/docs"))}>
              <span>Documentation</span>
            </div>
          </div>
        )}
      </div>

      <div className="menu-bar-sep" />

      <button className="menu-bar-icon-btn" onClick={onSaveProject} title="Save (Ctrl+S)">
        <SaveGlyph />
      </button>
      <button className="menu-bar-icon-btn" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
        <UndoGlyph />
      </button>
      <button className="menu-bar-icon-btn" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)">
        <RedoGlyph />
      </button>
      <div className="menu-bar-sep" />
      <button className="menu-bar-icon-btn" onClick={onRunAll} title="Run all Workflow nodes">
        <PlayGlyph />
      </button>
    </div>
  );
}
