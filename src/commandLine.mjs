// Which word the cursor is in, and what came before it.
//
// Pure, like railReorder.mjs: a string and an offset in, a description of
// what is being completed out. Nothing here knows about xterm or React.
//
// This is deliberately not a shell parser. It knows quoting, backslash
// escapes and the separators that start a fresh command, because each of
// those changes what a sensible candidate is — and it knows nothing else.
// Anything more (expansions, substitutions, redirections) would be work spent
// on cases where offering no completion is the right answer anyway.

const SEPARATORS = ['&&', '||', '|', ';', '\n'];

// Everything to the right of the cursor belongs to the line, not to the word
// being completed, so the scan simply never sees it.
export function completionContext(buffer, cursor) {
  const text = buffer.slice(0, Math.max(0, Math.min(cursor, buffer.length)));

  const words = [];
  let current = '';
  let start = 0;
  let quote = null;
  let started = false;

  const finish = () => {
    if (started) words.push(current);
    current = '';
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '\\' && i + 1 < text.length) {
      // The backslash is how the escape is written, not part of the word.
      if (!started) {
        started = true;
        start = i;
      }
      current += text[i + 1];
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      if (!started) {
        started = true;
        // Past the quote, not on it. `start` is where a replacement is
        // written from, so pointing at the quote itself would have the
        // accepted text overwrite the opening quote and unbalance the line.
        start = i + 1;
      }
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      finish();
      continue;
    }

    const separator = SEPARATORS.find((s) => text.startsWith(s, i));
    if (separator) {
      // A separator ends the word AND the command: what follows is a fresh
      // command line, so everything gathered so far stops being context.
      finish();
      words.length = 0;
      i += separator.length - 1;
      continue;
    }

    if (!started) {
      started = true;
      start = i;
    }
    current += ch;
  }

  // The trailing word is the prefix, not a completed word. An unstarted one
  // means the cursor sits after a space, which is an empty prefix beginning
  // where the cursor is.
  const prefix = started ? current : '';
  return {
    prefix,
    start: started ? start : text.length,
    words,
    position: words.length === 0 ? 'command' : 'argument',
    quote
  };
}
