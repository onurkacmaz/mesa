import test from 'node:test';
import assert from 'node:assert/strict';

import { rankCandidates } from '../src/rank.mjs';

const c = (value, source = 'history', extra = {}) => ({
  value,
  description: '',
  source,
  ...extra
});

const values = (list) => list.map((x) => x.value);

test('what does not match at all is dropped', () => {
  const list = rankCandidates([c('git status'), c('npm test')], 'git');
  assert.deepEqual(values(list), ['git status']);
});

test('an exact prefix beats a match in the middle', () => {
  const list = rankCandidates([c('ungit'), c('git status')], 'git');
  assert.deepEqual(values(list), ['git status', 'ungit']);
});

// Typing lowercase and getting the capitalised thing is the common case, so
// case-insensitive matches count — they just rank below exact ones.
test('case is honoured but not required', () => {
  const list = rankCandidates([c('Makefile'), c('makefile'), c('mise.toml')], 'ma');
  assert.deepEqual(values(list).slice(0, 2), ['makefile', 'Makefile']);
});

// The whole point of a fuzzy match: `gco` should find `git checkout`.
test('scattered letters match, below the solid prefixes', () => {
  const list = rankCandidates([c('git checkout'), c('grep -c out')], 'gco');
  assert.deepEqual(values(list), ['git checkout', 'grep -c out']);
});

test('letters in the wrong order do not match', () => {
  assert.deepEqual(rankCandidates([c('git checkout')], 'ogc'), []);
});

test('an empty prefix keeps everything, in source order', () => {
  const list = rankCandidates([c('b', 'history'), c('a', 'schema')], '');
  assert.deepEqual(values(list), ['a', 'b']);
});

// A schema entry is something the CLI genuinely accepts here, which is a
// stronger claim than a file that happens to share a prefix.
test('the source breaks a tie: schema, history, file, path', () => {
  const list = rankCandidates(
    // Distinct values that all score the same on the prefix, so the source is
    // the only thing left to order them by.
    [
      c('check-in', 'path'),
      c('checklist', 'file'),
      c('checkers', 'history'),
      c('checkout', 'schema')
    ],
    'check'
  );
  assert.deepEqual(
    list.map((x) => x.source),
    ['schema', 'history', 'file', 'path']
  );
});

test('the same command from two sources is listed once, at its best rank', () => {
  const list = rankCandidates([c('git status', 'history'), c('git status', 'schema')], 'git');
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'schema');
});

// Recency is what makes history feel like it is reading your mind: the same
// two commands, and the one you ran last is on top.
test('among history entries the more recent one wins', () => {
  const list = rankCandidates(
    [c('git push', 'history', { recency: 1 }), c('git pull', 'history', { recency: 9 })],
    'git p'
  );
  assert.deepEqual(values(list), ['git pull', 'git push']);
});

test('the list is capped', () => {
  const many = Array.from({ length: 40 }, (_, i) => c(`git c${i}`));
  assert.equal(rankCandidates(many, 'git').length, 8);
  assert.equal(rankCandidates(many, 'git', 3).length, 3);
});

test('a candidate identical to what is typed is not offered', () => {
  const list = rankCandidates([c('git status'), c('git stash')], 'git status');
  assert.deepEqual(values(list), []);
});

// The generator marker from schema.mjs carries no value and must never be
// shown as a row.
test('an empty candidate is never offered', () => {
  assert.deepEqual(rankCandidates([c(''), c('git')], 'g'), [
    { value: 'git', description: '', source: 'history' }
  ]);
});
