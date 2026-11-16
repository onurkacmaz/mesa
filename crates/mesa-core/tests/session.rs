use mesa_core::session::*;
use serde_json::{json, Value};

/// A pane that is one terminal, as the JS suite's helper built it.
fn pane(id: &str, over: Value) -> Value {
    let mut tab = json!({ "id": id, "title": "Terminal 1" });
    for key in ["title", "titleLocked", "cwd", "url", "command"] {
        if let Some(v) = over.get(key) {
            tab[key] = v.clone();
        }
    }
    let mut p = json!({
        "id": id, "kind": "terminal", "x": 10, "y": 20, "width": 1360, "height": 780, "z": 3,
        "tabs": [tab], "activeTabId": id
    });
    for (k, v) in over.as_object().unwrap() {
        if !["title", "titleLocked", "cwd", "url", "command"].contains(&k.as_str()) {
            p[k] = v.clone();
        }
    }
    p
}

fn session(over: Value) -> Value {
    let mut s = json!({
        "version": SESSION_VERSION,
        "activeWorkflowId": "wf-1",
        "counters": {},
        "workflows": [{
            "id": "wf-1", "name": "api",
            "view": { "zoom": 0.8, "pan": { "x": -420, "y": -180 } },
            "panes": [pane("term-1", json!({}))]
        }]
    });
    for (k, v) in over.as_object().unwrap() {
        s[k] = v.clone();
    }
    s
}

fn ids(s: &Session, w: usize) -> Vec<String> {
    s.workflows[w].panes.iter().map(|p| p.id.clone()).collect()
}

#[test]
fn restores_a_well_formed_session_unchanged() {
    let r = normalize_session(&session(json!({}))).unwrap();
    assert_eq!(r.workflows.len(), 1);
    assert_eq!(r.active_workflow_id, "wf-1");
    assert_eq!(r.workflows[0].view, View { zoom: 0.8, pan: Pan { x: -420.0, y: -180.0 } });
    assert_eq!(r.workflows[0].panes[0].id, "term-1");
    assert_eq!(r.workflows[0].panes[0].tabs[0].id, "term-1");
}

#[test]
fn survives_a_round_trip_through_json() {
    let before = normalize_session(&session(json!({}))).unwrap();
    let text = serde_json::to_string(&before).unwrap();
    let after = parse_session(&text).unwrap().unwrap();
    assert_eq!(after, before);
}

#[test]
fn refuses_anything_that_is_not_a_session() {
    for raw in [Value::Null, json!("nope"), json!(42), json!([]), json!({})] {
        assert!(normalize_session(&raw).is_none());
    }
}

#[test]
fn refuses_a_version_it_does_not_know() {
    assert!(normalize_session(&session(json!({ "version": 99 }))).is_none());
    assert!(normalize_session(&session(json!({ "version": null }))).is_none());
}

#[test]
fn an_empty_workflow_list_reads_as_no_session() {
    assert!(normalize_session(&session(json!({ "workflows": [] }))).is_none());
}

#[test]
fn drops_a_pane_with_no_usable_geometry_and_keeps_the_rest() {
    let r = normalize_session(&session(json!({ "workflows": [{
        "id": "wf-1", "name": "api",
        "panes": [pane("term-1", json!({ "width": 0 })), pane("term-2", json!({}))]
    }]})))
    .unwrap();
    assert_eq!(ids(&r, 0), vec!["term-2"]);
}

#[test]
fn a_session_written_before_ropes_were_removed_still_opens() {
    let r = normalize_session(&session(json!({ "workflows": [{
        "id": "wf-1", "name": "api",
        "panes": [pane("term-1", json!({})), pane("term-2", json!({}))],
        "connections": [{ "id": "conn-1", "from": "term-1", "to": "term-2" }]
    }]})))
    .unwrap();
    assert_eq!(ids(&r, 0), vec!["term-1", "term-2"]);
    let v = serde_json::to_value(&r).unwrap();
    assert!(v["workflows"][0].get("connections").is_none());
}

#[test]
fn two_panes_never_share_an_id() {
    let r = normalize_session(&session(json!({ "workflows": [
        { "id": "wf-1", "name": "a", "panes": [pane("term-1", json!({})), pane("term-1", json!({}))] },
        { "id": "wf-2", "name": "b", "panes": [pane("term-1", json!({})), pane("term-2", json!({}))] }
    ]})))
    .unwrap();
    assert_eq!(ids(&r, 0), vec!["term-1"]);
    assert_eq!(ids(&r, 1), vec!["term-2"]);
}

#[test]
fn falls_back_to_the_first_workflow_when_the_active_one_is_gone() {
    let r = normalize_session(&session(json!({ "activeWorkflowId": "wf-404" }))).unwrap();
    assert_eq!(r.active_workflow_id, "wf-1");
}

