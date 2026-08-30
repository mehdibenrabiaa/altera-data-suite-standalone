import { CATEGORY_META, CATEGORY_ORDER, NODE_CATALOG, NODE_DRAG_MIME, toDraggedNodeEntry, type DraggedNodeEntry } from "../nodeCatalog";

interface NodesPanelProps {
  // Click-to-add path: no drop position, so the caller falls back to a
  // cascading default. Drag-to-drop instead goes straight through
  // SchemaView's own onDrop (see NODE_DRAG_MIME), which has a real position.
  onAddNode: (entry: DraggedNodeEntry) => void;
}

export default function NodesPanel({ onAddNode }: NodesPanelProps) {
  return (
    <div className="nodes-panel">
      <div className="nodes-panel-scroll">
        {CATEGORY_ORDER.map((key) => {
          const meta = CATEGORY_META[key];
          const items = NODE_CATALOG.filter((n) => n.category === key);
          if (items.length === 0) return null;
          return (
            <div key={key} className="nodes-panel-category">
              <div className="nodes-panel-category-label">
                <span className="nodes-panel-category-label-box">{meta.label}</span>
                <span className="nodes-panel-category-label-line" />
              </div>
              <div className="nodes-panel-grid">
                {items.map((n) => {
                  const entry = toDraggedNodeEntry(n);
                  return (
                    <div
                      key={n.name}
                      className="nodes-panel-tile"
                      title={n.description}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(NODE_DRAG_MIME, JSON.stringify(entry));
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => onAddNode(entry)}
                    >
                      <div className="nodes-panel-tile-icon-wrap">
                        <div className="node-icon-tile nodes-panel-tile-icon" style={{ background: meta.color }}>
                          {/* A plain <img> is natively draggable in every
                              browser, which otherwise hijacks a drag started
                              right on the icon into the browser's own
                              "drag this image out" gesture instead of the
                              tile's own draggable/onDragStart above -- only
                              starting the drag correctly from elsewhere on
                              the tile body. */}
                          <img src={n.icon} alt="" draggable={false} />
                        </div>
                        <span className="node-port-triangle node-port-triangle-in" />
                        {n.hasOutput !== false && (
                          <span className="node-port-triangle node-port-triangle-out" />
                        )}
                      </div>
                      <span className="node-tile-name nodes-panel-tile-name">{n.name}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
