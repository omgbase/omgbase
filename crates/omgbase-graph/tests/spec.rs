//! The graph spec conformance runner: executes every fixture under
//! `spec/graph/cases` — observation scripts exactly as `spec/store` §9.4 —
//! against `omgbase-store` (which calls this crate inside its commit
//! transaction), then projects `nodes`, `external_nodes`, `edges` and
//! `doc_edges` per `spec/graph/README.md` §7 and checks them. The reference
//! runner this mirrors is `packages/core/corpus/graph/spec.test.ts`.
//!
//! Allowlist (`tests/spec-passing.txt`, one `<file-stem>::<name>` per line):
//! while the port is incomplete it names the cases that must pass. A listed
//! case that fails, an unlisted case that passes, or a listed id that no
//! longer exists all fail the build. If the file is absent, every case must
//! pass. Promote cases by rewriting the list to the currently passing set:
//!
//! ```text
//! GRAPH_SPEC_UPDATE=1 cargo test -p omgbase-graph --test spec
//! ```

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use omgbase_graph::node_id;
use omgbase_reconcile::Config;
use omgbase_store::{BatchItem, BatchOutcome, SequentialMinter, Store};
use rusqlite::Connection;
use rusqlite::types::Value as Sql;
use serde_json::{Map as JsonMap, Value as Json, json};

const SPEC_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/graph");
const CASES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/graph/cases");
const PASSING_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/spec-passing.txt");
/// A wrong `CASES_DIR` must not pass by finding some other, smaller directory.
const MIN_CASE_FILES: usize = 1;
const MAX_REPORT_LINES: usize = 400;
/// The repo every observation case runs in (`spec/store` §9.4 "Inputs").
const FIXTURE_REPO_SLUG: &str = "fixture";

const CONFIG_KEYS: [&str; 13] = [
    "matcher_v",
    "theta_accept",
    "theta_small",
    "small_block_tokens",
    "context_sim_floor",
    "children_vouch_frac",
    "split_coverage",
    "split_dominant_share",
    "copy_sim",
    "bulk_unmatched_frac",
    "bulk_min_blocks",
    "max_scored_blocks",
    "theta_xdoc",
];
/// §7: the tables a graph case projects.
const PROJECTED_TABLES: [&str; 4] = ["nodes", "external_nodes", "edges", "doc_edges"];

const PASSING_HEADER: &str = "\
# Graph spec cases (spec/graph/cases) that the Rust port must pass, one
# `<file-stem>::<name>` id per line, sorted. Maintained by tests/spec.rs:
# a listed case failing fails the build; an unlisted case passing also fails
# the build (add it here). Regenerate from the currently passing set with
#
#     GRAPH_SPEC_UPDATE=1 cargo test -p omgbase-graph --test spec
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

/// `spec/store` §2.4: `YYYY-MM-DDTHH:MM:SS.fffZ`.
fn is_spec_ts(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 24
        && b.iter().enumerate().all(|(i, &c)| match i {
            4 | 7 => c == b'-',
            10 => c == b'T',
            13 | 16 => c == b':',
            19 => c == b'.',
            23 => c == b'Z',
            _ => c.is_ascii_digit(),
        })
}

fn validate_config(at: &str, config: &Json, problems: &mut Vec<String>) {
    let Some(obj) = config.as_object() else {
        problems.push(format!("{at}: `config` must be an object"));
        return;
    };
    for (k, v) in obj {
        if !CONFIG_KEYS.contains(&k.as_str()) {
            problems.push(format!("{at}: unknown config key `{k}`"));
        } else if (k == "matcher_v") != v.is_string() || (k != "matcher_v" && !v.is_number()) {
            problems.push(format!("{at}: config.{k} has the wrong type"));
        }
    }
}

