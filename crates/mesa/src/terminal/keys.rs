//! A keystroke, as the bytes a shell expects.
//!
//! macOS line editing comes first. Option and Command are not Meta, so the
//! editing shortcuts every other Mac text field has never reach the shell.
//! The blunt fix — Option as Meta — would take the whole Option layer away,
//! and a Turkish keyboard needs it: Option+Q is how you type "@". So each
//! combination is translated on its own and every other Option press is left
//! alone, arriving as the character it types.

use gpui::Keystroke;

use alacritty_terminal::term::TermMode;

/// Control characters rather than ESC-prefixed sequences where it matters:
/// ESC+DEL is emacs-only, and in vi mode a lone ESC drops you into command
/// mode. ^W and ^U do the same job in both keymaps. The ESC-prefixed word
/// motions are bound into vi-insert too by the shell hook.
fn mac_line_editing(k: &Keystroke) -> Option<&'static str> {
    let m = &k.modifiers;
    if m.control || m.shift {
        return None;
    }
    match (m.alt, m.platform, k.key.as_str()) {
        (true, false, "backspace") => Some("\x17"), // kill the word before the cursor
        (false, true, "backspace") => Some("\x15"), // kill back to the start of the line
        (true, false, "left") => Some("\x1bb"),     // back one word
        (true, false, "right") => Some("\x1bf"),    // forward one word
        (true, false, "delete") => Some("\x1bd"),   // kill the word after the cursor
        (false, true, "left") => Some("\x01"),      // start of line
        (false, true, "right") => Some("\x05"),     // end of line
        _ => None,
    }
}

/// The xterm modifier parameter: 1 + shift + 2·alt + 4·ctrl.
fn modifier_code(k: &Keystroke) -> u8 {
    let m = &k.modifiers;
    1 + m.shift as u8 + 2 * m.alt as u8 + 4 * m.control as u8
}

pub fn to_bytes(k: &Keystroke, mode: TermMode) -> Option<String> {
    if let Some(s) = mac_line_editing(k) {
        return Some(s.to_string());
    }
    let m = &k.modifiers;
    // Anything held with Command belongs to the app, not the shell.
    if m.platform {
        return None;
    }
    let app_cursor = mode.contains(TermMode::APP_CURSOR);
    let modc = modifier_code(k);
    let csi = |final_: char| -> String {
        if modc > 1 {
            format!("\x1b[1;{modc}{final_}")
        } else if app_cursor {
            format!("\x1bO{final_}")
        } else {
            format!("\x1b[{final_}")
        }
    };
    let ss3 = |final_: char| -> String {
        if modc > 1 {
            format!("\x1b[1;{modc}{final_}")
        } else {
            format!("\x1bO{final_}")
        }
    };
    let tilde = |n: u8| -> String {
        if modc > 1 {
            format!("\x1b[{n};{modc}~")
        } else {
            format!("\x1b[{n}~")
        }
    };
    let s = match k.key.as_str() {
        // Shift+Enter is ESC+CR: at the prompt the shell hook binds it to a
        // widget that inserts a real newline without running the line; a TUI
        // reads it as Alt+Enter. A raw LF would have run the command.
        "enter" if m.shift && !m.alt && !m.control => "\x1b\r".into(),
        "enter" if m.alt => "\x1b\r".into(),
        "enter" => "\r".into(),
        "tab" if m.shift => "\x1b[Z".into(),
        "tab" => "\t".into(),
        "escape" => "\x1b".into(),
        "backspace" if m.control => "\x08".into(),
        "backspace" if m.alt => "\x1b\x7f".into(),
        "backspace" => "\x7f".into(),
        "space" if m.control => "\x00".into(),
        "space" if m.alt && !cfg!(target_os = "macos") => "\x1b ".into(),
        "space" => " ".into(),
        "up" => csi('A'),
        "down" => csi('B'),
        "right" => csi('C'),
        "left" => csi('D'),
        "home" => csi('H'),
        "end" => csi('F'),
        "pageup" => tilde(5),
        "pagedown" => tilde(6),
        "insert" => tilde(2),
        "delete" => tilde(3),
        "f1" => ss3('P'),
        "f2" => ss3('Q'),
        "f3" => ss3('R'),
        "f4" => ss3('S'),
        "f5" => tilde(15),
        "f6" => tilde(17),
        "f7" => tilde(18),
        "f8" => tilde(19),
        "f9" => tilde(20),
        "f10" => tilde(21),
        "f11" => tilde(23),
        "f12" => tilde(24),
        key if m.control && key.chars().count() == 1 => {
            let c = key.chars().next().unwrap().to_ascii_lowercase();
            let byte = match c {
                'a'..='z' => (c as u8) & 0x1f,
                '@' | '2' | ' ' => 0x00,
                '[' | '3' => 0x1b,
                '\\' | '4' => 0x1c,
                ']' | '5' => 0x1d,
                '^' | '6' => 0x1e,
                '_' | '-' | '7' => 0x1f,
                '?' | '8' => 0x7f,
                _ => return None,
            };
            let mut s = String::new();
            if m.alt {
                s.push('\x1b');
            }
            s.push(byte as char);
            s
        }
        _ => {
            // A typed character. On a Mac, Option produces its own layer
            // (Option+Q is "@" on a Turkish keyboard) and key_char carries it.
            // Elsewhere Alt is Meta, the ESC prefix every terminal sends.
            let ch = k.key_char.clone().or_else(|| (k.key.chars().count() == 1).then(|| k.key.clone()))?;
            if m.alt && !cfg!(target_os = "macos") {
                format!("\x1b{}", k.key)
            } else {
                ch
            }
        }
    };
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ks(s: &str) -> Keystroke {
        Keystroke::parse(s).unwrap()
    }

    #[test]
    fn named_keys() {
        assert_eq!(to_bytes(&ks("enter"), TermMode::NONE).as_deref(), Some("\r"));
        assert_eq!(to_bytes(&ks("shift-enter"), TermMode::NONE).as_deref(), Some("\x1b\r"));
        assert_eq!(to_bytes(&ks("up"), TermMode::NONE).as_deref(), Some("\x1b[A"));
        assert_eq!(to_bytes(&ks("up"), TermMode::APP_CURSOR).as_deref(), Some("\x1bOA"));
        assert_eq!(to_bytes(&ks("ctrl-c"), TermMode::NONE).as_deref(), Some("\x03"));
        assert_eq!(to_bytes(&ks("space"), TermMode::NONE).as_deref(), Some(" "));
        assert_eq!(to_bytes(&ks("shift-tab"), TermMode::NONE).as_deref(), Some("\x1b[Z"));
        assert_eq!(to_bytes(&ks("f1"), TermMode::NONE).as_deref(), Some("\x1bOP"));
        assert_eq!(to_bytes(&ks("f5"), TermMode::NONE).as_deref(), Some("\x1b[15~"));
        assert_eq!(to_bytes(&ks("ctrl-up"), TermMode::NONE).as_deref(), Some("\x1b[1;5A"));
    }

    #[test]
    fn mac_editing_and_command_keys() {
        assert_eq!(to_bytes(&ks("alt-backspace"), TermMode::NONE).as_deref(), Some("\x17"));
        assert_eq!(to_bytes(&ks("cmd-backspace"), TermMode::NONE).as_deref(), Some("\x15"));
        assert_eq!(to_bytes(&ks("cmd-left"), TermMode::NONE).as_deref(), Some("\x01"));
        assert_eq!(to_bytes(&ks("cmd-w"), TermMode::NONE), None);
    }
}
