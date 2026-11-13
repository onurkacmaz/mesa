//! The window: the workflow strip along the top, and every workflow's canvas
//! below it, only the active one drawn.
//!
//! The strip is the title bar: the app's identity, then the workflows
//! themselves, sitting in the window's own drag region beside the traffic
//! lights.

use std::{cell::RefCell, collections::HashMap, rc::Rc, time::{Duration, Instant}};

use gpui::{
    actions, canvas, div, prelude::*, px, Action, App, Bounds, Context, DispatchPhase, Entity, FocusHandle,
    Focusable, KeyBinding, KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels,
    SharedString, Subscription, Task, Window, WindowAppearance,
};

use mesa_core::{
    flags::{normalize_flags, Flags, ThemeMode},
    rail_reorder::{clamp_offset, drop_index, gap_between, reorder, slide_for, Slot},
    session::{counter_seeds_from, parse_session, PaneKind, Session, Workflow, SESSION_VERSION},
};

use super::{
    glyph_button, icon,
    onboarding::{Onboarding, OnboardingEvent},
    text_input::{InputEvent, TextInput},
    workspace::{confirm_rail, rail_button, Workspace, WorkspaceEvent},
    Icon, Shortcut,
};
use crate::{
    ids, storage,
    theme::{Appearance, Theme},
};

actions!(
    mesa,
    [
        NewTerminal,
        NewBrowser,
        NewWorkflow,
        CloseSelection,
        OpenInEditor,
        ChooseEditor,
        ZoomIn,
        ZoomOut,
        ZoomReset,
        ZoomFit,
        FocusOmnibox,
        Quit,
        ToggleFullScreen,
        Minimize
    ]
);

/// ⌘1–9: the sessions inside the selected window, the way they do in every
/// tabbed thing.
#[derive(Clone, PartialEq, Debug, gpui::Action)]
#[action(namespace = mesa, no_json)]
pub struct SwitchTab(pub usize);

/// ⌥⌘1–9: the workflow rail, a level up. Not ⌃1–9: macOS gives those to
/// Mission Control's desktops.
#[derive(Clone, PartialEq, Debug, gpui::Action)]
#[action(namespace = mesa, no_json)]
pub struct SwitchWorkflow(pub usize);

pub fn bind_keys(cx: &mut App) {
    // On a Mac the app's keys are ⌘ keys. Elsewhere ⌃ belongs to the shell
    // (⌃C, ⌃W, ⌃N all mean something there), so the app takes ⌃⇧ instead,
    // as Linux terminals do.
    let m = if cfg!(target_os = "macos") { "cmd" } else { "ctrl-shift" };
    let mut bindings = vec![
        KeyBinding::new(&format!("{m}-n"), NewTerminal, None),
        KeyBinding::new(&format!("{m}-b"), NewBrowser, None),
        KeyBinding::new(&format!("{m}-t"), NewWorkflow, None),
        KeyBinding::new(&format!("{m}-w"), CloseSelection, None),
        KeyBinding::new(&format!("{m}-e"), OpenInEditor, None),
        KeyBinding::new(&format!("{m}-l"), FocusOmnibox, None),
        KeyBinding::new(&format!("{m}-="), ZoomIn, None),
        KeyBinding::new(&format!("{m}-+"), ZoomIn, None),
        KeyBinding::new(&format!("{m}--"), ZoomOut, None),
        KeyBinding::new(&format!("{m}-0"), ZoomReset, None),
    ];
    if cfg!(target_os = "macos") {
        bindings.extend([
            KeyBinding::new("shift-cmd-e", ChooseEditor, None),
            KeyBinding::new("shift-cmd-0", ZoomFit, None),
            KeyBinding::new("cmd-)", ZoomFit, None),
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("ctrl-cmd-f", ToggleFullScreen, None),
            KeyBinding::new("cmd-m", Minimize, None),
        ]);
    } else {
        // X11 reports ⇧ with a symbol key as the symbol itself and drops the
        // shift (⌃⇧- arrives as ⌃_), so the shifted forms are bound too.
        bindings.extend([
            KeyBinding::new("ctrl-_", ZoomOut, None),
            KeyBinding::new("ctrl-)", ZoomReset, None),
            KeyBinding::new("ctrl-alt-)", ZoomFit, None),
            KeyBinding::new("ctrl-shift-alt-e", ChooseEditor, None),
            KeyBinding::new("ctrl-shift-alt-0", ZoomFit, None),
            KeyBinding::new("ctrl-shift-q", Quit, None),
            KeyBinding::new("f11", ToggleFullScreen, None),
        ]);
    }
    cx.bind_keys(bindings);
    if !cfg!(target_os = "macos") {
        for (n, sym) in ["!", "@", "#", "$", "%", "^", "&", "*", "("].iter().enumerate() {
            cx.bind_keys([KeyBinding::new(&format!("ctrl-{sym}"), SwitchTab(n + 1), None)]);
        }
    }
    for n in 1..=9usize {
        let tab = if cfg!(target_os = "macos") { format!("cmd-{n}") } else { format!("ctrl-shift-{n}") };
        let wf = if cfg!(target_os = "macos") { format!("alt-cmd-{n}") } else { format!("alt-{n}") };
        cx.bind_keys([KeyBinding::new(&tab, SwitchTab(n), None), KeyBinding::new(&wf, SwitchWorkflow(n), None)]);
    }
}

