//! What a closed app remembers, and the rules for trusting it again.
//!
//! Everything here is pure: it takes whatever was on disk — which may be
//! half-written, hand-edited, or from a version that no longer exists — and
//! returns either a session this app can be built from or nothing at all.
//! Nothing in this file touches the filesystem or the UI, so the one part of
//! persistence that can silently ruin a launch is also the part that is
//! directly testable.
//!
//! The governing rule is that a bad file must never cost more than the layout
//! it was holding. An app that will not open is a far worse failure than an
//! app that opens empty, so every check here fails toward empty rather than
//! toward a panic.
//!
//! The file format is the one the Electron build wrote, field for field, so a
//! layout saved by v1.x opens in this build unchanged.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const SESSION_VERSION: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "lowercase")]
pub enum PaneKind {
    Terminal,
    Browser,
}

impl PaneKind {
    pub fn is_browser(self) -> bool {
        self == PaneKind::Browser
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pan {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct View {
    pub zoom: f64,
    pub pan: Pan,
}

impl Default for View {
    fn default() -> Self {
        View { zoom: 1.0, pan: Pan { x: 0.0, y: 0.0 } }
    }
}

/// One session inside a pane: a terminal with a folder and a command, or a
/// browser on an address. The pane is the box they sit in, and the box holds
/// any number of them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub title_locked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pane {
    pub id: String,
    pub kind: PaneKind,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z: f64,
    pub tabs: Vec<Tab>,
    pub active_tab_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub view: View,
    pub panes: Vec<Pane>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub version: u32,
    pub active_workflow_id: String,
    #[serde(default)]
    pub counters: Map<String, Value>,
    pub workflows: Vec<Workflow>,
}

/// Everything a terminal would act on rather than display: returns, escape,
/// every other C0, and DEL. Public because the same strip has to happen where
/// a command is entered — a paste carries whatever was on the clipboard, and a
/// single-line input does not stop it.
pub fn strip_controls(text: &str) -> String {
    text.chars()
        .filter(|&c| !((c as u32) < 0x20 || c as u32 == 0x7f))
        .collect::<String>()
        .trim()
        .to_string()
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn text(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// A count read from a file is a hint, not a promise: it is corrected against
/// the ids actually present, so a stale or edited number can never hand out
/// an id that is already taken.
fn count_of(v: Option<&Value>) -> u64 {
    match num(v) {
        Some(n) if n >= 0.0 => n.floor() as u64,
        _ => 0,
    }
}

/// `term-12` → 12. The id scheme is a prefix and a run of digits; anything
/// else contributes nothing and is simply passed over.
pub fn trailing_number(id: &str) -> u64 {
    let digits: String = id.chars().rev().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return 0;
    }
    let start = id.len() - digits.len();
    if start == 0 || id.as_bytes()[start - 1] != b'-' {
        return 0;
    }
    digits.chars().rev().collect::<String>().parse().unwrap_or(0)
}

/// The same idea for a default title ("Terminal 4"), which is numbered by a
/// different counter and separated by a space rather than a hyphen. A renamed
/// pane usually ends in no digits at all and contributes nothing, which is
/// correct: its number is no longer the one the counter handed out.
fn trailing_count(text: &str) -> u64 {
    let digits: String = text.chars().rev().take_while(|c| c.is_ascii_digit()).collect();
    digits.chars().rev().collect::<String>().parse().unwrap_or(0)
}

fn normalize_view(raw: Option<&Value>) -> View {
    let zoom = num(raw.and_then(|r| r.get("zoom"))).filter(|z| *z > 0.0).unwrap_or(1.0);
    let pan = raw.and_then(|r| r.get("pan"));
    let x = num(pan.and_then(|p| p.get("x"))).unwrap_or(0.0);
    let y = num(pan.and_then(|p| p.get("y"))).unwrap_or(0.0);
    View { zoom, pan: Pan { x, y } }
}

fn is_http(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn normalize_tab(raw: &Value, kind: PaneKind) -> Option<Tab> {
    let id = text(raw.get("id"))?;
    let title = text(raw.get("title"))
        .map(str::to_string)
        .unwrap_or_else(|| if kind.is_browser() { "Browser" } else { "Terminal" }.to_string());
    let mut tab = Tab {
        id: id.to_string(),
        title,
        // A name the user typed sticks; one derived from the folder or the
        // page keeps following what is in the session.
        title_locked: raw.get("titleLocked") == Some(&Value::Bool(true)),
        cwd: None,
        command: None,
        url: None,
    };
    // The folder a terminal was last sitting in, and the page a browser was
    // last on. Absent is normal, so neither is worth failing over.
    if kind == PaneKind::Terminal {
        if let Some(cwd) = text(raw.get("cwd")) {
            tab.cwd = Some(cwd.to_string());
        }
        // The startup command is submitted at the tab's prompt on open, so
        // what is stored here has to be exactly one line: an embedded return
        // would run a second command nobody typed, and this file is plain
        // text that anything could have edited. Every C0 goes, not just the
        // returns, so one stored command can only ever be one command.
        if let Some(command) = text(raw.get("command")) {
            let command = strip_controls(command);
            if !command.is_empty() {
                tab.command = Some(command);
            }
        }
    }
    // http(s) only. A saved address is replayed into a page on launch with no
    // one watching, so the one scheme a browser tab can be opened on is the
    // one a browser tab can reach by itself.
    if kind == PaneKind::Browser {
        if let Some(url) = text(raw.get("url")).filter(|u| is_http(u)) {
            tab.url = Some(url.to_string());
        }
    }
    Some(tab)
}

fn normalize_pane(raw: &Value, seen_tab_ids: &mut HashSet<String>) -> Option<Pane> {
    let id = text(raw.get("id"))?;
    let kind = match raw.get("kind").and_then(Value::as_str) {
        Some("browser") => PaneKind::Browser,
        _ => PaneKind::Terminal,
    };
    let x = num(raw.get("x"))?;
    let y = num(raw.get("y"))?;
    // A pane with no size is a pane you cannot find again. Rather than guess a
    // box for it, drop it: the rest of the workflow is still worth restoring.
    let width = num(raw.get("width")).filter(|w| *w > 0.0)?;
    let height = num(raw.get("height")).filter(|h| *h > 0.0)?;

    let mut tabs = Vec::new();
    for candidate in raw.get("tabs").and_then(Value::as_array).into_iter().flatten() {
        // Tab ids come off the same counter pane ids do, so a duplicate would
        // put two live sessions on one id — one terminal's keystrokes
        // arriving in another's pty.
        let Some(tab) = normalize_tab(candidate, kind) else { continue };
        if !seen_tab_ids.insert(tab.id.clone()) {
            continue;
        }
        tabs.push(tab);
    }
    // A pane with no sessions left in it is an empty box: there is nothing to
    // restore and nothing to look at.
    if tabs.is_empty() {
        return None;
    }

    let wanted = raw.get("activeTabId").and_then(Value::as_str);
    let active_tab_id = match wanted {
        Some(w) if tabs.iter().any(|t| t.id == w) => w.to_string(),
        _ => tabs[0].id.clone(),
    };

    Some(Pane {
        id: id.to_string(),
        kind,
        x,
        y,
        width,
        height,
        z: num(raw.get("z")).unwrap_or(1.0),
        tabs,
        active_tab_id,
    })
}

/// A workflow written by v1.3.0 or earlier also carries a `connections`
/// array — the ropes that used to be drawn between panes. It is passed over
/// rather than migrated: nothing reads it any more, and an old file costs at
/// most what it was holding, never the launch.
fn normalize_workflow(
    raw: &Value,
    seen_pane_ids: &mut HashSet<String>,
    seen_tab_ids: &mut HashSet<String>,
) -> Option<Workflow> {
    let id = text(raw.get("id"))?;
    let mut panes = Vec::new();
    for candidate in raw.get("panes").and_then(Value::as_array).into_iter().flatten() {
        // Pane ids are handed out from one counter shared by every workflow,
        // so a duplicate is not a local collision — it would put two panes in
        // the app answering to the same terminal session.
        let Some(pane) = normalize_pane(candidate, seen_tab_ids) else { continue };
        if !seen_pane_ids.insert(pane.id.clone()) {
            continue;
        }
        panes.push(pane);
    }
    Some(Workflow {
        id: id.to_string(),
        name: text(raw.get("name")).unwrap_or("Workflow").to_string(),
        view: normalize_view(raw.get("view")),
        panes,
    })
}

/// Version 1 knew nothing about tabs: a pane WAS a session, and carried the
/// folder, the address and the startup command itself. Version 2 turns the
/// pane into a box, so each of those panes becomes a box holding exactly the
/// one session it already was.
///
/// The tab keeps the pane's id. In v1 that id was the terminal's id — it is
/// what the pty, the title, the folder and the address were all keyed by — so
/// handing it to the tab is the same session keeping its name.
fn migrate_v1(raw: &Value) -> Value {
    let mut out = raw.clone();
    out["version"] = Value::from(SESSION_VERSION);
    let workflows: Vec<Value> = raw
        .get("workflows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut workflow| {
            let panes: Vec<Value> = workflow
                .get("panes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|mut pane| {
                    let mut tab = Map::new();
                    for key in ["id", "title", "titleLocked", "cwd", "url", "command"] {
                        if let Some(v) = pane.get(key) {
                            tab.insert(key.to_string(), v.clone());
                        }
                    }
                    let id = pane.get("id").cloned().unwrap_or(Value::Null);
                    if pane.is_object() {
                        pane["tabs"] = Value::Array(vec![Value::Object(tab)]);
                        pane["activeTabId"] = id;
                    }
                    pane
                })
                .collect();
            if workflow.is_object() {
                workflow["panes"] = Value::Array(panes);
            }
            workflow
        })
        .collect();
    out["workflows"] = Value::Array(workflows);
    out
}

/// The only entry point. Returns a session that is safe to build the app
/// from, or `None` — meaning "start as if there were no file", which is also
/// what a first launch does. Callers never have to tell those two apart.
pub fn normalize_session(input: &Value) -> Option<Session> {
    if !input.is_object() {
        return None;
    }
    let migrated;
    let raw = if num(input.get("version")) == Some(1.0) {
        migrated = migrate_v1(input);
        &migrated
    } else {
        input
    };
    if num(raw.get("version")) != Some(SESSION_VERSION as f64) {
        return None;
    }
    let list = raw.get("workflows")?.as_array()?;

    let mut seen_pane_ids = HashSet::new();
    let mut seen_tab_ids = HashSet::new();
    let mut workflow_ids = HashSet::new();
    let mut workflows = Vec::new();
    for candidate in list {
        let Some(workflow) = normalize_workflow(candidate, &mut seen_pane_ids, &mut seen_tab_ids)
        else {
            continue;
        };
        if !workflow_ids.insert(workflow.id.clone()) {
            continue;
        }
        workflows.push(workflow);
    }

    // No workflows left is indistinguishable from no file: either way the app
    // opens the way it always has, with one empty workflow.
    if workflows.is_empty() {
        return None;
    }

    let active_workflow_id = match raw.get("activeWorkflowId").and_then(Value::as_str) {
        Some(id) if workflow_ids.contains(id) => id.to_string(),
        _ => workflows[0].id.clone(),
    };

    let counters = raw.get("counters").and_then(Value::as_object).cloned().unwrap_or_default();

    Some(Session { version: SESSION_VERSION, active_workflow_id, counters, workflows })
}

/// Parses text off the disk. Unparseable text is `Err`, so the caller can
/// tell "nothing usable" (archive it) from "not JSON at all" (also archive
/// it) from "no file" (which never reaches here).
pub fn parse_session(text: &str) -> Result<Option<Session>, serde_json::Error> {
    let value: Value = serde_json::from_str(text)?;
    Ok(normalize_session(&value))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CounterSeeds {
    pub pane: u64,
    pub workflow: u64,
    pub session: u64,
    pub z: u64,
}

/// Where the id counters have to resume from. They start at zero every
/// launch, so without this a restored `term-3` is followed by a freshly
/// minted `term-1` — two panes, one id, one terminal session between them.
///
/// Derived from the restored ids themselves and only then raised by whatever
/// the file claims, so the seeds hold even if the counters block is stale,
/// missing, or edited down by hand.
pub fn counter_seeds_from(session: &Session) -> CounterSeeds {
    let c = &session.counters;
    let mut seeds = CounterSeeds {
        pane: count_of(c.get("pane")),
        workflow: count_of(c.get("workflow")),
        // Session numbers only name panes ("Terminal 4"), so a low seed costs
        // a confusing duplicate name rather than a collision.
        session: count_of(c.get("session")),
        z: 1,
    };
    for workflow in &session.workflows {
        seeds.workflow = seeds.workflow.max(trailing_number(&workflow.id));
        for pane in &workflow.panes {
            seeds.pane = seeds.pane.max(trailing_number(&pane.id));
            if pane.z.is_finite() && pane.z > seeds.z as f64 {
                seeds.z = pane.z.ceil() as u64;
            }
            // Tabs are numbered off the same counter as panes, so a seed that
            // only cleared the pane ids would hand the next tab an id a live
            // session is already answering to.
            for tab in &pane.tabs {
                seeds.pane = seeds.pane.max(trailing_number(&tab.id));
                seeds.session = seeds.session.max(trailing_count(&tab.title));
            }
        }
    }
    seeds
}
