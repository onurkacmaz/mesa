import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import TerminalPane from './TerminalPane.jsx';
import Connections, { anchorOf, nearestEdge } from './Connections.jsx';
import Minimap from './Minimap.jsx';
import PaneDock from './PaneDock.jsx';
import RevealMark from './RevealMark.jsx';
import { getTerminalEntry } from './terminalRegistry.js';
import { getPaneGeom } from './paneGeometry.js';
import { registerWorkspaceActions, unregisterWorkspaceActions } from './workspaceActions.js';
import { SELECTION_COLOR, ropeColor } from './theme.js';

const CASCADE_STEP = 32;

// Terminal de tarayıcı da aynı ölçüde açılır, ve o ölçüyü tarayıcı belirler:
// guest'in gördüğü viewport panenin CSS boyutudur (tuvalin zoom'u onu yalnızca
// görsel olarak ölçekler). 780px'te siteler dar pencere düzenine düşüyor —
// YouTube kenar çubuğunu ~792px'in altında tamamen gizliyor, etiketli tam
// menüyü ancak ~1313px üstünde açıyor. Masaüstü düzenini tetikleyecek
// genişlikte açılır; terminal de aynı kutuyu alınca yan yana duran iki pane
// aynı ızgaraya oturuyor.
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
// How long the arrival marks stay on the canvas, and with them the colour in
// the ropes tied to the pane. Kept in step with the keyframes in styles.css —
// 320 flying, 200 held, 300 letting go.
const REVEAL_MARK_MS = 820;
// The colour leaves before the marks do, so the ropes' 120ms fade finishes on
// the same beat the brackets do and the whole arrival exhales at once.
const REVEAL_LIT_MS = 700;
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
// The invariant survives without the bound, and always did. ⌘⇧0 frames
// everything open at whatever zoom fits, from anywhere, at any scale — a
// deliberate way home beats a fence you feel on every gesture. So the view is
// free now: pan and zoom go exactly where they are aimed.

const rectsIntersect = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

let counter = 0;
function nextId(prefix) {
  counter += 1;
  return `${prefix}-${counter}`;
}

// Accent indices advance across every session ever opened, so two terminals
// never land on the same tint back to back.
let sessionCounter = 0;

function Kbd({ children }) {
  return <span className="kbd">{children}</span>;
}

