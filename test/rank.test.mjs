import test from 'node:test';
import assert from 'node:assert/strict';

import { rankCandidates, weighByUsage } from '../src/rank.mjs';

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

test('only what starts with the prefix is offered', () => {
  const list = rankCandidates([c('ungit'), c('git status')], 'git');
  assert.deepEqual(values(list), ['git status']);
});

// Typing lowercase and getting the capitalised thing is the common case, so
// case-insensitive matches count — they just rank below exact ones.
test('case is honoured but not required', () => {
  const list = rankCandidates([c('Makefile'), c('makefile'), c('mise.toml')], 'ma');
  assert.deepEqual(values(list).slice(0, 2), ['makefile', 'Makefile']);
});

// Scattered letters are NOT a match. `npm` matching
// `claude-work --resume Session 412e...` -- an n, a p and an m in that order,
// and nothing else in common -- is what a subsequence match actually produces
// on a real history, and it is why there is no longer one. Warp's inline
// history menu makes the same call.
test('scattered letters do not match', () => {
  assert.deepEqual(rankCandidates([c('git checkout')], 'gco'), []);
  assert.deepEqual(
    rankCandidates([c('claude-work --resume Session 412e0e48')], 'npm'),
    []
  );
});

test('a match in the middle of a command is not a match either', () => {
  assert.deepEqual(rankCandidates([c('sudo npm install')], 'npm'), []);
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

test('among otherwise equal history entries the more recent one wins', () => {
  const list = rankCandidates(
    [c('git push', 'history', { recency: 1 }), c('git pull', 'history', { recency: 9 })],
    'git p'
  );
  assert.deepEqual(values(list), ['git pull', 'git push']);
});

// The failure this was written for: on a real history `npm run dev` had been
// run 61 times and the typo `npm ryb dev` once, an hour apart -- and ordering
// on recency alone put the typo first. It is not merely ranked below it now,
// it is gone: two edits from something run 61 times is a typo, not a choice.
test('a command run many times beats a typo run once', () => {
  const now = 1_700_000_000;
  const list = rankCandidates(
    [
      c('npm ryb dev', 'history', { count: 1, at: now - 60, recency: 99 }),
      c('npm run dev', 'history', { count: 61, at: now - 4000, recency: 10 })
    ],
    'npm',
    8,
    now
  );
  assert.deepEqual(values(list), ['npm run dev']);
});

// But frequency must not win outright, or `clear` -- run 86 times -- would sit
// at the top of everything beginning with c forever.
test('something used constantly but not for a month yields to today', () => {
  const now = 1_700_000_000;
  const MONTH = 30 * 24 * 3600;
  const list = rankCandidates(
    [
      c('clear', 'history', { count: 86, at: now - MONTH, recency: 5 }),
      c('cargo build', 'history', { count: 3, at: now - 600, recency: 40 })
    ],
    'c',
    8,
    now
  );
  assert.deepEqual(values(list), ['cargo build', 'clear']);
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

// ── What a schema entry is worth ────────────────────────────────────────────
//
// A schema has no quality signal of its own: every subcommand matches equally,
// so they came out in the order the JSON file listed them and `git ` opened
// with archive, blame, commit, config. The history is what knows which of them
// you actually use.

const schema = (value) => ({ value, description: '', source: 'schema' });
const past = (value, count, freshness) => ({ value, source: 'history', count, freshness });

test('a schema entry inherits the runs of the commands that start with it', () => {
  const [merge] = weighByUsage(
    [schema('merge')],
    [past('git merge main', 4, 0.9), past('git merge dev', 2, 0.5)],
    'git '
  );
  assert.equal(merge.count, 6);
  assert.equal(merge.freshness, 0.9, 'takes the freshest of them');
});

// `npm r` starts every `npm run …` there is, so the alias `r` was credited
// with all 70 runs of `run` and came out above the word it abbreviates.
test('it counts whole words, not prefixes of them', () => {
  const [r] = weighByUsage([schema('r')], [past('npm run dev', 70, 1)], 'npm ');
  assert.equal(r.count, undefined, '`r` did not earn `run`s history');
  const [run] = weighByUsage([schema('run')], [past('npm run dev', 70, 1)], 'npm ');
  assert.equal(run.count, 70);
});

test('an exact past command counts, with nothing after it', () => {
  const [status] = weighByUsage([schema('status')], [past('git status', 9, 1)], 'git ');
  assert.equal(status.count, 9);
});

test('an entry nothing has ever run is left alone', () => {
  const [archive] = weighByUsage([schema('archive')], [past('git merge main', 4, 1)], 'git ');
  assert.deepEqual(archive, schema('archive'));
});

test('history entries pass through untouched', () => {
  const entry = past('git merge main', 4, 1);
  const [out] = weighByUsage([entry], [entry], 'git ');
  assert.equal(out, entry);
});

// The whole point: what you use beats what you have never touched, whichever
// list it came from.
test('a used schema entry outranks an unused one, and both stay in the list', () => {
  const now = 1_700_000_000;
  const list = rankCandidates(
    weighByUsage(
      [schema('archive'), schema('merge')],
      [past('git merge main', 6, 1)],
      'git '
    ),
    { word: '', line: 'git ' },
    8,
    now
  );
  assert.deepEqual(values(list), ['merge', 'archive']);
});

test('a command you actually run outranks a schema entry you never have', () => {
  const now = 1_700_000_000;
  const list = rankCandidates(
    [...weighByUsage([schema('archive')], [], 'git '), past('git merge main', 6, 1)],
    { word: '', line: 'git ' },
    8,
    now
  );
  assert.deepEqual(values(list), ['git merge main', 'archive']);
});

// ── Eight rows should be eight different ideas ──────────────────────────────
//
// The list was spending its slots on variations of one thing. Typing `claude`
// filled five of eight rows with `claude-work --resume <a session id you will
// never retype>`, and `docker c` gave three rows of
// `docker compose --profile …`. Ranking cannot fix that on its own: every one
// of those really is a command you ran, so they all rank alike and crowd out
// everything else.

const run = (value, count, extra = {}) => ({
  value,
  description: '',
  source: 'history',
  count,
  freshness: 0.9,
  ...extra
});

test('a family of variations gets two rows, not the whole list', () => {
  const now = 1_700_000_000;
  const list = rankCandidates(
    [
      run('claude-work --resume aaaa', 1),
      run('claude-work --resume bbbb', 1),
      run('claude-work --resume cccc', 1),
      run('claude-work --resume dddd', 1),
      run('claude-work stop aaaa', 1),
      run('claude-work attach aaaa', 1)
    ],
    'claude',
    8,
    now
  );
  const resumes = values(list).filter((v) => v.startsWith('claude-work --resume'));
  assert.equal(resumes.length, 2, 'only two of the four resumes');
  assert.ok(values(list).includes('claude-work stop aaaa'), 'the freed slot went to a different idea');
  assert.ok(values(list).includes('claude-work attach aaaa'));
});

test('commands that differ early are not one family', () => {
  const now = 1_700_000_000;
  const list = rankCandidates(
    [run('docker compose down', 9), run('docker compose up -d', 8), run('docker ps -a', 7)],
    'docker ',
    8,
    now
  );
  assert.deepEqual(values(list), ['docker compose down', 'docker compose up -d', 'docker ps -a']);
});

// A typo, a stray trailing slash and an abandoned half-typed line all look the
// same: run once, and a character or two away from something you run often.
test('a one-off a couple of edits from a popular command is dropped', () => {
  const now = 1_700_000_000;
  const dropped = (typo, real) => {
    const list = rankCandidates([run(real, 20), run(typo, 1)], real.slice(0, 3), 8, now);
    return !values(list).includes(typo);
  };
  assert.ok(dropped('docker compoe up', 'docker compose up'), 'typo');
  assert.ok(dropped('cd Projects/sh', 'cd Projects sh') || dropped('cd Projects sh', 'cd Projects/sh'), 'slash for space');
  assert.ok(dropped('cd Projects/app/', 'cd Projects/app'), 'stray trailing slash');
  assert.ok(dropped('npm ryb dev', 'npm run dev'), 'two edits');
});

test('a command you actually run often is never mistaken for a typo of another', () => {
  const now = 1_700_000_000;
  const list = rankCandidates([run('git push', 30), run('git pull', 25)], 'git p', 8, now);
  assert.deepEqual(values(list), ['git push', 'git pull']);
});

test('something far from everything else survives', () => {
  const now = 1_700_000_000;
  const list = rankCandidates([run('npm run dev', 40), run('npm publish', 1)], 'npm', 8, now);
  assert.ok(values(list).includes('npm publish'));
});

// The rules free slots; they must never leave the list emptier than it needs
// to be.
test('the list still fills up when there are candidates to fill it with', () => {
  const now = 1_700_000_000;
  const many = Array.from({ length: 20 }, (_, i) => run(`cmd${i} arg`, 5));
  assert.equal(rankCandidates(many, 'cmd', 8, now).length, 8);
});

test('a schema entry is never dropped as a typo of a command', () => {
  const now = 1_700_000_000;
  const list = rankCandidates(
    [run('git stash save', 20), { value: 'stash', description: '', source: 'schema' }],
    { word: 'st', line: 'git st' },
    8,
    now
  );
  assert.ok(values(list).includes('stash'));
});
