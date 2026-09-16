// What the Touch Bar shows for the active workflow: the same windows the dock
// lists, in the same order, under the same names.
//
// Pure, like railReorder.mjs: panes and a way to read a live title go in, a
// row of plain descriptions comes out. How those are drawn is touchBarArt.js;
// the main process only puts the result on the bar and never learns what a
// pane is. The rules for naming live here, where they can be tested.
//
// Order is creation order, never z-order, for the dock's reason: a strip that
// reshuffles every time you touch it cannot be learned by position.

const SEPARATOR = ' -> ';

// The tab in front names the pane, exactly as the dock names it. `titleOf` is
// paneTitles' getter, passed in so this file stays free of the renderer's
// registries.
//
// A derived name is two facts, "folder -> branch"; a name the user typed is one,
// even if it happens to contain an arrow ("React -> Vue migration"). Only the
// tab knows which it is, so the split happens here, where `titleLocked` can be
// read, and never later on a bare string.
export function paneName(pane, titleOf) {
  const tab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
  if (!tab) return { folder: pane.kind === 'browser' ? 'Browser' : 'Terminal', branch: null };
  const name = titleOf(tab.id) ?? tab.title;
  if (tab.titleLocked) return { folder: name, branch: null };
  const at = name.indexOf(SEPARATOR);
  if (at === -1) return { folder: name, branch: null };
  return { folder: name.slice(0, at), branch: name.slice(at + SEPARATOR.length) || null };
}

export function touchBarItems(panes, selectedIds, titleOf) {
  // The single-selection case is the pane that actually holds the keyboard;
  // a group selection has no one pane to stand in front of.
  const focusedId = selectedIds.length === 1 ? selectedIds[0] : null;
  return panes.map((pane) => ({
    id: pane.id,
    kind: pane.kind === 'browser' ? 'browser' : 'terminal',
    focused: pane.id === focusedId,
    ...paneName(pane, titleOf)
  }));
}

// The same name as one string, for anything that cannot draw three tones.
export function plainLabel({ folder, branch }) {
  return branch ? `${folder}${SEPARATOR}${branch}` : folder;
}

const ELLIPSIS = '…';
// A branch cut shorter than this stops identifying anything and only adds
// noise next to the folder, so below it the branch is dropped outright.
const MIN_BRANCH_CHARS = 3;

// Code points, not UTF-16 units, so an emoji in a page title is never split
// into half a surrogate pair.
const cut = (text, n) => Array.from(text).slice(0, n).join('') + ELLIPSIS;
const length = (text) => Array.from(text).length;

// Makes a name fit `maxWidth`, as measured by `widthOf({ folder, branch })`.
//
// The folder is the part that says which window this is, so it is the last
// thing to give way — the dock's rule, for the dock's reason. The branch is
// shortened first, then dropped, and only then is the folder cut. Always at
// the end, never the middle: a name reads left to right, and the start of it
// is what a glance catches.
export function fitName(name, maxWidth, widthOf) {
  if (widthOf(name) <= maxWidth) return name;

  const { folder, branch } = name;
  if (branch) {
    for (let n = length(branch) - 1; n >= MIN_BRANCH_CHARS; n -= 1) {
      const candidate = { folder, branch: cut(branch, n) };
      if (widthOf(candidate) <= maxWidth) return candidate;
    }
    if (widthOf({ folder, branch: null }) <= maxWidth) return { folder, branch: null };
  }

  for (let n = length(folder) - 1; n >= 1; n -= 1) {
    const candidate = { folder: cut(folder, n), branch: null };
    if (widthOf(candidate) <= maxWidth) return candidate;
  }
  return { folder: cut(folder, 1), branch: null };
}
