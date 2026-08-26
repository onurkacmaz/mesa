import React from 'react';
import Brackets from './Brackets.jsx';

// The arrival: the brackets fly in from outside the pane and snap tight around
// it as the view lands, then let go. They are what makes the trip land on
// something instead of just stopping — the canvas has no landmarks, so
// arriving needs to be said out loud.
const PAD = 7;
const ARM = 22;
const RUN_IN = 16;
const WEIGHT = 1.6;

export default function RevealMark({ rect, zoom, token }) {
  if (!rect) return null;

  // Everything here is quoted in screen pixels and divided by the zoom, so the
  // marks stay the same size on the display whether the pane is filling the
  // window or is a speck at 8%. A bracket that scaled with the canvas would be
  // invisible at one end of the range and a slab at the other.
  const pad = PAD / zoom;

  return (
    <div
      // Remounting on every trip is the point: the animation is declarative
      // and a fresh element is the only thing that restarts it cleanly.
      key={token}
      className="reveal-mark"
      aria-hidden="true"
      style={{
        left: rect.x - pad,
        top: rect.y - pad,
        width: rect.w + pad * 2,
        height: rect.h + pad * 2,
        '--bracket-arm': `${ARM / zoom}px`,
        '--bracket-run': `${RUN_IN / zoom}px`,
        '--bracket-weight': `${WEIGHT / zoom}px`
      }}
    >
      <Brackets />
    </div>
  );
}
