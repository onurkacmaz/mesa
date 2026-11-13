//! The pty's byte stream, split where the app has to step in.
//!
//! Most of what a shell prints goes straight to the terminal emulator. A few
//! sequences are for the app rather than for the screen, and they have to be
//! acted on at the exact point in the stream where they arrive — a prompt
//! marker means "the row the cursor is on NOW" — so the stream is cut there
//! and handed over in order: bytes, then the sequence, then more bytes.
//!
//!  - OSC 7    the working directory (`file://host/path`)
//!  - OSC 133  semantic prompt markers from the zsh hook (A, C, D;<exit>)
//!  - OSC 1717 the line ZLE is editing, for the completion list
//!
//! And one sequence is dropped outright: `CSI 3 J`, "erase saved lines".
//! `clear` on macOS emits ESC[3J ESC[H ESC[2J, and that first sequence throws
//! the whole scrollback away — so clearing the screen also destroyed
//! everything you had scrolled past. The screen still clears (ESC[2J is
//! untouched) but the history above it survives, which is what a workspace
//! terminal should do.
//!
//! Pure and stateful only across chunk boundaries: a read from a pty can end
//! anywhere, including in the middle of a sequence.

/// Longest OSC payload held on to. Past this the sequence is not one of ours
/// (ours are a path or a command line) and is passed through untouched.
const MAX_OSC: usize = 64 * 1024;
const MAX_CSI: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Piece {
    /// Bytes for the terminal emulator, in order.
    Bytes(Vec<u8>),
    /// One of the app's sequences: its code and everything after `code;`.
    Osc(u32, String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Ground,
    Escape,
    Osc,
    OscEscape,
    Csi,
}

pub struct Scanner {
    state: State,
    /// The raw bytes of the sequence being read, from its ESC on, so it can be
    /// passed through untouched when it turns out not to be ours.
    pending: Vec<u8>,
}

impl Default for Scanner {
    fn default() -> Self {
        Scanner { state: State::Ground, pending: Vec::new() }
    }
}

pub const OSC_CWD: u32 = 7;
pub const OSC_PROMPT: u32 = 133;
pub const OSC_LINE: u32 = 1717;

fn ours(code: u32) -> bool {
    matches!(code, OSC_CWD | OSC_PROMPT | OSC_LINE)
}

impl Scanner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, input: &[u8]) -> Vec<Piece> {
        let mut out: Vec<Piece> = Vec::new();
        let mut bytes: Vec<u8> = Vec::with_capacity(input.len());

        for &b in input {
            match self.state {
                State::Ground => {
                    if b == 0x1b {
                        self.state = State::Escape;
                        self.pending.clear();
                        self.pending.push(b);
                    } else {
                        bytes.push(b);
                    }
                }
                State::Escape => {
                    self.pending.push(b);
                    match b {
                        b']' => self.state = State::Osc,
                        b'[' => self.state = State::Csi,
                        0x1b => {
                            // ESC ESC: the first is an ordinary escape.
                            bytes.push(0x1b);
                            self.pending.clear();
                            self.pending.push(0x1b);
                        }
                        _ => {
                            bytes.extend_from_slice(&self.pending);
                            self.pending.clear();
                            self.state = State::Ground;
                        }
                    }
                }
                State::Osc => match b {
                    0x07 => {
                        self.pending.push(b);
                        self.finish_osc(&mut bytes, &mut out, 1);
                    }
                    0x1b => {
                        self.pending.push(b);
                        self.state = State::OscEscape;
                    }
                    _ => {
                        self.pending.push(b);
                        if self.pending.len() > MAX_OSC {
                            bytes.extend_from_slice(&self.pending);
                            self.pending.clear();
                            self.state = State::Ground;
                        }
                    }
                },
                State::OscEscape => {
                    if b == b'\\' {
                        self.pending.push(b);
                        self.finish_osc(&mut bytes, &mut out, 2);
                    } else {
                        // An ESC that is not a string terminator ends the OSC
                        // malformed. Hand it all on and read this ESC afresh.
                        let esc = self.pending.pop();
                        bytes.extend_from_slice(&self.pending);
                        self.pending.clear();
                        debug_assert_eq!(esc, Some(0x1b));
                        self.state = State::Escape;
                        self.pending.push(0x1b);
                        // Re-run this byte in the escape state.
                        self.pending.push(b);
                        match b {
                            b']' => self.state = State::Osc,
                            b'[' => self.state = State::Csi,
                            _ => {
                                bytes.extend_from_slice(&self.pending);
                                self.pending.clear();
                                self.state = State::Ground;
                            }
                        }
                    }
                }
                State::Csi => {
                    self.pending.push(b);
                    if (0x40..=0x7e).contains(&b) {
                        // ESC [ 3 J, exactly: erase saved lines. Dropped.
                        if self.pending.as_slice() != b"\x1b[3J" {
                            bytes.extend_from_slice(&self.pending);
                        }
                        self.pending.clear();
                        self.state = State::Ground;
                    } else if self.pending.len() > MAX_CSI {
                        bytes.extend_from_slice(&self.pending);
                        self.pending.clear();
                        self.state = State::Ground;
                    }
                }
            }
        }

