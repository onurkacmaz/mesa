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

      // Shift+Enter. Bir terminal tarihsel olarak Shift+Enter ile Enter'ı
      // ayırmaz: ikisi de satır başı (CR, \r) gönderir, bu yüzden çok satırlı
      // girdi okuyan hiçbir yerde alt satıra inilemiyor.
      //
      // Gönderilen dizi ESC+CR, yani Alt+Enter. Ham LF (\n) tercih
      // edilmedi çünkü zsh onu da satır sonu sayıp komutu çalıştırırdı;
      // ESC+CR ise iki tarafı birden çözüyor: kabuk isteminde shell hook'u
      // (electron/shell-hooks/zsh/.zshenv) bu diziyi satır arabelleğine
      // gerçek bir satır sonu ekleyen bir ZLE widget'ına bağlıyor, TUI'lar
      // ise onu Alt+Enter olarak okuyor.
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
    // session actually is.
    const oscCwdDisposable = term.parser.registerOscHandler(7, (data) => {
      const match = /^file:\/\/[^/]*(\/.*)$/.exec(data);
      if (match) {
        try {
          report({ cwd: decodeURIComponent(match[1]) });
        } catch {
          report({ cwd: match[1] });
        }
      }
      return true;
    });

    window.terminalApi.create(tabId, term.cols, term.rows).then((ok) => {
      if (!ok) {
        term.write('\r\n\x1b[31mnode-pty yuklenemedi. Bu bir mock terminal.\x1b[0m\r\n');
      }
    });

    const disposeData = window.terminalApi.onData(tabId, (data) => term.write(data));
    const disposeExit = window.terminalApi.onExit(tabId, () => {
      report({ exited: true, runningSince: null });
      term.write('\r\n\x1b[90m[işlem sonlandı]\x1b[0m\r\n');
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

  // ── Tuval zoom'u altında fare seçimi ────────────────────────────────────
  // xterm bir fare konumunu hücreye çevirirken viewport pikseliyle ölçülen
  // bir farkı (clientX - rect.left) ölçeklenmemiş bir hücre genişliğine
  // bölüyor: browser/input/Mouse.ts içindeki getCoords. Tuval paneli
  // transform: scale(s) ile ölçeklediğinde pay s katı büyüyor, payda
  // büyümüyor — yani her sütun ve satır tam olarak s katı kayıyor ve zoom
  // %100 değilken seçim bambaşka bir yeri işaretliyor. xterm dönüştürülmüş
  // bir ata elemanı desteklemiyor ve bunu ayarlayacak bir API'si de yok.
  //
  // Çözüm: olayı yakalama fazında durdurup koordinatı düzeltilmiş bir
  // kopyasını aynı hedefe göndermek. xterm'in kendi dinleyicileri (mousedown
  // ekran elemanında, sürükleme boyunca mousemove/mouseup document'te)
  // kopyayı görüyor ve doğru hücreyi hesaplıyor.
  useEffect(() => {
    const onMouse = (e) => {
      // Kendi gönderdiğimiz kopya: dokunmadan geçsin, yoksa sonsuz döngü.
      if (e.zoomCorrected) return;

      // Tuvalin kendi jesti sürerken (kaydırma ya da marquee seçimi) hiç
      // karışma: o olaylar terminalin değil tuvalin matematiğine ait.
      //
      // Aynı şey pane sürükleme/boyutlandırma için de geçerli ve gözden
      // kaçmıştı: `inside` her olayda `e.target`ten yeniden hesaplanıyor,
      // yani sürüklenen pane bir BAŞKA terminalin üstünden geçtiği anda o
      // terminal için `inside` true oluyor ve alttaki `!inside && !dragging`
      // kapısı açılıyor. Zoom 1 değilken bu, jestin her karesinde o terminale
      // sentetik mousedown/mousemove göndermek demek — xterm bunları kendi
      // seçim jesti sanıyor ve metin sürükleme boyunca yanıp sönüyor.
      if (
        document.body.classList.contains('is-canvas-drag') ||
        document.body.classList.contains('is-pane-drag')
      ) {
        return;
      }

      const host = hostRef.current;
      if (!host) return;
      const inside = host.contains(e.target);

      // Sürükleme terminalin dışına taşabilir — kaydırma çubuğuna kadar
      // seçmek bunu gerektiriyor. Nerede başladığını hatırlıyoruz.
      if (e.type === 'mousedown') draggingRef.current = inside;
      const dragging = draggingRef.current;
      if (e.type === 'mouseup') draggingRef.current = false;
      if (!inside && !dragging) return;

      const s = scaleRef.current;
      if (!s || s === 1) return;

      // Ölçüm xterm'in kullandığı elemandan alınmalı: koordinatı .xterm-screen'e
      // göre hesaplıyor, dış kaba göre değil. Aradaki fark .xterm'in kendi
      // padding'i ve düzeltmeyi tam 16 × (1 − s) piksel kaydırıyordu —
      // satırın ortasında fark edilmiyor, birinci sütunda bariz.
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
        // Çift tıklamayla kelime seçimi buna bakıyor: xterm tıklama sayısını
        // detail'den okuyor, kopyada da aynı kalmalı.
        detail: e.detail,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey
      });
      corrected.zoomCorrected = true;
      // Yayılım durur ve mousedown'ın varsayılan davranışı da iptal edilir.
      //
      // İkincisi şart: xterm kendi mousedown dinleyicisinde preventDefault
      // çağırıp odağı yardımcı textarea'sına alıyor, ama o dinleyici artık
      // yalnızca KOPYAYI görüyor — kopyada çağrılan preventDefault ise
      // orijinalin varsayılan davranışını iptal etmiyor. Orijinal dispatch'i
      // bitirdiğinde varsayılan davranış çalışıyor ve mousedown odağı
      // gövdeye taşıyor, yani xterm odağı aldıktan hemen sonra geri
      // kaybediyordu. Sonuç: zoom %100 değilken terminale her tıklayışta
      // imleç sönüyor ve sonraki hiçbir tıklama onu geri getiremiyordu.
      // Burada iptal etmek, ölçeksiz durumda xterm'in zaten yaptığı şey.
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
