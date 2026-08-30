import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import TerminalPane from './TerminalPane.jsx';
import Minimap from './Minimap.jsx';
import PaneDock from './PaneDock.jsx';
import RevealMark from './RevealMark.jsx';
import { getTerminalEntry } from './terminalRegistry.js';
import { getPaneGeom } from './paneGeometry.js';
import { getPaneCwd, setPaneCwd } from './paneCwd.js';
import { getPaneUrl, setPaneUrl } from './paneUrls.js';
import { isPaneRunning } from './paneRunning.js';
import { registerWorkspaceActions, unregisterWorkspaceActions } from './workspaceActions.js';
import { SELECTION_COLOR } from './theme.js';
import { Shortcut } from './shortcuts.jsx';
import { TickIcon } from './icons.jsx';
import { editorsFrom, resolveEditor } from './editors.mjs';

// /Users/someone/src/mesa → ~/src/mesa. The rail is naming a folder so you can
// tell it is the right one, not printing a path for you to copy — and a home
// directory spelled out in full pushes the part that actually identifies the
// folder off the end of the line.
//
// A path too long for the rail is cut from the FRONT, because the end is the
// part that says which project this is: every folder truncated the other way
// reads "~/Desktop/mesa/src/…". Cut here, by whole path segments, rather than
// in CSS. The CSS way is `direction: rtl`, and it is wrong for paths: `~`, `/`
// and `…` are all bidi-neutral, so the algorithm reorders the leading `~/` to
// the end and the rail renders `…/legacy-migration/~` — a folder that does not
// exist. textContent still reads correctly while that happens, so it is only
// ever visible in a screenshot.
const HOME = /^\/Users\/[^/]+(?=\/|$)/;
const DIR_BUDGET = 46;

function shortenDir(dir) {
  const short = dir.replace(HOME, '~');
  if (short.length <= DIR_BUDGET) return short;
  const parts = short.split('/');
  // Always keep the last segment, however long it is: a name cut in half is
  // worse than a name with no context.
  let kept = [parts.pop()];
  while (parts.length) {
    const next = parts.pop();
    if (`${next}/${kept.join('/')}`.length + 2 > DIR_BUDGET) break;
    kept = [next, ...kept];
  }
  return `…/${kept.join('/')}`;
}

const CASCADE_STEP = 32;

// A terminal and a browser open at the same size, and the browser is what
// decides that size: the viewport the guest sees is the pane's CSS size (the
// canvas's zoom only scales it visually). At 780px sites drop into their
// narrow-window layout — YouTube hides the sidebar entirely below ~792px and
// only opens the full labelled menu above ~1313px. So panes open wide enough
// to trigger the desktop layout; giving the terminal the same box means two
// panes side by side sit on one grid.
const DEFAULT_SIZE = { width: 1360, height: 780 };
// Widened along with the pan bound coming out. The old ceiling of 2.5x was
// tuned against a view you could not freely aim; now that you can put the
// cursor on a single line of output and drive into it, there is a reason to go
// further in, and a canvas with no fence is a reason to go further out.
const ZOOM_MIN = 0.04;
const ZOOM_MAX = 5;
const DOT_SPACING = 28;

// Zoom steps multiply rather than add, so a given wheel delta is always the
// same *ratio*. Adding a fixed amount would move 32% of the range per event
// at 0.25x but only 3% at 2.5x — the same gesture behaving differently
// depending on where you already were.
//
// The cap keeps one discrete mouse-wheel notch (deltaY ≈ 120) to a sane step
// while leaving a trackpad pinch — which arrives as many small deltas at
// 60Hz — under the cap and fully responsive.
const ZOOM_WHEEL_RATE = 0.002;
const ZOOM_WHEEL_MAX_STEP = 0.12;
const ZOOM_BUTTON_RATIO = 1.1;

// Travelling to a pane from the dock. The trip is animated rather than cut
// because the canvas has no landmarks: a cut leaves you somewhere new with no
// idea which way you came from, while a short glide keeps the two places
// related. Short enough that it never feels like waiting.
const REVEAL_MS = 320;
const REVEAL_PAD = 72;
// How long the arrival marks stay on the canvas. Kept in step with the
// keyframes in styles.css — 320 flying, 200 held, 300 letting go.
const REVEAL_MARK_MS = 820;
// Below this a pane is on screen but not readable, so arriving at it would
// answer the wrong question. Landing zoom is raised to frame it instead.
const REVEAL_LEGIBLE_ZOOM = 0.5;
// And the other end: how much bigger than the window a pane may be and still
// be worth arriving at without zooming out. A pane taller than the viewport is
// the ordinary working state — panes open at 1360x780 and most windows are
// shorter than that — so "does it fit entirely" is the wrong test. It would
// drop the view to ~81% on every single trip and quietly undo the zoom the
// user chose. Past half again the window you would land looking at a fragment,
// and that is when framing wins.
const REVEAL_MAX_OVERFLOW = 1.5;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

// Overshoots its target by about five percent and settles back, so the view
// arrives with a click rather than coasting to a halt. The corner marks run on
// a cubic-bezier in CSS that mirrors this — near enough that the two land
// together, though the bezier's peak sits a hair higher.
//
// Position only. Run on the zoom as well it would carry the scale past its
// target, and past 1.028 of a big zoom-out that lands beyond zero — a negative
// scale, which turns the canvas inside out for a frame. Zoom eases plainly.
const easeOutBack = (t) => {
  const c = 1.14;
  const u = t - 1;
  return 1 + (c + 1) * u ** 3 + c * u ** 2;
};

// The floor used to be "whatever still keeps the canvas covering the
// viewport", which made it depend on the window: 27% on a laptop, 43% on a
// large display, a wall you could feel and could not explain. It existed only
// because the dot field was painted on the canvas box, so anything past that
// box was a void ending in a hard seam. The field is drawn on the viewport
// now and repeats forever, so there is no edge left to protect and the floor
// is just a floor.
const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

// The bounding box of everything open, in canvas coordinates. This replaces
// the old fixed 6000x4000 rectangle as the thing the view is anchored to: the
// canvas has no edges any more, so the only meaningful landmark is the work
// itself. Null when the workspace is empty.
const contentBounds = (panes) => {
  if (!panes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of panes) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x + p.width > maxX) maxX = p.x + p.width;
    if (p.y + p.height > maxY) maxY = p.y + p.height;
  }
  return { minX, minY, maxX, maxY };
};

// There used to be a pan bound here: the centre of everything open was pinned
// to stay on screen, so the work was always one pan away. It was defending a
// real invariant — never let the view get somewhere it cannot come back from —
// but it defended it in the wrong place, and the cost was constant.
//
// Because the bound applied to the *result* of a zoom, zooming toward a point
// away from the panes was silently overruled: the cursor-anchored pan the zoom
// asked for got clipped, and the view slid back toward the panes instead of
// toward the thing being pointed at. A zoom that does not go where you aim it
// is not a zoom.
//
// The invariant survives without the bound, and always did. ⇧⌘0 frames
// everything open at whatever zoom fits, from anywhere, at any scale — a
// deliberate way home beats a fence you feel on every gesture. So the view is
// free now: pan and zoom go exactly where they are aimed.

const rectsIntersect = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

// The folder a new terminal should follow: the one the last used session is
// sitting in. The stack already knows which that is — z is bumped every time a
// pane is opened, selected or dragged — so terminals are read from the top
// down and no separate bookkeeping has to be kept in step with it. Browser
// panes are passed over: they sit in no folder.
//
// A session that has not reported a prompt yet has no folder to give, so the
// search carries on to the one under it rather than dropping straight home.
function lastUsedTerminalCwd(panes) {
  const terminals = panes.filter((p) => p.kind !== 'browser').sort((a, b) => b.z - a.z);
  for (const pane of terminals) {
    // Within one box the tab in front is the session you were last looking
    // at, so it answers before the ones behind it. The stack orders the boxes;
    // this orders what is inside one.
    for (const tab of [
      ...pane.tabs.filter((t) => t.id === pane.activeTabId),
      ...pane.tabs.filter((t) => t.id !== pane.activeTabId)
    ]) {
      const cwd = getPaneCwd(tab.id);
      if (cwd) return cwd;
    }
  }
  return undefined;
}

let counter = 0;
function nextId(prefix) {
  counter += 1;
  return `${prefix}-${counter}`;
}

// Accent indices advance across every session ever opened, so two terminals
// never land on the same tint back to back.
let sessionCounter = 0;