// One workflow: its own canvas, its own terminals, its own view. Every open
// workflow stays mounted — a workflow you switched away from is usually the
// one with something running in it — and only the active one is visible.
export default function Workspace({ workflowId, theme, active, onRequestClose, onPaneCountChange }) {
  const [panes, setPanes] = useState([]);
  const [zoom, setZoom] = useState(1);
  const [selectedIds, setSelectedIds] = useState([]);
  const [isPanning, setIsPanning] = useState(false);
  const [isMarqueeSelecting, setIsMarqueeSelecting] = useState(false);
  const [marqueeRect, setMarqueeRect] = useState(null);
  const [pendingClose, setPendingClose] = useState(null);

  // Connections are purely organisational: they say two panes belong together
  // and in which direction you read them. Nothing is piped, nothing is
  // triggered. This state changes only when one is created or deleted — never
  // while dragging, which is the whole reason the rope layer reads geometry
  // out of paneGeometry instead of out of here.
  const [connections, setConnections] = useState([]);
  const [selectedConnId, setSelectedConnId] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const draftRef = useRef(null);
  const connApiRef = useRef(null);
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  // Advances across the whole session so two ropes tied one after another
  // never come out the same colour, even after the ones between them are cut.
  const ropeIndexRef = useRef(0);
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

  const zCounter = useRef(1);
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
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const contentRef = useRef(null);
  const gridRef = useRef(null);
  const gridZoomRef = useRef(null);

  useEffect(() => {
    panesRef.current = panes;
    onPaneCountChange?.(panes.length);
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
  useLayoutEffect(() => {
    const container = canvasRef.current;
    if (!container) return;
    commitView(undefined, {
      x: container.clientWidth / 2,
      y: container.clientHeight / 2
    });
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
      setSelectedConnId(null);

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
  // CONNECTING — pull a rope out of a pane's edge port and drop it on
  // another pane.
  //
  // The hit test is arithmetic against paneGeometry rather than
  // elementFromPoint, for two reasons. A browser pane is a webview: it is a
  // separate WebContents and the element it returns is not something this
  // document can map back to a pane. And the gesture is suppressed over
  // webviews anyway (see the body class below), so there would be nothing
  // useful under the cursor there. Arithmetic works over every pane kind
  // equally, and z-order is already a number we keep.
  // ───────────────────────────────────────────────────────────────────────
  const paneAtPoint = useCallback((point, excludeId) => {
    let best = null;
    for (const p of panesRef.current) {
      if (p.id === excludeId) continue;
      const r = getPaneGeom(p.id);
      if (!r) continue;
      if (point.x < r.x || point.x > r.x + r.w) continue;
      if (point.y < r.y || point.y > r.y + r.h) continue;
      if (!best || p.z > best.pane.z) best = { pane: p, rect: r };
    }
    return best;
  }, []);

  const addConnection = useCallback((from, fromSide, fromT, to, toSide, toT) => {
    // A pane roped to itself has nothing to say, and would draw a loop with
    // no rest shape.
    if (from === to) return;
    // Advanced OUTSIDE the updater, deliberately. React 18 may invoke an
    // updater more than once (the same eager-evaluation hazard the zoom/pan
    // refs are documented against above), and a counter bumped in there would
    // skip a colour every time it happened. A skipped index here costs
    // nothing — the palette cycles — but a double bump inside would.
    const colorIndex = ropeIndexRef.current;
    ropeIndexRef.current += 1;
    setConnections((prev) => {
      // Same pair, same direction, already tied. A second rope on top of the
      // first would be invisible and undeletable.
      if (prev.some((c) => c.from === from && c.to === to)) return prev;
      return [
        ...prev,
        { id: nextId('conn'), from, fromSide, fromT, to, toSide, toT, colorIndex }
      ];
    });
  }, []);

  const selectConnection = useCallback((id) => {
    // One selection concept: picking a rope drops the pane selection, the way
    // picking a pane drops the rope.
    setSelectedConnId(id);
    setSelectedIds([]);
  }, []);

  // ── The gesture, in both of its forms ───────────────────────────────────
  // Pulling a NEW rope out of a port and MOVING an end of one that already
  // exists are the same motion, so they are the same code. The only thing that
  // differs is what stays put and what happens on release, and both of those
  // live in the draft: `fixed` is the end that does not move, `movingEnd` says
  // which end of the connection is in your hand, and `connId` is null for a
  // new rope or the rope being re-tied.
  const beginDraft = useCallback(
    (draft, e) => {
      const point = localPointFromEvent(e);
      draftRef.current = { ...draft, x: point.x, y: point.y, snap: null, snapSide: null, snapT: 0.5, targetId: null };
      // The same trick the pane drag uses: while a gesture is running no page
      // sees the mouse, because a webview under the cursor otherwise swallows
      // mousemove and strands the drag halfway across the canvas.
      document.body.classList.add('is-pane-drag', 'is-connecting');
      setIsConnecting(true);
      connApiRef.current?.wake();
    },
    [localPointFromEvent]
  );

  const startPortDrag = useCallback(
    (paneId, side, e) => {
      // A rope pulled from a port starts at that port's midpoint. Where it
      // ties at the far end is free, and once it is tied either end can be
      // dragged anywhere along any edge.
      beginDraft({ fixed: { paneId, side, t: 0.5 }, movingEnd: 'to', connId: null }, e);
    },
    [beginDraft]
  );

  const startEndpointDrag = useCallback(
    (connId, end, e) => {
      const conn = connectionsRef.current.find((c) => c.id === connId);
      if (!conn) return;
      // Grab one end and the OTHER one becomes the anchor.
      const fixed =
        end === 'to'
          ? { paneId: conn.from, side: conn.fromSide, t: conn.fromT }
          : { paneId: conn.to, side: conn.toSide, t: conn.toT };
      beginDraft({ fixed, movingEnd: end, connId }, e);
    },
    [beginDraft]
  );

  const moveConnectionEnd = useCallback((connId, end, paneId, side, t) => {
    setConnections((prev) =>
      prev.map((c) => {
        if (c.id !== connId) return c;
        const next =
          end === 'to'
            ? { ...c, to: paneId, toSide: side, toT: t }
            : { ...c, from: paneId, fromSide: side, fromT: t };
        // Re-tying an end onto the pane the other end is already on would make
        // a self-connection out of a valid rope. Refuse and leave it as it was.
        return next.from === next.to ? c : next;
      })
    );
  }, []);

  useEffect(() => {
    if (!isConnecting) return undefined;

    const finish = () => {
      const draft = draftRef.current;
      draftRef.current = null;
      document.body.classList.remove('is-pane-drag', 'is-connecting');
      setIsConnecting(false);
      connApiRef.current?.wake();
      return draft;
    };

    const onMouseMove = (e) => {
      const draft = draftRef.current;
      if (!draft) return;
      const point = localPointFromEvent(e);
      draft.x = point.x;
      draft.y = point.y;

      // The exact spot on the frame you are pointing at — which edge, and how
      // far along it. Not one of four fixed ports: anywhere on the border.
      // The pane holding the fixed end is excluded in both modes: an end
      // dropped there would tie the rope to itself. Note the MOVING end's
      // current pane is not excluded — re-tying somewhere else on the same
      // pane is a normal thing to want.
      const hit = paneAtPoint(point, draft.fixed.paneId);
      if (hit) {
        const { side, t } = nearestEdge(hit.rect, point);
        draft.snapSide = side;
        draft.snapT = t;
        draft.snap = anchorOf(hit.rect, side, t);
        draft.targetId = hit.pane.id;
      } else {
        draft.snapSide = null;
        draft.snap = null;
        draft.targetId = null;
      }
      connApiRef.current?.wake();
    };

    const onMouseUp = () => {
      const draft = finish();
      if (!draft) return;

      // Dropped on nothing. For a new rope that is simply a cancel; for one
      // being re-tied it is too, so the connection stays exactly where it was
      // rather than being destroyed by a slip of the hand.
      if (!draft.targetId) return;

      if (draft.connId) {
        moveConnectionEnd(draft.connId, draft.movingEnd, draft.targetId, draft.snapSide, draft.snapT);
        return;
      }

      // Re-tying a pair that is already tied would otherwise be a gesture that
      // completes and does nothing, with no explanation — a dead control by
      // any other name. Answer it instead: select the rope that already exists,
      // which lights it up and points straight at the reason nothing was added.
      const existing = connectionsRef.current.find(
        (c) => c.from === draft.fixed.paneId && c.to === draft.targetId
      );
      if (existing) {
        selectConnection(existing.id);
        return;
      }

      addConnection(
        draft.fixed.paneId,
        draft.fixed.side,
        draft.fixed.t,
        draft.targetId,
        draft.snapSide,
        draft.snapT
      );
    };

    // Escape is the way out of a gesture this long that does not require
    // finding empty canvas first.
    const onKeyDown = (e) => {
      if (e.key === 'Escape') finish();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    isConnecting,
    localPointFromEvent,
    paneAtPoint,
    addConnection,
    moveConnectionEnd,
    selectConnection
  ]);

  useEffect(() => {
    if (!active || !selectedConnId) return undefined;
    const onKeyDown = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      // Backspace belongs to the shell the instant focus is inside a pane.
      if (e.target instanceof Element && e.target.closest('.pane')) return;
      e.preventDefault();
      setConnections((prev) => prev.filter((c) => c.id !== selectedConnId));
      setSelectedConnId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, selectedConnId]);

  // A gesture interrupted by an unmount must not leave the body wedged into
  // its drag state, which would keep every webview inert.
  useEffect(
    () => () => document.body.classList.remove('is-pane-drag', 'is-connecting'),
    []
  );

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
  }, [active, zoomIn, zoomOut, zoomReset, fitToContent]);

  const addTerminal = useCallback((kind = 'terminal') => {
    // Read the view once, outside the updater: this converts the centre of
    // whatever is currently on screen into canvas coordinates, so a new pane
    // lands in front of the user wherever they have panned or zoomed to,
    // rather than back at a fixed corner of a 6000x4000 canvas.
    const rect = canvasRef.current?.getBoundingClientRect();
    const zoomNow = zoomRef.current;
    const panNow = panRef.current;

    setPanes((prev) => {
      const index = prev.length;
      const id = nextId('term');
      const sessionIndex = sessionCounter;
      sessionCounter += 1;
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
        title: kind === 'browser' ? `Browser ${sessionIndex + 1}` : `Terminal ${sessionIndex + 1}`
      };
      setSelectedIds([id]);
      return [...prev, pane];
    });
  }, []);

  // The title bar's "new terminal" and "new browser" live outside this
  // component, so what they call has to be reachable from outside it.
  useEffect(() => {
    registerWorkspaceActions(workflowId, { addTerminal });
    return () => unregisterWorkspaceActions(workflowId);
  }, [workflowId, addTerminal]);

  const updatePane = useCallback((id, patch) => {
    setPanes((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  // Panes leave by two independent routes — the × on the titlebar and the ⌘W
  // confirmation rail — so the pruning lives in one place both of them call.
  // Missing either one leaves ropes tied to nothing.
  const pruneConnections = useCallback((removedIds) => {
    const gone = new Set(removedIds);
    setConnections((prev) => prev.filter((c) => !gone.has(c.from) && !gone.has(c.to)));
    setSelectedConnId((prev) => {
      if (prev === null) return prev;
      const survivor = connectionsRef.current.find((c) => c.id === prev);
      return survivor && !gone.has(survivor.from) && !gone.has(survivor.to) ? prev : null;
    });
  }, []);

  const closePane = useCallback(
    (id) => {
      setPanes((prev) => prev.filter((p) => p.id !== id));
      setSelectedIds((prev) => prev.filter((x) => x !== id));
      pruneConnections([id]);
    },
    [pruneConnections]
  );

  // ⌘W closes the current selection rather than the window, after confirming.
  // The ids are snapshotted when the shortcut fires so the answer applies to
  // what was targeted, not to whatever happens to be selected later.
  const onRequestCloseRef = useRef(onRequestClose);
  onRequestCloseRef.current = onRequestClose;

  const restoreFocusRef = useRef(null);
  const closeSelected = useCallback(() => {
    const ids = selectedIdsRef.current;
    // Nothing selected means ⌘W is aimed at the workflow itself: close the
    // innermost thing that is actually targeted, and fall outward when
    // nothing inside is.
    if (ids.length === 0) {
      onRequestCloseRef.current?.();
      return;
    }
    setPendingClose((current) => {
      if (current) return current;
      // Take the keyboard away from the terminal while the question stands,
      // so keystrokes meant for the dialog cannot end up at a shell prompt.
      restoreFocusRef.current = document.activeElement;
      document.activeElement?.blur?.();
      return ids;
    });
  }, []);

  const cancelClose = useCallback(() => {
    setPendingClose(null);
    const el = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (el && el.isConnected) el.focus?.();
  }, []);

  const confirmClose = useCallback(() => {
    setPendingClose((ids) => {
      if (ids) {
        setPanes((prev) => prev.filter((p) => !ids.includes(p.id)));
        setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
        pruneConnections(ids);
      }
      return null;
    });
    restoreFocusRef.current = null;
  }, [pruneConnections]);

  useEffect(() => {
    if (!pendingClose || !active) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        confirmClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [pendingClose, active, cancelClose, confirmClose]);

  // Clicking an unselected pane selects just it; clicking one already inside
  // a multi-selection keeps the whole group intact (so it can be dragged
  // together). Shift toggles membership.
  const selectPane = useCallback((id, shift) => {
    setSelectedConnId(null);
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
  // reason the ropes read it: mid-drag, react-rnd owns the dragged pane's
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
      setReveal({ id, rect: r, token: revealTokenRef.current, lit: true });
      revealTimersRef.current = [
        setTimeout(
          () => setReveal((current) => (current ? { ...current, lit: false } : current)),
          REVEAL_LIT_MS
        ),
        setTimeout(() => setReveal(null), REVEAL_MARK_MS)
      ];

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
    // onDragStop and paneGeometry carries it to the ropes and the minimap —
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

  // Tuval kaydırılırken ya da seçim dikdörtgeni çizilirken de imleç bir
  // sayfanın üzerinden geçebilir; aynı sebeple sayfalar o an fareyi görmez.
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
              theme={theme}
              onChange={(patch) => updatePane(pane.id, patch)}
              onClose={() => closePane(pane.id)}
              onSelect={(shift) => selectPane(pane.id, shift)}
              onGroupDragStart={(pos) => beginGroupDrag(pane.id, pos)}
              onGroupDrag={(pos) => updateGroupDrag(pane.id, pos)}
              onGroupDragEnd={endGroupDrag}
              onPortDown={(side, e) => startPortDrag(pane.id, side, e)}
            />
          ))}

          {/* Rendered after the panes, held behind them by z-index. Order
              matters twice over: the ropes must pass behind the boxes (the
              reading a workflow graph wants — the panes are the objects, the
              lines are what ties them together), and this layer's layout
              effect has to run AFTER every pane has published its geometry.
              Mounted first it would run first, find an empty map on the paint a
              new pane appears on, and blank that pane's ropes for a frame.
              The layer inherits this element's pan/zoom transform, which is why
              it never has to know about either. */}
          <Connections
            connections={connections}
            theme={theme}
            // The rope in your hand is already wearing the colour it will keep
            // once it lands, so nothing changes appearance on drop.
            draftColor={ropeColor(theme, ropeIndexRef.current)}
            zoom={zoom}
            zoomRef={zoomRef}
            draftRef={draftRef}
            selectedId={selectedConnId}
            litPaneId={reveal?.lit ? reveal.id : null}
            onSelect={selectConnection}
            onEndpointDown={startEndpointDrag}
            apiRef={connApiRef}
          />

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
          connections={connections}
          theme={theme}
          selectedIds={selectedIds}
          canvasRef={canvasRef}
          panRef={panRef}
          zoomRef={zoomRef}
          apiRef={minimapApiRef}
          onNavigate={centerOn}
        />

        {panes.length === 0 && (
          <div className="empty-hint">
            <p className="empty-hint-lead">
              Boş çalışma alanı. <Kbd>⌘N</Kbd> ile ilk terminali açın.
            </p>
            <dl className="empty-hint-keys">
              <dt>Gezinme</dt>
              <dd>iki parmak kaydırma, ya da boşluk tuşu basılıyken sürükleme</dd>
              <dt>Yakınlaştırma</dt>
              <dd>
                <Kbd>⌘</Kbd> + kaydırma, <Kbd>⌘0</Kbd> ile sıfırlama, <Kbd>⌘⇧0</Kbd> ile hepsini
                sığdırma
              </dd>
              <dt>Seçim</dt>
              <dd>boş alanda sürükleyerek seçin</dd>
              <dt>Taşıma</dt>
              <dd>terminalleri başlık çubuğundan tutup sürükleyin</dd>
              <dt>Bağlama</dt>
              <dd>
                pane kenarındaki kareden tutup başka bir pane&apos;in kenarına sürükleyin
              </dd>
              <dt>Bağı düzenleme</dt>
              <dd>
                çizgiye tıklayın; uçlarını tutup taşıyın, <Kbd>⌫</Kbd> ile silin
              </dd>
            </dl>
          </div>
        )}

        {/* Not a dialog stacked over a dimmed page: the panes about to close
            are marked in place, and only the question and its two answers sit
            on top, on a rail along the bottom of the workspace. You confirm
            while still looking at exactly what you are confirming. */}
        {pendingClose && (
          <div className="confirm-rail" role="alertdialog" aria-modal="true" aria-label="Kapatmayı onayla">
            <span className="confirm-rail-count">{pendingClose.length}</span>
            <div className="confirm-rail-copy">
              <strong>terminal kapatılacak</strong>
              <span>çalışan işlemler sonlandırılır</span>
            </div>
            <div className="confirm-rail-actions">
              <button type="button" className="confirm-cancel" onClick={cancelClose}>
                Vazgeç <Kbd>esc</Kbd>
              </button>
              <button type="button" className="confirm-accept" onClick={confirmClose}>
                Kapat <Kbd>⏎</Kbd>
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
