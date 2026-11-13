//! The two surfaces, as colour tokens.
//!
//! Both themes are warm-neutral and amber-forward: the light one is not an
//! inversion but its own surface — paper under lamplight — so the workspace
//! keeps one temperature either way. Design language: square. Nothing in
//! this interface is rounded, so a stray rounded corner reads as a mistake.

use gpui::{Hsla, Rgba};
use mesa_core::terminal_osc::{TerminalTheme, DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME};

pub fn hex(rgb: u32) -> Hsla {
    rgba(rgb, 1.0)
}

pub fn rgba(rgb: u32, a: f32) -> Hsla {
    Rgba {
        r: ((rgb >> 16) & 0xff) as f32 / 255.0,
        g: ((rgb >> 8) & 0xff) as f32 / 255.0,
        b: (rgb & 0xff) as f32 / 255.0,
        a,
    }
    .into()
}

/// `a` over `b`, as CSS color-mix would put it.
pub fn mix(a: Hsla, b: Hsla, amount: f32) -> Hsla {
    let a = Rgba::from(a);
    let b = Rgba::from(b);
    Rgba {
        r: a.r * amount + b.r * (1.0 - amount),
        g: a.g * amount + b.g * (1.0 - amount),
        b: a.b * amount + b.b * (1.0 - amount),
        a: a.a * amount + b.a * (1.0 - amount),
    }
    .into()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Appearance {
    Dark,
    Light,
}

#[derive(Clone, Debug)]
pub struct Theme {
    pub accent: Hsla,
    pub danger: Hsla,
    pub danger_text: Hsla,
    pub bg_app: Hsla,
    pub bg_toolbar: Hsla,
    pub bg_canvas: Hsla,
    pub dot: Hsla,
    pub pane_frame: Hsla,
    pub pane_screen: Hsla,
    pub pane_border: Hsla,
    pub titlebar_top: Hsla,
    pub titlebar_bottom: Hsla,
    pub titlebar_edge: Hsla,
    pub text_strong: Hsla,
    pub text: Hsla,
    pub text_mid: Hsla,
    pub text_dim: Hsla,
    pub text_faint: Hsla,
    pub text_ghost: Hsla,
    pub hover: Hsla,
    pub hover_soft: Hsla,
    pub border: Hsla,
    pub border_soft: Hsla,
    pub kbd_bg: Hsla,
    pub kbd_border: Hsla,
    pub shadow: Hsla,
    pub selection: Hsla,
    /// The row a command was typed on gets a lit background.
    pub command_row_bg: Hsla,
    pub command_rule: Hsla,
    pub terminal: TerminalTheme,
}

impl Theme {
    pub fn dark() -> Self {
        Theme {
            accent: hex(0xd9a05c),
            danger: hex(0xd2705c),
            danger_text: hex(0xe9a08e),
            bg_app: hex(0x0a0908),
            bg_toolbar: hex(0x0c0b0a),
            bg_canvas: hex(0x070605),
            dot: rgba(0xe8ded0, 0.07),
            pane_frame: hex(0x151311),
            pane_screen: hex(0x0b0a09),
            pane_border: rgba(0xffffff, 0.09),
            titlebar_top: hex(0x171512),
            titlebar_bottom: hex(0x131110),
            titlebar_edge: rgba(0x000000, 0.55),
            text_strong: hex(0xece7e0),
            text: hex(0xddd8d1),
            text_mid: hex(0xb6b0a8),
            text_dim: hex(0x8a847b),
            text_faint: hex(0x6b665f),
            text_ghost: hex(0x57524b),
            hover: rgba(0xffffff, 0.08),
            hover_soft: rgba(0xffffff, 0.055),
            border: rgba(0xffffff, 0.1),
            border_soft: rgba(0xffffff, 0.07),
            kbd_bg: rgba(0xffffff, 0.07),
            kbd_border: rgba(0xffffff, 0.14),
            shadow: rgba(0x000000, 0.55),
            selection: hex(0xc9a35f),
            command_row_bg: hex(0x1b1712),
            command_rule: rgba(0xffffff, 0.10),
            terminal: DARK_TERMINAL_THEME,
        }
    }

    pub fn light() -> Self {
        Theme {
            accent: hex(0x9a6a1f),
            danger: hex(0xa2402c),
            danger_text: hex(0x8f3722),
            bg_app: hex(0xe9e7e4),
            bg_toolbar: hex(0xf7f6f4),
            bg_canvas: hex(0xe4e2de),
            dot: rgba(0x26221e, 0.14),
            pane_frame: hex(0xfbfaf9),
            pane_screen: hex(0xffffff),
            pane_border: rgba(0x1e1b18, 0.15),
            titlebar_top: hex(0xfdfcfb),
            titlebar_bottom: hex(0xf4f2f0),
            titlebar_edge: rgba(0x1e1b18, 0.12),
            text_strong: hex(0x1a1815),
            text: hex(0x2e2a26),
            text_mid: hex(0x45403a),
            text_dim: hex(0x67615a),
            text_faint: hex(0x877f76),
            text_ghost: hex(0xa09890),
            hover: rgba(0x1e1b18, 0.07),
            hover_soft: rgba(0x1e1b18, 0.04),
            border: rgba(0x1e1b18, 0.15),
            border_soft: rgba(0x1e1b18, 0.10),
            kbd_bg: rgba(0x1e1b18, 0.05),
            kbd_border: rgba(0x1e1b18, 0.2),
            shadow: rgba(0x1e1b18, 0.13),
            selection: hex(0x9a6a1f),
            command_row_bg: hex(0xf3f0ea),
            command_rule: rgba(0x000000, 0.14),
            terminal: LIGHT_TERMINAL_THEME,
        }
    }

    pub fn for_appearance(a: Appearance) -> Self {
        match a {
            Appearance::Dark => Self::dark(),
            Appearance::Light => Self::light(),
        }
    }

}

impl gpui::Global for Theme {}

/// The interface face and the terminal face. SF Mono is the native macOS
/// terminal face — a genuine system choice, not a webfont signalling
/// "developer". On other systems the stock monospace stands in.
pub fn ui_font() -> &'static str {
    if cfg!(target_os = "macos") {
        ".SystemUIFont"
    } else {
        "DejaVu Sans"
    }
}

pub fn mono_font() -> &'static str {
    if cfg!(target_os = "macos") {
        "Menlo"
    } else {
        "DejaVu Sans Mono"
    }
}
