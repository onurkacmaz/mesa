// Where each terminal session currently is, reported up from its own OSC 7
// handler. A new terminal opens in the folder the last one you used was
// sitting in, and the pane that has to answer that question is never the pane
// asking it.
//
// Same shape as paneGeometry and paneTitles, for the same reason: the cwd
// changes on every single prompt in every open session, and lifting that into
// Workspace state would re-render every terminal in the workflow each time any
// shell printed a prompt. It is only ever read at the moment a new pane is
// created.
const cwds = new Map();

export function setPaneCwd(id, cwd) {
  if (cwd) cwds.set(id, cwd);
}

export function getPaneCwd(id) {
  return id ? cwds.get(id) : undefined;
}

export function deletePaneCwd(id) {
  cwds.delete(id);
}
