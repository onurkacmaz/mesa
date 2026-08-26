// Reaching the active workflow's own commands from the title bar, which is
// rendered by App and knows nothing about any workspace's internals.
//
// Same shape as terminalRegistry and paneGeometry, and for the same reason:
// every workflow stays mounted for as long as it is open, so lifting these
// into App as state would mean App re-rendering — and with it every open
// terminal — for something that is only ever read at the moment a button is
// pressed. Keyed by workflow id, so switching tabs needs no bookkeeping: the
// title bar simply asks whichever workflow is active.
const actions = new Map();

export function registerWorkspaceActions(id, api) {
  actions.set(id, api);
}

export function unregisterWorkspaceActions(id) {
  actions.delete(id);
}

export function getWorkspaceActions(id) {
  return actions.get(id);
}
