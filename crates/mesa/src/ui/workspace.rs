//! One workflow: its own canvas, its own panes, its own view.
//!
//! Every open workflow stays alive — a workflow you switched away from is
//! usually the one with something running in it — and only the active one is
//! drawn.
//!
//! The canvas has no edges. Panning moves the view, zooming scales it about
//! the pointer, and every pane is placed at `pan + position × zoom` and drawn
//! with its rem size scaled by the zoom, so its whole contents scale with it.

use std::time::{Duration, Instant};

use gpui::{
    canvas, div, fill, point, prelude::*, px, size, AnyElement, App, Bounds, Context, DispatchPhase, Entity,
    EventEmitter, FocusHandle, Focusable, Hsla, KeyDownEvent, KeyUpEvent, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, Pixels, Point, ScrollWheelEvent, SharedString, Subscription, Window,
};

use mesa_core::{
    editors::{editors_from, resolve_editor, Editor},
    naming::{split_name, Name},
    session::{strip_controls, Pan, Pane as SavedPane, PaneKind, Tab as SavedTab, View, Workflow},
};

use super::{
    browser_view::{BrowserEvent, BrowserView},
    glyph_button, icon, kbd, r,
    terminal_view::{TerminalEvent, TerminalView},
    text_input::{InputEvent, TextInput},
    with_rem, Icon, Shortcut, BASE_REM,
};
use crate::{ids, platform, theme::Theme};

/// A terminal and a browser open at the same size, and the browser decides
/// it: below ~800px wide sites drop into their narrow layout.
const DEFAULT_SIZE: (f32, f32) = (1360.0, 780.0);
const CASCADE_STEP: f32 = 32.0;
const MIN_SIZE: (f32, f32) = (360.0, 220.0);
const ZOOM_MIN: f32 = 0.04;
const ZOOM_MAX: f32 = 5.0;
const DOT_SPACING: f32 = 28.0;
/// Zoom steps multiply rather than add, so a given wheel delta is always the
/// same RATIO. The cap keeps one mouse-wheel notch to a sane step while a
/// trackpad's many small deltas stay under it.
const ZOOM_WHEEL_RATE: f32 = 0.002;
const ZOOM_WHEEL_MAX_STEP: f32 = 0.12;
const ZOOM_BUTTON_RATIO: f32 = 1.1;
/// Travelling to a pane from the dock: animated rather than cut, because the
/// canvas has no landmarks and a short glide keeps the two places related.
const REVEAL_MS: f32 = 320.0;
const REVEAL_PAD: f32 = 72.0;
const REVEAL_MARK_MS: f32 = 820.0;
/// Below this a pane is on screen but not readable, so arriving at it is
/// framed instead.
const REVEAL_LEGIBLE_ZOOM: f32 = 0.5;
/// How much bigger than the window a pane may be and still be arrived at
/// without zooming out. A pane taller than the window is the ordinary state.
const REVEAL_MAX_OVERFLOW: f32 = 1.5;
const TITLEBAR_H: f32 = 34.0;
const TABS_H: f32 = 29.0;
const HANDLE: f32 = 6.0;
const MAP_W: f32 = 208.0;
const MAP_H: f32 = 136.0;
const MAP_PAD: f32 = 10.0;

fn clamp_zoom(z: f32) -> f32 {
    z.clamp(ZOOM_MIN, ZOOM_MAX)
}

fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

/// Overshoots by about five percent and settles back, so the view arrives
/// with a click rather than coasting to a halt. Position only: on the zoom it
/// could carry the scale past zero.
fn ease_out_back(t: f32) -> f32 {
    let c = 1.14;
    let u = t - 1.0;
    1.0 + (c + 1.0) * u.powi(3) + c * u.powi(2)
}

pub enum TabView {
    Terminal(Entity<TerminalView>),
    Browser(Entity<BrowserView>),
}

pub struct TabState {
    pub id: String,
    pub title: String,
    pub title_locked: bool,
    /// Something the user set ON the tab, unlike the folder and the address.
    pub command: Option<String>,
    pub view: TabView,
    _sub: Subscription,
}

pub struct Pane {
    pub id: String,
    pub kind: PaneKind,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub z: f64,
    pub tabs: Vec<TabState>,
    pub active_tab_id: String,
}

impl Pane {
    fn active_tab(&self) -> &TabState {
        self.tabs.iter().find(|t| t.id == self.active_tab_id).unwrap_or(&self.tabs[0])
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Edge {
    N,
    S,
    E,
    W,
    NE,
    NW,
    SE,
    SW,
}

enum Gesture {
    Pan { start: Point<Pixels>, start_pan: (f32, f32) },
    Marquee { start: (f32, f32), current: (f32, f32), additive: bool },
    Drag { start: Point<Pixels>, members: Vec<(String, f32, f32)> },
    Resize { pane: String, edge: Edge, start: Point<Pixels>, rect: (f32, f32, f32, f32) },
    TabDrag { pane: String, tab: String, start_x: Pixels, moved: bool },
    Minimap { proj: Projection },
}

#[derive(Clone, Copy)]
struct Projection {
    s: f32,
    ox: f32,
    oy: f32,
}

struct Reveal {
    rect: (f32, f32, f32, f32),
    started: Instant,
    from_zoom: f32,
    to_zoom: f32,
    from_pan: (f32, f32),
    to_pan: (f32, f32),
    glide: bool,
}

struct Editing {
    pane: String,
    tab: String,
    input: Entity<TextInput>,
    _sub: Subscription,
}

pub enum WorkspaceEvent {
    /// Something here is worth writing down.
    Dirty,
    /// ⌘W with nothing selected: the workflow itself is what is targeted.
    RequestCloseWorkflow,
    EditorChosen(String),
}

pub struct Workspace {
    pub id: String,
    panes: Vec<Pane>,
    zoom: f32,
    pan: (f32, f32),
    selected: Vec<String>,
    gesture: Option<Gesture>,
    space_held: bool,
    pending_close: Option<Vec<String>>,
    pending_close_tab: Option<(String, String)>,
    editor_choice: Option<(String, Vec<Editor>)>,
    pane_menu: Option<(String, Vec<Editor>, f32, f32)>,
    title_edit: Option<Editing>,
    command_edit: Option<Editing>,
    reveal: Option<Reveal>,
    /// The canvas box in window coordinates, as last laid out.
    canvas_bounds: Bounds<Pixels>,
    centered: bool,
    focus_handle: FocusHandle,
    z_counter: f64,
    pub editor_pref: Option<String>,
    pub active: bool,
    pub hide_empty_hint: bool,
    /// Something is drawn over the canvas (the onboarding, a workflow close
    /// question), so a native page must not be shown over it.
    pub covered: bool,
}

impl EventEmitter<WorkspaceEvent> for Workspace {}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

/// The folder a session is sitting in, which is the part of a path that
/// identifies a terminal. Home is `~`.
fn folder_name(cwd: &str) -> String {
    if platform::is_home(cwd) {
        return "~".into();
    }
    cwd.rsplit('/').find(|s| !s.is_empty()).unwrap_or("/").to_string()
}

/// Home-relative, and only the last two segments: the chrome answers "where
/// am I" at a glance, not print an absolute path.
fn short_path(cwd: &str) -> String {
    let s = platform::home_relative(cwd);
    let parts: Vec<&str> = s.split('/').filter(|p| !p.is_empty()).collect();
    if s == "~" || parts.len() <= 2 {
        return s;
    }
    format!("…/{}", parts[parts.len() - 2..].join("/"))
}

/// A path too long for the rail is cut from the FRONT, by whole segments,
/// because the end is the part that says which project this is.
fn shorten_dir(dir: &str) -> String {
    const BUDGET: usize = 46;
    let short = platform::home_relative(dir);
    if short.chars().count() <= BUDGET {
        return short;
    }
    let mut parts: Vec<&str> = short.split('/').collect();
    let mut kept = vec![parts.pop().unwrap_or("")];
    while let Some(next) = parts.pop() {
        let candidate = format!("{next}/{}", kept.join("/"));
        if candidate.chars().count() + 2 > BUDGET {
            break;
        }
        kept.insert(0, next);
    }
    format!("…/{}", kept.join("/"))
}

fn format_elapsed(seconds: u64) -> String {
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    }
}

fn trailing_number(id: &str) -> u64 {
    mesa_core::session::trailing_number(id)
}

impl Workspace {
    pub fn new(id: String, saved: Option<Workflow>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let view = saved.as_ref().map(|w| w.view).unwrap_or_default();
        let mut this = Workspace {
            id,
            panes: Vec::new(),
            zoom: clamp_zoom(view.zoom as f32),
            pan: (view.pan.x as f32, view.pan.y as f32),
            selected: Vec::new(),
            gesture: None,
            space_held: false,
            pending_close: None,
            pending_close_tab: None,
            editor_choice: None,
            pane_menu: None,
            title_edit: None,
            command_edit: None,
            reveal: None,
            canvas_bounds: Bounds::default(),
            // A restored workflow has somewhere it already belongs; only one
            // that has never been anywhere gets its origin centred.
            centered: saved.is_some(),
            focus_handle: cx.focus_handle(),
            z_counter: 1.0,
            editor_pref: None,
            active: false,
            hide_empty_hint: false,
            covered: false,
        };
        if let Some(saved) = saved {
            for pane in saved.panes {
                this.z_counter = this.z_counter.max(pane.z);
                let tabs = pane
                    .tabs
                    .iter()
                    .map(|t| this.make_tab_state(pane.kind, t.clone(), pane.width as f32, pane.height as f32, window, cx))
                    .collect();
                this.panes.push(Pane {
                    id: pane.id,
                    kind: pane.kind,
                    x: pane.x as f32,
                    y: pane.y as f32,
                    width: pane.width as f32,
                    height: pane.height as f32,
                    z: pane.z,
                    tabs,
                    active_tab_id: pane.active_tab_id,
                });
            }
        }
        this
    }

    fn make_tab_state(&mut self, kind: PaneKind, saved: SavedTab, w: f32, h: f32, window: &mut Window, cx: &mut Context<Self>) -> TabState {
        let (view, sub) = match kind {
            PaneKind::Terminal => {
                let screen_h = h - TITLEBAR_H - 2.0;
                let id = saved.id.clone();
                let cwd = saved.cwd.clone();
                let command = saved.command.clone();
                let v = cx.new(|cx| TerminalView::new(id, cwd, command, w - 2.0, screen_h, window, cx));
                // Only a folder change is worth writing down. The running
                // timer ticks four times a second and must not keep pushing
                // the debounced save back for as long as a command runs.
                let sub = cx.subscribe(&v, |_, _, e: &TerminalEvent, cx| {
                    if matches!(e, TerminalEvent::CwdChanged) {
                        cx.emit(WorkspaceEvent::Dirty);
                    }
                    cx.notify();
                });
                (TabView::Terminal(v), sub)
            }
            PaneKind::Browser => {
                let id = saved.id.clone();
                let url = saved.url.clone();
                let v = cx.new(|cx| BrowserView::new(id, url, window, cx));
                let sub = cx.subscribe_in(&v, window, |this, _, e: &BrowserEvent, window, cx| match e {
                    BrowserEvent::StatusChanged => cx.notify(),
                    BrowserEvent::UrlChanged => {
                        cx.emit(WorkspaceEvent::Dirty);
                        cx.notify();
                    }
                    BrowserEvent::Shortcut { key, shift, alt } => {
                        this.guest_shortcut(key, *shift, *alt, window, cx);
                    }
                });
                (TabView::Browser(v), sub)
            }
        };
        TabState { id: saved.id, title: saved.title, title_locked: saved.title_locked, command: saved.command, view, _sub: sub }
    }

