use mesa_core::accept::*;
use mesa_core::command_signature::trim_signature;
use mesa_core::dropdown::*;
use mesa_core::naming::*;
use mesa_core::rail_reorder::*;
use mesa_core::schema::{schema_candidates, Node};
use mesa_core::terminal_osc::*;
use mesa_core::zle::*;
use mesa_core::zsh_history::*;
use serde_json::json;

const CLEAR: &str = "\x05\x15";

fn seq(buffer: &str, cursor: usize, start: usize, value: &str) -> String {
    accept_sequence(&Accept { buffer, cursor, start, value })
}

#[test]
fn accepting_a_candidate() {
    assert_eq!(seq("git ch", 6, 4, "checkout"), format!("{CLEAR}git checkout"));
    assert_eq!(seq("git ch main", 6, 4, "checkout"), format!("{CLEAR}git checkout main"));
    assert_eq!(seq("gi", 2, 0, "git status"), format!("{CLEAR}git status"));
    assert_eq!(seq("git ", 4, 4, "status"), format!("{CLEAR}git status"));
    assert_eq!(seq("ec", 2, 0, "echo one\necho two"), format!("{CLEAR}echo one\x1b\recho two"));
    assert_eq!(seq("ec", 2, 0, "a\r\nb"), format!("{CLEAR}a\x1b\rb"));
    assert!(!seq("gi", 2, 0, "git status").ends_with('\r'));
    assert_eq!(seq("cd \"My Doc", 10, 4, "My Documents"), format!("{CLEAR}cd \"My Documents"));
    assert_eq!(seq("cd My\\ Doc", 10, 3, "My Documents"), format!("{CLEAR}cd My Documents"));
    assert_eq!(seq("cd ığ", 5, 3, "ığşü"), format!("{CLEAR}cd ığşü"));
}

#[test]
fn zle_buffers() {
    assert_eq!(decode_zle_buffer("git checkout main"), "git checkout main");
    assert_eq!(decode_zle_buffer("a\\nb"), "a\nb");
    assert_eq!(decode_zle_buffer("a\\rb"), "a\rb");
    assert_eq!(decode_zle_buffer("a\\tb"), "a\tb");
    assert_eq!(decode_zle_buffer("a\\eb"), "a\x1bb");
    assert_eq!(decode_zle_buffer("a\\ab"), "a\x07b");
    assert_eq!(decode_zle_buffer("a\\\\nb"), "a\\nb");
    assert_eq!(decode_zle_buffer("grep \"^[a-z]\" file"), "grep \"^[a-z]\" file");
    assert_eq!(decode_zle_buffer("a\\qb"), "a\\qb");
    assert_eq!(decode_zle_buffer("echo \\\\"), "echo \\");
    assert_eq!(decode_zle_buffer("echo \\"), "echo \\");
    assert_eq!(parse_zle_osc("L;5;git c"), Some(ZleLine { cursor: 5, buffer: "git c".into() }));
    assert_eq!(parse_zle_osc("L;12;cd /tmp; ls"), Some(ZleLine { cursor: 12, buffer: "cd /tmp; ls".into() }));
    assert_eq!(parse_zle_osc("L;0;"), Some(ZleLine { cursor: 0, buffer: "".into() }));
    for bad in ["X;0;hi", "L;notanumber;hi", "L;5", ""] {
        assert_eq!(parse_zle_osc(bad), None);
    }
}

fn hv(text: &str) -> Vec<String> {
    parse_zsh_history(text).into_iter().map(|c| c.value).collect()
}

#[test]
fn zsh_history() {
    assert_eq!(hv("git status\nnpm test\n"), ["git status", "npm test"]);
    assert_eq!(hv(": 1699999999:0;git status\n: 1700000000:12;npm test\n"), ["git status", "npm test"]);
    assert_eq!(hv(": 1699999999:0;cd /tmp; ls\n"), ["cd /tmp; ls"]);
    assert_eq!(hv(": 1699999999:0;echo one\\\necho two\n: 1700000000:0;ls\n"), ["echo one\necho two", "ls"]);
    let list = parse_zsh_history("old\nnew\n");
    assert!(list[1].recency > list[0].recency);
    assert_eq!(hv("git status\nnpm test\ngit status\n"), ["npm test", "git status"]);
    assert_eq!(parse_zsh_history("git status\nnpm test\ngit status\n")[1].count, Some(2));
    assert_eq!(hv("git status\n\n   \nls\n"), ["git status", "ls"]);
    assert!(parse_zsh_history("").is_empty());
    assert_eq!(parse_zsh_history(": 1700000000:0;ls\n")[0].at, Some(1_700_000_000));
}

