//! Differential conformance: every query must return the SAME result whether
//! run through the tier-3 SQLite pushdown planner or the pure in-memory
//! engine. Port of `packages/core/corpus/oqx/conformance.test.ts` over the
//! same alchemy corpus (`packages/core/corpus/oqx/fixtures/alchemy`, read
//! from disk; it is also every `query-*.json` suite's `corpus`). This is the
//! guardrail that lets the planner push work into SQL — any divergence (a
//! mistranslated predicate, a params-order bug) fails here.
//!
//! Each query also carries the reference planner's decision — planned or
//! declined — so the pushability table is pinned too: a planner that always
//! declined would agree with itself trivially.

// The error envelope is ~128 bytes; every failure here is a cold path.
#![allow(clippy::result_large_err)]

use std::fs;
use std::path::{Path, PathBuf};

use omgbase_reconcile::Config;
use omgbase_store::{BatchItem, SequentialMinter, Store};
use omgbase_surface::planner::compile;
use omgbase_surface::{OqxResult, QueryOptions, SurfaceError, query, rewrite_query};

const CORPUS_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/core/corpus/oqx/fixtures/alchemy"
);
const CORPUS_TS: &str = "2026-09-27T00:00:00.000Z";

/// The reference planner's verdict for a query.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Push {
    /// At least one top-level conjunct is pushed to SQL.
    Planned,
    /// Declined wholesale: the engine does everything in memory.
    Declined,
}
use Push::{Declined, Planned};