/// How long the app waits after the last change before writing the session.
/// Panes are dragged and the canvas panned continuously, so the file is
/// written once the hand comes off, never during the movement itself.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(800);
/// How far the pointer travels before a press on a name becomes a drag.
const DRAG_THRESHOLD: f32 = 4.0;
/// A drop is followed by the press that ends it, and the press after that
/// would otherwise arrive as a double click and open the rename field.
const DRAG_SETTLE: Duration = Duration::from_millis(500);

struct WorkflowEntry {
    id: String,
    name: String,
    workspace: Entity<Workspace>,
    _sub: Subscription,
}

struct RailDrag {
    from: usize,
    to: usize,
    start_x: Pixels,
    dx: f32,
    rects: Vec<Slot>,
    distance: f32,
    moved: bool,
}

pub struct MesaApp {
    workflows: Vec<WorkflowEntry>,
    active: String,
    renaming: Option<(String, Entity<TextInput>, Subscription)>,
    rail_drag: Option<RailDrag>,
    dropped_at: Option<Instant>,
    /// The workflow a question stands about, and how much was running when
    /// it was asked — snapshotted, so the number is the one asked about.
    pending_close: Option<(String, usize)>,
    onboarding: Option<(Entity<Onboarding>, Subscription)>,
    flags: Flags,
    appearance: Appearance,
    focus_handle: FocusHandle,
    save_task: Option<Task<()>>,
    /// Until the last session has been read there is nothing worth saying,
    /// and saying it anyway would overwrite the file being read.
    ready: bool,
    slots: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    _subs: Vec<Subscription>,
}

/// A session that has never held anything: no file at all, or one whose
/// workflows are every one of them an empty canvas.
fn is_untouched(restored: &Option<Session>) -> bool {
    restored.as_ref().map(|s| s.workflows.iter().all(|w| w.panes.is_empty())).unwrap_or(true)
}

fn appearance_of(mode: ThemeMode, window: &Window) -> Appearance {
    match mode {
        ThemeMode::Light => Appearance::Light,
        ThemeMode::Dark => Appearance::Dark,
        ThemeMode::Auto => match window.appearance() {
            WindowAppearance::Light | WindowAppearance::VibrantLight => Appearance::Light,
            _ => Appearance::Dark,
        },
    }
}

impl MesaApp {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        // A session that cannot be read is a lost layout, never a lost app.
        let text = storage::read_session();
        let restored = match text.as_deref().map(parse_session) {
            Some(Ok(Some(session))) => Some(session),
            Some(_) => {
                // Text that came back but adds up to nothing this build can
                // open: the app carries on empty, and the file is put beyond
                // the reach of the first save — it is the only copy.
                log::error!("session file unreadable, set aside as session.json.bak");
                storage::archive_session();
                None
            }
            None => None,
        };
        let flags = storage::read_flags().map(|t| mesa_core::flags::parse_flags(&t)).unwrap_or_default();
        let appearance = appearance_of(flags.theme, window);
        cx.set_global(Theme::for_appearance(appearance));

