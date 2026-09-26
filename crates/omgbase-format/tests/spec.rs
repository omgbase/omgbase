//! The format spec conformance runner: executes every fixture under
//! `spec/format/cases` against this implementation. The fixture format, the
//! invariants and the allowlist mechanism are defined in
//! `spec/format/README.md`; the reference runner this mirrors is
//! `packages/core/corpus/format/spec.test.ts`.
//!
//! Allowlist (`tests/spec-passing.txt`, one `<file-stem>::<name>` per line):
//! while the port is incomplete it names the cases that must pass. A listed
//! case that fails, an unlisted case that passes, or a listed id that no
//! longer exists all fail the build. If the file is absent, every case must
//! pass. Promote cases by rewriting the list to the currently passing set:
//!
//! ```text
//! FORMAT_SPEC_UPDATE=1 cargo test -p omgbase-format --test spec
//! ```

mod common;

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use omgbase_format::hash::hex;
use omgbase_format::{AttrValue, Block, BlockKind, BlockTree, parse_markdown};
use serde_json::Value as Json;

const CASES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/format/cases");
const PASSING_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/spec-passing.txt");
/// A wrong `CASES_DIR` must not pass by finding some other, smaller directory.
const MIN_CASE_FILES: usize = 3;
/// Cap on detail lines per report section.
const MAX_REPORT_LINES: usize = 400;
/// The only `format` this crate implements so far.
const FORMAT: &str = "markdown";
/// Every block in a fixture carries exactly these fields (§5).
const BLOCK_FIELDS: [&str; 7] = [
    "type", "span", "text", "attrs", "trivia", "raw_hash", "children",
];

const PASSING_HEADER: &str = "\
# Format spec cases (spec/format/cases) that the Rust port must pass, one
# `<file-stem>::<name>` id per line, sorted. Maintained by tests/spec.rs:
# a listed case failing fails the build; an unlisted case passing also fails
# the build (add it here). Regenerate from the currently passing set with
#
#     FORMAT_SPEC_UPDATE=1 cargo test -p omgbase-format --test spec
#
# When every case passes, delete this file (the runner then requires all).
";

// ---- fixture shape -----------------------------------------------------------

struct SpecCase {
    id: String,
    source: String,
    leading_trivia: String,
    blocks: Vec<Json>,
}

