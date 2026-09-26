//! The surface spec conformance runner: executes every fixture under
//! `spec/surface/cases` against this crate — the corpus-backed query suites
//! through [`omgbase_surface::query`] over one store per suite (the corpus
//! observed with the fixture minter, `spec/store` §9.4), `reads.json` as
//! observation scripts whose `read` steps call the catalog in-process
//! ([`Surface::call`]), and `cursor.json` through the cursor codec — and
//! compares each outcome to the case's `expect`. The fixture contract is
//! `spec/surface/README.md` §6; the reference runner this mirrors is
//! `packages/core/corpus/surface/spec.test.ts`.
//!
//! Allowlist (`tests/spec-passing.txt`, one `<file-stem>::<name>` per line):
//! while the port is incomplete it names the cases that must pass. A listed
//! case that fails, an unlisted case that passes, or a listed id that no
//! longer exists all fail the build. If the file is absent, every case must
//! pass. Promote cases by rewriting the list to the currently passing set:
//!
//! ```text
//! SURFACE_SPEC_UPDATE=1 cargo test -p omgbase-surface --test spec
//! ```

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use omgbase_reconcile::Config;
use omgbase_store::{BatchItem, BatchOutcome, SequentialMinter, Store};
use omgbase_surface::{QueryOptions, Surface, decode_cursor, encode_cursor, query};
use serde_json::{Map as JsonMap, Value as Json, json};

const SPEC_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/surface");
const CASES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/surface/cases");
const PASSING_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/spec-passing.txt");
/// A wrong `CASES_DIR` must not pass by finding some other, smaller directory.
const MIN_CASE_FILES: usize = 3;
const MAX_REPORT_LINES: usize = 400;
const EPS: f64 = 1e-9;
/// The repo every case runs in (`spec/store` §9.4 "Inputs").
const FIXTURE_REPO_SLUG: &str = "fixture";
/// When the corpus of a query suite is observed (§6).
const CORPUS_TS: &str = "2026-09-27T00:00:00.000Z";

const PASSING_HEADER: &str = "\
# Surface spec cases (spec/surface/cases) that the Rust port must pass, one
# `<file-stem>::<name>` id per line, sorted. Maintained by tests/spec.rs:
# a listed case failing fails the build; an unlisted case passing also fails
# the build (add it here). Regenerate from the currently passing set with
#
#     SURFACE_SPEC_UPDATE=1 cargo test -p omgbase-surface --test spec
#
# When every case passes, delete this file (the runner then requires all).
";

// ---- fixture shape -----------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Query,
    Reads,
    Cursor,
}

struct SpecCase {
    id: String,
    kind: Kind,
    case: Json,
}

struct SpecFile {
    stem: String,
    kind: Kind,
    /// The suite's corpus (query suites only): `path → source`, bytewise by path.
    corpus: Vec<(String, String)>,
    cases: Vec<SpecCase>,
}

struct Loaded {
    file_names: Vec<String>,
    files: Vec<SpecFile>,
    problems: Vec<String>,
}

