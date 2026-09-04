// Which candidates are offered, and in what order.
//
// Pure, like railReorder.mjs: candidates and a prefix in, an ordered list out.
// Nothing here knows where a candidate came from beyond the name of its
// source.
//
// PREFIX ONLY. There was a subsequence match here — every letter of the query
// appearing in order, so `gco` would find `git checkout` — and it had to go.
// It is the reason `npm` offered `claude-work --resume Session 412e...`, which
// contains an n, a p and an m in that order and nothing else in common with
// what was typed. One clever hit is not worth a list full of commands that
// have no visible relationship to the prefix. Warp's own inline history menu
// makes the same call: `if !normalized_text.starts_with(trimmed_query)
// { continue; }` — it keeps fuzzy matching for conversation titles, where
// there is nothing better, and never for commands.

// Source order, most authoritative first.
const SOURCE_RANK = { schema: 0, history: 1, file: 2, path: 3 };

// Higher is better; null means no match at all.
//
// Exported because the main process has to make the SAME judgement before
// sending candidates over IPC — PATH alone is a few thousand names and
// shipping all of them per keystroke stutters.
export function matchScore(value, prefix) {
  // An empty prefix matches everything, and matches it EQUALLY WELL — the same
  // score a solid prefix earns, not a worse one. The two kinds of candidate are
  // scored against different strings (a schema entry against the word under the
  // cursor, a history entry against the whole line), so a low score here is not
  // comparable with a high one there. Scoring the empty case 0 made `docker `
  // score its 57 subcommands below every past docker command line and the
  // schema never appeared at all. With nothing to tell candidates apart, the
  // source is what should decide, and it does.
  if (prefix === '') return 2;
  if (value.startsWith(prefix)) return 2;
  if (value.toLowerCase().startsWith(prefix.toLowerCase())) return 1;
  return null;
}

const HOUR = 3600;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// How much a command is worth offering: how often it has been run, weighted by
// how recently. Frequency alone would pin `clear` (86 runs) to the top of
// everything beginning with c forever; recency alone lets a typo run once an
// hour ago outrank the command run sixty times this week, which is exactly
// what was happening. The multipliers are the shape zoxide and Mozilla's
// frecency both use.
//
// How recent the last run was, as a multiplier. Real time when the history
// file carries timestamps, and the entry's own position in that file when it
// does not — which is the common case, because EXTENDED_HISTORY is off by
// default. Both are cut into the same four steps, because the point is to
// separate "just now", "recently" and "a while back", not to be precise.
function recencyBoost({ at, freshness }, now) {
  if (at) {
    const age = Math.max(0, now - at);
    if (age < HOUR) return 4;
    if (age < DAY) return 2;
    if (age < WEEK) return 0.5;
    return 0.25;
  }
  if (typeof freshness !== 'number') return 1;
  if (freshness >= 0.9) return 4;
  if (freshness >= 0.75) return 2;
  if (freshness >= 0.5) return 0.5;
  return 0.25;
}

export function frecency(candidate, now) {
  // Never run, as far as anything here knows: a schema entry no past command
  // matched. It still belongs in the list — that is how you find a flag you
  // have not used — but below everything with real use behind it.
  if (!candidate.count) return 0;
  // Diminishing returns, deliberately. A raw count grows without limit, and
  // then nothing can outrank it: `clear`, run 86 times but not for a month,
  // still beat a command used three times this morning, because 86 × the
  // oldest penalty is more than 3 × the freshest bonus. On a log scale the
  // 86th run is worth far less than the 3rd, which is also true of how much it
  // predicts the 87th.
  const runs = Math.log2(1 + Math.max(1, candidate.count ?? 1));
  return runs * recencyBoost(candidate, now);
}

// Two prefixes, because two kinds of candidate are being matched against two
// different things. A schema subcommand, a filename or an executable completes
// the WORD under the cursor. A history entry is a whole command line and
// completes the LINE — matching `cd RubymineProjects/sonar` against the word
// after `cd ` (which is empty) let every command in the file through, so `cd `
// offered `gs`, `claude` and `exit`. Warp matches history the same way, against
// the entire input rather than the last word.
//
// A bare string is read as both, which is the ordinary case at the start of a
// line where the word and the line are the same thing.
function prefixesFrom(prefix) {
  return typeof prefix === 'string' ? { word: prefix, line: prefix } : prefix;
}

// What a schema entry is worth, learned from what you have actually run.
//
// Without this a schema has no quality signal at all: every subcommand matches
// equally, so they came out in the order the JSON file happened to list them —
// `git ` opened with `archive`, `blame`, `commit`, `config`. Nobody's most-used
// git command is `archive`. The schema knows what git CAN do and has no idea
// what YOU do, and the history knows exactly.
//
// So each schema entry is credited with the runs of every past command that
// starts with it: `merge` at `git ` inherits every `git merge …` you have run.
// It then carries a count and a freshness like any history entry and is ranked
// beside them on the same scale, instead of ahead of them by category.
export function weighByUsage(candidates, history, linePrefix) {
  return candidates.map((candidate) => {
    if (candidate.source !== 'schema' || !candidate.value) return candidate;
    const start = `${linePrefix}${candidate.value}`;
    let count = 0;
    let freshness;
    for (const entry of history) {
      if (entry.source !== 'history' || !entry.value.startsWith(start)) continue;
      // The whole word, not a prefix of one. `npm r` starts every `npm run …`
      // there is, so the alias `r` was credited with all 70 runs of `run` and
      // came out above it; `merge` would likewise have swallowed `mergetool`.
      const after = entry.value[start.length];
      if (after !== undefined && after !== ' ') continue;
      count += entry.count ?? 1;
      if (freshness === undefined || (entry.freshness ?? 0) > freshness) {
        freshness = entry.freshness;
      }
    }
    return count ? { ...candidate, count, freshness } : candidate;
  });
}

export function rankCandidates(candidates, prefix, limit = 8, now = Date.now() / 1000) {
  const { word, line } = prefixesFrom(prefix);
  const scored = [];
  for (const candidate of candidates) {
    const against = candidate.source === 'history' ? line : word;
    // A generator marker carries no value, and a candidate identical to what
    // is already typed would accept to a no-op.
    if (!candidate.value || candidate.value === against) continue;
    const score = matchScore(candidate.value, against);
    if (score === null) continue;
    scored.push({
      candidate,
      score,
      weight: frecency(candidate, now)
    });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    // How much the thing is USED comes before what kind of thing it is. Source
    // used to win outright, which meant a schema entry nobody has ever run —
    // and the schema is mostly those — buried every command the user actually
    // types. It settles ties now instead of deciding the order.
    if (a.weight !== b.weight) return b.weight - a.weight;
    const sourceDelta =
      (SOURCE_RANK[a.candidate.source] ?? 9) - (SOURCE_RANK[b.candidate.source] ?? 9);
    if (sourceDelta !== 0) return sourceDelta;
    // Nothing to choose between them but which was seen last.
    return (b.candidate.recency ?? 0) - (a.candidate.recency ?? 0);
  });

  // Two sources offering the same text is common — `git status` is both a
  // schema entry and something you have run. Sorted order means the first one
  // seen is already the best-ranked, so the rest are simply dropped.
  const seen = new Set();
  const out = [];
  for (const { candidate } of scored) {
    if (seen.has(candidate.value)) continue;
    seen.add(candidate.value);
    out.push(candidate);
    if (out.length === limit) break;
  }
  return out;
}