// Both counters start at zero every launch, which is right for a first launch
// and wrong for every restored one: a restored `term-3` followed by a freshly
// minted `term-1` is two panes answering to one id. Seeded from the restored
// session before any workspace mounts, and only ever upward — a workspace that
// mounts later can never pull a counter back under an id already handed out.
export function seedCounters({ pane, session }) {
  counter = Math.max(counter, pane ?? 0);
  sessionCounter = Math.max(sessionCounter, session ?? 0);
}

// Written into the session so a pane that was opened and then closed still
// counts. Without it, closing "Terminal 5" and restoring a file that only
// remembers up to "Terminal 3" would hand out "Terminal 4" again — a number
// this session has already used.
export function readCounters() {
  return { pane: counter, session: sessionCounter };
}

// One session: a terminal or a page. A pane is the box these sit in, and the
// box may hold any number of them — but never a mixture, because a window
// keeps to its own kind.
//
// Numbered off the same counters panes are, since a tab IS what a pane used to
// be: its id is what the pty, the title, the folder and the address are all
// keyed by.
function makeTab(kind, initialCwd) {
  sessionCounter += 1;
  const tab = {
    id: nextId('term'),
    title: kind === 'browser' ? `Browser ${sessionCounter}` : `Terminal ${sessionCounter}`
  };
  if (initialCwd) tab.initialCwd = initialCwd;
  return tab;
}

// The pane objects a workflow opens with. What is on disk is each tab as it
// was; what a tab is created from carries the two "open me here" fields the
// views read on mount, so a saved folder and address arrive the same way an
// inherited folder does on a brand new terminal.
function hydratePanes(saved) {
  return (saved ?? []).map((pane) => ({
    ...pane,
    tabs: pane.tabs.map(({ cwd, url, ...tab }) => ({
      ...tab,
      ...(cwd ? { initialCwd: cwd } : {}),
      ...(url ? { initialUrl: url } : {})
    }))
  }));
}

