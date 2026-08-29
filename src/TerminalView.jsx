import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';
import { registerTerminal, unregisterTerminal } from './terminalRegistry.js';
import { COMMAND_ROW_BG, COMMAND_RULE, DANGER, TERMINAL_THEMES } from './theme.js';
import { OSC_ST, hexToOscRgb, oscPaletteColor, parseOscColor, terminalThemeName } from './terminalOsc.mjs';

// One live session: an xterm instance bound to one pty. Every open tab keeps
// its own mounted instance, including the ones you cannot see — that is the
// whole point of tabs here, since a background tab is usually the thing you
// left running. Inactive views stay laid out at full size and are hidden with
// visibility rather than display:none, so their row count never goes stale
// while they are off screen.
// How long the shell has to go quiet before a startup command is typed, for
// shells that do not speak OSC 133. Long enough that a slow login profile's
// own output keeps pushing it back, short enough that it does not read as the
// app hesitating.
const STARTUP_QUIET_MS = 700;

export default function TerminalView({
  tabId,
  initialCwd,
  startupCommand,
  accent,
  theme,
  scale,
  active,
  focused,
  onStatus
}) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);

  // The pane's startup command, caught at mount and never followed after
  // that. Editing it later is a change to what this pane opens with NEXT
  // time — typing into a terminal someone is already working in, because they
  // corrected a typo in a field, would be the app taking the keyboard.
  const startupRef = useRef(startupCommand);
  const startupSentRef = useRef(false);
  // Set inside the mount effect, so the OSC handler registered alongside it
  // can reach the same one-shot without either owning the other.
  const startupTypeRef = useRef(null);

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
  const tuiRef = useRef(false);
  const repaintBlocksRef = useRef(null);

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
      theme: { ...TERMINAL_THEMES[terminalThemeName(theme)], cursor: accent }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);

    // The canvas renderer, not xterm's default DOM one. This is what makes a
    // full-screen TUI — OpenCode, Claude Code, vim — look like it does in a
    // native terminal instead of shredded.
    //
    // The DOM renderer draws every cell as a text span and leans on the font
    // for box-drawing and block characters (█ ▀ ▄ ─ │ ┌). Those glyphs only
    // tile seamlessly when a cell lands on a whole pixel, and on this canvas
    // a pane is displayed through transform: scale(zoom) — so at any zoom but
    // 100% every block glyph is rasterised at a fractional offset and hairline
    // gaps open between them. Measured at 161%: OpenCode's block-letter logo
    // came out sliced by white seams and the prompt box lost its borders.
    // Warp has no such seams because it draws those glyphs itself.
    //
    // The canvas renderer does the same: box and block characters are drawn as
    // cell-exact vectors rather than looked up in the font, so they meet
    // perfectly at every zoom. Type goes very slightly soft above 100% — the
    // canvas bitmap is scaled rather than re-rasterised — which is a small
    // price against losing the glyphs entirely.
    //
    // Canvas rather than WebGL deliberately: every open tab keeps a live
    // terminal, including the ones you cannot see, and WebGL contexts are
    // capped per document (~16 in Chromium) with the oldest silently dropped —
    // which would show up as an old pane going blank rather than as anything
    // that reads like a rendering bug. A 2D context is under no such cap;
    // eight panes on a 2× display all kept drawing. It is not free either:
    // each terminal holds four full-size layers, so a large pane on a retina
    // display costs tens of megabytes of backing store.
    try {
      term.loadAddon(new CanvasAddon());
    } catch (err) {
      // Falls back to the DOM renderer, which still works — just with the
      // seams above. Better than a pane that fails to open.
      console.warn('canvas renderer unavailable, falling back to DOM', err);
    }

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

    // ── Command blocks, and why they are held rather than just drawn ────────
    //
    // Every block is kept as a marker plus the recipe for painting it, not as
    // a live decoration, because a decoration cannot stay up while a
    // full-screen TUI is running. xterm draws a decoration from its marker's
    // row without asking which buffer that row belongs to, so the blocks built
    // on the normal screen went on painting straight through OpenCode's
    // alternate screen: bands of lit rows and hairline rules laid across the
    // TUI's own output, at the normal screen's taller row height. That is the
    // striping in the report, and it is the renderer's cell background rather
    // than an element on top, so it cannot be hidden with CSS — the decoration
    // has to come down and go back up.
    //
    // A block stores its ROLE, never a colour: which row it marks and whether
    // the command succeeded. The colour is resolved from the live theme every
    // time it is painted, so switching to the light theme repaints the whole
    // scrollback with it. Storing the colour instead left every block that had
    // been made in the dark theme sitting as a black band on the light screen,
    // with its own command text unreadable inside it.
    const blocks = [];
    let painted = [];

    const paintBlock = (block) => {
      const activeTheme = themeRef.current;

      if (block.kind === 'row') {
        return term.registerDecoration({
          marker: block.marker,
          x: 0,
          width: term.cols,
          layer: 'bottom',
          backgroundColor: COMMAND_ROW_BG[activeTheme]
        });
      }

      const tick = block.ok ? accentRef.current : DANGER[activeTheme];
      const rule = block.ok
        ? COMMAND_RULE[activeTheme]
        : `color-mix(in srgb, ${DANGER[activeTheme]} 40%, transparent)`;
      const decoration = term.registerDecoration({ marker: block.marker, x: 0, width: term.cols });
      decoration?.onRender((el) => {
        el.style.backgroundImage = `linear-gradient(to right, ${tick} 0 14px, ${rule} 14px, ${rule} 62%, transparent 92%)`;
        el.style.backgroundSize = '100% 1px';
        el.style.backgroundRepeat = 'no-repeat';
        el.style.backgroundPosition = '0 0';
      });
      return decoration;
    };

    const unmountBlocks = () => {
      painted.forEach((decoration) => decoration.dispose());
      painted = [];
    };

    // Takes everything down first, so calling this twice cannot end up with
    // two decorations stacked on the same row.
    const mountBlocks = () => {
      unmountBlocks();
      // Walked backwards so a block whose marker has fallen out of scrollback
      // can be dropped in place — registerDecoration answers undefined for a
      // disposed marker, which is the only signal that the row is gone.
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const decoration = paintBlock(blocks[i]);
        if (decoration) painted.push(decoration);
        else blocks.splice(i, 1);
      }
    };

    const addBlock = (block) => {
      blocks.push(block);
      const decoration = paintBlock(block);
      if (decoration) painted.push(decoration);
    };

    // Handed out so the theme effect below can repaint the scrollback. It is a
    // no-op while a TUI holds the screen: the blocks are deliberately down
    // then, and remounting would put them straight back over the TUI.
    repaintBlocksRef.current = () => {
      if (!tuiRef.current) mountBlocks();
    };

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
      //
      // Nothing is marked while a TUI owns the screen. A TUI that speaks OSC
      // 133 itself would otherwise mark a row of the alternate buffer and lay
      // a band across its own output — the same bug, through the other door.
      if (kind === 'A') {
        promptMarker = tuiRef.current ? null : term.registerMarker(0);
        // A prompt is being drawn, so the shell is ready for a line: the one
        // certain moment to lay the startup command in front of it.
        startupTypeRef.current?.();
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
          addBlock({ marker: promptMarker, kind: 'row' });
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
      if (tuiRef.current) return true;
      const marker = term.registerMarker(0);
      if (!marker) return true;
      addBlock({ marker, kind: 'rule', ok: exitCode === 0 });
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

    // OSC 4/10/11 theme queries and dynamic fg/bg updates (OpenTUI, etc.).
    let fgOverride = null;
    let bgOverride = null;

    const baseTheme = () => TERMINAL_THEMES[terminalThemeName(themeRef.current)];

    const applyTheme = () => {
      const base = baseTheme();
      term.options.theme = {
        ...base,
        foreground: fgOverride ?? base.foreground,
        background: bgOverride ?? base.background,
        cursor: accentRef.current
      };
    };

    const replyOsc = (code, payload) => {
      queueMicrotask(() => window.terminalApi.input(tabId, `\x1b]${code};${payload}${OSC_ST}`));
    };

    const handleOscColor = (code, data, kind) => {
      if (data === '?' || data.startsWith('?')) {
        const hex = kind === 'fg' ? (fgOverride ?? baseTheme().foreground) : (bgOverride ?? baseTheme().background);
        replyOsc(code, hexToOscRgb(hex));
        return true;
      }
      const parsed = parseOscColor(data);
      if (!parsed) return true;
      if (kind === 'fg') fgOverride = parsed;
      else bgOverride = parsed;
      applyTheme();
      return true;
    };

    const oscPaletteDisposable = term.parser.registerOscHandler(4, (data) => {
      const [index, action] = data.split(';');
      if (action !== '?' && !action?.startsWith('?')) return true;
      const hex = oscPaletteColor(baseTheme(), index);
      if (hex) replyOsc(4, `${index};${hexToOscRgb(hex)}`);
      return true;
    });
    const oscFgDisposable = term.parser.registerOscHandler(10, (data) => handleOscColor(10, data, 'fg'));
    const oscBgDisposable = term.parser.registerOscHandler(11, (data) => handleOscColor(11, data, 'bg'));
    const oscFgResetDisposable = term.parser.registerOscHandler(110, () => {
      fgOverride = null;
      applyTheme();
      return true;
    });
    const oscBgResetDisposable = term.parser.registerOscHandler(111, () => {
      bgOverride = null;
      applyTheme();
      return true;
    });

    // Alternate-screen TUIs (OpenCode, vim, htop) need tight cell metrics and
    // no inner gutter — block glyphs and full-bleed layouts misalign otherwise.
    const applyTuiLayout = (isAlt) => {
      tuiRef.current = isAlt;
      report({ tui: isAlt });
      hostRef.current?.classList.toggle('pane-body-tui', isAlt);
      // The shell's command blocks belong to the normal screen and would
      // otherwise keep painting over the TUI (see the block store above).
      if (isAlt) unmountBlocks();
      else mountBlocks();
      term.options.lineHeight = isAlt ? 1 : 1.45;
      term.options.fontWeight = isAlt ? 'normal' : 450;
      applyTheme();
      fit.fit();
      window.terminalApi.resize(tabId, term.cols, term.rows);
    };
    const bufferDisposable = term.buffer.onBufferChange((buffer) => {
      applyTuiLayout(buffer.type === 'alternate');
    });
    applyTuiLayout(term.buffer.active.type === 'alternate');

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

    // The folder the pane was opened with — read at mount, which is the only
    // moment it means anything: from here on the shell owns its own cwd, and
    // where it walks to is reported back through OSC 7 above.
    window.terminalApi.create(tabId, term.cols, term.rows, initialCwd).then((ok) => {
      if (!ok) {
        term.write('\r\n\x1b[31mnode-pty failed to load. This is a mock terminal.\x1b[0m\r\n');
      }
    });

    // The startup command is submitted: the return goes with it, so the pane
    // comes back doing what it was doing. Restoring a workflow starts what
    // that workflow runs, which is the point of remembering it at all.
    //
    // This makes the moment it is sent matter more than it would if the line
    // were only being typed: a line submitted before the shell is listening is
    // lost, or worse, half of it is. The certain signal is OSC 133 A, which
    // our zsh hook emits and other shells do not, so there is a second and
    // weaker one for everyone else: the output going quiet. A login shell
    // takes as long as it takes, and waiting for it to stop talking asks
    // nothing about how long that is.
    let startupTimer = null;
    const typeStartup = () => {
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      if (startupSentRef.current) return;
      startupSentRef.current = true;
      const command = startupRef.current;
      // The return is part of the same write, so nothing can land between the
      // line and its submission.
      if (command) window.terminalApi.input(tabId, `${command}\r`);
    };
    startupTypeRef.current = typeStartup;

    const disposeData = window.terminalApi.onData(tabId, (data) => {
      term.write(data);
      if (startupSentRef.current || !startupRef.current) return;
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = setTimeout(typeStartup, STARTUP_QUIET_MS);
    });
    const disposeExit = window.terminalApi.onExit(tabId, () => {
      report({ exited: true, runningSince: null });
      term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
    });

    term.onData((data) => window.terminalApi.input(tabId, data));

    return () => {
      if (startupTimer) clearTimeout(startupTimer);
      startupTypeRef.current = null;
      disposeData();
      disposeExit();
      oscDisposable.dispose();
      oscPaletteDisposable.dispose();
      oscFgDisposable.dispose();
      oscBgDisposable.dispose();
      oscFgResetDisposable.dispose();
      oscBgResetDisposable.dispose();
      bufferDisposable.dispose();
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
    if (!term) return;
    // Palette swap from the chrome — preserve any OSC overrides a running TUI set.
    const base = TERMINAL_THEMES[terminalThemeName(theme)];
    const current = term.options.theme;
    term.options.theme = {
      ...base,
      foreground: current.foreground !== TERMINAL_THEMES.dark.foreground &&
        current.foreground !== TERMINAL_THEMES.light.foreground
        ? current.foreground
        : base.foreground,
      background: current.background !== TERMINAL_THEMES.dark.background &&
        current.background !== TERMINAL_THEMES.light.background
        ? current.background
        : base.background,
      cursor: accent
    };

    // The scrollback's command blocks carry theme colours too, and unlike the
    // palette above they are decorations rather than live cells — nothing
    // repaints them on its own. Left alone, every block made in the dark theme
    // stayed a black band on the light screen with its own command text
    // unreadable inside it.
    repaintBlocksRef.current?.();
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
