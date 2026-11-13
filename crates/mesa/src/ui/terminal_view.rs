//! One terminal tab: the session behind it, what it has reported about
//! itself, and the completion list drawn over it.
//!
//! Every open tab keeps its view, including the ones you cannot see — a
//! background tab is usually the thing you left running.

use std::{
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};

use alacritty_terminal::{grid::Dimensions, term::TermMode, vte::ansi};
use std::ops::Range;

use gpui::{
    actions, div, prelude::*, px, App, Bounds, EntityInputHandler, Pixels, UTF16Selection, ClipboardItem, Context, EventEmitter, FocusHandle, Focusable, KeyBinding,
    KeyDownEvent, MouseButton, SharedString, Task, Window,
};
use parking_lot::RwLock;

use mesa_core::{
    accept::{accept_sequence, accepted_line, Accept},
    command_line::{completion_context, Context as LineContext, Position},
    dropdown::{dropdown_placement, Direction, DEFAULT_MAX},
    rank::{rank_candidates, weigh_by_usage, Candidate, Prefix, Source},
    schema::schema_candidates,
    terminal_osc::TerminalTheme,
    zle::ZleLine,
};

use super::{
    r,
    terminal_element::{grid_size_for, line_height, CellMetrics, TerminalElement, FONT_SIZE, PAD_X, PAD_Y},
};
use crate::{
    completion,
    terminal::{
        keys,
        session::{Session, SessionEvent},
    },
    theme::Theme,
};

actions!(terminal, [Copy, Paste, ClearSelection]);

pub fn bind_keys(cx: &mut App) {
    let ctx = Some("Terminal");
    if cfg!(target_os = "macos") {
        cx.bind_keys([KeyBinding::new("cmd-c", Copy, ctx), KeyBinding::new("cmd-v", Paste, ctx)]);
    } else {
        cx.bind_keys([KeyBinding::new("ctrl-shift-c", Copy, ctx), KeyBinding::new("ctrl-shift-v", Paste, ctx)]);
    }
}

/// How long the shell has to go quiet before a startup command is typed,
/// for shells that do not speak OSC 133. Long enough that a slow login
/// profile's own output keeps pushing it back.
const STARTUP_QUIET: Duration = Duration::from_millis(700);

#[derive(Clone, Debug, Default)]
pub struct Status {
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub running_since: Option<Instant>,
    pub last_exit: Option<i32>,
    pub exited: bool,
    pub tui: bool,
}

/// Something the pane around this view needs to redraw for: the folder, the
/// branch, a command starting or ending.
pub enum TerminalEvent {
    StatusChanged,
    /// The folder moved: the one change here that belongs in the session.
    CwdChanged,
}

pub struct Completion {
    pub items: Vec<Candidate>,
    pub context: LineContext,
    pub line: ZleLine,
    pub selected: usize,
}

pub struct TerminalView {
    pub tab_id: String,
    pub session: Option<Arc<Session>>,
    focus_handle: FocusHandle,
    pub status: Status,
    startup: Option<String>,
    startup_sent: bool,
    startup_timer: Option<Task<()>>,
    completion: Option<Completion>,
    /// Which request is the current one, so an answer that arrives late can
    /// tell it is answering an old question.
    line_generation: u64,
    /// The line a candidate was just accepted onto. The shell reports that
    /// line straight back, and without this it is indistinguishable from
    /// typing.
    accepted: Option<String>,
    /// The last line the shell reported: what you just ran, once a command
    /// starts.
    last_line: String,
    cwd_ticket: u64,
    pub selecting: bool,
    /// An input method's composition, not yet committed.
    marked: Option<String>,
    /// Where the cursor cell was last painted, for the input method's
    /// candidate window.
    pub cursor_bounds: Option<Bounds<Pixels>>,
    pub scroll_remainder: f32,
    pub zoom: f32,
    pub visible: bool,
    palette: Arc<RwLock<(TerminalTheme, u32)>>,
    _events: Task<()>,
    _ticker: Option<Task<()>>,
}

