//! Which candidates are offered, and in what order.
//!
//! Pure: candidates and a prefix in, an ordered list out. Nothing here knows
//! where a candidate came from beyond the name of its source.
//!
//! PREFIX ONLY. There was a subsequence match once — every letter of the query
//! appearing in order, so `gco` would find `git checkout` — and it had to go.
//! It is the reason `npm` offered `claude-work --resume Session 412e...`,
//! which contains an n, a p and an m in that order and nothing else in common
//! with what was typed. Warp's own inline history menu makes the same call.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Schema,
    History,
    File,
    Path,
}

impl Source {
    /// Source order, most authoritative first.
    fn rank(self) -> u8 {
        match self {
            Source::Schema => 0,
            Source::History => 1,
            Source::File => 2,
            Source::Path => 3,
        }
    }
}

/// One thing the list could offer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Candidate {
    pub value: String,
    #[serde(default)]
    pub description: String,
    pub source: Source,
    /// How many times it was run. `Some(0)` is "deliberately no use behind
    /// this" (a noise directory); `None` is "nothing is known".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    /// Unix seconds of the last run or the last modification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    /// 1 is the last thing run, 0 the first; see `zsh_history`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freshness: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recency: Option<f64>,
    /// A schema node asking for live values names a generator here and
    /// carries no value of its own; it is resolved and then dropped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generator: Option<String>,
}

impl Candidate {
    pub fn new(value: impl Into<String>, source: Source) -> Self {
        Candidate {
            value: value.into(),
            description: String::new(),
            source,
            count: None,
            at: None,
            freshness: None,
            recency: None,
            generator: None,
        }
    }

    pub fn described(mut self, description: impl Into<String>) -> Self {
        self.description = description.into();
        self
    }
}

/// Higher is better; `None` means no match at all.
///
/// Public because the completion sources have to make the SAME judgement
/// before handing candidates over — PATH alone is a few thousand names.
pub fn match_score(value: &str, prefix: &str) -> Option<u8> {
    // An empty prefix matches everything, and matches it EQUALLY WELL — the
    // same score a solid prefix earns. The two kinds of candidate are scored
    // against different strings (a schema entry against the word under the
    // cursor, a history entry against the whole line), so a low score here is
    // not comparable with a high one there. With nothing to tell candidates
    // apart, the source is what should decide.
    if prefix.is_empty() || value.starts_with(prefix) {
        return Some(2);
    }
    if value.to_lowercase().starts_with(&prefix.to_lowercase()) {
        return Some(1);
    }
    None
}

const HOUR: i64 = 3600;
const DAY: i64 = 24 * HOUR;
const WEEK: i64 = 7 * DAY;

/// How recent the last run was, as a multiplier. Real time when the history
/// carries timestamps, and the entry's own position in the file when it does
/// not — which is the common case, because EXTENDED_HISTORY is off by default.
fn recency_boost(c: &Candidate, now: i64) -> f64 {
    if let Some(at) = c.at.filter(|&a| a != 0) {
        let age = (now - at).max(0);
        return if age < HOUR {
            4.0
        } else if age < DAY {
            2.0
        } else if age < WEEK {
            0.5
        } else {
            0.25
        };
    }
    match c.freshness {
        None => 1.0,
        Some(f) if f >= 0.9 => 4.0,
        Some(f) if f >= 0.75 => 2.0,
        Some(f) if f >= 0.5 => 0.5,
        Some(_) => 0.25,
    }
}

/// How much a command is worth offering: how often it has been run, weighted
/// by how recently. The multipliers are the shape zoxide and Mozilla's
/// frecency both use.
pub fn frecency(c: &Candidate, now: i64) -> f64 {
    // Never run, as far as anything here knows: below everything with real
    // use behind it, but still in the list — that is how you find a flag you
    // have not used.
    let count = match c.count {
        None | Some(0) => return 0.0,
        Some(n) => n,
    };
    // Diminishing returns, deliberately: on a log scale the 86th run of
    // `clear` is worth far less than the 3rd run of something this morning.
    let runs = (1.0 + count.max(1) as f64).log2();
    runs * recency_boost(c, now)
}

