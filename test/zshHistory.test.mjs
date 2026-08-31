import test from 'node:test';
import assert from 'node:assert/strict';

import { parseZshHistory } from '../src/zshHistory.mjs';

const values = (list) => list.map((x) => x.value);

test('a plain history file is one command per line', () => {
  assert.deepEqual(values(parseZshHistory('git status\nnpm test\n')), [
    'git status',
    'npm test'
  ]);
});

// With EXTENDED_HISTORY on, which is common, every line carries a header.
test('the extended-history header is stripped', () => {
  const text = ': 1699999999:0;git status\n: 1700000000:12;npm test\n';
  assert.deepEqual(values(parseZshHistory(text)), ['git status', 'npm test']);
});

// A semicolon inside the command must not be mistaken for the header's.
test('only the header separator is stripped, not later ones', () => {
  const text = ': 1699999999:0;cd /tmp; ls\n';
  assert.deepEqual(values(parseZshHistory(text)), ['cd /tmp; ls']);
});

// Mesa's own Shift+Enter writes these.
test('a trailing backslash continues the command onto the next line', () => {
  const text = ': 1699999999:0;echo one\\\necho two\n: 1700000000:0;ls\n';
  assert.deepEqual(values(parseZshHistory(text)), ['echo one\necho two', 'ls']);
});

test('the later a command appears, the more recent it is', () => {
  const list = parseZshHistory('old\nnew\n');
  assert.ok(list[1].recency > list[0].recency);
});

test('a repeated command is kept once, at its most recent position', () => {
  const list = parseZshHistory('git status\nnpm test\ngit status\n');
  assert.deepEqual(values(list), ['npm test', 'git status']);
});

test('blank lines and whitespace-only entries are not commands', () => {
  assert.deepEqual(values(parseZshHistory('git status\n\n   \nls\n')), [
    'git status',
    'ls'
  ]);
});

test('every entry says it came from history', () => {
  for (const entry of parseZshHistory('ls\n')) assert.equal(entry.source, 'history');
});

test('an empty file is an empty history, not a crash', () => {
  assert.deepEqual(parseZshHistory(''), []);
});
