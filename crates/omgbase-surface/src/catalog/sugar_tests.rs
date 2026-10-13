//! ADR-021, the retirement release (`spec/surface` 4.0): every sugar tool is
//! `apply { effects }` — the shared builders' effects planned and committed
//! in one transaction — and answers with the Receipt. These tests pin the
//! **4.0 equivalence**: for the twelve block/link tools, every scenario runs
//! the same call twice — through the pre-4.0 footprint oracle ([`call_legacy`],
//! the tool's kernel ops under the library `apply`, which is still the
//! fixture contract of `spec/mutate` §4) on one surface and through the
//! effect-driven handler on another, both over the alchemy corpus under the
//! sequential minter and one clock — and requires the store projection
//! identical (`commits` minus `ops`, `docs`, live `blocks`, `revisions`,
//! `block_changes`, `dispositions`, the pool, the pending rows, the files),
//! the Receipt's `revisions` equal to the kernel result's, the plan preview's
//! `results` (realized through `new_ids`) equal to the kernel's, errors equal
//! (code, message, `data`), and the next `b`/`d` minted identical. The four
//! document operations run against the store's own (the same builders): the
//! pinned relabels — `docs_set_meta`'s `edited / api`, `docs_create`'s
//! `inserted / api` — are asserted on the rows. Previews (the CLI's
//! `--dry-run`, `spec/cli` §3.6) are the Plan: nothing written, no id burned,
//! the commit that follows taking exactly the plan's ids. Every retired name
//! (`ops`, `dry_run`, `attrs`) is an argument error naming its replacement.

use std::fs;
use std::path::{Path, PathBuf};

use omgbase_format::BlockKind;
use omgbase_format::hash::hex;
use omgbase_reconcile::Config;
use omgbase_store::mutate_kernel::{At, Op, Parent, To};
use omgbase_store::{
    ApplyOrigin, ApplyRequest, ApplyResult, BatchItem, DocStore, Expect, MemDocStore,
    SequentialMinter, Store,
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use super::{
    Surface, SurfaceError, WriteTarget, arg_bool, arg_expect, arg_parent_expect, arg_str,
    arg_string, arg_strings, block_missing, tool_spec,
};
use crate::arguments::{arguments_hint, validate_arguments};
use crate::paths::reference_path;
use crate::read;

const CORPUS_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/core/corpus/oqx/fixtures/alchemy"
);
const CORPUS_TS: &str = "2026-09-27T00:00:00.000Z";
const CLOCK: &str = "2026-09-27T01:00:00.000Z";

const NOTES: &str = "lab/2026-01-notes.md";
const SALT: &str = "substances/salt.md";

fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, String)>) {
    for entry in fs::read_dir(dir).expect("readable corpus dir") {
        let path = entry.expect("entry").path();
        if path.is_dir() {
            walk(&path, base, out);
        } else if path.extension().is_some_and(|e| e == "md") {
            let rel = path
                .strip_prefix(base)
                .expect("under base")
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push((rel, fs::read_to_string(&path).expect("readable")));
        }
    }
}

fn corpus() -> Option<Vec<(String, String)>> {
    let dir = PathBuf::from(CORPUS_DIR);
    if !dir.is_dir() {
        eprintln!("sugar_tests: corpus not present at {CORPUS_DIR}; skipping");
        return None;
    }
    let mut files = Vec::new();
    walk(&dir, &dir, &mut files);
    files.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    Some(files)
}

/// A surface over a fresh store holding the corpus (sequential minter), an
/// in-memory doc store seeded with the same files, a fixed clock.
fn surface(files: &[(String, String)]) -> Surface {
    let mut store =
        Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).expect("store");
    let repo = store.create_repo("alchemy").expect("repo");
    let items: Vec<BatchItem> = files
        .iter()
        .map(|(p, s)| BatchItem::observed(p, s))
        .collect();
    store
        .observe_batch(&repo, &items, CORPUS_TS, &Config::default())
        .expect("corpus observed");
    let mut ds = MemDocStore::new();
    for (p, s) in files {
        ds.write(p, s).expect("seeded");
    }
    Surface::new(store, &repo, None)
        .with_doc_store(Box::new(ds))
        .with_clock(|| CLOCK.to_owned())
}

