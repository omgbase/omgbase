//! The sync spec conformance runner: executes every fixture under
//! `spec/sync/cases` against this crate over `omgbase-store` — `pure.json`
//! through the pure functions, `registry.json` and `checkpoint.json` as
//! scripts on a fresh in-memory store (the latter over the in-memory
//! filesystem, with the `spec/store` §8 invariants after every ingesting
//! step), the `adapter` cases of `protocol.json` against a scripted adapter
//! played over an in-process pipe (the engine's request lines compared byte
//! for byte with the transcript's `out` lines), and the `coordinator` cases
//! against the production `Coordinator` over a recording engine client — and
//! compares the result to each case's `expect`. The fixture contract is
//! `spec/sync/README.md` §8; the reference runners this mirrors are
//! `packages/core/corpus/sync/{spec.test,fixture}.ts` and
//! `packages/sync/corpus/sync/{spec.test,fixture}.ts`.
//!
//! Allowlist (`tests/spec-passing.txt`, one `<file-stem>::<name>` per line):
//! while the port is incomplete it names the cases that must pass. A listed
//! case that fails, an unlisted case that passes, or a listed id that no
//! longer exists all fail the build. If the file is absent, every case must
//! pass. Promote cases by rewriting the list to the currently passing set:
//!
//! ```text
//! SYNC_SPEC_UPDATE=1 cargo test -p omgbase-sync --test spec
//! ```

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc::Receiver;

use omgbase_format::hash::{hex, sha256};
use omgbase_reconcile::Config;
use omgbase_store::tree::parse_tree_entries;
use omgbase_store::{
    BatchItem, BatchOutcome, DocOpContext, NullDocStore, Origin, SequentialMinter, Store, TreeEntry,
};
use omgbase_sync::engine::{DocBytes, EngineClient, FileBytes, InProcessEngineClient};
use omgbase_sync::freshness::{CacheRow, DiskEntry};
use omgbase_sync::pipe::{Dir, ScriptedAdapter};
use omgbase_sync::registry::NewSource;
use omgbase_sync::source::{SourceCapabilities, SourceEntry, SourceIdentity, SourceItem};
use omgbase_sync::{
    ChangesPage, Coordinator, DeleteOutcome, Error as SyncError, ExternalSource, FileStat,
    MemFileSystem, ObserveOutcome, RepoRow, SyncSource, deep_merge, detect_disk_drift,
    freshness_sweep, process_checkpoint, rebuild_file_stats, recover_repo, registry,
    render_config_flags, repos_status, select_repo, settings, sweep_plan,
};
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map as JsonMap, Value as Json, json};

const SPEC_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/sync");
const CASES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/sync/cases");
const PASSING_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/spec-passing.txt");
/// A wrong `CASES_DIR` must not pass by finding some other, smaller directory.
const MIN_CASE_FILES: usize = 4;
const MAX_REPORT_LINES: usize = 400;
/// Nothing projected is floating point except `confidence`; compare within this.
const EPS: f64 = 1e-9;
/// The repo every script runs in (`spec/store` §9.4 "Inputs").
const FIXTURE_REPO_SLUG: &str = "fixture";
/// The root every checkpoint case runs under; the in-memory filesystem ignores it.
const FIXTURE_ROOT: &str = "/fixture";

const PURE_FNS: [&str; 4] = [
    "render_config_flags",
    "deep_merge",
    "select_repo",
    "sweep_plan",
];
const REGISTRY_STEPS: [&str; 8] = [
    "ensure_repo",
    "ensure_adapter",
    "create_source",
    "delete_source",
    "attach",
    "detach",
    "settings",
    "resolve_settings",
];
const REGISTRY_PROJECTION_KEYS: [&str; 8] = [
    "steps",
    "repos",
    "adapters",
    "sources",
    "attachments",
    "sync_state",
    "workspace_settings",
    "repos_status",
];
const CHECKPOINT_STEPS: [&str; 7] = [
    "disk",
    "rm",
    "sweep",
    "checkpoint",
    "drift",
    "recover",
    "rebuild_stats",
];
const CHECKPOINT_PROJECTION_KEYS: [&str; 13] = [
    "steps",
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
    "checkpoints",
    "file_stats",
];
const COORDINATOR_STEPS: [&str; 5] = ["source", "engine", "sync_in", "reconcile", "sync_out"];
const COORDINATOR_PROJECTION_KEYS: [&str; 4] = ["steps", "files", "docs", "commits"];

const PASSING_HEADER: &str = "\
# Sync spec cases (spec/sync/cases) that the Rust port must pass, one
# `<file-stem>::<name>` id per line, sorted. Maintained by tests/spec.rs:
# a listed case failing fails the build; an unlisted case passing also fails
# the build (add it here). Regenerate from the currently passing set with
#
#     SYNC_SPEC_UPDATE=1 cargo test -p omgbase-sync --test spec
#
# When every case passes, delete this file (the runner then requires all).
";

// ---- fixture shape -----------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Pure,
    Registry,
    Checkpoint,
    Adapter,
    Coordinator,
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

fn require_path(v: Option<&Json>, here: &str, problems: &mut Vec<String>) {
    match v.and_then(Json::as_str) {
        Some(p) if !p.is_empty() && !p.starts_with('/') => {}
        _ => problems.push(format!(
            "{here}: `path` must be repo-relative with no leading slash"
        )),
    }
}

fn is_string_array(v: &Json) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(Json::is_string))
}

fn is_sha_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// One step kind's validator: `(kind, body, here, problems)`.
type StepValidator = dyn Fn(&str, &JsonMap<String, Json>, &str, &mut Vec<String>);