impl EventEmitter<TerminalEvent> for TerminalView {}

impl TerminalView {
    pub fn new(
        tab_id: String,
        cwd: Option<String>,
        startup: Option<String>,
        width: f32,
        height: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let theme = cx.global::<Theme>().clone();
        let cell = *cx.global::<CellMetrics>();
        let palette = Arc::new(RwLock::new((theme.terminal.clone(), rgb_of(theme.accent))));
        let (cols, rows) = grid_size_for(width, height, cell, false);
        let session = match Session::spawn(cols, rows, cwd.as_deref(), palette.clone()) {
            Ok(s) => Some(Arc::new(s)),
            Err(err) => {
                log::error!("shell spawn failed: {err:#}");
                None
            }
        };
        let events = match &session {
            Some(s) => {
                let rx = s.events.clone();
                cx.spawn_in(window, async move |this, cx| {
                    while let Ok(event) = rx.recv().await {
                        let alive = this.update_in(cx, |this, window, cx| this.handle_event(event, window, cx)).is_ok();
                        if !alive {
                            break;
                        }
                    }
                })
            }
            None => Task::ready(()),
        };
        let focus_handle = cx.focus_handle();
        let mut status = Status::default();
        status.cwd = cwd;
        if session.is_none() {
            status.exited = true;
        }
        TerminalView {
            tab_id,
            session,
            focus_handle,
            status,
            startup: startup.filter(|s| !s.is_empty()),
            startup_sent: false,
            startup_timer: None,
            completion: None,
            line_generation: 0,
            accepted: None,
            last_line: String::new(),
            cwd_ticket: 0,
            selecting: false,
            marked: None,
            cursor_bounds: None,
            scroll_remainder: 0.0,
            zoom: 1.0,
            visible: true,
            palette,
            _events: events,
            _ticker: None,
        }
    }

    /// Swaps the palette when the chrome's theme changes. Only the live
    /// colours move; scrollback and the running shell are untouched, and
    /// blocks store roles rather than colours, so they repaint with it.
    pub fn set_theme(&mut self, theme: &Theme) {
        *self.palette.write() = (theme.terminal.clone(), rgb_of(theme.accent));
    }

    pub fn is_running(&self) -> bool {
        self.status.running_since.is_some()
    }

    fn report(&mut self, cx: &mut Context<Self>) {
        cx.emit(TerminalEvent::StatusChanged);
        cx.notify();
    }

    fn type_startup(&mut self) {
        if self.startup_sent {
            return;
        }
        self.startup_sent = true;
        // The return is part of the same write, so nothing can land between
        // the line and its submission.
        if let (Some(cmd), Some(s)) = (self.startup.as_ref(), self.session.as_ref()) {
            s.write_str(&format!("{cmd}\r"));
        }
    }