fn validate(file: &str, doc: &Json) -> Result<SpecFile, Vec<String>> {
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
    let kind = match stem {
        "cursor" => Kind::Cursor,
        "reads" => Kind::Reads,
        s if s.starts_with("query-") => Kind::Query,
        _ => {
            problems.push(format!("{file}: unknown suite"));
            return Err(problems);
        }
    };
    let mut corpus = Vec::new();
    if kind == Kind::Query {
        match obj.get("corpus").and_then(Json::as_object) {
            Some(c) if !c.is_empty() => {
                for (path, source) in c {
                    match source.as_str() {
                        Some(s) => corpus.push((path.clone(), s.to_owned())),
                        None => problems.push(format!("{file}: corpus[{path}] must be a string")),
                    }
                }
                corpus.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            }
            _ => problems.push(format!(
                "{file}: a query suite carries a non-empty `corpus`"
            )),
        }
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
        match kind {
            Kind::Query => {
                if !cobj.get("query").is_some_and(Json::is_string) {
                    problems.push(format!("{at}: `query` must be a string"));
                }
            }
            Kind::Reads => {
                if !cobj
                    .get("steps")
                    .and_then(Json::as_array)
                    .is_some_and(|s| !s.is_empty())
                {
                    problems.push(format!("{at}: `steps` must be a non-empty array"));
                }
            }
            Kind::Cursor => {
                if !(cobj.contains_key("parts") || cobj.contains_key("cursor")) {
                    problems.push(format!("{at}: a cursor case has `parts` or `cursor`"));
                }
            }
        }
        if !cobj.contains_key("expect") {
            problems.push(format!(
                "{at}: missing `expect` (run SURFACE_SPEC_UPDATE=1)"
            ));
        }
        out.push(SpecCase {
            id: format!("{stem}::{name}"),
            kind,
            case: c.clone(),
        });
    }
    if problems.is_empty() {
        Ok(SpecFile {
            stem: stem.to_owned(),
            kind,
            corpus,
            cases: out,
        })
    } else {
        Err(problems)
    }
}

/// The fixtures live in the monorepo, outside this crate, and are not shipped
/// in the published package: built on its own (or before the fixtures land),
/// every conformance test skips.
fn spec_available() -> bool {
    if Path::new(CASES_DIR).is_dir() {
        return true;
    }
    eprintln!("spec: fixtures not present at {CASES_DIR}; skipping");
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
            Ok(f) => files.push(f),
            Err(found) => problems.extend(found),
        }
    }
    Loaded {
        file_names,
        files,
        problems,
    }
}

// ---- helpers ----------------------------------------------------------------------

fn fresh_store() -> Store {
    Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).expect("in-memory store")
}

/// `spec/store` §9.4's outcome shape for an observe step.
fn outcome_json(o: &BatchOutcome) -> Json {
    match o {
        BatchOutcome::Deleted(d) => {
            json!({ "path": d.path, "deleted": d.doc_id.is_some(), "doc": d.doc_id })
        }
        BatchOutcome::Observed(o) => json!({
            "path": o.path, "echo": o.echo, "doc": o.doc_id, "commit": o.commit_id, "rev": o.rev,
            "converged": o.converged, "conflicted": o.conflicted,
            "dispositions": o.dispositions.iter().map(|(k, n)| (k.clone(), json!(n))).collect::<JsonMap<_, _>>(),
        }),
    }
}

fn config_from(overrides: Option<&Json>) -> Result<Config, String> {
    let mut c = Config::default();
    let Some(obj) = overrides.and_then(Json::as_object) else {
        return Ok(c);
    };
    for (k, v) in obj {
        let num = || {
            v.as_f64()
                .ok_or_else(|| format!("config.{k} must be a number"))
        };
        let count = || {
            v.as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| format!("config.{k} must be a non-negative integer"))
        };
        match k.as_str() {
            "matcher_v" => {
                c.matcher_v = v
                    .as_str()
                    .ok_or("config.matcher_v must be a string")?
                    .to_owned()
            }
            "theta_accept" => c.theta_accept = num()?,
            "theta_small" => c.theta_small = num()?,
            "small_block_tokens" => c.small_block_tokens = count()?,
            "context_sim_floor" => c.context_sim_floor = num()?,
            "children_vouch_frac" => c.children_vouch_frac = num()?,
            "split_coverage" => c.split_coverage = num()?,
            "split_dominant_share" => c.split_dominant_share = num()?,
            "copy_sim" => c.copy_sim = num()?,
            "bulk_unmatched_frac" => c.bulk_unmatched_frac = num()?,
            "bulk_min_blocks" => c.bulk_min_blocks = count()?,
            "max_scored_blocks" => c.max_scored_blocks = count()?,
            "theta_xdoc" => c.theta_xdoc = num()?,
            other => return Err(format!("unknown config key {other}")),
        }
    }
    Ok(c)
}

