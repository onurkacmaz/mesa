// Live pane geometry in canvas coordinates, written on every drag and resize
// frame. It exists for the same reason terminalRegistry does — reach a pane's
// current state without prop-drilling or re-rendering anything — but here the
// motivation is sharper, because React genuinely cannot supply this number.
//
// Two independent reasons `pane.x/y` goes stale mid-gesture:
//  1. react-rnd keeps the dragged pane's position in its own inline transform
//     and only reports it at onDragStop.
//  2. Workspace's group drag deliberately leaves the anchor untouched in
//     state — see `if (p.id === anchorId) return p;` in updateGroupDrag.
//
// The minimap reading pane.x/y would therefore freeze the dragged pane on the
// map and snap it on release, while the *other* panes of a multi-selection
// followed along correctly. Reading this map instead makes every pane equally
// live.
//
// Keyed by pane id, which is unique across every open workflow.
const geom = new Map();
const listeners = new Set();

export function setPaneGeom(id, rect) {
  geom.set(id, rect);
  // Any geometry change is what tells the minimap to redraw, without a React
  // render standing between the drag frame and the mark that follows it.
  for (const fn of listeners) fn(id);
}

export function getPaneGeom(id) {
  return geom.get(id);
}

export function deletePaneGeom(id) {
  geom.delete(id);
}

export function onPaneGeomChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
