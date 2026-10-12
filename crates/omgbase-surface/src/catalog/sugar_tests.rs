//! ADR-021, the migration phase: the twelve batch-1 sugar tools now lower to
//! `apply { effects }` ([`Surface::apply_sugar`]) and must be
//! **behaviour-preserving**. Every scenario here runs the same call twice —
//! through the pre-migration handler ([`Surface::call_legacy`], the kernel
//! ops + [`Surface::apply_ops`], kept verbatim for this comparison) on one
//! surface and through the effect-driven handler on another, both over the
//! alchemy corpus under the sequential minter and one clock — and requires:
//! the result JSON deep-equal (errors included: code, message, `data`), the
//! store projection identical (`commits` minus `ops`, `docs`, live `blocks`,
//! `revisions`, `block_changes`, the pool, the pending rows, the files), and
//! the next `b` the two stores mint identical (a dry run burns the same
//! ids). The two deliberate fixes the design pins — `blocks_update` with an
//! empty `expect` on `markdown`, `blocks_check` naming one id twice — are
//! asserted as differences, not equalities.

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
        "pool": rows("SELECT block_id, doc_id FROM resurrection_pool ORDER BY block_id"),
        "pending": rows("SELECT path FROM pending_materializations ORDER BY path"),
        "files": files,
    })
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
}

impl Pair {
    fn new() -> Option<Self> {
        let files = corpus()?;
        Some(Self {
            legacy: surface(&files),
            sugar: surface(&files),
        })
    }

    /// Run one call both ways; every observable must agree.
    fn check(&mut self, label: &str, tool: &str, args: Json) -> Json {
        let old = outcome(self.legacy.call_legacy(tool, &args));
        let new = outcome(self.sugar.call_result(tool, &args));
        assert_eq!(
            new, old,
            "[{label}] {tool} {args}: the effect-driven result differs from the legacy result"
        );
        assert_eq!(
            footprint(&self.sugar),
            footprint(&self.legacy),
            "[{label}] {tool} {args}: the store projections differ"
        );
        let next_old = self.legacy.store_mut().mint("b").unwrap();
        let next_new = self.sugar.store_mut().mint("b").unwrap();
        assert_eq!(
            next_new, next_old,
            "[{label}] {tool} {args}: the minted-id sequence diverged"
        );
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
