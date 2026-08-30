import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Rnd } from 'react-rnd';
import TerminalView from './TerminalView.jsx';
import BrowserView, { PageMark, Throbber } from './BrowserView.jsx';
import { ACCENT } from './theme.js';
import { setPaneGeom, deletePaneGeom } from './paneGeometry.js';
import { setPaneTitle, deletePaneTitle } from './paneTitles.js';
import { setPaneCwd, deletePaneCwd } from './paneCwd.js';
import { stripControls } from './session.mjs';
import { deletePaneUrl } from './paneUrls.js';
import { deletePaneRunning, setPaneRunning } from './paneRunning.js';
import { CloseIcon, PlusIcon, StartupIcon } from './icons.jsx';
import { hint } from './shortcuts.jsx';

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

// One session inside a box. Every tab in a pane stays mounted for as long as
// the tab exists and only the one in front is shown — the same arrangement App
// uses for workflows, and for the same reason: switching away from a tab must
// not kill what is running in it. Hidden with display:none rather than
// opacity, because a hidden-but-hittable terminal would still be found under
// the cursor by the drag-target lookup in Workspace.
function PaneTabView({ tab, kind, visible, theme, scale, focused, accent, onStatus }) {
  // The registries are keyed by session, so they are cleaned up by the session
  // that owns them — the pane cannot, because by the time it notices a tab is
  // gone the tab is already unmounted.
  useEffect(
    () => () => {
      deletePaneTitle(tab.id);
      deletePaneCwd(tab.id);
      deletePaneUrl(tab.id);
      deletePaneRunning(tab.id);
    },
    [tab.id]
  );

  return (
    <div className="pane-tab-view" style={visible ? undefined : { display: 'none' }}>
      {kind === 'browser' ? (
        <BrowserView
          paneId={tab.id}
          initialUrl={tab.initialUrl}
          focused={focused && visible}
          onStatus={onStatus}
        />
      ) : (
        <div className="pane-screen">
          <TerminalView
            tabId={tab.id}
            initialCwd={tab.initialCwd}
            startupCommand={tab.command}
            accent={accent}
            theme={theme}
            scale={scale}
            active={visible}
            focused={focused && visible}
            onStatus={onStatus}
          />
        </div>
      )}
    </div>
  );
}

