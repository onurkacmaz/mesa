import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { getPaneGeom, onPaneGeomChange } from './paneGeometry.js';
import { anchorOf } from './Connections.jsx';
import { ropeColor } from './theme.js';

// Small enough to stay out of the way, large enough that a pane is still a
// shape rather than a speck. Wider than tall because the canvas is: panes are
// laid out sideways far more often than stacked.
const MAP_W = 208;
const MAP_H = 136;
const MAP_PAD = 10;

// The map frames the union of everything open AND where you are currently
// looking — not just the panes. That is the difference between a decoration
// and a way home: wander off into empty canvas and the map zooms out to hold
// both, so you can see the work sitting off to one side and drag straight back
// to it. ⇧⌘0 does the same job in one keystroke; this is the version you can
// aim.
function fitProjection(panes, view) {
  let minX = view.x;
  let minY = view.y;
  let maxX = view.x + view.w;
  let maxY = view.y + view.h;
  for (const p of panes) {
    const r = getPaneGeom(p.id);
    if (!r) continue;
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  const boxW = Math.max(1, maxX - minX);
  const boxH = Math.max(1, maxY - minY);
  const innerW = MAP_W - MAP_PAD * 2;
  const innerH = MAP_H - MAP_PAD * 2;
  const s = Math.min(innerW / boxW, innerH / boxH);
  return {
    s,
    // Centred in the leftover space on the axis that did not decide the scale,
    // so the map's content never sits shoved against one edge.
    ox: MAP_PAD + (innerW - boxW * s) / 2 - minX * s,
    oy: MAP_PAD + (innerH - boxH * s) / 2 - minY * s
  };
}

export default function Minimap({
  panes,
  connections,
  theme,
  selectedIds,
  canvasRef,
  panRef,
  zoomRef,
  apiRef,
  onNavigate
}) {
  const paneRefs = useRef(new Map());
  const ropeRefs = useRef(new Map());
  const viewRectRef = useRef(null);
  const panesRef = useRef(panes);
  const connectionsRef = useRef(connections);
  const projRef = useRef({ s: 1, ox: 0, oy: 0 });
  // While a drag is in progress the projection is held still. Without this the
  // map re-fits on every frame — the view is part of what it frames — so the
  // point under the cursor would slide away as you dragged toward it, and the
  // whole thing would feel like steering on ice.
  const frozenRef = useRef(null);

  panesRef.current = panes;
  connectionsRef.current = connections;

  const sync = useCallback(() => {
    const container = canvasRef.current;
    if (!container) return;
    const zoom = zoomRef.current || 1;
    const pan = panRef.current;

    // The viewport, expressed in canvas coordinates: undo the translate, undo
    // the scale. Same inversion localPointFromEvent does, applied to the two
    // corners of the window instead of to the cursor.
    const view = {
      x: -pan.x / zoom,
      y: -pan.y / zoom,
      w: container.clientWidth / zoom,
      h: container.clientHeight / zoom
    };

    const proj = frozenRef.current ?? fitProjection(panesRef.current, view);
    projRef.current = proj;
    const { s, ox, oy } = proj;

    for (const p of panesRef.current) {
      const el = paneRefs.current.get(p.id);
      const r = getPaneGeom(p.id);
      if (!el) continue;
      if (!r) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.setAttribute('x', r.x * s + ox);
      el.setAttribute('y', r.y * s + oy);
      // A pane scaled to nothing is a pane you cannot see: hold a floor so
      // every one of them stays a mark on the map however far out it is.
      el.setAttribute('width', Math.max(2, r.w * s));
      el.setAttribute('height', Math.max(2, r.h * s));
    }

    for (const c of connectionsRef.current) {
      const el = ropeRefs.current.get(c.id);
      if (!el) continue;
      const a = getPaneGeom(c.from);
      const b = getPaneGeom(c.to);
      if (!a || !b) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      // Straight, not the sagging curve. At this scale the sag would be under
      // a pixel and the only thing it could add is noise.
      const p0 = anchorOf(a, c.fromSide, c.fromT);
      const p3 = anchorOf(b, c.toSide, c.toT);
      el.setAttribute('x1', p0.x * s + ox);
      el.setAttribute('y1', p0.y * s + oy);
      el.setAttribute('x2', p3.x * s + ox);
      el.setAttribute('y2', p3.y * s + oy);
    }

    const vr = viewRectRef.current;
    if (vr) {
      vr.setAttribute('x', view.x * s + ox);
      vr.setAttribute('y', view.y * s + oy);
      vr.setAttribute('width', Math.max(3, view.w * s));
      vr.setAttribute('height', Math.max(3, view.h * s));
    }
  }, [canvasRef, panRef, zoomRef]);

  // Driven from three places, none of which is a React render: the canvas
  // calls sync() from commitView on every pan and zoom frame, pane geometry
  // reports every drag and resize frame, and the layout effect below covers
  // panes or ropes being added and removed.
  useEffect(() => {
    apiRef.current = { sync };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, sync]);

  useEffect(() => onPaneGeomChange(sync), [sync]);

  useLayoutEffect(() => {
    const livePanes = new Set(panes.map((p) => p.id));
    for (const id of paneRefs.current.keys()) {
      if (!livePanes.has(id)) paneRefs.current.delete(id);
    }
    const liveRopes = new Set(connections.map((c) => c.id));
    for (const id of ropeRefs.current.keys()) {
      if (!liveRopes.has(id)) ropeRefs.current.delete(id);
    }
    sync();
  }, [panes, connections, sync]);

  // Screen point on the map -> canvas coordinates, through whichever
  // projection is currently in force.
  const worldAt = useCallback((surface, clientX, clientY) => {
    const rect = surface.getBoundingClientRect();
    const { s, ox, oy } = projRef.current;
    return {
      x: (clientX - rect.left - ox) / s,
      y: (clientY - rect.top - oy) / s
    };
  }, []);

  const beginNavigate = useCallback(
    (e) => {
      if (e.button !== 0) return;
      // The canvas only starts a marquee when the event target IS the canvas,
      // so this does not need to defend against that — but it does need to
      // keep the browser from starting a selection drag.
      e.preventDefault();
      const surface = e.currentTarget;
      frozenRef.current = projRef.current;
      onNavigate(worldAt(surface, e.clientX, e.clientY));

      const onMouseMove = (moveEvent) => {
        onNavigate(worldAt(surface, moveEvent.clientX, moveEvent.clientY));
      };
      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        // Released: let the map re-frame itself around where you ended up.
        frozenRef.current = null;
        sync();
      };
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [onNavigate, worldAt, sync]
  );

  // Nothing open, nothing to map. An empty frame in the corner would be a
  // widget announcing itself rather than a tool.
  if (panes.length === 0) return null;

  const setPaneRef = (id) => (el) => {
    if (el) paneRefs.current.set(id, el);
  };
  const setRopeRef = (id) => (el) => {
    if (el) ropeRefs.current.set(id, el);
  };

  return (
    <div className="minimap">
      <svg
        className="minimap-surface"
        width={MAP_W}
        height={MAP_H}
        onMouseDown={beginNavigate}
      >
        {connections.map((c) => (
          <line
            key={c.id}
            ref={setRopeRef(c.id)}
            className="minimap-rope"
            style={{ stroke: ropeColor(theme, c.colorIndex ?? 0) }}
          />
        ))}
        {panes.map((p) => (
          <rect
            key={p.id}
            ref={setPaneRef(p.id)}
            className={`minimap-pane${selectedIds.includes(p.id) ? ' minimap-pane-on' : ''}`}
          />
        ))}
        {/* Drawn last so it reads as a frame laid over the map rather than as
            one more box among the panes. */}
        <rect ref={viewRectRef} className="minimap-view" />
      </svg>
    </div>
  );
}
