import React, { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { PromptMark } from './TerminalPane.jsx';
import { PageMark } from './BrowserView.jsx';
import Brackets from './Brackets.jsx';
import { CloseIcon, MinusIcon, PlusIcon } from './icons.jsx';
import { getPaneTitle, onPaneTitleChange } from './paneTitles.js';
import { hint } from './shortcuts.jsx';

// The rail along the bottom of a workflow: every pane that is open, in the
// order it was opened, whatever the canvas is currently showing. The canvas
// answers "what is near me"; this answers "what exists", which on an unbounded
// surface are two different questions.
//
// Order is creation order and never z-order. Sorting by the stacking counter
// would reshuffle the whole rail on every click, so the one thing the rail is
// for — knowing where a window sits without reading it — would be destroyed by
// using it.
export default function PaneDock({
  panes,
  selectedIds,
  zoom,
  selectionCount,
  onReveal,
  onClose,
  onZoomIn,
  onZoomOut,
  onZoomReset
}) {
  const listRef = useRef(null);
  const itemRefs = useRef(new Map());

  // A pane's shown name can change without Workspace hearing about it (a
  // browser follows the page it is on, a terminal follows the branch), so the
  // rail listens for it directly. Only this component re-renders —
  // deliberately, since the alternative is waking every open terminal each time
  // a page loads or a command returns.
  const [titleTick, bumpTitles] = useReducer((n) => n + 1, 0);
  useEffect(() => onPaneTitleChange(bumpTitles), []);

  // The single-selection case is the pane that actually holds the keyboard.
  const focusedId = selectedIds.length === 1 ? selectedIds[0] : null;

  // Where the brackets sit. Measured rather than drawn per item so there is
  // exactly one of them, travelling between names — the rail's own small
  // version of the trip the canvas takes.
  const [cursor, setCursor] = useState(null);
  const settledRef = useRef(false);

  const measure = useCallback(() => {
    const el = focusedId ? itemRefs.current.get(focusedId) : null;
    if (!el) return;
    setCursor({ left: el.offsetLeft, width: el.offsetWidth });
  }, [focusedId]);

  useLayoutEffect(() => {
    measure();
  }, [measure, panes, titleTick]);

  // Widths move for reasons that are not renders: the window resizing, a font
  // finishing loading, the rail running out of room. Watching the list catches
  // all of them without polling.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    for (const el of itemRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [measure, panes]);

  // Selecting a pane on the canvas moves the rail's mark too, so the mark has
  // to be brought within reach when the rail has scrolled. Written as
  // scrollLeft rather than scrollIntoView: that call is allowed to scroll every
  // ancestor it finds, and one of those ancestors is the canvas, whose scroll
  // offset the pan math assumes is zero.
  useEffect(() => {
    const list = listRef.current;
    const el = focusedId ? itemRefs.current.get(focusedId) : null;
    if (!list || !el) return;
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < list.scrollLeft) {
      list.scrollLeft = left - 8;
    } else if (right > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = right - list.clientWidth + 8;
    }
  }, [focusedId, panes.length]);

  useEffect(() => {
    const live = new Set(panes.map((p) => p.id));
    for (const id of itemRefs.current.keys()) {
      if (!live.has(id)) itemRefs.current.delete(id);
    }
    if (live.size === 0) {
      settledRef.current = false;
      setCursor(null);
    }
  }, [panes]);

  // The very first placement is not a journey from the left edge of the rail,
  // so the transition is withheld until the brackets have somewhere to be.
  const wasSettled = settledRef.current;
  useEffect(() => {
    if (cursor) settledRef.current = true;
  }, [cursor]);

  return (
    <footer className="pane-dock">
      {panes.length === 0 ? (
        <span className="pane-dock-empty">no open panes</span>
      ) : (
        <div className="pane-dock-list" ref={listRef} aria-label="Open panes">
          {cursor && (
            <span
              className={`dock-cursor${focusedId ? ' dock-cursor-on' : ''}${
                wasSettled ? '' : ' dock-cursor-placed'
              }`}
              aria-hidden="true"
              style={{ transform: `translateX(${cursor.left}px)`, width: cursor.width }}
            >
              <Brackets />
            </span>
          )}

          {panes.map((pane) => {
            const isFocused = pane.id === focusedId;
            const isSelected = selectedIds.includes(pane.id);
            const label = getPaneTitle(pane.id) ?? pane.title;
            // A derived name is two facts — the folder, and the branch it is on
            // — so it is set as two, with the arrow between them quietest of
            // all. A name the user typed is one fact and stays one string.
            const [folder, branch] = pane.titleLocked ? [label] : label.split(' -> ');

            return (
              // The name and the × are two separate actions, so they are two
              // separate buttons in a row rather than one button with another
              // nested inside it. The row is what carries the hover and the
              // state, and what the brackets are measured against.
              <div
                key={pane.id}
                ref={(el) => {
                  if (el) itemRefs.current.set(pane.id, el);
                }}
                className={`dock-entry${isFocused ? ' dock-entry-on' : isSelected ? ' dock-entry-sel' : ''}`}
              >
                <button
                  type="button"
                  className="dock-item"
                  title={label}
                  aria-current={isFocused ? 'true' : undefined}
                  // The rail hands the keyboard to the pane it reveals, so it
                  // must never take it first: a button that keeps focus after a
                  // click would leave the terminal you just jumped to unable to
                  // receive a keystroke.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onReveal(pane.id)}
                >
                  {/* The globe is a solid glyph and the prompt is a stroked
                      one, so at the same size the browser mark lands visibly
                      heavier. Its weight is trimmed back so a row of mixed
                      panes reads as one set rather than two. */}
                  <span
                    className={`dock-item-mark${pane.kind === 'browser' ? ' dock-item-mark-page' : ''}`}
                    aria-hidden="true"
                  >
                    {pane.kind === 'browser' ? <PageMark /> : <PromptMark />}
                  </span>
                  <span className="dock-item-label">
                    <span className="dock-item-folder">{folder}</span>
                    {branch && (
                      <>
                        <span className="dock-item-sep">-&gt;</span>
                        <span className="dock-item-branch">{branch}</span>
                      </>
                    )}
                  </span>
                </button>

                {/* Always in the flow, only sometimes visible. Appearing on
                    hover would change the row's width, and the brackets are
                    measured from that width — the mark would twitch every time
                    the pointer crossed a name. */}
                <button
                  type="button"
                  className="dock-close"
                  aria-label={`Close ${label}`}
                  title="Close"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onClose(pane.id)}
                >
                  <CloseIcon />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="dock-spacer" />

      {/* Only when a marquee has caught more than one. A single selection is
          already said by the brackets. */}
      {selectionCount > 1 && <span className="dock-selection">{selectionCount} selected</span>}

      {/* The view's own controls, at the far end of the rail that carries the
          view's own list. Bare glyphs and a number: no boxed group, because the
          rail already is the box. */}
      <div className="dock-zoom">
        <button
          type="button"
          className="dock-zoom-btn"
          onClick={onZoomOut}
          title={hint('zoomOut')}
          aria-label={hint('zoomOut')}
        >
          <MinusIcon />
        </button>
        <button type="button" className="dock-zoom-value" onClick={onZoomReset} title={hint('zoomReset')}>
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="dock-zoom-btn"
          onClick={onZoomIn}
          title={hint('zoomIn')}
          aria-label={hint('zoomIn')}
        >
          <PlusIcon />
        </button>
      </div>
    </footer>
  );
}
