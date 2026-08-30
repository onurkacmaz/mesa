import React, { useCallback, useEffect, useState } from 'react';
import { BrandMark } from './icons.jsx';
import { Shortcut } from './shortcuts.jsx';

// The four cards a first launch is walked through, and the only time this app
// explains itself. Shown once, on an install that has never had anything on
// its canvas — src/flags.mjs holds the answer, and App decides.
//
// Every card is the same height and every part of it sits in the same place
// from one step to the next: the drawing, the title, the copy, the keys, the
// footer. Cards sized to their own text would shift the buttons under the
// pointer as you page through them, which is the sequential form of a ragged
// comparison grid.

// The panes in the drawings are Mesa's own shape — a box with a title bar
// scored across the top — so a card shows the thing it is describing rather
// than a generic illustration of a window.
//
// Drawn in outline rather than in the pane's real fills. At this size the
// interface's own tones do not survive: --pane-screen sits three values off
// --bg-canvas and the border is white at 9%, which is exactly right on a pane
// you are working in and invisible in a 100px picture of one. A drawing needs
// a line you can actually see, so it gets --art-line, defined in the
// stylesheet for both surfaces.
//
// The coordinates are put through Number before anything is added to them.
// Written as `y + 6` against a prop that arrived as the string "14" — which is
// what a JSX attribute in quotes gives you — the title bar's line lands at
// "146" and runs to "16118", a rule sixteen thousand units wide sitting far
// below the pane it belongs to. It stays valid SVG and only the sliver that
// crosses the viewport is ever visible, so it reads as a stray mark rather
// than as arithmetic.
function MiniPane(props) {
  const x = Number(props.x);
  const y = Number(props.y);
  const w = Number(props.w);
  const h = Number(props.h);
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="var(--art-fill)"
        stroke="var(--art-line)"
        strokeWidth="1"
      />
      <line
        x1={x}
        y1={y + 6}
        x2={x + w}
        y2={y + 6}
        stroke="var(--art-line)"
        strokeWidth="1"
        opacity="0.5"
      />
    </g>
  );
}

const Frame = ({ children, className }) => (
  <svg
    className={`ob-art${className ? ` ${className}` : ''}`}
    viewBox="0 0 320 104"
    fill="none"
    aria-hidden="true"
  >
    {children}
  </svg>
);

// Three sessions, three places. Nothing moves: the whole point of the first
// card is that things stay where they were put.
const PlacesArt = () => (
  <Frame>
    <MiniPane x={16} y={14} w={118} h={52} />
    <MiniPane x={150} y={8} w={90} h={40} />
    <MiniPane x={118} y={60} w={140} h={36} />
  </Frame>
);

// One pane travelling the short distance a drag would take it, and back.
const PlaceArt = () => (
  <Frame>
    <MiniPane x={20} y={20} w={112} h={60} />
    <g className="ob-drag">
      <MiniPane x={152} y={26} w={112} h={52} />
    </g>
  </Frame>
);

// The canvas pulling back to show more of itself, then returning. Scaled about
// its own centre so nothing drifts off the edge of the drawing.
const ZoomArt = () => (
  <Frame>
    <g className="ob-zoom">
      <MiniPane x={18} y={16} w={104} h={46} />
      <MiniPane x={134} y={10} w={78} h={38} />
      <MiniPane x={96} y={58} w={126} h={36} />
      <MiniPane x={228} y={52} w={70} h={42} />
    </g>
  </Frame>
);

// The strip at the top of the window, with the app's mark standing in front of
// whichever workflow you are in and walking to the next one.
const WorkflowsArt = () => (
  <Frame>
    <rect
      x="16"
      y="10"
      width="288"
      height="20"
      fill="var(--art-fill)"
      stroke="var(--art-line)"
      strokeWidth="1"
    />
    {/* The cut between slots, the way the real strip scores them apart. */}
    <line x1="98" y1="12" x2="98" y2="28" stroke="var(--art-line)" opacity="0.6" />
    <line x1="180" y1="12" x2="180" y2="28" stroke="var(--art-line)" opacity="0.6" />
    <rect x="42" y="18" width="42" height="4" fill="var(--art-line)" opacity="0.85" />
    <rect x="112" y="18" width="52" height="4" fill="var(--art-line)" opacity="0.45" />
    <rect x="194" y="18" width="36" height="4" fill="var(--art-line)" opacity="0.45" />
    {/* Drawn last so the mark stands in front of the slot it is in, never
        under the name beside it. */}
    <g className="ob-mark">
      <path d="M30 16L34 20L30 24" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="square" />
    </g>
    <MiniPane x={16} y={44} w={126} h={50} />
    <MiniPane x={158} y={50} w={98} h={44} />
  </Frame>
);

