import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Rnd } from 'react-rnd';
import TerminalView from './TerminalView.jsx';
import BrowserView, { PageMark, Throbber } from './BrowserView.jsx';
import { ACCENT } from './theme.js';
import { setPaneGeom, deletePaneGeom } from './paneGeometry.js';
import { setPaneTitle, deletePaneTitle } from './paneTitles.js';
import { SIDES } from './Connections.jsx';
import { CloseIcon } from './icons.jsx';

// Home-relative, and only the last two segments: the chrome wants to answer
// "where am I" at a glance, not print an absolute path.
function shortenPath(p) {
  const home = '/Users/';
  let s = p;
  if (s.startsWith(home)) {
    const rest = s.slice(home.length);
    const slash = rest.indexOf('/');
    s = slash === -1 ? '~' : `~${rest.slice(slash)}`;
  }
  const parts = s.split('/').filter(Boolean);
  if (s === '~' || parts.length <= 2) return s;
  return `…/${parts.slice(-2).join('/')}`;
}

// The folder a session is sitting in, which is the part of a path that
// actually identifies a terminal. Home is '~' rather than the account name:
// the account name is the same for every pane and so tells you nothing.
function folderName(p) {
  const short = shortenPath(p);
  if (short === '~') return '~';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '/';
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

// The pane's own identity mark. Exported because the dock names the same
// windows and has to name them with the same glyph.
export function PromptMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <path d="M1.5 2.5L5 5.5L1.5 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" strokeLinejoin="miter" />
      <line x1="6" y1="8.5" x2="9.5" y2="8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
    </svg>
  );
}