/// Everything a request leaves behind, minus `commits.ops` (the intent
/// record the effect path writes and the kernel path leaves NULL).
fn footprint(s: &Surface) -> Json {
    let conn = s.store.conn();
    let rows = |sql: &str| -> Vec<Vec<Json>> {
        let mut stmt = conn.prepare(sql).unwrap();
        let n = stmt.column_count();
        stmt.query_map([], |r| {
            (0..n)
                .map(|i| {
                    Ok(match r.get_ref(i)? {
                        rusqlite::types::ValueRef::Null => Json::Null,
                        rusqlite::types::ValueRef::Integer(i) => json!(i),
                        rusqlite::types::ValueRef::Real(f) => json!(f),
                        rusqlite::types::ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                        rusqlite::types::ValueRef::Blob(b) => json!(hex(b)),
                    })
                })
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
    };
    let docs =
        rows("SELECT doc_id, path, current_rev, file_hash, deleted_commit FROM docs ORDER BY path");
    let WriteTarget::Fixed(ds) = &s.writes else {
        panic!("the test surfaces write through a fixed doc store")
    };
    let mut files = Map::new();
    for row in &docs {
        let path = row[1].as_str().expect("path");
        files.insert(path.to_owned(), json!(ds.read(path).expect("readable")));
    }
    json!({
        "commits": rows("SELECT commit_id, seq, origin, actor, reason FROM commits ORDER BY seq"),
        "docs": docs,
        "blocks": rows("SELECT block_id, doc_id, parent_block, ordinal, depth, type, raw_hash, trivia_hash, attrs, created_commit FROM blocks WHERE deleted_commit IS NULL ORDER BY doc_id, parent_block, ordinal"),
        "revisions": rows("SELECT rev_id, doc_id, seq, rendered_hash, path, commit_id FROM revisions ORDER BY rev_id"),
        "block_changes": rows("SELECT block_id, commit_id, kind FROM block_changes ORDER BY commit_id, block_id"),
        "dispositions": rows("SELECT commit_id, block_id, kind, reason, matcher_v FROM dispositions ORDER BY commit_id, block_id, kind"),
        "pool": rows("SELECT block_id, doc_id FROM resurrection_pool ORDER BY block_id"),
        "pending": rows("SELECT path FROM pending_materializations ORDER BY path"),
        "files": files,
    })
}

/// Where two footprints differ, table by table: the rows only one side has
/// (a readable failure instead of two multi-kilobyte dumps).
fn footprint_diff(old: &Json, new: &Json) -> String {
    let mut out = String::new();
    for (table, o) in old.as_object().unwrap() {
        let n = &new[table];
        if o == n {
            continue;
        }
        out.push_str(&format!("  {table}:\n"));
        match (o.as_array(), n.as_array()) {
            (Some(o), Some(n)) => {
                for row in o.iter().filter(|r| !n.contains(r)) {
                    out.push_str(&format!("    legacy only: {row}\n"));
                }
                for row in n.iter().filter(|r| !o.contains(r)) {
                    out.push_str(&format!("    effects only: {row}\n"));
                }
            }
            _ => {
                for (k, ov) in o.as_object().unwrap() {
                    if n.get(k) != Some(ov) {
                        out.push_str(&format!(
                            "    {k}: legacy {ov}\n    {k}: effects {}\n",
                            n.get(k).unwrap_or(&Json::Null)
                        ));
                    }
                }
            }
        }
    }
    out
}

fn outcome(r: Result<Json, SurfaceError>) -> Json {
    match r {
        Ok(v) => v,
        Err(e) => e.to_json(),
    }
}

// ---- the pre-4.0 oracle ----------------------------------------------------------------

/// The kernel ops' result on the wire as the sugar tools answered through
/// 3.x: `{ results: [{ ids, removed?, mergedInto? }], revisions, committed }`.
fn apply_json(res: &ApplyResult) -> Json {
    let mut m = Map::new();
    m.insert(
        "results".to_owned(),
        Json::Array(
            res.results
                .iter()
                .map(|r| {
                    let mut o = Map::new();
                    o.insert("ids".to_owned(), json!(r.ids));
                    if let Some(rm) = &r.removed {
                        o.insert("removed".to_owned(), json!(rm));
                    }
                    if let Some(mi) = &r.merged_into {
                        o.insert("mergedInto".to_owned(), json!(mi));
                    }
                    Json::Object(o)
                })
                .collect(),
        ),
    );
    m.insert(
        "revisions".to_owned(),
        Json::Array(
            res.revisions
                .iter()
                .map(|r| json!({ "id": r.doc, "path": reference_path(&r.path), "hash": r.hash }))
                .collect(),
        ),
    );
    m.insert("committed".to_owned(), json!(res.committed));
    Json::Object(m)
}

/// The kernel changeset of a pre-4.0 sugar tool, committed through the
/// library `apply` (the fixture contract) under the tool's name.
fn apply_ops(
    s: &mut Surface,
    repo_id: &str,
    root: Option<&str>,
    ops: Vec<Op>,
    reason: &str,
) -> Result<ApplyResult, SurfaceError> {
    let ts = s.now();
    let req = ApplyRequest {
        repo_id: repo_id.to_owned(),
        ops,
        origin: ApplyOrigin::new(&s.actor, Some(reason)),
        dry_run: false,
    };
    s.with_writes(root, |store, ds| Ok(store.apply(&req, ds, &ts)?))
}

/// The live block's raw hash (hex) for CAS pinning; `None` when unknown.
fn pin_hash(s: &Surface, block_id: &str) -> Option<String> {
    let h: Option<Vec<u8>> = s
        .store
        .conn()
        .query_row(
            "SELECT raw_hash FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
            params![block_id],
            |r| r.get(0),
        )
        .optional()
        .unwrap();
    h.map(|h| hex(&h))
}

/// The twelve block/link tools as they ran before ADR-021's migration phase
/// — their kernel ops under the library `apply` — kept verbatim as the
/// footprint oracle the effect-driven handlers are compared against. The
/// tools' own ref resolution and pre-checks are the surface's (private to the
/// catalog, reachable from this child module).
#[allow(clippy::too_many_lines)]
fn call_legacy(s: &mut Surface, name: &str, args: &Json) -> Result<Json, SurfaceError> {
    let spec = tool_spec(name).expect("a catalog tool");
    validate_arguments(name, &spec.input_schema, args)?;
    let (repo, root) = s.scope(args)?;
    s.require_root(root.as_deref())?;
    let res = match name {
        "blocks_insert" => {
            let (parent, doc_id) = s.resolve_parent_ref(&repo, &arg_string(args, "to")?)?;
            let at = s.resolve_at(&repo, args.get("at"))?;
            let doc = (parent == Parent::Doc).then_some(doc_id);
            let ops = vec![Op::Insert {
                doc,
                to: To { parent, at },
                markdown: arg_string(args, "markdown")?,
                expect: arg_parent_expect(args)?,
            }];
            apply_ops(s, &repo, root.as_deref(), ops, "blocks_insert")?
        }
        "blocks_update" => {
            let block = s.resolve_block_ref(&repo, &arg_string(args, "id")?)?;
            let expect = match arg_expect(args)? {
                Some(e) => Some(e),
                None => pin_hash(s, &block).map(Expect::content),
            };
            let attrs = arg_bool(args, "checked")?.map(|c| {
                let mut a = Map::new();
                a.insert("checked".to_owned(), json!(c));
                a
            });
            let ops = vec![Op::Update {
                block,
                markdown: arg_str(args, "markdown").map(str::to_owned),
                attrs,
                expect,
                trivia: None,
                child_ids: None,
            }];
            apply_ops(s, &repo, root.as_deref(), ops, "blocks_update")?
        }
        "blocks_move" => {
            let blocks: Vec<String> = arg_strings(args, "blocks")?
                .iter()
                .map(|b| s.resolve_block_ref(&repo, b))
                .collect::<Result<_, _>>()?;
            let to_ref = arg_string(args, "to")?;
            let (parent, doc_id) = s.resolve_parent_ref(&repo, &to_ref)?;
            if parent == Parent::Doc {
                if let Some(first) = blocks.first() {
                    if s.doc_id_of_block(first)? != Some(doc_id) {
                        return Err(SurfaceError::with_data(
                            "target_missing",
                            format!(
                                "blocks_move cannot target another document's root ({to_ref}); anchor on a block in that document with at.before/at.after"
                            ),
                            json!({ "to": to_ref }),
                        ));
                    }
                }
            }
            let at = s.resolve_at(&repo, args.get("at"))?;
            let ops = vec![Op::Move {
                blocks,
                to: To { parent, at },
                doc: None,
                expect: arg_parent_expect(args)?,
            }];
            apply_ops(s, &repo, root.as_deref(), ops, "blocks_move")?
        }
        "blocks_remove" => {
            let blocks: Vec<String> = arg_strings(args, "blocks")?
                .iter()
                .map(|b| s.resolve_block_ref(&repo, b))
                .collect::<Result<_, _>>()?;
            let ops = vec![Op::Remove {
                blocks,
                expect: None,
            }];
            apply_ops(s, &repo, root.as_deref(), ops, "blocks_remove")?
        }
        "blocks_split" => {
            let block = s.resolve_block_ref(&repo, &arg_string(args, "id")?)?;
            let at: Vec<usize> = args["at"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| usize::try_from(v.as_u64().unwrap()).unwrap())
                .collect();
            let expect = Some(Expect::content(pin_hash(s, &block).unwrap_or_default()));
            let ops = vec![Op::Split { block, at, expect }];
            apply_ops(s, &repo, root.as_deref(), ops, "blocks_split")?
        }
        "blocks_merge" => {
            let blocks: Vec<String> = arg_strings(args, "blocks")?
                .iter()
                .map(|b| s.resolve_block_ref(&repo, b))
                .collect::<Result<_, _>>()?;
            let ops = vec![Op::Merge {
                blocks,
                separator: arg_str(args, "separator").map(str::to_owned),
                expect: None,
            }];
            apply_ops(s, &repo, root.as_deref(), ops, "blocks_merge")?
        }
        "blocks_check" => {
            let blocks: Vec<String> = arg_strings(args, "ids")?
                .iter()
                .map(|b| s.resolve_block_ref(&repo, b))
                .collect::<Result<_, _>>()?;
            let ops = if arg_bool(args, "checked")?.unwrap_or(true) {
                s.store.tasks_complete(&blocks)?
            } else {
                blocks
                    .iter()
                    .map(|b| {
                        let mut a = Map::new();
                        a.insert("checked".to_owned(), json!(false));
                        Op::Update {
                            block: b.clone(),
                            markdown: None,
                            attrs: Some(a),
                            expect: pin_hash(s, b).map(Expect::content),
                            trivia: None,
                            child_ids: None,
                        }
                    })
                    .collect()
            };
            apply_ops(s, &repo, root.as_deref(), ops, "blocks_check")?
        }
        "nodes_set" => {
            let node_id = arg_string(args, "id")?;
            let known: Option<i64> = s
                .store
                .conn()
                .query_row(
                    "SELECT 1 FROM nodes WHERE node_id = ?1 AND repo_id = ?2",
                    params![node_id, repo],
                    |r| r.get(0),
                )
                .optional()?;
            if known.is_none() {
                return Err(SurfaceError::with_data(
                    "block_missing",
                    format!("no node with id {}", Json::String(node_id.clone())),
                    json!({ "id": node_id }),
                ));
            }
            let ops = s.store.node_set(
                &node_id,
                &arg_string(args, "prop")?,
                &arg_string(args, "value")?,
            )?;
            apply_ops(s, &repo, root.as_deref(), ops, "nodes_set")?
        }
        "blocks_append" => {
            let given = arg_string(args, "id")?;
            let block = s.resolve_block_ref(&repo, &given)?;
            let text = arg_string(args, "text")?;
            let row: Option<(String, Option<String>, i64)> = s
                .store
                .conn()
                .query_row(
                    "SELECT b.type, d.format, (SELECT count(*) FROM blocks c WHERE c.parent_block = b.block_id AND c.deleted_commit IS NULL) FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ?1 AND b.deleted_commit IS NULL",
                    params![block],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let Some((kind, format, children)) = row else {
                return Err(block_missing(&given));
            };
            let container = if format.as_deref().unwrap_or("markdown") == "markdown" {
                kind.parse::<BlockKind>().is_ok_and(|k| k.is_container())
            } else {
                children > 0
            };
            let ops = if kind == "heading" {
                Store::sections_append(&block, &text)
            } else if container {
                vec![Op::Insert {
                    doc: None,
                    to: To {
                        parent: Parent::Block(block.clone()),
                        at: At::End,
                    },
                    markdown: text,
                    expect: None,
                }]
            } else {
                return Err(SurfaceError::with_data(
                    "block_not_container",
                    format!(
                        "block {block} is a {kind}, not a heading or a container; append means into — insert after it with blocks_insert {{ to: <its parent>, at: {{ after: {} }} }}",
                        Json::String(block.clone())
                    ),
                    json!({ "id": block, "type": kind }),
                ));
            };
            apply_ops(s, &repo, root.as_deref(), ops, "blocks_append")?
        }
        "docs_append" => {
            let doc_id = s.locate_doc(&repo, name, args)?;
            let text = arg_string(args, "text")?;
            let ops = match arg_str(args, "section") {
                Some(section) => {
                    let info = read::find_doc_by_id(s.store.conn(), &doc_id)?
                        .ok_or_else(|| block_missing(&doc_id))?;
                    let heading = s.resolve_section_heading(
                        &doc_id,
                        &info.path,
                        section,
                        (arg_str(args, "id"), arg_str(args, "path"), &text),
                    )?;
                    Store::sections_append(&heading, &text)
                }
                None => Store::docs_append(&doc_id, &text),
            };
            apply_ops(s, &repo, root.as_deref(), ops, "docs_append")?
        }
        "links_retarget" | "links_repair" => {
            let repairs: Vec<omgbase_store::LinkRepair> = if name == "links_retarget" {
                vec![omgbase_store::LinkRepair {
                    from: arg_string(args, "from_target")?,
                    to: arg_string(args, "to_target")?,
                }]
            } else if let Some(list) = args.get("repairs").and_then(Json::as_array) {
                list.iter()
                    .map(|r| {
                        Ok(omgbase_store::LinkRepair {
                            from: arg_string(r, "from")?,
                            to: arg_string(r, "to")?,
                        })
                    })
                    .collect::<Result<_, SurfaceError>>()?
            } else {
                vec![omgbase_store::LinkRepair {
                    from: arg_string(args, "from_target")?,
                    to: arg_string(args, "to_target")?,
                }]
            };
            let plan = s.store.links_repair(
                &repo,
                &repairs,
                arg_str(args, "path_glob").filter(|g| !g.is_empty()),
            )?;
            let res = apply_ops(s, &repo, root.as_deref(), plan.ops.clone(), name)?;
            let mut m = Map::new();
            m.insert(
                "hits".to_owned(),
                Json::Array(plan.hits.iter().map(|h| json!({ "id": h.block, "path": reference_path(&h.path), "oldRaw": h.old_raw, "newRaw": h.new_raw })).collect()),
            );
            m.insert(
                "pairs".to_owned(),
                Json::Array(
                    plan.pairs
                        .iter()
                        .map(|p| json!({ "from": p.from, "to": p.to, "hits": p.hits }))
                        .collect(),
                ),
            );
            return Ok(super::merge(m, apply_json(&res)));
        }
        other => panic!("no oracle for {other}"),
    };
    Ok(apply_json(&res))
}

// ---- the lockstep pair -------------------------------------------------------------------

/// The kernel-oracle surface and the effect-driven one, advanced in lockstep.
struct Pair {
    legacy: Surface,
    sugar: Surface,
}

/// The sugar path's answer with the plan it committed, viewed as the kernel
/// result: `results` the preview's with every `$new.n` realized through the
/// receipt's `new_ids` (a `blocks_update` with `markdown` + `checked` is two
/// effects where the kernel ran one op — the first result is the op's),
/// `revisions` the receipt's, `committed` true — plus the tool's extras
/// (`hits`, `pairs`) as they came.
fn as_kernel_view(tool: &str, result: &Json, plan: Option<&Json>) -> Json {
    if result.get("error").is_some() {
        // The corrected example (`data.fix`, 4.4) is the effect path's
        // teaching; the kernel oracle never had one.
        return strip_fix(result.clone());
    }
    let new_ids = result["new_ids"].as_object().cloned().unwrap_or_default();
    let realize = |id: &Json| -> Json {
        id.as_str()
            .and_then(|s| new_ids.get(s))
            .cloned()
            .unwrap_or_else(|| id.clone())
    };
    let mut results: Vec<Json> = plan
        .and_then(|p| p["preview"]["results"].as_array())
        .map(|rs| {
            rs.iter()
                .map(|r| {
                    let mut o = Map::new();
                    for key in ["ids", "removed", "mergedInto"] {
                        if let Some(list) = r.get(key).and_then(Json::as_array) {
                            o.insert(
                                key.to_owned(),
                                Json::Array(list.iter().map(realize).collect()),
                            );
                        }
                    }
                    Json::Object(o)
                })
                .collect()
        })
        .unwrap_or_default();
    if tool == "blocks_update" {
        results.truncate(1);
    }
    let mut m = Map::new();
    for key in ["hits", "pairs"] {
        if let Some(v) = result.get(key) {
            m.insert(key.to_owned(), v.clone());
        }
    }
    m.insert("results".to_owned(), Json::Array(results));
    m.insert("revisions".to_owned(), result["revisions"].clone());
    m.insert("committed".to_owned(), result["committed"].clone());
    Json::Object(m)
}

/// An error without its `data.fix` (4.4), for the oracle comparison.
fn strip_fix(mut v: Json) -> Json {
    if let Some(d) = v.get_mut("data").and_then(Json::as_object_mut) {
        d.remove("fix");
    }
    v
}

impl Pair {
    fn new() -> Option<Self> {
        let files = corpus()?;
        Some(Self {
            legacy: surface(&files),
            sugar: surface(&files),
        })
    }

    /// Run one call both ways; every observable must agree. Returns the
    /// sugar path's result (the Receipt, or the error).
    fn check(&mut self, label: &str, tool: &str, args: Json) -> Json {
        // The legacy path shares the heading resolution, so its miss carries
        // the 4.4 `fix` too; the oracle compares everything but that.
        let old = strip_fix(outcome(call_legacy(&mut self.legacy, tool, &args)));
        let (new, plan) = match self.sugar.call_result_with_plan(tool, &args) {
            Ok((r, p)) => (r, p),
            Err(e) => (e.to_json(), None),
        };
        assert_eq!(
            as_kernel_view(tool, &new, plan.as_ref()),
            old,
            "[{label}] {tool} {args}: the effect-driven result differs from the kernel result"
        );
        if new.get("error").is_none() {
            assert_eq!(new["committed"], json!(true), "[{label}] {new}");
            assert_eq!(
                new["plan_id"].as_str().map(str::len),
                Some(64),
                "[{label}] {new}"
            );
            assert!(
                new.get("results").is_none() && new.get("diffs").is_none(),
                "[{label}] {new}"
            );
        }
        let fp_old = footprint(&self.legacy);
        let fp_new = footprint(&self.sugar);
        assert!(
            fp_new == fp_old,
            "[{label}] {tool} {args}: the store projections differ:\n{}",
            footprint_diff(&fp_old, &fp_new)
        );
        for prefix in ["b", "d"] {
            let next_old = self.legacy.store_mut().mint(prefix).unwrap();
            let next_new = self.sugar.store_mut().mint(prefix).unwrap();
            assert_eq!(
                next_new, next_old,
                "[{label}] {tool} {args}: the minted `{prefix}` sequence diverged"
            );
        }
        new
    }

    fn ok(&mut self, label: &str, tool: &str, args: Json) -> Json {
        let out = self.check(label, tool, args);
        assert!(
            out.get("error").is_none(),
            "[{label}] {tool} expected success, got {out}"
        );
        out
    }

    fn err(&mut self, label: &str, tool: &str, args: Json, code: &str) -> Json {
        let out = self.check(label, tool, args);
        assert_eq!(
            out["error"], code,
            "[{label}] {tool} expected {code}: {out}"
        );
        out
    }
}

// ---- corpus addressing ----------------------------------------------------------------

fn doc_id(s: &Surface, path: &str) -> String {
    s.store
        .conn()
        .query_row(
            "SELECT doc_id FROM docs WHERE path = ?1 AND deleted_commit IS NULL",
            [path],
            |r| r.get(0),
        )
        .expect("a corpus document")
}

/// Live top-level blocks of `kind` in a document, in order.
fn top_blocks(s: &Surface, path: &str, kind: &str) -> Vec<String> {
    let doc = doc_id(s, path);
    let mut stmt = s
        .store
        .conn()
        .prepare(
            "SELECT block_id FROM blocks WHERE doc_id = ?1 AND parent_block IS NULL AND type = ?2 AND deleted_commit IS NULL ORDER BY ordinal",
        )
        .unwrap();
    stmt.query_map([doc.as_str(), kind], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

/// Live children of a block, in order.
fn children(s: &Surface, parent: &str) -> Vec<String> {
    let mut stmt = s
        .store
        .conn()
        .prepare(
            "SELECT block_id FROM blocks WHERE parent_block = ?1 AND deleted_commit IS NULL ORDER BY ordinal",
        )
        .unwrap();
    stmt.query_map([parent], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

fn raw(s: &Surface, block: &str) -> String {
    s.store
        .conn()
        .query_row(
            "SELECT b.bytes FROM blocks bl JOIN blobs b ON b.hash = bl.raw_hash WHERE bl.block_id = ?1 AND bl.deleted_commit IS NULL",
            [block],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .expect("a live block")
}

/// The first `md:link` node of a document.
fn link_node(s: &Surface, path: &str) -> String {
    let doc = doc_id(s, path);
    s.store
        .conn()
        .query_row(
            "SELECT node_id FROM nodes WHERE doc_id = ?1 AND kind = 'md:link' AND block_id IS NOT NULL ORDER BY node_id LIMIT 1",
            [doc.as_str()],
            |r| r.get(0),
        )
        .expect("a link node")
}

/// `(kind, reason, matcher_v)` of every disposition row of a commit.
fn dispositions_of(s: &Surface, commit: &str) -> Vec<(String, String, Option<String>)> {
    let mut stmt = s
        .store
        .conn()
        .prepare("SELECT kind, reason, matcher_v FROM dispositions WHERE commit_id = ?1 ORDER BY block_id")
        .unwrap();
    stmt.query_map([commit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

// ---- the equivalence sweep ------------------------------------------------------------

/// One scenario sequence over both surfaces: committed runs of every
/// block/link tool, their kernel errors (`stale_expectation`,
/// `type_mismatch`, `not_contiguous`, `node_not_editable`) and their own
/// pre-check errors, each compared after the call.
#[test]
#[allow(clippy::too_many_lines)]
fn effect_driven_sugar_tools_match_the_kernel_oracle_over_the_alchemy_corpus() {
    let Some(mut p) = Pair::new() else {
        return;
    };
    let notes_paras = top_blocks(&p.legacy, NOTES, "paragraph");
    let notes_headings = top_blocks(&p.legacy, NOTES, "heading");
    let notes_lists = top_blocks(&p.legacy, NOTES, "list");
    let tasks_list = notes_lists.last().expect("the Tasks list").clone();
    let tasks = children(&p.legacy, &tasks_list);
    assert!(tasks.len() >= 7, "{tasks:?}");
    assert!(notes_paras.len() >= 4, "{notes_paras:?}");
    assert!(notes_headings.len() >= 3, "{notes_headings:?}");
    let salt_lists = top_blocks(&p.legacy, SALT, "list");
    let salt_supplies = salt_lists.last().expect("the Supplies list").clone();
    let link = link_node(&p.legacy, SALT);

    // blocks_insert: top level, into a list container (the parsed wrapper
    // list burns an id), the destination-parent CAS, a leaf parent (kernel
    // `type_mismatch`), an unknown ref (pre-check).
    let ins = p.ok(
        "insert-end",
        "blocks_insert",
        json!({ "to": NOTES, "markdown": "Tail.\n" }),
    );
    assert_eq!(ins["new_ids"].as_object().map(Map::len), Some(1), "{ins}");
    p.ok(
        "insert-list-item",
        "blocks_insert",
        json!({ "to": tasks_list, "markdown": "- [ ] another\n", "at": { "after": tasks[1] } }),
    );
    p.err(
        "insert-stale-parent",
        "blocks_insert",
        json!({ "to": tasks_list, "markdown": "- x", "expect": { "parent_children_hash": "00" } }),
        "stale_expectation",
    );
    p.ok(
        "insert-empty-expect",
        "blocks_insert",
        json!({ "to": NOTES, "markdown": "Tail two.\n", "expect": {} }),
    );
    p.err(
        "insert-into-leaf",
        "blocks_insert",
        json!({ "to": notes_paras[0], "markdown": "x" }),
        "type_mismatch",
    );
    p.err(
        "insert-unknown-ref",
        "blocks_insert",
        json!({ "to": "b_zzz", "markdown": "x" }),
        "block_missing",
    );

    // blocks_update: markdown, checked, markdown + checked on a task item
    // (two effects, one kernel op), a stale `content_hash`, a multi-block
    // replacement (the ids in the preview).
    let upd = p.ok(
        "update-markdown",
        "blocks_update",
        json!({ "id": notes_paras[0], "markdown": "Edited paragraph." }),
    );
    assert!(upd.get("id").is_none() && upd.get("ids").is_none(), "{upd}");
    p.ok(
        "update-checked",
        "blocks_update",
        json!({ "id": tasks[4], "checked": true }),
    );
    p.ok(
        "update-markdown-and-checked",
        "blocks_update",
        json!({ "id": tasks[0], "markdown": "- [ ] rewritten", "checked": true }),
    );
    assert_eq!(raw(&p.sugar, &tasks[0]), "- [ ] rewritten");
    p.err(
        "update-stale-content",
        "blocks_update",
        json!({ "id": notes_paras[1], "markdown": "x", "expect": { "content_hash": "00" } }),
        "stale_expectation",
    );
    let multi = p.ok(
        "update-multi-block",
        "blocks_update",
        json!({ "id": notes_paras[1], "markdown": "Two paragraphs.\n\nSecond." }),
    );
    assert_eq!(
        multi["new_ids"].as_object().map(Map::len),
        Some(2),
        "a re-parse into two blocks mints two: {multi}"
    );
    // `checked` alone still runs the content CAS when a hash is given.
    p.err(
        "update-checked-stale-content",
        "blocks_update",
        json!({ "id": tasks[5], "checked": true, "expect": { "content_hash": "00" } }),
        "stale_expectation",
    );

    // blocks_move: within the document, the own-document guard, a heading
    // destination (`type_mismatch`), the destination CAS, a cross-document
    // move into a list container.
    p.ok(
        "move-start",
        "blocks_move",
        json!({ "blocks": [notes_paras[2]], "to": NOTES, "at": "start" }),
    );
    p.err(
        "move-other-root",
        "blocks_move",
        json!({ "blocks": [notes_paras[2]], "to": SALT }),
        "target_missing",
    );
    p.err(
        "move-into-heading",
        "blocks_move",
        json!({ "blocks": [notes_paras[2]], "to": notes_headings[1], "at": "end" }),
        "type_mismatch",
    );
    p.err(
        "move-stale-parent",
        "blocks_move",
        json!({ "blocks": [tasks[2]], "to": tasks_list, "at": "start", "expect": { "parent_children_hash": "00" } }),
        "stale_expectation",
    );
    p.ok(
        "move-cross-doc",
        "blocks_move",
        json!({ "blocks": [tasks[3]], "to": salt_supplies, "at": "end" }),
    );

    // blocks_remove: two blocks, one with children.
    p.ok(
        "remove",
        "blocks_remove",
        json!({ "blocks": [tasks[6], notes_paras[3]] }),
    );

    // blocks_split: committed, an offset past the end.
    let split = p.ok(
        "split",
        "blocks_split",
        json!({ "id": notes_paras[0], "at": [6] }),
    );
    // The first half keeps its id, the second is the one symbol minted.
    let second = split["new_ids"]["$new.0"]
        .as_str()
        .expect("one mint")
        .to_owned();
    let halves = vec![notes_paras[0].clone(), second];
    p.err(
        "split-bad-offset",
        "blocks_split",
        json!({ "id": notes_paras[2], "at": [9999] }),
        "type_mismatch",
    );

    // blocks_merge: the split halves, a non-adjacent pair.
    p.ok(
        "merge",
        "blocks_merge",
        json!({ "blocks": halves, "separator": " " }),
    );
    p.err(
        "merge-non-adjacent",
        "blocks_merge",
        json!({ "blocks": [notes_paras[0], notes_paras[2]] }),
        "not_contiguous",
    );

    // blocks_check: on, off, a paragraph (the kernel sets the attribute regardless).
    p.ok(
        "check-on",
        "blocks_check",
        json!({ "ids": [tasks[5], tasks[1]] }),
    );
    p.ok(
        "check-off",
        "blocks_check",
        json!({ "ids": [tasks[1]], "checked": false }),
    );
    p.ok(
        "check-paragraph",
        "blocks_check",
        json!({ "ids": [notes_paras[2]] }),
    );

    // nodes_set: a link's destination, an unknown prop, an unknown node.
    p.ok(
        "node-set",
        "nodes_set",
        json!({ "id": link, "prop": "value", "value": "/processes/dissolution.md" }),
    );
    p.err(
        "node-set-unknown-prop",
        "nodes_set",
        json!({ "id": link, "prop": "nope", "value": "x" }),
        "node_not_editable",
    );
    p.err(
        "node-set-unknown-node",
        "nodes_set",
        json!({ "id": "n_000000000000", "prop": "value", "value": "x" }),
        "block_missing",
    );

    // blocks_append: a heading's section, a container, a leaf.
    p.ok(
        "append-section",
        "blocks_append",
        json!({ "id": notes_headings[1], "text": "Appended to Setup." }),
    );
    p.ok(
        "append-container",
        "blocks_append",
        json!({ "id": tasks_list, "text": "- [ ] appended\n" }),
    );
    p.err(
        "append-leaf",
        "blocks_append",
        json!({ "id": notes_paras[2], "text": "x" }),
        "block_not_container",
    );

    // docs_append: a section by text, the top level, a missing heading, a
    // missing document.
    p.ok(
        "docs-append-section",
        "docs_append",
        json!({ "path": NOTES, "section": "## Results", "text": "Appended under Results." }),
    );
    p.ok(
        "docs-append-end",
        "docs_append",
        json!({ "id": doc_id(&p.legacy, NOTES), "text": "- a\n- b\n" }),
    );
    p.err(
        "docs-append-nope",
        "docs_append",
        json!({ "path": NOTES, "section": "Nope", "text": "x" }),
        "parent_missing",
    );
    p.err(
        "docs-append-missing-doc",
        "docs_append",
        json!({ "path": "nope.md", "text": "x" }),
        "doc_missing",
    );

    // links_retarget / links_repair (4.0: committed by default, no
    // `applied`): a commit, two pairs with one miss, no hit at all (a
    // Receipt with `commit: null`), a scope.
    let rt = p.ok(
        "retarget-apply",
        "links_retarget",
        json!({ "from_target": "mercury", "to_target": "substances/mercury.md" }),
    );
    assert!(rt.get("applied").is_none(), "{rt}");
    assert!(!rt["hits"].as_array().unwrap().is_empty(), "{rt}");
    assert_eq!(
        rt.as_object().unwrap().keys().collect::<Vec<_>>(),
        [
            "hits",
            "pairs",
            "plan_id",
            "commit",
            "revisions",
            "new_ids",
            "committed",
            "summary"
        ]
    );
    p.ok(
        "repair-two-pairs",
        "links_repair",
        json!({ "repairs": [{ "from": "salt", "to": "substances/salt.md" }, { "from": "/nope.md", "to": "/x.md" }] }),
    );
    let none = p.ok(
        "retarget-no-hits",
        "links_retarget",
        json!({ "from_target": "zzz-nothing", "to_target": "y.md" }),
    );
    assert_eq!(none["commit"], Json::Null, "{none}");
    assert_eq!(none["hits"], json!([]));
    p.ok(
        "retarget-scoped",
        "links_retarget",
        json!({ "from_target": "sulphur", "to_target": "substances/sulphur.md", "path_glob": "substances/**" }),
    );
}

// ---- the two pinned fixes -------------------------------------------------------------

/// `blocks_update { markdown, expect: {} }`: the kernel op carried an empty
/// expectation (`stale_expectation` "expect.content_hash required"); the
/// planner pins the live hash, so the write succeeds.
#[test]
fn blocks_update_with_an_empty_expect_succeeds_through_the_planner() {
    let Some(mut p) = Pair::new() else {
        return;
    };
    let para = top_blocks(&p.legacy, NOTES, "paragraph")[0].clone();
    let args = json!({ "id": para, "markdown": "Pinned by the planner.", "expect": {} });
    let old = outcome(call_legacy(&mut p.legacy, "blocks_update", &args));
    assert_eq!(old["error"], "stale_expectation", "{old}");
    assert_eq!(old["message"], "expect.content_hash required");
    let new = outcome(p.sugar.call_result("blocks_update", &args));
    assert!(new.get("error").is_none(), "{new}");
    assert_eq!(new["committed"], true);
    assert_eq!(raw(&p.sugar, &para), "Pinned by the planner.");
    // A wrong hash is still refused, with the kernel's own data.
    let stale = outcome(p.sugar.call_result(
        "blocks_update",
        &json!({ "id": para, "markdown": "x", "expect": { "content_hash": "00" } }),
    ));
    assert_eq!(stale["error"], "stale_expectation");
    assert_eq!(stale["data"]["op_index"], 0);
    assert_eq!(stale["data"]["block"], para);
    assert!(stale["data"].get("effect_index").is_none(), "{stale}");
}

/// `blocks_check { ids: [t, t] }`: the kernel expansion pinned both ops to
/// the pre-write hash, so the second failed `stale_expectation`; the planner
/// sees one identical scalar write twice and drops the duplicate — one
/// revision, the task checked.
#[test]
fn blocks_check_with_a_duplicate_id_dedupes_through_the_planner() {
    let Some(mut p) = Pair::new() else {
        return;
    };
    let list = top_blocks(&p.legacy, NOTES, "list").last().unwrap().clone();
    let task = children(&p.legacy, &list)[4].clone();
    assert!(
        raw(&p.legacy, &task).starts_with("- [ ]"),
        "an unchecked task"
    );
    let args = json!({ "ids": [task, task] });
    let old = outcome(call_legacy(&mut p.legacy, "blocks_check", &args));
    assert_eq!(old["error"], "stale_expectation", "{old}");
    let (new, plan) = p
        .sugar
        .call_result_with_plan("blocks_check", &args)
        .unwrap();
    assert_eq!(
        plan.unwrap()["preview"]["results"],
        json!([{ "ids": [task] }])
    );
    assert_eq!(new["revisions"].as_array().unwrap().len(), 1);
    assert_eq!(new["committed"], true);
    assert!(raw(&p.sugar, &task).starts_with("- [x]"));
}

/// An empty `blocks` / `ids` list is an argument error on the four list
/// tools (3.2, §9) — raised after the root check, before any ref resolves —
/// where the kernel oracle reached the kernel with a malformed op
/// (`block_missing`) or, for `blocks_check`, committed nothing and reported
/// success.
#[test]
fn an_empty_block_list_is_an_argument_error() {
    let Some(mut p) = Pair::new() else {
        return;
    };
    for (tool, arg, extra) in [
        ("blocks_move", "blocks", json!({ "to": NOTES })),
        ("blocks_remove", "blocks", json!({})),
        ("blocks_merge", "blocks", json!({})),
        ("blocks_check", "ids", json!({})),
    ] {
        let mut args = extra.as_object().unwrap().clone();
        args.insert(arg.to_owned(), json!([]));
        let out = outcome(p.sugar.call_result(tool, &Json::Object(args.clone())));
        assert_eq!(out["error"], "filter_invalid", "{tool}: {out}");
        let shape = tool_spec(tool).unwrap();
        let tail = arguments_hint(tool, &shape.input_schema);
        assert_eq!(
            out["message"],
            format!("`{arg}` must name at least one block ({tail})"),
            "{tool}"
        );
        assert_eq!(out["data"]["hint"], "arguments");
        let before = footprint(&p.sugar);
        let old = outcome(call_legacy(&mut p.legacy, tool, &Json::Object(args)));
        if tool == "blocks_check" {
            assert_eq!(
                old["committed"], true,
                "the kernel no-op reported success: {old}"
            );
        } else {
            assert_eq!(old["error"], "block_missing", "{tool}: {old}");
        }
        assert_eq!(
            footprint(&p.sugar),
            before,
            "{tool}: an argument error writes nothing"
        );
    }
    assert_eq!(
        outcome(
            p.sugar
                .call_result("blocks_remove", &json!({ "blocks": [] }))
        )["message"],
        "`blocks` must name at least one block (blocks_remove takes blocks, repo?)"
    );
    assert_eq!(
        outcome(p.sugar.call_result("blocks_check", &json!({ "ids": [] })))["message"],
        "`ids` must name at least one block (blocks_check takes checked?, ids, repo?)"
    );
}

// ---- 4.0: previews, retired names -------------------------------------------------------

/// Every write's preview is the Plan (`spec/cli` §3.6; the CLI's seam runs
/// the tool's own resolution and checks): nothing written, no id burned, the
/// hook quiet, and the commit that follows IS that plan — the same
/// `plan_id`, its symbols realized to the ids the preview would have named.
#[test]
#[allow(clippy::too_many_lines)]
fn previews_are_plans_that_burn_nothing() {
    let Some(files) = corpus() else {
        return;
    };
    let mut s = surface(&files);
    let notes_paras = top_blocks(&s, NOTES, "paragraph");
    let tasks_list = top_blocks(&s, NOTES, "list").last().unwrap().clone();
    let tasks = children(&s, &tasks_list);
    let link = link_node(&s, SALT);
    let doc = doc_id(&s, NOTES);
    let cases: Vec<(&str, Json)> = vec![
        (
            "blocks_insert",
            json!({ "to": NOTES, "markdown": "One.\n\nTwo.\n" }),
        ),
        (
            "blocks_update",
            json!({ "id": notes_paras[0], "markdown": "Edited." }),
        ),
        (
            "blocks_move",
            json!({ "blocks": [notes_paras[1]], "to": NOTES, "at": "start" }),
        ),
        ("blocks_check", json!({ "ids": [tasks[0]] })),
        ("blocks_split", json!({ "id": notes_paras[2], "at": [4] })),
        ("blocks_remove", json!({ "blocks": [tasks[6]] })),
        (
            "nodes_set",
            json!({ "id": link, "prop": "value", "value": "/x.md" }),
        ),
        (
            "blocks_append",
            json!({ "id": tasks_list, "text": "- [ ] appended\n" }),
        ),
        ("docs_append", json!({ "id": doc, "text": "Appended.\n" })),
        (
            "links_retarget",
            json!({ "from_target": "mercury", "to_target": "substances/mercury.md" }),
        ),
        (
            "docs_create",
            json!({ "path": "notes/new.md", "markdown": "# New\n\nBody.\n", "frontmatter": { "title": "New" } }),
        ),
        (
            "docs_set_meta",
            json!({ "path": SALT, "set": { "reviewed": "2026-09" }, "unset": ["tradition"] }),
        ),
        (
            "docs_move",
            json!({ "path": "texts/mutus-liber.md", "to_path": "texts/silent-book.md" }),
        ),
        ("docs_delete", json!({ "path": "texts/emerald-tablet.md" })),
        (
            "docs_update",
            json!({ "path": "processes/calcination.md", "content": "# Calcination\n\nOnly this.\n" }),
        ),
        (
            "apply",
            json!({ "effects": [{ "op": "insert", "into": { "kind": "document", "path": NOTES }, "markdown": "Via apply.\n" }] }),
        ),
    ];
    for (tool, args) in cases {
        let before = footprint(&s);
        let next_b = s.store_mut().mint("b").unwrap();
        let next_d = s.store_mut().mint("d").unwrap();
        let plan = s
            .preview_call(tool, &args)
            .unwrap_or_else(|e| panic!("{tool}: {}", e.to_json()));
        assert_eq!(plan["version"], 1, "{tool}: a Plan, not a Receipt: {plan}");
        assert!(plan.get("committed").is_none(), "{tool}: {plan}");
        assert!(plan["preview"]["diffs"].is_object(), "{tool}: {plan}");
        assert_eq!(footprint(&s), before, "{tool}: a preview writes nothing");
        // The mints the preview's symbols stand for are still the next ones:
        // the sequential minter answers the same `b`/`d` after the preview.
        let after_b = s.store_mut().mint("b").unwrap();
        let after_d = s.store_mut().mint("d").unwrap();
        let bump = |id: &str| -> usize { id.split('_').nth(1).unwrap().parse::<usize>().unwrap() };
        assert_eq!(
            bump(&after_b),
            bump(&next_b) + 1,
            "{tool}: the preview burned a `b`"
        );
        assert_eq!(
            bump(&after_d),
            bump(&next_d) + 1,
            "{tool}: the preview burned a `d`"
        );
        // The commit is the previewed plan: the same digest, every symbol
        // realized in the receipt.
        let (receipt, committed_plan) = s
            .call_result_with_plan(tool, &args)
            .unwrap_or_else(|e| panic!("{tool}: {}", e.to_json()));
        assert_eq!(
            receipt["plan_id"], plan["plan_id"],
            "{tool}: the preview IS the plan"
        );
        assert_eq!(receipt["committed"], json!(true), "{tool}: {receipt}");
        let committed_plan = committed_plan.expect("a write tool keeps its plan");
        assert_eq!(committed_plan["plan_id"], plan["plan_id"]);
        let symbols: Vec<&str> = plan["new_ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["symbol"].as_str().unwrap())
            .collect();
        let realized = receipt["new_ids"].as_object().unwrap();
        assert_eq!(
            realized.keys().map(String::as_str).collect::<Vec<_>>(),
            symbols,
            "{tool}: every symbol of the preview is realized"
        );
    }
    // The pinned relabels (3.0; `spec/mutate` §6, §10): a committed
    // `docs_set_meta` is a head write — every block `edited / api`, no
    // matcher — and a committed `docs_create` a known-id ingest — every
    // block `inserted / api`.
    let created = s.call(
        "docs_create",
        json!({ "path": "notes/other.md", "markdown": "# O\n\nP.\n" }),
    );
    let rows = dispositions_of(&s, created.body["commit"].as_str().unwrap());
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert!(
        rows.iter()
            .all(|(k, r, m)| k == "inserted" && r == "api" && m.is_none()),
        "{rows:?}"
    );
    let patched = s.call(
        "docs_set_meta",
        json!({ "path": SALT, "set": { "verified": true } }),
    );
    let rows = dispositions_of(&s, patched.body["commit"].as_str().unwrap());
    assert!(!rows.is_empty());
    assert!(
        rows.iter()
            .all(|(k, r, m)| k == "edited" && r == "api" && m.is_none()),
        "{rows:?}"
    );
}

/// The four document operations at the surface are the store's own (the same
/// builders): identical footprints, the pre-checks' messages and `data`
/// pinned (`path_taken {}`, `doc_missing`), the Receipt's revisions, and
/// `docs_move`'s link report; an empty `docs_set_meta` is an argument error.
#[test]
#[allow(clippy::too_many_lines)]
fn document_operations_are_the_stores_builders() {
    let Some(files) = corpus() else {
        return;
    };
    let mut a = surface(&files);
    let mut b = surface(&files);
    const MUTUS: &str = "texts/mutus-liber.md";
    const EMERALD: &str = "texts/emerald-tablet.md";
    let repo = a.default_repo.clone();
    let ctx = |a: &mut Surface| omgbase_store::DocOpContext {
        repo_id: repo.clone(),
        actor: Some(a.actor.clone()),
        ts: a.now(),
    };
    let via_store = |b: &mut Surface,
                     f: &dyn Fn(
        &mut Store,
        &mut dyn DocStore,
        &omgbase_store::DocOpContext,
    ) -> omgbase_store::Result<Json>|
     -> Json {
        let c = ctx(b);
        let out = b.with_writes(None, |store, ds| {
            f(store, ds, &c).map_err(SurfaceError::from)
        });
        outcome(out)
    };
    let same = |label: &str, a: &Surface, b: &Surface| {
        let (fa, fb) = (footprint(a), footprint(b));
        assert!(
            fa == fb,
            "[{label}] the surface and the store differ:\n{}",
            footprint_diff(&fb, &fa)
        );
    };

    // create
    let fm: Map<String, Json> =
        serde_json::from_str(r#"{"type":"substance","layer":"working"}"#).unwrap();
    let created = outcome(a.call_result("docs_create", &json!({ "path": "/substances/gold.md", "markdown": "# Gold\n\nSee [[mercury]] and [lost](nope.md).\n\n- [ ] refine\n", "frontmatter": fm })));
    let fm2 = fm.clone();
    let store_created = via_store(&mut b, &|store, ds, c| {
        store
            .docs_create(
                c,
                ds,
                "/substances/gold.md",
                "# Gold\n\nSee [[mercury]] and [lost](nope.md).\n\n- [ ] refine\n",
                Some(&fm2),
            )
            .map(|r| r.receipt.to_json())
    });
    assert_eq!(
        created["revisions"][0]["id"],
        store_created["revisions"][0]["id"]
    );
    assert_eq!(created["new_ids"], store_created["new_ids"]);
    assert_eq!(
        created["revisions"][0]["path"], "/substances/gold.md",
        "rooted at the surface"
    );
    same("create", &a, &b);
    let taken = outcome(a.call_result(
        "docs_create",
        &json!({ "path": "index.md", "markdown": "# Again\n" }),
    ));
    assert_eq!(taken["error"], "path_taken");
    assert_eq!(taken["message"], "document already exists at index.md");
    assert_eq!(taken["data"], json!({}));
    for s in [&mut a, &mut b] {
        let WriteTarget::Fixed(ds) = &mut s.writes else {
            panic!()
        };
        ds.write("notes/stray.md", "# Stray\n").unwrap();
    }
    let stray = outcome(a.call_result(
        "docs_create",
        &json!({ "path": "notes/stray.md", "markdown": "# Again\n" }),
    ));
    assert_eq!(
        stray["message"],
        "file already exists on disk at notes/stray.md"
    );

    // set_meta: set two + unset one, a shared key, a document without
    // frontmatter, an absent key, a miss, nothing to do.
    let patched = outcome(a.call_result("docs_set_meta", &json!({ "path": SALT, "set": { "verified": false, "reviewed": "2026-09" }, "unset": ["tradition"] })));
    assert_eq!(
        patched["revisions"].as_array().map(Vec::len),
        Some(1),
        "{patched}"
    );
    let set: Map<String, Json> =
        serde_json::from_str(r#"{"verified":false,"reviewed":"2026-09"}"#).unwrap();
    via_store(&mut b, &|store, ds, c| {
        store
            .docs_set_meta(c, ds, SALT, Some(&set), &["tradition".to_owned()])
            .map(|r| r.to_json())
    });
    same("set-meta", &a, &b);
    let shared: Map<String, Json> = serde_json::from_str(r#"{"status":"x","other":1}"#).unwrap();
    outcome(a.call_result(
        "docs_set_meta",
        &json!({ "path": SALT, "set": shared, "unset": ["status"] }),
    ));
    via_store(&mut b, &|store, ds, c| {
        store
            .docs_set_meta(c, ds, SALT, Some(&shared), &["status".to_owned()])
            .map(|r| r.to_json())
    });
    same("set-meta-shared-key", &a, &b);
    let missing = outcome(a.call_result(
        "docs_set_meta",
        &json!({ "path": "nope.md", "set": { "a": 1 } }),
    ));
    assert_eq!(missing["error"], "doc_missing");
    assert_eq!(missing["data"], json!({ "path": "nope.md" }));
    let before = footprint(&a);
    for args in [
        json!({ "path": SALT, "set": {}, "unset": [] }),
        json!({ "path": SALT }),
    ] {
        let out = outcome(a.call_result("docs_set_meta", &args));
        assert_eq!(out["error"], "filter_invalid", "{out}");
        assert_eq!(
            out["message"],
            "pass `set` and/or `unset` (docs_set_meta takes id?, path?, repo?, set?, unset?)",
            "{out}"
        );
    }
    assert_eq!(footprint(&a), before, "nothing written");

    // move: with the default retarget (index.md links to Mutus Liber), the
    // link report; a destination taken; a miss; without the retarget.
    let moved = outcome(a.call_result(
        "docs_move",
        &json!({ "path": MUTUS, "to_path": "texts/silent-book.md" }),
    ));
    assert!(moved.get("error").is_none(), "{moved}");
    let store_moved = via_store(&mut b, &|store, ds, c| {
        store
            .docs_move(c, ds, MUTUS, "texts/silent-book.md", true)
            .map(|r| {
                let mut v = r.receipt.to_json();
                v["dangling"] = json!(
                    r.dangling
                        .iter()
                        .map(omgbase_store::InboundLink::to_json)
                        .collect::<Vec<_>>()
                );
                v["retargeted"] = omgbase_store::docs_ops::retargeted_json(r.retargeted.as_ref());
                v
            })
    });
    same("move", &a, &b);
    assert_eq!(moved["retargeted"], store_moved["retargeted"]);
    assert_eq!(moved["dangling"], json!([]));
    assert_eq!(
        moved["revisions"].as_array().map(Vec::len),
        Some(1),
        "the rewritten source: {moved}"
    );
    assert_eq!(moved["revisions"][0]["path"], "/index.md");
    assert_eq!(
        moved.as_object().unwrap().keys().collect::<Vec<_>>(),
        [
            "plan_id",
            "commit",
            "revisions",
            "new_ids",
            "committed",
            "summary",
            "retargeted",
            "dangling"
        ]
    );
    let taken = outcome(a.call_result(
        "docs_move",
        &json!({ "path": SALT, "to_path": "/index.md" }),
    ));
    assert_eq!(taken["message"], "a document already exists at index.md");
    assert_eq!(taken["data"], json!({}));
    let missing = outcome(a.call_result("docs_move", &json!({ "path": MUTUS, "to_path": "x.md" })));
    assert_eq!(missing["error"], "doc_missing");
    let plain = outcome(a.call_result(
        "docs_move",
        &json!({ "path": EMERALD, "to_path": "texts/tablet.md", "retarget_inbound": false }),
    ));
    via_store(&mut b, &|store, ds, c| {
        store
            .docs_move(c, ds, EMERALD, "texts/tablet.md", false)
            .map(|r| r.to_json())
    });
    same("move-no-retarget", &a, &b);
    assert_eq!(plain["revisions"], json!([]), "{plain}");
    assert!(
        plain["dangling"].as_array().is_some_and(|d| !d.is_empty()),
        "{plain}"
    );
    assert_eq!(
        plain["dangling"][0]["path"]
            .as_str()
            .map(|p| p.starts_with('/')),
        Some(true),
        "rooted"
    );
    assert_eq!(plain["retargeted"], Json::Null);

    // delete: a Receipt without a revision; a repeat is a miss.
    let deleted = outcome(a.call_result("docs_delete", &json!({ "path": "texts/tablet.md" })));
    via_store(&mut b, &|store, ds, c| {
        store
            .docs_delete(c, ds, "texts/tablet.md")
            .map(|r| r.to_json())
    });
    same("delete", &a, &b);
    assert_eq!(deleted["revisions"], json!([]));
    assert!(deleted["commit"].is_string(), "{deleted}");
    let again = outcome(a.call_result("docs_delete", &json!({ "path": "texts/tablet.md" })));
    assert_eq!(again["error"], "doc_missing");
}

/// Every retired input is `filter_invalid` naming its replacement, before the
/// handler runs (4.0, `spec/surface` §4): `dry_run` on `apply` and every
/// sugar tool, `ops` on `apply`, `attrs` on `blocks_update`; an unknown
/// argument is never stripped.
#[test]
fn retired_names_are_argument_errors_on_every_write_tool() {
    let Some(files) = corpus() else {
        return;
    };
    let mut s = surface(&files);
    let before = footprint(&s);
    let para = top_blocks(&s, NOTES, "paragraph")[0].clone();
    let writes: Vec<(&str, Json)> = vec![
        ("apply", json!({ "effects": [] })),
        ("blocks_insert", json!({ "to": NOTES, "markdown": "x" })),
        ("blocks_update", json!({ "id": para, "markdown": "x" })),
        ("blocks_move", json!({ "blocks": [para], "to": NOTES })),
        ("blocks_remove", json!({ "blocks": [para] })),
        ("blocks_split", json!({ "id": para, "at": [1] })),
        ("blocks_merge", json!({ "blocks": [para] })),
        ("blocks_check", json!({ "ids": [para] })),
        (
            "nodes_set",
            json!({ "id": "n_x", "prop": "value", "value": "x" }),
        ),
        ("blocks_append", json!({ "id": para, "text": "x" })),
        ("docs_append", json!({ "path": NOTES, "text": "x" })),
        (
            "links_retarget",
            json!({ "from_target": "a", "to_target": "b" }),
        ),
        (
            "links_repair",
            json!({ "from_target": "a", "to_target": "b" }),
        ),
        ("docs_create", json!({ "path": "n.md", "markdown": "x" })),
        ("docs_move", json!({ "path": NOTES, "to_path": "x.md" })),
        ("docs_delete", json!({ "path": NOTES })),
        ("docs_set_meta", json!({ "path": NOTES, "set": { "a": 1 } })),
        ("docs_update", json!({ "path": NOTES, "content": "x" })),
    ];
    for (tool, args) in writes {
        let mut with_dry = args.as_object().unwrap().clone();
        with_dry.insert("dry_run".to_owned(), json!(true));
        let out = outcome(s.call_result(tool, &Json::Object(with_dry)));
        let tail = arguments_hint(tool, &tool_spec(tool).unwrap().input_schema);
        assert_eq!(out["error"], "filter_invalid", "{tool}: {out}");
        assert_eq!(
            out["message"],
            format!(
                "`dry_run` is no longer an argument — preview with `plan {{ effects: [...] }}` ({tail})"
            ),
            "{tool}"
        );
        assert_eq!(out["data"]["hint"], "arguments");
    }
    let ops = outcome(s.call_result(
        "apply",
        &json!({ "ops": [{ "op": "remove", "blocks": [para] }] }),
    ));
    assert_eq!(
        ops["message"],
        "`ops` is no longer an argument — `apply` takes `effects` (the kernel ops are a library/fixture contract since spec/mutate 3.0) (apply takes effects, expect?, reason?, repo?, select?)"
    );
    let both = outcome(s.call_result("apply", &json!({ "ops": [], "effects": [] })));
    assert!(
        both["message"]
            .as_str()
            .unwrap()
            .starts_with("`ops` is no longer an argument"),
        "the retired name first (bytewise order of the given names): {both}"
    );
    let none = outcome(s.call_result("apply", &json!({})));
    assert_eq!(
        none["message"],
        "`effects` is required (apply takes effects, expect?, reason?, repo?, select?)"
    );
    let attrs = outcome(s.call_result(
        "blocks_update",
        &json!({ "id": para, "attrs": { "custom": 1 } }),
    ));
    assert_eq!(
        attrs["message"],
        "`attrs` is no longer an argument — pass `checked` (blocks_update takes checked?, expect?, id, markdown?, repo?)"
    );
    let applied = outcome(s.call_result(
        "links_retarget",
        &json!({ "from_target": "a", "to_target": "b", "applied": true }),
    ));
    assert!(
        applied["message"]
            .as_str()
            .unwrap()
            .starts_with("unknown argument `applied`"),
        "{applied}"
    );
    assert_eq!(footprint(&s), before, "an argument error writes nothing");
}

/// Surface 4.0: `docs_update` is sugar for `set { document, field: "content" }`
/// and answers with the Receipt. Its footprint equals the retired kernel
/// path's — `plan_update` + the kernel `apply` of the opset's ops with its
/// frontmatter as the file head — exactly: both are known-id ingests, so the
/// dispositions agree; the one difference is the intent record
/// (`commits.ops`), outside the footprint. A content already current is a
/// plan with nothing to do: no commit, no revision, the store untouched.
#[test]
fn docs_update_is_set_content_sugar_with_the_kernel_footprint() {
    let Some(files) = corpus() else {
        return;
    };
    let mut legacy = surface(&files);
    let mut sugar = surface(&files);
    const MUTUS: &str = "texts/mutus-liber.md";
    let content = "---\ntype: text\nlayer: draft\ntradition: western\nera: 1677\ntags: [text, images]\nverified: false\n---\n\n# Mutus Liber\n\nOnly this, and a [link](/substances/salt.md).\n\n- [x] Obtain a facsimile with plate numbering\n";
    // The kernel path, by hand: plan, then the ops. The opset's frontmatter
    // is unchanged here, so no head is needed (the kernel request lost its
    // `set_frontmatter` at 3.0).
    let repo = legacy.default_repo.clone();
    let opset = legacy
        .store_mut()
        .plan_update(&repo, MUTUS, content, &Config::default())
        .unwrap();
    assert!(opset.converges);
    assert!(opset.frontmatter.is_none());
    let req = ApplyRequest {
        repo_id: repo.clone(),
        ops: opset.kernel_ops(),
        origin: ApplyOrigin::new("agent:test", Some("interop")),
        dry_run: false,
    };
    let WriteTarget::Fixed(ds) = &mut legacy.writes else {
        panic!("fixed doc store")
    };
    let legacy_result = legacy
        .store
        .apply(&req, ds.as_mut(), CLOCK)
        .expect("the kernel apply");
    assert!(legacy_result.committed);

    sugar.actor = "agent:test".to_owned();
    let receipt = outcome(sugar.call_result(
        "docs_update",
        &json!({ "path": MUTUS, "content": content, "reason": "interop" }),
    ));
    assert_eq!(receipt["committed"], json!(true));
    assert_eq!(receipt["plan_id"].as_str().map(str::len), Some(64));
    assert_eq!(receipt["commit"], json!("c_20"));
    assert_eq!(
        receipt["revisions"],
        json!([{ "id": "d_17", "path": "/texts/mutus-liber.md", "hash": legacy_result.revisions[0].hash }])
    );
    assert!(
        receipt["new_ids"].as_object().map(Map::len) >= Some(opset.summary.created),
        "a symbol per inserted block (a re-parse's discarded mint included): {receipt}"
    );
    assert!(receipt.get("opset").is_none() && receipt.get("plan").is_none());
    // The kernel `plan_update` minted its reconcile's and verify's ids under
    // the production minter; the planner runs it under a throwaway symbol
    // table, so the new blocks' ids differ by offset — everything else, and
    // every disposition's labels, agree.
    let (fp_old, fp_new) = (footprint(&legacy), footprint(&sugar));
    for table in ["commits", "docs", "revisions", "pending", "files", "pool"] {
        assert_eq!(fp_new[table], fp_old[table], "{table}");
    }
    let labels = |fp: &Json| -> Vec<Json> {
        fp["dispositions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r[0] == json!("c_20"))
            .map(|r| json!([r[2], r[3], r[4]]))
            .collect()
    };
    let (mut old_labels, mut new_labels) = (labels(&fp_old), labels(&fp_new));
    old_labels.sort_by_key(|v| v.to_string());
    new_labels.sort_by_key(|v| v.to_string());
    assert_eq!(new_labels, old_labels, "both paths are known-id ingests");
    assert!(
        new_labels
            .iter()
            .all(|l| l[1] == json!("api") && l[2] == Json::Null),
        "{new_labels:?}"
    );
    assert_eq!(
        fp_new["blocks"].as_array().unwrap().len(),
        fp_old["blocks"].as_array().unwrap().len()
    );
    let ops: Option<String> = sugar
        .store
        .conn()
        .query_row(
            "SELECT ops FROM commits WHERE commit_id = 'c_20'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        ops.is_some_and(|o| o.contains("\"field\":\"content\"")),
        "the intent record names the effect"
    );

    // Already current: nothing planned, nothing committed.
    let before = footprint(&sugar);
    let again =
        outcome(sugar.call_result("docs_update", &json!({ "path": MUTUS, "content": content })));
    assert_eq!(again["commit"], Json::Null);
    assert_eq!(again["revisions"], json!([]));
    assert_eq!(again["new_ids"], json!({}));
    assert_eq!(again["committed"], json!(true));
    assert_eq!(footprint(&sugar), before, "no change, no commit");

    // A miss is the locator's `doc_missing`; the identity decision is the
    // plan's `preview.identity` — through `plan` and through the CLI's seam.
    let missing = outcome(sugar.call_result(
        "docs_update",
        &json!({ "path": "nope.md", "content": "# x\n" }),
    ));
    assert_eq!(missing["error"], "doc_missing");
    assert_eq!(missing["data"], json!({ "path": "nope.md" }));
    let plan = outcome(sugar.call_result(
        "plan",
        &json!({ "effects": [{ "op": "set", "target": { "kind": "document", "path": MUTUS }, "field": "content", "value": "# Mutus Liber\n\nOnly this.\n" }] }),
    ));
    let identity = &plan["preview"]["identity"]["d_17"];
    assert_eq!(identity["matcher_v"], json!(opset.matcher_v));
    assert_eq!(identity["summary"]["preserved"], json!(1));
    assert_eq!(identity["ops"][0]["op_index"], json!(0));
    assert!(identity["ops"][0].get("disposition").is_some());
    let previewed = sugar
        .preview_call(
            "docs_update",
            &json!({ "path": MUTUS, "content": "# Mutus Liber\n\nOnly this.\n" }),
        )
        .unwrap();
    assert_eq!(previewed["plan_id"], plan["plan_id"]);
}