    fn handle_event(&mut self, event: SessionEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            SessionEvent::Output => {
                if let Some(s) = &self.session {
                    s.output_pending.store(false, Ordering::Release);
                }
                // The weaker signal that a shell is ready for a line, for
                // shells that never send a prompt marker: its output going
                // quiet.
                if !self.startup_sent && self.startup.is_some() {
                    self.startup_timer = Some(cx.spawn_in(window, async move |this, cx| {
                        cx.background_executor().timer(STARTUP_QUIET).await;
                        let _ = this.update(cx, |this, _| this.type_startup());
                    }));
                }
                cx.notify();
            }
            SessionEvent::PromptStart => {
                // A prompt is being drawn: the one certain moment to lay the
                // startup command in front of it.
                self.type_startup();
                self.startup_timer = None;
            }
            SessionEvent::Cwd(dir) => {
                let moved = self.status.cwd.as_deref() != Some(dir.as_str());
                self.status.cwd = Some(dir.clone());
                if moved {
                    cx.emit(TerminalEvent::CwdChanged);
                }
                // The branch is read on every prompt, not only when the folder
                // changes: `git checkout` moves it without moving the shell.
                self.cwd_ticket += 1;
                let ticket = self.cwd_ticket;
                cx.spawn(async move |this, cx| {
                    let branch = cx
                        .background_executor()
                        .spawn(async move { crate::platform::git_branch_at(std::path::Path::new(&dir)) })
                        .await;
                    let _ = this.update(cx, |this, cx| {
                        if this.cwd_ticket == ticket && this.status.branch != branch {
                            this.status.branch = branch;
                            this.report(cx);
                        }
                    });
                })
                .detach();
                self.report(cx);
            }
            SessionEvent::CommandStart => {
                self.status.running_since = Some(Instant::now());
                // The line has been submitted, and what was on it is now the
                // freshest history there is.
                if !self.last_line.is_empty() {
                    let line = std::mem::take(&mut self.last_line);
                    cx.background_executor().spawn(async move { completion::remember_command(&line) }).detach();
                }
                self.close_completion(cx);
                // The ticking number is real data changing, which is the one
                // thing in a title bar that earns motion.
                self._ticker = Some(cx.spawn(async move |this, cx| loop {
                    cx.background_executor().timer(Duration::from_millis(250)).await;
                    if this.update(cx, |_, cx| cx.emit(TerminalEvent::StatusChanged)).is_err() {
                        break;
                    }
                }));
                self.report(cx);
            }
            SessionEvent::CommandEnd(code) => {
                self.status.running_since = None;
                self.status.last_exit = (code != 0).then_some(code);
                self._ticker = None;
                self.report(cx);
            }
            SessionEvent::Line(line) => self.handle_line(line, window, cx),
            SessionEvent::Tui(on) => {
                self.status.tui = on;
                // A TUI has no shell line behind it, so the list is stale the
                // moment one takes the screen.
                if on {
                    self.close_completion(cx);
                }
                self.report(cx);
            }
            SessionEvent::Clipboard(text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
            SessionEvent::Exited => {
                self.status.exited = true;
                self.status.running_since = None;
                self._ticker = None;
                if let Some(s) = &self.session {
                    let mut shared = s.shared.lock();
                    let mut parser: ansi::Processor = ansi::Processor::new();
                    parser.advance(&mut shared.term, b"\r\n\x1b[90m[process exited]\x1b[0m\r\n");
                }
                self.report(cx);
            }
        }
    }

    fn close_completion(&mut self, cx: &mut Context<Self>) {
        self.line_generation += 1;
        if self.completion.take().is_some() {
            cx.notify();
        }
    }

    /// Everything the list offers for the line the shell just reported. The
    /// sources are read off the UI thread; only the ranking happens here.
    fn handle_line(&mut self, line: Option<ZleLine>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(line) = line else {
            self.close_completion(cx);
            return;
        };
        self.last_line = line.buffer.clone();
        // Every report invalidates whatever is still in flight.
        self.line_generation += 1;
        let generation = self.line_generation;

        // The echo of a candidate just accepted, not a keystroke.
        if self.accepted.as_deref() == Some(line.buffer.as_str()) {
            self.accepted = None;
            self.completion = None;
            cx.notify();
            return;
        }

        let context = completion_context(&line.buffer, line.cursor);
        // Nothing typed yet at a bare prompt: eight arbitrary executables
        // under the cursor is noise. `git ` with an empty word does open.
        if context.position == Position::Command && context.prefix.is_empty() {
            self.completion = None;
            cx.notify();
            return;
        }

        let cwd = self.status.cwd.clone();
        cx.spawn_in(window, async move |this, cx| {
            let ctx = context.clone();
            let line_ = line.clone();
            let items = cx
                .background_executor()
                .spawn(async move { rank_for(&ctx, &line_, cwd.as_deref()) })
                .await;
            let _ = this.update(cx, |this, cx| {
                // Answers arrive out of order; only the newest may write.
                if this.line_generation != generation {
                    return;
                }
                this.completion = (!items.is_empty()).then(|| Completion { items, context, line, selected: 0 });
                cx.notify();
            });
        })
        .detach();
    }

