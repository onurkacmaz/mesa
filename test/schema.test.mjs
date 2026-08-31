import test from 'node:test';
import assert from 'node:assert/strict';

import { schemaCandidates } from '../src/schema.mjs';
import { SCHEMAS } from '../src/schemas/index.mjs';

const git = {
  name: 'git',
  subcommands: [
    {
      name: 'checkout',
      args: { generator: 'git-branches' },
      options: [
        { name: '-b', description: 'create a new branch' },
        { name: '--force', description: 'throw away local changes' }
      ]
    },
    { name: 'commit', options: [{ name: '-m', description: 'message' }] },
    { name: 'cherry-pick' }
  ],
  options: [{ name: '--version', description: 'print the version' }]
};

const values = (list) => list.map((c) => c.value);

test('the subcommands are offered after the command name', () => {
  assert.deepEqual(values(schemaCandidates(git, ['git'], '')), [
    'checkout',
    'commit',
    'cherry-pick'
  ]);
});

// Filtering here is only about which node of the schema applies. Ranking the
// survivors is rank.mjs's job, so everything plausible is handed on.
test('a prefix narrows the subcommands offered', () => {
  assert.deepEqual(values(schemaCandidates(git, ['git'], 'ch')), [
    'checkout',
    'cherry-pick'
  ]);
});

test('a subcommand brings its own options', () => {
  assert.deepEqual(values(schemaCandidates(git, ['git', 'checkout'], '-')), [
    '-b',
    '--force'
  ]);
});

test('a description travels with the option, for the list to show', () => {
  const [b] = schemaCandidates(git, ['git', 'checkout'], '-b');
  assert.equal(b.value, '-b');
  assert.equal(b.description, 'create a new branch');
  assert.equal(b.source, 'schema');
});

test('the top-level options are offered against the bare command', () => {
  assert.deepEqual(values(schemaCandidates(git, ['git'], '--')), ['--version']);
});

// A flag prefix means flags. Offering `checkout` for `git -` would be noise.
test('a dash asks for options only, never subcommands', () => {
  const list = schemaCandidates(git, ['git', 'commit'], '-');
  assert.deepEqual(values(list), ['-m']);
});

// The generator is a NAME. Resolving it means running something, which
// happens in the main process against a fixed table — never from this file,
// and never as code out of the JSON.
test('a node that takes dynamic values names its generator', () => {
  const list = schemaCandidates(git, ['git', 'checkout'], '');
  const marker = list.find((c) => c.generator);
  assert.equal(marker.generator, 'git-branches');
});

test('a subcommand with nothing to add offers nothing', () => {
  assert.deepEqual(schemaCandidates(git, ['git', 'cherry-pick'], '-'), []);
});

test('a word that is in no schema node ends the walk', () => {
  assert.deepEqual(schemaCandidates(git, ['git', 'nonsense'], ''), []);
});

test('every shipped schema is walkable and names its command', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    assert.equal(schema.name, name);
    assert.doesNotThrow(() => schemaCandidates(schema, [name], ''));
  }
});

test('the shipped git schema knows checkout takes branches', () => {
  const list = schemaCandidates(SCHEMAS.git, ['git', 'checkout'], '');
  assert.ok(list.some((c) => c.generator === 'git-branches'));
});

test('the shipped npm schema knows run takes script names', () => {
  const list = schemaCandidates(SCHEMAS.npm, ['npm', 'run'], '');
  assert.ok(list.some((c) => c.generator === 'npm-scripts'));
});

// Every generator a schema names has to exist in the main process table, or
// the node silently offers nothing. This is the check that keeps a typo in a
// schema from becoming a completion that just never appears.
test('every generator named by a shipped schema is one the app can resolve', () => {
  const KNOWN = new Set([
    'files',
    'directories',
    'git-branches',
    'npm-scripts',
    'ssh-hosts',
    'path',
    'history'
  ]);
  const named = new Set();
  const walk = (node) => {
    if (node.args?.generator) named.add(node.args.generator);
    for (const sub of node.subcommands ?? []) walk(sub);
  };
  for (const schema of Object.values(SCHEMAS)) walk(schema);
  assert.ok(named.size > 0);
  for (const generator of named) assert.ok(KNOWN.has(generator), `unknown generator: ${generator}`);
});
