//! The handful of things the app remembers about the person using it, rather
//! than about their work. A layout belongs in session.json; this file is for
//! answers to questions the app should only ask once, and for the one
//! preference the window chrome carries (the theme).
//!
//! It is kept apart from the session on purpose. session.json is rewritten on
//! every change and is archived out of the way whenever it cannot be parsed,
//! so a layout rescued from a bad file would also, silently, forget that the
//! onboarding had ever been shown. These facts have different lifetimes and
//! different failure modes, so they get different files.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Three states, because "follow the system" is a real preference and not
/// the same as picking a side.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    Auto,
    Light,
    Dark,
}

impl ThemeMode {
    pub const ALL: [ThemeMode; 3] = [ThemeMode::Auto, ThemeMode::Light, ThemeMode::Dark];

    pub fn label(self) -> &'static str {
        match self {
            ThemeMode::Auto => "Auto",
            ThemeMode::Light => "Light",
            ThemeMode::Dark => "Dark",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    /// Strictly `true`, never merely truthy: a string, a 1, or an object that
    /// happens to be present is not someone having answered yes.
    pub seen_onboarding: bool,
    /// The bundle name of the editor ⌘E opens folders in — "Zed", "Cursor".
    /// Whether it is still installed is a question for `editors`.
    pub editor: Option<String>,
    /// The chrome's theme. The Electron build kept this in the renderer's
    /// localStorage; there is no renderer any more, so it lives here.
    #[serde(default)]
    pub theme: ThemeMode,
}

/// Nothing seen, nothing chosen: also what any unreadable file resolves to.
/// The worst a corrupt flags file can cost is one extra run of the
/// onboarding and one extra question about editors, which is the right price.
pub fn normalize_flags(raw: &Value) -> Flags {
    let Some(source) = raw.as_object() else { return Flags::default() };
    Flags {
        seen_onboarding: source.get("seenOnboarding") == Some(&Value::Bool(true)),
        editor: source
            .get("editor")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        theme: match source.get("theme").and_then(Value::as_str) {
            Some("light") => ThemeMode::Light,
            Some("dark") => ThemeMode::Dark,
            _ => ThemeMode::Auto,
        },
    }
}

pub fn parse_flags(text: &str) -> Flags {
    serde_json::from_str::<Value>(text).map(|v| normalize_flags(&v)).unwrap_or_default()
}