    /// A shortcut typed inside a page, replayed as if it had been typed on
    /// the canvas.
    fn guest_shortcut(&mut self, key: &str, shift: bool, alt: bool, window: &mut Window, cx: &mut Context<Self>) {
        let action: Box<dyn gpui::Action> = match (key, alt) {
            ("w", _) => Box::new(super::app::CloseSelection),
            ("n", _) => Box::new(super::app::NewTerminal),
            ("b", _) => Box::new(super::app::NewBrowser),
            ("t", _) => Box::new(super::app::NewWorkflow),
            ("l", _) => Box::new(super::app::FocusOmnibox),
            (d, true) if d.len() == 1 => match d.parse::<usize>() {
                Ok(n) => Box::new(super::app::SwitchWorkflow(n)),
                Err(_) => return,
            },
            (d, false) if d.len() == 1 => match d.parse::<usize>() {
                Ok(n) => Box::new(super::app::SwitchTab(n)),
                Err(_) => return,
            },
            _ => return,
        };
        let _ = shift;
        // Taken back off the page first, so the action lands on the app.
        window.focus(&self.focus_handle);
        window.dispatch_action(action, cx);
    }

    fn rect_of(&self, p: &Pane) -> Bounds<Pixels> {
        let o = self.canvas_bounds.origin;
        Bounds::new(
            point(o.x + px(self.pan.0 + p.x * self.zoom), o.y + px(self.pan.1 + p.y * self.zoom)),
            size(px(p.width * self.zoom), px(p.height * self.zoom)),
        )
    }

    /// Screen coordinates → canvas coordinates (undo the translate, then the
    /// scale).
    fn to_canvas(&self, p: Point<Pixels>) -> (f32, f32) {
        let o = self.canvas_bounds.origin;
        ((f32::from(p.x - o.x) - self.pan.0) / self.zoom, (f32::from(p.y - o.y) - self.pan.1) / self.zoom)
    }

    fn canvas_size(&self) -> (f32, f32) {
        (f32::from(self.canvas_bounds.size.width), f32::from(self.canvas_bounds.size.height))
    }

    fn dirty(&mut self, cx: &mut Context<Self>) {
        cx.emit(WorkspaceEvent::Dirty);
        cx.notify();
    }

    fn cancel_reveal(&mut self) {
        if let Some(r) = self.reveal.as_mut() {
            r.glide = false;
        }
    }

    fn commit_view(&mut self, zoom: Option<f32>, pan: (f32, f32), cx: &mut Context<Self>) {
        if let Some(z) = zoom {
            self.zoom = z;
        }
        self.pan = pan;
        self.dirty(cx);
    }

    /// Zoom keeps the point under the cursor pinned: solve for the pan that
    /// leaves that screen point mapping to the same content point.
    fn apply_zoom(&mut self, next: impl Fn(f32) -> f32, at: Option<Point<Pixels>>, cx: &mut Context<Self>) {
        self.cancel_reveal();
        let old = self.zoom;
        let new = clamp_zoom(next(old));
        if (new - old).abs() < f32::EPSILON {
            return;
        }
        let (w, h) = self.canvas_size();
        let o = self.canvas_bounds.origin;
        let (mx, my) = match at {
            Some(p) => (f32::from(p.x - o.x), f32::from(p.y - o.y)),
            None => (w / 2.0, h / 2.0),
        };
        let ratio = new / old;
        let pan = (mx - (mx - self.pan.0) * ratio, my - (my - self.pan.1) * ratio);
        self.commit_view(Some(new), pan, cx);
    }

    pub fn zoom_in(&mut self, cx: &mut Context<Self>) {
        self.apply_zoom(|z| z * ZOOM_BUTTON_RATIO, None, cx);
    }

    pub fn zoom_out(&mut self, cx: &mut Context<Self>) {
        self.apply_zoom(|z| z / ZOOM_BUTTON_RATIO, None, cx);
    }

    pub fn zoom_reset(&mut self, cx: &mut Context<Self>) {
        self.apply_zoom(|_| 1.0, None, cx);
    }

    /// The safety net for an unbounded canvas, and the only one: frame
    /// everything open at whatever zoom makes it fit, from any offset and any
    /// scale.
    pub fn fit_to_content(&mut self, cx: &mut Context<Self>) {
        if self.panes.is_empty() {
            return;
        }
        self.cancel_reveal();
        let (min_x, min_y, max_x, max_y) = self.content_bounds();
        let (w, h) = self.canvas_size();
        const PAD: f32 = 80.0;
        let z = clamp_zoom(((w - PAD * 2.0) / (max_x - min_x)).min((h - PAD * 2.0) / (max_y - min_y)));
        let pan = (w / 2.0 - (min_x + max_x) / 2.0 * z, h / 2.0 - (min_y + max_y) / 2.0 * z);
        self.commit_view(Some(z), pan, cx);
    }

    fn content_bounds(&self) -> (f32, f32, f32, f32) {
        let mut b = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for p in &self.panes {
            b.0 = b.0.min(p.x);
            b.1 = b.1.min(p.y);
            b.2 = b.2.max(p.x + p.width);
            b.3 = b.3.max(p.y + p.height);
        }
        b
    }

    fn view_now(&mut self, window: &mut Window) -> (f32, (f32, f32)) {
        let Some(r) = self.reveal.as_ref() else { return (self.zoom, self.pan) };
        if !r.glide {
            return (self.zoom, self.pan);
        }
        let t = (r.started.elapsed().as_secs_f32() * 1000.0 / REVEAL_MS).min(1.0);
        let e = ease_out_back(t);
        let zoom = r.from_zoom + (r.to_zoom - r.from_zoom) * ease_out_cubic(t);
        let pan = (r.from_pan.0 + (r.to_pan.0 - r.from_pan.0) * e, r.from_pan.1 + (r.to_pan.1 - r.from_pan.1) * e);
        if t >= 1.0 {
            let (z, p) = (r.to_zoom, r.to_pan);
            self.zoom = z;
            self.pan = p;
            if let Some(r) = self.reveal.as_mut() {
                r.glide = false;
            }
        } else {
            self.zoom = zoom;
            self.pan = pan;
            window.request_animation_frame();
        }
        (self.zoom, self.pan)
    }

    // ── Panes ──────────────────────────────────────────────────────────────

    /// The folder a new terminal should follow: the one the last used
    /// session is sitting in. The stack already knows which that is — z is
    /// bumped every time a pane is opened, selected or dragged — and within
    /// a box the tab in front answers before the ones behind it.
    fn last_used_cwd(&self, cx: &App) -> Option<String> {
        let mut terminals: Vec<&Pane> = self.panes.iter().filter(|p| p.kind == PaneKind::Terminal).collect();
        terminals.sort_by(|a, b| b.z.partial_cmp(&a.z).unwrap_or(std::cmp::Ordering::Equal));
        for pane in terminals {
            let ordered = pane.tabs.iter().filter(|t| t.id == pane.active_tab_id).chain(pane.tabs.iter().filter(|t| t.id != pane.active_tab_id));
            for tab in ordered {
                if let TabView::Terminal(v) = &tab.view {
                    if let Some(c) = v.read(cx).status.cwd.clone() {
                        return Some(c);
                    }
                }
            }
        }
        None
    }

    fn new_saved_tab(kind: PaneKind, cwd: Option<String>) -> SavedTab {
        let n = ids::next_session();
        SavedTab {
            id: ids::next_id("term"),
            title: if kind.is_browser() { format!("Browser {n}") } else { format!("Terminal {n}") },
            title_locked: false,
            cwd,
            command: None,
            url: None,
        }
    }

    /// A new session joins the selected window when that window is the same
    /// kind, and opens its own window otherwise: a box keeps to one kind.
    pub fn add_pane(&mut self, kind: PaneKind, window: &mut Window, cx: &mut Context<Self>) {
        let cwd = if kind.is_browser() { None } else { self.last_used_cwd(cx) };
        if self.selected.len() == 1 {
            if let Some(idx) = self.panes.iter().position(|p| p.id == self.selected[0] && p.kind == kind) {
                let (w, h) = (self.panes[idx].width, self.panes[idx].height);
                let tab = self.make_tab_state(kind, Self::new_saved_tab(kind, cwd), w, h, window, cx);
                let id = tab.id.clone();
                self.panes[idx].tabs.push(tab);
                self.panes[idx].active_tab_id = id;
                let pane_id = self.panes[idx].id.clone();
                self.focus_pane(&pane_id, window, cx);
                self.dirty(cx);
                return;
            }
        }
        // In front of the user wherever they have panned or zoomed to, with a
        // small step per pane so successive ones do not land exactly on top
        // of each other.
        let (w, h) = self.canvas_size();
        let step = (self.panes.len() % 5) as f32 - 2.0;
        let offset = step * CASCADE_STEP;
        let (sw, sh) = DEFAULT_SIZE;
        let x = (w / 2.0 - self.pan.0) / self.zoom - sw / 2.0 + offset;
        let y = (h / 2.0 - self.pan.1) / self.zoom - sh / 2.0 + offset;
        self.z_counter += 1.0;
        let tab = self.make_tab_state(kind, Self::new_saved_tab(kind, cwd), sw, sh, window, cx);
        let id = ids::next_id("pane");
        let active = tab.id.clone();
        self.panes.push(Pane { id: id.clone(), kind, x, y, width: sw, height: sh, z: self.z_counter, tabs: vec![tab], active_tab_id: active });
        self.selected = vec![id.clone()];
        self.focus_pane(&id, window, cx);
        self.dirty(cx);
    }

    /// Hands the keyboard to the session in front of a pane.
    fn focus_pane(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = self.panes.iter().find(|p| p.id == id) else { return };
        match &p.active_tab().view {
            TabView::Terminal(v) => window.focus(&v.focus_handle(cx)),
            TabView::Browser(v) => {
                window.focus(&v.focus_handle(cx));
                v.read(cx).focus_page();
            }
        }
    }

    /// Clicking an unselected pane selects just it; clicking one already
    /// inside a multi-selection keeps the group intact so it can be dragged
    /// together. Shift toggles membership.
    fn select_pane(&mut self, id: &str, shift: bool, cx: &mut Context<Self>) {
        if shift {
            if let Some(i) = self.selected.iter().position(|s| s == id) {
                self.selected.remove(i);
            } else {
                self.selected.push(id.to_string());
            }
        } else if !(self.selected.iter().any(|s| s == id) && self.selected.len() > 1) {
            self.selected = vec![id.to_string()];
        }
        self.z_counter += 1.0;
        let z = self.z_counter;
        if let Some(p) = self.panes.iter_mut().find(|p| p.id == id) {
            p.z = z;
        }
        self.pane_menu = None;
        cx.notify();
    }

