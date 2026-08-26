// The name a pane is currently wearing, which is not always the name in its
// state: a browser pane shows the page's own title until you rename it, and
// that title is reported up from inside the guest, so it never reaches
// Workspace at all.
//
// Same shape as paneGeometry, for the same reason. The dock has to print the
// exact string the pane's own titlebar prints — two names for one window is a
// bug, not a detail — and the only other way to get it there is to lift the
// browser's live status into Workspace, which would re-render every open
// terminal every time a page finished loading.
const titles = new Map();
const listeners = new Set();

export function setPaneTitle(id, title) {
  if (titles.get(id) === title) return;
  titles.set(id, title);
  for (const fn of listeners) fn(id, title);
}

export function getPaneTitle(id) {
  return titles.get(id);
}

export function deletePaneTitle(id) {
  titles.delete(id);
}

export function onPaneTitleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
