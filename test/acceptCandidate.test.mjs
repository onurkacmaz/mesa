import test from 'node:test';
import assert from 'node:assert/strict';

import { acceptSequence } from '../src/acceptCandidate.mjs';

// ^E then ^U: end of line, then kill it. Both keymaps end up with an empty
// line, so the whole replacement can simply be typed after them.
const CLEAR = '\x05\x15';

test('the line is cleared and retyped, never appended to', () => {
  assert.equal(
    acceptSequence({ buffer: 'git ch', cursor: 6, start: 4, value: 'checkout' }),
    `${CLEAR}git checkout`
  );
});

test('what is right of the completed word is kept', () => {
  assert.equal(
    acceptSequence({ buffer: 'git ch main', cursor: 6, start: 4, value: 'checkout' }),
    `${CLEAR}git checkout main`
  );
});

test('completing the command itself replaces the whole line', () => {
  assert.equal(
    acceptSequence({ buffer: 'gi', cursor: 2, start: 0, value: 'git status' }),
    `${CLEAR}git status`
  );
});

test('an empty prefix inserts at the cursor', () => {
  assert.equal(
    acceptSequence({ buffer: 'git ', cursor: 4, start: 4, value: 'status' }),
    `${CLEAR}git status`
  );
});

// A raw newline would run the command at the first line break — half a
// command. \x1b\r is the sequence the Shift+Enter widget already binds to
// insert a newline without submitting, so a multi-line entry comes back whole.
test('a multi-line candidate uses the newline that does not submit', () => {
  assert.equal(
    acceptSequence({ buffer: 'ec', cursor: 2, start: 0, value: 'echo one\necho two' }),
    `${CLEAR}echo one\x1b\recho two`
  );
});

test('a carriage return in a candidate is treated the same way', () => {
  assert.equal(
    acceptSequence({ buffer: 'ec', cursor: 2, start: 0, value: 'a\r\nb' }),
    `${CLEAR}a\x1b\rb`
  );
});

test('the replacement is never submitted on its own', () => {
  const sent = acceptSequence({ buffer: 'gi', cursor: 2, start: 0, value: 'git status' });
  assert.ok(!sent.endsWith('\r'));
});

// commandLine.mjs points `start` past the opening quote, so the quote sits in
// the kept prefix and the accepted text must not disturb it.
test('an opening quote is preserved, not overwritten', () => {
  assert.equal(
    acceptSequence({ buffer: 'cd "My Doc', cursor: 10, start: 4, value: 'My Documents' }),
    `${CLEAR}cd "My Documents`
  );
});

// An escaped space makes the raw word longer than the prefix it decodes to
// (`My\\ Doc` is 7 characters, `My Doc` is 6), which is the other reason the
// end of the word is the cursor and not a run of non-space.
test('an escaped space in the typed word is replaced whole', () => {
  assert.equal(
    acceptSequence({ buffer: 'cd My\\ Doc', cursor: 10, start: 3, value: 'My Documents' }),
    `${CLEAR}cd My Documents`
  );
});
