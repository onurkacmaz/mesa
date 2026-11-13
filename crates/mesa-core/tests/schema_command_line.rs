use mesa_core::command_line::*;
use mesa_core::schema::*;
use serde_json::json;

fn git() -> Node {
    serde_json::from_value(json!({
        "name": "git",
        "subcommands": [
            { "name": "checkout", "args": { "generator": "git-branches" },
              "options": [ { "name": "-b", "description": "create a new branch" },
                           { "name": "--force", "description": "throw away local changes" } ] },
            { "name": "commit", "options": [{ "name": "-m", "description": "message" }] },
            { "name": "cherry-pick" }
        ],
        "options": [{ "name": "--version", "description": "print the version" }]
    }))
    .unwrap()
}

fn w(words: &[&str]) -> Vec<String> {
    words.iter().map(|s| s.to_string()).collect()
}

fn values(list: &[mesa_core::rank::Candidate]) -> Vec<&str> {
    list.iter().map(|c| c.value.as_str()).collect()
}

#[test]
fn subcommands_and_options() {
    let g = git();
    assert_eq!(values(&schema_candidates(&g, &w(&["git"]), "")), ["checkout", "commit", "cherry-pick"]);
    let _ = ([""]
        .iter().filter(|v| !v.is_empty()).copied().collect::<Vec<_>>());
    assert_eq!(values(&schema_candidates(&g, &w(&["git"]), "ch")), ["checkout", "cherry-pick"]);
    assert_eq!(values(&schema_candidates(&g, &w(&["git", "checkout"]), "-")), ["-b", "--force"]);
    let b = &schema_candidates(&g, &w(&["git", "checkout"]), "-b")[0];
    assert_eq!(b.description, "create a new branch");
    assert_eq!(values(&schema_candidates(&g, &w(&["git"]), "--")), ["--version"]);
    assert_eq!(values(&schema_candidates(&g, &w(&["git", "commit"]), "-")), ["-m"]);
}

#[test]
fn generators_and_dead_ends() {
    let g = git();
    let list = schema_candidates(&g, &w(&["git", "checkout"]), "");
    assert_eq!(list.iter().find_map(|c| c.generator.clone()).as_deref(), Some("git-branches"));
    assert!(schema_candidates(&g, &w(&["git", "cherry-pick"]), "-").is_empty());
    assert!(schema_candidates(&g, &w(&["git", "nonsense"]), "").is_empty());
}

fn ctx(prefix: &str, start: usize, words: &[&str], position: Position, quote: Option<char>) -> Context {
    Context { prefix: prefix.into(), start, words: w(words), position, quote }
}

fn at(buffer: &str) -> Context {
    completion_context(buffer, buffer.chars().count())
}

#[test]
fn command_line_contexts() {
    use Position::*;
    assert_eq!(at("gi"), ctx("gi", 0, &[], Command, None));
    assert_eq!(at(""), ctx("", 0, &[], Command, None));
    assert_eq!(at("git ch"), ctx("ch", 4, &["git"], Argument, None));
    assert_eq!(at("git checkout "), ctx("", 13, &["git", "checkout"], Argument, None));
    assert_eq!(at("git checkout -"), ctx("-", 13, &["git", "checkout"], Argument, None));
    assert_eq!(completion_context("git checkout main", 7), ctx("che", 4, &["git"], Argument, None));
    assert_eq!(at("git   ch"), ctx("ch", 6, &["git"], Argument, None));
    assert_eq!(at("git commit -m \"work in pro"), ctx("work in pro", 15, &["git", "commit", "-m"], Argument, Some('"')));
    assert_eq!(at("cd 'My Doc"), ctx("My Doc", 4, &["cd"], Argument, Some('\'')));
    assert_eq!(at("cd \"My Documents\" "), ctx("", 18, &["cd", "My Documents"], Argument, None));
    assert_eq!(at("cd My\\ Doc"), ctx("My Doc", 3, &["cd"], Argument, None));
    assert_eq!(at("ls | gr"), ctx("gr", 5, &[], Command, None));
    assert_eq!(at("cd /tmp && l"), ctx("l", 11, &[], Command, None));
    assert_eq!(at("cd /tmp; l"), ctx("l", 9, &[], Command, None));
    assert_eq!(at("echo \"a | b"), ctx("a | b", 6, &["echo"], Argument, Some('"')));
    assert_eq!(at("cd /tmp\nl"), ctx("l", 8, &[], Command, None));
    assert_eq!(completion_context("git", 99), ctx("git", 0, &[], Command, None));
}

#[test]
fn offsets_are_characters_not_bytes() {
    assert_eq!(at("cd ığş"), ctx("ığş", 3, &["cd"], Position::Argument, None));
}
