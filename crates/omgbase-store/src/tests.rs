//! Store-level unit tests: the ports of the reference's `store.test.ts`,
//! `writers.test.ts`, `gc.test.ts`, `rebuild.test.ts`, `observe.test.ts`
//! and the §8 invariants on small scripts.

use std::collections::BTreeMap;

use omgbase_format::hash::{hex, sha256};
use omgbase_format::parse_markdown;
use omgbase_reconcile::Config;
use rusqlite::{Connection, params};

use crate::derived::mark_reachable;
use crate::writers::{assign_fresh_ids, write_block_tree};
use crate::*;

const T0: &str = "2026-09-26T10:00:00.000Z";
const T1: &str = "2026-09-26T10:01:00.000Z";
const T2: &str = "2026-09-26T10:02:00.000Z";

fn fixture_store() -> (Store, String) {
    let mut store = Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
    let repo = store.create_repo("fixture").unwrap();
    assert_eq!(repo, "rp_0");
    (store, repo)
}

fn count(store: &Store, table: &str) -> i64 {
    store
        .conn()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

fn observe(store: &mut Store, repo: &str, path: &str, source: &str, ts: &str) -> ObserveOutcome {
    store
        .observe_one(repo, path, source, ts, &Config::default())
        .unwrap()
}

fn kinds(o: &ObserveOutcome) -> Vec<(String, u64)> {
    o.dispositions
        .iter()
        .map(|(k, n)| (k.clone(), *n))
        .collect()
}

// ---- schema & config ------------------------------------------------------------------

#[test]
fn applies_pragmas_and_user_version() {
    let store = Store::open_in_memory().unwrap();
    let fk: i64 = store
        .conn()
        .pragma_query_value(None, "foreign_keys", |r| r.get(0))
        .unwrap();
    let sync: i64 = store
        .conn()
        .pragma_query_value(None, "synchronous", |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1);
    assert_eq!(sync, 1, "NORMAL");
    assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
    assert!(SPEC_VERSION.starts_with(&format!("{SCHEMA_VERSION}.")));
    assert!(env!("CARGO_PKG_VERSION").starts_with(&format!("{SPEC_VERSION}.")));
}

#[test]
fn creates_every_table() {
    let store = Store::open_in_memory().unwrap();
    let mut stmt = store
        .conn()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap();
    let names: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    for t in [
        "repos",
        "docs",
        "blocks",
        "blobs",
        "tree_nodes",
        "revisions",
        "commits",
        "dispositions",
        "edges",
        "external_nodes",
        "collections",
        "checkpoints",
        "resurrection_pool",
        "sections",
        "doc_edges",
        "block_changes",
        "inferred_edges",
        "embeddings",
        "doc_embeddings",
        "blocks_fts",
        "nodes",
        "nodes_fts",
        "file_stats",
        "properties",
        "adapters",
        "sources",
        "attachments",
        "sync_state",
        "workspace_settings",
    ] {
        assert!(names.contains(&t.to_owned()), "missing table {t}");
    }
    let ws: i64 = store
        .conn()
        .query_row(
            "SELECT count(*) FROM workspace_settings WHERE id = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ws, 1, "singleton settings row seeded");
}

#[test]
fn embedded_schema_equals_the_spec_file_when_present() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/store/schema.sql");
    match std::fs::read_to_string(path) {
        Ok(text) => assert_eq!(
            text, SCHEMA_SQL,
            "crates/omgbase-store/schema.sql drifted from spec/store/schema.sql"
        ),
        Err(_) => {
            eprintln!("spec/store/schema.sql not present (built outside the monorepo); skipping")
        }
    }
}

#[test]
fn schema_sql_is_idempotent() {
    let store = Store::open_in_memory().unwrap();
    store.conn().execute_batch(SCHEMA_SQL).unwrap();
    assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
}

#[test]
fn migrates_a_v1_database_forward() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE repos (repo_id TEXT PRIMARY KEY, slug TEXT, root_path TEXT, settings TEXT);
         PRAGMA user_version = 1;",
    )
    .unwrap();
    let store = Store::from_connection(conn, Box::new(SequentialMinter::new())).unwrap();
    assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
    assert!(schema::table_exists(store.conn(), "file_stats").unwrap());
    assert!(schema::table_exists(store.conn(), "workspace_settings").unwrap());
    assert!(schema::table_exists(store.conn(), "doc_embeddings").unwrap());
    let cols = schema::column_names(store.conn(), "repos").unwrap();
    assert!(
        !cols.contains(&"root_path".to_owned()),
        "v13 dropped root_path"
    );
    // No docs table was created: partial pre-states migrate only what the steps touch.
    assert!(!schema::table_exists(store.conn(), "docs").unwrap());
}

#[test]
fn migrates_documents_columns_and_renames_to_docs() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE documents (doc_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, path TEXT NOT NULL, frontmatter TEXT);
         CREATE TABLE blocks (block_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(doc_id));
         INSERT INTO documents VALUES ('d_1', 'rp_1', 'a.md', '{}');
         PRAGMA user_version = 2;",
    )
    .unwrap();
    let store = Store::from_connection(conn, Box::new(SequentialMinter::new())).unwrap();
    assert!(!schema::table_exists(store.conn(), "documents").unwrap());
    let cols = schema::column_names(store.conn(), "docs").unwrap();
    assert_eq!(
        cols,
        [
            "doc_id",
            "repo_id",
            "path",
            "metadata",
            "format",
            "leading_trivia",
            "frontmatter_trivia"
        ]
    );
    assert!(
        schema::column_names(store.conn(), "blocks")
            .unwrap()
            .contains(&"trivia_hash".to_owned())
    );
    // The FK on blocks now names docs (SQLite rewrote it with the rename).
    let sql: String = store
        .conn()
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = 'blocks'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        sql.contains("REFERENCES \"docs\"") || sql.contains("REFERENCES docs"),
        "{sql}"
    );
    let format: String = store
        .conn()
        .query_row("SELECT format FROM docs WHERE doc_id = 'd_1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(format, "markdown");
}

