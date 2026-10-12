//! ADR-021, the migration phase: the twelve batch-1 sugar tools and the four
//! batch-2 document operations now lower to `apply { effects }`
//! ([`Surface::apply_sugar`] / [`Surface::apply_sugar_with`]) and must be
//! **behaviour-preserving**. Every scenario here runs the same call twice —
//! through the pre-migration handler ([`Surface::call_legacy`], the kernel
//! ops + [`Surface::apply_ops`] or the library's document operations, kept
//! verbatim for this comparison) on one surface and through the effect-driven
//! handler on another, both over the alchemy corpus under the sequential
//! minter and one clock — and requires: the result JSON deep-equal (errors
//! included: code, message, `data`), the store projection identical
//! (`commits` minus `ops`, `docs`, live `blocks`, `revisions`,
//! `block_changes`, `dispositions`, the pool, the pending rows, the files),
//! and the next `b` and `d` the two stores mint identical (a dry run burns
//! the same ids). The deliberate differences the design pins — `blocks_update`
//! with an empty `expect` on `markdown`, `blocks_check` naming one id twice,
//! `docs_set_meta`'s known-id identity (dispositions `edited`/`api` where the
//! reconciling ingest wrote `same`/`exact_hash`) — are asserted as
//! differences, not equalities.

use std::fs;
use std::path::{Path, PathBuf};

use omgbase_format::hash::hex;
use omgbase_reconcile::Config;
use omgbase_store::{BatchItem, DocStore, MemDocStore, SequentialMinter, Store};
use serde_json::{Map, Value as Json, json};

use super::{Surface, WriteTarget};

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
/// record the effect path writes and the legacy path leaves NULL).
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

fn outcome(r: Result<Json, super::SurfaceError>) -> Json {
    match r {
        Ok(v) => v,
        Err(e) => e.to_json(),
    }
}

/// The legacy surface and the effect-driven one, advanced in lockstep.
struct Pair {
    legacy: Surface,
    sugar: Surface,
    /// A pinned `docs_set_meta` commit happened: its relabelled rows stay in
    /// every later footprint, so the tolerance sticks for the sequence.
    identity_pinned: bool,
}

impl Pair {
    fn new() -> Option<Self> {
        let files = corpus()?;
        Some(Self {
            legacy: surface(&files),
            sugar: surface(&files),
            identity_pinned: false,
        })
    }

    /// Run one call both ways; every observable must agree.
    fn check(&mut self, label: &str, tool: &str, args: Json) -> Json {
        self.check_with(label, tool, args, false)
    }

