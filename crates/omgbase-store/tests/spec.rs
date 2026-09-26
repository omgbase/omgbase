//! The store spec conformance runner: executes every fixture under
//! `spec/store/cases` against this implementation. The fixture contract, the
//! §8 invariants and the allowlist mechanism are defined in
//! `spec/store/README.md` §8–§9; the reference runner this mirrors is
//! `packages/core/corpus/store/spec.test.ts` (+ `fixture.ts`).
//!
//! Allowlist (`tests/spec-passing.txt`, one `<file-stem>::<name>` per line):
//! while the port is incomplete it names the cases that must pass. A listed
//! case that fails, an unlisted case that passes, or a listed id that no
//! longer exists all fail the build. If the file is absent, every case must
//! pass. Promote cases by rewriting the list to the currently passing set:
//!
//! ```text
//! STORE_SPEC_UPDATE=1 cargo test -p omgbase-store --test spec
//! ```

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use omgbase_format::hash::{hex, sha256};
use omgbase_reconcile::Config;
use omgbase_store::tree::parse_tree_entries;
use omgbase_store::{
    BatchItem, BatchOutcome, SCHEMA_SQL, SCHEMA_VERSION, SequentialMinter, Store, TreeEntry,
};
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map as JsonMap, Value as Json, json};

const SPEC_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/store");
const CASES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/store/cases");
const PASSING_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/spec-passing.txt");
/// A wrong `CASES_DIR` must not pass by finding some other, smaller directory.
const MIN_CASE_FILES: usize = 3;
const MAX_REPORT_LINES: usize = 400;
/// Nothing projected is floating point except `confidence`; compare within this.
const EPS: f64 = 1e-9;
/// The repo every observation case runs in (§9.4 "Inputs").
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
const PROJECTED_TABLES: [&str; 10] = [
    "docs",
    "commits",
    "revisions",
    "blobs",
    "tree_nodes",
    "blocks",
    "dispositions",
    "block_changes",
    "resurrection_pool",
    "sections",
];

const PASSING_HEADER: &str = "\
# Store spec cases (spec/store/cases) that the Rust port must pass, one
# `<file-stem>::<name>` id per line, sorted. Maintained by tests/spec.rs:
# a listed case failing fails the build; an unlisted case passing also fails
# the build (add it here). Regenerate from the currently passing set with
#
#     STORE_SPEC_UPDATE=1 cargo test -p omgbase-store --test spec
#
# When every case passes, delete this file (the runner then requires all).
";

// ---- fixture shape -----------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Schema,
    Migration,
    Observe,
}

/// §9.1: the suite kinds, told apart by the file stem.
fn suite_kind(stem: &str) -> Kind {
    match stem {
        "schema" => Kind::Schema,
        "migrations" => Kind::Migration,
        _ => Kind::Observe,
    }
}

