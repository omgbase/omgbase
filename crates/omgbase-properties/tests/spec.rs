//! The properties spec conformance runner: executes every fixture under
//! `spec/properties/cases` against this implementation. The fixture format
//! and the runner checks are `spec/properties/README.md` §7; the reference
//! runner this mirrors is `packages/core/corpus/properties/spec.test.ts`.
//!
//! Allowlist (`tests/spec-passing.txt`, one `<file-stem>::<name>` per line):
//! while the port is incomplete it names the cases that must pass. A listed
//! case that fails, an unlisted case that passes, or a listed id that no
//! longer exists all fail the build. If the file is absent, every case must
//! pass. Promote cases by rewriting the list to the currently passing set:
//!
//! ```text
//! PROPERTIES_SPEC_UPDATE=1 cargo test -p omgbase-properties --test spec
//! ```

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use omgbase_format::{Block, BlockKind, parse_markdown};
use omgbase_properties::{DocBlock, PropertyRow, doc_properties, grouped, merged, prop_id};
use serde_json::{Map as JsonMap, Value as Json, json};

const CASES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/properties/cases");
const PASSING_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/spec-passing.txt");
/// A wrong `CASES_DIR` must not pass by finding some other, smaller directory.
const MIN_CASE_FILES: usize = 3;
/// Cap on detail lines per report section.
const MAX_REPORT_LINES: usize = 400;
/// Numbers are IEEE doubles carried at full precision; compare within this (§7).
const EPS: f64 = 1e-9;
/// §7: the fixture document id.
const DOC_ID: &str = "d_0";

const CASE_KEYS: [&str; 4] = ["name", "notes", "source", "expect"];
const EXPECT_KEYS: [&str; 3] = ["rows", "grouped", "merged"];
/// §1, in the fixture's order.
const ROW_KEYS: [&str; 11] = [
    "prop_id", "block_id", "source", "key", "card", "ord", "type", "val_text", "val_num",
    "val_bool", "val_json",
];
const SOURCES: [&str; 3] = ["frontmatter", "inline", "computed"];

const PASSING_HEADER: &str = "\
# Properties spec cases (spec/properties/cases) that the Rust port must pass,
# one `<file-stem>::<name>` id per line, sorted. Maintained by tests/spec.rs:
# a listed case failing fails the build; an unlisted case passing also fails
# the build (add it here). Regenerate from the currently passing set with
#
#     PROPERTIES_SPEC_UPDATE=1 cargo test -p omgbase-properties --test spec
#
# When every case passes, delete this file (the runner then requires all).
";

// ---- fixture shape -----------------------------------------------------------

struct SpecCase {
    id: String,
    case: Json,
}

struct SpecFile {
    stem: String,
    cases: Vec<SpecCase>,
}

fn unknown_keys(obj: &JsonMap<String, Json>, allowed: &[&str]) -> Vec<String> {
    obj.keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .cloned()
        .collect()
}

fn validate_row(at: &str, row: &Json, problems: &mut Vec<String>) {
    let Some(obj) = row.as_object() else {
        problems.push(format!("{at}: row is not an object"));
        return;
    };
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let mut want: Vec<&str> = ROW_KEYS.to_vec();
    want.sort_unstable();
    if keys != want {
        problems.push(format!(
            "{at}: a row carries exactly the eleven §1 fields (got {})",
            keys.join(", ")
        ));
    }
    if !obj.get("prop_id").and_then(Json::as_str).is_some_and(|p| {
        p.len() == 14 && p.starts_with("p_") && p[2..].chars().all(|c| c.is_ascii_hexdigit())
    }) {
        problems.push(format!("{at}: prop_id must be `p_` + 12 hex characters"));
    }
    if !obj
        .get("source")
        .and_then(Json::as_str)
        .is_some_and(|s| SOURCES.contains(&s))
    {
        problems.push(format!(
            "{at}: source must be frontmatter | inline | computed"
        ));
    }
    if !obj
        .get("card")
        .and_then(Json::as_str)
        .is_some_and(|s| s == "scalar" || s == "list")
    {
        problems.push(format!("{at}: card must be scalar | list"));
    }
    if !obj
        .get("type")
        .and_then(Json::as_str)
        .is_some_and(|s| ["string", "number", "bool", "null", "json"].contains(&s))
    {
        problems.push(format!(
            "{at}: type must be string | number | bool | null | json"
        ));
    }
    if !obj.get("ord").is_some_and(Json::is_u64) {
        problems.push(format!("{at}: ord must be a non-negative integer"));
    }
    if !obj.get("key").is_some_and(Json::is_string) {
        problems.push(format!("{at}: key must be a string"));
    }
    if let Some(v) = obj.get("val_num") {
        let ok = v.is_null()
            || v.is_number()
            || v.as_str()
                .is_some_and(|s| ["Infinity", "-Infinity", "NaN"].contains(&s));
        if !ok {
            problems.push(format!(
                "{at}: val_num must be a number, null, or one of the non-finite strings"
            ));
        }
    }
}