        let mut this = MesaApp {
            workflows: Vec::new(),
            active: String::new(),
            renaming: None,
            rail_drag: None,
            dropped_at: None,
            pending_close: None,
            onboarding: None,
            flags: flags.clone(),
            appearance,
            focus_handle: cx.focus_handle(),
            save_task: None,
            ready: false,
            slots: Default::default(),
            _subs: Vec::new(),
        };

        // In front of an empty canvas only: someone with a workspace to come
        // back to is not owed an introduction.
        if !flags.seen_onboarding && is_untouched(&restored) {
            this.show_onboarding(window, cx);
        }

        match restored {
            Some(session) => {
                // Before any workflow is built: one built first would ask for
                // an id from a counter still sitting at zero.
                let seeds = counter_seeds_from(&session);
                ids::seed(seeds.pane, seeds.session, seeds.workflow);
                let active = session.active_workflow_id.clone();
                for wf in session.workflows {
                    this.push_workflow(wf.id.clone(), wf.name.clone(), Some(wf), window, cx);
                }
                this.active = active;
            }
            None => {
                let n = ids::next_workflow();
                let id = format!("wf-{n}");
                this.push_workflow(id.clone(), format!("Workflow {n}"), None, window, cx);
                this.active = id;
            }
        }
        this.sync_active(window, cx);

