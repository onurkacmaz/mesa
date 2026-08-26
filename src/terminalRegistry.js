// Lets the canvas-level wheel handler reach a pane's Terminal instance
// without prop-drilling or re-rendering anything. Keyed by pane id, which the
// pane also stamps onto its .pane-body as data-pane-id.
const registry = new Map();

export function registerTerminal(id, term) {
  registry.set(id, { term, remainder: 0 });
}

export function unregisterTerminal(id) {
  registry.delete(id);
}

export function getTerminalEntry(id) {
  return registry.get(id);
}
