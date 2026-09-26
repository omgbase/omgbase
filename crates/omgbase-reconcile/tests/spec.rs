//! The reconcile spec conformance runner: executes every fixture under
//! `spec/reconcile/cases` against this implementation. The fixture format,
//! the invariants and the allowlist mechanism are defined in
//! `spec/reconcile/README.md` §9; the reference runner this mirrors is
//! `packages/core/corpus/reconcile/spec.test.ts` (+ `fixture.ts`).
//!
//! Allowlist (`tests/spec-passing.txt`, one `<file-stem>::<name>` per line):
//! while the port is incomplete it names the cases that must pass. A listed
//! case that fails, an unlisted case that passes, or a listed id that no
//! longer exists all fail the build. If the file is absent, every case must
//! pass. Promote cases by rewriting the list to the currently passing set:
//!
//! ```text
//! RECONCILE_SPEC_UPDATE=1 cargo test -p omgbase-reconcile --test spec
//! ```

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use omgbase_format::hash::{hex, norm_hash, raw_hash};
use omgbase_format::text::normalize_visible_text;
use omgbase_format::{BlockKind, parse_markdown};
use omgbase_reconcile::{
    Config, CrossDocMatch, Detail, DetailValue, Disposition, DispositionKind, FlatSource, Inserted,
    MatchBlock, Minter, Options, PerDocUnmatched, PoolEntry, ReconcileResult, SequentialMinter,
    apply_cross_doc_matches, cross_doc_match, flatten, reconcile_document,
};
use serde_json::{Map as JsonMap, Value as Json, json};

const CASES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/reconcile/cases");
const PASSING_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/spec-passing.txt");
/// A wrong `CASES_DIR` must not pass by finding some other, smaller directory.
const MIN_CASE_FILES: usize = 3;
/// Cap on detail lines per report section.
const MAX_REPORT_LINES: usize = 400;
/// Numbers are IEEE doubles carried at full precision; compare within this (§8).
const EPS: f64 = 1e-9;
/// The runner's minted ids are `new_<n>`; a fixture id may not start this way.
const MINT_PREFIX: &str = "new";

/// §6 names a fixture `config` may carry.
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
/// spec/format §3 kinds a fixture block may carry (`frontmatter` is never reconciled).
const BLOCK_KINDS: [&str; 12] = [
    "heading",
    "paragraph",
    "list",
    "list_item",
    "task",
    "blockquote",
    "code_fence",
    "table",
    "table_row",
    "thematic_break",
    "html_block",
    "opaque",
];
const CASE_KEYS: [&str; 8] = [
    "name", "notes", "config", "old", "new", "pool", "docs", "expect",
];
const BLOCK_KEYS: [&str; 5] = ["id", "type", "raw", "anchors", "children"];
const POOL_KEYS: [&str; 4] = ["id", "type", "raw", "text"];
const RESULT_KEYS: [&str; 4] = ["assignment", "dispositions", "deleted", "consumed_pool"];
const DISPOSITION_KEYS: [&str; 5] = ["block", "confidence", "detail", "kind", "reason"];

const PASSING_HEADER: &str = "\
# Reconcile spec cases (spec/reconcile/cases) that the Rust port must pass, one
# `<file-stem>::<name>` id per line, sorted. Maintained by tests/spec.rs:
# a listed case failing fails the build; an unlisted case passing also fails
# the build (add it here). Regenerate from the currently passing set with
#
#     RECONCILE_SPEC_UPDATE=1 cargo test -p omgbase-reconcile --test spec
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

