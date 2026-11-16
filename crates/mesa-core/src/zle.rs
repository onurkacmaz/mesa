//! The line the shell is editing, as it arrives over the wire in an OSC 1717
//! sequence from the zsh hook.
//!
//! The escaping this undoes is hand-rolled rather than base64, because the
//! hook runs on every keystroke and zsh has no base64 builtin. Escaping the
//! backslash first and never using caret notation means a literal `\n` and a
//! real newline, and a literal `^[` and a real ESC, all arrive distinct.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZleLine {
    /// Characters, as zsh's `$CURSOR` counts them.
    pub cursor: usize,
    pub buffer: String,
}

pub fn decode_zle_buffer(payload: &str) -> String {
    let mut out = String::with_capacity(payload.len());
    let mut chars = payload.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        let decoded = match chars.peek() {
            Some('n') => Some('\n'),
            Some('r') => Some('\r'),
            Some('t') => Some('\t'),
            Some('e') => Some('\x1b'),
            Some('a') => Some('\x07'),
            Some('\\') => Some('\\'),
            _ => None,
        };
        // An escape the hook never emits is not ours to interpret: both
        // characters are kept exactly as they arrived.
        match decoded {
            Some(d) => {
                out.push(d);
                chars.next();
            }
            None => out.push(ch),
        }
    }
    out
}

/// `data` is everything after the `1717;`, which is `L;<cursor>;<buffer>`.
/// Only the first two separators are split on — a semicolon is an ordinary
/// character in a shell command.
pub fn parse_zle_osc(data: &str) -> Option<ZleLine> {
    let rest = data.strip_prefix("L;")?;
    let (cursor, buffer) = rest.split_once(';')?;
    if cursor.is_empty() || !cursor.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(ZleLine { cursor: cursor.parse().ok()?, buffer: decode_zle_buffer(buffer) })
}