    pub fn select_tab(&mut self, n: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected.len() != 1 {
            return;
        }
        let id = self.selected[0].clone();
        let Some(p) = self.panes.iter_mut().find(|p| p.id == id) else { return };
        let Some(tab) = p.tabs.get(n.saturating_sub(1)) else { return };
        p.active_tab_id = tab.id.clone();
        self.focus_pane(&id, window, cx);
        self.dirty(cx);
    }

    fn set_active_tab(&mut self, pane: &str, tab: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(p) = self.panes.iter_mut().find(|p| p.id == pane) {
            p.active_tab_id = tab.to_string();
        }
        self.focus_pane(pane, window, cx);
        self.dirty(cx);
    }

    fn tab_running(tab: &TabState, cx: &App) -> bool {
        matches!(&tab.view, TabView::Terminal(v) if v.read(cx).is_running())
    }

    /// How many sessions here have a command in flight. Read at the one
    /// moment the workflow is about to close.
    pub fn running_count(&self, cx: &App) -> usize {
        self.panes.iter().flat_map(|p| p.tabs.iter()).filter(|t| Self::tab_running(t, cx)).count()
    }

    fn something_running(&self, ids: &[String], cx: &App) -> bool {
        self.panes.iter().filter(|p| ids.contains(&p.id)).flat_map(|p| p.tabs.iter()).any(|t| Self::tab_running(t, cx))
    }

    fn remove_panes(&mut self, ids: &[String], cx: &mut Context<Self>) {
        // Dropping a tab's view ends its session, and with it the whole
        // process group inside it.
        for p in self.panes.iter_mut().filter(|p| ids.contains(&p.id)) {
            for t in &p.tabs {
                if let TabView::Browser(b) = &t.view {
                    b.update(cx, |b, _| b.hide());
                }
            }
        }
        self.panes.retain(|p| !ids.contains(&p.id));
        self.selected.retain(|s| !ids.contains(s));
        self.dirty(cx);
    }

    fn remove_tab(&mut self, pane: &str, tab: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = self.panes.iter_mut().find(|p| p.id == pane) else { return };
        let Some(index) = p.tabs.iter().position(|t| t.id == tab) else { return };
        if p.tabs.len() <= 1 {
            return;
        }
        if let TabView::Browser(b) = &p.tabs[index].view {
            b.update(cx, |b, _| b.hide());
        }
        p.tabs.remove(index);
        // The tab to its left, the way every tabbed thing does it.
        if p.active_tab_id == tab {
            p.active_tab_id = p.tabs[index.saturating_sub(1)].id.clone();
        }
        let pane = pane.to_string();
        self.focus_pane(&pane, window, cx);
        self.dirty(cx);
    }

    /// Every way out of a pane kills the process group inside it, so every
    /// way out asks first — but only when there is work in flight. An idle
    /// prompt and a page close on the spot.
    fn request_close_panes(&mut self, ids: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        if ids.is_empty() {
            return;
        }
        if !self.something_running(&ids, cx) {
            self.remove_panes(&ids, cx);
            return;
        }
        if self.pending_close.is_none() && self.pending_close_tab.is_none() {
            // The keyboard comes away from the terminal while the question
            // stands, so keys meant for it cannot reach a shell prompt.
            window.focus(&self.focus_handle);
            self.pending_close = Some(ids);
            cx.notify();
        }
    }

    fn close_tab(&mut self, pane: &str, tab: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = self.panes.iter().find(|p| p.id == pane) else { return };
        // The last tab in a box is the box.
        if p.tabs.len() <= 1 {
            self.request_close_panes(vec![pane.to_string()], window, cx);
        } else if p.tabs.iter().any(|t| t.id == tab && Self::tab_running(t, cx)) {
            if self.pending_close.is_none() && self.pending_close_tab.is_none() {
                window.focus(&self.focus_handle);
                self.pending_close_tab = Some((pane.to_string(), tab.to_string()));
                cx.notify();
            }
        } else {
            self.remove_tab(pane, tab, window, cx);
        }
    }

    /// ⌘W closes the innermost thing actually targeted, falling outward when
    /// nothing inside is: the tab in front, then the window holding it, then
    /// the workflow holding that.
    pub fn close_selected(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected.is_empty() {
            cx.emit(WorkspaceEvent::RequestCloseWorkflow);
            return;
        }
        if self.selected.len() == 1 {
            if let Some(p) = self.panes.iter().find(|p| p.id == self.selected[0]) {
                if p.tabs.len() > 1 {
                    let (pane, tab) = (p.id.clone(), p.active_tab_id.clone());
                    self.close_tab(&pane, &tab, window, cx);
                    return;
                }
            }
        }
        let ids = self.selected.clone();
        self.request_close_panes(ids, window, cx);
    }

    fn cancel_close(&mut self, cx: &mut Context<Self>) {
        self.pending_close = None;
        self.pending_close_tab = None;
        cx.notify();
    }

    fn confirm_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some((pane, tab)) = self.pending_close_tab.take() {
            self.remove_tab(&pane, &tab, window, cx);
        } else if let Some(ids) = self.pending_close.take() {
            self.remove_panes(&ids, cx);
        }
        cx.notify();
    }

