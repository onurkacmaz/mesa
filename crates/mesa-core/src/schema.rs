//! What a CLI can be asked to do next, according to a shipped schema.
//!
//! Pure: a schema, the words already on the line and the prefix being typed
//! go in; candidates come out. Nothing here reads a disk or runs a command.
//!
//! `args.generator` is the reason this stays pure. A node that takes live
//! values — the branches `git checkout` accepts, the scripts `npm run`
//! accepts — names a generator rather than carrying code for one, and the
//! name is looked up in a fixed table on the app side.

use serde::{Deserialize, Serialize};

use crate::rank::{Candidate, Source};

/// A name is a string, or a list of aliases: `["-q", "--quiet"]` is a single
/// option you can write two ways.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Names {
    One(String),
    Many(Vec<String>),
}

impl Names {
    pub fn all(&self) -> &[String] {
        match self {
            Names::One(s) => std::slice::from_ref(s),
            Names::Many(v) => v,
        }
    }
    pub fn first(&self) -> Option<&str> {
        self.all().first().map(String::as_str)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Args {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestions: Option<Vec<Node>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub name: Names,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subcommands: Option<Vec<Node>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<Node>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Args>,
}

/// Follow the words down the schema. `git checkout` lands on the checkout
/// node; a word belonging to no node ends the walk, because past that point
/// nothing in the schema describes what is being typed.
fn walk<'a>(schema: &'a Node, words: &[String]) -> Option<&'a Node> {
    let mut node = schema;
    for word in words.iter().skip(1) {
        node = node.subcommands.as_ref()?.iter().find(|s| s.name.all().contains(word))?;
    }
    Some(node)
}

pub fn schema_candidates(schema: &Node, words: &[String], prefix: &str) -> Vec<Candidate> {
    let Some(node) = walk(schema, words) else { return Vec::new() };

    // Options are offered under every alias they have, subcommands only under
    // the first. `-q` and `--quiet` are both things people type; `npm r` is
    // an alias for `run` that nobody reaches for.
    let expand = |nodes: Option<&Vec<Node>>, aliases: bool| -> Vec<Candidate> {
        let mut out = Vec::new();
        for n in nodes.into_iter().flatten() {
            let names = n.name.all();
            let names = if aliases { names } else { &names[..names.len().min(1)] };
            for name in names {
                if prefix.is_empty() || name.starts_with(prefix) {
                    out.push(
                        Candidate::new(name.clone(), Source::Schema)
                            .described(n.description.clone().unwrap_or_default()),
                    );
                }
            }
        }
        out
    };

    // A prefix that opens with a dash is asking for flags.
    if prefix.starts_with('-') {
        return expand(node.options.as_ref(), true);
    }

    let mut all = expand(node.subcommands.as_ref(), false);
    // Values the node accepts outright, listed in the schema rather than
    // looked up anywhere: `for … in`, a flag's allowed words.
    all.extend(expand(node.args.as_ref().and_then(|a| a.suggestions.as_ref()), false));

    // The marker carries no value of its own: it tells the caller which
    // generator to resolve for this node, and is dropped once it has.
    if let Some(generator) = node.args.as_ref().and_then(|a| a.generator.clone()) {
        let mut marker = Candidate::new("", Source::Schema);
        marker.generator = Some(generator);
        all.push(marker);
    }
    all
}