/// Validate one fixture file as the reference's runner does.
fn validate(file: &str, doc: &Json) -> Result<Vec<SpecCase>, Vec<String>> {
    let stem = file.trim_end_matches(".json");
    let mut problems = Vec::new();
    let Some(obj) = doc.as_object() else {
        return Err(vec![format!("{file}: not an object")]);
    };
    if obj.get("suite").and_then(Json::as_str) != Some(stem) {
        problems.push(format!(
            "{file}: `suite` must equal the file stem '{stem}' (got {:?})",
            obj.get("suite")
        ));
    }
    let extra = unknown_keys(obj, &["suite", "cases"]);
    if !extra.is_empty() {
        problems.push(format!(
            "{file}: unknown top-level keys {}",
            extra.join(", ")
        ));
    }
    let cases = match obj.get("cases").and_then(Json::as_array) {
        Some(cases) if !cases.is_empty() => cases,
        _ => {
            problems.push(format!("{file}: `cases` must be a non-empty array"));
            return Err(problems);
        }
    };

    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(cases.len());
    for (i, c) in cases.iter().enumerate() {
        let at = format!("{file}#{i}");
        let Some(cobj) = c.as_object() else {
            problems.push(format!("{at}: not an object"));
            continue;
        };
        let unknown = unknown_keys(cobj, &CASE_KEYS);
        if !unknown.is_empty() {
            problems.push(format!("{at}: unknown case keys {}", unknown.join(", ")));
        }
        let name = match cobj.get("name").and_then(Json::as_str) {
            Some(n) if !n.is_empty() => {
                if !seen.insert(n.to_owned()) {
                    problems.push(format!("{at}: duplicate name '{n}'"));
                }
                n.to_owned()
            }
            _ => {
                problems.push(format!("{at}: missing `name`"));
                String::new()
            }
        };
        if cobj.get("notes").is_some_and(|n| !n.is_string()) {
            problems.push(format!("{at}: `notes` must be a string"));
        }
        if !cobj.get("source").is_some_and(Json::is_string) {
            problems.push(format!("{at}: `source` must be a string"));
        }
        let Some(expect) = cobj.get("expect") else {
            problems.push(format!(
                "{at}: missing `expect` (run PROPERTIES_SPEC_UPDATE=1)"
            ));
            continue;
        };
        match expect.as_object() {
            Some(e) => {
                let extra = unknown_keys(e, &EXPECT_KEYS);
                if !extra.is_empty() {
                    problems.push(format!("{at}.expect: unknown keys {}", extra.join(", ")));
                }
                match e.get("rows").and_then(Json::as_array) {
                    Some(rows) => {
                        for (j, r) in rows.iter().enumerate() {
                            validate_row(&format!("{at}.expect.rows[{j}]"), r, &mut problems);
                        }
                    }
                    None => problems.push(format!("{at}.expect.rows must be an array")),
                }
                match e.get("grouped").and_then(Json::as_object) {
                    Some(g) => {
                        let mut keys: Vec<&str> = g.keys().map(String::as_str).collect();
                        keys.sort_unstable();
                        let mut want = SOURCES.to_vec();
                        want.sort_unstable();
                        if keys != want || !g.values().all(Json::is_object) {
                            problems.push(format!(
                                "{at}.expect.grouped must have exactly the three source objects"
                            ));
                        }
                    }
                    None => problems.push(format!("{at}.expect.grouped must be an object")),
                }
                if !e.get("merged").is_some_and(Json::is_object) {
                    problems.push(format!("{at}.expect.merged must be an object"));
                }
            }
            None => problems.push(format!("{at}.expect must be an object")),
        }
        out.push(SpecCase {
            id: format!("{stem}::{name}"),
            case: c.clone(),
        });
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(problems)
    }
}

struct Loaded {
    file_names: Vec<String>,
    files: Vec<SpecFile>,
    problems: Vec<String>,
}

