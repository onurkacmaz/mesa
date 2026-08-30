# Mesa

Terminals on an infinite canvas. Put a shell where you want it, leave it there,
and come back to it in the same place tomorrow.

![Mesa](docs/screenshot.png)

A tabbed terminal makes you remember which tab is which. Mesa gives every
session a *place* instead: drag windows anywhere on an unbounded surface, zoom
out to see the whole workspace, zoom back in to work. Browser panes sit on the
same canvas, so the thing you are building and the page you are checking it on
are side by side rather than behind each other.

## Install

Download the `.dmg` from [Releases](https://github.com/onurkacmaz/mesa/releases)
and drag Mesa to Applications. Apple Silicon only.

The build is **not code-signed**, so macOS will refuse it on first launch. To
open it anyway: right-click the app → **Open** → **Open**. You only do this
once.

## Build from source

```sh
git clone https://github.com/onurkacmaz/mesa.git
cd mesa
npm install
npm run dev      # vite + electron, with devtools
```

Other scripts:

```sh
npm test         # unit tests (node:test, no build needed)
npm run build    # renderer bundle only
npm run dist     # signed-less .dmg into release/
```

`node-pty` builds a native module on install, so you need the Xcode command
line tools (`xcode-select --install`).

## Keys

| | |
|---|---|
| `⌘N` / `⌘B` | new terminal / new browser |
| `⌘1`–`⌘9` | switch tab |
| `⌘T` | new workflow |
| `⌥⌘1`–`⌥⌘9` | switch workflow |
| `⌘W` | close the innermost thing: tab, then window, then workflow |
| `⌘L` | focus a browser pane's address bar |
| `⌘E` / `⇧⌘E` | open the selected terminal's folder in your editor / in a different one |
| `⌘0` / `⇧⌘0` | actual size / fit everything |
| `⌘` + scroll | zoom |
| `space` + drag | pan |

Drag across empty canvas to select several panes; drag a pane by its title bar
to move it, double-click the title to rename it, right-click it for the editor
menu.

## What it remembers

Workflows, panes, tabs, the canvas view, every terminal's folder and every
browser's address are written to `session.json` in the app's data directory and
read back on launch.

A pty dies with the app, so a restored terminal is a **fresh shell standing in
the folder it was left in** — the layout comes back, the running processes do
not.

Answers to questions the app should only ask once — whether the onboarding
cards have been read, and which editor `⌘E` opens folders in — live in
`flags.json` beside it, not in the session. A session that cannot be parsed is
set aside so the next save cannot overwrite it, and a rescued layout should not
also cost an answer already given.

`⌘E` opens the selected terminal's **current** folder, the one its shell last
reported, in whichever editor you picked the first time you pressed it. Mesa
does not embed an editor: it hands the folder to the one already installed.
To change the answer, either press `⇧⌘E` or right-click a terminal's title bar
— both list the editors on this Mac with the current one ticked, and picking
one opens the folder and becomes the new default.

## What it does not do

Worth knowing before you try it:

- **macOS on Apple Silicon only.** There are Windows and Linux branches in the
  code, but nothing is built or tested on either. They are not expected to work
  as-is.
- **The DMG is unsigned and un-notarised.** See the install note above.
- **"Is something running?" needs zsh.** The check that makes `⌘W` ask before
  killing a live command relies on a zsh prompt hook (OSC 133). Under bash,
  fish or anything else, panes close without asking.
- **No agent orchestration, no git worktree management, no task board.** Mesa
  opens shells and puts them somewhere. That is the whole of it.

## How it is put together

Electron, with a React renderer and no framework beyond it.

```
electron/main.js      pty spawning, session file I/O, guest webview policy
electron/preload.js   the entire renderer↔main surface
src/Workspace.jsx     the canvas: pan, zoom, selection, pane lifecycle
src/TerminalPane.jsx  one pane: title bar, tab strip, drag and resize
src/TerminalView.jsx  xterm.js, wired to a pty
src/BrowserView.jsx   a <webview> guest with its own chrome
src/Onboarding.jsx    the one-time first-launch cards
src/session.mjs       pure: what a session file is, and when to trust it
src/flags.mjs         pure: what the app remembers about you, not your work
src/editors.mjs       pure: which installed apps are editors, and which you chose
```

`src/session.mjs`, `src/flags.mjs` and `src/editors.mjs` are deliberately free
of React and the filesystem, which is why the part of persistence that can ruin
a launch is also the part that is directly unit-tested. `electron/main.js` can
see the disk and nothing else: it hands over raw text and raw file names, and
what any of it means is decided in those three files.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome.

## License

[MIT](LICENSE) © Onur Kaçmaz