    /// Bring a pane to the middle of the window and hand it the keyboard,
    /// wherever the view happens to be: the dock's whole job.
    pub fn reveal_pane(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = self.panes.iter().find(|p| p.id == id) else { return };
        let r_ = (p.x, p.y, p.width, p.height);
        let (cw, ch) = self.canvas_size();
        let from_zoom = self.zoom;
        // The zoom you were working at is the zoom you keep — unless the pane
        // would not be readable, or would be far bigger than the window.
        let overflow = (r_.2 * from_zoom / cw).max(r_.3 * from_zoom / ch);
        let keep = from_zoom >= REVEAL_LEGIBLE_ZOOM && overflow <= REVEAL_MAX_OVERFLOW;
        let fit = ((cw - REVEAL_PAD * 2.0) / r_.2).min((ch - REVEAL_PAD * 2.0) / r_.3);
        let to_zoom = if keep { from_zoom } else { clamp_zoom(fit.min(1.0)) };
        let to_pan = (cw / 2.0 - (r_.0 + r_.2 / 2.0) * to_zoom, ch / 2.0 - (r_.1 + r_.3 / 2.0) * to_zoom);
        self.reveal = Some(Reveal {
            rect: r_,
            started: Instant::now(),
            from_zoom,
            to_zoom,
            from_pan: self.pan,
            to_pan,
            glide: true,
        });
        let id = id.to_string();
        // Selection now, not when the glide lands: everything typed during
        // the trip has to go somewhere.
        self.select_pane(&id, false, cx);
        self.selected = vec![id.clone()];
        self.focus_pane(&id, window, cx);
        // The marks let go after their run.
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(REVEAL_MARK_MS as u64 + 20)).await;
            let _ = this.update(cx, |this, cx| {
                if this.reveal.as_ref().map(|r| r.started.elapsed().as_secs_f32() * 1000.0 >= REVEAL_MARK_MS).unwrap_or(false) {
                    this.reveal = None;
                    cx.notify();
                }
            });
        })
        .detach();
        self.dirty(cx);
    }

    // ── Editors ────────────────────────────────────────────────────────────

    /// The folder a pane is showing: where its shell is NOW, as last
    /// reported through OSC 7.
    fn folder_of(&self, pane: &str, cx: &App) -> Option<String> {
        let p = self.panes.iter().find(|p| p.id == pane)?;
        match &p.active_tab().view {
            TabView::Terminal(v) => v.read(cx).status.cwd.clone(),
            TabView::Browser(_) => None,
        }
    }

    fn use_editor(&mut self, app: String, dir: &str, cx: &mut Context<Self>) {
        let dir = dir.to_string();
        let app_ = app.clone();
        cx.background_executor().spawn(async move { platform::open_in_editor(&app_, &dir) }).detach();
        cx.emit(WorkspaceEvent::EditorChosen(app));
    }

    /// Picks an application by hand and uses it: the way in for an editor the
    /// known list has never heard of.
    fn pick_application(&mut self, dir: String, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: true,
            multiple: false,
            prompt: Some("Choose an editor".into()),
        });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else { return };
            let Some(app) = paths.first().and_then(|p| platform::bundle_name_of(p)) else { return };
            let _ = this.update(cx, |this, cx| this.use_editor(app, &dir, cx));
        })
        .detach();
    }

    /// ⌘E hands the selected terminal's folder to the remembered editor, or
    /// asks which when there is none (or when ⇧ asks for a different one).
    pub fn open_in_editor(&mut self, ask: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected.len() != 1 {
            return;
        }
        let Some(dir) = self.folder_of(&self.selected[0].clone(), cx) else { return };
        let editors = editors_from(&platform::list_applications(), self.editor_pref.as_deref());
        if editors.is_empty() {
            self.pick_application(dir, cx);
            return;
        }
        if !ask {
            if let Some(e) = resolve_editor(self.editor_pref.as_deref(), &editors) {
                // Straight through, and not re-recorded: the answer was given.
                let (app, dir) = (e.app.clone(), dir.clone());
                cx.background_executor().spawn(async move { platform::open_in_editor(&app, &dir) }).detach();
                return;
            }
        }
        window.focus(&self.focus_handle);
        self.editor_choice = Some((dir, editors));
        cx.notify();
    }

    fn open_pane_menu(&mut self, pane: &str, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(dir) = self.folder_of(pane, cx) else { return };
        let editors = editors_from(&platform::list_applications(), self.editor_pref.as_deref());
        let o = self.canvas_bounds.origin;
        window.focus(&self.focus_handle);
        self.pane_menu = Some((dir, editors, f32::from(at.x - o.x), f32::from(at.y - o.y)));
        cx.notify();
    }

    pub fn focus_omnibox(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected.len() != 1 {
            return;
        }
        let Some(p) = self.panes.iter().find(|p| p.id == self.selected[0]) else { return };
        if let TabView::Browser(b) = &p.active_tab().view {
            b.update(cx, |b, cx| b.begin_editing(window, cx));
        }
    }

    pub fn apply_theme(&mut self, theme: &Theme, cx: &mut Context<Self>) {
        for p in &self.panes {
            for t in &p.tabs {
                if let TabView::Terminal(v) = &t.view {
                    v.update(cx, |v, cx| {
                        v.set_theme(theme);
                        cx.notify();
                    });
                }
            }
        }
    }

    /// Ends every session in this workflow — the shells and everything they
    /// launched. Called on the way out, where entities are not guaranteed to
    /// be dropped before the process exits and a dev server would otherwise
    /// outlive the app as an orphan.
    pub fn shutdown(&self, cx: &App) {
        for p in &self.panes {
            for t in &p.tabs {
                if let TabView::Terminal(v) = &t.view {
                    if let Some(s) = &v.read(cx).session {
                        s.kill();
                    }
                }
            }
        }
    }

    /// Hides every native page; a workflow going into the background must
    /// not leave its pages floating over the next one.
    pub fn hide_pages(&mut self, cx: &mut Context<Self>) {
        for p in &self.panes {
            for t in &p.tabs {
                if let TabView::Browser(b) = &t.view {
                    b.update(cx, |b, _| b.hide());
                }
            }
        }
    }

    // ── Titles ─────────────────────────────────────────────────────────────

    /// A terminal is named after the work in it — the folder, and the branch
    /// when it differs from the folder — not after the order it was opened
    /// in. A browser carries the page's title. A name the user typed sticks.
    fn title_of(&self, kind: PaneKind, tab: &TabState, cx: &App) -> String {
        if tab.title_locked {
            return tab.title.clone();
        }
        match &tab.view {
            TabView::Browser(b) => b.read(cx).page_title.clone().unwrap_or_else(|| tab.title.clone()),
            TabView::Terminal(v) => {
                let s = &v.read(cx).status;
                let Some(folder) = s.cwd.as_deref().map(folder_name) else { return tab.title.clone() };
                match &s.branch {
                    Some(b) if *b != folder && kind == PaneKind::Terminal => format!("{folder} -> {b}"),
                    _ => folder,
                }
            }
        }
    }

    /// Names on the strip, made distinct: three tabs reading "mesa" name
    /// nothing. Numbered only where there is a clash, and by WHEN the session
    /// was opened, so a name stays put when its tab is dragged.
    fn strip_labels(&self, pane: &Pane, cx: &App) -> Vec<String> {
        let names: Vec<String> = pane.tabs.iter().map(|t| self.title_of(pane.kind, t, cx)).collect();
        let mut order: Vec<usize> = (0..pane.tabs.len()).collect();
        order.sort_by_key(|&i| trailing_number(&pane.tabs[i].id));
        let mut seen: std::collections::HashMap<&str, usize> = Default::default();
        let mut nth = vec![0usize; names.len()];
        for &i in &order {
            if names.iter().filter(|n| **n == names[i]).count() > 1 {
                let c = seen.entry(names[i].as_str()).or_insert(0);
                *c += 1;
                nth[i] = *c;
            }
        }
        names.iter().zip(nth).map(|(n, k)| if k > 0 { format!("{n} {k}") } else { n.clone() }).collect()
    }

    pub fn pane_names(&self, cx: &App) -> Vec<(String, PaneKind, Name)> {
        self.panes
            .iter()
            .map(|p| {
                let tab = p.active_tab();
                (p.id.clone(), p.kind, split_name(&self.title_of(p.kind, tab, cx), tab.title_locked))
            })
            .collect()
    }

    // ── Persistence ────────────────────────────────────────────────────────

    /// This workflow as it would be written to disk: the live folder and
    /// address, not the ones the tab opened with, and the session's own name
    /// rather than the one it is wearing.
    pub fn serialize(&self, name: &str, cx: &App) -> Workflow {
        Workflow {
            id: self.id.clone(),
            name: name.to_string(),
            view: View { zoom: self.zoom as f64, pan: Pan { x: self.pan.0 as f64, y: self.pan.1 as f64 } },
            panes: self
                .panes
                .iter()
                .map(|p| SavedPane {
                    id: p.id.clone(),
                    kind: p.kind,
                    x: p.x as f64,
                    y: p.y as f64,
                    width: p.width as f64,
                    height: p.height as f64,
                    z: p.z,
                    active_tab_id: p.active_tab_id.clone(),
                    tabs: p
                        .tabs
                        .iter()
                        .map(|t| {
                            let (cwd, url) = match &t.view {
                                TabView::Terminal(v) => (v.read(cx).status.cwd.clone(), None),
                                TabView::Browser(b) => {
                                    let u = b.read(cx).url.clone();
                                    (None, (!u.is_empty()).then_some(u))
                                }
                            };
                            SavedTab {
                                id: t.id.clone(),
                                title: t.title.clone(),
                                title_locked: t.title_locked,
                                cwd,
                                command: if p.kind == PaneKind::Terminal { t.command.clone() } else { None },
                                url,
                            }
                        })
                        .collect(),
                })
                .collect(),
        }
    }

    // ── Gestures ───────────────────────────────────────────────────────────

    fn on_canvas_mouse_down(&mut self, e: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.cancel_reveal();
        self.pane_menu = None;
        window.focus(&self.focus_handle);
        if self.space_held || e.button == MouseButton::Middle {
            self.gesture = Some(Gesture::Pan { start: e.position, start_pan: self.pan });
            cx.notify();
            return;
        }
        if e.button != MouseButton::Left {
            return;
        }
        let p = self.to_canvas(e.position);
        self.gesture = Some(Gesture::Marquee { start: p, current: p, additive: e.modifiers.shift });
        if !e.modifiers.shift {
            self.selected.clear();
        }
        cx.notify();
    }

    fn on_scroll(&mut self, e: &ScrollWheelEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let delta = e.delta.pixel_delta(px(20.));
        if e.modifiers.platform || e.modifiers.control {
            // Zoom wins over everything.
            let step = (f32::from(delta.y) * ZOOM_WHEEL_RATE).clamp(-ZOOM_WHEEL_MAX_STEP, ZOOM_WHEEL_MAX_STEP);
            self.apply_zoom(|z| z * step.exp(), Some(e.position), cx);
            return;
        }
        // Empty canvas, a title bar, a pane border: pan the workspace.
        self.cancel_reveal();
        let pan = (self.pan.0 + f32::from(delta.x), self.pan.1 + f32::from(delta.y));
        self.commit_view(None, pan, cx);
    }

    fn on_global_move(&mut self, e: &MouseMoveEvent, cx: &mut Context<Self>) {
        let zoom = self.zoom;
        match self.gesture.as_mut() {
            Some(Gesture::Pan { start, start_pan }) => {
                let pan = (start_pan.0 + f32::from(e.position.x - start.x), start_pan.1 + f32::from(e.position.y - start.y));
                self.commit_view(None, pan, cx);
            }
            Some(Gesture::Marquee { .. }) => {
                let p = self.to_canvas(e.position);
                if let Some(Gesture::Marquee { current, .. }) = self.gesture.as_mut() {
                    *current = p;
                }
                cx.notify();
            }
            Some(Gesture::Drag { start, members }) => {
                let dx = f32::from(e.position.x - start.x) / zoom;
                let dy = f32::from(e.position.y - start.y) / zoom;
                let members = members.clone();
                for (id, x, y) in members {
                    if let Some(p) = self.panes.iter_mut().find(|p| p.id == id) {
                        p.x = x + dx;
                        p.y = y + dy;
                    }
                }
                cx.notify();
            }
            Some(Gesture::Resize { pane, edge, start, rect }) => {
                let dx = f32::from(e.position.x - start.x) / zoom;
                let dy = f32::from(e.position.y - start.y) / zoom;
                let (x, y, w, h) = *rect;
                let (mut nx, mut ny, mut nw, mut nh) = (x, y, w, h);
                let east = matches!(edge, Edge::E | Edge::NE | Edge::SE);
                let west = matches!(edge, Edge::W | Edge::NW | Edge::SW);
                let south = matches!(edge, Edge::S | Edge::SE | Edge::SW);
                let north = matches!(edge, Edge::N | Edge::NE | Edge::NW);
                if east {
                    nw = (w + dx).max(MIN_SIZE.0);
                }
                if south {
                    nh = (h + dy).max(MIN_SIZE.1);
                }
                if west {
                    nw = (w - dx).max(MIN_SIZE.0);
                    nx = x + w - nw;
                }
                if north {
                    nh = (h - dy).max(MIN_SIZE.1);
                    ny = y + h - nh;
                }
                let pane = pane.clone();
                if let Some(p) = self.panes.iter_mut().find(|p| p.id == pane) {
                    (p.x, p.y, p.width, p.height) = (nx, ny, nw, nh);
                }
                cx.notify();
            }
            Some(Gesture::TabDrag { pane, tab, start_x, moved }) => {
                // A few pixels of slack, so a click that shifts slightly is
                // still a click. The order is rewritten as you cross a
                // neighbour, so the strip shows the arrangement you are
                // choosing while you choose it.
                if !*moved && (f32::from(e.position.x - *start_x)).abs() < 4.0 {
                    return;
                }
                *moved = true;
                let (pane, tab) = (pane.clone(), tab.clone());
                let Some(p) = self.panes.iter().find(|p| p.id == pane) else { return };
                let rect = self.rect_of(p);
                let tab_w = (f32::from(rect.size.width) - 30.0 * zoom) / p.tabs.len() as f32;
                let rel = f32::from(e.position.x - rect.origin.x) - 4.0 * zoom;
                let to = ((rel / tab_w.max(1.0)).floor().max(0.0) as usize).min(p.tabs.len() - 1);
                if let Some(p) = self.panes.iter_mut().find(|p| p.id == pane) {
                    if let Some(from) = p.tabs.iter().position(|t| t.id == tab) {
                        if from != to {
                            let t = p.tabs.remove(from);
                            p.tabs.insert(to, t);
                            cx.notify();
                        }
                    }
                }
            }
            Some(Gesture::Minimap { proj }) => {
                let proj = *proj;
                self.minimap_navigate(e.position, proj, cx);
            }
            None => {}
        }
    }

    fn on_global_up(&mut self, _e: &MouseUpEvent, cx: &mut Context<Self>) {
        match self.gesture.take() {
            Some(Gesture::Marquee { start, current, additive }) => {
                let (x0, y0) = (start.0.min(current.0), start.1.min(current.1));
                let (x1, y1) = (start.0.max(current.0), start.1.max(current.1));
                if x1 - x0 > 0.5 || y1 - y0 > 0.5 {
                    let hits: Vec<String> = self
                        .panes
                        .iter()
                        .filter(|p| p.x < x1 && p.x + p.width > x0 && p.y < y1 && p.y + p.height > y0)
                        .map(|p| p.id.clone())
                        .collect();
                    if additive {
                        for h in hits {
                            if !self.selected.contains(&h) {
                                self.selected.push(h);
                            }
                        }
                    } else {
                        self.selected = hits;
                    }
                }
                cx.notify();
            }
            Some(Gesture::Drag { .. }) | Some(Gesture::Resize { .. }) | Some(Gesture::TabDrag { moved: true, .. }) => {
                self.dirty(cx);
            }
            Some(_) => cx.notify(),
            None => {}
        }
    }

    fn begin_drag(&mut self, anchor: &str, at: Point<Pixels>) {
        let ids: Vec<String> = if self.selected.iter().any(|s| s == anchor) && self.selected.len() > 1 {
            self.selected.clone()
        } else {
            vec![anchor.to_string()]
        };
        let mut members = Vec::new();
        for id in &ids {
            self.z_counter += 1.0;
            let z = self.z_counter;
            if let Some(p) = self.panes.iter_mut().find(|p| &p.id == id) {
                p.z = z;
                members.push((p.id.clone(), p.x, p.y));
            }
        }
        self.gesture = Some(Gesture::Drag { start: at, members });
    }

    // ── Minimap ────────────────────────────────────────────────────────────

    /// The map frames the union of everything open AND where you are looking
    /// — wander off into empty canvas and it zooms out to hold both, so you
    /// can see the work off to one side and drag straight back to it.
    fn projection(&self) -> Projection {
        let (cw, ch) = self.canvas_size();
        let view = (-self.pan.0 / self.zoom, -self.pan.1 / self.zoom, cw / self.zoom, ch / self.zoom);
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (view.0, view.1, view.0 + view.2, view.1 + view.3);
        for p in &self.panes {
            min_x = min_x.min(p.x);
            min_y = min_y.min(p.y);
            max_x = max_x.max(p.x + p.width);
            max_y = max_y.max(p.y + p.height);
        }
        let (bw, bh) = ((max_x - min_x).max(1.0), (max_y - min_y).max(1.0));
        let (iw, ih) = (MAP_W - MAP_PAD * 2.0, MAP_H - MAP_PAD * 2.0);
        let s = (iw / bw).min(ih / bh);
        Projection { s, ox: MAP_PAD + (iw - bw * s) / 2.0 - min_x * s, oy: MAP_PAD + (ih - bh * s) / 2.0 - min_y * s }
    }

    fn minimap_origin(&self) -> Point<Pixels> {
        let b = self.canvas_bounds;
        point(b.origin.x + b.size.width - px(MAP_W + 12.0 + 2.0), b.origin.y + b.size.height - px(MAP_H + 12.0 + 2.0))
    }

    /// Put a canvas point in the middle of the window at the current zoom.
    fn minimap_navigate(&mut self, at: Point<Pixels>, proj: Projection, cx: &mut Context<Self>) {
        let o = self.minimap_origin();
        let wx = (f32::from(at.x - o.x) - 1.0 - proj.ox) / proj.s;
        let wy = (f32::from(at.y - o.y) - 1.0 - proj.oy) / proj.s;
        let (cw, ch) = self.canvas_size();
        let pan = (cw / 2.0 - wx * self.zoom, ch / 2.0 - wy * self.zoom);
        self.commit_view(None, pan, cx);
    }

    // ── Editing names and commands ─────────────────────────────────────────

    fn begin_title_edit(&mut self, pane: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = self.panes.iter().find(|p| p.id == pane) else { return };
        let tab = p.active_tab();
        let current = self.title_of(p.kind, tab, cx);
        let (pane, tab) = (pane.to_string(), tab.id.clone());
        let input = self.make_input(current, "", window, cx);
        let sub = cx.subscribe_in(&input, window, |this, _, e: &InputEvent, window, cx| match e {
            InputEvent::Submit(text) | InputEvent::Blur(text) => {
                let text = text.trim().to_string();
                if let Some(ed) = this.title_edit.take() {
                    if !text.is_empty() {
                        if let Some(t) = this.panes.iter_mut().find(|p| p.id == ed.pane).and_then(|p| p.tabs.iter_mut().find(|t| t.id == ed.tab)) {
                            t.title = text;
                            t.title_locked = true;
                        }
                    }
                    let pane = ed.pane.clone();
                    if matches!(e, InputEvent::Submit(_)) {
                        this.focus_pane(&pane, window, cx);
                    }
                }
                this.dirty(cx);
            }
            InputEvent::Cancel => {
                if let Some(ed) = this.title_edit.take() {
                    this.focus_pane(&ed.pane, window, cx);
                }
                cx.notify();
            }
        });
        window.focus(&input.focus_handle(cx));
        self.title_edit = Some(Editing { pane, tab, input, _sub: sub });
        cx.notify();
    }

    fn toggle_command_edit(&mut self, pane: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.command_edit.as_ref().map(|e| e.pane == pane).unwrap_or(false) {
            self.command_edit = None;
            cx.notify();
            return;
        }
        let Some(p) = self.panes.iter().find(|p| p.id == pane) else { return };
        let tab = p.active_tab();
        let current = tab.command.clone().unwrap_or_default();
        let (pane, tab) = (pane.to_string(), tab.id.clone());
        let input = self.make_input(current, "npm run dev", window, cx);
        let sub = cx.subscribe_in(&input, window, |this, _, e: &InputEvent, window, cx| match e {
            InputEvent::Submit(text) | InputEvent::Blur(text) => {
                // Stripped on the way in as well as on the way out of the
                // file: a single line means a single command. Empty clears it.
                let command = strip_controls(text);
                if let Some(ed) = this.command_edit.take() {
                    if let Some(t) = this.panes.iter_mut().find(|p| p.id == ed.pane).and_then(|p| p.tabs.iter_mut().find(|t| t.id == ed.tab)) {
                        t.command = (!command.is_empty()).then_some(command);
                    }
                    if matches!(e, InputEvent::Submit(_)) {
                        this.focus_pane(&ed.pane, window, cx);
                    }
                }
                this.dirty(cx);
            }
            InputEvent::Cancel => {
                if let Some(ed) = this.command_edit.take() {
                    this.focus_pane(&ed.pane, window, cx);
                }
                cx.notify();
            }
        });
        window.focus(&input.focus_handle(cx));
        self.command_edit = Some(Editing { pane, tab, input, _sub: sub });
        cx.notify();
    }

    fn make_input(&self, text: String, placeholder: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<TextInput> {
        let theme = cx.global::<Theme>().clone();
        let placeholder = placeholder.to_string();
        cx.new(|cx| {
            let mut t = TextInput::new(text, placeholder, window, cx);
            t.cursor_color = theme.accent;
            t.placeholder_color = theme.text_ghost;
            t.selection_color = crate::theme::mix(theme.accent, gpui::transparent_black(), 0.3);
            t
        })
    }

    fn on_key_down(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = e.keystroke.key.as_str();
        if self.pending_close.is_some() || self.pending_close_tab.is_some() {
            match key {
                "escape" => self.cancel_close(cx),
                "enter" => self.confirm_close(window, cx),
                _ => return,
            }
            cx.stop_propagation();
            return;
        }
        if self.editor_choice.is_some() || self.pane_menu.is_some() {
            if key == "escape" {
                self.editor_choice = None;
                self.pane_menu = None;
                cx.stop_propagation();
                cx.notify();
            }
            return;
        }
        // Space arms panning only while the canvas itself has the keyboard: in
        // a terminal it is a character being typed.
        if key == "space" && self.focus_handle.is_focused(window) {
            self.space_held = true;
        }
    }

    fn on_key_up(&mut self, e: &KeyUpEvent, _: &mut Window, _: &mut Context<Self>) {
        if e.keystroke.key == "space" {
            self.space_held = false;
        }
    }
}