/// The fixtures live in the monorepo, outside this crate, and are not shipped
/// in the published package. When the crate is built on its own (e.g. `cargo
/// test` on a crates.io download), every conformance test skips with a note
/// instead of failing on a missing directory.
fn spec_available() -> bool {
    if Path::new(CASES_DIR).is_dir() {
        return true;
    }
    eprintln!(
        "spec: fixtures not present at {CASES_DIR} (built outside the omgbase monorepo); skipping"
    );
    false
}

fn load() -> Loaded {
    let dir = Path::new(CASES_DIR);
    let mut file_names: Vec<String> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|entry| {
            entry
                .expect("readable directory entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.ends_with(".json"))
        .collect();
    file_names.sort();
    let mut files = Vec::new();
    let mut problems = Vec::new();
    for name in &file_names {
        let text = match fs::read_to_string(dir.join(name)) {
            Ok(t) => t,
            Err(e) => {
                problems.push(format!("{name}: {e}"));
                continue;
            }
        };
        let doc: Json = match serde_json::from_str(&text) {
            Ok(d) => d,
            Err(e) => {
                problems.push(format!("{name}: {e}"));
                continue;
            }
        };
        match validate(name, &doc) {
            Ok(cases) => files.push(SpecFile {
                stem: name.trim_end_matches(".json").to_owned(),
                cases,
            }),
            Err(found) => problems.extend(found),
        }
    }
    Loaded {
        file_names,
        files,
        problems,
    }
}

// ---- evaluation ----------------------------------------------------------------------

/// §7 "Inputs": parse per spec/format, split the `frontmatter` block off,
/// assign `b_0`, `b_1`, … in pre-order over the body, doc id `d_0`.
fn evaluate(source: &str) -> Vec<PropertyRow> {
    let tree = parse_markdown(source);
    let (frontmatter, body): (Option<&Block>, &[Block]) = match tree.children.first() {
        Some(b) if b.kind == BlockKind::Frontmatter => (Some(b), &tree.children[1..]),
        _ => (None, &tree.children[..]),
    };
    let ids: Vec<String> = (0..DocBlock::count(body))
        .map(|i| format!("b_{i}"))
        .collect();
    let blocks = DocBlock::from_blocks(body, &ids);
    doc_properties(DOC_ID, frontmatter, &blocks)
}

fn source_rank(s: &str) -> u8 {
    match s {
        "frontmatter" => 0,
        "inline" => 1,
        _ => 2,
    }
}

/// §7 "Expect": `val_json` as parsed JSON, non-finite `val_num` as strings,
/// `val_bool` as 1/0.
fn row_json(r: &PropertyRow) -> Json {
    let val_num = match r.val_num {
        None => Json::Null,
        Some(n) if n.is_nan() => Json::String("NaN".to_owned()),
        Some(n) if n.is_infinite() => {
            Json::String(if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned())
        }
        Some(n) => Json::from(n),
    };
    let val_json = match r.val_json.as_deref() {
        None => Json::Null,
        Some(text) => serde_json::from_str(text)
            .unwrap_or_else(|e| panic!("val_json is not JSON ({e}): {text}")),
    };
    json!({
        "prop_id": r.prop_id,
        "block_id": r.block_id,
        "source": r.source.as_str(),
        "key": r.key,
        "card": r.card.as_str(),
        "ord": r.ord,
        "type": r.ty.as_str(),
        "val_text": r.val_text,
        "val_num": val_num,
        "val_bool": r.val_bool.map(i64::from),
        "val_json": val_json,
    })
}

/// Rows sorted by (source rank, key bytewise, ord).
fn rows_json(rows: &[PropertyRow]) -> Json {
    let mut sorted: Vec<&PropertyRow> = rows.iter().collect();
    sorted.sort_by(|a, b| {
        source_rank(a.source.as_str())
            .cmp(&source_rank(b.source.as_str()))
            .then_with(|| a.key.as_bytes().cmp(b.key.as_bytes()))
            .then_with(|| a.ord.cmp(&b.ord))
    });
    Json::Array(sorted.into_iter().map(row_json).collect())
}

/// §7 "Runner checks": every `prop_id` equals the §1 derivation from the
/// row's own fields; `prop_id`s are unique.
fn check_ids(rows: &[PropertyRow]) -> Vec<String> {
    let mut problems = Vec::new();
    let mut seen = BTreeSet::new();
    for r in rows {
        let want = prop_id(DOC_ID, r.source, &r.key, r.ord);
        if r.prop_id != want {
            problems.push(format!(
                "{}/{}/{}: prop_id {} != derived {want}",
                r.source, r.key, r.ord, r.prop_id
            ));
        }
        if !seen.insert(r.prop_id.as_str()) {
            problems.push(format!("prop_id {} is not unique", r.prop_id));
        }
    }
    problems
}

/// The fixture's `expect.rows` may carry `prop_id`s too; check them against
/// the derivation as well so a stale fixture is caught, not matched.
fn check_fixture_ids(rows: &Json) -> Vec<String> {
    let mut problems = Vec::new();
    let mut seen = BTreeSet::new();
    for r in rows.as_array().into_iter().flatten() {
        let (Some(id), Some(source), Some(key), Some(ord)) = (
            r["prop_id"].as_str(),
            r["source"].as_str(),
            r["key"].as_str(),
            r["ord"].as_u64(),
        ) else {
            continue;
        };
        let Some(source) = omgbase_properties::Source::parse(source) else {
            continue;
        };
        let want = prop_id(DOC_ID, source, key, u32::try_from(ord).unwrap_or(u32::MAX));
        if id != want {
            problems.push(format!(
                "fixture row {source}/{key}/{ord}: prop_id {id} != derived {want}"
            ));
        }
        if !seen.insert(id) {
            problems.push(format!("fixture prop_id {id} is not unique"));
        }
    }
    problems
}

// ---- comparison ----------------------------------------------------------------------

/// Deep-compare two JSON values, object key order ignored, numbers within
/// `EPS`. `None` when equal, else the path and values of the first difference.
fn deep_eq_tol(a: &Json, b: &Json, path: &str) -> Option<String> {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => {
            let (x, y) = (
                x.as_f64().unwrap_or(f64::NAN),
                y.as_f64().unwrap_or(f64::NAN),
            );
            if (x - y).abs() <= EPS || (x.is_nan() && y.is_nan()) {
                None
            } else {
                Some(format!("{path}: {x} vs {y}"))
            }
        }
        (Json::Array(x), Json::Array(y)) => {
            if x.len() != y.len() {
                return Some(format!("{path}: length {} vs {}", x.len(), y.len()));
            }
            x.iter()
                .zip(y)
                .enumerate()
                .find_map(|(i, (p, q))| deep_eq_tol(p, q, &format!("{path}[{i}]")))
        }
        (Json::Object(x), Json::Object(y)) => {
            let ka: BTreeSet<&String> = x.keys().collect();
            let kb: BTreeSet<&String> = y.keys().collect();
            if ka != kb {
                return Some(format!(
                    "{path}: keys {{{}}} vs {{{}}}",
                    ka.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(","),
                    kb.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(",")
                ));
            }
            ka.into_iter()
                .find_map(|k| deep_eq_tol(&x[k], &y[k], &format!("{path}.{k}")))
        }
        (Json::Array(_), _) | (_, Json::Array(_)) => Some(format!("{path}: array vs non-array")),
        (Json::Object(_), _) | (_, Json::Object(_)) => {
            Some(format!("{path}: object vs non-object"))
        }
        _ => (a != b).then(|| format!("{path}: {a} vs {b}")),
    }
}

/// Clip a one-line diagnostic so a big result cannot flood the report.
fn clip(s: impl Into<String>) -> String {
    const MAX: usize = 300;
    let s: String = s.into();
    let s = s.replace('\n', " ");
    if s.chars().count() <= MAX {
        return s;
    }
    let cut: String = s.chars().take(MAX).collect();
    format!("{cut}…")
}

fn check(c: &SpecCase) -> Result<(), String> {
    let source = c.case["source"].as_str().ok_or("source must be a string")?;
    let rows = evaluate(source);
    let problems = check_ids(&rows);
    if !problems.is_empty() {
        return Err(clip(format!("ids: {}", problems.join("; "))));
    }
    let want = &c.case["expect"];
    let fixture_problems = check_fixture_ids(&want["rows"]);
    if !fixture_problems.is_empty() {
        return Err(clip(format!("fixture: {}", fixture_problems.join("; "))));
    }
    let actual = json!({
        "rows": rows_json(&rows),
        "grouped": grouped(&rows),
        "merged": merged(&rows),
    });
    match deep_eq_tol(&actual, want, "expect") {
        None => Ok(()),
        Some(diff) => Err(clip(diff)),
    }
}

thread_local! {
    /// Set while a case runs so the panic hook stays quiet: a bug is reported
    /// once as a case failure, not as a stack of notes.
    static IN_CASE: Cell<bool> = const { Cell::new(false) };
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_owned()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "non-string panic payload".to_owned()
    }
}

