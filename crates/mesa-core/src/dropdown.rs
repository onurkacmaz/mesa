//! Which way the completion list opens, and how tall it is.
//!
//! The prompt is normally the LAST row of the pane, so a list that always
//! opened downward would be drawn outside the pane in the ordinary case. It
//! opens downward only while the rows below can hold it whole, flips above the
//! cursor otherwise, and when neither side can hold it shrinks to fit the
//! roomier one rather than being cut off.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Up,
    Down,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placement {
    pub direction: Direction,
    pub row: usize,
    pub rows: usize,
}

pub const DEFAULT_MAX: usize = 8;

pub fn dropdown_placement(cursor_row: usize, term_rows: usize, count: usize, max: usize) -> Placement {
    let wanted = count.min(max);
    let below = term_rows.saturating_sub(cursor_row + 1);
    let above = cursor_row;
    if wanted <= below {
        return Placement { direction: Direction::Down, row: cursor_row + 1, rows: wanted };
    }
    if wanted <= above {
        return Placement { direction: Direction::Up, row: cursor_row - wanted, rows: wanted };
    }
    if below >= above {
        Placement { direction: Direction::Down, row: cursor_row + 1, rows: below }
    } else {
        Placement { direction: Direction::Up, row: cursor_row - above, rows: above }
    }
}
