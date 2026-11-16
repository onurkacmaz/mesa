//! Which word the cursor is in, and what came before it.
//!
//! Pure: a string and an offset in, a description of what is being completed
//! out. Offsets are in characters (zsh's `$CURSOR` counts characters, not
//! bytes), and so is everything this returns.
//!
//! This is deliberately not a shell parser. It knows quoting, backslash
//! escapes and the separators that start a fresh command, because each of
//! those changes what a sensible candidate is — and it knows nothing else.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Position {
    Command,
    Argument,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Context {
    pub prefix: String,
    /// Where a replacement is written from, as a character index.
    pub start: usize,
    pub words: Vec<String>,
    pub position: Position,
    pub quote: Option<char>,
}

const SEPARATORS: [&str; 5] = ["&&", "||", "|", ";", "\n"];

fn starts_with_at(text: &[char], at: usize, s: &str) -> bool {
    let mut i = at;
    for c in s.chars() {
        if text.get(i) != Some(&c) {
            return false;
        }
        i += 1;
    }
    true
}

/// Everything to the right of the cursor belongs to the line, not to the word
/// being completed, so the scan simply never sees it.
pub fn completion_context(buffer: &str, cursor: usize) -> Context {
    let all: Vec<char> = buffer.chars().collect();
    let text = &all[..cursor.min(all.len())];

    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut start = 0;
    let mut quote: Option<char> = None;
    let mut started = false;

    let mut i = 0;
    while i < text.len() {
        let ch = text[i];

        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
            i += 1;
            continue;
        }

        if ch == '\\' && i + 1 < text.len() {
            // The backslash is how the escape is written, not part of the word.
            if !started {
                started = true;
                start = i;
            }
            current.push(text[i + 1]);
            i += 2;
            continue;
        }

        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            if !started {
                started = true;
                // Past the quote, not on it: pointing at the quote would have
                // the accepted text overwrite it and unbalance the line.
                start = i + 1;
            }
            i += 1;
            continue;
        }

        if ch == ' ' || ch == '\t' {
            if started {
                words.push(std::mem::take(&mut current));
            }
            current.clear();
            started = false;
            i += 1;
            continue;
        }

        if let Some(sep) = SEPARATORS.iter().find(|s| starts_with_at(text, i, s)) {
            // A separator ends the word AND the command: what follows is a
            // fresh command line, so everything gathered so far stops being
            // context.
            current.clear();
            started = false;
            words.clear();
            i += sep.chars().count();
            continue;
        }

        if !started {
            started = true;
            start = i;
        }
        current.push(ch);
        i += 1;
    }

    // The trailing word is the prefix, not a completed word. An unstarted one
    // means the cursor sits after a space: an empty prefix where the cursor is.
    Context {
        prefix: if started { current } else { String::new() },
        start: if started { start } else { text.len() },
        position: if words.is_empty() { Position::Command } else { Position::Argument },
        words,
        quote,
    }
}