// ---- query suites -------------------------------------------------------------------

/// One store per suite: the corpus observed once (`spec/store` §9.4 minter,
/// one batch in path order at [`CORPUS_TS`]); queries are read-only.
fn corpus_store(corpus: &[(String, String)]) -> Result<(Store, String), String> {
    let mut store = fresh_store();
    let repo = store
        .create_repo(FIXTURE_REPO_SLUG)
        .map_err(|e| e.to_string())?;
    let items: Vec<BatchItem> = corpus
        .iter()
        .map(|(p, s)| BatchItem::observed(p, s))
        .collect();
    store
        .observe_batch(&repo, &items, CORPUS_TS, &Config::default())
        .map_err(|e| e.to_string())?;
    Ok((store, repo))
}

fn run_query_case(store: &Store, repo: &str, c: &Json) -> Result<(), String> {
    let source = c["query"].as_str().ok_or("query")?;
    let opts = QueryOptions {
        limit: c.get("limit").and_then(Json::as_u64).map(|n| n as usize),
        cursor: c.get("cursor").and_then(Json::as_str),
        provider: None,
    };
    let expect = &c["expect"];
    match query(store, repo, source, opts) {
        Ok(res) => {
            if let Some(code) = expect.get("error") {
                return Err(clip(format!(
                    "expected error {code}, got a result {}",
                    res.to_json()
                )));
            }
            match deep_eq_tol(&res.to_json(), expect, "expect", EPS) {
                None => Ok(()),
                Some(diff) => Err(clip(diff)),
            }
        }
        Err(e) => {
            let Some(code) = expect.get("error").and_then(Json::as_str) else {
                return Err(clip(format!("unexpected error {}: {}", e.code, e.message)));
            };
            if e.code != code {
                return Err(clip(format!(
                    "error code {} (expected {code}): {}",
                    e.code, e.message
                )));
            }
            if let Some(needle) = expect.get("message_includes").and_then(Json::as_str) {
                if !e.message.contains(needle) {
                    return Err(clip(format!(
                        "message {:?} does not include {needle:?}",
                        e.message
                    )));
                }
            }
            Ok(())
        }
    }
}

// ---- cursor.json ------------------------------------------------------------------

fn run_cursor_case(c: &Json) -> Result<Json, String> {
    if let Some(parts) = c.get("parts").and_then(Json::as_array) {
        let parts: Vec<&str> = parts.iter().filter_map(Json::as_str).collect();
        return Ok(json!({ "cursor": encode_cursor(&parts) }));
    }
    let cursor = c["cursor"].as_str().ok_or("cursor")?;
    let arity = c
        .get("arity")
        .and_then(Json::as_u64)
        .map_or(2, |n| n as usize);
    Ok(match decode_cursor(cursor, "spec", arity) {
        Ok(parts) => json!({ "parts": parts }),
        Err(e) => json!({ "error": e.code }),
    })
}

// ---- reads.json -------------------------------------------------------------------

/// A scratch directory that is removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let unique = format!(
            "omgbase-surface-spec-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        );
        let dir = std::env::temp_dir().join(unique);
        fs::create_dir_all(&dir).expect("temp dir");
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The fixture's view of an outcome: an error envelope without its
/// `message` (and without `data` for `filter_invalid`); `changes_since`
/// digests without `summary`.
fn normalize_outcome(tool: &str, out: &omgbase_surface::ToolOutcome) -> Json {
    let mut body = out.body.clone();
    if out.is_error {
        if let Some(o) = body.as_object_mut() {
            o.remove("message");
            if o.get("error").and_then(Json::as_str) == Some("filter_invalid") {
                o.remove("data");
            }
        }
    } else if tool == "changes_since" {
        if let Some(digests) = body.get_mut("digests").and_then(Json::as_array_mut) {
            for d in digests {
                if let Some(o) = d.as_object_mut() {
                    o.remove("summary");
                }
            }
        }
    }
    body
}