// ── Rendering ──────────────────────────────────────────────────────────────

impl Workspace {
    fn render_pane(&self, pane: &Pane, theme: &Theme, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let rect = self.rect_of(pane);
        let o = self.canvas_bounds.origin;
        let local = (f32::from(rect.origin.x - o.x), f32::from(rect.origin.y - o.y));
        let zoom = self.zoom;
        let focused = self.selected.len() == 1 && self.selected[0] == pane.id;
        let selected = self.selected.contains(&pane.id);
        let pending = self.pending_close.as_ref().map(|ids| ids.contains(&pane.id)).unwrap_or(false);
        let is_browser = pane.kind.is_browser();
        let tab = pane.active_tab();
        let title = self.title_of(pane.kind, tab, cx);
        let accent = theme.accent;
        let border: Hsla = if pending {
            theme.danger
        } else if focused {
            crate::theme::mix(accent, gpui::transparent_black(), 0.69)
        } else if selected {
            crate::theme::mix(accent, gpui::transparent_black(), 0.55)
        } else {
            theme.pane_border
        };

        let (status_text, status_color, cwd_text): (Option<String>, Hsla, Option<String>) = match &tab.view {
            TabView::Terminal(v) => {
                let s = &v.read(cx).status;
                let st = if s.exited {
                    (Some("exited".to_string()), theme.text_ghost)
                } else if let Some(since) = s.running_since {
                    (Some(format_elapsed(since.elapsed().as_secs())), theme.text_dim)
                } else if let Some(code) = s.last_exit {
                    (Some(format!("exit {code}")), theme.danger)
                } else {
                    (None, theme.text_dim)
                };
                let cwd = s.cwd.as_ref().filter(|_| !s.exited).map(|c| short_path(c));
                (st.0, st.1, cwd)
            }
            TabView::Browser(_) => (None, theme.text_dim, None),
        };
        let loading = matches!(&tab.view, TabView::Browser(b) if b.read(cx).loading);

        let pane_id = pane.id.clone();
        let editing_title = self.title_edit.as_ref().filter(|e| e.pane == pane.id && e.tab == tab.id).map(|e| e.input.clone());
        let editing_command = self.command_edit.as_ref().filter(|e| e.pane == pane.id).map(|e| e.input.clone());

        // ── The title bar: the pane's only grip ────────────────────────────
        let mut titlebar = div()
            .id(SharedString::from(format!("titlebar-{}", pane.id)))
            .flex()
            .flex_none()
            .items_center()
            .gap(r(9.))
            .h(r(TITLEBAR_H))
            .pl(r(12.))
            .pr(r(8.))
            .bg(gpui::linear_gradient(180., gpui::linear_color_stop(theme.titlebar_top, 0.), gpui::linear_color_stop(theme.titlebar_bottom, 1.)))
            .border_b_1()
            .border_color(theme.titlebar_edge)
            .cursor_grab()
            .on_mouse_down(MouseButton::Left, {
                let id = pane_id.clone();
                cx.listener(move |this, e: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    this.select_pane(&id, e.modifiers.shift, cx);
                    if e.click_count == 2 {
                        this.begin_title_edit(&id, window, cx);
                        return;
                    }
                    this.begin_drag(&id, e.position);
                    this.focus_pane(&id, window, cx);
                })
            });
        if !is_browser {
            let id = pane_id.clone();
            titlebar = titlebar.on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, e: &MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    this.open_pane_menu(&id, e.position, window, cx);
                }),
            );
        }
        let mark = if is_browser {
            if loading {
                icon(Icon::Refresh, 13., theme.text_dim).into_any_element()
            } else {
                icon(Icon::Page, 13., if focused { theme.text_mid } else { theme.text_dim }).into_any_element()
            }
        } else {
            icon(Icon::Prompt, 11., accent).into_any_element()
        };
        titlebar = titlebar.child(div().flex_none().child(mark));
        titlebar = match editing_title {
            Some(input) => titlebar.child(
                div()
                    .flex()
                    .flex_1()
                    .max_w(r(320.))
                    .h(r(22.))
                    .items_center()
                    .px(r(6.))
                    .bg(theme.pane_screen)
                    .border_1()
                    .border_color(theme.border)
                    .text_size(r(12.))
                    .text_color(theme.text_strong)
                    .child(input),
            ),
            None => titlebar.child(
                div()
                    .flex_none()
                    .max_w(relative_width(0.72))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .text_size(r(12.))
                    .font_weight(gpui::FontWeight(550.))
                    .text_color(if focused { theme.text_strong } else { theme.text_mid })
                    .child(SharedString::from(title.clone())),
            ),
        };
        // The row's spring: what holds the status, the startup mark and the
        // close against the right edge, even when it has nothing to say.
        titlebar = titlebar.child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_size(r(11.))
                .text_color(if focused { theme.text_dim } else { theme.text_faint })
                .when_some(cwd_text, |d, c| d.child(SharedString::from(c))),
        );
        if let Some(st) = status_text {
            titlebar = titlebar.child(div().flex_none().text_size(r(11.)).text_color(status_color).child(SharedString::from(st)));
        }
        if !is_browser {
            let id = pane_id.clone();
            let set = tab.command.is_some();
            let color = if set || editing_command.is_some() { theme.accent } else { theme.text_faint };
            titlebar = titlebar.child(
                div()
                    .relative()
                    .flex_none()
                    .child(
                        super::glyph_button_tinted(SharedString::from(format!("cmd-{}", pane.id)), Icon::Startup, 20., color, theme)
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .on_click(cx.listener(move |this, _, window, cx| this.toggle_command_edit(&id, window, cx))),
                    )
                    .when_some(editing_command, |d, input| {
                        // Deferred, so it is drawn over the screen below the
                        // title bar instead of under it.
                        d.child(gpui::deferred(
                            div()
                                .id("command-panel")
                                .absolute()
                                .top(r(26.))
                                .right(r(-28.))
                                .w(r(320.))
                                .flex()
                                .flex_col()
                                .gap(r(6.))
                                .p(r(10.))
                                .bg(crate::theme::mix(theme.pane_frame, theme.bg_canvas, 0.88))
                                .border_1()
                                .border_color(theme.pane_border)
                                .shadow_lg()
                                .occlude()
                                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                .child(div().text_size(r(11.)).text_color(theme.text_dim).child("Runs when this tab opens."))
                                .child(
                                    div()
                                        .flex()
                                        .h(r(26.))
                                        .items_center()
                                        .px(r(8.))
                                        .bg(theme.pane_screen)
                                        .border_1()
                                        .border_color(theme.border)
                                        .font_family(crate::theme::mono_font())
                                        .text_size(r(12.))
                                        .text_color(theme.text_strong)
                                        .child(input),
                                ),
                        ))
                    }),
            );
        }
        {
            let id = pane_id.clone();
            titlebar = titlebar.child(
                glyph_button(SharedString::from(format!("close-{}", pane.id)), Icon::Close, 20., theme)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _, window, cx| this.request_close_panes(vec![id.clone()], window, cx))),
            );
        }

        // ── The tab strip, only once there is a choice to make ─────────────
        let strip = (pane.tabs.len() > 1).then(|| {
            let labels = self.strip_labels(pane, cx);
            let dragging = match &self.gesture {
                Some(Gesture::TabDrag { tab, moved: true, .. }) => Some(tab.clone()),
                _ => None,
            };
            let mut strip = div()
                .flex()
                .flex_none()
                .items_center()
                .h(r(TABS_H))
                .px(r(4.))
                .bg(theme.titlebar_bottom)
                .border_b_1()
                .border_color(theme.titlebar_edge)
                .overflow_hidden();
            for (i, (t, label)) in pane.tabs.iter().zip(labels).enumerate() {
                if i > 0 {
                    strip = strip.child(div().flex_none().w(px(1.)).h(r(12.)).my_auto().bg(theme.border_soft));
                }
                let on = t.id == pane.active_tab_id;
                let pending_tab = self.pending_close_tab.as_ref().map(|(p, tb)| *p == pane.id && *tb == t.id).unwrap_or(false);
                let exited = matches!(&t.view, TabView::Terminal(v) if v.read(cx).status.exited);
                let (pid, tid) = (pane.id.clone(), t.id.clone());
                let (pid2, tid2) = (pane.id.clone(), t.id.clone());
                let group: SharedString = format!("tab-{}", t.id).into();
                strip = strip.child(
                    div()
                        .id(SharedString::from(format!("tab-{}", t.id)))
                        .group(group.clone())
                        .flex()
                        .flex_1()
                        .min_w_0()
                        .max_w(r(220.))
                        .items_center()
                        .gap(r(5.))
                        .px(r(8.))
                        .text_size(r(11.))
                        .text_color(if pending_tab {
                            theme.danger_text
                        } else if on || dragging.as_deref() == Some(t.id.as_str()) {
                            theme.text_strong
                        } else {
                            theme.text_faint
                        })
                        .when(on, |d| d.bg(theme.pane_screen))
                        .when(pending_tab, |d| d.bg(crate::theme::mix(theme.danger, gpui::transparent_black(), 0.12)))
                        .hover(|s| s.text_color(theme.text_mid))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, e: &MouseDownEvent, window, cx| {
                                cx.stop_propagation();
                                this.select_pane(&pid, false, cx);
                                this.set_active_tab(&pid, &tid, window, cx);
                                this.gesture = Some(Gesture::TabDrag { pane: pid.clone(), tab: tid.clone(), start_x: e.position.x, moved: false });
                            }),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .when(exited, |d| d.text_color(theme.text_ghost))
                                .child(SharedString::from(label)),
                        )
                        .child(
                            div()
                                .invisible()
                                .when(on, |d| d.visible())
                                .group_hover(group, |s| s.visible())
                                .child(
                                    glyph_button(SharedString::from(format!("tab-close-{}", t.id)), Icon::Close, 19., theme)
                                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                        .on_click(cx.listener(move |this, _, window, cx| this.close_tab(&pid2, &tid2, window, cx))),
                                ),
                        ),
                );
            }
            let (pid, kind) = (pane.id.clone(), pane.kind);
            strip.child(
                div().flex().items_center().ml(r(4.)).child(
                    glyph_button(SharedString::from(format!("tab-add-{}", pane.id)), Icon::Plus, 19., theme)
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.selected = vec![pid.clone()];
                            this.add_pane(kind, window, cx);
                        })),
                ),
            )
        });

        // ── The screen: only the tab in front is drawn ─────────────────────
        let body: AnyElement = match &tab.view {
            TabView::Terminal(v) => {
                v.update(cx, |v, _| {
                    v.zoom = zoom;
                    v.visible = true;
                });
                v.clone().into_any_element()
            }
            TabView::Browser(b) => {
                let showable = self.page_showable(pane);
                b.update(cx, |b, _| {
                    b.canvas_zoom = zoom;
                    b.showable = showable;
                });
                b.clone().into_any_element()
            }
        };
        // Pages behind the one in front are put away.
        for t in pane.tabs.iter().filter(|t| t.id != tab.id) {
            if let TabView::Browser(b) = &t.view {
                b.update(cx, |b, _| b.hide());
            }
        }
        let _ = window;

        let content = div()
            .size_full()
            .flex()
            .flex_col()
            .font_family(crate::theme::ui_font())
            .child(titlebar)
            .children(strip)
            .child(div().flex().flex_1().min_h_0().overflow_hidden().child(body));

        let mut pane_el = div()
            .id(SharedString::from(format!("pane-{}", pane.id)))
            .absolute()
            .left(px(local.0))
            .top(px(local.1))
            .w(rect.size.width)
            .h(rect.size.height)
            .bg(theme.pane_frame)
            .border_1()
            .border_color(border)
            .shadow(vec![gpui::BoxShadow {
                color: theme.shadow,
                offset: point(px(0.), px(3. * zoom.min(1.0))),
                blur_radius: px(8. * zoom.min(1.0)),
                spread_radius: px(0.),
            }])
            .overflow_hidden()
            .block_mouse_except_scroll()
            .on_mouse_down(MouseButton::Left, {
                let id = pane_id.clone();
                cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                    this.select_pane(&id, e.modifiers.shift, cx);
                })
            })
            .child(with_rem(px(BASE_REM * zoom), content));

        if pending {
            pane_el = pane_el.child(div().absolute().inset_0().bg(crate::theme::mix(theme.danger, gpui::transparent_black(), 0.10)));
        }

        // Resize handles, in screen pixels whatever the zoom.
        let handles = [
            (Edge::N, gpui::CursorStyle::ResizeUpDown),
            (Edge::S, gpui::CursorStyle::ResizeUpDown),
            (Edge::E, gpui::CursorStyle::ResizeLeftRight),
            (Edge::W, gpui::CursorStyle::ResizeLeftRight),
            (Edge::NE, gpui::CursorStyle::ResizeUpRightDownLeft),
            (Edge::SW, gpui::CursorStyle::ResizeUpRightDownLeft),
            (Edge::NW, gpui::CursorStyle::ResizeUpLeftDownRight),
            (Edge::SE, gpui::CursorStyle::ResizeUpLeftDownRight),
        ];
        for (edge, cursor) in handles {
            let id = pane_id.clone();
            let h = px(HANDLE);
            let mut d = div().id(SharedString::from(format!("handle-{}-{:?}", pane.id, edge))).absolute().cursor(cursor);
            d = match edge {
                Edge::N => d.top_0().left(h).right(h).h(h),
                Edge::S => d.bottom_0().left(h).right(h).h(h),
                Edge::E => d.right_0().top(h).bottom(h).w(h),
                Edge::W => d.left_0().top(h).bottom(h).w(h),
                Edge::NE => d.top_0().right_0().size(h),
                Edge::NW => d.top_0().left_0().size(h),
                Edge::SE => d.bottom_0().right_0().size(h),
                Edge::SW => d.bottom_0().left_0().size(h),
            };
            pane_el = pane_el.child(d.on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    this.select_pane(&id, false, cx);
                    if let Some(p) = this.panes.iter().find(|p| p.id == id) {
                        this.gesture = Some(Gesture::Resize { pane: id.clone(), edge, start: e.position, rect: (p.x, p.y, p.width, p.height) });
                    }
                }),
            ));
        }
        pane_el.into_any_element()
    }

    /// A native page can be shown only when nothing should be over it: the
    /// workflow is in front, no question or menu stands over the canvas, no
    /// pane above overlaps it, and it sits wholly inside the canvas.
    fn page_showable(&self, pane: &Pane) -> bool {
        if !self.active || self.covered || self.gesture.is_some() || self.pane_menu.is_some() || self.editor_choice.is_some() {
            return false;
        }
        if self.pending_close.is_some() || self.pending_close_tab.is_some() {
            return false;
        }
        let r = self.rect_of(pane);
        let c = self.canvas_bounds;
        let inside = r.origin.x >= c.origin.x
            && r.origin.y >= c.origin.y
            && r.origin.x + r.size.width <= c.origin.x + c.size.width
            && r.origin.y + r.size.height <= c.origin.y + c.size.height;
        let minimap = Bounds::new(self.minimap_origin(), size(px(MAP_W + 2.), px(MAP_H + 2.)));
        let overlaps = |a: Bounds<Pixels>, b: Bounds<Pixels>| {
            a.origin.x < b.origin.x + b.size.width && a.origin.x + a.size.width > b.origin.x && a.origin.y < b.origin.y + b.size.height && a.origin.y + a.size.height > b.origin.y
        };
        let covered = self.panes.iter().any(|o| o.id != pane.id && o.z > pane.z && overlaps(self.rect_of(o), r));
        inside && !covered && !overlaps(r, minimap)
    }

    fn render_dock(&self, theme: &Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = (self.selected.len() == 1).then(|| self.selected[0].clone());
        let names = self.pane_names(cx);
        let mut list = div().id("dock-list").flex().items_center().gap(r(2.)).min_w_0().overflow_x_scroll();
        if names.is_empty() {
            list = list.child(div().text_size(r(11.5)).text_color(theme.text_ghost).child("no open panes"));
        }
        for (id, kind, name) in names {
            let on = focused.as_deref() == Some(id.as_str());
            let sel = self.selected.contains(&id);
            let group: SharedString = format!("dock-{id}").into();
            let (rid, cid) = (id.clone(), id.clone());
            let label_color = if on { theme.text_strong } else if sel { theme.text_mid } else { theme.text_faint };
            let mut entry = div()
                .id(SharedString::from(format!("dock-{id}")))
                .group(group.clone())
                .relative()
                .flex()
                .flex_none()
                .items_center()
                .h(r(24.))
                .max_w(r(250.))
                .hover(|s| s.bg(theme.hover_soft))
                .child(
                    div()
                        .id(SharedString::from(format!("dock-item-{id}")))
                        .flex()
                        .items_center()
                        .gap(r(7.))
                        .min_w_0()
                        .pl(r(10.))
                        .pr(r(4.))
                        .h_full()
                        .cursor_pointer()
                        .text_size(r(11.5))
                        .text_color(label_color)
                        .on_click(cx.listener(move |this, _, window, cx| this.reveal_pane(&rid, window, cx)))
                        .child(icon(if kind.is_browser() { Icon::Page } else { Icon::Prompt }, if kind.is_browser() { 12. } else { 11. }, if on { theme.accent } else { theme.text_faint }))
                        .child(
                            div()
                                .flex()
                                .min_w_0()
                                .gap(r(5.))
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .child(div().flex_none().child(SharedString::from(name.folder.clone())))
                                .when_some(name.branch.clone(), |d, b| {
                                    d.child(div().flex_none().text_color(theme.text_ghost).child("->"))
                                        .child(div().min_w_0().overflow_hidden().text_ellipsis().text_color(theme.text_faint).child(SharedString::from(b)))
                                }),
                        ),
                )
                .child(
                    div().invisible().group_hover(group, |s| s.visible()).child(
                        glyph_button(SharedString::from(format!("dock-close-{id}")), Icon::Close, 20., theme)
                            .on_click(cx.listener(move |this, _, window, cx| this.request_close_panes(vec![cid.clone()], window, cx))),
                    ),
                );
            if on {
                entry = entry.children(brackets(theme.accent, 5.0, 1.0));
            }
            list = list.child(entry);
        }
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(r(10.))
            .h(r(34.))
            .px(r(10.))
            .bg(theme.bg_toolbar)
            .border_t_1()
            .border_color(theme.titlebar_edge)
            .font_family(crate::theme::ui_font())
            .child(list)
            .child(div().flex_1())
            .when(self.selected.len() > 1, |d| {
                d.child(div().text_size(r(11.)).text_color(theme.text_dim).child(SharedString::from(format!("{} selected", self.selected.len()))))
            })
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(1.))
                    .child(glyph_button("zoom-out", Icon::Minus, 22., theme).on_click(cx.listener(|this, _, _, cx| this.zoom_out(cx))))
                    .child(
                        div()
                            .id("zoom-value")
                            .min_w(r(42.))
                            .flex()
                            .justify_center()
                            .cursor_pointer()
                            .text_size(r(11.))
                            .text_color(theme.text_dim)
                            .hover(|s| s.text_color(theme.text_strong))
                            .on_click(cx.listener(|this, _, _, cx| this.zoom_reset(cx)))
                            .child(SharedString::from(format!("{}%", (self.zoom * 100.0).round()))),
                    )
                    .child(glyph_button("zoom-in", Icon::Plus, 22., theme).on_click(cx.listener(|this, _, _, cx| this.zoom_in(cx)))),
            )
    }

    fn render_minimap(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.panes.is_empty() {
            return None;
        }
        // While a drag is in progress the projection is held still, or the
        // point under the cursor would slide away as you dragged toward it.
        let proj = match &self.gesture {
            Some(Gesture::Minimap { proj }) => *proj,
            _ => self.projection(),
        };
        let (cw, ch) = self.canvas_size();
        let view = (-self.pan.0 / self.zoom, -self.pan.1 / self.zoom, cw / self.zoom, ch / self.zoom);
        let rects: Vec<((f32, f32, f32, f32), bool)> = self
            .panes
            .iter()
            .map(|p| ((p.x * proj.s + proj.ox, p.y * proj.s + proj.oy, (p.width * proj.s).max(2.0), (p.height * proj.s).max(2.0)), self.selected.contains(&p.id)))
            .collect();
        let view_rect = (view.0 * proj.s + proj.ox, view.1 * proj.s + proj.oy, (view.2 * proj.s).max(3.0), (view.3 * proj.s).max(3.0));
        let (canvas_bg, pane_c, pane_on, view_c) = (theme.bg_canvas, theme.text_ghost, theme.accent, theme.text_dim);
        Some(
            div()
                .id("minimap")
                .absolute()
                .right(px(12.))
                .bottom(px(12.))
                .w(px(MAP_W + 2.))
                .h(px(MAP_H + 2.))
                .bg(theme.pane_frame)
                .border_1()
                .border_color(theme.pane_border)
                .occlude()
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, e: &MouseDownEvent, _, cx| {
                        cx.stop_propagation();
                        this.cancel_reveal();
                        let proj = this.projection();
                        this.gesture = Some(Gesture::Minimap { proj });
                        this.minimap_navigate(e.position, proj, cx);
                    }),
                )
                .child(
                    canvas(
                        |_, _, _| {},
                        move |bounds, _, window, _| {
                            window.paint_quad(fill(bounds, canvas_bg));
                            window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
                                let at = |x: f32, y: f32, w: f32, h: f32| Bounds::new(point(bounds.origin.x + px(x), bounds.origin.y + px(y)), size(px(w), px(h)));
                                for ((x, y, w, h), on) in &rects {
                                    let mut c = if *on { pane_on } else { pane_c };
                                    c.a *= 0.75;
                                    window.paint_quad(fill(at(*x, *y, *w, *h), c));
                                }
                                let (x, y, w, h) = view_rect;
                                window.paint_quad(gpui::outline(at(x, y, w, h), view_c, gpui::BorderStyle::Solid));
                            });
                        },
                    )
                    .size_full(),
                )
                .into_any_element(),
        )
    }

    fn render_confirm(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.pending_close.is_none() && self.pending_close_tab.is_none() {
            return None;
        }
        let tab = self.pending_close_tab.is_some();
        let count = self.pending_close.as_ref().map(|v| v.len()).unwrap_or(1);
        let (title, detail) = if tab {
            ("tab will close", "a command is running in it")
        } else if count == 1 {
            ("pane will close", "commands are running in them")
        } else {
            ("panes will close", "commands are running in them")
        };
        Some(confirm_rail(
            theme,
            Some(count.to_string()),
            title.to_string(),
            div().child(detail),
            vec![
                rail_button("confirm-cancel", "Cancel", Shortcut::Cancel, false, theme).on_click(cx.listener(|this, _, _, cx| this.cancel_close(cx))).into_any_element(),
                rail_button("confirm-accept", "Close", Shortcut::Confirm, true, theme).on_click(cx.listener(|this, _, window, cx| this.confirm_close(window, cx))).into_any_element(),
            ],
        ))
    }

    fn render_editor_choice(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (dir, editors) = self.editor_choice.as_ref()?;
        let mut options = div().flex().items_center().gap(r(4.));
        for e in editors {
            let app = e.app.clone();
            let current = self.editor_pref.as_deref() == Some(e.app.as_str());
            options = options.child(
                div()
                    .id(SharedString::from(format!("editor-{}", e.app)))
                    .px(r(9.))
                    .h(r(24.))
                    .flex()
                    .items_center()
                    .border_1()
                    .border_color(if current { theme.accent } else { theme.border })
                    .text_size(r(12.))
                    .text_color(if current { theme.text_strong } else { theme.text_mid })
                    .cursor_pointer()
                    .hover(|s| s.bg(theme.hover).text_color(theme.text_strong))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some((dir, _)) = this.editor_choice.take() {
                            this.use_editor(app.clone(), &dir, cx);
                        }
                        cx.notify();
                    }))
                    .child(SharedString::from(e.label.clone())),
            );
        }
        options = options.child(
            div()
                .id("editor-other")
                .px(r(9.))
                .h(r(24.))
                .flex()
                .items_center()
                .text_size(r(12.))
                .text_color(theme.text_dim)
                .cursor_pointer()
                .hover(|s| s.text_color(theme.text_strong))
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some((dir, _)) = this.editor_choice.take() {
                        this.pick_application(dir, cx);
                    }
                    cx.notify();
                }))
                .child("Other…"),
        );
        Some(confirm_rail(
            theme,
            None,
            "Open in".into(),
            div().font_family(crate::theme::mono_font()).child(SharedString::from(shorten_dir(dir))),
            vec![
                options.into_any_element(),
                rail_button("editor-cancel", "Cancel", Shortcut::Cancel, false, theme)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.editor_choice = None;
                        cx.notify();
                    }))
                    .into_any_element(),
            ],
        ))
    }

    fn render_pane_menu(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (dir, editors, x, y) = self.pane_menu.as_ref()?;
        let (cw, ch) = self.canvas_size();
        let item_h = 26.0;
        let height = 30.0 + item_h * (editors.len() as f32 + 1.0) + 9.0;
        let width = 230.0;
        // Nudged back inside the canvas: right-clicking near an edge is the
        // ordinary case, not the exotic one.
        let left = (*x).min(cw - width - 8.0).max(4.0);
        let top = (*y).min(ch - height - 8.0).max(4.0);
        let mut menu = div()
            .id("pane-menu")
            .absolute()
            .left(px(left))
            .top(px(top))
            .w(px(width))
            .py(px(4.))
            .flex()
            .flex_col()
            .bg(theme.pane_frame)
            .border_1()
            .border_color(theme.pane_border)
            .shadow_lg()
            .occlude()
            .font_family(crate::theme::ui_font())
            .child(div().px(px(10.)).h(px(26.)).flex().items_center().text_size(px(11.)).text_color(theme.text_faint).child("Open folder in"));
        for e in editors {
            let current = self.editor_pref.as_deref() == Some(e.app.as_str());
            let app = e.app.clone();
            menu = menu.child(
                div()
                    .id(SharedString::from(format!("menu-{}", e.app)))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .px(px(10.))
                    .h(px(item_h))
                    .text_size(px(12.5))
                    .text_color(theme.text)
                    .cursor_pointer()
                    .hover(|s| s.bg(theme.hover))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some((dir, ..)) = this.pane_menu.take() {
                            this.use_editor(app.clone(), &dir, cx);
                        }
                        cx.notify();
                    }))
                    .child(div().w(px(14.)).when(current, |d| d.child(icon(Icon::Tick, 11., theme.accent))))
                    .child(div().flex_1().child(SharedString::from(e.label.clone())))
                    .when(current, |d| d.child(kbd(Shortcut::OpenInEditor, theme))),
            );
        }
        let dir = dir.clone();
        menu = menu.child(div().h(px(1.)).my(px(4.)).bg(theme.border_soft)).child(
            div()
                .id("menu-other")
                .flex()
                .items_center()
                .gap(px(6.))
                .px(px(10.))
                .h(px(item_h))
                .text_size(px(12.5))
                .text_color(theme.text_dim)
                .cursor_pointer()
                .hover(|s| s.bg(theme.hover))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.pane_menu = None;
                    this.pick_application(dir.clone(), cx);
                    cx.notify();
                }))
                .child(div().w(px(14.)))
                .child("Other application…"),
        );
        Some(menu.into_any_element())
    }

    fn render_empty_hint(&self, theme: &Theme) -> impl IntoElement {
        let row = |label: &'static str, rest: gpui::Div| {
            div()
                .flex()
                .gap(px(16.))
                .child(div().w(px(56.)).text_size(px(11.5)).text_color(theme.text_faint).child(label))
                .child(rest.flex().items_center().gap(px(5.)).flex_wrap().text_color(theme.text_ghost))
        };
        div()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .max_w(px(420.))
                    .flex()
                    .flex_col()
                    .gap(px(7.))
                    .text_size(px(12.5))
                    .text_color(theme.text_ghost)
                    .font_family(crate::theme::ui_font())
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .mb(px(11.))
                            .text_size(px(13.))
                            .text_color(theme.text_dim)
                            .child("Empty workspace. Press")
                            .child(kbd(Shortcut::NewTerminal, theme))
                            .child("to open the first terminal."),
                    )
                    .child(row("Pan", div().child("two-finger scroll, or drag with").child(kbd(Shortcut::Space, theme)).child("held")))
                    .child(row(
                        "Zoom",
                        div()
                            .child("hold")
                            .child(kbd(Shortcut::Command, theme))
                            .child("and scroll;")
                            .child(kbd(Shortcut::ZoomReset, theme))
                            .child("for actual size,")
                            .child(kbd(Shortcut::ZoomFit, theme))
                            .child("to fit everything"),
                    ))
                    .child(row("Select", div().child("drag across empty canvas")))
                    .child(row("Move", div().child("drag a pane by its title bar"))),
            )
    }
}

