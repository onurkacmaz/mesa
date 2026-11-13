//! Everything a completion needs from outside the line itself: the files in
//! a directory, the executables on PATH, the branches in a repository, the
//! scripts in a package.json, the hosts in an ssh config, the shell's own
//! history, and the shipped command schemas.
//!
//! Every one of these is slow enough that doing it per keystroke would stall
//! the pane, so each is cached, keyed by the directory the pane is in, and
//! all of it runs off the UI thread.
//!
//! A generator is chosen by NAME from the table in `candidates`. Nothing in a
//! schema reaches this code as a command, an argument or a path.

use std::{
    collections::HashMap,
    fs,
    path::Path,
    process::Command,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use mesa_core::{
    rank::{match_score, Candidate, Source},
    schema::Node,
    zsh_history::{parse_zsh_history, unmetafy},
};

include!(concat!(env!("OUT_DIR"), "/schemas.rs"));

/// Long enough that a burst of typing costs one read, short enough that a
/// branch you just created shows up without restarting anything.
const TTL: Duration = Duration::from_secs(5);

/// How many candidates go to the ranker for one keystroke: well past the
/// eight the list shows, far short of the thousands PATH would otherwise send.
const WIRE_LIMIT: usize = 200;

/// How many entries are worth stat-ing for their modification time.
const STAT_LIMIT: usize = 400;

/// Directories that are almost never what you meant to type. Still offered,
/// but with no use behind them, which puts them last.
const NOISE: &[&str] =
    &["node_modules", "dist", "build", "release", "target", "vendor", "coverage", "__pycache__", ".next", "Pods"];

type Cache = Mutex<HashMap<String, (Instant, Arc<Vec<Candidate>>)>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn cached(key: String, produce: impl FnOnce() -> Option<Vec<Candidate>>) -> Arc<Vec<Candidate>> {
    if let Some((at, value)) = cache().lock().unwrap().get(&key) {
        if at.elapsed() < TTL {
            return value.clone();
        }
    }
    // A source that cannot answer — a folder gone, a repository that is not
    // one — offers nothing. It must never take the pane down with it.
    let value = Arc::new(produce().unwrap_or_default());
    cache().lock().unwrap().insert(key, (Instant::now(), value.clone()));
    value
}

fn mtime_secs(path: &Path) -> Option<i64> {
    let m = fs::metadata(path).ok()?.modified().ok()?;
    Some(m.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64)
}

fn entries(cwd: &str, directories_only: bool) -> Option<Vec<Candidate>> {
    let mut out = Vec::new();
    for e in fs::read_dir(cwd).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false)
            || (e.file_type().map(|t| t.is_symlink()).unwrap_or(false) && e.path().is_dir());
        if directories_only && !is_dir {
            continue;
        }
        if out.len() >= STAT_LIMIT {
            break;
        }
        let value = if is_dir { format!("{name}/") } else { name.clone() };
        let mut c = Candidate::new(value, Source::File);
        // Count 0 for the noise: the ranking reads it as "no use behind
        // this" and puts it last. Modification time for everything else —
        // what you touched an hour ago is what you are about to name.
        if NOISE.contains(&name.as_str()) {
            c.count = Some(0);
        } else {
            c.count = Some(1);
            c.at = mtime_secs(&e.path());
        }
        out.push(c);
    }
    Some(out)
}

fn git_branches(cwd: &str) -> Option<Vec<Candidate>> {
    let out = Command::new("git")
        .args(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])
        .current_dir(cwd)
        .output()
        .ok()?;
    Some(
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| Candidate::new(l, Source::Schema))
            .collect(),
    )
}

fn npm_scripts(cwd: &str) -> Option<Vec<Candidate>> {
    let text = fs::read_to_string(Path::new(cwd).join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(
        json.get("scripts")?
            .as_object()?
            .iter()
            .map(|(k, v)| Candidate::new(k.clone(), Source::Schema).described(v.as_str().unwrap_or_default()))
            .collect(),
    )
}

fn ssh_hosts() -> Option<Vec<Candidate>> {
    let text = fs::read_to_string(dirs::home_dir()?.join(".ssh/config")).ok()?;
    let mut hosts = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.get(..5).filter(|h| h.eq_ignore_ascii_case("host ")).map(|_| &trimmed[5..]) else {
            continue;
        };
        // A pattern is not a host you can connect to.
        for name in rest.split_whitespace() {
            if !name.contains('*') && !name.contains('?') {
                hosts.push(Candidate::new(name, Source::Schema));
            }
        }
    }
    Some(hosts)
}

fn path_executables() -> Option<Vec<Candidate>> {
    let path = std::env::var("PATH").ok()?;
    let mut names = std::collections::BTreeSet::new();
    for dir in path.split(':').filter(|d| !d.is_empty()) {
        // A PATH entry that does not exist is normal, not an error.
        let Ok(found) = fs::read_dir(dir) else { continue };
        for e in found.flatten() {
            names.insert(e.file_name().to_string_lossy().to_string());
        }
    }
    Some(names.into_iter().map(|n| Candidate::new(n, Source::Path)).collect())
}

/// Built once and kept. Commands run inside Mesa are added by
/// `remember_command`, and the file itself only grows.
fn history_cache() -> &'static Mutex<Option<Vec<Candidate>>> {
    static H: OnceLock<Mutex<Option<Vec<Candidate>>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(None))
}

