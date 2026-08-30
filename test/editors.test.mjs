import test from 'node:test';
import assert from 'node:assert/strict';

import { editorsFrom, resolveEditor } from '../src/editors.mjs';

const names = (editors) => editors.map((e) => e.app);

test('an installed editor is recognised by its bundle name', () => {
  assert.deepEqual(names(editorsFrom(['Zed.app'])), ['Zed']);
});

test('the JetBrains family is recognised, not just the two flagships', () => {
  const found = ['RubyMine.app', 'PyCharm.app', 'GoLand.app', 'Rider.app'];
  assert.deepEqual(names(editorsFrom(found)).sort(), ['GoLand', 'PyCharm', 'Rider', 'RubyMine']);
});

test('an app you picked yourself is offered even though it is no known editor', () => {
  const editors = editorsFrom(['Zed.app', 'Obscure Editor.app'], 'Obscure Editor');
  assert.deepEqual(names(editors), ['Zed', 'Obscure Editor']);
});

test('an app you picked that has since been deleted is not offered', () => {
  assert.deepEqual(names(editorsFrom(['Zed.app'], 'Obscure Editor')), ['Zed']);
});

test('an app you picked that is already a known editor is not offered twice', () => {
  assert.deepEqual(names(editorsFrom(['Zed.app', 'Cursor.app'], 'Zed')), ['Cursor', 'Zed']);
});

test('everything else in the folder is passed over', () => {
  assert.deepEqual(editorsFrom(['Chess.app', 'Mail.app', 'Some Installer.app']), []);
});

test('the list comes back in one fixed order, whatever the disk said', () => {
  const found = ['Zed.app', 'Visual Studio Code.app', 'Cursor.app'];
  const forwards = names(editorsFrom(found));
  const backwards = names(editorsFrom([...found].reverse()));
  assert.deepEqual(forwards, backwards);
});

test('an editor found in two folders is only offered once', () => {
  assert.deepEqual(names(editorsFrom(['Zed.app', 'Zed.app'])), ['Zed']);
});

test('every offered editor carries a name to show and a bundle to open', () => {
  for (const editor of editorsFrom(['Zed.app', 'Cursor.app', 'Visual Studio Code.app'])) {
    assert.equal(typeof editor.app, 'string');
    assert.equal(typeof editor.label, 'string');
    assert.ok(editor.app.length > 0 && editor.label.length > 0);
  }
});

test('a preference that is still installed is the one used', () => {
  const available = editorsFrom(['Zed.app', 'Cursor.app']);
  assert.equal(resolveEditor('Cursor', available)?.app, 'Cursor');
});

test('a preference for an editor since deleted is not used', () => {
  const available = editorsFrom(['Zed.app']);
  assert.equal(resolveEditor('Cursor', available), null);
});

test('no preference yet means nothing is chosen for you', () => {
  const available = editorsFrom(['Zed.app', 'Cursor.app']);
  assert.equal(resolveEditor(null, available), null);
  assert.equal(resolveEditor('', available), null);
});

test('a single installed editor is still not chosen without being asked', () => {
  // The preference is the answer to a question. One candidate is not an answer.
  assert.equal(resolveEditor(null, editorsFrom(['Zed.app'])), null);
});
