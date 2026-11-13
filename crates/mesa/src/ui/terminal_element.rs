//! The grid, painted.
//!
//! One element draws a whole session: the screen surface, the lit rows and
//! rules of command blocks, cell backgrounds, the selection, the glyphs and
//! the cursor — read from alacritty's grid under its lock, once per frame.
//!
//! The pane it sits in may be shown at any canvas zoom, so every length here
//! is the zoom-1 length times the zoom. The terminal's own rows and columns
//! are worked out from the UNZOOMED box, so zooming the canvas never reflows
//! what is running in it — exactly as `transform: scale()` behaved.

use std::sync::Arc;

use alacritty_terminal::{
    grid::Dimensions,
    index::Side,
    selection::{Selection, SelectionType},
    term::{
        cell::{Cell, Flags},
        TermMode,
    },
    vte::ansi::{Color as AnsiColor, CursorShape, NamedColor},
};
use gpui::{
    fill, linear_color_stop, linear_gradient, outline, point, px, size, App, Bounds, DispatchPhase, Element,
    ElementId, Entity, Font, FontStyle, FontWeight, GlobalElementId, Hitbox, HitboxBehavior, Hsla,
    InspectorElementId, IntoElement, LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels,
    ScrollWheelEvent, SharedString, StrikethroughStyle, Style, TextRun, UnderlineStyle, Window,
};

use super::terminal_view::TerminalView;
use crate::{
    terminal::session::{grid_point, palette_color, visible_row, BlockKind, Session},
    theme::{rgba, Theme},
};

/// The terminal face: 14px, a touch heavier than book weight — light-on-dark
/// type optically thins out, so 400 reads as spindly on this surface.
pub const FONT_SIZE: f32 = 14.0;
pub const LINE_HEIGHT: f32 = 1.45;
/// Full-screen TUIs need tight cell metrics and no inner gutter, or block
/// glyphs and full-bleed layouts misalign.
pub const TUI_LINE_HEIGHT: f32 = 1.0;
pub const PAD_X: f32 = 12.0;
pub const PAD_Y: f32 = 8.0;

/// The cell at zoom 1, measured once from the font.
#[derive(Clone, Copy, Debug)]
pub struct CellMetrics {
    pub width: f32,
}

impl gpui::Global for CellMetrics {}

pub fn mono_font(bold: bool, italic: bool) -> Font {
    Font {
        family: crate::theme::mono_font().into(),
        features: Default::default(),
        fallbacks: None,
        weight: if bold { FontWeight(650.0) } else { FontWeight(450.0) },
        style: if italic { FontStyle::Italic } else { FontStyle::Normal },
    }
}

pub fn measure_cell(cx: &App) -> CellMetrics {
    let ts = cx.text_system();
    let id = ts.resolve_font(&mono_font(false, false));
    let width = ts.advance(id, px(FONT_SIZE), 'm').map(|s| f32::from(s.width)).unwrap_or(FONT_SIZE * 0.6);
    CellMetrics { width: width.max(1.0) }
}

pub fn line_height(tui: bool) -> f32 {
    FONT_SIZE * if tui { TUI_LINE_HEIGHT } else { LINE_HEIGHT }
}

/// How many rows and columns a pane's screen holds, at zoom 1.
pub fn grid_size_for(width: f32, height: f32, cell: CellMetrics, tui: bool) -> (usize, usize) {
    let (px_, py) = if tui { (0.0, 0.0) } else { (PAD_X, PAD_Y) };
    let cols = ((width - 2.0 * px_) / cell.width).floor().max(2.0) as usize;
    let rows = ((height - 2.0 * py) / line_height(tui)).floor().max(1.0) as usize;
    (cols, rows)
}

pub struct TerminalElement {
    pub view: Entity<TerminalView>,
    pub session: Arc<Session>,
    pub theme: Theme,
    pub zoom: f32,
    pub focused: bool,
    pub tui: bool,
    pub cell: CellMetrics,
    /// A hidden tab keeps its size but draws nothing and takes no input.
    pub visible: bool,
}

