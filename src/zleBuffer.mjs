// The line the shell is editing, as it arrives over the wire.
//
// Pure, like railReorder.mjs: what comes in is the payload of an OSC 1717
// sequence and what goes out is the exact string zsh had in $BUFFER. Nothing
// in here knows about xterm or React.
//
// The escaping this undoes is deliberately hand-rolled rather than base64,
// because the hook emitting it runs on every keystroke and zsh has no base64
// builtin — encoding would mean a fork per key. zsh's own ${(V)} flag looked
// like the fork-free answer and was measured to be lossy twice over: it
// leaves backslashes alone, so a literal \n and a real newline arrive
// identically, and it writes ESC in caret notation, which a literal ^[ is
// indistinguishable from. `grep "^[a-z]"` is an ordinary command, so that
// second one is not a corner case. Escaping the backslash first and never
// using caret notation settles both.

const ESCAPES = new Map([
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['e', '\x1b'],
  ['a', '\x07'],
  ['\\', '\\']
]);

export function decodeZleBuffer(payload) {
  let out = '';
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = payload[i + 1];
    const decoded = next === undefined ? undefined : ESCAPES.get(next);
    // An escape the hook never emits is not ours to interpret: both
    // characters are kept exactly as they arrived rather than guessed at.
    if (decoded === undefined) {
      out += ch;
      continue;
    }
    out += decoded;
    i += 1;
  }
  return out;
}

// `data` is everything xterm hands an OSC handler after the `1717;`, which is
// `L;<cursor>;<escaped buffer>`. Only the first two separators are split on —
// a semicolon is an ordinary character in a shell command and every one of
// them after that belongs to the buffer.
export function parseZleOsc(data) {
  if (typeof data !== 'string') return null;
  const first = data.indexOf(';');
  if (first === -1 || data.slice(0, first) !== 'L') return null;
  const second = data.indexOf(';', first + 1);
  if (second === -1) return null;
  const cursorText = data.slice(first + 1, second);
  if (!/^\d+$/.test(cursorText)) return null;
  return {
    cursor: Number(cursorText),
    buffer: decodeZleBuffer(data.slice(second + 1))
  };
}