        this._subs.push(cx.observe_window_appearance(window, |this, window, cx| {
            if this.flags.theme == ThemeMode::Auto {
                this.set_appearance(appearance_of(ThemeMode::Auto, window), cx);
            }
        }));
        // The way out. A debounced write may still be pending, so the last
        // write is made synchronously before the app goes.
        this._subs.push(cx.on_app_quit(|this, cx| {
            this.flush(cx);
            for w in &this.workflows {
                w.workspace.read(cx).shutdown(cx);
            }
            async {}
        }));
        window.on_window_should_close(cx, |_, cx| {
            cx.quit();
            true
        });
        this.ready = true;
        this
    }

    fn push_workflow(&mut self, id: String, name: String, saved: Option<Workflow>, window: &mut Window, cx: &mut Context<Self>) {
        let wid = id.clone();
        let workspace = cx.new(|cx| Workspace::new(wid, saved, window, cx));
        let wid = id.clone();
        let sub = cx.subscribe_in(&workspace, window, move |this, _, e: &WorkspaceEvent, window, cx| match e {
            WorkspaceEvent::Dirty => this.schedule_save(cx),
            WorkspaceEvent::RequestCloseWorkflow => this.request_close_workflow(Some(wid.clone()), window, cx),
            WorkspaceEvent::EditorChosen(app) => {
                let app = app.clone();
                this.patch_flags(cx, |f| f.editor = Some(app));
            }
        });
        let pref = self.flags.editor.clone();
        workspace.update(cx, |w, _| w.editor_pref = pref);
        self.workflows.push(WorkflowEntry { id, name, workspace, _sub: sub });
    }

    fn active_workspace(&self) -> Option<Entity<Workspace>> {
        self.workflows.iter().find(|w| w.id == self.active).map(|w| w.workspace.clone())
    }

    /// Tells every workspace whether it is the one in front, and what is
    /// over it — a native page must never float over another workflow, the
    /// onboarding, or a question.
    fn sync_active(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let covered = self.onboarding.is_some() || self.pending_close.is_some() || self.renaming.is_some();
        let onboarding = self.onboarding.is_some();
        for w in &self.workflows {
            let active = w.id == self.active;
            w.workspace.update(cx, |ws, cx| {
                ws.active = active;
                ws.covered = covered;
                ws.hide_empty_hint = onboarding;
                if !active {
                    ws.hide_pages(cx);
                }
                cx.notify();
            });
        }
        let _ = window;
        cx.notify();
    }

    fn set_active(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.active == id {
            return;
        }
        self.active = id;
        self.sync_active(window, cx);
        if let Some(ws) = self.active_workspace() {
            window.focus(&ws.focus_handle(cx));
        }
        self.schedule_save(cx);
    }

    fn set_appearance(&mut self, appearance: Appearance, cx: &mut Context<Self>) {
        if appearance == self.appearance {
            return;
        }
        self.appearance = appearance;
        let theme = Theme::for_appearance(appearance);
        cx.set_global(theme.clone());
        for w in &self.workflows {
            w.workspace.update(cx, |ws, cx| ws.apply_theme(&theme, cx));
        }
        cx.refresh_windows();
    }

    fn set_theme_mode(&mut self, mode: ThemeMode, window: &mut Window, cx: &mut Context<Self>) {
        self.patch_flags(cx, |f| f.theme = mode);
        self.set_appearance(appearance_of(mode, window), cx);
        cx.notify();
    }

    /// One field at a time, but always the whole file on the way out: the
    /// write replaces what is on disk, so writing one field alone would drop
    /// the others.
    fn patch_flags(&mut self, cx: &mut Context<Self>, patch: impl FnOnce(&mut Flags)) {
        let mut next = self.flags.clone();
        patch(&mut next);
        let next = normalize_flags(&serde_json::to_value(&next).unwrap_or_default());
        self.flags = next.clone();
        for w in &self.workflows {
            let pref = next.editor.clone();
            w.workspace.update(cx, |ws, _| ws.editor_pref = pref);
        }
        let text = serde_json::to_string(&next).unwrap_or_default();
        cx.background_executor().spawn(async move { storage::write_flags(&text) }).detach();
    }

    // ── Saving ─────────────────────────────────────────────────────────────

    /// The whole app as one string. Every workflow is asked for its own half:
    /// the only place that knows what is on a canvas is the canvas.
    fn snapshot(&self, cx: &App) -> String {
        let (pane, session, workflow) = ids::counters();
        let session = Session {
            version: SESSION_VERSION,
            active_workflow_id: self.active.clone(),
            counters: serde_json::json!({ "pane": pane, "session": session, "workflow": workflow }).as_object().cloned().unwrap_or_default(),
            workflows: self.workflows.iter().map(|w| w.workspace.read(cx).serialize(&w.name, cx)).collect(),
        };
        serde_json::to_string(&session).unwrap_or_default()
    }

    fn schedule_save(&mut self, cx: &mut Context<Self>) {
        if !self.ready {
            return;
        }
        self.save_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SAVE_DEBOUNCE).await;
            // The task's own handle is left alone here: dropping it from
            // inside would cancel the very write it is about to make.
            let Ok(text) = this.update(cx, |this, cx| this.snapshot(cx)) else {
                return;
            };
            cx.background_executor().spawn(async move { storage::write_session(&text) }).await;
        }));
    }

    fn flush(&mut self, cx: &mut Context<Self>) {
        if !self.ready {
            return;
        }
        self.save_task = None;
        storage::write_session(&self.snapshot(cx));
    }

    // ── Workflows ──────────────────────────────────────────────────────────

    fn add_workflow(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let n = ids::next_workflow();
        let id = format!("wf-{n}");
        self.push_workflow(id.clone(), format!("Workflow {n}"), None, window, cx);
        self.set_active(id, window, cx);
        self.schedule_save(cx);
    }

    /// Closing a workflow drops every session in it, and with them their
    /// process groups.
    fn close_workflow(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.workflows.len() <= 1 {
            return; // never leave the window with nothing
        }
        let Some(index) = self.workflows.iter().position(|w| w.id == id) else { return };
        let entry = self.workflows.remove(index);
        entry.workspace.update(cx, |ws, cx| ws.hide_pages(cx));
        if self.active == id {
            self.active = self.workflows[index.saturating_sub(1).min(self.workflows.len() - 1)].id.clone();
        }
        self.sync_active(window, cx);
        self.schedule_save(cx);
    }

    /// The same rule the panes inside follow: the question is for work in
    /// flight, and a workflow of idle prompts and pages closes on the spot.
    fn request_close_workflow(&mut self, id: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let target = id.unwrap_or_else(|| self.active.clone());
        if self.workflows.len() <= 1 {
            return;
        }
        let running = self.workflows.iter().find(|w| w.id == target).map(|w| w.workspace.read(cx).running_count(cx)).unwrap_or(0);
        if running == 0 {
            self.close_workflow(&target, window, cx);
            return;
        }
        self.pending_close = Some((target, running));
        window.focus(&self.focus_handle);
        self.sync_active(window, cx);
    }

    fn begin_rename(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(name) = self.workflows.iter().find(|w| w.id == id).map(|w| w.name.clone()) else { return };
        let theme = cx.global::<Theme>().clone();
        let input = cx.new(|cx| {
            let mut t = TextInput::new(name, "", window, cx);
            t.cursor_color = theme.accent;
            t.selection_color = crate::theme::mix(theme.accent, gpui::transparent_black(), 0.3);
            t
        });
        let sub = cx.subscribe_in(&input, window, |this, _, e: &InputEvent, window, cx| {
            let Some((id, _, _)) = this.renaming.take() else { return };
            if let InputEvent::Submit(text) | InputEvent::Blur(text) = e {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    if let Some(w) = this.workflows.iter_mut().find(|w| w.id == id) {
                        w.name = trimmed.to_string();
                    }
                    this.schedule_save(cx);
                }
            }
            if !matches!(e, InputEvent::Blur(_)) {
                if let Some(ws) = this.active_workspace() {
                    window.focus(&ws.focus_handle(cx));
                }
            }
            this.sync_active(window, cx);
        });
        window.focus(&input.focus_handle(cx));
        self.renaming = Some((id, input, sub));
        self.sync_active(window, cx);
    }

    fn show_onboarding(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let ob = cx.new(Onboarding::new);
        let sub = cx.subscribe_in(&ob, window, |this, _, e: &OnboardingEvent, window, cx| {
            // Recorded as the screen goes: what the flag really says is that
            // someone was here to read it.
            this.onboarding = None;
            this.patch_flags(cx, |f| f.seen_onboarding = true);
            this.sync_active(window, cx);
            if let Some(ws) = this.active_workspace() {
                window.focus(&ws.focus_handle(cx));
                if matches!(e, OnboardingEvent::Finish) {
                    ws.update(cx, |ws, cx| ws.add_pane(PaneKind::Terminal, window, cx));
                }
            }
        });
        window.focus(&ob.focus_handle(cx));
        self.onboarding = Some((ob, sub));
    }

    // ── The rail drag ──────────────────────────────────────────────────────
    //
    // The order changes exactly once, on release. Everything before that is
    // an offset: the name in hand tracks the pointer, the names it passes
    // step aside by the width of the hole it left, and nothing reflows.

    fn begin_rail_drag(&mut self, index: usize, e: &MouseDownEvent) {
        if self.renaming.is_some() || self.workflows.len() < 2 {
            return;
        }
        let slots = self.slots.borrow();
        let rects: Vec<Slot> = self
            .workflows
            .iter()
            .map(|w| slots.get(&w.id).map(|b| Slot { left: f32::from(b.origin.x), width: f32::from(b.size.width) }).unwrap_or(Slot { left: 0., width: 0. }))
            .collect();
        drop(slots);
        let distance = rects[index].width + gap_between(&rects, 9.0);
        self.rail_drag = Some(RailDrag { from: index, to: index, start_x: e.position.x, dx: 0.0, rects, distance, moved: false });
    }

    fn move_rail_drag(&mut self, e: &MouseMoveEvent, cx: &mut Context<Self>) {
        let Some(d) = self.rail_drag.as_mut() else { return };
        let travelled = f32::from(e.position.x - d.start_x);
        if !d.moved {
            if travelled.abs() < DRAG_THRESHOLD {
                return;
            }
            d.moved = true;
        }
        d.dx = clamp_offset(&d.rects, d.from, travelled);
        d.to = drop_index(&d.rects, d.from, d.dx);
        cx.notify();
    }

    fn end_rail_drag(&mut self, cx: &mut Context<Self>) {
        let Some(d) = self.rail_drag.take() else { return };
        if d.moved {
            self.dropped_at = Some(Instant::now());
            if d.to != d.from {
                let order: Vec<usize> = reorder(&(0..self.workflows.len()).collect::<Vec<_>>(), d.from, d.to);
                let mut old: Vec<Option<WorkflowEntry>> = self.workflows.drain(..).map(Some).collect();
                self.workflows = order.into_iter().map(|i| old[i].take().unwrap()).collect();
                self.schedule_save(cx);
            }
        }
        cx.notify();
    }

    // ── Actions ────────────────────────────────────────────────────────────

    fn with_workspace(&mut self, cx: &mut Context<Self>, window: &mut Window, f: impl FnOnce(&mut Workspace, &mut Window, &mut Context<Workspace>)) {
        if self.onboarding.is_some() || self.pending_close.is_some() {
            return;
        }
        if let Some(ws) = self.active_workspace() {
            ws.update(cx, |ws, cx| f(ws, window, cx));
        }
    }

    fn on_key_down(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        log::trace!("key {:?} {:?} {:?}", e.keystroke.key, e.keystroke.key_char, e.keystroke.modifiers);
        if self.pending_close.is_none() {
            return;
        }
        match e.keystroke.key.as_str() {
            "escape" => {
                self.pending_close = None;
                self.sync_active(window, cx);
            }
            "enter" => {
                if let Some((id, _)) = self.pending_close.take() {
                    self.close_workflow(&id, window, cx);
                }
            }
            _ => return,
        }
        cx.stop_propagation();
    }

    fn render_titlebar(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<Theme>().clone();
        let mac = cfg!(target_os = "macos");
        let left_pad = if mac && !window.is_fullscreen() { 84.0 } else { 16.0 };
        let drag = self.rail_drag.as_ref().map(|d| (d.from, d.to, d.dx, d.distance, d.moved));
        let many = self.workflows.len() > 1;

        let mut rail = div().flex().items_end().gap(px(4.)).min_w_0().h_full();
        for (index, wf) in self.workflows.iter().enumerate() {
            let active = wf.id == self.active;
            let shift = match drag {
                Some((from, to, dx, distance, true)) => {
                    if index == from {
                        dx
                    } else {
                        slide_for(index, from, to, distance)
                    }
                }
                _ => 0.0,
            };
            if index > 0 {
                rail = rail.child(div().flex_none().w(px(1.)).h(px(12.)).mb(px(9.)).bg(theme.border_soft));
            }
            let id = wf.id.clone();
            let id2 = wf.id.clone();
            let id3 = wf.id.clone();
            let slots = self.slots.clone();
            let slot_id = wf.id.clone();
            let group: SharedString = format!("wf-{}", wf.id).into();
            let renaming = self.renaming.as_ref().filter(|(rid, ..)| *rid == wf.id).map(|(_, input, _)| input.clone());
            let label: gpui::AnyElement = match renaming {
                Some(input) => div()
                    .w(px(140.))
                    .h(px(22.))
                    .flex()
                    .items_center()
                    .px(px(4.))
                    .bg(theme.pane_screen)
                    .border_1()
                    .border_color(theme.border)
                    .text_color(theme.text_strong)
                    .child(input)
                    .into_any_element(),
                None => div().overflow_hidden().whitespace_nowrap().text_ellipsis().child(SharedString::from(wf.name.clone())).into_any_element(),
            };
            rail = rail.child(
                div()
                    .id(SharedString::from(format!("wf-{}", wf.id)))
                    .group(group.clone())
                    .relative()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(8.))
                    .h(px(30.))
                    .max_w(px(220.))
                    .pl(px(31.))
                    .pr(px(10.))
                    .left(px(shift))
                    .text_size(px(12.))
                    .text_color(if active { theme.text_strong } else { theme.text_mid })
                    .when(!active, |d| d.hover(|s| s.text_color(theme.text_strong)))
                    .cursor_pointer()
                    .child(
                        canvas(
                            move |bounds, _, _| {
                                slots.borrow_mut().insert(slot_id, bounds);
                            },
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .inset_0(),
                    )
                    // The mark stands in front of the workflow you are in: the
                    // app's own mark is also the answer to "where am I".
                    .when(active, |d| d.child(div().absolute().left(px(9.)).bottom(px(7.)).child(icon(Icon::Brand, 16., theme.accent))))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, e: &MouseDownEvent, window, cx| {
                            if e.click_count == 2 {
                                // Two quick drags in a row end in a double click
                                // that was never one.
                                if this.dropped_at.map(|t| t.elapsed() < DRAG_SETTLE).unwrap_or(false) {
                                    return;
                                }
                                this.begin_rename(id.clone(), window, cx);
                                return;
                            }
                            this.set_active(id.clone(), window, cx);
                            this.begin_rail_drag(index, e);
                        }),
                    )
                    .child(label)
                    .when(many, |d| {
                        d.child(
                            div().invisible().when(active, |d| d.visible()).group_hover(group, |s| s.visible()).child(
                                glyph_button(SharedString::from(format!("wf-close-{id2}")), Icon::Close, 18., &theme)
                                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                    .on_click(cx.listener(move |this, _, window, cx| this.request_close_workflow(Some(id3.clone()), window, cx))),
                            ),
                        )
                    }),
            );
        }

        let theme_switch = div().flex().items_center().gap(px(2.)).h(px(30.)).children(ThemeMode::ALL.iter().map(|mode| {
            let on = self.flags.theme == *mode;
            let mode = *mode;
            div()
                .id(SharedString::from(format!("theme-{}", mode.label())))
                .px(px(5.))
                .h(px(22.))
                .flex()
                .items_center()
                .text_size(px(11.))
                .text_color(if on { theme.text_strong } else { theme.text_dim })
                .when(on, |d| d.border_b_1().border_color(theme.accent))
                .cursor_pointer()
                .hover(|s| s.text_color(theme.text_strong))
                .on_click(cx.listener(move |this, _, window, cx| this.set_theme_mode(mode, window, cx)))
                .child(mode.label())
        }));

        let action = |id: &'static str, label: &'static str| {
            div()
                .id(id)
                .flex()
                .items_center()
                .gap(px(7.))
                .h(px(22.))
                .px(px(4.))
                .text_size(px(11.5))
                .text_color(theme.text_dim)
                .cursor_pointer()
                .hover(|s| s.text_color(theme.text_strong))
                .child(icon(Icon::Plus, 11., theme.text_dim))
                .child(label)
        };

        let tracker = Some(()).map(|_| {
            let weak = cx.entity().downgrade();
            canvas(
                |_, _, _| {},
                move |_, _, window, _| {
                    let w1 = weak.clone();
                    window.on_mouse_event(move |e: &MouseMoveEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            let _ = w1.update(cx, |this, cx| this.move_rail_drag(e, cx));
                        }
                    });
                    let w2 = weak.clone();
                    window.on_mouse_event(move |_: &MouseUpEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            let _ = w2.update(cx, |this, cx| this.end_rail_drag(cx));
                        }
                    });
                },
            )
            .absolute()
            .inset_0()
        });

        div()
            .id("titlebar")
            .relative()
            .flex()
            .flex_none()
            .items_end()
            .gap(px(12.))
            .pl(px(left_pad))
            .pr(px(16.))
            .h(px(40.))
            .bg(theme.bg_app)
            .font_family(crate::theme::ui_font())
            .on_mouse_down(MouseButton::Left, |e: &MouseDownEvent, window, _| {
                if e.click_count == 2 {
                    window.titlebar_double_click();
                } else {
                    window.start_window_move();
                }
            })
            .child(rail)
            .child(
                glyph_button("workflow-add", Icon::Plus, 26., &theme)
                    .mb(px(2.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(|this, _, window, cx| this.add_workflow(window, cx))),
            )
            .child(div().flex_1().h_full().window_control_area(gpui::WindowControlArea::Drag))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .h(px(30.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(action("new-terminal", "Terminal").on_click(cx.listener(|this, _, window, cx| {
                        this.with_workspace(cx, window, |ws, window, cx| ws.add_pane(PaneKind::Terminal, window, cx))
                    })))
                    .child(action("new-browser", "Browser").on_click(cx.listener(|this, _, window, cx| {
                        this.with_workspace(cx, window, |ws, window, cx| ws.add_pane(PaneKind::Browser, window, cx))
                    }))),
            )
            .child(div().flex_none().w(px(1.)).h(px(12.)).mb(px(9.)).bg(theme.border_soft))
            .child(div().on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation()).child(theme_switch))
            .children(tracker)
    }
}

