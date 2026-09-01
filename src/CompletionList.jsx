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
  screenLeft,
  screenTop,
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
  const page = items.slice(first, first + placed.rows);

  // The best match sits nearest the line you are typing on — so at the BOTTOM
  // when the list opens upward, and at the top when it opens downward. Warp
  // does the same thing and says so in as many words: its history is sorted
  // oldest-first precisely "so that current session items appear at the bottom
  // (closer to input)". Always drawing the best match at the top looks right
  // until the list flips, and then the thing you almost certainly want is as
  // far from the cursor as it can get.
  const upward = placed.direction === 'up';
  const visible = upward ? [...page].reverse() : page;
  const indexOf = (i) => (upward ? first + placed.rows - 1 - i : first + i);

  // Anchored to an EDGE of the cursor's row, not to a row number.
  //
  // Placing the top at `placed.row * cellHeight` meant the list's own height
  // had to match the rows it had reserved, and it never does — its rows are
  // set in CSS and a terminal cell is whatever the font measures. Measured at
  // 59% zoom: six reserved rows came to 22px more than the list needed, so it
  // hung in mid-air well above the prompt instead of sitting on it. In the
  // other direction — a taller row, a longer description — the same mismatch
  // would have run the list down over the line being typed.
  //
  // Opening upward it is pinned by its BOTTOM to the top of the cursor's row,
  // with translateY(-100%) doing the work so nothing here needs to know how
  // tall the list turned out. Opening downward it is pinned by its top to the
  // bottom of that row. Either way it touches the line exactly, and can never
  // cover it.
  //
  // screenLeft/screenTop are the terminal screen's own inset inside the pane.
  // Ignoring them put every row half a cell out of true.
  const rowTop = screenTop + cursorRow * cellHeight;
  return (
    <div
      className="completion-list"
      style={{
        left: `${screenLeft + cursorCol * cellWidth}px`,
        top: `${upward ? rowTop : rowTop + cellHeight}px`,
        transform: upward ? 'translateY(-100%)' : undefined
      }}
    >
      {visible.map((item, i) => (
        <button
          key={item.value}
          type="button"
          className={
            indexOf(i) === selected ? 'completion-row completion-row-on' : 'completion-row'
          }
          // The pane must not lose focus to the list, or the next keystroke
          // goes nowhere. mousedown is where focus would move, so that is
          // where it is refused.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(indexOf(i));
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