impl IntoElement for TerminalElement {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

pub struct Layout {
    hitbox: Hitbox,
    cell_w: f32,
    cell_h: f32,
    origin: gpui::Point<Pixels>,
}

fn to_hsla(c: u32) -> Hsla {
    crate::theme::hex(c)
}

struct Colors<'a> {
    theme: &'a Theme,
    overrides: &'a alacritty_terminal::term::color::Colors,
    accent: u32,
}

impl Colors<'_> {
    fn index(&self, i: usize) -> Hsla {
        if let Some(rgb) = self.overrides[i] {
            return gpui::Rgba { r: rgb.r as f32 / 255., g: rgb.g as f32 / 255., b: rgb.b as f32 / 255., a: 1. }.into();
        }
        to_hsla(palette_color(&self.theme.terminal, self.accent, i))
    }

    fn resolve(&self, c: AnsiColor, bold: bool) -> Hsla {
        match c {
            AnsiColor::Spec(rgb) => {
                gpui::Rgba { r: rgb.r as f32 / 255., g: rgb.g as f32 / 255., b: rgb.b as f32 / 255., a: 1. }.into()
            }
            AnsiColor::Indexed(i) => {
                // Bold draws in the bright eight, as xterm.js does by default.
                let i = i as usize;
                self.index(if bold && i < 8 { i + 8 } else { i })
            }
            AnsiColor::Named(n) => {
                let i = n as usize;
                let i = if bold && i < 8 { i + 8 } else { i };
                match n {
                    NamedColor::DimForeground | NamedColor::BrightForeground => self.index(NamedColor::Foreground as usize),
                    _ if i <= 15 || i == NamedColor::Foreground as usize || i == NamedColor::Background as usize => {
                        self.index(i)
                    }
                    _ => self.index(NamedColor::Foreground as usize),
                }
            }
        }
    }
}

/// Glyphs that tile with their neighbours. The font draws them only as well
/// as its metrics allow, and at a fractional zoom hairline seams open between
/// them — so the simple ones are drawn as cell-exact rectangles instead.
fn block_glyph(c: char) -> Option<(f32, f32, f32, f32)> {
    // (x, y, w, h) as fractions of the cell.
    Some(match c {
        '█' => (0., 0., 1., 1.),
        '▀' => (0., 0., 1., 0.5),
        '▄' => (0., 0.5, 1., 0.5),
        '▌' => (0., 0., 0.5, 1.),
        '▐' => (0.5, 0., 0.5, 1.),
        '▁' => (0., 0.875, 1., 0.125),
        '▂' => (0., 0.75, 1., 0.25),
        '▃' => (0., 0.625, 1., 0.375),
        '▅' => (0., 0.375, 1., 0.625),
        '▆' => (0., 0.25, 1., 0.75),
        '▇' => (0., 0.125, 1., 0.875),
        '▔' => (0., 0., 1., 0.125),
        '▏' => (0., 0., 0.125, 1.),
        '▕' => (0.875, 0., 0.125, 1.),
        _ => return None,
    })
}

/// Box-drawing lines: which arms leave the centre (left, right, up, down)
/// and whether they are heavy.
fn box_glyph(c: char) -> Option<([bool; 4], bool)> {
    let light = |l, r, u, d| Some(([l, r, u, d], false));
    let heavy = |l, r, u, d| Some(([l, r, u, d], true));
    match c {
        '─' => light(true, true, false, false),
        '│' => light(false, false, true, true),
        '┌' | '╭' => light(false, true, false, true),
        '┐' | '╮' => light(true, false, false, true),
        '└' | '╰' => light(false, true, true, false),
        '┘' | '╯' => light(true, false, true, false),
        '├' => light(false, true, true, true),
        '┤' => light(true, false, true, true),
        '┬' => light(true, true, false, true),
        '┴' => light(true, true, true, false),
        '┼' => light(true, true, true, true),
        '━' => heavy(true, true, false, false),
        '┃' => heavy(false, false, true, true),
        '┏' => heavy(false, true, false, true),
        '┓' => heavy(true, false, false, true),
        '┗' => heavy(false, true, true, false),
        '┛' => heavy(true, false, true, false),
        '┣' => heavy(false, true, true, true),
        '┫' => heavy(true, false, true, true),
        '┳' => heavy(true, true, false, true),
        '┻' => heavy(true, true, true, false),
        '╋' => heavy(true, true, true, true),
        _ => None,
    }
}