export default function TerminalPane({
  pane,
  scale,
  focused,
  selected,
  pendingClose,
  theme,
  onChange,
  onClose,
  onSelect,
  onGroupDragStart,
  onGroupDrag,
  onGroupDragEnd,
  onPortDown
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(pane.title);

  // The committed geometry, republished whenever React knows it changed. The
  // drag and resize handlers below publish the *uncommitted* geometry on every
  // frame; together they are what keeps a rope's endpoint glued to its pane.
  // Layout effect rather than effect: a rope must have its shape on the same
  // paint the pane first appears on, not one frame later.
  useLayoutEffect(() => {
    setPaneGeom(pane.id, { x: pane.x, y: pane.y, w: pane.width, h: pane.height });
  }, [pane.id, pane.x, pane.y, pane.width, pane.height]);

  useEffect(() => () => deletePaneGeom(pane.id), [pane.id]);

  // Live session state, reported up from the view: where the shell is,
  // whether a command is running, and how the last one ended.
  const [status, setStatus] = useState({});
  const handleStatus = useCallback((id, patch) => {
    setStatus((prev) => ({ ...prev, ...patch }));
  }, []);

  const accent = ACCENT[theme];

  // Bir webview ayrı bir WebContents: imleç üzerine girdiği anda ana belge
  // mousemove almayı bırakır ve süren jest guest'in üstünde takılı kalır.
  // İşaret gövdeye konur, panenin kendisine değil — sürüklenen pane başka
  // bir panenin sayfasının üstünden geçtiğinde de aynı şey oluyor.
  const setManipulating = (on) => {
    document.body.classList.toggle('is-pane-drag', on);
  };
  useEffect(() => () => document.body.classList.remove('is-pane-drag'), []);

  // The ticking number is real data changing, which is the one thing here
  // that earns motion.
  const [elapsed, setElapsed] = useState(0);
  const runningSince = status.runningSince ?? null;
  useEffect(() => {
    if (runningSince === null) return undefined;
    setElapsed(Math.floor((Date.now() - runningSince) / 1000));
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - runningSince) / 1000)), 250);
    return () => clearInterval(tick);
  }, [runningSince]);

  // Bir browser panesi, siz ona bir isim verene kadar sayfanın başlığını
  // taşır — sekmenin adını yazan tarayıcı gibi. Elle adlandırıldığı anda o
  // isim kilitlenir ve sayfa değiştikçe silinip gitmez.
  const isBrowser = pane.kind === 'browser';

  // A terminal is named after the work in it, not after the order it was
  // opened in: the folder, and the branch when the folder is in a repo. Three
  // panes called "Terminal 1/2/3" are three panes you have to click to tell
  // apart. The stock name is only what stands there until the first prompt
  // reports where the shell actually is.
  //
  // Renaming locks it, exactly as it does for a browser pane — once you have
  // given a pane a name, cd'ing must not silently take it away.
  const folder = status.cwd ? folderName(status.cwd) : null;
  // Bir worktree klasörü neredeyse her zaman dalın adını taşır, ve o durumda
  // "HR-17123-description-fields -> HR-17123-description-fields" aynı şeyi iki
  // kez söyleyip rayı da başlık çubuğunu da doldurur. Dal klasörden farklıysa
  // yeni bir bilgidir ve yazılır; aynıysa zaten yazılmıştır.
  const sessionName = folder
    ? status.branch && status.branch !== folder
      ? `${folder} -> ${status.branch}`
      : folder
    : null;

  const displayTitle = pane.titleLocked
    ? pane.title
    : (isBrowser ? status.pageTitle : sessionName) ?? pane.title;

  // Published so the dock can print the same name this titlebar does — for a
  // browser that is the page's title, which only exists in here.
  useLayoutEffect(() => {
    setPaneTitle(pane.id, displayTitle);
  }, [pane.id, displayTitle]);

  useEffect(() => () => deletePaneTitle(pane.id), [pane.id]);

  const commitTitle = () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (trimmed) onChange({ title: trimmed, titleLocked: true });
  };

  // Focus and selection are tonal steps off the resting edge rather than a
  // colour swapped in: the focused pane's own identity tint, and a quieter
  // version of it for panes that are merely part of a selection.
  const borderColor = focused
    ? `${accent}b0`
    : selected
      ? `color-mix(in srgb, ${accent} 55%, transparent)`
      : 'var(--pane-border)';

  // display/flexDirection have to be applied inline rather than from .pane's
  // CSS: react-rnd writes its own inline `display` onto this element and an
  // inline style beats a class rule. Without this the pane fell back to
  // display:block, so the screen's `flex: 1 1 auto` did nothing and the
  // terminal grew to its natural height, overflowing the pane by ~160px —
  // which overflow:hidden then cropped, taking the prompt with it.
  const paneStyle = {
    zIndex: pane.z,
    borderColor,
    display: 'flex',
    flexDirection: 'column'
  };

  const statusNode = status.exited ? (
    <span className="pane-status pane-status-dim">sonlandı</span>
  ) : runningSince !== null ? (
    <span className="pane-status">{formatElapsed(elapsed)}</span>
  ) : status.lastExit ? (
    <span className="pane-status pane-status-fail">exit {status.lastExit}</span>
  ) : null;

  return (
    <Rnd
      className={`pane${isBrowser ? ' pane-browser' : ''}${focused ? ' pane-focused' : ''}${
        selected && !focused ? ' pane-selected' : ''
      }${pendingClose ? ' pane-pending-close' : ''}`}
      style={paneStyle}
      size={{ width: pane.width, height: pane.height }}
      position={{ x: pane.x, y: pane.y }}
      scale={scale}
      minWidth={360}
      minHeight={220}
      // No bounds: the canvas has no edges, so a pane can be moved anywhere.
      // The titlebar is the only grip, always. Dragging from the whole surface
      // meant a selected terminal could not be used as a terminal, which is
      // what the Alt escape hatch existed to undo — grip and escape hatch both
      // gone, and the body is simply always the body.
      dragHandleClassName="pane-titlebar"
      // The ports sit on the pane's edges, and the top one overlaps the
      // titlebar — which is the drag handle. Without it listed here, grabbing
      // that port would start dragging the pane instead of pulling a rope.
      cancel=".pane-close, .pane-title-input, .pane-port"
      onDragStart={(e, d) => {
        setManipulating(true);
        onGroupDragStart({ x: d.x, y: d.y });
      }}
      onDrag={(e, d) => {
        // Published every frame because react-rnd keeps this position in its
        // own inline transform and does not report it until onDragStop. A
        // connection reading pane.x/y would freeze here and snap on release.
        setPaneGeom(pane.id, { x: d.x, y: d.y, w: pane.width, h: pane.height });
        onGroupDrag({ x: d.x, y: d.y });
      }}
      onDragStop={(e, d) => {
        setManipulating(false);
        onChange({ x: d.x, y: d.y });
        onGroupDragEnd();
      }}
      onResizeStart={() => {
        setManipulating(true);
        onSelect(false);
      }}
      // There was no onResize at all before: size only landed in state at
      // onResizeStop. Same class of bug as the drag above — an endpoint tied
      // to an edge being resized would lag behind until the mouse came up.
      onResize={(e, dir, ref, delta, position) => {
        setPaneGeom(pane.id, {
          x: position.x,
          y: position.y,
          w: ref.offsetWidth,
          h: ref.offsetHeight
        });
      }}
      onResizeStop={(e, dir, ref, delta, position) => {
        setManipulating(false);
        onChange({
          width: ref.offsetWidth,
          height: ref.offsetHeight,
          x: position.x,
          y: position.y
        });
      }}
      onMouseDown={(e) => onSelect(e.shiftKey)}
    >
      <div className="pane-titlebar">
        {/* The session's identity colour rides on this mark rather than on a
            strip down the edge — a bare glyph, no tile behind it. */}
        {isBrowser ? (
          // Chrome'un sekmesi gibi: yüklenirken favicon'un yerini dönen işaret
          // alır, sonra favicon geri gelir.
          <span className={`pane-icon pane-icon-page${status.loading ? ' pane-icon-busy' : ''}`}>
            {status.loading ? (
              <Throbber />
            ) : status.favicon ? (
              <img
                className="pane-favicon"
                src={status.favicon}
                alt=""
                // Favicon 404 verdiğinde kırık resim ikonu bırakmaktansa
                // küreye düşülür.
                onError={() => handleStatus(pane.id, { favicon: null })}
              />
            ) : (
              <PageMark />
            )}
          </span>
        ) : (
          <span className="pane-icon" style={{ color: accent }}>
            <PromptMark />
          </span>
        )}

        {editingTitle ? (
          <input
            autoFocus
            className="pane-title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle();
              if (e.key === 'Escape') setEditingTitle(false);
            }}
          />
        ) : (
          <span
            className="pane-title"
            onDoubleClick={() => {
              setTitleDraft(displayTitle);
              setEditingTitle(true);
            }}
            title="Yeniden adlandırmak için çift tıklayın"
          >
            {displayTitle}
          </span>
        )}

        {!isBrowser && status.cwd && !status.exited && (
          <span className="pane-cwd" title={status.cwd}>
            {shortenPath(status.cwd)}
          </span>
        )}

        {statusNode}

        <button
          className="pane-close"
          onClick={onClose}
          title="Kapat"
          aria-label={isBrowser ? 'Browser panesini kapat' : 'Terminali kapat'}
        >
          <CloseIcon />
        </button>
      </div>

      {/* Browser panesinde chrome şeridi ekranın üstünde, ekranın içinde
          değil: sayfa terminalin oturduğu aynı gömme yüzeyi kullanır. */}
      {isBrowser ? (
        <BrowserView paneId={pane.id} focused={focused} onStatus={handleStatus} />
      ) : (
        <div className="pane-screen">
          <TerminalView
            tabId={pane.id}
            accent={accent}
            theme={theme}
            scale={scale}
            active
            focused={focused}
            onStatus={handleStatus}
          />
        </div>
      )}

      {/* Connection ports. Square marks flush against the inside of the 1px
          border — .pane is overflow:hidden, so anything hung outside the edge
          would simply be cropped away. They read as tabs cut into the frame
          rather than as handles stuck onto it, which is the only form the
          house rule at the top of styles.css allows: nothing is rounded, so
          there are no dots here. */}
      {SIDES.map((side) => (
        <span
          key={side}
          className={`pane-port pane-port-${side}`}
          onMouseDown={(e) => {
            // Left button only. The middle button is the canvas pan modifier
            // and the right one opens a context menu; neither should be able
            // to start pulling a rope.
            if (e.button !== 0) return;
            // Both are load-bearing: stopPropagation keeps Rnd's own
            // onMouseDown from selecting (and raising) the pane, preventDefault
            // keeps the browser from starting a text-selection drag that would
            // fight the gesture the whole way across the canvas.
            e.stopPropagation();
            e.preventDefault();
            onPortDown?.(side, e);
          }}
          aria-hidden="true"
        />
      ))}

      {pendingClose && <div className="pane-close-veil" aria-hidden="true" />}
    </Rnd>
  );
}