#[test]
fn unmetafy_restores_what_zsh_escaped() {
    // "ı" is C4 B1; zsh writes 0x83 before bytes in 0x83..=0x9f, XOR 32.
    let bytes = [b'c', b'd', b' ', 0xC4, 0x83, 0xB1 ^ 32 ^ 0 /* placeholder */];
    let _ = bytes;
    let mut metafied = Vec::new();
    for b in "cd ığş".bytes() {
        if (0x83..=0x9f).contains(&b) || b == 0 {
            metafied.push(0x83);
            metafied.push(b ^ 32);
        } else {
            metafied.push(b);
        }
    }
    assert_eq!(unmetafy(&metafied), "cd ığş");
}

#[test]
fn dropdown_placements() {
    let p = |r, t, c| dropdown_placement(r, t, c, DEFAULT_MAX);
    assert_eq!(p(2, 40, 5), Placement { direction: Direction::Down, row: 3, rows: 5 });
    assert_eq!(p(39, 40, 5), Placement { direction: Direction::Up, row: 34, rows: 5 });
    assert_eq!(p(35, 40, 5).direction, Direction::Up);
    assert_eq!(p(34, 40, 5).direction, Direction::Down);
    assert_eq!(p(0, 40, 30).rows, 8);
    assert_eq!(dropdown_placement(0, 40, 30, 3).rows, 3);
    assert_eq!(p(4, 6, 8), Placement { direction: Direction::Up, row: 0, rows: 4 });
    assert_eq!(p(2, 6, 8).direction, Direction::Down);
    assert_eq!(p(0, 1, 5), Placement { direction: Direction::Down, row: 1, rows: 0 });
    assert_eq!(p(2, 40, 0).rows, 0);
    for term_rows in 1..=12 {
        for cursor_row in 0..term_rows {
            let pl = p(cursor_row, term_rows, 8);
            if pl.rows == 0 {
                continue;
            }
            assert!(pl.row + pl.rows <= term_rows);
        }
    }
}

const RECTS: [Slot; 3] = [
    Slot { left: 0.0, width: 100.0 },
    Slot { left: 109.0, width: 40.0 },
    Slot { left: 158.0, width: 200.0 },
];

#[test]
fn rail_reordering() {
    let at = |i, dx| drop_index(&RECTS, i, dx);
    assert_eq!(at(0, 20.0), 0);
    assert_eq!(at(2, -25.0), 2);
    assert_eq!(at(0, 30.0), 1);
    assert_eq!(at(0, 159.0), 2);
    assert_eq!(at(2, -29.0), 2);
    assert_eq!(at(2, -30.0), 1);
    assert_eq!(at(2, -109.0), 0);
    assert_eq!(at(2, clamp_offset(&RECTS, 2, 10000.0)), 2);
    assert_eq!(at(2, clamp_offset(&RECTS, 2, -10000.0)), 0);
    let wide = [Slot { left: 0.0, width: 240.0 }, Slot { left: 249.0, width: 40.0 }, Slot { left: 298.0, width: 40.0 }];
    assert_eq!(drop_index(&wide, 0, clamp_offset(&wide, 0, 10000.0)), 2);
    assert_eq!(at(0, 28.0), 0);
    let d = 109.0;
    assert_eq!(slide_for(0, 0, 2, d), 0.0);
    assert_eq!(slide_for(1, 0, 2, d), -d);
    assert_eq!(slide_for(2, 0, 2, d), -d);
    assert_eq!(slide_for(2, 0, 1, 109.0), 0.0);
    assert_eq!(slide_for(0, 2, 1, 209.0), 0.0);
    assert_eq!(slide_for(0, 2, 0, 209.0), 209.0);
    assert_eq!(gap_between(&RECTS, 0.0), 9.0);
    assert_eq!(gap_between(&RECTS[..1], 4.0), 4.0);
    assert_eq!(clamp_offset(&RECTS, 0, -400.0), 0.0);
    assert_eq!(clamp_offset(&RECTS, 0, 400.0), 258.0);
    assert_eq!(clamp_offset(&RECTS, 2, -400.0), -158.0);
    assert_eq!(clamp_offset(&RECTS, 1, 20.0), 20.0);
    assert_eq!(reorder(&["a", "b", "c"], 0, 2), ["b", "c", "a"]);
    assert_eq!(reorder(&["a", "b", "c"], 2, 0), ["c", "a", "b"]);
    assert_eq!(reorder(&["a", "b", "c"], 1, 1), ["a", "b", "c"]);
}

