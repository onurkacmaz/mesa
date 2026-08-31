import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampOffset,
  dropIndex,
  gapBetween,
  reorder,
  slideFor
} from '../src/railReorder.mjs';

// Three slots of deliberately different widths, 9 apart — a rail whose names
// are "Workflow 1", something short, and something long, which is the case
// where any arithmetic that assumes one slot width falls over.
const rects = [
  { left: 0, width: 100 }, // centre 50
  { left: 109, width: 40 }, // centre 129
  { left: 158, width: 200 } // centre 258
];

// Every drag is expressed as an offset from where the name started, which is
// exactly what the component has: the pointer's travel, clamped to the rail.
const at = (i, dx) => dropIndex(rects, i, dx);

test('a name that has not passed anything stays where it is', () => {
  assert.equal(at(0, 20), 0);
  assert.equal(at(2, -25), 2);
});

test('a name drops where it has been carried past', () => {
  // Its right edge past the middle name's centre (129), and then past the
  // last one's (258).
  assert.equal(at(0, 30), 1);
  assert.equal(at(0, 159), 2);
});

test('the same holds dragging back towards the front of the rail', () => {
  assert.equal(at(2, -29), 2); // left edge on 129, not past it
  assert.equal(at(2, -30), 1); // past it
  assert.equal(at(2, -109), 0); // and past 50
});

test('the widest name on the rail can still reach either end of it', () => {
  // The whole reason the edges decide this and not the centre. The long name
  // carried as far right as the rail allows must land last, and as far left
  // must land first — its centre never reaches either neighbour's.
  const right = clampOffset(rects, 2, 10000);
  assert.equal(at(2, right), 2);
  const left = clampOffset(rects, 2, -10000);
  assert.equal(at(2, left), 0);

  const wide = [
    { left: 0, width: 240 },
    { left: 249, width: 40 },
    { left: 298, width: 40 }
  ];
  assert.equal(dropIndex(wide, 0, clampOffset(wide, 0, 10000)), 2);
});

test('crossing a narrow name takes only the room that name occupies', () => {
  // The boundary is that name's centre, never the dragged name's own width:
  // a pixel short of it is no move, a pixel past it is.
  assert.equal(at(0, 28), 0);
  assert.equal(at(0, 30), 1);
});

test('the names in between step aside by one hole, whatever they are called', () => {
  const distance = rects[0].width + 9;
  assert.equal(slideFor(0, 0, 2, distance), 0); // the one in hand
  assert.equal(slideFor(1, 0, 2, distance), -distance);
  assert.equal(slideFor(2, 0, 2, distance), -distance);
});

test('names outside the span the drag covers do not move at all', () => {
  assert.equal(slideFor(2, 0, 1, 109), 0);
  assert.equal(slideFor(0, 2, 1, 209), 0);
});

test('dragging towards the front pushes the names it passes forwards', () => {
  const distance = rects[2].width + 9;
  assert.equal(slideFor(0, 2, 0, distance), distance);
  assert.equal(slideFor(1, 2, 0, distance), distance);
  assert.equal(slideFor(2, 2, 0, distance), 0);
});

test('the gap is read off the rail rather than assumed', () => {
  assert.equal(gapBetween(rects), 9);
  assert.equal(gapBetween([{ left: 0, width: 100 }], 4), 4);
});

test('a name cannot be thrown off either end of the rail', () => {
  assert.equal(clampOffset(rects, 0, -400), 0);
  assert.equal(clampOffset(rects, 0, 400), 258);
  assert.equal(clampOffset(rects, 2, -400), -158);
  assert.equal(clampOffset(rects, 1, 20), 20);
});

test('the order after the drop is a new array', () => {
  const list = ['a', 'b', 'c'];
  assert.deepEqual(reorder(list, 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(reorder(list, 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(list, ['a', 'b', 'c']);
});

test('a drop where it started leaves the order untouched', () => {
  const list = ['a', 'b', 'c'];
  assert.equal(reorder(list, 1, 1), list);
});
