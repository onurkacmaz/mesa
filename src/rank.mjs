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

// ── Eight rows, eight different ideas ──────────────────────────────────────
//
// Ranking alone cannot make a list useful, because it answers the wrong
// question. It puts the best candidate first, and then the second-best is
// usually a variation of the first: typing `claude` filled five of eight rows
// with `claude-work --resume <a session id you will never retype>`, and
// `docker c` gave three rows of `docker compose --profile …`. Every one of
// those really is a command you ran, so they rank alike and crowd out
// everything else. A list is worth its space when the rows are ALTERNATIVES.

const words = (value) => value.split(/\s+/).filter(Boolean);

// How many leading words two commands agree on.
function sharedWords(a, b) {
  const x = words(a);
  const y = words(b);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n += 1;
  return n;
}

// Levenshtein, but it only ever needs to answer "within `max`?" — so it gives
// up as soon as every cell in a row is already past the limit.
function withinEdits(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (current[j] < best) best = current[j];
    }
    if (best > max) return false;
    previous = current;
  }
  return previous[b.length] <= max;
}

// How deep two commands must agree before they count as the same idea.
//
// Two leading words is the floor, and it has to rise with what has been typed
// or a long line collapses into nothing: at `docker exec ` every command
// already agrees on two words by definition, so a fixed two would have read
// every container you have ever run as the same idea. One word past what is
// typed, never less than two.
//
// Measured against a real history, this is what separates `docker compose
// down` and `docker compose up -d` — two ideas, they part company at the third
// word — from the three `docker compose --profile …` variants, which are one.
const familyDepth = (typedWords) => Math.max(2, typedWords + 1);
const MAX_PER_FAMILY = 2;

// What a typo, a stray trailing slash and an abandoned half-typed line all
// look like: run once, and a character or two away from something run often.
const NEAR_DUPLICATE_EDITS = 2;
const RUN_OFTEN_ENOUGH = 3;

export function admit(sorted, typedWords, limit) {
  const out = [];
  const passed = [];
  for (const candidate of sorted) {
    const { value, source, count } = candidate;
    let reject = false;

    for (const seen of passed) {
      // Everything already passed ranked higher, which for a history entry
      // means it is used more. Only history is judged this way: a schema entry
      // is a fact about the command, not something anyone typed.
      if (
        source === 'history' &&
        seen.source === 'history' &&
        (count ?? 1) <= 1 &&
        (seen.count ?? 1) >= RUN_OFTEN_ENOUGH &&
        withinEdits(value, seen.value, NEAR_DUPLICATE_EDITS)
      ) {
        reject = true;
        break;
      }
    }

    if (!reject) {
      const depth = familyDepth(typedWords);
      let family = 0;
      for (const kept of out) {
        if (sharedWords(value, kept.value) >= depth) family += 1;
      }
      if (family >= MAX_PER_FAMILY) reject = true;
    }

    passed.push(candidate);
    if (reject) continue;
    out.push(candidate);
    if (out.length === limit) break;
  }
  return out;
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
    // The actual timestamp, once the buckets have run out of things to say.
    // Those buckets are coarse on purpose — they have to compare a file with a
    // command — but everything in one working directory tends to fall inside
    // the same week, so every file in `ls ` scored identically and they came
    // out in whatever order the filesystem returned them. Newest first is what
    // a directory listing is actually asked for.
    const atDelta = (b.candidate.at ?? 0) - (a.candidate.at ?? 0);
    if (atDelta !== 0) return atDelta;
    // Nothing to choose between them but which was seen last.
    return (b.candidate.recency ?? 0) - (a.candidate.recency ?? 0);
  });

  // Two sources offering the same text is common — `git status` is both a
  // schema entry and something you have run. Sorted order means the first one
  // seen is already the best-ranked, so the rest are simply dropped.
  const seen = new Set();
  const unique = [];
  for (const { candidate } of scored) {
    if (seen.has(candidate.value)) continue;
    seen.add(candidate.value);
    unique.push(candidate);
  }

  // Cut to `limit` only after the rows have been made to differ from each
  // other. Cutting first would hand the whole list to one family.
  //
  // The word under the cursor is only half typed unless a space follows it, so
  // it does not count as agreed-upon yet. Counting it did: at `claude` the
  // family depth came out one too deep and every `claude-work --resume …` was
  // read as its own idea, which is the whole thing being fixed.
  const complete = words(line).length - (line.endsWith(' ') || line === '' ? 0 : 1);
  return admit(unique, Math.max(0, complete), limit);
}