/// Returns the step count, or -1 when `steps` is malformed.
fn validate_steps(at: &str, steps: Option<&Json>, problems: &mut Vec<String>) -> i64 {
    let Some(steps) = steps.and_then(Json::as_array).filter(|s| !s.is_empty()) else {
        problems.push(format!("{at}: `steps` must be a non-empty array"));
        return -1;
    };
    for (i, s) in steps.iter().enumerate() {
        let here = format!("{at}.steps[{i}]");
        let Some(obj) = s.as_object() else {
            problems.push(format!("{here}: not an object"));
            continue;
        };
        let keys: Vec<&String> = obj.keys().collect();
        if keys.len() != 1 || (keys[0] != "observe" && keys[0] != "sweep") {
            problems.push(format!(
                "{here}: a step is exactly one of `observe` / `sweep` (got {})",
                keys.iter()
                    .map(|k| k.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            continue;
        }
        let body = &obj[keys[0]];
        let ts_ok = body
            .get("ts")
            .and_then(Json::as_str)
            .is_some_and(is_spec_ts);
        if !body.is_object() || !ts_ok {
            problems.push(format!(
                "{here}: `ts` must be RFC 3339 UTC with three fractional digits and Z"
            ));
        }
        let Some(body) = body.as_object() else {
            continue;
        };
        if keys[0] == "sweep" {
            if body.keys().any(|k| k != "ts") {
                problems.push(format!("{here}: sweep takes only `ts`"));
            }
            continue;
        }
        if body.keys().any(|k| k != "ts" && k != "items") {
            problems.push(format!("{here}: observe takes `ts` and `items`"));
        }
        let Some(items) = body
            .get("items")
            .and_then(Json::as_array)
            .filter(|i| !i.is_empty())
        else {
            problems.push(format!("{here}: `items` must be a non-empty array"));
            continue;
        };
        let mut paths = HashSet::new();
        for (j, it) in items.iter().enumerate() {
            let where_ = format!("{here}.items[{j}]");
            let Some(it) = it.as_object() else {
                problems.push(format!("{where_}: not an object"));
                continue;
            };
            if it.keys().any(|k| k != "path" && k != "source") {
                problems.push(format!("{where_}: an item is {{ path, source }}"));
            }
            match it.get("path").and_then(Json::as_str) {
                Some(p) if !p.is_empty() && !p.starts_with('/') && p.ends_with(".md") => {
                    if !paths.insert(p.to_owned()) {
                        problems.push(format!("{where_}: path {p} appears twice in one batch"));
                    }
                }
                _ => problems.push(format!(
                    "{where_}: `path` must be repo-relative, no leading slash, ending in .md"
                )),
            }
            if !matches!(it.get("source"), Some(Json::Null | Json::String(_))) {
                problems.push(format!("{where_}: `source` must be a string or null"));
            }
        }
    }
    steps.len() as i64
}

/// §7: `expect` carries the four tables (and may carry `steps`, one entry
/// per step, as the store fixtures do).
fn validate_projection(at: &str, e: &Json, step_count: i64, problems: &mut Vec<String>) {
    let Some(obj) = e.as_object() else {
        problems.push(format!("{at}: must be an object"));
        return;
    };
    let mut allowed: Vec<&str> = vec!["steps"];
    allowed.extend(PROJECTED_TABLES);
    let extra = unknown_keys(obj, &allowed);
    if !extra.is_empty() {
        problems.push(format!("{at}: unknown keys {}", extra.join(", ")));
    }
    for t in PROJECTED_TABLES {
        if !obj.get(t).is_some_and(Json::is_array) {
            problems.push(format!("{at}.{t}: must be an array"));
        }
    }
    if let Some(steps) = obj.get("steps") {
        match steps.as_array() {
            Some(steps) if step_count >= 0 && steps.len() as i64 != step_count => {
                problems.push(format!(
                    "{at}.steps: {} outcomes for {step_count} steps",
                    steps.len()
                ));
            }
            Some(_) => {}
            None => problems.push(format!("{at}.steps: must be an array")),
        }
    }
}

/// Validate one fixture file as the reference's validator does.
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
        let unknown = unknown_keys(cobj, &["name", "notes", "config", "steps", "expect"]);
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
        if let Some(config) = cobj.get("config") {
            validate_config(&at, config, &mut problems);
        }
        let step_count = validate_steps(&at, cobj.get("steps"), &mut problems);
        let Some(expect) = cobj.get("expect") else {
            problems.push(format!("{at}: missing `expect` (run GRAPH_SPEC_UPDATE=1)"));
            continue;
        };
        validate_projection(&format!("{at}.expect"), expect, step_count, &mut problems);
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

// ---- SQL helpers -------------------------------------------------------------------

/// A SQLite value as the fixtures carry it: INTEGER/REAL → number, TEXT →
/// string, BLOB → hex, NULL → null.
fn sql_json(v: &Sql) -> Json {
    match v {
        Sql::Null => Json::Null,
        Sql::Integer(i) => json!(i),
        Sql::Real(f) => json!(f),
        Sql::Text(s) => Json::String(s.clone()),
        Sql::Blob(b) => Json::String(b.iter().map(|x| format!("{x:02x}")).collect()),
    }
}

/// `sql` with `params` as a list of JSON row objects (column order kept).
fn query_rows(conn: &Connection, sql: &str, params: &[&dyn rusqlite::ToSql]) -> Vec<Json> {
    let mut stmt = conn.prepare(sql).expect("valid SQL");
    let names: Vec<String> = stmt
        .column_names()
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    let rows = stmt
        .query_map(params, |r| {
            let mut obj = JsonMap::new();
            for (i, n) in names.iter().enumerate() {
                obj.insert(n.clone(), sql_json(&r.get::<_, Sql>(i)?));
            }
            Ok(Json::Object(obj))
        })
        .expect("query runs");
    rows.map(|r| r.expect("row reads")).collect()
}

fn with_json_column(mut row: Json, column: &str) -> Json {
    if let Some(text) = row[column].as_str() {
        let parsed: Json = serde_json::from_str(text)
            .unwrap_or_else(|e| panic!("{column} is not JSON ({e}): {text}"));
        row[column] = parsed;
    }
    row
}

fn str_of<'a>(row: &'a Json, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

fn int_of(row: &Json, key: &str) -> i64 {
    row[key].as_i64().unwrap_or(i64::MAX)
}

fn bytes_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.as_bytes().cmp(b.as_bytes())
}

// ---- observation scripts (spec/store §9.4) ----------------------------------------

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
                    .to_owned();
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

struct Evaluation {
    /// The §7 projection (plus `steps`), keyed like a fixture `expect`.
    actual: JsonMap<String, Json>,
    /// §7 runner-check violations, prefixed with the step they were found after.
    problems: Vec<String>,
}

fn run_case_script(c: &Json) -> Result<Evaluation, String> {
    let config = config_from(c.get("config"))?;
    let mut store = Store::open_in_memory_with_minter(Box::new(SequentialMinter::new()))
        .map_err(|e| e.to_string())?;
    let repo_id = store
        .create_repo(FIXTURE_REPO_SLUG)
        .map_err(|e| e.to_string())?;
    let mut steps = Vec::new();
    let mut problems = Vec::new();
    for (i, step) in c["steps"].as_array().ok_or("steps")?.iter().enumerate() {
        if let Some(observe) = step.get("observe") {
            let ts = observe["ts"].as_str().ok_or("observe.ts")?;
            let items: Vec<BatchItem> = observe["items"]
                .as_array()
                .ok_or("observe.items")?
                .iter()
                .map(|it| BatchItem {
                    path: it["path"].as_str().unwrap_or_default().to_owned(),
                    source: it["source"].as_str().map(str::to_owned),
                })
                .collect();
            let outcomes = store
                .observe_batch(&repo_id, &items, ts, &config)
                .map_err(|e| format!("step {i}: {e}"))?;
            steps.push(Json::Array(outcomes.iter().map(outcome_json).collect()));
            for p in check_graph(store.conn(), &repo_id) {
                problems.push(format!("after step {i}: {p}"));
            }
        } else if let Some(sweep) = step.get("sweep") {
            let ts = sweep["ts"].as_str().ok_or("sweep.ts")?;
            let swept = store.sweep_pool(ts).map_err(|e| format!("step {i}: {e}"))?;
            steps.push(json!({ "swept": swept }));
        } else {
            return Err(format!("step {i}: neither observe nor sweep"));
        }
    }
    for p in check_graph(store.conn(), &repo_id) {
        problems.push(format!("at end: {p}"));
    }
    let mut actual = JsonMap::new();
    actual.insert("steps".to_owned(), Json::Array(steps));
    for (k, v) in project_graph(store.conn(), &repo_id) {
        actual.insert(k, v);
    }
    Ok(Evaluation { actual, problems })
}

// ---- projection (§7) ------------------------------------------------------------------

/// The §7 projection of one repo's graph tables (`repo_id` omitted), in
/// fixture order.
fn project_graph(conn: &Connection, repo_id: &str) -> Vec<(String, Json)> {
    let docs = query_rows(
        conn,
        "SELECT doc_id FROM docs WHERE repo_id = ?1 ORDER BY path",
        &[&repo_id],
    );
    let doc_index: HashMap<String, usize> = docs
        .iter()
        .enumerate()
        .map(|(i, d)| (str_of(d, "doc_id").to_owned(), i))
        .collect();
    let index_of = |id: &str| doc_index.get(id).copied().unwrap_or(usize::MAX);

    let mut nodes: Vec<Json> = query_rows(
        conn,
        "SELECT node_id, doc_id, block_id, kind, name, value, span_start, span_end, attrs FROM nodes WHERE repo_id = ?1",
        &[&repo_id],
    )
    .into_iter()
    .map(|r| with_json_column(r, "attrs"))
    .collect();
    nodes.sort_by(|a, b| {
        index_of(str_of(a, "doc_id"))
            .cmp(&index_of(str_of(b, "doc_id")))
            .then_with(|| bytes_cmp(str_of(a, "node_id"), str_of(b, "node_id")))
    });

    let mut external = query_rows(
        conn,
        "SELECT node_id, uri, title FROM external_nodes WHERE repo_id = ?1",
        &[&repo_id],
    );
    external.sort_by(|a, b| bytes_cmp(str_of(a, "uri"), str_of(b, "uri")));

    let commit_seq: HashMap<String, i64> = query_rows(
        conn,
        "SELECT commit_id, seq FROM commits WHERE repo_id = ?1",
        &[&repo_id],
    )
    .iter()
    .map(|c| (str_of(c, "commit_id").to_owned(), int_of(c, "seq")))
    .collect();
    let seq_of = |id: &str| commit_seq.get(id).copied().unwrap_or(i64::MAX);
    let mut edges = query_rows(
        conn,
        "SELECT edge_id, src_doc, src_block, src_field, predicate, dst_kind, dst_node, anchor, provenance, via_node, from_commit, to_commit
           FROM edges WHERE repo_id = ?1",
        &[&repo_id],
    );
    edges.sort_by(|a, b| {
        seq_of(str_of(a, "from_commit"))
            .cmp(&seq_of(str_of(b, "from_commit")))
            .then_with(|| bytes_cmp(str_of(a, "edge_id"), str_of(b, "edge_id")))
    });

    let mut doc_edges: Vec<Json> = query_rows(
        conn,
        "SELECT de.src_doc, de.predicate, de.dst_node, de.dst_kind, de.count, de.samples
           FROM doc_edges de JOIN docs d ON d.doc_id = de.src_doc WHERE d.repo_id = ?1",
        &[&repo_id],
    )
    .into_iter()
    .map(|r| with_json_column(r, "samples"))
    .collect();
    doc_edges.sort_by(|a, b| {
        bytes_cmp(str_of(a, "src_doc"), str_of(b, "src_doc"))
            .then_with(|| bytes_cmp(str_of(a, "predicate"), str_of(b, "predicate")))
            .then_with(|| bytes_cmp(str_of(a, "dst_node"), str_of(b, "dst_node")))
    });

    vec![
        ("nodes".to_owned(), Json::Array(nodes)),
        ("external_nodes".to_owned(), Json::Array(external)),
        ("edges".to_owned(), Json::Array(edges)),
        ("doc_edges".to_owned(), Json::Array(doc_edges)),
    ]
}

// ---- runner checks (§7) ----------------------------------------------------------------

fn check_graph(conn: &Connection, repo_id: &str) -> Vec<String> {
    let mut problems = Vec::new();

    let docs = query_rows(
        conn,
        "SELECT doc_id, path, deleted_commit FROM docs WHERE repo_id = ?1",
        &[&repo_id],
    );
    let doc_ids: HashSet<&str> = docs.iter().map(|d| str_of(d, "doc_id")).collect();
    let live_paths: HashSet<&str> = docs
        .iter()
        .filter(|d| d["deleted_commit"].is_null())
        .map(|d| str_of(d, "path"))
        .collect();
    let commits: HashSet<String> = query_rows(
        conn,
        "SELECT commit_id FROM commits WHERE repo_id = ?1",
        &[&repo_id],
    )
    .iter()
    .map(|c| str_of(c, "commit_id").to_owned())
    .collect();
    let externals: HashSet<String> = query_rows(
        conn,
        "SELECT node_id FROM external_nodes WHERE repo_id = ?1",
        &[&repo_id],
    )
    .iter()
    .map(|x| str_of(x, "node_id").to_owned())
    .collect();

    // Every node_id equals its §2.3 derivation: per (doc, kind, block), the
    // ids are exactly node_id(doc, block, kind, 0..n).
    let nodes = query_rows(
        conn,
        "SELECT node_id, doc_id, block_id, kind FROM nodes WHERE repo_id = ?1 ORDER BY rowid",
        &[&repo_id],
    );
    let mut groups: BTreeMap<(String, String, String), Vec<String>> = BTreeMap::new();
    for n in &nodes {
        groups
            .entry((
                str_of(n, "doc_id").to_owned(),
                str_of(n, "kind").to_owned(),
                str_of(n, "block_id").to_owned(),
            ))
            .or_default()
            .push(str_of(n, "node_id").to_owned());
    }
    for ((doc, kind, block), mut have) in groups {
        let mut want: Vec<String> = (0..have.len())
            .map(|i| node_id(&doc, &block, &kind, i as u32))
            .collect();
        have.sort();
        want.sort();
        if have != want {
            problems.push(format!(
                "node ids of {doc}/{block}/{kind} are not the §2.3 derivation over ordinals 0..{}",
                have.len()
            ));
        }
    }

    // Edge commits exist; open targets are a doc id (live or tombstoned —
    // §3.6 keeps a tombstoned target's id), an external node, or a phantom
    // for a path with no live doc.
    let edges = query_rows(
        conn,
        "SELECT edge_id, dst_node, dst_kind, from_commit, to_commit FROM edges WHERE repo_id = ?1",
        &[&repo_id],
    );
    for e in &edges {
        let id = str_of(e, "edge_id");
        if !commits.contains(str_of(e, "from_commit")) {
            problems.push(format!("edge {id}: from_commit is not a commit"));
        }
        if let Some(to) = e["to_commit"].as_str() {
            if !commits.contains(to) {
                problems.push(format!("edge {id}: to_commit {to} is not a commit"));
            }
            continue;
        }
        let dst = str_of(e, "dst_node");
        let ok = if let Some(path) = dst.strip_prefix("phantom:") {
            !live_paths.contains(path)
        } else {
            doc_ids.contains(dst) || externals.contains(dst)
        };
        if !ok {
            problems.push(format!(
                "edge {id}: open dst_node {dst} is neither a doc, an external node nor a phantom without a live doc"
            ));
        }
    }

    // doc_edges equals the §3.4 rollup recomputed from the open edges.
    let open = query_rows(
        conn,
        "SELECT src_doc, predicate, dst_node, dst_kind, src_block FROM edges WHERE repo_id = ?1 AND to_commit IS NULL ORDER BY rowid",
        &[&repo_id],
    );
    /// `(src_doc, predicate, dst_node, dst_kind)` → `(count, samples)`.
    type Rollup = BTreeMap<(String, String, String, String), (i64, Vec<String>)>;
    let mut want: Rollup = BTreeMap::new();
    for e in &open {
        let entry = want
            .entry((
                str_of(e, "src_doc").to_owned(),
                str_of(e, "predicate").to_owned(),
                str_of(e, "dst_node").to_owned(),
                str_of(e, "dst_kind").to_owned(),
            ))
            .or_insert((0, Vec::new()));
        entry.0 += 1;
        if let Some(b) = e["src_block"].as_str() {
            if entry.1.len() < 3 {
                entry.1.push(b.to_owned());
            }
        }
    }
    let want: BTreeSet<String> = want
        .into_iter()
        .map(|((s, p, n, k), (c, samples))| {
            format!(
                "{s}|{p}|{n}|{k}|{c}|{}",
                serde_json::to_string(&samples).unwrap()
            )
        })
        .collect();
    let have: BTreeSet<String> = query_rows(
        conn,
        "SELECT de.src_doc, de.predicate, de.dst_node, de.dst_kind, de.count, de.samples
           FROM doc_edges de JOIN docs d ON d.doc_id = de.src_doc WHERE d.repo_id = ?1",
        &[&repo_id],
    )
    .iter()
    .map(|r| {
        let samples: Json = serde_json::from_str(str_of(r, "samples")).unwrap_or(Json::Null);
        format!(
            "{}|{}|{}|{}|{}|{}",
            str_of(r, "src_doc"),
            str_of(r, "predicate"),
            str_of(r, "dst_node"),
            str_of(r, "dst_kind"),
            int_of(r, "count"),
            samples
        )
    })
    .collect();
    if have != want {
        for row in want.difference(&have) {
            problems.push(format!("doc_edges: rollup row missing: {row}"));
        }
        for row in have.difference(&want) {
            problems.push(format!(
                "doc_edges: row not in the recomputed rollup: {row}"
            ));
        }
    }
    problems
}

// ---- comparison ----------------------------------------------------------------------

/// Deep-compare two JSON values, object key order ignored. `None` when
/// equal, else the path and values of the first difference.
fn deep_eq(a: &Json, b: &Json, path: &str) -> Option<String> {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => {
            let (x, y) = (
                x.as_f64().unwrap_or(f64::NAN),
                y.as_f64().unwrap_or(f64::NAN),
            );
            if x == y || (x.is_nan() && y.is_nan()) {
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
                .find_map(|(i, (p, q))| deep_eq(p, q, &format!("{path}[{i}]")))
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
                .find_map(|k| deep_eq(&x[k], &y[k], &format!("{path}.{k}")))
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

fn check(c: &SpecCase) -> Result<(), String> {
    let ev = run_case_script(&c.case)?;
    if !ev.problems.is_empty() {
        return Err(clip(format!("checks: {}", ev.problems.join("; "))));
    }
    // Compare exactly the keys the fixture carries (`steps` is optional).
    let expect = c.case["expect"].as_object().ok_or("expect")?;
    let actual: JsonMap<String, Json> = ev
        .actual
        .into_iter()
        .filter(|(k, _)| expect.contains_key(k))
        .collect();
    match deep_eq(&Json::Object(actual), &c.case["expect"], "expect") {
        None => Ok(()),
        Some(diff) => Err(clip(diff)),
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
    std::env::var("GRAPH_SPEC_UPDATE").is_ok_and(|v| !v.is_empty() && v != "0")
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
        "cases that pass but are not listed in spec-passing.txt — add them (or run GRAPH_SPEC_UPDATE=1 cargo test -p omgbase-graph --test spec)",
        &unlisted_passing,
    );
    report("stale allowlist entries", &stale);
    if passing == all_ids {
        eprintln!(
            "spec: every case passes — delete tests/spec-passing.txt (or run with GRAPH_SPEC_UPDATE=1)"
        );
    }
    assert!(
        regressions.is_empty() && unlisted_passing.is_empty() && stale.is_empty(),
        "spec allowlist out of date: {} regression(s), {} unlisted passing, {} stale — see the report above (stderr); \
         promote with `GRAPH_SPEC_UPDATE=1 cargo test -p omgbase-graph --test spec`",
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
}

/// `spec/graph/VERSION` is the version this crate implements.
#[test]
fn version_agrees_with_the_spec() {
    let version_file = Path::new(SPEC_DIR).join("VERSION");
    if !version_file.is_file() {
        eprintln!("spec: {} not present; skipping", version_file.display());
        return;
    }
    let version = fs::read_to_string(version_file).expect("VERSION");
    assert_eq!(omgbase_graph::SPEC_VERSION, version.trim());
}

/// The §7 checks hold for every case's resulting database, whatever the
/// fixture expects — a failing comparison must never hide a broken table.
#[test]
fn every_case_satisfies_the_runner_checks() {
    if !spec_available() {
        return;
    }
    let loaded = load();
    let mut problems = Vec::new();
    let mut checked = 0usize;
    for f in &loaded.files {
        for c in &f.cases {
            match run_case_script(&c.case) {
                Ok(ev) => {
                    for p in ev.problems {
                        problems.push(format!("{}: {p}", c.id));
                    }
                    checked += 1;
                }
                Err(e) => problems.push(format!("{}: cannot evaluate: {e}", c.id)),
            }
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
    assert!(checked > 0, "no cases evaluated");
}
