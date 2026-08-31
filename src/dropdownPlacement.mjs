// Which way the completion list opens, and how tall it is.
//
// Pure, like railReorder.mjs: row counts in, a placement out. Nothing here
// knows about the DOM.
//
// The rule exists because the prompt is normally the LAST row of the pane,
// not a row somewhere in the middle. A list that always opened downward would
// therefore be drawn outside the pane and clipped away in the ordinary case,
// which is the case that matters. So it opens downward only while the rows
// below can hold it whole, and flips above the cursor otherwise.
//
// When neither side can hold it, it shrinks to fit the roomier one rather
// than being cut off at the pane edge. A half-drawn row reads as broken.

export function dropdownPlacement({ cursorRow, termRows, count, max = 8 }) {
  const wanted = Math.min(count, max);
  const below = termRows - cursorRow - 1;
  const above = cursorRow;

  if (wanted <= below) return { direction: 'down', row: cursorRow + 1, rows: wanted };
  if (wanted <= above) return { direction: 'up', row: cursorRow - wanted, rows: wanted };

  if (below >= above) return { direction: 'down', row: cursorRow + 1, rows: below };
  return { direction: 'up', row: cursorRow - above, rows: above };
}
