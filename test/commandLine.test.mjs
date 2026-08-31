import test from 'node:test';
import assert from 'node:assert/strict';

import { completionContext } from '../src/commandLine.mjs';

// The cursor is almost always at the end while typing, so that is the default
// the tests read against; the cases where it is not get their own test.
const at = (buffer, cursor = buffer.length) => completionContext(buffer, cursor);

test('the first word is the command being completed', () => {
  assert.deepEqual(at('gi'), {
    prefix: 'gi',
    start: 0,
    words: [],
    position: 'command',
    quote: null
  });
});

test('an empty line offers everything from the command position', () => {
  assert.deepEqual(at(''), {
    prefix: '',
    start: 0,
    words: [],
    position: 'command',
    quote: null
  });
});

test('a word after the command is an argument, and the command is context', () => {
  assert.deepEqual(at('git ch'), {
    prefix: 'ch',
    start: 4,
    words: ['git'],
    position: 'argument',
    quote: null
  });
});

test('a space at the end starts a new empty argument', () => {
  assert.deepEqual(at('git checkout '), {
    prefix: '',
    start: 13,
    words: ['git', 'checkout'],
    position: 'argument',
    quote: null
  });
});

test('a flag is an ordinary argument, dashes and all', () => {
  assert.deepEqual(at('git checkout -'), {
    prefix: '-',
    start: 13,
    words: ['git', 'checkout'],
    position: 'argument',
    quote: null
  });
});

// Only the text up to the cursor is being completed. What is to the right of
// it belongs to the line, not to the word we are offering candidates for.
test('the word is cut at the cursor, not at its end', () => {
  assert.deepEqual(completionContext('git checkout main', 7), {
    prefix: 'che',
    start: 4,
    words: ['git'],
    position: 'argument',
    quote: null
  });
});

test('runs of spaces do not become empty words', () => {
  assert.deepEqual(at('git   ch'), {
    prefix: 'ch',
    start: 6,
    words: ['git'],
    position: 'argument',
    quote: null
  });
});

test('a quoted argument is one word, spaces included', () => {
  assert.deepEqual(at('git commit -m "work in pro'), {
    prefix: 'work in pro',
    start: 15,
    words: ['git', 'commit', '-m'],
    position: 'argument',
    quote: '"'
  });
});

test('single quotes work the same way', () => {
  assert.deepEqual(at("cd 'My Doc"), {
    prefix: 'My Doc',
    start: 4,
    words: ['cd'],
    position: 'argument',
    quote: "'"
  });
});

test('a closed quote is a finished word', () => {
  assert.deepEqual(at('cd "My Documents" '), {
    prefix: '',
    start: 18,
    words: ['cd', 'My Documents'],
    position: 'argument',
    quote: null
  });
});

// An escaped space is the other way to write a path with a space in it, and
// the backslash is not part of what the user means by the word.
test('an escaped space keeps the word together', () => {
  assert.deepEqual(at('cd My\\ Doc'), {
    prefix: 'My Doc',
    start: 3,
    words: ['cd'],
    position: 'argument',
    quote: null
  });
});

// Each of these starts a new command, so what follows is in command position
// again — offering `git` subcommands after a pipe would be nonsense.
test('a pipe or a separator starts a new command', () => {
  assert.deepEqual(at('ls | gr'), {
    prefix: 'gr',
    start: 5,
    words: [],
    position: 'command',
    quote: null
  });
  assert.deepEqual(at('cd /tmp && l'), {
    prefix: 'l',
    start: 11,
    words: [],
    position: 'command',
    quote: null
  });
  assert.deepEqual(at('cd /tmp; l'), {
    prefix: 'l',
    start: 9,
    words: [],
    position: 'command',
    quote: null
  });
});

// A separator inside quotes is text, not a separator.
test('a separator inside quotes does not start a command', () => {
  assert.deepEqual(at('echo "a | b'), {
    prefix: 'a | b',
    start: 6,
    words: ['echo'],
    position: 'argument',
    quote: '"'
  });
});

// Mesa's own Shift+Enter puts real newlines in the buffer.
test('a newline starts a new command like a separator does', () => {
  assert.deepEqual(at('cd /tmp\nl'), {
    prefix: 'l',
    start: 8,
    words: [],
    position: 'command',
    quote: null
  });
});

test('a cursor past the end of the line does not run off it', () => {
  assert.deepEqual(completionContext('git', 99), {
    prefix: 'git',
    start: 0,
    words: [],
    position: 'command',
    quote: null
  });
});
