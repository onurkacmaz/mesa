//! Which editors this Mac has, and which one you meant.
//!
//! Mesa does not embed an editor. Embedding a native one would mean adopting
//! another process's window into this app's view hierarchy, which macOS has
//! no public API for. So ⌘E hands the folder to the editor already installed
//! and gets out of the way.
//!
//! Pure: what arrives is a list of file names read off a disk and a
//! preference read out of a JSON file, and the rules for making sense of them
//! are the part worth testing.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Editor {
    /// What `open -a` takes: the bundle name, stable in a way a path is not.
    pub app: String,
    pub label: String,
}

/// The order here is the order the chooser offers them in, and it is fixed on
/// purpose: a list built in the order the filesystem happened to return would
/// put a different editor under the pointer on different machines.
///
/// This list will never be complete, and it is not meant to be. Anything
/// missing is reachable through the picker instead, and once picked it is
/// carried by `pinned` below.
pub const KNOWN_EDITORS: &[(&str, &str)] = &[
    ("Visual Studio Code", "VS Code"),
    ("Visual Studio Code - Insiders", "VS Code Insiders"),
    ("VSCodium", "VSCodium"),
    ("Cursor", "Cursor"),
    ("Windsurf", "Windsurf"),
    ("Zed", "Zed"),
    ("Sublime Text", "Sublime Text"),
    ("Nova", "Nova"),
    ("BBEdit", "BBEdit"),
    ("TextMate", "TextMate"),
    ("Emacs", "Emacs"),
    ("MacVim", "MacVim"),
    ("IntelliJ IDEA", "IntelliJ IDEA"),
    ("IntelliJ IDEA Ultimate", "IntelliJ IDEA"),
    ("IntelliJ IDEA Community Edition", "IntelliJ IDEA CE"),
    ("WebStorm", "WebStorm"),
    ("PhpStorm", "PhpStorm"),
    ("PyCharm", "PyCharm"),
    ("PyCharm Community Edition", "PyCharm CE"),
    ("RubyMine", "RubyMine"),
    ("GoLand", "GoLand"),
    ("CLion", "CLion"),
    ("Rider", "Rider"),
    ("RustRover", "RustRover"),
    ("DataGrip", "DataGrip"),
    ("Fleet", "Fleet"),
    ("Android Studio", "Android Studio"),
    ("Xcode", "Xcode"),
];

/// `["Zed.app", "Chess.app"]` → the editors among them. Anything unrecognised
/// is passed over rather than guessed at: macOS has no honest flag for "this
/// one edits code".
///
/// `pinned` is the way out of that: an application chosen by hand through the
/// picker is offered from then on, whether or not this file has heard of it.
/// It is still checked against what is installed, so an editor deleted last
/// week quietly stops being offered rather than failing at launch.
pub fn editors_from<S: AsRef<str>>(file_names: &[S], pinned: Option<&str>) -> Vec<Editor> {
    let found: std::collections::HashSet<&str> = file_names
        .iter()
        .map(|n| {
            let n = n.as_ref();
            n.strip_suffix(".app").unwrap_or(n)
        })
        .collect();
    let mut editors: Vec<Editor> = KNOWN_EDITORS
        .iter()
        .filter(|(app, _)| found.contains(app))
        .map(|(app, label)| Editor { app: app.to_string(), label: label.to_string() })
        .collect();
    if let Some(pinned) = pinned.filter(|p| !p.is_empty()) {
        if found.contains(pinned) && !editors.iter().any(|e| e.app == pinned) {
            // Last, and labelled with its own bundle name: there is nothing
            // else to call an application this file has never seen.
            editors.push(Editor { app: pinned.to_string(), label: pinned.to_string() });
        }
    }
    editors
}

/// The stored preference, checked against what is actually installed. `None`
/// means "ask" — and it is also what a preference for an editor since deleted
/// resolves to, because silently opening a different editor than the one
/// someone chose is worse than asking again.
///
/// One installed editor is not an answer either: choosing on someone's behalf
/// would leave them with a setting they never made.
pub fn resolve_editor<'a>(preference: Option<&str>, available: &'a [Editor]) -> Option<&'a Editor> {
    let preference = preference.filter(|p| !p.is_empty())?;
    available.iter().find(|e| e.app == preference)
}
