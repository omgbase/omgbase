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
use std::time::{Duration, Instant};

use omgbase_format::hash::{hex, sha256};
use omgbase_reconcile::Config;
use omgbase_store::delta::{
    Form, Node, ResolvedList, ResolvedTree, TreeResolver, encode_body_delta,
    encode_frontmatter_delta, entry_text, explicit_entries, full_node_text, is_checkpoint_seq,
    parse_frontmatter_blob, parse_node_text,
};
use omgbase_store::{
    BatchItem, BatchOutcome, DocOpContext, NullDocStore, Origin, SequentialMinter, Store, TreeEntry,
};
use omgbase_sync::engine::{DocBytes, EngineClient, FileBytes, InProcessEngineClient};
use omgbase_sync::freshness::{CacheRow, DiskEntry};
use omgbase_sync::pipe::{Dir, ScriptedAdapter};
use omgbase_sync::registry::NewSource;
use omgbase_sync::source::{SourceCapabilities, SourceEntry, SourceIdentity, SourceItem};
use omgbase_sync::{
    ChangesPage, Coordinator, DeleteOutcome, DocListing, Error as SyncError, ExternalSource,
    FileStat, MemFileSystem, ObserveOutcome, RepoRow, SyncSource, WatchEvent, deep_merge,
    detect_disk_drift, freshness_sweep, process_checkpoint, rebuild_file_stats, recover_repo,
    registry, render_config_flags, repos_status, select_repo, settings, sweep_plan,
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
const CHECKPOINT_PROJECTION_KEYS: [&str; 17] = [
    "steps",
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
    "sections",
    "pending_materializations",
    "archives",
    "sync_state",
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
            only_keys(body, &["ts"], here, problems);
            require_ts(body, here, problems);
        }
        "checkpoint" => {
            only_keys(body, &["ts", "paths"], here, problems);
            require_ts(body, here, problems);
            match body.get("paths").and_then(Json::as_array) {
                Some(paths) => {
                    for (j, p) in paths.iter().enumerate() {
                        require_path(Some(p), &format!("{here}.paths[{j}]"), problems);
                    }
                }
                None => problems.push(format!("{here}: `paths` must be an array")),
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
            only_keys(body, &["cursor", "epoch"], here, problems);
            if body.get("cursor").is_some_and(|v| !v.is_number()) {
                problems.push(format!("{here}: `cursor` must be a number"));
            }
            if body.get("epoch").is_some_and(|v| !v.is_string()) {
                problems.push(format!("{here}: `epoch` must be a string"));
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

/// §8 (1.2): `events` is the ordered list of parsed event objects the watch
/// listener received — `{"event":"ready"}` or `{"event":"batch","paths":
/// [<string>…]}` — never the pre-1.2 `[[paths]]` shape.
fn validate_events(at: &str, events: &Json, problems: &mut Vec<String>) {
    let Some(list) = events.as_array() else {
        problems.push(format!("{at}: must be an array of event objects"));
        return;
    };
    for (i, e) in list.iter().enumerate() {
        let ok = e
            .as_object()
            .is_some_and(|o| match o.get("event").and_then(Json::as_str) {
                Some("ready") => o.len() == 1,
                Some("batch") => {
                    o.len() == 2
                        && o.get("paths")
                            .and_then(Json::as_array)
                            .is_some_and(|p| p.iter().all(Json::is_string))
                }
                _ => false,
            });
        if !ok {
            problems.push(format!(
                "{at}[{i}]: an event is {{\"event\":\"ready\"}} or {{\"event\":\"batch\",\"paths\":[…]}} (sync 1.2)"
            ));
        }
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
                                if let Some(events) = o.get("events") {
                                    validate_events(
                                        &format!("{at}.expect.events"),
                                        events,
                                        &mut problems,
                                    );
                                }
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
        "SELECT repo_id, slug, settings, epoch FROM repos ORDER BY slug",
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
        "SELECT repo_id, source_id, path, revision, cursor, last_batch_ts, last_batch_id, last_batch_files FROM sync_state ORDER BY repo_id, source_id, path",
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
        // 4.0: the feed's `{ epoch, oldest, head }` in place of `commits`;
        // `unconverged` retired.
        statuses.push(json!({
            "slug": r["slug"], "docs": st.docs, "blocks": st.blocks, "feed": st.feed.to_json(),
            "open_edges": st.open_edges,
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

fn checkpoint_outcome(r: &omgbase_sync::BatchResult) -> Json {
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
                    &config,
                )
                .map_err(|e| e.to_string())?;
                touched.extend(r.batch.ingested.iter().cloned());
                touched.extend(r.batch.suppressed.iter().cloned());
                touched.extend(r.batch.conflicted.iter().cloned());
                touched.extend(r.batch.deleted.iter().cloned());
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

/// The repo's `sync_state` rows (by `source_id`, `path`; `repo_id` omitted —
/// the status row among them, 4.0) and `file_stats` by path.
fn project_sync_tables(conn: &Connection, repo_id: &str) -> Vec<(String, Json)> {
    let sync_state = query_rows(
        conn,
        "SELECT source_id, path, revision, cursor, last_batch_ts, last_batch_id, last_batch_files FROM sync_state WHERE repo_id = ?1 ORDER BY source_id, path",
        &[&repo_id],
    );
    let file_stats = query_rows(
        conn,
        "SELECT path, mtime_ns, size, hash FROM file_stats WHERE repo_id = ?1 ORDER BY path",
        &[&repo_id],
    );
    vec![
        ("sync_state".to_owned(), Json::Array(sync_state)),
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
    watches: &mut Vec<Receiver<WatchEvent>>,
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

/// Whether an `in` transcript line is an unsolicited event (`{"event": …}`)
/// rather than a response.
fn is_event_line(line: &str) -> bool {
    serde_json::from_str::<Json>(line)
        .ok()
        .and_then(|v| v.get("event").and_then(Json::as_str).map(str::to_owned))
        .is_some()
}

/// The runner's patience for the events a transcript promises (§8 Ordering:
/// a shortfall is a failure, not a wait forever).
const EVENT_PATIENCE: Duration = Duration::from_secs(5);

/// §8 Ordering (1.2): before the next `out` request, receive from the live
/// watch stream until `events` holds as many as the transcript promised
/// (the `in` event lines since the `watch` request); a shortfall within
/// [`EVENT_PATIENCE`] fails the case by name.
fn await_promised_events(
    case: &str,
    rx: Option<&Receiver<WatchEvent>>,
    events: &mut Vec<Json>,
    promised: usize,
    before: &str,
) -> Result<(), String> {
    if events.len() >= promised {
        return Ok(());
    }
    let Some(rx) = rx else {
        return Err(format!(
            "{case}: the transcript promises {promised} event(s) before `{before}` but no watch is live"
        ));
    };
    let deadline = Instant::now() + EVENT_PATIENCE;
    while events.len() < promised {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(ev) => events.push(ev.to_json()),
            Err(_) => {
                return Err(format!(
                    "{case}: the watch stream yielded {} event(s) where the transcript promises {promised} before `{before}` (waited {EVENT_PATIENCE:?}); received so far: {}",
                    events.len(),
                    Json::Array(events.clone())
                ));
            }
        }
    }
    Ok(())
}

fn run_adapter_case(c: &Json) -> Result<AdapterEvaluation, String> {
    let case = c["name"].as_str().unwrap_or("<unnamed>");
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
    let mut watches: Vec<Receiver<WatchEvent>> = Vec::new();
    // The events the listener received, in order, as the wire spells them.
    let mut events: Vec<Json> = Vec::new();
    // §8 Ordering: `in` event lines since the `watch` request (while the
    // transcript's watch is live — the engine drops events outside one, so
    // lines before `watch` or after `unwatch` are not waited for).
    let mut promised = 0usize;
    let mut watch_live = false;
    let mut failure = None;
    for (dir, line) in &transcript {
        match dir {
            Dir::In => {
                if watch_live && is_event_line(line) {
                    promised += 1;
                }
            }
            Dir::Out => {
                if let Err(e) =
                    await_promised_events(case, watches.last(), &mut events, promised, line)
                {
                    failure = Some(e);
                    break;
                }
                let method = serde_json::from_str::<Json>(line)
                    .ok()
                    .and_then(|r| r["method"].as_str().map(str::to_owned))
                    .unwrap_or_default();
                let before = watches.len();
                match play_request(&mut source, line, &mut watches) {
                    Ok(r) => results.push(r),
                    Err(e) => {
                        failure = Some(e);
                        break;
                    }
                }
                if method == "watch" && watches.len() > before {
                    watch_live = true;
                } else if method == "unwatch" {
                    watch_live = false;
                }
            }
        }
    }
    source.close().map_err(|e| e.to_string())?;
    if let Some(e) = failure {
        return Err(e);
    }
    // Whatever else the streams carried (the adapter has closed by now).
    for rx in &watches {
        while let Ok(ev) = rx.try_recv() {
            events.push(ev.to_json());
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
        epoch: Option<&str>,
        limit: Option<usize>,
        origin: Option<&str>,
    ) -> omgbase_sync::Result<ChangesPage> {
        let limit = limit.or(self.page_limit);
        // The call is recorded with the cursor's epoch when the coordinator
        // sent one (4.0: a cursor is `(epoch, seq)`).
        let mut call = json!({ "engine": "changes_since", "cursor": cursor });
        if let Some(e) = epoch {
            call["epoch"] = json!(e);
        }
        if let Some(l) = limit {
            call["limit"] = json!(l);
        }
        self.calls.borrow_mut().push(call);
        self.inner.changes_since(cursor, epoch, limit, origin)
    }

    fn list_docs(&mut self) -> omgbase_sync::Result<Vec<DocListing>> {
        self.calls
            .borrow_mut()
            .push(json!({ "engine": "list_docs" }));
        self.inner.list_docs()
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
                        .sync_out(
                            body.get("cursor").and_then(Json::as_i64).unwrap_or(0),
                            body.get("epoch").and_then(Json::as_str),
                        )
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
        "SELECT doc_id, path, deleted_at FROM docs WHERE repo_id = ?1 ORDER BY path",
        &[&repo_id],
    )
    .into_iter()
    .map(|d| json!({ "doc_id": d["doc_id"], "path": d["path"], "deleted": !d["deleted_at"].is_null() }))
    .collect();
    // 4.0: the projection reads the feed (the core's); the recorder's
    // `commits` is its twin.
    let commits = query_rows(
        store.conn(),
        "SELECT commit_id, seq, origin, actor FROM feed WHERE repo_id = ?1 ORDER BY seq",
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

    let commits = query_rows(
        conn,
        "SELECT commit_id, epoch, seq, ts, origin, actor, reason, batch_id, ops FROM commits WHERE repo_id = ?1 ORDER BY seq",
        &[&repo_id],
    );
    let commit_seq: HashMap<String, i64> = commits
        .iter()
        .map(|c| (str_of(c, "commit_id").to_owned(), int_of(c, "seq")))
        .collect();
    let seq_of = |id: &str| commit_seq.get(id).copied().unwrap_or(i64::MAX);
    // 17.0 (3d): the feed and its entries — the rows of the repo's current
    // epoch, by `seq`; the entries of a row in the order they were written.
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

    let mut revisions = query_rows(
        conn,
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
    // `spec/store` §9.4 (15.0): the recorded segments by `(seq_lo,
    // segment_id)`, `path` as its file name, `bytes` omitted.
    let archives: Vec<Json> = query_rows(
        conn,
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
    /// `None` once archived (`spec/store` 15.0).
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
            }
        }
    }

    let blob_rows: Vec<(Vec<u8>, Vec<u8>, i64)> =
        all_rows(conn, "SELECT hash, bytes, size FROM blobs", &[], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        });
    let blob_hashes: HashSet<String> = blob_rows.iter().map(|b| hex(&b.0)).collect();
    let blob_text: HashMap<String, String> = blob_rows
        .iter()
        .map(|b| (hex(&b.0), String::from_utf8_lossy(&b.1).into_owned()))
        .collect();
    let tree_rows: Vec<(Vec<u8>, String)> =
        all_rows(conn, "SELECT hash, entries FROM tree_nodes", &[], |r| {
            Ok((r.get(0)?, r.get(1)?))
        });
    let tree_hashes: HashSet<String> = tree_rows.iter().map(|t| hex(&t.0)).collect();
    let node_texts: HashMap<String, &str> = tree_rows
        .iter()
        .map(|t| (hex(&t.0), t.1.as_str()))
        .collect();
    // 16.0: a node is a `[`-form list or a `{"d":…}` delta (§4.1 "Delta nodes").
    let mut nodes: HashMap<String, Node> = HashMap::new();
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
    let revisions: Vec<Rev> = all_rows(
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
    );
    // I9 (`spec/store` 15.0): `archive IS NOT NULL` ⇔ `root_tree IS NULL`.
    for r in &revisions {
        if r.archive.is_some() != r.root_tree.is_none() {
            problems.push(format!(
                "I9: revision {} archive/root_tree disagree",
                r.rev_id
            ));
        }
    }
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
    // F1: every head still within retention has its entry. When nothing was
    // pruned (oldest ≤ 1) every live doc's head and every tombstone's deletion
    // appear; after a prune only the documents whose last change is younger
    // than the oldest retained row are checked.
    let oldest_ts: Option<&str> = feed_by_seq.first().map(|r| r.3.as_str());
    let heads_in_feed: HashSet<&str> = entries.iter().filter_map(|e| e.4.as_deref()).collect();
    let deleted_in_feed: HashSet<&str> = entries
        .iter()
        .filter(|e| e.6 == "deleted")
        .map(|e| e.2.as_str())
        .collect();
    for d in &docs {
        let within = oldest <= 1 || oldest_ts.is_some_and(|t| d.updated_at.as_str() > t);
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
    // H4: the recorder's `commits` agree with the feed on every retained seq.
    let commit_rows: Vec<(String, String, i64, String)> = all_rows(
        conn,
        "SELECT commit_id, epoch, seq, batch_id FROM commits WHERE repo_id = ?1 ORDER BY seq",
        &[&repo_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    );
    let commit_by_seq: HashMap<i64, &(String, String, i64, String)> =
        commit_rows.iter().map(|c| (c.2, c)).collect();
    for r in &feed_by_seq {
        match commit_by_seq.get(&r.1) {
            None => problems.push(format!(
                "H4: feed row {} (seq {}) has no commits row",
                r.2, r.1
            )),
            Some(c) if c.0 != r.2 || c.1 != r.0 || c.3 != r.5 => problems.push(format!(
                "H4: commits row at seq {} ({}, {}, {}) disagrees with the feed ({}, {}, {})",
                r.1, c.0, c.1, c.3, r.2, r.0, r.5
            )),
            Some(_) => {}
        }
    }
    for c in &commit_rows {
        if c.1 != epoch {
            problems.push(format!("H4: commit {} carries epoch {}", c.0, c.1));
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
                if store.reconstruct(&d.doc_id).ok().flatten().as_deref() != Some(source.as_str()) {
                    problems.push(format!("C1: {at} reconstruct(doc) != source"));
                }
            }
        }
        // H1: with legacy capture on, the head IS a captured revision — same
        // path, same bytes, the same commit instant as `updated_at` — and
        // reconstruct at it reproduces the source.
        let Some(rev) = rev_by_id.get(head.as_str()) else {
            problems.push(format!(
                "H1: {at} head {head} has no revisions row (capture disagrees with the head)"
            ));
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
                if r["trivia_hash"].as_str() != e.trivia_hash_hex.as_deref() {
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
            Some(last) if d.head.as_deref() != Some(last.rev_id.as_str()) => {
                problems.push(format!(
                    "I4: doc {} head {:?} is not its greatest-seq revision",
                    d.doc_id, d.head
                ));
            }
            None if d.head.is_some() => {
                problems.push(format!("I4: doc {} has head but no revisions", d.doc_id));
            }
            _ => {}
        }
    }

    // ---- I5 nothing to collect ------------------------------------------------------------
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
                "I5: tree_node {h} is unreachable from every revision"
            ));
        }
    }
    for h in &blob_hashes {
        if !marked_blobs.contains(h) {
            problems.push(format!("I5: blob {h} is unreachable from every revision"));
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

    // ---- I6 pool -------------------------------------------------------------------------
    let live_doc_of = |block_id: &str| -> Option<String> {
        conn.query_row(
            "SELECT doc_id FROM blocks WHERE block_id = ?1 AND deleted_at IS NULL",
            params![block_id],
            |r| r.get(0),
        )
        .optional()
        .expect("query runs")
    };
    // C6 (17.0; I6 restated over the row's own `deleted_at`).
    let pool: Vec<(String, String, String, String)> = all_rows(
        conn,
        "SELECT block_id, created_at, deleted_at, expires_ts FROM resurrection_pool WHERE repo_id = ?1",
        &[&repo_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    );
    for (block_id, created_at, deleted_at, expires_ts) in &pool {
        if omgbase_store::time::parse_ms(deleted_at).is_err() {
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
    let unheld: Vec<String> = all_rows(
        conn,
        "SELECT DISTINCT bc.block_id AS id FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE c.repo_id = ?1 AND bc.block_id != 'DOC'
           AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = bc.block_id AND (ic.holders & 2) != 0)
         UNION SELECT r.rev_id FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE d.repo_id = ?1
           AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = r.rev_id AND (ic.holders & 2) != 0)
         UNION SELECT DISTINCT r.doc_id FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE d.repo_id = ?1
           AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = r.doc_id AND (ic.holders & 2) != 0)
         UNION SELECT c.commit_id FROM commits c WHERE c.repo_id = ?1
           AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = c.commit_id AND (ic.holders & 2) != 0)
         ORDER BY 1",
        &[&repo_id],
        |r| r.get(0),
    );
    for id in unheld {
        problems.push(format!(
            "H6: {id} is named by a history row but its claim lacks the recorder's bit"
        ));
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
        let (Some(head), None) = (&d.head, &d.deleted_at) else {
            continue;
        };
        let Some(rev) = rev_by_id.get(head.as_str()) else {
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
    // 14.2: `same` is never persisted (`spec/store` §5.4 step 10; the §7
    // sweep removes a 14.1 store's), and a block's rows are its own history —
    // so every live block has at least one (its `inserted`, lineage or
    // resurrection row).
    for (commit_id, block_id, kind) in &dispositions {
        if kind == "same" {
            problems.push(format!(
                "I7: disposition {block_id} of {commit_id} is a persisted `same`"
            ));
        }
    }
    // 17.0: qualified by H6 — a block whose commit was wholly archived has no
    // row left; the recorder's hold on its claim is what remains.
    let unchanged: Vec<String> = all_rows(
        conn,
        "SELECT b.block_id FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE d.repo_id = ?1 AND b.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM block_changes bc WHERE bc.block_id = b.block_id)
           AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = b.block_id AND (ic.holders & 2) != 0) ORDER BY b.block_id",
        &[&repo_id],
        |r| r.get(0),
    );
    for block_id in unchanged {
        problems.push(format!(
            "I7: live block {block_id} has no block_changes row and no recorder hold on its claim"
        ));
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
