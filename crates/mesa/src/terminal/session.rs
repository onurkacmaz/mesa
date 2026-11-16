//! One live session: a login shell on a pty, and the grid it draws into.
//!
//! The pty is read on a thread of its own. Bytes go through
//! `mesa_core::stream::Scanner`, which cuts out the sequences meant for the
//! app (folder, prompt markers, the ZLE line) at the exact point they arrive,
//! and everything else goes to alacritty's emulator. The UI never touches the
//! pty directly: it reads the grid under a lock when it paints, and hears
//! about everything else as `SessionEvent`s.

use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use alacritty_terminal::{
    event::{Event, EventListener, WindowSize},
    grid::Dimensions,
    index::{Column, Line, Point},
    term::{Config, Term, TermMode},
    vte::ansi::{self, NamedColor, Rgb},
};
use anyhow::Context as _;
use parking_lot::{Mutex, RwLock};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use mesa_core::{
    stream::{parse_cwd, parse_prompt_mark, Piece, PromptMark, Scanner, OSC_CWD, OSC_LINE, OSC_PROMPT},
    terminal_osc::TerminalTheme,
    zle::{parse_zle_osc, ZleLine},
};

pub const SCROLLBACK: usize = 10_000;

/// What the UI hears from a session. Output itself is not carried — it is
/// already in the grid — only the news that there is some.
#[derive(Clone, Debug)]
pub enum SessionEvent {
    Output,
    Cwd(String),
    PromptStart,
    CommandStart,
    CommandEnd(i32),
    /// The line ZLE is editing, or `None` for "nothing to complete".
    Line(Option<ZleLine>),
    Tui(bool),
    Clipboard(String),
    Exited,
}

/// A command block's ROLE, never its colour: the colour is resolved from the
/// live theme every time it is painted, so switching themes repaints the
/// whole scrollback with it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BlockKind {
    /// The row a command was typed on.
    Row,
    /// The rule under a finished command's output.
    Rule { ok: bool },
}

#[derive(Clone, Copy, Debug)]
pub struct Block {
    /// Counted from the top of the scrollback, so it stays with its text as
    /// the screen scrolls.
    pub line: i64,
    pub kind: BlockKind,
}

#[derive(Clone)]
pub struct Listener {
    pending: Arc<Mutex<Vec<Event>>>,
}

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        match event {
            Event::Wakeup | Event::MouseCursorDirty | Event::CursorBlinkingChange => {}
            other => self.pending.lock().push(other),
        }
    }
}

pub struct Shared {
    pub term: Term<Listener>,
    pub blocks: Vec<Block>,
    pub alt: bool,
    pub cell_width: f32,
    pub cell_height: f32,
}

impl Shared {
    /// Where the cursor is, counted from the top of the scrollback.
    pub fn cursor_absolute(&self) -> i64 {
        let grid = self.term.grid();
        grid.history_size() as i64 + grid.cursor.point.line.0 as i64
    }
}

#[derive(Clone, Copy)]
pub struct GridSize {
    pub columns: usize,
    pub lines: usize,
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.lines
    }
    fn screen_lines(&self) -> usize {
        self.lines
    }
    fn columns(&self) -> usize {
        self.columns
    }
}

pub struct Session {
    pub shared: Arc<Mutex<Shared>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    pid: Option<i32>,
    pub events: smol::channel::Receiver<SessionEvent>,
    /// Set when an Output event is in flight, so a flood of output is one
    /// wake-up for the UI rather than one per read.
    pub output_pending: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    size: Mutex<GridSize>,
}

/// The shell the account actually uses. SHELL is what the launching process
/// had, which is the right answer when it exists — but launchd sets none, so
/// a Mac app opened from Finder would hand everyone /bin/zsh. The password
/// database is right in both cases. Either can name a shell since
/// uninstalled, so each candidate is checked.
pub fn user_shell() -> String {
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(s) = std::env::var("SHELL") {
        candidates.push(s);
    }
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if !pw.is_null() && !(*pw).pw_shell.is_null() {
            if let Ok(s) = std::ffi::CStr::from_ptr((*pw).pw_shell).to_str() {
                candidates.push(s.to_string());
            }
        }
    }
    candidates.push("/bin/zsh".into());
    candidates.push("/bin/bash".into());
    candidates.into_iter().find(|c| !c.is_empty() && std::path::Path::new(c).exists()).unwrap_or_else(|| "/bin/sh".into())
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// The folder a new session starts in. The one asked for can be gone by now
/// — deleted from another pane, an unmounted volume — and a spawn into a
/// missing folder would leave the pane dead, so home stands in.
fn resolve_cwd(requested: Option<&str>) -> PathBuf {
    if let Some(r) = requested.filter(|r| r.starts_with('/')) {
        let p = PathBuf::from(r);
        if p.is_dir() {
            return p;
        }
    }
    home()
}

