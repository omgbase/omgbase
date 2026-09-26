//! The search spec conformance runner: executes every fixture under
//! `spec/search/cases` — `sanitize.json` (string → MATCH expression),
//! `cosine.json` (two vectors → similarity) and observation scripts exactly
//! as `spec/store` §9.4 plus the `drain`, `search` and `resolve` steps of
//! `spec/search` §7 — against `omgbase-store` (which calls this crate for its
//! queries and the drain, with the §6 fixture embedder as the provider), then
//! projects `embed_tasks`, `doc_tasks`, `embeddings` and `doc_embeddings` and
//! checks them. The reference runner this mirrors is
//! `packages/core/corpus/search/spec.test.ts`.
//!
//! Allowlist (`tests/spec-passing.txt`, one `<file-stem>::<name>` per line):
//! while the port is incomplete it names the cases that must pass. A listed
//! case that fails, an unlisted case that passes, or a listed id that no
//! longer exists all fail the build. If the file is absent, every case must
//! pass. Promote cases by rewriting the list to the currently passing set:
//!
//! ```text
//! SEARCH_SPEC_UPDATE=1 cargo test -p omgbase-search --test spec
//! ```

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use omgbase_reconcile::Config;
use omgbase_search::{
    DocEmbedMethod, EmbeddingProvider, FixtureEmbedder, cosine_f32, hex, sanitize_fts_query,
    token_budget,
};
use omgbase_store::{BatchItem, BatchOutcome, HybridQuery, QueryVector, SequentialMinter, Store};
use rusqlite::Connection;
use rusqlite::types::Value as Sql;
use serde_json::{Map as JsonMap, Value as Json, json};

const SPEC_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/search");
const CASES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/search/cases");
const PASSING_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/spec-passing.txt");
/// A wrong `CASES_DIR` must not pass by finding some other, smaller directory.
const MIN_CASE_FILES: usize = 1;
const MAX_REPORT_LINES: usize = 400;
/// The repo every observation case runs in (`spec/store` §9.4 "Inputs").
const FIXTURE_REPO_SLUG: &str = "fixture";
/// §7: `text_search` scores (bm25) compare within this.
const TEXT_SCORE_EPS: f64 = 1e-6;
/// §7: everything else floating point compares within this.
const EPS: f64 = 1e-9;

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
/// §7: the projections an observation case may carry besides `steps`.
const PROJECTED_KEYS: [&str; 4] = ["embed_tasks", "doc_tasks", "embeddings", "doc_embeddings"];
const STEP_KINDS: [&str; 5] = ["observe", "sweep", "drain", "search", "resolve"];

const PASSING_HEADER: &str = "\
# Search spec cases (spec/search/cases) that the Rust port must pass, one
# `<file-stem>::<name>` id per line, sorted. Maintained by tests/spec.rs:
# a listed case failing fails the build; an unlisted case passing also fails
# the build (add it here). Regenerate from the currently passing set with
#
#     SEARCH_SPEC_UPDATE=1 cargo test -p omgbase-search --test spec
#
# When every case passes, delete this file (the runner then requires all).
";

// ---- fixture shape -----------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Sanitize,
    Cosine,
    Observe,
}

/// §7: the case shapes, told apart by the file stem.
fn suite_kind(stem: &str) -> Kind {
    match stem {
        "sanitize" => Kind::Sanitize,
        "cosine" => Kind::Cosine,
        _ => Kind::Observe,
    }
}