const STEPS = [
  {
    title: 'Every session gets a place.',
    body: 'Mesa is one canvas with no edges. A terminal you put somewhere stays there, so what you come back to is a layout rather than a row of tabs you have to read.',
    Art: PlacesArt,
    keys: []
  },
  {
    title: 'Open one, put it where you want.',
    body: 'New panes land on the canvas and are yours to arrange. Drag a pane by its title bar to move it, or take an edge to resize it.',
    Art: PlaceArt,
    keys: ['newTerminal', 'newBrowser']
  },
  {
    title: 'Zoom out to see the whole thing.',
    body: 'Pan to move around the canvas and zoom to fit as much of it on screen as you need. Zooming out far enough shows every pane you have open at once.',
    Art: ZoomArt,
    keys: ['space', 'command', 'zoomFit']
  },
  {
    title: 'Keep separate work separate.',
    body: 'A workflow is its own canvas, and the amber mark on the strip stands in front of the one you are in. Everything is where you left it the next time you open Mesa.',
    Art: WorkflowsArt,
    keys: ['newWorkflow', 'switchWorkflow']
  }
];

export default function Onboarding({ theme, onSkip, onFinish }) {
  const [step, setStep] = useState(0);
  const last = step === STEPS.length - 1;

  const back = useCallback(() => setStep((n) => Math.max(0, n - 1)), []);
  const next = useCallback(() => setStep((n) => Math.min(STEPS.length - 1, n + 1)), []);

  // Paged from the keyboard as well as the buttons. Modifiers are left alone
  // so nothing here shadows an app shortcut — ⌥← is a word jump somewhere and
  // has no business paging a card.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.metaKey || e.altKey || e.ctrlKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onSkip();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (!last) next();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (last) onFinish();
        else next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [back, next, last, onSkip, onFinish]);

  const { title, body, Art, keys } = STEPS[step];

  return (
    <div className="ob" role="region" aria-label="Getting started">
      <div className="ob-card">
        <div className="ob-figure">
          <Art />
        </div>

        {/* Fixed height, so the footer does not walk up and down the window as
            the copy changes length from one card to the next. */}
        <div className="ob-copy">
          <h2 className="ob-title">{title}</h2>
          <p className="ob-body">{body}</p>
          <div className="ob-keys">
            {keys.map((id) => (
              <Shortcut key={id} id={id} />
            ))}
          </div>
        </div>

        {/* Three regions: the way out, where you are, the way through. The way
            out is kept at the other end of the row from the way forward, so
            leaving is never a neighbour of the button you are repeatedly
            clicking. */}
        <div className="ob-footer">
          <button type="button" className="ob-skip" onClick={onSkip}>
            Skip
          </button>

          {/* Square, because nothing in this interface is round. Four marks,
              the one you are on filled in. */}
          <div className="ob-progress" aria-hidden="true">
            {STEPS.map((s, i) => (
              <span key={s.title} className={`ob-tick${i === step ? ' ob-tick-on' : ''}`} />
            ))}
          </div>

          <div className="ob-actions">
            {/* Held rather than removed on the first card: a control that
                appears from nowhere moves everything beside it. */}
            <button
              type="button"
              className="ob-back"
              onClick={back}
              style={step === 0 ? { visibility: 'hidden' } : undefined}
              tabIndex={step === 0 ? -1 : undefined}
            >
              Back
            </button>
            {last ? (
              <button type="button" className="ob-next" onClick={onFinish}>
                <span className="ob-next-mark">
                  <BrandMark theme={theme} size={13} />
                </span>
                Start
              </button>
            ) : (
              <button type="button" className="ob-next" onClick={next}>
                Next
                <span className="ob-next-chevron" aria-hidden="true">
                  ›
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
