//! The mutation spec conformance runner: executes every fixture under
//! `spec/mutate/cases` — observation scripts exactly as `spec/store` §9.4
//! plus the `apply`, `macro`, `docs`, `plan` and `disk` steps of
//! `spec/mutate` §9 — against `omgbase-store` (which calls this crate to apply
//! changesets) and an in-memory doc store seeded by the `observe` steps, then
//! checks the §8 invariants, `files[path] == reconstruct(doc)`, and the
//! projection (`steps`, `files`, `docs`, `blocks`, `commits`, `revisions`,
//! `dispositions`, `resurrection_pool`). The reference runner this mirrors is
//! `packages/core/corpus/mutate/spec.test.ts` (+ `fixture.ts`).
//!
//! Allowlist (`tests/spec-passing.txt`, one `<file-stem>::<name>` per line):
//! while the port is incomplete it names the cases that must pass. A listed
//! case that fails, an unlisted case that passes, or a listed id that no
//! longer exists all fail the build. If the file is absent, every case must
//! pass. Promote cases by rewriting the list to the currently passing set:
//!
//! ```text
//! MUTATE_SPEC_UPDATE=1 cargo test -p omgbase-mutate --test spec
//! ```

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use omgbase_format::hash::{hex, sha256};
use omgbase_mutate::{At, MutationError, Op, Opset};
use omgbase_reconcile::Config;
use omgbase_store::tree::parse_tree_entries;
use omgbase_store::{
    ApplyOrigin, ApplyRequest, ApplyResult, BatchItem, BatchOutcome, DocOpContext, DocStore,
    LinkRepair, MemDocStore, SequentialMinter, SetFrontmatter, Store, TreeEntry,
};
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map as JsonMap, Value as Json, json};

const SPEC_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/mutate");
const CASES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/mutate/cases");
const PASSING_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/spec-passing.txt");
/// A wrong `CASES_DIR` must not pass by finding some other, smaller directory.
const MIN_CASE_FILES: usize = 3;
const MAX_REPORT_LINES: usize = 400;
/// Nothing projected is floating point except `confidence`; compare within this.
const EPS: f64 = 1e-9;
/// The repo every case runs in (`spec/store` §9.4 "Inputs").
const FIXTURE_REPO_SLUG: &str = "fixture";
/// `current.markdown` longer than this many bytes is dropped from a recorded error.
const CURRENT_MARKDOWN_LIMIT: usize = 200;

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
const PROJECTED_TABLES: [&str; 6] = [
    "docs",
    "blocks",
    "commits",
    "revisions",
    "dispositions",
    "resurrection_pool",
];
const STEP_KINDS: [&str; 7] = ["observe", "sweep", "apply", "macro", "docs", "plan", "disk"];
const MACROS: [&str; 9] = [
    "tasks_complete",
    "sections_append",
    "docs_append",
    "sections_rename",
    "sections_move",
    "lists_insert_item",
    "node_set",
    "links_repair",
    "links_retarget",
];
const DOC_OPS: [&str; 4] = ["create", "move", "delete", "set_meta"];

const PASSING_HEADER: &str = "\
# Mutate spec cases (spec/mutate/cases) that the Rust port must pass, one
# `<file-stem>::<name>` id per line, sorted. Maintained by tests/spec.rs:
# a listed case failing fails the build; an unlisted case passing also fails
# the build (add it here). Regenerate from the currently passing set with
#
#     MUTATE_SPEC_UPDATE=1 cargo test -p omgbase-mutate --test spec
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

fn require_ts(body: &JsonMap<String, Json>, here: &str, problems: &mut Vec<String>) {
    if !body
        .get("ts")
        .and_then(Json::as_str)
        .is_some_and(is_spec_ts)
    {
        problems.push(format!(
            "{here}: `ts` must be RFC 3339 UTC with three fractional digits and Z (spec/store §2.4)"
        ));
    }
}

fn require_origin(v: Option<&Json>, here: &str, problems: &mut Vec<String>) {
    let ok = v.and_then(Json::as_object).is_some_and(|o| {
        o.get("actor").is_some_and(Json::is_string)
            && o.get("reason").is_none_or(Json::is_string)
            && o.keys().all(|k| k == "actor" || k == "reason")
    });
    if !ok {
        problems.push(format!("{here}: `origin` is {{ actor, reason? }}"));
    }
}

fn only_keys(
    body: &JsonMap<String, Json>,
    allowed: &[&str],
    here: &str,
    problems: &mut Vec<String>,
) {
    let extra = unknown_keys(body, allowed);
    if !extra.is_empty() {
        problems.push(format!("{here}: unknown keys {}", extra.join(", ")));
    }
}