fn relative_width(f: f32) -> gpui::DefiniteLength {
    gpui::relative(f)
}

/// Four corner brackets, the kind that sit around a printing plate: around
/// the pane you have just flown to, and around the name of the pane you are
/// in down on the dock. Brackets rather than a box: four corners read as an
/// instrument aiming at something.
pub fn brackets(color: Hsla, arm: f32, weight: f32) -> Vec<AnyElement> {
    let (a, t) = (px(arm), px(weight));
    let corner = |top: bool, left: bool| {
        let mut d = div().absolute().size(a);
        d = if top { d.top_0() } else { d.bottom_0() };
        d = if left { d.left_0() } else { d.right_0() };
        d.child(div().absolute().w(a).h(t).bg(color).when(top, |d| d.top_0()).when(!top, |d| d.bottom_0()))
            .child(div().absolute().w(t).h(a).bg(color).when(left, |d| d.left_0()).when(!left, |d| d.right_0()))
            .into_any_element()
    };
    vec![corner(true, true), corner(true, false), corner(false, true), corner(false, false)]
}

/// Not a dialog over a dimmed page: the things a question is about stay in
/// view, and only the question and its answers sit on a rail along the
/// bottom.
pub fn confirm_rail(theme: &Theme, count: Option<String>, title: String, detail: gpui::Div, actions: Vec<AnyElement>) -> AnyElement {
    div()
        .absolute()
        .bottom(px(28.))
        .left_0()
        .right_0()
        .flex()
        .justify_center()
        .child(
            div()
                .id("confirm-rail")
                .flex()
                .items_center()
                .gap(px(16.))
                .py(px(10.))
                .pl(px(14.))
                .pr(px(10.))
                .bg(theme.titlebar_top)
                .border_1()
                .border_color(theme.border)
                .shadow_lg()
                .occlude()
                .font_family(crate::theme::ui_font())
                .when_some(count, |d, c| {
                    d.child(
                        div()
                            .pr(px(14.))
                            .border_r_1()
                            .border_color(theme.border_soft)
                            .font_family(crate::theme::mono_font())
                            .text_size(px(15.))
                            .text_color(theme.danger)
                            .child(SharedString::from(c)),
                    )
                })
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(div().text_size(px(12.5)).font_weight(gpui::FontWeight::SEMIBOLD).text_color(theme.text_strong).child(SharedString::from(title)))
                        .child(detail.text_size(px(11.5)).text_color(theme.text_dim)),
                )
                .child(div().flex().items_center().gap(px(6.)).children(actions)),
        )
        .into_any_element()
}

