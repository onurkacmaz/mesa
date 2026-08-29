// Which sessions have a command running in them right now, reported from each
// terminal's own OSC 133 handler: C when a command starts, D when it finishes,
// and cleared when the shell exits.
//
// Same shape as paneCwd, paneTitles and paneUrls, for the same reason — this
// changes on every command in every open session, and lifting it into
// Workspace state would re-render every terminal in the workflow each time any
// shell started or finished anything. It is only ever read at the moment
// something is about to be closed.
//
// This is what decides whether closing asks first. A terminal sitting at a
// prompt has nothing to lose and closes on the spot; one with work in it is
// worth a question.
const running = new Set();

export function setPaneRunning(id, isRunning) {
  if (!id) return;
  if (isRunning) running.add(id);
  else running.delete(id);
}

export function isPaneRunning(id) {
  return id ? running.has(id) : false;
}

export function deletePaneRunning(id) {
  running.delete(id);
}
