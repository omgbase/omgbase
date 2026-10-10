//! The OQX spec conformance runner: executes every fixture under
//! `spec/oqx/cases` against this implementation. The fixture format, the
//! result canonicalization rules, and the allowlist mechanism are defined in
//! `spec/oqx/README.md`; the reference runner this mirrors is
//! `packages/oqx/test/spec.test.ts`.
//!
//! Allowlist (`tests/spec-passing.txt`, one `<file-stem>::<name>` per line):
//! while the port is incomplete it names the cases that must pass. A listed
//! case that fails, an unlisted case that passes, or a listed id that no
//! longer exists all fail the build. If the file is absent, every case must
//! pass. Promote cases by rewriting the list to the currently passing set:
//!
//! ```text
//! OQX_SPEC_UPDATE=1 cargo test -p oqx --test spec
//! ```
//!
//! The runner does its own JSON <-> `Value` conversion so it compiles with and
//! without the `json` feature; with the feature on, a test checks the two
//! conversions agree on every fixture.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use oqx::walk::Node;
use oqx::{
    DefaultContext, Engine, InMemoryEngine, Object, OqxError, Query, Value, parse_string,
    parse_template, print_query, print_template, resolve_aliases, run_query, strip_spans,
    transform,
};
use serde_json::Value as Json;

const CASES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/oqx/cases");
const PASSING_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/spec-passing.txt");
/// A wrong `CASES_DIR` must not pass by finding some other, smaller directory.
const MIN_CASE_FILES: usize = 20;
/// Cap on detail lines per report section.
const MAX_REPORT_LINES: usize = 400;

const PASSING_HEADER: &str = "\
# OQX spec cases (spec/oqx/cases) that the Rust port must pass, one
# `<file-stem>::<name>` id per line, sorted. Maintained by tests/spec.rs:
# a listed case failing fails the build; an unlisted case passing also fails
# the build (add it here). Regenerate from the currently passing set with
#
#     OQX_SPEC_UPDATE=1 cargo test -p oqx --test spec
#
# When every case passes, delete this file (the runner then requires all).
";

// ---- fixture shape -----------------------------------------------------------

struct SpecError {
    stage: String,
    includes: Vec<String>,
}

enum Expect {
    Result(Json),
    Error(SpecError),
    /// The JSON tree of `parse(query)`; compared with spans stripped unless the
    /// case sets `spans: true`.
    Ast(Json),
}

struct Template {
    strings: Vec<String>,
    values: Vec<Json>,
}

struct SpecCase {
    id: String,
    roots: Json,
    query: Option<String>,
    template: Option<Template>,
    spans: bool,
    expect: Expect,
}

struct SpecFile {
    stem: String,
    cases: Vec<SpecCase>,
}

