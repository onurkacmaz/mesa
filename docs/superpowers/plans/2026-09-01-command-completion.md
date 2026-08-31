# Inline Command Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dropdown that opens under the cursor as you type at the zsh prompt, listing past commands, files, PATH executables and hand-written subcommand/flag schemas, accepted with Enter.

**Architecture:** zsh's ZLE owns the input line, so the renderer learns what is typed by a `line-pre-redraw` hook that emits the buffer over a private OSC 1717 sequence. The renderer decodes it, tokenizes it, gathers candidates from four sources, ranks them, and draws a list inside the pane — inside the canvas transform, so it scales with zoom. Accepting replaces the line by sending `^E ^U` plus the text.

**Tech Stack:** Electron, React, xterm.js, node-pty, zsh 5.9. Pure logic lives in `src/*.mjs` and is tested with `node --test`, matching `railReorder.mjs` / `session.mjs` / `editors.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-01-command-completion-design.md`

## Global Constraints

- **zsh only.** The hook lives in `electron/shell-hooks/zsh/.zshenv`, which `shellEnv()` in `electron/main.js` already gates on `path.basename(shellPath) !== 'zsh'`. Other shells get no dropdown and no errors.
- **No fork in the hook.** The hook runs on every ZLE redraw. Parameter expansion only — no `$( )`, no subshell, no external command.
- **Never intercept Tab.** Tab always reaches zsh, dropdown open or not.
- **No shadow-buffer fallback.** If OSC 1717 never arrives, the dropdown never opens. Never reconstruct the line from keystrokes.
- **Schema `generator` values are names, never code.** They index a fixed table in the main process. Nothing from a schema JSON file is ever passed to a shell or `eval`.
- **`~/.zsh_history` is read-only.** Never write to it.
- **The overlay renders inside the pane**, positioned from `term.buffer.active.cursorX/cursorY`, never from `getBoundingClientRect`.
- **Hidden while a TUI owns the alternate buffer** (`tuiRef.current`).
- **List capped at 8 rows.**
- **Comment style:** every new `.mjs` opens with a prose comment explaining *why* it exists, matching `src/railReorder.mjs`. Tests are named as sentences describing behaviour.
- **Run one test file with** `node --test test/<name>.test.mjs`; the whole suite with `npm test`.

---

### Task 1: Decode the wire format

The hook escapes the line buffer so it survives an OSC payload. This is the decoder, and the first thing everything else depends on. It is written first because a wrong decoder corrupts every downstream module silently.

**Files:**
- Create: `src/zleBuffer.mjs`
- Test: `test/zleBuffer.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `decodeZleBuffer(payload: string) -> string`
  - `parseZleOsc(data: string) -> { cursor: number, buffer: string } | null`

The hook escapes exactly six things, backslash first: `\` → `\\`, LF → `\n`, CR → `\r`, ESC → `\e`, BEL → `\a`, TAB → `\t`. `parseZleOsc` receives what xterm hands an OSC handler: everything after `1717;`, e.g. `L;17;grep "^[a-z]"`. It splits on the first two `;` only — the buffer is the last field and may contain `;` freely.

- [ ] **Step 1: Write the failing test**

Create `test/zleBuffer.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeZleBuffer, parseZleOsc } from '../src/zleBuffer.mjs';

test('an ordinary line comes back untouched', () => {
  assert.equal(decodeZleBuffer('git checkout main'), 'git checkout main');
});

test('the escaped control characters come back as themselves', () => {
  assert.equal(decodeZleBuffer('a\\nb'), 'a\nb');
  assert.equal(decodeZleBuffer('a\\rb'), 'a\rb');
  assert.equal(decodeZleBuffer('a\\tb'), 'a\tb');
  assert.equal(decodeZleBuffer('a\\eb'), 'a\x1bb');
  assert.equal(decodeZleBuffer('a\\ab'), 'a\x07b');
});

// The case that ruled out ${(V)}: with backslashes escaped first, a literal
// backslash-n and a real newline are distinguishable. Without that they are
// the same three bytes and no decoder can be correct.
test('a literal backslash is not mistaken for an escape', () => {
  assert.equal(decodeZleBuffer('a\\\\nb'), 'a\\nb');
  assert.equal(decodeZleBuffer('grep "\\\\n"'), 'grep "\\n"');
});

// The other case that ruled out ${(V)}: caret notation would have made this
// indistinguishable from a real ESC. Nothing escapes a caret, so it survives.
test('a literal caret-bracket survives, being an ordinary command', () => {
  assert.equal(decodeZleBuffer('grep "^[a-z]" file'), 'grep "^[a-z]" file');
});

test('an unknown escape keeps both characters', () => {
  assert.equal(decodeZleBuffer('a\\qb'), 'a\\qb');
});

test('a trailing lone backslash is kept', () => {
  assert.equal(decodeZleBuffer('echo \\\\'), 'echo \\');
  assert.equal(decodeZleBuffer('echo \\'), 'echo \\');
});

test('the osc payload splits into a cursor and a buffer', () => {
  assert.deepEqual(parseZleOsc('L;5;git c'), { cursor: 5, buffer: 'git c' });
});

// Semicolons are ordinary in shell commands, so the buffer has to be the last
// field and everything after the second separator belongs to it.
test('semicolons in the command stay in the buffer', () => {
  assert.deepEqual(parseZleOsc('L;12;cd /tmp; ls'), {
    cursor: 12,
    buffer: 'cd /tmp; ls'
  });
});

test('an empty buffer is a buffer, not a missing one', () => {
  assert.deepEqual(parseZleOsc('L;0;'), { cursor: 0, buffer: '' });
});

test('anything that is not a line report is refused', () => {
  assert.equal(parseZleOsc('X;0;hi'), null);
  assert.equal(parseZleOsc('L;notanumber;hi'), null);
  assert.equal(parseZleOsc('L;5'), null);
  assert.equal(parseZleOsc(''), null);
});

