import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { registerTerminal, unregisterTerminal } from './terminalRegistry.js';
import { COMMAND_ROW_BG, COMMAND_RULE, DANGER, TERMINAL_THEMES } from './theme.js';

// One live session: an xterm instance bound to one pty. Every open tab keeps
// its own mounted instance, including the ones you cannot see — that is the
// whole point of tabs here, since a background tab is usually the thing you
// left running. Inactive views stay laid out at full size and are hidden with
// visibility rather than display:none, so their row count never goes stale
// while they are off screen.
export default function TerminalView({ tabId, accent, theme, scale, active, focused, onStatus }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);

  // The mount effect runs once, but the handlers it installs live for the
  // session's whole life and need current values every time they fire.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const accentRef = useRef(accent);
  accentRef.current = accent;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const draggingRef = useRef(false);

  useEffect(() => {
    const report = (patch) => onStatusRef.current?.(tabId, patch);

    const term = new Terminal({
      allowProposedApi: true, // needed for registerMarker/registerDecoration
      cursorBlink: true,
      cursorStyle: 'block',
      // SF Mono is the native macOS terminal face — a genuine system choice
      // here, not a trendy webfont pulled in to signal "developer".
      fontFamily: "'SF Mono', 'Menlo', ui-monospace, monospace",
      // Bigger, and a touch heavier than book weight. Light-on-dark type
      // optically thins out, so 400 reads as spindly and washed out on this
      // surface; 450 puts the stroke weight back without tipping into bold.
      fontSize: 14,
      fontWeight: 450,
      fontWeightBold: 650,
      lineHeight: 1.45,
      letterSpacing: 0,
      scrollback: 10000,
      theme: { ...TERMINAL_THEMES[theme], cursor: accent }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;
    registerTerminal(tabId, term);

    // macOS line editing. Option and Command are not Meta by default, so the
    // editing shortcuts every other Mac text field has never reach the shell —
    // Option+Backspace in particular just did nothing.
    //
    // The blunt fix would be macOptionIsMeta, but that turns the entire Option
    // layer into an escape prefix and a Turkish keyboard needs it: Option+Q is
    // how you type "@". So each combination is translated on its own and every
    // other Option press is left completely alone.
    const MAC_LINE_EDITING = [
      // Control characters, not ESC-prefixed sequences. ESC+DEL is the emacs
      // binding for backward-kill-word, and this shell turned out to be in vi
      // mode — there ESC just drops you into command mode, which is why
      // Option+Backspace appeared to do nothing (it moved the cursor two
      // columns and left the keymap switched). ^W and ^U are bound to the same
      // job in BOTH keymaps, so these work whichever mode the user's shell is
      // in. Option+arrow word motion is deliberately absent: the only zsh
      // binding for it is ESC-prefixed, which would strand a vi user in
      // command mode.
      { alt: true, key: 'Backspace', send: '\x17' }, // kill the word before the cursor
      { meta: true, key: 'Backspace', send: '\x15' }, // kill back to the start of the line
      // Word motion and forward word-kill are ESC-prefixed, which zsh only
      // understands in its emacs keymap out of the box. The shell hook binds
      // them into vi-insert too (see electron/shell-hooks/zsh/.zshenv), so
      // these behave the same whichever mode the user's shell is in — and
      // crucially without ESC ever being seen on its own, which would have
      // dropped a vi user into command mode.
      { alt: true, key: 'ArrowLeft', send: '\x1bb' }, // back one word
      { alt: true, key: 'ArrowRight', send: '\x1bf' }, // forward one word
      { alt: true, key: 'Delete', send: '\x1bd' }, // kill the word after the cursor
      { meta: true, key: 'ArrowLeft', send: '\x01' }, // start of line
      { meta: true, key: 'ArrowRight', send: '\x05' } // end of line
    ];
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;

      // Shift+Enter. A terminal historically does not tell Shift+Enter and
      // Enter apart: both send a carriage return (CR, \r), which is why there
      // is nowhere that reads multi-line input where you can drop to the next
      // line.
      //
      // The sequence sent is ESC+CR, which is to say Alt+Enter. A raw LF (\n)
      // was not chosen because zsh counts that as a line ending too and would
      // run the command; ESC+CR answers both sides at once: at the shell
      // prompt the shell hook (electron/shell-hooks/zsh/.zshenv) binds this
      // sequence to a ZLE widget that inserts a real newline into the line
      // buffer, while TUIs read it as Alt+Enter.
      if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.altKey && !event.ctrlKey) {
        event.preventDefault();
        window.terminalApi.input(tabId, '\x1b\r');
        return false;
      }

      const match = MAC_LINE_EDITING.find(
        (b) =>
          b.key === event.key &&
          Boolean(b.alt) === event.altKey &&
          Boolean(b.meta) === event.metaKey &&
          !event.ctrlKey
      );
      if (!match) return true;
      event.preventDefault();
      window.terminalApi.input(tabId, match.send);
      return false;
    });

    // Re-measure whenever the box actually changes, instead of trusting the
    // single fit() above. That one call runs before layout has necessarily
    // settled, and a terminal whose rows disagree with its visible height
    // fails silently — rows simply fall outside the clip and the prompt
    // disappears.
    const resizeObserver = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return;
      fitRef.current.fit();
      window.terminalApi.resize(tabId, termRef.current.cols, termRef.current.rows);
    });
    resizeObserver.observe(hostRef.current);

    // OSC 133 semantic-prompt markers, emitted by our zsh hook (see
    // electron/shell-hooks/zsh/.zshenv):
    //   A = prompt start, C = command started (preexec),
    //   D;<exitCode> = command finished (precmd).
    //
    // zsh runs precmd before EVERY prompt, including the shell's own startup
    // and every bare Enter, so a divider keyed off D alone landed under every
    // row the user ever pressed Enter on. Gate on having seen a C since the
    // last one: that is the only signal that a real command ran.
    let sawCommand = false;
    let promptMarker = null;
    const oscDisposable = term.parser.registerOscHandler(133, (data) => {
      const kind = data[0];

      // A marks the row the prompt is about to be drawn on. Holding on to it
      // lets us tint that row once we know a command was actually submitted.
      if (kind === 'A') {
        promptMarker = term.registerMarker(0);
        return true;
      }

      if (kind === 'C') {
        sawCommand = true;
        report({ runningSince: Date.now() });

        // The command you ran gets a lit row of its own, so a long scrollback
        // reads as a stack of blocks instead of undifferentiated text. Uses
        // xterm's own backgroundColor decoration, which paints the cell
        // background beneath the glyphs rather than an element over them.
        if (promptMarker) {
          term.registerDecoration({
            marker: promptMarker,
            x: 0,
            width: term.cols,
            layer: 'bottom',
            backgroundColor: COMMAND_ROW_BG[themeRef.current]
          });
          promptMarker = null;
        }
        return true;
      }

      // B is a prompt-boundary marker we draw nothing for, but we still
      // consume it so it never leaks into the visible output.
      if (kind !== 'D') return true;
      if (!sawCommand) return true;
      sawCommand = false;

      const exitCode = Number(data.split(';')[1] ?? '0');
      report({ runningSince: null, lastExit: exitCode });

      // At D-time the cursor sits on the row the next prompt is about to be
      // drawn on, so a rule there lands directly under the finished command's
      // output. It is an index mark rather than an edge-to-edge line: a short
      // solid tick in the session's own tint (or the failure red), then a
      // hairline that fades out well before the right edge.
      const marker = term.registerMarker(0);
      if (!marker) return true;
      const activeTheme = themeRef.current;
      const tick = exitCode === 0 ? accentRef.current : DANGER[activeTheme];
      const rule =
        exitCode === 0
          ? COMMAND_RULE[activeTheme]
          : `color-mix(in srgb, ${DANGER[activeTheme]} 40%, transparent)`;
      const decoration = term.registerDecoration({ marker, x: 0, width: term.cols });
      decoration?.onRender((el) => {
        el.style.backgroundImage = `linear-gradient(to right, ${tick} 0 14px, ${rule} 14px, ${rule} 62%, transparent 92%)`;
        el.style.backgroundSize = '100% 1px';
        el.style.backgroundRepeat = 'no-repeat';
        el.style.backgroundPosition = '0 0';
      });
      return true;
    });

    // `clear` on macOS emits ESC[3J ESC[H ESC[2J. That first sequence is
    // "erase saved lines" — it throws the scrollback away, which is why
    // clearing the screen also destroyed everything you had scrolled past.
    // Swallow just that one: the screen still clears (ESC[2J is untouched),
    // but the history above it survives, which is what a workspace terminal
    // should do. Returning false for every other parameter leaves normal
    // erase-in-display handling exactly as it was.
    const csiEraseDisplay = term.parser.registerCsiHandler({ final: 'J' }, (params) => params[0] === 3);

    // OSC 7 carries the working directory, so the chrome can show where the
    // session actually is — and, from that directory, which branch the work is
    // on. The branch is resolved on every prompt rather than only when the
    // directory changes, because `git checkout` moves the branch without
    // moving the shell.
    //
    // Answers can land out of order (two prompts in quick succession, one
    // path deeper than the other), so each request carries a ticket and only
    // the newest one is allowed to report.
    let cwdTicket = 0;
    const reportCwd = (dir) => {
      report({ cwd: dir });
      const ticket = ++cwdTicket;
      Promise.resolve(window.terminalApi.gitBranch?.(dir))
        .then((branch) => {
          if (ticket === cwdTicket) report({ branch: branch ?? null });
        })
        .catch(() => {});
    };

    const oscCwdDisposable = term.parser.registerOscHandler(7, (data) => {
      const match = /^file:\/\/[^/]*(\/.*)$/.exec(data);
      if (match) {
        // Decoded first, and only then reported: with the call inside the try
        // a throw from anywhere downstream would run the whole report a second
        // time on the raw path.
        let dir;
        try {
          dir = decodeURIComponent(match[1]);
        } catch {
          dir = match[1];
        }
        reportCwd(dir);
      }
      return true;
    });

    window.terminalApi.create(tabId, term.cols, term.rows).then((ok) => {
      if (!ok) {
        term.write('\r\n\x1b[31mnode-pty failed to load. This is a mock terminal.\x1b[0m\r\n');
      }
    });

    const disposeData = window.terminalApi.onData(tabId, (data) => term.write(data));
    const disposeExit = window.terminalApi.onExit(tabId, () => {
      report({ exited: true, runningSince: null });
      term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
    });

    term.onData((data) => window.terminalApi.input(tabId, data));

    return () => {
      disposeData();
      disposeExit();
      oscDisposable.dispose();
      oscCwdDisposable.dispose();
      csiEraseDisplay.dispose();
      resizeObserver.disconnect();
      unregisterTerminal(tabId);
      window.terminalApi.close(tabId);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mouse selection under the canvas's zoom ─────────────────────────────
  // When xterm turns a mouse position into a cell it divides a difference
  // measured in viewport pixels (clientX - rect.left) by an unscaled cell
  // width: getCoords in browser/input/Mouse.ts. When the canvas scales the
  // pane with transform: scale(s) the numerator grows by s and the
  // denominator does not — so every column and row is off by exactly s, and
  // at any zoom but 100% the selection marks somewhere else entirely. xterm
  // does not support a transformed ancestor and has no API to tell it about
  // one.
  //
  // The fix: stop the event in the capture phase and dispatch a
  // coordinate-corrected copy of it at the same target. xterm's own listeners
  // (mousedown on the screen element, mousemove/mouseup on the document for
  // the length of a drag) see the copy and compute the right cell.
  useEffect(() => {
    const onMouse = (e) => {
      // The copy we dispatched ourselves: let it through untouched, or this
      // loops forever.
      if (e.zoomCorrected) return;

      // Do not interfere at all while the canvas is running a gesture of its
      // own (a pan, or a marquee selection): those events belong to the
      // canvas's arithmetic, not the terminal's.
      //
      // The same holds for dragging or resizing a pane, and that was missed:
      // `inside` is recomputed from `e.target` on every event, so the moment a
      // dragged pane crosses ANOTHER terminal, `inside` goes true for that
      // terminal and the `!inside && !dragging` gate below opens. At any zoom
      // but 1 that means firing synthetic mousedown/mousemove at that terminal
      // on every frame of the gesture — xterm takes them for a selection
      // gesture of its own and the text flickers for the length of the drag.
      if (
        document.body.classList.contains('is-canvas-drag') ||
        document.body.classList.contains('is-pane-drag')
      ) {
        return;
      }

      const host = hostRef.current;
      if (!host) return;
      const inside = host.contains(e.target);

      // A drag can run outside the terminal — selecting as far as the
      // scrollbar requires it. So where it started is remembered.
      if (e.type === 'mousedown') draggingRef.current = inside;
      const dragging = draggingRef.current;
      if (e.type === 'mouseup') draggingRef.current = false;
      if (!inside && !dragging) return;

      const s = scaleRef.current;
      if (!s || s === 1) return;

      // The measurement has to come off the element xterm itself uses: it
      // computes the coordinate against .xterm-screen, not the outer
      // container. The difference is .xterm's own padding, and it was shifting
      // the correction by exactly 16 × (1 − s) pixels — unnoticeable mid-line,
      // obvious in the first column.
      const screenEl = host.querySelector('.xterm-screen') || host;
      const rect = screenEl.getBoundingClientRect();
      const corrected = new MouseEvent(e.type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: rect.left + (e.clientX - rect.left) / s,
        clientY: rect.top + (e.clientY - rect.top) / s,
        screenX: e.screenX,
        screenY: e.screenY,
        button: e.button,
        buttons: e.buttons,
        // Double-click word selection depends on this: xterm reads the click
        // count out of detail, so the copy has to carry it unchanged.
        detail: e.detail,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey
      });
      corrected.zoomCorrected = true;
      // Propagation stops, and mousedown's default action is cancelled too.
      //
      // The second part is required: xterm calls preventDefault in its own
      // mousedown listener and pulls focus into its helper textarea, but that
      // listener now only ever sees the COPY — and a preventDefault called on
      // the copy does not cancel the original's default action. When the
      // original finished dispatching, the default ran and mousedown moved
      // focus to the body, so xterm lost focus immediately after taking it.
      // The result: at any zoom but 100%, every click into the terminal put
      // the cursor out, and no later click could bring it back. Cancelling
      // here is what xterm already does in the unscaled case.
      if (e.type === 'mousedown') e.preventDefault();
      e.stopImmediatePropagation();
      e.target.dispatchEvent(corrected);
    };

    const types = ['mousedown', 'mousemove', 'mouseup'];
    types.forEach((t) => document.addEventListener(t, onMouse, true));
    return () => types.forEach((t) => document.removeEventListener(t, onMouse, true));
  }, []);


  // Swap an open terminal's palette when the theme changes. Only the live
  // colours move; scrollback, cursor position and the running shell are
  // untouched.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = { ...TERMINAL_THEMES[theme], cursor: accent };
  }, [theme, accent]);

  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  return (
    <div
      className={`pane-body${active ? '' : ' pane-body-hidden'}`}
      data-terminal-id={tabId}
      ref={hostRef}
    />
  );
}
