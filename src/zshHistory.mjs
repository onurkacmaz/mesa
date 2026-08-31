// The commands you have already run, out of zsh's own history file.
//
// Pure, like railReorder.mjs: the file's text in, candidates out. Reading the
// file happens in the main process; the format is the part worth testing.
//
// The file is read and never written. zsh owns it, another shell may be
// appending to it at the same moment, and nothing about offering completions
// justifies a second writer.
//
// It is also not a list of lines. With EXTENDED_HISTORY on — common enough to
// be the case worth handling — every entry carries a `: <when>:<elapsed>;`
// header, and a command spanning several lines continues with a trailing
// backslash, which is exactly what Mesa's own Shift+Enter produces.

const HEADER = /^: \d+:\d+;/;

export function parseZshHistory(text) {
  const entries = [];
  let current = null;

  for (const raw of text.split('\n')) {
    if (current !== null) {
      // Mid-command: a trailing backslash means another line follows.
      if (raw.endsWith('\\')) {
        current += `\n${raw.slice(0, -1)}`;
        continue;
      }
      entries.push(`${current}\n${raw}`);
      current = null;
      continue;
    }

    const line = raw.replace(HEADER, '');
    if (line.trim() === '') continue;
    if (line.endsWith('\\')) {
      current = line.slice(0, -1);
      continue;
    }
    entries.push(line);
  }
  if (current !== null) entries.push(current);

  // Later in the file is more recent. Walking backwards keeps the most recent
  // occurrence of a repeated command and drops the older ones, then the order
  // is restored so callers still see oldest first.
  const seen = new Set();
  const kept = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (seen.has(entries[i])) continue;
    seen.add(entries[i]);
    kept.push({ value: entries[i], source: 'history', recency: i });
  }
  return kept.reverse();
}
