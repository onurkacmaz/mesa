//! The bytes that put a chosen candidate onto the shell's line.
//!
//! The line is cleared and retyped rather than patched, because the app
//! cannot move ZLE's cursor around reliably enough to edit in place — but the
//! two keys that clear it were not free to choose. ^K was the obvious pick and
//! is wrong: in the viins keymap it is self-insert, so a vi-mode user would
//! get a literal control character typed into their line. ^E then ^U empties
//! the line in BOTH keymaps (^E only works in viins because the shell hook
//! binds it there).

const CLEAR_LINE: &str = "\x05\x15";

/// A raw newline inside a candidate would submit the command at the first
/// line break. This is the sequence the Shift+Enter widget in the shell hook
/// binds to insert a newline without submitting.
const SOFT_NEWLINE: &str = "\x1b\r";

/// What is being accepted. Offsets are character indices into `buffer`.
pub struct Accept<'a> {
    pub buffer: &'a str,
    pub cursor: usize,
    pub start: usize,
    pub value: &'a str,
}

fn split(buffer: &str, start: usize, cursor: usize) -> (String, String) {
    let chars: Vec<char> = buffer.chars().collect();
    let start = start.min(chars.len());
    let cursor = cursor.min(chars.len()).max(start);
    (chars[..start].iter().collect(), chars[cursor..].iter().collect())
}

/// The line as it will read once the candidate is on it. The caller needs
/// this as well as the keystrokes, because the shell reports the new line
/// straight back — and without something to compare against, that report
/// looks exactly like the user typing and opens a fresh list.
pub fn accepted_line(a: &Accept) -> String {
    let (before, rest) = split(a.buffer, a.start, a.cursor);
    format!("{before}{}{rest}", a.value)
}

/// Everything from the cursor onward belongs to the line and is kept. The
/// cursor is where the replaced word ends, exactly — the completion context
/// scans only up to it, so the prefix always runs from `start` to here, even
/// for a quoted or escaped word that is longer in the buffer than its prefix.
pub fn accept_sequence(a: &Accept) -> String {
    let line = accepted_line(a);
    let line = line.replace("\r\n", "\n").replace('\r', "\n").replace('\n', SOFT_NEWLINE);
    format!("{CLEAR_LINE}{line}")
}
