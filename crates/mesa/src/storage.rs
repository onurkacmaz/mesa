//! The disk, and nothing else: where the session and the flags live, how
//! they are written so a crash cannot half-write them, and how a file this
//! build cannot read is set aside rather than overwritten.
//!
//! What any of it means is decided in `mesa_core::session` and
//! `mesa_core::flags`; this file hands raw text over and takes raw text back.

use std::{
    fs,
    path::{Path, PathBuf},
};

/// Where the last session is kept: the same folder the Electron build used
/// (`~/Library/Application Support/Mesa` on a Mac), so a layout saved by
/// v1.x is the layout this build opens with.
pub fn data_dir() -> PathBuf {
    let base = if cfg!(target_os = "macos") { dirs::data_dir() } else { dirs::config_dir() };
    base.unwrap_or_else(std::env::temp_dir).join("Mesa")
}

pub fn session_path() -> PathBuf {
    data_dir().join("session.json")
}

/// Its own file because the two have different lifetimes: the session is
/// rewritten constantly and archived when it cannot be parsed, and a rescued
/// layout should not also cost answers to questions already asked.
pub fn flags_path() -> PathBuf {
    data_dir().join("flags.json")
}

/// Written to a sibling first and renamed into place, because rename is
/// atomic and a write is not. Quitting mid-write is exactly when this file is
/// being touched, and a half-written JSON costs the whole layout.
pub fn write_atomically(file: &Path, payload: &str) -> bool {
    if let Some(parent) = file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let temp = file.with_extension("json.tmp");
    match fs::write(&temp, payload).and_then(|_| fs::rename(&temp, file)) {
        Ok(()) => true,
        Err(err) => {
            log::error!("write of {} failed: {err}", file.display());
            let _ = fs::remove_file(&temp);
            false
        }
    }
}

/// The raw text of the session file, or `None` on a first launch.
pub fn read_session() -> Option<String> {
    fs::read_to_string(session_path()).ok()
}

/// Put the session file beyond the reach of the next write. Used for a file
/// this app cannot make sense of, because otherwise the first save of the new
/// session quietly overwrites the only copy of someone's layout. It survives
/// as session.json.bak, which can be renamed back by hand.
pub fn archive_session() -> bool {
    let path = session_path();
    fs::rename(&path, path.with_extension("json.bak")).is_ok()
}

pub fn write_session(payload: &str) -> bool {
    write_atomically(&session_path(), payload)
}

/// Unlike the session, a flags file that cannot be read is not set aside:
/// there is no layout in it worth preserving.
pub fn read_flags() -> Option<String> {
    fs::read_to_string(flags_path()).ok()
}

pub fn write_flags(payload: &str) -> bool {
    write_atomically(&flags_path(), payload)
}

/// The zsh bootstrap, written out where zsh can read it. zsh stat()s ZDOTDIR
/// through a real syscall, so the hook cannot live inside the binary; it is
/// compiled in and copied to the data folder whenever the copy there differs.
pub fn shell_hooks_dir() -> Option<PathBuf> {
    const ZSHENV: &str = include_str!("../assets/shell-hooks/zsh/.zshenv");
    let dir = data_dir().join("shell-hooks").join("zsh");
    let file = dir.join(".zshenv");
    if fs::read_to_string(&file).ok().as_deref() != Some(ZSHENV) {
        fs::create_dir_all(&dir).ok()?;
        fs::write(&file, ZSHENV).ok()?;
    }
    Some(dir)
}