// One workflow: its own canvas, its own terminals, its own view. Every open
// workflow stays mounted — a workflow you switched away from is usually the
// one with something running in it — and only the active one is visible.
export default function Workspace({
  workflowId,
  theme,
  active,
  initialState,
  // Held back while the onboarding cards are up. They print the same keys, on
  // the same canvas, over the top of this — two legends at once reads as a
  // mistake rather than as emphasis.
  hideEmptyHint = false,
  // The editor ⌘E uses, and the way to record a new answer. Owned by App
  // because the flags file is one file for the whole app, not one per canvas.
  editorPref = null,
  onEditorChosen,
  onDirty,
  onRequestClose
}) {
  // Read once, on mount, and never again. A restored session is a seed, not a
  // binding: the moment this workspace is on screen the user owns its state,
  // and following the prop afterwards would put the file and the canvas in a
  // fight over which of them is the workflow.
  const [panes, setPanes] = useState(() => hydratePanes(initialState?.panes));
  const [zoom, setZoom] = useState(() => clampZoom(initialState?.view?.zoom ?? 1));
  const [selectedIds, setSelectedIds] = useState([]);
  const [isPanning, setIsPanning] = useState(false);
  const [isMarqueeSelecting, setIsMarqueeSelecting] = useState(false);
  const [marqueeRect, setMarqueeRect] = useState(null);
  const [pendingClose, setPendingClose] = useState(null);
  // The editor question, standing: which folder it was asked about and which
  // editors this Mac actually has. Null the rest of the time — nothing is
  // scanned, and no rail is drawn, until ⌘E is pressed.
  const [editorChoice, setEditorChoice] = useState(null);
  // The title bar menu: which folder, which editors, and where the pointer
  // was. Positioned in window coordinates because it is drawn outside the
  // canvas transform — see the comment on TerminalPane's onContextMenu.
  const [paneMenu, setPaneMenu] = useState(null);
  const paneMenuRef = useRef(null);

  // "Something here is worth writing down." Held in a ref so the workspace can
  // say it from inside a pan — which runs on every mousemove — without the
  // callback identity re-rendering anything.
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;

  const minimapApiRef = useRef(null);

  // The arrival: which pane is being landed on, and a token that changes on
  // every trip so the marks remount and replay even when you reveal the same
  // pane twice in a row.
  const [reveal, setReveal] = useState(null);
  const revealTokenRef = useRef(0);
  const revealTimersRef = useRef([]);
  const clearRevealTimers = useCallback(() => {
    revealTimersRef.current.forEach(clearTimeout);
    revealTimersRef.current = [];
  }, []);

  // The reveal glide is the only thing in here that moves the view on its own,
  // so any deliberate input has to be able to take the wheel back off it
  // mid-flight. Every gesture that moves the view calls this first.
  const revealRafRef = useRef(null);
  const cancelReveal = useCallback(() => {
    if (revealRafRef.current !== null) {
      cancelAnimationFrame(revealRafRef.current);
      revealRafRef.current = null;
    }
  }, []);
  useEffect(
    () => () => {
      cancelReveal();
      clearRevealTimers();
    },
    [cancelReveal, clearRevealTimers]
  );

  // Restored panes carry the stacking they were left in, so the counter has to
  // resume above the highest of them or the next pane opened would land under
  // panes that were already there.
  const zCounter = useRef(
    (initialState?.panes ?? []).reduce((top, p) => Math.max(top, p.z ?? 1), 1)
  );
  // Defined up here because the keyboard effect below lists it as a
  // dependency, and a dependency array is read during render — a const
  // declared further down would still be in its temporal dead zone.
  const selectTab = useCallback((paneId, tabId) => {
    setPanes((prev) => prev.map((p) => (p.id === paneId ? { ...p, activeTabId: tabId } : p)));
  }, []);

  const canvasRef = useRef(null);
  const panStateRef = useRef(null);
  const spacePressedRef = useRef(false);
  const marqueeStateRef = useRef(null);
  const marqueeRectRef = useRef(null);
  const groupDragRef = useRef(null);
  const panesRef = useRef(panes);
  const selectedIdsRef = useRef(selectedIds);

  // zoom/pan are mirrored into refs and the refs are the source of truth for
  // every mutation. Two reasons this matters:
  //  1. A wheel burst fires many events inside one frame; reading the ref
  //     lets each event compose onto the previous one instead of onto a
  //     stale render value.
  //  2. It keeps us out of nested setState updaters. React 18 may invoke an
  //     updater more than once (eager state evaluation), so a setPan() called
  //     from inside a setZoom() updater could apply the pan twice — which
  //     showed up as the viewport jumping unpredictably on every zoom step.
  const zoomRef = useRef(clampZoom(initialState?.view?.zoom ?? 1));
  const panRef = useRef({
    x: initialState?.view?.pan?.x ?? 0,
    y: initialState?.view?.pan?.y ?? 0
  });
  const contentRef = useRef(null);
  const gridRef = useRef(null);
  const gridZoomRef = useRef(null);

  useEffect(() => {
    panesRef.current = panes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panes]);
  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);

  // The transform is written straight to the DOM rather than going through
  // React state. Pan fires on every wheel tick and every mousemove; routing
  // that through setState would re-render App — and therefore every open
  // TerminalPane, xterm instances included — 60+ times a second, which is
  // what made panning feel sluggish and stuttery. Nothing else reads pan
  // during render, so there is no reason for React to know about it at all.
  //
  // zoom still lives in state because panes need it (Rnd's drag math and the
  // terminal's scroll sensitivity both take `scale` as a prop), but it only
  // changes on deliberate zoom input, not continuously while panning.
  const commitView = useCallback((nextZoom, nextPan) => {
    const zoomForView = nextZoom ?? zoomRef.current;
    // Taken exactly as asked. Nothing corrects it, which is the point: the
    // offset a cursor-anchored zoom solves for is the offset that gets used.
    if (nextPan) panRef.current = nextPan;

    const el = contentRef.current;
    if (el) {
      const { x, y } = panRef.current;
      el.style.transform = `translate(${x}px, ${y}px) scale(${zoomForView})`;
    }

    // The surface is a viewport-sized layer, so panning moves the pattern's
    // origin and zooming changes its pitch — it never runs out. The dot's
    // radius has to track the zoom by hand: it lives inside the gradient, and
    // that used to be scaled by the same transform as the spacing. Leave it
    // at a flat 1px and a 2.8px pitch at 10% turns the field into a haze.
    const grid = gridRef.current;
    if (grid) {
      if (gridZoomRef.current !== zoomForView) {
        gridZoomRef.current = zoomForView;
        const pitch = DOT_SPACING * zoomForView;
        grid.style.backgroundSize = `${pitch}px ${pitch}px`;
        grid.style.backgroundImage =
          `radial-gradient(var(--dot) ${zoomForView}px, transparent ${zoomForView}px)`;
      }
      const { x, y } = panRef.current;
      grid.style.backgroundPosition = `${x}px ${y}px`;
    }

    if (nextZoom !== undefined && nextZoom !== zoomRef.current) {
      zoomRef.current = nextZoom;
      setZoom(nextZoom);
    }

    // The minimap frames the viewport, so it has to be told on the same frame
    // the viewport moves. Called imperatively for the same reason the transform
    // above is written by hand: routing a pan through React would re-render
    // every open terminal sixty times a second.
    //
    // AFTER the zoom commit above, not before. sync() derives the viewport
    // rectangle from zoomRef, so running it first would size that rectangle
    // with the zoom we are in the middle of leaving — the frame would trail one
    // step behind on every single zoom.
    minimapApiRef.current?.sync();
    onDirtyRef.current?.();
  }, []);

  // Put a canvas point in the middle of the window at the current zoom. The
  // minimap's whole interaction is this one move, repeated as you drag.
  const centerOn = useCallback(
    (point) => {
      const container = canvasRef.current;
      if (!container) return;
      cancelReveal();
      const z = zoomRef.current;
      commitView(undefined, {
        x: container.clientWidth / 2 - point.x * z,
        y: container.clientHeight / 2 - point.y * z
      });
    },
    [commitView, cancelReveal]
  );

  // Panning is a CSS translate driven by state — .canvas is deliberately NOT
  // a native scroll container (overflow: hidden), so a terminal's internal
  // scrollback has nothing to chain into even when it hits its own boundary.
  // Zoom keeps the point under the cursor pinned: solve for the pan that
  // leaves screen point `mouse` mapping to the same content point after the
  // scale changes by `ratio`.
  const applyZoom = useCallback(
    (computeNext, clientX, clientY) => {
      const container = canvasRef.current;
      if (!container) return;
      cancelReveal();
      const oldZoom = zoomRef.current;
      const nextZoom = clampZoom(computeNext(oldZoom));
      if (nextZoom === oldZoom) return;

      const rect = container.getBoundingClientRect();
      const mouseX = (clientX ?? rect.left + rect.width / 2) - rect.left;
      const mouseY = (clientY ?? rect.top + rect.height / 2) - rect.top;
      const ratio = nextZoom / oldZoom;
      const oldPan = panRef.current;

      commitView(nextZoom, {
        x: mouseX - (mouseX - oldPan.x) * ratio,
        y: mouseY - (mouseY - oldPan.y) * ratio
      });
    },
    [commitView, cancelReveal]
  );

  const panBy = useCallback(
    (dx, dy) => {
      cancelReveal();
      const { x, y } = panRef.current;
      commitView(undefined, { x: x + dx, y: y + dy });
    },
    [commitView, cancelReveal]
  );

  // Start with the canvas origin under the middle of the window. There is no
  // box to centre any more, so the origin is simply where the first pane will
  // be placed, and putting it in the middle leaves room to open up in every
  // direction rather than only down and to the right.
  //
  // A restored workflow has somewhere it already belongs, and this is the
  // effect that would take it away: it runs on mount and would push a view
  // that was saved at a deliberate place back to the origin. So a restored
  // view is committed as it is, and only a workflow that has never been
  // anywhere gets centred.
  useLayoutEffect(() => {
    // Restored panes have reported nothing yet — no prompt has printed, no
    // guest has navigated — so the registries the session is read out of are
    // empty until they do. Seeding them from the file is what lets the next
    // terminal open in the right folder, and what keeps a session saved
    // before the first prompt from forgetting where everything was.
    //
    // Seeded from the TABS, which is where a folder and an address have lived
    // since a pane became a box of sessions. This read the pane instead, and a
    // pane has carried neither field since that change — so `pane.cwd` was
    // always undefined and the loop had been doing nothing at all. The comment
    // above it stayed true the whole time; only the code had moved on. Both
    // registries are keyed by tab id everywhere else (see setPaneCwd calls in
    // addTab and TerminalPane), so seeding by pane id would have missed even
    // if the field had been there.
    for (const pane of initialState?.panes ?? []) {
      for (const tab of pane.tabs ?? []) {
        if (tab.cwd) setPaneCwd(tab.id, tab.cwd);
        if (tab.url) setPaneUrl(tab.id, tab.url);
      }
    }

    const container = canvasRef.current;
    if (!container) return;
    if (initialState?.view) {
      // The transform is written by hand rather than rendered, so a restored
      // view is not on screen until something commits it — and it has to be
      // the first paint, or the canvas visibly jumps into place.
      commitView();
      return;
    }
    commitView(undefined, {
      x: container.clientWidth / 2,
      y: container.clientHeight / 2
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The same view, committed once more after the tree has settled. The layout
  // effect above runs while refs are still being attached, so the minimap's
  // own first sync finds no canvas to measure the viewport against and draws
  // nothing. A workflow that opens empty never notices — the first pane
  // opened syncs it — but a restored one opens with its panes already in
  // place and nothing after mount would ever ask again, leaving the map blank
  // until the first pan. Passive effects run after every ref is attached and
  // after the minimap has published its api, so by here there is a canvas to
  // measure and someone to tell.
  useEffect(() => {
    commitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zoomIn = useCallback(() => applyZoom((z) => z * ZOOM_BUTTON_RATIO), [applyZoom]);
  const zoomOut = useCallback(() => applyZoom((z) => z / ZOOM_BUTTON_RATIO), [applyZoom]);
  const zoomReset = useCallback(() => applyZoom(() => 1), [applyZoom]);

  // The safety net for an unbounded canvas, and now the ONLY one: frame
  // everything that is open, at whatever zoom makes it fit. With the pan bound
  // gone this carries the whole "you can always get back" guarantee by itself,
  // which is why it works from any offset and any scale rather than nudging
  // the view — however far out you have wandered, this is the move that
  // answers "where did everything go".
  const fitToContent = useCallback(() => {
    const container = canvasRef.current;
    const box = contentBounds(panesRef.current);
    if (!container || !box) return;
    cancelReveal();
    const PAD = 80;
    const width = box.maxX - box.minX;
    const height = box.maxY - box.minY;
    const nextZoom = clampZoom(
      Math.min(
        (container.clientWidth - PAD * 2) / width,
        (container.clientHeight - PAD * 2) / height
      )
    );
    commitView(nextZoom, {
      x: container.clientWidth / 2 - ((box.minX + box.maxX) / 2) * nextZoom,
      y: container.clientHeight / 2 - ((box.minY + box.maxY) / 2) * nextZoom
    });
  }, [commitView, cancelReveal]);

  // Space (or the middle mouse button) pans; a plain left-drag on empty
  // canvas draws a marquee selection instead. Two-finger scroll pans too —
  // see the wheel arbiter below.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code !== 'Space') return;
      // A focused terminal owns the spacebar — it is a character being typed,
      // not a pan modifier. (Panes take keyboard focus now, so without this
      // every space typed at a prompt would also arm canvas panning.)
      if (e.target instanceof Element && e.target.closest('.pane')) return;
      spacePressedRef.current = true;
    };
    const onKeyUp = (e) => {
      if (e.code === 'Space') spacePressedRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Screen coordinates -> canvas-content coordinates (undo the translate,
  // then undo the scale). Reads refs so it never goes stale mid-gesture.
  const localPointFromEvent = useCallback((e) => {
    const container = canvasRef.current;
    const rect = container.getBoundingClientRect();
    const pan = panRef.current;
    const zoom = zoomRef.current;
    return {
      x: (e.clientX - rect.left - pan.x) / zoom,
      y: (e.clientY - rect.top - pan.y) / zoom
    };
  }, []);

  const handleCanvasMouseDown = useCallback(
    (e) => {
      // Empty canvas means the viewport itself. The content layer is a bare
      // transform origin with no size, so it is never a hit target; it stays
      // in the test only because it costs nothing and keeps the gesture
      // correct if it is ever given dimensions again.
      if (e.target !== canvasRef.current && e.target !== contentRef.current) return;

      cancelReveal();

      if (spacePressedRef.current || e.button === 1) {
        panStateRef.current = { startX: e.clientX, startY: e.clientY, startPan: panRef.current };
        setIsPanning(true);
        return;
      }

      if (e.button !== 0) return;

      const point = localPointFromEvent(e);
      marqueeStateRef.current = { startX: point.x, startY: point.y, additive: e.shiftKey };
      const initialRect = { x: point.x, y: point.y, width: 0, height: 0 };
      marqueeRectRef.current = initialRect;
      setMarqueeRect(initialRect);
      setIsMarqueeSelecting(true);
    },
    [localPointFromEvent, cancelReveal]
  );

  useEffect(() => {
    if (!isPanning) return undefined;
    const onMouseMove = (e) => {
      const state = panStateRef.current;
      if (!state) return;
      commitView(undefined, {
        x: state.startPan.x + (e.clientX - state.startX),
        y: state.startPan.y + (e.clientY - state.startY)
      });
    };
    const onMouseUp = () => {
      panStateRef.current = null;
      setIsPanning(false);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isPanning, commitView]);

  useEffect(() => {
    if (!isMarqueeSelecting) return undefined;
    const onMouseMove = (e) => {
      const state = marqueeStateRef.current;
      if (!state) return;
      const point = localPointFromEvent(e);
      const rect = {
        x: Math.min(state.startX, point.x),
        y: Math.min(state.startY, point.y),
        width: Math.abs(point.x - state.startX),
        height: Math.abs(point.y - state.startY)
      };
      marqueeRectRef.current = rect;
      setMarqueeRect(rect);
    };
    const onMouseUp = () => {
      const state = marqueeStateRef.current;
      const rect = marqueeRectRef.current;
      if (state && rect) {
        const hits = panesRef.current.filter((p) => rectsIntersect(rect, p)).map((p) => p.id);
        setSelectedIds((prev) => {
          if (!state.additive) return hits;
          const set = new Set(prev);
          hits.forEach((id) => set.add(id));
          return Array.from(set);
        });
      }
      marqueeStateRef.current = null;
      marqueeRectRef.current = null;
      setMarqueeRect(null);
      setIsMarqueeSelecting(false);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isMarqueeSelecting, localPointFromEvent]);

  // ───────────────────────────────────────────────────────────────────────
  // WHEEL ROUTING — deliberately stateless: whatever is under the cursor
  // right now handles the event. No gesture locks, no timers, no swallowed
  // input. Every wheel tick does the obvious thing immediately.
  //
  // Registered on .canvas in the CAPTURE phase so it runs before xterm's own
  // listener (which sits on the screen element inside each pane, in the
  // bubble phase). That ordering is what lets the zoom branch claim an event
  // outright via stopPropagation.
  //
  // Scroll chaining — the original bug, where a terminal hitting its
  // scrollback boundary leaked the scroll out to the workspace — is
  // structurally impossible now: .canvas is overflow:hidden and panning is a
  // CSS transform, so there is no scrollable ancestor for anything to chain
  // into. That is why this handler can afford to be so simple.
  // ───────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;

    const onWheel = (e) => {
      // Zoom wins over everything. macOS pinch arrives as ctrlKey wheel
      // events; stopPropagation keeps xterm from also scrolling underneath.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        const step = Math.max(
          -ZOOM_WHEEL_MAX_STEP,
          Math.min(ZOOM_WHEEL_MAX_STEP, -e.deltaY * ZOOM_WHEEL_RATE)
        );
        applyZoom((z) => z * Math.exp(step), e.clientX, e.clientY);
        return;
      }

      // Over a terminal: scroll it explicitly, in buffer lines.
      //
      // xterm v5 normally scrolls its scrollback by letting the browser
      // natively scroll .xterm-viewport. That breaks down here because the
      // panes live inside a CSS scale() transform: wheel deltas arrive in
      // screen pixels while scrollTop lives in the pane's own unscaled
      // coordinates, so the amount scrolled drifts with the zoom level and
      // the DOM scroll position desyncs from xterm's own viewport tracking —
      // which is what left the view stuck away from the prompt, refusing to
      // scroll down until it had been scrolled up first.
      //
      // Driving term.scrollLines() ourselves sidesteps all of it: it works in
      // lines, is immune to the transform, and lets xterm keep DOM and buffer
      // in sync the way it does for its own output. Fractional leftovers
      // carry over so slow trackpad deltas still accumulate smoothly.
      //
      // Note we do NOT fall through to panning at the scrollback boundary.
      // Hitting the top or bottom of a terminal simply stops, exactly like
      // every other terminal — chaining into a canvas pan there meant reading
      // to the end of some output sent the whole workspace flying.
      const overTerminal = e.target instanceof Element && e.target.closest('.pane-body');
      if (overTerminal) {
        const entry = getTerminalEntry(overTerminal.dataset.terminalId);
        // Alt-screen programs (vim, less, htop) want the raw event so xterm
        // can translate it into the arrow keys / mouse reports they expect.
        if (!entry || entry.term.buffer.active.type === 'alternate') return;

        e.preventDefault();
        const lineHeight = overTerminal.querySelector('.xterm-viewport')?.scrollHeight
          / Math.max(1, entry.term.buffer.active.length);
        if (!lineHeight || !Number.isFinite(lineHeight)) return;

        const wanted = entry.remainder + e.deltaY / lineHeight;
        const lines = Math.trunc(wanted);
        entry.remainder = wanted - lines;
        if (lines !== 0) entry.term.scrollLines(lines);
        return;
      }

      // Empty canvas, a titlebar, a pane border — pan the workspace.
      e.preventDefault();
      panBy(-e.deltaX, -e.deltaY);
    };

    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
  }, [applyZoom, panBy]);

  // Held in a ref for the same reason the selection is: the key listener below
  // is attached once and would otherwise close over the preference as it was
  // when the workspace mounted.
  const editorPrefRef = useRef(editorPref);
  editorPrefRef.current = editorPref;

  // ⌘E hands the selected terminal's folder to an editor. Mesa does not embed
  // one — see src/editors.mjs for why that is not a thing this app can do —
  // so the folder goes out to the editor already installed.
  //
  // The folder comes from the session's own cwd registry, which is fed by OSC 7
  // on every prompt, so it is where the shell is NOW rather than where it
  // started. A terminal you have cd'd into a subdirectory opens there.
  // The folder a pane is showing, or null when there is nothing to open: a
  // browser pane has no folder, and neither does a terminal whose shell has
  // not printed a prompt yet.
  const folderOf = useCallback((paneId) => {
    const pane = panesRef.current.find((p) => p.id === paneId);
    if (!pane || pane.kind !== 'terminal') return null;
    return getPaneCwd(pane.activeTabId) ?? null;
  }, []);

  // Opening and remembering are the same act. Every route in — ⌘E's first
  // question, the rail, the title bar menu — goes through here, so choosing an
  // editor anywhere is choosing it everywhere.
  const useEditor = useCallback(
    (editor, dir) => {
      window.terminalApi.openInEditor(editor.app, dir);
      onEditorChosen?.(editor.app);
    },
    [onEditorChosen]
  );

  // Picks an application by hand and uses it. The way in for an editor the
  // known list has never heard of, and the whole of ⌘E on a Mac that has none
  // of them: rather than doing nothing, the shortcut asks.
  const pickApplication = useCallback(
    async (dir) => {
      const app = await window.terminalApi.chooseApplication();
      if (app) useEditor({ app, label: app }, dir);
    },
    [useEditor]
  );

  const openFolderInEditor = useCallback(
    async (askWhich) => {
      const selected = selectedIdsRef.current;
      if (selected.length !== 1) return;
      const dir = folderOf(selected[0]);
      if (!dir) return;

      const editors = editorsFrom(
        await window.terminalApi.listApplications(),
        editorPrefRef.current
      );
      // No editor this app recognises, and nothing chosen by hand before. The
      // shortcut used to return here and look broken; now it asks the one
      // question it can ask.
      if (!editors.length) {
        setEditorChoice(null);
        await pickApplication(dir);
        return;
      }

      const remembered = askWhich ? null : resolveEditor(editorPrefRef.current, editors);
      // Straight through on the remembered one — and note it is not put through
      // useEditor, because re-recording the answer someone already gave is not
      // a decision, and would keep the file being written on every ⌘E.
      if (remembered) {
        window.terminalApi.openInEditor(remembered.app, dir);
        return;
      }
      setEditorChoice({ dir, editors });
    },
    [folderOf, pickApplication]
  );

  const chooseEditor = useCallback(
    (editor) => {
      const choice = editorChoice;
      setEditorChoice(null);
      if (choice) useEditor(editor, choice.dir);
    },
    [editorChoice, useEditor]
  );

  // Right-click on a title bar. The editors are read before the menu is drawn
  // rather than after, so it opens with its items already in it — a menu that
  // fills in a frame later reads as a stutter.
  const openTitlebarMenu = useCallback(
    async (paneId, x, y) => {
      const dir = folderOf(paneId);
      if (!dir) return; // a browser pane, or a terminal with nothing to say yet
      const editors = editorsFrom(
        await window.terminalApi.listApplications(),
        editorPrefRef.current
      );
      // The pointer arrives in window coordinates and the menu is positioned
      // inside the canvas box, which starts below the workflow strip.
      const box = canvasRef.current?.getBoundingClientRect();
      setPaneMenu({ dir, editors, x: x - (box?.left ?? 0), y: y - (box?.top ?? 0) });
    },
    [folderOf]
  );

  const chooseFromMenu = useCallback(
    (editor) => {
      const menu = paneMenu;
      setPaneMenu(null);
      if (menu) useEditor(editor, menu.dir);
    },
    [paneMenu, useEditor]
  );

  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (e) => {
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomOut();
      } else if (e.code === 'Digit0') {
        // Shift turns the key into ')' on most layouts, so match the physical
        // key rather than the character it produces.
        e.preventDefault();
        if (e.shiftKey) fitToContent();
        else zoomReset();
      } else if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        addTerminal('terminal');
      } else if (e.key.toLowerCase() === 'b') {
        e.preventDefault();
        addTerminal('browser');
      } else if (/^Digit[1-9]$/.test(e.code) && !e.altKey) {
        // The digits reach the sessions inside the selected window, the way
        // they do in every tabbed thing. Held with alt they belong to the
        // workflow rail, which App listens for — so this hands them over
        // rather than swallowing them.
        const selected = selectedIdsRef.current;
        if (selected.length !== 1) return;
        const pane = panesRef.current.find((p) => p.id === selected[0]);
        const tab = pane?.tabs[Number(e.code.slice(-1)) - 1];
        if (!tab) return;
        e.preventDefault();
        selectTab(pane.id, tab.id);
      } else if (e.key.toLowerCase() === 'e') {
        // Swallowed whether or not there is a terminal to act on, the way ⌘W
        // is: a shortcut that sometimes falls through to whatever else claims
        // ⌘E reads as broken rather than as inapplicable.
        e.preventDefault();
        openFolderInEditor(e.shiftKey);
      } else if (e.key.toLowerCase() === 'w') {
        // Always swallowed, even with nothing selected: ⌘W must never fall
        // through to closing the workspace.
        e.preventDefault();
        closeSelected();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, zoomIn, zoomOut, zoomReset, fitToContent, selectTab, openFolderInEditor]);

  // A new session joins the selected window when that window is the same kind,
  // and opens its own window otherwise. A terminal and a page are different
  // tools with different chrome, so a box that held both would have to answer
  // to two title bars at once.
  const addTab = useCallback((paneId, kind) => {
    // Read outside the updater, which React may run more than once: a counter
    // advanced twice would skip a number, and a folder read twice is wasted
    // work.
    const inheritedCwd = kind === 'browser' ? undefined : lastUsedTerminalCwd(panesRef.current);
    const tab = makeTab(kind, inheritedCwd);
    setPanes((prev) =>
      prev.map((p) => (p.id === paneId ? { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id } : p))
    );
    setPaneCwd(tab.id, inheritedCwd);
  }, []);

  // Dragging one session past another on the strip. The order is the user's
  // to keep — which terminal sits where is part of how a window is read — so
  // it is state, and it is written to the session with everything else.
  const reorderTab = useCallback((paneId, tabId, toIndex) => {
    setPanes((prev) =>
      prev.map((pane) => {
        if (pane.id !== paneId) return pane;
        const from = pane.tabs.findIndex((t) => t.id === tabId);
        if (from === -1 || from === toIndex) return pane;
        const tabs = [...pane.tabs];
        const [moved] = tabs.splice(from, 1);
        tabs.splice(toIndex, 0, moved);
        return { ...pane, tabs };
      })
    );
  }, []);

  const updateTab = useCallback((paneId, tabId, patch) => {
    setPanes((prev) =>
      prev.map((p) =>
        p.id === paneId
          ? { ...p, tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) }
          : p
      )
    );
  }, []);

  const addTerminal = useCallback(
    (kind = 'terminal') => {
      // Aimed at the selected window when it can take this kind of session.
      // One selected window only: with several selected there is no single
      // answer to "which of you", and opening a new window is the honest one.
      const selected = selectedIdsRef.current;
      const target =
        selected.length === 1
          ? panesRef.current.find((p) => p.id === selected[0] && p.kind === kind)
          : null;
      if (target) {
        addTab(target.id, kind);
        return;
      }

      // Read the view once, outside the updater: this converts the centre of
      // whatever is currently on screen into canvas coordinates, so a new pane
      // lands in front of the user wherever they have panned or zoomed to,
      // rather than back at a fixed corner of a 6000x4000 canvas.
      const rect = canvasRef.current?.getBoundingClientRect();
      const zoomNow = zoomRef.current;
      const panNow = panRef.current;

      // A new terminal opens where the last one you used is sitting, the way a
      // new tab does in a terminal app: you almost always want the folder you
      // were just working in, not the home directory. Undefined until the first
      // session has reported a prompt, and the shell falls back to home then.
      const inheritedCwd = kind === 'browser' ? undefined : lastUsedTerminalCwd(panesRef.current);
      const id = nextId('pane');
      const tab = makeTab(kind, inheritedCwd);

      setPanes((prev) => {
        const index = prev.length;
        zCounter.current += 1;

        // A small step per pane keeps successive terminals from landing exactly
        // on top of each other; it is centred on the offset run so the group
        // stays balanced around the middle instead of drifting off one way.
        const step = (index % 5) - 2;
        const offset = step * CASCADE_STEP;

        const size = DEFAULT_SIZE;

        let x = 48 + offset;
        let y = 48 + offset;
        if (rect) {
          x = (rect.width / 2 - panNow.x) / zoomNow - size.width / 2 + offset;
          y = (rect.height / 2 - panNow.y) / zoomNow - size.height / 2 + offset;
        }

        const pane = {
          id,
          x,
          y,
          width: size.width,
          height: size.height,
          z: zCounter.current,
          kind,
          tabs: [tab],
          activeTabId: tab.id
        };
        setSelectedIds([id]);
        return [...prev, pane];
      });

      // Published straight away so a run of new terminals opened before any of
      // them has printed a prompt still follows the same folder, rather than the
      // second one falling back to home.
      setPaneCwd(tab.id, inheritedCwd);
    },
    [addTab]
  );

  // This workflow, as it would be written to disk. Asked for rather than
  // published: App holds no pane state and gains none by saving — it calls
  // this at the moment a write is due and the panes never leave this
  // component, which is the same arrangement the title bar's buttons use.
  //
  // Read entirely out of refs, so it is correct whenever it is called,
  // including mid-drag and mid-pan when React has not re-rendered yet.
  const serialize = useCallback(
    () => ({
      view: { zoom: zoomRef.current, pan: { ...panRef.current } },
      panes: panesRef.current.map((pane) => ({
        id: pane.id,
        kind: pane.kind === 'browser' ? 'browser' : 'terminal',
        x: pane.x,
        y: pane.y,
        width: pane.width,
        height: pane.height,
        z: pane.z,
        activeTabId: pane.activeTabId,
        tabs: pane.tabs.map((tab) => {
          const saved = {
            id: tab.id,
            // The session's own name, not the one it is currently wearing: a
            // browser shows the page's title until it is renamed, and that
            // title belongs to the page, which will supply it again on its own
            // when the page loads back.
            title: tab.title,
            titleLocked: tab.titleLocked === true
          };
          // The live values, not the ones the tab opened with. A terminal's
          // folder moves with every cd, and a browser's address with every
          // link — neither is what is on the tab object.
          if (pane.kind === 'browser') {
            const url = getPaneUrl(tab.id);
            if (url) saved.url = url;
          } else {
            const cwd = getPaneCwd(tab.id);
            if (cwd) saved.cwd = cwd;
            // Unlike the folder and the address, this one is not reported from
            // inside the session: it is something the user set ON the tab, so
            // the tab object is where it lives and where it is read from.
            if (tab.command) saved.command = tab.command;
          }
          return saved;
        })
      }))
    }),
    []
  );

  // The title bar's "new terminal" and "new browser" live outside this
  // component, so what they call has to be reachable from outside it.
  // How many sessions in this workflow have a command in flight. Asked for
  // rather than published, like serialize: it is read at the one moment a
  // workflow is about to close, and pushing it up on every command would
  // re-render App — and with it every open terminal — each time any shell in
  // any workflow started or finished anything.
  const runningCount = useCallback(
    () =>
      panesRef.current.reduce(
        (n, pane) =>
          pane.kind === 'browser'
            ? n
            : n + pane.tabs.filter((tab) => isPaneRunning(tab.id)).length,
        0
      ),
    []
  );

  useEffect(() => {
    registerWorkspaceActions(workflowId, { addTerminal, serialize, runningCount });
    return () => unregisterWorkspaceActions(workflowId);
  }, [workflowId, addTerminal, serialize, runningCount]);

  // Everything that changes what this workflow *is* passes through one of
  // these two. Pan is the exception and reports itself from commitView,
  // because it never becomes state at all.
  useEffect(() => {
    onDirtyRef.current?.();
  }, [panes, zoom]);

  const updatePane = useCallback((id, patch) => {
    setPanes((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  // Every way out of a pane ends the same way — the process group inside it is
  // killed, and whatever was running there goes with it — so every way out
  // asks first. The titlebar ×, the dock's × and ⌘W all come through here
  // rather than closing anything themselves, which is what keeps one route
  // from quietly skipping the question.
  //
  // The ids are snapshotted at the moment the request is made, so the answer
  // applies to what was targeted and not to whatever happens to be selected
  // by the time it is given.
  const restoreFocusRef = useRef(null);

  // Whether closing this much would interrupt anything. A terminal sitting at
  // a prompt has nothing running in it, so closing it costs nothing and asks
  // nothing; one with a command in flight is worth stopping for. A browser
  // never has a process group at all, so it never answers yes.
  const somethingIsRunning = useCallback(
    (paneIds) =>
      paneIds.some((id) => {
        const pane = panesRef.current.find((p) => p.id === id);
        if (!pane || pane.kind === 'browser') return false;
        return pane.tabs.some((tab) => isPaneRunning(tab.id));
      }),
    []
  );

  // The removals themselves, with no question attached. Two callers each:
  // the confirmation, when one was asked for, and the close paths that have
  // nothing to ask about.
  const removePanes = useCallback((ids) => {
    setPanes((prev) => prev.filter((p) => !ids.includes(p.id)));
    setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
  }, []);

  const removeTab = useCallback((paneId, tabId) => {
    setPanes((prev) =>
      prev.map((pane) => {
        if (pane.id !== paneId) return pane;
        const index = pane.tabs.findIndex((t) => t.id === tabId);
        const tabs = pane.tabs.filter((t) => t.id !== tabId);
        if (!tabs.length) return pane; // guarded by closeTab; never reached
        // The tab to its left, the way every tabbed thing does it: the
        // neighbour you were next to, not the far end of the strip.
        const activeTabId =
          pane.activeTabId === tabId ? tabs[Math.max(0, index - 1)].id : pane.activeTabId;
        return { ...pane, tabs, activeTabId };
      })
    );
  }, []);

  // Closing a terminal tab kills a process group exactly as closing a terminal
  // window does, so it asks the same question. Held apart from pendingClose rather than making
  // that state polymorphic: the pane veil, the rail's copy and the focus
  // restore all read it, and one of them quietly mishandling a second shape is
  // the kind of bug that only shows up mid-answer.
  const [pendingCloseTab, setPendingCloseTab] = useState(null);

  const requestCloseTab = useCallback((paneId, tabId) => {
    setPendingCloseTab((current) => {
      if (current) return current;
      restoreFocusRef.current = document.activeElement;
      document.activeElement?.blur?.();
      return { paneId, tabId };
    });
  }, []);

  const requestClosePanes = useCallback((ids) => {
    if (ids.length === 0) return;
    // The question exists for work in flight, so it is asked only when there
    // is some. An idle prompt and a browser page both close on the spot: one
    // has nothing running, the other has no process group to run anything.
    if (!somethingIsRunning(ids)) {
      removePanes(ids);
      return;
    }
    setPendingClose((current) => {
      // A question already standing owns the rail: a second × behind it must
      // not change what is about to be answered.
      if (current) return current;
      // Take the keyboard away from the terminal while the question stands,
      // so keystrokes meant for the dialog cannot end up at a shell prompt.
      restoreFocusRef.current = document.activeElement;
      document.activeElement?.blur?.();
      return ids;
    });
  }, [removePanes, somethingIsRunning]);

  // The × on a pane closes that pane, even when it is one of several selected:
  // the button is attached to a specific window and points at it alone.
  const closePane = useCallback((id) => requestClosePanes([id]), [requestClosePanes]);

  // The × on a tab. The last tab in a box is the box: closing it leaves an
  // empty window that could hold nothing and answer to no one, so the question
  // asked is the one about the window.
  const closeTab = useCallback(
    (paneId, tabId) => {
      const pane = panesRef.current.find((p) => p.id === paneId);
      if (!pane) return;
      if (pane.tabs.length <= 1) requestClosePanes([paneId]);
      else if (isPaneRunning(tabId)) requestCloseTab(paneId, tabId);
      else removeTab(paneId, tabId);
    },
    [requestClosePanes, requestCloseTab, removeTab]
  );

  // ⌘W closes the current selection rather than the window.
  const onRequestCloseRef = useRef(onRequestClose);
  onRequestCloseRef.current = onRequestClose;

  const closeSelected = useCallback(() => {
    const ids = selectedIdsRef.current;
    // ⌘W always closes the innermost thing that is actually targeted, and
    // falls outward when nothing inside is: the tab in front, then the window
    // holding it, then the workflow holding that.
    if (ids.length === 0) {
      onRequestCloseRef.current?.();
      return;
    }
    if (ids.length === 1) {
      const pane = panesRef.current.find((p) => p.id === ids[0]);
      // Several tabs in the box means the box is not what is aimed at. With
      // one tab left there is nothing between the key and the window.
      if (pane && pane.tabs.length > 1) {
        if (isPaneRunning(pane.activeTabId)) requestCloseTab(pane.id, pane.activeTabId);
        else removeTab(pane.id, pane.activeTabId);
        return;
      }
    }
    // Several windows selected: ⌘W means all of them, as it always has. Three
    // separate tabs vanishing out of three boxes is not what that gesture has
    // ever asked for.
    requestClosePanes(ids);
  }, [requestClosePanes, requestCloseTab, removeTab]);

  const cancelClose = useCallback(() => {
    setPendingClose(null);
    setPendingCloseTab(null);
    const el = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (el && el.isConnected) el.focus?.();
  }, []);

  const confirmCloseTab = useCallback(() => {
    setPendingCloseTab((target) => {
      if (target) removeTab(target.paneId, target.tabId);
      return null;
    });
    restoreFocusRef.current = null;
  }, [removeTab]);

  const confirmClose = useCallback(() => {
    setPendingClose((ids) => {
      if (ids) removePanes(ids);
      return null;
    });
    restoreFocusRef.current = null;
  }, [removePanes]);

  // One question stands at a time, whichever it is, and the same two keys
  // answer it.
  useEffect(() => {
    if ((!pendingClose && !pendingCloseTab) || !active) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (pendingCloseTab) confirmCloseTab();
        else confirmClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [pendingClose, pendingCloseTab, active, cancelClose, confirmClose, confirmCloseTab]);

  // Measured, then nudged back inside the canvas. Right-clicking near the
  // bottom or the right edge is the ordinary case, not the exotic one — a pane
  // dragged down there is exactly where you would reach for its menu — and a
  // menu sized from a guess at its own item height would be wrong the first
  // time an editor with a long name was installed.
  useLayoutEffect(() => {
    const el = paneMenuRef.current;
    const box = canvasRef.current?.getBoundingClientRect();
    if (!el || !box || !paneMenu) return;
    const menu = el.getBoundingClientRect();
    const overflowX = Math.max(0, menu.right - box.right + 8);
    const overflowY = Math.max(0, menu.bottom - box.bottom + 8);
    if (!overflowX && !overflowY) return;
    // Clamped at zero as well as at the far edge: a menu taller than the
    // canvas should start at the top of it, never above.
    el.style.left = `${Math.max(4, paneMenu.x - overflowX)}px`;
    el.style.top = `${Math.max(4, paneMenu.y - overflowY)}px`;
  }, [paneMenu]);

  // Dismissed by esc or by a click anywhere else, the way a menu is. Pointerdown
  // rather than click, so it closes on the press rather than waiting for a
  // release that may land somewhere else entirely.
  useEffect(() => {
    if (!paneMenu) return undefined;
    const onPointerDown = (e) => {
      if (paneMenuRef.current?.contains(e.target)) return;
      setPaneMenu(null);
    };
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setPaneMenu(null);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [paneMenu]);

  // The editor question takes esc the same way, and only esc: there is no
  // default editor to press return for, which is the whole reason it is being
  // asked. Captured, so a terminal with the keyboard cannot swallow the key
  // that dismisses the rail standing over it.
  useEffect(() => {
    if (!editorChoice || !active) return undefined;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setEditorChoice(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [editorChoice, active]);

  // Clicking an unselected pane selects just it; clicking one already inside
  // a multi-selection keeps the whole group intact (so it can be dragged
  // together). Shift toggles membership.
  const selectPane = useCallback((id, shift) => {
    setSelectedIds((prev) => {
      if (shift) {
        return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      }
      if (prev.includes(id) && prev.length > 1) return prev;
      return [id];
    });
    zCounter.current += 1;
    const z = zCounter.current;
    setPanes((prev) => prev.map((p) => (p.id === id ? { ...p, z } : p)));
  }, []);

  // Bring a pane to the middle of the window and hand it the keyboard,
  // wherever the view happens to be — the dock's whole job, and the one move
  // that makes an unbounded canvas safe to wander.
  //
  // Geometry comes from paneGeometry rather than from `pane`, for the same
  // reason the minimap reads it: mid-drag, react-rnd owns the dragged pane's
  // position and pane.x/y is a frame or more stale.
  const revealPane = useCallback(
    (id) => {
      const container = canvasRef.current;
      if (!container) return;
      const pane = panesRef.current.find((p) => p.id === id);
      if (!pane) return;
      const r = getPaneGeom(id) ?? { x: pane.x, y: pane.y, w: pane.width, h: pane.height };

      const cw = container.clientWidth;
      const ch = container.clientHeight;

      // Two ways the current zoom can be the wrong one to arrive at: too far
      // in and the pane does not fit on screen, too far out and it is a smudge
      // you cannot read. Anywhere between those, the zoom you were working at
      // is the zoom you keep — a jump that silently rescales the work would
      // undo a deliberate choice every time you changed window.
      const fromZoom = zoomRef.current;
      const overflow = Math.max((r.w * fromZoom) / cw, (r.h * fromZoom) / ch);
      const keepZoom =
        fromZoom >= REVEAL_LEGIBLE_ZOOM && overflow <= REVEAL_MAX_OVERFLOW;
      // Only reached when the zoom you were at is not the one to arrive at.
      const fit = Math.min((cw - REVEAL_PAD * 2) / r.w, (ch - REVEAL_PAD * 2) / r.h);
      const toZoom = keepZoom ? fromZoom : clampZoom(Math.min(fit, 1));

      const fromPan = panRef.current;
      const toPan = {
        x: cw / 2 - (r.x + r.w / 2) * toZoom,
        y: ch / 2 - (r.y + r.h / 2) * toZoom
      };
      const dx = toPan.x - fromPan.x;
      const dy = toPan.y - fromPan.y;
      const dz = toZoom - fromZoom;

      cancelReveal();

      // Raised before the flight, not after it: the brackets fly in over the
      // same 320ms the view does, so the two motions are one arrival. Waiting
      // for the landing would make them an afterthought stuck on the end.
      revealTokenRef.current += 1;
      clearRevealTimers();
      setReveal({ id, rect: r, token: revealTokenRef.current });
      revealTimersRef.current = [setTimeout(() => setReveal(null), REVEAL_MARK_MS)];

      const still = Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dz) < 0.001;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (still || reduced) {
        commitView(dz === 0 ? undefined : toZoom, toPan);
      } else {
        const started = performance.now();
        const step = (now) => {
          const t = Math.min(1, (now - started) / REVEAL_MS);
          const e = easeOutBack(t);
          // undefined when the zoom is being kept: commitView only touches
          // React state when the zoom actually changes, so a pure travel
          // stays entirely out of render — same bargain the pan transform
          // makes everywhere else in here.
          commitView(dz === 0 ? undefined : fromZoom + dz * easeOutCubic(t), {
            x: fromPan.x + dx * e,
            y: fromPan.y + dy * e
          });
          revealRafRef.current = t < 1 ? requestAnimationFrame(step) : null;
        };
        revealRafRef.current = requestAnimationFrame(step);
      }

      // Selection is what actually focuses the pane (TerminalView focuses its
      // xterm when `focused` turns on), so it is set now rather than when the
      // glide lands — otherwise everything typed during the trip goes nowhere.
      selectPane(id, false);

      // ...except when the pane was already the whole selection: `focused`
      // never flips, so that effect never runs, and the keyboard stays
      // wherever it was — a toolbar button, say. Asked for directly here, the
      // rail always hands over the keyboard as well as the view.
      getTerminalEntry(id)?.term?.focus();
    },
    [commitView, cancelReveal, clearRevealTimers, selectPane]
  );

  const beginGroupDrag = useCallback((anchorId, anchorPos) => {
    const currentSelected = selectedIdsRef.current;
    const idsToMove = currentSelected.includes(anchorId) && currentSelected.length > 1 ? currentSelected : [anchorId];
    const members = {};
    panesRef.current.forEach((p) => {
      if (idsToMove.includes(p.id)) members[p.id] = { x: p.x, y: p.y };
    });
    // `multi` decides whether a drag frame has anything to say to React at
    // all. When only the anchor is moving, react-rnd owns its position until
    // onDragStop and paneGeometry carries it to the minimap —
    // React learns nothing new from a frame, so it must not be woken for one.
    groupDragRef.current = {
      anchorId,
      anchorStart: anchorPos,
      members,
      multi: idsToMove.length > 1
    };

    if (idsToMove.length > 1) {
      setPanes((prev) => {
        let z = zCounter.current;
        const zMap = {};
        idsToMove.forEach((id) => {
          z += 1;
          zMap[id] = z;
        });
        zCounter.current = z;
        return prev.map((p) => (zMap[p.id] ? { ...p, z: zMap[p.id] } : p));
      });
    }
  }, []);

  const updateGroupDrag = useCallback((anchorId, currentPos) => {
    const g = groupDragRef.current;
    if (!g || g.anchorId !== anchorId) return;
    // A single-pane drag has no followers, and the anchor is deliberately left
    // untouched below — so the updater's only product was a fresh array of
    // identical objects. setPanes cannot bail on that, so it re-rendered the
    // whole workspace (every pane, every terminal, every webview, the minimap)
    // sixty-plus times a second for zero DOM change. The pan transform is kept
    // out of React state for exactly this reason; this put it straight back.
    if (!g.multi) return;
    const dx = currentPos.x - g.anchorStart.x;
    const dy = currentPos.y - g.anchorStart.y;
    setPanes((prev) =>
      prev.map((p) => {
        if (p.id === anchorId) return p;
        const start = g.members[p.id];
        if (!start) return p;
        return { ...p, x: start.x + dx, y: start.y + dy };
      })
    );
  }, []);

  const endGroupDrag = useCallback(() => {
    groupDragRef.current = null;
  }, []);

  // The cursor can cross a page while the canvas is being panned or a marquee
  // drawn too, so for the same reason no page sees the mouse during either.
  useEffect(() => {
    const on = isPanning || marqueeRect !== null;
    document.body.classList.toggle('is-canvas-drag', on);
    return () => document.body.classList.remove('is-canvas-drag');
  }, [isPanning, marqueeRect]);

  const selectionCount = selectedIds.length;

  return (
    <div className={`workspace${active ? '' : ' workspace-hidden'}`} aria-hidden={!active}>
      {/* No toolbar row. The two things it held — opening a window and
          changing the view — both belong to the rail at the bottom, next to
          the list of what is already open. Deleting the row gives the canvas
          44px back and leaves the title bar to workflows alone. */}
      <div
        className={`canvas${isPanning ? ' panning' : ''}`}
        ref={canvasRef}
        onMouseDown={handleCanvasMouseDown}
      >
        <div className="canvas-grid" ref={gridRef} aria-hidden="true" />
        <div
          ref={contentRef}
          className="canvas-content"
          style={{
            // No width/height: this element is a transform origin, nothing
            // else. It used to be sized so Rnd could use it as a drag bound,
            // and that bound is what made the workspace feel fenced in.
            // Read from the ref, not state: React only re-renders here on
            // zoom/pane changes, and this keeps that render in sync with the
            // imperative writes commitView makes between renders.
            transform: `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${zoom})`
          }}
        >
          {panes.map((pane) => (
            <TerminalPane
              key={pane.id}
              pane={pane}
              scale={zoom}
              focused={selectionCount === 1 && selectedIds[0] === pane.id}
              selected={selectedIds.includes(pane.id)}
              pendingClose={pendingClose?.includes(pane.id) ?? false}
              pendingCloseTabId={
                pendingCloseTab?.paneId === pane.id ? pendingCloseTab.tabId : null
              }
              theme={theme}
              onChange={(patch) => updatePane(pane.id, patch)}
              onTabChange={(tabId, patch) => updateTab(pane.id, tabId, patch)}
              onTabSelect={(tabId) => selectTab(pane.id, tabId)}
              onTabReorder={(tabId, toIndex) => reorderTab(pane.id, tabId, toIndex)}
              onTabClose={(tabId) => closeTab(pane.id, tabId)}
              onTabAdd={() => addTab(pane.id, pane.kind)}
              onClose={() => closePane(pane.id)}
              onSelect={(shift) => selectPane(pane.id, shift)}
              onTitlebarMenu={
                pane.kind === 'terminal' ? (x, y) => openTitlebarMenu(pane.id, x, y) : undefined
              }
              onGroupDragStart={(pos) => beginGroupDrag(pane.id, pos)}
              onGroupDrag={(pos) => updateGroupDrag(pane.id, pos)}
              onGroupDragEnd={endGroupDrag}
            />
          ))}

          {/* Over the panes rather than under them: it is an instrument
              aimed at one of them, not another box on the canvas. */}
          {reveal && <RevealMark rect={reveal.rect} zoom={zoom} token={reveal.token} />}

          {marqueeRect && (
            <div
              className="marquee-box"
              style={{
                left: marqueeRect.x,
                top: marqueeRect.y,
                width: marqueeRect.width,
                height: marqueeRect.height,
                borderColor: SELECTION_COLOR[theme],
                background: `${SELECTION_COLOR[theme]}1f`
              }}
            />
          )}
        </div>

        <Minimap
          panes={panes}
          selectedIds={selectedIds}
          canvasRef={canvasRef}
          panRef={panRef}
          zoomRef={zoomRef}
          apiRef={minimapApiRef}
          onNavigate={centerOn}
        />

        {panes.length === 0 && !hideEmptyHint && (
          <div className="empty-hint">
            <p className="empty-hint-lead">
              Empty workspace. Press <Shortcut id="newTerminal" /> to open the first terminal.
            </p>
            <dl className="empty-hint-keys">
              <dt>Pan</dt>
              <dd>
                two-finger scroll, or drag with <Shortcut id="space" /> held
              </dd>
              <dt>Zoom</dt>
              <dd>
                hold <Shortcut id="command" /> and scroll; <Shortcut id="zoomReset" /> for actual
                size, <Shortcut id="zoomFit" /> to fit everything
              </dd>
              <dt>Select</dt>
              <dd>drag across empty canvas</dd>
              <dt>Move</dt>
              <dd>drag a pane by its title bar</dd>
            </dl>
          </div>
        )}

        {/* Not a dialog stacked over a dimmed page: the panes about to close
            are marked in place, and only the question and its two answers sit
            on top, on a rail along the bottom of the workspace. You confirm
            while still looking at exactly what you are confirming. */}
        {(pendingClose || pendingCloseTab) && (
          <div className="confirm-rail" role="alertdialog" aria-modal="true" aria-label="Confirm close">
            <span className="confirm-rail-count">{pendingClose ? pendingClose.length : 1}</span>
            <div className="confirm-rail-copy">
              <strong>
                {pendingCloseTab
                  ? 'tab will close'
                  : pendingClose.length === 1
                    ? 'pane will close'
                    : 'panes will close'}
              </strong>
              {/* The question is only asked when something is actually
                  running, so it says so plainly rather than hedging about what
                  might be in there. */}
              <span>
                {pendingCloseTab
                  ? 'a command is running in it'
                  : 'commands are running in them'}
              </span>
            </div>
            <div className="confirm-rail-actions">
              <button type="button" className="confirm-cancel" onClick={cancelClose}>
                Cancel <Shortcut id="cancel" />
              </button>
              <button
                type="button"
                className="confirm-accept"
                onClick={pendingCloseTab ? confirmCloseTab : confirmClose}
              >
                Close <Shortcut id="confirm" />
              </button>
            </div>
          </div>
        )}

        {/* Right-clicking a title bar. Drawn here, a sibling of the canvas
            content rather than a child of the pane, so the canvas transform
            cannot scale it: at 50% zoom a menu inside a pane would come out
            half size. Its coordinates were converted to this box when it
            opened, and nudged back inside it after measuring. */}
        {paneMenu && (
          <div
            className="pane-menu"
            ref={paneMenuRef}
            role="menu"
            aria-label="Open folder in"
            style={{ left: paneMenu.x, top: paneMenu.y }}
          >
            <div className="pane-menu-head">Open folder in</div>
            {paneMenu.editors.map((editor) => {
              const current = editor.app === editorPref;
              return (
                <button
                  key={editor.app}
                  type="button"
                  role="menuitem"
                  className="pane-menu-item"
                  onClick={() => chooseFromMenu(editor)}
                >
                  <span className="pane-menu-tick">{current ? <TickIcon /> : null}</span>
                  <span className="pane-menu-label">{editor.label}</span>
                  {/* The key is printed only beside the one it would actually
                      use, because that is the whole of what ⌘E means. */}
                  <span className="pane-menu-key">
                    {current ? <Shortcut id="openInEditor" /> : null}
                  </span>
                </button>
              );
            })}
            {/* The list above is a good default, never a ceiling. Anything on
                this Mac can be reached from here, and once reached it is
                offered alongside the others from then on. */}
            <div className="pane-menu-sep" />
            <button
              type="button"
              role="menuitem"
              className="pane-menu-item pane-menu-item-quiet"
              onClick={() => {
                const { dir } = paneMenu;
                setPaneMenu(null);
                pickApplication(dir);
              }}
            >
              <span className="pane-menu-tick" />
              <span className="pane-menu-label">Other application…</span>
              <span className="pane-menu-key" />
            </button>
          </div>
        )}

        {/* The same rail the close question stands on, asking a different
            question. Not a modal in the middle of the canvas: the pane whose
            folder this is stays visible and selected while you answer. */}
        {editorChoice && (
          <div className="confirm-rail" role="dialog" aria-label="Choose an editor">
            <div className="confirm-rail-copy">
              <strong>Open in</strong>
              <span className="editor-rail-dir" title={editorChoice.dir}>
                {shortenDir(editorChoice.dir)}
              </span>
            </div>
            <div className="editor-rail-options">
              {editorChoice.editors.map((editor) => (
                <button
                  key={editor.app}
                  type="button"
                  className={`editor-option${
                    editor.app === editorPref ? ' editor-option-current' : ''
                  }`}
                  onClick={() => chooseEditor(editor)}
                >
                  {editor.label}
                </button>
              ))}
              <button
                type="button"
                className="editor-option editor-option-other"
                onClick={() => {
                  const { dir } = editorChoice;
                  setEditorChoice(null);
                  pickApplication(dir);
                }}
              >
                Other…
              </button>
            </div>
            <div className="confirm-rail-actions">
              <button type="button" className="confirm-cancel" onClick={() => setEditorChoice(null)}>
                Cancel <Shortcut id="cancel" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* A sibling of the canvas, not a layer over it: the minimap and the
          confirmation rail are positioned inside the canvas, so giving the
          dock its own row means neither of them has to know it exists. */}
      <PaneDock
        panes={panes}
        selectedIds={selectedIds}
        selectionCount={selectionCount}
        zoom={zoom}
        onReveal={revealPane}
        onClose={closePane}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomReset={zoomReset}
      />
    </div>
  );
}
