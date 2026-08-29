// The address a browser pane is currently on, reported up from its own
// navigation handlers.
//
// Same shape as paneCwd and paneTitles, for the same reason: a session that is
// saved has to know where every browser was left, and the address changes on
// every navigation — every link followed, every in-page route — inside a guest
// that Workspace cannot see. Lifting it into Workspace state would re-render
// every open terminal in the workflow each time any page moved, to hold a
// value that is only ever read at the moment the session is written.
//
// Empty is a real answer: a pane still on its blank home page is saved with no
// address, and opens the same way.
const urls = new Map();

export function setPaneUrl(id, url) {
  if (!id) return;
  if (url) urls.set(id, url);
  else urls.delete(id);
}

export function getPaneUrl(id) {
  return id ? urls.get(id) : undefined;
}

export function deletePaneUrl(id) {
  urls.delete(id);
}
