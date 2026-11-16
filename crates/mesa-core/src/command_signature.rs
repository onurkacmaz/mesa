//! Turning one of Warp's command signatures into a schema this app can use.
//!
//! The signatures come from warpdotdev/command-signatures (MIT), which is the
//! Fig spec format. Two reasons they cannot be used as they are.
//!
//! They carry CODE: `generators`, `script`, `postProcess`, `generateSpec` and
//! `loadSpec` are JavaScript meant to be evaluated by the host. Every one of
//! those fields is dropped here. A spec can ask for a generator BY NAME and
//! nothing else, and the name has to be one this app implements.
//!
//! And they are enormous — 498 specs, 31MB — because every option carries its
//! full manual-page description. The list shows one line, so descriptions are
//! cut to fit it.

use serde_json::{json, Map, Value};

const DESCRIPTION_MAX: usize = 80;
const SUGGESTIONS_MAX: usize = 60;

/// Fig's argument templates mapped onto the generators this app has.
fn template(name: &str) -> Option<&'static str> {
    Some(match name {
        "filepaths" | "filepathsMayNotExist" => "files",
        "folders" | "foldersMayNotExist" => "directories",
        _ => return None,
    })
}

/// The handful of Warp generator names with a real equivalent here.
fn generator(name: &str) -> Option<&'static str> {
    Some(match name {
        "local_branches" | "branches" | "remote_branches" | "refs_remote_branches"
        | "local_or_remote_branch" | "local_and_remote_branches" | "search_branches"
        | "push_refspec_branches" => "git-branches",
        "get_scripts_generator" => "npm-scripts",
        "hosts" | "known_hosts" => "ssh-hosts",
        "files_for_staging" | "tracked_files" | "get_changed_or_tracked_files" | "remote_paths" => "files",
        "entry_dirs" => "directories",
        _ => return None,
    })
}

fn shorten(description: Option<&Value>) -> String {
    let Some(d) = description.and_then(Value::as_str) else { return String::new() };
    let one_line = d.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= DESCRIPTION_MAX {
        return one_line;
    }
    let cut: String = one_line.chars().take(DESCRIPTION_MAX - 1).collect();
    format!("{}…", cut.trim_end())
}

fn names(node: &Value) -> Vec<String> {
    match node.get("name") {
        Some(Value::String(s)) if !s.is_empty() => vec![s.clone()],
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(String::from).collect(),
        _ => Vec::new(),
    }
}

fn name_value(names: Vec<String>) -> Value {
    if names.len() == 1 {
        Value::String(names.into_iter().next().unwrap())
    } else {
        json!(names)
    }
}

fn first_arg(args: Option<&Value>) -> Option<&Value> {
    match args? {
        Value::Array(a) => a.first(),
        other => Some(other),
    }
}

fn as_list(v: Option<&Value>) -> Vec<&str> {
    match v {
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

fn suggestions_for(args: Option<&Value>) -> Option<Value> {
    let raw = first_arg(args)?.get("suggestions")?.as_array()?;
    let mut out = Vec::new();
    for item in raw {
        let name = match item {
            Value::String(s) => Some(s.as_str()),
            other => match other.get("name") {
                Some(Value::String(s)) => Some(s.as_str()),
                Some(Value::Array(a)) => a.first().and_then(Value::as_str),
                _ => None,
            },
        };
        let Some(name) = name.filter(|n| !n.is_empty()) else { continue };
        let mut entry = Map::new();
        entry.insert("name".into(), json!(name));
        let description = if item.is_string() { String::new() } else { shorten(item.get("description")) };
        if !description.is_empty() {
            entry.insert("description".into(), json!(description));
        }
        out.push(Value::Object(entry));
        if out.len() == SUGGESTIONS_MAX {
            break;
        }
    }
    (!out.is_empty()).then_some(Value::Array(out))
}

fn generator_for(args: Option<&Value>) -> Option<&'static str> {
    let arg = first_arg(args).filter(|a| a.is_object())?;
    // The NAMED generator first: `git checkout` carries both
    // generatorName: ["local_branches", …] and template: "filepaths", and the
    // branches are obviously the answer.
    as_list(arg.get("generatorName"))
        .into_iter()
        .find_map(generator)
        .or_else(|| as_list(arg.get("template")).into_iter().find_map(template))
}

fn trim_option(option: &Value) -> Option<Value> {
    let n = names(option);
    if n.is_empty() {
        return None;
    }
    let mut out = Map::new();
    out.insert("name".into(), name_value(n));
    let description = shorten(option.get("description"));
    if !description.is_empty() {
        out.insert("description".into(), json!(description));
    }
    Some(Value::Object(out))
}

fn trim_node(node: &Value, depth: usize) -> Option<Value> {
    let n = names(node);
    if n.is_empty() {
        return None;
    }
    let mut out = Map::new();
    out.insert("name".into(), name_value(n));
    let description = shorten(node.get("description"));
    if !description.is_empty() {
        out.insert("description".into(), json!(description));
    }
    let options: Vec<Value> =
        node.get("options").and_then(Value::as_array).into_iter().flatten().filter_map(trim_option).collect();
    if !options.is_empty() {
        out.insert("options".into(), Value::Array(options));
    }
    if depth > 0 {
        let subs: Vec<Value> = node
            .get("subcommands")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|s| trim_node(s, depth - 1))
            .collect();
        if !subs.is_empty() {
            out.insert("subcommands".into(), Value::Array(subs));
        }
    }
    let generator = generator_for(node.get("args"));
    let suggestions = suggestions_for(node.get("args"));
    if generator.is_some() || suggestions.is_some() {
        let mut args = Map::new();
        if let Some(g) = generator {
            args.insert("generator".into(), json!(g));
        }
        if let Some(s) = suggestions {
            args.insert("suggestions".into(), s);
        }
        out.insert("args".into(), Value::Object(args));
    }
    Some(Value::Object(out))
}

/// Depth is capped because a few specs nest absurdly and every level
/// multiplies what is kept, for suggestions no one types.
pub fn trim_signature(spec: &Value, depth: usize) -> Option<Value> {
    let mut trimmed = trim_node(spec, depth)?;
    // The top-level name is what the command is looked up by, so it has to
    // be a single string rather than a list of aliases.
    if let Some(Value::Array(a)) = trimmed.get("name").cloned() {
        trimmed["name"] = a.into_iter().next().unwrap_or(Value::Null);
    }
    Some(trimmed)
}