fn history() -> Vec<Candidate> {
    let mut guard = history_cache().lock().unwrap();
    if guard.is_none() {
        let file = std::env::var("HISTFILE")
            .ok()
            .map(Into::into)
            .or_else(|| dirs::home_dir().map(|h| h.join(".zsh_history")));
        // Read as BYTES and unmetafied, not decoded: zsh writes this file in
        // its own metafied encoding and neither obvious decoding survives it.
        *guard = Some(file.and_then(|f| fs::read(f).ok()).map(|b| parse_zsh_history(&unmetafy(&b))).unwrap_or_default());
    }
    guard.clone().unwrap_or_default()
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// A command just run in this app, put at the front of the history it
/// offers. zsh writes it to the file on its own schedule — usually when the
/// shell exits — so without this what you ran a moment ago would not be
/// offered until the app was restarted. The file itself is never written.
pub fn remember_command(command: &str) {
    if command.trim().is_empty() {
        return;
    }
    let mut guard = history_cache().lock().unwrap();
    let Some(list) = guard.as_mut() else { return };
    let at = list.iter().position(|e| e.value == command);
    // Running it again is one more run of the same command.
    let count = at.map(|i| list[i].count.unwrap_or(1) + 1).unwrap_or(1);
    if let Some(i) = at {
        list.remove(i);
    }
    let newest = list.last().and_then(|e| e.recency).unwrap_or(0.0) + 1.0;
    let mut c = Candidate::new(command, Source::History);
    c.recency = Some(newest);
    c.count = Some(count);
    c.at = Some(now());
    c.freshness = Some(1.0);
    list.push(c);
}

/// The cut is by SCORE, not by whoever the directory scan happened to reach
/// first: a case-exact match must never be pushed out by two hundred
/// case-insensitive ones.
fn filter_for_wire(all: &[Candidate], prefix: &str) -> Vec<Candidate> {
    if prefix.is_empty() {
        return all.iter().take(WIRE_LIMIT).cloned().collect();
    }
    let mut scored: Vec<(u8, &Candidate)> =
        all.iter().filter_map(|c| match_score(&c.value, prefix).map(|s| (s, c))).collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.into_iter().take(WIRE_LIMIT).map(|(_, c)| c.clone()).collect()
}

/// The folder a request is answered in: the pane's own, if it still exists.
pub fn resolve_cwd(cwd: Option<&str>) -> String {
    if let Some(c) = cwd.filter(|c| c.starts_with('/')) {
        if Path::new(c).is_dir() {
            return c.to_string();
        }
    }
    dirs::home_dir().map(|h| h.to_string_lossy().to_string()).unwrap_or_else(|| "/".into())
}

/// The whole table. A generator name that is not here resolves to nothing,
/// which is what keeps a schema from reaching anything it likes.
pub fn candidates(cwd: Option<&str>, generator: &str, prefix: &str) -> Vec<Candidate> {
    let cwd = resolve_cwd(cwd);
    let all: Arc<Vec<Candidate>> = match generator {
        "files" => cached(format!("files:{cwd}"), || entries(&cwd, false)),
        "directories" => cached(format!("dirs:{cwd}"), || entries(&cwd, true)),
        "git-branches" => cached(format!("branches:{cwd}"), || git_branches(&cwd)),
        "npm-scripts" => cached(format!("scripts:{cwd}"), || npm_scripts(&cwd)),
        "ssh-hosts" => cached("ssh".into(), ssh_hosts),
        "path" => cached("path".into(), path_executables),
        "history" => Arc::new(history()),
        _ => return Vec::new(),
    };
    filter_for_wire(&all, prefix)
}

/// One command's schema, parsed the first time that command is typed and
/// kept after that — including the misses, since a command with no schema is
/// the common case and must not cost a lookup on every keystroke.
pub fn command_schema(command: &str) -> Option<Arc<Node>> {
    static PARSED: OnceLock<Mutex<HashMap<String, Option<Arc<Node>>>>> = OnceLock::new();
    // The name came from a shell's report of what someone typed.
    if command.is_empty() || command.len() > 64 || !command.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return None;
    }
    let map = PARSED.get_or_init(Default::default);
    if let Some(hit) = map.lock().unwrap().get(command) {
        return hit.clone();
    }
    let parsed = SCHEMAS
        .binary_search_by(|(name, _)| (*name).cmp(command))
        .ok()
        .and_then(|i| serde_json::from_str::<Node>(SCHEMAS[i].1).ok())
        .map(Arc::new);
    map.lock().unwrap().insert(command.to_string(), parsed.clone());
    parsed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schemas_are_compiled_in_and_sorted() {
        assert!(SCHEMAS.len() > 400);
        assert!(SCHEMAS.windows(2).all(|w| w[0].0 < w[1].0));
        assert!(command_schema("git").is_some());
        assert!(command_schema("definitely-not-a-command").is_none());
        assert!(command_schema("../etc/passwd").is_none());
    }

    #[test]
    fn an_unknown_generator_offers_nothing() {
        assert!(candidates(Some("/"), "rm -rf", "").is_empty());
    }

    #[test]
    fn the_wire_cut_keeps_exact_matches() {
        let mut all: Vec<Candidate> = (0..300).map(|i| Candidate::new(format!("Ab{i}"), Source::Path)).collect();
        all.push(Candidate::new("ab", Source::Path));
        let out = filter_for_wire(&all, "ab");
        assert_eq!(out.len(), WIRE_LIMIT);
        assert_eq!(out[0].value, "ab");
    }
}