export default function TerminalPane({
  pane,
  scale,
  focused,
  selected,
  pendingClose,
  pendingCloseTabId,
  theme,
  onChange,
  onTabChange,
  onTabSelect,
  onTabReorder,
  onTabClose,
  onTabAdd,
  onClose,
  onSelect,
  onTitlebarMenu,
  onGroupDragStart,
  onGroupDrag,
  onGroupDragEnd
}) {
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(activeTab.title);
  // The startup command field. Open is a state of this pane, not of the app:
  // two panes can have theirs open at once and neither is modal.
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandDraft, setCommandDraft] = useState(activeTab.command ?? '');
  const commandRef = useRef(null);
  const stripRef = useRef(null);
  // A tab drag in progress. Held in a ref because it changes on every pointer
  // frame and none of it is worth a render — the only thing that renders is
  // the order itself, and that only when the order actually changes.
  const tabDragRef = useRef(null);
  const [draggingTabId, setDraggingTabId] = useState(null);

  // The committed geometry, republished whenever React knows it changed. The
  // drag and resize handlers below publish the *uncommitted* geometry on every
  // frame; together they are what keeps the minimap's mark glued to its pane.
  // Layout effect rather than effect: the mark must be in place on the same
  // paint the pane first appears on, not one frame later.
  useLayoutEffect(() => {
    setPaneGeom(pane.id, { x: pane.x, y: pane.y, w: pane.width, h: pane.height });
  }, [pane.id, pane.x, pane.y, pane.width, pane.height]);

  useEffect(() => () => deletePaneGeom(pane.id), [pane.id]);

  // Live session state, reported up from each view: where the shell is,
  // whether a command is running, and how the last one ended. Keyed by tab,
  // because a box now holds several sessions and the title row speaks for
  // whichever one is in front.
  const [statusByTab, setStatusByTab] = useState({});
  const handleStatus = useCallback((id, patch) => {
    // Published as well as kept, because the next terminal to be opened starts
    // in the folder the last used one is in — and Workspace, which creates it,
    // never sees this status.
    if (patch.cwd) setPaneCwd(id, patch.cwd);
    // Published as well as kept, because what decides whether closing asks a
    // question is Workspace, and it never sees this status.
    if ('runningSince' in patch) setPaneRunning(id, patch.runningSince !== null);
    setStatusByTab((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);

  const status = statusByTab[activeTab.id] ?? {};

  useEffect(() => {
    if (!commandOpen) return undefined;
    const onDown = (e) => {
      if (!commandRef.current?.contains(e.target)) setCommandOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setCommandOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [commandOpen]);

  // Stripped on the way in as well as on the way out of the file. A single
  // line means a single command: this field runs what is in it, and a newline
  // that arrived with a paste would quietly make it two. Empty clears it.
  const commitCommand = useCallback(() => {
    const command = stripControls(commandDraft);
    setCommandOpen(false);
    setCommandDraft(command);
    if (command !== (activeTab.command ?? '')) {
      onTabChange(activeTab.id, { command: command || undefined });
    }
  }, [commandDraft, activeTab, onTabChange]);

  // Reordering by dragging, measured against the tabs actually on screen
  // rather than against arithmetic: the strip scrolls, tab widths follow their
  // names, and the canvas is under a zoom. getBoundingClientRect answers all
  // three at once, and the pointer is in the same coordinates.
  //
  // The order is rewritten as you cross a neighbour rather than on release, so
  // the strip shows the arrangement you are choosing while you choose it. No
  // ghost, no gap to animate: the real tab is the one that moves.
  const onTabPointerDown = (e, tab) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    onTabSelect(tab.id);
    tabDragRef.current = { tabId: tab.id, startX: e.clientX, moved: false };
    // Capture keeps the moves coming to this tab even once the pointer has
    // left it, which is most of a drag. It is an optimisation, not the
    // mechanism: where it is refused the strip still reorders, because the
    // moves land on whichever tab is under the pointer and every one of them
    // runs the same handler.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // no capture available; the drag works without it
    }
  };

  const onTabPointerMove = (e) => {
    const drag = tabDragRef.current;
    if (!drag) return;
    // A few pixels of slack, so a click that shifts slightly under the finger
    // is still a click.
    if (!drag.moved && Math.abs(e.clientX - drag.startX) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      setDraggingTabId(drag.tabId);
    }
    const els = [...(stripRef.current?.querySelectorAll('.pane-tab') ?? [])];
    if (!els.length) return;
    // The slot the pointer is in: the first tab whose middle it has not passed,
    // and the end of the strip when it has passed all of them.
    let index = els.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientX < r.left + r.width / 2;
    });
    if (index === -1) index = els.length - 1;
    onTabReorder(drag.tabId, index);
  };

  const endTabDrag = (e) => {
    if (!tabDragRef.current) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // never captured, or already released
    }
    tabDragRef.current = null;
    setDraggingTabId(null);
  };

  const accent = ACCENT[theme];

  // A webview is a separate WebContents: the moment the cursor enters it the
  // host document stops receiving mousemove and the gesture in progress hangs
  // over the guest. The flag goes on the body, not on the pane itself — the
  // same thing happens when a dragged pane crosses another pane's page.
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

  // A browser pane carries the page's title until you give it a name of your
  // own — the way a browser writes the tab's name. Renaming by hand locks that
  // name in, so it is not wiped out as the page changes.
  const isBrowser = pane.kind === 'browser';

  // A terminal is named after the work in it, not after the order it was
  // opened in: the folder, and the branch when the folder is in a repo. Three
  // sessions called "Terminal 1/2/3" are three you have to click to tell
  // apart. The stock name is only what stands there until the first prompt
  // reports where the shell actually is.
  //
  // Renaming locks it, exactly as it does for a browser tab — once you have
  // given a session a name, cd'ing must not silently take it away.
  //
  // Written as a function of a tab rather than of this pane, because the strip
  // names every tab and the title row names the one in front: one derivation,
  // so a tab cannot be called one thing on the strip and another above it.
  const titleOf = useCallback(
    (tab) => {
      if (tab.titleLocked) return tab.title;
      const tabStatus = statusByTab[tab.id] ?? {};
      if (isBrowser) return tabStatus.pageTitle ?? tab.title;
      const folder = tabStatus.cwd ? folderName(tabStatus.cwd) : null;
      if (!folder) return tab.title;
      // A worktree folder almost always carries the branch's name, and in that
      // case "HR-17123-description-fields -> HR-17123-description-fields" says
      // the same thing twice and fills both the rail and the title bar. A
      // branch that differs from the folder is new information and gets
      // written; one that matches has been said already.
      return tabStatus.branch && tabStatus.branch !== folder
        ? `${folder} -> ${tabStatus.branch}`
        : folder;
    },
    [isBrowser, statusByTab]
  );

  const displayTitle = titleOf(activeTab);

  // Names on the strip are made distinct before they are printed. Three
  // terminals opened in one folder are all called after that folder, and three
  // tabs reading "mesa" side by side name nothing — the strip exists to tell
  // them apart. Numbered only where there is a clash, so the ordinary case of
  // differently-named tabs stays clean.
  //
  // Numbered by WHEN the session was opened, never by where it currently sits.
  // Numbering by position would rename a tab the moment you dragged it — pick
  // up "mesa 3", drop it at the front, and it is suddenly "mesa 1" — which
  // takes away the one thing the number was there to give: a name that stays
  // put. Tab ids are handed out in order, so they are that record.
  const stripLabels = useMemo(() => {
    const openedAt = (id) => Number(/-(\d+)$/.exec(id)?.[1] ?? 0);
    const counts = new Map();
    for (const tab of pane.tabs) {
      const name = titleOf(tab);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const nth = new Map();
    const seen = new Map();
    for (const tab of [...pane.tabs].sort((a, b) => openedAt(a.id) - openedAt(b.id))) {
      const name = titleOf(tab);
      if (counts.get(name) === 1) continue;
      const next = (seen.get(name) ?? 0) + 1;
      seen.set(name, next);
      nth.set(tab.id, next);
    }
    return new Map(
      pane.tabs.map((tab) => {
        const name = titleOf(tab);
        return [tab.id, nth.has(tab.id) ? `${name} ${nth.get(tab.id)}` : name];
      })
    );
  }, [pane.tabs, titleOf]);

  // Published so the dock can print the same name this titlebar does — for a
  // browser that is the page's title, which only exists in here. Every tab
  // publishes, not just the one in front: the dock names a window by whichever
  // tab is active, and that changes without any of them remounting.
  useLayoutEffect(() => {
    for (const tab of pane.tabs) setPaneTitle(tab.id, titleOf(tab));
  }, [pane.tabs, titleOf]);

  const commitTitle = () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (trimmed) onTabChange(activeTab.id, { title: trimmed, titleLocked: true });
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
    <span className="pane-status pane-status-dim">exited</span>
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
      // Controls that live ON the drag handle. Without them listed here, a
      // click on the × or in the title field would start dragging the pane
      // instead of doing what the control is for.
      cancel=".pane-close, .pane-title-input"
      onDragStart={(e, d) => {
        setManipulating(true);
        onGroupDragStart({ x: d.x, y: d.y });
      }}
      onDrag={(e, d) => {
        // Published every frame because react-rnd keeps this position in its
        // own inline transform and does not report it until onDragStop. A
        // minimap reading pane.x/y would freeze here and snap on release.
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
      {/* Right-click asks Workspace to put a menu at the pointer. The menu is
          drawn up there rather than in here because this pane lives inside the
          canvas's transform: a menu rendered as a child of it would be scaled
          with the canvas, and unreadable at any zoom below about 70%. */}
      <div
        className="pane-titlebar"
        onContextMenu={
          onTitlebarMenu
            ? (e) => {
                e.preventDefault();
                onTitlebarMenu(e.clientX, e.clientY);
              }
            : undefined
        }
      >
        {/* The session's identity colour rides on this mark rather than on a
            strip down the edge — a bare glyph, no tile behind it. */}
        {isBrowser ? (
          // As on Chrome's tab: the throbber takes the favicon's place while
          // loading, then the favicon comes back.
          <span className={`pane-icon pane-icon-page${status.loading ? ' pane-icon-busy' : ''}`}>
            {status.loading ? (
              <Throbber />
            ) : status.favicon ? (
              <img
                className="pane-favicon"
                src={status.favicon}
                alt=""
                // When the favicon 404s, fall back to the globe rather than
                // leave a broken-image icon.
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
            title="Double-click to rename"
          >
            {displayTitle}
          </span>
        )}

        {/* Always present on a terminal, even with nothing to say — an exited
            session has no folder worth printing, but this span is also the
            row's spring: it is what holds the status, the startup mark and the
            close against the right edge. Dropping it on exit collapsed that
            whole group onto the title, which took the startup panel (it hangs
            off the mark) past the pane's left edge, where the pane clipped
            it. */}
        {!isBrowser && (
          <span className="pane-cwd" title={status.cwd ?? undefined}>
            {status.cwd && !status.exited ? shortenPath(status.cwd) : ''}
          </span>
        )}

        {statusNode}

        {/* Terminals only: a browser pane has no prompt to put a line at, and
            it already carries its own controls in its chrome. The mark stays
            visible once a command is set — that tone IS the answer to "does
            this pane start with something", so no second copy of the command
            has to sit on a row that already has a name and a path on it. */}
        {!isBrowser && (
          <div className="pane-command-anchor" ref={commandRef}>
            <button
              type="button"
              className={`pane-command${activeTab.command ? ' pane-command-set' : ''}${
                commandOpen ? ' pane-command-open' : ''
              }`}
              onClick={() => {
                setCommandDraft(activeTab.command ?? '');
                setCommandOpen((open) => !open);
              }}
              title={activeTab.command ? `Runs on open: ${activeTab.command}` : 'Startup command'}
              aria-label="Startup command"
              aria-expanded={commandOpen}
            >
              <StartupIcon />
            </button>

            {commandOpen && (
              <div className="pane-command-panel">
                <label className="pane-command-label" htmlFor={`startup-${activeTab.id}`}>
                  Runs when this tab opens.
                </label>
                <input
                  id={`startup-${activeTab.id}`}
                  autoFocus
                  className="pane-command-input"
                  value={commandDraft}
                  placeholder="npm run dev"
                  // A command is not prose: the red squiggle under every tool
                  // name is noise, and autocorrect would quietly rewrite one.
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  onChange={(e) => setCommandDraft(e.target.value)}
                  onBlur={commitCommand}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitCommand();
                    if (e.key === 'Escape') setCommandOpen(false);
                  }}
                />
              </div>
            )}
          </div>
        )}

        <button
          className="pane-close"
          onClick={onClose}
          title="Close"
          aria-label={isBrowser ? 'Close browser pane' : 'Close terminal'}
        >
          <CloseIcon />
        </button>
      </div>

      {/* The strip appears only once there is a choice to make. A window with
          one session in it looks exactly as it always has — a row of one tab
          would be a control that answers a question nobody asked. */}
      {pane.tabs.length > 1 && (
        <div className="pane-tabs" role="tablist" aria-label="Sessions" ref={stripRef}>
          {pane.tabs.map((tab, index) => (
            <React.Fragment key={tab.id}>
              {/* A cut between tabs, not a border around them: the strip is
                  one length of material with the sessions scored into it. */}
              {index > 0 && <span className="pane-tab-cut" aria-hidden="true" />}
              <div
                role="tab"
                aria-selected={tab.id === pane.activeTabId}
                className={`pane-tab${tab.id === pane.activeTabId ? ' pane-tab-on' : ''}${
                  tab.id === pendingCloseTabId ? ' pane-tab-pending' : ''
                }${statusByTab[tab.id]?.exited ? ' pane-tab-exited' : ''}${
                  tab.id === draggingTabId ? ' pane-tab-dragging' : ''
                }`}
                onPointerDown={(e) => onTabPointerDown(e, tab)}
                onPointerMove={onTabPointerMove}
                onPointerUp={endTabDrag}
                onPointerCancel={endTabDrag}
              >
                <span className="pane-tab-label">{stripLabels.get(tab.id)}</span>
                <button
                  type="button"
                  className="pane-tab-close"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }}
                  aria-label={`Close ${stripLabels.get(tab.id)}`}
                >
                  <CloseIcon />
                </button>
              </div>
            </React.Fragment>
          ))}
          <button
            type="button"
            className="pane-tab-add"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onTabAdd();
            }}
            title={hint(isBrowser ? 'newBrowser' : 'newTerminal')}
            aria-label="New tab"
          >
            <PlusIcon />
          </button>
        </div>
      )}

      {/* Every tab stays mounted; only the one in front is shown. Switching
          tabs must never kill what is running in the one you left, which is
          the same rule that keeps a workflow's terminals alive while you work
          in another workflow. */}
      {pane.tabs.map((tab) => (
        <PaneTabView
          key={tab.id}
          tab={tab}
          kind={pane.kind}
          visible={tab.id === activeTab.id}
          theme={theme}
          scale={scale}
          focused={focused}
          accent={accent}
          onStatus={handleStatus}
        />
      ))}
    </Rnd>
  );
}