fn name(folder: &str, branch: Option<&str>) -> Name {
    Name { folder: folder.into(), branch: branch.map(String::from) }
}

#[test]
fn naming() {
    assert_eq!(split_name("mesa -> main", false), name("mesa", Some("main")));
    assert_eq!(split_name("React -> Vue migration", true), name("React -> Vue migration", None));
    assert_eq!(split_name("mesa -> a -> b", false), name("mesa", Some("a -> b")));
    assert_eq!(plain_label(&name("mesa", Some("main"))), "mesa -> main");
    assert_eq!(plain_label(&name("Hacker News", None)), "Hacker News");

    let width = |n: &Name| (n.folder.chars().count() + n.branch.as_ref().map_or(0, |b| 4 + b.chars().count())) as f32;
    assert_eq!(fit_name(&name("mesa", Some("main")), 20.0, width), name("mesa", Some("main")));
    let fitted = fit_name(&name("mesa", Some("feature/touch-bar")), 16.0, width);
    assert_eq!(fitted, name("mesa", Some("feature…")));
    assert_eq!(fit_name(&name("mesa-website", Some("feature")), 13.0, width), name("mesa-website", None));
    assert_eq!(fit_name(&name("HR-17123-description-fields", Some("main")), 10.0, width), name("HR-17123-…", None));
    assert_eq!(fit_name(&name("ab😀cdef", None), 4.0, width).folder, "ab😀…");
}

#[test]
fn osc_colours() {
    assert_eq!(rgb_to_osc(0x0b0a09), "rgb:0b0b/0a0a/0909");
    assert_eq!(hex_to_osc_rgb("#0b0a09").as_deref(), Some("rgb:0b0b/0a0a/0909"));
    assert_eq!(parse_osc_color("rgb:0b0b/0a0a/0909"), Some(0x0b0a09));
    assert_eq!(parse_osc_color("?"), None);
    assert_eq!(OSC_PALETTE_KEYS[4], "blue");
    assert_eq!(OSC_PALETTE_KEYS[12], "brightBlue");
    assert_eq!(osc_palette_color(&DARK_TERMINAL_THEME, "4"), Some(0x7f9cba));
    assert_eq!(osc_palette_color(&DARK_TERMINAL_THEME, "12"), Some(0x9db8d1));
    assert_eq!(osc_palette_color(&DARK_TERMINAL_THEME, "255"), None);
}

