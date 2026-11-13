# Contributing

Thanks for looking. Issues and pull requests are both welcome.

## Getting set up

```sh
cargo run -p mesa
```

That builds and starts the app. Dependencies are compiled with optimisations
even in a debug build (see `[profile.dev.package."*"]` in `Cargo.toml`), so a
debug terminal keeps up with real output; your own changes still build fast.

On a Mac you need the Xcode command line tools (`xcode-select --install`). On
Linux, GPUI needs the X11/Wayland, xkbcommon, Vulkan and fontconfig development
packages.

## Tests

```sh
cargo test --workspace
```

The tests need no window and no shell, because everything they cover is pure.
That is a deliberate constraint rather than a limitation: logic worth testing
gets moved out of the UI and into `crates/mesa-core` (`session.rs`, `rank.rs`,
`stream.rs`) where it can be tested directly.

If you are fixing a bug in one of those, add the failing test first.

## Verifying UI changes

There is no automated UI test. What works well instead is running the app
against a throwaway home directory, so it cannot touch your own layout:

```sh
HOME=$(mktemp -d) cargo run -p mesa
```

On Linux the same works headless under Xvfb with a window manager running
(GPUI only draws a window the server says is visible), driven by `xdotool` and
captured with `import -window root`.

The macOS-only page code lives in `crates/mesa-webview` so it can be
type-checked from any machine:

```sh
rustup target add aarch64-apple-darwin
cargo check -p mesa-webview --target aarch64-apple-darwin
```

## Style

`rustfmt` defaults, except that lines run long rather than wrap a builder
chain mid-thought — match what is around you.

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
- `cargo test --workspace` green (CI runs it on macOS)
- Say what you did and why; if it touches the UI, a screenshot helps

If you are planning something large, open an issue first — Mesa is deliberately
small, and the most likely reason a PR gets turned down is scope rather than
quality. See "What it does not do" in the README.
