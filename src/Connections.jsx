import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { getPaneGeom, onPaneGeomChange } from './paneGeometry.js';
import { ropeColor } from './theme.js';

// ─── The rope ────────────────────────────────────────────────────────────
//
// A connection is drawn as one cubic Bézier whose belly is a simulated point
// chasing a target, rather than a curve recomputed from scratch each frame.
// That single indirection is the whole effect: fling a pane and the belly
// lags behind, so the rope stretches and swings; let go and it oscillates
// into place. Two degrees of freedom per connection, no verlet chain.
//
// ── TUNING (yours to set) ───────────────────────────────────────────────
// These four numbers decide whether this reads as a rope, a rubber band or a
// coiled phone cord. They are the aesthetic core of the feature and the
// defaults below are only a starting point.
//
// STIFFNESS  how hard the belly is pulled toward its rest point
// DAMPING    how fast the swing dies; too low never settles, too high is dead
// NATURAL_LENGTH  the rope's own length: endpoints closer than this have
//                 slack to give, endpoints further apart pull it taut
// SAG_PER_SLACK   how much of that slack turns into droop
const STIFFNESS = 0.14;
const DAMPING = 0.78;
const NATURAL_LENGTH = 420;
const SAG_PER_SLACK = 0.3;

// A rope is never perfectly straight, even pulled tight — without this floor
// a long connection reads as a ruled line, which is the one thing it must not
// look like.
const SAG_FLOOR = 10;

// Sag is a function of SLACK, not of distance. This is the detail that
// separates a rope from a curve: pull the ends apart and the belly rises on
// its own, because there is less rope left over to droop.
//
// Slack alone is not enough though, and the failure is ugly rather than
// subtle. Two panes stacked with a 60px gap have 360px of slack, which on the
// raw formula puts the belly ~160px BELOW the midpoint — deep inside the pane
// below, so the rope dives through it and only a loop shows underneath. Two
// bounds fix it, and both are the physics rather than a fudge:
//
//  · sag can never exceed a fraction of the separation itself. A rope between
//    two points 60px apart cannot hang 160px; it would already be lying on
//    something.
//  · sag scales with how LEVEL the run is. A plumb rope has nowhere to droop
//    to — the slack goes straight down along the line it already occupies —
//    so a vertical connection is nearly taut and a horizontal one swags.
const SAG_SPAN_LIMIT = 0.5;

function ropeRest(p0, p3) {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const dist = Math.hypot(dx, dy) || 1;
  const slack = Math.max(0, NATURAL_LENGTH - dist);
  const levelness = Math.abs(dx) / dist;
  const sag = Math.min(slack * SAG_PER_SLACK, dist * SAG_SPAN_LIMIT) * levelness;
  return {
    x: (p0.x + p3.x) / 2,
    y: (p0.y + p3.y) / 2 + SAG_FLOOR + sag
  };
}
// ─────────────────────────────────────────────────────────────────────────

// Below this the belly is close enough to its target, and slow enough, that
// another frame would move it by less than a pixel. Crossing it is what lets
// the rAF loop shut itself down — a permanent 60fps loop in an Electron app
// full of live PTYs is a battery bug, not an animation.
const REST_EPSILON = 0.05;

// The layers are absolutely-positioned surfaces inside .canvas-content, so
// they inherit the canvas pan/zoom transform for free. .canvas-content has no
// size of its own (it is a bare transform origin) and pane coordinates are
// routinely negative, so each surface is an oversized box centred on the
// origin rather than something sized to fit. .canvas clips them to the
// viewport.
const SURFACE_HALF = 20000;

// Where a rope may tie along an edge. Held off the exact corners, because a
// rope knotted at a corner has no clean direction to leave in and reads as
// having missed the pane.
const T_MIN = 0.08;
const T_MAX = 0.92;
const clampT = (t) => Math.min(T_MAX, Math.max(T_MIN, t));

const NORMAL = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 }
};

export const SIDES = ['left', 'right', 'top', 'bottom'];