struct SpecFile {
    stem: String,
    cases: Vec<SpecCase>,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Validate one fixture block (recursively), pushing problems.
fn validate_block(at: &str, b: &Json, problems: &mut Vec<String>) {
    let Some(obj) = b.as_object() else {
        problems.push(format!("{at}: block is not an object"));
        return;
    };
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let mut want = BLOCK_FIELDS;
    want.sort_unstable();
    if keys != want {
        problems.push(format!(
            "{at}: block must have exactly the fields {want:?}, has {keys:?}"
        ));
    }
    match obj.get("type").and_then(Json::as_str) {
        Some(t) if t.parse::<BlockKind>().is_ok() => {}
        Some(t) => problems.push(format!("{at}: unknown block type {t:?}")),
        None => problems.push(format!("{at}: `type` must be a string")),
    }
    match obj.get("span").and_then(Json::as_array) {
        Some(span) if span.len() == 2 => match (span[0].as_u64(), span[1].as_u64()) {
            (Some(s), Some(e)) if s <= e => {}
            _ => problems.push(format!(
                "{at}: `span` must be two non-negative integers, start <= end"
            )),
        },
        _ => problems.push(format!("{at}: `span` must be a two-element array")),
    }
    if !obj.get("text").is_some_and(Json::is_string) {
        problems.push(format!("{at}: `text` must be a string"));
    }
    if !obj.get("attrs").is_some_and(Json::is_object) {
        problems.push(format!("{at}: `attrs` must be an object"));
    } else if let Some(attrs) = obj.get("attrs").and_then(Json::as_object) {
        for (k, v) in attrs {
            let ok = match v {
                Json::Bool(_) | Json::String(_) => true,
                Json::Number(n) => n.is_i64(),
                _ => false,
            };
            if !ok {
                problems.push(format!(
                    "{at}: attrs.{k} must be a boolean, integer or string"
                ));
            }
        }
    }
    if !obj.get("trivia").is_some_and(Json::is_string) {
        problems.push(format!("{at}: `trivia` must be a string"));
    }
    match obj.get("raw_hash").and_then(Json::as_str) {
        Some(h) if is_hex64(h) => {}
        _ => problems.push(format!(
            "{at}: `raw_hash` must be 64 lowercase hex characters"
        )),
    }
    match obj.get("children").and_then(Json::as_array) {
        Some(children) => {
            for (i, c) in children.iter().enumerate() {
                if c.get("trivia")
                    .and_then(Json::as_str)
                    .is_some_and(|t| !t.is_empty())
                {
                    problems.push(format!(
                        "{at}/children/{i}: nested block must have trivia \"\""
                    ));
                }
                validate_block(&format!("{at}/children/{i}"), c, problems);
            }
        }
        None => problems.push(format!("{at}: `children` must be an array")),
    }
}

/// Validate one fixture document exactly as the reference runner does,
/// returning the problems found (empty = valid) and, if valid, the cases.
fn validate(file: &str, doc: &Json) -> Result<Vec<SpecCase>, Vec<String>> {
    let stem = file.trim_end_matches(".json");
    let mut problems = Vec::new();
    let Some(doc) = doc.as_object() else {
        return Err(vec![format!("{file}: not an object")]);
    };
    match doc.get("suite").and_then(Json::as_str) {
        Some(s) if s == stem => {}
        Some(s) => problems.push(format!(
            "{file}: `suite` {s:?} must equal the file stem {stem:?}"
        )),
        None => problems.push(format!("{file}: missing `suite`")),
    }
    match doc.get("format").and_then(Json::as_str) {
        Some(FORMAT) => {}
        Some(f) => problems.push(format!("{file}: `format` {f:?} is not {FORMAT:?}")),
        None => problems.push(format!("{file}: missing `format`")),
    }
    let cases = match doc.get("cases") {
        Some(Json::Array(cases)) if !cases.is_empty() => cases,
        _ => {
            problems.push(format!("{file}: `cases` must be a non-empty array"));
            return Err(problems);
        }
    };
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(cases.len());
    for (i, c) in cases.iter().enumerate() {
        let at = format!("{file}#{i}");
        let Some(c) = c.as_object() else {
            problems.push(format!("{at}: not an object"));
            continue;
        };
        let name = match c.get("name") {
            Some(Json::String(n)) if !n.is_empty() => {
                if !seen.insert(n.clone()) {
                    problems.push(format!("{at}: duplicate name '{n}'"));
                }
                n.clone()
            }
            _ => {
                problems.push(format!("{at}: missing `name`"));
                String::new()
            }
        };
        if c.get("notes").is_some_and(|n| !n.is_string()) {
            problems.push(format!("{at}: `notes` must be a string"));
        }
        let Some(source) = c.get("source").and_then(Json::as_str) else {
            problems.push(format!("{at}: `source` must be a string"));
            continue;
        };
        let Some(expect) = c.get("expect").and_then(Json::as_object) else {
            problems.push(format!("{at}: missing `expect`"));
            continue;
        };
        let Some(leading_trivia) = expect.get("leading_trivia").and_then(Json::as_str) else {
            problems.push(format!("{at}: `expect.leading_trivia` must be a string"));
            continue;
        };
        let Some(blocks) = expect.get("blocks").and_then(Json::as_array) else {
            problems.push(format!("{at}: `expect.blocks` must be an array"));
            continue;
        };
        for (j, b) in blocks.iter().enumerate() {
            validate_block(&format!("{at}/blocks/{j}"), b, &mut problems);
        }
        out.push(SpecCase {
            id: format!("{stem}::{name}"),
            source: source.to_owned(),
            leading_trivia: leading_trivia.to_owned(),
            blocks: blocks.clone(),
        });
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(problems)
    }
}

/// Every `*.json` under `CASES_DIR`, sorted, parsed and validated. Files that
/// fail validation are reported in `problems` and omitted from `files`.
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

// ---- comparison ------------------------------------------------------------------

fn attr_json(v: &AttrValue) -> Json {
    match v {
        AttrValue::Bool(b) => Json::Bool(*b),
        AttrValue::Int(n) => Json::from(*n),
        AttrValue::Str(s) => Json::String(s.clone()),
    }
}

/// The implementation's block in fixture shape (§5), for reporting.
fn block_json(b: &Block) -> Json {
    let mut attrs = serde_json::Map::new();
    for (k, v) in &b.attrs {
        attrs.insert(k.clone(), attr_json(v));
    }
    serde_json::json!({
        "type": b.kind.as_str(),
        "span": [b.span.start, b.span.end],
        "text": b.text,
        "attrs": attrs,
        "trivia": b.trivia,
        "raw_hash": hex(&b.raw_hash()),
        "children": b.children.iter().map(block_json).collect::<Vec<_>>(),
    })
}

/// JSON equality with object key order ignored (attrs, §3).
fn json_eq(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => x.as_f64() == y.as_f64(),
        (Json::Array(x), Json::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q))
        }
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
        }
        _ => a == b,
    }
}

