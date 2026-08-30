import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeFlags } from '../src/flags.mjs';

test('a first launch has seen nothing and chosen nothing', () => {
  assert.deepEqual(normalizeFlags(null), { seenOnboarding: false, editor: null });
});

test('the chosen editor is remembered', () => {
  assert.equal(normalizeFlags({ editor: 'Zed' }).editor, 'Zed');
});

test('an editor that is not a name is no editor', () => {
  for (const value of [7, {}, [], true, '']) {
    assert.equal(normalizeFlags({ editor: value }).editor, null, `for ${JSON.stringify(value)}`);
  }
});

test('a stored flag is honoured', () => {
  assert.equal(normalizeFlags({ seenOnboarding: true }).seenOnboarding, true);
});

test('only a real true counts as seen', () => {
  for (const value of ['yes', 1, {}, [], 'false']) {
    assert.equal(normalizeFlags({ seenOnboarding: value }).seenOnboarding, false, `for ${JSON.stringify(value)}`);
  }
});

test('a file that is not an object costs nothing but the flags', () => {
  for (const raw of ['nope', 42, [], true]) {
    assert.deepEqual(
      normalizeFlags(raw),
      { seenOnboarding: false, editor: null },
      `for ${JSON.stringify(raw)}`
    );
  }
});

test('keys this version does not know are dropped', () => {
  const flags = normalizeFlags({ seenOnboarding: true, editor: 'Zed', theme: 'dark', a: { b: 1 } });
  assert.deepEqual(Object.keys(flags).sort(), ['editor', 'seenOnboarding']);
});