fn validate_blocks(at: &str, blocks: &Json, is_old: bool, problems: &mut Vec<String>) {
    let Some(blocks) = blocks.as_array() else {
        problems.push(format!("{at}: `blocks` must be an array"));
        return;
    };
    for (i, b) in blocks.iter().enumerate() {
        let here = format!("{at}[{i}]");
        let Some(obj) = b.as_object() else {
            problems.push(format!("{here}: block is not an object"));
            continue;
        };
        let unknown = unknown_keys(obj, &BLOCK_KEYS);
        if !unknown.is_empty() {
            problems.push(format!("{here}: unknown block keys {}", unknown.join(", ")));
        }
        match obj.get("type").and_then(Json::as_str) {
            Some(t) if BLOCK_KINDS.contains(&t) => {}
            other => problems.push(format!(
                "{here}: `type` must be a spec/format §3 kind (got {other:?})"
            )),
        }
        if !obj.get("raw").is_some_and(Json::is_string) {
            problems.push(format!("{here}: `raw` must be a string"));
        }
        if is_old
            && !obj
                .get("id")
                .and_then(Json::as_str)
                .is_some_and(|id| !id.is_empty())
        {
            problems.push(format!("{here}: old block needs a non-empty `id`"));
        }
        if !is_old && obj.contains_key("id") {
            problems.push(format!("{here}: new block must not carry an `id`"));
        }
        if let Some(anchors) = obj.get("anchors") {
            if !anchors
                .as_array()
                .is_some_and(|a| a.iter().all(Json::is_string))
            {
                problems.push(format!("{here}: `anchors` must be an array of strings"));
            }
        }
        match obj.get("children") {
            Some(children) if children.is_array() => {
                validate_blocks(&format!("{here}.children"), children, is_old, problems);
            }
            _ => problems.push(format!("{here}: `children` must be an array")),
        }
    }
}