fn run_reads_case(c: &Json) -> Result<Json, String> {
    let config = config_from(c.get("config"))?;
    let workspace = c.get("workspace").and_then(Json::as_bool).unwrap_or(false);
    let mut store = fresh_store();
    let repo_id = store
        .create_repo(FIXTURE_REPO_SLUG)
        .map_err(|e| e.to_string())?;
    let name = c["name"].as_str().unwrap_or("case");
    let temp = workspace.then(|| TempDir::new(name));
    if let Some(dir) = &temp {
        omgbase_sync::registry::register_fs_source(
            &mut store,
            &repo_id,
            FIXTURE_REPO_SLUG,
            &dir.0.to_string_lossy(),
        )
        .map_err(|e| e.to_string())?;
    }
    let clock: Rc<RefCell<String>> = Rc::new(RefCell::new(CORPUS_TS.to_owned()));
    let tick = Rc::clone(&clock);
    let mut surface = Surface::new(store, &repo_id, None)
        .with_config(config.clone())
        .with_clock(move || tick.borrow().clone());

    let mut steps = Vec::new();
    for (i, step) in c["steps"].as_array().ok_or("steps")?.iter().enumerate() {
        if let Some(observe) = step.get("observe") {
            let ts = observe["ts"].as_str().ok_or("observe.ts")?;
            *clock.borrow_mut() = ts.to_owned();
            let items: Vec<BatchItem> = observe["items"]
                .as_array()
                .ok_or("observe.items")?
                .iter()
                .map(|it| BatchItem {
                    path: it["path"].as_str().unwrap_or_default().to_owned(),
                    source: it["source"].as_str().map(str::to_owned),
                })
                .collect();
            if let Some(dir) = &temp {
                for it in &items {
                    let file = dir.0.join(&it.path);
                    match &it.source {
                        Some(s) => {
                            if let Some(parent) = file.parent() {
                                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                            }
                            fs::write(&file, s).map_err(|e| e.to_string())?;
                        }
                        None => {
                            let _ = fs::remove_file(&file);
                        }
                    }
                }
            }
            let outcomes = surface
                .store_mut()
                .observe_batch(&repo_id, &items, ts, &config)
                .map_err(|e| format!("step {i}: {e}"))?;
            steps.push(Json::Array(outcomes.iter().map(outcome_json).collect()));
        } else if let Some(sweep) = step.get("sweep") {
            let ts = sweep["ts"].as_str().ok_or("sweep.ts")?;
            let swept = surface
                .store_mut()
                .sweep_pool(ts)
                .map_err(|e| format!("step {i}: {e}"))?;
            steps.push(json!({ "swept": swept }));
        } else if let Some(read) = step.get("read") {
            let tool = read["tool"].as_str().ok_or("read.tool")?;
            let args = read.get("args").cloned().unwrap_or_else(|| json!({}));
            if let Some(ts) = read.get("ts").and_then(Json::as_str) {
                *clock.borrow_mut() = ts.to_owned();
            }
            let out = surface.call(tool, args);
            steps.push(normalize_outcome(tool, &out));
        } else {
            return Err(format!("step {i}: neither observe, sweep nor read"));
        }
    }
    Ok(json!({ "steps": steps }))
}

// ---- driving ------------------------------------------------------------------------

struct SuiteState {
    /// The corpus store of the suite (query suites).
    store: Option<(Store, String)>,
}

fn check(c: &SpecCase, suite: &SuiteState) -> Result<(), String> {
    match c.kind {
        Kind::Query => {
            let (store, repo) = suite.store.as_ref().ok_or("suite store")?;
            run_query_case(store, repo, &c.case)
        }
        Kind::Cursor => {
            let actual = run_cursor_case(&c.case)?;
            deep_eq_tol(&actual, &c.case["expect"], "expect", EPS).map_or(Ok(()), |d| Err(clip(d)))
        }
        Kind::Reads => {
            let actual = run_reads_case(&c.case)?;
            deep_eq_tol(&actual, &c.case["expect"], "expect", EPS).map_or(Ok(()), |d| Err(clip(d)))
        }
    }
}