fn case_keys(kind: Kind) -> &'static [&'static str] {
    match kind {
        Kind::Schema => &["name", "notes", "expect"],
        Kind::Migration => &["name", "notes", "setup", "user_version", "rows", "expect"],
        Kind::Observe => &["name", "notes", "config", "steps", "expect"],
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

/// §2.4: `YYYY-MM-DDTHH:MM:SS.fffZ`.
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
                "{here}: `ts` must be RFC 3339 UTC with three fractional digits and Z (§2.4)"
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

fn validate_projection(at: &str, e: &Json, step_count: i64, problems: &mut Vec<String>) {
    let Some(obj) = e.as_object() else {
        problems.push(format!("{at}: must be an object"));
        return;
    };
    let mut want: Vec<&str> = vec!["steps"];
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
    for k in &want {
        if !obj[*k].is_array() {
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

fn validate_migration_expect(at: &str, e: &Json, rows: &[String], problems: &mut Vec<String>) {
    let Some(obj) = e.as_object() else {
        problems.push(format!("{at}: must be an object"));
        return;
    };
    if obj.contains_key("error") {
        if obj.len() != 1 || !obj["error"].is_string() {
            problems.push(format!("{at}: a refusal is exactly {{ error: string }}"));
        }
        return;
    }
    let extra = unknown_keys(obj, &["user_version", "tables", "rows"]);
    if !extra.is_empty() {
        problems.push(format!("{at}: unknown keys {}", extra.join(", ")));
    }
    if !obj.get("user_version").is_some_and(Json::is_number) {
        problems.push(format!("{at}.user_version must be a number"));
    }
    if !obj.get("tables").is_some_and(Json::is_object) {
        problems.push(format!("{at}.tables must be an object"));
    }
    match obj.get("rows").and_then(Json::as_object) {
        Some(r) => {
            let have: BTreeSet<&str> = r.keys().map(String::as_str).collect();
            let want: BTreeSet<&str> = rows.iter().map(String::as_str).collect();
            if have != want {
                problems.push(format!(
                    "{at}.rows: tables {{{}}} vs case rows {{{}}}",
                    have.into_iter().collect::<Vec<_>>().join(","),
                    want.into_iter().collect::<Vec<_>>().join(",")
                ));
            }
        }
        None => problems.push(format!("{at}.rows must be an object")),
    }
}

fn validate_fingerprint(at: &str, e: &Json, problems: &mut Vec<String>) {
    let Some(obj) = e.as_object() else {
        problems.push(format!("{at}: must be an object"));
        return;
    };
    let extra = unknown_keys(obj, &["user_version", "tables", "indexes"]);
    if !extra.is_empty() {
        problems.push(format!("{at}: unknown keys {}", extra.join(", ")));
    }
    if !obj.get("user_version").is_some_and(Json::is_number) {
        problems.push(format!("{at}.user_version must be a number"));
    }
    if !obj.get("tables").is_some_and(Json::is_object) {
        problems.push(format!("{at}.tables must be an object"));
    }
    if !obj.get("indexes").is_some_and(Json::is_object) {
        problems.push(format!("{at}.indexes must be an object"));
    }
}

/// Validate one fixture file as the reference's `validateFixtureFile` does.
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
    if kind == Kind::Schema && cases.len() != 1 {
        problems.push(format!("{file}: the schema suite has exactly one case"));
    }

    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(cases.len());
    for (i, c) in cases.iter().enumerate() {
        let at = format!("{file}#{i}");
        let Some(cobj) = c.as_object() else {
            problems.push(format!("{at}: not an object"));
            continue;
        };
        let unknown = unknown_keys(cobj, case_keys(kind));
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
        let mut step_count = -1;
        let mut row_tables: Vec<String> = Vec::new();
        match kind {
            Kind::Migration => {
                if !cobj
                    .get("setup")
                    .and_then(Json::as_array)
                    .is_some_and(|s| s.iter().all(Json::is_string))
                {
                    problems.push(format!("{at}: `setup` must be an array of SQL strings"));
                }
                if !cobj
                    .get("user_version")
                    .is_some_and(|v| v.as_u64().is_some())
                {
                    problems.push(format!(
                        "{at}: `user_version` must be a non-negative integer"
                    ));
                }
                match cobj.get("rows").and_then(Json::as_array) {
                    Some(r) if r.iter().all(Json::is_string) => {
                        row_tables = r
                            .iter()
                            .filter_map(Json::as_str)
                            .map(str::to_owned)
                            .collect();
                    }
                    _ => problems.push(format!("{at}: `rows` must be an array of table names")),
                }
            }
            Kind::Observe => {
                if let Some(config) = cobj.get("config") {
                    validate_config(&at, config, &mut problems);
                }
                step_count = validate_steps(&at, cobj.get("steps"), &mut problems);
            }
            Kind::Schema => {}
        }
        let Some(expect) = cobj.get("expect") else {
            problems.push(format!("{at}: missing `expect` (run STORE_SPEC_UPDATE=1)"));
            continue;
        };
        let e_at = format!("{at}.expect");
        match kind {
            Kind::Schema => validate_fingerprint(&e_at, expect, &mut problems),
            Kind::Migration => validate_migration_expect(&e_at, expect, &row_tables, &mut problems),
            Kind::Observe => validate_projection(&e_at, expect, step_count, &mut problems),
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
/// in the published package: built on its own, every conformance test skips.
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

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn table_names(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .expect("valid SQL");
    stmt.query_map([], |r| r.get(0))
        .expect("query runs")
        .map(|r| r.expect("row reads"))
        .collect()
}

fn column_names(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", quote(table)))
        .expect("valid SQL");
    stmt.query_map([], |r| r.get::<_, String>(1))
        .expect("query runs")
        .map(|r| r.expect("row reads"))
        .collect()
}

fn user_version(conn: &Connection) -> i64 {
    conn.pragma_query_value(None, "user_version", |r| r.get(0))
        .expect("user_version")
}

// ---- §9.2 schema fingerprint --------------------------------------------------------

fn schema_fingerprint(conn: &Connection) -> Json {
    let mut tables = JsonMap::new();
    let mut indexes: BTreeMap<String, Json> = BTreeMap::new();
    for table in table_names(conn) {
        let columns: Vec<Json> =
            query_rows(conn, &format!("PRAGMA table_info({})", quote(&table)), &[])
                .into_iter()
                .map(|c| {
                    json!({
                        "cid": c["cid"], "name": c["name"], "type": c["type"],
                        "notnull": c["notnull"], "dflt_value": c["dflt_value"], "pk": c["pk"],
                    })
                })
                .collect();
        let fks: Vec<Json> = query_rows(
            conn,
            &format!("PRAGMA foreign_key_list({})", quote(&table)),
            &[],
        )
        .into_iter()
        .map(|f| json!({ "from": f["from"], "table": f["table"], "to": f["to"] }))
        .collect();
        tables.insert(
            table.clone(),
            json!({ "columns": columns, "foreign_keys": fks }),
        );
        for ix in query_rows(conn, &format!("PRAGMA index_list({})", quote(&table)), &[]) {
            let name = ix["name"].as_str().expect("index name").to_owned();
            let mut cols = query_rows(conn, &format!("PRAGMA index_info({})", quote(&name)), &[]);
            cols.sort_by_key(|c| c["seqno"].as_i64().unwrap_or(0));
            let cols: Vec<Json> = cols
                .into_iter()
                .map(|c| match &c["name"] {
                    Json::Null => Json::String(String::new()),
                    other => other.clone(),
                })
                .collect();
            indexes.insert(
                name,
                json!({
                    "table": table, "unique": ix["unique"], "origin": ix["origin"],
                    "partial": ix["partial"], "columns": cols,
                }),
            );
        }
    }
    json!({
        "user_version": user_version(conn),
        "tables": Json::Object(tables),
        "indexes": indexes.into_iter().collect::<JsonMap<_, _>>(),
    })
}

fn run_schema_case() -> Json {
    let store = Store::open_in_memory().expect("fresh store opens");
    schema_fingerprint(store.conn())
}

// ---- §9.3 migrations ----------------------------------------------------------------

fn run_migration_case(c: &Json) -> Json {
    let conn = Connection::open_in_memory().expect("in-memory connection");
    for stmt in c["setup"].as_array().expect("setup array") {
        conn.execute_batch(stmt.as_str().expect("SQL string"))
            .unwrap_or_else(|e| panic!("setup statement failed: {e}"));
    }
    let uv = c["user_version"].as_i64().expect("user_version");
    conn.pragma_update(None, "user_version", uv)
        .expect("user_version set");
    let store = match Store::from_connection(conn, Box::new(SequentialMinter::new())) {
        Ok(s) => s,
        Err(e) => return json!({ "error": e.to_string() }),
    };
    let conn = store.conn();
    let mut tables = JsonMap::new();
    for t in table_names(conn) {
        tables.insert(t.clone(), json!(column_names(conn, &t)));
    }
    let mut rows = JsonMap::new();
    for t in c["rows"].as_array().expect("rows array") {
        let t = t.as_str().expect("table name");
        rows.insert(
            t.to_owned(),
            Json::Array(query_rows(
                conn,
                &format!("SELECT * FROM {} ORDER BY rowid", quote(t)),
                &[],
            )),
        );
    }
    json!({ "user_version": user_version(conn), "tables": Json::Object(tables), "rows": Json::Object(rows) })
}

// ---- §9.4 observation scripts ---------------------------------------------------------

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

struct ObserveEvaluation {
    expect: Json,
    /// §8 invariant violations, prefixed with the step they were found after.
    problems: Vec<String>,
}

fn run_observe_case(c: &Json) -> Result<ObserveEvaluation, String> {
    let config = config_from(c.get("config"))?;
    let mut store = Store::open_in_memory_with_minter(Box::new(SequentialMinter::new()))
        .map_err(|e| e.to_string())?;
    let repo_id = store
        .create_repo(FIXTURE_REPO_SLUG)
        .map_err(|e| e.to_string())?;
    let mut last_source: HashMap<String, String> = HashMap::new();
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
            for it in &items {
                match &it.source {
                    None => {
                        last_source.remove(&it.path);
                    }
                    Some(s) => {
                        last_source.insert(it.path.clone(), s.clone());
                    }
                }
            }
            steps.push(Json::Array(outcomes.iter().map(outcome_json).collect()));
            for p in check_invariants(&store, &repo_id, &last_source) {
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
    for p in check_invariants(&store, &repo_id, &last_source) {
        problems.push(format!("at end: {p}"));
    }
    let mut expect = JsonMap::new();
    expect.insert("steps".to_owned(), Json::Array(steps));
    for (k, v) in project_store(store.conn(), &repo_id) {
        expect.insert(k, v);
    }
    Ok(ObserveEvaluation {
        expect: Json::Object(expect),
        problems,
    })
}

// ---- projection (§9.4 "Expect") -----------------------------------------------------------

const BLOCK_COLUMNS: &str = "block_id, doc_id, parent_block, order_key, ordinal, depth, ancestor_path, type, attrs, text, raw_hash, norm_hash, trivia_hash, created_commit, deleted_commit";

/// A doc's `blocks` rows in pre-order (children by `parent_block`, `ordinal`
/// order); an orphaned parent counts as top level.
fn doc_blocks_preorder(conn: &Connection, doc_id: &str, live_only: bool) -> Vec<Json> {
    let rows = query_rows(
        conn,
        &format!(
            "SELECT {BLOCK_COLUMNS} FROM blocks WHERE doc_id = ?1 {} ORDER BY ordinal, block_id",
            if live_only {
                "AND deleted_commit IS NULL"
            } else {
                ""
            }
        ),
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

/// The §9.4 projection of one repo's durable + pinned derived tables
/// (`repo_id` omitted), in fixture order.
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

    let mut blobs: Vec<Json> = {
        let mut stmt = conn
            .prepare("SELECT hash, size, bytes FROM blobs")
            .expect("valid SQL");
        stmt.query_map([], |r| {
            let hash: Vec<u8> = r.get(0)?;
            let size: i64 = r.get(1)?;
            let bytes: Vec<u8> = r.get(2)?;
            Ok(json!({ "hash": hex(&hash), "size": size, "bytes": String::from_utf8_lossy(&bytes) }))
        })
        .expect("query runs")
        .map(|r| r.expect("row reads"))
        .collect()
    };
    blobs.sort_by(|a, b| str_of(a, "hash").cmp(str_of(b, "hash")));
    let mut tree_nodes = query_rows(conn, "SELECT hash, entries FROM tree_nodes", &[]);
    tree_nodes.sort_by(|a, b| str_of(a, "hash").cmp(str_of(b, "hash")));

    let mut blocks = Vec::new();
    for doc_id in &doc_ids {
        for r in doc_blocks_preorder(conn, doc_id, false) {
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
    let mut block_changes = query_rows(
        conn,
        "SELECT bc.block_id, bc.commit_id, bc.kind FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE c.repo_id = ?1",
        &[&repo_id],
    );
    block_changes.sort_by(by_commit_block_kind);

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
    let mut sections = query_rows(
        conn,
        "SELECT s.doc_id, s.heading_block, s.level, s.first_ordinal, s.last_ordinal FROM sections s JOIN docs d ON d.doc_id = s.doc_id WHERE d.repo_id = ?1",
        &[&repo_id],
    );
    sections.sort_by(|a, b| {
        str_of(a, "doc_id")
            .as_bytes()
            .cmp(str_of(b, "doc_id").as_bytes())
            .then(int_of(a, "first_ordinal").cmp(&int_of(b, "first_ordinal")))
    });

    vec![
        ("docs".to_owned(), Json::Array(docs)),
        ("commits".to_owned(), Json::Array(commits)),
        ("revisions".to_owned(), Json::Array(revisions)),
        ("blobs".to_owned(), Json::Array(blobs)),
        ("tree_nodes".to_owned(), Json::Array(tree_nodes)),
        ("blocks".to_owned(), Json::Array(blocks)),
        ("dispositions".to_owned(), Json::Array(dispositions)),
        ("block_changes".to_owned(), Json::Array(block_changes)),
        ("resurrection_pool".to_owned(), Json::Array(pool)),
        ("sections".to_owned(), Json::Array(sections)),
    ]
}

// ---- invariants (§8) ---------------------------------------------------------------------

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

/// README §8 I1–I8. `last_source` is the last observed source per live path.
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

    // ---- I2 hash integrity ------------------------------------------------------------
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
                    "I2: tree_node {h} entry {} raw_hash {} not in blobs",
                    e.block_id, e.raw_hash_hex
                ));
            }
            if let Some(t) = &e.trivia_hash_hex {
                if !blob_hashes.contains(t) {
                    problems.push(format!(
                        "I2: tree_node {h} entry {} trivia_hash {t} not in blobs",
                        e.block_id
                    ));
                }
            }
            if let Some(c) = &e.child_tree_hash_hex {
                if !tree_hashes.contains(c) {
                    problems.push(format!(
                        "I2: tree_node {h} entry {} child tree {c} not in tree_nodes",
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

    // ---- I1 convergence, I3 blocks mirror the current revision -----------------------------
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

        // I3: live rows as a tree vs the revision's Merkle tree.
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

    // ---- I4 dense sequences ------------------------------------------------------------
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

    // ---- I5 nothing to collect ------------------------------------------------------------
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

    // ---- I6 pool -------------------------------------------------------------------------
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

    // ---- I7 dispositions ------------------------------------------------------------------
    // Every disposition names an existing commit. For each live doc's CURRENT
    // commit, a disposition on a block that survives the commit (every kind
    // but `deleted` / `merged_into`) names a live row of that doc, and a
    // `deleted` / `merged_into` one names no live row of that doc.
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

    // ---- I8 rebuild equivalence -----------------------------------------------------------
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

fn check(c: &SpecCase) -> Result<(), String> {
    let actual = match c.kind {
        Kind::Schema => run_schema_case(),
        Kind::Migration => run_migration_case(&c.case),
        Kind::Observe => {
            let ev = run_observe_case(&c.case)?;
            if !ev.problems.is_empty() {
                return Err(clip(format!("invariants: {}", ev.problems.join("; "))));
            }
            ev.expect
        }
    };
    match deep_eq_tol(&actual, &c.case["expect"], "expect", EPS) {
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
    std::env::var("STORE_SPEC_UPDATE").is_ok_and(|v| !v.is_empty() && v != "0")
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
        "cases that pass but are not listed in spec-passing.txt — add them (or run STORE_SPEC_UPDATE=1 cargo test -p omgbase-store --test spec)",
        &unlisted_passing,
    );
    report("stale allowlist entries", &stale);
    if passing == all_ids {
        eprintln!(
            "spec: every case passes — delete tests/spec-passing.txt (or run with STORE_SPEC_UPDATE=1)"
        );
    }
    assert!(
        regressions.is_empty() && unlisted_passing.is_empty() && stale.is_empty(),
        "spec allowlist out of date: {} regression(s), {} unlisted passing, {} stale — see the report above (stderr); \
         promote with `STORE_SPEC_UPDATE=1 cargo test -p omgbase-store --test spec`",
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

/// §3.3: the embedded DDL is `spec/store/schema.sql`, byte for byte; the
/// spec `VERSION`'s major is the schema version.
#[test]
fn schema_sql_and_version_agree_with_the_spec() {
    if !spec_available() {
        return;
    }
    let sql = fs::read_to_string(Path::new(SPEC_DIR).join("schema.sql")).expect("schema.sql");
    assert_eq!(
        sql, SCHEMA_SQL,
        "spec/store/schema.sql != the embedded schema.sql"
    );
    let version = fs::read_to_string(Path::new(SPEC_DIR).join("VERSION")).expect("VERSION");
    let major: i64 = version
        .trim()
        .split('.')
        .next()
        .and_then(|m| m.parse().ok())
        .expect("VERSION is <major>.<minor>");
    assert_eq!(major, SCHEMA_VERSION);
    assert_eq!(omgbase_store::SPEC_VERSION, version.trim());
}

/// The schema fingerprint carries the schema version.
#[test]
fn schema_fingerprint_carries_the_schema_version() {
    if !spec_available() {
        return;
    }
    let loaded = load();
    let schema = loaded
        .files
        .iter()
        .find(|f| f.stem == "schema")
        .expect("schema.json present");
    assert_eq!(
        schema.cases[0].case["expect"]["user_version"],
        json!(SCHEMA_VERSION)
    );
}

/// The invariants hold for every observation case's resulting database,
/// whatever the fixture expects — a failing comparison must never hide a
/// broken database.
#[test]
fn every_observe_case_satisfies_the_invariants() {
    if !spec_available() {
        return;
    }
    let loaded = load();
    let mut problems = Vec::new();
    let mut checked = 0usize;
    for f in &loaded.files {
        for c in f.cases.iter().filter(|c| c.kind == Kind::Observe) {
            match run_observe_case(&c.case) {
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