// `t` is where along the side the rope is tied, 0 to 1. It used to be fixed at
// the midpoint, which is what made every connection land in the same four
// places on a pane regardless of where it was aimed.
export function anchorOf(rect, side, t = 0.5) {
  switch (side) {
    case 'left':
      return { x: rect.x, y: rect.y + rect.h * t };
    case 'right':
      return { x: rect.x + rect.w, y: rect.y + rect.h * t };
    case 'top':
      return { x: rect.x + rect.w * t, y: rect.y };
    default:
      return { x: rect.x + rect.w * t, y: rect.y + rect.h };
  }
}

// The exact point on `rect`'s frame that `point` is nearest to: which edge,
// and how far along it. This is what decides where a rope lands, and it is
// deliberately the plain perpendicular answer — you tie the rope where you
// point at, with nothing clever in between.
export function nearestEdge(rect, point) {
  const dLeft = Math.abs(point.x - rect.x);
  const dRight = Math.abs(rect.x + rect.w - point.x);
  const dTop = Math.abs(point.y - rect.y);
  const dBottom = Math.abs(rect.y + rect.h - point.y);
  const nearest = Math.min(dLeft, dRight, dTop, dBottom);
  if (nearest === dLeft) return { side: 'left', t: clampT((point.y - rect.y) / (rect.h || 1)) };
  if (nearest === dRight) return { side: 'right', t: clampT((point.y - rect.y) / (rect.h || 1)) };
  if (nearest === dTop) return { side: 'top', t: clampT((point.x - rect.x) / (rect.w || 1)) };
  return { side: 'bottom', t: clampT((point.x - rect.x) / (rect.w || 1)) };
}

// Which side of `rect` faces `point`. Used only for the loose end of a rope
// that is over no pane at all, where there is no frame to tie to and the curve
// just needs to arrive from a sensible direction.
function facingSide(rect, point) {
  const dx = point.x - (rect.x + rect.w / 2);
  const dy = point.y - (rect.y + rect.h / 2);
  if (Math.abs(dx) / (rect.w || 1) > Math.abs(dy) / (rect.h || 1)) {
    return dx > 0 ? 'right' : 'left';
  }
  return dy > 0 ? 'bottom' : 'top';
}

// How far the curve leaves a port before it starts bending, so a rope always
// departs perpendicular to the edge it is tied to and never clips the pane.
function leadFor(dist) {
  return Math.min(120, 26 + dist * 0.26);
}

// Control points are solved for, not guessed. For a cubic Bézier
// B(0.5) = (P0 + 3·C1 + 3·C2 + P3) / 8, so writing C1 = A + d and C2 = B + d
// (A and B being the perpendicular departure points) and setting B(0.5) to the
// simulated belly gives one linear equation for the shared displacement d.
// The curve then passes exactly through the belly instead of merely near it.
function controlPoints(p0, p3, fromSide, toSide, belly) {
  const lead = leadFor(Math.hypot(p3.x - p0.x, p3.y - p0.y));
  const n0 = NORMAL[fromSide];
  const n3 = NORMAL[toSide];
  const ax = p0.x + n0.x * lead;
  const ay = p0.y + n0.y * lead;
  const bx = p3.x + n3.x * lead;
  const by = p3.y + n3.y * lead;
  const dx = (8 * belly.x - p0.x - p3.x - 3 * ax - 3 * bx) / 6;
  const dy = (8 * belly.y - p0.y - p3.y - 3 * ay - 3 * by) / 6;
  return { c1x: ax + dx, c1y: ay + dy, c2x: bx + dx, c2y: by + dy };
}

function pathData(p0, p3, c) {
  return `M ${p0.x} ${p0.y} C ${c.c1x} ${c.c1y} ${c.c2x} ${c.c2y} ${p3.x} ${p3.y}`;
}

// A sharp mitred head aimed along the curve's final tangent. Drawn as an
// explicit polygon rather than an SVG <marker> because a marker scales with
// stroke-width, and these strokes are non-scaling — the head has to be
// divided by the zoom by hand to stay the same size on screen.
const HEAD_LENGTH = 11;
const HEAD_HALF_WIDTH = 4.5;