/// Validate a single-key step list; returns the step count or -1.
fn validate_steps(
    at: &str,
    steps: Option<&Json>,
    kinds: &[&str],
    validate: &StepValidator,
    problems: &mut Vec<String>,
) -> i64 {
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
        if keys.len() != 1 || !kinds.contains(&keys[0].as_str()) {
            problems.push(format!(
                "{here}: a step is exactly one of {} (got {})",
                kinds
                    .iter()
                    .map(|k| format!("`{k}`"))
                    .collect::<Vec<_>>()
                    .join(" / "),
                keys.iter()
                    .map(|k| k.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            continue;
        }
        let kind = keys[0].as_str();
        let Some(body) = obj[kind].as_object() else {
            problems.push(format!("{here}: not an object"));
            continue;
        };
        validate(kind, body, &here, problems);
    }
    steps.len() as i64
}

fn validate_registry_step(
    kind: &str,
    body: &JsonMap<String, Json>,
    here: &str,
    problems: &mut Vec<String>,
) {
    let s = |k: &str| body.get(k).and_then(Json::as_str);
    match kind {
        "ensure_repo" => {
            only_keys(body, &["slug", "root"], here, problems);
            if s("slug").is_none_or(str::is_empty) {
                problems.push(format!("{here}: `slug` must be a non-empty string"));
            }
            if body.get("root").is_some_and(|v| !v.is_string()) {
                problems.push(format!("{here}: `root` must be a string"));
            }
        }
        "ensure_adapter" => {
            only_keys(body, &["name", "command", "args"], here, problems);
            if s("name").is_none() || s("command").is_none() {
                problems.push(format!("{here}: `name` and `command` must be strings"));
            }
            if body.get("args").is_some_and(|v| !is_string_array(v)) {
                problems.push(format!("{here}: `args` must be a string array"));
            }
        }
        "create_source" => {
            only_keys(body, &["name", "adapter", "config", "env"], here, problems);
            if s("name").is_none() || s("adapter").is_none() {
                problems.push(format!("{here}: `name` and `adapter` must be strings"));
            }
            if body.get("config").is_some_and(|v| !v.is_object()) {
                problems.push(format!("{here}: `config` must be an object"));
            }
            if body.get("env").is_some_and(|v| !v.is_object()) {
                problems.push(format!("{here}: `env` must be an object"));
            }
        }
        "delete_source" => {
            only_keys(body, &["source"], here, problems);
            if s("source").is_none() {
                problems.push(format!("{here}: `source` must be a source id"));
            }
        }
        "attach" | "detach" => {
            only_keys(body, &["repo", "source"], here, problems);
            if s("repo").is_none() || s("source").is_none() {
                problems.push(format!("{here}: `repo` and `source` must be ids"));
            }
        }
        "settings" => {
            only_keys(body, &["scope", "set"], here, problems);
            if s("scope").is_none_or(str::is_empty) {
                problems.push(format!("{here}: `scope` is \"workspace\" or a repo slug"));
            }
            if !body.get("set").is_some_and(Json::is_object) {
                problems.push(format!("{here}: `set` must be an object"));
            }
        }
        "resolve_settings" => {
            only_keys(body, &["repo"], here, problems);
            if body.get("repo").is_some_and(|v| !v.is_string()) {
                problems.push(format!("{here}: `repo` must be a slug"));
            }
        }
        _ => unreachable!(),
    }
}

fn validate_checkpoint_step(
    kind: &str,
    body: &JsonMap<String, Json>,
    here: &str,
    problems: &mut Vec<String>,
) {
    match kind {
        "disk" => {
            only_keys(body, &["path", "content", "mtime_ns"], here, problems);
            require_path(body.get("path"), here, problems);
            if !body.get("content").is_some_and(Json::is_string) {
                problems.push(format!("{here}: `content` must be a string"));
            }
            if !body
                .get("mtime_ns")
                .and_then(Json::as_u64)
                .is_some_and(|n| n <= (1 << 53))
            {
                problems.push(format!(
                    "{here}: `mtime_ns` must be a non-negative safe integer"
                ));
            }
        }
        "rm" => {
            only_keys(body, &["path"], here, problems);
            require_path(body.get("path"), here, problems);
        }
        "sweep" => {
            only_keys(body, &["ts", "git_head"], here, problems);
            require_ts(body, here, problems);
            if body.get("git_head").is_some_and(|v| !v.is_string()) {
                problems.push(format!("{here}: `git_head` must be a string"));
            }
        }
        "checkpoint" => {
            only_keys(body, &["ts", "paths", "git_head"], here, problems);
            require_ts(body, here, problems);
            match body.get("paths").and_then(Json::as_array) {
                Some(paths) => {
                    for (j, p) in paths.iter().enumerate() {
                        require_path(Some(p), &format!("{here}.paths[{j}]"), problems);
                    }
                }
                None => problems.push(format!("{here}: `paths` must be an array")),
            }
            if body.get("git_head").is_some_and(|v| !v.is_string()) {
                problems.push(format!("{here}: `git_head` must be a string"));
            }
        }
        "drift" | "rebuild_stats" => only_keys(body, &[], here, problems),
        "recover" => {
            only_keys(body, &["ts"], here, problems);
            require_ts(body, here, problems);
        }
        _ => unreachable!(),
    }
}

fn validate_coordinator_step(
    kind: &str,
    body: &JsonMap<String, Json>,
    here: &str,
    problems: &mut Vec<String>,
) {
    match kind {
        "source" => {
            only_keys(body, &["set", "rm"], here, problems);
            if body.get("set").is_some_and(|v| {
                !v.as_object()
                    .is_some_and(|o| o.values().all(Json::is_string))
            }) {
                problems.push(format!("{here}: `set` is path → content"));
            }
            if body.get("rm").is_some_and(|v| !is_string_array(v)) {
                problems.push(format!("{here}: `rm` is a path list"));
            }
        }
        "engine" => {
            only_keys(
                body,
                &["ts", "create", "import", "delete", "observe"],
                here,
                problems,
            );
            require_ts(body, here, problems);
            let ops = ["create", "import", "delete", "observe"]
                .iter()
                .filter(|k| body.contains_key(**k))
                .count();
            if ops != 1 {
                problems.push(format!(
                    "{here}: exactly one of create/import/delete/observe"
                ));
            }
        }
        "sync_in" => {
            only_keys(body, &["ts"], here, problems);
            require_ts(body, here, problems);
        }
        "reconcile" => {
            only_keys(body, &["ts", "paths"], here, problems);
            require_ts(body, here, problems);
            if !body.get("paths").is_some_and(is_string_array) {
                problems.push(format!("{here}: `paths` must be a string array"));
            }
        }
        "sync_out" => {
            only_keys(body, &["cursor"], here, problems);
            if body.get("cursor").is_some_and(|v| !v.is_number()) {
                problems.push(format!("{here}: `cursor` must be a number"));
            }
        }
        _ => unreachable!(),
    }
}

fn validate_pure_case(at: &str, c: &JsonMap<String, Json>, problems: &mut Vec<String>) {
    only_keys(c, &["name", "notes", "fn", "args", "expect"], at, problems);
    let fn_name = c.get("fn").and_then(Json::as_str).unwrap_or("");
    if !PURE_FNS.contains(&fn_name) {
        problems.push(format!("{at}: `fn` must be one of {}", PURE_FNS.join("/")));
    }
    let Some(a) = c.get("args").and_then(Json::as_object) else {
        problems.push(format!("{at}: `args` must be an object"));
        return;
    };
    let here = format!("{at}.args");
    match fn_name {
        "render_config_flags" => {
            only_keys(a, &["config"], &here, problems);
            if !a.get("config").is_some_and(Json::is_object) {
                problems.push(format!("{here}: `config` must be an object"));
            }
        }
        "deep_merge" => {
            only_keys(a, &["base", "over"], &here, problems);
            for k in ["base", "over"] {
                if !a.get(k).is_some_and(Json::is_object) {
                    problems.push(format!("{here}: `{k}` must be an object"));
                }
            }
        }
        "select_repo" => {
            only_keys(a, &["repos", "cwd", "slug"], &here, problems);
            match a.get("repos").and_then(Json::as_array) {
                Some(repos) => {
                    for (i, r) in repos.iter().enumerate() {
                        let ok = r.as_object().is_some_and(|o| {
                            o.get("slug").is_some_and(Json::is_string)
                                && o.get("root_path")
                                    .is_some_and(|v| v.is_string() || v.is_null())
                        });
                        if !ok {
                            problems.push(format!(
                                "{here}.repos[{i}]: a repo is {{ slug, root_path: string | null }}"
                            ));
                        }
                    }
                }
                None => problems.push(format!(
                    "{here}: `repos` must be an array of {{ slug, root_path }}"
                )),
            }
            if !a
                .get("cwd")
                .and_then(Json::as_str)
                .is_some_and(|c| c.starts_with('/'))
            {
                problems.push(format!("{here}: `cwd` must be an absolute path"));
            }
            if a.get("slug").is_some_and(|v| !v.is_string()) {
                problems.push(format!("{here}: `slug` must be a string"));
            }
        }
        "sweep_plan" => {
            only_keys(a, &["cache", "disk"], &here, problems);
            match a.get("cache").and_then(Json::as_array) {
                Some(rows) => {
                    for (i, r) in rows.iter().enumerate() {
                        let ok = r.as_object().is_some_and(|o| {
                            o.get("path").is_some_and(Json::is_string)
                                && o.get("mtime_ns").is_some_and(Json::is_number)
                                && o.get("size").is_some_and(Json::is_number)
                                && o.get("hash").and_then(Json::as_str).is_some_and(is_sha_hex)
                        });
                        if !ok {
                            problems.push(format!(
                                "{here}.cache[{i}]: a cache row is {{ path, mtime_ns, size, hash: <sha256 hex> }}"
                            ));
                        }
                    }
                }
                None => problems.push(format!("{here}: `cache` must be an array")),
            }
            match a.get("disk").and_then(Json::as_array) {
                Some(rows) => {
                    for (i, r) in rows.iter().enumerate() {
                        let ok = r.as_object().is_some_and(|o| {
                            o.get("path").is_some_and(Json::is_string)
                                && o.get("mtime_ns").is_some_and(Json::is_number)
                                && o.get("content").is_some_and(Json::is_string)
                                && o.get("size").is_none_or(Json::is_number)
                        });
                        if !ok {
                            problems.push(format!(
                                "{here}.disk[{i}]: a disk entry is {{ path, mtime_ns, content, size? }}"
                            ));
                        }
                    }
                }
                None => problems.push(format!("{here}: `disk` must be an array")),
            }
        }
        _ => {}
    }
    if !c.contains_key("expect") {
        problems.push(format!("{at}: missing `expect` (run SYNC_SPEC_UPDATE=1)"));
    }
}

fn validate_exact_keys(at: &str, e: &Json, want: &[&str], problems: &mut Vec<String>) -> bool {
    let Some(obj) = e.as_object() else {
        problems.push(format!("{at}: must be an object"));
        return false;
    };
    let keys: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
    let want_set: BTreeSet<&str> = want.iter().copied().collect();
    if keys != want_set {
        problems.push(format!(
            "{at}: must have exactly the keys {} (got {})",
            want.join(", "),
            keys.into_iter().collect::<Vec<_>>().join(", ")
        ));
        return false;
    }
    true
}

fn validate_steps_count(at: &str, e: &Json, step_count: i64, problems: &mut Vec<String>) {
    match e.get("steps").and_then(Json::as_array) {
        None => problems.push(format!("{at}.steps: must be an array")),
        Some(steps) if step_count >= 0 && steps.len() as i64 != step_count => {
            problems.push(format!(
                "{at}.steps: {} outcomes for {step_count} steps",
                steps.len()
            ))
        }
        _ => {}
    }
}

fn validate_transcript(at: &str, t: Option<&Json>, problems: &mut Vec<String>) {
    let Some(t) = t.and_then(Json::as_array).filter(|t| !t.is_empty()) else {
        problems.push(format!(
            "{at}: `transcript` must be a non-empty array of {{ dir, line }}"
        ));
        return;
    };
    for (i, e) in t.iter().enumerate() {
        let ok = e.as_object().is_some_and(|o| {
            o.len() == 2
                && matches!(o.get("dir").and_then(Json::as_str), Some("in" | "out"))
                && o.get("line").is_some_and(Json::is_string)
        });
        if !ok {
            problems.push(format!(
                "{at}.transcript[{i}]: an entry is {{ dir: \"in\" | \"out\", line }}"
            ));
            continue;
        }
        if e["dir"] == "out" {
            match serde_json::from_str::<Json>(e["line"].as_str().unwrap_or_default()) {
                Ok(req) if req.get("method").is_some_and(Json::is_string) => {}
                Ok(_) => problems.push(format!(
                    "{at}.transcript[{i}]: an `out` line is a request {{ id, method, params }}"
                )),
                Err(_) => {
                    problems.push(format!("{at}.transcript[{i}]: an `out` line must be JSON"))
                }
            }
        }
    }
    if t[0]["dir"] != "in" {
        problems.push(format!(
            "{at}.transcript[0]: the first line is the adapter's handshake (dir \"in\")"
        ));
    }
}

fn validate_coordinator_case(at: &str, c: &JsonMap<String, Json>, problems: &mut Vec<String>) {
    only_keys(
        c,
        &[
            "name",
            "kind",
            "notes",
            "source",
            "page_limit",
            "steps",
            "expect",
        ],
        at,
        problems,
    );
    if let Some(source) = c.get("source") {
        match source.as_object() {
            Some(o) => {
                only_keys(o, &["write_through"], &format!("{at}.source"), problems);
                if o.get("write_through").is_some_and(|v| !v.is_boolean()) {
                    problems.push(format!("{at}.source: `write_through` must be a boolean"));
                }
            }
            None => problems.push(format!("{at}: `source` must be an object")),
        }
    }
    if c.get("page_limit")
        .is_some_and(|v| !v.as_u64().is_some_and(|n| n >= 1))
    {
        problems.push(format!("{at}: `page_limit` must be a positive integer"));
    }
    let n = validate_steps(
        at,
        c.get("steps"),
        &COORDINATOR_STEPS,
        &validate_coordinator_step,
        problems,
    );
    match c.get("expect") {
        None => problems.push(format!(
            "{at}: missing `expect` (run SYNC_SPEC_UPDATE=1 in packages/sync)"
        )),
        Some(e) => {
            if validate_exact_keys(
                &format!("{at}.expect"),
                e,
                &COORDINATOR_PROJECTION_KEYS,
                problems,
            ) {
                validate_steps_count(&format!("{at}.expect"), e, n, problems);
            }
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
    let suite = match stem {
        "pure" => Kind::Pure,
        "registry" => Kind::Registry,
        "checkpoint" => Kind::Checkpoint,
        "protocol" => Kind::Adapter,
        _ => {
            problems.push(format!(
                "{file}: unknown suite (one of pure, registry, checkpoint, protocol)"
            ));
            return Err(problems);
        }
    };
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
        if cobj.get("notes").is_some_and(|n| !n.is_string()) {
            problems.push(format!("{at}: `notes` must be a string"));
        }
        let mut kind = suite;
        match suite {
            Kind::Pure => validate_pure_case(&at, cobj, &mut problems),
            Kind::Registry => {
                only_keys(
                    cobj,
                    &["name", "notes", "steps", "expect"],
                    &at,
                    &mut problems,
                );
                let n = validate_steps(
                    &at,
                    cobj.get("steps"),
                    &REGISTRY_STEPS,
                    &validate_registry_step,
                    &mut problems,
                );
                match cobj.get("expect") {
                    None => {
                        problems.push(format!("{at}: missing `expect` (run SYNC_SPEC_UPDATE=1)"))
                    }
                    Some(e) => {
                        if validate_exact_keys(
                            &format!("{at}.expect"),
                            e,
                            &REGISTRY_PROJECTION_KEYS,
                            &mut problems,
                        ) {
                            validate_steps_count(&format!("{at}.expect"), e, n, &mut problems);
                        }
                    }
                }
            }
            Kind::Checkpoint => {
                only_keys(
                    cobj,
                    &["name", "notes", "config", "steps", "expect"],
                    &at,
                    &mut problems,
                );
                if cobj.get("config").is_some_and(|v| !v.is_object()) {
                    problems.push(format!("{at}: `config` must be an object"));
                }
                let n = validate_steps(
                    &at,
                    cobj.get("steps"),
                    &CHECKPOINT_STEPS,
                    &validate_checkpoint_step,
                    &mut problems,
                );
                match cobj.get("expect") {
                    None => {
                        problems.push(format!("{at}: missing `expect` (run SYNC_SPEC_UPDATE=1)"))
                    }
                    Some(e) => {
                        if validate_exact_keys(
                            &format!("{at}.expect"),
                            e,
                            &CHECKPOINT_PROJECTION_KEYS,
                            &mut problems,
                        ) {
                            validate_steps_count(&format!("{at}.expect"), e, n, &mut problems);
                        }
                    }
                }
            }
            Kind::Adapter | Kind::Coordinator => match cobj.get("kind").and_then(Json::as_str) {
                Some("adapter") => {
                    only_keys(
                        cobj,
                        &["name", "kind", "notes", "transcript", "expect"],
                        &at,
                        &mut problems,
                    );
                    validate_transcript(&at, cobj.get("transcript"), &mut problems);
                    match cobj.get("expect") {
                        None => problems
                            .push(format!("{at}: missing `expect` (run SYNC_SPEC_UPDATE=1)")),
                        Some(e) => match e.as_object() {
                            None => problems.push(format!("{at}.expect: must be an object")),
                            Some(o) if !o.contains_key("error") => {
                                validate_exact_keys(
                                    &format!("{at}.expect"),
                                    e,
                                    &["capabilities", "results", "events"],
                                    &mut problems,
                                );
                            }
                            Some(_) => {}
                        },
                    }
                }
                Some("coordinator") => {
                    kind = Kind::Coordinator;
                    validate_coordinator_case(&at, cobj, &mut problems);
                }
                _ => problems.push(format!(
                    "{at}: `kind` must be \"adapter\" or \"coordinator\""
                )),
            },
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

// ---- helpers ----------------------------------------------------------------------

fn fresh_store() -> Store {
    Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).expect("in-memory store")
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

fn obj_of(v: Option<&Json>) -> JsonMap<String, Json> {
    v.and_then(Json::as_object).cloned().unwrap_or_default()
}

fn parse_json_text(text: &str) -> Json {
    serde_json::from_str(text).unwrap_or_else(|e| panic!("not JSON ({e}): {text}"))
}

/// A SQLite constraint failure → the pinned error code; anything else is a
/// runner bug (`Err`).
fn constraint_code(e: &SyncError) -> Result<&'static str, String> {
    if let SyncError::Store(omgbase_store::Error::Sqlite(rusqlite::Error::SqliteFailure(ffi, _))) =
        e
    {
        // SQLITE_CONSTRAINT_UNIQUE 2067, SQLITE_CONSTRAINT_PRIMARYKEY 1555,
        // SQLITE_CONSTRAINT_FOREIGNKEY 787.
        return match ffi.extended_code {
            2067 | 1555 => Ok("unique"),
            787 => Ok("foreign_key"),
            other => Err(format!("unexpected constraint {other}: {e}")),
        };
    }
    Err(format!("unexpected error: {e}"))
}

// ---- pure.json -------------------------------------------------------------------

fn run_pure(c: &Json) -> Result<Json, String> {
    let a = c["args"].as_object().ok_or("args")?;
    match c["fn"].as_str().unwrap_or("") {
        "render_config_flags" => Ok(json!(render_config_flags(&obj_of(a.get("config"))))),
        "deep_merge" => Ok(Json::Object(deep_merge(
            &obj_of(a.get("base")),
            &obj_of(a.get("over")),
        ))),
        "select_repo" => {
            let repos: Vec<RepoRow> = a["repos"]
                .as_array()
                .ok_or("repos")?
                .iter()
                .map(|r| {
                    RepoRow::candidate(r["slug"].as_str().unwrap_or(""), r["root_path"].as_str())
                })
                .collect();
            let cwd = a["cwd"].as_str().ok_or("cwd")?;
            let slug = a.get("slug").and_then(Json::as_str);
            Ok(match select_repo(&repos, cwd, slug) {
                Ok(r) => json!(r.slug),
                Err(e) => json!({ "error": e.error, "candidates": e.candidates }),
            })
        }
        "sweep_plan" => {
            let cache: Vec<CacheRow> = a["cache"]
                .as_array()
                .ok_or("cache")?
                .iter()
                .map(|r| {
                    let mut hash = [0u8; 32];
                    let hex_text = r["hash"].as_str().unwrap_or("");
                    for (i, byte) in hash.iter_mut().enumerate() {
                        *byte = u8::from_str_radix(&hex_text[i * 2..i * 2 + 2], 16).unwrap_or(0);
                    }
                    CacheRow {
                        path: r["path"].as_str().unwrap_or("").to_owned(),
                        mtime_ns: r["mtime_ns"].as_i64().unwrap_or(0),
                        size: r["size"].as_i64().unwrap_or(0),
                        hash,
                    }
                })
                .collect();
            let disk_json = a["disk"].as_array().ok_or("disk")?;
            let contents: HashMap<String, String> = disk_json
                .iter()
                .map(|d| {
                    (
                        d["path"].as_str().unwrap_or("").to_owned(),
                        d["content"].as_str().unwrap_or("").to_owned(),
                    )
                })
                .collect();
            let disk: Vec<DiskEntry> = disk_json
                .iter()
                .map(|d| {
                    let content = d["content"].as_str().unwrap_or("");
                    DiskEntry {
                        path: d["path"].as_str().unwrap_or("").to_owned(),
                        stat: FileStat {
                            mtime_ns: d["mtime_ns"].as_i64().unwrap_or(0),
                            size: d
                                .get("size")
                                .and_then(Json::as_i64)
                                .unwrap_or(content.len() as i64),
                        },
                    }
                })
                .collect();
            let mut hash_of = |path: &str| -> omgbase_sync::Result<[u8; 32]> {
                Ok(sha256(
                    contents.get(path).map_or("", String::as_str).as_bytes(),
                ))
            };
            let plan = sweep_plan(&cache, &disk, &mut hash_of).map_err(|e| e.to_string())?;
            Ok(plan.to_json())
        }
        other => Err(format!("unknown fn {other}")),
    }
}

// ---- registry.json -----------------------------------------------------------------

fn repo_id_by_slug(store: &Store, slug: &str) -> Result<Option<String>, String> {
    store.repo_by_slug(slug).map_err(|e| e.to_string())
}

fn run_registry_step(store: &mut Store, step: &Json) -> Result<Json, String> {
    let obj = step.as_object().ok_or("step")?;
    let (kind, body) = obj.iter().next().ok_or("empty step")?;
    let s = |k: &str| body.get(k).and_then(Json::as_str).unwrap_or("");
    let outcome: omgbase_sync::Result<Json> = match kind.as_str() {
        "ensure_repo" => {
            registry::ensure_repo(store, s("slug"), body.get("root").and_then(Json::as_str))
                .map(|id| json!({ "repo": id }))
        }
        "ensure_adapter" => registry::ensure_adapter(
            store,
            s("name"),
            s("command"),
            &strings_of(body.get("args")),
        )
        .map(|()| json!({})),
        "create_source" => {
            let config = body.get("config").and_then(Json::as_object);
            let env: Option<BTreeMap<String, String>> =
                body.get("env").and_then(Json::as_object).map(|o| {
                    o.iter()
                        .map(|(k, v)| {
                            (
                                k.clone(),
                                v.as_str().map_or_else(|| v.to_string(), str::to_owned),
                            )
                        })
                        .collect()
                });
            registry::create_source(
                store,
                &NewSource {
                    name: s("name"),
                    adapter: s("adapter"),
                    config,
                    env: env.as_ref(),
                },
            )
            .map(|id| json!({ "source": id }))
        }
        "delete_source" => registry::delete_source(store, s("source")).map(|()| json!({})),
        "attach" => registry::attach(store, s("repo"), s("source")).map(|()| json!({})),
        "detach" => registry::detach(store, s("repo"), s("source")).map(|()| json!({})),
        "settings" => {
            let set = obj_of(body.get("set"));
            if s("scope") == "workspace" {
                settings::write_workspace_settings(store, &set).map(|()| json!({}))
            } else {
                match repo_id_by_slug(store, s("scope"))? {
                    None => Ok(json!({ "error": "repo_not_found" })),
                    Some(id) => settings::write_repo_settings(store, &id, &set).map(|()| json!({})),
                }
            }
        }
        "resolve_settings" => match body.get("repo").and_then(Json::as_str) {
            None => settings::resolve_settings(store, None).map(|s| json!({ "settings": s })),
            Some(slug) => match repo_id_by_slug(store, slug)? {
                None => Ok(json!({ "error": "repo_not_found" })),
                Some(id) => {
                    settings::resolve_settings(store, Some(&id)).map(|s| json!({ "settings": s }))
                }
            },
        },
        other => return Err(format!("unknown registry step {other}")),
    };
    match outcome {
        Ok(v) => Ok(v),
        Err(e) => Ok(json!({ "error": constraint_code(&e)? })),
    }
}

/// README §8 `registry.json` projection: the registry tables, both settings
/// layers, the disk-free status fields.
fn project_registry(store: &Store) -> Result<Vec<(String, Json)>, String> {
    let conn = store.conn();
    let repos: Vec<Json> = query_rows(
        conn,
        "SELECT repo_id, slug, settings FROM repos ORDER BY slug",
        &[],
    )
    .into_iter()
    .map(|r| with_json_column(r, "settings"))
    .collect();
    let adapters: Vec<Json> = query_rows(
        conn,
        "SELECT name, command, args FROM adapters ORDER BY name",
        &[],
    )
    .into_iter()
    .map(|r| with_json_column(r, "args"))
    .collect();
    let sources: Vec<Json> = query_rows(
        conn,
        "SELECT source_id, name, adapter, config, env FROM sources ORDER BY name",
        &[],
    )
    .into_iter()
    .map(|r| with_json_column(with_json_column(r, "config"), "env"))
    .collect();
    let attachments = query_rows(
        conn,
        "SELECT repo_id, source_id FROM attachments ORDER BY repo_id, source_id",
        &[],
    );
    let sync_state = query_rows(
        conn,
        "SELECT repo_id, source_id, path, revision, cursor FROM sync_state ORDER BY repo_id, source_id, path",
        &[],
    );
    let ws: Option<String> = conn
        .query_row(
            "SELECT settings FROM workspace_settings WHERE id = 0",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let workspace_settings = ws.map_or_else(|| json!({}), |t| parse_json_text(&t));
    let mut statuses = Vec::new();
    for r in &repos {
        let st = repos_status(store, str_of(r, "repo_id"), None).map_err(|e| e.to_string())?;
        statuses.push(json!({
            "slug": r["slug"], "docs": st.docs, "blocks": st.blocks, "commits": st.commits,
            "open_edges": st.open_edges, "unconverged": st.unconverged,
        }));
    }
    Ok(vec![
        ("repos".to_owned(), Json::Array(repos)),
        ("adapters".to_owned(), Json::Array(adapters)),
        ("sources".to_owned(), Json::Array(sources)),
        ("attachments".to_owned(), Json::Array(attachments)),
        ("sync_state".to_owned(), Json::Array(sync_state)),
        ("workspace_settings".to_owned(), workspace_settings),
        ("repos_status".to_owned(), Json::Array(statuses)),
    ])
}

fn run_registry_case(c: &Json) -> Result<Json, String> {
    let mut store = fresh_store();
    let mut steps = Vec::new();
    for (i, step) in c["steps"].as_array().ok_or("steps")?.iter().enumerate() {
        steps.push(run_registry_step(&mut store, step).map_err(|e| format!("step {i}: {e}"))?);
    }
    let mut actual = JsonMap::new();
    actual.insert("steps".to_owned(), Json::Array(steps));
    for (k, v) in project_registry(&store)? {
        actual.insert(k, v);
    }
    Ok(Json::Object(actual))
}

// ---- checkpoint.json ------------------------------------------------------------------

struct Evaluation {
    actual: Json,
    problems: Vec<String>,
}

fn checkpoint_outcome(r: &omgbase_sync::CheckpointResult) -> Json {
    r.to_json()
}

fn run_checkpoint_case(c: &Json) -> Result<Evaluation, String> {
    let config = Config::default();
    let mut store = fresh_store();
    let repo_id =
        registry::ensure_repo(&mut store, FIXTURE_REPO_SLUG, None).map_err(|e| e.to_string())?;
    let mut fs = MemFileSystem::new();
    let root = Path::new(FIXTURE_ROOT);
    // The bytes the store is supposed to hold per live path (I1): refreshed
    // from the filesystem for every path an ingesting step touched.
    let mut last_source: HashMap<String, String> = HashMap::new();
    let mut steps = Vec::new();
    let mut problems = Vec::new();
    for (i, step) in c["steps"].as_array().ok_or("steps")?.iter().enumerate() {
        let obj = step.as_object().ok_or("step")?;
        let (kind, body) = obj.iter().next().ok_or("empty step")?;
        let mut touched: Vec<String> = Vec::new();
        let mut ingesting = false;
        let outcome = match kind.as_str() {
            "disk" => {
                fs.set(
                    body["path"].as_str().ok_or("disk.path")?,
                    body["content"].as_str().ok_or("disk.content")?,
                    body["mtime_ns"].as_i64().ok_or("disk.mtime_ns")?,
                );
                json!({})
            }
            "rm" => {
                fs.remove(body["path"].as_str().ok_or("rm.path")?);
                json!({})
            }
            "sweep" => {
                let r = freshness_sweep(
                    &mut store,
                    &repo_id,
                    &fs,
                    root,
                    body["ts"].as_str().ok_or("sweep.ts")?,
                    body.get("git_head").and_then(Json::as_str),
                    &config,
                )
                .map_err(|e| e.to_string())?;
                touched.extend(r.checkpoint.ingested.iter().cloned());
                touched.extend(r.checkpoint.suppressed.iter().cloned());
                touched.extend(r.checkpoint.conflicted.iter().cloned());
                touched.extend(r.checkpoint.deleted.iter().cloned());
                ingesting = true;
                r.to_json()
            }
            "checkpoint" => {
                let paths = strings_of(body.get("paths"));
                let r = process_checkpoint(
                    &mut store,
                    &repo_id,
                    &fs,
                    root,
                    &paths,
                    body["ts"].as_str().ok_or("checkpoint.ts")?,
                    body.get("git_head").and_then(Json::as_str),
                    &config,
                )
                .map_err(|e| e.to_string())?;
                touched.extend(paths);
                ingesting = true;
                checkpoint_outcome(&r)
            }
            "drift" => {
                let d =
                    detect_disk_drift(&store, &repo_id, &fs, root).map_err(|e| e.to_string())?;
                json!({ "changed": d.changed, "deleted": d.deleted, "untracked": d.untracked })
            }
            "recover" => {
                let r = recover_repo(
                    &mut store,
                    &repo_id,
                    &fs,
                    root,
                    body["ts"].as_str().ok_or("recover.ts")?,
                    &config,
                )
                .map_err(|e| e.to_string())?;
                touched.extend(r.healed.iter().cloned());
                ingesting = true;
                r.to_json()
            }
            "rebuild_stats" => {
                let n =
                    rebuild_file_stats(&store, &repo_id, &fs, root).map_err(|e| e.to_string())?;
                json!({ "scanned": n })
            }
            other => return Err(format!("unknown checkpoint step {other}")),
        };
        for p in touched {
            match fs.get(&p) {
                Some(f) => {
                    last_source.insert(p, f.content.clone());
                }
                None => {
                    last_source.remove(&p);
                }
            }
        }
        steps.push(outcome);
        if ingesting {
            for p in check_invariants(&store, &repo_id, &last_source) {
                problems.push(format!("after step {i}: {p}"));
            }
        }
    }
    for p in check_invariants(&store, &repo_id, &last_source) {
        problems.push(format!("at end: {p}"));
    }
    let mut actual = JsonMap::new();
    actual.insert("steps".to_owned(), Json::Array(steps));
    for (k, v) in project_store(store.conn(), &repo_id) {
        actual.insert(k, v);
    }
    for (k, v) in project_sync_tables(store.conn(), &repo_id) {
        actual.insert(k, v);
    }
    Ok(Evaluation {
        actual: Json::Object(actual),
        problems,
    })
}

/// `checkpoints` (by `ts`, then insertion) with `files` parsed, and
/// `file_stats` by path.
fn project_sync_tables(conn: &Connection, repo_id: &str) -> Vec<(String, Json)> {
    let checkpoints: Vec<Json> = query_rows(
        conn,
        "SELECT id, ts, files, git_head FROM checkpoints WHERE repo_id = ?1 ORDER BY ts, rowid",
        &[&repo_id],
    )
    .into_iter()
    .map(|r| with_json_column(r, "files"))
    .collect();
    let file_stats = query_rows(
        conn,
        "SELECT path, mtime_ns, size, hash FROM file_stats WHERE repo_id = ?1 ORDER BY path",
        &[&repo_id],
    );
    vec![
        ("checkpoints".to_owned(), Json::Array(checkpoints)),
        ("file_stats".to_owned(), Json::Array(file_stats)),
    ]
}

// ---- protocol.json (kind `adapter`) ----------------------------------------------------

struct AdapterEvaluation {
    actual: Json,
    /// The request lines the scripted adapter received (the engine's `out` lines).
    received: Vec<String>,
}

fn classify_connect_error(e: &SyncError) -> Result<&'static str, String> {
    match e {
        SyncError::AdapterHandshake { .. } => Ok("invalid_handshake"),
        SyncError::AdapterExited { .. } => Ok("exited"),
        SyncError::AdapterSpawn { .. } => Ok("spawn"),
        other => Err(format!("unexpected connect error: {other}")),
    }
}

/// Issue the request an `out` line spells through the source and record the
/// result as the reference's `playRequest` does.
fn play_request(
    source: &mut ExternalSource,
    line: &str,
    watches: &mut Vec<Receiver<Vec<String>>>,
) -> Result<Json, String> {
    let req: Json = serde_json::from_str(line).map_err(|e| format!("out line: {e}"))?;
    let method = req["method"].as_str().unwrap_or("");
    let p = |k: &str| req["params"][k].as_str().unwrap_or("").to_owned();
    let caps = source.capabilities();
    let adapter_error = |e: SyncError| -> Result<Json, String> {
        match e {
            SyncError::AdapterError { message, .. } => Ok(json!({ "error": message })),
            other => Err(format!("unexpected source error: {other}")),
        }
    };
    match method {
        "enumerate" => match source.enumerate() {
            Ok(entries) => Ok(
                json!({ "entries": entries.iter().map(SourceEntry::to_json).collect::<Vec<_>>() }),
            ),
            Err(e) => adapter_error(e),
        },
        "fetch" => match source.fetch(&p("path")) {
            Ok(item) => Ok(json!({ "item": item.as_ref().map(SourceItem::to_json) })),
            Err(e) => adapter_error(e),
        },
        "write" => {
            if !caps.write_through {
                return Ok(json!({ "error": "unsupported" }));
            }
            match source.write(&p("path"), &p("content")) {
                Ok(()) => Ok(json!({ "ok": true })),
                Err(e) => adapter_error(e),
            }
        }
        "remove" => {
            if !caps.write_through {
                return Ok(json!({ "error": "unsupported" }));
            }
            match source.remove(&p("path")) {
                Ok(()) => Ok(json!({ "ok": true })),
                Err(e) => adapter_error(e),
            }
        }
        "watch" => {
            if !caps.watch {
                return Ok(json!({ "error": "unsupported" }));
            }
            match source.watch() {
                Ok(rx) => {
                    watches.push(rx);
                    Ok(json!({ "ok": true }))
                }
                Err(e) => adapter_error(e),
            }
        }
        "unwatch" => {
            if watches.is_empty() {
                return Ok(json!({ "error": "no watch" }));
            }
            // The receiver stays alive so the events it carried can be drained.
            source.unwatch().map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        other => Ok(json!({ "error": format!("unknown method {other}") })),
    }
}

fn run_adapter_case(c: &Json) -> Result<AdapterEvaluation, String> {
    let transcript: Vec<(Dir, String)> = c["transcript"]
        .as_array()
        .ok_or("transcript")?
        .iter()
        .map(|e| {
            (
                if e["dir"] == "in" { Dir::In } else { Dir::Out },
                e["line"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect();
    let (adapter, from_adapter, to_adapter) = ScriptedAdapter::spawn(transcript.clone());
    let mut source = match ExternalSource::connect("fake", from_adapter, to_adapter) {
        Ok(s) => s,
        Err(e) => {
            let code = classify_connect_error(&e)?;
            return Ok(AdapterEvaluation {
                actual: json!({ "error": code }),
                received: adapter.received(),
            });
        }
    };
    let caps = source.capabilities();
    let mut results = Vec::new();
    let mut watches: Vec<Receiver<Vec<String>>> = Vec::new();
    let mut failure = None;
    for (dir, line) in &transcript {
        if *dir != Dir::Out {
            continue;
        }
        match play_request(&mut source, line, &mut watches) {
            Ok(r) => results.push(r),
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    source.close().map_err(|e| e.to_string())?;
    if let Some(e) = failure {
        return Err(e);
    }
    let mut events: Vec<Json> = Vec::new();
    for rx in &watches {
        while let Ok(paths) = rx.try_recv() {
            events.push(json!(paths));
        }
    }
    Ok(AdapterEvaluation {
        actual: json!({
            "capabilities": {
                "identity": caps.identity.as_str(),
                "write_through": caps.write_through,
                "watch": caps.watch,
            },
            "results": results,
            "events": events,
        }),
        received: adapter.received(),
    })
}

// ---- protocol.json (kind `coordinator`) ------------------------------------------------

type Calls = Rc<RefCell<Vec<Json>>>;

/// The reference's `ScriptedSource`: insertion-ordered files whose `revision`
/// is a per-path write counter; every call recorded.
struct RecordingSource {
    write_through: bool,
    files: Vec<(String, String, u64)>,
    calls: Calls,
}

impl RecordingSource {
    fn set(&mut self, path: &str, content: &str) {
        match self.files.iter_mut().find(|(p, _, _)| p == path) {
            Some(f) => {
                f.1 = content.to_owned();
                f.2 += 1;
            }
            None => self.files.push((path.to_owned(), content.to_owned(), 1)),
        }
    }

    fn rm(&mut self, path: &str) {
        self.files.retain(|(p, _, _)| p != path);
    }

    fn snapshot(&self) -> Json {
        let mut sorted: Vec<&(String, String, u64)> = self.files.iter().collect();
        sorted.sort_by(|a, b| a.0.cmp(&b.0));
        Json::Object(
            sorted
                .into_iter()
                .map(|(p, c, _)| (p.clone(), json!(c)))
                .collect(),
        )
    }
}

impl SyncSource for RecordingSource {
    fn capabilities(&self) -> SourceCapabilities {
        SourceCapabilities {
            identity: SourceIdentity::Inferred,
            write_through: self.write_through,
            watch: false,
        }
    }

    fn enumerate(&mut self) -> omgbase_sync::Result<Vec<SourceEntry>> {
        self.calls
            .borrow_mut()
            .push(json!({ "source": "enumerate" }));
        Ok(self
            .files
            .iter()
            .map(|(p, _, rev)| SourceEntry {
                path: p.clone(),
                revision: rev.to_string(),
                source_id: None,
            })
            .collect())
    }

    fn fetch(&mut self, path: &str) -> omgbase_sync::Result<Option<SourceItem>> {
        self.calls
            .borrow_mut()
            .push(json!({ "source": "fetch", "path": path }));
        Ok(self
            .files
            .iter()
            .find(|(p, _, _)| p == path)
            .map(|(p, c, rev)| SourceItem {
                entry: SourceEntry {
                    path: p.clone(),
                    revision: rev.to_string(),
                    source_id: None,
                },
                content: c.clone(),
            }))
    }

    fn write(&mut self, path: &str, content: &str) -> omgbase_sync::Result<()> {
        self.calls
            .borrow_mut()
            .push(json!({ "source": "write", "path": path, "content": content }));
        self.set(path, content);
        Ok(())
    }

    fn remove(&mut self, path: &str) -> omgbase_sync::Result<()> {
        self.calls
            .borrow_mut()
            .push(json!({ "source": "remove", "path": path }));
        self.rm(path);
        Ok(())
    }
}

/// The reference's `RecordingEngine`: the in-process client with a pinned
/// `ts` and page limit, every call recorded.
struct RecordingEngine<'a> {
    inner: InProcessEngineClient<'a>,
    page_limit: Option<usize>,
    calls: Calls,
}

impl EngineClient for RecordingEngine<'_> {
    fn observe_many(&mut self, files: &[FileBytes]) -> omgbase_sync::Result<Vec<ObserveOutcome>> {
        self.calls.borrow_mut().push(json!({
            "engine": "observe_many",
            "files": files.iter().map(|f| json!({ "path": f.path, "content": f.content })).collect::<Vec<_>>(),
        }));
        self.inner.observe_many(files)
    }

    fn observe_delete(&mut self, path: &str) -> omgbase_sync::Result<DeleteOutcome> {
        self.calls
            .borrow_mut()
            .push(json!({ "engine": "observe_delete", "path": path }));
        self.inner.observe_delete(path)
    }

    fn changes_since(
        &mut self,
        cursor: i64,
        limit: Option<usize>,
        origin: Option<&str>,
    ) -> omgbase_sync::Result<ChangesPage> {
        let limit = limit.or(self.page_limit);
        let mut call = json!({ "engine": "changes_since", "cursor": cursor });
        if let Some(l) = limit {
            call["limit"] = json!(l);
        }
        self.calls.borrow_mut().push(call);
        self.inner.changes_since(cursor, limit, origin)
    }

    fn read_doc(&mut self, path: &str) -> omgbase_sync::Result<Option<DocBytes>> {
        self.calls
            .borrow_mut()
            .push(json!({ "engine": "read_doc", "path": path }));
        self.inner.read_doc(path)
    }
}

fn run_engine_step(
    store: &mut Store,
    repo_id: &str,
    s: &JsonMap<String, Json>,
) -> Result<Json, String> {
    let ts = s.get("ts").and_then(Json::as_str).ok_or("engine.ts")?;
    let ctx = |actor: Option<&Json>| DocOpContext {
        repo_id: repo_id.to_owned(),
        actor: actor.and_then(Json::as_str).map(str::to_owned),
        ts: ts.to_owned(),
    };
    if let Some(c) = s.get("create") {
        let res = store
            .docs_create(
                &ctx(c.get("actor")),
                &mut NullDocStore,
                c["path"].as_str().unwrap_or(""),
                c["markdown"].as_str().unwrap_or(""),
                Some(&JsonMap::new()),
            )
            .map_err(|e| e.to_string())?;
        return Ok(json!({ "doc": res.doc_id, "committed": res.committed }));
    }
    if let Some(im) = s.get("import") {
        let res = store
            .fresh_ingest(
                repo_id,
                im["path"].as_str().unwrap_or(""),
                im["content"].as_str().unwrap_or(""),
                ts,
                Origin::Import,
            )
            .map_err(|e| e.to_string())?;
        return Ok(json!({ "doc": res.doc_id, "commit": res.commit_id }));
    }
    if let Some(d) = s.get("delete") {
        let res = store
            .docs_delete(
                &ctx(d.get("actor")),
                &mut NullDocStore,
                d["path"].as_str().unwrap_or(""),
            )
            .map_err(|e| e.to_string())?;
        return Ok(json!({ "doc": res.doc_id, "committed": res.committed }));
    }
    let items: Vec<BatchItem> = s
        .get("observe")
        .and_then(Json::as_array)
        .map(|a| {
            a.iter()
                .map(|o| {
                    BatchItem::observed(
                        o["path"].as_str().unwrap_or(""),
                        o["content"].as_str().unwrap_or(""),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let outcomes = store
        .observe_batch(repo_id, &items, ts, &Config::default())
        .map_err(|e| e.to_string())?;
    store.sweep_pool(ts).map_err(|e| e.to_string())?;
    let observed: Vec<Json> = outcomes
        .iter()
        .map(|o| match o {
            BatchOutcome::Observed(ob) => {
                json!({ "path": ob.path, "echo": ob.echo, "commit": ob.commit_id })
            }
            BatchOutcome::Deleted(d) => {
                json!({ "path": d.path, "echo": false, "commit": Json::Null })
            }
        })
        .collect();
    Ok(json!({ "observed": observed }))
}

fn in_summary(s: &omgbase_sync::SyncInSummary, calls: &Calls) -> Json {
    let mut v = s.to_json();
    v["calls"] = Json::Array(calls.borrow().clone());
    v
}

fn out_summary(s: &omgbase_sync::SyncOutSummary, calls: &Calls) -> Json {
    let mut v = s.to_json();
    v["calls"] = Json::Array(calls.borrow().clone());
    v
}

fn run_coordinator_case(c: &Json) -> Result<Json, String> {
    let mut store = fresh_store();
    let repo_id =
        registry::ensure_repo(&mut store, FIXTURE_REPO_SLUG, None).map_err(|e| e.to_string())?;
    let calls: Calls = Rc::new(RefCell::new(Vec::new()));
    let mut source = RecordingSource {
        write_through: c["source"]["write_through"].as_bool().unwrap_or(true),
        files: Vec::new(),
        calls: Rc::clone(&calls),
    };
    let page_limit = c
        .get("page_limit")
        .and_then(Json::as_u64)
        .map(|n| n as usize);
    let ts_cell: Rc<RefCell<String>> = Rc::new(RefCell::new("1970-01-01T00:00:00.000Z".to_owned()));
    let mut steps = Vec::new();
    for (i, step) in c["steps"].as_array().ok_or("steps")?.iter().enumerate() {
        let obj = step.as_object().ok_or("step")?;
        let (kind, body) = obj.iter().next().ok_or("empty step")?;
        calls.borrow_mut().clear();
        let outcome = match kind.as_str() {
            "source" => {
                for (path, content) in obj_of(body.get("set")) {
                    source.set(&path, content.as_str().unwrap_or(""));
                }
                for path in strings_of(body.get("rm")) {
                    source.rm(&path);
                }
                json!({})
            }
            "engine" => run_engine_step(&mut store, &repo_id, body.as_object().ok_or("engine")?)
                .map_err(|e| format!("step {i}: {e}"))?,
            "sync_in" | "reconcile" | "sync_out" => {
                if let Some(ts) = body.get("ts").and_then(Json::as_str) {
                    *ts_cell.borrow_mut() = ts.to_owned();
                }
                let clock_ts = Rc::clone(&ts_cell);
                let inner = InProcessEngineClient::new(&mut store, &repo_id)
                    .with_clock(move || clock_ts.borrow().clone());
                let mut engine = RecordingEngine {
                    inner,
                    page_limit,
                    calls: Rc::clone(&calls),
                };
                let mut co = Coordinator::new(&mut engine, &mut source);
                let r = match kind.as_str() {
                    "sync_in" => co.sync_in().map(|s| in_summary(&s, &calls)),
                    "reconcile" => co
                        .reconcile(&strings_of(body.get("paths")))
                        .map(|s| in_summary(&s, &calls)),
                    _ => co
                        .sync_out(body.get("cursor").and_then(Json::as_i64).unwrap_or(0))
                        .map(|s| out_summary(&s, &calls)),
                };
                r.map_err(|e| format!("step {i}: {e}"))?
            }
            other => return Err(format!("unknown coordinator step {other}")),
        };
        steps.push(outcome);
    }
    let docs: Vec<Json> = query_rows(
        store.conn(),
        "SELECT doc_id, path, deleted_commit FROM docs WHERE repo_id = ?1 ORDER BY path",
        &[&repo_id],
    )
    .into_iter()
    .map(|d| json!({ "doc_id": d["doc_id"], "path": d["path"], "deleted": !d["deleted_commit"].is_null() }))
    .collect();
    let commits = query_rows(
        store.conn(),
        "SELECT commit_id, seq, origin, actor FROM commits WHERE repo_id = ?1 ORDER BY seq",
        &[&repo_id],
    );
    Ok(json!({
        "steps": steps,
        "files": source.snapshot(),
        "docs": docs,
        "commits": commits,
    }))
}

// ---- running a case ----------------------------------------------------------------------

fn check(c: &SpecCase) -> Result<(), String> {
    let (actual, problems) = match c.kind {
        Kind::Pure => (run_pure(&c.case)?, Vec::new()),
        Kind::Registry => (run_registry_case(&c.case)?, Vec::new()),
        Kind::Checkpoint => {
            let ev = run_checkpoint_case(&c.case)?;
            (ev.actual, ev.problems)
        }
        Kind::Adapter => {
            let ev = run_adapter_case(&c.case)?;
            let want: Vec<&str> = c.case["transcript"]
                .as_array()
                .map(|t| {
                    t.iter()
                        .filter(|e| e["dir"] == "out")
                        .filter_map(|e| e["line"].as_str())
                        .collect()
                })
                .unwrap_or_default();
            let mut problems = Vec::new();
            if ev.received.len() != want.len() {
                problems.push(format!(
                    "the adapter received {} request line(s) for {} `out` entries: {:?}",
                    ev.received.len(),
                    want.len(),
                    ev.received
                ));
            } else {
                for (i, (got, exp)) in ev.received.iter().zip(&want).enumerate() {
                    if got != exp {
                        problems.push(format!(
                            "request {i}: engine sent {got}, transcript says {exp}"
                        ));
                    }
                }
            }
            (ev.actual, problems)
        }
        Kind::Coordinator => (run_coordinator_case(&c.case)?, Vec::new()),
    };
    if !problems.is_empty() {
        return Err(clip(format!("problems: {}", problems.join("; "))));
    }
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
    std::env::var("SYNC_SPEC_UPDATE").is_ok_and(|v| !v.is_empty() && v != "0")
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
        "cases that pass but are not listed in spec-passing.txt — add them (or run SYNC_SPEC_UPDATE=1 cargo test -p omgbase-sync --test spec)",
        &unlisted_passing,
    );
    report("stale allowlist entries", &stale);
    if passing == all_ids {
        eprintln!(
            "spec: every case passes — delete tests/spec-passing.txt (or run with SYNC_SPEC_UPDATE=1)"
        );
    }
    assert!(
        regressions.is_empty() && unlisted_passing.is_empty() && stale.is_empty(),
        "spec allowlist out of date: {} regression(s), {} unlisted passing, {} stale — see the report above (stderr); \
         promote with `SYNC_SPEC_UPDATE=1 cargo test -p omgbase-sync --test spec`",
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

/// `spec/sync/VERSION` is the version this crate implements.
#[test]
fn version_agrees_with_the_spec() {
    let version_file = Path::new(SPEC_DIR).join("VERSION");
    if !version_file.is_file() {
        eprintln!("spec: {} not present; skipping", version_file.display());
        return;
    }
    let version = fs::read_to_string(version_file).expect("VERSION");
    assert_eq!(omgbase_sync::SPEC_VERSION, version.trim());
}

// ---- borrowed from the store runner (spec/store §9.4 projection, §8 invariants) ----

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