#[test]
fn keeps_a_browser_url_and_a_terminal_cwd_and_never_crosses_them() {
    let r = normalize_session(&session(json!({ "workflows": [{ "id": "wf-1", "name": "a", "panes": [
        pane("term-1", json!({ "cwd": "/tmp", "url": "https://example.com" })),
        pane("term-2", json!({ "kind": "browser", "title": "Browser 2", "cwd": "/tmp", "url": "https://example.com" }))
    ]}]})))
    .unwrap();
    let t = &r.workflows[0].panes[0].tabs[0];
    let b = &r.workflows[0].panes[1].tabs[0];
    assert_eq!(t.cwd.as_deref(), Some("/tmp"));
    assert_eq!(t.url, None);
    assert_eq!(b.url.as_deref(), Some("https://example.com"));
    assert_eq!(b.cwd, None);
}

#[test]
fn a_browser_url_must_be_http() {
    let r = normalize_session(&session(json!({ "workflows": [{ "id": "wf-1", "name": "a", "panes": [
        pane("term-1", json!({ "kind": "browser", "url": "file:///etc/passwd" })),
        pane("term-2", json!({ "kind": "browser", "url": "HTTPS://Example.com" }))
    ]}]})))
    .unwrap();
    assert_eq!(r.workflows[0].panes[0].tabs[0].url, None);
    assert_eq!(r.workflows[0].panes[1].tabs[0].url.as_deref(), Some("HTTPS://Example.com"));
}

#[test]
fn a_startup_command_survives_stripped_of_anything_that_could_run_it() {
    let r = normalize_session(&session(json!({ "workflows": [{ "id": "wf-1", "name": "a", "panes": [
        pane("term-1", json!({ "command": "npm run dev" })),
        pane("term-2", json!({ "command": "rm -rf /\r" })),
        pane("term-3", json!({ "command": "echo hi\nmake deploy" })),
        pane("term-5", json!({ "command": "\u{1b}[200~evil" })),
        pane("term-8", json!({ "command": "   \r\n  " }))
    ]}]})))
    .unwrap();
    let commands: Vec<Option<String>> =
        r.workflows[0].panes.iter().map(|p| p.tabs[0].command.clone()).collect();
    assert_eq!(
        commands,
        vec![
            Some("npm run dev".into()),
            Some("rm -rf /".into()),
            Some("echo himake deploy".into()),
            Some("[200~evil".into()),
            None
        ]
    );
}

#[test]
fn a_browser_pane_carries_no_startup_command() {
    let r = normalize_session(&session(json!({ "workflows": [{ "id": "wf-1", "name": "a", "panes": [
        pane("term-1", json!({ "kind": "browser", "command": "npm run dev" }))
    ]}]})))
    .unwrap();
    assert_eq!(r.workflows[0].panes[0].tabs[0].command, None);
}

#[test]
fn repairs_a_broken_view_rather_than_dropping_the_workflow() {
    let r = normalize_session(&session(json!({ "workflows": [{
        "id": "wf-1", "name": "a", "view": { "zoom": 0, "pan": "nope" }, "panes": [pane("term-1", json!({}))]
    }]})))
    .unwrap();
    assert_eq!(r.workflows[0].view, View::default());
}

#[test]
fn counters_resume_past_every_restored_id() {
    let seeds = counter_seeds_from(
        &normalize_session(&session(json!({
            "workflows": [{ "id": "wf-3", "name": "a",
                "panes": [pane("term-7", json!({ "title": "Terminal 7", "z": 12 }))] }],
            "activeWorkflowId": "wf-3"
        })))
        .unwrap(),
    );
    assert_eq!(seeds.pane, 7);
    assert_eq!(seeds.workflow, 3);
    assert_eq!(seeds.session, 7);
    assert_eq!(seeds.z, 12);
}

#[test]
fn a_stale_counters_block_can_only_raise_a_seed() {
    let raw = normalize_session(&session(json!({ "counters": { "pane": 0, "workflow": 0, "session": 99 } })))
        .unwrap();
    let seeds = counter_seeds_from(&raw);
    assert_eq!(seeds.pane, 1);
    assert_eq!(seeds.workflow, 1);
    assert_eq!(seeds.session, 99);
}

#[test]
fn a_rope_id_left_on_disk_no_longer_pushes_the_pane_counter() {
    let seeds = counter_seeds_from(
        &normalize_session(&session(json!({ "workflows": [{ "id": "wf-1", "name": "a",
            "panes": [pane("term-7", json!({})), pane("term-2", json!({}))],
            "connections": [{ "id": "conn-9", "from": "term-7", "to": "term-2" }] }] })))
        .unwrap(),
    );
    assert_eq!(seeds.pane, 7);
}

