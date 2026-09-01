import test from 'node:test';
import assert from 'node:assert/strict';

import { trimSignature } from '../src/commandSignature.mjs';

test('the shape that matters comes through', () => {
  const out = trimSignature({
    name: 'demo',
    description: 'A demo',
    subcommands: [{ name: 'run', description: 'Run it' }],
    options: [{ name: '--force', description: 'Force it' }]
  });
  assert.deepEqual(out, {
    name: 'demo',
    description: 'A demo',
    options: [{ name: '--force', description: 'Force it' }],
    subcommands: [{ name: 'run', description: 'Run it' }]
  });
});

// The whole safety argument. The upstream format carries JavaScript meant to be
// evaluated by the host — some of it pre-compiled into a string — and none of
// it may survive.
test('every executable field is dropped', () => {
  const out = trimSignature({
    name: 'demo',
    generateSpec: '_NuFrRa_(o,t)=>p(void 0,null,function*(){})',
    loadSpec: 'other-spec',
    subcommands: [
      {
        name: 'run',
        args: {
          generators: [{ script: 'ls -1', postProcess: '(out)=>out.split("\\n")' }],
          script: 'echo hi',
          postProcess: '(o)=>o'
        }
      }
    ]
  });
  const text = JSON.stringify(out);
  for (const field of ['generateSpec', 'loadSpec', 'generators', 'script', 'postProcess']) {
    assert.ok(!text.includes(field), `${field} survived`);
  }
});

test('a template becomes a generator this app actually has', () => {
  const out = trimSignature({ name: 'demo', args: { template: 'folders' } });
  assert.deepEqual(out.args, { generator: 'directories' });
  assert.deepEqual(
    trimSignature({ name: 'demo', args: { template: 'filepaths' } }).args,
    { generator: 'files' }
  );
});

test('a template with no equivalent here resolves to no generator at all', () => {
  const out = trimSignature({ name: 'demo', args: { template: 'help' } });
  assert.equal(out.args, undefined);
  assert.equal(
    trimSignature({ name: 'demo', args: { generatorName: 'gcs_buckets' } }).args,
    undefined
  );
});

// The named generator has to win. `git checkout` declares
// generatorName: ["local_branches", …] AND template: ["filepaths", "folders"],
// and checking the template first had it completing filenames.
test('a named generator beats the generic template beside it', () => {
  const out = trimSignature({
    name: 'checkout',
    args: [{ generatorName: ['local_branches', 'tags'], template: ['filepaths', 'folders'] }]
  });
  assert.deepEqual(out.args, { generator: 'git-branches' });
});

// ["-q", "--quiet"] is one option written two ways, and both are real things
// to type, so the list is kept rather than collapsed.
test('an option keeps every alias it can be written as', () => {
  const out = trimSignature({
    name: 'demo',
    options: [{ name: ['-q', '--quiet'], description: 'Quiet' }]
  });
  assert.deepEqual(out.options[0].name, ['-q', '--quiet']);
});

test('the command itself is named once, never as a list', () => {
  assert.equal(trimSignature({ name: ['ns', 'nativescript'] }).name, 'ns');
});

// The list gives a description one ellipsised line, so a manual page in there
// is bytes nobody will ever see -- and there are 500 specs of them.
test('a long description is cut to something a row can show', () => {
  const long = 'x'.repeat(400);
  const out = trimSignature({ name: 'demo', description: long });
  assert.ok(out.description.length <= 80, `kept ${out.description.length} characters`);
  assert.ok(out.description.endsWith('…'));
});

test('a description folded over several lines becomes one', () => {
  const out = trimSignature({ name: 'demo', description: 'one\n  two\tthree' });
  assert.equal(out.description, 'one two three');
});

test('an empty description is left out rather than carried as empty', () => {
  const out = trimSignature({ name: 'demo', description: '   ' });
  assert.ok(!('description' in out));
});

test('a node with no name is not a node', () => {
  assert.equal(trimSignature({ description: 'nameless' }), null);
  const out = trimSignature({ name: 'demo', subcommands: [{ description: 'nameless' }] });
  assert.ok(!('subcommands' in out));
});

// A few specs nest absurdly, and every level multiplies what is kept.
test('nesting is capped', () => {
  const deep = { name: 'a', subcommands: [{ name: 'b', subcommands: [{ name: 'c', subcommands: [{ name: 'd' }] }] }] };
  const out = trimSignature(deep, 2);
  assert.equal(out.subcommands[0].subcommands[0].name, 'c');
  assert.ok(!('subcommands' in out.subcommands[0].subcommands[0]));
});

// 4212 nodes upstream carry one of these. They are values the command simply
// accepts -- `for ... in`, a flag's allowed words -- and no generator can
// produce them, because they are not looked up anywhere.
test('a static suggestion list is kept', () => {
  const out = trimSignature({
    name: 'demo',
    args: { suggestions: ['in', { name: 'of', description: 'the other one' }] }
  });
  assert.deepEqual(out.args.suggestions, [{ name: 'in' }, { name: 'of', description: 'the other one' }]);
});

test('a suggestion with no name is not a suggestion', () => {
  const out = trimSignature({ name: 'demo', args: { suggestions: [{ description: 'nameless' }, 'ok'] } });
  assert.deepEqual(out.args.suggestions, [{ name: 'ok' }]);
});

// A few specs list hundreds of locale or timezone names, and the list shows
// eight.
test('an enormous suggestion list is capped', () => {
  const many = Array.from({ length: 500 }, (_, i) => `v${i}`);
  const out = trimSignature({ name: 'demo', args: { suggestions: many } });
  assert.ok(out.args.suggestions.length <= 60, `kept ${out.args.suggestions.length}`);
});

test('a node carrying both a generator and a list keeps both', () => {
  const out = trimSignature({
    name: 'demo',
    args: { template: 'folders', suggestions: ['here'] }
  });
  assert.equal(out.args.generator, 'directories');
  assert.deepEqual(out.args.suggestions, [{ name: 'here' }]);
});
