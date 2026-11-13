//! The pure half of Mesa.
//!
//! Everything here is free of the UI, the filesystem and the processes it
//! drives, which is why the parts of the app that can ruin a launch (reading
//! a session back) or quietly lie (ranking a completion, reading a shell's
//! report of its own line) are also the parts that are directly tested. The
//! app crate can see the disk, the ptys and the window; what any of it means
//! is decided here.

pub mod accept;
pub mod command_line;
pub mod command_signature;
pub mod dropdown;
pub mod editors;
pub mod flags;
pub mod naming;
pub mod rail_reorder;
pub mod rank;
pub mod schema;
pub mod session;
pub mod stream;
pub mod terminal_osc;
pub mod zle;
pub mod zsh_history;
