import test from 'node:test';
import assert from 'node:assert/strict';

import { dropdownPlacement } from '../src/dropdownPlacement.mjs';

test('with room below, the list opens downward under the cursor', () => {
  assert.deepEqual(dropdownPlacement({ cursorRow: 2, termRows: 40, count: 5 }), {
    direction: 'down',
    row: 3,
    rows: 5
  });
});

// The steady state: the prompt is the last row of the pane. A list drawn
// downward here would be entirely outside it.
test('at the bottom of the pane the list flips above the cursor', () => {
  assert.deepEqual(dropdownPlacement({ cursorRow: 39, termRows: 40, count: 5 }), {
    direction: 'up',
    row: 34,
    rows: 5
  });
});

test('it flips as soon as the rows below will not hold it whole', () => {
  // 4 rows below the cursor, 5 wanted.
  assert.equal(dropdownPlacement({ cursorRow: 35, termRows: 40, count: 5 }).direction, 'up');
  // 5 rows below, 5 wanted: it still fits.
  assert.equal(dropdownPlacement({ cursorRow: 34, termRows: 40, count: 5 }).direction, 'down');
});

test('the list never grows past the cap', () => {
  assert.equal(dropdownPlacement({ cursorRow: 0, termRows: 40, count: 30 }).rows, 8);
  assert.equal(dropdownPlacement({ cursorRow: 0, termRows: 40, count: 30, max: 3 }).rows, 3);
});

// Half a row hanging off the pane edge reads as broken, so the list shrinks
// to what the side it opens on can actually hold.
test('in a short pane it shrinks rather than being cut off', () => {
  const placed = dropdownPlacement({ cursorRow: 4, termRows: 6, count: 8 });
  assert.equal(placed.direction, 'up');
  assert.equal(placed.rows, 4);
  assert.equal(placed.row, 0);
});

test('it takes the roomier side when neither can hold it whole', () => {
  // 2 rows above, 3 below.
  assert.equal(dropdownPlacement({ cursorRow: 2, termRows: 6, count: 8 }).direction, 'down');
});

test('a pane with no room at all asks for no rows', () => {
  assert.deepEqual(dropdownPlacement({ cursorRow: 0, termRows: 1, count: 5 }), {
    direction: 'down',
    row: 1,
    rows: 0
  });
});

test('nothing to show is no rows, whatever the room', () => {
  assert.equal(dropdownPlacement({ cursorRow: 2, termRows: 40, count: 0 }).rows, 0);
});

// Whichever way it opens, every row it claims has to be a real row of the
// pane. This is the invariant the whole flip rule exists to hold.
test('the rows it claims always sit inside the pane', () => {
  for (let termRows = 1; termRows <= 12; termRows += 1) {
    for (let cursorRow = 0; cursorRow < termRows; cursorRow += 1) {
      const p = dropdownPlacement({ cursorRow, termRows, count: 8 });
      assert.ok(p.rows >= 0, `negative rows at ${cursorRow}/${termRows}`);
      if (p.rows === 0) continue;
      assert.ok(p.row >= 0, `starts above the pane at ${cursorRow}/${termRows}`);
      assert.ok(
        p.row + p.rows <= termRows,
        `runs past the bottom at ${cursorRow}/${termRows}: ${p.row}+${p.rows}`
      );
    }
  }
});
