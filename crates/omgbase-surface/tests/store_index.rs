//! The store-backed indexes behind `StoreContext::index_for` (`store_index`):
//! a nested block over a root scan with a correlated or constant equality is
//! answered by ONE indexed statement per probe and the root is never read
//! whole. `tests/conformance.rs` proves the results do not change; this file
//! proves the WORK changed — how many root scans ran, that typed equality and
//! the absent fallback hold — and that the correlated shape stays fast at a
//! couple of thousand documents. Port of
//! `packages/core/src/oqx-js/store-index.test.ts`.

#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use omgbase_reconcile::Config;
use omgbase_store::{BatchItem, SequentialMinter, Store};
use omgbase_surface::context::scan_of;
use omgbase_surface::store_index::indexable_paths;
use omgbase_surface::{StoreContext, Target, rewrite_query};
use oqx::{DataContext, Engine, InMemoryEngine, Value};

const CORPUS_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/core/corpus/oqx/fixtures/alchemy"
);
const TS: &str = "2026-09-27T00:00:00.000Z";

fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, String)>) {
    for entry in fs::read_dir(dir).expect("corpus dir") {
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

fn store_of(files: &[(String, String)]) -> (Store, String) {
    let mut store =
        Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).expect("store");
    let repo = store.create_repo("r").expect("repo");
    let items: Vec<BatchItem> = files
        .iter()
        .map(|(p, s)| BatchItem::observed(p, s))
        .collect();
    store
        .observe_batch(&repo, &items, TS, &Config::default())
        .expect("observed");
    (store, repo)
}

fn alchemy() -> Option<(Store, String)> {
    let dir = PathBuf::from(CORPUS_DIR);
    if !dir.is_dir() {
        eprintln!("store_index: corpus not present at {CORPUS_DIR}; skipping");
        return None;
    }
    let mut files = Vec::new();
    walk(&dir, &dir, &mut files);
    files.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    Some(store_of(&files))
}

/// Run `q` on the in-memory engine over a fresh context; the result's value,
/// the root scans the context ran, and the naive engine's value.
fn run(store: &Store, repo: &str, q: &str) -> (Value, usize, Value) {
    let parsed = rewrite_query(&oqx::parse_string(q).expect("parses"));
    let engine = InMemoryEngine::new(StoreContext::new(store.conn(), repo, HashMap::new()));
    let out = engine.run(&parsed, &[]).expect("runs").into_value();
    let scans = engine.context().scans_run();
    let naive = InMemoryEngine::new(StoreContext::new(store.conn(), repo, HashMap::new()))
        .with_rules(&[])
        .run(&parsed, &[])
        .expect("runs")
        .into_value();
    (out, scans, naive)
}

fn paths(ctx: &StoreContext<'_>, rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|r| ctx.get(r, "$path").unwrap().to_string())
        .collect()
}

#[test]
fn index_for_answers_for_a_root_scan_marker_on_an_indexable_path_and_for_nothing_else() {
    let Some((store, repo)) = alchemy() else {
        return;
    };
    let ctx = StoreContext::new(store.conn(), &repo, HashMap::new());
    let repo_root = ctx.root("$repo");
    let docs = ctx.get(&repo_root, "docs").unwrap();
    assert_eq!(
        scan_of(&docs),
        Some(Target::Docs),
        "a lazy marker, not the rows"
    );
    assert_eq!(ctx.scans_run(), 0);
    let p = |k: &str| vec![k.to_owned()];
    assert!(ctx.index_for(&docs, &p("$path")).is_some());
    assert!(ctx.index_for(&docs, &p("$id")).is_some());
    assert!(ctx.index_for(&docs, &p("type")).is_some()); // a property
    assert!(ctx.index_for(&docs, &p("$title")).is_some()); // the computed scalar
    assert!(ctx.index_for(&docs, &p("format")).is_none()); // a column without an index
    assert!(ctx.index_for(&docs, &p("$tags")).is_none()); // list-valued
    assert!(ctx.index_for(&docs, &p("out")).is_none()); // a relation
    assert!(ctx.index_for(&docs, &p("path")).is_none()); // reserved: the scan raises
    assert!(
        ctx.index_for(&docs, &["meta".to_owned(), "id".to_owned()])
            .is_none()
    ); // multi-segment
    assert!(ctx.index_for(&ctx.root("edges"), &p("$dst")).is_some()); // a bare root
    assert!(
        ctx.index_for(&ctx.get(&repo_root, "edges").unwrap(), &p("predicate"))
            .is_none()
    ); // no leading index
    assert!(
        ctx.index_for(&ctx.get(&repo_root, "blocks").unwrap(), &p("$doc"))
            .is_some()
    );
    assert!(
        ctx.index_for(&ctx.get(&repo_root, "nodes").unwrap(), &p("name"))
            .is_some()
    );
    // a relation's rows are an ordinary array: the engine indexes those itself
    let rows = ctx.to_rows(&docs);
    assert_eq!(ctx.scans_run(), 1);
    let out = ctx.get(&rows[0], "out").unwrap();
    assert!(ctx.index_for(&out, &p("$path")).is_none());
    assert_eq!(
        indexable_paths(Target::Edges),
        ["$id", "$src", "$dst", "$path", "$dst_path"]
    );
    // the scan is read once per run
    let _ = ctx.to_rows(&docs);
    assert_eq!(ctx.scans_run(), 1);
}

#[test]
fn a_correlated_block_over_repo_docs_probes_sqlite_and_never_runs_the_docs_scan() {
    let Some((store, repo)) = alchemy() else {
        return;
    };
    let q = "select $path, same_type: $repo.docs collect { $path values where type == ^type && $path != ^$path } from docs";
    let (out, scans, naive) = run(&store, &repo, q);
    assert_eq!(out, naive);
    let rows = out.as_array().unwrap();
    assert!(rows.len() > 10);
    // the top-level `from docs` scanned docs ONCE; the nested `$repo.docs` never did
    assert_eq!(scans, 1);
    // substances see the other four substances, in (path, id) order
    let salt = rows
        .iter()
        .find(|r| {
            r.as_object().unwrap().get("$path") == Some(&Value::Str("substances/salt.md".into()))
        })
        .unwrap();
    assert_eq!(
        salt.as_object().unwrap().get("same_type"),
        Some(&Value::Array(
            [
                "substances/mercury.md",
                "substances/philosophers-stone.md",
                "substances/prima-materia.md",
                "substances/sulphur.md"
            ]
            .into_iter()
            .map(|s| Value::Str(s.into()))
            .collect()
        ))
    );
}

#[test]
fn the_other_targets_are_probed_from_their_indexes() {
    let Some((store, repo)) = alchemy() else {
        return;
    };
    for q in [
        "select $path, inbound: $repo.edges collect { $src values where $dst == ^$id } from docs",
        "select $id, paragraphs: $repo.blocks collect { $ordinal values where $doc == ^$doc && type == \"paragraph\" } from blocks where type == \"heading\"",
        "select name, same_kind: $repo.nodes collect { name values where kind == ^kind && $doc_id == ^$doc_id } from nodes where kind == \"md:section\"",
        "select $path, outbound: $repo.edges collect { $dst_path values where $path == ^$path } from docs",
    ] {
        let (out, scans, naive) = run(&store, &repo, q);
        assert_eq!(out, naive, "{q}");
        assert_eq!(scans, 1, "{q}: the top-level source only");
    }
}

#[test]
fn typed_equality_per_value_kind_and_the_absent_fallback() {
    let Some((store, repo)) = alchemy() else {
        return;
    };
    let ctx = StoreContext::new(store.conn(), &repo, HashMap::new());
    let docs = ctx.get(&ctx.root("$repo"), "docs").unwrap();
    let era = ctx.index_for(&docs, &["era".to_owned()]).unwrap();
    let rows = |v: Value| era.lookup_rows(&v).unwrap().unwrap();
    assert_eq!(
        paths(&ctx, &rows(Value::Number(800.0))),
        [
            "practitioners/jabir-ibn-hayyan.md",
            "texts/emerald-tablet.md"
        ]
    );
    assert!(rows(Value::Number(-0.0)).is_empty());
    assert!(rows(Value::Str("800".into())).is_empty()); // §5: a string never equals a number
    assert!(rows(Value::Number(f64::NAN)).is_empty());
    assert!(rows(Value::Bool(true)).is_empty());
    assert_eq!(ctx.scans_run(), 0, "every probe above was a statement");
    let ty = ctx.index_for(&docs, &["type".to_owned()]).unwrap();
    assert_eq!(
        paths(
            &ctx,
            &ty.lookup_rows(&Value::Str("text".into())).unwrap().unwrap()
        ),
        ["texts/emerald-tablet.md", "texts/mutus-liber.md"]
    );
    assert!(
        ty.lookup_rows(&Value::Number(1.0))
            .unwrap()
            .unwrap()
            .is_empty()
    );
    // a column probe: only strings
    let path = ctx.index_for(&docs, &["$path".to_owned()]).unwrap();
    assert_eq!(
        paths(
            &ctx,
            &path
                .lookup_rows(&Value::Str("index.md".into()))
                .unwrap()
                .unwrap()
        ),
        ["index.md"]
    );
    assert!(
        path.lookup_rows(&Value::Number(5.0))
            .unwrap()
            .unwrap()
            .is_empty()
    );
    assert_eq!(ctx.scans_run(), 0);
    // the absent probe is the fallback: the documents LACKING the key (and null scalars), one scan
    let all = ctx.to_rows(&docs);
    let lacking: Vec<String> = all
        .iter()
        .filter(|r| ctx.get(r, "era").unwrap().is_absent())
        .map(|r| ctx.get(r, "$path").unwrap().to_string())
        .collect();
    assert!(lacking.len() > 5);
    assert_eq!(paths(&ctx, &rows(Value::Null)), lacking);
    assert_eq!(paths(&ctx, &rows(Value::Undefined)), lacking);
    assert_eq!(ctx.scans_run(), 1, "read once, reused");
    // `lookup` (positions) agrees with `lookup_rows`
    let pos: Vec<String> = era
        .lookup(&Value::Number(800.0))
        .into_iter()
        .map(|i| ctx.get(&all[i], "$path").unwrap().to_string())
        .collect();
    assert_eq!(pos, paths(&ctx, &rows(Value::Number(800.0))));
    assert!(ty.lookup(&Value::Str("nope".into())).is_empty());
}

#[test]
fn a_scan_projected_as_a_value_renders_as_its_rows() {
    let Some((store, repo)) = alchemy() else {
        return;
    };
    let res = omgbase_surface::query(
        &store,
        &repo,
        "select n: size($repo.docs), all: $repo.docs from docs where $path == \"index.md\"",
        omgbase_surface::QueryOptions {
            limit: Some(10),
            cursor: None,
            provider: None,
            in_memory: true,
        },
    )
    .expect("runs");
    let hit = &res.hits[0];
    let all = hit["all"].as_array().expect("an array of rows");
    assert_eq!(hit["n"].as_f64(), Some(all.len() as f64));
    assert!(all.len() > 10);
    assert!(all[0].get("path").is_some(), "rendered as {{ id, path }}");
}

#[test]
fn perf_a_correlated_block_over_two_thousand_documents_runs_no_scan_and_stays_fast() {
    let n = 2000;
    let files: Vec<(String, String)> = (0..n)
        .map(|i| {
            if i % 10 == 0 {
                (
                    format!("customers/c{i}.md"),
                    format!("---\ntype: customer\nname: Customer {i}\n---\n\n# Customer {i}\n"),
                )
            } else {
                (
                    format!("orders/o{i}.md"),
                    format!(
                        "---\ntype: order\ncustomer: customers/c{}.md\nseq: {i}\n---\n\n# Order {i}\n",
                        i - (i % 10)
                    ),
                )
            }
        })
        .collect();
    let (store, repo) = store_of(&files);
    let q = "select name, orders: $repo.docs collect { $path where type == \"order\" && customer == ^$path } from docs where type == \"customer\"";
    let parsed = rewrite_query(&oqx::parse_string(q).expect("parses"));
    let t0 = Instant::now();
    let engine = InMemoryEngine::new(StoreContext::new(store.conn(), &repo, HashMap::new()));
    let out = engine.run(&parsed, &[]).expect("runs").into_value();
    let ms = t0.elapsed().as_millis();
    let rows = out.as_array().unwrap();
    assert_eq!(rows.len(), n / 10);
    assert_eq!(
        rows[0]
            .as_object()
            .unwrap()
            .get("orders")
            .and_then(Value::as_array)
            .map(<[Value]>::len),
        Some(9)
    );
    assert_eq!(
        engine.context().scans_run(),
        1,
        "the top-level `from docs` only"
    );
    eprintln!(
        "correlated probe over {n} docs: {ms} ms ({} probes)",
        rows.len()
    );
    assert!(ms < 5000, "{ms} ms");
}