test('multi-byte characters survive and the cursor counts them as one each', () => {
  assert.deepEqual(parseZleOsc('L;17;grep "^[a-z]" ığş'), {
    cursor: 17,
    buffer: 'grep "^[a-z]" ığş'
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/zleBuffer.test.mjs`
Expected: FAIL — `Cannot find module '../src/zleBuffer.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `src/zleBuffer.mjs`:

```javascript
// The line the shell is editing, as it arrives over the wire.
//
// Pure, like railReorder.mjs: what comes in is the payload of an OSC 1717
// sequence and what goes out is the exact string zsh had in $BUFFER. Nothing
// in here knows about xterm or React.
//
// The escaping this undoes is deliberately hand-rolled rather than base64,
// because the hook emitting it runs on every keystroke and zsh has no base64
// builtin — encoding would mean a fork per key. zsh's own ${(V)} flag looked
// like the fork-free answer and was measured to be lossy twice over: it
// leaves backslashes alone, so a literal \n and a real newline arrive
// identically, and it writes ESC in caret notation, which a literal ^[ is
// indistinguishable from. `grep "^[a-z]"` is an ordinary command, so that
// second one is not a corner case. Escaping the backslash first and never
// using caret notation settles both.

const ESCAPES = new Map([
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['e', '\x1b'],
  ['a', '\x07'],
  ['\\', '\\']
]);

export function decodeZleBuffer(payload) {
  let out = '';
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = payload[i + 1];
    const decoded = next === undefined ? undefined : ESCAPES.get(next);
    // An escape the hook never emits is not ours to interpret: both
    // characters are kept exactly as they arrived rather than guessed at.
    if (decoded === undefined) {
      out += ch;
      continue;
    }
    out += decoded;
    i += 1;
  }
  return out;
}

// `data` is everything xterm hands an OSC handler after the `1717;`, which is
// `L;<cursor>;<escaped buffer>`. Only the first two separators are split on —
// a semicolon is an ordinary character in a shell command and every one of
// them after that belongs to the buffer.
export function parseZleOsc(data) {
  if (typeof data !== 'string') return null;
  const first = data.indexOf(';');
  if (first === -1 || data.slice(0, first) !== 'L') return null;
  const second = data.indexOf(';', first + 1);
  if (second === -1) return null;
  const cursorText = data.slice(first + 1, second);
  if (!/^\d+$/.test(cursorText)) return null;
  return {
    cursor: Number(cursorText),
    buffer: decodeZleBuffer(data.slice(second + 1))
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/zleBuffer.test.mjs`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/zleBuffer.mjs test/zleBuffer.test.mjs
git commit -m "Read the line the shell is editing off the wire"
```

---

### Task 2: Emit the line buffer from zsh

The producer side of Task 1's format. There is no unit test for this — it is shell code inside a live ZLE — so it is verified by hand under a real pty before anything is built on it.

**Files:**
- Modify: `electron/shell-hooks/zsh/.zshenv` (append, after `add-zsh-hook preexec __wfterm_preexec`)

**Interfaces:**
- Consumes: nothing.
- Produces: `\e]1717;L;<cursor>;<escaped buffer>\a` on stdout, on every change to the line.

- [ ] **Step 1: Append the hook**

Add at the end of `electron/shell-hooks/zsh/.zshenv`:

```zsh
# What is currently being typed, so the app can offer a completion list for
# it. Mesa does not own the input line — ZLE does — so the only honest source
# for "what is on the line" is ZLE itself. Reconstructing it from keystrokes
# was rejected: it desyncs silently on history recall, on paste, on the
# shell's own Tab completion, and on the ^W/^U the app itself sends, and a
# list built on a buffer that lies is worse than no list.
#
# add-zle-hook-widget rather than `zle -N zle-line-pre-redraw`: defining that
# widget directly clobbers whatever else claims it, which would break
# zsh-autosuggestions and zsh-syntax-highlighting. Additive, like every other
# hook in this file.
__wfterm_zle_sync() {
  # line-pre-redraw fires on every redraw, not every change — moving the
  # cursor and syntax highlighting repaint the line too — so this compares
  # before emitting rather than making the app recompute for nothing.
  [[ $BUFFER == $__wfterm_last_buffer ]] && return
  __wfterm_last_buffer=$BUFFER

  # $BUFFER can hold ESC, BEL and newlines, any of which would corrupt the
  # sequence. zsh has no base64 builtin and this runs on every keystroke, so
  # encoding must not fork: these are all parameter expansions. The backslash
  # goes first, which is what makes a literal \n and a real newline tell
  # apart. Caret notation is deliberately not used — zsh's own ${(V)} does,
  # and it makes a real ESC indistinguishable from the ^[ in `grep "^[a-z]"`.
  local b=${BUFFER//\\/\\\\}
  b=${b//$'\n'/\\n}
  b=${b//$'\r'/\\r}
  b=${b//$'\e'/\\e}
  b=${b//$'\a'/\\a}
  b=${b//$'\t'/\\t}

  # Anything still holding a control character needed ^V to type. Rather than
  # guess at an encoding for it, say nothing: the list simply does not open
  # for that line, which is the same policy as everywhere else here.
  [[ $b == *[[:cntrl:]]* ]] && return

  printf '\e]1717;L;%d;%s\a' "$CURSOR" "$b"
}

autoload -Uz add-zle-hook-widget
add-zle-hook-widget line-pre-redraw __wfterm_zle_sync
```

- [ ] **Step 2: Verify it fires under a real pty**

This cannot be checked by running zsh with piped stdin — ZLE needs a terminal, and input arriving all at once is consumed before the editor draws. Allocate a pty with `script` and feed keystrokes with delays:

```bash
cd /tmp && rm -rf zletest && mkdir -p zletest && cd zletest
cp /Users/onurkacmaz/Desktop/mesa/electron/shell-hooks/zsh/.zshenv ./.zshrc
perl -e '$|=1; select(undef,undef,undef,1.2); print q{grep "^[a-z]" ığş};
         select(undef,undef,undef,0.9); print "\r";
         select(undef,undef,undef,0.6); print "exit\r";
         select(undef,undef,undef,0.5);' \
  | ZDOTDIR=$PWD script -q /dev/null zsh -i > out.txt 2>&1
perl -ne 'while(/\x1b\]1717;L;(\d+);(.*?)\x07/gs){print "cursor=$1 payload=[$2]\n"}' out.txt
```

Expected: one line per keystroke, ending with

```
cursor=17 payload=[grep "^[a-z]" ığş]
```

The caret-bracket must be intact and the cursor must be 17, not the byte length — that is the check that multi-byte characters are counted as one each.

- [ ] **Step 3: Verify the user's own config still loads**

Run Mesa (`npm run dev`), open a terminal pane, and confirm:
- the prompt still appears and commands still run
- `echo $ZDOTDIR` reports the user's real value, not the hook directory
- if `zsh-autosuggestions` or `zsh-syntax-highlighting` are installed, they still work — this is what `add-zle-hook-widget` protects and the one way to see it

- [ ] **Step 4: Commit**

```bash
git add electron/shell-hooks/zsh/.zshenv
git commit -m "Tell the app what is being typed, from ZLE itself"
```

---

### Task 3: Receive the buffer in the renderer

Wire OSC 1717 into `TerminalView` beside the OSC 7/4/10/11/133 handlers that already exist, and hand what arrives to a callback. Nothing is drawn yet — this task ends when the decoded line can be seen updating per keystroke.

**Files:**
- Modify: `src/TerminalView.jsx` (add a handler beside `oscCwdDisposable`, around line 453; add its `.dispose()` to the cleanup return, around line 530)

**Interfaces:**
- Consumes: `parseZleOsc` from `src/zleBuffer.mjs` (Task 1).
- Produces: an `onLineChange({ buffer, cursor })` prop on `TerminalView`, called on every change to the shell's input line, and called with `null` whenever the line stops being live (TUI takes the screen, or a command starts running).

- [ ] **Step 1: Add the handler**

Import at the top of `src/TerminalView.jsx`:

```javascript
import { parseZleOsc } from './zleBuffer.mjs';
```

Add beside the other OSC registrations:

```javascript
    // What the shell has on its input line, reported by the ZLE hook in
    // electron/shell-hooks/zsh/.zshenv. This is the only honest source for
    // it: the line belongs to ZLE, not to us.
    //
    // Silence is a valid state and the whole fallback story. A shell that is
    // not zsh, or one whose config displaced the hook, simply never sends
    // this and the completion list never opens — rather than being fed a
    // guess reconstructed from keystrokes.
    const oscLineDisposable = term.parser.registerOscHandler(1717, (data) => {
      const line = parseZleOsc(data);
      // A TUI owns the whole screen and has no shell line behind it. Same
      // guard as the OSC 133 prompt marker, for the same reason.
      if (line && !tuiRef.current) onLineChangeRef.current?.(line);
      return true;
    });
```

Add to the cleanup return, beside `oscCwdDisposable.dispose()`:

```javascript
      oscLineDisposable.dispose();
```

- [ ] **Step 2: Close the list when the line stops being live**

A submitted command and a TUI both mean there is no line any more. In the existing OSC 133 handler, inside the `if (kind === 'C')` branch, after `sawCommand = true;`:

```javascript
        // The line has been submitted, so there is nothing to complete
        // against until the next prompt.
        onLineChangeRef.current?.(null);
```

And in `applyTuiLayout`, wherever it is told the alternate buffer has been entered, call `onLineChangeRef.current?.(null)` for the same reason.

- [ ] **Step 3: Hold the callback in a ref**

The OSC handler is registered once inside the mount effect, so it must not close over a stale prop. Beside the existing `scaleRef` pattern near line 55:

```javascript
  const onLineChangeRef = useRef(onLineChange);
  onLineChangeRef.current = onLineChange;
```

Add `onLineChange` to the component's destructured props beside `scale`.

- [ ] **Step 4: Verify by hand**

Temporarily pass `onLineChange={(l) => console.log('line', l)}` from `TerminalPane.jsx`, run `npm run dev`, open the renderer devtools, and type at a prompt.

Expected: one log per keystroke with the exact text on the line. Then check the three cases that matter:
- press ↑ to recall a command — the log must show the **recalled command**, which is the case a keystroke-based shadow buffer gets wrong
- press Tab and let zsh complete a path — the log must show the **completed** line
- run `htop` or `less` — logs must stop, and a `null` must arrive

Remove the temporary prop before committing.

- [ ] **Step 5: Commit**

```bash
git add src/TerminalView.jsx
git commit -m "Listen for the line the shell reports"
```

---

### Task 4: Work out what is being completed

Turn a buffer and a cursor into "which word is under the cursor, what comes before it, and is it the command or an argument". Pure and heavily tested — every source depends on getting this right.

**Files:**
- Create: `src/commandLine.mjs`
- Test: `test/commandLine.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `completionContext(buffer: string, cursor: number) -> { prefix, start, words, position, quote }` where `position` is `'command'` or `'argument'`, `quote` is `'"'`, `"'"` or `null`, `words` is the completed words before the prefix (including the command name), and `start` is the index in `buffer` where `prefix` begins.

- [ ] **Step 1: Write the failing test**

Create `test/commandLine.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { completionContext } from '../src/commandLine.mjs';

// The cursor is almost always at the end while typing, so that is the default
// the tests read against; the cases where it is not get their own test.
const at = (buffer, cursor = buffer.length) => completionContext(buffer, cursor);

test('the first word is the command being completed', () => {
  assert.deepEqual(at('gi'), {
    prefix: 'gi',
    start: 0,
    words: [],
    position: 'command',
    quote: null
  });
});

test('an empty line offers everything from the command position', () => {
  assert.deepEqual(at(''), {
    prefix: '',
    start: 0,
    words: [],
    position: 'command',
    quote: null
  });
});

test('a word after the command is an argument, and the command is context', () => {
  assert.deepEqual(at('git ch'), {
    prefix: 'ch',
    start: 4,
    words: ['git'],
    position: 'argument',
    quote: null
  });
});

test('a space at the end starts a new empty argument', () => {
  assert.deepEqual(at('git checkout '), {
    prefix: '',
    start: 13,
    words: ['git', 'checkout'],
    position: 'argument',
    quote: null
  });
});

test('a flag is an ordinary argument, dashes and all', () => {
  assert.deepEqual(at('git checkout -'), {
    prefix: '-',
    start: 13,
    words: ['git', 'checkout'],
    position: 'argument',
    quote: null
  });
});

// Only the text up to the cursor is being completed. What is to the right of
// it belongs to the line, not to the word we are offering candidates for.
test('the word is cut at the cursor, not at its end', () => {
  assert.deepEqual(completionContext('git checkout main', 11), {
    prefix: 'che',
    start: 4,
    words: ['git'],
    position: 'argument',
    quote: null
  });
});

test('runs of spaces do not become empty words', () => {
  assert.deepEqual(at('git   ch'), {
    prefix: 'ch',
    start: 6,
    words: ['git'],
    position: 'argument',
    quote: null
  });
});

test('a quoted argument is one word, spaces included', () => {
  assert.deepEqual(at('git commit -m "work in pro'), {
    prefix: 'work in pro',
    start: 15,
    words: ['git', 'commit', '-m'],
    position: 'argument',
    quote: '"'
  });
});

test('single quotes work the same way', () => {
  assert.deepEqual(at("cd 'My Doc"), {
    prefix: 'My Doc',
    start: 4,
    words: ['cd'],
    position: 'argument',
    quote: "'"
  });
});

test('a closed quote is a finished word', () => {
  assert.deepEqual(at('cd "My Documents" '), {
    prefix: '',
    start: 18,
    words: ['cd', 'My Documents'],
    position: 'argument',
    quote: null
  });
});

// An escaped space is the other way to write a path with a space in it, and
// the backslash is not part of what the user means by the word.
test('an escaped space keeps the word together', () => {
  assert.deepEqual(at('cd My\\ Doc'), {
    prefix: 'My Doc',
    start: 3,
    words: ['cd'],
    position: 'argument',
    quote: null
  });
});

// Each of these starts a new command, so what follows is in command position
// again — offering `git` subcommands after a pipe would be nonsense.
test('a pipe or a separator starts a new command', () => {
  assert.deepEqual(at('ls | gr'), {
    prefix: 'gr',
    start: 5,
    words: [],
    position: 'command',
    quote: null
  });
  assert.deepEqual(at('cd /tmp && l'), {
    prefix: 'l',
    start: 11,
    words: [],
    position: 'command',
    quote: null
  });
  assert.deepEqual(at('cd /tmp; l'), {
    prefix: 'l',
    start: 9,
    words: [],
    position: 'command',
    quote: null
  });
});

// A separator inside quotes is text, not a separator.
test('a separator inside quotes does not start a command', () => {
  assert.deepEqual(at('echo "a | b'), {
    prefix: 'a | b',
    start: 6,
    words: ['echo'],
    position: 'argument',
    quote: '"'
  });
});

// Mesa's own Shift+Enter puts real newlines in the buffer.
test('a newline starts a new command like a separator does', () => {
  assert.deepEqual(at('cd /tmp\nl'), {
    prefix: 'l',
    start: 8,
    words: [],
    position: 'command',
    quote: null
  });
});

test('a cursor past the end of the line does not run off it', () => {
  assert.deepEqual(completionContext('git', 99), {
    prefix: 'git',
    start: 0,
    words: [],
    position: 'command',
    quote: null
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/commandLine.test.mjs`
Expected: FAIL — `Cannot find module '../src/commandLine.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `src/commandLine.mjs`:

```javascript
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
        start = i;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/commandLine.test.mjs`
Expected: PASS, 15 tests

- [ ] **Step 5: Commit**

```bash
git add src/commandLine.mjs test/commandLine.test.mjs
git commit -m "Work out which word the cursor is completing"
```

---

### Task 5: Walk the CLI schemas

Hand-written JSON describing subcommands and flags, and the code that walks it. `generator` values are names looked up later in the main process — nothing here ever executes anything.

**Files:**
- Create: `src/schema.mjs`
- Create: `src/schemas/git.json`, `src/schemas/npm.json`, `src/schemas/docker.json`, `src/schemas/brew.json`, `src/schemas/ssh.json`, `src/schemas/kubectl.json`, `src/schemas/cd.json`
- Create: `src/schemas/index.mjs`
- Test: `test/schema.test.mjs`

**Interfaces:**
- Consumes: `completionContext`'s `words` and `prefix` (Task 4).
- Produces:
  - `schemaCandidates(schema, words, prefix) -> Array<{ value, description, source: 'schema', generator?: string }>` where `words` is the full word list including the command name.
  - `SCHEMAS: Record<string, object>` from `src/schemas/index.mjs`.

A schema is `{ name, subcommands?, options?, args? }`; a subcommand has the same shape recursively. `args.generator` is a name like `git-branches`. When the prefix starts with `-`, only options are offered; otherwise subcommands, plus a generator marker if the matched node declares one.

- [ ] **Step 1: Write the failing test**

Create `test/schema.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { schemaCandidates } from '../src/schema.mjs';
import { SCHEMAS } from '../src/schemas/index.mjs';

const git = {
  name: 'git',
  subcommands: [
    {
      name: 'checkout',
      args: { generator: 'git-branches' },
      options: [
        { name: '-b', description: 'create a new branch' },
        { name: '--force', description: 'throw away local changes' }
      ]
    },
    { name: 'commit', options: [{ name: '-m', description: 'message' }] },
    { name: 'cherry-pick' }
  ],
  options: [{ name: '--version', description: 'print the version' }]
};

const values = (list) => list.map((c) => c.value);

test('the subcommands are offered after the command name', () => {
  assert.deepEqual(values(schemaCandidates(git, ['git'], '')), [
    'checkout',
    'commit',
    'cherry-pick'
  ]);
});

// Filtering here is only about which node of the schema applies. Ranking the
// survivors is rank.mjs's job, so everything plausible is handed on.
test('a prefix narrows the subcommands offered', () => {
  assert.deepEqual(values(schemaCandidates(git, ['git'], 'ch')), [
    'checkout',
    'cherry-pick'
  ]);
});

test('a subcommand brings its own options', () => {
  assert.deepEqual(values(schemaCandidates(git, ['git', 'checkout'], '-')), [
    '-b',
    '--force'
  ]);
});

test('a description travels with the option, for the list to show', () => {
  const [b] = schemaCandidates(git, ['git', 'checkout'], '-b');
  assert.equal(b.value, '-b');
  assert.equal(b.description, 'create a new branch');
  assert.equal(b.source, 'schema');
});

test('the top-level options are offered against the bare command', () => {
  assert.deepEqual(values(schemaCandidates(git, ['git'], '--')), ['--version']);
});

// A flag prefix means flags. Offering `checkout` for `git -` would be noise.
test('a dash asks for options only, never subcommands', () => {
  const list = schemaCandidates(git, ['git', 'commit'], '-');
  assert.deepEqual(values(list), ['-m']);
});

// The generator is a NAME. Resolving it means running something, which
// happens in the main process against a fixed table — never from this file,
// and never as code out of the JSON.
test('a node that takes dynamic values names its generator', () => {
  const list = schemaCandidates(git, ['git', 'checkout'], '');
  const marker = list.find((c) => c.generator);
  assert.equal(marker.generator, 'git-branches');
});

test('a subcommand with nothing to add offers nothing', () => {
  assert.deepEqual(schemaCandidates(git, ['git', 'cherry-pick'], '-'), []);
});

test('a word that is in no schema node ends the walk', () => {
  assert.deepEqual(schemaCandidates(git, ['git', 'nonsense'], ''), []);
});

test('every shipped schema is walkable and names its command', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    assert.equal(schema.name, name);
    assert.doesNotThrow(() => schemaCandidates(schema, [name], ''));
  }
});

test('the shipped git schema knows checkout takes branches', () => {
  const list = schemaCandidates(SCHEMAS.git, ['git', 'checkout'], '');
  assert.ok(list.some((c) => c.generator === 'git-branches'));
});

test('the shipped npm schema knows run takes script names', () => {
  const list = schemaCandidates(SCHEMAS.npm, ['npm', 'run'], '');
  assert.ok(list.some((c) => c.generator === 'npm-scripts'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/schema.test.mjs`
Expected: FAIL — `Cannot find module '../src/schema.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `src/schema.mjs`:

```javascript
// What a CLI can be asked to do next, according to a hand-written schema.
//
// Pure, like railReorder.mjs: a schema object, the words already on the line
// and the prefix being typed go in; candidates come out. Nothing here reads a
// disk or runs a command.
//
// `args.generator` is the reason this stays pure. A node that takes live
// values — the branches `git checkout` accepts, the scripts `npm run`
// accepts — names a generator rather than carrying code for one, and the name
// is looked up in a fixed table in the main process. That is the whole
// argument for hand-writing these instead of adopting Fig's ~600-CLI spec
// repository: Fig's generators are executable TypeScript, and running spec
// code safely is a subsystem of its own.

function matches(name, prefix) {
  return prefix === '' || name.startsWith(prefix);
}

// Follow the words down the schema. `git checkout` lands on the checkout
// node; a word belonging to no node ends the walk, because past that point
// nothing in the schema describes what is being typed.
function walk(schema, words) {
  let node = schema;
  for (const word of words.slice(1)) {
    const next = node.subcommands?.find((s) => s.name === word);
    if (!next) return null;
    node = next;
  }
  return node;
}

export function schemaCandidates(schema, words, prefix) {
  const node = walk(schema, words);
  if (!node) return [];

  const option = (o) => ({
    value: o.name,
    description: o.description ?? '',
    source: 'schema'
  });

  // A prefix that opens with a dash is asking for flags, so offering
  // subcommands alongside them would only be noise.
  if (prefix.startsWith('-')) {
    return (node.options ?? []).filter((o) => matches(o.name, prefix)).map(option);
  }

  const subcommands = (node.subcommands ?? [])
    .filter((s) => matches(s.name, prefix))
    .map((s) => ({
      value: s.name,
      description: s.description ?? '',
      source: 'schema'
    }));

  // The marker carries no value of its own: it tells the caller which
  // generator to resolve for this node, and is dropped once it has.
  const generator = node.args?.generator;
  return generator
    ? [...subcommands, { value: '', description: '', source: 'schema', generator }]
    : subcommands;
}
```

Create `src/schemas/git.json`:

```json
{
  "name": "git",
  "subcommands": [
    { "name": "status", "description": "what has changed" },
    { "name": "add", "args": { "generator": "files" },
      "options": [{ "name": "-p", "description": "stage hunk by hunk" },
                  { "name": "-A", "description": "stage everything" }] },
    { "name": "commit",
      "options": [{ "name": "-m", "description": "message" },
                  { "name": "--amend", "description": "redo the last commit" },
                  { "name": "--no-verify", "description": "skip the hooks" }] },
    { "name": "checkout", "args": { "generator": "git-branches" },
      "options": [{ "name": "-b", "description": "create a new branch" },
                  { "name": "--force", "description": "throw away local changes" }] },
    { "name": "switch", "args": { "generator": "git-branches" },
      "options": [{ "name": "-c", "description": "create a new branch" }] },
    { "name": "branch", "args": { "generator": "git-branches" },
      "options": [{ "name": "-d", "description": "delete a merged branch" },
                  { "name": "-D", "description": "delete it regardless" },
                  { "name": "-a", "description": "list remote branches too" }] },
    { "name": "merge", "args": { "generator": "git-branches" } },
    { "name": "rebase", "args": { "generator": "git-branches" },
      "options": [{ "name": "-i", "description": "pick the commits by hand" },
                  { "name": "--abort", "description": "give up and go back" },
                  { "name": "--continue", "description": "carry on after a fix" }] },
    { "name": "pull", "options": [{ "name": "--rebase", "description": "rebase instead of merging" }] },
    { "name": "push",
      "options": [{ "name": "-u", "description": "set the upstream" },
                  { "name": "--force-with-lease", "description": "force, but not over someone else's work" }] },
    { "name": "log",
      "options": [{ "name": "--oneline", "description": "one line per commit" },
                  { "name": "--graph", "description": "draw the branches" }] },
    { "name": "diff", "options": [{ "name": "--staged", "description": "what is about to be committed" }] },
    { "name": "stash", "subcommands": [{ "name": "pop" }, { "name": "list" }, { "name": "drop" }] },
    { "name": "restore", "args": { "generator": "files" } },
    { "name": "reset", "options": [{ "name": "--hard", "description": "throw away local changes" }] },
    { "name": "cherry-pick" },
    { "name": "fetch", "options": [{ "name": "--all", "description": "every remote" }] },
    { "name": "worktree", "subcommands": [{ "name": "add" }, { "name": "list" }, { "name": "remove" }] },
    { "name": "clone" },
    { "name": "remote", "subcommands": [{ "name": "-v" }, { "name": "add" }, { "name": "remove" }] }
  ],
  "options": [{ "name": "--version", "description": "print the version" }]
}
```

Create `src/schemas/npm.json`:

```json
{
  "name": "npm",
  "subcommands": [
    { "name": "run", "args": { "generator": "npm-scripts" } },
    { "name": "install",
      "options": [{ "name": "-D", "description": "a development dependency" },
                  { "name": "-g", "description": "install it globally" },
                  { "name": "--save-exact", "description": "pin the version" }] },
    { "name": "uninstall" },
    { "name": "test" },
    { "name": "start" },
    { "name": "publish", "options": [{ "name": "--dry-run", "description": "say what would happen" }] },
    { "name": "version", "subcommands": [{ "name": "patch" }, { "name": "minor" }, { "name": "major" }] },
    { "name": "ci" },
    { "name": "outdated" },
    { "name": "audit", "options": [{ "name": "fix", "description": "apply what it can" }] }
  ]
}
```

Create `src/schemas/docker.json`:

```json
{
  "name": "docker",
  "subcommands": [
    { "name": "ps", "options": [{ "name": "-a", "description": "stopped ones too" }] },
    { "name": "images" },
    { "name": "build",
      "options": [{ "name": "-t", "description": "tag the image" },
                  { "name": "--no-cache", "description": "build every layer again" }] },
    { "name": "run",
      "options": [{ "name": "-it", "description": "interactive, with a terminal" },
                  { "name": "-d", "description": "in the background" },
                  { "name": "--rm", "description": "clean up on exit" },
                  { "name": "-p", "description": "publish a port" }] },
    { "name": "exec", "options": [{ "name": "-it", "description": "interactive, with a terminal" }] },
    { "name": "logs", "options": [{ "name": "-f", "description": "keep following" }] },
    { "name": "stop" },
    { "name": "rm" },
    { "name": "rmi" },
    { "name": "compose",
      "subcommands": [{ "name": "up", "options": [{ "name": "-d", "description": "in the background" }] },
                      { "name": "down" }, { "name": "logs" }, { "name": "ps" }, { "name": "build" }] }
  ]
}
```

Create `src/schemas/brew.json`:

```json
{
  "name": "brew",
  "subcommands": [
    { "name": "install", "options": [{ "name": "--cask", "description": "a macOS app" }] },
    { "name": "uninstall" },
    { "name": "upgrade" },
    { "name": "update" },
    { "name": "search" },
    { "name": "info" },
    { "name": "list" },
    { "name": "services", "subcommands": [{ "name": "start" }, { "name": "stop" }, { "name": "restart" }, { "name": "list" }] },
    { "name": "doctor" },
    { "name": "cleanup" }
  ]
}
```

Create `src/schemas/ssh.json`:

```json
{
  "name": "ssh",
  "args": { "generator": "ssh-hosts" },
  "options": [
    { "name": "-p", "description": "port" },
    { "name": "-i", "description": "identity file" },
    { "name": "-L", "description": "forward a local port" },
    { "name": "-A", "description": "forward the agent" },
    { "name": "-v", "description": "say what it is doing" }
  ]
}
```

Create `src/schemas/kubectl.json`:

```json
{
  "name": "kubectl",
  "subcommands": [
    { "name": "get", "subcommands": [{ "name": "pods" }, { "name": "services" }, { "name": "deployments" }, { "name": "nodes" }],
      "options": [{ "name": "-A", "description": "every namespace" },
                  { "name": "-o", "description": "output format" }] },
    { "name": "describe", "subcommands": [{ "name": "pod" }, { "name": "service" }, { "name": "deployment" }] },
    { "name": "logs", "options": [{ "name": "-f", "description": "keep following" }] },
    { "name": "apply", "options": [{ "name": "-f", "description": "from a file" }] },
    { "name": "delete", "options": [{ "name": "-f", "description": "from a file" }] },
    { "name": "exec", "options": [{ "name": "-it", "description": "interactive, with a terminal" }] },
    { "name": "config", "subcommands": [{ "name": "use-context" }, { "name": "get-contexts" }, { "name": "current-context" }] }
  ]
}
```

Create `src/schemas/cd.json`:

```json
{
  "name": "cd",
  "args": { "generator": "directories" }
}
```

Create `src/schemas/index.mjs`:

```javascript
// The CLIs Mesa knows the shape of.
//
// Hand-written and deliberately few. Everything outside this set still
// completes from history, from the files in the working directory and from
// PATH, so the cost of not being here is small — while the cost of adopting a
// large third-party spec repository would be running its spec code.
//
// Adding one is a JSON file and a line here.

import brew from './brew.json' with { type: 'json' };
import cd from './cd.json' with { type: 'json' };
import docker from './docker.json' with { type: 'json' };
import git from './git.json' with { type: 'json' };
import kubectl from './kubectl.json' with { type: 'json' };
import npm from './npm.json' with { type: 'json' };
import ssh from './ssh.json' with { type: 'json' };

export const SCHEMAS = { brew, cd, docker, git, kubectl, npm, ssh };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/schema.test.mjs`
Expected: PASS, 12 tests

If the JSON import assertion syntax is rejected by the installed Node version, check with `node -e "console.log(process.version)"`. `with { type: 'json' }` needs Node 20.10+; on an older version use `import { createRequire } from 'node:module'` and `createRequire(import.meta.url)('./git.json')` instead, and note that Vite handles both.

- [ ] **Step 5: Commit**

```bash
git add src/schema.mjs src/schemas test/schema.test.mjs
git commit -m "Describe the shape of the commands worth knowing"
```

---

### Task 6: Rank the candidates

Merge every source into one ordered list. This is what decides whether the dropdown feels sharp or random.

**Files:**
- Create: `src/rank.mjs`
- Test: `test/rank.test.mjs`

**Interfaces:**
- Consumes: candidate objects from Tasks 5, 7 and 8 — `{ value, description, source, recency? }` where `source` is `'schema' | 'history' | 'file' | 'path'`.
- Produces: `rankCandidates(candidates, prefix, limit = 8) -> Array<candidate>`.

- [ ] **Step 1: Write the failing test**

Create `test/rank.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { rankCandidates } from '../src/rank.mjs';

const c = (value, source = 'history', extra = {}) => ({
  value,
  description: '',
  source,
  ...extra
});

const values = (list) => list.map((x) => x.value);

test('what does not match at all is dropped', () => {
  const list = rankCandidates([c('git status'), c('npm test')], 'git');
  assert.deepEqual(values(list), ['git status']);
});

test('an exact prefix beats a match in the middle', () => {
  const list = rankCandidates([c('ungit'), c('git status')], 'git');
  assert.deepEqual(values(list), ['git status', 'ungit']);
});

// Typing lowercase and getting the capitalised thing is the common case, so
// case-insensitive matches count — they just rank below exact ones.
test('case is honoured but not required', () => {
  const list = rankCandidates([c('Makefile'), c('makefile'), c('mise.toml')], 'ma');
  assert.deepEqual(values(list).slice(0, 2), ['makefile', 'Makefile']);
});

// The whole point of a fuzzy match: `gco` should find `git checkout`.
test('scattered letters match, below the solid prefixes', () => {
  const list = rankCandidates([c('git checkout'), c('grep -c out')], 'gco');
  assert.deepEqual(values(list), ['git checkout', 'grep -c out']);
});

test('letters in the wrong order do not match', () => {
  assert.deepEqual(rankCandidates([c('git checkout')], 'ogc'), []);
});

test('an empty prefix keeps everything, in source order', () => {
  const list = rankCandidates([c('b', 'history'), c('a', 'schema')], '');
  assert.deepEqual(values(list), ['a', 'b']);
});

// A schema entry is something the CLI genuinely accepts here, which is a
// stronger claim than a file that happens to share a prefix.
test('the source breaks a tie: schema, history, file, path', () => {
  const list = rankCandidates(
    [c('check', 'path'), c('check', 'file'), c('check', 'history'), c('check', 'schema')],
    'check'
  );
  assert.deepEqual(
    list.map((x) => x.source),
    ['schema', 'history', 'file', 'path']
  );
});

test('the same command from two sources is listed once, at its best rank', () => {
  const list = rankCandidates([c('git status', 'history'), c('git status', 'schema')], 'git');
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'schema');
});

// Recency is what makes history feel like it is reading your mind: the same
// two commands, and the one you ran last is on top.
test('among history entries the more recent one wins', () => {
  const list = rankCandidates(
    [c('git push', 'history', { recency: 1 }), c('git pull', 'history', { recency: 9 })],
    'git p'
  );
  assert.deepEqual(values(list), ['git pull', 'git push']);
});

test('the list is capped', () => {
  const many = Array.from({ length: 40 }, (_, i) => c(`git c${i}`));
  assert.equal(rankCandidates(many, 'git').length, 8);
  assert.equal(rankCandidates(many, 'git', 3).length, 3);
});

test('a candidate identical to what is typed is not offered', () => {
  const list = rankCandidates([c('git status'), c('git stash')], 'git status');
  assert.deepEqual(values(list), []);
});

test('an empty candidate is never offered', () => {
  assert.deepEqual(rankCandidates([c(''), c('git')], 'g'), [{ value: 'git', description: '', source: 'history' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/rank.test.mjs`
Expected: FAIL — `Cannot find module '../src/rank.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `src/rank.mjs`:

```javascript
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
function matchScore(value, prefix) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/rank.test.mjs`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/rank.mjs test/rank.test.mjs
git commit -m "Decide which candidate is worth offering first"
```

---

### Task 7: Read the command history

Parse `~/.zsh_history`, which is not a plain list of lines — zsh writes an `: <timestamp>:<elapsed>;<command>` header per entry when `EXTENDED_HISTORY` is on, and continues a multi-line command with a trailing backslash.

**Files:**
- Create: `src/zshHistory.mjs`
- Test: `test/zshHistory.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseZshHistory(text: string) -> Array<{ value: string, source: 'history', recency: number }>` — newest last in the file, so `recency` counts up with position, and the returned array is deduped keeping the most recent occurrence.

- [ ] **Step 1: Write the failing test**

Create `test/zshHistory.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseZshHistory } from '../src/zshHistory.mjs';

const values = (list) => list.map((x) => x.value);

test('a plain history file is one command per line', () => {
  assert.deepEqual(values(parseZshHistory('git status\nnpm test\n')), [
    'git status',
    'npm test'
  ]);
});

// With EXTENDED_HISTORY on, which is common, every line carries a header.
test('the extended-history header is stripped', () => {
  const text = ': 1699999999:0;git status\n: 1700000000:12;npm test\n';
  assert.deepEqual(values(parseZshHistory(text)), ['git status', 'npm test']);
});

// A semicolon inside the command must not be mistaken for the header's.
test('only the header separator is stripped, not later ones', () => {
  const text = ': 1699999999:0;cd /tmp; ls\n';
  assert.deepEqual(values(parseZshHistory(text)), ['cd /tmp; ls']);
});

// Mesa's own Shift+Enter writes these.
test('a trailing backslash continues the command onto the next line', () => {
  const text = ': 1699999999:0;echo one\\\necho two\n: 1700000000:0;ls\n';
  assert.deepEqual(values(parseZshHistory(text)), ['echo one\necho two', 'ls']);
});

test('the later a command appears, the more recent it is', () => {
  const list = parseZshHistory('old\nnew\n');
  assert.ok(list[1].recency > list[0].recency);
});

test('a repeated command is kept once, at its most recent position', () => {
  const list = parseZshHistory('git status\nnpm test\ngit status\n');
  assert.deepEqual(values(list), ['npm test', 'git status']);
});

test('blank lines and whitespace-only entries are not commands', () => {
  assert.deepEqual(values(parseZshHistory('git status\n\n   \nls\n')), [
    'git status',
    'ls'
  ]);
});

test('every entry says it came from history', () => {
  for (const entry of parseZshHistory('ls\n')) assert.equal(entry.source, 'history');
});

test('an empty file is an empty history, not a crash', () => {
  assert.deepEqual(parseZshHistory(''), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/zshHistory.test.mjs`
Expected: FAIL — `Cannot find module '../src/zshHistory.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `src/zshHistory.mjs`:

```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/zshHistory.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/zshHistory.mjs test/zshHistory.test.mjs
git commit -m "Read the commands already run out of zsh's history"
```

---

### Task 8: Gather the live candidates

Everything that needs a disk or a subprocess, in one place in the main process, behind IPC and a cache. This is the only task in the plan that does I/O.

**Files:**
- Create: `electron/completionSources.js`
- Modify: `electron/main.js` (register the IPC handler beside the existing `git:branch` one)
- Modify: `electron/preload.js` (expose it on `window.terminalApi`)

**Interfaces:**
- Consumes: `parseZshHistory` from `src/zshHistory.mjs` (Task 7).
- Produces: IPC channel `completion:candidates`, called as
  `window.terminalApi.candidates({ cwd, generator, prefix }) -> Promise<Array<{ value, description, source }>>`
  where `generator` is one of `files`, `directories`, `git-branches`, `npm-scripts`, `ssh-hosts`, `path`, `history`, or `null`.

- [ ] **Step 1: Write the source module**

Create `electron/completionSources.js`:

```javascript
// Everything a completion needs that lives outside the renderer: the files in
// a directory, the executables on PATH, the branches in a repository, the
// scripts in a package.json, the hosts in an ssh config, and the shell's own
// history.
//
// It is all here, in the main process, for two reasons. The renderer cannot
// touch a disk, and every one of these is slow enough that doing it per
// keystroke would stall the pane — so each is cached, and the cache is keyed
// by the directory the pane is actually in.
//
// A generator is chosen by NAME from the table below. Nothing in a schema
// JSON file reaches this code as a command, an argument or a path: a schema
// can only ask for a generator that already exists here.

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

const TTL_MS = 5000;
const cache = new Map();

async function cached(key, produce) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = [];
  try {
    value = await produce();
  } catch {
    // A directory that has gone, a repository that is not one, a package.json
    // that does not parse: a completion source that cannot answer offers
    // nothing. It must never take the pane down with it — the same guard the
    // git:branch handler already makes.
    value = [];
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function entries(cwd, directoriesOnly) {
  const found = await fs.readdir(cwd, { withFileTypes: true });
  return found
    .filter((e) => !e.name.startsWith('.'))
    .filter((e) => (directoriesOnly ? e.isDirectory() : true))
    .map((e) => ({
      value: e.isDirectory() ? `${e.name}/` : e.name,
      description: '',
      source: 'file'
    }));
}

async function gitBranches(cwd) {
  const { stdout } = await run(
    'git',
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
    { cwd }
  );
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((value) => ({ value, description: '', source: 'schema' }));
}

async function npmScripts(cwd) {
  const text = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
  const scripts = JSON.parse(text).scripts ?? {};
  return Object.entries(scripts).map(([value, command]) => ({
    value,
    description: command,
    source: 'schema'
  }));
}

async function sshHosts() {
  const text = await fs.readFile(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
  const hosts = [];
  for (const line of text.split('\n')) {
    const match = /^\s*Host\s+(.+)$/i.exec(line);
    if (!match) continue;
    // A pattern is not a host you can connect to.
    for (const name of match[1].split(/\s+/)) {
      if (name && !name.includes('*') && !name.includes('?')) hosts.push(name);
    }
  }
  return hosts.map((value) => ({ value, description: '', source: 'schema' }));
}

async function pathExecutables() {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = new Set();
  for (const dir of dirs) {
    let found;
    try {
      found = await fs.readdir(dir);
    } catch {
      continue; // A PATH entry that does not exist is normal, not an error.
    }
    for (const name of found) names.add(name);
  }
  return [...names].map((value) => ({ value, description: '', source: 'path' }));
}

let historyCache = null;

async function history(parseZshHistory) {
  if (historyCache) return historyCache;
  try {
    const file = process.env.HISTFILE || path.join(os.homedir(), '.zsh_history');
    // zsh writes this file in its own eight-bit metafied encoding, so a
    // stray byte is normal and must not throw. 'latin1' keeps every byte and
    // never rejects one; UTF-8 text still compares correctly against a
    // prefix that came through the same door.
    const text = await fs.readFile(file, 'latin1');
    historyCache = parseZshHistory(text);
  } catch {
    historyCache = [];
  }
  return historyCache;
}

// The whole table. A generator name that is not a key here resolves to
// nothing, which is what keeps a schema from reaching anything it likes.
function generators(parseZshHistory) {
  return {
    files: (cwd) => cached(`files:${cwd}`, () => entries(cwd, false)),
    directories: (cwd) => cached(`dirs:${cwd}`, () => entries(cwd, true)),
    'git-branches': (cwd) => cached(`branches:${cwd}`, () => gitBranches(cwd)),
    'npm-scripts': (cwd) => cached(`scripts:${cwd}`, () => npmScripts(cwd)),
    'ssh-hosts': () => cached('ssh', () => sshHosts()),
    path: () => cached('path', () => pathExecutables()),
    history: () => history(parseZshHistory)
  };
}

module.exports = { generators };
```

- [ ] **Step 2: Register the IPC handler**

In `electron/main.js`, beside the existing `git:branch` handler:

```javascript
const { generators } = require('./completionSources');
const { parseZshHistory } = require('../src/zshHistory.mjs');

const completionGenerators = generators(parseZshHistory);

ipcMain.handle('completion:candidates', async (_event, { cwd, generator }) => {
  const produce = completionGenerators[generator];
  if (!produce) return [];
  return produce(resolveCwd(cwd));
});
```

`electron/main.js` is CommonJS and `src/zshHistory.mjs` is an ES module, so a plain `require` of it will fail. Load it with a dynamic import at startup instead:

```javascript
let parseZshHistory = () => [];
import('../src/zshHistory.mjs').then((m) => {
  parseZshHistory = m.parseZshHistory;
});
```

and have the `history` generator call through the binding rather than capturing it.

- [ ] **Step 3: Expose it on the preload bridge**

In `electron/preload.js`, add to the `terminalApi` object:

```javascript
  candidates: (request) => ipcRenderer.invoke('completion:candidates', request),
```

- [ ] **Step 4: Verify by hand**

Run `npm run dev`, open the renderer devtools console in a pane sitting in the Mesa repo:

```javascript
await window.terminalApi.candidates({ cwd: '/Users/onurkacmaz/Desktop/mesa', generator: 'npm-scripts' })
await window.terminalApi.candidates({ cwd: '/Users/onurkacmaz/Desktop/mesa', generator: 'git-branches' })
await window.terminalApi.candidates({ cwd: '/nonexistent', generator: 'files' })
await window.terminalApi.candidates({ cwd: '/tmp', generator: 'made-up' })
```

Expected: the repo's npm scripts with their command lines as descriptions; its branches; `[]` for the missing directory; `[]` for the unknown generator. Neither of the last two may throw or log an error.

- [ ] **Step 5: Commit**

```bash
git add electron/completionSources.js electron/main.js electron/preload.js
git commit -m "Gather what a completion needs from disk, once and cached"
```

---

### Task 9: Place the list

Where the dropdown sits, and — the part that is a design hole rather than a detail — which way it opens. The prompt is at the bottom of the scrollback in the steady state, so a list drawn downward would fall outside the pane and be clipped.

**Files:**
- Create: `src/dropdownPlacement.mjs`
- Test: `test/dropdownPlacement.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `dropdownPlacement({ cursorRow, termRows, count, max = 8 }) -> { direction: 'down' | 'up', row: number, rows: number }` where `row` is the first terminal row the list occupies.

- [ ] **Step 1: Write the failing test**

Create `test/dropdownPlacement.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { dropdownPlacement } from '../src/dropdownPlacement.mjs';

test('with room below, the list opens downward under the cursor', () => {
  assert.deepEqual(dropdownPlacement({ cursorRow: 2, termRows: 40, count: 5 }), {
    direction: 'down',
    row: 3,
    rows: 5
  });
});

// The steady state: the prompt is the last row of the pane. A list drawn
// downward here would be entirely outside it.
test('at the bottom of the pane the list flips above the cursor', () => {
  assert.deepEqual(dropdownPlacement({ cursorRow: 39, termRows: 40, count: 5 }), {
    direction: 'up',
    row: 34,
    rows: 5
  });
});

test('it flips as soon as the rows below will not hold it whole', () => {
  // 4 rows below the cursor, 5 wanted.
  assert.equal(dropdownPlacement({ cursorRow: 35, termRows: 40, count: 5 }).direction, 'up');
  // 5 rows below, 5 wanted: it still fits.
  assert.equal(dropdownPlacement({ cursorRow: 34, termRows: 40, count: 5 }).direction, 'down');
});

test('the list never grows past the cap', () => {
  assert.equal(dropdownPlacement({ cursorRow: 0, termRows: 40, count: 30 }).rows, 8);
  assert.equal(dropdownPlacement({ cursorRow: 0, termRows: 40, count: 30, max: 3 }).rows, 3);
});

// Half a row hanging off the pane edge reads as broken, so the list shrinks
// to what the side it opens on can actually hold.
test('in a short pane it shrinks rather than being cut off', () => {
  const placed = dropdownPlacement({ cursorRow: 4, termRows: 6, count: 8 });
  assert.equal(placed.direction, 'up');
  assert.equal(placed.rows, 4);
  assert.equal(placed.row, 0);
});

test('it takes the roomier side when neither can hold it whole', () => {
  // 2 rows above, 3 below.
  assert.equal(dropdownPlacement({ cursorRow: 2, termRows: 6, count: 8 }).direction, 'down');
});

test('a pane with no room at all asks for no rows', () => {
  assert.deepEqual(dropdownPlacement({ cursorRow: 0, termRows: 1, count: 5 }), {
    direction: 'down',
    row: 1,
    rows: 0
  });
});

test('nothing to show is no rows, whatever the room', () => {
  assert.equal(dropdownPlacement({ cursorRow: 2, termRows: 40, count: 0 }).rows, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/dropdownPlacement.test.mjs`
Expected: FAIL — `Cannot find module '../src/dropdownPlacement.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `src/dropdownPlacement.mjs`:

```javascript
// Which way the completion list opens, and how tall it is.
//
// Pure, like railReorder.mjs: row counts in, a placement out. Nothing here
// knows about the DOM.
//
// The rule exists because the prompt is normally the LAST row of the pane,
// not a row somewhere in the middle. A list that always opened downward would
// therefore be drawn outside the pane and clipped away in the ordinary case,
// which is the case that matters. So it opens downward only while the rows
// below can hold it whole, and flips above the cursor otherwise.
//
// When neither side can hold it, it shrinks to fit the roomier one rather
// than being cut off at the pane edge. A half-drawn row reads as broken.

export function dropdownPlacement({ cursorRow, termRows, count, max = 8 }) {
  const wanted = Math.min(count, max);
  const below = termRows - cursorRow - 1;
  const above = cursorRow;

  if (wanted <= below) return { direction: 'down', row: cursorRow + 1, rows: wanted };
  if (wanted <= above) return { direction: 'up', row: cursorRow - wanted, rows: wanted };

  if (below >= above) return { direction: 'down', row: cursorRow + 1, rows: below };
  return { direction: 'up', row: cursorRow - above, rows: above };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/dropdownPlacement.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/dropdownPlacement.mjs test/dropdownPlacement.test.mjs
git commit -m "Open the list the way the pane has room for"
```

---

### Task 10: Build the keystrokes that accept a candidate

Replacing the line, not appending to it — and doing so without typing a control character into a vi-mode user's buffer or submitting a multi-line command halfway through.

**Files:**
- Create: `src/acceptCandidate.mjs`
- Test: `test/acceptCandidate.test.mjs`

**Interfaces:**
- Consumes: `completionContext`'s `start` (Task 4).
- Produces: `acceptSequence({ buffer, start, value }) -> string` — the exact bytes to send to the pty.

- [ ] **Step 1: Write the failing test**

Create `test/acceptCandidate.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { acceptSequence } from '../src/acceptCandidate.mjs';

// ^E then ^U: end of line, then kill it. Both keymaps end up with an empty
// line, so the whole replacement can simply be typed after them.
const CLEAR = '\x05\x15';

test('the line is cleared and retyped, never appended to', () => {
  assert.equal(
    acceptSequence({ buffer: 'git ch', start: 4, value: 'checkout' }),
    `${CLEAR}git checkout`
  );
});

test('what is right of the completed word is kept', () => {
  assert.equal(
    acceptSequence({ buffer: 'git ch main', start: 4, value: 'checkout' }),
    `${CLEAR}git checkout main`
  );
});

test('completing the command itself replaces the whole line', () => {
  assert.equal(
    acceptSequence({ buffer: 'gi', start: 0, value: 'git status' }),
    `${CLEAR}git status`
  );
});

test('an empty prefix inserts at the cursor', () => {
  assert.equal(
    acceptSequence({ buffer: 'git ', start: 4, value: 'status' }),
    `${CLEAR}git status`
  );
});

// A raw newline would run the command at the first line break — half a
// command. \x1b\r is the sequence the Shift+Enter widget already binds to
// insert a newline without submitting, so a multi-line entry comes back whole.
test('a multi-line candidate uses the newline that does not submit', () => {
  assert.equal(
    acceptSequence({ buffer: 'ec', start: 0, value: 'echo one\necho two' }),
    `${CLEAR}echo one\x1b\recho two`
  );
});

test('a carriage return in a candidate is treated the same way', () => {
  assert.equal(
    acceptSequence({ buffer: 'ec', start: 0, value: 'a\r\nb' }),
    `${CLEAR}a\x1b\rb`
  );
});

test('the replacement is never submitted on its own', () => {
  const sent = acceptSequence({ buffer: 'gi', start: 0, value: 'git status' });
  assert.ok(!sent.endsWith('\r'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/acceptCandidate.test.mjs`
Expected: FAIL — `Cannot find module '../src/acceptCandidate.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `src/acceptCandidate.mjs`:

```javascript
// The bytes that put a chosen candidate onto the shell's line.
//
// Pure, like railReorder.mjs: the line, where the completed word starts and
// the chosen text go in; what to send to the pty comes out.
//
// The line is cleared and retyped rather than patched, because the app cannot
// move ZLE's cursor around reliably enough to edit in place — but the two
// keys that clear it were not free to choose. ^K was the obvious pick and is
// wrong: in the viins keymap it is self-insert, so a vi-mode user would get a
// literal control character typed into their line. ^E then ^U empties the
// line in BOTH keymaps — in viins, ^U is vi-kill-line, which kills backwards
// from the cursor, and ^E has already moved the cursor to the end. ^E itself
// only works in viins because the key table in the shell hook binds it there.
const CLEAR_LINE = '\x05\x15';

// A raw newline inside a candidate would submit the command at the first line
// break and run half of it. This is the sequence the Shift+Enter widget in
// the shell hook binds to insert a newline into the line buffer without
// submitting, so a multi-line history entry is reproduced intact.
const SOFT_NEWLINE = '\x1b\r';

export function acceptSequence({ buffer, start, value }) {
  const before = buffer.slice(0, start);
  // The prefix runs from `start` to wherever the completed word ends; what
  // follows it on the line belongs to the line and is kept.
  const rest = buffer.slice(start).replace(/^\S*/, '');
  const line = `${before}${value}${rest}`;
  return CLEAR_LINE + line.replace(/\r\n|\r|\n/g, SOFT_NEWLINE);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/acceptCandidate.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/acceptCandidate.mjs test/acceptCandidate.test.mjs
git commit -m "Put a chosen candidate on the line without submitting it"
```

---

### Task 11: Draw the list and wire the keys

The one React task. Everything it needs is already built and tested; this assembles it, owns the four keys the dropdown claims, and leaves Tab alone.

**Files:**
- Create: `src/CompletionList.jsx`
- Modify: `src/TerminalView.jsx` (consume `onLineChange` from Task 3, render the list, extend `attachCustomKeyEventHandler` at line 159)
- Modify: `src/styles.css` (append the list's styles)

**Interfaces:**
- Consumes: `completionContext` (Task 4), `SCHEMAS` and `schemaCandidates` (Task 5), `rankCandidates` (Task 6), `window.terminalApi.candidates` (Task 8), `dropdownPlacement` (Task 9), `acceptSequence` (Task 10).
- Produces: nothing further.

- [ ] **Step 1: Write the list component**

Create `src/CompletionList.jsx`:

```jsx
// The completion list, drawn inside the pane.
//
// Inside is the whole point. Panes live in one transform: translate() scale()
// layer, so a list positioned in viewport coordinates would drift and
// mis-scale at every zoom but 100% — the same trap the mouse-selection code
// in TerminalView.jsx had to be corrected for. Positioned in terminal rows
// and columns inside the pane, it scales with the canvas for free and needs
// no correction maths at all.

import { dropdownPlacement } from './dropdownPlacement.mjs';

export default function CompletionList({
  items,
  selected,
  cursorRow,
  cursorCol,
  termRows,
  cellWidth,
  cellHeight,
  onPick
}) {
  if (items.length === 0) return null;

  const placed = dropdownPlacement({ cursorRow, termRows, count: items.length });
  if (placed.rows === 0) return null;

  // Only the rows that fit are drawn, and the selected one is always among
  // them: a selection scrolled out of view reads as the list being stuck.
  const first = Math.max(0, Math.min(selected - placed.rows + 1, items.length - placed.rows));
  const visible = items.slice(first, first + placed.rows);

  return (
    <div
      className="completion-list"
      style={{
        left: `${cursorCol * cellWidth}px`,
        top: `${placed.row * cellHeight}px`
      }}
    >
      {visible.map((item, i) => (
        <button
          key={item.value}
          type="button"
          className={
            first + i === selected ? 'completion-row completion-row-on' : 'completion-row'
          }
          // The pane must not lose focus to the list, or the next keystroke
          // goes nowhere.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(first + i);
          }}
        >
          <span className="completion-value">{item.value}</span>
          {item.description ? (
            <span className="completion-description">{item.description}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Add the styles**

Append to `src/styles.css`. The precedent is `.pane-menu` (around line 1235), not `.cr-menu` — the comment above `.pane-menu` says why in as many words: `.cr-menu` is the browser pane's Chrome-imitating furniture, down to its 8px radius, and borrowing it would put Chrome's chrome on Mesa's own panes. So: square, the pane's frame and border, one directional shadow.

```css
/* The completion list, drawn in the pane's own coordinates so it rides the
   canvas transform with everything else. Mesa's own surface, like .pane-menu:
   square, the pane's frame and border, one directional shadow. */
.completion-list {
  position: absolute;
  z-index: 9400;
  display: flex;
  flex-direction: column;
  min-width: 18ch;
  max-width: 62ch;
  overflow: hidden;
  background: var(--pane-frame);
  border: 1px solid var(--pane-border);
  box-shadow: var(--shadow-rail);
}

.completion-row {
  appearance: none;
  display: flex;
  gap: 1.5ch;
  align-items: baseline;
  justify-content: space-between;
  width: 100%;
  padding: 2px 8px;
  border: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: default;
}

.completion-row-on {
  background: var(--hover);
  color: var(--text-strong);
}

.completion-value {
  white-space: pre;
}

/* What the candidate is for, not what it is: it must never compete with the
   command itself for the eye. */
.completion-description {
  overflow: hidden;
  color: var(--text-dim);
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Every colour here is one of the variables the pane chrome already uses, which is what makes the list re-tint with the light and dark themes for free — all of `--pane-frame`, `--pane-border`, `--shadow-rail`, `--text`, `--text-strong`, `--text-dim` and `--hover` are defined for both. No literal colour is introduced.

- [ ] **Step 3: Gather candidates when the line changes**

In `src/TerminalView.jsx`, add state and an effect driven by the `onLineChange` wired in Task 3:

```javascript
  const [completion, setCompletion] = useState(null);

  const onLineChange = useCallback((line) => {
    if (!line) {
      setCompletion(null);
      return;
    }
    const context = completionContext(line.buffer, line.cursor);
    let cancelled = false;

    (async () => {
      const schema = SCHEMAS[context.words[0]];
      const fromSchema = schema
        ? schemaCandidates(schema, context.words, context.prefix)
        : [];

      // A schema node that names a generator is asking for live values. The
      // marker itself is never shown — rankCandidates drops it, having no
      // value — and is replaced by what the generator returns.
      const generator = fromSchema.find((c) => c.generator)?.generator;
      const wanted = [
        { generator: 'history' },
        { generator: context.position === 'command' ? 'path' : 'files' },
        ...(generator ? [{ generator }] : [])
      ];

      const live = (
        await Promise.all(
          wanted.map((w) =>
            window.terminalApi.candidates({ cwd: getPaneCwd(tabId), generator: w.generator })
          )
        )
      ).flat();

      if (cancelled) return;
      const items = rankCandidates([...fromSchema, ...live], context.prefix);
      setCompletion(items.length ? { items, context, line, selected: 0 } : null);
    })();

    return () => {
      cancelled = true;
    };
  }, []);
```

The working directory comes from `getPaneCwd(tabId)` in `src/paneCwd.js`, which the OSC 7 handler already keeps current for every pane. Import it — do not add a second source for the same fact, and do not invent a ref: the registry is the established pattern here, the same shape as `paneGeometry` and `paneTitles`.

- [ ] **Step 4: Own the four keys**

Extend the existing `attachCustomKeyEventHandler` at `src/TerminalView.jsx:159`, **before** the `MAC_LINE_EDITING` lookup:

```javascript
      // The completion list claims four keys, and only while it is open.
      //
      // Tab is deliberately not among them, open or closed. zsh users lean on
      // compsys and their own plugins, and Mesa does not own the line the way
      // Warp does — shadowing the shell's own completion would be a
      // regression for exactly the people most likely to notice.
      //
      // The arrows are claimed only while the list is open, because with it
      // closed Up is history recall and taking that would break something
      // basic.
      const open = completionRef.current;
      if (open && !event.metaKey && !event.altKey && !event.ctrlKey) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          const count = open.items.length;
          setCompletion((c) =>
            c ? { ...c, selected: (c.selected + step + count) % count } : c
          );
          return false;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          acceptCompletion(open, open.selected);
          return false;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setCompletion(null);
          return false;
        }
      }
```

`completionRef` mirrors `completion` the way `scaleRef` mirrors `scale` — the handler is registered once at mount and must not read a stale value.

And the accept itself:

```javascript
  const acceptCompletion = (open, index) => {
    const item = open.items[index];
    if (!item) return;
    window.terminalApi.input(
      tabId,
      acceptSequence({
        buffer: open.line.buffer,
        start: open.context.start,
        value: item.value
      })
    );
    setCompletion(null);
  };
```

- [ ] **Step 5: Render it**

Inside the pane's terminal container, beside the existing overlays:

```jsx
      {completion ? (
        <CompletionList
          items={completion.items}
          selected={completion.selected}
          cursorRow={termRef.current.buffer.active.cursorY}
          cursorCol={termRef.current.buffer.active.cursorX}
          termRows={termRef.current.rows}
          cellWidth={termRef.current._core._renderService.dimensions.css.cell.width}
          cellHeight={termRef.current._core._renderService.dimensions.css.cell.height}
          onPick={(i) => acceptCompletion(completion, i)}
        />
      ) : null}
```

The cell dimensions come from xterm's internals because there is no public accessor for them. If that path is missing on the installed version, check `node_modules/@xterm/xterm/typings/xterm.d.ts` and measure a cell from the rendered DOM instead rather than guessing at a size — a mis-measured cell puts the list in the wrong place at every zoom.

- [ ] **Step 6: Verify by hand**

Run `npm run dev` and, in a terminal pane:

- type `gi` — a list opens under the cursor with `git` commands
- type `git ch` — `checkout` and `cherry-pick` are offered
- type `git checkout ` — real branch names from this repository appear
- type `npm run ` — this repo's scripts appear, with their command lines beside them
- press ↓ then Enter — the line is replaced, not appended to, and does **not** run
- press ↑ with the list closed — the shell recalls the previous command as it always did
- press **Tab** — zsh's own completion runs, unchanged
- press Escape — the list closes and the line is untouched
- scroll the pane so the prompt sits at the very bottom — the list opens **upward**, fully inside the pane
- zoom the canvas to ~50% and ~150% — the list stays attached to the cursor and scales with the pane
- run `htop` — no list appears at all; quit it and the list works again

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS — every test from Tasks 1, 4, 5, 6, 7, 9 and 10, plus the pre-existing suite.

- [ ] **Step 8: Commit**

```bash
git add src/CompletionList.jsx src/TerminalView.jsx src/styles.css
git commit -m "Offer the list, and leave Tab to the shell"
```

---

## Verification

After Task 11, the feature is complete. Confirm against the spec:

- [ ] `npm test` passes
- [ ] The dropdown never opens in a non-zsh shell, and nothing errors
- [ ] Tab reaches zsh in every state
- [ ] ↑ with the list closed is still history recall
- [ ] The list flips above the cursor at the bottom of a pane and is never clipped
- [ ] Accepting a multi-line history entry reproduces it whole without running it
- [ ] `~/.zsh_history` is unmodified: `ls -l ~/.zsh_history` before and after a session shows the same size and mtime unless a command was actually run
- [ ] `zsh-autosuggestions` and `zsh-syntax-highlighting`, if installed, still work