struct Batch {
    col: usize,
    text: String,
    runs: Vec<TextRun>,
    wide: bool,
}

impl Element for TerminalElement {
    type RequestLayoutState = ();
    type PrepaintState = Layout;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = gpui::relative(1.).into();
        style.size.height = gpui::relative(1.).into();
        style.flex_grow = 1.0;
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        _cx: &mut App,
    ) -> Layout {
        let zoom = self.zoom.max(0.0001);
        let tui = self.tui;
        let cell_w = self.cell.width * zoom;
        let cell_h = line_height(tui) * zoom;
        let (px_, py) = if tui { (0.0, 0.0) } else { (PAD_X, PAD_Y) };
        // The grid follows the box at zoom 1, never the zoom itself.
        let w = f32::from(bounds.size.width) / zoom;
        let h = f32::from(bounds.size.height) / zoom;
        let (cols, rows) = grid_size_for(w, h, self.cell, tui);
        self.session.resize(cols, rows, self.cell.width, line_height(tui));
        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
        Layout {
            hitbox,
            cell_w,
            cell_h,
            origin: point(bounds.origin.x + px(px_ * zoom), bounds.origin.y + px(py * zoom)),
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        layout: &mut Layout,
        window: &mut Window,
        cx: &mut App,
    ) {
        if !self.visible {
            return;
        }
        let theme = &self.theme;
        let accent_rgb = {
            let c = gpui::Rgba::from(theme.accent);
            (((c.r * 255.) as u32) << 16) | (((c.g * 255.) as u32) << 8) | ((c.b * 255.) as u32)
        };
        let (cell_w, cell_h, origin) = (layout.cell_w, layout.cell_h, layout.origin);
        let zoom = self.zoom;
        let font_px = FONT_SIZE * zoom;

        self.register_mouse(layout, window);

        let shared = self.session.shared.lock();
        let term = &shared.term;
        let colors = Colors { theme, overrides: term.colors(), accent: accent_rgb };
        let default_bg = colors.index(NamedColor::Background as usize);
        let default_fg = colors.index(NamedColor::Foreground as usize);

        window.paint_quad(fill(bounds, default_bg));

        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            let cell_rect = |row: usize, col: usize, cols: f32| {
                Bounds::new(
                    point(origin.x + px(col as f32 * cell_w), origin.y + px(row as f32 * cell_h)),
                    size(px(cols * cell_w), px(cell_h)),
                )
            };
            let columns = term.columns();
            let full_row = |row: usize| {
                Bounds::new(
                    point(bounds.origin.x, origin.y + px(row as f32 * cell_h)),
                    size(bounds.size.width, px(cell_h)),
                )
            };

            // The command rows, beneath everything that sits on them. Only
            // on the normal screen: the blocks belong to the shell, and a TUI
            // on the alternate screen must not get bands across its output.
            if !shared.alt {
                for block in &shared.blocks {
                    if block.kind == BlockKind::Row {
                        if let Some(row) = visible_row(&shared, block.line) {
                            window.paint_quad(fill(full_row(row), theme.command_row_bg));
                        }
                    }
                }
            }

            let content = term.renderable_content();
            let display_offset = content.display_offset as i32;
            let selection = content.selection;
            let cursor = content.cursor;
            let show_cursor = content.mode.contains(TermMode::SHOW_CURSOR) && display_offset == 0;

            // Below a few pixels a glyph is not readable, and shaping
            // thousands of them every frame is not free. The cells are drawn
            // as a texture of their own colour instead.
            let tiny = font_px < 4.0;

            let mut batches_by_row: Vec<Vec<Batch>> = (0..term.screen_lines()).map(|_| Vec::new()).collect();
            let mut current: Option<(usize, Batch, (Hsla, Flags))> = None;

            let flush = |current: &mut Option<(usize, Batch, (Hsla, Flags))>, batches: &mut Vec<Vec<Batch>>| {
                if let Some((row, batch, _)) = current.take() {
                    if !batch.text.trim().is_empty() {
                        batches[row].push(batch);
                    }
                }
            };

            for indexed in content.display_iter {
                let row_i = indexed.point.line.0 + display_offset;
                if row_i < 0 {
                    continue;
                }
                let row = row_i as usize;
                let col = indexed.point.column.0;
                let cell: &Cell = &indexed.cell;
                if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
                    continue;
                }
                let bold = cell.flags.contains(Flags::BOLD);
                let mut fg = colors.resolve(cell.fg, bold);
                let mut bg = match cell.bg {
                    AnsiColor::Named(NamedColor::Background) => None,
                    other => Some(colors.resolve(other, false)),
                };
                if cell.flags.contains(Flags::INVERSE) {
                    let b = bg.unwrap_or(default_bg);
                    bg = Some(fg);
                    fg = b;
                }
                if cell.flags.contains(Flags::DIM) {
                    fg.a *= 0.6;
                }
                let wide = cell.flags.contains(Flags::WIDE_CHAR);
                let width = if wide { 2.0 } else { 1.0 };
                if let Some(bg) = bg {
                    window.paint_quad(fill(cell_rect(row, col, width), bg));
                }
                let selected = selection.map(|s| s.contains(indexed.point)).unwrap_or(false);
                if selected {
                    let (rgb, a) = theme.terminal.selection;
                    window.paint_quad(fill(cell_rect(row, col, width), rgba(rgb, a + 0.08)));
                }
                if cell.flags.contains(Flags::HIDDEN) || cell.c == ' ' || cell.c == '\t' {
                    flush(&mut current, &mut batches_by_row);
                    continue;
                }
                if tiny {
                    let mut c = fg;
                    c.a *= 0.45;
                    let r = cell_rect(row, col, width);
                    window.paint_quad(fill(
                        Bounds::new(point(r.origin.x, r.origin.y + px(cell_h * 0.25)), size(r.size.width, px(cell_h * 0.5))),
                        c,
                    ));
                    continue;
                }
                if let Some((x, y, w, h)) = block_glyph(cell.c) {
                    flush(&mut current, &mut batches_by_row);
                    let r = cell_rect(row, col, 1.0);
                    window.paint_quad(fill(
                        Bounds::new(
                            point(r.origin.x + px(x * cell_w), r.origin.y + px(y * cell_h)),
                            size(px(w * cell_w + 0.5), px(h * cell_h + 0.5)),
                        ),
                        fg,
                    ));
                    continue;
                }
                if let Some((arms, heavy)) = box_glyph(cell.c) {
                    flush(&mut current, &mut batches_by_row);
                    let r = cell_rect(row, col, 1.0);
                    let t = (if heavy { 2.0 } else { 1.0 } * zoom).max(1.0);
                    let cx_ = r.origin.x + px((cell_w - t) / 2.0);
                    let cy = r.origin.y + px((cell_h - t) / 2.0);
                    let [l, rt, u, d] = arms;
                    if l {
                        window.paint_quad(fill(Bounds::new(point(r.origin.x, cy), size(px(cell_w / 2.0 + t / 2.0), px(t))), fg));
                    }
                    if rt {
                        window.paint_quad(fill(Bounds::new(point(cx_, cy), size(px(cell_w / 2.0 + t / 2.0 + 0.5), px(t))), fg));
                    }
                    if u {
                        window.paint_quad(fill(Bounds::new(point(cx_, r.origin.y), size(px(t), px(cell_h / 2.0 + t / 2.0))), fg));
                    }
                    if d {
                        window.paint_quad(fill(Bounds::new(point(cx_, cy), size(px(t), px(cell_h / 2.0 + t / 2.0 + 0.5))), fg));
                    }
                    continue;
                }

                let italic = cell.flags.contains(Flags::ITALIC);
                let underline = cell.flags.intersects(Flags::ALL_UNDERLINES).then(|| UnderlineStyle {
                    color: Some(fg),
                    thickness: px((1.0 * zoom).max(0.5)),
                    wavy: cell.flags.contains(Flags::UNDERCURL),
                });
                let strike = cell
                    .flags
                    .contains(Flags::STRIKEOUT)
                    .then(|| StrikethroughStyle { color: Some(fg), thickness: px((1.0 * zoom).max(0.5)) });
                let mut text = String::new();
                text.push(cell.c);
                for z in cell.zerowidth().into_iter().flatten() {
                    text.push(*z);
                }
                let run = TextRun {
                    len: text.len(),
                    font: mono_font(bold, italic),
                    color: fg,
                    background_color: None,
                    underline,
                    strikethrough: strike,
                };
                let key = (fg, cell.flags & (Flags::BOLD | Flags::ITALIC | Flags::ALL_UNDERLINES | Flags::STRIKEOUT));
                let contiguous = matches!(&current, Some((r, b, _)) if *r == row && !b.wide && !wide && b.col + b.text_cells() == col);
                if wide || !contiguous {
                    flush(&mut current, &mut batches_by_row);
                    current = Some((row, Batch { col, text: text.clone(), runs: vec![run], wide }, key));
                    if wide {
                        flush(&mut current, &mut batches_by_row);
                    }
                } else if let Some((_, batch, k)) = current.as_mut() {
                    if *k == key {
                        batch.runs.last_mut().unwrap().len += text.len();
                    } else {
                        batch.runs.push(run);
                        *k = key;
                    }
                    batch.text.push_str(&text);
                }
            }
            flush(&mut current, &mut batches_by_row);

            if !tiny {
                for (row, batches) in batches_by_row.into_iter().enumerate() {
                    for batch in batches {
                        let force = if batch.wide { None } else { Some(px(cell_w)) };
                        let line = window.text_system().shape_line(SharedString::from(batch.text), px(font_px), &batch.runs, force);
                        let at = point(origin.x + px(batch.col as f32 * cell_w), origin.y + px(row as f32 * cell_h));
                        let _ = line.paint(at, px(cell_h), window, cx);
                    }
                }
            }

            // The rules under finished commands: a short solid tick in the
            // accent (or the failure red), then a hairline that fades out
            // well before the right edge — an index mark, not a border.
            if !shared.alt {
                let width = columns as f32 * cell_w;
                for block in &shared.blocks {
                    let BlockKind::Rule { ok } = block.kind else { continue };
                    let Some(row) = visible_row(&shared, block.line) else { continue };
                    let y = origin.y + px(row as f32 * cell_h);
                    let tick = if ok { theme.accent } else { theme.danger };
                    let rule = if ok { theme.command_rule } else { crate::theme::mix(theme.danger, gpui::transparent_black(), 0.4) };
                    let t = px(1.0_f32.max(zoom * 0.8));
                    let tick_w = 14.0 * zoom;
                    window.paint_quad(fill(Bounds::new(point(bounds.origin.x, y), size(px(tick_w), t)), tick));
                    let solid_end = width * 0.62;
                    window.paint_quad(fill(
                        Bounds::new(point(bounds.origin.x + px(tick_w), y), size(px((solid_end - tick_w).max(0.)), t)),
                        rule,
                    ));
                    let mut clear = rule;
                    clear.a = 0.0;
                    window.paint_quad(fill(
                        Bounds::new(point(bounds.origin.x + px(solid_end), y), size(px(width * 0.30), t)),
                        linear_gradient(90., linear_color_stop(rule, 0.), linear_color_stop(clear, 1.)),
                    ));
                }
            }

            // The cursor, in the accent. Hollow when the pane does not have
            // the keyboard, so you can tell at a glance which one does.
            if show_cursor && !tiny {
                let row = cursor.point.line.0 + display_offset;
                if row >= 0 {
                    let rect = cell_rect(row as usize, cursor.point.column.0, 1.0);
                    let accent = theme.accent;
                    match (cursor.shape, self.focused) {
                        (CursorShape::Hidden, _) => {}
                        (_, false) => window.paint_quad(outline(rect, accent, gpui::BorderStyle::Solid)),
                        (CursorShape::Beam, true) => {
                            window.paint_quad(fill(Bounds::new(rect.origin, size(px((2.0 * zoom).max(1.)), rect.size.height)), accent))
                        }
                        (CursorShape::Underline, true) => window.paint_quad(fill(
                            Bounds::new(
                                point(rect.origin.x, rect.origin.y + rect.size.height - px((2.0 * zoom).max(1.))),
                                size(rect.size.width, px((2.0 * zoom).max(1.))),
                            ),
                            accent,
                        )),
                        (CursorShape::HollowBlock, true) => window.paint_quad(outline(rect, accent, gpui::BorderStyle::Solid)),
                        (CursorShape::Block, true) => {
                            window.paint_quad(fill(rect, accent));
                            // The glyph under a block cursor, in the screen's
                            // own colour so it reads through the block.
                            let grid = term.grid();
                            let point_ = cursor.point;
                            if point_.line.0 >= -(grid.history_size() as i32) && (point_.line.0 as usize) < grid.screen_lines() {
                                let c = grid[point_.line][point_.column].c;
                                if c != ' ' && c != '\0' {
                                    let text: SharedString = c.to_string().into();
                                    let run = TextRun {
                                        len: text.len(),
                                        font: mono_font(false, false),
                                        color: default_bg,
                                        background_color: None,
                                        underline: None,
                                        strikethrough: None,
                                    };
                                    let line = window.text_system().shape_line(text, px(font_px), &[run], Some(px(cell_w)));
                                    let _ = line.paint(rect.origin, px(cell_h), window, cx);
                                }
                            }
                        }
                    }
                }
            }
            let _ = default_fg;
        });
    }
}

