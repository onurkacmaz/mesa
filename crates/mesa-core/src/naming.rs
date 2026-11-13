//! How a pane is named outside itself — on the dock and on the Touch Bar —
//! and how a name is made to fit.
//!
//! A derived name is two facts, "folder -> branch"; a name the user typed is
//! one, even if it happens to contain an arrow ("React -> Vue migration").
//! Only the tab knows which it is, so the split happens where `title_locked`
//! can be read, never later on a bare string.

pub const SEPARATOR: &str = " -> ";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Name {
    pub folder: String,
    pub branch: Option<String>,
}

pub fn split_name(name: &str, locked: bool) -> Name {
    if locked {
        return Name { folder: name.to_string(), branch: None };
    }
    match name.split_once(SEPARATOR) {
        Some((folder, branch)) => Name {
            folder: folder.to_string(),
            branch: (!branch.is_empty()).then(|| branch.to_string()),
        },
        None => Name { folder: name.to_string(), branch: None },
    }
}

pub fn plain_label(name: &Name) -> String {
    match &name.branch {
        Some(b) => format!("{}{SEPARATOR}{b}", name.folder),
        None => name.folder.clone(),
    }
}

const ELLIPSIS: char = '…';
/// A branch cut shorter than this stops identifying anything.
const MIN_BRANCH_CHARS: usize = 3;

/// Characters, not bytes, so an emoji is never split in half.
fn cut(text: &str, n: usize) -> String {
    let mut s: String = text.chars().take(n).collect();
    s.push(ELLIPSIS);
    s
}

/// Makes a name fit `max_width`, as measured by `width_of`. The folder is the
/// part that says which window this is, so it is the last thing to give way:
/// the branch is shortened first, then dropped, and only then is the folder
/// cut. Always at the end: the start of a name is what a glance catches.
pub fn fit_name(name: &Name, max_width: f32, width_of: impl Fn(&Name) -> f32) -> Name {
    if width_of(name) <= max_width {
        return name.clone();
    }
    if let Some(branch) = &name.branch {
        let len = branch.chars().count();
        for n in (MIN_BRANCH_CHARS..len).rev() {
            let candidate = Name { folder: name.folder.clone(), branch: Some(cut(branch, n)) };
            if width_of(&candidate) <= max_width {
                return candidate;
            }
        }
        let bare = Name { folder: name.folder.clone(), branch: None };
        if width_of(&bare) <= max_width {
            return bare;
        }
    }
    let len = name.folder.chars().count();
    for n in (1..len).rev() {
        let candidate = Name { folder: cut(&name.folder, n), branch: None };
        if width_of(&candidate) <= max_width {
            return candidate;
        }
    }
    Name { folder: cut(&name.folder, 1), branch: None }
}