    fn accept(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(open) = self.completion.take() else { return };
        let Some(item) = open.items.get(index) else { return };
        let accept = Accept {
            buffer: &open.line.buffer,
            cursor: open.line.cursor,
            // A history entry is a whole command line and replaces the whole
            // line; everything else replaces the word under the cursor.
            start: if item.source == Source::History { 0 } else { open.context.start },
            value: &item.value,
        };
        // Remembered before the write: the shell echoes the new line back
        // through the same hook the typing comes through.
        self.accepted = Some(accepted_line(&accept));
        if let Some(s) = &self.session {
            s.write_str(&accept_sequence(&accept));
        }
        self.line_generation += 1;
        cx.notify();
    }

    fn upward(&self) -> bool {
        let (Some(s), Some(c)) = (&self.session, &self.completion) else { return false };
        let shared = s.shared.lock();
        let row = shared.term.grid().cursor.point.line.0.max(0) as usize;
        dropdown_placement(row, shared.term.screen_lines(), c.items.len(), DEFAULT_MAX).direction == Direction::Up
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.session.clone() else { return };
        let k = &event.keystroke;
        let m = &k.modifiers;

        // The completion list claims four keys, and only while it is open.
        // Tab accepts — the key a terminal has always used for completion —
        // and Enter is left doing what Enter does. With the list closed, Tab
        // and the arrows go straight to the shell.
        if self.completion.is_some() && !m.platform && !m.alt && !m.control {
            match k.key.as_str() {
                "down" | "up" => {
                    // With the list drawn upward the best match is at the
                    // BOTTOM, so moving up the screen means moving down the
                    // ranking.
                    let down = k.key == "down";
                    let step: isize = if down { 1 } else { -1 } * if self.upward() { -1 } else { 1 };
                    if let Some(c) = self.completion.as_mut() {
                        let n = c.items.len() as isize;
                        c.selected = ((c.selected as isize + step + n) % n) as usize;
                    }
                    cx.stop_propagation();
                    cx.notify();
                    return;
                }
                "tab" if !m.shift => {
                    let selected = self.completion.as_ref().map(|c| c.selected).unwrap_or(0);
                    self.accept(selected, cx);
                    cx.stop_propagation();
                    return;
                }
                "escape" => {
                    self.close_completion(cx);
                    cx.stop_propagation();
                    return;
                }
                _ => {}
            }
        }

        // Plain typing is left unhandled, so the platform's text system
        // turns it into text (Caps Lock, dead keys, input methods) and hands
        // it to the input handler below — see `keys::is_text`.
        if keys::is_text(k) {
            return;
        }

        let mode = *session.shared.lock().term.mode();
        if let Some(bytes) = keys::to_bytes(k, mode) {
            cx.stop_propagation();
            self.type_bytes(&session, &bytes, cx);
        }
    }

    /// Typing returns the view to the prompt and clears a selection, as
    /// every terminal does.
    fn type_bytes(&mut self, session: &Session, bytes: &str, cx: &mut Context<Self>) {
        {
            let mut shared = session.shared.lock();
            shared.term.selection = None;
            if shared.term.grid().display_offset() != 0 {
                shared.term.scroll_display(alacritty_terminal::grid::Scroll::Bottom);
            }
        }
        session.write_str(bytes);
        cx.notify();
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        let Some(s) = &self.session else { return };
        if let Some(text) = s.shared.lock().term.selection_to_string() {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        let Some(s) = self.session.clone() else { return };
        let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) else { return };
        let bracketed = s.shared.lock().term.mode().contains(TermMode::BRACKETED_PASTE);
        if bracketed {
            // The end marker is stripped from what is pasted, so a paste can
            // never close the bracket early and run what follows it.
            let clean = text.replace("\x1b[201~", "");
            s.write_str(&format!("\x1b[200~{clean}\x1b[201~"));
        } else {
            s.write_str(&text.replace("\r\n", "\r").replace('\n', "\r"));
        }
    }