struct SpecCase {
    id: String,
    kind: Kind,
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

fn validate_observe_body(here: &str, body: &JsonMap<String, Json>, problems: &mut Vec<String>) {
    if !body
        .get("ts")
        .and_then(Json::as_str)
        .is_some_and(is_spec_ts)
    {
        problems.push(format!(
            "{here}: `ts` must be RFC 3339 UTC with three fractional digits and Z"
        ));
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
        return;
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
        if keys.len() != 1 || !STEP_KINDS.contains(&keys[0].as_str()) {
            problems.push(format!(
                "{here}: a step is exactly one of {} (got {})",
                STEP_KINDS.join(" / "),
                keys.iter()
                    .map(|k| k.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            continue;
        }
        let body = &obj[keys[0]];
        match keys[0].as_str() {
            "observe" => match body.as_object() {
                Some(b) => validate_observe_body(&here, b, problems),
                None => problems.push(format!("{here}: observe must be an object")),
            },
            "sweep" => {
                let ts_ok = body
                    .get("ts")
                    .and_then(Json::as_str)
                    .is_some_and(is_spec_ts);
                if !body.is_object()
                    || !ts_ok
                    || body
                        .as_object()
                        .is_some_and(|b| b.keys().any(|k| k != "ts"))
                {
                    problems.push(format!("{here}: sweep takes only a spec `ts`"));
                }
            }
            "drain" => {
                if body != &Json::Bool(true) {
                    problems.push(format!("{here}: drain is `true`"));
                }
            }
            "search" | "resolve" => {
                let Some(b) = body.as_object() else {
                    problems.push(format!("{here}: {} must be an object", keys[0]));
                    continue;
                };
                let allowed: &[&str] = if keys[0] == "search" {
                    &["text", "semantic", "limit"]
                } else {
                    &["query", "semantic", "limit"]
                };
                let extra = unknown_keys(b, allowed);
                if !extra.is_empty() {
                    problems.push(format!("{here}: unknown keys {}", extra.join(", ")));
                }
                for k in ["text", "semantic", "query"] {
                    if b.get(k).is_some_and(|v| !v.is_string()) {
                        problems.push(format!("{here}.{k}: must be a string"));
                    }
                }
                if b.get("limit").is_some_and(|v| v.as_u64().is_none()) {
                    problems.push(format!("{here}.limit: must be a non-negative integer"));
                }
                if keys[0] == "search" && !b.contains_key("text") && !b.contains_key("semantic") {
                    problems.push(format!("{here}: search needs `text` and/or `semantic`"));
                }
                if keys[0] == "resolve" && !b.get("query").is_some_and(Json::is_string) {
                    problems.push(format!("{here}: resolve needs `query`"));
                }
            }
            _ => unreachable!(),
        }
    }
    steps.len() as i64
}

/// §7: `expect` carries `steps` (one entry per step) and any of the four
/// projections.
fn validate_projection(at: &str, e: &Json, step_count: i64, problems: &mut Vec<String>) {
    let Some(obj) = e.as_object() else {
        problems.push(format!("{at}: must be an object"));
        return;
    };
    let mut allowed: Vec<&str> = vec!["steps"];
    allowed.extend(PROJECTED_KEYS);
    let extra = unknown_keys(obj, &allowed);
    if !extra.is_empty() {
        problems.push(format!("{at}: unknown keys {}", extra.join(", ")));
    }
    for t in PROJECTED_KEYS {
        if obj.get(t).is_some_and(|v| !v.is_array()) {
            problems.push(format!("{at}.{t}: must be an array"));
        }
    }
    match obj.get("steps").map(Json::as_array) {
        Some(Some(steps)) if step_count >= 0 && steps.len() as i64 != step_count => {
            problems.push(format!(
                "{at}.steps: {} outcomes for {step_count} steps",
                steps.len()
            ));
        }
        Some(Some(_)) => {}
        Some(None) => problems.push(format!("{at}.steps: must be an array")),
        None => problems.push(format!("{at}: missing `steps`")),
    }
}

fn validate_vector(at: &str, v: Option<&Json>, problems: &mut Vec<String>) {
    match v.and_then(Json::as_array) {
        Some(items) if items.iter().all(Json::is_number) => {}
        _ => problems.push(format!("{at}: must be an array of numbers")),
    }
}

/// Validate one fixture file as the reference's validator does.
fn validate(file: &str, doc: &Json) -> Result<Vec<SpecCase>, Vec<String>> {
    let stem = file.trim_end_matches(".json");
    let kind = suite_kind(stem);
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
        let allowed: &[&str] = match kind {
            Kind::Sanitize => &["name", "notes", "input", "expect"],
            Kind::Cosine => &["name", "notes", "a", "b", "expect"],
            Kind::Observe => &["name", "notes", "config", "steps", "expect"],
        };
        let unknown = unknown_keys(cobj, allowed);
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
        let Some(expect) = cobj.get("expect") else {
            problems.push(format!("{at}: missing `expect` (run SEARCH_SPEC_UPDATE=1)"));
            continue;
        };
        match kind {
            Kind::Sanitize => {
                if !cobj.get("input").is_some_and(Json::is_string) {
                    problems.push(format!("{at}: `input` must be a string"));
                }
                if !expect.is_string() {
                    problems.push(format!("{at}.expect: must be a string"));
                }
            }
            Kind::Cosine => {
                validate_vector(&format!("{at}.a"), cobj.get("a"), &mut problems);
                validate_vector(&format!("{at}.b"), cobj.get("b"), &mut problems);
                if !expect.is_number() {
                    problems.push(format!("{at}.expect: must be a number"));
                }
            }
            Kind::Observe => {
                if let Some(config) = cobj.get("config") {
                    validate_config(&at, config, &mut problems);
                }
                let step_count = validate_steps(&at, cobj.get("steps"), &mut problems);
                validate_projection(&format!("{at}.expect"), expect, step_count, &mut problems);
            }
        }
        out.push(SpecCase {
            id: format!("{stem}::{name}"),
            kind,
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
        Sql::Blob(b) => Json::String(hex(b)),
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

/// A `vec` blob (hex, as [`sql_json`] renders it) as its float32 values.
fn vec_json(row: &mut Json) {
    let Some(h) = row["vec"].as_str() else {
        return;
    };
    let bytes: Vec<u8> = (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).expect("hex"))
        .collect();
    let floats: Vec<Json> = omgbase_search::blob_to_f32(&bytes)
        .iter()
        .map(|f| json!(f64::from(*f)))
        .collect();
    row["vec"] = Json::Array(floats);
}

fn str_of<'a>(row: &'a Json, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

fn bytes_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.as_bytes().cmp(b.as_bytes())
}

// ---- observation scripts (spec/store §9.4 + spec/search §7) --------------------------

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

fn limit_of(body: &Json, default: usize) -> usize {
    body.get("limit")
        .and_then(Json::as_u64)
        .map_or(default, |n| n as usize)
}

/// §7 `search`: text-only → `text_search` hits; semantic-only →
/// `vector_search` with the fixture-embedded query; both → `hybrid` hits with
/// evidence.
fn search_step(store: &Store, repo_id: &str, body: &Json) -> Result<Json, String> {
    let text = body.get("text").and_then(Json::as_str);
    let semantic = body.get("semantic").and_then(Json::as_str);
    let limit = limit_of(body, 50);
    let embedder = FixtureEmbedder;
    match (text, semantic) {
        (Some(t), None) => {
            let r = store
                .text_search(repo_id, t, limit)
                .map_err(|e| e.to_string())?;
            let hits: Vec<Json> = r
                .hits
                .iter()
                .map(|h| {
                    json!({
                        "block_id": h.block_id, "doc_id": h.doc_id, "path": h.path,
                        "type": h.block_type, "text": h.text, "score": h.score,
                    })
                })
                .collect();
            Ok(json!({ "hits": hits, "truncated": r.truncated }))
        }
        (None, Some(s)) => {
            let q = embedder.embed_query(s).map_err(|e| e.to_string())?;
            let hits = store
                .vector_search(repo_id, embedder.model(), &q, limit)
                .map_err(|e| e.to_string())?;
            Ok(json!({
                "hits": hits.iter().map(|h| json!({
                    "block_id": h.block_id, "doc_id": h.doc_id, "path": h.path, "cosine": h.cosine,
                })).collect::<Vec<_>>()
            }))
        }
        (Some(t), Some(s)) => {
            let q = embedder.embed_query(s).map_err(|e| e.to_string())?;
            let hits = store
                .hybrid_search(
                    repo_id,
                    &HybridQuery {
                        text: Some(t.to_owned()),
                        vector: Some(QueryVector {
                            model: embedder.model().to_owned(),
                            vec: q,
                        }),
                        terms: None,
                        limit: Some(limit),
                    },
                )
                .map_err(|e| e.to_string())?;
            Ok(json!({
                "hits": hits.iter().map(|h| json!({
                    "block_id": h.block_id, "doc_id": h.doc_id, "path": h.path,
                    "score": h.score, "evidence": h.evidence.to_json(),
                })).collect::<Vec<_>>()
            }))
        }
        (None, None) => Err("search needs text and/or semantic".to_owned()),
    }
}

/// §4 `resolve`: `query` (+ the fixture-embedded `semantic`), limit default 10.
fn resolve_step(store: &Store, repo_id: &str, body: &Json) -> Result<Json, String> {
    let query = body["query"].as_str().ok_or("resolve.query")?;
    let embedder = FixtureEmbedder;
    let vector = match body.get("semantic").and_then(Json::as_str) {
        Some(s) => Some(QueryVector {
            model: embedder.model().to_owned(),
            vec: embedder.embed_query(s).map_err(|e| e.to_string())?,
        }),
        None => None,
    };
    let limit = body.get("limit").and_then(Json::as_u64).map(|n| n as usize);
    let hits = store
        .resolve(repo_id, query, vector, limit)
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "hits": hits.iter().map(|h| json!({
            "id": h.id, "locator": h.locator, "preview": h.preview, "evidence": h.evidence.to_json(),
        })).collect::<Vec<_>>()
    }))
}

struct Evaluation {
    /// The §7 projection (plus `steps`), keyed like a fixture `expect`.
    actual: JsonMap<String, Json>,
    /// Runner-check violations, prefixed with the step they were found after.
    problems: Vec<String>,
}

fn run_case_script(c: &Json) -> Result<Evaluation, String> {
    let config = config_from(c.get("config"))?;
    let mut store = Store::open_in_memory_with_minter(Box::new(SequentialMinter::new()))
        .map_err(|e| e.to_string())?;
    let repo_id = store
        .create_repo(FIXTURE_REPO_SLUG)
        .map_err(|e| e.to_string())?;
    let embedder = FixtureEmbedder;
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
        } else if let Some(sweep) = step.get("sweep") {
            let ts = sweep["ts"].as_str().ok_or("sweep.ts")?;
            let swept = store.sweep_pool(ts).map_err(|e| format!("step {i}: {e}"))?;
            steps.push(json!({ "swept": swept }));
        } else if step.get("drain").is_some() {
            let d = store
                .drain(&repo_id, &embedder)
                .map_err(|e| format!("step {i}: {e}"))?;
            steps.push(json!({
                "embedded": d.blocks.embedded, "cached": d.blocks.cached,
                "doc_embedded": d.docs.embedded, "doc_cached": d.docs.cached,
                "doc_pooled": d.docs.pooled,
            }));
        } else if let Some(search) = step.get("search") {
            steps
                .push(search_step(&store, &repo_id, search).map_err(|e| format!("step {i}: {e}"))?);
        } else if let Some(resolve) = step.get("resolve") {
            steps.push(
                resolve_step(&store, &repo_id, resolve).map_err(|e| format!("step {i}: {e}"))?,
            );
        } else {
            return Err(format!("step {i}: unknown step"));
        }
        for p in check_search(store.conn(), &repo_id) {
            problems.push(format!("after step {i}: {p}"));
        }
    }
    let mut actual = JsonMap::new();
    actual.insert("steps".to_owned(), Json::Array(steps));
    for (k, v) in project_search(&store, &repo_id).map_err(|e| e.to_string())? {
        actual.insert(k, v);
    }
    Ok(Evaluation { actual, problems })
}

