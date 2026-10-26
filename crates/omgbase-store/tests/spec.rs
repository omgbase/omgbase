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
use std::rc::Rc;

use omgbase_format::hash::{hex, sha256};
use omgbase_reconcile::Config;
use omgbase_store::delta::{
    Form, Node, ResolvedList, ResolvedTree, TreeResolver, encode_body_delta,
    encode_frontmatter_delta, entry_text, explicit_entries, full_node_text, is_checkpoint_seq,
    parse_frontmatter_blob, parse_node_text,
};
use omgbase_store::{
    ARCHIVE_SQL, ARCHIVED_COMMITS_SQL, BatchItem, BatchOutcome, Composition, ExportOptions,
    HISTORY_SQL, IdMinter, RepeatingMinter, RetentionOptions, SCHEMA_SQL, SCHEMA_VERSION,
    SEMANTIC_SQL, SequentialMinter, Store, TreeEntry,
};
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map as JsonMap, Value as Json, json};

use omgbase_store::manifest::{history_bundle_present, read_capability};

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
const PROJECTED_TABLES: [&str; 15] = [
    "docs",
    "commits",
    "feed",
    "feed_entries",
    "revisions",
    "blobs",
    "tree_nodes",
    "blocks",
    "dispositions",
    "block_changes",
    "resurrection_pool",
    "id_claims",
    "sections",
    "pending_materializations",
    "archives",
];
/// README §9.4 (15.0): the retention step kinds.
const HISTORY_STEP_KINDS: [&str; 5] = [
    "history_plan",
    "history_export",
    "history_attach",
    "history_detach",
    "read_at",
];
/// README §9.4 (15.0): `<dest>` stands for the case's archive directory in a projected path.
const DEST_TOKEN: &str = "<dest>";

/// README §9.4 (17.1, Phase 4a): the lifecycle steps and the fault device.
const LIFECYCLE_STEP_KINDS: [&str; 4] = [
    "history_enable",
    "history_disable",
    "history_purge",
    "recorder_fault",
];

/// README §9.4 (17.1): the instant every fixture repository is born — the
/// runner creates it under this clock, before any authored `ts`, so the
/// manifest's coverage (`[{ from: <birth>, to: null }]`) covers the whole
/// script and the history invariants apply to every captured document; it is
/// also what `sync_status.capabilities.coverage_from` reads on the wire
/// (`spec/surface` §6).
const FIXTURE_BIRTH: &str = "2000-01-01T00:00:00.000Z";

/// README §9.6: the tables whose projection the core-only run compares.
const CORE_PROJECTED_TABLES: [&str; 8] = [
    "docs",
    "feed",
    "feed_entries",
    "blocks",
    "resurrection_pool",
    "id_claims",
    "sections",
    "pending_materializations",
];

/// The fault's message, verbatim in the member's `error` (after `history capture of <path> failed: `).
const RECORDER_FAULT_REASON: &str = "recorder fault (fixture device)";
/// README §9.5 (17.0): an `edge_transitions` row as the recorder suite
/// carries it — every column but `repo_id`.
const EDGE_TRANSITION_FIELDS: [&str; 12] = [
    "edge_id",
    "src_doc",
    "src_block",
    "src_field",
    "predicate",
    "dst_kind",
    "dst_node",
    "anchor",
    "provenance",
    "via_node",
    "from_commit",
    "to_commit",
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
    /// README §9.5 (17.0): a recorder suite under `cases/history/` —
    /// `edge-transitions`, the same scripts projecting `edge_transitions` alone.
    Edges,
}

/// §9.1: the suite kinds, told apart by the file stem (the base name: a
/// recorder suite lives under `cases/history/`, §9.5).
fn suite_kind(stem: &str) -> Kind {
    match stem {
        "schema" => Kind::Schema,
        "migrations" => Kind::Migration,
        "edge-transitions" => Kind::Edges,
        _ => Kind::Observe,
    }
}

fn case_keys(kind: Kind) -> &'static [&'static str] {
    match kind {
        Kind::Schema => &["name", "notes", "expect"],
        Kind::Migration => &["name", "notes", "setup", "user_version", "rows", "expect"],
        Kind::Observe => &[
            "name",
            "notes",
            "config",
            "minter",
            "capabilities",
            "steps",
            "expect",
        ],
        Kind::Edges => &["name", "notes", "config", "steps", "expect"],
    }
}

/// The suite name of a case file: its base name without `.json`.
fn stem_of(file: &str) -> &str {
    let base = file.rsplit('/').next().unwrap_or(file);
    base.trim_end_matches(".json")
}

struct SpecCase {
    id: String,
    kind: Kind,
    /// The path relative to `cases/` (`cases/history/` is skipped wholesale by the core-only run, README §9.6).
    file: String,
    case: Json,
}