    fn render_completion(&self, theme: &Theme, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let completion = self.completion.as_ref()?;
        if !self.visible {
            return None;
        }
        let session = self.session.as_ref()?;
        let (cursor_row, cursor_col, term_rows) = {
            let shared = session.shared.lock();
            let g = shared.term.grid();
            (g.cursor.point.line.0.max(0) as usize, g.cursor.point.column.0, g.screen_lines())
        };
        let placed = dropdown_placement(cursor_row, term_rows, completion.items.len(), DEFAULT_MAX);
        if placed.rows == 0 {
            return None;
        }
        let cell = *cx.global::<CellMetrics>();
        let lh = line_height(false);
        // Only the rows that fit are drawn, and the selected one is always
        // among them.
        let first = completion.selected.saturating_sub(placed.rows - 1).min(completion.items.len() - placed.rows);
        let upward = placed.direction == Direction::Up;
        // The best match sits nearest the line being typed: at the BOTTOM
        // when the list opens upward.
        let mut indices: Vec<usize> = (first..first + placed.rows).collect();
        if upward {
            indices.reverse();
        }
        let row_top = PAD_Y + cursor_row as f32 * lh;
        let left = PAD_X + cursor_col as f32 * cell.width;
        let row_h = 21.0;
        let height = row_h * placed.rows as f32 + 2.0;
        let top = if upward { row_top - height } else { row_top + lh };

        let rows = indices.into_iter().map(|i| {
            let item = &completion.items[i];
            let on = i == completion.selected;
            div()
                .id(("completion", i))
                .flex()
                .justify_between()
                .gap(r(12.))
                .h(r(row_h))
                .items_center()
                .px(r(8.))
                .text_size(r(12.5))
                .text_color(if on { theme.text_strong } else { theme.text })
                .when(on, |d| d.bg(theme.hover))
                .cursor_pointer()
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.accept(i, cx);
                    }),
                )
                .child(div().flex_none().child(SharedString::from(item.value.replace('\n', " ⏎ "))))
                .when(!item.description.is_empty(), |d| {
                    d.child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .text_color(theme.text_dim)
                            .child(SharedString::from(item.description.clone())),
                    )
                })
        });

        Some(
            div()
                .absolute()
                .left(r(left))
                .top(r(top))
                .min_w(r(150.))
                .max_w(r(520.))
                .flex()
                .flex_col()
                .bg(theme.pane_frame)
                .border_1()
                .border_color(theme.pane_border)
                .shadow(vec![gpui::BoxShadow {
                    color: theme.shadow,
                    offset: gpui::point(px(0.), r(6.).to_pixels(px(16.))),
                    blur_radius: px(18.),
                    spread_radius: px(0.),
                }])
                .font_family(crate::theme::mono_font())
                .children(rows)
                .into_any_element(),
        )
    }
}

fn rgb_of(c: gpui::Hsla) -> u32 {
    let c = gpui::Rgba::from(c);
    (((c.r * 255.).round() as u32) << 16) | (((c.g * 255.).round() as u32) << 8) | ((c.b * 255.).round() as u32)
}

