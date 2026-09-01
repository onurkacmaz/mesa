// The bytes that put a chosen candidate onto the shell's line.
//
// Pure, like railReorder.mjs: the line, where the completed word starts and
// the chosen text go in; what to send to the pty comes out.
//
// The line is cleared and retyped rather than patched, because the app cannot
// move ZLE's cursor around reliably enough to edit in place — but the two
// keys that clear it were not free to choose. ^K was the obvious pick and is
// wrong: in the viins keymap it is self-insert, so a vi-mode user would get a
// literal control character typed into their line. ^E then ^U empties the
// line in BOTH keymaps — in viins, ^U is vi-kill-line, which kills backwards
// from the cursor, and ^E has already moved the cursor to the end. ^E itself
// only works in viins because the key table in the shell hook binds it there.
const CLEAR_LINE = '\x05\x15';

// A raw newline inside a candidate would submit the command at the first line
// break and run half of it. This is the sequence the Shift+Enter widget in
// the shell hook binds to insert a newline into the line buffer without
// submitting, so a multi-line history entry is reproduced intact.
const SOFT_NEWLINE = '\x1b\r';

// The line as it will read once the candidate is on it.
//
// The caller needs this as well as the keystrokes, because the shell reports
// the new line straight back through the ZLE hook — and without something to
// compare against, that report looks exactly like the user typing and opens a
// fresh list under the word just chosen. Accepting would then appear to do
// nothing at all.
export function acceptedLine({ buffer, cursor, start, value }) {
  return `${buffer.slice(0, start)}${value}${buffer.slice(cursor)}`;
}

export function acceptSequence({ buffer, cursor, start, value }) {
  const before = buffer.slice(0, start);
  // Everything from the cursor onward belongs to the line and is kept. The
  // cursor is where the replaced word ends, exactly — completionContext scans
  // only up to it, so the prefix it reports always runs from `start` to here.
  //
  // Finding that end by matching a run of non-space instead would be wrong
  // twice over, and both cases are ordinary: a quoted word contains spaces
  // (cd "My Doc), and an escaped one is longer in the buffer than in the
  // prefix it decodes to (cd My\ Doc).
  const rest = buffer.slice(cursor);
  const line = `${before}${value}${rest}`;
  return CLEAR_LINE + line.replace(/\r\n|\r|\n/g, SOFT_NEWLINE);
}