struct SpecFile {
    /// The path relative to `cases/` (`feed.json`, `history/edge-transitions.json`).
    file: String,
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
        if keys.len() != 1
            || !(["observe", "sweep", "gc", "exec", "remint_epoch"].contains(&keys[0].as_str())
                || HISTORY_STEP_KINDS.contains(&keys[0].as_str())
                || LIFECYCLE_STEP_KINDS.contains(&keys[0].as_str()))
        {
            problems.push(format!(
                "{here}: a step is exactly one of `observe` / `sweep` / `gc` / `exec` / `remint_epoch` / the retention steps / the lifecycle steps (got {})",
                keys.iter()
                    .map(|k| k.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            continue;
        }
        let body = &obj[keys[0]];
        if keys[0] == "gc" || keys[0] == "exec" {
            validate_gc_exec_body(&here, keys[0], body, problems);
            continue;
        }
        if HISTORY_STEP_KINDS.contains(&keys[0].as_str()) {
            validate_history_body(&here, keys[0], body, problems);
            continue;
        }
        if LIFECYCLE_STEP_KINDS.contains(&keys[0].as_str()) {
            validate_lifecycle_body(&here, keys[0], body, problems);
            continue;
        }
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
        if keys[0] == "sweep" || keys[0] == "remint_epoch" {
            if body.keys().any(|k| k != "ts") {
                problems.push(format!("{here}: {} takes only `ts`", keys[0]));
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
    if let Some(steps) = obj["steps"].as_array()
        && step_count >= 0
        && steps.len() as i64 != step_count
    {
        problems.push(format!(
            "{at}.steps: {} outcomes for {step_count} steps",
            steps.len()
        ));
    }
}

/// README §9.5 (17.0): `expect` is exactly `{ edge_transitions: [...] }`, each
/// row the twelve fields with their types.
fn validate_edge_transitions(at: &str, e: &Json, problems: &mut Vec<String>) {
    let rows = e
        .as_object()
        .filter(|o| o.len() == 1)
        .and_then(|o| o.get("edge_transitions"))
        .and_then(Json::as_array);
    let Some(rows) = rows else {
        problems.push(format!(
            "{at}: must be exactly {{ edge_transitions: [...] }}"
        ));
        return;
    };
    let mut want: Vec<&str> = EDGE_TRANSITION_FIELDS.to_vec();
    want.sort_unstable();
    for (i, r) in rows.iter().enumerate() {
        let here = format!("{at}.edge_transitions[{i}]");
        let Some(obj) = r.as_object() else {
            problems.push(format!("{here}: not an object"));
            continue;
        };
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        if keys != want {
            problems.push(format!(
                "{here}: a row has exactly the fields {} (got {})",
                EDGE_TRANSITION_FIELDS.join(", "),
                keys.join(", ")
            ));
            continue;
        }
        for k in [
            "edge_id",
            "src_doc",
            "predicate",
            "dst_kind",
            "dst_node",
            "provenance",
            "from_commit",
        ] {
            if !obj[k].is_string() {
                problems.push(format!("{here}: {k} must be a string"));
            }
        }
        for k in ["src_block", "src_field", "anchor", "via_node", "to_commit"] {
            if !(obj[k].is_null() || obj[k].is_string()) {
                problems.push(format!("{here}: {k} must be a string or null"));
            }
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
    let stem = stem_of(file);
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
            Kind::Observe | Kind::Edges => {
                if let Some(config) = cobj.get("config") {
                    validate_config(&at, config, &mut problems);
                }
                if kind == Kind::Observe
                    && let Some(caps) = cobj.get("capabilities")
                    && !caps.as_object().is_some_and(|o| {
                        o.len() == 1 && o.get("history").is_some_and(Json::is_boolean)
                    })
                {
                    problems.push(format!(
                        "{at}: `capabilities` is exactly {{ history: boolean }} (README §9.4, Phase 4a)"
                    ));
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
            Kind::Edges => validate_edge_transitions(&e_at, expect, &mut problems),
        }
        out.push(SpecCase {
            id: format!("{stem}::{name}"),
            kind,
            file: file.to_owned(),
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

/// `cases/*.json` and the recorder suites under `cases/history/*.json`
/// (README §9.1, §9.5), as paths relative to `cases/`, each group sorted.
fn case_file_names(dir: &Path) -> Vec<String> {
    let list = |sub: Option<&str>| -> Vec<String> {
        let d = sub.map_or_else(|| dir.to_path_buf(), |s| dir.join(s));
        let Ok(entries) = fs::read_dir(&d) else {
            if sub.is_none() {
                panic!("cannot read {}", d.display());
            }
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .map(|entry| {
                entry
                    .expect("readable directory entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name.ends_with(".json"))
            .map(|name| sub.map_or_else(|| name.clone(), |s| format!("{s}/{name}")))
            .collect();
        names.sort();
        names
    };
    let mut out = list(None);
    out.extend(list(Some("history")));
    out
}

fn load() -> Loaded {
    let dir = Path::new(CASES_DIR);
    let file_names = case_file_names(dir);
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
                file: name.clone(),
                stem: stem_of(name).to_owned(),
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
    // Under the composition `OMGBASE_CAPABILITIES` names (README §9.6 rule
    // (5): the core-only run's fresh database has no semantic bundle).
    let store = Store::open_in_memory_with_capabilities(
        Box::new(SequentialMinter::new()),
        omgbase_store::Capabilities::standard_from_env().expect("OMGBASE_CAPABILITIES"),
    )
    .expect("fresh store opens");
    schema_fingerprint(store.conn())
}

// ---- §9.3 migrations ----------------------------------------------------------------

/// README §9.3 (17.0, 3e-ii): the clock a migration case runs under — what
/// step 17 writes where it says "the migration's clock" (the manifest's
/// `updated_at`, a coverage start with no commit to anchor on).
const MIGRATION_CLOCK: &str = "2026-09-27T00:00:00.000Z";

fn run_migration_case(c: &Json) -> Json {
    let conn = Connection::open_in_memory().expect("in-memory connection");
    for stmt in c["setup"].as_array().expect("setup array") {
        conn.execute_batch(stmt.as_str().expect("SQL string"))
            .unwrap_or_else(|e| panic!("setup statement failed: {e}"));
    }
    let uv = c["user_version"].as_i64().expect("user_version");
    conn.pragma_update(None, "user_version", uv)
        .expect("user_version set");
    // Under the composition `OMGBASE_CAPABILITIES` names (README §9.6: the
    // `history` composition upgrades a 16.x database but executes no semantic
    // DDL — the bundle's tables are then stripped from BOTH sides).
    let store = match Store::from_connection_at(
        conn,
        Box::new(SequentialMinter::new()),
        omgbase_store::Capabilities::standard_from_env().expect("OMGBASE_CAPABILITIES"),
        MIGRATION_CLOCK,
    ) {
        Ok(s) => s,
        // A SQLite failure renders as SQLite's own message, as the reference's
        // does (`migrations::v14-to-v15-…` pins "no such table: block_changes").
        Err(omgbase_store::Error::Sqlite(e)) => return json!({ "error": e.to_string() }),
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
        // README §9.4 (Phase 4a): a member rolled back because its capture failed.
        BatchOutcome::Failed(f) => {
            json!({ "path": f.path, "failed": true, "doc": f.doc_id, "error": f.error })
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

/// The fixture minter a case names (§9.4, 13.5): the sequential one, or the
/// repeating one for `"minter": "repeat"` — installed before the repo is
/// created.
fn minter_of(c: &Json) -> Result<Box<dyn IdMinter>, String> {
    Ok(match c.get("minter") {
        None => Box::new(SequentialMinter::new()),
        Some(Json::String(k)) if k == "sequential" => Box::new(SequentialMinter::new()),
        Some(Json::String(k)) if k == "repeat" => Box::new(RepeatingMinter::new()),
        Some(other) => {
            return Err(format!(
                "minter: expected \"sequential\" or \"repeat\", got {other}"
            ));
        }
    })
}

/// A fixture store under the composition `OMGBASE_CAPABILITIES` names (README
/// §9.6: `core` runs every observation script as a core-only build) and the
/// case's repository under the fixture birth clock (README §9.4, 17.1) with
/// the capture the case's `capabilities` key asks for (`{ history: false }` →
/// born `disabled`; absent → on).
fn fixture_store(minter: Box<dyn IdMinter>, history: bool) -> Result<(Store, String), String> {
    let mut store = Store::open_in_memory_with_capabilities(
        minter,
        omgbase_store::Capabilities::standard_from_env().map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let repo_id = store
        .create_repo_with(FIXTURE_REPO_SLUG, FIXTURE_BIRTH, history)
        .map_err(|e| e.to_string())?;
    Ok((store, repo_id))
}

/// The case's `capabilities.history` (README §9.4): on unless `{ history: false }`.
fn case_history(c: &Json) -> bool {
    c.get("capabilities")
        .and_then(|caps| caps.get("history"))
        .and_then(Json::as_bool)
        .unwrap_or(true)
}

// ---- the composition ledger (README §9.6, Phase 5a) --------------------------------------
//
// `OMGBASE_CAPABILITIES` names one of the plan's four compositions — `core`,
// `history`, `semantic`, `full` (the default) — and this runner opens its stores
// through `Capabilities::standard_from_env()`, so the SAME scripts run on the
// composition named and the runner decides, per case, whether it is compared
// as recorded, compared through a MAPPING keyed on the module the composition
// lacks (the mapping lives here, never in a fixture), or SKIPPED because the
// case needs the absent module. One machine-readable line at the end —
// `[<suite> spec] composition=<name>: compared=<n> mapped=<n> skipped=<n>` —
// is what `pnpm conformance` (`scripts/conformance.mjs`) collects into the
// suite × composition matrix; the reference's `corpus/composition.ts`.

/// The composition this process runs under (`OMGBASE_CAPABILITIES`, default `full`).
fn composition() -> Composition {
    Composition::from_env().expect("OMGBASE_CAPABILITIES")
}

/// One runner's ledger: `compared` = cases compared exactly as recorded,
/// `mapped` = cases compared through a composition mapping (with a note of
/// what moved), `skipped` = cases not run because they need an absent module
/// (with the reason).
struct Ledger {
    suite: &'static str,
    composition: Composition,
    compared: Vec<String>,
    mapped: Vec<String>,
    skipped: Vec<String>,
}

impl Ledger {
    fn new(suite: &'static str) -> Self {
        Self {
            suite,
            composition: composition(),
            compared: Vec::new(),
            mapped: Vec::new(),
            skipped: Vec::new(),
        }
    }

    /// A case compared: `mapped` names what the mapping changed (`None` = compared as recorded).
    fn record(&mut self, id: &str, mapped: Option<&str>) {
        match mapped {
            Some(m) => self.mapped.push(format!("{id} ({m})")),
            None => self.compared.push(id.to_owned()),
        }
    }

    fn skip(&mut self, id: &str, reason: &str) {
        self.skipped.push(format!("{id} — {reason}"));
    }

    /// A `<X>_SPEC_UPDATE` under a reduced composition would record that composition's answers: refused.
    fn refuse_update(&self, update: bool, env_var: &str) {
        assert!(
            !(update && self.composition != Composition::Full),
            "{env_var} under OMGBASE_CAPABILITIES={} would record the {} composition's answers; run it on the full one",
            self.composition,
            self.composition
        );
    }

    /// The line (+ the mapped and skipped lists under a reduced composition), to stderr.
    fn report(&self) {
        let mut text = format!(
            "[{} spec] composition={}: compared={} mapped={} skipped={}\n",
            self.suite,
            self.composition,
            self.compared.len(),
            self.mapped.len(),
            self.skipped.len()
        );
        if self.composition != Composition::Full {
            for m in &self.mapped {
                text.push_str(&format!("  mapped {m}\n"));
            }
            for s in &self.skipped {
                text.push_str(&format!("  skip {s}\n"));
            }
        }
        eprint!("{text}");
    }
}

/// README §9.6 rule (1): does the case run WITHOUT the history module
/// (`core`, `semantic`) — only `observe` / `sweep` / `remint_epoch` steps?
fn runs_under_core(c: &Json) -> bool {
    c["steps"].as_array().is_some_and(|steps| {
        steps.iter().all(|s| {
            s.as_object().is_some_and(|o| {
                o.keys()
                    .all(|k| k == "observe" || k == "sweep" || k == "remint_epoch")
            })
        })
    })
}

/// README §9.6 rule (3): a projection reduced to what a run WITHOUT the
/// history module compares — the core tables, `id_claims` with bit 1 masked
/// (a claim the recorder alone held — `holders = 2` — drops out, since a
/// recorder-less store never wrote it), and the history tables emptied.
fn core_mode_projection(expect: &Json) -> Json {
    let mut out = expect.clone();
    let Some(obj) = out.as_object_mut() else {
        return out;
    };
    for t in PROJECTED_TABLES {
        if !CORE_PROJECTED_TABLES.contains(&t) {
            obj.insert(t.to_owned(), Json::Array(Vec::new()));
        }
    }
    if let Some(Json::Array(claims)) = obj.get("id_claims").cloned() {
        let masked: Vec<Json> = claims
            .into_iter()
            .filter_map(|mut r| {
                let holders = r.get("holders").and_then(Json::as_i64).unwrap_or(0) & 1;
                if holders == 0 {
                    return None;
                }
                r["holders"] = json!(holders);
                Some(r)
            })
            .collect();
        obj.insert("id_claims".to_owned(), Json::Array(masked));
    }
    out
}

/// README §9.6 "Without the semantic module": the fingerprint without the
/// semantic bundle (its tables and indexes) — applied to BOTH sides.
fn without_semantic_tables(f: &Json) -> Json {
    let mut out = f.clone();
    if let Some(tables) = out.get_mut("tables").and_then(Json::as_object_mut) {
        tables.remove("embeddings");
        tables.remove("doc_embeddings");
    }
    if let Some(indexes) = out.get_mut("indexes").and_then(Json::as_object_mut) {
        let gone: Vec<String> = indexes
            .iter()
            .filter(|(_, ix)| {
                matches!(
                    ix.get("table").and_then(Json::as_str),
                    Some("embeddings" | "doc_embeddings")
                )
            })
            .map(|(k, _)| k.clone())
            .collect();
        for k in gone {
            indexes.remove(&k);
        }
    }
    out
}

/// README §9.6 "Without the semantic module": a migration's expectation
/// without the semantic bundle's tables (the `history` composition upgrades a
/// 16.x database but executes no semantic DDL, so a 16.x `doc_embeddings`
/// stays) — applied to BOTH sides, the `tables` and the `rows` maps.
fn without_semantic_migration_tables(e: &Json) -> Json {
    let mut out = e.clone();
    for key in ["tables", "rows"] {
        if let Some(m) = out.get_mut(key).and_then(Json::as_object_mut) {
            m.remove("embeddings");
            m.remove("doc_embeddings");
        }
    }
    out
}

// ---- the recorder fault device (README §9.4, Phase 4a) ------------------------------------
//
// `{ recorder_fault: { fail: true } }` wraps the store's recorder so that
// every capture call (`record_commit`, `record_revision`,
// `record_dispositions`, `record_edge_transitions`, `retarget_edges`) fails;
// the next `observe` step then pins resolution 18 — the member is rolled back
// (`{ path, failed: true, doc, error }`), the feed and every table stay as
// they were, the next observe after `{ fail: false }` lands it. Test seam
// only: the composition is swapped on the store (`Store::set_history`).

/// The store's recorder behind a switch: with `fail` set every capture call
/// fails with [`RECORDER_FAULT_REASON`]; the reads and the maintenance pass
/// through. Installed once by the first `recorder_fault` step of a case and
/// toggled after (the runner holds the switch).
struct FaultyRecorder {
    inner: Box<dyn omgbase_store::HistoryRecorder>,
    fail: Rc<Cell<bool>>,
}

impl FaultyRecorder {
    fn capture<T>(
        &self,
        body: impl FnOnce() -> omgbase_store::Result<T>,
    ) -> omgbase_store::Result<T> {
        if self.fail.get() {
            return Err(omgbase_store::Error::Other(
                RECORDER_FAULT_REASON.to_owned(),
            ));
        }
        body()
    }
}

impl omgbase_store::HistoryRecorder for FaultyRecorder {
    fn record_commit(
        &self,
        tx: &Connection,
        commit: &omgbase_store::CommitRecord<'_>,
    ) -> omgbase_store::Result<()> {
        self.capture(|| self.inner.record_commit(tx, commit))
    }
    fn record_revision(
        &self,
        tx: &Connection,
        transition: &omgbase_store::RevisionTransition<'_>,
    ) -> omgbase_store::Result<omgbase_store::RecordedRevision> {
        self.capture(|| self.inner.record_revision(tx, transition))
    }
    fn record_dispositions(
        &self,
        tx: &Connection,
        commit_id: &str,
        rows: &[omgbase_store::DispositionRow],
    ) -> omgbase_store::Result<()> {
        self.capture(|| self.inner.record_dispositions(tx, commit_id, rows))
    }
    fn record_edge_transitions(
        &self,
        tx: &Connection,
        commit_id: &str,
        transitions: &omgbase_store::EdgeTransitions,
    ) -> omgbase_store::Result<()> {
        self.capture(|| {
            self.inner
                .record_edge_transitions(tx, commit_id, transitions)
        })
    }
    fn retarget_edges(
        &self,
        tx: &Connection,
        edge_ids: &[&str],
        dst_node: &str,
    ) -> omgbase_store::Result<()> {
        self.capture(|| self.inner.retarget_edges(tx, edge_ids, dst_node))
    }
    fn read_at_revision(
        &self,
        conn: &Connection,
        doc_id: &str,
        rev_id: &str,
    ) -> omgbase_store::Result<Option<omgbase_store::RevisionRead>> {
        self.inner.read_at_revision(conn, doc_id, rev_id)
    }
    fn frontmatter_at_revision(
        &self,
        conn: &Connection,
        rev_id: &str,
    ) -> omgbase_store::Result<Option<String>> {
        self.inner.frontmatter_at_revision(conn, rev_id)
    }
    fn disposition_counts(
        &self,
        conn: &Connection,
        commit_id: &str,
    ) -> omgbase_store::Result<Option<Vec<(String, i64)>>> {
        self.inner.disposition_counts(conn, commit_id)
    }
    fn revision_rows(
        &self,
        conn: &Connection,
        repo_id: &str,
    ) -> omgbase_store::Result<Vec<omgbase_store::RevisionQueryRow>> {
        self.inner.revision_rows(conn, repo_id)
    }
    fn doc_revision_rows(
        &self,
        conn: &Connection,
        doc_id: &str,
    ) -> omgbase_store::Result<Vec<omgbase_store::RevisionQueryRow>> {
        self.inner.doc_revision_rows(conn, doc_id)
    }
    fn has_revision(&self, conn: &Connection, rev_id: &str) -> omgbase_store::Result<bool> {
        self.inner.has_revision(conn, rev_id)
    }
    fn uncaptured_heads(
        &self,
        conn: &Connection,
        repo_id: &str,
        since: &str,
    ) -> omgbase_store::Result<i64> {
        self.inner.uncaptured_heads(conn, repo_id, since)
    }
    fn baseline(
        &self,
        tx: &Connection,
        commit: &omgbase_store::CommitRecord<'_>,
    ) -> omgbase_store::Result<usize> {
        self.inner.baseline(tx, commit)
    }
    fn purge(
        &self,
        tx: &Connection,
        repo_id: &str,
        before: Option<&str>,
        drop_if_empty: bool,
        protect_heads: bool,
    ) -> omgbase_store::Result<omgbase_store::HistoryPurgeOutcome> {
        self.inner
            .purge(tx, repo_id, before, drop_if_empty, protect_heads)
    }
    fn rebuild_projection(&self, tx: &Connection) -> omgbase_store::Result<()> {
        self.inner.rebuild_projection(tx)
    }
    fn gc(&self, tx: &Connection) -> omgbase_store::Result<omgbase_store::GcResult> {
        self.inner.gc(tx)
    }
    fn gc_dry_run(&self, conn: &Connection) -> omgbase_store::Result<omgbase_store::GcResult> {
        self.inner.gc_dry_run(conn)
    }
    fn count_same_dispositions(&self, conn: &Connection) -> omgbase_store::Result<usize> {
        self.inner.count_same_dispositions(conn)
    }
    fn size_figures(
        &self,
        conn: &Connection,
        now: &str,
    ) -> omgbase_store::Result<omgbase_store::HistorySizeFigures> {
        self.inner.size_figures(conn, now)
    }
    fn retention_policy(
        &self,
        conn: &Connection,
        repo_id: &str,
        override_: Option<&Json>,
    ) -> omgbase_store::Result<omgbase_store::RetentionPolicy> {
        self.inner.retention_policy(conn, repo_id, override_)
    }
    fn retention_plan(
        &self,
        conn: &Connection,
        repo_id: &str,
        opts: &RetentionOptions,
    ) -> omgbase_store::Result<omgbase_store::RetentionPlan> {
        self.inner.retention_plan(conn, repo_id, opts)
    }
    fn export_history(
        &self,
        conn: &Connection,
        mint: &mut omgbase_store::Mint<'_>,
        repo_id: &str,
        opts: &ExportOptions,
    ) -> omgbase_store::Result<omgbase_store::ExportResult> {
        self.inner.export_history(conn, mint, repo_id, opts)
    }
    fn attach_archive(
        &self,
        conn: &Connection,
        repo_id: &str,
        target: &Path,
    ) -> omgbase_store::Result<omgbase_store::AttachResult> {
        self.inner.attach_archive(conn, repo_id, target)
    }
    fn detach_archive(
        &self,
        conn: &Connection,
        repo_id: &str,
        r: &str,
    ) -> omgbase_store::Result<Option<String>> {
        self.inner.detach_archive(conn, repo_id, r)
    }
    fn list_archives(
        &self,
        conn: &Connection,
        repo_id: &str,
        dest: Option<&Path>,
    ) -> omgbase_store::Result<Vec<omgbase_store::ArchiveListing>> {
        self.inner.list_archives(conn, repo_id, dest)
    }
}

/// `{ recorder_fault: { fail } }`: install the switch on the first call,
/// then flip it; returns whether a fault is now in force (`false` when the
/// store has no recorder to fault).
fn set_recorder_fault(store: &mut Store, fail: bool, switch: &mut Option<Rc<Cell<bool>>>) -> bool {
    if switch.is_none() {
        let Some(inner) = store.set_history(None) else {
            return false;
        };
        let flag = Rc::new(Cell::new(false));
        store.set_history(Some(Box::new(FaultyRecorder {
            inner,
            fail: Rc::clone(&flag),
        })));
        *switch = Some(flag);
    }
    let flag = switch.as_ref().expect("installed above");
    flag.set(fail);
    fail
}

/// README §9.4 (Phase 4a; §5.9): `history_enable` / `history_disable` through
/// the production verbs, the fault device through the test seam.
fn run_lifecycle_step(
    store: &mut Store,
    repo_id: &str,
    kind: &str,
    body: &Json,
    fault: &mut Option<Rc<Cell<bool>>>,
) -> Result<Json, String> {
    match kind {
        "history_enable" => {
            let ts = body["ts"].as_str().ok_or("history_enable.ts")?;
            let writer_requires = body
                .get("writer_requires")
                .and_then(Json::as_bool)
                .unwrap_or(true);
            let r = store
                .enable_history(repo_id, ts, writer_requires)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "history": r.to_json() }))
        }
        "history_disable" => {
            let ts = body["ts"].as_str().ok_or("history_disable.ts")?;
            let r = store
                .disable_history(repo_id, ts)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "history": r.to_json() }))
        }
        // README §9.4 (Phase 4b; §7.6): `history purge [--before]` → the receipt.
        "history_purge" => {
            body["ts"].as_str().ok_or("history_purge.ts")?;
            let before = body.get("before").and_then(Json::as_str);
            let r = store
                .purge_history(repo_id, before)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "purge": r.to_json() }))
        }
        _ => {
            let fail = body["fail"].as_bool().ok_or("recorder_fault.fail")?;
            Ok(json!({ "fault": set_recorder_fault(store, fail, fault) }))
        }
    }
}

/// README §9.4 (Phase 4a): the lifecycle steps' bodies — `history_enable {
/// ts, writer_requires? }`, `history_disable { ts }`, `recorder_fault { fail }`.
fn validate_lifecycle_body(here: &str, kind: &str, body: &Json, problems: &mut Vec<String>) {
    let Some(b) = body.as_object() else {
        problems.push(format!("{here}: {kind} must be an object"));
        return;
    };
    match kind {
        "history_enable" => {
            if b.keys().any(|k| k != "ts" && k != "writer_requires") {
                problems.push(format!(
                    "{here}: history_enable takes `ts` and an optional `writer_requires`"
                ));
            }
            if !b.get("ts").and_then(Json::as_str).is_some_and(is_spec_ts) {
                problems.push(format!(
                    "{here}: `ts` must be RFC 3339 UTC with three fractional digits and Z (§2.4)"
                ));
            }
            if b.get("writer_requires").is_some_and(|w| !w.is_boolean()) {
                problems.push(format!("{here}: `writer_requires` must be a boolean"));
            }
        }
        "history_disable" => {
            if b.keys().any(|k| k != "ts") {
                problems.push(format!("{here}: history_disable takes only `ts`"));
            } else if !b.get("ts").and_then(Json::as_str).is_some_and(is_spec_ts) {
                problems.push(format!(
                    "{here}: `ts` must be RFC 3339 UTC with three fractional digits and Z (§2.4)"
                ));
            }
        }
        "history_purge" => {
            if b.keys().any(|k| k != "ts" && k != "before") {
                problems.push(format!(
                    "{here}: history_purge takes `ts` and an optional `before`"
                ));
            } else {
                if !b.get("ts").and_then(Json::as_str).is_some_and(is_spec_ts) {
                    problems.push(format!(
                        "{here}: `ts` must be RFC 3339 UTC with three fractional digits and Z (§2.4)"
                    ));
                }
                if b.get("before")
                    .is_some_and(|v| !v.as_str().is_some_and(is_spec_ts))
                {
                    problems.push(format!(
                        "{here}: `before` must be RFC 3339 UTC with three fractional digits and Z (§2.4)"
                    ));
                }
            }
        }
        _ => {
            if b.keys().any(|k| k != "fail") || !b.get("fail").is_some_and(Json::is_boolean) {
                problems.push(format!(
                    "{here}: recorder_fault takes only a boolean `fail`"
                ));
            }
        }
    }
}

/// The step loop every observation-script suite of this spec shares (§9.4,
/// §9.5): each step through its production path, the §8 invariants after
/// every observe / gc / export / re-mint step and at the end. Returns the
/// outcomes and the problems found.
fn run_steps(
    store: &mut Store,
    repo_id: &str,
    c: &Json,
    config: &Config,
) -> Result<(Vec<Json>, Vec<String>), String> {
    let mut last_source: HashMap<String, String> = HashMap::new();
    let mut steps = Vec::new();
    let mut problems = Vec::new();
    // The case's archive directory (README §9.4, 15.0): created on the first
    // retention step, removed with the store.
    let mut dest: Option<ArchiveDir> = None;
    // The recorder fault device's switch (README §9.4, Phase 4a), installed
    // by the first `recorder_fault` step.
    let mut fault: Option<Rc<Cell<bool>>> = None;
    for (i, step) in c["steps"].as_array().ok_or("steps")?.iter().enumerate() {
        if let Some(kind) = LIFECYCLE_STEP_KINDS
            .iter()
            .find(|k| step.get(**k).is_some())
        {
            // README §5.9 (Phase 4a): `history enable` (the baseline commit
            // and the open interval; every invariant holds after it),
            // `history disable`, the fault device (no check after it).
            steps.push(
                run_lifecycle_step(store, repo_id, kind, &step[*kind], &mut fault)
                    .map_err(|e| format!("step {i}: {e}"))?,
            );
            if *kind != "recorder_fault" {
                for p in check_invariants(store, repo_id, &last_source) {
                    problems.push(format!("after step {i}: {p}"));
                }
            }
        } else if let Some(kind) = HISTORY_STEP_KINDS.iter().find(|k| step.get(**k).is_some()) {
            let dir =
                dest.get_or_insert_with(|| ArchiveDir::new(c["name"].as_str().unwrap_or("case")));
            steps.push(
                run_history_step(store, repo_id, kind, &step[*kind], &dir.0)
                    .map_err(|e| format!("step {i}: {e}"))?,
            );
            if *kind == "history_export" {
                for p in check_invariants(store, repo_id, &last_source) {
                    problems.push(format!("after step {i}: {p}"));
                }
            }
        } else if let Some(observe) = step.get("observe") {
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
                .observe_batch(repo_id, &items, ts, config)
                .map_err(|e| format!("step {i}: {e}"))?;
            // A member rolled back by a capture failure (Phase 4a) left the
            // store as it was: its source is not what the rows hold.
            let failed: HashSet<&str> = outcomes
                .iter()
                .filter_map(|o| o.as_failed().map(|f| f.path.as_str()))
                .collect();
            for it in &items {
                if failed.contains(it.path.as_str()) {
                    continue;
                }
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
            for p in check_invariants(store, repo_id, &last_source) {
                problems.push(format!("after step {i}: {p}"));
            }
        } else if let Some(sweep) = step.get("sweep") {
            let ts = sweep["ts"].as_str().ok_or("sweep.ts")?;
            let swept = store.sweep_pool(ts).map_err(|e| format!("step {i}: {e}"))?;
            steps.push(json!({ "swept": swept }));
        } else if let Some(gc) = step.get("gc") {
            let ts = gc.get("ts").and_then(Json::as_str);
            steps.push(run_gc_step(store, ts).map_err(|e| format!("step {i}: {e}"))?);
            for p in check_invariants(store, repo_id, &last_source) {
                problems.push(format!("after step {i}: {p}"));
            }
        } else if let Some(remint) = step.get("remint_epoch") {
            // README §7.5 (17.0): the epoch re-mint — a new `ep`, the feed
            // emptied; the invariants hold on the new epoch (C4 with an empty
            // feed, F1 vacuous).
            let ts = remint["ts"].as_str().ok_or("remint_epoch.ts")?;
            let epoch = store
                .remint_epoch(repo_id, ts)
                .map_err(|e| format!("step {i}: {e}"))?;
            steps.push(json!({ "epoch": epoch }));
            for p in check_invariants(store, repo_id, &last_source) {
                problems.push(format!("after step {i}: {p}"));
            }
        } else if let Some(exec) = step.get("exec") {
            steps.push(run_exec_step(store.conn(), exec).map_err(|e| format!("step {i}: {e}"))?);
        } else {
            return Err(format!(
                "step {i}: none of observe, sweep, gc, exec, remint_epoch, history_*, read_at, history_enable, history_disable, history_purge, recorder_fault"
            ));
        }
    }
    for p in check_invariants(store, repo_id, &last_source) {
        problems.push(format!("at end: {p}"));
    }
    drop(dest);
    Ok((steps, problems))
}

fn run_observe_case(c: &Json) -> Result<ObserveEvaluation, String> {
    let config = config_from(c.get("config"))?;
    let (mut store, repo_id) = fixture_store(minter_of(c)?, case_history(c))?;
    let (steps, problems) = run_steps(&mut store, &repo_id, c, &config)?;
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

/// README §9.5 (17.0): the recorder's edge suite — the same observation
/// scripts as `spec/graph`'s, projecting `edge_transitions` alone: every
/// column but `repo_id`, by (`from_commit`'s rank in the `commits` order —
/// `(ts, seq)` — then `edge_id` bytewise), `to_commit` as the commit id or
/// null. Runner checks beyond §8: every `from_commit`/`to_commit` is a
/// `commits` row (the check that moved here from `spec/graph` 2.x); every
/// open transition has an `edges` row of the same id and destination, and
/// every `edges` row an open transition (§8 H6, in `check_invariants`).
fn run_edge_transitions_case(c: &Json) -> Result<ObserveEvaluation, String> {
    let config = config_from(c.get("config"))?;
    let (mut store, repo_id) = fixture_store(Box::new(SequentialMinter::new()), true)?;
    let (_, mut problems) = run_steps(&mut store, &repo_id, c, &config)?;
    let conn = store.conn();
    let commit_rank: HashMap<String, usize> = all_rows(
        conn,
        "SELECT commit_id FROM commits WHERE repo_id = ?1 ORDER BY ts, seq",
        &[&repo_id],
        |r| r.get::<_, String>(0),
    )
    .into_iter()
    .enumerate()
    .map(|(i, id)| (id, i))
    .collect();
    let rank_of = |id: &str| commit_rank.get(id).copied().unwrap_or(usize::MAX);
    let mut rows = query_rows(
        conn,
        &format!(
            "SELECT {} FROM edge_transitions WHERE repo_id = ?1",
            EDGE_TRANSITION_FIELDS.join(", ")
        ),
        &[&repo_id],
    );
    rows.sort_by(|a, b| {
        rank_of(str_of(a, "from_commit"))
            .cmp(&rank_of(str_of(b, "from_commit")))
            .then_with(|| {
                str_of(a, "edge_id")
                    .as_bytes()
                    .cmp(str_of(b, "edge_id").as_bytes())
            })
    });
    for t in &rows {
        let id = str_of(t, "edge_id");
        let from = str_of(t, "from_commit");
        if !commit_rank.contains_key(from) {
            problems.push(format!("edge {id}: from_commit {from} is not a commit"));
        }
        if let Some(to) = t["to_commit"].as_str()
            && !commit_rank.contains_key(to)
        {
            problems.push(format!("edge {id}: to_commit {to} is not a commit"));
        }
    }
    Ok(ObserveEvaluation {
        expect: json!({ "edge_transitions": rows }),
        problems,
    })
}

/// README §9.4 (14.2): `gc` is `{}` and `exec` is `{ sql: [<statement>, …] }`.
fn validate_gc_exec_body(here: &str, kind: &str, body: &Json, problems: &mut Vec<String>) {
    let Some(b) = body.as_object() else {
        problems.push(format!("{here}: {kind} must be an object"));
        return;
    };
    if kind == "gc" {
        // README §9.4 (14.2, 17.0): `{}` or `{ ts }` — the claims prune's clock.
        if b.keys().any(|k| k != "ts") {
            problems.push(format!("{here}: gc takes only an optional `ts`"));
        } else if let Some(ts) = b.get("ts")
            && !ts.as_str().is_some_and(is_spec_ts)
        {
            problems.push(format!(
                "{here}: `ts` must be RFC 3339 UTC with three fractional digits and Z (§2.4)"
            ));
        }
        return;
    }
    if b.keys().any(|k| k != "sql") {
        problems.push(format!("{here}: exec takes only `sql`"));
    }
    let sql_ok = b.get("sql").and_then(Json::as_array).is_some_and(|a| {
        !a.is_empty() && a.iter().all(|q| q.as_str().is_some_and(|s| !s.is_empty()))
    });
    if !sql_ok {
        problems.push(format!(
            "{here}: `sql` must be a non-empty array of statements"
        ));
    }
}

/// README §9.4 (14.2, 17.0): the `gc` step — the §7 collection, enabled,
/// never a dry run, `ts` the clock of the claims prune (§7.3) and the feed
/// prune (§7.4; the runner's own clock without it); the counts in the
/// fixture's spelling.
fn run_gc_step(store: &Store, ts: Option<&str>) -> Result<Json, String> {
    let r = match ts {
        Some(ts) => store.gc_at(true, ts),
        None => store.gc(true),
    }
    .map_err(|e| e.to_string())?;
    Ok(json!({ "gc": {
        "blobs": r.blobs_swept,
        "tree_nodes": r.tree_nodes_swept,
        "same_dispositions": r.same_dispositions_swept,
        "claims_released": r.claims_released,
        "feed_pruned": r.feed_pruned,
    } }))
}

/// README §9.4 (14.2): the `exec` step — every statement run verbatim, in
/// order, in one transaction; the rows changed summed. The invariants are not
/// checked after it (the device plants rows a 14.2 store never writes).
fn run_exec_step(conn: &Connection, exec: &Json) -> Result<Json, String> {
    let sql = exec["sql"].as_array().ok_or("exec.sql")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut changes = 0usize;
    for statement in sql {
        let s = statement.as_str().ok_or("exec.sql[]")?;
        changes += tx.execute(s, []).map_err(|e| format!("{s}: {e}"))?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({ "changes": changes }))
}

/// README §9.4 (15.0): the retention steps' bodies — `history_plan { ts,
/// policy?, before? }`, `history_export { ts, policy?, before?, prune }`,
/// `history_attach` / `history_detach { segment }`, `read_at { doc, rev }`.
fn validate_history_body(here: &str, kind: &str, body: &Json, problems: &mut Vec<String>) {
    let Some(b) = body.as_object() else {
        problems.push(format!("{here}: not an object"));
        return;
    };
    let allowed: &[&str] = match kind {
        "history_plan" => &["ts", "policy", "before"],
        "history_export" => &["ts", "policy", "before", "prune"],
        "history_attach" | "history_detach" => &["segment"],
        _ => &["doc", "rev"],
    };
    let extra: Vec<&str> = b
        .keys()
        .map(String::as_str)
        .filter(|k| !allowed.contains(k))
        .collect();
    if !extra.is_empty() {
        problems.push(format!(
            "{here}: {kind} takes {} (got {})",
            allowed
                .iter()
                .map(|k| format!("`{k}`"))
                .collect::<Vec<_>>()
                .join(", "),
            extra.join(", ")
        ));
    }
    match kind {
        "history_plan" | "history_export" => {
            if !b.get("ts").and_then(Json::as_str).is_some_and(is_spec_ts) {
                problems.push(format!(
                    "{here}: `ts` must be RFC 3339 UTC with three fractional digits and Z (§2.4)"
                ));
            }
            if b.get("policy").is_some_and(|p| !p.is_object()) {
                problems.push(format!(
                    "{here}: `policy` must be an object (a partial over the defaults)"
                ));
            }
            if b.get("before")
                .is_some_and(|v| !v.as_str().is_some_and(is_spec_ts))
            {
                problems.push(format!(
                    "{here}: `before` must be RFC 3339 UTC with three fractional digits and Z (§2.4)"
                ));
            }
            if kind == "history_export" && !b.get("prune").is_some_and(Json::is_boolean) {
                problems.push(format!("{here}: `prune` must be a boolean"));
            }
        }
        "read_at" => {
            if !b.get("doc").is_some_and(Json::is_string)
                || !b.get("rev").is_some_and(Json::is_string)
            {
                problems.push(format!("{here}: read_at takes `doc` and `rev` ids"));
            }
        }
        _ => {
            if !b
                .get("segment")
                .and_then(Json::as_str)
                .is_some_and(|s| !s.is_empty())
            {
                problems.push(format!("{here}: `segment` must be a segment id"));
            }
        }
    }
}

/// The case's archive directory (README §9.4, 15.0), removed on drop.
struct ArchiveDir(PathBuf);

impl ArchiveDir {
    fn new(tag: &str) -> Self {
        let unique = format!(
            "omgbase-store-spec-archives-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        );
        let dir = std::env::temp_dir().join(unique);
        fs::create_dir_all(&dir).expect("archive dir");
        Self(dir)
    }
}

impl Drop for ArchiveDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The file of a segment under the case's `dest`, by id (`…-<segment>.omgarchive.db`).
fn segment_file(dest: &Path, segment_id: &str) -> Result<PathBuf, String> {
    let suffix = format!("-{segment_id}.omgarchive.db");
    let found = fs::read_dir(dest)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .find(|n| n.ends_with(&suffix))
        .ok_or_else(|| format!("no segment file for {segment_id} under {}", dest.display()))?;
    Ok(dest.join(found))
}

/// README §9.4 (15.0): the retention steps, through the production paths
/// (`retention_plan`, `export_history`, `attach_archive`, `detach_archive`,
/// `read_at_revision`). `policy` is a partial over the defaults (the repo has
/// no settings in a fixture); `ts` is the clock.
fn run_history_step(
    store: &mut Store,
    repo_id: &str,
    kind: &str,
    body: &Json,
    dest: &Path,
) -> Result<Json, String> {
    let retention = |body: &Json| -> Result<RetentionOptions, String> {
        let now = body["ts"].as_str().ok_or("ts")?.to_owned();
        let policy = store
            .retention_policy(repo_id, body.get("policy"))
            .map_err(|e| e.to_string())?;
        Ok(RetentionOptions {
            now,
            before: body.get("before").and_then(Json::as_str).map(str::to_owned),
            policy,
        })
    };
    match kind {
        "history_plan" => {
            let opts = retention(body)?;
            let plan = store
                .retention_plan(repo_id, &opts)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "plan": plan.to_json() }))
        }
        "history_export" => {
            let opts = ExportOptions {
                retention: retention(body)?,
                dest: dest.to_path_buf(),
                prune: body["prune"].as_bool().unwrap_or(false),
            };
            let r = store
                .export_history(repo_id, &opts)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "export": {
                "segment": r.segment.as_ref().map(|s| json!({
                    "id": s.id, "seq_lo": s.seq_lo, "seq_hi": s.seq_hi,
                    "revision_count": s.revision_count, "previous_segment": s.previous_segment,
                })),
                "reused": r.reused,
                "squashed": r.squashed.map(|q| json!({
                    "revisions": q.revisions, "commits": q.commits,
                    "dispositions": q.dispositions, "block_changes": q.block_changes,
                    "checkpointed": q.checkpointed,
                })),
                "gc": r.gc.map(|g| json!({ "blobs": g.blobs, "tree_nodes": g.tree_nodes })),
            } }))
        }
        "history_attach" => {
            let file = segment_file(dest, body["segment"].as_str().ok_or("segment")?)?;
            let r = store
                .attach_archive(repo_id, &file)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "attached": r.attached.iter().map(|a| json!({
                "segment_id": a.segment_id, "seq_lo": a.seq_lo, "seq_hi": a.seq_hi,
                "revision_count": a.revision_count,
            })).collect::<Vec<_>>() }))
        }
        "history_detach" => {
            let detached = store
                .detach_archive(repo_id, body["segment"].as_str().ok_or("segment")?)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "detached": detached }))
        }
        _ => {
            let doc = body["doc"].as_str().ok_or("doc")?;
            let rev = body["rev"].as_str().ok_or("rev")?;
            match store.read_at_revision(doc, rev) {
                Ok(Some(r)) => {
                    Ok(json!({ "raw": r.content, "rendered_hash_match": r.rendered_hash_match }))
                }
                Ok(None) => Ok(json!({ "error": "target_missing" })),
                Err(omgbase_store::Error::RevisionArchived { rev, archive, path }) => {
                    let mut m = JsonMap::new();
                    m.insert("error".to_owned(), json!("revision_archived"));
                    m.insert("rev".to_owned(), json!(rev));
                    m.insert("archive".to_owned(), json!(archive));
                    if let Some(p) = path {
                        m.insert(
                            "path".to_owned(),
                            json!(format!(
                                "{DEST_TOKEN}/{}",
                                omgbase_store::segment_basename(&p)
                            )),
                        );
                    }
                    Ok(Json::Object(m))
                }
                Err(e) => Err(e.to_string()),
            }
        }
    }
}

// ---- projection (§9.4 "Expect") -----------------------------------------------------------

const BLOCK_COLUMNS: &str = "block_id, doc_id, parent_block, order_key, ordinal, depth, ancestor_path, type, attrs, text, raw, raw_hash, norm_hash, trivia, trivia_hash, created_at, updated_at, deleted_at";

/// A doc's `blocks` rows in pre-order (children by `parent_block`, `ordinal`
/// order); an orphaned parent counts as top level.
fn doc_blocks_preorder(conn: &Connection, doc_id: &str, live_only: bool) -> Vec<Json> {
    let rows = query_rows(
        conn,
        &format!(
            "SELECT {BLOCK_COLUMNS} FROM blocks WHERE doc_id = ?1 {} ORDER BY ordinal, block_id",
            if live_only {
                "AND deleted_at IS NULL"
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
        "SELECT doc_id, path, format, head, file_hash, conflicted, leading_trivia, frontmatter_raw, frontmatter_trivia, created_at, updated_at, deleted_at FROM docs WHERE repo_id = ?1 ORDER BY path",
        &[&repo_id],
    );
    let doc_ids: Vec<String> = docs
        .iter()
        .map(|d| str_of(d, "doc_id").to_owned())
        .collect();

    // Phase 4a: a database no repository of which ever enabled capture has no
    // history table — every history projection is `[]` then.
    let history = history_bundle_present(conn).expect("sqlite_master reads");
    let rows = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> Vec<Json> {
        if history {
            query_rows(conn, sql, params)
        } else {
            Vec::new()
        }
    };

    // `commits` by (`ts`, `seq`) — the same order as by `seq` while one epoch
    // exists (I4), and the chronological one across an epoch re-mint (§7.5),
    // whose commits restart at `seq = 1`; the rank in this list orders the
    // dispositions and block_changes by commit.
    let commits = rows(
        "SELECT commit_id, epoch, seq, ts, origin, actor, reason, batch_id, ops FROM commits WHERE repo_id = ?1 ORDER BY ts, seq",
        &[&repo_id],
    );
    let commit_seq: HashMap<String, i64> = commits
        .iter()
        .enumerate()
        .map(|(i, c)| (str_of(c, "commit_id").to_owned(), i as i64))
        .collect();
    let seq_of = |id: &str| commit_seq.get(id).copied().unwrap_or(i64::MAX);

    // 17.0 (3d): the feed and its entries — the rows of the repo's current
    // epoch (a fixture database has one), by `seq`; the entries of a row in
    // the order they were written (the member order of the commit).
    let feed = query_rows(
        conn,
        "SELECT epoch, seq, commit_id, ts, origin, actor, reason, batch_id, plan_id FROM feed WHERE repo_id = ?1 ORDER BY seq",
        &[&repo_id],
    );
    let feed_entries = query_rows(
        conn,
        "SELECT epoch, seq, doc_id, path, head, hash, kind, from_path FROM feed_entries WHERE repo_id = ?1 ORDER BY seq, rowid",
        &[&repo_id],
    );

    let mut revisions = rows(
        "SELECT r.rev_id, r.doc_id, r.seq, r.root_tree, r.frontmatter_blob, r.rendered_hash, r.path, r.commit_id, r.archive
         FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE d.repo_id = ?1",
        &[&repo_id],
    );
    revisions.sort_by(|a, b| {
        str_of(a, "doc_id")
            .as_bytes()
            .cmp(str_of(b, "doc_id").as_bytes())
            .then(int_of(a, "seq").cmp(&int_of(b, "seq")))
    });

    let mut blobs: Vec<Json> = if history {
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
    } else {
        Vec::new()
    };
    blobs.sort_by(|a, b| str_of(a, "hash").cmp(str_of(b, "hash")));
    let mut tree_nodes = rows("SELECT hash, entries FROM tree_nodes", &[]);
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
    let mut dispositions: Vec<Json> = rows(
        "SELECT x.commit_id, x.block_id, x.kind, x.confidence, x.reason, x.matcher_v, x.detail
         FROM dispositions x JOIN commits c ON c.commit_id = x.commit_id WHERE c.repo_id = ?1",
        &[&repo_id],
    )
    .into_iter()
    .map(|r| with_json_column(r, "detail"))
    .collect();
    dispositions.sort_by(by_commit_block_kind);
    let mut block_changes = rows(
        "SELECT bc.block_id, bc.commit_id, bc.kind FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE c.repo_id = ?1",
        &[&repo_id],
    );
    block_changes.sort_by(by_commit_block_kind);

    let mut pool = query_rows(
        conn,
        "SELECT block_id, doc_id, raw_hash, norm_hash, type, created_at, deleted_at, expires_ts FROM resurrection_pool WHERE repo_id = ?1",
        &[&repo_id],
    );
    pool.sort_by(|a, b| {
        str_of(a, "expires_ts").cmp(str_of(b, "expires_ts")).then(
            str_of(a, "block_id")
                .as_bytes()
                .cmp(str_of(b, "block_id").as_bytes()),
        )
    });
    // README §9.4 (17.0): the §2.1 claims of the case's repo as `{ prefix,
    // id, minted_at, holders }` by (`prefix` bytewise, `id` bytewise) — the
    // repository's own `rp` claim and its epoch's `ep` claim (3d) omitted
    // like `repo_id` is from every row (the runner minted both before the
    // first step, at its own clock).
    let mut id_claims = query_rows(
        conn,
        "SELECT prefix, id, minted_at, holders FROM id_claims WHERE repo_id = ?1 AND prefix NOT IN ('rp', 'ep')",
        &[&repo_id],
    );
    id_claims.sort_by(|a, b| {
        str_of(a, "prefix")
            .as_bytes()
            .cmp(str_of(b, "prefix").as_bytes())
            .then(str_of(a, "id").as_bytes().cmp(str_of(b, "id").as_bytes()))
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
    let pending = query_rows(
        conn,
        "SELECT path, kind, from_path, doc_id, head, rendered_hash, prior_hash, commit_id, created_at FROM pending_materializations WHERE repo_id = ?1 ORDER BY path",
        &[&repo_id],
    );
    // 15.0: the recorded segments, `path` reduced to its file name (the
    // directory is the run's) and `bytes` omitted (a page layout, not a behavior).
    let archives: Vec<Json> = rows(
        "SELECT segment_id, path, seq_lo, seq_hi, created_at, revision_count FROM archives WHERE repo_id = ?1 ORDER BY seq_lo, segment_id",
        &[&repo_id],
    )
    .into_iter()
    .map(|r| {
        json!({
            "segment_id": r["segment_id"],
            "file": omgbase_store::segment_basename(str_of(&r, "path")),
            "seq_lo": r["seq_lo"],
            "seq_hi": r["seq_hi"],
            "created_at": r["created_at"],
            "revision_count": r["revision_count"],
        })
    })
    .collect();

    vec![
        ("docs".to_owned(), Json::Array(docs)),
        ("commits".to_owned(), Json::Array(commits)),
        ("feed".to_owned(), Json::Array(feed)),
        ("feed_entries".to_owned(), Json::Array(feed_entries)),
        ("revisions".to_owned(), Json::Array(revisions)),
        ("blobs".to_owned(), Json::Array(blobs)),
        ("tree_nodes".to_owned(), Json::Array(tree_nodes)),
        ("blocks".to_owned(), Json::Array(blocks)),
        ("dispositions".to_owned(), Json::Array(dispositions)),
        ("block_changes".to_owned(), Json::Array(block_changes)),
        ("resurrection_pool".to_owned(), Json::Array(pool)),
        ("id_claims".to_owned(), Json::Array(id_claims)),
        ("sections".to_owned(), Json::Array(sections)),
        ("pending_materializations".to_owned(), Json::Array(pending)),
        ("archives".to_owned(), Json::Array(archives)),
    ]
}

// ---- invariants (§8) ---------------------------------------------------------------------

struct Rev {
    rev_id: String,
    doc_id: String,
    seq: i64,
    /// `None` once archived (15.0).
    root_tree: Option<String>,
    frontmatter_blob: Option<String>,
    rendered_hash: Vec<u8>,
    /// The path as of the revision (immutable since 17.0, D11).
    path: String,
    commit_id: String,
    archive: Option<String>,
}

struct Doc {
    doc_id: String,
    path: String,
    head: Option<String>,
    file_hash: Option<Vec<u8>>,
    frontmatter_raw: Option<String>,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
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

/// README §8 I1–I10. `last_source` is the last observed source per live path.
fn check_invariants(
    store: &Store,
    repo_id: &str,
    last_source: &HashMap<String, String>,
) -> Vec<String> {
    let conn = store.conn();
    let mut problems = Vec::new();

    // ---- A1 alerts re-derive (17.0, 3e-ii) ------------------------------------------------
    // An active alert names a condition the store can re-derive, or is
    // advisory: after re-deriving the channel at the runner's clock (as
    // every reader of it does — a superseded pending row leaves the backlog
    // alert stale until then), a `materialization_backlog` alert's
    // `detail.oldest` is the `created_at` of a pending row of the repository
    // and `detail.pending` counts at least one; `materialization_failed` and
    // `writer_refused` are advisory (a past event, cleared by the next
    // success). Every alert has a §2.4 `since` and a known severity.
    match omgbase_store::active_alerts(conn, repo_id, &omgbase_store::time::now_ts()) {
        Err(e) => problems.push(format!("A1: the alert channel cannot be read: {e}")),
        Ok(_) => {
            let active: Vec<(String, String, String, String)> = all_rows(
                conn,
                "SELECT code, severity, since, detail FROM alerts WHERE repo_id = ?1 AND cleared_at IS NULL ORDER BY since, code",
                &[&repo_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            );
            for (code, severity, since, detail) in &active {
                if !is_spec_ts(since) {
                    problems.push(format!(
                        "A1: alert {code} has a malformed since {}",
                        Json::String(since.clone())
                    ));
                }
                if !["info", "warning", "error"].contains(&severity.as_str()) {
                    problems.push(format!(
                        "A1: alert {code} has severity {}",
                        Json::String(severity.clone())
                    ));
                }
                if code == omgbase_store::MATERIALIZATION_BACKLOG_ALERT {
                    let d: Json = serde_json::from_str(detail).unwrap_or(Json::Null);
                    let oldest = d.get("oldest").and_then(Json::as_str);
                    let named = oldest.is_some_and(|o| {
                        conn.query_row(
                            "SELECT 1 FROM pending_materializations WHERE repo_id = ?1 AND created_at = ?2",
                            [&repo_id as &dyn rusqlite::ToSql, &o],
                            |_| Ok(()),
                        )
                        .optional()
                        .ok()
                        .flatten()
                        .is_some()
                    });
                    if !named {
                        problems.push(format!(
                            "A1: materialization_backlog names no pending row at {}",
                            d.get("oldest").cloned().unwrap_or(Json::Null)
                        ));
                    }
                    let pending = d.get("pending").and_then(Json::as_i64);
                    if pending.is_none_or(|n| n < 1) {
                        problems.push(format!(
                            "A1: materialization_backlog counts {} pending rows",
                            d.get("pending").cloned().unwrap_or(Json::Null)
                        ));
                    }
                }
                // 17.4 (§5.11, C9): a `legacy_bytes` alert names the live
                // documents whose rows do not reproduce their `file_hash` —
                // `detail.docs` is their count and every id of `detail.sample`
                // is one of them.
                if code == omgbase_store::legacy_bytes::LEGACY_BYTES_ALERT {
                    let d: Json = serde_json::from_str(detail).unwrap_or(Json::Null);
                    let docs = omgbase_store::legacy_bytes::unreproducible_docs(conn, repo_id)
                        .unwrap_or_default();
                    if d.get("docs").and_then(Json::as_u64) != Some(docs.len() as u64) {
                        problems.push(format!(
                            "A1: legacy_bytes counts {} documents, {} are not reproducible",
                            d.get("docs").cloned().unwrap_or(Json::Null),
                            docs.len()
                        ));
                    }
                    let ids: HashSet<&str> = docs.iter().map(|x| x.doc_id.as_str()).collect();
                    let sample_ok = d.get("sample").and_then(Json::as_array).is_some_and(|s| {
                        s.iter()
                            .all(|id| id.as_str().is_some_and(|id| ids.contains(id)))
                    });
                    if !sample_ok {
                        problems.push(format!(
                            "A1: legacy_bytes sample {} names a reproducible document",
                            d.get("sample").cloned().unwrap_or(Json::Null)
                        ));
                    }
                }
            }
        }
    }

    // ---- the composition and the coverage (README §8, Phase 4a) -------------------------------
    // The history invariants are checked when the store carries the module
    // and the bundle's tables exist (`reader`); within them, what capture
    // promised is bounded by the repository's COVERAGE intervals (§3.1
    // `capabilities.coverage`): a document whose head was minted outside
    // coverage owes no revision (H1/H3 skip it unless the baseline captured
    // it), a feed row outside coverage owes no `commits` row (H4),
    // `commits.seq` is dense only when capture was never off (I4), and the
    // edge record agrees with the open edges only while capture is on (H6).
    // A core-only run checks C*, F* and A1 alone.
    let reader = store.history_reader().ok().flatten().is_some();
    let manifest = read_capability(conn, repo_id, "history").ok().flatten();
    let coverage: Vec<(String, Option<String>)> = manifest
        .as_ref()
        .map(|m| {
            m.coverage
                .iter()
                .map(|i| (i.from.clone(), i.to.clone()))
                .collect()
        })
        .unwrap_or_default();
    let capture_on = manifest
        .as_ref()
        .is_some_and(|m| m.state == omgbase_store::ManifestState::Enabled);
    let in_coverage = |ts: &str| -> bool {
        coverage
            .iter()
            .any(|(from, to)| from.as_str() <= ts && to.as_deref().is_none_or(|t| ts < t))
    };
    let never_off =
        coverage.len() == 1 && coverage[0].1.is_none() && coverage[0].0.as_str() <= FIXTURE_BIRTH;

    let blob_rows: Vec<(Vec<u8>, Vec<u8>, i64)> = if reader {
        all_rows(conn, "SELECT hash, bytes, size FROM blobs", &[], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
    } else {
        Vec::new()
    };
    let blob_hashes: HashSet<String> = blob_rows.iter().map(|b| hex(&b.0)).collect();
    let blob_text: HashMap<String, String> = blob_rows
        .iter()
        .map(|b| (hex(&b.0), String::from_utf8_lossy(&b.1).into_owned()))
        .collect();
    let tree_rows: Vec<(Vec<u8>, String)> = if reader {
        all_rows(conn, "SELECT hash, entries FROM tree_nodes", &[], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
    } else {
        Vec::new()
    };
    let tree_hashes: HashSet<String> = tree_rows.iter().map(|t| hex(&t.0)).collect();
    let node_texts: HashMap<String, &str> = tree_rows
        .iter()
        .map(|t| (hex(&t.0), t.1.as_str()))
        .collect();
    // 16.0: a node is a `[`-form list or a `{"d":…}` delta (§4.1 "Delta nodes").
    let mut nodes: HashMap<String, Node> = HashMap::new();
    let commits: Vec<(String, i64, String)> = if reader {
        all_rows(
            conn,
            "SELECT commit_id, seq, ts FROM commits WHERE repo_id = ?1 ORDER BY ts, seq",
            &[&repo_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
    } else {
        Vec::new()
    };
    let commit_by_id: HashMap<&str, &(String, i64, String)> =
        commits.iter().map(|c| (c.0.as_str(), c)).collect();
    let docs: Vec<Doc> = all_rows(
        conn,
        "SELECT doc_id, path, head, file_hash, frontmatter_raw, created_at, updated_at, deleted_at FROM docs WHERE repo_id = ?1 ORDER BY path",
        &[&repo_id],
        |r| {
            Ok(Doc {
                doc_id: r.get(0)?,
                path: r.get(1)?,
                head: r.get(2)?,
                file_hash: r.get(3)?,
                frontmatter_raw: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                deleted_at: r.get(7)?,
            })
        },
    );
    let revisions: Vec<Rev> = if reader {
        all_rows(
            conn,
            "SELECT r.rev_id, r.doc_id, r.seq, r.root_tree, r.frontmatter_blob, r.rendered_hash, r.path, r.commit_id, r.archive
             FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE d.repo_id = ?1",
            &[&repo_id],
            |r| {
                Ok(Rev {
                    rev_id: r.get(0)?,
                    doc_id: r.get(1)?,
                    seq: r.get(2)?,
                    root_tree: r.get::<_, Option<Vec<u8>>>(3)?.map(|h| hex(&h)),
                    frontmatter_blob: r.get::<_, Option<Vec<u8>>>(4)?.map(|h| hex(&h)),
                    rendered_hash: r.get(5)?,
                    path: r.get(6)?,
                    commit_id: r.get(7)?,
                    archive: r.get(8)?,
                })
            },
        )
    } else {
        Vec::new()
    };
    let rev_by_id: HashMap<&str, &Rev> = revisions.iter().map(|r| (r.rev_id.as_str(), r)).collect();

    // ---- I9 archived revisions (15.0) ----------------------------------------------------
    // `archive IS NOT NULL` ⇔ `root_tree IS NULL`, and an archived revision
    // has no frontmatter blob either: the bodies moved to the segment, the
    // row stayed.
    for r in &revisions {
        if r.archive.is_some() && (r.root_tree.is_some() || r.frontmatter_blob.is_some()) {
            problems.push(format!(
                "I9: archived revision {} still carries a root_tree or frontmatter_blob",
                r.rev_id
            ));
        }
        if r.archive.is_none() && r.root_tree.is_none() {
            problems.push(format!("I9: live revision {} has no root_tree", r.rev_id));
        }
    }

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
        let Some(node) = parse_node_text(entries) else {
            problems.push(format!(
                "I2: tree_node {h} entries do not parse as §4.1 (full or delta)"
            ));
            continue;
        };
        // 16.0: a `{`-node names only its own `+`/`~` entries; the kept ones are the base's.
        let parsed = explicit_entries(&node);
        for e in &parsed {
            if !blob_hashes.contains(&e.raw_hash_hex) {
                problems.push(format!(
                    "I2: tree_node {h} entry {} raw_hash {} not in blobs",
                    e.block_id, e.raw_hash_hex
                ));
            }
            if let Some(t) = &e.trivia_hash_hex
                && !blob_hashes.contains(t)
            {
                problems.push(format!(
                    "I2: tree_node {h} entry {} trivia_hash {t} not in blobs",
                    e.block_id
                ));
            }
            if let Some(c) = &e.child_tree_hash_hex
                && !tree_hashes.contains(c)
            {
                problems.push(format!(
                    "I2: tree_node {h} entry {} child tree {c} not in tree_nodes",
                    e.block_id
                ));
            }
        }
        nodes.insert(h, node);
    }
    for r in &revisions {
        if r.root_tree
            .as_ref()
            .is_some_and(|h| !tree_hashes.contains(h))
        {
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
            } else if blob_text
                .get(fm)
                .is_none_or(|t| parse_frontmatter_blob(t).is_none())
            {
                problems.push(format!(
                    "I2: revision {} frontmatter blob {fm} is neither a raw nor a §4.1 frontmatter delta",
                    r.rev_id
                ));
            }
        }
    }

    // ---- I10 delta nodes (16.0) ----------------------------------------------------------
    // Every live revision's root and frontmatter resolve in context; a
    // delta's previous revision exists and is live; a checkpoint revision is
    // in checkpoint form (a self-contained root, a raw frontmatter); every
    // delta reachable from a live revision is strictly smaller than its full
    // form and is the §4.1 encoding against the predecessor's resolved list.
    let mut resolver = TreeResolver::new(conn);
    let mut resolved_trees: HashMap<String, Rc<ResolvedTree>> = HashMap::new();
    let mut resolved_frontmatter: HashMap<String, String> = HashMap::new();
    for r in &revisions {
        let Some(root_hex) = &r.root_tree else {
            continue;
        };
        let prev = revisions
            .iter()
            .find(|p| p.doc_id == r.doc_id && p.seq == r.seq - 1);
        let root_text = node_texts.get(root_hex.as_str()).copied();
        let fm_text = r
            .frontmatter_blob
            .as_ref()
            .and_then(|h| blob_text.get(h.as_str()).map(String::as_str));
        let root_is_delta = root_text.is_some_and(|t| t.starts_with('{'));
        let fm_is_delta = fm_text.is_some_and(|t| t.starts_with('{'));
        let no_live_base = prev.is_none_or(|p| p.archive.is_some());
        let checkpoint = is_checkpoint_seq(r.seq) || no_live_base;
        if (root_is_delta || fm_is_delta) && no_live_base {
            problems.push(format!(
                "I10: revision {} (seq {}) is a delta but revision {} is {}",
                r.rev_id,
                r.seq,
                r.seq - 1,
                if prev.is_none() {
                    "missing"
                } else {
                    "archived"
                }
            ));
        }
        if checkpoint && fm_is_delta {
            problems.push(format!(
                "I10: checkpoint revision {} (seq {}) has a delta frontmatter",
                r.rev_id, r.seq
            ));
        }
        match resolver.tree(&r.doc_id, r.seq, root_hex) {
            Ok(tree) => {
                if checkpoint && !tree.root.self_contained {
                    problems.push(format!(
                        "I10: checkpoint revision {} (seq {}) root is not self-contained",
                        r.rev_id, r.seq
                    ));
                }
                // The never-larger rule, over every list of the tree.
                let check = |list: &ResolvedList, where_: String, problems: &mut Vec<String>| {
                    if list.form != Form::Delta {
                        return;
                    }
                    let text = node_texts.get(list.hash.as_str()).copied().unwrap_or("");
                    let texts: Vec<String> = list.entries.iter().map(entry_text).collect();
                    let full = full_node_text(&texts);
                    if text.len() >= full.len() {
                        problems.push(format!(
                            "I10: delta node {} ({where_}) is not smaller than its full form ({} >= {})",
                            list.hash,
                            text.len(),
                            full.len()
                        ));
                    }
                };
                check(&tree.root, format!("root of {}", r.rev_id), &mut problems);
                for (block, list) in &tree.by_block {
                    check(
                        list,
                        format!("children of {block} in {}", r.rev_id),
                        &mut problems,
                    );
                }
                // A delta at a non-checkpoint is the Myers script against the base, exactly.
                if let (true, Some(prev_root)) =
                    (root_is_delta, prev.and_then(|p| p.root_tree.as_ref()))
                {
                    match resolver.tree(&r.doc_id, r.seq - 1, prev_root) {
                        Ok(base) => {
                            let want = encode_body_delta(&base.root.texts, &tree.root.texts);
                            if Some(want.as_str()) != root_text {
                                problems.push(format!(
                                    "I10: delta root of {} is not the §4.1 encoding against revision {}",
                                    r.rev_id,
                                    r.seq - 1
                                ));
                            }
                        }
                        Err(e) => problems.push(format!(
                            "I10: base revision {} of {} does not resolve: {e}",
                            r.seq - 1,
                            r.rev_id
                        )),
                    }
                }
                resolved_trees.insert(r.rev_id.clone(), tree);
            }
            Err(e) => problems.push(format!("I10: revision {} does not resolve: {e}", r.rev_id)),
        }
        if let Some(fm_hex) = &r.frontmatter_blob {
            match resolver.frontmatter(&r.doc_id, r.seq, fm_hex) {
                Ok(raw) => {
                    resolved_frontmatter.insert(r.rev_id.clone(), raw.clone());
                    if fm_is_delta && fm_text.is_some_and(|t| t.len() >= raw.len()) {
                        problems.push(format!(
                            "I10: frontmatter delta of {} is not smaller than the raw",
                            r.rev_id
                        ));
                    }
                    if let (true, Some(prev_fm)) =
                        (fm_is_delta, prev.and_then(|p| p.frontmatter_blob.as_ref()))
                    {
                        match resolver.frontmatter(&r.doc_id, r.seq - 1, prev_fm) {
                            Ok(base_raw) => {
                                if Some(encode_frontmatter_delta(&base_raw, &raw).as_str())
                                    != fm_text
                                {
                                    problems.push(format!(
                                        "I10: frontmatter delta of {} is not the §4.1 encoding against revision {}",
                                        r.rev_id,
                                        r.seq - 1
                                    ));
                                }
                            }
                            Err(e) => problems.push(format!(
                                "I10: base frontmatter of {} does not resolve: {e}",
                                r.rev_id
                            )),
                        }
                    }
                }
                Err(e) => problems.push(format!(
                    "I10: frontmatter of {} does not resolve: {e}",
                    r.rev_id
                )),
            }
        }
    }

    // ---- C2 row hashes (17.0): every block's bytes are on its row; C7 the block's clocks ----
    struct BlockStamp {
        block_id: String,
        doc_id: String,
        raw: String,
        raw_hash: Vec<u8>,
        text: String,
        norm_hash: Vec<u8>,
        trivia: Option<String>,
        trivia_hash: Option<Vec<u8>>,
        created_at: String,
        updated_at: String,
        deleted_at: Option<String>,
    }
    let all_blocks: Vec<BlockStamp> = all_rows(
        conn,
        "SELECT b.block_id, b.doc_id, b.raw, b.raw_hash, b.text, b.norm_hash, b.trivia, b.trivia_hash, b.created_at, b.updated_at, b.deleted_at
         FROM blocks b WHERE EXISTS (SELECT 1 FROM docs d WHERE d.doc_id = b.doc_id AND d.repo_id = ?1)",
        &[&repo_id],
        |r| {
            Ok(BlockStamp {
                block_id: r.get(0)?,
                doc_id: r.get(1)?,
                raw: r.get(2)?,
                raw_hash: r.get(3)?,
                text: r.get(4)?,
                norm_hash: r.get(5)?,
                trivia: r.get(6)?,
                trivia_hash: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
                deleted_at: r.get(10)?,
            })
        },
    );
    for b in &all_blocks {
        if sha256(b.raw.as_bytes())[..] != b.raw_hash[..] {
            problems.push(format!("C2: block {} raw_hash != sha256(raw)", b.block_id));
        }
        match (&b.trivia, &b.trivia_hash) {
            (None, None) => {}
            (Some(t), Some(h)) => {
                if sha256(t.as_bytes())[..] != h[..] {
                    problems.push(format!(
                        "C2: block {} trivia_hash != sha256(trivia)",
                        b.block_id
                    ));
                }
            }
            _ => problems.push(format!(
                "C2: block {} trivia and trivia_hash disagree on NULL",
                b.block_id
            )),
        }
        if b.trivia.as_deref() == Some("") {
            problems.push(format!(
                "C2: block {} has an empty trivia instead of NULL",
                b.block_id
            ));
        }
        if sha256(b.text.as_bytes())[..] != b.norm_hash[..] {
            problems.push(format!(
                "C2: block {} norm_hash != sha256(text)",
                b.block_id
            ));
        }
        // C7: a block's timestamps are ordered and bounded by its document's.
        if b.created_at > b.updated_at {
            problems.push(format!(
                "C7: block {} created_at {} > updated_at {}",
                b.block_id, b.created_at, b.updated_at
            ));
        }
    }
    let doc_by_id: HashMap<&str, &Doc> = docs.iter().map(|d| (d.doc_id.as_str(), d)).collect();
    for b in &all_blocks {
        let Some(d) = doc_by_id.get(b.doc_id.as_str()) else {
            continue;
        };
        if d.deleted_at.is_none() && b.deleted_at.is_some() {
            problems.push(format!(
                "C7: live doc {} has a tombstoned block {}",
                d.doc_id, b.block_id
            ));
        }
        if d.deleted_at.is_some() && b.deleted_at.is_none() {
            problems.push(format!(
                "C7: tombstoned doc {} has a live block {}",
                d.doc_id, b.block_id
            ));
        }
        if b.updated_at > d.updated_at {
            problems.push(format!(
                "C7: block {} updated_at {} > its document's {}",
                b.block_id, b.updated_at, d.updated_at
            ));
        }
    }

    // ---- C4 the head, C7 the document's timestamps -----------------------------------------
    for d in &docs {
        if d.created_at > d.updated_at {
            problems.push(format!(
                "C7: doc {} created_at {} > updated_at {}",
                d.doc_id, d.created_at, d.updated_at
            ));
        }
        if d.deleted_at.is_none() && d.head.is_none() {
            problems.push(format!(
                "C4: live doc {} ({}) has no head",
                d.doc_id, d.path
            ));
        }
        if let Some(deleted_at) = &d.deleted_at
            && *deleted_at != d.updated_at
        {
            problems.push(format!(
                "C7: tombstoned doc {} deleted_at {deleted_at} != updated_at {}",
                d.doc_id, d.updated_at
            ));
        }
    }

    // ---- C4 the dense feed, F1–F3 the entries, H4 the log's agreement (17.0, 3d) ----------
    let epoch: Option<String> = conn
        .query_row(
            "SELECT epoch FROM repos WHERE repo_id = ?1",
            params![repo_id],
            |r| r.get(0),
        )
        .optional()
        .expect("query runs");
    if !epoch.as_deref().is_some_and(|e| e.starts_with("ep_")) {
        problems.push(format!(
            "C4: repo {repo_id} has no ep_ epoch ({})",
            epoch.as_deref().unwrap_or("undefined")
        ));
    }
    let epoch = epoch.unwrap_or_default();
    type FeedRowT = (String, i64, String, String, String, String, Option<String>);
    let feed_rows: Vec<FeedRowT> = all_rows(
        conn,
        "SELECT epoch, seq, commit_id, ts, origin, batch_id, plan_id FROM feed WHERE repo_id = ?1 ORDER BY ts, seq",
        &[&repo_id],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        },
    );
    let mut feed_by_seq: Vec<&FeedRowT> = feed_rows.iter().collect();
    feed_by_seq.sort_by_key(|r| r.1);
    let oldest = feed_by_seq.first().map_or(0, |r| r.1);
    let head_seq = feed_by_seq.last().map_or(0, |r| r.1);
    if oldest > head_seq {
        problems.push(format!("F2: feed oldest {oldest} > head {head_seq}"));
    }
    if (oldest == 0) != (head_seq == 0) {
        problems.push(format!(
            "F2: feed oldest {oldest} and head {head_seq} disagree on emptiness"
        ));
    }
    for (i, r) in feed_rows.iter().enumerate() {
        let (r_epoch, seq, commit_id, ts, origin, batch_id, plan_id) = r;
        if *seq != oldest + i as i64 {
            problems.push(format!(
                "C4: feed row {commit_id} has seq {seq} at position {i} of (ts, seq) order from oldest {oldest} (the feed is not contiguous)"
            ));
        }
        if *r_epoch != epoch {
            problems.push(format!(
                "C4: feed row {commit_id} carries epoch {r_epoch}, the repo's is {epoch}"
            ));
        }
        if !is_spec_ts(ts) {
            problems.push(format!(
                "C4: feed row {commit_id} ts {ts} is not a §2.4 timestamp"
            ));
        }
        if !commit_id.starts_with("c_") {
            problems.push(format!(
                "C4: feed row seq {seq} commit_id {commit_id} is not a c_ id"
            ));
        }
        if !batch_id.starts_with("c_") {
            problems.push(format!(
                "C4: feed row {commit_id} batch_id {batch_id} is not a c_ id"
            ));
        }
        // The batch id names a feed row of the same epoch at or before this
        // one (D4: the first committing member), unless pruned.
        let batch_row = feed_by_seq.iter().find(|b| b.2 == *batch_id);
        match batch_row {
            Some(b) if b.1 > *seq => problems.push(format!(
                "C4: feed row {commit_id} (seq {seq}) names a later batch {batch_id} (seq {})",
                b.1
            )),
            None if batch_id != commit_id && oldest <= 1 => problems.push(format!(
                "C4: feed row {commit_id} names a batch {batch_id} the feed does not hold"
            )),
            _ => {}
        }
        if let Some(p) = plan_id {
            if p.len() != 64
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                problems.push(format!(
                    "C4: feed row {commit_id} plan_id {p} is not 64 hex"
                ));
            }
            if origin != "api" {
                problems.push(format!(
                    "C4: feed row {commit_id} of origin {origin} carries a plan_id"
                ));
            }
        }
    }
    type EntryT = (
        String,
        i64,
        String,
        String,
        Option<String>,
        Option<Vec<u8>>,
        String,
        Option<String>,
    );
    let entries: Vec<EntryT> = all_rows(
        conn,
        "SELECT epoch, seq, doc_id, path, head, hash, kind, from_path FROM feed_entries WHERE repo_id = ?1 ORDER BY seq, rowid",
        &[&repo_id],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
            ))
        },
    );
    let feed_seqs: HashSet<i64> = feed_by_seq.iter().map(|r| r.1).collect();
    let doc_ids_known: HashSet<&str> = docs.iter().map(|d| d.doc_id.as_str()).collect();
    let mut last_kind_of_doc: HashMap<&str, &str> = HashMap::new();
    for (e_epoch, seq, doc_id, path, head, hash, kind, from_path) in &entries {
        let at = format!("feed entry ({seq}, {doc_id})");
        if !feed_seqs.contains(seq) {
            problems.push(format!("F1: {at} has no feed row"));
        }
        if *e_epoch != epoch {
            problems.push(format!("F1: {at} carries epoch {e_epoch}"));
        }
        if !doc_ids_known.contains(doc_id.as_str()) {
            problems.push(format!("F1: {at} names no docs row"));
        }
        if kind == "deleted" {
            if head.is_some() || hash.is_some() {
                problems.push(format!("F3: {at} is deleted but carries a head or a hash"));
            }
        } else {
            if head.is_none() || hash.is_none() {
                problems.push(format!("F3: {at} ({kind}) lacks a head or a hash"));
            }
            if let Some(h) = head
                && !h.starts_with("r_")
            {
                problems.push(format!("F3: {at} head {h} is not an r_ id"));
            }
        }
        if (kind == "moved") != from_path.is_some() {
            problems.push(format!(
                "F3: {at} from_path {} disagrees with kind {kind}",
                from_path.as_deref().unwrap_or("null")
            ));
        }
        if kind == "moved" && from_path.as_deref() == Some(path.as_str()) {
            problems.push(format!("F3: {at} moved from its own path {path}"));
        }
        // The kinds in sequence per document (over the retained feed): a
        // `created` follows nothing or a `deleted`; a `changed`/`moved` never
        // follows a `deleted`.
        let prev = last_kind_of_doc.get(doc_id.as_str()).copied();
        if kind == "created"
            && let Some(prev) = prev
            && prev != "deleted"
        {
            problems.push(format!(
                "F3: {at} is created but the document's previous entry is {prev}"
            ));
        }
        if (kind == "changed" || kind == "moved") && prev == Some("deleted") {
            problems.push(format!(
                "F3: {at} is {kind} right after a deleted entry (a revival is created)"
            ));
        }
        last_kind_of_doc.insert(doc_id.as_str(), kind.as_str());
    }
    // F1: every head still within the retained feed has its entry: every live
    // doc's head and every tombstone's deletion whose last change is not older
    // than the oldest retained row (a prune takes rows from the front; an epoch
    // re-mint, §7.5, empties the feed — the documents committed before it have
    // no entry and none is owed).
    let oldest_ts: Option<&str> = feed_by_seq.first().map(|r| r.3.as_str());
    let heads_in_feed: HashSet<&str> = entries.iter().filter_map(|e| e.4.as_deref()).collect();
    let deleted_in_feed: HashSet<&str> = entries
        .iter()
        .filter(|e| e.6 == "deleted")
        .map(|e| e.2.as_str())
        .collect();
    for d in &docs {
        let within = oldest_ts.is_some_and(|t| d.updated_at.as_str() >= t);
        if !within {
            continue;
        }
        if d.deleted_at.is_none()
            && let Some(head) = &d.head
            && !heads_in_feed.contains(head.as_str())
        {
            problems.push(format!(
                "F1: live doc {} ({}) head {head} appears in no feed entry",
                d.doc_id, d.path
            ));
        }
        if d.deleted_at.is_some() && !deleted_in_feed.contains(d.doc_id.as_str()) {
            problems.push(format!(
                "F1: tombstoned doc {} ({}) has no deleted entry",
                d.doc_id, d.path
            ));
        }
        // C7: the document's updated_at is the ts of the feed row whose entry
        // carries its head.
        if d.deleted_at.is_none()
            && let Some(head) = &d.head
            && let Some(e) = entries
                .iter()
                .find(|e| e.4.as_deref() == Some(head.as_str()))
            && let Some(row) = feed_by_seq.iter().find(|r| r.1 == e.1)
            && row.3 != d.updated_at
        {
            problems.push(format!(
                "C7: doc {} updated_at {} != the ts {} of the feed row carrying its head",
                d.doc_id, d.updated_at, row.3
            ));
        }
    }
    // H4: the recorder's `commits` agree with the feed on every retained seq
    // WITHIN COVERAGE (Phase 4a: a feed row written while capture was off has
    // no log row) and AT OR AFTER THE LOG'S OLDEST ROW of the epoch (Phase 4b:
    // a `history purge` trims the log's head — a feed row older than every
    // retained commit owes none; a repository with no commit owes none), and
    // every log row of the current epoch at or after the oldest retained feed
    // row IS a feed row (the log is a subsequence of the feed).
    let commit_rows: Vec<(String, String, i64, String)> = if reader {
        all_rows(
            conn,
            "SELECT commit_id, epoch, seq, batch_id FROM commits WHERE repo_id = ?1 ORDER BY seq",
            &[&repo_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
    } else {
        Vec::new()
    };
    let commit_by_seq: HashMap<i64, &(String, String, i64, String)> = commit_rows
        .iter()
        .filter(|c| c.1 == epoch)
        .map(|c| (c.2, c))
        .collect();
    let oldest_log_seq = commit_by_seq.keys().copied().min().unwrap_or(i64::MAX);
    for r in &feed_by_seq {
        match commit_by_seq.get(&r.1) {
            None => {
                if reader && in_coverage(&r.3) && r.1 >= oldest_log_seq {
                    problems.push(format!(
                        "H4: feed row {} (seq {}) has no commits row",
                        r.2, r.1
                    ));
                }
            }
            Some(c) if c.0 != r.2 || c.1 != r.0 || c.3 != r.5 => problems.push(format!(
                "H4: commits row at seq {} ({}, {}, {}) disagrees with the feed ({}, {}, {})",
                r.1, c.0, c.1, c.3, r.2, r.0, r.5
            )),
            Some(_) => {}
        }
    }
    let feed_commits: HashSet<&str> = feed_by_seq.iter().map(|r| r.2.as_str()).collect();
    for c in &commit_rows {
        if c.1 == epoch && c.2 >= oldest && !feed_commits.contains(c.0.as_str()) {
            problems.push(format!(
                "H4: commits row {} (seq {}) is within the retained feed but has no feed row",
                c.0, c.2
            ));
        }
    }
    // A commit of an earlier epoch is a re-mint's (§7.5): its epoch must still
    // be a claimed `ep` of the repository.
    let epoch_claimed = |ep: &str| -> bool {
        conn.query_row(
            "SELECT 1 FROM id_claims WHERE id = ?1 AND prefix = 'ep' AND repo_id = ?2",
            params![ep, repo_id],
            |_| Ok(()),
        )
        .optional()
        .expect("query runs")
        .is_some()
    };
    for c in &commit_rows {
        if c.1 != epoch && !epoch_claimed(&c.1) {
            problems.push(format!(
                "H4: commit {} carries epoch {}, which is neither the repository's nor a claimed earlier one",
                c.0, c.1
            ));
        }
    }

    // ---- C8 pending rows (17.0, M4): self-contained against the current rows ----------------
    // A `write`/`rename` row names a live document's current head and the
    // bytes that head renders to (`rendered_hash == docs.file_hash ==
    // sha256(reconstruct)`); a `remove` row names a tombstoned document, no
    // head, no prior, the bytes it owes an unlink (`docs.file_hash` before the
    // tombstone). `prior_hash` is defined, not derivable (the bytes it names
    // left the store), so only its nullness is checked. Kind and `from_path`
    // agree; `commit_id` is a `c_` id and, with capture on, a `commits` row
    // whose `ts` is `created_at`.
    type PendingRowT = (
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        Vec<u8>,
        Option<Vec<u8>>,
        String,
        String,
    );
    let pending_rows: Vec<PendingRowT> = all_rows(
        conn,
        "SELECT path, kind, from_path, doc_id, head, rendered_hash, prior_hash, commit_id, created_at FROM pending_materializations WHERE repo_id = ?1 ORDER BY path",
        &[&repo_id],
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
            ))
        },
    );
    for (path, kind, from_path, doc_id, head, rendered_hash, prior_hash, commit_id, created_at) in
        &pending_rows
    {
        let at = format!("pending {kind} at {path}");
        let Some(d) = doc_by_id.get(doc_id.as_str()) else {
            problems.push(format!("C8: {at} names no docs row ({doc_id})"));
            continue;
        };
        if (kind == "rename") != from_path.is_some() {
            problems.push(format!(
                "C8: {at} from_path {from_path:?} disagrees with its kind"
            ));
        }
        if !is_spec_ts(created_at) {
            problems.push(format!(
                "C8: {at} created_at {created_at} is not a §2.4 timestamp"
            ));
        }
        if !commit_id.starts_with("c_") {
            problems.push(format!("C8: {at} commit_id {commit_id} is not a c_ id"));
        }
        if let Some((_, _, ts)) = commit_by_id.get(commit_id.as_str())
            && ts != created_at
        {
            problems.push(format!(
                "C8: {at} created_at {created_at} != its commit's ts {ts}"
            ));
        }
        if kind == "remove" {
            if let Some(head) = head {
                problems.push(format!("C8: {at} carries a head ({head})"));
            }
            if prior_hash.is_some() {
                problems.push(format!("C8: {at} carries a prior_hash"));
            }
            if d.deleted_at.is_none() {
                problems.push(format!("C8: {at} names a live document"));
            }
            if let Some(file_hash) = &d.file_hash
                && file_hash[..] != rendered_hash[..]
            {
                problems.push(format!(
                    "C8: {at} rendered_hash != the tombstoned document's file_hash"
                ));
            }
            continue;
        }
        if d.deleted_at.is_some() {
            problems.push(format!("C8: {at} names a tombstoned document"));
        }
        if head.is_none() || *head != d.head {
            problems.push(format!("C8: {at} head {head:?} != docs.head {:?}", d.head));
        }
        if d.file_hash.as_deref() != Some(&rendered_hash[..]) {
            problems.push(format!("C8: {at} rendered_hash != docs.file_hash"));
        }
        let bytes = store.reconstruct(doc_id).ok().flatten();
        if bytes.is_none_or(|b| sha256(b.as_bytes())[..] != rendered_hash[..]) {
            problems.push(format!(
                "C8: {at} reconstruct(doc) does not hash to rendered_hash"
            ));
        }
    }

    // ---- C9 bytes reproducible, or named (17.4, §5.11) --------------------------------------
    // Every live document's rows reproduce its `file_hash`, or the repository's
    // active `legacy_bytes` alert names it (A1 above checks the count and sample).
    let unreproducible =
        omgbase_store::legacy_bytes::unreproducible_docs(conn, repo_id).unwrap_or_default();
    let legacy_active =
        omgbase_store::legacy_bytes::legacy_bytes_active(conn, repo_id).unwrap_or(false);
    if !unreproducible.is_empty() && !legacy_active {
        problems.push(format!(
            "C9: {} live document(s) do not reproduce their file_hash and no legacy_bytes alert names them: {}",
            unreproducible.len(),
            unreproducible
                .iter()
                .map(|d| d.path.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    // A document the active alert names is a LEGACY document until the sweep
    // repairs it (§5.11): C1's reconstruct clause is what C9 relaxes for it,
    // and H3's trivia clause is not owed — its capture is the 16.x one. (The
    // fixtures reach the state through the `sql` device, which erases the
    // rows' separators and leaves the recorder's tree whole; on a real legacy
    // document the tree names no trivia either.)
    let legacy_named: HashSet<&str> = if legacy_active {
        unreproducible.iter().map(|d| d.doc_id.as_str()).collect()
    } else {
        HashSet::new()
    };

    // ---- C1 convergence from the rows; H1/H3 the recorder's capture agrees with the head ----
    for d in &docs {
        let (Some(head), None) = (&d.head, &d.deleted_at) else {
            continue;
        };
        let at = format!("doc {} ({})", d.doc_id, d.path);
        let source = last_source.get(&d.path);
        match source {
            None => problems.push(format!(
                "C1: {at} is live but no source was observed for its path"
            )),
            Some(source) => {
                let want = sha256(source.as_bytes());
                if d.file_hash.as_deref() != Some(&want[..]) {
                    problems.push(format!("C1: {at} file_hash != sha256(source)"));
                }
                if !legacy_named.contains(d.doc_id.as_str())
                    && store.reconstruct(&d.doc_id).ok().flatten().as_deref()
                        != Some(source.as_str())
                {
                    problems.push(format!("C1: {at} reconstruct(doc) != source"));
                }
            }
        }
        // H1: with capture on, the head IS a captured revision — same path,
        // same bytes, the same commit instant as `updated_at` — and
        // reconstruct at it reproduces the source. Phase 4a: owed only for a
        // head minted within coverage (a head minted while capture was off
        // has a row only when the baseline of a later `history enable` wrote
        // one — then the row's commit is the baseline's, not the head's, so
        // the instant is not compared); without the module nothing is owed.
        let Some(rev) = rev_by_id.get(head.as_str()) else {
            if reader && in_coverage(&d.updated_at) {
                problems.push(format!(
                    "H1: {at} head {head} has no revisions row (capture disagrees with the head)"
                ));
            }
            continue;
        };
        let Some(root_tree) = rev.root_tree.as_deref() else {
            problems.push(format!("H1: {at} head {head} is archived (never prunable)"));
            continue;
        };
        if rev.path != d.path {
            problems.push(format!(
                "H1: {at} revision {head} carries path {}",
                rev.path
            ));
        }
        if let Some(file_hash) = &d.file_hash
            && rev.rendered_hash[..] != file_hash[..]
        {
            problems.push(format!(
                "H1: {at} revision {head} rendered_hash != file_hash"
            ));
        }
        if let Some((_, _, ts)) = commit_by_id.get(rev.commit_id.as_str())
            && in_coverage(&d.updated_at)
            && *ts != d.updated_at
        {
            problems.push(format!(
                "C7: {at} updated_at {} != the head commit's ts {ts}",
                d.updated_at
            ));
        }
        if let Some(source) = source {
            match store.read_at_revision(&d.doc_id, head).ok().flatten() {
                None => problems.push(format!("H1: {at} reconstruct at {head} returned nothing")),
                Some(read) => {
                    if read.content != *source {
                        problems.push(format!("H1: {at} reconstruct at {head} != source"));
                    }
                    if !read.rendered_hash_match {
                        problems.push(format!(
                            "H1: {at} rendered_hash_match is false at the current revision"
                        ));
                    }
                }
            }
        }
        // H3 (frontmatter): the row's current frontmatter equals the head
        // revision's resolved one.
        let fm_resolved = match &rev.frontmatter_blob {
            Some(_) => resolved_frontmatter.get(rev.rev_id.as_str()).cloned(),
            None => None,
        };
        if fm_resolved != d.frontmatter_raw {
            problems.push(format!(
                "H3: {at} frontmatter_raw differs from the head revision's resolved frontmatter"
            ));
        }

        // H3: live rows as a tree vs the head revision's resolved Merkle tree.
        let live = query_rows(
            conn,
            &format!("SELECT {BLOCK_COLUMNS} FROM blocks WHERE doc_id = ?1 AND deleted_at IS NULL"),
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
                    "C3: {at} live rows name a parent {parent} that is not live"
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
            resolved: &ResolvedTree,
            legacy: bool,
            problems: &mut Vec<String>,
        ) {
            let parent_id = parent.map(|p| str_of(p, "block_id").to_owned());
            let rows = children.get(&parent_id).map_or(&[][..], Vec::as_slice);
            // 16.0: the tree compared is the head revision's RESOLVED tree.
            let empty: Vec<TreeEntry> = Vec::new();
            let entries: &[TreeEntry] = match (tree_hex, &parent_id) {
                (None, _) => &empty,
                (Some(_), None) => &resolved.root.entries,
                (Some(_), Some(p)) => resolved
                    .by_block
                    .get(p)
                    .map_or(&empty[..], |l| &l.entries[..]),
            };
            let where_ = match &parent_id {
                Some(p) => format!("{at} under {p}"),
                None => format!("{at} top level"),
            };
            if rows.len() != entries.len() {
                problems.push(format!(
                    "H3: {where_}: {} live rows vs {} tree entries",
                    rows.len(),
                    entries.len()
                ));
                return;
            }
            for (i, (r, e)) in rows.iter().zip(entries).enumerate() {
                if str_of(r, "block_id") != e.block_id {
                    problems.push(format!(
                        "H3: {where_}[{i}]: block {} vs tree entry {}",
                        str_of(r, "block_id"),
                        e.block_id
                    ));
                }
                if str_of(r, "type") != e.kind {
                    problems.push(format!(
                        "H3: {where_}[{i}]: type {} vs {}",
                        str_of(r, "type"),
                        e.kind
                    ));
                }
                if str_of(r, "raw_hash") != e.raw_hash_hex {
                    problems.push(format!(
                        "H3: {where_}[{i}]: raw_hash differs from the tree entry"
                    ));
                }
                if !legacy && r["trivia_hash"].as_str() != e.trivia_hash_hex.as_deref() {
                    problems.push(format!(
                        "H3: {where_}[{i}]: trivia_hash differs from the tree entry"
                    ));
                }
                if int_of(r, "ordinal") != i as i64 {
                    problems.push(format!(
                        "C3: {where_}[{i}]: ordinal {} (order_key order says {i})",
                        int_of(r, "ordinal")
                    ));
                }
                if int_of(r, "depth") != depth {
                    problems.push(format!(
                        "C3: {where_}[{i}]: depth {} != {depth}",
                        int_of(r, "depth")
                    ));
                }
                if str_of(r, "ancestor_path") != ancestor_path {
                    problems.push(format!(
                        "C3: {where_}[{i}]: ancestor_path {} != {ancestor_path}",
                        str_of(r, "ancestor_path")
                    ));
                }
                let attrs: Json = serde_json::from_str(str_of(r, "attrs")).unwrap_or(Json::Null);
                if let Some(diff) = deep_eq_tol(&attrs, &e.attrs, "attrs", 0.0) {
                    problems.push(format!(
                        "H3: {where_}[{i}]: attrs differ from the tree entry ({diff})"
                    ));
                }
                compare(
                    e.child_tree_hash_hex.as_deref(),
                    Some(r),
                    depth + 1,
                    &format!("{ancestor_path}{}/", str_of(r, "block_id")),
                    at,
                    children,
                    resolved,
                    legacy,
                    problems,
                );
            }
        }
        let Some(resolved) = resolved_trees.get(rev.rev_id.as_str()) else {
            problems.push(format!(
                "H3: {at} head revision {} did not resolve",
                rev.rev_id
            ));
            continue;
        };
        compare(
            Some(root_tree),
            None,
            0,
            "/",
            &at,
            &children,
            resolved,
            legacy_named.contains(d.doc_id.as_str()),
            &mut problems,
        );
    }

    // ---- I4 sequences (per epoch since 17.0: a re-mint restarts the seq) -----------------
    // `commits.seq` is strictly increasing in (ts, seq) order per epoch, and
    // dense from the oldest retained row when capture was never off (Phase 4a:
    // a disabled interval leaves the feed's seqs of that span out of the log;
    // Phase 4b: a purge trims the log's head, so the run starts where the log
    // does).
    type EpochCommit = (String, i64, String);
    let commits_by_epoch: Vec<EpochCommit> = if reader {
        all_rows(
            conn,
            "SELECT commit_id, seq, epoch FROM commits WHERE repo_id = ?1 ORDER BY ts, seq",
            &[&repo_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
    } else {
        Vec::new()
    };
    let mut per_epoch: Vec<(String, Vec<&EpochCommit>)> = Vec::new();
    for c in &commits_by_epoch {
        match per_epoch.iter_mut().find(|(ep, _)| *ep == c.2) {
            Some((_, list)) => list.push(c),
            None => per_epoch.push((c.2.clone(), vec![c])),
        }
    }
    for (ep, list) in &per_epoch {
        for (i, (commit_id, seq, _)) in list.iter().enumerate() {
            if never_off && *seq != list[0].1 + i as i64 {
                problems.push(format!(
                    "I4: commit {commit_id} has seq {seq} at position {} in (ts, seq) order of epoch {ep} (the log begins at seq {})",
                    i + 1,
                    list[0].1
                ));
            }
            if i > 0 && *seq <= list[i - 1].1 {
                problems.push(format!(
                    "I4: commit {commit_id} has seq {seq} after seq {} in (ts, seq) order of epoch {ep}",
                    list[i - 1].1
                ));
            }
        }
    }
    for d in &docs {
        let mut revs: Vec<&Rev> = revisions.iter().filter(|r| r.doc_id == d.doc_id).collect();
        revs.sort_by_key(|r| r.seq);
        // Per document the retained revisions' seqs are consecutive; they
        // begin at 1 unless a purge trimmed the document's history (Phase 4b).
        let first_seq = revs.first().map_or(1, |r| r.seq);
        for (i, r) in revs.iter().enumerate() {
            if r.seq != first_seq + i as i64 {
                problems.push(format!(
                    "I4: revision {} of {} has seq {}, expected {}",
                    r.rev_id,
                    d.doc_id,
                    r.seq,
                    first_seq + i as i64
                ));
            }
        }
        // Phase 4a: a head minted while capture was off is newer than every
        // captured revision (until a baseline captures it).
        match revs.last() {
            Some(last)
                if d.deleted_at.is_none()
                    && in_coverage(&d.updated_at)
                    && d.head.as_deref() != Some(last.rev_id.as_str()) =>
            {
                problems.push(format!(
                    "I4: doc {} head {:?} is not its greatest-seq revision",
                    d.doc_id, d.head
                ));
            }
            None if d.head.is_some() && reader && in_coverage(&d.updated_at) => {
                problems.push(format!("I4: doc {} has head but no revisions", d.doc_id));
            }
            _ => {}
        }
    }

    // ---- I5 nothing to collect ------------------------------------------------------------
    // 15.0: the mark walks the LIVE revisions; an archived one's bodies are its segment's.
    let mut marked_trees: HashSet<String> = HashSet::new();
    let mut marked_blobs: HashSet<String> = HashSet::new();
    let mut stack: Vec<String> = revisions
        .iter()
        .filter_map(|r| r.root_tree.clone())
        .collect();
    for r in &revisions {
        if let Some(fm) = &r.frontmatter_blob {
            marked_blobs.insert(fm.clone());
        }
    }
    while let Some(h) = stack.pop() {
        if !marked_trees.insert(h.clone()) {
            continue;
        }
        // 16.0: the EXPLICIT mark — a node marks the entries its own text
        // carries (all of a `[`-node's, the `+`/`~` of a `{`-node); the kept
        // entries are the base revision's to mark, and I10 says the base is live.
        for e in nodes.get(&h).map(explicit_entries).unwrap_or_default() {
            marked_blobs.insert(e.raw_hash_hex);
            if let Some(t) = e.trivia_hash_hex {
                marked_blobs.insert(t);
            }
            if let Some(c) = e.child_tree_hash_hex {
                stack.push(c);
            }
        }
    }
    for h in &tree_hashes {
        if !marked_trees.contains(h) {
            problems.push(format!(
                "I5: tree_node {h} is unreachable from every live revision"
            ));
        }
    }
    for h in &blob_hashes {
        if !marked_blobs.contains(h) {
            problems.push(format!(
                "I5: blob {h} is unreachable from every live revision"
            ));
        }
    }
    if let Ok(dry) = store.gc_dry_run()
        && (dry.blobs_swept != 0 || dry.tree_nodes_swept != 0)
    {
        problems.push(format!(
            "I5: the implementation's GC would sweep {} blobs and {} tree nodes",
            dry.blobs_swept, dry.tree_nodes_swept
        ));
    }

    // ---- C6 pool (17.0; I6 restated over the row's own `deleted_at`) -----------------------
    let live_doc_of = |block_id: &str| -> Option<String> {
        conn.query_row(
            "SELECT doc_id FROM blocks WHERE block_id = ?1 AND deleted_at IS NULL",
            params![block_id],
            |r| r.get(0),
        )
        .optional()
        .expect("query runs")
    };
    let pool: Vec<(String, String, String, String)> = all_rows(
        conn,
        "SELECT block_id, created_at, deleted_at, expires_ts FROM resurrection_pool WHERE repo_id = ?1",
        &[&repo_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    );
    for (block_id, created_at, deleted_at, expires_ts) in &pool {
        if !is_spec_ts(deleted_at) {
            problems.push(format!(
                "C6: pool row {block_id} deleted_at {deleted_at} is not a §2.4 timestamp"
            ));
        }
        let want = omgbase_store::time::pool_expiry(deleted_at).unwrap_or_default();
        if *expires_ts != want {
            problems.push(format!(
                "C6: pool row {block_id} expires_ts {expires_ts} != deleted_at {deleted_at} + 30 days"
            ));
        }
        if created_at > deleted_at {
            problems.push(format!(
                "C6: pool row {block_id} created_at {created_at} > deleted_at {deleted_at}"
            ));
        }
        if live_doc_of(block_id).is_some() {
            problems.push(format!("C6: pool row {block_id} has a live blocks row"));
        }
    }

    // ---- C5 claims (17.0, §2.1) -------------------------------------------------------------
    // Every id a core row of the repo carries names an `id_claims` row with the
    // core's bit; a pool id is claimed; no claim has `holders = 0`; H6 — every
    // id a history row names has the recorder's bit.
    let claim_of = |id: &str| -> Option<i64> {
        conn.query_row(
            "SELECT holders FROM id_claims WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .expect("query runs")
    };
    let mut core_ids: Vec<(&str, String)> = Vec::new();
    for d in &docs {
        core_ids.push(("d", d.doc_id.clone()));
        if let Some(head) = &d.head {
            core_ids.push(("r", head.clone()));
        }
    }
    for block_id in all_rows(
        conn,
        "SELECT b.block_id FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE d.repo_id = ?1",
        &[&repo_id],
        |r| r.get::<_, String>(0),
    ) {
        core_ids.push(("b", block_id));
    }
    for (block_id, ..) in &pool {
        core_ids.push(("b", block_id.clone()));
    }
    for node_id in all_rows(
        conn,
        "SELECT node_id FROM external_nodes WHERE repo_id = ?1",
        &[&repo_id],
        |r| r.get::<_, String>(0),
    ) {
        core_ids.push(("x", node_id));
    }
    for edge_id in all_rows(
        conn,
        "SELECT edge_id FROM edges WHERE repo_id = ?1",
        &[&repo_id],
        |r| r.get::<_, String>(0),
    ) {
        core_ids.push(("e", edge_id));
    }
    core_ids.push(("rp", repo_id.to_owned()));
    // 17.0 (3d): the epoch, every retained feed row's commit and batch, every
    // retained entry's head.
    if !epoch.is_empty() {
        core_ids.push(("ep", epoch.clone()));
    }
    for r in &feed_by_seq {
        core_ids.push(("c", r.2.clone()));
        core_ids.push(("c", r.5.clone()));
    }
    for e in &entries {
        if let Some(h) = &e.4 {
            core_ids.push(("r", h.clone()));
        }
    }
    for (prefix, id) in &core_ids {
        match claim_of(id) {
            None => problems.push(format!(
                "C5: {prefix} {id} names a core row but has no id_claims row"
            )),
            Some(holders) if holders & 1 == 0 => problems.push(format!(
                "C5: claim {id} ({prefix}) lacks the core's bit (holders {holders})"
            )),
            Some(_) => {}
        }
    }
    let claims: Vec<(String, String, i64, String)> = all_rows(
        conn,
        "SELECT id, prefix, holders, minted_at FROM id_claims WHERE repo_id = ?1",
        &[&repo_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    );
    for (id, prefix, holders, minted_at) in &claims {
        if *holders == 0 {
            problems.push(format!("C5: claim {id} has holders = 0"));
        }
        if !id.starts_with(&format!("{prefix}_")) {
            problems.push(format!("C5: claim {id} is filed under prefix {prefix}"));
        }
        if !is_spec_ts(minted_at) {
            problems.push(format!(
                "C5: claim {id} minted_at {minted_at} is not a §2.4 timestamp"
            ));
        }
    }
    let unheld: Vec<String> = if !reader {
        Vec::new()
    } else {
        all_rows(
        conn,
        "SELECT DISTINCT bc.block_id AS id FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE c.repo_id = ?1 AND bc.block_id != 'DOC'
           AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = bc.block_id AND (ic.holders & 2) != 0)
         UNION SELECT r.rev_id FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE d.repo_id = ?1
           AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = r.rev_id AND (ic.holders & 2) != 0)
         UNION SELECT DISTINCT r.doc_id FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE d.repo_id = ?1
           AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = r.doc_id AND (ic.holders & 2) != 0)
         UNION SELECT c.commit_id FROM commits c WHERE c.repo_id = ?1
           AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = c.commit_id AND (ic.holders & 2) != 0)
         UNION SELECT t.edge_id FROM edge_transitions t WHERE t.repo_id = ?1
           AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = t.edge_id AND (ic.holders & 2) != 0)
         ORDER BY 1",
        &[&repo_id],
        |r| r.get(0),
    )
    };
    for id in unheld {
        problems.push(format!(
            "H6: {id} is named by a history row but its claim lacks the recorder's bit"
        ));
    }
    // Without the module nothing below applies: the dispositions, the
    // projection and the archive rule are the recorder's.
    if !reader {
        return problems;
    }
    // H6 (17.0, M6): the open transitions and the edges agree — same ids,
    // same destination — while capture is on (Phase 4a: the edges move freely
    // while it is off; the baseline of the next `history enable` reconciles them).
    if capture_on {
        for id in all_rows(
            conn,
            "SELECT t.edge_id FROM edge_transitions t WHERE t.repo_id = ?1 AND t.to_commit IS NULL AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.edge_id = t.edge_id) ORDER BY 1",
            &[&repo_id],
            |r| r.get::<_, String>(0),
        ) {
            problems.push(format!("H6: open transition {id} has no edges row"));
        }
        for id in all_rows(
            conn,
            "SELECT e.edge_id FROM edges e WHERE e.repo_id = ?1 AND NOT EXISTS (SELECT 1 FROM edge_transitions t WHERE t.edge_id = e.edge_id AND t.to_commit IS NULL) ORDER BY 1",
            &[&repo_id],
            |r| r.get::<_, String>(0),
        ) {
            problems.push(format!("H6: edge {id} has no open transition"));
        }
        for id in all_rows(
            conn,
            "SELECT e.edge_id FROM edges e JOIN edge_transitions t ON t.edge_id = e.edge_id WHERE e.repo_id = ?1 AND t.to_commit IS NULL AND t.dst_node != e.dst_node ORDER BY 1",
            &[&repo_id],
            |r| r.get::<_, String>(0),
        ) {
            problems.push(format!(
                "H6: edge {id} and its open transition disagree on dst_node"
            ));
        }
    }

    // ---- I7 dispositions ------------------------------------------------------------------
    // Every disposition names an existing commit. For each commit that is
    // the CURRENT commit of at least one live doc, over the live docs whose
    // current revision it wrote: a disposition on a block that survives the
    // commit (every kind but `deleted` / `merged_into`) names a live row of
    // one of those docs, and a `deleted` / `merged_into` one names no live
    // row of any of them.
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
    // The live docs whose current revision each commit wrote: one on the
    // observe path, N for an `api` changeset (spec/store §5.4 "The api
    // path", 13.7).
    let mut current_docs_of: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for d in &docs {
        let (Some(head), None) = (&d.head, &d.deleted_at) else {
            continue;
        };
        let Some(rev) = rev_by_id.get(head.as_str()) else {
            continue;
        };
        current_docs_of
            .entry(rev.commit_id.as_str())
            .or_default()
            .insert(d.doc_id.as_str());
    }
    for (commit, doc_ids) in &current_docs_of {
        let label = doc_ids.iter().copied().collect::<Vec<_>>().join(",");
        for (commit_id, block_id, kind) in &dispositions {
            if commit_id != commit || block_id == "DOC" {
                continue;
            }
            let row = live_doc_of(block_id);
            let live_here = row.as_deref().is_some_and(|d| doc_ids.contains(d));
            let gone = kind == "deleted" || kind == "merged_into";
            if gone && live_here {
                problems.push(format!(
                    "I7: {kind} block {block_id} of {commit_id} is still live in {}",
                    row.as_deref().unwrap_or("")
                ));
            }
            if !gone && !live_here {
                problems.push(format!(
                    "I7: {kind} block {block_id} of {commit_id} is not live in {label}"
                ));
            }
        }
    }
    // 14.2: `same` is never persisted (§5.4 step 10; the §7 sweep removes a
    // 14.1 store's), and a block's rows are its own history — so every live
    // block has at least one (its `inserted`, lineage or resurrection row)
    // UNLESS the commit that wrote it is wholly archived (17.0: the squash
    // empties a wholly archived commit's rows; the recorder's hold on the
    // id's claim is what remains of them, H6).
    for (commit_id, block_id, kind) in &dispositions {
        if kind == "same" {
            problems.push(format!(
                "I7: disposition {block_id} of {commit_id} is a persisted `same`"
            ));
        }
    }
    let unchanged: Vec<(String, String)> = all_rows(
        conn,
        "SELECT b.block_id, b.created_at FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE d.repo_id = ?1 AND b.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM block_changes bc WHERE bc.block_id = b.block_id)
           AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = b.block_id AND (ic.holders & 2) != 0) ORDER BY b.block_id",
        &[&repo_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    );
    // Phase 4a: a block born while capture was off has neither until a baseline holds it.
    for (block_id, created_at) in unchanged {
        if in_coverage(&created_at) {
            problems.push(format!(
                "I7: live block {block_id} has no block_changes row and no recorder hold on its claim"
            ));
        }
    }

    // ---- I8 rebuild equivalence -----------------------------------------------------------
    for d in &docs {
        if d.deleted_at.is_some() {
            continue;
        }
        let tops: Vec<(String, i64, String, Option<i64>)> = all_rows(
            conn,
            "SELECT block_id, ordinal, type, json_extract(attrs, '$.level') FROM blocks WHERE doc_id = ?1 AND parent_block IS NULL AND deleted_at IS NULL ORDER BY ordinal",
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
    // 17.0: `block_changes` is exactly the projection of `dispositions` over
    // every commit — a wholly archived commit has neither (the squash deletes
    // both; 15.0–16.x kept each block's earliest row for the mint oracle,
    // which the claims table replaced).
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
    let archived_disp: i64 = conn
        .query_row(
            &format!(
                "SELECT count(*) FROM dispositions WHERE commit_id IN ({ARCHIVED_COMMITS_SQL})"
            ),
            [],
            |r| r.get(0),
        )
        .expect("query runs");
    if archived_disp > 0 {
        problems.push(format!(
            "I9: {archived_disp} disposition rows of wholly archived commits remain"
        ));
    }
    let archived_bc: i64 = conn
        .query_row(
            &format!(
                "SELECT count(*) FROM block_changes WHERE commit_id IN ({ARCHIVED_COMMITS_SQL})"
            ),
            [],
            |r| r.get(0),
        )
        .expect("query runs");
    if archived_bc > 0 {
        problems.push(format!(
            "I9: {archived_bc} block_changes rows of wholly archived commits remain"
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

/// README §9.6 rules (1) and (4): does a run WITHOUT the history module
/// (`core`, `semantic`) skip this case — `migrations.json`, the recorder's
/// edge suite, `cases/history/` wholesale, and an observation script with a
/// step beyond `observe` / `sweep` / `remint_epoch`?
fn lacks_history_skips(c: &SpecCase) -> bool {
    match c.kind {
        Kind::Migration | Kind::Edges => true,
        Kind::Schema => false,
        Kind::Observe => c.file.starts_with("history/") || !runs_under_core(&c.case),
    }
}

fn check(c: &SpecCase, ledger: &mut Ledger) -> Result<(), String> {
    let composition = ledger.composition;
    let mut expected = c.case["expect"].clone();
    // README §9.6 "Without the semantic module": the bundle's tables are not
    // compared on EITHER side of a schema fingerprint or a migration's table
    // list — a fresh database has none, a migrated one keeps whatever the
    // older schema carried (§3.1: the bundle follows the composition).
    let strip_semantic = !composition.has_semantic()
        && (c.kind == Kind::Schema
            || (c.kind == Kind::Migration && c.case["expect"].get("error").is_none()));
    let mapped: Option<&str> = match c.kind {
        Kind::Schema if strip_semantic => Some("fingerprint without the semantic bundle"),
        Kind::Migration if strip_semantic => Some("table list without the semantic bundle"),
        Kind::Observe if !composition.has_history() => Some("core tables, holders bit 1 masked"),
        _ => None,
    };
    ledger.record(&c.id, mapped);
    let actual = match c.kind {
        Kind::Schema => {
            let actual = run_schema_case();
            if strip_semantic {
                expected = without_semantic_tables(&expected);
                without_semantic_tables(&actual)
            } else {
                actual
            }
        }
        Kind::Migration => {
            let actual = run_migration_case(&c.case);
            if strip_semantic {
                expected = without_semantic_migration_tables(&expected);
                without_semantic_migration_tables(&actual)
            } else {
                actual
            }
        }
        Kind::Observe | Kind::Edges => {
            let ev = if c.kind == Kind::Edges {
                run_edge_transitions_case(&c.case)?
            } else {
                run_observe_case(&c.case)?
            };
            if !ev.problems.is_empty() {
                return Err(clip(format!("invariants: {}", ev.problems.join("; "))));
            }
            // README §9.6 rule (3): the core tables alone, the recorder's bit masked.
            if c.kind == Kind::Observe && !composition.has_history() {
                expected = core_mode_projection(&expected);
            }
            ev.expect
        }
    };
    match deep_eq_tol(&actual, &expected, "expect", EPS) {
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

fn run_case(c: &SpecCase, ledger: &mut Ledger) -> Result<(), String> {
    IN_CASE.with(|f| f.set(true));
    let outcome = panic::catch_unwind(AssertUnwindSafe(|| check(c, ledger)));
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

    // README §9.6: the four compositions — without the history module the
    // observation scripts are compared on the core tables and the cases that
    // need the module are skipped; without the semantic module the schema and
    // migration comparisons strip the bundle's tables from both sides. The
    // ledger line is what `pnpm conformance` reads; the fixtures are never
    // regenerated from a reduced composition.
    let mut ledger = Ledger::new("store");
    ledger.refuse_update(update_requested(), "STORE_SPEC_UPDATE");
    let mut all_ids = BTreeSet::new();
    let mut passing = BTreeSet::new();
    let mut failing: Vec<(String, Option<String>)> = Vec::new();
    for file in &loaded.files {
        for c in &file.cases {
            all_ids.insert(c.id.clone());
            if !ledger.composition.has_history() && lacks_history_skips(c) {
                // A skipped case counts as passing for the allowlist's
                // bookkeeping, as the reference's skipped test does.
                ledger.skip(&c.id, "needs the history module");
                passing.insert(c.id.clone());
                continue;
            }
            match run_case(c, &mut ledger) {
                Ok(()) => {
                    passing.insert(c.id.clone());
                }
                Err(reason) => failing.push((c.id.clone(), Some(reason))),
            }
        }
    }
    let _ = panic::take_hook();
    ledger.report();

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
    let loaded_names: Vec<String> = loaded.files.iter().map(|f| f.file.clone()).collect();
    assert_eq!(loaded_names, loaded.file_names, "every case file must load");
    // README §9.5: the recorder suites under `cases/history/` — the
    // edge-transition projections and, since 3e-ii, the three recorder-only
    // observation scripts moved there byte-identical.
    for suite in [
        "history/edge-transitions.json",
        "history/garbage.json",
        "history/delta.json",
        "history/retention.json",
    ] {
        assert!(
            loaded.file_names.iter().any(|f| f == suite),
            "the recorder suite {suite} under cases/history/ (README §9.5) is loaded"
        );
    }
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

/// §3.3: the embedded DDL is `spec/store/schema.sql`, byte for byte — and
/// since 17.0 the two bundle files `schema-history.sql` /
/// `schema-semantic.sql` the same way; the spec `VERSION`'s major is the
/// schema version.
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
    let history =
        fs::read_to_string(Path::new(SPEC_DIR).join("schema-history.sql")).expect("history");
    assert_eq!(
        history, HISTORY_SQL,
        "spec/store/schema-history.sql != the embedded schema-history.sql"
    );
    let semantic =
        fs::read_to_string(Path::new(SPEC_DIR).join("schema-semantic.sql")).expect("semantic");
    assert_eq!(
        semantic, SEMANTIC_SQL,
        "spec/store/schema-semantic.sql != the embedded schema-semantic.sql"
    );
    // §3.3 (15.0): the second DDL artifact, the archive segment's, the same way.
    let archive = fs::read_to_string(Path::new(SPEC_DIR).join("archive.sql")).expect("archive.sql");
    assert_eq!(
        archive, ARCHIVE_SQL,
        "spec/store/archive.sql != the embedded archive.sql"
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

/// §3.3 (17.0): the three bundles partition the table set — no table lost or
/// duplicated against 17.0's single file: the 3d set minus the D9 drops
/// (`collections`, `inferred_edges`) plus the history bundle's
/// `edge_transitions`, and (3e-ii) the core's `capabilities` and `alerts`; 34
/// tables, the history bundle 8, the semantic 2.
#[test]
fn the_three_bundles_partition_the_table_set() {
    fn names(ddl: &str) -> Vec<String> {
        let mut out = Vec::new();
        for line in ddl.lines() {
            let rest = line
                .strip_prefix("CREATE TABLE IF NOT EXISTS ")
                .or_else(|| line.strip_prefix("CREATE VIRTUAL TABLE IF NOT EXISTS "));
            if let Some(rest) = rest {
                let name = rest.split_whitespace().next().unwrap_or("");
                out.push(name.trim_end_matches('(').to_owned());
            }
        }
        out
    }
    let core = names(SCHEMA_SQL);
    let mut history = names(HISTORY_SQL);
    let mut semantic = names(SEMANTIC_SQL);
    let mut all: Vec<String> = core
        .iter()
        .chain(&history)
        .chain(&semantic)
        .cloned()
        .collect();
    let distinct: BTreeSet<&String> = all.iter().collect();
    assert_eq!(distinct.len(), all.len(), "a table in two bundles: {all:?}");
    all.sort();
    assert_eq!(
        all,
        [
            "adapters",
            "alerts",
            "archives",
            "attachments",
            "blobs",
            "block_changes",
            "blocks",
            "blocks_fts",
            "capabilities",
            "commits",
            "dispositions",
            "doc_edges",
            "doc_embeddings",
            "docs",
            "edge_transitions",
            "edges",
            "embeddings",
            "external_nodes",
            "feed",
            "feed_entries",
            "file_stats",
            "id_claims",
            "nodes",
            "nodes_fts",
            "pending_materializations",
            "properties",
            "repos",
            "resurrection_pool",
            "revisions",
            "sections",
            "sources",
            "sync_state",
            "tree_nodes",
            "workspace_settings",
        ]
    );
    history.sort();
    assert_eq!(
        history,
        [
            "archives",
            "blobs",
            "block_changes",
            "commits",
            "dispositions",
            "edge_transitions",
            "revisions",
            "tree_nodes"
        ]
    );
    semantic.sort();
    assert_eq!(semantic, ["doc_embeddings", "embeddings"]);
    // A fresh store (17.1, Phase 4a) holds the core and semantic bundles —
    // the history bundle follows the manifest — and exactly all three once a
    // repository's history is enabled.
    let mut store = Store::open_in_memory_with_minter(Box::new(SequentialMinter::new()))
        .expect("fresh store opens");
    let mut have = table_names(store.conn());
    have.retain(|t| !t.starts_with("blocks_fts_") && !t.starts_with("nodes_fts_"));
    let mut core_and_semantic: Vec<String> = core.iter().chain(&semantic).cloned().collect();
    core_and_semantic.sort();
    assert_eq!(have, core_and_semantic);
    store
        .create_repo_at(FIXTURE_REPO_SLUG, FIXTURE_BIRTH)
        .expect("a repository with capture on");
    let mut have = table_names(store.conn());
    have.retain(|t| !t.starts_with("blocks_fts_") && !t.starts_with("nodes_fts_"));
    assert_eq!(have, all);
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
    // README §9.6: a run without the history module checks the cases it runs (C*, F*, A1).
    let lacks_history = !composition().has_history();
    for f in &loaded.files {
        for c in f
            .cases
            .iter()
            .filter(|c| matches!(c.kind, Kind::Observe | Kind::Edges))
            .filter(|c| !(lacks_history && lacks_history_skips(c)))
        {
            let ev = if c.kind == Kind::Edges {
                run_edge_transitions_case(&c.case)
            } else {
                run_observe_case(&c.case)
            };
            match ev {
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
