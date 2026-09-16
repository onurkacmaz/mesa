import test from 'node:test';
import assert from 'node:assert/strict';

import { fitName, paneName, plainLabel, touchBarItems } from '../src/touchBar.mjs';

const terminal = (id, title, extra = {}, tabExtra = {}) => ({
  id,
  kind: 'terminal',
  activeTabId: `${id}-t`,
  tabs: [{ id: `${id}-t`, title, ...tabExtra }],
  ...extra
});

const noLiveTitles = () => undefined;

test('a pane is named by the tab in front of it, not the first one', () => {
  const pane = {
    id: 'p',
    kind: 'terminal',
    activeTabId: 'b',
    tabs: [
      { id: 'a', title: 'first' },
      { id: 'b', title: 'second' }
    ]
  };
  assert.deepEqual(paneName(pane, noLiveTitles), { folder: 'second', branch: null });
});

test('a live title wins over the one in state, as it does in the dock', () => {
  const titleOf = (id) => (id === 'p-t' ? 'Hacker News' : undefined);
  assert.equal(paneName(terminal('p', 'Browser'), titleOf).folder, 'Hacker News');
});

test('an active tab id that no longer exists falls back to the first tab', () => {
  const pane = terminal('p', 'mesa', { activeTabId: 'gone' });
  assert.equal(paneName(pane, noLiveTitles).folder, 'mesa');
});

test('a derived name splits into folder and branch', () => {
  assert.deepEqual(paneName(terminal('p', 'mesa -> main'), noLiveTitles), {
    folder: 'mesa',
    branch: 'main'
  });
});

test('a name the user typed stays one fact, arrow and all', () => {
  const pane = terminal('p', 'React -> Vue migration', {}, { titleLocked: true });
  assert.deepEqual(paneName(pane, noLiveTitles), {
    folder: 'React -> Vue migration',
    branch: null
  });
});

test('only the first arrow separates, so a branch may contain one', () => {
  const { folder, branch } = paneName(terminal('p', 'mesa -> a -> b'), noLiveTitles);
  assert.equal(folder, 'mesa');
  assert.equal(branch, 'a -> b');
});

test('items keep creation order and carry id and kind', () => {
  const panes = [
    terminal('b', 'one'),
    { ...terminal('a', 'two'), kind: 'browser' },
    terminal('c', 'three')
  ];
  const items = touchBarItems(panes, [], noLiveTitles);
  assert.deepEqual(
    items.map((item) => [item.id, item.kind]),
    [
      ['b', 'terminal'],
      ['a', 'browser'],
      ['c', 'terminal']
    ]
  );
});

test('only a single selection counts as focused', () => {
  const panes = [terminal('a', 'mesa'), terminal('b', 'mesa')];
  assert.deepEqual(
    touchBarItems(panes, ['a'], noLiveTitles).map((item) => item.focused),
    [true, false]
  );
  assert.deepEqual(
    touchBarItems(panes, ['a', 'b'], noLiveTitles).map((item) => item.focused),
    [false, false]
  );
});

test('no panes, no items', () => {
  assert.deepEqual(touchBarItems([], [], noLiveTitles), []);
});

test('the plain label reads the way the dock title does', () => {
  assert.equal(plainLabel({ folder: 'mesa', branch: 'main' }), 'mesa -> main');
  assert.equal(plainLabel({ folder: 'Hacker News', branch: null }), 'Hacker News');
});

// One unit per character, plus a fixed 4 for the arrow and its gaps.
const widthOf = ({ folder, branch }) =>
  Array.from(folder).length + (branch ? 4 + Array.from(branch).length : 0);

test('a name that fits is left alone', () => {
  const name = { folder: 'mesa', branch: 'main' };
  assert.equal(fitName(name, 20, widthOf), name);
});

test('the branch gives way before the folder', () => {
  const fitted = fitName({ folder: 'mesa', branch: 'feature/touch-bar' }, 16, widthOf);
  assert.equal(fitted.folder, 'mesa');
  assert.equal(fitted.branch, 'feature…');
  assert.ok(widthOf(fitted) <= 16);
});

test('a branch too short to mean anything is dropped rather than kept as a stub', () => {
  assert.deepEqual(fitName({ folder: 'mesa-website', branch: 'feature' }, 13, widthOf), {
    folder: 'mesa-website',
    branch: null
  });
});

test('the folder is cut at the end only once the branch is gone', () => {
  const fitted = fitName({ folder: 'HR-17123-description-fields', branch: 'main' }, 10, widthOf);
  assert.deepEqual(fitted, { folder: 'HR-17123-…', branch: null });
});

test('an emoji is never split in half', () => {
  const fitted = fitName({ folder: 'ab😀cdef', branch: null }, 4, widthOf);
  assert.equal(fitted.folder, 'ab😀…');
});