function arrowData(p3, c, zoom) {
  let tx = p3.x - c.c2x;
  let ty = p3.y - c.c2y;
  let len = Math.hypot(tx, ty);
  // A degenerate tangent (control point sitting on the endpoint) would divide
  // by zero and blank the head; fall back to the chord.
  if (len < 0.001) {
    tx = 1;
    ty = 0;
    len = 1;
  }
  tx /= len;
  ty /= len;
  const l = HEAD_LENGTH / zoom;
  const w = HEAD_HALF_WIDTH / zoom;
  const bx = p3.x - tx * l;
  const by = p3.y - ty * l;
  const px = -ty * w;
  const py = tx * w;
  return `M ${p3.x} ${p3.y} L ${bx + px} ${by + py} L ${bx - px} ${by - py} Z`;
}

// Square marks, sized in screen pixels and divided by the zoom so they stay
// grabbable at every scale.
const HANDLE = 9;
const SNAP_MARK = 7;

function placeMark(el, point, size, zoom) {
  const s = size / zoom;
  el.setAttribute('x', point.x - s / 2);
  el.setAttribute('y', point.y - s / 2);
  el.setAttribute('width', s);
  el.setAttribute('height', s);
}

export default function Connections({
  connections,
  theme,
  draftColor,
  zoom,
  zoomRef,
  draftRef,
  selectedId,
  // The pane currently being arrived at. Its ropes come up to full colour for
  // the length of that moment — a rope is the only thing on the canvas that
  // already carries a hue of its own, so this is where the arrival gets to be
  // in colour without inventing a palette for it.
  litPaneId,
  onSelect,
  onEndpointDown,
  apiRef
}) {
  const groupsRef = useRef(new Map());
  const draftPathRef = useRef(null);
  const snapMarkRef = useRef(null);
  const endFromRef = useRef(null);
  const endToRef = useRef(null);
  const springsRef = useRef(new Map());
  const connectionsRef = useRef(connections);
  const selectedIdRef = useRef(selectedId);
  const rafRef = useRef(null);

  connectionsRef.current = connections;
  selectedIdRef.current = selectedId;

  // Reduced motion does not get a lesser version of the effect, it gets the
  // resting shape: the rope is drawn at its target every frame, no swing.
  const reducedRef = useRef(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      reducedRef.current = mq.matches;
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const draw = useCallback(() => {
    const zoomNow = zoomRef.current || 1;
    const reduced = reducedRef.current;
    const draft = draftRef.current;
    let moving = false;

    for (const conn of connectionsRef.current) {
      const nodes = groupsRef.current.get(conn.id);
      if (!nodes?.group || !nodes.line || !nodes.hit || !nodes.head) continue;
      const a = getPaneGeom(conn.from);
      const b = getPaneGeom(conn.to);
      // Hidden while one of its own ends is in your hand: the draft below is
      // standing in for it, and drawing both would double the rope.
      if (!a || !b || draft?.connId === conn.id) {
        nodes.group.style.display = 'none';
        continue;
      }
      nodes.group.style.display = '';

      const p0 = anchorOf(a, conn.fromSide, conn.fromT);
      const p3 = anchorOf(b, conn.toSide, conn.toT);
      const target = ropeRest(p0, p3);

      let s = springsRef.current.get(conn.id);
      if (!s) {
        // Seeded AT the target, never at zero: the rope must be at its
        // resting shape on its very first paint. The simulation perturbs a
        // line that is already there — it never gates whether it exists.
        s = { x: target.x, y: target.y, vx: 0, vy: 0 };
        springsRef.current.set(conn.id, s);
      }

      if (reduced) {
        s.x = target.x;
        s.y = target.y;
        s.vx = 0;
        s.vy = 0;
      } else {
        // Semi-implicit Euler: velocity is updated first and then used to
        // move the belly in the same step, which is what keeps a spring this
        // stiff from overshooting into oscillation that never dies.
        s.vx = (s.vx + (target.x - s.x) * STIFFNESS) * DAMPING;
        s.vy = (s.vy + (target.y - s.y) * STIFFNESS) * DAMPING;
        s.x += s.vx;
        s.y += s.vy;
        const still =
          Math.abs(s.vx) < REST_EPSILON &&
          Math.abs(s.vy) < REST_EPSILON &&
          Math.abs(target.x - s.x) < REST_EPSILON &&
          Math.abs(target.y - s.y) < REST_EPSILON;
        if (still) {
          s.x = target.x;
          s.y = target.y;
          s.vx = 0;
          s.vy = 0;
        } else {
          moving = true;
        }
      }

      const c = controlPoints(p0, p3, conn.fromSide, conn.toSide, s);
      const d = pathData(p0, p3, c);
      nodes.line.setAttribute('d', d);
      nodes.hit.setAttribute('d', d);
      nodes.head.setAttribute('d', arrowData(p3, c, zoomNow));
    }

    // ── The top layer: the rope in your hand, and the handles on the one you
    // have selected. Both live above the panes, because both are things you
    // aim at — a marker drawn behind the pane you are pointing at would be
    // invisible exactly when it matters.
    const draftEl = draftPathRef.current;
    const snapEl = snapMarkRef.current;
    if (draftEl && snapEl) {
      if (draft) {
        const fixedRect = getPaneGeom(draft.fixed.paneId);
        if (fixedRect) {
          const anchor = anchorOf(fixedRect, draft.fixed.side, draft.fixed.t);
          const loose = draft.snap ?? { x: draft.x, y: draft.y };
          const looseSide =
            draft.snapSide ?? facingSide({ x: loose.x, y: loose.y, w: 1, h: 1 }, anchor);
          // The fixed end is always drawn as the curve's start. For a rope
          // whose SOURCE end is the one being moved that reverses the visual
          // direction for the length of the gesture, which is correct: the end
          // that is standing still is the one the curve is anchored to.
          const c = controlPoints(
            anchor,
            loose,
            draft.fixed.side,
            looseSide,
            ropeRest(anchor, loose)
          );
          draftEl.setAttribute('d', pathData(anchor, loose, c));
          draftEl.style.display = '';

          if (draft.snap) {
            placeMark(snapEl, draft.snap, SNAP_MARK, zoomNow);
            snapEl.style.display = '';
          } else {
            snapEl.style.display = 'none';
          }
        }
        moving = true;
      } else {
        draftEl.style.display = 'none';
        snapEl.style.display = 'none';
      }
    }

    const fromEl = endFromRef.current;
    const toEl = endToRef.current;
    if (fromEl && toEl) {
      const sel = draft
        ? null
        : connectionsRef.current.find((c) => c.id === selectedIdRef.current);
      const a = sel && getPaneGeom(sel.from);
      const b = sel && getPaneGeom(sel.to);
      if (sel && a && b) {
        placeMark(fromEl, anchorOf(a, sel.fromSide, sel.fromT), HANDLE, zoomNow);
        placeMark(toEl, anchorOf(b, sel.toSide, sel.toT), HANDLE, zoomNow);
        fromEl.style.display = '';
        toEl.style.display = '';
      } else {
        fromEl.style.display = 'none';
        toEl.style.display = 'none';
      }
    }

    if (moving) {
      rafRef.current = requestAnimationFrame(draw);
    } else {
      rafRef.current = null;
    }
  }, [zoomRef, draftRef]);

  const wake = useCallback(() => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(draw);
  }, [draw]);

  // Any pane moving, resizing or mounting perturbs the ropes tied to it.
  useEffect(() => onPaneGeomChange(wake), [wake]);

  // A new or removed connection needs a pass to take its resting shape, and
  // `zoom` is in the deps because the arrowhead and the square marks are the
  // things here that are NOT drawn in canvas units — they are divided by the
  // zoom by hand, so nothing else would redraw them after a zoom.
  //
  // draw() is called synchronously rather than scheduled: a rope must have its
  // shape on the same paint it first appears on. Scheduling would leave one
  // frame with an empty `d`, which is a flash of missing content — the
  // simulation perturbs a line that is already drawn, it never decides whether
  // the line exists.
  useLayoutEffect(() => {
    const live = new Set(connections.map((c) => c.id));
    for (const id of springsRef.current.keys()) {
      if (!live.has(id)) springsRef.current.delete(id);
    }
    for (const id of groupsRef.current.keys()) {
      if (!live.has(id)) groupsRef.current.delete(id);
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    draw();
  }, [connections, selectedId, zoom, draw]);

  useEffect(() => {
    apiRef.current = { wake };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, wake]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    []
  );

  // Deliberately does nothing on detach. React nulls every ref in a group
  // before re-attaching them, so clearing the entry here would race the
  // re-attach and could drop a live rope's nodes on an ordinary re-render.
  // Stale ids are pruned in the layout effect above, where the current set of
  // connections is actually known.
  const setNodes = useCallback(
    (id, key) => (el) => {
      if (!el) return;
      let nodes = groupsRef.current.get(id);
      if (!nodes) {
        nodes = {};
        groupsRef.current.set(id, nodes);
      }
      nodes[key] = el;
    },
    []
  );

  const surfaceProps = {
    width: SURFACE_HALF * 2,
    height: SURFACE_HALF * 2,
    viewBox: `${-SURFACE_HALF} ${-SURFACE_HALF} ${SURFACE_HALF * 2} ${SURFACE_HALF * 2}`,
    style: { left: -SURFACE_HALF, top: -SURFACE_HALF }
  };

  const selected = connections.find((c) => c.id === selectedId);
  const selectedColor = selected ? ropeColor(theme, selected.colorIndex ?? 0) : undefined;

  return (
    <>
      {/* Committed ropes, behind the panes: the boxes are the objects and the
          lines are what ties them together. */}
      <svg className="conn-layer" {...surfaceProps} aria-hidden="true">
        {connections.map((conn) => (
          <g
            key={conn.id}
            ref={setNodes(conn.id, 'group')}
            className={`conn${selectedId === conn.id ? ' conn-selected' : ''}${
              litPaneId && (conn.from === litPaneId || conn.to === litPaneId) ? ' conn-lit' : ''
            }`}
            // Handed to CSS as a custom property rather than set on stroke and
            // fill directly, so one value colours the line and its arrowhead
            // and the stylesheet keeps every other decision about them.
            style={{ '--rope': ropeColor(theme, conn.colorIndex ?? 0) }}
          >
            {/* A transparent wide stroke is the click target. The layer itself
                is pointer-events:none — a full-bleed SVG that accepted the
                pointer would become the hit target for the whole canvas and
                silently kill marquee selection and space-drag panning. */}
            <path
              ref={setNodes(conn.id, 'hit')}
              className="conn-hit"
              d=""
              onMouseDown={(e) => {
                e.stopPropagation();
                onSelect(conn.id);
              }}
            />
            <path ref={setNodes(conn.id, 'line')} className="conn-line" d="" />
            <path ref={setNodes(conn.id, 'head')} className="conn-head" d="" />
          </g>
        ))}
      </svg>

      {/* Above the panes: the rope being pulled, the mark showing exactly where
          it will tie, and the two handles of the selected rope. All three are
          things you aim at, and a pane must never be able to hide them. */}
      <svg className="conn-layer conn-layer-top" {...surfaceProps}>
        <path
          ref={draftPathRef}
          className="conn-line conn-draft"
          d=""
          style={{ display: 'none', '--rope': draftColor }}
        />
        <rect ref={snapMarkRef} className="conn-snap" style={{ display: 'none' }} />
        <rect
          ref={endFromRef}
          className="conn-endpoint"
          style={{ display: 'none', '--rope': selectedColor }}
          onMouseDown={(e) => {
            if (e.button !== 0 || !selectedId) return;
            e.stopPropagation();
            e.preventDefault();
            onEndpointDown(selectedId, 'from', e);
          }}
        />
        <rect
          ref={endToRef}
          className="conn-endpoint"
          style={{ display: 'none', '--rope': selectedColor }}
          onMouseDown={(e) => {
            if (e.button !== 0 || !selectedId) return;
            e.stopPropagation();
            e.preventDefault();
            onEndpointDown(selectedId, 'to', e);
          }}
        />
      </svg>
    </>
  );
}