/// Clip a one-line diagnostic so a big tree cannot flood the report.
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

/// Deep-compare one implementation block against its fixture (spans exact,
/// strings exact, attrs as JSON with key order ignored, children recursive).
fn compare_block(path: &str, got: &Block, want: &Json) -> Result<(), String> {
    let mismatch = |field: &str, got_v: &dyn std::fmt::Display, want_v: &dyn std::fmt::Display| {
        Err(clip(format!(
            "{path}: {field}: got {got_v}, expected {want_v}"
        )))
    };
    let want_type = want["type"].as_str().unwrap_or_default();
    if got.kind.as_str() != want_type {
        return mismatch("type", &got.kind, &want_type);
    }
    let want_span = (
        want["span"][0].as_u64().unwrap_or_default() as usize,
        want["span"][1].as_u64().unwrap_or_default() as usize,
    );
    if (got.span.start, got.span.end) != want_span {
        return mismatch(
            "span",
            &format!("[{}, {}) {:?}", got.span.start, got.span.end, got.raw),
            &format!("[{}, {})", want_span.0, want_span.1),
        );
    }
    let want_text = want["text"].as_str().unwrap_or_default();
    if got.text != want_text {
        return mismatch(
            "text",
            &format!("{:?}", got.text),
            &format!("{want_text:?}"),
        );
    }
    let got_attrs = block_json(got)["attrs"].clone();
    if !json_eq(&got_attrs, &want["attrs"]) {
        return mismatch("attrs", &got_attrs, &want["attrs"]);
    }
    let want_trivia = want["trivia"].as_str().unwrap_or_default();
    if got.trivia != want_trivia {
        return mismatch(
            "trivia",
            &format!("{:?}", got.trivia),
            &format!("{want_trivia:?}"),
        );
    }
    let got_hash = hex(&got.raw_hash());
    let want_hash = want["raw_hash"].as_str().unwrap_or_default();
    if got_hash != want_hash {
        return mismatch("raw_hash", &got_hash, &want_hash);
    }
    let want_children = want["children"].as_array().map_or(&[][..], Vec::as_slice);
    if got.children.len() != want_children.len() {
        let got_kinds: Vec<&str> = got.children.iter().map(|c| c.kind.as_str()).collect();
        let want_kinds: Vec<&str> = want_children
            .iter()
            .map(|c| c["type"].as_str().unwrap_or_default())
            .collect();
        return mismatch(
            "children",
            &format!("{} {got_kinds:?}", got.children.len()),
            &format!("{} {want_kinds:?}", want_children.len()),
        );
    }
    for (i, (g, w)) in got.children.iter().zip(want_children).enumerate() {
        compare_block(&format!("{path}/{i}"), g, w)?;
    }
    Ok(())
}

fn compare_tree(tree: &BlockTree, c: &SpecCase) -> Result<(), String> {
    if tree.leading_trivia != c.leading_trivia {
        return Err(clip(format!(
            "leading_trivia: got {:?}, expected {:?}",
            tree.leading_trivia, c.leading_trivia
        )));
    }
    if tree.children.len() != c.blocks.len() {
        let got: Vec<&str> = tree.children.iter().map(|b| b.kind.as_str()).collect();
        let want: Vec<&str> = c
            .blocks
            .iter()
            .map(|b| b["type"].as_str().unwrap_or_default())
            .collect();
        return Err(clip(format!(
            "blocks: got {} {got:?}, expected {} {want:?}",
            got.len(),
            want.len()
        )));
    }
    for (i, (g, w)) in tree.children.iter().zip(&c.blocks).enumerate() {
        compare_block(&format!("blocks/{i}"), g, w)?;
    }
    Ok(())
}