/// Run one case, turning a panic into an ordinary failure.
fn run_case(c: &SpecCase) -> Result<(), String> {
    IN_CASE.with(|f| f.set(true));
    let outcome = panic::catch_unwind(AssertUnwindSafe(|| check(c)));
    IN_CASE.with(|f| f.set(false));
    match outcome {
        Ok(r) => r,
        Err(payload) => Err(clip(format!("panicked: {}", panic_message(payload)))),
    }
}

// ---- allowlist ------------------------------------------------------------------

fn read_allowlist(path: &Path) -> Option<BTreeSet<String>> {
    let text = fs::read_to_string(path).ok()?;
    Some(
        text.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(str::to_owned)
            .collect(),
    )
}

fn write_allowlist(path: &Path, ids: &BTreeSet<String>) {
    let mut text = String::from(PASSING_HEADER);
    for id in ids {
        text.push_str(id);
        text.push('\n');
    }
    fs::write(path, text).unwrap_or_else(|e| panic!("cannot write {}: {e}", path.display()));
}

fn update_requested() -> bool {
    std::env::var("PROPERTIES_SPEC_UPDATE").is_ok_and(|v| !v.is_empty() && v != "0")
}

/// Print `ids` (with an optional reason each) grouped by file stem, in fixture
/// order, capped at `MAX_REPORT_LINES` lines.
fn report(title: &str, ids: &[(String, Option<String>)]) {
    if ids.is_empty() {
        return;
    }
    eprintln!("\n{title} ({}):", ids.len());
    let mut by_file: BTreeMap<&str, Vec<&(String, Option<String>)>> = BTreeMap::new();
    for item in ids {
        let stem = item.0.split("::").next().unwrap_or("");
        by_file.entry(stem).or_default().push(item);
    }
    let mut printed = 0;
    'outer: for (stem, items) in by_file {
        eprintln!("  {stem}.json:");
        for (id, reason) in items {
            if printed >= MAX_REPORT_LINES {
                eprintln!("  … {} more not shown", ids.len() - printed);
                break 'outer;
            }
            match reason {
                Some(r) => eprintln!("    {id}\n        {r}"),
                None => eprintln!("    {id}"),
            }
            printed += 1;
        }
    }
}