/// Queries spanning the surface: pushable scalar leaves (`_path ==` /
/// `startsWith`, bare properties, columns, flattened attrs), non-pushable
/// (ranges, negation, nested ops, `follow`), every consumer, order by,
/// distinct, correlation, and each target. Each must agree planned vs
/// in-memory; the verdict is the reference's (`translate.ts`).
const QUERIES: &[(&str, Push)] = &[
    // pushable path predicates (the planner reduces the scan in SQL)
    ("from docs where _path == \"index.md\"", Planned),
    ("from docs where _path.startsWith(\"substances/\")", Planned),
    (
        "from docs where _path.startsWith(\"substances/\") && _path.endsWith(\"mercury.md\")",
        Planned,
    ),
    ("from docs where _path != \"index.md\"", Planned),
    ("from blocks where _path.startsWith(\"lab/\")", Planned),
    ("from nodes where _path.startsWith(\"processes/\")", Planned),
    ("from links where _path.startsWith(\"index\")", Planned),
    // pushable composed with a non-pushable residual (mixed); a call in the
    // residual could raise, so the whole query declines (surface 1.1 patch)
    (
        "from docs where _path.startsWith(\"substances/\") && \"substance\" in list(_tags)",
        Declined,
    ),
    (
        "from docs where _path.startsWith(\"processes/\") && _nodes exists { where _kind == \"md:task\" }",
        Planned,
    ),
    // bare document properties push via the properties table; a number
    // against a property read pushes typed (`p.type = 'number'` tested
    // first, surface 1.2 patch)
    ("from docs where type == \"substance\"", Planned),
    ("from docs where layer == \"canon\"", Planned),
    ("from docs where era < 1000", Planned),
    // range membership (declined → in-memory both ways, must agree)
    ("from docs where era in 800..1680", Declined),
    ("from docs where era in 800...1680", Declined),
    ("from docs where era in 1600..", Declined),
    ("from docs where era in ..300", Declined),
    // mixed: type pushed to SQL, range left residual
    (
        "from docs where era in 1600..1700 && type == \"practitioner\"",
        Planned,
    ),
    // range-VALUED frontmatter (window: ISO-date range, stage_range: numeric range)
    ("from docs where \"2026-01-15\" in range(window)", Declined),
    ("from docs where 2 in range(stage_range)", Declined),
    // a bare range-valued prop is a plain string → pushable, agrees
    (
        "from docs where window == \"2026-01-01..2026-01-31\"",
        Planned,
    ),
    ("from docs where stage_range == \"1..4\"", Planned),
    ("from docs where !verified", Declined),
    (
        "from docs where _nodes exists { where _kind == \"md:task\" && !_attrs.checked }",
        Declined,
    ),
    (
        "from blocks where _type == \"task\" && _doc.type == \"lab-note\"",
        Planned,
    ),
    ("from nodes where _kind == \"md:section\"", Planned),
    // a docs COLUMN, not a property
    ("from docs where _format == \"markdown\"", Planned),
    // boolean param → 1/0
    (
        "from nodes where _kind == \"md:task\" && _attrs.checked == true",
        Planned,
    ),
    (
        "from nodes where _kind == \"md:task\" && _attrs.checked == false",
        Planned,
    ),
    // flattened attrs: a bare identifier reads attrs.<key> on nodes/blocks;
    // planned (json_extract) must equal in-memory
    (
        "from nodes where _kind == \"md:task\" && checked == true",
        Planned,
    ),
    (
        "from nodes where _kind == \"md:task\" && checked == false",
        Planned,
    ),
    ("from nodes where _kind == \"md:task\" && !checked", Planned),
    (
        "from blocks where _type == \"task\" && checked == false",
        Planned,
    ),
    (
        "from nodes where _kind == \"md:section\" && level == 1",
        Planned,
    ),
    (
        "from docs where _nodes exists { where _kind == \"md:task\" && !checked }",
        Declined,
    ),
    (
        "select _path, checked from nodes where _kind == \"md:task\" && checked == false",
        Planned,
    ),
    // consumers
    (
        "docs count { where _path.startsWith(\"substances/\") }",
        Planned,
    ),
    ("docs exists { where _path == \"index.md\" }", Planned),
    (
        "docs first { where type == \"practitioner\" order by era desc }",
        Planned,
    ),
    (
        "select _path, layer from docs where type == \"substance\"",
        Planned,
    ),
    // order by + pagination surface
    (
        "from docs where type == \"practitioner\" order by era asc",
        Planned,
    ),
    ("from docs order by _path", Declined),
    // distinct
    ("select distinct type from docs", Declined),
    (
        "select k: _nodes collect distinct { select _kind } from docs where _path == \"processes/magnum-opus.md\"",
        Planned,
    ),
    (
        "from docs where _nodes count distinct { select _kind } == 3",
        Declined,
    ),
    // values / $it (top-level values is shaped by the runner; nested by the engine)
    (
        "select era values from docs where type == \"practitioner\" order by era asc",
        Planned,
    ),
    ("select distinct type values from docs", Declined),
    (
        "docs first { select _path values where type == \"practitioner\" order by era desc }",
        Planned,
    ),
    (
        "select tags: _tags collect { $it values where $it != \"substance\" } from docs where type == \"substance\"",
        Planned,
    ),
    (
        "from docs where _tags exists { where $it == \"tria-prima\" }",
        Declined,
    ),
    // none / limit / offset (top-level bounds are applied by the runner, nested by the engine)
    (
        "from docs where type == \"substance\" && _nodes none { where _kind == \"md:task\" }",
        Planned,
    ),
    ("docs none { where type == \"nope\" }", Planned),
    (
        "from docs where type == \"practitioner\" order by era desc limit 2",
        Planned,
    ),
    (
        "from docs where type == \"practitioner\" order by era desc limit 2 offset 1",
        Planned,
    ),
    ("select distinct type values from docs limit 2", Declined),
    (
        "from docs where _nodes exists { where _kind == \"md:task\" offset 3 }",
        Declined,
    ),
    (
        "docs first { select _path values where type == \"practitioner\" order by era asc offset 1 }",
        Planned,
    ),
    // entries() / $key (a free call → residual; the context materializes frontmatter/inline)
    (
        "select fm: entries(_frontmatter) collect { k: $key, v: $it } from docs where _path == \"substances/salt.md\"",
        Planned,
    ),
    (
        "from docs where entries(_frontmatter) exists { where $key == \"era\" && $it > 1600 }",
        Declined,
    ),
    (
        "select ks: entries(_inline) collect { $key values } from docs where entries(_inline) exists { }",
        Declined,
    ),
    // (a call in the residual block's receiver: the whole query declines)
    (
        "select _path from nodes where _kind == \"md:task\" && entries(_attrs) exists { where $key == \"checked\" && $it }",
        Declined,
    ),
    (
        "select h: _nodes collect { select _name values where _kind == \"md:section\" order by first_ordinal limit 2 } from docs where _path == \"processes/magnum-opus.md\"",
        Planned,
    ),
    // follow (planner declines → in-memory both ways, still must agree)
    (
        "from docs where _path == \"substances/philosophers-stone.md\" follow distinct _out_links collect { from _dst }",
        Declined,
    ),
    (
        "select n: _name, d: $depth from nodes where _kind == \"md:section\" && _name == \"The magnum opus\" follow $it._children",
        Declined,
    ),
    // correlation / lifts
    // (a `^`-escaped name in the residual block: the whole query declines)
    (
        "select slug from docs where type == \"substance\" && ^nodes exists { where _kind == \"md:wikilink\" && _value == ^slug }",
        Declined,
    ),
    (
        "select _path, open from docs where _nodes collect { ^open: _value where _kind == \"md:task\" && !_attrs.checked }",
        Declined,
    ),
    // links target
    (
        "select _doc_id, _dst_path from links where _predicate == \"references\"",
        Planned,
    ),
    // row functions rewrite to `$it.fn(…)`, which the translator declines;
    // a pushable sibling still plans
    ("from blocks where text(\"mercury\")", Declined),
    // (a row function in the residual: the whole query declines)
    (
        "from blocks where type == \"heading\" && within(\"lab/*\")",
        Declined,
    ),
    // `||` at the top is the whole residual; `.lower()` pushes explicitly
    (
        "from docs where _path == \"index.md\" || layer == \"canon\"",
        Declined,
    ),
    (
        "from docs where _path.lower().startsWith(\"SUBSTANCES/\".lower())",
        Planned,
    ),
    ("from docs where _path.matches(\"^lab/\")", Declined),
    ("from docs where _hash != null", Planned),
    ("from docs where _updated_at >= \"2026-01-01\"", Planned),
    // nested blocks over a ROOT SCAN with a correlated / constant equality: the
    // store answers these from SQLite indexes (`store_index`) instead of
    // materializing `^<target>` — results must not move an inch
    (
        "select _path, cited: ^docs collect { _path where _out_links exists { where _dst_path == ^^_path } } from docs",
        Declined,
    ),
    (
        "select name, orders: ^docs collect { _path where type == \"order\" && customer == ^_path } from docs where type == \"customer\"",
        Planned,
    ),
    (
        "from docs where _path == \"index.md\" follow _out_links collect { from _dst }, ^docs collect { where after.contains(^_path) }",
        Declined,
    ),
    (
        "select _path, same_type: ^docs collect { _path where type == ^type && _path != ^_path } from docs",
        Declined,
    ),
    (
        "select _path, same_era: ^docs collect { _path where era == ^era } from docs where type == \"practitioner\"",
        Planned,
    ),
    (
        "select _path, same_layer: ^docs collect { _path values where layer == ^layer } from docs",
        Declined,
    ),
    (
        "from docs where ^docs count { where layer == ^layer } > 3",
        Declined,
    ),
    (
        "from docs where ^docs exists { where _title == ^_title && _id != ^_id }",
        Declined,
    ),
    (
        "select _path, by_title: ^docs collect { _path values where _title == ^_title } from docs where type == \"process\"",
        Planned,
    ),
    (
        "select _path, self: ^docs first { _path values where _path == ^_path } from docs",
        Declined,
    ),
    (
        "select _path, by_id: ^docs single { _path values where _id == ^_id } from docs where type == \"substance\"",
        Planned,
    ),
    // mixed value kinds on one property: a number probe against a string
    // property (and the reverse) matches nothing; an absent probe matches the
    // documents lacking the key (the in-memory fallback)
    (
        "select _path, s: ^docs collect { _path where slug == ^era } from docs where type == \"practitioner\"",
        Planned,
    ),
    (
        "select _path, e: ^docs collect { _path where era == ^slug } from docs where type == \"substance\"",
        Planned,
    ),
    (
        "from docs where ^docs none { where era == ^type }",
        Declined,
    ),
    (
        "select _path, no_era: ^docs collect { _path values where era == ^nope } from docs where _path == \"index.md\"",
        Planned,
    ),
    (
        "select _path, no_slug: ^docs collect { _path where slug == null } from docs where type == \"text\"",
        Planned,
    ),
    (
        "select _path, l: ^docs collect { _path values where _tags == ^_tags } from docs",
        Declined,
    ),
    (
        "select _path, l: ^docs collect { _path values where layer == ^_tags } from docs",
        Declined,
    ),
    // the other targets as receivers: an edges-target correlated block, blocks by doc_id, nodes by kind
    (
        "select _path, inbound: ^links collect { _doc_id where _dst_id == ^_id } from docs",
        Declined,
    ),
    (
        "select _path, outbound: ^links collect { _dst_path values where _path == ^_path } from docs",
        Declined,
    ),
    (
        "from docs where ^links count { where _path == ^_path } > 2",
        Declined,
    ),
    (
        "select _doc_id, same_dst: ^links collect { _doc_id values where _dst_path == ^_dst_path && _id != ^_id } from links where _predicate == \"references\"",
        Planned,
    ),
    (
        "select _id, paragraphs: ^blocks collect { _ordinal values where _doc_id == ^_doc_id && _type == \"paragraph\" } from blocks where _type == \"heading\"",
        Planned,
    ),
    (
        "from blocks where _type == \"heading\" && ^blocks count { where _doc_id == ^_doc_id && _type == \"paragraph\" } > 3",
        Declined,
    ),
    (
        "from nodes where _kind == \"md:section\" && ^nodes count { where _kind == ^_kind } > 10",
        Declined,
    ),
    (
        "select _name, same_kind: ^nodes collect { _name values where _kind == ^_kind && _doc_id == ^_doc_id } from nodes where _kind == \"md:section\"",
        Planned,
    ),
    (
        "select _path, by_name: ^nodes collect { _id where _name == ^_name } from nodes where _kind == \"md:section\" && _name == \"Preparation\"",
        Planned,
    ),
    (
        "select _path, nameless: ^nodes collect { _kind values where _name == ^nope } from nodes where _kind == \"md:section\" && _name == \"Preparation\"",
        Planned,
    ),
];

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