/// Two prefixes, because two kinds of candidate are matched against two
/// different things. A schema subcommand, a filename or an executable
/// completes the WORD under the cursor; a history entry is a whole command
/// line and completes the LINE.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prefix {
    pub word: String,
    pub line: String,
}

impl From<&str> for Prefix {
    /// A bare string is read as both, which is the ordinary case at the start
    /// of a line where the word and the line are the same thing.
    fn from(s: &str) -> Self {
        Prefix { word: s.to_string(), line: s.to_string() }
    }
}

impl Prefix {
    pub fn new(word: &str, line: &str) -> Self {
        Prefix { word: word.to_string(), line: line.to_string() }
    }
}

/// What a schema entry is worth, learned from what you have actually run.
///
/// Each schema entry is credited with the runs of every past command that
/// starts with it: `merge` at `git ` inherits every `git merge …` you have
/// run. It then carries a count and a freshness like any history entry and is
/// ranked beside them on the same scale.
pub fn weigh_by_usage(candidates: &[Candidate], history: &[Candidate], line_prefix: &str) -> Vec<Candidate> {
    candidates
        .iter()
        .map(|candidate| {
            if candidate.source != Source::Schema || candidate.value.is_empty() {
                return candidate.clone();
            }
            let start = format!("{line_prefix}{}", candidate.value);
            let mut count = 0;
            let mut freshness: Option<f64> = None;
            let mut seen_freshness = false;
            for entry in history {
                if entry.source != Source::History || !entry.value.starts_with(&start) {
                    continue;
                }
                // The whole word, not a prefix of one: `npm r` starts every
                // `npm run …`, and `merge` would swallow `mergetool`.
                if let Some(&after) = entry.value.as_bytes().get(start.len()) {
                    if after != b' ' {
                        continue;
                    }
                }
                count += entry.count.unwrap_or(1);
                if !seen_freshness || entry.freshness.unwrap_or(0.0) > freshness.unwrap_or(f64::NEG_INFINITY) {
                    freshness = entry.freshness;
                    seen_freshness = true;
                }
            }
            if count > 0 {
                let mut out = candidate.clone();
                out.count = Some(count);
                out.freshness = freshness;
                out
            } else {
                candidate.clone()
            }
        })
        .collect()
}

// ── Eight rows, eight different ideas ──────────────────────────────────────
//
// Ranking alone cannot make a list useful: it puts the best candidate first,
// and then the second-best is usually a variation of the first. A list is
// worth its space when the rows are ALTERNATIVES.

fn words(value: &str) -> Vec<&str> {
    value.split_whitespace().collect()
}

/// The words that say what a command DOES, with the flags taken out. `ls -l`,
/// `ls -a` and `ls -la` all reduce to `ls`: one command run three ways.
fn without_flags(value: &str) -> String {
    words(value).into_iter().filter(|w| !w.starts_with('-')).collect::<Vec<_>>().join(" ")
}

fn shared_words(a: &str, b: &str) -> usize {
    words(a).iter().zip(words(b).iter()).take_while(|(x, y)| x == y).count()
}

/// Levenshtein, but it only ever needs to answer "within `max`?" — so it
/// gives up as soon as every cell in a row is already past the limit.
fn within_edits(a: &str, b: &str, max: usize) -> bool {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.len().abs_diff(b.len()) > max {
        return false;
    }
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut current = vec![i; b.len() + 1];
        let mut best = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            current[j] = (previous[j] + 1).min(current[j - 1] + 1).min(previous[j - 1] + cost);
            best = best.min(current[j]);
        }
        if best > max {
            return false;
        }
        previous = current;
    }
    previous[b.len()] <= max
}

/// How deep two commands must agree before they count as the same idea: one
/// word past what is typed, never less than two. At `docker exec ` every
/// command already agrees on two words by definition.
fn family_depth(typed_words: usize) -> usize {
    (typed_words + 1).max(2)
}
const MAX_PER_FAMILY: usize = 2;

/// How many never-run executables may take a row. `ls` shares its first two
/// letters with lsvfs, lsmp, lsbom, lsappinfo and lsm; five rows of binaries
/// nobody has ever run is not discovery, it is the alphabet.
const MAX_UNUSED_PATH: usize = 2;