thread_local! {
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

fn run_case(c: &SpecCase, suite: &SuiteState) -> Result<(), String> {
    IN_CASE.with(|f| f.set(true));
    let outcome = panic::catch_unwind(AssertUnwindSafe(|| check(c, suite)));
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
    std::env::var("SURFACE_SPEC_UPDATE").is_ok_and(|v| !v.is_empty() && v != "0")
}

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
        let suite = SuiteState {
            store: match file.kind {
                Kind::Query => match corpus_store(&file.corpus) {
                    Ok(s) => Some(s),
                    Err(e) => {
                        for c in &file.cases {
                            all_ids.insert(c.id.clone());
                            failing
                                .push((c.id.clone(), Some(format!("corpus did not observe: {e}"))));
                        }
                        continue;
                    }
                },
                _ => None,
            },
        };
        for c in &file.cases {
            all_ids.insert(c.id.clone());
            match run_case(c, &suite) {
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
        "cases that pass but are not listed in spec-passing.txt — add them (or run SURFACE_SPEC_UPDATE=1 cargo test -p omgbase-surface --test spec)",
        &unlisted_passing,
    );
    report("stale allowlist entries", &stale);
    if passing == all_ids {
        eprintln!(
            "spec: every case passes — delete tests/spec-passing.txt (or run with SURFACE_SPEC_UPDATE=1)"
        );
    }
    assert!(
        regressions.is_empty() && unlisted_passing.is_empty() && stale.is_empty(),
        "spec allowlist out of date: {} regression(s), {} unlisted passing, {} stale — see the report above (stderr); \
         promote with `SURFACE_SPEC_UPDATE=1 cargo test -p omgbase-surface --test spec`",
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
}

/// `spec/surface/VERSION` is the version this crate implements.
#[test]
fn version_agrees_with_the_spec() {
    let version_file = Path::new(SPEC_DIR).join("VERSION");
    if !version_file.is_file() {
        eprintln!("spec: {} not present; skipping", version_file.display());
        return;
    }
    let version = fs::read_to_string(version_file).expect("VERSION");
    assert_eq!(omgbase_surface::SPEC_VERSION, version.trim());
}

// ---- comparison ----------------------------------------------------------------------

/// Deep-compare two JSON values, object key order ignored, numbers within
/// `eps`. `None` when equal, else the path and values of the first difference.
fn deep_eq_tol(a: &Json, b: &Json, path: &str, eps: f64) -> Option<String> {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => {
            let (x, y) = (
                x.as_f64().unwrap_or(f64::NAN),
                y.as_f64().unwrap_or(f64::NAN),
            );
            if (x - y).abs() <= eps || (x.is_nan() && y.is_nan()) {
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
                .find_map(|(i, (p, q))| deep_eq_tol(p, q, &format!("{path}[{i}]"), eps))
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
                .find_map(|k| deep_eq_tol(&x[k], &y[k], &format!("{path}.{k}"), eps))
        }
        (Json::Array(_), _) | (_, Json::Array(_)) => Some(format!("{path}: array vs non-array")),
        (Json::Object(_), _) | (_, Json::Object(_)) => {
            Some(format!("{path}: object vs non-object"))
        }
        _ => (a != b).then(|| format!("{path}: {a} vs {b}")),
    }
}

fn clip(s: impl Into<String>) -> String {
    const MAX: usize = 400;
    let s: String = s.into();
    let s = s.replace('\n', " ");
    if s.chars().count() <= MAX {
        return s;
    }
    let cut: String = s.chars().take(MAX).collect();
    format!("{cut}…")
}
