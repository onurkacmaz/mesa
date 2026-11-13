//! The terminal palettes, and the colour formats shells and TUIs use to ask
//! about them (OSC 4/10/11).
//!
//! Warm black and amber, the same temperature as the chrome. A tool that
//! builds its own UI from the terminal's colour answers (OpenCode does) will
//! therefore come out warm here rather than in a cool blue-black.

/// 0xRRGGBB.
pub type Rgb = u32;

#[derive(Clone, Debug, PartialEq)]
pub struct TerminalTheme {
    pub background: Rgb,
    pub foreground: Rgb,
    /// RGB plus an alpha in 0..=1.
    pub selection: (Rgb, f32),
    /// black, red, green, yellow, blue, magenta, cyan, white, then the bright
    /// eight in the same order — the OSC 4 index order.
    pub ansi: [Rgb; 16],
}

pub const OSC_PALETTE_KEYS: [&str; 16] = [
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed",
    "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

pub const DARK_TERMINAL_THEME: TerminalTheme = TerminalTheme {
    background: 0x0b0a09,
    foreground: 0xe8e3da,
    selection: (0xd9a05c, 0.22),
    ansi: [
        0x211f1d, 0xd2705c, 0x93ad6a, 0xd9a05c, 0x7f9cba, 0xb98aa8, 0x79ada4, 0xd3cdc4, 0x6d675f, 0xe28c78,
        0xadc487, 0xeabd7c, 0x9db8d1, 0xd0a6c0, 0x96c6bd, 0xf5f1ea,
    ],
};

/// Not a simple inversion but its own surface — paper under lamplight rather
/// than a blank white sheet.
pub const LIGHT_TERMINAL_THEME: TerminalTheme = TerminalTheme {
    background: 0xffffff,
    foreground: 0x2b2723,
    selection: (0x9a6a1f, 0.20),
    ansi: [
        0x2b2723, 0xa2402c, 0x4d6a2e, 0x8a6520, 0x35597f, 0x7b4a6b, 0x2f6b62, 0x6b645c, 0x8b837a, 0xbd5138,
        0x5f7f39, 0xa17a29, 0x436b96, 0x8f5a7c, 0x3a8076, 0x4a443d,
    ],
};

pub fn hex(rgb: Rgb) -> String {
    format!("#{rgb:06x}")
}

/// 8-bit `#rrggbb` → the 16-bit `rgb:rrrr/gggg/bbbb` OSC replies use.
pub fn rgb_to_osc(rgb: Rgb) -> String {
    let c = |shift: u32| {
        let v = (rgb >> shift) & 0xff;
        format!("{:04x}", (v << 8) | v)
    };
    format!("rgb:{}/{}/{}", c(16), c(8), c(0))
}

pub fn hex_to_osc_rgb(hex: &str) -> Option<String> {
    let h = hex.trim_start_matches('#');
    u32::from_str_radix(h.get(..6)?, 16).ok().map(rgb_to_osc)
}

/// What a program set a colour to. `None` for a query or anything unreadable.
pub fn parse_osc_color(data: &str) -> Option<Rgb> {
    if data.is_empty() || data == "?" {
        return None;
    }
    if let Some(rest) = data.strip_prefix("rgb:") {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() < 3 {
            return None;
        }
        let to8 = |p: &str| -> Option<u32> {
            let v = u32::from_str_radix(p, 16).ok()?;
            // Scaled by the field's own width, so `rgb:ff/00/00` and
            // `rgb:ffff/0000/0000` are the same red.
            Some(match p.len() {
                1 => v * 17,
                2 => v,
                3 => v >> 4,
                _ => (v >> 8) & 0xff,
            })
        };
        return Some((to8(parts[0])? << 16) | (to8(parts[1])? << 8) | to8(parts[2])?);
    }
    let h = data.strip_prefix('#')?;
    if h.len() < 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(&h[..6], 16).ok()
}

pub fn osc_palette_color(theme: &TerminalTheme, index: &str) -> Option<Rgb> {
    let i: usize = index.parse().ok()?;
    theme.ansi.get(i).copied()
}