/// What a typo, a stray trailing slash and an abandoned half-typed line all
/// look like: run once, and a character or two away from something run often.
const NEAR_DUPLICATE_EDITS: usize = 2;
const RUN_OFTEN_ENOUGH: u64 = 3;

fn unused_path(c: &Candidate) -> bool {
    c.source == Source::Path && matches!(c.count, None | Some(0))
}

pub fn admit(sorted: Vec<Candidate>, typed_words: usize, limit: usize) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();
    let mut passed: Vec<Candidate> = Vec::new();
    let depth = family_depth(typed_words);
    for candidate in sorted {
        let mut reject = false;

        // Everything already passed ranked higher, which for a history entry
        // means it is used more. Only history is judged this way: a schema
        // entry is a fact about the command, not something anyone typed.
        if candidate.source == Source::History && candidate.count.unwrap_or(1) <= 1 {
            reject = passed.iter().any(|seen| {
                seen.source == Source::History
                    && seen.count.unwrap_or(1) >= RUN_OFTEN_ENOUGH
                    && within_edits(&candidate.value, &seen.value, NEAR_DUPLICATE_EDITS)
            });
        }

        if !reject && unused_path(&candidate) {
            reject = out.iter().filter(|k| unused_path(k)).count() >= MAX_UNUSED_PATH;
        }

        if !reject {
            let bare = without_flags(&candidate.value);
            let family = out
                .iter()
                .filter(|kept| {
                    let same_stem = shared_words(&candidate.value, &kept.value) >= depth;
                    // Or the same command entirely, once its flags are set aside.
                    let same_command = !bare.is_empty() && bare == without_flags(&kept.value);
                    same_stem || same_command
                })
                .count();
            reject = family >= MAX_PER_FAMILY;
        }

        passed.push(candidate.clone());
        if reject {
            continue;
        }
        out.push(candidate);
        if out.len() == limit {
            break;
        }
    }
    out
}

pub fn rank_candidates(candidates: &[Candidate], prefix: impl Into<Prefix>, limit: usize, now: i64) -> Vec<Candidate> {
    let Prefix { word, line } = prefix.into();
    struct Scored<'a> {
        candidate: &'a Candidate,
        score: u8,
        weight: f64,
    }
    let mut scored: Vec<Scored> = Vec::new();
    for candidate in candidates {
        // A generator marker carries no value.
        if candidate.value.is_empty() {
            continue;
        }
        let against = if candidate.source == Source::History { &line } else { &word };
        // A word completed to itself is a no-op. A whole command is different:
        // `ls` is the most-run thing in a history by a long way, and dropping
        // it for being exactly what was typed left only its flag variants.
        if &candidate.value == against && candidate.source != Source::History {
            continue;
        }
        let Some(score) = match_score(&candidate.value, against) else { continue };
        scored.push(Scored { candidate, score, weight: frecency(candidate, now) });
    }

    scored.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            // How much the thing is USED comes before what kind of thing it
            // is; source settles ties instead of deciding the order.
            .then_with(|| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.candidate.source.rank().cmp(&b.candidate.source.rank()))
            // The actual timestamp, once the coarse buckets have run out of
            // things to say: newest first is what a directory listing is for.
            .then_with(|| b.candidate.at.unwrap_or(0).cmp(&a.candidate.at.unwrap_or(0)))
            .then_with(|| {
                b.candidate
                    .recency
                    .unwrap_or(0.0)
                    .partial_cmp(&a.candidate.recency.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    // Two sources offering the same text is common. Sorted order means the
    // first one seen is already the best-ranked, so the rest are dropped.
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<Candidate> = scored
        .into_iter()
        .filter(|s| seen.insert(s.candidate.value.clone()))
        .map(|s| s.candidate.clone())
        .collect();

    // The word under the cursor is only half typed unless a space follows
    // it, so it does not count as agreed-upon yet.
    let typed = words(&line).len();
    let complete = if line.ends_with(' ') || line.is_empty() { typed } else { typed.saturating_sub(1) };
    admit(unique, complete, limit)
}