// ---- projection (§7) ------------------------------------------------------------------

/// The §7 projection: `embed_tasks`, `doc_tasks` (with `header` and
/// `method_if_embedded` under the fixture embedder's budget), `embeddings` by
/// (`content_hash`, `ctx_hash`), `doc_embeddings` by `doc_id`.
fn project_search(store: &Store, repo_id: &str) -> omgbase_store::Result<Vec<(String, Json)>> {
    let embed_tasks: Vec<Json> = store
        .build_embed_tasks(repo_id)?
        .iter()
        .map(|t| json!({ "block_id": t.block_id, "content_hash": t.content_hash, "ctx": t.ctx }))
        .collect();
    let budget = token_budget(FixtureEmbedder.max_input_tokens());
    let doc_tasks: Vec<Json> = store
        .build_doc_embed_tasks(repo_id)?
        .iter()
        .map(|t| {
            json!({
                "doc_id": t.doc_id,
                "header": t.header,
                "input_hash": hex(&t.input_hash()),
                "method_if_embedded": DocEmbedMethod::for_input(&t.input, budget).as_str(),
                "blocks": t.blocks.iter().map(|b| json!({ "content_hash": b.content_hash, "tokens": b.tokens })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let conn = store.conn();
    let mut embeddings: Vec<Json> = query_rows(
        conn,
        "SELECT content_hash, ctx_hash, model, dim, vec FROM embeddings",
        &[],
    );
    embeddings.sort_by(|a, b| {
        bytes_cmp(str_of(a, "content_hash"), str_of(b, "content_hash"))
            .then_with(|| bytes_cmp(str_of(a, "ctx_hash"), str_of(b, "ctx_hash")))
    });
    embeddings.iter_mut().for_each(vec_json);
    let mut doc_embeddings: Vec<Json> = query_rows(
        conn,
        "SELECT e.doc_id, e.model, e.input_hash, e.method, e.dim, e.vec
           FROM doc_embeddings e JOIN docs d ON d.doc_id = e.doc_id WHERE d.repo_id = ?1",
        &[&repo_id],
    );
    doc_embeddings.sort_by(|a, b| bytes_cmp(str_of(a, "doc_id"), str_of(b, "doc_id")));
    doc_embeddings.iter_mut().for_each(vec_json);
    Ok(vec![
        ("embed_tasks".to_owned(), Json::Array(embed_tasks)),
        ("doc_tasks".to_owned(), Json::Array(doc_tasks)),
        ("embeddings".to_owned(), Json::Array(embeddings)),
        ("doc_embeddings".to_owned(), Json::Array(doc_embeddings)),
    ])
}

// ---- runner checks --------------------------------------------------------------------------

/// Cache rows are well-formed: `dim × 4` bytes of vector, a known `method`,
/// and (the fixture embedder being the only provider) the fixture model.
fn check_search(conn: &Connection, _repo_id: &str) -> Vec<String> {
    let mut problems = Vec::new();
    for row in query_rows(
        conn,
        "SELECT content_hash, ctx_hash, model, dim, length(vec) AS len FROM embeddings",
        &[],
    ) {
        if row["dim"].as_i64().unwrap_or(-1) * 4 != row["len"].as_i64().unwrap_or(-2) {
            problems.push(format!(
                "embeddings {}/{}: dim × 4 != length(vec)",
                str_of(&row, "content_hash"),
                str_of(&row, "ctx_hash")
            ));
        }
        if str_of(&row, "model") != omgbase_search::FIXTURE_MODEL {
            problems.push(format!(
                "embeddings row under model {}",
                str_of(&row, "model")
            ));
        }
    }
    for row in query_rows(
        conn,
        "SELECT doc_id, model, method, dim, length(vec) AS len FROM doc_embeddings",
        &[],
    ) {
        if row["dim"].as_i64().unwrap_or(-1) * 4 != row["len"].as_i64().unwrap_or(-2) {
            problems.push(format!(
                "doc_embeddings {}: dim × 4 != length(vec)",
                str_of(&row, "doc_id")
            ));
        }
        if DocEmbedMethod::parse(str_of(&row, "method")).is_none() {
            problems.push(format!(
                "doc_embeddings {}: method {:?}",
                str_of(&row, "doc_id"),
                str_of(&row, "method")
            ));
        }
    }
    problems
}

// ---- comparison ----------------------------------------------------------------------

/// The tolerance for a number at `path`: `score`s (bm25, and the hybrid
/// score built on it) within 1e-6, everything else within 1e-9.
fn tolerance(path: &str) -> f64 {
    if path.ends_with(".score") {
        TEXT_SCORE_EPS
    } else {
        EPS
    }
}

/// §7: two numbers agree when within the path's tolerance, or when they are
/// the same float32 (stored vectors and cosines are float32 data printed as
/// f64 on one side and possibly shortest-f32 on the other).
fn numbers_agree(x: f64, y: f64, path: &str) -> bool {
    x == y
        || (x.is_nan() && y.is_nan())
        || (x - y).abs() <= tolerance(path)
        || (x as f32) == (y as f32)
}

/// Deep-compare two JSON values, object key order ignored, numbers per
/// [`numbers_agree`]. `None` when equal, else the first difference.
fn deep_eq(a: &Json, b: &Json, path: &str) -> Option<String> {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => {
            let (x, y) = (
                x.as_f64().unwrap_or(f64::NAN),
                y.as_f64().unwrap_or(f64::NAN),
            );
            if numbers_agree(x, y, path) {
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

fn f32s(v: &Json) -> Vec<f32> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| x.as_f64().unwrap_or(f64::NAN) as f32)
                .collect()
        })
        .unwrap_or_default()
}

fn check(c: &SpecCase) -> Result<(), String> {
    match c.kind {
        Kind::Sanitize => {
            let input = c.case["input"].as_str().ok_or("input")?;
            let want = c.case["expect"].as_str().ok_or("expect")?;
            let got = sanitize_fts_query(input);
            if got == want {
                Ok(())
            } else {
                Err(clip(format!(
                    "sanitize({input:?}): got {got:?}, want {want:?}"
                )))
            }
        }
        Kind::Cosine => {
            let got = cosine_f32(&f32s(&c.case["a"]), &f32s(&c.case["b"]));
            let want = c.case["expect"].as_f64().ok_or("expect")?;
            if (got - want).abs() <= EPS {
                Ok(())
            } else {
                Err(format!("cosine: got {got}, want {want}"))
            }
        }
        Kind::Observe => {
            let ev = run_case_script(&c.case)?;
            if !ev.problems.is_empty() {
                return Err(clip(format!("checks: {}", ev.problems.join("; "))));
            }
            // Compare exactly the keys the fixture carries.
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
    std::env::var("SEARCH_SPEC_UPDATE").is_ok_and(|v| !v.is_empty() && v != "0")
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
        "cases that pass but are not listed in spec-passing.txt — add them (or run SEARCH_SPEC_UPDATE=1 cargo test -p omgbase-search --test spec)",
        &unlisted_passing,
    );
    report("stale allowlist entries", &stale);
    if passing == all_ids {
        eprintln!(
            "spec: every case passes — delete tests/spec-passing.txt (or run with SEARCH_SPEC_UPDATE=1)"
        );
    }
    assert!(
        regressions.is_empty() && unlisted_passing.is_empty() && stale.is_empty(),
        "spec allowlist out of date: {} regression(s), {} unlisted passing, {} stale — see the report above (stderr); \
         promote with `SEARCH_SPEC_UPDATE=1 cargo test -p omgbase-search --test spec`",
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

/// `spec/search/VERSION` is the version this crate implements.
#[test]
fn version_agrees_with_the_spec() {
    let version_file = Path::new(SPEC_DIR).join("VERSION");
    if !version_file.is_file() {
        eprintln!("spec: {} not present; skipping", version_file.display());
        return;
    }
    let version = fs::read_to_string(version_file).expect("VERSION");
    assert_eq!(omgbase_search::SPEC_VERSION, version.trim());
}

/// The runner checks hold for every observation case's resulting database,
/// whatever the fixture expects — a failing comparison must never hide a
/// broken cache.
#[test]
fn every_case_satisfies_the_runner_checks() {
    if !spec_available() {
        return;
    }
    let loaded = load();
    let mut problems = Vec::new();
    let mut checked = 0usize;
    for f in &loaded.files {
        for c in f.cases.iter().filter(|c| c.kind == Kind::Observe) {
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
    if checked == 0 {
        eprintln!("spec: no observation cases yet");
    }
}