impl Focusable for MesaApp {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for MesaApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<Theme>().clone();
        let titlebar = self.render_titlebar(window, cx);
        let active = self.active_workspace();
        let onboarding = self.onboarding.as_ref().map(|(o, _)| o.clone());
        let confirm = self.pending_close.as_ref().map(|(id, running)| {
            let name = self.workflows.iter().find(|w| &w.id == id).map(|w| w.name.clone()).unwrap_or_default();
            confirm_rail(
                &theme,
                Some(running.to_string()),
                format!("{name} will close"),
                div().child(if *running == 1 { "a command is running inside it" } else { "commands are running inside it" }),
                vec![
                    rail_button("wf-cancel", "Cancel", Shortcut::Cancel, false, &theme)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.pending_close = None;
                            this.sync_active(window, cx);
                        }))
                        .into_any_element(),
                    rail_button("wf-accept", "Close", Shortcut::Confirm, true, &theme)
                        .on_click(cx.listener(|this, _, window, cx| {
                            if let Some((id, _)) = this.pending_close.take() {
                                this.close_workflow(&id, window, cx);
                            }
                        }))
                        .into_any_element(),
                ],
            )
        });

        div()
            .id("mesa")
            .key_context("Mesa")
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_action(cx.listener(|this, _: &NewTerminal, window, cx| this.with_workspace(cx, window, |ws, w, cx| ws.add_pane(PaneKind::Terminal, w, cx))))
            .on_action(cx.listener(|this, _: &NewBrowser, window, cx| this.with_workspace(cx, window, |ws, w, cx| ws.add_pane(PaneKind::Browser, w, cx))))
            .on_action(cx.listener(|this, _: &NewWorkflow, window, cx| {
                if this.renaming.is_none() {
                    this.add_workflow(window, cx)
                }
            }))
            // Always swallowed, even with nothing selected: ⌘W must never
            // fall through to closing the window.
            .on_action(cx.listener(|this, _: &CloseSelection, window, cx| this.with_workspace(cx, window, |ws, w, cx| ws.close_selected(w, cx))))
            .on_action(cx.listener(|this, _: &OpenInEditor, window, cx| this.with_workspace(cx, window, |ws, w, cx| ws.open_in_editor(false, w, cx))))
            .on_action(cx.listener(|this, _: &ChooseEditor, window, cx| this.with_workspace(cx, window, |ws, w, cx| ws.open_in_editor(true, w, cx))))
            .on_action(cx.listener(|this, _: &ZoomIn, window, cx| this.with_workspace(cx, window, |ws, _, cx| ws.zoom_in(cx))))
            .on_action(cx.listener(|this, _: &ZoomOut, window, cx| this.with_workspace(cx, window, |ws, _, cx| ws.zoom_out(cx))))
            .on_action(cx.listener(|this, _: &ZoomReset, window, cx| this.with_workspace(cx, window, |ws, _, cx| ws.zoom_reset(cx))))
            .on_action(cx.listener(|this, _: &ZoomFit, window, cx| this.with_workspace(cx, window, |ws, _, cx| ws.fit_to_content(cx))))
            .on_action(cx.listener(|this, _: &FocusOmnibox, window, cx| this.with_workspace(cx, window, |ws, w, cx| ws.focus_omnibox(w, cx))))
            .on_action(cx.listener(|this, a: &SwitchTab, window, cx| {
                let n = a.0;
                this.with_workspace(cx, window, |ws, w, cx| ws.select_tab(n, w, cx))
            }))
            .on_action(cx.listener(|this, a: &SwitchWorkflow, window, cx| {
                if let Some(id) = this.workflows.get(a.0.saturating_sub(1)).map(|w| w.id.clone()) {
                    this.set_active(id, window, cx);
                }
            }))
            .on_action(|_: &ToggleFullScreen, window, _| window.toggle_fullscreen())
            .on_action(|_: &Minimize, window, _| window.minimize_window())
            .on_action(cx.listener(|this, _: &Quit, _, cx| {
                this.flush(cx);
                cx.quit();
            }))
            .size_full()
            .flex()
            .flex_col()
            .bg(theme.bg_app)
            .text_color(theme.text)
            .font_family(crate::theme::ui_font())
            .child(titlebar)
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .children(active.map(|ws| ws.into_any_element()))
                    .children(onboarding.map(|o| o.into_any_element()))
                    .children(confirm),
            )
    }
}

#[allow(dead_code)]
fn _assert_action(_: &dyn Action) {}