#[test]
fn command_signatures_are_trimmed_to_data() {
    let out = trim_signature(
        &json!({
            "name": "git", "description": "the stupid content tracker",
            "generateSpec": "function(){}", "loadSpec": "x",
            "subcommands": [{
                "name": ["checkout", "co"], "description": "switch",
                "args": { "generatorName": ["local_branches"], "template": "filepaths", "generators": { "script": "rm -rf" } },
                "options": [{ "name": ["-q", "--quiet"], "description": "quiet\n  please" }]
            }, {
                "name": "cd", "args": { "template": "folders", "suggestions": ["in", { "name": "of", "description": "the other one" }, { "description": "nameless" }] }
            }, { "description": "no name" }]
        }),
        3,
    )
    .unwrap();
    let text = out.to_string();
    for field in ["generateSpec", "loadSpec", "generators", "script", "template", "generatorName"] {
        assert!(!text.contains(&format!("\"{field}\"")), "{field} survived");
    }
    assert_eq!(out["subcommands"][0]["args"], json!({ "generator": "git-branches" }));
    assert_eq!(out["subcommands"][0]["options"][0]["name"], json!(["-q", "--quiet"]));
    assert_eq!(out["subcommands"][0]["options"][0]["description"], json!("quiet please"));
    assert_eq!(out["subcommands"][1]["args"]["generator"], json!("directories"));
    assert_eq!(out["subcommands"][1]["args"]["suggestions"], json!([{ "name": "in" }, { "name": "of", "description": "the other one" }]));
    assert_eq!(out["subcommands"].as_array().unwrap().len(), 2);
    assert_eq!(trim_signature(&json!({ "name": ["ns", "nativescript"] }), 3).unwrap()["name"], json!("ns"));
    assert!(trim_signature(&json!({ "description": "nameless" }), 3).is_none());
    let long = trim_signature(&json!({ "name": "x", "description": "word ".repeat(40) }), 3).unwrap();
    let d = long["description"].as_str().unwrap();
    assert!(d.chars().count() <= 80 && d.ends_with('…'));
    let deep = trim_signature(&json!({ "name": "a", "subcommands": [{ "name": "b", "subcommands": [{ "name": "c", "subcommands": [{ "name": "d" }] }] }] }), 1).unwrap();
    assert_eq!(deep["subcommands"][0]["name"], json!("b"));
    assert!(deep["subcommands"][0].get("subcommands").is_none());
    let unknown = trim_signature(&json!({ "name": "x", "args": { "template": "history" } }), 3).unwrap();
    assert!(unknown.get("args").is_none());
}

/// The shipped schema set, read straight out of the app's assets.
fn shipped() -> Vec<(String, serde_json::Value)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../mesa/assets/command-schemas");
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let name = p.file_stem().unwrap().to_string_lossy().to_string();
        out.push((name, serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap()));
    }
    out
}

#[test]
fn the_shipped_schemas_are_data_only_and_resolvable() {
    let all = shipped();
    assert!(all.len() > 400, "only {} schemas shipped", all.len());
    let allowed = ["name", "description", "subcommands", "options", "args", "generator", "suggestions"];
    let known = ["files", "directories", "git-branches", "npm-scripts", "ssh-hosts", "path", "history"];
    fn walk(v: &serde_json::Value, keys: &mut std::collections::HashSet<String>, gens: &mut std::collections::HashSet<String>) {
        match v {
            serde_json::Value::Object(m) => {
                for (k, x) in m {
                    keys.insert(k.clone());
                    if k == "generator" {
                        if let Some(g) = x.as_str() {
                            gens.insert(g.to_string());
                        }
                    }
                    walk(x, keys, gens);
                }
            }
            serde_json::Value::Array(a) => a.iter().for_each(|x| walk(x, keys, gens)),
            _ => {}
        }
    }
    let (mut keys, mut gens) = (Default::default(), Default::default());
    for (name, schema) in &all {
        assert_eq!(schema["name"].as_str(), Some(name.as_str()));
        // Every one deserialises into the shape the app reads.
        let _: Node = serde_json::from_value(schema.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
        walk(schema, &mut keys, &mut gens);
    }
    for k in &keys {
        assert!(allowed.contains(&k.as_str()), "unexpected key {k}");
    }
    assert!(!gens.is_empty());
    for g in &gens {
        assert!(known.contains(&g.as_str()), "unknown generator {g}");
    }

    let git: Node = serde_json::from_value(all.iter().find(|(n, _)| n == "git").unwrap().1.clone()).unwrap();
    assert!(git.subcommands.as_ref().unwrap().len() > 30);
    let words = vec!["git".to_string(), "checkout".to_string()];
    assert!(schema_candidates(&git, &words, "").iter().any(|c| c.generator.as_deref() == Some("git-branches")));
    let npm: Node = serde_json::from_value(all.iter().find(|(n, _)| n == "npm").unwrap().1.clone()).unwrap();
    let words = vec!["npm".to_string(), "run".to_string()];
    assert!(schema_candidates(&npm, &words, "").iter().any(|c| c.generator.as_deref() == Some("npm-scripts")));
}