#[test]
fn migrates_v12_to_v13_root_path_into_an_fs_source() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE repos (repo_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, root_path TEXT, settings TEXT NOT NULL DEFAULT '{}');
         CREATE TABLE adapters (name TEXT PRIMARY KEY, command TEXT NOT NULL, args TEXT NOT NULL DEFAULT '[]');
         CREATE TABLE sources (source_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, adapter TEXT NOT NULL REFERENCES adapters(name), config TEXT NOT NULL DEFAULT '{}', env TEXT NOT NULL DEFAULT '{}');
         CREATE TABLE attachments (repo_id TEXT NOT NULL REFERENCES repos(repo_id), source_id TEXT NOT NULL REFERENCES sources(source_id), PRIMARY KEY (repo_id, source_id));
         INSERT INTO repos (repo_id, slug, root_path) VALUES ('rp_1', 'vault', '/data/vault');
         INSERT INTO repos (repo_id, slug, root_path) VALUES ('rp_2', 'headless', NULL);
         PRAGMA user_version = 12;",
    )
    .unwrap();
    let store = Store::from_connection(conn, Box::new(SequentialMinter::new())).unwrap();
    assert_eq!(store.user_version().unwrap(), 13);
    let cols = schema::column_names(store.conn(), "repos").unwrap();
    assert_eq!(cols, ["repo_id", "slug", "settings"]);
    let src: (String, String, String) = store
        .conn()
        .query_row(
            "SELECT source_id, adapter, config FROM sources WHERE name = 'vault-fs'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(src.0, "src_0");
    assert_eq!(src.1, "fs");
    assert_eq!(src.2, r#"{"root":"/data/vault"}"#);
    let attached: i64 = store
        .conn()
        .query_row(
            "SELECT count(*) FROM attachments WHERE repo_id = 'rp_1' AND source_id = 'src_0'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(attached, 1);
    assert_eq!(
        count(&store, "sources"),
        1,
        "a repo without a root gets no source"
    );
    let adapter: String = store
        .conn()
        .query_row("SELECT command FROM adapters WHERE name = 'fs'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(adapter, "omgbase-fs-adapter");
}

#[test]
fn refuses_a_newer_database_with_the_exact_message() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA user_version = 14").unwrap();
    let err = Store::from_connection(conn, Box::new(RandomMinter))
        .err()
        .unwrap();
    assert_eq!(
        err.to_string(),
        "database schema (v14) is newer than this build (v13); upgrade omgbase"
    );
    assert!(matches!(
        err,
        Error::SchemaTooNew {
            found: 14,
            supported: 13
        }
    ));
}

#[test]
fn opening_twice_is_a_no_op_and_file_stores_use_wal() {
    let dir = std::env::temp_dir().join(format!("omgbase-store-{}", ids::random_suffix()));
    let path = dir.join("nested").join("omgbase.db");
    {
        let mut store = Store::open(&path).unwrap();
        let mode: String = store
            .conn()
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        store.create_repo("r").unwrap();
        store.close().unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(count(&store, "repos"), 1);
        store.close().unwrap();
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn enforces_foreign_keys_and_check_constraints() {
    let mut store = Store::open_in_memory().unwrap();
    let err = store
        .conn()
        .execute(
            "INSERT INTO docs (doc_id, repo_id, path) VALUES ('d_x', 'rp_missing', 'a.md')",
            [],
        )
        .unwrap_err();
    assert!(err.to_string().contains("FOREIGN KEY"), "{err}");
    let repo = store.create_repo("s").unwrap();
    let err = store
        .conn()
        .execute(
            "INSERT INTO commits (commit_id, repo_id, seq, ts, origin) VALUES ('c_1', ?1, 1, 't', 'bogus')",
            params![repo],
        )
        .unwrap_err();
    assert!(err.to_string().contains("CHECK"), "{err}");
}

#[test]
fn transaction_rolls_back_on_drop() {
    let store = Store::open_in_memory().unwrap();
    {
        let tx = store.transaction().unwrap();
        tx.execute("INSERT INTO repos (repo_id, slug) VALUES ('rp_1', 's')", [])
            .unwrap();
    }
    assert_eq!(count(&store, "repos"), 0);
}

#[test]
fn cosine_udf_matches_the_reference() {
    let store = Store::open_in_memory().unwrap();
    let blob = |v: &[f32]| -> Vec<u8> { v.iter().flat_map(|f| f.to_le_bytes()).collect() };
    let a = blob(&[1.0, 0.0, 0.0]);
    let b = blob(&[0.0, 1.0, 0.0]);
    let c = blob(&[2.0, 0.0, 0.0]);
    let q = |x: &[u8], y: &[u8]| -> Option<f64> {
        store
            .conn()
            .query_row("SELECT cosine(?1, ?2)", params![x, y], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(q(&a, &b), Some(0.0));
    assert_eq!(q(&a, &c), Some(1.0));
    assert_eq!(q(&a, &blob(&[0.0, 0.0, 0.0])), Some(0.0), "zero vector → 0");
    // Unequal lengths use the shorter prefix.
    assert!((q(&blob(&[1.0, 1.0]), &blob(&[1.0, 1.0, 5.0])).unwrap() - 1.0).abs() < 1e-12);
    let null: Option<f64> = store
        .conn()
        .query_row("SELECT cosine(?1, NULL)", params![a], |r| r.get(0))
        .unwrap();
    assert_eq!(null, None);
    assert!(
        store
            .conn()
            .query_row("SELECT cosine('x', 'y')", [], |r| r
                .get::<_, Option<f64>>(0))
            .is_err()
    );
    assert_eq!(cosine_bytes(&[], &[]), 0.0);
}

// ---- writers ----------------------------------------------------------------------------

#[test]
fn dedups_identical_blobs_and_tree_nodes() {
    let store = Store::open_in_memory().unwrap();
    let h1 = store.put_blob("same text").unwrap();
    let h2 = store.put_blob("same text").unwrap();
    assert_eq!(h1, h2);
    assert_eq!(h1, hex(&sha256(b"same text")));
    assert_eq!(count(&store, "blobs"), 1);
    let size: i64 = store
        .conn()
        .query_row("SELECT size FROM blobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(size, 9);
    let e = [TreeEntry {
        block_id: "b_a".to_owned(),
        raw_hash_hex: h1,
        child_tree_hash_hex: None,
        kind: "paragraph".to_owned(),
        attrs: serde_json::json!({}),
        trivia_hash_hex: None,
    }];
    assert_eq!(
        store.put_tree_node(&e).unwrap(),
        store.put_tree_node(&e).unwrap()
    );
    assert_eq!(count(&store, "tree_nodes"), 1);
    // UTF-8 bytes, not chars.
    let h = store.put_blob("é").unwrap();
    let size: i64 = store
        .conn()
        .query_row(
            "SELECT size FROM blobs WHERE hash = ?1",
            params![tree::from_hex(&h).unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(size, 2);
}

#[test]
fn structural_sharing_editing_one_of_500_blocks_adds_one_node_and_one_blob() {
    let store = Store::open_in_memory().unwrap();
    let mut blocks: Vec<TreeInputBlock> = (0..500)
        .map(|i| TreeInputBlock {
            block_id: format!("b_{i:05}"),
            kind: "paragraph".to_owned(),
            raw: format!("Paragraph number {i}."),
            text: format!("Paragraph number {i}."),
            trivia: "\n\n".to_owned(),
            attrs: Default::default(),
            children: Vec::new(),
        })
        .collect();
    store.write_block_tree(&blocks).unwrap();
    let (t1, b1) = (count(&store, "tree_nodes"), count(&store, "blobs"));
    blocks[250].raw = "Paragraph number 250 — EDITED.".to_owned();
    store.write_block_tree(&blocks).unwrap();
    assert_eq!(
        count(&store, "tree_nodes") - t1,
        1,
        "only the root node changes"
    );
    assert_eq!(
        count(&store, "blobs") - b1,
        1,
        "only the edited paragraph's blob"
    );
}

#[test]
fn rewriting_an_unchanged_tree_adds_zero_rows() {
    let store = Store::open_in_memory().unwrap();
    let tree = parse_markdown("# A\n\n- x\n  - y\n\nC\n");
    let mut minter = SequentialMinter::new();
    let blocks = assign_fresh_ids(&tree.children, &mut minter);
    assert_eq!(
        blocks[1].children[0].children[0].block_id, "b_3",
        "pre-order mint"
    );
    let root1 = write_block_tree(store.conn(), &blocks).unwrap();
    let n1 = count(&store, "tree_nodes");
    let root2 = write_block_tree(store.conn(), &blocks).unwrap();
    assert_eq!(root1, root2);
    assert_eq!(count(&store, "tree_nodes"), n1);
    assert_eq!(n1, 4, "root, the list, item x's children, the nested list");
}

#[test]
fn assigns_per_repo_commit_seq_and_per_doc_revision_seq() {
    let (mut store, repo) = fixture_store();
    store
        .conn()
        .execute(
            "INSERT INTO docs (doc_id, repo_id, path) VALUES ('d_1', ?1, 'a.md')",
            params![repo],
        )
        .unwrap();
    let (c1, s1) = store.new_commit(&NewCommit::observed(&repo, "t1")).unwrap();
    assert_eq!((c1.as_str(), s1), ("c_0", 1));
    let tree = parse_markdown("# A\n");
    let blocks = assign_fresh_ids(&tree.children, store.minter_mut());
    let root = store.write_block_tree(&blocks).unwrap();
    let rev = |store: &mut Store, commit: &str| {
        store
            .write_revision(&NewRevision {
                doc_id: "d_1",
                root_tree_hex: &root,
                frontmatter_blob_hex: None,
                rendered_hash: sha256(b"# A\n"),
                path: "a.md",
                commit_id: commit,
            })
            .unwrap()
    };
    assert_eq!(rev(&mut store, &c1), ("r_0".to_owned(), 1));
    let (c2, s2) = store.new_commit(&NewCommit::observed(&repo, "t2")).unwrap();
    assert_eq!((c2.as_str(), s2), ("c_1", 2));
    assert_eq!(rev(&mut store, &c2), ("r_1".to_owned(), 2));
}

// ---- observe ----------------------------------------------------------------------------

#[test]
fn first_observation_mints_in_the_specified_order() {
    let (mut store, repo) = fixture_store();
    let o = observe(&mut store, &repo, "a.md", "# Title\n\nFirst.\n", T0);
    assert_eq!(o.doc_id, "d_0");
    assert_eq!(o.commit_id.as_deref(), Some("c_0"));
    assert_eq!(o.rev.as_deref(), Some("r_0"));
    assert!(o.converged && !o.echo && !o.conflicted);
    assert_eq!(kinds(&o), [("inserted".to_owned(), 2)]);
    assert_eq!(o.old_hash_hex, None);
    assert_eq!(o.new_hash_hex, hex(&sha256(b"# Title\n\nFirst.\n")));
    type Row = (
        String,
        Option<String>,
        String,
        i64,
        i64,
        String,
        String,
        String,
        Option<Vec<u8>>,
    );
    let rows: Vec<Row> = {
        let mut stmt = store
            .conn()
            .prepare("SELECT block_id, parent_block, order_key, ordinal, depth, ancestor_path, type, attrs, trivia_hash FROM blocks ORDER BY rowid")
            .unwrap();
        stmt.query_map([], |r| {
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
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
    };
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0, "b_0");
    assert_eq!(rows[0].2, "V");
    assert_eq!(rows[0].6, "heading");
    assert_eq!(rows[0].7, r#"{"level":1}"#);
    assert_eq!(rows[0].8.as_deref(), Some(&sha256(b"\n\n")[..]));
    assert_eq!(rows[1].0, "b_1");
    assert_eq!(rows[1].2, "W");
    assert_eq!(rows[1].5, "/");
    assert_eq!(rows[1].8.as_deref(), Some(&sha256(b"\n")[..]));
    let sections = count(&store, "sections");
    assert_eq!(sections, 1);
    let fts: i64 = store
        .conn()
        .query_row(
            "SELECT count(*) FROM blocks_fts WHERE blocks_fts MATCH 'first'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(fts, 1);
}

#[test]
fn echo_writes_nothing_and_mints_nothing() {
    let (mut store, repo) = fixture_store();
    observe(&mut store, &repo, "a.md", "# T\n", T0);
    let before = (count(&store, "commits"), count(&store, "revisions"));
    let o = observe(&mut store, &repo, "a.md", "# T\n", T1);
    assert!(o.echo && o.converged && !o.conflicted);
    assert_eq!(o.commit_id, None);
    assert_eq!(o.rev, None);
    assert!(o.dispositions.is_empty());
    assert_eq!(o.old_hash_hex.as_deref(), Some(o.new_hash_hex.as_str()));
    assert_eq!(
        (count(&store, "commits"), count(&store, "revisions")),
        before
    );
    // The next mint is still b_1 / c_1: nothing was minted by the echo.
    assert_eq!(store.mint("c"), "c_1");
    assert_eq!(store.mint("b"), "b_1");
}

#[test]
fn edit_carries_ids_and_stamps_created_commit_as_last_written() {
    let (mut store, repo) = fixture_store();
    observe(
        &mut store,
        &repo,
        "a.md",
        "# Title\n\nThe first paragraph has enough words to be matched by similarity.\n",
        T0,
    );
    let o = observe(
        &mut store,
        &repo,
        "a.md",
        "# Title\n\nThe first paragraph has enough words to be matched by similarity, edited.\n",
        T1,
    );
    assert_eq!(
        kinds(&o),
        [("edited".to_owned(), 1), ("same".to_owned(), 1)]
    );
    let rows: Vec<(String, String)> = {
        let mut stmt = store
            .conn()
            .prepare("SELECT block_id, created_commit FROM blocks ORDER BY ordinal")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(
        rows,
        [
            ("b_0".to_owned(), "c_1".to_owned()),
            ("b_1".to_owned(), "c_1".to_owned())
        ]
    );
    let seqs: Vec<i64> = {
        let mut stmt = store
            .conn()
            .prepare("SELECT seq FROM revisions WHERE doc_id = 'd_0' ORDER BY seq")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(seqs, [1, 2]);
    assert_eq!(count(&store, "block_changes"), 4);
}

#[test]
fn deletion_pools_blocks_for_thirty_days_and_sweep_expires_them() {
    let (mut store, repo) = fixture_store();
    observe(
        &mut store,
        &repo,
        "a.md",
        "# A\n\nkeep this paragraph forever please\n\ndelete this whole paragraph soon\n",
        T0,
    );
    let o = observe(
        &mut store,
        &repo,
        "a.md",
        "# A\n\nkeep this paragraph forever please\n",
        T1,
    );
    assert_eq!(o.dispositions["deleted"], 1);
    let pool: Vec<(String, String, String, String)> = {
        let mut stmt = store
            .conn()
            .prepare("SELECT block_id, doc_id, deleted_commit, expires_ts FROM resurrection_pool")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(
        pool,
        [(
            "b_2".to_owned(),
            "d_0".to_owned(),
            "c_1".to_owned(),
            "2026-10-26T10:01:00.000Z".to_owned()
        )]
    );
    assert_eq!(store.load_pool(&repo, T2).unwrap().len(), 1);
    assert_eq!(
        store
            .load_pool(&repo, "2026-10-26T10:01:00.000Z")
            .unwrap()
            .len(),
        0,
        "expires_ts > ts is strict"
    );
    assert_eq!(store.sweep_pool("2000-01-01T00:00:00.000Z").unwrap(), 0);
    assert_eq!(
        store.sweep_pool("2026-10-26T10:01:00.000Z").unwrap(),
        1,
        "expires_ts <= ts sweeps"
    );
    assert_eq!(count(&store, "resurrection_pool"), 0);
}

#[test]
fn a_pooled_block_resurrects_with_its_id() {
    let (mut store, repo) = fixture_store();
    observe(
        &mut store,
        &repo,
        "a.md",
        "# A\n\nfirst paragraph of the document\n\nsecond paragraph of the document\n",
        T0,
    );
    observe(
        &mut store,
        &repo,
        "a.md",
        "# A\n\nfirst paragraph of the document\n",
        T1,
    );
    let o = observe(
        &mut store,
        &repo,
        "a.md",
        "# A\n\nfirst paragraph of the document\n\nsecond paragraph of the document\n",
        T2,
    );
    assert_eq!(o.dispositions["resurrected"], 1);
    let id: String = store
        .conn()
        .query_row("SELECT block_id FROM blocks WHERE ordinal = 2", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(id, "b_2");
    assert_eq!(count(&store, "resurrection_pool"), 0, "consumed");
}

#[test]
fn observed_deletion_tombstones_and_recreation_revives_the_doc_row() {
    let (mut store, repo) = fixture_store();
    let src = "# A\n\nsome body text that is long enough\n";
    observe(&mut store, &repo, "a.md", src, T0);
    let out = store
        .observe_batch(&repo, &[BatchItem::gone("a.md")], T1, &Config::default())
        .unwrap();
    let d = out[0].as_deleted().unwrap();
    assert_eq!(d.doc_id.as_deref(), Some("d_0"));
    assert!(d.deleted());
    assert!(d.old_hash_hex.is_some());
    let (deleted, reason): (Option<String>, Option<String>) = store
        .conn()
        .query_row(
            "SELECT d.deleted_commit, c.reason FROM docs d JOIN commits c ON c.commit_id = d.deleted_commit WHERE d.doc_id = 'd_0'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(deleted.as_deref(), Some("c_1"));
    assert_eq!(reason.as_deref(), Some("observed deletion"));
    assert_eq!(count(&store, "resurrection_pool"), 2);
    assert_eq!(count(&store, "revisions"), 1, "no revision for a tombstone");
    assert_eq!(store.reconstruct("d_0").unwrap(), None);
    let live: i64 = store
        .conn()
        .query_row(
            "SELECT count(*) FROM blocks WHERE deleted_commit IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(live, 0);
    // (An external-content FTS table answers a plain count(*) from the content
    // table, so emptiness is checked with a MATCH.)
    let fts: i64 = store
        .conn()
        .query_row(
            "SELECT count(*) FROM blocks_fts WHERE blocks_fts MATCH 'body'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(fts, 0);

    // A gone path with no live doc is a no-op.
    let out = store
        .observe_batch(&repo, &[BatchItem::gone("a.md")], T1, &Config::default())
        .unwrap();
    assert_eq!(out[0].as_deleted().unwrap().doc_id, None);
    assert_eq!(count(&store, "commits"), 2);

    // Re-creation: same doc row, ids resurrect, tombstone cleared, echo afterwards.
    let o = observe(&mut store, &repo, "a.md", src, T2);
    assert_eq!(o.doc_id, "d_0");
    assert_eq!(o.dispositions["resurrected"], 2);
    assert!(o.converged);
    let deleted: Option<String> = store
        .conn()
        .query_row(
            "SELECT deleted_commit FROM docs WHERE doc_id = 'd_0'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(deleted, None);
    assert_eq!(store.reconstruct("d_0").unwrap().as_deref(), Some(src));
    assert_eq!(count(&store, "resurrection_pool"), 0);
    let echo = observe(&mut store, &repo, "a.md", src, "2026-09-26T10:03:00.000Z");
    assert!(echo.echo);
}

#[test]
fn observe_delete_sweeps_and_reports() {
    let (mut store, repo) = fixture_store();
    observe(&mut store, &repo, "a.md", "para\n", T0);
    let d = store.observe_delete(&repo, "a.md", T1).unwrap();
    assert!(d.deleted());
    assert_eq!(d.path, "a.md");
    let d = store.observe_delete(&repo, "a.md", T1).unwrap();
    assert!(!d.deleted());
    assert_eq!(d.old_hash_hex, None);
}

#[test]
fn cross_document_move_in_one_batch_carries_the_id() {
    let (mut store, repo) = fixture_store();
    let moved = "this whole paragraph gets cut from file a and pasted into file b intact\n";
    store
        .observe_batch(
            &repo,
            &[
                BatchItem::observed("a.md", &format!("file a keeps this\n\n{moved}")),
                BatchItem::observed("b.md", "file b original line\n"),
            ],
            T0,
            &Config::default(),
        )
        .unwrap();
    let out = store
        .observe_batch(
            &repo,
            &[
                BatchItem::observed("a.md", "file a keeps this\n"),
                BatchItem::observed("b.md", &format!("file b original line\n\n{moved}")),
            ],
            T1,
            &Config::default(),
        )
        .unwrap();
    let a = out[0].as_observed().unwrap();
    let b = out[1].as_observed().unwrap();
    assert_eq!(
        kinds(a),
        [("same".to_owned(), 1)],
        "no deleted disposition in the source"
    );
    assert_eq!(kinds(b), [("moved".to_owned(), 1), ("same".to_owned(), 1)]);
    let (doc, detail): (String, String) = store
        .conn()
        .query_row(
            "SELECT b.doc_id, d.detail FROM blocks b JOIN dispositions d ON d.block_id = b.block_id AND d.kind = 'moved' WHERE b.block_id = 'b_1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(doc, "d_1");
    assert_eq!(detail, r#"{"fromDoc":"d_0"}"#);
    assert_eq!(
        count(&store, "resurrection_pool"),
        0,
        "a moved block is never pooled"
    );
    // The replaced minted id was simply never used.
    assert_eq!(store.mint("b"), "b_4");
}

#[test]
fn cross_document_move_from_a_gone_member_survives_either_batch_order() {
    for source_first in [true, false] {
        let (mut store, repo) = fixture_store();
        let text = "a paragraph long enough to be matched across documents by the pool\n";
        observe(&mut store, &repo, "a.md", text, T0);
        let mut items = vec![BatchItem::gone("a.md"), BatchItem::observed("b.md", text)];
        if !source_first {
            items.reverse();
        }
        let out = store
            .observe_batch(&repo, &items, T1, &Config::default())
            .unwrap();
        let b = out.iter().find_map(BatchOutcome::as_observed).unwrap();
        assert_eq!(
            kinds(b),
            [("moved".to_owned(), 1)],
            "source_first={source_first}"
        );
        let rows: Vec<(String, String, Option<String>)> = {
            let mut stmt = store
                .conn()
                .prepare("SELECT block_id, doc_id, deleted_commit FROM blocks")
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        assert_eq!(
            rows,
            [("b_0".to_owned(), "d_1".to_owned(), None)],
            "source_first={source_first}"
        );
        assert_eq!(
            count(&store, "resurrection_pool"),
            0,
            "source_first={source_first}"
        );
    }
}

#[test]
fn conflict_markers_flag_the_doc() {
    let (mut store, repo) = fixture_store();
    let o = observe(
        &mut store,
        &repo,
        "a.md",
        "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n",
        T0,
    );
    assert!(o.conflicted);
    let flag: i64 = store
        .conn()
        .query_row("SELECT conflicted FROM docs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(flag, 1);
    let o = observe(&mut store, &repo, "a.md", "resolved\n", T1);
    assert!(!o.conflicted);
    let flag: i64 = store
        .conn()
        .query_row("SELECT conflicted FROM docs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(flag, 0);
}

#[test]
fn frontmatter_is_a_blob_on_the_revision_not_a_block() {
    let (mut store, repo) = fixture_store();
    let src = "---\ntitle: x\n---\n\n# H\n\nbody\n";
    let o = observe(&mut store, &repo, "a.md", src, T0);
    assert!(o.converged);
    assert_eq!(o.dispositions["inserted"], 2);
    let (fm, trivia): (Option<Vec<u8>>, Option<String>) = store
        .conn()
        .query_row(
            "SELECT r.frontmatter_blob, d.frontmatter_trivia FROM revisions r JOIN docs d ON d.doc_id = r.doc_id",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(fm.as_deref(), Some(&sha256(b"---\ntitle: x\n---")[..]));
    assert_eq!(trivia.as_deref(), Some("\n\n"));
    assert_eq!(store.reconstruct(&o.doc_id).unwrap().as_deref(), Some(src));
    let at = store.read_at_revision(&o.doc_id, "r_0").unwrap().unwrap();
    assert_eq!(at.content, src);
    assert!(at.rendered_hash_match);
    assert_eq!(at.path, "a.md");
    assert!(store.read_at_revision(&o.doc_id, "r_9").unwrap().is_none());
    assert!(store.read_at_revision("d_9", "r_0").unwrap().is_none());
}

#[test]
fn leading_trivia_and_empty_document_round_trip() {
    let (mut store, repo) = fixture_store();
    for src in ["\n\n# H\n", "", "\n", "just text"] {
        let o = observe(&mut store, &repo, "a.md", src, T0);
        assert!(o.converged, "{src:?}");
        assert_eq!(store.reconstruct(&o.doc_id).unwrap().as_deref(), Some(src));
    }
    let root: Vec<u8> = store
        .conn()
        .query_row(
            "SELECT root_tree FROM revisions WHERE rev_id = 'r_1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(root, sha256(b"[]"), "an empty body is the empty node");
}

#[test]
fn read_at_an_older_revision_reports_the_hash_honestly() {
    let (mut store, repo) = fixture_store();
    observe(&mut store, &repo, "a.md", "# A\n\none\n", T0);
    observe(&mut store, &repo, "a.md", "\n# A\n\none\n", T1); // leading trivia changed
    let at = store.read_at_revision("d_0", "r_0").unwrap().unwrap();
    assert_eq!(
        at.content, "\n# A\n\none\n",
        "doc-level trivia is not versioned"
    );
    assert!(!at.rendered_hash_match);
    let at = store.read_at_revision("d_0", "r_1").unwrap().unwrap();
    assert!(at.rendered_hash_match);
}

#[test]
fn old_tree_loads_in_parent_then_ordinal_order_with_recomputed_text() {
    let (mut store, repo) = fixture_store();
    observe(
        &mut store,
        &repo,
        "a.md",
        "# H\n\n- a\n- b\n  > q\n\n> quoted\n> more\n",
        T0,
    );
    let old = store.load_old_match_blocks("d_0").unwrap();
    let keys: Vec<&str> = old.iter().map(|b| b.key.as_str()).collect();
    // Top level first (parent NULL), then children grouped by parent id bytewise.
    // Pre-order ids: b_0 heading, b_1 list, b_2 item a, b_3 item b, b_4 its
    // paragraph, b_5 its blockquote, b_6 that paragraph, b_7 blockquote, b_8.
    assert_eq!(
        keys,
        [
            "/0", "/1", "/2", "/1/0", "/1/1", "/1/1/0", "/1/1/1", "/1/1/1/0", "/2/0"
        ]
    );
    let by_key: BTreeMap<&str, &MatchBlock> = old.iter().map(|b| (b.key.as_str(), b)).collect();
    assert_eq!(by_key["/1"].text, "a b q");
    assert_eq!(by_key["/1/1"].text, "b q");
    assert_eq!(by_key["/2"].text, "quoted more");
    assert_eq!(by_key["/2/0"].text, "quoted more");
    assert_eq!(by_key["/2/0"].kind, "paragraph");
    assert_eq!(by_key["/1/1/1"].text, "q");
    assert_eq!(by_key["/1/1/1/0"].parent_key.as_deref(), Some("/1/1/1"));
    assert_eq!(by_key["/1/1/1/0"].index, 0);
    assert_eq!(
        old.iter()
            .filter_map(|b| b.id.as_deref())
            .collect::<Vec<_>>(),
        [
            "b_0", "b_1", "b_7", "b_2", "b_3", "b_4", "b_5", "b_6", "b_8"
        ]
    );
    assert!(old.iter().all(|b| b.anchors.is_empty()));
    // Stored norm_hash agrees with the recomputed text.
    for b in &old {
        let stored: Vec<u8> = store
            .conn()
            .query_row(
                "SELECT norm_hash FROM blocks WHERE block_id = ?1",
                params![b.id.as_ref().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hex(&stored), b.norm_hash, "{}", b.key);
    }
}

#[test]
fn sections_span_to_the_next_peer_or_higher_heading() {
    let (mut store, repo) = fixture_store();
    observe(
        &mut store,
        &repo,
        "a.md",
        "intro\n\n# One\n\nbody\n\n## One point one\n\nmore\n\n# Two\n\nlast\n\nSetext\n------\n",
        T0,
    );
    let rows: Vec<(String, i64, i64, i64)> = {
        let mut stmt = store
            .conn()
            .prepare("SELECT heading_block, level, first_ordinal, last_ordinal FROM sections ORDER BY first_ordinal")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(
        rows,
        [
            ("b_1".to_owned(), 1, 1, 4),
            ("b_3".to_owned(), 2, 3, 4),
            ("b_5".to_owned(), 1, 5, 7),
            ("b_7".to_owned(), 2, 7, 7),
        ]
    );
}

#[test]
fn rebuild_reproduces_sections_block_changes_and_fts() {
    let (mut store, repo) = fixture_store();
    observe(
        &mut store,
        &repo,
        "a.md",
        "# Doc\n\n## Section One\n\nbody with a [link](/b.md)\n\n- [ ] a task\n\n## Section Two\n\nmore body text here\n",
        T0,
    );
    observe(
        &mut store,
        &repo,
        "b.md",
        "# B\n\nreferences [a](/a.md)\n",
        T0,
    );
    observe(
        &mut store,
        &repo,
        "a.md",
        "# Doc\n\n## Section One\n\nbody with a [link](/b.md)\n\n## Section Two\n\nmore body text here\n",
        T1,
    );
    let snapshot = |store: &Store, table: &str| -> Vec<Vec<String>> {
        let mut stmt = store
            .conn()
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1, 2, 3"))
            .unwrap();
        let n = stmt.column_count();
        stmt.query_map([], |r| {
            (0..n)
                .map(|i| {
                    r.get::<_, rusqlite::types::Value>(i)
                        .map(|v| format!("{v:?}"))
                })
                .collect()
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
    };
    let secs = snapshot(&store, "sections");
    let changes = snapshot(&store, "block_changes");
    assert!(!secs.is_empty() && !changes.is_empty());
    let fts_hits = |store: &Store| -> i64 {
        store
            .conn()
            .query_row(
                "SELECT count(*) FROM blocks_fts WHERE blocks_fts MATCH 'body'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    };
    let fts_before = fts_hits(&store);
    assert!(fts_before > 0);
    store.conn().execute_batch("DELETE FROM sections; DELETE FROM block_changes; INSERT INTO blocks_fts(blocks_fts) VALUES('delete-all');").unwrap();
    store.rebuild_index(RebuildTarget::All).unwrap();
    assert_eq!(snapshot(&store, "sections"), secs);
    assert_eq!(snapshot(&store, "block_changes"), changes);
    assert_eq!(fts_hits(&store), fts_before);
    let hit: i64 = store
        .conn()
        .query_row(
            "SELECT count(*) FROM blocks_fts WHERE blocks_fts MATCH 'section'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(hit > 0);
    // Per-target rebuilds are the same rows.
    store.conn().execute_batch("DELETE FROM sections").unwrap();
    store.rebuild_index(RebuildTarget::Sections).unwrap();
    assert_eq!(snapshot(&store, "sections"), secs);
}

#[test]
fn gc_is_off_by_default_and_finds_nothing_unreachable_when_on() {
    let (mut store, repo) = fixture_store();
    observe(&mut store, &repo, "a.md", "# A\n\nbody one\n", T0);
    observe(
        &mut store,
        &repo,
        "a.md",
        "# A\n\nbody one edited\n\nbody two added\n",
        T1,
    );
    let before = (count(&store, "blobs"), count(&store, "tree_nodes"));
    assert_eq!(store.gc(false).unwrap(), GcResult::default());
    assert_eq!(store.gc_dry_run().unwrap(), GcResult::default());
    assert_eq!(store.gc(true).unwrap(), GcResult::default());
    assert_eq!(
        (count(&store, "blobs"), count(&store, "tree_nodes")),
        before
    );
    let (trees, blobs) = mark_reachable(store.conn()).unwrap();
    assert_eq!(trees.len() as i64, before.1);
    assert_eq!(blobs.len() as i64, before.0);
    // An orphan is collected when GC is on.
    store.put_blob("orphan").unwrap();
    store
        .put_tree_node(&[TreeEntry {
            block_id: "b_x".to_owned(),
            raw_hash_hex: hex(&sha256(b"orphan")),
            child_tree_hash_hex: None,
            kind: "paragraph".to_owned(),
            attrs: serde_json::json!({}),
            trivia_hash_hex: None,
        }])
        .unwrap();
    assert_eq!(
        store.gc_dry_run().unwrap(),
        GcResult {
            blobs_swept: 1,
            tree_nodes_swept: 1
        }
    );
    assert_eq!(
        store.gc(true).unwrap(),
        GcResult {
            blobs_swept: 1,
            tree_nodes_swept: 1
        }
    );
    assert_eq!(
        (count(&store, "blobs"), count(&store, "tree_nodes")),
        before
    );
}

#[test]
fn a_batch_shares_one_pool_snapshot_so_an_id_resurrects_once() {
    let (mut store, repo) = fixture_store();
    let text = "a paragraph long enough to be matched by hash from the pool\n";
    observe(&mut store, &repo, "a.md", text, T0);
    store
        .observe_batch(&repo, &[BatchItem::gone("a.md")], T1, &Config::default())
        .unwrap();
    assert_eq!(count(&store, "resurrection_pool"), 1);
    let out = store
        .observe_batch(
            &repo,
            &[
                BatchItem::observed("b.md", text),
                BatchItem::observed("c.md", text),
            ],
            T2,
            &Config::default(),
        )
        .unwrap();
    // Neither b.md nor c.md has a doc row, so the pool is not offered to
    // either (§5.1 step 4): both insert; the pooled row stays.
    assert_eq!(
        kinds(out[0].as_observed().unwrap()),
        [("inserted".to_owned(), 1)]
    );
    assert_eq!(
        kinds(out[1].as_observed().unwrap()),
        [("inserted".to_owned(), 1)]
    );
    assert_eq!(count(&store, "resurrection_pool"), 1);
    // Re-creating a.md and observing d.md (new) in one batch: only a.md may resurrect.
    let out = store
        .observe_batch(
            &repo,
            &[
                BatchItem::observed("a.md", text),
                BatchItem::observed("d.md", text),
            ],
            "2026-09-26T10:03:00.000Z",
            &Config::default(),
        )
        .unwrap();
    assert_eq!(
        kinds(out[0].as_observed().unwrap()),
        [("resurrected".to_owned(), 1)]
    );
    assert_eq!(
        kinds(out[1].as_observed().unwrap()),
        [("inserted".to_owned(), 1)]
    );
    assert_eq!(count(&store, "resurrection_pool"), 0);
}

#[test]
fn invalid_timestamps_are_rejected_up_front() {
    let (mut store, repo) = fixture_store();
    let err = store
        .observe_batch(
            &repo,
            &[BatchItem::observed("a.md", "x\n")],
            "yesterday",
            &Config::default(),
        )
        .unwrap_err();
    assert!(matches!(err, Error::InvalidTimestamp(_)), "{err}");
    assert_eq!(count(&store, "commits"), 0);
}

// ---- properties (spec/properties §6) -------------------------------------------------

#[test]
fn properties_rows_are_written_in_the_commit_and_replaced_on_reingest() {
    use omgbase_properties::{Card, Source, ValueType, prop_id};
    let (mut store, repo) = fixture_store();
    let o = observe(
        &mut store,
        &repo,
        "a.md",
        "---\nlayer: canon\ntags: [x, y]\nqty: 1..5\nweird: .nan\n---\n\n# Title\n\nelement:: fire #hot\n",
        T0,
    );
    let doc = o.doc_id.clone();
    let commit = o.commit_id.clone().unwrap();
    let rows = store.properties(&doc).unwrap();
    // Write order: inline, frontmatter, computed.
    let order: Vec<(Source, &str, u32)> = rows
        .iter()
        .map(|r| (r.source, r.key.as_str(), r.ord))
        .collect();
    assert_eq!(
        order,
        [
            (Source::Inline, "element", 0),
            (Source::Frontmatter, "layer", 0),
            (Source::Frontmatter, "tags", 0),
            (Source::Frontmatter, "tags", 1),
            (Source::Frontmatter, "qty", 0),
            (Source::Frontmatter, "weird", 0),
            (Source::Computed, "$title", 0),
            (Source::Computed, "$tags", 0),
        ]
    );
    let find = |s: Source, k: &str, o: u32| {
        rows.iter()
            .find(|r| r.source == s && r.key == k && r.ord == o)
            .unwrap()
            .clone()
    };
    let element = find(Source::Inline, "element", 0);
    assert_eq!(
        element.block_id.as_deref(),
        Some("b_1"),
        "the paragraph after the heading"
    );
    assert_eq!(
        (element.card, element.ty, element.val_text.as_deref()),
        (Card::Scalar, ValueType::String, Some("fire #hot"))
    );
    assert_eq!(element.prop_id, prop_id(&doc, Source::Inline, "element", 0));
    let layer = find(Source::Frontmatter, "layer", 0);
    assert_eq!(
        (layer.block_id, layer.card, layer.val_text.as_deref()),
        (None, Card::Scalar, Some("canon"))
    );
    assert_eq!(
        find(Source::Frontmatter, "tags", 1).val_text.as_deref(),
        Some("y")
    );
    assert_eq!(find(Source::Frontmatter, "tags", 1).card, Card::List);
    let qty = find(Source::Frontmatter, "qty", 0);
    assert_eq!(qty.val_text.as_deref(), Some("1..5"));
    assert!(
        qty.val_json
            .as_deref()
            .unwrap()
            .contains("\"__range\":true")
    );
    assert_eq!(
        find(Source::Computed, "$title", 0).val_text.as_deref(),
        Some("Title")
    );
    assert_eq!(
        find(Source::Computed, "$tags", 0).val_text.as_deref(),
        Some("hot")
    );
    // NaN: type = number, val_num NULL in the table, NaN on read.
    let weird = find(Source::Frontmatter, "weird", 0);
    assert_eq!(weird.ty, ValueType::Number);
    assert!(weird.val_num.unwrap().is_nan());
    let stored: (String, Option<f64>) = store
        .conn()
        .query_row(
            "SELECT type, val_num FROM properties WHERE doc_id = ?1 AND key = 'weird'",
            params![doc],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored, ("number".to_owned(), None));
    // Every row carries the repo, the commit, and no deleted_commit.
    let meta: (i64, i64) = store
        .conn()
        .query_row(
            "SELECT count(*), sum(repo_id = ?1 AND created_commit = ?2 AND deleted_commit IS NULL) FROM properties WHERE doc_id = ?3",
            params![repo, commit, doc],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(meta, (8, 8));
    assert_eq!(
        store.properties_merged(&doc).unwrap(),
        serde_json::json!({
            "element": "fire #hot", "layer": "canon", "tags": ["x", "y"], "qty": "1..5", "weird": null,
            "$title": "Title", "$tags": ["hot"],
        })
    );
    assert_eq!(
        store.properties_grouped(&doc).unwrap()["inline"],
        serde_json::json!({"element": "fire #hot"})
    );

    // Re-ingest replaces the rows: new keys appear, old ones are gone, the
    // surviving key carries the new commit and its new value.
    let o2 = observe(
        &mut store,
        &repo,
        "a.md",
        "---\nlayer: draft\n---\n\n# Title\n\nplain\n",
        T1,
    );
    assert_eq!(o2.doc_id, doc);
    let rows = store.properties(&doc).unwrap();
    let keys: Vec<(Source, &str)> = rows.iter().map(|r| (r.source, r.key.as_str())).collect();
    assert_eq!(
        keys,
        [(Source::Frontmatter, "layer"), (Source::Computed, "$title")]
    );
    assert_eq!(rows[0].val_text.as_deref(), Some("draft"));
    let commits: Vec<String> = store
        .conn()
        .prepare("SELECT DISTINCT created_commit FROM properties WHERE doc_id = ?1")
        .unwrap()
        .query_map(params![doc], |r| r.get(0))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap();
    assert_eq!(commits, [o2.commit_id.clone().unwrap()]);
    assert_eq!(count(&store, "properties"), 2);

    // An echo writes nothing.
    let o3 = observe(
        &mut store,
        &repo,
        "a.md",
        "---\nlayer: draft\n---\n\n# Title\n\nplain\n",
        T2,
    );
    assert!(o3.echo);
    assert_eq!(count(&store, "properties"), 2);
}

#[test]
fn a_document_without_properties_has_no_rows_and_a_collision_keeps_the_later_row() {
    use omgbase_properties::Source;
    let (mut store, repo) = fixture_store();
    let o = observe(&mut store, &repo, "plain.md", "just a paragraph\n", T0);
    assert!(store.properties(&o.doc_id).unwrap().is_empty());
    let o = observe(
        &mut store,
        &repo,
        "c.md",
        "---\nmeta.owner: a\nmeta:\n  owner: b\n---\n",
        T1,
    );
    let rows = store.properties(&o.doc_id).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (
            rows[0].source,
            rows[0].key.as_str(),
            rows[0].val_text.as_deref()
        ),
        (Source::Frontmatter, "meta.owner", Some("b"))
    );
}