        if !bytes.is_empty() {
            out.push(Piece::Bytes(bytes));
        }
        out
    }

    fn finish_osc(&mut self, bytes: &mut Vec<u8>, out: &mut Vec<Piece>, terminator: usize) {
        self.state = State::Ground;
        let raw = std::mem::take(&mut self.pending);
        // ESC ] ... terminator
        let body = &raw[2..raw.len() - terminator];
        let (code, data) = match body.iter().position(|&c| c == b';') {
            Some(i) => (&body[..i], &body[i + 1..]),
            None => (body, &body[body.len()..]),
        };
        let code = std::str::from_utf8(code).ok().and_then(|c| c.parse::<u32>().ok());
        match code {
            Some(code) if ours(code) => {
                if !bytes.is_empty() {
                    out.push(Piece::Bytes(std::mem::take(bytes)));
                }
                out.push(Piece::Osc(code, String::from_utf8_lossy(data).into_owned()));
            }
            _ => bytes.extend_from_slice(&raw),
        }
    }
}

/// `file://host/Users/me/My%20Project` → `/Users/me/My Project`.
pub fn parse_cwd(data: &str) -> Option<String> {
    let rest = data.strip_prefix("file://")?;
    let path = &rest[rest.find('/')?..];
    Some(percent_decode(path))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 1 && s.is_char_boundary(i + 3) {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptMark {
    /// A prompt is about to be drawn.
    PromptStart,
    /// A command was submitted.
    CommandStart,
    /// The command finished with this exit code.
    CommandEnd(i32),
    /// Anything else (B, or a marker this app draws nothing for).
    Other,
}

pub fn parse_prompt_mark(data: &str) -> PromptMark {
    match data.chars().next() {
        Some('A') => PromptMark::PromptStart,
        Some('C') => PromptMark::CommandStart,
        Some('D') => {
            PromptMark::CommandEnd(data.split(';').nth(1).and_then(|c| c.trim().parse().ok()).unwrap_or(0))
        }
        _ => PromptMark::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(chunks: &[&[u8]]) -> Vec<Piece> {
        let mut s = Scanner::new();
        let mut out = Vec::new();
        for c in chunks {
            out.extend(s.feed(c));
        }
        // Adjacent byte runs are one run, however the chunks fell.
        let mut merged: Vec<Piece> = Vec::new();
        for p in out {
            if let (Some(Piece::Bytes(prev)), Piece::Bytes(b)) = (merged.last_mut(), &p) {
                prev.extend_from_slice(b);
                continue;
            }
            merged.push(p);
        }
        merged
    }

    #[test]
    fn plain_output_passes_through() {
        assert_eq!(all(&[b"hello\r\n"]), vec![Piece::Bytes(b"hello\r\n".to_vec())]);
    }

    #[test]
    fn our_sequences_are_cut_out_in_order() {
        let got = all(&[b"a\x1b]133;A\x07b\x1b]7;file://h/tmp\x1b\\c"]);
        assert_eq!(
            got,
            vec![
                Piece::Bytes(b"a".to_vec()),
                Piece::Osc(133, "A".into()),
                Piece::Bytes(b"b".to_vec()),
                Piece::Osc(7, "file://h/tmp".into()),
                Piece::Bytes(b"c".to_vec()),
            ]
        );
    }

    #[test]
    fn a_sequence_split_across_reads_survives() {
        let got = all(&[b"x\x1b]17", b"17;L;3;git", b" st\x07y"]);
        assert_eq!(
            got,
            vec![Piece::Bytes(b"x".to_vec()), Piece::Osc(1717, "L;3;git st".into()), Piece::Bytes(b"y".to_vec())]
        );
    }

    #[test]
    fn other_sequences_are_left_for_the_emulator() {
        let raw: &[u8] = b"\x1b]0;title\x07\x1b[31mred\x1b[0m\x1b]11;?\x1b\\";
        assert_eq!(all(&[raw]), vec![Piece::Bytes(raw.to_vec())]);
    }

    #[test]
    fn erase_saved_lines_is_dropped_and_nothing_else() {
        let got = all(&[b"\x1b[3J\x1b[H\x1b[2J"]);
        assert_eq!(got, vec![Piece::Bytes(b"\x1b[H\x1b[2J".to_vec())]);
        let got = all(&[b"\x1b[", b"3", b"J"]);
        assert!(got.is_empty());
        assert_eq!(all(&[b"\x1b[13J"]), vec![Piece::Bytes(b"\x1b[13J".to_vec())]);
    }

    #[test]
    fn utf8_in_a_payload_is_kept() {
        assert_eq!(all(&["\x1b]1717;L;5;cd ığş\x07".as_bytes()]), vec![Piece::Osc(1717, "L;5;cd ığş".into())]);
    }

    #[test]
    fn cwd_and_marks() {
        assert_eq!(parse_cwd("file://host/Users/me/My%20Project").as_deref(), Some("/Users/me/My Project"));
        assert_eq!(parse_cwd("file:///tmp").as_deref(), Some("/tmp"));
        assert_eq!(parse_cwd("http://x/y"), None);
        assert_eq!(parse_prompt_mark("D;127"), PromptMark::CommandEnd(127));
        assert_eq!(parse_prompt_mark("D"), PromptMark::CommandEnd(0));
        assert_eq!(parse_prompt_mark("A"), PromptMark::PromptStart);
        assert_eq!(parse_prompt_mark("C"), PromptMark::CommandStart);
        assert_eq!(parse_prompt_mark("B"), PromptMark::Other);
    }
}
