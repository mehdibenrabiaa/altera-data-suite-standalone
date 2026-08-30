// Power-Query-style column-type icon shown before a grid header's column
// name (BrowseWindow.tsx, SchemaView.tsx's output drawer) -- see
// columnTypeDetection.ts for how the type itself is detected. Inlined as
// plain SVG rather than <img src> files so a header cell renders with zero
// extra network/asset requests, same reasoning as this app's other inline
// glyph components (CircleXGlyph, DrawerChevronIcon, ...). text/integer/
// float are the user's own custom-provided glyphs (source files kept at
// public/column-type-icons/ for reference/future edits, path data copied
// in here); calendar-days (date) is still Lucide's own -- the one icon the
// user explicitly asked for by name, https://lucide.dev/icons/calendar-days.
import type { IHeaderParams } from "ag-grid-community";
import type { DetectedColumnType } from "./columnTypeDetection";

function CalendarDaysIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v3" />
      <path d="M16 2v3" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 13h.01" />
      <path d="M12 13h.01" />
      <path d="M16 13h.01" />
      <path d="M8 17h.01" />
      <path d="M12 17h.01" />
      <path d="M16 17h.01" />
    </svg>
  );
}
function IntegerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.5,9.4H6c0.2,0,0.4,0.1,0.4,0.4v10c0,0.2-0.1,0.4-0.4,0.4H4.6c-0.2,0-0.4-0.1-0.4-0.4v-8.2l-2.1,1.1
        c-0.2,0.1-0.4,0-0.4-0.2v-1.3c0-0.2,0.1-0.3,0.2-0.4l2.1-1.1C4.2,9.4,4.3,9.4,4.5,9.4z" />
      <path d="M7.3,12.5v-0.9c0-0.2,0.1-0.3,0.2-0.4l3.5-3.5c0.7-0.7,1.3-1.5,1.3-2.2c0-0.9-0.5-1.4-1.3-1.4c-0.8,0-1.3,0.3-1.4,1.1
        c0,0.2-0.2,0.4-0.4,0.4H7.7c-0.2,0-0.4-0.1-0.3-0.4c0.2-2.2,1.8-3.1,3.5-3.1c1.7,0,3.5,1.1,3.5,3.4c0,1.2-0.8,2.4-1.7,3.3l-2.2,2.1
        h3.7c0.2,0,0.4,0.1,0.4,0.4v1.3c0,0.2-0.1,0.4-0.4,0.4H7.7C7.4,12.9,7.3,12.7,7.3,12.5z" />
      <path d="M21.9,16.8c0,2.3-1.8,3.5-3.8,3.5c-1.9,0-3.6-1.1-3.8-3.1c0-0.2,0.1-0.4,0.4-0.4H16c0.2,0,0.3,0.1,0.4,0.3
        c0.1,0.7,0.7,1.1,1.7,1.1c1.1,0,1.7-0.6,1.7-1.5c0-0.9-0.6-1.5-1.7-1.5h-0.8c-0.2,0-0.4-0.1-0.4-0.4v-0.8c0-0.2,0.1-0.3,0.2-0.5
        l1.8-2.4H15c-0.2,0-0.4-0.1-0.4-0.4V9.8c0-0.2,0.1-0.4,0.4-0.4h6c0.2,0,0.4,0.1,0.4,0.4v1.1c0,0.2-0.1,0.3-0.2,0.5l-1.8,2.4
        C20.8,14.2,21.9,15.2,21.9,16.8z" />
    </svg>
  );
}
function FloatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.9,4.8h1.7C6.9,4.8,7,4.9,7,5.2v11.6c0,0.3-0.2,0.4-0.4,0.4H5c-0.3,0-0.4-0.2-0.4-0.4V7.2L2.2,8.6C2,8.7,1.7,8.6,1.7,8.3
        V6.7c0-0.2,0.1-0.4,0.3-0.5l2.4-1.3C4.6,4.8,4.7,4.8,4.9,4.8z" />
      <path d="M9.4,16.8v-1.7c0-0.3,0.1-0.4,0.4-0.4h1.7c0.3,0,0.4,0.2,0.4,0.4v1.7c0,0.3-0.2,0.4-0.4,0.4H9.9
        C9.6,17.2,9.4,17.1,9.4,16.8z" />
      <path d="M13.6,16.8v-1.1c0-0.2,0.1-0.4,0.2-0.5l4-4c0.8-0.8,1.4-1.7,1.4-2.6c0-1-0.6-1.6-1.5-1.6c-0.9,0-1.5,0.4-1.6,1.3
        c0,0.3-0.2,0.4-0.4,0.4h-1.6c-0.3,0-0.4-0.2-0.4-0.4c0.2-2.5,2.1-3.6,4-3.6c2,0,4,1.3,4,4c0,1.4-0.9,2.8-1.9,3.9l-2.5,2.4h4.2
        c0.3,0,0.4,0.2,0.4,0.4v1.5c0,0.3-0.2,0.4-0.4,0.4h-7.4C13.8,17.2,13.6,17.1,13.6,16.8z" />
    </svg>
  );
}
function TextIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8,10c0.1,0.2,0,0.3-0.2,0.3h-1c-0.1,0-0.2-0.1-0.3-0.2L6.1,9H3.4L3,10.1c0,0.1-0.1,0.2-0.3,0.2h-1
        c-0.2,0-0.3-0.1-0.2-0.3l2.3-6.7c0-0.1,0.1-0.2,0.3-0.2h1.3c0.1,0,0.2,0.1,0.3,0.2L8,10L8,10z M5.7,7.7l-1-3l-1,3H5.7z" />
      <path d="M14.8,8c0,1.3-1,2.3-2.3,2.3H9.1H9c-0.2,0-0.2-0.1-0.2-0.2V3.4c0-0.2,0.1-0.2,0.2-0.2h1.2h1.6c1.2,0,2.1,0.8,2.1,1.9
        c0,0.3-0.1,0.6-0.3,0.9C14.3,6.3,14.8,7.1,14.8,8z M10.1,4.5v1.2h2.1c0.1-0.1,0.2-0.3,0.2-0.5c0-0.4-0.3-0.7-0.7-0.7H10.1z
        M13.4,7.9c0-0.6-0.3-1-1-1h-2.2V9h2.2C13.1,9,13.4,8.5,13.4,7.9z" />
      <path d="M15.4,6.7C15.4,4.6,17,3,19.1,3c1.6,0,3,1,3.4,2.4c0,0.2,0,0.3-0.2,0.3h-1c-0.1,0-0.2-0.1-0.3-0.2
        c-0.3-0.7-1.1-1.1-1.9-1.1c-1.4,0-2.3,1-2.3,2.3c0,1.4,0.9,2.3,2.3,2.3C20,9,20.7,8.6,21,7.9c0.1-0.1,0.1-0.2,0.3-0.2h1
        c0.2,0,0.3,0.1,0.2,0.3c-0.4,1.4-1.8,2.4-3.4,2.4C16.9,10.4,15.4,8.8,15.4,6.7z" />
      <path d="M3.8,11.9H5c0.2,0,0.3,0.1,0.3,0.3v8.3c0,0.2-0.1,0.3-0.3,0.3H3.9c-0.2,0-0.3-0.1-0.3-0.3v-6.8l-1.7,0.9
        c-0.2,0.1-0.4,0-0.4-0.2v-1.1c0-0.2,0.1-0.3,0.2-0.4L3.4,12C3.6,12,3.7,11.9,3.8,11.9z" />
      <path d="M8.2,20.5v-0.8c0-0.1,0-0.3,0.2-0.4l2.9-2.9c0.6-0.6,1-1.2,1-1.9s-0.4-1.2-1.1-1.2c-0.6,0-1.1,0.3-1.2,0.9
        c0,0.2-0.1,0.3-0.3,0.3H8.5c-0.2,0-0.3-0.1-0.3-0.3c0.1-1.8,1.5-2.6,2.9-2.6s2.9,0.9,2.9,2.9c0,1-0.6,2-1.4,2.8L10.8,19h3
        c0.2,0,0.3,0.1,0.3,0.3v1.1c0,0.2-0.1,0.3-0.3,0.3H8.5C8.3,20.8,8.2,20.7,8.2,20.5z" />
      <path d="M22.5,18.1c0,1.9-1.5,2.9-3.2,2.9c-1.6,0-3-0.9-3.2-2.6c0-0.2,0.1-0.3,0.3-0.3h1.2c0.2,0,0.3,0.1,0.3,0.3
        c0.1,0.6,0.6,0.9,1.4,0.9c0.9,0,1.4-0.5,1.4-1.2s-0.5-1.2-1.4-1.2h-0.6c-0.2,0-0.3-0.1-0.3-0.3V16c0-0.1,0-0.3,0.1-0.4l1.5-2h-3.2
        c-0.2,0-0.3-0.1-0.3-0.3v-1c0-0.2,0.1-0.3,0.3-0.3h5c0.2,0,0.3,0.1,0.3,0.3v0.9c0,0.1,0,0.3-0.1,0.4l-1.5,2
        C21.6,15.9,22.5,16.8,22.5,18.1z" />
    </svg>
  );
}

export function ColumnTypeIcon({ type }: { type: DetectedColumnType }) {
  switch (type) {
    case "date": return <CalendarDaysIcon />;
    case "integer": return <IntegerIcon />;
    case "float": return <FloatIcon />;
    case "text": return <TextIcon />;
  }
}

// AG-Grid's `innerHeaderComponent` mechanism -- replaces just the header's
// label content (the grid still handles resize/sort-space/borders/etc.
// around it), rather than a full custom `headerComponent` that would need
// to reimplement all of that itself. `detectedType` rides in via each
// ColDef's own `innerHeaderComponentParams`.
export interface TypedColumnHeaderParams extends IHeaderParams {
  detectedType: DetectedColumnType;
}
export function TypedColumnHeader(props: TypedColumnHeaderParams) {
  return (
    <span className="typed-column-header">
      <ColumnTypeIcon type={props.detectedType} />
      <span className="typed-column-header-name">{props.displayName}</span>
    </span>
  );
}
