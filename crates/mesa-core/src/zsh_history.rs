//! The commands you have already run, out of zsh's own history file.
//!
//! The file is read and never written: zsh owns it, another shell may be
//! appending to it at the same moment, and nothing about offering
//! completions justifies a second writer.
//!
//! It is not plain text. zsh METAFIES bytes (0x83 marks the next byte as
//! escaped, the real byte being that one XOR 32); with EXTENDED_HISTORY every
//! entry carries a `: <when>:<elapsed>;` header, whose timestamp is how
//! recent a command is; and a command spanning lines continues with a
//! trailing backslash.

use std::collections::HashMap;

use crate::rank::{Candidate, Source};

pub fn unmetafy(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x83 && i + 1 < bytes.len() {
            i += 1;
            out.push(bytes[i] ^ 32);
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header(line: &str) -> Option<(i64, usize)> {
    let rest = line.strip_prefix(": ")?;
    let colon = rest.find(':')?;
    let when = &rest[..colon];
    if when.is_empty() || !when.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let after = &rest[colon + 1..];
    let semi = after.find(';')?;
    let elapsed = &after[..semi];
    if elapsed.is_empty() || !elapsed.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((when.parse().ok()?, 2 + colon + 1 + semi + 1))
}

pub fn parse_zsh_history(text: &str) -> Vec<Candidate> {
    let mut entries: Vec<(String, Option<i64>)> = Vec::new();
    let push = |entries: &mut Vec<(String, Option<i64>)>, value: String, at: Option<i64>| {
        // Trailing whitespace is not part of a command, and keeping it splits
        // one command into two competing entries.
        let trimmed = value.trim_end().to_string();
        if !trimmed.trim().is_empty() {
            entries.push((trimmed, at));
        }
    };

    let mut current: Option<String> = None;
    let mut current_at: Option<i64> = None;
    for raw in text.split('\n') {
        if let Some(cur) = current.take() {
            if let Some(stripped) = raw.strip_suffix('\\') {
                current = Some(format!("{cur}\n{stripped}"));
                continue;
            }
            push(&mut entries, format!("{cur}\n{raw}"), current_at);
            continue;
        }
        let (at, line) = match header(raw) {
            Some((at, len)) => (Some(at), &raw[len..]),
            None => (None, raw),
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(stripped) = line.strip_suffix('\\') {
            current = Some(stripped.to_string());
            current_at = at;
            continue;
        }
        push(&mut entries, line.to_string(), at);
    }
    if let Some(cur) = current {
        push(&mut entries, cur, current_at);
    }

    // How OFTEN a command was run is the single most useful thing in this
    // file. Walking backwards keeps the most recent occurrence of each command
    // — its position and timestamp — while still counting every one.
    let mut by_value: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<Candidate> = Vec::new();
    for (i, (value, at)) in entries.iter().enumerate().rev() {
        if let Some(&idx) = by_value.get(value) {
            *out[idx].count.as_mut().unwrap() += 1;
            continue;
        }
        let mut c = Candidate::new(value.clone(), Source::History);
        c.recency = Some(i as f64);
        c.count = Some(1);
        c.at = *at;
        by_value.insert(value.clone(), out.len());
        out.push(c);
    }

    // How fresh each command is, as a fraction: 1 is the last thing run, 0
    // the first. The timestamp usually does not exist, and without this
    // ranking collapses to raw frequency.
    let total = (entries.len().max(1) - 1).max(1) as f64;
    out.reverse();
    for entry in &mut out {
        entry.freshness = Some(entry.recency.unwrap_or(0.0) / total);
    }
    out
}