fn check(c: &SpecCase) -> Result<(), String> {
    let tree = parse_markdown(&c.source);
    common::check_invariants(&tree).map_err(|e| clip(format!("invariant: {e}")))?;
    compare_tree(&tree, c)
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
    std::env::var("FORMAT_SPEC_UPDATE").is_ok_and(|v| !v.is_empty() && v != "0")
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
    // (id, reason) in fixture order
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
        "cases that pass but are not listed in spec-passing.txt — add them (or run FORMAT_SPEC_UPDATE=1 cargo test -p omgbase-format --test spec)",
        &unlisted_passing,
    );
    report("stale allowlist entries", &stale);
    if passing == all_ids {
        eprintln!(
            "spec: every case passes — delete tests/spec-passing.txt (or run with FORMAT_SPEC_UPDATE=1)"
        );
    }
    assert!(
        regressions.is_empty() && unlisted_passing.is_empty() && stale.is_empty(),
        "spec allowlist out of date: {} regression(s), {} unlisted passing, {} stale — see the report above (stderr); \
         promote with `FORMAT_SPEC_UPDATE=1 cargo test -p omgbase-format --test spec`",
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
    for f in &loaded.files {
        let mut seen = BTreeSet::new();
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

/// The fixture `source` is the byte sequence the spans index: every fixture
/// span must be a valid range of it, and every `raw_hash` must be the hash
/// of that slice — the fixture is self-consistent before the port is judged.
#[test]
fn fixture_spans_and_hashes_are_self_consistent() {
    if !spec_available() {
        return;
    }

    fn walk(source: &str, at: &str, b: &Json, problems: &mut Vec<String>) {
        let s = b["span"][0].as_u64().unwrap_or_default() as usize;
        let e = b["span"][1].as_u64().unwrap_or_default() as usize;
        match source.get(s..e) {
            None => problems.push(format!(
                "{at}: span [{s}, {e}) is not a char-boundary range of source"
            )),
            Some(raw) => {
                if raw.ends_with(['\n', '\r']) {
                    problems.push(format!("{at}: raw ends in a line ending"));
                }
                let h = hex(&omgbase_format::hash::raw_hash(raw));
                if Some(h.as_str()) != b["raw_hash"].as_str() {
                    problems.push(format!("{at}: raw_hash is not sha256(source[span])"));
                }
            }
        }
        for (i, c) in b["children"].as_array().into_iter().flatten().enumerate() {
            walk(source, &format!("{at}/{i}"), c, problems);
        }
    }

    let loaded = load();
    let mut problems = Vec::new();
    let mut checked = 0usize;
    for f in &loaded.files {
        for c in &f.cases {
            if !c.source.starts_with(&c.leading_trivia) {
                problems.push(format!(
                    "{}: leading_trivia is not a prefix of source",
                    c.id
                ));
            }
            for (i, b) in c.blocks.iter().enumerate() {
                walk(&c.source, &format!("{}/blocks/{i}", c.id), b, &mut problems);
                checked += 1;
            }
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
    assert!(checked > 0, "no blocks checked");
}

/// The runner's private JSON shape must agree with the crate's `json`
/// feature on every parsed fixture source, so the two cannot drift.
#[cfg(feature = "json")]
#[test]
fn runner_shape_agrees_with_the_json_feature() {
    if !spec_available() {
        return;
    }

    let loaded = load();
    let mut checked = 0usize;
    for f in &loaded.files {
        for c in &f.cases {
            let tree = parse_markdown(&c.source);
            for b in &tree.children {
                assert!(json_eq(&block_json(b), &b.to_json()), "{}", c.id);
                checked += 1;
            }
            assert_eq!(
                tree.to_json()["leading_trivia"],
                Json::String(tree.leading_trivia.clone())
            );
        }
    }
    assert!(checked > 0, "checked no blocks");
}
