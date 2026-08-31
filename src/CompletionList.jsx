// The completion list, drawn inside the pane.
//
// Inside is the whole point. Panes live in one transform: translate() scale()
// layer, so a list positioned in viewport coordinates would drift and
// mis-scale at every zoom but 100% — the same trap the mouse-selection code
// in TerminalView.jsx had to be corrected for. Positioned in terminal rows
// and columns inside the pane, it scales with the canvas for free and needs
// no correction maths at all.

import { dropdownPlacement } from './dropdownPlacement.mjs';

export default function CompletionList({
  items,
  selected,
  cursorRow,
  cursorCol,
  termRows,
  cellWidth,
  cellHeight,
  onPick
}) {
  if (items.length === 0) return null;

  const placed = dropdownPlacement({ cursorRow, termRows, count: items.length });
  if (placed.rows === 0) return null;

  // Only the rows that fit are drawn, and the selected one is always among
  // them: a selection scrolled out of view reads as the list being stuck.
  const first = Math.max(
    0,
    Math.min(selected - placed.rows + 1, items.length - placed.rows)
  );
  const visible = items.slice(first, first + placed.rows);

  return (
    <div
      className="completion-list"
      style={{
        left: `${cursorCol * cellWidth}px`,
        top: `${placed.row * cellHeight}px`
      }}
    >
      {visible.map((item, i) => (
        <button
          key={item.value}
          type="button"
          className={
            first + i === selected ? 'completion-row completion-row-on' : 'completion-row'
          }
          // The pane must not lose focus to the list, or the next keystroke
          // goes nowhere. mousedown is where focus would move, so that is
          // where it is refused.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(first + i);
          }}
        >
          <span className="completion-value">{item.value}</span>
          {item.description ? (
            <span className="completion-description">{item.description}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