fn validate_observe_body(here: &str, body: &JsonMap<String, Json>, problems: &mut Vec<String>) {
    require_ts(body, here, problems);
    only_keys(body, &["ts", "items"], here, problems);
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
        only_keys(it, &["path", "source"], &where_, problems);
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

fn validate_disk(body: &Json, here: &str, problems: &mut Vec<String>) {
    let Some(b) = body.as_object() else {
        problems.push(format!("{here}: not an object"));
        return;
    };
    only_keys(b, &["path", "source"], here, problems);
    match b.get("path").and_then(Json::as_str) {
        Some(p) if !p.is_empty() && !p.starts_with('/') => {}
        _ => problems.push(format!(
            "{here}: `path` must be repo-relative with no leading slash"
        )),
    }
    if !b.get("source").is_some_and(Json::is_string) {
        problems.push(format!("{here}: `source` must be a string"));
    }
}

fn validate_ops(ops: Option<&Json>, here: &str, problems: &mut Vec<String>) {
    let Some(ops) = ops.and_then(Json::as_array) else {
        problems.push(format!("{here}: `ops` must be an array"));
        return;
    };
    for (i, o) in ops.iter().enumerate() {
        if Op::from_json(o).is_err() {
            problems.push(format!("{here}.ops[{i}]: not a well-formed op"));
        }
    }
}

/// Returns the step count, or -1 when `steps` is malformed. `nested` limits
/// the kinds to `observe`/`disk` (a plan's `before_apply`).
fn validate_steps(at: &str, steps: Option<&Json>, nested: bool, problems: &mut Vec<String>) -> i64 {
    let Some(steps) = steps.and_then(Json::as_array).filter(|s| !s.is_empty()) else {
        problems.push(format!("{at}: `steps` must be a non-empty array"));
        return -1;
    };
    for (i, s) in steps.iter().enumerate() {
        let here = format!("{at}[{i}]");
        let Some(obj) = s.as_object() else {
            problems.push(format!("{here}: not an object"));
            continue;
        };
        let keys: Vec<&String> = obj.keys().collect();
        let allowed: &[&str] = if nested {
            &["observe", "disk"]
        } else {
            &STEP_KINDS
        };
        if keys.len() != 1 || !allowed.contains(&keys[0].as_str()) {
            problems.push(format!(
                "{here}: a step is exactly one of {} (got {})",
                allowed.join(" / "),
                keys.iter()
                    .map(|k| k.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            continue;
        }
        let kind = keys[0].as_str();
        let body = &obj[kind];
        let Some(b) = body.as_object() else {
            problems.push(format!("{here}: {kind} must be an object"));
            continue;
        };
        match kind {
            "observe" => validate_observe_body(&here, b, problems),
            "sweep" => {
                require_ts(b, &here, problems);
                only_keys(b, &["ts"], &here, problems);
            }
            "disk" => validate_disk(body, &here, problems),
            "apply" => {
                only_keys(
                    b,
                    &["ts", "ops", "origin", "dry_run", "set_frontmatter"],
                    &here,
                    problems,
                );
                require_ts(b, &here, problems);
                validate_ops(b.get("ops"), &here, problems);
                require_origin(b.get("origin"), &here, problems);
                if b.get("dry_run").is_some_and(|v| !v.is_boolean()) {
                    problems.push(format!("{here}: `dry_run` must be a boolean"));
                }
                if b.get("set_frontmatter").is_some_and(|v| !v.is_array()) {
                    problems.push(format!(
                        "{here}: `set_frontmatter` must be an array of {{ doc, raw }}"
                    ));
                }
            }
            "macro" => {
                only_keys(b, &["ts", "name", "args", "origin"], &here, problems);
                require_ts(b, &here, problems);
                if !b
                    .get("name")
                    .and_then(Json::as_str)
                    .is_some_and(|n| MACROS.contains(&n))
                {
                    problems.push(format!(
                        "{here}: `name` must be one of {}",
                        MACROS.join("/")
                    ));
                }
                if !b.get("args").is_some_and(Json::is_object) {
                    problems.push(format!("{here}: `args` must be an object"));
                }
                require_origin(b.get("origin"), &here, problems);
            }
            "docs" => {
                let mut allowed = vec!["ts", "actor"];
                allowed.extend(DOC_OPS);
                only_keys(b, &allowed, &here, problems);
                require_ts(b, &here, problems);
                if b.get("actor").is_some_and(|v| !v.is_string()) {
                    problems.push(format!("{here}: `actor` must be a string"));
                }
                let ops: Vec<&str> = DOC_OPS
                    .iter()
                    .copied()
                    .filter(|k| b.contains_key(*k))
                    .collect();
                if ops.len() != 1 {
                    problems.push(format!("{here}: exactly one of {}", DOC_OPS.join("/")));
                } else if !b[ops[0]].is_object() {
                    problems.push(format!("{here}.{}: must be an object", ops[0]));
                }
            }
            "plan" => {
                only_keys(
                    b,
                    &["ts", "doc", "content", "apply", "origin", "before_apply"],
                    &here,
                    problems,
                );
                require_ts(b, &here, problems);
                if !b.get("doc").is_some_and(Json::is_string) {
                    problems.push(format!("{here}: `doc` must be a string"));
                }
                if !b.get("content").is_some_and(Json::is_string) {
                    problems.push(format!("{here}: `content` must be a string"));
                }
                if b.get("apply").is_some_and(|v| !v.is_boolean()) {
                    problems.push(format!("{here}: `apply` must be a boolean"));
                }
                if let Some(o) = b.get("origin") {
                    require_origin(Some(o), &here, problems);
                }
                if let Some(ba) = b.get("before_apply") {
                    validate_steps(&format!("{here}.before_apply"), Some(ba), true, problems);
                }
            }
            _ => unreachable!(),
        }
    }
    steps.len() as i64
}

fn validate_projection(at: &str, e: &Json, step_count: i64, problems: &mut Vec<String>) {
    let Some(obj) = e.as_object() else {
        problems.push(format!("{at}: must be an object"));
        return;
    };
    let mut want: Vec<&str> = vec!["steps", "files"];
    want.extend(PROJECTED_TABLES);
    let keys: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
    let want_set: BTreeSet<&str> = want.iter().copied().collect();
    if keys != want_set {
        problems.push(format!(
            "{at}: must have exactly the keys {} (got {})",
            want.join(", "),
            keys.into_iter().collect::<Vec<_>>().join(", ")
        ));
        return;
    }
    if !obj["files"].is_object() {
        problems.push(format!("{at}.files: must be an object"));
    }
    for k in &want {
        if *k != "files" && !obj[*k].is_array() {
            problems.push(format!("{at}.{k}: must be an array"));
        }
    }
    if let Some(steps) = obj["steps"].as_array() {
        if step_count >= 0 && steps.len() as i64 != step_count {
            problems.push(format!(
                "{at}.steps: {} outcomes for {step_count} steps",
                steps.len()
            ));
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
        let step_count = validate_steps(
            &format!("{at}.steps"),
            cobj.get("steps"),
            false,
            &mut problems,
        );
        match cobj.get("expect") {
            Some(expect) => {
                validate_projection(&format!("{at}.expect"), expect, step_count, &mut problems)
            }
            None => problems.push(format!("{at}: missing `expect` (run MUTATE_SPEC_UPDATE=1)")),
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

fn sql_json(v: &Sql) -> Json {
    match v {
        Sql::Null => Json::Null,
        Sql::Integer(i) => json!(i),
        Sql::Real(f) => json!(f),
        Sql::Text(s) => Json::String(s.clone()),
        Sql::Blob(b) => Json::String(hex(b)),
    }
}

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

fn str_of<'a>(row: &'a Json, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

fn int_of(row: &Json, key: &str) -> i64 {
    row[key].as_i64().unwrap_or(i64::MAX)
}

fn with_json_column(mut row: Json, column: &str) -> Json {
    if let Some(text) = row[column].as_str() {
        let parsed: Json = serde_json::from_str(text)
            .unwrap_or_else(|e| panic!("{column} is not JSON ({e}): {text}"));
        row[column] = parsed;
    }
    row
}

// ---- running a case (§9) ----------------------------------------------------------------

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

/// §8: `{ error: { code, op_index?, block?, current?, retriable? } }`; a
/// `current.markdown` over the limit is dropped. Anything but a mutation
/// error is a runner bug.
fn error_outcome(e: &omgbase_store::Error) -> Result<Json, String> {
    let Some(m) = e.as_mutation() else {
        return Err(format!("non-mutation error: {e}"));
    };
    Ok(json!({ "error": error_json(m) }))
}

fn error_json(m: &MutationError) -> Json {
    let mut error = JsonMap::new();
    error.insert("code".to_owned(), json!(m.code.as_str()));
    if let Some(n) = m.data.get("op_index").filter(|v| v.is_number()) {
        error.insert("op_index".to_owned(), n.clone());
    }
    if let Some(b) = m.data.get("block").filter(|v| v.is_string()) {
        error.insert("block".to_owned(), b.clone());
    }
    if let Some(Json::Object(current)) = m.data.get("current") {
        let mut current = current.clone();
        if current
            .get("markdown")
            .and_then(Json::as_str)
            .is_some_and(|s| s.len() > CURRENT_MARKDOWN_LIMIT)
        {
            current.remove("markdown");
        }
        error.insert("current".to_owned(), Json::Object(current));
    }
    if let Some(r) = m.data.get("retriable").filter(|v| v.is_boolean()) {
        error.insert("retriable".to_owned(), r.clone());
    }
    Json::Object(error)
}

fn origin_from(v: Option<&Json>) -> ApplyOrigin {
    let actor = v
        .and_then(|o| o.get("actor"))
        .and_then(Json::as_str)
        .unwrap_or("agent:update");
    let reason = v.and_then(|o| o.get("reason")).and_then(Json::as_str);
    ApplyOrigin::new(actor, reason)
}

struct Runner {
    store: Store,
    repo_id: String,
    doc_store: MemDocStore,
    /// Paths a `disk` step rewrote that no commit has ingested yet.
    pending_disk: HashSet<String>,
    config: Config,
}

fn run_apply(r: &mut Runner, ops: Vec<Op>, body: &JsonMap<String, Json>) -> Result<Json, String> {
    let ts = body.get("ts").and_then(Json::as_str).ok_or("apply.ts")?;
    let set_frontmatter = body
        .get("set_frontmatter")
        .and_then(Json::as_array)
        .map(|arr| {
            arr.iter()
                .map(|e| SetFrontmatter {
                    doc: e["doc"].as_str().unwrap_or_default().to_owned(),
                    raw: e.get("raw").and_then(Json::as_str).map(str::to_owned),
                })
                .collect()
        })
        .unwrap_or_default();
    let req = ApplyRequest {
        repo_id: r.repo_id.clone(),
        ops,
        origin: origin_from(body.get("origin")),
        dry_run: body.get("dry_run").and_then(Json::as_bool).unwrap_or(false),
        set_frontmatter,
    };
    match r.store.apply(&req, &mut r.doc_store, ts) {
        Ok(res) => Ok(res.to_json()),
        Err(e) => error_outcome(&e),
    }
}

fn apply_json(res: &ApplyResult) -> Json {
    res.to_json()
}

fn ops_of(body: &JsonMap<String, Json>) -> Result<Vec<Op>, String> {
    body.get("ops")
        .and_then(Json::as_array)
        .ok_or("ops")?
        .iter()
        .map(Op::from_json)
        .collect()
}

fn strings_of(v: Option<&Json>) -> Vec<String> {
    v.and_then(Json::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Json::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn run_macro(r: &mut Runner, body: &JsonMap<String, Json>) -> Result<Json, String> {
    let name = body
        .get("name")
        .and_then(Json::as_str)
        .ok_or("macro.name")?;
    let a = body
        .get("args")
        .and_then(Json::as_object)
        .ok_or("macro.args")?;
    let s = |k: &str| a.get(k).and_then(Json::as_str).unwrap_or_default();
    let mut extra = JsonMap::new();
    let expansion: omgbase_store::Result<Vec<Op>> = match name {
        "tasks_complete" => r.store.tasks_complete(&strings_of(a.get("blocks"))),
        "sections_append" => Ok(Store::sections_append(s("heading"), s("markdown"))),
        "docs_append" => Ok(Store::docs_append(s("doc"), s("markdown"))),
        "sections_rename" => r.store.sections_rename(s("heading"), s("title")),
        "sections_move" => {
            let to =
                omgbase_mutate::changeset::to_from_json(a.get("to").ok_or("sections_move.to")?)?;
            r.store.sections_move(s("heading"), &to)
        }
        "lists_insert_item" => {
            let at = match a.get("at") {
                Some(Json::String(x)) if x == "start" => At::Start,
                Some(Json::String(x)) if x == "end" => At::End,
                Some(Json::Object(o)) if o.contains_key("before") => {
                    At::Before(o["before"].as_str().unwrap_or_default().to_owned())
                }
                Some(Json::Object(o)) if o.contains_key("after") => {
                    At::After(o["after"].as_str().unwrap_or_default().to_owned())
                }
                _ => return Err("lists_insert_item.at".to_owned()),
            };
            Ok(Store::lists_insert_item(s("anchor"), at, s("markdown")))
        }
        "node_set" => r.store.node_set(s("node"), s("prop"), s("value")),
        "links_repair" | "links_retarget" => {
            let glob = a.get("path_glob").and_then(Json::as_str);
            let plan = if name == "links_repair" {
                let repairs: Vec<LinkRepair> = a
                    .get("repairs")
                    .and_then(Json::as_array)
                    .ok_or("links_repair.repairs")?
                    .iter()
                    .map(|p| LinkRepair {
                        from: p["from"].as_str().unwrap_or_default().to_owned(),
                        to: p["to"].as_str().unwrap_or_default().to_owned(),
                    })
                    .collect();
                r.store.links_repair(&r.repo_id, &repairs, glob)
            } else {
                r.store.links_retarget(&r.repo_id, s("from"), s("to"), glob)
            };
            match plan {
                Ok(p) => {
                    extra = p.extras_json();
                    Ok(p.ops)
                }
                Err(e) => Err(e),
            }
        }
        other => return Err(format!("unknown macro {other}")),
    };
    let ops = match expansion {
        Ok(ops) => ops,
        Err(e) => return error_outcome(&e),
    };
    let mut out = JsonMap::new();
    out.insert(
        "ops".to_owned(),
        Json::Array(ops.iter().map(Op::to_json).collect()),
    );
    for (k, v) in extra {
        out.insert(k, v);
    }
    let outcome = run_apply(r, ops, body)?;
    if let Json::Object(o) = outcome {
        for (k, v) in o {
            out.insert(k, v);
        }
    }
    Ok(Json::Object(out))
}

fn run_docs(r: &mut Runner, body: &JsonMap<String, Json>) -> Result<Json, String> {
    let ctx = DocOpContext {
        repo_id: r.repo_id.clone(),
        actor: body.get("actor").and_then(Json::as_str).map(str::to_owned),
        ts: body
            .get("ts")
            .and_then(Json::as_str)
            .ok_or("docs.ts")?
            .to_owned(),
    };
    let result: omgbase_store::Result<Json> = if let Some(c) = body.get("create") {
        let fm = c.get("frontmatter").and_then(Json::as_object);
        r.store
            .docs_create(
                &ctx,
                &mut r.doc_store,
                c["path"].as_str().unwrap_or_default(),
                c["markdown"].as_str().unwrap_or_default(),
                fm,
            )
            .map(|res| res.to_json())
    } else if let Some(m) = body.get("move") {
        r.store
            .docs_move(
                &ctx,
                &mut r.doc_store,
                m["doc"].as_str().unwrap_or_default(),
                m["to_path"].as_str().unwrap_or_default(),
                m.get("retarget_inbound")
                    .and_then(Json::as_bool)
                    .unwrap_or(false),
            )
            .map(|res| res.to_json())
    } else if let Some(d) = body.get("delete") {
        r.store
            .docs_delete(
                &ctx,
                &mut r.doc_store,
                d["doc"].as_str().unwrap_or_default(),
            )
            .map(|res| res.to_json())
    } else if let Some(m) = body.get("set_meta") {
        r.store
            .docs_set_meta(
                &ctx,
                &mut r.doc_store,
                m["doc"].as_str().unwrap_or_default(),
                m.get("set").and_then(Json::as_object),
                &strings_of(m.get("unset")),
            )
            .map(|res| res.to_json())
    } else {
        return Err("docs step names no operation".to_owned());
    };
    match result {
        Ok(v) => Ok(v),
        Err(e) => error_outcome(&e),
    }
}

fn run_plan(r: &mut Runner, body: &JsonMap<String, Json>) -> Result<Json, String> {
    let ts = body.get("ts").and_then(Json::as_str).ok_or("plan.ts")?;
    let doc = body.get("doc").and_then(Json::as_str).ok_or("plan.doc")?;
    let content = body
        .get("content")
        .and_then(Json::as_str)
        .ok_or("plan.content")?;
    let config = r.config.clone();
    let opset: Opset = match r.store.plan_update(&r.repo_id, doc, content, &config) {
        Ok(o) => o,
        Err(e) => return error_outcome(&e),
    };
    let mut out = JsonMap::new();
    out.insert("opset".to_owned(), opset.to_json());
    if let Some(before) = body.get("before_apply").and_then(Json::as_array) {
        let mut outcomes = Vec::new();
        for step in before {
            outcomes.push(run_step(r, step)?);
        }
        out.insert("before_apply".to_owned(), Json::Array(outcomes));
    }
    if body.get("apply").and_then(Json::as_bool).unwrap_or(false) {
        let origin = origin_from(body.get("origin"));
        let outcome =
            match r
                .store
                .apply_opset(&r.repo_id, &opset, &origin, false, &mut r.doc_store, ts)
            {
                Ok(res) => apply_json(&res),
                Err(e) => error_outcome(&e)?,
            };
        out.insert("apply".to_owned(), outcome);
    }
    Ok(Json::Object(out))
}

fn run_step(r: &mut Runner, step: &Json) -> Result<Json, String> {
    let obj = step.as_object().ok_or("step")?;
    let (kind, body) = obj.iter().next().ok_or("empty step")?;
    match kind.as_str() {
        "observe" => {
            let ts = body["ts"].as_str().ok_or("observe.ts")?;
            let items: Vec<BatchItem> = body["items"]
                .as_array()
                .ok_or("observe.items")?
                .iter()
                .map(|it| BatchItem {
                    path: it["path"].as_str().unwrap_or_default().to_owned(),
                    source: it["source"].as_str().map(str::to_owned),
                })
                .collect();
            let config = r.config.clone();
            let outcomes = r
                .store
                .observe_batch(&r.repo_id, &items, ts, &config)
                .map_err(|e| e.to_string())?;
            for it in &items {
                match &it.source {
                    None => r.doc_store.remove(&it.path).map_err(|e| e.to_string())?,
                    Some(s) => r.doc_store.write(&it.path, s).map_err(|e| e.to_string())?,
                }
                r.pending_disk.remove(&it.path);
            }
            Ok(Json::Array(outcomes.iter().map(outcome_json).collect()))
        }
        "sweep" => {
            let ts = body["ts"].as_str().ok_or("sweep.ts")?;
            let swept = r.store.sweep_pool(ts).map_err(|e| e.to_string())?;
            Ok(json!({ "swept": swept }))
        }
        "disk" => {
            let path = body["path"].as_str().ok_or("disk.path")?;
            let source = body["source"].as_str().ok_or("disk.source")?;
            r.doc_store.write(path, source).map_err(|e| e.to_string())?;
            r.pending_disk.insert(path.to_owned());
            Ok(json!({}))
        }
        "apply" => {
            let b = body.as_object().ok_or("apply")?;
            let ops = ops_of(b)?;
            run_apply(r, ops, b)
        }
        "macro" => run_macro(r, body.as_object().ok_or("macro")?),
        "docs" => run_docs(r, body.as_object().ok_or("docs")?),
        "plan" => run_plan(r, body.as_object().ok_or("plan")?),
        other => Err(format!("unknown step {other}")),
    }
}

struct Evaluation {
    /// The §9 projection, keyed like a fixture `expect`.
    actual: Json,
    /// Invariant violations, prefixed with the step they were found after.
    problems: Vec<String>,
}

fn run_case_script(c: &Json) -> Result<Evaluation, String> {
    let config = config_from(c.get("config"))?;
    let mut store = Store::open_in_memory_with_minter(Box::new(SequentialMinter::new()))
        .map_err(|e| e.to_string())?;
    let repo_id = store
        .create_repo(FIXTURE_REPO_SLUG)
        .map_err(|e| e.to_string())?;
    let mut r = Runner {
        store,
        repo_id,
        doc_store: MemDocStore::new(),
        pending_disk: HashSet::new(),
        config,
    };
    let mut steps = Vec::new();
    let mut problems = Vec::new();
    for (i, step) in c["steps"].as_array().ok_or("steps")?.iter().enumerate() {
        steps.push(run_step(&mut r, step).map_err(|e| format!("step {i}: {e}"))?);
        for p in check_all(&mut r) {
            problems.push(format!("after step {i}: {p}"));
        }
    }
    for p in check_all(&mut r) {
        problems.push(format!("at end: {p}"));
    }
    let mut actual = JsonMap::new();
    actual.insert("steps".to_owned(), Json::Array(steps));
    let files: JsonMap<String, Json> = r
        .doc_store
        .files()
        .iter()
        .map(|(k, v)| (k.clone(), json!(v)))
        .collect();
    actual.insert("files".to_owned(), Json::Object(files));
    for (k, v) in project_store(r.store.conn(), &r.repo_id) {
        actual.insert(k, v);
    }
    Ok(Evaluation {
        actual: Json::Object(actual),
        problems,
    })
}

// ---- projection (§9) --------------------------------------------------------------------

const BLOCK_COLUMNS: &str = "block_id, doc_id, parent_block, order_key, ordinal, depth, ancestor_path, type, attrs, text, raw_hash, norm_hash, trivia_hash, created_commit, deleted_commit";

fn doc_blocks_preorder(conn: &Connection, doc_id: &str) -> Vec<Json> {
    let rows = query_rows(
        conn,
        &format!("SELECT {BLOCK_COLUMNS} FROM blocks WHERE doc_id = ?1 ORDER BY ordinal, block_id"),
        &[&doc_id],
    );
    let ids: HashSet<String> = rows
        .iter()
        .map(|r| r["block_id"].as_str().unwrap_or_default().to_owned())
        .collect();
    let mut by_parent: BTreeMap<Option<String>, Vec<&Json>> = BTreeMap::new();
    for r in &rows {
        let parent = r["parent_block"]
            .as_str()
            .filter(|p| ids.contains(*p))
            .map(str::to_owned);
        by_parent.entry(parent).or_default().push(r);
    }
    fn walk(
        parent: Option<&str>,
        by_parent: &BTreeMap<Option<String>, Vec<&Json>>,
        out: &mut Vec<Json>,
    ) {
        let key = parent.map(str::to_owned);
        for r in by_parent.get(&key).map_or(&[][..], Vec::as_slice) {
            out.push((*r).clone());
            walk(r["block_id"].as_str(), by_parent, out);
        }
    }
    let mut out = Vec::new();
    walk(None, &by_parent, &mut out);
    out
}

fn project_store(conn: &Connection, repo_id: &str) -> Vec<(String, Json)> {
    let docs = query_rows(
        conn,
        "SELECT doc_id, path, format, current_rev, file_hash, conflicted, leading_trivia, frontmatter_trivia, deleted_commit FROM docs WHERE repo_id = ?1 ORDER BY path",
        &[&repo_id],
    );
    let doc_ids: Vec<String> = docs
        .iter()
        .map(|d| str_of(d, "doc_id").to_owned())
        .collect();
    let commits = query_rows(
        conn,
        "SELECT commit_id, seq, ts, origin, actor, reason, checkpoint_id, ops FROM commits WHERE repo_id = ?1 ORDER BY seq",
        &[&repo_id],
    );
    let commit_seq: HashMap<String, i64> = commits
        .iter()
        .map(|c| (str_of(c, "commit_id").to_owned(), int_of(c, "seq")))
        .collect();
    let seq_of = |id: &str| commit_seq.get(id).copied().unwrap_or(i64::MAX);
    let mut revisions = query_rows(
        conn,
        "SELECT r.rev_id, r.doc_id, r.seq, r.root_tree, r.frontmatter_blob, r.rendered_hash, r.path, r.commit_id
         FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE d.repo_id = ?1",
        &[&repo_id],
    );
    revisions.sort_by(|a, b| {
        str_of(a, "doc_id")
            .as_bytes()
            .cmp(str_of(b, "doc_id").as_bytes())
            .then(int_of(a, "seq").cmp(&int_of(b, "seq")))
    });
    let mut blocks = Vec::new();
    for doc_id in &doc_ids {
        for r in doc_blocks_preorder(conn, doc_id) {
            blocks.push(with_json_column(r, "attrs"));
        }
    }
    let by_commit_block_kind = |a: &Json, b: &Json| {
        seq_of(str_of(a, "commit_id"))
            .cmp(&seq_of(str_of(b, "commit_id")))
            .then(
                str_of(a, "block_id")
                    .as_bytes()
                    .cmp(str_of(b, "block_id").as_bytes()),
            )
            .then(
                str_of(a, "kind")
                    .as_bytes()
                    .cmp(str_of(b, "kind").as_bytes()),
            )
    };
    let mut dispositions: Vec<Json> = query_rows(
        conn,
        "SELECT x.commit_id, x.block_id, x.kind, x.confidence, x.reason, x.matcher_v, x.detail
         FROM dispositions x JOIN commits c ON c.commit_id = x.commit_id WHERE c.repo_id = ?1",
        &[&repo_id],
    )
    .into_iter()
    .map(|r| with_json_column(r, "detail"))
    .collect();
    dispositions.sort_by(by_commit_block_kind);
    let mut pool = query_rows(
        conn,
        "SELECT block_id, doc_id, raw_hash, norm_hash, type, deleted_commit, expires_ts FROM resurrection_pool WHERE repo_id = ?1",
        &[&repo_id],
    );
    pool.sort_by(|a, b| {
        str_of(a, "expires_ts").cmp(str_of(b, "expires_ts")).then(
            str_of(a, "block_id")
                .as_bytes()
                .cmp(str_of(b, "block_id").as_bytes()),
        )
    });
    vec![
        ("docs".to_owned(), Json::Array(docs)),
        ("blocks".to_owned(), Json::Array(blocks)),
        ("commits".to_owned(), Json::Array(commits)),
        ("revisions".to_owned(), Json::Array(revisions)),
        ("dispositions".to_owned(), Json::Array(dispositions)),
        ("resurrection_pool".to_owned(), Json::Array(pool)),
    ]
}

// ---- checks (spec/store §8 + §9 files) ----------------------------------------------------

/// The `files[path] == reconstruct(doc)` check for every live document (a
/// path a `disk` step rewrote is exempt until a commit ingests those bytes),
/// then the store invariants with the file bytes as the last source.
fn check_all(r: &mut Runner) -> Vec<String> {
    let mut problems = Vec::new();
    let mut last_source: HashMap<String, String> = HashMap::new();
    let live: Vec<(String, String, Option<Vec<u8>>)> = {
        let mut stmt = r
            .store
            .conn()
            .prepare(
                "SELECT doc_id, path, file_hash FROM docs WHERE repo_id = ?1 AND deleted_commit IS NULL AND current_rev IS NOT NULL ORDER BY path",
            )
            .expect("valid SQL");
        let it = stmt
            .query_map(params![r.repo_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .expect("query runs");
        it.map(|x| x.expect("row reads")).collect()
    };
    for (doc_id, path, file_hash) in live {
        let bytes = r.doc_store.read(&path).expect("mem store reads");
        if let (Some(b), Some(h)) = (&bytes, &file_hash) {
            if sha256(b.as_bytes())[..] == h[..] {
                r.pending_disk.remove(&path);
            }
        }
        let reconstructed = r
            .store
            .reconstruct(&doc_id)
            .ok()
            .flatten()
            .unwrap_or_default();
        if r.pending_disk.contains(&path) {
            last_source.insert(path.clone(), reconstructed);
            continue;
        }
        let Some(bytes) = bytes else {
            problems.push(format!(
                "files: live doc {doc_id} ({path}) has no file in the doc store"
            ));
            continue;
        };
        if reconstructed != bytes {
            problems.push(format!("files: {path} != reconstruct({doc_id})"));
        }
        last_source.insert(path, bytes);
    }
    problems.extend(check_invariants(&r.store, &r.repo_id, &last_source));
    problems
}

struct Rev {
    rev_id: String,
    doc_id: String,
    seq: i64,
    root_tree: String,
    frontmatter_blob: Option<String>,
    rendered_hash: Vec<u8>,
    commit_id: String,
}

struct Doc {
    doc_id: String,
    path: String,
    current_rev: Option<String>,
    file_hash: Option<Vec<u8>>,
    deleted_commit: Option<String>,
}

fn all_rows<T>(
    conn: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
    f: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Vec<T> {
    let mut stmt = conn.prepare(sql).expect("valid SQL");
    stmt.query_map(params, f)
        .expect("query runs")
        .map(|r| r.expect("row reads"))
        .collect()
}

/// `spec/store` §8 I1–I8 (the store runner's checker).
fn check_invariants(
    store: &Store,
    repo_id: &str,
    last_source: &HashMap<String, String>,
) -> Vec<String> {
    let conn = store.conn();
    let mut problems = Vec::new();

    let blob_rows: Vec<(Vec<u8>, Vec<u8>, i64)> =
        all_rows(conn, "SELECT hash, bytes, size FROM blobs", &[], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        });
    let blob_hashes: HashSet<String> = blob_rows.iter().map(|b| hex(&b.0)).collect();
    let tree_rows: Vec<(Vec<u8>, String)> =
        all_rows(conn, "SELECT hash, entries FROM tree_nodes", &[], |r| {
            Ok((r.get(0)?, r.get(1)?))
        });
    let tree_hashes: HashSet<String> = tree_rows.iter().map(|t| hex(&t.0)).collect();
    let mut trees: HashMap<String, Vec<TreeEntry>> = HashMap::new();
    let commits: Vec<(String, i64, String)> = all_rows(
        conn,
        "SELECT commit_id, seq, ts FROM commits WHERE repo_id = ?1 ORDER BY ts, seq",
        &[&repo_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    );
    let commit_by_id: HashMap<&str, &(String, i64, String)> =
        commits.iter().map(|c| (c.0.as_str(), c)).collect();
    let docs: Vec<Doc> = all_rows(
        conn,
        "SELECT doc_id, path, current_rev, file_hash, deleted_commit FROM docs WHERE repo_id = ?1 ORDER BY path",
        &[&repo_id],
        |r| {
            Ok(Doc {
                doc_id: r.get(0)?,
                path: r.get(1)?,
                current_rev: r.get(2)?,
                file_hash: r.get(3)?,
                deleted_commit: r.get(4)?,
            })
        },
    );
    let revisions: Vec<Rev> = all_rows(
        conn,
        "SELECT r.rev_id, r.doc_id, r.seq, r.root_tree, r.frontmatter_blob, r.rendered_hash, r.commit_id
         FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE d.repo_id = ?1",
        &[&repo_id],
        |r| {
            Ok(Rev {
                rev_id: r.get(0)?,
                doc_id: r.get(1)?,
                seq: r.get(2)?,
                root_tree: hex(&r.get::<_, Vec<u8>>(3)?),
                frontmatter_blob: r.get::<_, Option<Vec<u8>>>(4)?.map(|h| hex(&h)),
                rendered_hash: r.get(5)?,
                commit_id: r.get(6)?,
            })
        },
    );
    let rev_by_id: HashMap<&str, &Rev> = revisions.iter().map(|r| (r.rev_id.as_str(), r)).collect();

    // I2
    for (hash, bytes, size) in &blob_rows {
        let h = hex(hash);
        if sha256(bytes)[..] != hash[..] {
            problems.push(format!("I2: blob {h} hash != sha256(bytes)"));
        }
        if *size != bytes.len() as i64 {
            problems.push(format!(
                "I2: blob {h} size {size} != |bytes| {}",
                bytes.len()
            ));
        }
    }
    for (hash, entries) in &tree_rows {
        let h = hex(hash);
        if sha256(entries.as_bytes())[..] != hash[..] {
            problems.push(format!("I2: tree_node {h} hash != sha256(entries)"));
        }
        let Ok(parsed) = parse_tree_entries(entries) else {
            problems.push(format!("I2: tree_node {h} entries do not parse as §4.1"));
            continue;
        };
        for e in &parsed {
            if !blob_hashes.contains(&e.raw_hash_hex) {
                problems.push(format!(
                    "I2: tree_node {h} entry {} raw_hash not in blobs",
                    e.block_id
                ));
            }
            if let Some(t) = &e.trivia_hash_hex {
                if !blob_hashes.contains(t) {
                    problems.push(format!(
                        "I2: tree_node {h} entry {} trivia_hash not in blobs",
                        e.block_id
                    ));
                }
            }
            if let Some(c) = &e.child_tree_hash_hex {
                if !tree_hashes.contains(c) {
                    problems.push(format!(
                        "I2: tree_node {h} entry {} child tree not in tree_nodes",
                        e.block_id
                    ));
                }
            }
        }
        trees.insert(h, parsed);
    }
    for r in &revisions {
        if !tree_hashes.contains(&r.root_tree) {
            problems.push(format!(
                "I2: revision {} root_tree not in tree_nodes",
                r.rev_id
            ));
        }
        if let Some(fm) = &r.frontmatter_blob {
            if !blob_hashes.contains(fm) {
                problems.push(format!(
                    "I2: revision {} frontmatter_blob not in blobs",
                    r.rev_id
                ));
            }
        }
    }

    // I1, I3
    for d in &docs {
        let (Some(current_rev), None) = (&d.current_rev, &d.deleted_commit) else {
            continue;
        };
        let at = format!("doc {} ({})", d.doc_id, d.path);
        let Some(rev) = rev_by_id.get(current_rev.as_str()) else {
            problems.push(format!(
                "I1: {at} current_rev {current_rev} is not a revision"
            ));
            continue;
        };
        match last_source.get(&d.path) {
            None => problems.push(format!(
                "I1: {at} is live but no source was observed for its path"
            )),
            Some(source) => {
                let want = sha256(source.as_bytes());
                if d.file_hash.as_deref() != Some(&want[..]) {
                    problems.push(format!("I1: {at} file_hash != sha256(source)"));
                }
                if rev.rendered_hash[..] != want[..] {
                    problems.push(format!("I1: {at} rendered_hash != sha256(source)"));
                }
                if store.reconstruct(&d.doc_id).ok().flatten().as_deref() != Some(source.as_str()) {
                    problems.push(format!("I1: {at} reconstruct(doc) != source"));
                }
                match store
                    .read_at_revision(&d.doc_id, current_rev)
                    .ok()
                    .flatten()
                {
                    None => problems.push(format!(
                        "I1: {at} reconstruct at {current_rev} returned nothing"
                    )),
                    Some(read) => {
                        if read.content != *source {
                            problems
                                .push(format!("I1: {at} reconstruct at {current_rev} != source"));
                        }
                        if !read.rendered_hash_match {
                            problems.push(format!(
                                "I1: {at} rendered_hash_match is false at the current revision"
                            ));
                        }
                    }
                }
            }
        }
        let live = query_rows(
            conn,
            &format!(
                "SELECT {BLOCK_COLUMNS} FROM blocks WHERE doc_id = ?1 AND deleted_commit IS NULL"
            ),
            &[&d.doc_id],
        );
        let live_ids: HashSet<&str> = live.iter().map(|r| str_of(r, "block_id")).collect();
        let mut children: BTreeMap<Option<String>, Vec<&Json>> = BTreeMap::new();
        for r in &live {
            children
                .entry(r["parent_block"].as_str().map(str::to_owned))
                .or_default()
                .push(r);
        }
        for list in children.values_mut() {
            list.sort_by(|a, b| {
                str_of(a, "order_key")
                    .as_bytes()
                    .cmp(str_of(b, "order_key").as_bytes())
            });
        }
        for parent in children.keys().flatten() {
            if !live_ids.contains(parent.as_str()) {
                problems.push(format!(
                    "I3: {at} live rows name a parent {parent} that is not live"
                ));
            }
        }
        #[allow(clippy::too_many_arguments)]
        fn compare(
            tree_hex: Option<&str>,
            parent: Option<&Json>,
            depth: i64,
            ancestor_path: &str,
            at: &str,
            children: &BTreeMap<Option<String>, Vec<&Json>>,
            trees: &HashMap<String, Vec<TreeEntry>>,
            problems: &mut Vec<String>,
        ) {
            let parent_id = parent.map(|p| str_of(p, "block_id").to_owned());
            let rows = children.get(&parent_id).map_or(&[][..], Vec::as_slice);
            let empty = Vec::new();
            let entries = tree_hex.map_or(&empty, |h| trees.get(h).unwrap_or(&empty));
            let where_ = match &parent_id {
                Some(p) => format!("{at} under {p}"),
                None => format!("{at} top level"),
            };
            if rows.len() != entries.len() {
                problems.push(format!(
                    "I3: {where_}: {} live rows vs {} tree entries",
                    rows.len(),
                    entries.len()
                ));
                return;
            }
            for (i, (r, e)) in rows.iter().zip(entries).enumerate() {
                if str_of(r, "block_id") != e.block_id {
                    problems.push(format!(
                        "I3: {where_}[{i}]: block {} vs tree entry {}",
                        str_of(r, "block_id"),
                        e.block_id
                    ));
                }
                if str_of(r, "type") != e.kind {
                    problems.push(format!(
                        "I3: {where_}[{i}]: type {} vs {}",
                        str_of(r, "type"),
                        e.kind
                    ));
                }
                if str_of(r, "raw_hash") != e.raw_hash_hex {
                    problems.push(format!(
                        "I3: {where_}[{i}]: raw_hash differs from the tree entry"
                    ));
                }
                if r["trivia_hash"].as_str() != e.trivia_hash_hex.as_deref() {
                    problems.push(format!(
                        "I3: {where_}[{i}]: trivia_hash differs from the tree entry"
                    ));
                }
                if int_of(r, "ordinal") != i as i64 {
                    problems.push(format!(
                        "I3: {where_}[{i}]: ordinal {} (order_key order says {i})",
                        int_of(r, "ordinal")
                    ));
                }
                if int_of(r, "depth") != depth {
                    problems.push(format!(
                        "I3: {where_}[{i}]: depth {} != {depth}",
                        int_of(r, "depth")
                    ));
                }
                if str_of(r, "ancestor_path") != ancestor_path {
                    problems.push(format!(
                        "I3: {where_}[{i}]: ancestor_path {} != {ancestor_path}",
                        str_of(r, "ancestor_path")
                    ));
                }
                if hex(&sha256(str_of(r, "text").as_bytes())) != str_of(r, "norm_hash") {
                    problems.push(format!("I3: {where_}[{i}]: norm_hash != sha256(text)"));
                }
                let attrs: Json = serde_json::from_str(str_of(r, "attrs")).unwrap_or(Json::Null);
                if let Some(diff) = deep_eq_tol(&attrs, &e.attrs, "attrs", 0.0) {
                    problems.push(format!(
                        "I3: {where_}[{i}]: attrs differ from the tree entry ({diff})"
                    ));
                }
                compare(
                    e.child_tree_hash_hex.as_deref(),
                    Some(r),
                    depth + 1,
                    &format!("{ancestor_path}{}/", str_of(r, "block_id")),
                    at,
                    children,
                    trees,
                    problems,
                );
            }
        }
        compare(
            Some(&rev.root_tree),
            None,
            0,
            "/",
            &at,
            &children,
            &trees,
            &mut problems,
        );
    }

    // I4
    for (i, (commit_id, seq, _)) in commits.iter().enumerate() {
        if *seq != i as i64 + 1 {
            problems.push(format!(
                "I4: commit {commit_id} has seq {seq} at position {} in (ts, seq) order",
                i + 1
            ));
        }
    }
    for d in &docs {
        let mut revs: Vec<&Rev> = revisions.iter().filter(|r| r.doc_id == d.doc_id).collect();
        revs.sort_by_key(|r| r.seq);
        for (i, r) in revs.iter().enumerate() {
            if r.seq != i as i64 + 1 {
                problems.push(format!(
                    "I4: revision {} of {} has seq {}, expected {}",
                    r.rev_id,
                    d.doc_id,
                    r.seq,
                    i + 1
                ));
            }
        }
        match revs.last() {
            Some(last) if d.current_rev.as_deref() != Some(last.rev_id.as_str()) => {
                problems.push(format!(
                    "I4: doc {} current_rev {:?} is not its greatest-seq revision",
                    d.doc_id, d.current_rev
                ));
            }
            None if d.current_rev.is_some() => {
                problems.push(format!(
                    "I4: doc {} has current_rev but no revisions",
                    d.doc_id
                ));
            }
            _ => {}
        }
    }

    // I5
    let mut marked_trees: HashSet<String> = HashSet::new();
    let mut marked_blobs: HashSet<String> = HashSet::new();
    let mut stack: Vec<String> = revisions.iter().map(|r| r.root_tree.clone()).collect();
    for r in &revisions {
        if let Some(fm) = &r.frontmatter_blob {
            marked_blobs.insert(fm.clone());
        }
    }
    while let Some(h) = stack.pop() {
        if !marked_trees.insert(h.clone()) {
            continue;
        }
        for e in trees.get(&h).map_or(&[][..], Vec::as_slice) {
            marked_blobs.insert(e.raw_hash_hex.clone());
            if let Some(t) = &e.trivia_hash_hex {
                marked_blobs.insert(t.clone());
            }
            if let Some(c) = &e.child_tree_hash_hex {
                stack.push(c.clone());
            }
        }
    }
    for h in &tree_hashes {
        if !marked_trees.contains(h) {
            problems.push(format!(
                "I5: tree_node {h} is unreachable from every revision"
            ));
        }
    }
    for h in &blob_hashes {
        if !marked_blobs.contains(h) {
            problems.push(format!("I5: blob {h} is unreachable from every revision"));
        }
    }
    if let Ok(dry) = store.gc_dry_run() {
        if dry.blobs_swept != 0 || dry.tree_nodes_swept != 0 {
            problems.push(format!(
                "I5: the implementation's GC would sweep {} blobs and {} tree nodes",
                dry.blobs_swept, dry.tree_nodes_swept
            ));
        }
    }

    // I6
    let live_doc_of = |block_id: &str| -> Option<String> {
        conn.query_row(
            "SELECT doc_id FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
            params![block_id],
            |r| r.get(0),
        )
        .optional()
        .expect("query runs")
    };
    let pool: Vec<(String, String, String)> = all_rows(
        conn,
        "SELECT block_id, deleted_commit, expires_ts FROM resurrection_pool WHERE repo_id = ?1",
        &[&repo_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    );
    for (block_id, deleted_commit, expires_ts) in &pool {
        match commit_by_id.get(deleted_commit.as_str()) {
            None => problems.push(format!(
                "I6: pool row {block_id} names a missing commit {deleted_commit}"
            )),
            Some((_, _, ts)) => {
                let want = omgbase_store::time::pool_expiry(ts).unwrap_or_default();
                if *expires_ts != want {
                    problems.push(format!(
                        "I6: pool row {block_id} expires_ts {expires_ts} != {ts} + 30 days"
                    ));
                }
            }
        }
        if live_doc_of(block_id).is_some() {
            problems.push(format!("I6: pool row {block_id} has a live blocks row"));
        }
    }

    // I7
    let dispositions: Vec<(String, String, String)> = all_rows(
        conn,
        "SELECT x.commit_id, x.block_id, x.kind FROM dispositions x JOIN commits c ON c.commit_id = x.commit_id WHERE c.repo_id = ?1",
        &[&repo_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    );
    for (commit_id, block_id, kind) in &dispositions {
        if !commit_by_id.contains_key(commit_id.as_str()) {
            problems.push(format!(
                "I7: disposition {block_id}/{kind} names a missing commit {commit_id}"
            ));
        }
    }
    for d in &docs {
        let (Some(current_rev), None) = (&d.current_rev, &d.deleted_commit) else {
            continue;
        };
        let Some(rev) = rev_by_id.get(current_rev.as_str()) else {
            continue;
        };
        for (commit_id, block_id, kind) in &dispositions {
            if *commit_id != rev.commit_id || block_id == "DOC" {
                continue;
            }
            let row = live_doc_of(block_id);
            let gone = kind == "deleted" || kind == "merged_into";
            if gone && row.as_deref() == Some(d.doc_id.as_str()) {
                problems.push(format!(
                    "I7: {kind} block {block_id} of {commit_id} is still live in {}",
                    d.doc_id
                ));
            }
            if !gone && row.as_deref() != Some(d.doc_id.as_str()) {
                problems.push(format!(
                    "I7: {kind} block {block_id} of {commit_id} is not live in {}",
                    d.doc_id
                ));
            }
        }
    }

    // I8
    for d in &docs {
        if d.deleted_commit.is_some() {
            continue;
        }
        let tops: Vec<(String, i64, String, Option<i64>)> = all_rows(
            conn,
            "SELECT block_id, ordinal, type, json_extract(attrs, '$.level') FROM blocks WHERE doc_id = ?1 AND parent_block IS NULL AND deleted_commit IS NULL ORDER BY ordinal",
            &[&d.doc_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        );
        let max_ordinal = tops.last().map_or(-1, |t| t.1);
        let headings: Vec<&(String, i64, String, Option<i64>)> =
            tops.iter().filter(|t| t.2 == "heading").collect();
        let want: Vec<Json> = headings
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let level = h.3.unwrap_or(1);
                let last = headings[i + 1..]
                    .iter()
                    .find(|n| n.3.unwrap_or(1) <= level)
                    .map_or(max_ordinal, |n| n.1 - 1);
                json!({ "heading_block": h.0, "doc_id": d.doc_id, "level": level, "first_ordinal": h.1, "last_ordinal": last })
            })
            .collect();
        let have = query_rows(
            conn,
            "SELECT heading_block, doc_id, level, first_ordinal, last_ordinal FROM sections WHERE doc_id = ?1 ORDER BY first_ordinal",
            &[&d.doc_id],
        );
        if let Some(diff) = deep_eq_tol(&Json::Array(have), &Json::Array(want), "sections", 0.0) {
            problems.push(format!(
                "I8: sections of {} differ from a rebuild ({diff})",
                d.doc_id
            ));
        }
    }
    let bc_have = query_rows(
        conn,
        "SELECT block_id, commit_id, kind FROM block_changes ORDER BY block_id, commit_id, kind",
        &[],
    );
    let bc_want = query_rows(
        conn,
        "SELECT DISTINCT block_id, commit_id, kind FROM dispositions ORDER BY block_id, commit_id, kind",
        &[],
    );
    if let Some(diff) = deep_eq_tol(
        &Json::Array(bc_have),
        &Json::Array(bc_want),
        "block_changes",
        0.0,
    ) {
        problems.push(format!(
            "I8: block_changes differ from a rebuild out of dispositions ({diff})"
        ));
    }
    problems
}

// ---- comparison ----------------------------------------------------------------------

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
    const MAX: usize = 600;
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
        return Err(clip(format!("invariants: {}", ev.problems.join("; "))));
    }
    match deep_eq_tol(&ev.actual, &c.case["expect"], "expect", EPS) {
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
    std::env::var("MUTATE_SPEC_UPDATE").is_ok_and(|v| !v.is_empty() && v != "0")
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
        "cases that pass but are not listed in spec-passing.txt — add them (or run MUTATE_SPEC_UPDATE=1 cargo test -p omgbase-mutate --test spec)",
        &unlisted_passing,
    );
    report("stale allowlist entries", &stale);
    if passing == all_ids {
        eprintln!(
            "spec: every case passes — delete tests/spec-passing.txt (or run with MUTATE_SPEC_UPDATE=1)"
        );
    }
    assert!(
        regressions.is_empty() && unlisted_passing.is_empty() && stale.is_empty(),
        "spec allowlist out of date: {} regression(s), {} unlisted passing, {} stale — see the report above (stderr); \
         promote with `MUTATE_SPEC_UPDATE=1 cargo test -p omgbase-mutate --test spec`",
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

/// `spec/mutate/VERSION` is the version this crate implements.
#[test]
fn version_agrees_with_the_spec() {
    let version_file = Path::new(SPEC_DIR).join("VERSION");
    if !version_file.is_file() {
        eprintln!("spec: {} not present; skipping", version_file.display());
        return;
    }
    let version = fs::read_to_string(version_file).expect("VERSION");
    assert_eq!(omgbase_mutate::SPEC_VERSION, version.trim());
}
