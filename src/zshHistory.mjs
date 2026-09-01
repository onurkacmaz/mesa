// The commands you have already run, out of zsh's own history file.
//
// Pure, like railReorder.mjs: the file's bytes in, candidates out. Reading the
// file happens in the main process; the format is the part worth testing.
//
// The file is read and never written. zsh owns it, another shell may be
// appending to it at the same moment, and nothing about offering completions
// justifies a second writer.
//
// It is also not a list of lines, and not plain text either. Three things have
// to be undone before any of it means anything:
//
//  - zsh METAFIES the bytes. 0x83 marks the next byte as escaped, and the real
//    byte is that one XOR 32. Read as UTF-8 without undoing it, a Turkish
//    command comes back as `ıă<?>Ń<?>`; read as latin1 it comes back as
//    `Ä±Ä¿Å¿`. Neither is the command, and neither would ever match what the
//    user types.
//  - With EXTENDED_HISTORY on — common enough to be the case worth handling —
//    every entry carries a `: <when>:<elapsed>;` header. The timestamp in it
//    is not noise to be stripped: it is how recent a command is, which is half
//    of deciding whether it is worth offering.
//  - A command spanning several lines continues with a trailing backslash,
//    which is exactly what Mesa's own Shift+Enter produces.

const HEADER = /^: (\d+):\d+;/;

// zsh's Meta escape. Kept here rather than in the caller because it is part of
// reading this file's format, and a test can reach it here.
export function unmetafy(buffer) {
  const out = Buffer.allocUnsafe(buffer.length);
  let j = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x83 && i + 1 < buffer.length) {
      i += 1;
      out[j] = buffer[i] ^ 32;
    } else {
      out[j] = buffer[i];
    }
    j += 1;
  }
  return out.subarray(0, j).toString('utf8');
}

export function parseZshHistory(text) {
  const entries = [];
  let current = null;
  let currentAt = null;

  const push = (value, at) => {
    // Trailing whitespace is not part of a command, and keeping it splits one
    // command into two entries — `npm run ` and `npm run` were both in the
    // list, competing with each other for a place in it.
    const trimmed = value.replace(/\s+$/, '');
    if (trimmed.trim() === '') return;
    entries.push({ value: trimmed, at });
  };

  for (const raw of text.split('\n')) {
    if (current !== null) {
      if (raw.endsWith('\\')) {
        current += `\n${raw.slice(0, -1)}`;
        continue;
      }
      push(`${current}\n${raw}`, currentAt);
      current = null;
      continue;
    }

    const header = HEADER.exec(raw);
    const at = header ? Number(header[1]) : null;
    const line = header ? raw.slice(header[0].length) : raw;
    if (line.trim() === '') continue;
    if (line.endsWith('\\')) {
      current = line.slice(0, -1);
      currentAt = at;
      continue;
    }
    push(line, at);
  }
  if (current !== null) push(current, currentAt);

  // How OFTEN a command was run is the single most useful thing in this file,
  // and collapsing duplicates without counting them threw it away. Measured on
  // a real history: `npm run dev` appears 61 times and the typo `npm ryb dev`
  // once, yet ordering on recency alone let the typo outrank it.
  //
  // Walking backwards keeps the most recent occurrence of each command — its
  // position and its timestamp — while still counting every one.
  const byValue = new Map();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const { value, at } = entries[i];
    const seen = byValue.get(value);
    if (seen) {
      seen.count += 1;
      continue;
    }
    byValue.set(value, { value, source: 'history', recency: i, count: 1, at });
  }

  // How fresh each command is, as a fraction: 1 is the last thing run, 0 the
  // first. It exists because the timestamp usually does not — EXTENDED_HISTORY
  // is off by default and plenty of history files, including the one this was
  // measured against, are bare lines with no `: <when>:` header at all. The
  // position in the file is then the only recency signal there is, and without
  // it ranking collapses to raw frequency, where whatever you once ran a
  // hundred times stays at the top forever.
  const total = Math.max(1, entries.length - 1);
  const out = [...byValue.values()].reverse();
  for (const entry of out) entry.freshness = entry.recency / total;
  return out;
}