impl Session {
    pub fn spawn(
        columns: usize,
        lines: usize,
        cwd: Option<&str>,
        theme: Arc<RwLock<(TerminalTheme, u32)>>,
    ) -> anyhow::Result<Session> {
        let columns = columns.max(2);
        let lines = lines.max(1);
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: lines as u16, cols: columns as u16, pixel_width: 0, pixel_height: 0 })
            .context("openpty")?;

        let shell = user_shell();
        let mut cmd = CommandBuilder::new(&shell);
        // A LOGIN shell. A non-login zsh skips /etc/zprofile and ~/.zprofile,
        // which on macOS is where PATH is actually built (path_helper, `brew
        // shellenv`) — miss them and docker, brew, rvm are "command not
        // found" even though the same command works in Terminal.app.
        cmd.arg("-l");
        cmd.cwd(resolve_cwd(cwd));
        cmd.env("TERM", "xterm-256color");
        // Colour is off by default in most tools, which is why a fresh
        // terminal looks so grey; truecolor is advertised because tools like
        // OpenCode degrade to 256 colours without it.
        cmd.env("CLICOLOR", "1");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "mesa");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        cmd.env("LSCOLORS", "DxGxcxdxCxegedabagacad");
        cmd.env("LS_COLORS", "di=1;33:ln=1;36:so=32:pi=33:ex=32:bd=34;46:cd=34;43:su=30;41:sg=30;46:tw=30;42:ow=30;43");
        cmd.env("GREP_COLORS", "mt=1;33");
        // An app opened from the Finder gets no locale at all, and a shell
        // without one prints every multibyte character as escapes — a Turkish
        // file name comes out as <C4><B1>. Only filled in when nothing set it.
        if ["LC_ALL", "LC_CTYPE", "LANG"].iter().all(|k| std::env::var_os(k).is_none()) {
            cmd.env("LANG", "en_US.UTF-8");
        }
        // For zsh, ZDOTDIR points at the bootstrap, which restores the user's
        // real ZDOTDIR before their own dotfiles load and adds the prompt
        // markers and line reports additively.
        if std::path::Path::new(&shell).file_name().and_then(|n| n.to_str()) == Some("zsh") {
            if let Some(hooks) = crate::storage::shell_hooks_dir() {
                let real = std::env::var("ZDOTDIR").unwrap_or_else(|_| home().to_string_lossy().to_string());
                cmd.env("ZDOTDIR", hooks);
                cmd.env("WFTERM_REAL_ZDOTDIR", real);
            }
        }

        let mut child = pair.slave.spawn_command(cmd).context("spawn shell")?;
        drop(pair.slave);
        let pid = child.process_id().map(|p| p as i32);
        let mut reader = pair.master.try_clone_reader().context("pty reader")?;
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer().context("pty writer")?));

        let pending = Arc::new(Mutex::new(Vec::new()));
        let size = GridSize { columns, lines };
        let config = Config { scrolling_history: SCROLLBACK, ..Config::default() };
        let term = Term::new(config, &size, Listener { pending: pending.clone() });
        let shared = Arc::new(Mutex::new(Shared { term, blocks: Vec::new(), alt: false, cell_width: 8.0, cell_height: 16.0 }));

        let (tx, rx) = smol::channel::unbounded();
        let output_pending = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));

        {
            let shared = shared.clone();
            let writer = writer.clone();
            let output_pending = output_pending.clone();
            let alive = alive.clone();
            std::thread::Builder::new()
                .name("mesa-pty".into())
                .spawn(move || {
                    let mut reader_state = ReaderState::default();
                    let mut parser: ansi::Processor = ansi::Processor::new();
                    let mut scanner = Scanner::new();
                    let mut buf = vec![0u8; 64 * 1024];
                    loop {
                        let n = match reader.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => n,
                        };
                        let pieces = scanner.feed(&buf[..n]);
                        let mut guard = shared.lock();
                        for piece in pieces {
                            match piece {
                                Piece::Bytes(bytes) => {
                                    parser.advance(&mut guard.term, &bytes);
                                    let alt = guard.term.mode().contains(TermMode::ALT_SCREEN);
                                    if alt != guard.alt {
                                        guard.alt = alt;
                                        let _ = tx.try_send(SessionEvent::Tui(alt));
                                    }
                                }
                                Piece::Osc(code, data) => {
                                    reader_state.osc(&mut guard, code, &data, &tx);
                                }
                            }
                        }
                        let events: Vec<Event> = std::mem::take(&mut *pending.lock());
                        for event in events {
                            answer(&guard, event, &writer, &theme, &tx);
                        }
                        drop(guard);
                        if !output_pending.swap(true, Ordering::AcqRel) {
                            let _ = tx.try_send(SessionEvent::Output);
                        }
                    }
                    alive.store(false, Ordering::Release);
                    let _ = child.wait();
                    let _ = tx.try_send(SessionEvent::Exited);
                })
                .context("pty thread")?;
        }

        Ok(Session {
            shared,
            writer,
            master: Mutex::new(pair.master),
            pid,
            events: rx,
            output_pending,
            alive,
            size: Mutex::new(size),
        })
    }

    pub fn write(&self, bytes: &[u8]) {
        if !self.alive.load(Ordering::Acquire) {
            return;
        }
        let mut w = self.writer.lock();
        let _ = w.write_all(bytes);
        let _ = w.flush();
    }

    pub fn write_str(&self, s: &str) {
        self.write(s.as_bytes())
    }

    pub fn resize(&self, columns: usize, lines: usize, cell_width: f32, cell_height: f32) {
        let columns = columns.max(2);
        let lines = lines.max(1);
        {
            let mut s = self.size.lock();
            if s.columns == columns && s.lines == lines {
                let mut g = self.shared.lock();
                g.cell_width = cell_width;
                g.cell_height = cell_height;
                return;
            }
            *s = GridSize { columns, lines };
        }
        let _ = self.master.lock().resize(PtySize {
            rows: lines as u16,
            cols: columns as u16,
            pixel_width: (columns as f32 * cell_width) as u16,
            pixel_height: (lines as f32 * cell_height) as u16,
        });
        let mut g = self.shared.lock();
        g.cell_width = cell_width;
        g.cell_height = cell_height;
        g.term.resize(GridSize { columns, lines });
    }

    /// Kills the whole process group the pty spawned — the shell AND
    /// anything it launched, a dev server say — not just the shell, whose
    /// children would otherwise survive as orphans.
    pub fn kill(&self) {
        let Some(pid) = self.pid else { return };
        unsafe {
            if libc::killpg(pid, libc::SIGHUP) != 0 {
                libc::kill(pid, libc::SIGHUP);
            }
        }
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            unsafe {
                libc::killpg(pid, libc::SIGKILL);
            }
        });
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Answers what the emulator asks of the host: colour probes (OSC 4/10/11 —
/// OpenCode dresses itself from these), size reports, text the terminal
/// wants written back, a title, a clipboard store.
fn answer(
    shared: &Shared,
    event: Event,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    theme: &Arc<RwLock<(TerminalTheme, u32)>>,
    tx: &smol::channel::Sender<SessionEvent>,
) {
    let reply = |s: String| {
        let mut w = writer.lock();
        let _ = w.write_all(s.as_bytes());
        let _ = w.flush();
    };
    match event {
        Event::PtyWrite(text) => reply(text),
        Event::ColorRequest(index, format) => {
            let rgb = shared.term.colors()[index].unwrap_or_else(|| {
                let (palette, accent) = &*theme.read();
                to_rgb(palette_color(palette, *accent, index))
            });
            reply(format(rgb));
        }
        Event::TextAreaSizeRequest(format) => {
            let size = WindowSize {
                num_lines: shared.term.screen_lines() as u16,
                num_cols: shared.term.columns() as u16,
                cell_width: shared.cell_width as u16,
                cell_height: shared.cell_height as u16,
            };
            reply(format(size));
        }
        Event::ClipboardStore(_, text) => {
            let _ = tx.try_send(SessionEvent::Clipboard(text));
        }
        _ => {}
    }
}

fn to_rgb(c: u32) -> Rgb {
    Rgb { r: (c >> 16) as u8, g: (c >> 8) as u8, b: c as u8 }
}

/// The colour at an xterm palette index: the sixteen from the theme, then
/// the 6×6×6 cube and the grey ramp, then the named slots.
pub fn palette_color(theme: &TerminalTheme, accent: u32, index: usize) -> u32 {
    match index {
        0..=15 => theme.ansi[index],
        16..=231 => {
            let i = index - 16;
            let step = |v: usize| if v == 0 { 0 } else { (v * 40 + 55) as u32 };
            (step(i / 36) << 16) | (step((i / 6) % 6) << 8) | step(i % 6)
        }
        232..=255 => {
            let v = ((index - 232) * 10 + 8) as u32;
            (v << 16) | (v << 8) | v
        }
        i if i == NamedColor::Foreground as usize => theme.foreground,
        i if i == NamedColor::Background as usize => theme.background,
        i if i == NamedColor::Cursor as usize => accent,
        _ => theme.foreground,
    }
}

/// What the reader thread remembers between OSC 133 markers.
#[derive(Default)]
struct ReaderState {
    /// zsh runs precmd before EVERY prompt, including a bare Enter, so a
    /// divider keyed off D alone landed under every row ever entered on. Only
    /// a C since the last D says a real command ran.
    saw_command: bool,
    /// The row the last prompt started on, to be lit once a command is
    /// submitted from it.
    prompt_line: Option<i64>,
}

impl ReaderState {
    fn osc(&mut self, shared: &mut Shared, code: u32, data: &str, tx: &smol::channel::Sender<SessionEvent>) {
        match code {
            OSC_CWD => {
                if let Some(dir) = parse_cwd(data) {
                    let _ = tx.try_send(SessionEvent::Cwd(dir));
                }
            }
            OSC_LINE => {
                // A TUI owns the whole screen and has no shell line behind it.
                if !shared.alt {
                    let _ = tx.try_send(SessionEvent::Line(parse_zle_osc(data)));
                }
            }
            OSC_PROMPT => match parse_prompt_mark(data) {
                PromptMark::PromptStart => {
                    // Nothing is marked while a TUI owns the screen: a TUI that
                    // speaks OSC 133 itself would lay a band across its output.
                    self.prompt_line = (!shared.alt).then(|| shared.cursor_absolute());
                    let _ = tx.try_send(SessionEvent::PromptStart);
                }
                PromptMark::CommandStart => {
                    self.saw_command = true;
                    if let Some(line) = self.prompt_line.take() {
                        push_block(shared, Block { line, kind: BlockKind::Row });
                    }
                    let _ = tx.try_send(SessionEvent::CommandStart);
                }
                PromptMark::CommandEnd(code) => {
                    if !self.saw_command {
                        return;
                    }
                    self.saw_command = false;
                    let _ = tx.try_send(SessionEvent::CommandEnd(code));
                    // At D-time the cursor sits on the row the next prompt is
                    // about to be drawn on, so the rule lands directly under
                    // the finished command's output.
                    if !shared.alt {
                        let line = shared.cursor_absolute();
                        push_block(shared, Block { line, kind: BlockKind::Rule { ok: code == 0 } });
                    }
                }
                PromptMark::Other => {}
            },
            _ => {}
        }
    }
}

fn push_block(shared: &mut Shared, block: Block) {
    shared.blocks.push(block);
    // A block whose row has fallen out of the scrollback marks nothing.
    let top = 0i64;
    shared.blocks.retain(|b| b.line >= top);
    if shared.blocks.len() > 4 * SCROLLBACK {
        shared.blocks.drain(..SCROLLBACK);
    }
}

/// The viewport row an absolute line is on right now, if it is on screen.
pub fn visible_row(shared: &Shared, line: i64) -> Option<usize> {
    let grid = shared.term.grid();
    let row = line - grid.history_size() as i64 + grid.display_offset() as i64;
    (row >= 0 && row < grid.screen_lines() as i64).then_some(row as usize)
}

/// A viewport cell → the grid point under it.
pub fn grid_point(shared: &Shared, row: usize, col: usize) -> Point {
    let grid = shared.term.grid();
    let col = col.min(grid.columns().saturating_sub(1));
    Point::new(Line(row as i32 - grid.display_offset() as i32), Column(col))
}