// ---- tests -----------------------------------------------------------------------

#[test]
fn spec() {
    if !spec_available() {
        return;
    }

    let loaded = load();
    assert!(
        loaded.problems.is_empty(),
        "fixture files are not well-formed:\n{}",
        loaded.problems.join("\n")
    );
    assert!(
        loaded.file_names.len() >= MIN_CASE_FILES,
        "found only {} case files under {CASES_DIR} (expected at least {MIN_CASE_FILES}); wrong path?",
        loaded.file_names.len()
    );

    // Quiet the default panic hook while a case runs (see IN_CASE).
    let prev = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        if !IN_CASE.with(Cell::get) {
            prev(info);
        }
    }));

    let mut all_ids = BTreeSet::new();
    let mut passing = BTreeSet::new();
    let mut failing: Vec<(String, Option<String>)> = Vec::new();
    for file in &loaded.files {
        for c in &file.cases {
            all_ids.insert(c.id.clone());
            match run_case(c) {
                Ok(()) => {
                    passing.insert(c.id.clone());
                }
                Err(reason) => failing.push((c.id.clone(), Some(reason))),
            }
        }
    }
    let _ = panic::take_hook();

    let passing_path = PathBuf::from(PASSING_FILE);
    let listed = read_allowlist(&passing_path);
    let listed_count = listed.as_ref().map_or(0, BTreeSet::len);
    eprintln!(
        "spec: {} passed, {} failed, {} listed{}",
        passing.len(),
        failing.len(),
        listed_count,
        if listed.is_none() {
            " (no spec-passing.txt: every case must pass)"
        } else {
            ""
        }
    );
    assert!(
        all_ids.len() == passing.len() + failing.len(),
        "case ids are unique across files"
    );

    if update_requested() {
        let before = listed.clone().unwrap_or_default();
        let removed: Vec<(String, Option<String>)> = failing
            .iter()
            .filter(|(id, _)| before.contains(id))
            .cloned()
            .collect();
        let added = passing.difference(&before).count();
        if passing == all_ids {
            let _ = fs::remove_file(&passing_path);
            eprintln!(
                "spec: every case passes; removed {}",
                passing_path.display()
            );
        } else {
            write_allowlist(&passing_path, &passing);
            eprintln!(
                "spec: wrote {} ({} ids; +{added}, -{})",
                passing_path.display(),
                passing.len(),
                removed.len()
            );
        }
        report(
            "regressions dropped from spec-passing.txt (were listed, now fail)",
            &removed,
        );
        report("still failing (not listed)", &failing);
        return;
    }

    let Some(listed) = listed else {
        report(
            "failing cases (no spec-passing.txt: every case must pass)",
            &failing,
        );
        assert!(
            failing.is_empty(),
            "{} spec case(s) failed; see the report above (stderr)",
            failing.len()
        );
        return;
    };

    let regressions: Vec<(String, Option<String>)> = failing
        .iter()
        .filter(|(id, _)| listed.contains(id))
        .cloned()
        .collect();
    let unlisted_passing: Vec<(String, Option<String>)> = loaded
        .files
        .iter()
        .flat_map(|f| f.cases.iter())
        .filter(|c| passing.contains(&c.id) && !listed.contains(&c.id))
        .map(|c| (c.id.clone(), None))
        .collect();
    let stale: Vec<(String, Option<String>)> = listed
        .difference(&all_ids)
        .map(|id| {
            (
                id.clone(),
                Some("listed in spec-passing.txt but no such case exists".to_owned()),
            )
        })
        .collect();

    report("listed cases that FAIL (regressions)", &regressions);
    report(
        "cases that pass but are not listed in spec-passing.txt — add them (or run PROPERTIES_SPEC_UPDATE=1 cargo test -p omgbase-properties --test spec)",
        &unlisted_passing,
    );
    report("stale allowlist entries", &stale);
    if passing == all_ids {
        eprintln!(
            "spec: every case passes — delete tests/spec-passing.txt (or run with PROPERTIES_SPEC_UPDATE=1)"
        );
    }
    assert!(
        regressions.is_empty() && unlisted_passing.is_empty() && stale.is_empty(),
        "spec allowlist out of date: {} regression(s), {} unlisted passing, {} stale — see the report above (stderr); \
         promote with `PROPERTIES_SPEC_UPDATE=1 cargo test -p omgbase-properties --test spec`",
        regressions.len(),
        unlisted_passing.len(),
        stale.len()
    );
}

