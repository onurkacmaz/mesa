//! Where a workflow lands when you drag it along the rail.
//!
//! The gesture is two numbers: `drop_index` says where the dragged name would
//! sit if you let go now; `slide_for` says how far each other name moves out
//! of its way. The order in state changes exactly once — on release.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Slot {
    pub left: f32,
    pub width: f32,
}

/// A name has taken a neighbour's place once it covers more than half of it —
/// the leading edge is what is asked about, never the centre, so the longest
/// name on the rail can still reach either end of it. Measured against the
/// boxes as they were when the drag began.
pub fn drop_index(rects: &[Slot], from: usize, dx: f32) -> usize {
    let me = rects[from];
    let left = me.left + dx;
    let right = left + me.width;
    let mut to = from;
    for (i, r) in rects.iter().enumerate().skip(from + 1) {
        if right > r.left + r.width / 2.0 {
            to = i;
        }
    }
    for i in (0..from).rev() {
        let r = rects[i];
        if left < r.left + r.width / 2.0 {
            to = i;
        }
    }
    to
}

/// Taking a slot out of the row leaves a hole its own width plus one gap
/// wide, and every name between where it left and where it is going slides
/// across that hole by the same distance.
pub fn slide_for(index: usize, from: usize, to: usize, distance: f32) -> f32 {
    if index == from {
        0.0
    } else if index > from && index <= to {
        -distance
    } else if index < from && index >= to {
        distance
    } else {
        0.0
    }
}

pub fn gap_between(rects: &[Slot], fallback: f32) -> f32 {
    for w in rects.windows(2) {
        let gap = w[1].left - (w[0].left + w[0].width);
        if gap > 0.0 {
            return gap;
        }
    }
    fallback
}

/// The dragged name stays on the rail rather than being thrown past an end.
pub fn clamp_offset(rects: &[Slot], from: usize, dx: f32) -> f32 {
    let first = rects[0];
    let last = rects[rects.len() - 1];
    let me = rects[from];
    let min = first.left - me.left;
    let max = last.left + last.width - (me.left + me.width);
    dx.max(min).min(max)
}

pub fn reorder<T: Clone>(list: &[T], from: usize, to: usize) -> Vec<T> {
    let mut next = list.to_vec();
    if from != to && from < next.len() {
        let moved = next.remove(from);
        next.insert(to.min(next.len()), moved);
    }
    next
}
