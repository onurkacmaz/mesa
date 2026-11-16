//! What the app asks of the machine outside its own window: which branch a
//! folder is on, which editors are installed, and handing a folder to one.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// Reads which git branch a directory is on. Deliberately does not run
/// `git`: that would mean spawning a process on every prompt, and .git/HEAD
/// is a one-line file that already names the branch.
///
/// `.git` can be a file rather than a directory (submodules and worktrees):
/// then it holds a single `gitdir:` line pointing at the real git directory.
pub fn git_branch_at(dir: &Path) -> Option<String> {
    if !dir.is_absolute() {
        return None;
    }
    let mut current = dir.to_path_buf();
    for _ in 0..64 {
        let dot_git = current.join(".git");
        if let Ok(meta) = fs::metadata(&dot_git) {
            let git_dir = if meta.is_file() {
                let text = fs::read_to_string(&dot_git).ok()?;
                let line = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?;
                current.join(line.trim())
            } else {
                dot_git
            };
            let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
            let head = head.trim();
            // A detached HEAD has no name; the short sha is the only readable
            // thing.
            return match head.strip_prefix("ref: refs/heads/") {
                Some(branch) => Some(branch.to_string()),
                None => head.get(..7).map(str::to_string).filter(|s| !s.is_empty()),
            };
        }
        if !current.pop() {
            return None;
        }
    }
    None
}

/// The two places a Mac keeps applications. A per-user install is just as
/// real as a system-wide one.
#[cfg(target_os = "macos")]
fn application_folders() -> Vec<PathBuf> {
    let mut v = vec![PathBuf::from("/Applications")];
    if let Some(home) = dirs::home_dir() {
        v.push(home.join("Applications"));
    }
    v
}

/// Every bundle name found, unfiltered — which of them is an editor is
/// decided in `mesa_core::editors`. One level down as well as the top
/// (/Applications/Utilities, JetBrains Toolbox's own folder), never a full
/// walk into every bundle's contents.
#[cfg(target_os = "macos")]
pub fn list_applications() -> Vec<String> {
    let mut names = std::collections::BTreeSet::new();
    let read = |p: &Path| fs::read_dir(p).map(|r| r.flatten().collect::<Vec<_>>()).unwrap_or_default();
    for folder in application_folders() {
        for entry in read(&folder) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".app") {
                names.insert(name);
            } else if entry.path().is_dir() {
                for inner in read(&entry.path()) {
                    let inner = inner.file_name().to_string_lossy().to_string();
                    if inner.ends_with(".app") {
                        names.insert(inner);
                    }
                }
            }
        }
    }
    names.into_iter().collect()
}

/// Off a Mac there are no bundles, so the same names are answered from the
/// command-line launchers those editors install, found on PATH.
#[cfg(not(target_os = "macos"))]
pub fn list_applications() -> Vec<String> {
    LINUX_LAUNCHERS
        .iter()
        .filter(|(_, bin)| which(bin).is_some())
        .map(|(app, _)| format!("{app}.app"))
        .collect()
}

#[cfg(not(target_os = "macos"))]
const LINUX_LAUNCHERS: &[(&str, &str)] = &[
    ("Visual Studio Code", "code"),
    ("VSCodium", "codium"),
    ("Cursor", "cursor"),
    ("Windsurf", "windsurf"),
    ("Zed", "zed"),
    ("Sublime Text", "subl"),
    ("Emacs", "emacs"),
    ("IntelliJ IDEA", "idea"),
    ("PyCharm", "pycharm"),
    ("GoLand", "goland"),
    ("RustRover", "rustrover"),
];

#[cfg(not(target_os = "macos"))]
fn which(bin: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")?
        .to_str()?
        .split(':')
        .map(|d| Path::new(d).join(bin))
        .find(|p| p.is_file())
}

/// `open -a <app> <dir>`, with an argument array and no shell, so nothing in
/// either string can be read as syntax.
///
/// Both are checked even though both come from this app: the folder is
/// whatever a shell last reported through OSC 7, and the app name has been
/// out to disk and back through a JSON file anyone could have edited. So the
/// folder must be an absolute path that is really a directory, and the app
/// must be one this machine actually has.
pub fn open_in_editor(app: &str, dir: &str) -> bool {
    if app.is_empty() {
        return false;
    }
    let path = Path::new(dir);
    if !path.is_absolute() || !path.is_dir() {
        return false;
    }
    let bundle = format!("{app}.app");
    if !list_applications().contains(&bundle) {
        return false;
    }
    #[cfg(target_os = "macos")]
    let spawned = Command::new("open").args(["-a", app, dir]).spawn();
    #[cfg(not(target_os = "macos"))]
    let spawned = match LINUX_LAUNCHERS.iter().find(|(a, _)| *a == app) {
        Some((_, bin)) => Command::new(bin).arg(dir).spawn(),
        None => return false,
    };
    match spawned {
        Ok(_) => true,
        Err(err) => {
            log::error!("editor launch failed: {err}");
            false
        }
    }
}

/// The bundle name of a picked application, if it is one the folders above
/// actually hold — picking one from elsewhere would be accepted here and
/// refused at launch, which is worse than not offering it.
pub fn bundle_name_of(picked: &Path) -> Option<String> {
    let name = picked.file_name()?.to_str()?.strip_suffix(".app")?.to_string();
    list_applications().contains(&format!("{name}.app")).then_some(name)
}

/// /Users/someone/src/mesa → ~/src/mesa (also /home/someone).
pub fn home_relative(path: &str) -> String {
    if let Some(home) = dirs::home_dir().and_then(|h| h.to_str().map(str::to_string)) {
        if path == home {
            return "~".into();
        }
        if let Some(rest) = path.strip_prefix(&format!("{home}/")) {
            return format!("~/{rest}");
        }
    }
    path.to_string()
}

pub fn is_home(path: &str) -> bool {
    dirs::home_dir().and_then(|h| h.to_str().map(|h| h == path)).unwrap_or(false)
}
