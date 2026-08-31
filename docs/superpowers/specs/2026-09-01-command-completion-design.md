# Inline command completion

A dropdown that opens under the cursor as you type at the shell prompt,
listing candidate commands: past commands, files in the current directory,
executables on PATH, and hand-written subcommand/flag schemas for a small set
of CLIs. Arrow keys select, Enter accepts, Escape dismisses. Tab is never
taken.

## The problem this design solves first

Warp can show a list of what you are typing because Warp does not run the
shell's line editor. It replaces the input line with its own text editor and
therefore always knows the exact contents of the line.

Mesa runs real zsh. ZLE owns the line — every keystroke goes straight through
`term.onData` to the pty (`src/TerminalView.jsx`). Nothing in the renderer
knows what is on the input line.

So the first question is not what the dropdown looks like. It is: **where does
"what is currently typed" come from?** Everything else is downstream of that
answer, and a wrong answer here makes the rest worthless.

### Rejected: a shadow buffer in the renderer

Accumulate keystrokes in `attachCustomKeyEventHandler` since the last OSC 133
`A` marker. Cheap, shell-agnostic, and wrong. It desyncs silently on:

- history recall (up-arrow)
- paste
- zsh's own Tab completion
- `zsh-autosuggestions` accepting a suggestion
- `^W` / `^U`, which Mesa itself sends from `MAC_LINE_EDITING`
- vi-mode motions
- multi-line input via the existing Shift+Enter widget

A dropdown built on a buffer that lies is worse than no dropdown. Rejected.

### Chosen: ask ZLE

zsh fires a hook on every line-editor redraw, where `$BUFFER` and `$CURSOR`
are readable. This is the same hook `zsh-autosuggestions` is built on, so it
is a proven path. Emit the buffer as a private OSC sequence and read it in the
renderer beside the OSC 7/4/10/11/133 handlers that already exist.

Verified on zsh 5.9 (the version macOS ships) under a real pty: the hook fires
per keystroke and reports the buffer correctly, including after history
recall.

## Architecture

```
zsh (ZLE)                    main process              renderer
─────────                    ────────────              ────────
line-pre-redraw hook
  emits OSC 1717  ──pty──▶   passthrough      ──IPC──▶ registerOscHandler(1717)
                                                              │
                                                       zleBuffer.mjs (decode)
                                                              │
                                                       commandLine.mjs (tokenize)
                                                              │
                    ┌─────────────────────────────────────────┤
                    ▼                                         ▼
            completionSources.mjs                       schema.mjs
            (main, all I/O, cached)                     (pure, JSON schemas)
                    │                                         │
                    └──────────────────▶ rank.mjs ◀───────────┘
                                            │
                                     dropdown overlay
                                     (inside the pane,
                                      inside the canvas transform)
                                            │
                                     accept: ^E ^U + text ──▶ pty
```

## The buffer feed

Added to `electron/shell-hooks/zsh/.zshenv`, symmetric with the `add-zsh-hook`
calls already there:

```zsh
autoload -Uz add-zle-hook-widget
__mesa_zle_sync() {
  [[ $BUFFER == $__mesa_last ]] && return
  __mesa_last=$BUFFER
  printf '\e]1717;L;%d;%s\a' "$CURSOR" "${(V)BUFFER}"
}
add-zle-hook-widget line-pre-redraw __mesa_zle_sync
```

Three decisions worth keeping:

**`add-zle-hook-widget`, not `zle -N` on the hook name.** Defining
`zle-line-pre-redraw` directly clobbers whatever else claims it, which breaks
`zsh-autosuggestions` and `zsh-syntax-highlighting`. The whole hook file is
built on "nothing the user's config does is overwritten"; this follows it.

**`${(V)BUFFER}`, not base64.** `$BUFFER` can hold ESC, BEL and newlines, all
of which would corrupt the OSC sequence. zsh has no base64 builtin, so
encoding would mean a fork on every keystroke. `${(V)…}` is a parameter
expansion flag — no fork — and renders control characters printably: ESC
becomes `^[`, newline `\n`, tab `\t`.

**The buffer is the last field.** `${(V)…}` leaves `;` literal, which would
collide with the OSC field separator. Putting the buffer last costs nothing:
the renderer splits on the first two separators and takes the rest verbatim.

**The dedupe guard is not an optimisation.** `line-pre-redraw` fires on every
redraw, not every change — cursor movement and syntax highlighting repaint the
line too. Without the guard the renderer would recompute candidates for a
buffer that did not change.

## The engine

Everything below is pure and I/O-free, testable with `node --test` exactly
like `railReorder.mjs` and `session.mjs`.

