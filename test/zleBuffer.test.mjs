import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeZleBuffer, parseZleOsc } from '../src/zleBuffer.mjs';

test('an ordinary line comes back untouched', () => {
  assert.equal(decodeZleBuffer('git checkout main'), 'git checkout main');
});

test('the escaped control characters come back as themselves', () => {
  assert.equal(decodeZleBuffer('a\\nb'), 'a\nb');
  assert.equal(decodeZleBuffer('a\\rb'), 'a\rb');
  assert.equal(decodeZleBuffer('a\\tb'), 'a\tb');
  assert.equal(decodeZleBuffer('a\\eb'), 'a\x1bb');
  assert.equal(decodeZleBuffer('a\\ab'), 'a\x07b');
});

// The case that ruled out ${(V)}: with backslashes escaped first, a literal
// backslash-n and a real newline are distinguishable. Without that they are
// the same three bytes and no decoder can be correct.
test('a literal backslash is not mistaken for an escape', () => {
  assert.equal(decodeZleBuffer('a\\\\nb'), 'a\\nb');
  assert.equal(decodeZleBuffer('grep "\\\\n"'), 'grep "\\n"');
});

// The other case that ruled out ${(V)}: caret notation would have made this
// indistinguishable from a real ESC. Nothing escapes a caret, so it survives.
test('a literal caret-bracket survives, being an ordinary command', () => {
  assert.equal(decodeZleBuffer('grep "^[a-z]" file'), 'grep "^[a-z]" file');
});

test('an unknown escape keeps both characters', () => {
  assert.equal(decodeZleBuffer('a\\qb'), 'a\\qb');
});

test('a trailing lone backslash is kept', () => {
  assert.equal(decodeZleBuffer('echo \\\\'), 'echo \\');
  assert.equal(decodeZleBuffer('echo \\'), 'echo \\');
});

test('the osc payload splits into a cursor and a buffer', () => {
  assert.deepEqual(parseZleOsc('L;5;git c'), { cursor: 5, buffer: 'git c' });
});

// Semicolons are ordinary in shell commands, so the buffer has to be the last
// field and everything after the second separator belongs to it.
test('semicolons in the command stay in the buffer', () => {
  assert.deepEqual(parseZleOsc('L;12;cd /tmp; ls'), {
    cursor: 12,
    buffer: 'cd /tmp; ls'
  });
});

test('an empty buffer is a buffer, not a missing one', () => {
  assert.deepEqual(parseZleOsc('L;0;'), { cursor: 0, buffer: '' });
});

test('anything that is not a line report is refused', () => {
  assert.equal(parseZleOsc('X;0;hi'), null);
  assert.equal(parseZleOsc('L;notanumber;hi'), null);
  assert.equal(parseZleOsc('L;5'), null);
  assert.equal(parseZleOsc(''), null);
});

test('multi-byte characters survive and the cursor counts them as one each', () => {
  assert.deepEqual(parseZleOsc('L;17;grep "^[a-z]" ığş'), {
    cursor: 17,
    buffer: 'grep "^[a-z]" ığş'
  });
});