fn unix_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// The list for one reported line: the schema's view of what the command can
/// take, the live sources it names, the history, all ranked together.
fn rank_for(context: &LineContext, line: &ZleLine, cwd: Option<&str>) -> Vec<Candidate> {
    let schema = context.words.first().and_then(|w| completion::command_schema(w));
    let from_schema = schema.map(|s| schema_candidates(&s, &context.words, &context.prefix)).unwrap_or_default();
    // A schema node that names a generator is asking for live values. The
    // marker itself is never shown — it has no value — and stands in for what
    // the generator returns.
    let generator = from_schema.iter().find_map(|c| c.generator.clone());
    let mut wanted = vec!["history", if context.position == Position::Command { "path" } else { "files" }];
    if let Some(g) = generator.as_deref() {
        wanted.push(g);
    }
    let chars: Vec<char> = line.buffer.chars().collect();
    let line_so_far: String = chars[..line.cursor.min(chars.len())].iter().collect();
    let mut live = Vec::new();
    for name in wanted {
        // A history entry is a whole command line, matched against the line.
        let prefix = if name == "history" { line_so_far.as_str() } else { context.prefix.as_str() };
        live.extend(completion::candidates(cwd, name, prefix));
    }
    // Up to where the WORD starts, not up to the cursor: `git c` must credit
    // `checkout` with your past `git checkout`s.
    let before_word: String = chars[..context.start.min(chars.len())].iter().collect();
    let mut all = weigh_by_usage(&from_schema, &live, &before_word);
    all.extend(live);
    rank_candidates(&all, Prefix::new(&context.prefix, &line_so_far), 8, unix_now())
}

/// The terminal as a text-input client. It holds no text of its own — the
/// line belongs to the shell — so it only takes what the platform has
/// composed and types it into the pty. A composition in progress (an input
/// method's candidate, a dead key's accent) is held as marked text until it
/// is committed, and its position is the cursor's, so the candidate window
/// opens at the prompt.
impl EntityInputHandler for TerminalView {
    fn text_for_range(&mut self, _: Range<usize>, _: &mut Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        None
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        let at = self.marked.as_ref().map(|m| m.encode_utf16().count()).unwrap_or(0);
        Some(UTF16Selection { range: at..at, reversed: false })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|m| 0..m.encode_utf16().count())
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked = None;
    }

    fn replace_text_in_range(&mut self, _: Option<Range<usize>>, text: &str, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        let Some(session) = self.session.clone() else { return };
        // Control characters never arrive here as text: a newline the
        // platform inserts is Return, which is translated in on_key_down.
        let text: String = text.chars().filter(|c| !c.is_control()).collect();
        if !text.is_empty() {
            self.type_bytes(&session, &text, cx);
        }
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.marked = (!text.is_empty()).then(|| text.to_string());
        cx.notify();
    }

    fn bounds_for_range(&mut self, _: Range<usize>, _: Bounds<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        self.cursor_bounds
    }

    fn character_index_for_point(&mut self, _: gpui::Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        None
    }
}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.global::<Theme>().clone();
        let cell = *cx.global::<CellMetrics>();
        let focused = self.focus_handle.is_focused(window);
        let completion = self.render_completion(&theme, cx);
        let mut root = div()
            .id(SharedString::from(format!("terminal-{}", self.tab_id)))
            .key_context("Terminal")
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::paste))
            .relative()
            .flex()
            .flex_1()
            .size_full()
            .overflow_hidden()
            .cursor(gpui::CursorStyle::IBeam)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, _| {
                    window.focus(&this.focus_handle);
                }),
            );
        match &self.session {
            Some(session) => {
                root = root.child(TerminalElement {
                    view: cx.entity(),
                    session: session.clone(),
                    theme: theme.clone(),
                    zoom: self.zoom,
                    focused,
                    tui: self.status.tui,
                    cell,
                    visible: self.visible,
                });
            }
            None => {
                root = root.bg(theme.pane_screen).child(
                    div()
                        .p(r(12.))
                        .text_size(r(FONT_SIZE))
                        .text_color(theme.danger)
                        .font_family(crate::theme::mono_font())
                        .child("The shell could not be started."),
                );
            }
        }
        root.children(completion)
    }
}