| Module | Responsibility |
|---|---|
| `zleBuffer.mjs` | Decode `${(V)}` escaping back to a real string |
| `commandLine.mjs` | buffer + cursor → tokens; which token is being completed, is it in command position, is it inside quotes |
| `schema.mjs` | Walk a CLI schema: `git ch` → subcommands, `git checkout -` → flags |
| `rank.mjs` | Merge sources, fuzzy match, score, dedupe, cap |

All I/O lives in one place: `completionSources.mjs`, in the main process,
cached per working directory.

### Schema format

Hand-written JSON for roughly 8–10 CLIs (`git`, `npm`, `docker`, `brew`,
`cd`, `ssh`, `kubectl` and peers). Anything outside that set still completes
from history, files and PATH.

```json
{ "name": "git",
  "subcommands": [
    { "name": "checkout",
      "args": { "generator": "git-branches" },
      "options": [{ "name": "-b", "description": "create a new branch" }] }
  ] }
```

`generator` is a **name, not code**. It looks up a fixed table in the main
process (`git-branches` → `git for-each-ref`), and results are cached by cwd.
Nothing from a schema is ever executed.

This is why the Fig spec repository (`withfig/autocomplete`, ~600 CLIs, MIT)
was not adopted despite the coverage: its generators are executable
TypeScript, and running them safely is a subsystem of its own. Warp itself
ships hand-written specs.

### Ranking

Prefix match outranks subsequence (fuzzy) match. Ties break on source priority
— schema, then history, then files, then PATH — and within history, on
recency. The list is capped at eight rows.

### History

Read `~/.zsh_history` once at startup, then append commands run inside Mesa.
The OSC 133 `C` marker already fires when a command is submitted but does not
carry its text; the text is the last buffer OSC 1717 reported before that
marker. Read-only: the user's history file is never written to.

## The overlay

Panes live inside a single `transform: translate() scale()` layer. Positioning
the dropdown in viewport coordinates would drift at any zoom but 100% — the
"Mouse selection under the canvas's zoom" block in `src/TerminalView.jsx` is
the scar from exactly that class of bug.

So the dropdown renders **inside the pane**, next to the terminal, positioned
from `term.buffer.active.cursorX/cursorY` times the cell size. It scales with
the canvas for free, with no correction maths.

It is hard-hidden while a TUI owns the alternate buffer (`tuiRef.current`).
There is no shell line then, and the same guard already protects the OSC 133
`A` marker.

## Key ownership

`attachCustomKeyEventHandler` already exists and swallows a key by returning
`false`.

| Key | Dropdown open | Dropdown closed |
|---|---|---|
| ↑ ↓ | move selection | passes to zsh (history recall) |
| Enter | accept selection | passes to zsh |
| Escape | dismiss | passes to zsh |
| Tab | **always passes to zsh** | passes to zsh |

Tab is never taken. zsh users lean on `compsys` and their own plugins, and
unlike Warp, Mesa does not own the line — shadowing the shell's completion
would be a regression for the people most likely to notice.

## Accepting a candidate

Replace the line; do not append. Send `\x05\x15` (end-of-line, then kill) plus
the full replacement text.

`^K` was the obvious choice and is wrong: in the `viins` keymap it is
`self-insert`, so a vi-mode user would get a literal control character typed
into the line. `^E` then `^U` empties the line in both keymaps — in `viins`,
`^U` is `vi-kill-line`, which kills backwards from the cursor, and `^E` has
already moved the cursor to the end. `^E` itself works in `viins` only because
the existing gap-filling table in `.zshenv` binds it there. No new binding is
needed.

## Failure behaviour

If OSC 1717 never arrives — the shell is not zsh, or the user's configuration
displaced the hook — the feature simply never opens. There is no fallback to a
shadow buffer. A list built on a guess is worse than no list.

## Testing

Unit tests under `test/`, run by `node --test`, following the existing
pattern:

- `zleBuffer.test.mjs` — decoding buffers containing ESC, newline, tab and `;`
- `commandLine.test.mjs` — tokenizing: inside quotes, command position, cursor
  mid-line
- `schema.test.mjs` — `git ch` → subcommands, `git checkout -` → flags
- `rank.test.mjs` — ordering, dedupe, source priority

The shell hook and the overlay are not unit-testable and are verified by hand
in the running app.

## Out of scope

- Shells other than zsh
- Running schema generators as code
- Inline ghost-text suggestions (this is a dropdown, not an autosuggestion)
- Rewriting the input line to be owned by Mesa rather than ZLE