    /// [`Pair::check`]; with `pinned_identity`, a committed `docs_set_meta`
    /// whose dispositions and block changes are allowed to differ exactly as
    /// the design pins (§2 item 6): the library's reconciling ingest matched
    /// every body block `same` (`exact_hash`, the matcher's version), the
    /// planner's known-id head writes `edited`/`api` with no matcher — the
    /// same blocks, the same commit, everything else identical.
    fn check_with(&mut self, label: &str, tool: &str, args: Json, pinned_identity: bool) -> Json {
        let old = outcome(self.legacy.call_legacy(tool, &args));
        let new = outcome(self.sugar.call_result(tool, &args));
        assert_eq!(
            new, old,
            "[{label}] {tool} {args}: the effect-driven result differs from the legacy result"
        );
        let mut fp_old = footprint(&self.legacy);
        let mut fp_new = footprint(&self.sugar);
        self.identity_pinned |= pinned_identity;
        if self.identity_pinned {
            let d_old = fp_old["dispositions"].take();
            let d_new = fp_new["dispositions"].take();
            assert_pinned_set_meta_identity(label, &d_old, &d_new, pinned_identity);
            let c_old = fp_old["block_changes"].take();
            let c_new = fp_new["block_changes"].take();
            assert_pinned_set_meta_changes(label, &c_old, &c_new);
        }
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

    /// A file both doc stores hold without the store knowing it (a stray file
    /// on disk).
    fn seed_file(&mut self, path: &str, bytes: &str) {
        for s in [&mut self.legacy, &mut self.sugar] {
            let WriteTarget::Fixed(ds) = &mut s.writes else {
                panic!("the test surfaces write through a fixed doc store")
            };
            ds.write(path, bytes).expect("seeded");
        }
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

/// The one difference a committed `docs_set_meta` or `docs_create` may show
/// (design §2 item 6, pinned by the interop `write-docs-set-meta-delete`
/// history read; the retirement design §2 (a) for a create): the rows of
/// the new commit. Every row the legacy path wrote as
/// `same`/`exact_hash`/`m<version>` the planner path writes as
/// `edited`/`api`/`NULL`, and every `inserted`/`NULL`/`m<version>` row of a
/// created document's reconciling ingest as `inserted`/`api`/`NULL`, for the
/// same `(commit, block)`; rows of other kinds (and every earlier commit's)
/// are identical.
fn assert_pinned_set_meta_identity(label: &str, old: &Json, new: &Json, expect_relabel: bool) {
    let rows = |v: &Json| -> Vec<Vec<Json>> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_array().unwrap().clone())
            .collect()
    };
    let (old, new) = (rows(old), rows(new));
    assert_eq!(old.len(), new.len(), "[{label}] dispositions row count");
    let mut relabeled = 0;
    for (o, n) in old.iter().zip(&new) {
        if o == n {
            continue;
        }
        assert_eq!(o[0], n[0], "[{label}] commit: {o:?} vs {n:?}");
        assert_eq!(o[1], n[1], "[{label}] block: {o:?} vs {n:?}");
        assert!(
            o[4].as_str().is_some_and(|m| m.starts_with('m')),
            "[{label}] the legacy row {o:?} carries no matcher version"
        );
        let planner = (&n[2], &n[3], &n[4]);
        if o[2] == json!("inserted") {
            // A created document: the reconciling ingest's `inserted` rows
            // are the known-id ingest's `inserted / api`.
            assert_eq!(o[3], Json::Null, "[{label}] the legacy row {o:?}");
            assert_eq!(
                planner,
                (&json!("inserted"), &json!("api"), &Json::Null),
                "[{label}] the planner row {n:?} is not `inserted`/`api`/NULL"
            );
        } else {
            assert_eq!(
                (&o[2], &o[3]),
                (&json!("same"), &json!("exact_hash")),
                "[{label}] the legacy row {o:?} is not a `same`/`exact_hash` match"
            );
            assert_eq!(
                planner,
                (&json!("edited"), &json!("api"), &Json::Null),
                "[{label}] the planner row {n:?} is not `edited`/`api`/NULL"
            );
        }
        relabeled += 1;
    }
    assert!(
        relabeled > 0 || !expect_relabel,
        "[{label}] expected the pinned identity difference; the dispositions were identical"
    );
}

/// The `block_changes` face of the same pin: a `same` row of the legacy
/// commit is an `edited` row of the planner's, block for block.
fn assert_pinned_set_meta_changes(label: &str, old: &Json, new: &Json) {
    let (old, new) = (old.as_array().unwrap(), new.as_array().unwrap());
    assert_eq!(old.len(), new.len(), "[{label}] block_changes row count");
    for (o, n) in old.iter().zip(new) {
        if o == n {
            continue;
        }
        assert_eq!(o[0], n[0], "[{label}] block: {o} vs {n}");
        assert_eq!(o[1], n[1], "[{label}] commit: {o} vs {n}");
        assert_eq!(
            (&o[2], &n[2]),
            (&json!("same"), &json!("edited")),
            "[{label}] {o} vs {n}: not the pinned `same` → `edited` relabel"
        );
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

// ---- the equivalence sweep ------------------------------------------------------------

/// One scenario sequence over both surfaces: committed and dry runs of
/// every batch-1 tool, their kernel errors (`stale_expectation`,
/// `type_mismatch`, `not_contiguous`, `node_not_editable`) and their own
/// pre-check errors, each compared after the call.
#[test]
#[allow(clippy::too_many_lines)]
fn effect_driven_sugar_tools_match_their_legacy_handlers_over_the_alchemy_corpus() {
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
    let salt_paras = top_blocks(&p.legacy, SALT, "paragraph");
    let link = link_node(&p.legacy, SALT);

    // blocks_insert: top level (dry + committed), into a list container
    // (the parsed wrapper list burns an id), the destination-parent CAS,
    // a leaf parent (kernel `type_mismatch`), an unknown ref (pre-check).
    p.ok(
        "insert-start-dry",
        "blocks_insert",
        json!({ "to": NOTES, "markdown": "## New\n\nPara.\n", "at": "start", "dry_run": true }),
    );
    p.ok(
        "insert-end",
        "blocks_insert",
        json!({ "to": NOTES, "markdown": "Tail.\n" }),
    );
    p.ok(
        "insert-list-item",
        "blocks_insert",
        json!({ "to": tasks_list, "markdown": "- [ ] another\n", "at": { "after": tasks[1] } }),
    );
    p.err(
        "insert-stale-parent",
        "blocks_insert",
        json!({ "to": tasks_list, "markdown": "- x", "expect": { "parent_children_hash": "00" }, "dry_run": true }),
        "stale_expectation",
    );
    p.ok(
        "insert-empty-expect",
        "blocks_insert",
        json!({ "to": NOTES, "markdown": "Tail two.\n", "expect": {}, "dry_run": true }),
    );
    p.err(
        "insert-into-leaf",
        "blocks_insert",
        json!({ "to": notes_paras[0], "markdown": "x", "dry_run": true }),
        "type_mismatch",
    );
    p.err(
        "insert-unknown-ref",
        "blocks_insert",
        json!({ "to": "b_zzz", "markdown": "x" }),
        "block_missing",
    );

    // blocks_update: markdown (dry + committed), checked, markdown + checked
    // on a task item (the two-op collapse), a stale `content_hash`, a
    // multi-block replacement (ids), the `attrs` bag (legacy both ways).
    p.ok(
        "update-markdown-dry",
        "blocks_update",
        json!({ "id": notes_paras[0], "markdown": "Edited paragraph.", "dry_run": true }),
    );
    let upd = p.ok(
        "update-markdown",
        "blocks_update",
        json!({ "id": notes_paras[0], "markdown": "Edited paragraph." }),
    );
    assert_eq!(upd["id"], notes_paras[0]);
    p.ok(
        "update-checked",
        "blocks_update",
        json!({ "id": tasks[4], "checked": true }),
    );
    let both = p.ok(
        "update-markdown-and-checked",
        "blocks_update",
        json!({ "id": tasks[0], "markdown": "- [ ] rewritten", "checked": true }),
    );
    // One result (the two effects collapse); the bytes are whatever the
    // legacy op produced — a `task` item takes the generic re-parse branch,
    // so this is a nested list and `checked` lands on the list's attrs —
    // and the pair check above has already proved them identical.
    assert_eq!(both["results"].as_array().unwrap().len(), 1);
    assert_eq!(raw(&p.sugar, &tasks[0]), "- [ ] rewritten");
    p.err(
        "update-stale-content",
        "blocks_update",
        json!({ "id": notes_paras[1], "markdown": "x", "expect": { "content_hash": "00" } }),
        "stale_expectation",
    );
    p.ok(
        "update-multi-block-dry",
        "blocks_update",
        json!({ "id": notes_paras[1], "markdown": "Two paragraphs.\n\nSecond.", "dry_run": true }),
    );
    p.ok(
        "update-attrs-bag",
        "blocks_update",
        json!({ "id": notes_paras[1], "attrs": { "custom": 1 } }),
    );
    p.ok(
        "update-attrs-checked-bag",
        "blocks_update",
        json!({ "id": tasks[5], "attrs": { "checked": true }, "dry_run": true }),
    );
    // `checked` alone still runs the content CAS when a hash is given.
    p.err(
        "update-checked-stale-content",
        "blocks_update",
        json!({ "id": tasks[5], "checked": true, "expect": { "content_hash": "00" }, "dry_run": true }),
        "stale_expectation",
    );
    p.ok(
        "update-checked-empty-expect",
        "blocks_update",
        json!({ "id": tasks[5], "checked": true, "expect": {}, "dry_run": true }),
    );

    // blocks_move: within the document (dry + committed), the own-document
    // guard, a heading destination (`type_mismatch`), the destination CAS,
    // a cross-document move into a list container.
    p.ok(
        "move-start-dry",
        "blocks_move",
        json!({ "blocks": [notes_paras[1]], "to": NOTES, "at": "start", "dry_run": true }),
    );
    p.ok(
        "move-start",
        "blocks_move",
        json!({ "blocks": [notes_paras[1]], "to": NOTES, "at": "start" }),
    );
    p.err(
        "move-other-root",
        "blocks_move",
        json!({ "blocks": [notes_paras[1]], "to": SALT }),
        "target_missing",
    );
    p.err(
        "move-into-heading",
        "blocks_move",
        json!({ "blocks": [notes_paras[1]], "to": notes_headings[1], "at": "end" }),
        "type_mismatch",
    );
    p.err(
        "move-stale-parent",
        "blocks_move",
        json!({ "blocks": [tasks[2]], "to": tasks_list, "at": "start", "expect": { "parent_children_hash": "00" }, "dry_run": true }),
        "stale_expectation",
    );
    p.ok(
        "move-cross-doc",
        "blocks_move",
        json!({ "blocks": [tasks[3]], "to": salt_supplies, "at": "end" }),
    );

    // blocks_remove: dry, then committed (two blocks, one with children).
    p.ok(
        "remove-dry",
        "blocks_remove",
        json!({ "blocks": [notes_paras[3]], "dry_run": true }),
    );
    p.ok(
        "remove",
        "blocks_remove",
        json!({ "blocks": [tasks[6], notes_paras[3]] }),
    );

    // blocks_split: dry + committed, an offset past the end.
    p.ok(
        "split-dry",
        "blocks_split",
        json!({ "id": notes_paras[0], "at": [6], "dry_run": true }),
    );
    let split = p.ok(
        "split",
        "blocks_split",
        json!({ "id": notes_paras[0], "at": [6] }),
    );
    let halves = split["results"][0]["ids"].as_array().unwrap().clone();
    assert_eq!(halves.len(), 2, "{split}");
    p.err(
        "split-bad-offset",
        "blocks_split",
        json!({ "id": notes_paras[2], "at": [9999], "dry_run": true }),
        "type_mismatch",
    );

    // blocks_merge: dry + committed (the split halves), a non-adjacent pair.
    p.ok(
        "merge-dry",
        "blocks_merge",
        json!({ "blocks": halves, "dry_run": true }),
    );
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

    // blocks_check: on (committed), off (dry), a paragraph (the kernel
    // sets the attribute regardless).
    p.ok(
        "check-on",
        "blocks_check",
        json!({ "ids": [tasks[5], tasks[1]] }),
    );
    p.ok(
        "check-off-dry",
        "blocks_check",
        json!({ "ids": [tasks[1]], "checked": false, "dry_run": true }),
    );
    p.ok(
        "check-paragraph",
        "blocks_check",
        json!({ "ids": [notes_paras[2]], "dry_run": true }),
    );

    // nodes_set: a link's destination (dry + committed), an unknown prop,
    // an unknown node.
    p.ok(
        "node-set-dry",
        "nodes_set",
        json!({ "id": link, "prop": "value", "value": "/x.md", "dry_run": true }),
    );
    // A destination different from the current one: the legacy editor
    // reports a rebuilt segment equal to the old one as "could not locate"
    // (both paths do; a value equal to the live target is that case).
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

    // blocks_append: a heading's section (committed), a container (dry), a leaf.
    p.ok(
        "append-section",
        "blocks_append",
        json!({ "id": notes_headings[1], "text": "Appended to Setup." }),
    );
    p.ok(
        "append-container-dry",
        "blocks_append",
        json!({ "id": tasks_list, "text": "- [ ] appended\n", "dry_run": true }),
    );
    p.err(
        "append-leaf",
        "blocks_append",
        json!({ "id": notes_paras[2], "text": "x" }),
        "block_not_container",
    );

    // docs_append: a section by text (dry + committed), the top level, a
    // missing heading, a missing document.
    p.ok(
        "docs-append-section-dry",
        "docs_append",
        json!({ "path": NOTES, "section": "Results", "text": "Appended under Results.", "dry_run": true }),
    );
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

    // links_retarget / links_repair: the default dry run, a commit, two
    // pairs with one miss, no hit at all (nothing committed), a scope.
    let plan = p.ok(
        "retarget-plan",
        "links_retarget",
        json!({ "from_target": "mercury", "to_target": "substances/mercury.md" }),
    );
    assert_eq!(plan["applied"], false);
    assert!(!plan["hits"].as_array().unwrap().is_empty(), "{plan}");
    p.ok(
        "retarget-apply",
        "links_retarget",
        json!({ "from_target": "mercury", "to_target": "substances/mercury.md", "dry_run": false }),
    );
    p.ok(
        "repair-two-pairs",
        "links_repair",
        json!({ "repairs": [{ "from": "salt", "to": "substances/salt.md" }, { "from": "/nope.md", "to": "/x.md" }], "dry_run": false }),
    );
    p.ok(
        "retarget-no-hits",
        "links_retarget",
        json!({ "from_target": "zzz-nothing", "to_target": "y.md", "dry_run": false }),
    );
    p.ok(
        "retarget-scoped",
        "links_retarget",
        json!({ "from_target": "sulphur", "to_target": "substances/sulphur.md", "path_glob": "substances/**" }),
    );
    let _ = salt_paras;
}

// ---- the two pinned fixes -------------------------------------------------------------

/// `blocks_update { markdown, expect: {} }`: the legacy op carried an empty
/// expectation to the kernel (`stale_expectation` "expect.content_hash
/// required"); the planner pins the live hash, so the write succeeds.
#[test]
fn blocks_update_with_an_empty_expect_succeeds_through_the_planner() {
    let Some(mut p) = Pair::new() else {
        return;
    };
    let para = top_blocks(&p.legacy, NOTES, "paragraph")[0].clone();
    let args = json!({ "id": para, "markdown": "Pinned by the planner.", "expect": {} });
    let old = outcome(p.legacy.call_legacy("blocks_update", &args));
    assert_eq!(old["error"], "stale_expectation", "{old}");
    assert_eq!(old["message"], "expect.content_hash required");
    let new = outcome(p.sugar.call_result("blocks_update", &args));
    assert!(new.get("error").is_none(), "{new}");
    assert_eq!(new["id"], para);
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

/// `blocks_check { ids: [t, t] }`: the legacy expansion pinned both ops to
/// the pre-write hash, so the second failed `stale_expectation`; the planner
/// sees one identical scalar write twice and drops the duplicate — one
/// result, one revision, the task checked.
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
    let old = outcome(p.legacy.call_legacy("blocks_check", &args));
    assert_eq!(old["error"], "stale_expectation", "{old}");
    let new = outcome(p.sugar.call_result("blocks_check", &args));
    assert!(new.get("error").is_none(), "{new}");
    assert_eq!(new["results"], json!([{ "ids": [task] }]));
    assert_eq!(new["revisions"].as_array().unwrap().len(), 1);
    assert_eq!(new["committed"], true);
    assert!(raw(&p.sugar, &task).starts_with("- [x]"));
}

/// An empty `blocks` / `ids` list is an argument error on the four list
/// tools (3.2, §9) — raised after the root check, before any ref resolves —
/// where the legacy handlers reached the kernel with a malformed op
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
        let shape = super::tool_spec(tool).unwrap();
        let tail = crate::arguments::arguments_hint(tool, &shape.input_schema);
        assert_eq!(
            out["message"],
            format!("`{arg}` must name at least one block ({tail})"),
            "{tool}"
        );
        assert_eq!(out["data"]["hint"], "arguments");
        let before = footprint(&p.sugar);
        let old = outcome(p.legacy.call_legacy(tool, &Json::Object(args)));
        if tool == "blocks_check" {
            assert_eq!(
                old["committed"], true,
                "the legacy no-op reported success: {old}"
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
        "`blocks` must name at least one block (blocks_remove takes blocks, dry_run?, repo?)"
    );
    assert_eq!(
        outcome(p.sugar.call_result("blocks_check", &json!({ "ids": [] })))["message"],
        "`ids` must name at least one block (blocks_check takes checked?, dry_run?, ids, repo?)"
    );
}

/// The adapter never leaks the planner's `effect_index`, and a sugar dry
/// run consumes the ids the real run would mint (`spec/surface` §9).
#[test]
fn dry_runs_consume_the_ids_the_commit_would_mint() {
    let Some(mut p) = Pair::new() else {
        return;
    };
    let next = p.sugar.store_mut().mint("b").unwrap();
    let n: usize = next.trim_start_matches("b_").parse().unwrap();
    let dry = outcome(p.sugar.call_result(
        "blocks_insert",
        &json!({ "to": NOTES, "markdown": "One.\n\nTwo.\n", "dry_run": true }),
    ));
    assert_eq!(
        dry["results"][0]["ids"],
        json!([format!("b_{}", n + 1), format!("b_{}", n + 2)]),
        "{dry}"
    );
    assert_eq!(dry["committed"], false);
    assert!(dry["diffs"][format!("/{NOTES}")].is_object(), "{dry}");
    let wet = outcome(p.sugar.call_result(
        "blocks_insert",
        &json!({ "to": NOTES, "markdown": "Three.\n" }),
    ));
    assert_eq!(wet["results"][0]["ids"], json!([format!("b_{}", n + 3)]));
    assert!(wet.get("diffs").is_none(), "no diffs on a commit: {wet}");
    assert_eq!(wet["committed"], true);
}

// ---- batch 2: the document operations -------------------------------------------------

/// The four document operations both ways: committed and dry runs of
/// `docs_create`, `docs_set_meta`, `docs_delete` and `docs_move` (with and
/// without `retarget_inbound`, a self-linking source, frontmatter-only
/// inbound relations), their own pre-check errors (`path_taken` for a live
/// document and for a stray file, `doc_missing`) and the id sequence after
/// each. `docs_set_meta`'s committed runs compare under the pinned identity
/// difference; everything else must be identical.
#[test]
#[allow(clippy::too_many_lines)]
fn effect_driven_document_operations_match_their_legacy_handlers() {
    let Some(mut p) = Pair::new() else {
        return;
    };
    const MUTUS: &str = "texts/mutus-liber.md";
    const EMERALD: &str = "texts/emerald-tablet.md";
    const CALCINATION: &str = "processes/calcination.md";

    // docs_create: a dry run with frontmatter (the `d` burned), a rooted
    // path, a body with links (one into a missing document), an empty body,
    // a body without a trailing newline, a taken path (live document), a
    // taken path (stray file), by-the-byte the same `path_taken` data. A
    // committed create carries the pinned identity difference of mutate 3.0
    // (the retirement design §2 (a)): the planner adopts the composed file as
    // a loaded tree, so its blocks commit `inserted / 1 / api / NULL` where
    // the library's reconciling ingest wrote `inserted / NULL / NULL / m2.3`
    // — bytes, revision and commit sequence identical.
    p.ok(
        "create-dry",
        "docs_create",
        json!({ "path": "notes/dry.md", "markdown": "# Dry\n", "frontmatter": { "title": "Dry", "tags": ["a", "b"], "n": 2 }, "dry_run": true }),
    );
    p.check_with(
        "create-rooted",
        "docs_create",
        json!({ "path": "/notes/new.md", "markdown": "---\ntitle: New\n---\n# New\n\nHello.\n" }),
        true,
    );
    p.check_with(
        "create-links",
        "docs_create",
        json!({ "path": "substances/gold.md", "markdown": "# Gold\n\nThe goal. See [[mercury]], [salt](/substances/salt.md) and [lost](nope.md).\n\n- [ ] refine\n", "frontmatter": { "type": "substance", "layer": "working", "verified": false } }),
        true,
    );
    p.check_with(
        "create-empty",
        "docs_create",
        json!({ "path": "notes/empty.md", "markdown": "" }),
        false,
    );
    p.check_with(
        "create-no-newline",
        "docs_create",
        json!({ "path": "notes/tight.md", "markdown": "Just a line", "frontmatter": {} }),
        true,
    );
    p.err(
        "create-taken-doc",
        "docs_create",
        json!({ "path": "index.md", "markdown": "# Again\n" }),
        "path_taken",
    );
    p.seed_file("notes/stray.md", "# Stray\n");
    p.err(
        "create-taken-file",
        "docs_create",
        json!({ "path": "notes/stray.md", "markdown": "# Again\n" }),
        "path_taken",
    );
    p.err(
        "create-taken-file-dry",
        "docs_create",
        json!({ "path": "/notes/stray.md", "markdown": "# Again\n", "dry_run": true }),
        "path_taken",
    );

    // docs_set_meta: the dry run (identical: nothing is written), then the
    // committed patches under the pinned identity difference — set two +
    // unset one, an idempotent re-set, a key in both lists (unset wins), a
    // structured value, by id, a document without frontmatter, an unset of
    // an absent key (a normalizing rewrite); a miss. (Nothing to set or
    // unset is the pinned argument error below.)
    p.ok(
        "set-meta-dry",
        "docs_set_meta",
        json!({ "path": SALT, "set": { "verified": false, "reviewed": "2026-09" }, "unset": ["tradition"], "dry_run": true }),
    );
    p.check_with(
        "set-meta",
        "docs_set_meta",
        json!({ "path": SALT, "set": { "verified": false, "reviewed": "2026-09" }, "unset": ["tradition"] }),
        true,
    );
    p.check_with(
        "set-meta-again",
        "docs_set_meta",
        json!({ "path": SALT, "set": { "reviewed": "2026-09" } }),
        true,
    );
    p.check_with(
        "set-meta-shared-key",
        "docs_set_meta",
        json!({ "path": SALT, "set": { "status": "x", "other": 1 }, "unset": ["status"] }),
        true,
    );
    p.check_with(
        "set-meta-structured",
        "docs_set_meta",
        json!({ "id": doc_id(&p.legacy, NOTES), "set": { "meta": { "a": [1, 2.5, "three"], "b": null, "c": { "d": true } } } }),
        true,
    );
    p.check_with(
        "set-meta-no-frontmatter",
        "docs_set_meta",
        json!({ "path": "notes/new.md", "set": { "status": "open" }, "unset": ["title"] }),
        true,
    );
    p.check_with(
        "set-meta-absent-unset",
        "docs_set_meta",
        json!({ "path": EMERALD, "unset": ["nope"] }),
        true,
    );
    p.err(
        "set-meta-missing",
        "docs_set_meta",
        json!({ "path": "nope.md", "set": { "a": 1 } }),
        "doc_missing",
    );

    // docs_move: the dry runs with and without the retarget, the committed
    // move with the retarget (index.md links to Mutus Liber), a destination
    // taken by a live document and by a stray file, a miss, a document with
    // no inbound link, a committed move without the retarget (the links
    // dangle), frontmatter-only inbound relations (never rewritten), a
    // self-linking document (the library's own-path quirk), a rooted `to_path`.
    p.ok(
        "move-dry",
        "docs_move",
        json!({ "path": MUTUS, "to_path": "texts/silent-book.md", "dry_run": true }),
    );
    p.ok(
        "move-dry-no-retarget",
        "docs_move",
        json!({ "id": doc_id(&p.legacy, MUTUS), "to_path": "texts/silent-book.md", "retarget_inbound": false, "dry_run": true }),
    );
    p.ok(
        "move",
        "docs_move",
        json!({ "path": MUTUS, "to_path": "texts/silent-book.md" }),
    );
    p.err(
        "move-taken-doc",
        "docs_move",
        json!({ "path": SALT, "to_path": "/index.md" }),
        "path_taken",
    );
    p.err(
        "move-taken-file",
        "docs_move",
        json!({ "path": SALT, "to_path": "notes/stray.md" }),
        "path_taken",
    );
    p.err(
        "move-missing",
        "docs_move",
        json!({ "path": MUTUS, "to_path": "x.md" }),
        "doc_missing",
    );
    p.ok(
        "move-no-inbound",
        "docs_move",
        json!({ "path": "notes/empty.md", "to_path": "notes/void.md" }),
    );
    p.ok(
        "move-no-retarget",
        "docs_move",
        json!({ "path": SALT, "to_path": "substances/sal.md", "retarget_inbound": false }),
    );
    p.ok(
        "move-frontmatter-inbound-dry",
        "docs_move",
        json!({ "path": CALCINATION, "to_path": "processes/burning.md", "dry_run": true }),
    );
    p.ok(
        "move-frontmatter-inbound",
        "docs_move",
        json!({ "path": CALCINATION, "to_path": "processes/burning.md" }),
    );
    p.ok(
        "create-self-link",
        "docs_create",
        json!({ "path": "self/loop.md", "markdown": "# Loop\n\nSee [me](loop.md) and [me too](/self/loop.md) and [gold](../substances/gold.md).\n" }),
    );
    p.ok(
        "move-self-link-dry",
        "docs_move",
        json!({ "path": "self/loop.md", "to_path": "self/ring.md", "dry_run": true }),
    );
    p.ok(
        "move-self-link",
        "docs_move",
        json!({ "path": "self/loop.md", "to_path": "/self/ring.md" }),
    );

    // docs_delete: the dry run, the commit (the inbound links now dangle), a
    // repeat (a miss), by id, a document with a pending retarget history.
    p.ok(
        "delete-dry",
        "docs_delete",
        json!({ "path": EMERALD, "dry_run": true }),
    );
    p.ok("delete", "docs_delete", json!({ "path": EMERALD }));
    p.err(
        "delete-again",
        "docs_delete",
        json!({ "path": EMERALD }),
        "doc_missing",
    );
    p.ok(
        "delete-by-id",
        "docs_delete",
        json!({ "id": doc_id(&p.legacy, "substances/gold.md") }),
    );
    p.ok(
        "delete-moved",
        "docs_delete",
        json!({ "path": "texts/silent-book.md" }),
    );
    // A create at a deleted document's path is allowed again, and lands.
    p.ok(
        "create-after-delete",
        "docs_create",
        json!({ "path": EMERALD, "markdown": "# Emerald, again\n" }),
    );
}

/// `docs_set_meta` with nothing to set or unset: the library path rewrote the
/// file through the YAML emitter anyway — a normalizing no-op `api` commit
/// (`set_meta <path>`), or on a dry run a `diffs` entry — where the planner
/// has no effect to plan. Pinned (3.3, both engines) as an argument error.
#[test]
fn docs_set_meta_with_nothing_to_do_is_an_argument_error() {
    let Some(mut p) = Pair::new() else {
        return;
    };
    let before = footprint(&p.sugar);
    for args in [
        json!({ "path": SALT, "set": {}, "unset": [] }),
        json!({ "path": SALT }),
        json!({ "path": SALT, "set": {}, "dry_run": true }),
    ] {
        let out = outcome(p.sugar.call_result("docs_set_meta", &args));
        assert_eq!(out["error"], "filter_invalid", "{out}");
        assert_eq!(
            out["message"],
            "pass `set` and/or `unset` (docs_set_meta takes dry_run?, id?, path?, repo?, set?, unset?)",
            "{out}"
        );
    }
    assert_eq!(footprint(&p.sugar), before, "nothing written");
    // The legacy handler committed a (normalizing) rewrite instead.
    let legacy = outcome(p.legacy.call_legacy(
        "docs_set_meta",
        &json!({ "path": SALT, "set": {}, "unset": [] }),
    ));
    assert_eq!(legacy["committed"], true, "{legacy}");
}

/// A `docs_create` dry run burns the `d` the commit would take (`spec/surface`
/// §9, `spec/cli` `docs::new-dry-run-json` pins `d_20`), and no planner key
/// leaks into the result.
#[test]
fn docs_create_dry_run_consumes_the_document_id() {
    let Some(mut p) = Pair::new() else {
        return;
    };
    let next = p.sugar.store_mut().mint("d").unwrap();
    let n: usize = next.trim_start_matches("d_").parse().unwrap();
    let dry = outcome(p.sugar.call_result(
        "docs_create",
        &json!({ "path": "notes/dry.md", "markdown": "# Dry\n", "dry_run": true }),
    ));
    assert_eq!(
        dry,
        json!({ "id": format!("d_{}", n + 1), "path": "/notes/dry.md", "committed": false, "diffs": { "/notes/dry.md": { "before": "", "after": "# Dry\n" } } })
    );
    let wet = outcome(p.sugar.call_result(
        "docs_create",
        &json!({ "path": "notes/dry.md", "markdown": "# Dry\n" }),
    ));
    assert_eq!(
        wet,
        json!({ "id": format!("d_{}", n + 2), "path": "/notes/dry.md", "committed": true })
    );
    let taken = outcome(p.sugar.call_result(
        "docs_create",
        &json!({ "path": "notes/dry.md", "markdown": "x" }),
    ));
    assert_eq!(taken["error"], "path_taken");
    assert_eq!(taken["data"], json!({}), "{taken}");
    assert_eq!(taken["message"], "document already exists at notes/dry.md");
}

/// Surface 4.0: `docs_update` is sugar for `set { document, field: "content" }`
/// and answers with the Receipt. Its footprint equals the retired legacy
/// path's — `plan_update` + the kernel `apply` of the opset's ops with its
/// frontmatter override — exactly: both are known-id ingests, so the
/// dispositions agree (unlike `docs_set_meta`'s and `docs_create`'s relabel);
/// the one difference is the intent record (`commits.ops`), outside the
/// footprint. A content already current is a plan with nothing to do: no
/// commit, no revision, the store untouched.
#[test]
fn docs_update_is_set_content_sugar_with_the_legacy_footprint() {
    let Some(files) = corpus() else {
        return;
    };
    let mut legacy = surface(&files);
    let mut sugar = surface(&files);
    const MUTUS: &str = "texts/mutus-liber.md";
    let content = "---\ntype: text\nlayer: draft\ntradition: western\nera: 1677\ntags: [text, images]\nverified: false\n---\n\n# Mutus Liber\n\nOnly this, and a [link](/substances/salt.md).\n\n- [x] Obtain a facsimile with plate numbering\n";
    // The legacy path, by hand (the deleted `apply_opset`): plan, then the
    // kernel ops with the opset's frontmatter as `set_frontmatter`.
    let repo = legacy.default_repo.clone();
    let opset = legacy
        .store_mut()
        .plan_update(&repo, MUTUS, content, &Config::default())
        .unwrap();
    assert!(opset.converges);
    let req = omgbase_store::ApplyRequest {
        repo_id: repo.clone(),
        ops: opset.kernel_ops(),
        origin: omgbase_store::ApplyOrigin::new("agent:test", Some("interop")),
        dry_run: false,
        set_frontmatter: match &opset.frontmatter {
            Some(raw) => vec![omgbase_store::SetFrontmatter {
                doc: opset.target_doc.clone(),
                raw: raw.clone(),
            }],
            None => Vec::new(),
        },
    };
    let WriteTarget::Fixed(ds) = &mut legacy.writes else {
        panic!("fixed doc store")
    };
    let legacy_result = legacy
        .store
        .apply(&req, ds.as_mut(), CLOCK)
        .expect("the legacy apply");
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
    // The legacy `plan_update` minted its reconcile's and dry runs' ids under
    // the production minter (3.x: a plan burned ids); the planner runs it
    // under a throwaway symbol table, so the new blocks' ids differ by
    // offset — everything else, and every disposition's labels, agree.
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

    // `dry_run` is no longer an argument; a miss is the locator's `doc_missing`.
    let dry = outcome(sugar.call_result(
        "docs_update",
        &json!({ "path": MUTUS, "content": content, "dry_run": true }),
    ));
    assert_eq!(dry["error"], "filter_invalid", "{dry}");
    let missing = outcome(sugar.call_result(
        "docs_update",
        &json!({ "path": "nope.md", "content": "# x\n" }),
    ));
    assert_eq!(missing["error"], "doc_missing");
    assert_eq!(missing["data"], json!({ "path": "nope.md" }));
    // The identity decision is the plan's `preview.identity`.
    let plan = outcome(sugar.call_result(
        "plan",
        &json!({ "effects": [{ "op": "set", "target": { "kind": "document", "path": MUTUS }, "field": "content", "value": "# Mutus Liber\n\nOnly this.\n" }] }),
    ));
    let identity = &plan["preview"]["identity"]["d_17"];
    assert_eq!(identity["matcher_v"], json!(opset.matcher_v));
    assert_eq!(identity["summary"]["preserved"], json!(1));
    assert_eq!(identity["ops"][0]["op_index"], json!(0));
    assert!(identity["ops"][0].get("disposition").is_some());
}
