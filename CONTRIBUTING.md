# Contributing

Thanks for looking. Issues and pull requests are both welcome.

## Getting set up

```sh
npm install
npm run dev
```

`npm run dev` starts Vite and Electron together, with devtools detached. The
renderer hot-reloads; changes to `electron/main.js` or `electron/preload.js`
need the app restarted.

`node-pty` compiles on install, so you need the Xcode command line tools
(`xcode-select --install`).

## Tests

```sh
npm test
```

Tests run on `node:test` with no build step and no Electron, because everything
they cover is pure. That is a deliberate constraint rather than a limitation:
logic worth testing gets moved out of the components and into a plain module
(`src/session.mjs`, `src/terminalOsc.mjs`) where it can be tested directly.

If you are fixing a bug in one of those, add the failing test first.

## Verifying UI changes

There is no automated UI test. What works well instead is a second Electron
process with a hidden window pointed at the dev server: it can load a session
you construct, run real ptys, and take a screenshot with `capturePage()`,
without touching the app you have open. Ask in an issue if you want the script.

## Style

The code is formatted with 2-space indent, single quotes, semicolons — match
what is around you.

The one thing worth knowing is the comment convention. Comments here explain
**why**, not what, and they carry the reasoning that would otherwise be lost:
the constraint that forced a decision, the bug an ordering prevents, the option
that was tried and rejected. A comment restating the code is noise; a comment
recording why the obvious approach does not work is the point.

Please keep this up in new code, and please update a comment that your change
makes untrue. A confidently wrong comment costs more than no comment.

## Commits

Written as a sentence saying what the change does, imperative mood, no prefix:

```
Remove the ropes between panes
Give a pane tabs, and remember the session between launches
```

Use the body to say why, and what a reader would otherwise have to reconstruct.
Release commits are the one exception and use `chore: release vX.Y.Z`.

## Pull requests

- One concern per PR
- `npm test` green (CI runs it on macOS)
- Say what you did and why; if it touches the UI, a screenshot helps

If you are planning something large, open an issue first — Mesa is deliberately
small, and the most likely reason a PR gets turned down is scope rather than
quality. See "What it does not do" in the README.
