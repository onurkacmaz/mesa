use mesa_core::rank::*;

const NOW: i64 = 1_700_000_000;

fn c(value: &str, source: Source) -> Candidate {
    Candidate::new(value, source)
}
fn h(value: &str) -> Candidate {
    c(value, Source::History)
}
fn values(list: &[Candidate]) -> Vec<&str> {
    list.iter().map(|x| x.value.as_str()).collect()
}
fn rank(list: &[Candidate], prefix: impl Into<Prefix>) -> Vec<Candidate> {
    rank_candidates(list, prefix, 8, NOW)
}
fn run(value: &str, count: u64) -> Candidate {
    let mut x = h(value);
    x.count = Some(count);
    x.freshness = Some(0.9);
    x
}
fn past(value: &str, count: u64, freshness: f64) -> Candidate {
    let mut x = h(value);
    x.count = Some(count);
    x.freshness = Some(freshness);
    x
}

#[test]
fn what_does_not_match_at_all_is_dropped() {
    assert_eq!(values(&rank(&[h("git status"), h("npm test")], "git")), ["git status"]);
    assert_eq!(values(&rank(&[h("ungit"), h("git status")], "git")), ["git status"]);
}

#[test]
fn case_is_honoured_but_not_required() {
    let list = rank(&[h("Makefile"), h("makefile"), h("mise.toml")], "ma");
    assert_eq!(&values(&list)[..2], ["makefile", "Makefile"]);
}

#[test]
fn scattered_letters_and_middles_do_not_match() {
    assert!(rank(&[h("git checkout")], "gco").is_empty());
    assert!(rank(&[h("claude-work --resume Session 412e0e48")], "npm").is_empty());
    assert!(rank(&[h("sudo npm install")], "npm").is_empty());
}

#[test]
fn an_empty_prefix_keeps_everything_in_source_order() {
    let list = rank(&[h("b"), c("a", Source::Schema)], "");
    assert_eq!(values(&list), ["a", "b"]);
}

#[test]
fn the_source_breaks_a_tie() {
    let list = rank(
        &[c("check-in", Source::Path), c("checklist", Source::File), c("checkers", Source::History), c("checkout", Source::Schema)],
        "check",
    );
    assert_eq!(
        list.iter().map(|x| x.source).collect::<Vec<_>>(),
        [Source::Schema, Source::History, Source::File, Source::Path]
    );
}

#[test]
fn the_same_command_from_two_sources_is_listed_once() {
    let list = rank(&[h("git status"), c("git status", Source::Schema)], "git");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].source, Source::Schema);
}

#[test]
fn among_equal_history_entries_the_more_recent_wins() {
    let mut a = h("git push");
    a.recency = Some(1.0);
    let mut b = h("git pull");
    b.recency = Some(9.0);
    assert_eq!(values(&rank(&[a, b], "git p")), ["git pull", "git push"]);
}

#[test]
fn a_command_run_many_times_beats_a_typo_run_once() {
    let mut typo = h("npm ryb dev");
    typo.count = Some(1);
    typo.at = Some(NOW - 60);
    typo.recency = Some(99.0);
    let mut real = h("npm run dev");
    real.count = Some(61);
    real.at = Some(NOW - 4000);
    real.recency = Some(10.0);
    assert_eq!(values(&rank(&[typo, real], "npm")), ["npm run dev"]);
}

#[test]
fn something_used_constantly_but_not_for_a_month_yields_to_today() {
    let mut clear = h("clear");
    clear.count = Some(86);
    clear.at = Some(NOW - 30 * 24 * 3600);
    let mut cargo = h("cargo build");
    cargo.count = Some(3);
    cargo.at = Some(NOW - 600);
    assert_eq!(values(&rank(&[clear, cargo], "c")), ["cargo build", "clear"]);
}

#[test]
fn the_list_is_capped() {
    let many: Vec<_> = (0..40).map(|i| h(&format!("git c{i}"))).collect();
    assert_eq!(rank(&many, "git").len(), 8);
    assert_eq!(rank_candidates(&many, "git", 3, NOW).len(), 3);
}

#[test]
fn a_word_completed_to_itself_is_not_offered() {
    let list = rank(
        &[c("checkout", Source::Schema), c("checkout-index", Source::Schema)],
        Prefix::new("checkout", "git checkout"),
    );
    assert_eq!(values(&list), ["checkout-index"]);
}

#[test]
fn the_command_you_already_typed_is_still_offered() {
    assert_eq!(values(&rank(&[h("git status"), h("git stash")], "git status")), ["git status"]);
}

#[test]
fn flag_variants_are_one_family() {
    let list = rank(&[run("ls", 47), run("ls -l", 5), run("ls -a", 3), run("ls -la", 2), run("cat file", 9)], "ls");
    let ls: Vec<_> = values(&list).into_iter().filter(|v| v.starts_with("ls")).collect();
    assert_eq!(ls.len(), 2, "{ls:?}");
    assert_eq!(ls[0], "ls");
}

#[test]
fn a_real_argument_is_not_a_flag_variant() {
    let list = rank(&[run("docker compose down", 9), run("docker compose up -d", 8)], "docker compose");
    assert_eq!(list.len(), 2);
}

#[test]
fn an_empty_candidate_is_never_offered() {
    assert_eq!(rank(&[h(""), h("git")], "g"), vec![h("git")]);
}

