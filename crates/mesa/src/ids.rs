//! The id counters. One for panes and tabs alike (a tab IS what a pane used
//! to be: its id is what the pty, the title, the folder and the address are
//! keyed by), one for workflows, and one that numbers default names
//! ("Terminal 4").
//!
//! They start at zero every launch, which is right for a first launch and
//! wrong for every restored one, so they are seeded from the restored
//! session before any workflow is built — and only ever upward.

use std::sync::atomic::{AtomicU64, Ordering};

static PANE: AtomicU64 = AtomicU64::new(0);
static SESSION: AtomicU64 = AtomicU64::new(0);
static WORKFLOW: AtomicU64 = AtomicU64::new(0);

pub fn seed(pane: u64, session: u64, workflow: u64) {
    PANE.fetch_max(pane, Ordering::SeqCst);
    SESSION.fetch_max(session, Ordering::SeqCst);
    WORKFLOW.fetch_max(workflow, Ordering::SeqCst);
}

pub fn next_id(prefix: &str) -> String {
    format!("{prefix}-{}", PANE.fetch_add(1, Ordering::SeqCst) + 1)
}

pub fn next_session() -> u64 {
    SESSION.fetch_add(1, Ordering::SeqCst) + 1
}

pub fn next_workflow() -> u64 {
    WORKFLOW.fetch_add(1, Ordering::SeqCst) + 1
}

/// Written into the session so a pane opened and then closed still counts.
pub fn counters() -> (u64, u64, u64) {
    (PANE.load(Ordering::SeqCst), SESSION.load(Ordering::SeqCst), WORKFLOW.load(Ordering::SeqCst))
}