fn corpus() -> Option<Vec<(String, String)>> {
    let dir = PathBuf::from(CORPUS_DIR);
    if !dir.is_dir() {
        eprintln!("conformance: corpus not present at {CORPUS_DIR}; skipping");
        return None;
    }
    let mut files = Vec::new();
    walk(&dir, &dir, &mut files);
    files.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    assert!(
        files.len() >= 10,
        "alchemy corpus has {} files",
        files.len()
    );
    Some(files)
}

fn alchemy_store() -> Option<(Store, String)> {
    let files = corpus()?;
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
    Some((store, repo))
}

fn run(
    store: &Store,
    repo: &str,
    q: &str,
    limit: usize,
    cursor: Option<&str>,
    in_memory: bool,
) -> Result<OqxResult, SurfaceError> {
    query(
        store,
        repo,
        q,
        QueryOptions {
            limit: Some(limit),
            cursor,
            provider: None,
            in_memory,
            bare: false,
            unknown_names: None,
            vocabulary: None,
            now_ms: None,
            request: None,
        },
    )
}

fn describe(r: &Result<OqxResult, SurfaceError>) -> String {
    match r {
        Ok(res) => res.to_json().to_string(),
        Err(e) => format!("error {} {:?}", e.code, e.message),
    }
}

#[test]
fn planned_equals_in_memory_over_the_alchemy_corpus() {
    let Some((store, repo)) = alchemy_store() else {
        return;
    };
    let mut failures = Vec::new();
    for (q, push) in QUERIES {
        let planned = run(&store, &repo, q, 100, None, false);
        let memory = run(&store, &repo, q, 100, None, true);
        let agree = match (&planned, &memory) {
            (Ok(p), Ok(m)) => p == m,
            (Err(p), Err(m)) => p.code == m.code && p.message == m.message,
            _ => false,
        };
        if !agree {
            failures.push(format!(
                "{q}\n    planned:   {}\n    in-memory: {}",
                describe(&planned),
                describe(&memory)
            ));
        }
        // The reference planner's verdict, on the query as the runner sees it.
        let parsed = rewrite_query(&oqx::parse_string(q).expect("parses"), 0);
        let compiled = compile(&parsed, &[], &repo);
        let verdict = if compiled.is_some() {
            Planned
        } else {
            Declined
        };
        if verdict != *push {
            failures.push(format!(
                "{q}\n    expected {push:?}, planner said {verdict:?}{}",
                compiled.map_or(String::new(), |c| format!(": {}", c.sql))
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} conformance failure(s):\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn planned_queries_actually_reduce_the_scan() {
    let Some((store, repo)) = alchemy_store() else {
        return;
    };
    // A planned `path ==` produces exactly the matching row for the residual;
    // a full scan of docs is larger.
    let parsed = rewrite_query(
        &oqx::parse_string("from docs where _path == \"index.md\" && layer == \"canon\"").unwrap(),
        0,
    );
    let planner = omgbase_surface::SqlitePlanner::new(store.conn(), &repo);
    let plan = planner
        .try_plan(&parsed, &[])
        .expect("statement runs")
        .expect("planned");
    assert_eq!(plan.rows.len(), 1, "{:?}", plan.rows);
    assert_eq!(plan.residual.r#where, None, "both conjuncts were pushed");
    let all = run(&store, &repo, "from docs", 100, None, true).unwrap();
    assert!(all.hits.len() > 1);
    // The produced rows are tagged like a root scan's: the residual reads
    // intrinsics and relations through them.
    let res = run(
        &store,
        &repo,
        "select _title, n: _nodes collect { select _kind } from docs where _path == \"index.md\"",
        100,
        None,
        false,
    )
    .unwrap();
    assert_eq!(res.hits.len(), 1);
    assert!(res.hits[0]["_title"].is_string(), "{}", res.hits[0]);
    assert!(
        res.hits[0]["n"].as_array().is_some_and(|a| !a.is_empty()),
        "{}",
        res.hits[0]
    );
}

#[test]
fn agrees_across_a_paginated_sweep() {
    let Some((store, repo)) = alchemy_store() else {
        return;
    };
    // Walk the whole docs set in pages of 5, both ways, comparing each page.
    let (mut cur_p, mut cur_m): (Option<String>, Option<String>) = (None, None);
    for _ in 0..6 {
        let p = run(&store, &repo, "from docs", 5, cur_p.as_deref(), false).unwrap();
        let m = run(&store, &repo, "from docs", 5, cur_m.as_deref(), true).unwrap();
        assert_eq!(p, m);
        cur_p = p.cursor.clone();
        cur_m = m.cursor.clone();
        if cur_p.is_none() {
            break;
        }
    }
    // The same sweep over a planned scan (a pushed predicate that keeps most rows).
    let (mut cur_p, mut cur_m): (Option<String>, Option<String>) = (None, None);
    for _ in 0..6 {
        let q = "from docs where _path != \"index.md\"";
        let p = run(&store, &repo, q, 5, cur_p.as_deref(), false).unwrap();
        let m = run(&store, &repo, q, 5, cur_m.as_deref(), true).unwrap();
        assert_eq!(p, m);
        cur_p = p.cursor.clone();
        cur_m = m.cursor.clone();
        if cur_p.is_none() {
            break;
        }
    }
}