/// Validate one fixture document exactly as the reference runner does,
/// returning the problems found (empty = valid) and, if valid, the cases.
fn validate(file: &str, doc: &Json) -> Result<Vec<SpecCase>, Vec<String>> {
    let stem = file.trim_end_matches(".json");
    let mut problems = Vec::new();
    let Some(doc) = doc.as_object() else {
        return Err(vec![format!("{file}: not an object")]);
    };
    if !matches!(doc.get("suite"), Some(Json::String(s)) if !s.is_empty()) {
        problems.push(format!("{file}: missing `suite`"));
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
        let query = c.get("query").and_then(Json::as_str).map(str::to_owned);
        let template_obj = c.get("template").and_then(Json::as_object);
        if query.is_some() == template_obj.is_some() {
            problems.push(format!(
                "{at}: exactly one of `query` / `template` is required"
            ));
        }
        let mut template = None;
        if let Some(t) = template_obj {
            match (
                t.get("strings").and_then(Json::as_array),
                t.get("values").and_then(Json::as_array),
            ) {
                (Some(strings), Some(values)) if strings.len() == values.len() + 1 => {
                    let strings: Option<Vec<String>> = strings
                        .iter()
                        .map(|s| s.as_str().map(str::to_owned))
                        .collect();
                    match strings {
                        Some(strings) => {
                            template = Some(Template {
                                strings,
                                values: values.clone(),
                            })
                        }
                        None => problems.push(format!("{at}: `template.strings` must be strings")),
                    }
                }
                _ => problems.push(format!(
                    "{at}: `template.strings` must have one more element than `template.values`"
                )),
            }
        }
        let roots = match c.get("roots") {
            None => Json::Object(serde_json::Map::new()),
            Some(r @ Json::Object(_)) => r.clone(),
            Some(_) => {
                problems.push(format!("{at}: `roots` must be an object"));
                Json::Object(serde_json::Map::new())
            }
        };
        let Some(expect) = c.get("expect").and_then(Json::as_object) else {
            problems.push(format!("{at}: missing `expect`"));
            continue;
        };
        let result = expect.get("result");
        let error = expect.get("error");
        let ast = expect.get("ast");
        if [result.is_some(), error.is_some(), ast.is_some()]
            .iter()
            .filter(|b| **b)
            .count()
            != 1
        {
            problems.push(format!(
                "{at}: `expect` needs exactly one of `result` / `error` / `ast`"
            ));
        }
        let spans = match c.get("spans") {
            None => false,
            Some(Json::Bool(b)) => {
                if ast.is_none() {
                    problems.push(format!("{at}: `spans` needs `expect.ast`"));
                }
                *b
            }
            Some(_) => {
                problems.push(format!("{at}: `spans` is a boolean"));
                false
            }
        };
        let expect = if let Some(a) = ast {
            Expect::Ast(a.clone())
        } else if let Some(e) = error {
            let stage = e.get("stage").and_then(Json::as_str);
            let Some(stage) = stage.filter(|s| ["lex", "parse", "eval"].contains(s)) else {
                problems.push(format!(
                    "{at}: `expect.error.stage` must be lex | parse | eval"
                ));
                continue;
            };
            let includes = match e.get("includes") {
                None => Vec::new(),
                Some(Json::Array(a)) if a.iter().all(Json::is_string) => a
                    .iter()
                    .filter_map(Json::as_str)
                    .map(str::to_owned)
                    .collect(),
                Some(_) => {
                    problems.push(format!(
                        "{at}: `expect.error.includes` must be an array of strings"
                    ));
                    continue;
                }
            };
            Expect::Error(SpecError {
                stage: stage.to_owned(),
                includes,
            })
        } else {
            Expect::Result(result.cloned().unwrap_or(Json::Null))
        };
        out.push(SpecCase {
            id: format!("{stem}::{name}"),
            roots,
            query,
            template,
            spans,
            expect,
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

// ---- JSON <-> Value ------------------------------------------------------------

/// Plain JSON into a `Value`: `null` → `Null` (never `Undefined`), numbers as
/// doubles, object key order preserved (serde_json has `preserve_order` on).
fn from_json(j: &Json) -> Value {
    match j {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => Value::Number(n.as_f64().unwrap_or(f64::NAN)),
        Json::String(s) => Value::Str(s.clone()),
        Json::Array(a) => Value::Array(a.iter().map(from_json).collect()),
        Json::Object(o) => {
            Value::Object(o.iter().map(|(k, v)| (k.clone(), from_json(v))).collect())
        }
    }
}

/// The spec's canonicalization (`JSON.stringify` behavior): an `Undefined`
/// object property is dropped; an `Undefined` array element or top-level
/// value becomes `null`. Callers check finiteness first (`assert_finite`).
fn canonicalize(v: &Value) -> Json {
    match v {
        Value::Undefined | Value::Null => Json::Null,
        Value::Bool(b) => Json::Bool(*b),
        Value::Number(n) => serde_json::Number::from_f64(*n).map_or(Json::Null, Json::Number),
        Value::Str(s) => Json::String(s.clone()),
        Value::Array(a) => Json::Array(a.iter().map(canonicalize).collect()),
        Value::Object(o) => Json::Object(
            o.iter()
                .filter(|(_, v)| !matches!(v, Value::Undefined))
                .map(|(k, v)| (k.to_owned(), canonicalize(v)))
                .collect(),
        ),
        Value::Range(_) => Json::Null,
    }
}

/// Fail loudly on a value the spec forbids in a result (NaN / ±Infinity would
/// canonicalize to `null` and a fixture could pass by accident); a `Range`
/// likewise never belongs in a result.
fn assert_finite(v: &Value, path: &str) -> Result<(), String> {
    match v {
        Value::Number(n) if !n.is_finite() => Err(format!(
            "non-finite number {n} at {path} — a spec bug (see README: result canonicalization)"
        )),
        Value::Range(_) => Err(format!(
            "range value at {path} — ranges never appear in results"
        )),
        Value::Array(a) => a
            .iter()
            .enumerate()
            .try_for_each(|(i, x)| assert_finite(x, &format!("{path}[{i}]"))),
        Value::Object(o) => o
            .iter()
            .try_for_each(|(k, x)| assert_finite(x, &format!("{path}.{k}"))),
        _ => Ok(()),
    }
}

/// JSON equality with object key order ignored, array order significant, and
/// numbers compared as IEEE doubles (so `2` == `2.0` and `-0` == `0`).
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

// ---- execution ---------------------------------------------------------------

/// The case's query and bindings, parsed by the entry point its form names.
fn parse_case(c: &SpecCase) -> Result<(Query, Vec<Value>), OqxError> {
    match (&c.template, &c.query) {
        (Some(t), _) => {
            let bindings: Vec<Value> = t.values.iter().map(from_json).collect();
            Ok((parse_template(&t.strings, bindings.len())?, bindings))
        }
        (None, Some(q)) => Ok((parse_string(q)?, Vec::new())),
        (None, None) => unreachable!("validated: one of query / template"),
    }
}

fn execute(c: &SpecCase) -> Result<Value, OqxError> {
    let Some(roots) = from_json(&c.roots).as_object().cloned() else {
        unreachable!("roots validated as an object")
    };
    let roots: Object = roots;
    let (query, bindings) = parse_case(c)?;
    Ok(run_query(&query, &bindings, roots)?.into_value())
}

/// `execute` on the naive engine (no optimizer rules), for the optimized ≡
/// naive pass.
fn execute_naive(c: &SpecCase) -> Result<Value, OqxError> {
    let Some(roots) = from_json(&c.roots).as_object().cloned() else {
        unreachable!("roots validated as an object")
    };
    let (query, bindings) = parse_case(c)?;
    // An engine evaluates the query as given: resolve the aliases first, as the
    // entry points do.
    let query = resolve_aliases(&query)?;
    Ok(InMemoryEngine::new(DefaultContext::new(roots))
        .with_rules(&[])
        .run(&query, &bindings)?
        .into_value())
}

/// The optimizer invariant: the default engine and the naive engine agree on
/// every fixture — same canonical result, or the same error stage and message.
fn check_optimized_equals_naive(c: &SpecCase) -> Result<(), String> {
    match (execute(c), execute_naive(c)) {
        (Ok(a), Ok(b)) => {
            let (a, b) = (canonicalize(&a), canonicalize(&b));
            if json_eq(&a, &b) {
                Ok(())
            } else {
                Err(clip(format!("optimized {a} ≠ naive {b}")))
            }
        }
        (Err(a), Err(b)) => {
            if a.stage == b.stage && a.message == b.message {
                Ok(())
            } else {
                Err(clip(format!("optimized error {a} ≠ naive error {b}")))
            }
        }
        (Ok(a), Err(b)) => Err(clip(format!(
            "optimized succeeded with {} but naive raised {b}",
            canonicalize(&a)
        ))),
        (Err(a), Ok(b)) => Err(clip(format!(
            "optimized raised {a} but naive succeeded with {}",
            canonicalize(&b)
        ))),
    }
}

/// Clip a one-line diagnostic so a big result cannot flood the report.
fn clip(s: impl Into<String>) -> String {
    const MAX: usize = 240;
    let s: String = s.into();
    let s = s.replace('\n', " ");
    if s.chars().count() <= MAX {
        return s;
    }
    let cut: String = s.chars().take(MAX).collect();
    format!("{cut}…")
}

/// `expect.ast`: the serde form of the parsed tree equals the fixture's JSON
/// (spans dropped unless the case compares them) — what proves the two
/// implementations produce one shape.
fn check_ast(c: &SpecCase, expected: &Json) -> Result<(), String> {
    let (query, _) = parse_case(c).map_err(|e| clip(format!("unexpected {e}")))?;
    let mut actual = serde_json::to_value(&query).map_err(|e| clip(format!("serialize: {e}")))?;
    if !c.spans {
        drop_spans(&mut actual);
    }
    if json_eq(&actual, expected) {
        Ok(())
    } else {
        Err(clip(format!("expected {expected} got {actual}")))
    }
}

fn drop_spans(j: &mut Json) {
    match j {
        Json::Object(o) => {
            o.remove("span");
            o.values_mut().for_each(drop_spans);
        }
        Json::Array(a) => a.iter_mut().for_each(drop_spans),
        _ => {}
    }
}

/// The round-trip law of the canonical printer (`spec/oqx/AST.md` §6), checked
/// on every fixture query that parses:
/// `strip(parse(print(parse(q)))) ≡ strip(parse(q))`. A template prints to
/// fragments whose gaps may reorder the bindings; the original is renumbered
/// by the printed order before comparing.
fn check_round_trip(c: &SpecCase) -> Result<(), String> {
    let (query, _) = match parse_case(c) {
        Ok(p) => p,
        Err(e) if matches!(e.stage, oqx::Stage::Lex | oqx::Stage::Parse) => return Ok(()),
        Err(e) => return Err(clip(format!("unexpected {e}"))),
    };
    if c.template.is_some() {
        let t = print_template(Node::Query(&query));
        if t.strings.len() != t.count + 1 {
            return Err(clip(format!("template fragments {:?}", t.strings)));
        }
        let position = |idx: usize| t.indices.iter().position(|i| *i == idx).expect("printed");
        let renumbered = transform(&query, &mut |e, _| match e {
            oqx::Expr::Binding { index, span } => oqx::Expr::Binding {
                index: position(index),
                span,
            },
            other => other,
        });
        let again = parse_template(&t.strings, t.count)
            .map_err(|e| clip(format!("reparse of {:?}: {e}", t.strings)))?;
        return if strip_spans(&again) == strip_spans(&renumbered) {
            Ok(())
        } else {
            Err(clip(format!(
                "template round trip of {:?} differs",
                t.strings
            )))
        };
    }
    let printed = print_query(&query).map_err(|e| clip(format!("print: {e}")))?;
    let again = parse_string(&printed).map_err(|e| {
        clip(format!(
            "print produced an unparseable query {printed:?}: {e}"
        ))
    })?;
    if strip_spans(&again) == strip_spans(&query) {
        Ok(())
    } else {
        Err(clip(format!("round trip of {printed:?} differs")))
    }
}

fn check(c: &SpecCase) -> Result<(), String> {
    match &c.expect {
        Expect::Ast(expected) => check_ast(c, expected),
        Expect::Error(want) => match execute(c) {
            Ok(v) => Err(clip(format!(
                "expected an OqxError at stage {}, but the query succeeded with {}",
                want.stage,
                canonicalize(&v)
            ))),
            Err(e) => {
                if e.stage.as_str() != want.stage {
                    return Err(clip(format!(
                        "stage: expected {}, got {}: {}",
                        want.stage,
                        e.stage.as_str(),
                        e.message
                    )));
                }
                for frag in &want.includes {
                    if !e.message.contains(frag) {
                        return Err(clip(format!(
                            "message should include {frag:?}: {}",
                            e.message
                        )));
                    }
                }
                Ok(())
            }
        },
        Expect::Result(expected) => {
            let actual = execute(c).map_err(|e| clip(format!("unexpected {e}")))?;
            assert_finite(&actual, "$")?;
            let actual = canonicalize(&actual);
            if json_eq(&actual, expected) {
                Ok(())
            } else {
                Err(clip(format!("expected {expected} got {actual}")))
            }
        }
    }
}

thread_local! {
    /// Set while a case runs so the panic hook stays quiet: an engine `todo!()`
    /// or a bug is reported once as a case failure, not as 592 stack notes.
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
    std::env::var("OQX_SPEC_UPDATE").is_ok_and(|v| !v.is_empty() && v != "0")
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
        "cases that pass but are not listed in spec-passing.txt — add them (or run OQX_SPEC_UPDATE=1 cargo test -p oqx --test spec)",
        &unlisted_passing,
    );
    report("stale allowlist entries", &stale);
    if passing == all_ids {
        eprintln!(
            "spec: every case passes — delete tests/spec-passing.txt (or run with OQX_SPEC_UPDATE=1)"
        );
    }
    assert!(
        regressions.is_empty() && unlisted_passing.is_empty() && stale.is_empty(),
        "spec allowlist out of date: {} regression(s), {} unlisted passing, {} stale — see the report above (stderr); \
         promote with `OQX_SPEC_UPDATE=1 cargo test -p oqx --test spec`",
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

/// The canonical printer's round-trip law over every fixture query that parses
/// (`spec/oqx/AST.md` §6). Mirrors the reference's `[print round trip]` tests.
#[test]
fn print_round_trips_every_case() {
    if !spec_available() {
        return;
    }
    let loaded = load();
    let mut checked = 0usize;
    let mut failing: Vec<(String, Option<String>)> = Vec::new();
    for f in &loaded.files {
        for c in &f.cases {
            checked += 1;
            if let Err(reason) = check_round_trip(c) {
                failing.push((c.id.clone(), Some(reason)));
            }
        }
    }
    eprintln!(
        "spec: print round-trips {} of {checked} cases",
        checked - failing.len()
    );
    report("print round trip failed", &failing);
    assert!(
        failing.is_empty(),
        "{} cases failed the round-trip law",
        failing.len()
    );
    assert!(checked > 800, "checked only {checked} cases");
}

/// The runner's private conversions must agree with the crate's `json`
/// feature on every fixture value, so the two cannot drift.
#[cfg(feature = "json")]
#[test]
fn runner_conversions_agree_with_oqx_json() {
    if !spec_available() {
        return;
    }

    let loaded = load();
    let mut checked = 0usize;
    for f in &loaded.files {
        for c in &f.cases {
            let mut values: Vec<&Json> = vec![&c.roots];
            if let Some(t) = &c.template {
                values.extend(t.values.iter());
            }
            if let Expect::Result(r) = &c.expect {
                values.push(r);
            }
            for j in values {
                let ours = from_json(j);
                assert_eq!(ours, Value::from(j), "{}: JSON → Value", c.id);
                assert_eq!(
                    ours,
                    Value::from(j.clone()),
                    "{}: JSON → Value (owned)",
                    c.id
                );
                let back = ours.to_canonical_json();
                assert!(json_eq(&back, j), "{}: round trip {j} → {back}", c.id);
                assert!(
                    json_eq(&canonicalize(&ours), &back),
                    "{}: canonicalize",
                    c.id
                );
                checked += 1;
            }
        }
    }
    assert!(checked > 100, "checked only {checked} values");
}

/// The optimizer invariant over the whole spec: for every fixture, the default
/// engine (the optimizer's rules) and the naive engine (`with_rules(&[])`)
/// produce the same canonical result or the same error (stage and message).
/// Planner behavior is implementation conformance, never a spec fixture
/// (spec/oqx/README.md, "What does not belong in cases/"), so this is where the
/// optimizer is proven against the language. Mirrors the reference's
/// `test/conformance.test.ts`.
#[test]
fn optimized_equals_naive_on_every_case() {
    if !spec_available() {
        return;
    }
    let loaded = load();
    let mut checked = 0usize;
    let mut failing: Vec<(String, Option<String>)> = Vec::new();
    for f in &loaded.files {
        for c in &f.cases {
            checked += 1;
            let outcome = panic::catch_unwind(AssertUnwindSafe(|| check_optimized_equals_naive(c)));
            match outcome {
                Ok(Ok(())) => {}
                Ok(Err(reason)) => failing.push((c.id.clone(), Some(reason))),
                Err(payload) => failing.push((
                    c.id.clone(),
                    Some(clip(format!("panicked: {}", panic_message(payload)))),
                )),
            }
        }
    }
    eprintln!(
        "spec: optimized ≡ naive on {} of {checked} cases",
        checked - failing.len()
    );
    report("optimized ≠ naive", &failing);
    assert!(
        failing.is_empty(),
        "{} cases differ between the optimized and the naive engine",
        failing.len()
    );
    assert!(checked > 800, "checked only {checked} cases");
}
