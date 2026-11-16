use mesa_core::editors::*;
use mesa_core::flags::*;
use serde_json::{json, Value};

#[test]
fn a_first_launch_has_seen_nothing_and_chosen_nothing() {
    assert_eq!(normalize_flags(&Value::Null), Flags::default());
    assert!(!Flags::default().seen_onboarding);
    assert_eq!(Flags::default().editor, None);
}

#[test]
fn the_chosen_editor_is_remembered() {
    assert_eq!(normalize_flags(&json!({ "editor": "Zed" })).editor.as_deref(), Some("Zed"));
}

#[test]
fn an_editor_that_is_not_a_name_is_no_editor() {
    for v in [json!(""), json!(3), json!(true), json!(["Zed"]), json!({ "app": "Zed" }), Value::Null] {
        assert_eq!(normalize_flags(&json!({ "editor": v })).editor, None, "for {v}");
    }
}

#[test]
fn only_a_real_true_counts_as_seen() {
    assert!(normalize_flags(&json!({ "seenOnboarding": true })).seen_onboarding);
    for v in [json!("true"), json!(1), json!({}), json!([]), Value::Null] {
        assert!(!normalize_flags(&json!({ "seenOnboarding": v })).seen_onboarding, "for {v}");
    }
}

#[test]
fn a_file_that_is_not_an_object_costs_nothing_but_the_flags() {
    for v in [json!("x"), json!(4), json!([true]), Value::Null] {
        assert_eq!(normalize_flags(&v), Flags::default());
    }
    assert_eq!(parse_flags("{nope"), Flags::default());
}

#[test]
fn keys_this_version_does_not_know_are_dropped() {
    let flags = normalize_flags(&json!({ "seenOnboarding": true, "editor": "Zed", "extra": 1 }));
    let v = serde_json::to_value(&flags).unwrap();
    let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["editor", "seenOnboarding", "theme"]);
}

#[test]
fn the_theme_reads_back_and_defaults_to_auto() {
    assert_eq!(normalize_flags(&json!({ "theme": "light" })).theme, ThemeMode::Light);
    assert_eq!(normalize_flags(&json!({ "theme": "neon" })).theme, ThemeMode::Auto);
}

fn names(e: &[Editor]) -> Vec<&str> {
    e.iter().map(|e| e.app.as_str()).collect()
}

#[test]
fn an_installed_editor_is_recognised_by_its_bundle_name() {
    assert_eq!(names(&editors_from(&["Zed.app"], None)), ["Zed"]);
}

#[test]
fn the_jetbrains_family_is_recognised() {
    let found = ["RubyMine.app", "GoLand.app", "PyCharm.app", "Rider.app"];
    let mut n = names(&editors_from(&found, None)).into_iter().map(String::from).collect::<Vec<_>>();
    n.sort();
    assert_eq!(n, ["GoLand", "PyCharm", "Rider", "RubyMine"]);
}

#[test]
fn an_app_you_picked_yourself_is_offered() {
    let editors = editors_from(&["Zed.app", "Obscure Editor.app"], Some("Obscure Editor"));
    assert_eq!(names(&editors), ["Zed", "Obscure Editor"]);
    assert_eq!(names(&editors_from(&["Zed.app"], Some("Obscure Editor"))), ["Zed"]);
    assert_eq!(names(&editors_from(&["Zed.app", "Cursor.app"], Some("Zed"))), ["Cursor", "Zed"]);
}

#[test]
fn everything_else_is_passed_over_and_order_is_fixed() {
    assert!(editors_from(&["Chess.app", "Mail.app", "Some Installer.app"], None).is_empty());
    let a = editors_from(&["Zed.app", "Cursor.app", "Xcode.app"], None);
    let b = editors_from(&["Xcode.app", "Cursor.app", "Zed.app"], None);
    assert_eq!(a, b);
    assert_eq!(names(&editors_from(&["Zed.app", "Zed.app"], None)), ["Zed"]);
}

#[test]
fn resolving_the_preference() {
    let available = editors_from(&["Zed.app", "Cursor.app"], None);
    assert_eq!(resolve_editor(Some("Cursor"), &available).map(|e| e.app.as_str()), Some("Cursor"));
    let available = editors_from(&["Zed.app"], None);
    assert_eq!(resolve_editor(Some("Cursor"), &available), None);
    assert_eq!(resolve_editor(None, &available), None);
    assert_eq!(resolve_editor(Some(""), &available), None);
}
