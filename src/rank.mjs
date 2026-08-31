// Which candidates are offered, and in what order.
//
// Pure, like railReorder.mjs: candidates and a prefix in, an ordered list
// out. Nothing here knows where a candidate came from beyond the name of its
// source.
//
// The ordering is three rules deep and each earns its place. How well the
// prefix matches comes first, because a solid prefix is what the user is
// obviously reaching for and a scattered match is a guess. The source breaks
// the tie, because a schema entry is something the CLI genuinely accepts
// here, while a file only happens to share some letters. Recency settles the
// rest, which is what makes history feel like it is reading your mind.

// Source order, most authoritative first.
const SOURCE_RANK = { schema: 0, history: 1, file: 2, path: 3 };

// Higher is better; null means no match at all.
//
// Exported because the main process has to make the SAME judgement before
// sending candidates over IPC — PATH alone is a few thousand names and
// shipping all of them per keystroke stutters. Filtering there with a plain
// startsWith would have quietly killed the fuzzy match: `gco` would never
// reach this file to become `git checkout`.
export function matchScore(value, prefix) {
  if (prefix === '') return 0;
  if (value.startsWith(prefix)) return 3;
  const lowerValue = value.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerValue.startsWith(lowerPrefix)) return 2;

  // Subsequence: every letter of the prefix appears in order, which is what
  // turns `gco` into `git checkout`.
  let at = 0;
  for (const ch of lowerPrefix) {
    at = lowerValue.indexOf(ch, at);
    if (at === -1) return null;
    at += 1;
  }
  return 1;
}

export function rankCandidates(candidates, prefix, limit = 8) {
  const scored = [];
  for (const candidate of candidates) {
    // A generator marker carries no value, and a candidate identical to what
    // is already typed would accept to a no-op.
    if (!candidate.value || candidate.value === prefix) continue;
    const score = matchScore(candidate.value, prefix);
    if (score === null) continue;
    scored.push({ candidate, score });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const sourceDelta =
      (SOURCE_RANK[a.candidate.source] ?? 9) - (SOURCE_RANK[b.candidate.source] ?? 9);
    if (sourceDelta !== 0) return sourceDelta;
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
