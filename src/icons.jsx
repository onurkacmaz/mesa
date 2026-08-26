import React from 'react';

// The app's own small glyphs, drawn rather than typed and kept in one place.
// They were duplicated across three files with three different sizes, which is
// how the × ended up visibly smaller on the rail than on a pane for no reason
// anyone chose. One definition, one default size, one weight.
//
// Square caps and mitred joins throughout: the rule the whole interface is cut
// to. A round cap here would be the one soft corner in the app.

// 11 in a 20px box reads as a real target rather than a speck. The strokes run
// corner to corner of the box so the cross fills its own square — a "×" glyph
// typed instead would sit optically high, which is why this is drawn.
export function CloseIcon({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 11 11" fill="none" aria-hidden="true">
      <line x1="1.2" y1="1.2" x2="9.8" y2="9.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
      <line x1="9.8" y1="1.2" x2="1.2" y2="9.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

export function PlusIcon({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 11 11" fill="none" aria-hidden="true">
      <line x1="1.5" y1="5.5" x2="9.5" y2="5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
      <line x1="5.5" y1="1.5" x2="5.5" y2="9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
    </svg>
  );
}

export function MinusIcon({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 11 11" fill="none" aria-hidden="true">
      <line x1="1.5" y1="5.5" x2="9.5" y2="5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
    </svg>
  );
}
