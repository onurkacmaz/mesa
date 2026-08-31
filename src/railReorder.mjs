// Where a workflow lands when you drag it along the rail.
//
// Pure, like editors.mjs and flags.mjs: what arrives is a row of measured
// boxes and a pointer offset, and the rules for turning those into an order
// are the part worth testing. Nothing in here knows about React or the DOM.
//
// The whole gesture is expressed in two numbers. `dropIndex` says where the
// dragged name would sit if you let go now; `slideFor` says how far each of
// the other names has to move out of its way. The rail is then drawn from
// those, so the order in state changes exactly once — on release — and the
// motion in between is transform only, with nothing reflowing under the
// pointer.

// A slot's box, in rail coordinates: `{ left, width }`.

// A name has taken a neighbour's place once it covers more than half of it —
// so the edge going first is what is asked about, never the pointer and never
// the dragged name's own centre.
//
// The centre is the obvious rule and it is wrong here, because these names are
// as wide as whatever they are called. Carried to the end of the rail, a name
// wider than the one already there still has its centre short of that one's
// centre — the last place on the rail would simply be unreachable for the
// longest name on it, which is the kind of miss that reads as the drag being
// broken.
//
// Measured against the boxes as they were when the drag began. They are the
// only stable set: the boxes on screen are mid-slide, so asking them where
// they are would feed the answer back into itself.
export function dropIndex(rects, from, dx) {
  const self = rects[from];
  const left = self.left + dx;
  const right = left + self.width;
  let to = from;
  // Moving right: the leading edge is the right one.
  for (let i = from + 1; i < rects.length; i += 1) {
    if (right > rects[i].left + rects[i].width / 2) to = i;
  }
  // Moving left it is the left edge, and the row is read from the dragged slot
  // outwards so `to` ends up at the furthest name passed rather than the
  // nearest.
  for (let i = from - 1; i >= 0; i -= 1) {
    if (left < rects[i].left + rects[i].width / 2) to = i;
  }
  return to;
}

// How far the name at `index` steps aside. Taking a slot out of the row leaves
// a hole exactly its own width plus one gap wide, and every name between where
// it left and where it is going slides across that hole — so one distance
// covers all of them, whatever their own widths are.
export function slideFor(index, from, to, distance) {
  if (index === from) return 0;
  if (index > from && index <= to) return -distance;
  if (index < from && index >= to) return distance;
  return 0;
}

// The gap between two slots, read off the row rather than written down here.
// It is the CSS gap plus the cut scored between them, and this file has no
// business knowing either number.
export function gapBetween(rects, fallback = 0) {
  for (let i = 1; i < rects.length; i += 1) {
    const gap = rects[i].left - (rects[i - 1].left + rects[i - 1].width);
    if (gap > 0) return gap;
  }
  return fallback;
}

// The dragged name stays on the rail. Without this it can be thrown past
// either end, which drops in the same place it would have anyway and looks
// like the rail has lost hold of it.
export function clampOffset(rects, from, dx) {
  const first = rects[0];
  const last = rects[rects.length - 1];
  const self = rects[from];
  const min = first.left - self.left;
  const max = last.left + last.width - (self.left + self.width);
  return Math.min(Math.max(dx, min), max);
}

// The order after the drop. A new array every time, because this is going
// straight into state.
export function reorder(list, from, to) {
  if (from === to) return list;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