fn validate_side(at: &str, side: Option<&Json>, is_old: bool, problems: &mut Vec<String>) {
    let Some(obj) = side.and_then(Json::as_object) else {
        problems.push(format!("{at}: must be an object with `source` or `blocks`"));
        return;
    };
    let keys: Vec<&String> = obj.keys().collect();
    if keys.len() != 1 || (keys[0] != "source" && keys[0] != "blocks") {
        problems.push(format!(
            "{at}: must have exactly one of `source` / `blocks` (got {})",
            keys.iter()
                .map(|k| k.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
        return;
    }
    if let Some(source) = obj.get("source") {
        if !source.is_string() {
            problems.push(format!("{at}: `source` must be a string"));
        }
    } else {
        validate_blocks(&format!("{at}.blocks"), &obj["blocks"], is_old, problems);
    }
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

fn validate_pool(at: &str, pool: &Json, problems: &mut Vec<String>) {
    let Some(pool) = pool.as_array() else {
        problems.push(format!("{at}: `pool` must be an array"));
        return;
    };
    for (i, p) in pool.iter().enumerate() {
        let here = format!("{at}[{i}]");
        let Some(obj) = p.as_object() else {
            problems.push(format!("{here}: pool entry is not an object"));
            continue;
        };
        let unknown = unknown_keys(obj, &POOL_KEYS);
        if !unknown.is_empty() {
            problems.push(format!("{here}: unknown pool keys {}", unknown.join(", ")));
        }
        if !obj
            .get("id")
            .and_then(Json::as_str)
            .is_some_and(|id| !id.is_empty())
        {
            problems.push(format!("{here}: pool entry needs an `id`"));
        }
        if !obj
            .get("type")
            .and_then(Json::as_str)
            .is_some_and(|t| BLOCK_KINDS.contains(&t))
        {
            problems.push(format!("{here}: `type` must be a spec/format §3 kind"));
        }
        if !obj.get("raw").is_some_and(Json::is_string) {
            problems.push(format!("{here}: `raw` must be a string"));
        }
        if obj.get("text").is_some_and(|t| !t.is_string()) {
            problems.push(format!("{here}: `text` must be a string"));
        }
    }
}

fn validate_canon_result(at: &str, e: &Json, problems: &mut Vec<String>) {
    let Some(obj) = e.as_object() else {
        problems.push(format!("{at}: must be an object"));
        return;
    };
    let extra = unknown_keys(obj, &RESULT_KEYS);
    if !extra.is_empty() {
        problems.push(format!("{at}: unknown keys {}", extra.join(", ")));
    }
    if !obj.get("assignment").is_some_and(Json::is_object) {
        problems.push(format!("{at}.assignment must be an object"));
    }
    match obj.get("dispositions").and_then(Json::as_array) {
        Some(dispositions) => {
            for (i, d) in dispositions.iter().enumerate() {
                let Some(d) = d.as_object() else {
                    problems.push(format!("{at}.dispositions[{i}]: not an object"));
                    continue;
                };
                let mut keys: Vec<&str> = d.keys().map(String::as_str).collect();
                keys.sort_unstable();
                if keys != DISPOSITION_KEYS {
                    problems.push(format!(
                        "{at}.dispositions[{i}]: must have exactly block, kind, confidence, reason, detail (got {})",
                        keys.join(", ")
                    ));
                }
            }
        }
        None => problems.push(format!("{at}.dispositions must be an array")),
    }
    if !obj.get("deleted").is_some_and(Json::is_array) {
        problems.push(format!("{at}.deleted must be an array"));
    }
    if !obj.get("consumed_pool").is_some_and(Json::is_array) {
        problems.push(format!("{at}.consumed_pool must be an array"));
    }
}

/// Validate one fixture file as the reference's `validateFixtureFile` does.
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
        let unknown = unknown_keys(cobj, &CASE_KEYS);
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

        let single = cobj.contains_key("old") || cobj.contains_key("new");
        let checkpoint = cobj.contains_key("docs");
        if single == checkpoint {
            problems.push(format!("{at}: a case has either `old` + `new` or `docs`"));
            continue;
        }
        if single {
            validate_side(&format!("{at}.old"), cobj.get("old"), true, &mut problems);
            validate_side(&format!("{at}.new"), cobj.get("new"), false, &mut problems);
            if let Some(pool) = cobj.get("pool") {
                validate_pool(&format!("{at}.pool"), pool, &mut problems);
            }
        } else {
            if cobj.contains_key("pool") {
                problems.push(format!("{at}: a checkpoint case takes no `pool`"));
            }
            match cobj.get("docs").and_then(Json::as_array) {
                Some(docs) if !docs.is_empty() => {
                    let mut ids = BTreeSet::new();
                    for (j, d) in docs.iter().enumerate() {
                        let here = format!("{at}.docs[{j}]");
                        let Some(dobj) = d.as_object() else {
                            problems.push(format!("{here}: not an object"));
                            continue;
                        };
                        let bad = unknown_keys(dobj, &["id", "old", "new"]);
                        if !bad.is_empty() {
                            problems.push(format!("{here}: unknown doc keys {}", bad.join(", ")));
                        }
                        match dobj.get("id").and_then(Json::as_str) {
                            Some(id) if !id.is_empty() => {
                                if !ids.insert(id.to_owned()) {
                                    problems.push(format!("{here}: duplicate doc id '{id}'"));
                                }
                            }
                            _ => problems.push(format!("{here}: doc needs an `id`")),
                        }
                        validate_side(&format!("{here}.old"), dobj.get("old"), true, &mut problems);
                        validate_side(
                            &format!("{here}.new"),
                            dobj.get("new"),
                            false,
                            &mut problems,
                        );
                    }
                }
                _ => problems.push(format!("{at}: `docs` must be a non-empty array")),
            }
        }

        let Some(expect) = cobj.get("expect") else {
            problems.push(format!(
                "{at}: missing `expect` (run RECONCILE_SPEC_UPDATE=1)"
            ));
            continue;
        };
        if single {
            validate_canon_result(&format!("{at}.expect"), expect, &mut problems);
        } else {
            match (expect.get("moves"), expect.get("docs")) {
                (Some(moves), Some(docs)) if moves.is_array() && docs.is_object() => {
                    for (id, r) in docs.as_object().expect("object") {
                        validate_canon_result(&format!("{at}.expect.docs.{id}"), r, &mut problems);
                    }
                }
                _ => problems.push(format!(
                    "{at}.expect: a checkpoint expect has `moves` and `docs`"
                )),
            }
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

// ---- inputs ------------------------------------------------------------------------

/// A case side to input blocks (§9): `source` is parsed per spec/format with
/// the `frontmatter` block dropped and, on the old side, ids `b_0`, `b_1`, …
/// in pre-order; `blocks` passes through, `id` required on old only.
fn side_to_sources(side: &Json, is_old: bool) -> Result<Vec<FlatSource>, String> {
    if let Some(source) = side.get("source").and_then(Json::as_str) {
        let tree = parse_markdown(source);
        let mut ids = SequentialMinter::new("b");
        let ids: Option<&mut dyn Minter> = if is_old { Some(&mut ids) } else { None };
        return Ok(FlatSource::from_tree(&tree, ids));
    }
    let blocks = side
        .get("blocks")
        .and_then(Json::as_array)
        .ok_or("side has neither `source` nor `blocks`")?;
    blocks_to_sources(blocks, is_old)
}

fn blocks_to_sources(blocks: &[Json], is_old: bool) -> Result<Vec<FlatSource>, String> {
    blocks
        .iter()
        .map(|b| {
            let kind: BlockKind = b["type"]
                .as_str()
                .ok_or("block `type` must be a string")?
                .parse()
                .map_err(|e| format!("{e}"))?;
            let raw = b["raw"].as_str().ok_or("block `raw` must be a string")?;
            let mut src = FlatSource::new(kind, raw);
            if is_old {
                src.id = Some(b["id"].as_str().ok_or("old block needs an id")?.to_owned());
            }
            if let Some(anchors) = b.get("anchors").and_then(Json::as_array) {
                src.anchors = anchors
                    .iter()
                    .filter_map(Json::as_str)
                    .map(str::to_owned)
                    .collect();
            }
            let children = b
                .get("children")
                .and_then(Json::as_array)
                .map_or(&[][..], Vec::as_slice);
            src.children = blocks_to_sources(children, is_old)?;
            Ok(src)
        })
        .collect()
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

/// `pool` entries: `raw_hash = sha256(raw)`, `norm_hash = sha256(text)` with
/// `text` defaulting to the spec/format §4.1 leaf rule over `raw` at depth 0.
fn pool_from(pool: Option<&Json>) -> Result<Vec<PoolEntry>, String> {
    let Some(entries) = pool.and_then(Json::as_array) else {
        return Ok(Vec::new());
    };
    entries
        .iter()
        .map(|p| {
            let id = p["id"].as_str().ok_or("pool entry needs an id")?;
            let type_name = p["type"].as_str().ok_or("pool `type` must be a string")?;
            let kind: BlockKind = type_name.parse().map_err(|e| format!("{e}"))?;
            let raw = p["raw"].as_str().ok_or("pool `raw` must be a string")?;
            let text = match p.get("text").and_then(Json::as_str) {
                Some(t) => t.to_owned(),
                None => normalize_visible_text(raw, kind, 0),
            };
            Ok(PoolEntry {
                id: id.to_owned(),
                kind: type_name.to_owned(),
                raw_hash: hex(&raw_hash(raw)),
                norm_hash: hex(&norm_hash(&text)),
            })
        })
        .collect()
}

// ---- evaluation ----------------------------------------------------------------------

struct EvaluatedDoc {
    doc_id: String,
    old: Vec<MatchBlock>,
    new: Vec<MatchBlock>,
    result: ReconcileResult,
}

struct Evaluation {
    config: Config,
    pool_ids: HashSet<String>,
    docs: Vec<EvaluatedDoc>,
    /// Checkpoint cases only.
    moves: Option<Vec<CrossDocMatch>>,
}

/// Every id the fixture supplies (old ids across the documents, pool ids):
/// what a result may name besides minted ids.
fn known_ids(ev: &Evaluation) -> HashSet<String> {
    let mut known = ev.pool_ids.clone();
    for d in &ev.docs {
        known.extend(d.old.iter().filter_map(|b| b.id.clone()));
    }
    known
}

fn build_doc(
    doc_id: &str,
    old: &Json,
    new: &Json,
) -> Result<(Vec<MatchBlock>, Vec<MatchBlock>), String> {
    let old = flatten(&side_to_sources(old, true).map_err(|e| format!("{doc_id}.old: {e}"))?);
    let new = flatten(&side_to_sources(new, false).map_err(|e| format!("{doc_id}.new: {e}"))?);
    Ok((old, new))
}

/// Run the implementation on a case's inputs: a single document, or every
/// document of a checkpoint followed by the §7 cross-document procedure.
fn evaluate(c: &SpecCase) -> Result<Evaluation, String> {
    let case = &c.case;
    let config = config_from(case.get("config"))?;
    let mut minter = SequentialMinter::new(MINT_PREFIX);

    let ev = if let Some(docs) = case.get("docs").and_then(Json::as_array) {
        let mut evaluated = Vec::with_capacity(docs.len());
        for d in docs {
            let doc_id = d["id"].as_str().ok_or("doc needs an id")?.to_owned();
            let (old, new) = build_doc(&doc_id, &d["old"], &d["new"])?;
            let result = reconcile_document(
                &old,
                &new,
                Options {
                    config: &config,
                    pool: &[],
                    minter: &mut minter,
                },
            );
            evaluated.push(EvaluatedDoc {
                doc_id,
                old,
                new,
                result,
            });
        }
        // §7: pool the leftovers — deleted blocks in `deleted` order, inserted
        // blocks in disposition order with their minted ids.
        let per_doc: Vec<PerDocUnmatched> = evaluated
            .iter()
            .map(|e| {
                let key_of_id: HashMap<&str, &str> = e
                    .result
                    .assignment
                    .iter()
                    .map(|(k, id)| (id.as_str(), k.as_str()))
                    .collect();
                PerDocUnmatched {
                    doc_id: e.doc_id.clone(),
                    deleted: e
                        .result
                        .deleted
                        .iter()
                        .filter_map(|id| e.old.iter().find(|b| b.id.as_deref() == Some(id)))
                        .cloned()
                        .collect(),
                    inserted: e
                        .result
                        .dispositions
                        .iter()
                        .filter(|d| d.kind == DispositionKind::Inserted)
                        .filter_map(|d| {
                            let key = key_of_id.get(d.block_id.as_str())?;
                            let block = e.new.iter().find(|b| &b.key == key)?;
                            Some(Inserted {
                                block: block.clone(),
                                minted_id: d.block_id.clone(),
                            })
                        })
                        .collect(),
                }
            })
            .collect();
        let moves = cross_doc_match(&per_doc, &config);
        let mut by_doc: BTreeMap<String, ReconcileResult> = evaluated
            .iter()
            .map(|e| (e.doc_id.clone(), e.result.clone()))
            .collect();
        apply_cross_doc_matches(&mut by_doc, &moves, &config.matcher_v);
        for e in &mut evaluated {
            e.result = by_doc.remove(&e.doc_id).expect("every doc is present");
        }
        Evaluation {
            config,
            pool_ids: HashSet::new(),
            docs: evaluated,
            moves: Some(moves),
        }
    } else {
        let pool = pool_from(case.get("pool"))?;
        let (old, new) = build_doc("doc", &case["old"], &case["new"])?;
        let result = reconcile_document(
            &old,
            &new,
            Options {
                config: &config,
                pool: &pool,
                minter: &mut minter,
            },
        );
        Evaluation {
            config,
            pool_ids: pool.iter().map(|p| p.id.clone()).collect(),
            docs: vec![EvaluatedDoc {
                doc_id: "doc".to_owned(),
                old,
                new,
                result,
            }],
            moves: None,
        }
    };

    // The runner's minted ids must be distinguishable from the fixture's.
    let known = known_ids(&ev);
    if let Some(id) = known
        .iter()
        .find(|id| id.starts_with(&format!("{MINT_PREFIX}_")))
    {
        return Err(format!(
            "fixture id {id} collides with the runner's minter prefix"
        ));
    }
    Ok(ev)
}

// ---- invariants (§2, §3, §9 "Runner checks") -----------------------------------------

/// Every new key assigned exactly once; carried ids unique (R1); carried
/// pairs same type (R2); every old id in exactly one disposition (across the
/// documents of a checkpoint); every minted id in exactly one; `matcher_v`
/// everywhere; `deleted` and `consumed_pool` name known ids.
fn check_invariants(ev: &Evaluation) -> Vec<String> {
    let mut problems = Vec::new();
    let mut old_by_id: HashMap<&str, &MatchBlock> = HashMap::new();
    for d in &ev.docs {
        for o in &d.old {
            let id = o.id.as_deref().unwrap_or_default();
            if old_by_id.insert(id, o).is_some() {
                problems.push(format!("{}: old id {id} is not unique", d.doc_id));
            }
        }
    }
    let known: HashSet<&str> = old_by_id
        .keys()
        .copied()
        .chain(ev.pool_ids.iter().map(String::as_str))
        .collect();
    let mut old_disposition_count: HashMap<&str, usize> =
        old_by_id.keys().map(|id| (*id, 0)).collect();

    for d in &ev.docs {
        let at = &d.doc_id;
        let result = &d.result;
        let new_keys: HashSet<&str> = d.new.iter().map(|n| n.key.as_str()).collect();
        for n in &d.new {
            if !result.assignment.contains_key(&n.key) {
                problems.push(format!("{at}: new key {} unassigned", n.key));
            }
        }
        for k in result.assignment.keys() {
            if !new_keys.contains(k.as_str()) {
                problems.push(format!("{at}: assignment names unknown key {k}"));
            }
        }

        let mut seen: HashMap<&str, &str> = HashMap::new();
        let mut minted: BTreeSet<&str> = BTreeSet::new();
        for n in &d.new {
            let Some(id) = result.assignment.get(&n.key) else {
                continue;
            };
            if let Some(prev) = seen.insert(id, &n.key) {
                problems.push(format!(
                    "{at}: id {id} assigned to {prev} and {} (R1)",
                    n.key
                ));
            }
            if let Some(o) = old_by_id.get(id.as_str()) {
                if o.kind != n.kind {
                    problems.push(format!(
                        "{at}: carry {id} → {} changes type {} → {} (R2)",
                        n.key, o.kind, n.kind
                    ));
                }
            } else if !ev.pool_ids.contains(id) {
                minted.insert(id);
            }
        }

        let mut minted_count: BTreeMap<&str, usize> = minted.iter().map(|id| (*id, 0)).collect();
        for disp in &result.dispositions {
            if disp.matcher_v != ev.config.matcher_v {
                problems.push(format!(
                    "{at}: disposition {} has matcher_v {}",
                    disp.block_id, disp.matcher_v
                ));
            }
            if let Some(n) = old_disposition_count.get_mut(disp.block_id.as_str()) {
                *n += 1;
            } else if let Some(n) = minted_count.get_mut(disp.block_id.as_str()) {
                *n += 1;
            } else if disp.block_id != "DOC" && !ev.pool_ids.contains(&disp.block_id) {
                problems.push(format!(
                    "{at}: disposition names unknown id {} ({})",
                    disp.block_id, disp.kind
                ));
            }
        }
        for (id, n) in minted_count {
            if n != 1 {
                problems.push(format!("{at}: minted id {id} has {n} dispositions"));
            }
        }
        for id in &result.deleted {
            if !known.contains(id.as_str()) {
                problems.push(format!("{at}: deleted names unknown id {id}"));
            }
        }
        for id in &result.consumed_pool {
            if !ev.pool_ids.contains(id) {
                problems.push(format!("{at}: consumed_pool names non-pool id {id}"));
            }
        }
    }
    let mut counts: Vec<(&str, usize)> = old_disposition_count.into_iter().collect();
    counts.sort_unstable();
    for (id, n) in counts {
        if n != 1 {
            problems.push(format!("old id {id} has {n} dispositions"));
        }
    }
    problems
}

// ---- result → expect -------------------------------------------------------------------

fn detail_value_json(v: &DetailValue) -> Json {
    match v {
        DetailValue::Str(s) => Json::String(s.clone()),
        DetailValue::Int(n) => Json::from(*n),
        DetailValue::Num(n) => Json::from(*n),
        DetailValue::List(items) => Json::Array(items.iter().map(detail_value_json).collect()),
        DetailValue::Map(m) => detail_json(m),
    }
}

fn detail_json(detail: &Detail) -> Json {
    Json::Object(
        detail
            .iter()
            .map(|(k, v)| (k.clone(), detail_value_json(v)))
            .collect(),
    )
}

/// The implementation's disposition as it stands (ids as assigned).
fn disposition_json(d: &Disposition) -> Json {
    json!({
        "block_id": d.block_id,
        "kind": d.kind.as_str(),
        "confidence": d.confidence,
        "reason": d.reason.map(|r| r.as_str()),
        "matcher_v": d.matcher_v,
        "detail": detail_json(&d.detail),
    })
}

fn result_json(r: &ReconcileResult) -> Json {
    json!({
        "assignment": r.assignment,
        "dispositions": r.dispositions.iter().map(disposition_json).collect::<Vec<_>>(),
        "deleted": r.deleted,
        "consumed_pool": r.consumed_pool,
    })
}

/// §9 "Expect": assignment with minted ids as `null`, dispositions with
/// minted ids as `new:<key>`, sorted by block then kind (bytewise),
/// `matcher_v` dropped after being checked against the config.
fn canonicalize(
    doc: &EvaluatedDoc,
    known: &HashSet<String>,
    config: &Config,
) -> Result<Json, String> {
    let result = &doc.result;
    let mut assignment = JsonMap::new();
    let mut minted_to_key: HashMap<&str, &str> = HashMap::new();
    for n in &doc.new {
        let id = result
            .assignment
            .get(&n.key)
            .ok_or_else(|| format!("new key {} has no assignment", n.key))?;
        if known.contains(id) {
            assignment.insert(n.key.clone(), Json::String(id.clone()));
        } else {
            assignment.insert(n.key.clone(), Json::Null);
            if let Some(prev) = minted_to_key.insert(id, &n.key) {
                return Err(format!(
                    "minted id {id} assigned to both {prev} and {}",
                    n.key
                ));
            }
        }
    }
    let mut dispositions: Vec<(String, &str, Json)> = Vec::with_capacity(result.dispositions.len());
    for d in &result.dispositions {
        if d.matcher_v != config.matcher_v {
            return Err(format!(
                "disposition {} has matcher_v {}, expected {}",
                d.block_id, d.matcher_v, config.matcher_v
            ));
        }
        let block = if d.block_id == "DOC" || known.contains(&d.block_id) {
            d.block_id.clone()
        } else {
            let key = minted_to_key.get(d.block_id.as_str()).ok_or_else(|| {
                format!(
                    "disposition {} ({}) names an id that is neither known nor assigned to a new key",
                    d.block_id, d.kind
                )
            })?;
            format!("new:{key}")
        };
        let kind = d.kind.as_str();
        let value = json!({
            "block": block,
            "kind": kind,
            "confidence": d.confidence,
            "reason": d.reason.map(|r| r.as_str()),
            "detail": detail_json(&d.detail),
        });
        dispositions.push((block, kind, value));
    }
    dispositions.sort_by(|a, b| {
        a.0.as_bytes()
            .cmp(b.0.as_bytes())
            .then_with(|| a.1.as_bytes().cmp(b.1.as_bytes()))
    });
    Ok(json!({
        "assignment": assignment,
        "dispositions": dispositions.into_iter().map(|(_, _, v)| v).collect::<Vec<_>>(),
        "deleted": result.deleted,
        "consumed_pool": result.consumed_pool,
    }))
}

fn moves_json(moves: &[CrossDocMatch]) -> Json {
    Json::Array(
        moves
            .iter()
            .map(|m| {
                json!({
                    "from_doc": m.from_doc,
                    "to_doc": m.to_doc,
                    "carried_id": m.carried_id,
                    "new_key": m.new_key,
                    "kind": m.kind.as_str(),
                    "confidence": m.confidence,
                })
            })
            .collect(),
    )
}

/// The case's `expect` as this implementation computes it.
fn expected_json(ev: &Evaluation) -> Result<Json, String> {
    let known = known_ids(ev);
    match &ev.moves {
        None => canonicalize(&ev.docs[0], &known, &ev.config),
        Some(moves) => {
            let mut docs = JsonMap::new();
            for d in &ev.docs {
                docs.insert(d.doc_id.clone(), canonicalize(d, &known, &ev.config)?);
            }
            Ok(json!({ "moves": moves_json(moves), "docs": docs }))
        }
    }
}

// ---- comparison ----------------------------------------------------------------------

/// Deep-compare two JSON values, object key order ignored, numbers within
/// `EPS`. `None` when equal, else the path and values of the first difference.
fn deep_eq_tol(a: &Json, b: &Json, path: &str) -> Option<String> {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => {
            let (x, y) = (
                x.as_f64().unwrap_or(f64::NAN),
                y.as_f64().unwrap_or(f64::NAN),
            );
            if (x - y).abs() <= EPS || (x.is_nan() && y.is_nan()) {
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
                .find_map(|(i, (p, q))| deep_eq_tol(p, q, &format!("{path}[{i}]")))
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
                .find_map(|k| deep_eq_tol(&x[k], &y[k], &format!("{path}.{k}")))
        }
        (Json::Array(_), _) | (_, Json::Array(_)) => Some(format!("{path}: array vs non-array")),
        (Json::Object(_), _) | (_, Json::Object(_)) => {
            Some(format!("{path}: object vs non-object"))
        }
        _ => (a != b).then(|| format!("{path}: {a} vs {b}")),
    }
}

/// Clip a one-line diagnostic so a big result cannot flood the report.
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

fn check(c: &SpecCase) -> Result<(), String> {
    let ev = evaluate(c)?;
    let problems = check_invariants(&ev);
    if !problems.is_empty() {
        return Err(clip(format!("invariants: {}", problems.join("; "))));
    }
    let actual = expected_json(&ev)?;
    let want = &c.case["expect"];
    match deep_eq_tol(&actual, want, "expect") {
        None => Ok(()),
        Some(diff) => Err(clip(diff)),
    }
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
    std::env::var("RECONCILE_SPEC_UPDATE").is_ok_and(|v| !v.is_empty() && v != "0")
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
        "cases that pass but are not listed in spec-passing.txt — add them (or run RECONCILE_SPEC_UPDATE=1 cargo test -p omgbase-reconcile --test spec)",
        &unlisted_passing,
    );
    report("stale allowlist entries", &stale);
    if passing == all_ids {
        eprintln!(
            "spec: every case passes — delete tests/spec-passing.txt (or run with RECONCILE_SPEC_UPDATE=1)"
        );
    }
    assert!(
        regressions.is_empty() && unlisted_passing.is_empty() && stale.is_empty(),
        "spec allowlist out of date: {} regression(s), {} unlisted passing, {} stale — see the report above (stderr); \
         promote with `RECONCILE_SPEC_UPDATE=1 cargo test -p omgbase-reconcile --test spec`",
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
    assert!(
        !loaded.problems.iter().any(|p| p.contains("duplicate name")),
        "{:?}",
        loaded.problems
    );
}

/// The invariants hold for every case's raw result, whatever the fixture
/// expects — a failing comparison must never hide a broken result.
#[test]
fn every_result_satisfies_the_invariants() {
    if !spec_available() {
        return;
    }

    let loaded = load();
    let mut problems = Vec::new();
    let mut checked = 0usize;
    for f in &loaded.files {
        for c in &f.cases {
            match evaluate(c) {
                Ok(ev) => {
                    for p in check_invariants(&ev) {
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

/// The runner's private JSON shape must agree with the crate's `json`
/// feature on every case's raw result, so the two cannot drift.
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
            let Ok(ev) = evaluate(c) else {
                continue;
            };
            for d in &ev.docs {
                for disp in &d.result.dispositions {
                    assert_eq!(disposition_json(disp), disp.to_json(), "{}", c.id);
                    checked += 1;
                }
                assert_eq!(result_json(&d.result), d.result.to_json(), "{}", c.id);
            }
        }
    }
    assert!(checked > 0, "checked no dispositions");
}