#[test]
fn a_renamed_pane_contributes_no_session_number() {
    let seeds = counter_seeds_from(
        &normalize_session(&session(json!({ "workflows": [{ "id": "wf-1", "name": "a",
            "panes": [pane("term-1", json!({ "title": "deploy" }))] }] })))
        .unwrap(),
    );
    assert_eq!(seeds.session, 0);
}

#[test]
fn a_v1_session_becomes_a_v2_one() {
    let r = normalize_session(&json!({
        "version": 1, "activeWorkflowId": "wf-1", "counters": { "pane": 3 },
        "workflows": [{ "id": "wf-1", "name": "api", "view": { "zoom": 0.5, "pan": { "x": 10, "y": 20 } },
          "panes": [
            { "id": "term-3", "kind": "terminal", "x": 1, "y": 2, "width": 100, "height": 200, "z": 4,
              "title": "build", "titleLocked": true, "cwd": "/tmp", "command": "npm run dev" },
            { "id": "term-5", "kind": "browser", "x": 3, "y": 4, "width": 100, "height": 200, "z": 5,
              "title": "Browser 5", "url": "https://example.com" }
          ],
          "connections": [{ "id": "conn-6", "from": "term-3", "to": "term-5" }] }]
    }))
    .unwrap();
    let terminal = &r.workflows[0].panes[0];
    assert_eq!(
        terminal.tabs,
        vec![Tab {
            id: "term-3".into(),
            title: "build".into(),
            title_locked: true,
            cwd: Some("/tmp".into()),
            command: Some("npm run dev".into()),
            url: None
        }]
    );
    assert_eq!(terminal.active_tab_id, "term-3");
    assert_eq!(r.workflows[0].panes[1].tabs[0].url.as_deref(), Some("https://example.com"));
    assert_eq!(r.workflows[0].view, View { zoom: 0.5, pan: Pan { x: 10.0, y: 20.0 } });
}

#[test]
fn a_pane_holds_many_tabs_and_remembers_which_was_in_front() {
    let r = normalize_session(&session(json!({ "workflows": [{ "id": "wf-1", "name": "a", "panes": [
        pane("term-1", json!({ "tabs": [
            { "id": "term-1", "title": "one", "cwd": "/one" },
            { "id": "term-4", "title": "two", "cwd": "/two", "command": "npm test" },
            { "id": "term-6", "title": "three" }
        ], "activeTabId": "term-4" }))
    ]}]})))
    .unwrap();
    let p = &r.workflows[0].panes[0];
    assert_eq!(p.tabs.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["term-1", "term-4", "term-6"]);
    assert_eq!(p.active_tab_id, "term-4");
    assert_eq!(p.tabs[1].command.as_deref(), Some("npm test"));
}

#[test]
fn an_active_tab_that_is_gone_falls_back_to_the_first() {
    let r = normalize_session(&session(json!({ "workflows": [{ "id": "wf-1", "name": "a",
        "panes": [pane("term-1", json!({ "activeTabId": "term-404" }))] }] })))
    .unwrap();
    assert_eq!(r.workflows[0].panes[0].active_tab_id, "term-1");
}

#[test]
fn a_pane_with_no_tabs_left_is_dropped() {
    let r = normalize_session(&session(json!({ "workflows": [{ "id": "wf-1", "name": "a",
        "panes": [pane("term-1", json!({ "tabs": [] })), pane("term-2", json!({}))] }] })))
    .unwrap();
    assert_eq!(ids(&r, 0), vec!["term-2"]);
}

#[test]
fn no_two_tabs_share_an_id() {
    let r = normalize_session(&session(json!({ "workflows": [
        { "id": "wf-1", "name": "a", "panes": [pane("term-1", json!({ "tabs": [
            { "id": "term-1", "title": "one" }, { "id": "term-1", "title": "duplicate" } ] }))] },
        { "id": "wf-2", "name": "b", "panes": [pane("term-2", json!({ "tabs": [
            { "id": "term-1", "title": "stolen" }, { "id": "term-9", "title": "own" } ],
            "activeTabId": "term-9" }))] }
    ]})))
    .unwrap();
    assert_eq!(r.workflows[0].panes[0].tabs.iter().map(|t| &t.id).collect::<Vec<_>>(), ["term-1"]);
    assert_eq!(r.workflows[1].panes[0].tabs.iter().map(|t| &t.id).collect::<Vec<_>>(), ["term-9"]);
}

#[test]
fn counters_clear_every_tab_id() {
    let seeds = counter_seeds_from(
        &normalize_session(&session(json!({ "workflows": [{ "id": "wf-1", "name": "a", "panes": [
            pane("term-2", json!({ "tabs": [
                { "id": "term-2", "title": "Terminal 2" }, { "id": "term-11", "title": "Terminal 11" } ] }))
        ]}]})))
        .unwrap(),
    );
    assert_eq!(seeds.pane, 11);
    assert_eq!(seeds.session, 11);
}