#[test]
fn a_schema_entry_inherits_the_runs_of_the_commands_that_start_with_it() {
    let out = weigh_by_usage(
        &[c("merge", Source::Schema)],
        &[past("git merge main", 4, 0.9), past("git merge dev", 2, 0.5)],
        "git ",
    );
    assert_eq!(out[0].count, Some(6));
    assert_eq!(out[0].freshness, Some(0.9));
}

#[test]
fn it_counts_whole_words_not_prefixes() {
    let r = weigh_by_usage(&[c("r", Source::Schema)], &[past("npm run dev", 70, 1.0)], "npm ");
    assert_eq!(r[0].count, None);
    let run = weigh_by_usage(&[c("run", Source::Schema)], &[past("npm run dev", 70, 1.0)], "npm ");
    assert_eq!(run[0].count, Some(70));
    let status = weigh_by_usage(&[c("status", Source::Schema)], &[past("git status", 9, 1.0)], "git ");
    assert_eq!(status[0].count, Some(9));
}

#[test]
fn an_unused_entry_and_history_pass_through_untouched() {
    let archive = weigh_by_usage(&[c("archive", Source::Schema)], &[past("git merge main", 4, 1.0)], "git ");
    assert_eq!(archive[0], c("archive", Source::Schema));
    let entry = past("git merge main", 4, 1.0);
    assert_eq!(weigh_by_usage(&[entry.clone()], &[entry.clone()], "git ")[0], entry);
}

#[test]
fn a_used_schema_entry_outranks_an_unused_one() {
    let list = rank(
        &weigh_by_usage(
            &[c("archive", Source::Schema), c("merge", Source::Schema)],
            &[past("git merge main", 6, 1.0)],
            "git ",
        ),
        Prefix::new("", "git "),
    );
    assert_eq!(values(&list), ["merge", "archive"]);
}

#[test]
fn a_command_you_run_outranks_a_schema_entry_you_never_have() {
    let mut all = weigh_by_usage(&[c("archive", Source::Schema)], &[], "git ");
    all.push(past("git merge main", 6, 1.0));
    assert_eq!(values(&rank(&all, Prefix::new("", "git "))), ["git merge main", "archive"]);
}

#[test]
fn a_family_of_variations_gets_two_rows() {
    let list = rank(
        &[
            run("claude-work --resume aaaa", 1),
            run("claude-work --resume bbbb", 1),
            run("claude-work --resume cccc", 1),
            run("claude-work --resume dddd", 1),
            run("claude-work stop aaaa", 1),
            run("claude-work attach aaaa", 1),
        ],
        "claude",
    );
    let v = values(&list);
    assert_eq!(v.iter().filter(|x| x.starts_with("claude-work --resume")).count(), 2);
    assert!(v.contains(&"claude-work stop aaaa"));
    assert!(v.contains(&"claude-work attach aaaa"));
}

#[test]
fn commands_that_differ_early_are_not_one_family() {
    let list = rank(&[run("docker compose down", 9), run("docker compose up -d", 8), run("docker ps -a", 7)], "docker ");
    assert_eq!(values(&list), ["docker compose down", "docker compose up -d", "docker ps -a"]);
}

#[test]
fn a_one_off_a_couple_of_edits_from_a_popular_command_is_dropped() {
    let dropped = |typo: &str, real: &str| {
        let list = rank(&[run(real, 20), run(typo, 1)], &real[..3]);
        !values(&list).contains(&typo)
    };
    assert!(dropped("docker compoe up", "docker compose up"));
    assert!(dropped("cd Projects/sh", "cd Projects sh") || dropped("cd Projects sh", "cd Projects/sh"));
    assert!(dropped("cd Projects/app/", "cd Projects/app"));
    assert!(dropped("npm ryb dev", "npm run dev"));
}

#[test]
fn commands_run_often_are_never_typos_of_each_other() {
    assert_eq!(values(&rank(&[run("git push", 30), run("git pull", 25)], "git p")), ["git push", "git pull"]);
    assert!(values(&rank(&[run("npm run dev", 40), run("npm publish", 1)], "npm")).contains(&"npm publish"));
}

#[test]
fn the_list_still_fills_up() {
    let many: Vec<_> = (0..20).map(|i| run(&format!("cmd{i} arg"), 5)).collect();
    assert_eq!(rank(&many, "cmd").len(), 8);
}

#[test]
fn a_schema_entry_is_never_dropped_as_a_typo() {
    let list = rank(&[run("git stash save", 20), c("stash", Source::Schema)], Prefix::new("st", "git st"));
    assert!(values(&list).contains(&"stash"));
}

#[test]
fn never_run_executables_get_a_couple_of_rows() {
    let list = rank(
        &[
            run("ls", 47),
            c("lsvfs", Source::Path),
            c("lsmp", Source::Path),
            c("lsbom", Source::Path),
            c("lsappinfo", Source::Path),
            c("lsm", Source::Path),
        ],
        "ls",
    );
    let v = values(&list);
    assert_eq!(v.iter().filter(|x| x.starts_with("ls") && **x != "ls").count(), 2);
    assert!(v.contains(&"ls"));
}

#[test]
fn schema_entries_are_not_capped_like_unrelated_binaries() {
    let list = rank(
        &["commit", "cp", "create", "config", "container"].map(|v| c(v, Source::Schema)),
        Prefix::new("c", "docker c"),
    );
    assert_eq!(list.len(), 5);
}