impl Batch {
    fn text_cells(&self) -> usize {
        // Zero-width characters ride along with their base character, so the
        // number of cells is the number of base characters.
        self.text.chars().filter(|c| unicode_width::UnicodeWidthChar::width(*c).unwrap_or(0) > 0).count().max(1)
    }
}

/// Mouse report encoding for a TUI that asked for one (SGR when it can).
fn mouse_report(mode: TermMode, button: u8, col: usize, row: usize, pressed: bool, motion: bool) -> Option<Vec<u8>> {
    let b = button + if motion { 32 } else { 0 };
    if mode.contains(TermMode::SGR_MOUSE) {
        Some(format!("\x1b[<{};{};{}{}", b, col + 1, row + 1, if pressed { 'M' } else { 'm' }).into_bytes())
    } else {
        let code = if pressed { b } else { 3 };
        let enc = |v: usize| (v.min(222) + 32 + 1) as u8;
        Some(vec![0x1b, b'[', b'M', code + 32, enc(col), enc(row)])
    }
}

impl TerminalElement {
    fn register_mouse(&self, layout: &Layout, window: &mut Window) {
        let hitbox = layout.hitbox.clone();
        let (cell_w, cell_h, origin) = (layout.cell_w, layout.cell_h, layout.origin);
        let cell_at = move |p: gpui::Point<Pixels>| -> (usize, usize, Side) {
            let x = (f32::from(p.x - origin.x) / cell_w).max(0.0);
            let y = (f32::from(p.y - origin.y) / cell_h).max(0.0);
            let side = if x.fract() < 0.5 { Side::Left } else { Side::Right };
            (y as usize, x as usize, side)
        };

        // Press: a report for a TUI that wants the mouse (shift bypasses it,
        // as in every terminal), a selection otherwise.
        {
            let view = self.view.clone();
            let session = self.session.clone();
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |e: &MouseDownEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble || !hitbox.is_hovered(window) || e.button != MouseButton::Left {
                    return;
                }
                let (row, col, side) = cell_at(e.position);
                let mut shared = session.shared.lock();
                let mode = *shared.term.mode();
                if mode.intersects(TermMode::MOUSE_MODE) && !e.modifiers.shift {
                    if let Some(bytes) = mouse_report(mode, 0, col, row, true, false) {
                        drop(shared);
                        session.write(&bytes);
                    }
                } else {
                    let point = grid_point(&shared, row, col);
                    let ty = match e.click_count {
                        2 => SelectionType::Semantic,
                        3.. => SelectionType::Lines,
                        _ => SelectionType::Simple,
                    };
                    let mut sel = Selection::new(ty, point, side);
                    if ty != SelectionType::Simple {
                        sel.update(point, side);
                    }
                    shared.term.selection = Some(sel);
                    drop(shared);
                    view.update(cx, |v, cx| {
                        v.selecting = true;
                        cx.notify();
                    });
                }
            });
        }
        {
            let view = self.view.clone();
            let session = self.session.clone();
            window.on_mouse_event(move |e: &MouseMoveEvent, phase, _window, cx| {
                if phase != DispatchPhase::Bubble || !view.read(cx).selecting || e.pressed_button != Some(MouseButton::Left) {
                    return;
                }
                let (row, col, side) = cell_at(e.position);
                let mut shared = session.shared.lock();
                let lines = shared.term.screen_lines();
                // Dragging past the top or bottom edge scrolls the history.
                let row = if f32::from(e.position.y - origin.y) < 0.0 {
                    shared.term.scroll_display(alacritty_terminal::grid::Scroll::Delta(1));
                    0
                } else if row >= lines {
                    shared.term.scroll_display(alacritty_terminal::grid::Scroll::Delta(-1));
                    lines.saturating_sub(1)
                } else {
                    row
                };
                let point = grid_point(&shared, row, col);
                if let Some(sel) = shared.term.selection.as_mut() {
                    sel.update(point, side);
                }
                drop(shared);
                view.update(cx, |_, cx| cx.notify());
            });
        }
        {
            let view = self.view.clone();
            let session = self.session.clone();
            let hitbox = hitbox.clone();
            window.on_mouse_event(move |e: &MouseUpEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble || e.button != MouseButton::Left {
                    return;
                }
                let was_selecting = view.read(cx).selecting;
                if was_selecting {
                    view.update(cx, |v, _| v.selecting = false);
                    // A click with no drag is no selection.
                    let mut shared = session.shared.lock();
                    if shared.term.selection.as_ref().map(|s| s.is_empty()).unwrap_or(false) {
                        shared.term.selection = None;
                    }
                    return;
                }
                if hitbox.is_hovered(window) {
                    let shared = session.shared.lock();
                    let mode = *shared.term.mode();
                    if mode.intersects(TermMode::MOUSE_MODE) && !e.modifiers.shift {
                        let (row, col, _) = cell_at(e.position);
                        if let Some(bytes) = mouse_report(mode, 0, col, row, false, false) {
                            drop(shared);
                            session.write(&bytes);
                        }
                    }
                }
            });
        }

        // The wheel, in lines. Held with ⌘ or ⌃ it is the canvas's zoom and
        // is left to bubble up to it. Hitting the top or bottom of the
        // scrollback simply stops — it never chains into a canvas pan.
        {
            let view = self.view.clone();
            let session = self.session.clone();
            window.on_mouse_event(move |e: &ScrollWheelEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble || !hitbox.is_hovered(window) {
                    return;
                }
                if e.modifiers.platform || e.modifiers.control {
                    return;
                }
                cx.stop_propagation();
                let dy = f32::from(e.delta.pixel_delta(px(cell_h)).y);
                let lines = view.update(cx, |v, _| {
                    let wanted = v.scroll_remainder + dy / cell_h;
                    let lines = wanted.trunc();
                    v.scroll_remainder = wanted - lines;
                    lines as i32
                });
                if lines == 0 {
                    return;
                }
                let mut shared = session.shared.lock();
                let mode = *shared.term.mode();
                if shared.alt {
                    // Alt-screen programs (vim, less, htop) want the wheel as
                    // the mouse reports or arrow keys they expect.
                    let (row, col, _) = cell_at(e.position);
                    drop(shared);
                    if mode.intersects(TermMode::MOUSE_MODE) {
                        let button = if lines > 0 { 64 } else { 65 };
                        for _ in 0..lines.unsigned_abs() {
                            if let Some(b) = mouse_report(mode, button, col, row, true, false) {
                                session.write(&b);
                            }
                        }
                    } else if mode.contains(TermMode::ALTERNATE_SCROLL) {
                        let key = match (lines > 0, mode.contains(TermMode::APP_CURSOR)) {
                            (true, true) => "\x1bOA",
                            (true, false) => "\x1b[A",
                            (false, true) => "\x1bOB",
                            (false, false) => "\x1b[B",
                        };
                        session.write(key.repeat(lines.unsigned_abs() as usize).as_bytes());
                    }
                } else {
                    shared.term.scroll_display(alacritty_terminal::grid::Scroll::Delta(lines));
                    drop(shared);
                }
                view.update(cx, |_, cx| cx.notify());
            });
        }
    }
}