pub fn rail_button(id: &'static str, label: &'static str, key: Shortcut, primary: bool, theme: &Theme) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(px(7.))
        .h(px(28.))
        .px(px(10.))
        .text_size(px(12.))
        .cursor_pointer()
        .when(primary, |d| d.bg(theme.danger).text_color(theme.pane_frame).hover(|s| s.opacity(0.9)))
        .when(!primary, |d| d.text_color(theme.text_mid).hover(|s| s.bg(theme.hover).text_color(theme.text_strong)))
        .child(label)
        .child(if primary {
            kbd(key, theme).text_size(px(10.5)).text_color(theme.pane_frame).border_color(gpui::hsla(0., 0., 1., 0.35)).bg(gpui::hsla(0., 0., 1., 0.12))
        } else {
            kbd(key, theme).text_size(px(10.5))
        })
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<Theme>().clone();
        let (zoom, pan) = self.view_now(window);
        let entity = cx.entity();

        let mut order: Vec<usize> = (0..self.panes.len()).collect();
        order.sort_by(|a, b| self.panes[*a].z.partial_cmp(&self.panes[*b].z).unwrap_or(std::cmp::Ordering::Equal));
        let panes: Vec<AnyElement> = order.iter().map(|&i| self.render_pane(&self.panes[i], &theme, window, cx)).collect();

        let marquee = match &self.gesture {
            Some(Gesture::Marquee { start, current, .. }) => {
                let (x0, y0) = (start.0.min(current.0), start.1.min(current.1));
                let (x1, y1) = (start.0.max(current.0), start.1.max(current.1));
                let c = theme.selection;
                let mut bg = c;
                bg.a = 0.12;
                Some(
                    div()
                        .absolute()
                        .left(px(pan.0 + x0 * zoom))
                        .top(px(pan.1 + y0 * zoom))
                        .w(px((x1 - x0) * zoom))
                        .h(px((y1 - y0) * zoom))
                        .border_1()
                        .border_color(c)
                        .bg(bg),
                )
            }
            _ => None,
        };

        // The arrival marks: they fly in from outside the pane and snap tight
        // around it as the view lands, then let go. Quoted in screen pixels,
        // so they are the same size whatever the zoom.
        let reveal = self.reveal.as_ref().and_then(|rv| {
            let ms = rv.started.elapsed().as_secs_f32() * 1000.0;
            if ms > REVEAL_MARK_MS {
                return None;
            }
            window.request_animation_frame();
            let fly = (ms / REVEAL_MS).min(1.0);
            let run = 16.0 * (1.0 - ease_out_back(fly));
            let alpha = if ms < REVEAL_MS + 200.0 { 1.0 } else { 1.0 - (ms - REVEAL_MS - 200.0) / 300.0 };
            let pad = 7.0 + run;
            let (x, y, w, h) = rv.rect;
            let mut c = theme.accent;
            c.a = alpha.clamp(0.0, 1.0);
            Some(
                div()
                    .absolute()
                    .left(px(pan.0 + x * zoom - pad))
                    .top(px(pan.1 + y * zoom - pad))
                    .w(px(w * zoom + pad * 2.0))
                    .h(px(h * zoom + pad * 2.0))
                    .children(brackets(c, 22.0, 1.6)),
            )
        });

        // The dot field is drawn on the viewport and repeats forever, so the
        // canvas never runs out. At a pitch too fine to see it thins to every
        // n-th dot rather than turning into a haze.
        let dot = theme.dot;
        let dots = canvas(
            move |bounds, _, cx| {
                entity.update(cx, |this, cx| {
                    let first = this.canvas_bounds.size.width == px(0.);
                    this.canvas_bounds = bounds;
                    if !this.centered && bounds.size.width > px(0.) {
                        this.centered = true;
                        this.pan = (f32::from(bounds.size.width) / 2.0, f32::from(bounds.size.height) / 2.0);
                        cx.notify();
                    } else if first {
                        cx.notify();
                    }
                });
            },
            move |bounds, _, window, _| {
                let mut pitch = DOT_SPACING * zoom;
                while pitch < 9.0 {
                    pitch *= 2.0;
                }
                let r_ = (zoom.clamp(0.6, 1.4)).max(0.8);
                let (w, h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
                let ox = pan.0.rem_euclid(pitch);
                let oy = pan.1.rem_euclid(pitch);
                let mut y = oy;
                while y < h {
                    let mut x = ox;
                    while x < w {
                        window.paint_quad(fill(Bounds::new(point(bounds.origin.x + px(x), bounds.origin.y + px(y)), size(px(r_), px(r_))), dot));
                        x += pitch;
                    }
                    y += pitch;
                }
            },
        )
        .absolute()
        .inset_0();

        // While a gesture runs, its moves and its release are heard wherever
        // the pointer goes — over a pane, a page, or out of the canvas.
        // Registered every frame, not only while a gesture runs: a quick
        // click releases before the next frame is drawn, and a release that
        // finds no listener would leave the gesture stuck.
        let tracker = Some(()).map(|_| {
            let weak = cx.entity().downgrade();
            canvas(
                |_, _, _| {},
                move |_, _, window, _| {
                    let w1 = weak.clone();
                    window.on_mouse_event(move |e: &MouseMoveEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            let _ = w1.update(cx, |this, cx| this.on_global_move(e, cx));
                        }
                    });
                    let w2 = weak.clone();
                    window.on_mouse_event(move |e: &MouseUpEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            let _ = w2.update(cx, |this, cx| this.on_global_up(e, cx));
                        }
                    });
                },
            )
            .absolute()
            .inset_0()
        });

        let empty = (self.panes.is_empty() && !self.hide_empty_hint).then(|| self.render_empty_hint(&theme));
        let minimap = self.render_minimap(&theme, cx);
        let confirm = self.render_confirm(&theme, cx);
        let editor = self.render_editor_choice(&theme, cx);
        let menu = self.render_pane_menu(&theme, cx);
        let dock = self.render_dock(&theme, cx);
        let cursor = match (&self.gesture, self.space_held) {
            (Some(Gesture::Pan { .. }), _) => gpui::CursorStyle::ClosedHand,
            (Some(Gesture::Drag { .. }), _) => gpui::CursorStyle::ClosedHand,
            (None, true) => gpui::CursorStyle::OpenHand,
            _ => gpui::CursorStyle::Arrow,
        };

        div()
            .id(SharedString::from(format!("workspace-{}", self.id)))
            .key_context("Workspace")
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_key_up(cx.listener(Self::on_key_up))
            .size_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .id("canvas")
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .bg(theme.bg_canvas)
                    .cursor(cursor)
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::on_canvas_mouse_down))
                    .on_mouse_down(MouseButton::Middle, cx.listener(Self::on_canvas_mouse_down))
                    .on_scroll_wheel(cx.listener(Self::on_scroll))
                    .child(dots)
                    .children(panes)
                    .children(reveal)
                    .children(marquee)
                    .children(minimap)
                    .children(empty)
                    .children(confirm)
                    .children(editor)
                    .children(menu)
                    .children(tracker),
            )
            .child(dock)
    }
}