#[test]
fn fixture_files_are_well_formed_and_every_case_file_was_loaded() {
    if !spec_available() {
        return;
    }

    let loaded = load();
    assert_eq!(loaded.problems, Vec::<String>::new());
    assert!(
        loaded.file_names.len() >= MIN_CASE_FILES,
        "found only {} case files under {CASES_DIR}",
        loaded.file_names.len()
    );
    let loaded_names: Vec<String> = loaded
        .files
        .iter()
        .map(|f| format!("{}.json", f.stem))
        .collect();
    assert_eq!(loaded_names, loaded.file_names, "every case file must load");
    for f in &loaded.files {
        assert!(!f.cases.is_empty(), "{}.json has no cases", f.stem);
    }
}

#[test]
fn case_names_are_unique_per_file() {
    if !spec_available() {
        return;
    }

    let loaded = load();
    let mut seen = BTreeSet::new();
    for f in &loaded.files {
        for c in &f.cases {
            assert!(seen.insert(&c.id), "duplicate case id {}", c.id);
        }
    }
    assert!(
        !loaded.problems.iter().any(|p| p.contains("duplicate name")),
        "{:?}",
        loaded.problems
    );
}

/// The id invariants hold for every case's raw result, whatever the fixture
/// expects — a failing comparison must never hide a broken result.
#[test]
fn every_result_has_derived_unique_prop_ids() {
    if !spec_available() {
        return;
    }

    let loaded = load();
    let mut problems = Vec::new();
    let mut checked = 0usize;
    for f in &loaded.files {
        for c in &f.cases {
            let Some(source) = c.case["source"].as_str() else {
                problems.push(format!("{}: source is not a string", c.id));
                continue;
            };
            for p in check_ids(&evaluate(source)) {
                problems.push(format!("{}: {p}", c.id));
            }
            checked += 1;
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
    assert!(checked > 0, "no cases evaluated");
}
