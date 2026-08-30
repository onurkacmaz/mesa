import React, { useId } from 'react';

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

// Where a session starts from: a standing bar with the line that runs out of
// it. It names the moment, not the act — the command is laid at the prompt on
// open and left unrun, so a play triangle would promise something this does
// not do.
//
// Emphatically NOT a chevron: the pane already wears one as its own mark, at
// the other end of the same row, and two different things in one title bar
// must not share a glyph. Not a down-chevron or a row of dots either — those
// say "a menu is here" and say nothing about what is in it.
export function StartupIcon({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 11 11" fill="none" aria-hidden="true">
      <line x1="1.9" y1="2.2" x2="1.9" y2="8.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
      <line x1="4.2" y1="5.5" x2="9.4" y2="5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
    </svg>
  );
}

// Bare bespoke mark: a prompt chevron + cursor, drawn as paths (no tile
// behind it). The chevron carries a tight two-stop amber gradient — the
// only gradient in the whole UI, reserved for this one small glyph.
//
// It is not a logo parked in a corner. It stands in front of the workflow you
// are in, so the app's own mark is also the answer to "where am I" — the same
// job the chevron does at the prompt inside every pane.
//
// The gradient id comes from useId rather than a constant, because the mark is
// now drawn in more than one place at a time. Two <defs> under one id is not a
// visible fault while both are the same colour — every reference resolves to
// whichever came first in the document — which is exactly why it would be
// found late, on the day the two stopped matching.
export function BrandMark({ theme, size = 16 }) {
  const gradientId = useId();
  const [from, to] = theme === 'light' ? ['#c98f36', '#7c4f13'] : ['#f0c481', '#c97f2e'];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="2" y1="3" x2="14" y2="13" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
      <path
        d="M3.2 4L7.6 8L3.2 12"
        stroke={`url(#${gradientId})`}
        strokeWidth="1.6"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <line
        x1="9.4"
        y1="12"
        x2="13.2"
        y2="12"
        stroke={`url(#${gradientId})`}
        strokeWidth="1.6"
        strokeLinecap="square"
      />
    </svg>
  );
}

// Marks the choice already in force. Two strokes, mitred and square-capped
// like everything else here — a rounded tick would be the one soft mark in the
// app, and the short arm is kept short so it reads as a check rather than as a
// leaning cross.
export function TickIcon({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 11 11" fill="none" aria-hidden="true">
      <path
        d="M1.6 5.6L4.3 8.3L9.4 3.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
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
