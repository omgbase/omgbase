//! Store-level unit tests: the ports of the reference's `store.test.ts`,
//! `writers.test.ts`, `gc.test.ts`, `rebuild.test.ts`, `observe.test.ts`
//! and the §8 invariants on small scripts.

use std::collections::BTreeMap;

use omgbase_format::hash::{hex, sha256};
use omgbase_format::parse_markdown;
use omgbase_reconcile::Config;
use rusqlite::{Connection, params};

use crate::derived::mark_reachable;
use crate::effects::{CommitHead, Effect, Outcome};
use crate::writers::{Origin, assign_fresh_ids, write_block_tree};
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
        "pending_materializations",
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
    assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
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

/// Spec §1 step 3 — the mixed-version guarantee of a major cut: an opener
/// that meets a database one major ahead (a v15 engine opening the v16 file
/// this build writes; simulated here as this build meeting v17) refuses with
/// the exact message, and neither migrates nor touches it.
#[test]
fn refuses_a_newer_database_with_the_exact_message() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA user_version = 17").unwrap();
    let err = Store::from_connection(conn, Box::new(RandomMinter))
        .err()
        .unwrap();
    assert_eq!(
        err.to_string(),
        "database schema (v17) is newer than this build (v16); upgrade omgbase"
    );
    assert!(matches!(
        err,
        Error::SchemaTooNew {
            found: 17,
            supported: 16
        }
    ));
}

/// Migration 14 creates `pending_materializations` on a v13 database (and
/// 15 then creates `archives`); a fresh database has both from `schema.sql`.
#[test]
fn migrates_v13_to_v14_with_the_pending_table() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE repos (repo_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, settings TEXT NOT NULL DEFAULT '{}');
         PRAGMA user_version = 13;",
    )
    .unwrap();
    let store = Store::from_connection(conn, Box::new(SequentialMinter::new())).unwrap();
    assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
    let cols: Vec<String> = {
        let mut stmt = store
            .conn()
            .prepare("PRAGMA table_info(pending_materializations)")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(
        cols,
        [
            "repo_id",
            "path",
            "kind",
            "from_path",
            "doc_id",
            "rev_id",
            "rendered_hash",
            "commit_id"
        ]
    );
    let tables = count(&store, "sqlite_master WHERE type = 'table'");
    assert_eq!(
        tables, 3,
        "repos + pending_materializations (14) + archives (15)"
    );
}

/// Migration 15 (spec §3.4) rebuilds `revisions` under `foreign_keys = OFF`:
/// a v14 database whose `pending_materializations.rev_id` references a
/// revision keeps every row, the body columns turn nullable and lose their
/// foreign keys, `archive` appears, `archives` is created.
#[test]
fn migrates_v14_to_v15_rebuilding_revisions() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE repos (repo_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, settings TEXT NOT NULL DEFAULT '{}');
         CREATE TABLE docs (doc_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(repo_id), path TEXT NOT NULL, current_rev TEXT, file_hash BLOB);
         CREATE TABLE blobs (hash BLOB PRIMARY KEY, bytes BLOB NOT NULL, size INTEGER NOT NULL);
         CREATE TABLE tree_nodes (hash BLOB PRIMARY KEY, entries TEXT NOT NULL);
         CREATE TABLE commits (commit_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repos(repo_id), seq INTEGER NOT NULL, ts TEXT NOT NULL, origin TEXT NOT NULL);
         CREATE TABLE revisions (rev_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(doc_id), seq INTEGER NOT NULL, root_tree BLOB NOT NULL REFERENCES tree_nodes(hash), frontmatter_blob BLOB REFERENCES blobs(hash), rendered_hash BLOB NOT NULL, path TEXT NOT NULL, commit_id TEXT NOT NULL REFERENCES commits(commit_id), UNIQUE (doc_id, seq));
         CREATE TABLE pending_materializations (repo_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, from_path TEXT, doc_id TEXT NOT NULL, rev_id TEXT REFERENCES revisions(rev_id), rendered_hash BLOB NOT NULL, commit_id TEXT NOT NULL, PRIMARY KEY (repo_id, path));
         INSERT INTO repos (repo_id, slug) VALUES ('rp_1', 'v');
         INSERT INTO docs (doc_id, repo_id, path, current_rev) VALUES ('d_1', 'rp_1', 'a.md', 'r_1');
         INSERT INTO tree_nodes (hash, entries) VALUES (X'01', '[]');
         INSERT INTO commits (commit_id, repo_id, seq, ts, origin) VALUES ('c_1', 'rp_1', 1, '2026-10-15T00:00:00.000Z', 'api');
         INSERT INTO revisions (rev_id, doc_id, seq, root_tree, frontmatter_blob, rendered_hash, path, commit_id) VALUES ('r_1', 'd_1', 1, X'01', NULL, X'03', 'a.md', 'c_1');
         INSERT INTO pending_materializations (repo_id, path, kind, doc_id, rev_id, rendered_hash, commit_id) VALUES ('rp_1', 'a.md', 'write', 'd_1', 'r_1', X'03', 'c_1');
         PRAGMA user_version = 14;",
    )
    .unwrap();
    let store = Store::from_connection(conn, Box::new(SequentialMinter::new())).unwrap();
    assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
    let cols: Vec<(String, i64)> = {
        let mut stmt = store
            .conn()
            .prepare("PRAGMA table_info(revisions)")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(3)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(
        cols.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
        [
            "rev_id",
            "doc_id",
            "seq",
            "root_tree",
            "frontmatter_blob",
            "rendered_hash",
            "path",
            "commit_id",
            "archive"
        ]
    );
    assert_eq!(cols[3].1, 0, "root_tree is nullable");
    let fks = count(&store, "pragma_foreign_key_list('revisions')");
    assert_eq!(fks, 2, "docs and commits only; the body FKs are gone");
    assert_eq!(count(&store, "revisions WHERE archive IS NULL"), 1);
    assert_eq!(
        count(&store, "pending_materializations"),
        1,
        "the DROP cascaded nothing"
    );
    assert_eq!(count(&store, "archives"), 0);
    let fk_on: i64 = store
        .conn()
        .pragma_query_value(None, "foreign_keys", |r| r.get(0))
        .unwrap();
    assert_eq!(fk_on, 1, "foreign keys are back on");
}

/// Spec §7.1 end to end: a one-per-day ladder archives two of five revisions
/// into a segment; the squash NULLs their bodies, drops the wholly archived
/// commits' dispositions and the non-earliest block_changes, sweeps exactly
/// the bodies the segment now holds alone, records the segment and the chain
/// pointer; the archived revisions read back through the segment byte for
/// byte; detaching makes the read `RevisionArchived` (no path); attaching
/// the file brings it back; a second export has nothing to do.
#[test]
fn export_prune_reads_through_the_segment_and_round_trips_attach() {
    let (mut store, repo) = fixture_store();
    let dir = std::env::temp_dir().join(format!("omgbase-store-arc-{}", ids::random_suffix()));
    let sources = [
        (
            "2026-01-01T10:00:00.000Z",
            "# A

First draft.
",
        ),
        (
            "2026-01-01T12:00:00.000Z",
            "# A

First draft, noon.
",
        ),
        (
            "2026-01-02T10:00:00.000Z",
            "# A

First draft, noon.

Second day.
",
        ),
        (
            "2026-01-03T09:00:00.000Z",
            "# A

First draft, noon.

Second day, third morning.
",
        ),
        (
            "2026-01-03T15:00:00.000Z",
            "# A

First draft, noon.

Second day, third afternoon.
",
        ),
    ];
    let mut revs = Vec::new();
    for (ts, src) in sources {
        revs.push(observe(&mut store, &repo, "a.md", src, ts).rev.unwrap());
    }
    let policy = store
        .retention_policy(
            &repo,
            Some(&serde_json::json!({ "keep_days": 0, "per_doc_max": 0, "ladder": [{ "after_days": 0, "keep": "one per day" }] })),
        )
        .unwrap();
    let opts = ExportOptions {
        retention: RetentionOptions {
            now: "2026-01-10T00:00:00.000Z".to_owned(),
            before: None,
            policy,
        },
        dest: dir.clone(),
        prune: true,
    };
    let plan = store.retention_plan(&repo, &opts.retention).unwrap();
    assert_eq!(
        plan.docs[0].keep,
        vec![revs[1].clone(), revs[2].clone(), revs[4].clone()]
    );
    assert_eq!(plan.docs[0].archive, vec![revs[0].clone(), revs[3].clone()]);
    assert_eq!(plan.totals.revisions, 5);
    let r = store.export_history(&repo, &opts).unwrap();
    let seg = r.segment.clone().unwrap();
    assert_eq!(seg.id, "s_0");
    assert_eq!((seg.seq_lo, seq_hi(&seg)), (1, 4));
    assert!(!r.reused);
    let squashed = r.squashed.unwrap();
    assert_eq!((squashed.revisions, squashed.commits), (2, 2));
    assert!(std::path::Path::new(&seg.path).exists());
    assert!(seg.path.ends_with("rp_0-1-4-s_0.omgarchive.db"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&seg.path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o444, "a segment is read-only");
    }
    // I9 on the rows, the registry and the chain pointer.
    assert_eq!(
        count(
            &store,
            "revisions WHERE archive = 's_0' AND root_tree IS NULL"
        ),
        2
    );
    assert_eq!(count(&store, "archives"), 1);
    let settings: String = store
        .conn()
        .query_row(
            "SELECT settings FROM repos WHERE repo_id = ?1",
            params![repo],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(settings, r#"{"history":{"last_segment":"s_0"}}"#);
    assert_eq!(
        store.gc_dry_run().unwrap().blobs_swept,
        0,
        "the squash swept"
    );
    // Reads through the attached segment, byte for byte.
    let doc = plan.docs[0].id.clone();
    let read = store.read_at_revision(&doc, &revs[0]).unwrap().unwrap();
    assert_eq!(read.content, sources[0].1);
    assert!(read.rendered_hash_match);
    let body = store.revision_body(&revs[3], Some(&doc)).unwrap().unwrap();
    assert!(body.archived);
    assert_eq!(body.prefix, "arc_s_0.");
    let manifest = read_manifest(std::path::Path::new(&seg.path)).unwrap();
    assert_eq!(
        (manifest.segment_id.as_str(), manifest.repo_id.as_str()),
        ("s_0", repo.as_str())
    );
    assert_eq!(manifest.revision_count, 2);
    assert_eq!(manifest.schema_user_version, SCHEMA_VERSION);
    // Detach: the row stays, the read says so.
    assert_eq!(
        store.detach_archive(&repo, "s_0").unwrap(),
        Some("s_0".to_owned())
    );
    assert_eq!(store.detach_archive(&repo, "s_0").unwrap(), None);
    let err = store.read_at_revision(&doc, &revs[0]).unwrap_err();
    assert_eq!(
        err.to_string(),
        format!(
            "revision \"{}\" is archived in segment s_0, which is not attached (omg history attach <file>)",
            revs[0]
        )
    );
    let listed = store.list_archives(&repo, Some(&dir)).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].state, ArchiveState::Detached);
    // Attach by directory, then the read works again and a new export finds nothing.
    let attached = store.attach_archive(&repo, &dir).unwrap();
    assert_eq!(attached.attached.len(), 1);
    assert_eq!(attached.skipped, 0);
    assert_eq!(
        store
            .read_at_revision(&doc, &revs[3])
            .unwrap()
            .unwrap()
            .content,
        sources[3].1
    );
    assert_eq!(
        store.list_archives(&repo, Some(&dir)).unwrap()[0].state,
        ArchiveState::Attached
    );
    let again = store.export_history(&repo, &opts).unwrap();
    assert!(again.segment.is_none());
    // A non-segment is refused by name.
    let txt = dir.join("notes.txt");
    std::fs::write(&txt, "hello\n").unwrap();
    let err = store.attach_archive(&repo, &txt).unwrap_err();
    assert_eq!(
        err.to_string(),
        format!("{}: not an archive segment", txt.display())
    );
    let err = store
        .attach_archive(&repo, &dir.join("nowhere.omgarchive.db"))
        .unwrap_err();
    assert!(err.to_string().ends_with(": no such file"));
    let _ = std::fs::remove_dir_all(&dir);
}

fn seq_hi(s: &SegmentInfo) -> i64 {
    s.seq_hi
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
            span: omgbase_format::Span { start: 0, end: 0 },
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
    let mut store = Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
    let tree = parse_markdown("# A\n\n- x\n  - y\n\nC\n");
    let blocks = assign_fresh_ids(&tree.children, &mut store.minter()).unwrap();
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
    let blocks = assign_fresh_ids(&tree.children, &mut store.minter()).unwrap();
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
                seq: None,
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
    assert_eq!(store.mint("c").unwrap(), "c_1");
    assert_eq!(store.mint("b").unwrap(), "b_1");
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
    // Two `inserted` rows from the first revision, one `edited` from the
    // second; the heading's `same` verdict is counted above, not persisted
    // (§5.4 step 10, 14.2 — through 14.1 this was 4).
    assert_eq!(count(&store, "block_changes"), 3);
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
    assert_eq!(store.mint("b").unwrap(), "b_4");
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
    // `doc_edges` is the rollup of the open edges: emptied, `Edges` (and
    // `All`) restore the same rows.
    let edges = snapshot(&store, "doc_edges");
    assert!(!edges.is_empty(), "the fixture links a.md → b.md");
    store.conn().execute_batch("DELETE FROM doc_edges").unwrap();
    store.rebuild_index(RebuildTarget::Edges).unwrap();
    assert_eq!(snapshot(&store, "doc_edges"), edges);
    store.conn().execute_batch("DELETE FROM doc_edges").unwrap();
    store.rebuild_index(RebuildTarget::All).unwrap();
    assert_eq!(snapshot(&store, "doc_edges"), edges);
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
            tree_nodes_swept: 1,
            same_dispositions_swept: 0,
        }
    );
    assert_eq!(
        store.gc(true).unwrap(),
        GcResult {
            blobs_swept: 1,
            tree_nodes_swept: 1,
            same_dispositions_swept: 0,
        }
    );
    assert_eq!(
        (count(&store, "blobs"), count(&store, "tree_nodes")),
        before
    );
}

/// §7 "The `same` sweep" (14.2): the rows a 14.1 store wrote go with the
/// default sweep, from both tables; a dry run counts them and deletes nothing;
/// a fresh 14.2 store never has any.
#[test]
fn gc_sweeps_a_pre_14_2_stores_same_rows() {
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
    // The outcome counts the matcher's `same`; the table holds none.
    assert_eq!(
        kinds(&o),
        [("edited".to_owned(), 1), ("same".to_owned(), 1)]
    );
    assert_eq!(store.count_same_dispositions().unwrap(), 0);
    let commit = o.commit_id.clone().expect("a commit");
    let persisted: Vec<String> = {
        let mut stmt = store
            .conn()
            .prepare("SELECT kind FROM dispositions WHERE commit_id = ?1 ORDER BY kind")
            .unwrap();
        stmt.query_map([&commit], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(persisted, ["edited"]);
    // Plant what 14.1 would have written for the untouched heading.
    store
        .conn()
        .execute(
            "INSERT INTO dispositions (commit_id, block_id, kind, confidence, reason, matcher_v, detail)
               VALUES (?1, 'b_0', 'same', 1.0, 'exact_hash', 'm2.3', '{}')",
            [&commit],
        )
        .unwrap();
    store
        .conn()
        .execute(
            "INSERT INTO block_changes (block_id, commit_id, kind) VALUES ('b_0', ?1, 'same')",
            [&commit],
        )
        .unwrap();
    assert_eq!(store.count_same_dispositions().unwrap(), 1);
    let before = (
        count(&store, "dispositions"),
        count(&store, "block_changes"),
    );
    assert_eq!(store.gc_dry_run().unwrap().same_dispositions_swept, 1);
    assert_eq!(
        (
            count(&store, "dispositions"),
            count(&store, "block_changes")
        ),
        before,
        "a dry run deletes nothing"
    );
    assert_eq!(store.gc(false).unwrap(), GcResult::default());
    assert_eq!(store.gc(true).unwrap().same_dispositions_swept, 1);
    assert_eq!(store.count_same_dispositions().unwrap(), 0);
    assert_eq!(
        (
            count(&store, "dispositions"),
            count(&store, "block_changes")
        ),
        (before.0 - 1, before.1 - 1)
    );
    assert_eq!(store.gc(true).unwrap(), GcResult::default());
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

// ---- FTS: leaf-only index (spec/search §1.1, 1.2) ---------------------------------------

/// The rowids `blocks_fts` indexes (its `_docsize` shadow table has one row
/// per indexed document) and the live-leaf rowids of `blocks`.
fn fts_indexed_and_leaves(store: &Store) -> (Vec<i64>, Vec<i64>) {
    let ids = |sql: &str| -> Vec<i64> {
        let mut stmt = store.conn().prepare(sql).unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    (
        ids("SELECT id FROM blocks_fts_docsize ORDER BY id"),
        ids(&format!(
            "SELECT b.rowid FROM blocks b WHERE {LIVE_LEAF_SQL} ORDER BY b.rowid"
        )),
    )
}

fn assert_fts_is_leaves(store: &Store, at: &str) {
    let (indexed, leaves) = fts_indexed_and_leaves(store);
    assert_eq!(indexed, leaves, "{at}: blocks_fts rows vs live leaves");
}

fn text_hits(store: &Store, repo: &str, q: &str) -> Vec<(String, String)> {
    store
        .text_search(repo, q, 50)
        .unwrap()
        .hits
        .into_iter()
        .map(|h| (h.path, h.block_type))
        .collect()
}

const FILLER: &str = "lorem ipsum dolor sit.\n\nsit amet consectetur adipiscing.\n\nadipiscing elit sed do.\n\ndo eiusmod tempor incididunt.\n";

#[test]
fn fts_indexes_leaves_only_through_edits_and_rebuild() {
    let (mut store, repo) = fixture_store();
    observe(
        &mut store,
        &repo,
        "a.md",
        &format!(
            "# Reef\n\n- corals build reefs\n  - polyps secrete calcium\n    - zooxanthellae photosynthesize here\n- fish shelter\n\n{FILLER}"
        ),
        T0,
    );
    assert_fts_is_leaves(&store, "after ingest");
    assert_eq!(
        text_hits(&store, &repo, "zooxanthellae"),
        [("a.md".to_owned(), "list_item".to_owned())],
        "one hit, the innermost item"
    );
    let containers: i64 = store
        .conn()
        .query_row(
            &format!("SELECT count(*) FROM blocks b WHERE b.deleted_commit IS NULL AND NOT ({LIVE_LEAF_SQL})"),
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(containers, 5, "list, item, sublist, item, sub-sublist");

    // An edit re-nests; the index follows the new leaf set.
    observe(
        &mut store,
        &repo,
        "a.md",
        &format!(
            "# Reef\n\n- corals build reefs\n- zooxanthellae photosynthesize here\n\n{FILLER}"
        ),
        T1,
    );
    assert_fts_is_leaves(&store, "after edit");

    // FTS5's wholesale 'rebuild' indexes containers; ours restores the leaf set.
    let (before, _) = fts_indexed_and_leaves(&store);
    store
        .conn()
        .execute_batch("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")
        .unwrap();
    assert!(fts_indexed_and_leaves(&store).0.len() > before.len());
    store.rebuild_index(RebuildTarget::Fts).unwrap();
    assert_eq!(fts_indexed_and_leaves(&store).0, before);
    assert_fts_is_leaves(&store, "after rebuild");
}

#[test]
fn cross_document_move_of_a_list_keeps_the_fts_index_equal_to_the_leaves() {
    let (mut store, repo) = fixture_store();
    let list =
        "- kelp grows fast in cold water\n  - giant kelp forms canopies\n- otters eat urchins\n";
    store
        .observe_batch(
            &repo,
            &[
                BatchItem::observed("a.md", &format!("# A\n\n{list}\n{FILLER}")),
                BatchItem::observed("b.md", "# B\n\nquiet paragraph about quails.\n"),
            ],
            T0,
            &Config::default(),
        )
        .unwrap();
    assert_fts_is_leaves(&store, "after first batch");
    // Destination before source, so the carried ids are live foreign rows when
    // the destination evicts them (§5.4 step 8).
    let out = store
        .observe_batch(
            &repo,
            &[
                BatchItem::observed(
                    "b.md",
                    &format!("# B\n\nquiet paragraph about quails.\n\n{list}"),
                ),
                BatchItem::observed("a.md", &format!("# A\n\n{FILLER}")),
            ],
            T1,
            &Config::default(),
        )
        .unwrap();
    let b = out[0].as_observed().unwrap();
    assert!(
        b.dispositions.get("moved").is_some_and(|n| *n > 0),
        "the move was recognized: {:?}",
        kinds(b)
    );
    assert_fts_is_leaves(&store, "after the move");
    let mut kelp = text_hits(&store, &repo, "kelp");
    kelp.sort();
    assert_eq!(
        kelp,
        [
            ("b.md".to_owned(), "list_item".to_owned()),
            ("b.md".to_owned(), "paragraph".to_owned()),
        ]
    );
    assert_eq!(
        text_hits(&store, &repo, "urchins"),
        [("b.md".to_owned(), "list_item".to_owned())]
    );
}

#[test]
fn evicting_a_lists_only_child_reindexes_the_parent() {
    let (mut store, repo) = fixture_store();
    store
        .observe_batch(
            &repo,
            &[
                BatchItem::observed(
                    "a.md",
                    &format!(
                        "# A\n\n- the solitary item about lighthouses and their keepers\n\n{FILLER}"
                    ),
                ),
                BatchItem::observed("b.md", "# B\n\nquiet paragraph about quails.\n"),
            ],
            T0,
            &Config::default(),
        )
        .unwrap();
    // The item moves to b.md while a.md keeps a list with a new item;
    // destination first, so a.md's list is left childless in the table until
    // a.md commits and must be re-indexed for the source's delete pass to
    // stay symmetric.
    store
        .observe_batch(
            &repo,
            &[
                BatchItem::observed(
                    "b.md",
                    "# B\n\nquiet paragraph about quails.\n\n- the solitary item about lighthouses and their keepers\n",
                ),
                BatchItem::observed(
                    "a.md",
                    &format!("# A\n\n- a fresh replacement item about harbors\n\n{FILLER}"),
                ),
            ],
            T1,
            &Config::default(),
        )
        .unwrap();
    assert_fts_is_leaves(&store, "after the move");
    assert_eq!(
        text_hits(&store, &repo, "lighthouses"),
        [("b.md".to_owned(), "list_item".to_owned())]
    );
    assert_eq!(
        text_hits(&store, &repo, "harbors"),
        [("a.md".to_owned(), "list_item".to_owned())]
    );
}

// ---- find_doc_by_ref binds one parameter for a `d_` id (regression) --------------------

#[test]
fn find_doc_by_ref_accepts_a_doc_id_and_a_path() {
    let (mut store, repo) = fixture_store();
    let mut ds = MemDocStore::new();
    let ctx = DocOpContext {
        repo_id: repo.clone(),
        actor: None,
        ts: T0.to_owned(),
    };
    let created = store
        .docs_create(&ctx, &mut ds, "notes/x.md", "# X\n", None)
        .unwrap();
    let by_id = crate::mutate::find_doc_by_ref(store.conn(), &repo, &created.doc_id)
        .unwrap()
        .expect("found by id");
    let by_path = crate::mutate::find_doc_by_ref(store.conn(), &repo, "notes/x.md")
        .unwrap()
        .expect("found by path");
    assert_eq!(by_id.doc_id, by_path.doc_id);
    assert!(
        crate::mutate::find_doc_by_ref(store.conn(), &repo, "d_zzzzzzz")
            .unwrap()
            .is_none()
    );
}

// ---- document operations over the builders (spec/mutate §6, 3.0) ----------------------

/// The four document operations are the shared builders' effects through the
/// planner: `plan_effects` over the same effects previews exactly what each
/// operation commits (a create `"" → bytes`, a move two entries + the
/// rewritten source, a delete `bytes → ""`, a set_meta before → after), a
/// plan burns no id, and the committed operation records the Receipt whose
/// `plan_id` is that plan's.
#[test]
fn document_operations_are_planned_effects() {
    let (mut store, repo) = fixture_store();
    let mut ds = MemDocStore::new();
    let ctx = DocOpContext {
        repo_id: repo.clone(),
        actor: Some("agent:mcp".to_owned()),
        ts: T0.to_owned(),
    };
    let pctx = PlanContext {
        repo_id: repo.clone(),
        ts: T0.to_owned(),
        config: Config::default(),
    };
    let b_src = "# B\n\nTarget.\n";
    let a_src = "# A\n\nSee [b](b.md).\n";
    let b = store
        .docs_create(&ctx, &mut ds, "b.md", b_src, None)
        .unwrap();
    assert_eq!(b.doc_id, "d_0");
    assert_eq!(b.receipt.revisions[0].doc, "d_0");
    assert_eq!(
        b.receipt.new_ids[0],
        ("$new.0".to_owned(), "d_0".to_owned())
    );
    assert_eq!(b.receipt.commit.as_deref(), Some("c_0"));
    let a = store
        .docs_create(&ctx, &mut ds, "a.md", a_src, None)
        .unwrap();
    assert_eq!(a.doc_id, "d_1");
    assert_eq!(
        a.to_json(),
        serde_json::json!({ "doc": "d_1", "path": "a.md", "committed": true })
    );
    let snapshot = |store: &Store| {
        (
            count(store, "docs"),
            count(store, "commits"),
            count(store, "revisions"),
            count(store, "blocks"),
        )
    };
    let before = snapshot(&store);
    let files = ds.files().clone();
    let diffs_of = |plan: &Plan| -> Vec<(String, (String, String))> {
        plan.preview.as_ref().unwrap().diffs.clone()
    };
    let d = |b: &str, a: &str| (b.to_owned(), a.to_owned());

    // create: `"" → bytes`; the plan's symbols are the document, then its blocks.
    let fm: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(r#"{"title":"C"}"#).unwrap();
    let c = sugar::create_document("c.md", "# C", Some(&fm));
    assert_eq!(c.reason, "create c.md");
    let plan = store.plan_effects(&pctx, &c.effects, &ds).unwrap();
    assert_eq!(
        diffs_of(&plan),
        vec![("c.md".to_owned(), d("", "---\ntitle: C\n---\n\n# C\n"))]
    );
    assert_eq!(
        plan.to_json(false)["new_ids"],
        serde_json::json!([{ "symbol": "$new.0", "kind": "document" }, { "symbol": "$new.1", "kind": "block" }])
    );

    // move with retarget_inbound: the rewritten source, then the old path
    // emptied and the new path filled; the link report is the store's.
    let m = sugar::move_document("d_0", "b.md", "notes/b.md", true);
    assert_eq!(m.reason, "move b.md -> notes/b.md");
    let plan = store.plan_effects(&pctx, &m.effects, &ds).unwrap();
    assert_eq!(
        diffs_of(&plan),
        vec![
            ("a.md".to_owned(), d(a_src, "# A\n\nSee [b](notes/b.md).\n")),
            ("b.md".to_owned(), d(b_src, "")),
            ("notes/b.md".to_owned(), d("", b_src)),
        ]
    );
    let inbound = crate::links::inbound_links_to(store.conn(), &repo, "d_0", "b.md").unwrap();
    let rt = store
        .plan_inbound_retarget("d_0", "b.md", "notes/b.md", &inbound)
        .unwrap();
    assert!(rt.dangling.is_empty());
    assert_eq!(rt.blocks.len(), 1);
    assert_eq!(rt.docs, ["d_1"]);
    // … and without it: two entries.
    let m = sugar::move_document("d_0", "b.md", "notes/b.md", false);
    let plan = store.plan_effects(&pctx, &m.effects, &ds).unwrap();
    assert_eq!(diffs_of(&plan).len(), 2);

    // delete: `bytes → ""`.
    let del = sugar::delete_document("d_1", "a.md");
    assert_eq!(del.reason, "delete a.md");
    let plan = store.plan_effects(&pctx, &del.effects, &ds).unwrap();
    assert_eq!(diffs_of(&plan), vec![("a.md".to_owned(), d(a_src, ""))]);

    // set_meta: before → after.
    let set: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(r#"{"status":"open"}"#).unwrap();
    let sm = sugar::set_meta("d_1", "a.md", Some(&set), &[]);
    assert_eq!(sm.reason, "set_meta a.md");
    let plan = store.plan_effects(&pctx, &sm.effects, &ds).unwrap();
    assert_eq!(
        diffs_of(&plan),
        vec![(
            "a.md".to_owned(),
            d(a_src, "---\nstatus: open\n---\n\n# A\n\nSee [b](b.md).\n")
        )]
    );

    // Nothing was written or committed, and no id was burned: the next
    // create takes `d_2`, the id the dry run of 3.x would have consumed.
    assert_eq!(snapshot(&store), before);
    assert_eq!(ds.files(), &files);
    let real = store
        .docs_create(&ctx, &mut ds, "c.md", "# C\n", None)
        .unwrap();
    assert_eq!((real.doc_id.as_str(), real.committed), ("d_2", true));
    assert_eq!(
        real.to_json(),
        serde_json::json!({ "doc": "d_2", "path": "c.md", "committed": true })
    );
    // The pre-checks keep the library's messages and an empty `data`.
    let taken = store
        .docs_create(&ctx, &mut ds, "/c.md", "x", None)
        .unwrap_err();
    let m = expect_mutation(&taken, omgbase_mutate::ErrorCode::PathTaken);
    assert_eq!(m.message, "document already exists at c.md");
    assert!(m.data.is_empty(), "{:?}", m.data);
    let missing = store.docs_delete(&ctx, &mut ds, "nope.md").unwrap_err();
    assert_eq!(
        expect_mutation(&missing, omgbase_mutate::ErrorCode::DocMissing).message,
        "no document nope.md"
    );
    let empty = store
        .docs_set_meta(&ctx, &mut ds, "a.md", None, &[])
        .unwrap_err();
    assert!(matches!(empty, Error::InvalidEffect(_)), "{empty}");
    // A committed set_meta is a head write over the body's carries: every
    // block is `same` (bytes, parent and index unchanged — `spec/mutate` §4
    // step 5(b)), and `same` is not persisted (store 14.2), so a
    // frontmatter-only commit writes no disposition row at all.
    let patched = store
        .docs_set_meta(&ctx, &mut ds, "a.md", Some(&set), &[])
        .unwrap();
    assert_eq!(patched.receipt.revisions.len(), 1);
    let kinds: Vec<(String, String)> = {
        let mut stmt = store
            .conn()
            .prepare("SELECT kind, reason FROM dispositions WHERE commit_id = ?1 ORDER BY block_id")
            .unwrap();
        let rows = stmt
            .query_map([patched.receipt.commit.as_deref().unwrap()], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        rows.map(|r| r.unwrap()).collect()
    };
    assert!(kinds.is_empty(), "{kinds:?}");
    assert!(
        ds.read("a.md")
            .unwrap()
            .unwrap()
            .starts_with("---\nstatus: open\n")
    );
    // An absent actor records NULL (a fixture `docs` step without one).
    let anon = DocOpContext {
        actor: None,
        ..ctx.clone()
    };
    let r = store.docs_delete(&anon, &mut ds, "c.md").unwrap();
    let actor: Option<String> = store
        .conn()
        .query_row(
            "SELECT actor FROM commits WHERE commit_id = ?1",
            [r.receipt.commit.as_deref().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(actor, None);
}

// ---- transaction hygiene: the statement stream ---------------------------------------
//
// `Connection::trace_v2` (rusqlite's `trace` feature, dev-only) records every
// statement this thread runs; a write "rides a transaction" when a `BEGIN`
// precedes it with no `COMMIT`/`ROLLBACK` between, and a `COMMIT` follows.

thread_local! {
    static TRACE: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn record_stmt(e: rusqlite::trace::TraceEvent<'_>) {
    if let rusqlite::trace::TraceEvent::Stmt(_, sql) = e {
        TRACE.with(|t| t.borrow_mut().push(sql.trim().to_owned()));
    }
}

/// Start (or restart) recording this thread's statements on `conn`.
fn start_trace(conn: &Connection) {
    TRACE.with(|t| t.borrow_mut().clear());
    conn.trace_v2(
        rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
        Some(record_stmt),
    );
}

fn traced() -> Vec<String> {
    TRACE.with(|t| t.borrow().clone())
}

/// The index of the `BEGIN` opening the transaction the first statement
/// matching `needle` ran in — `None` when it ran in autocommit (no open
/// `BEGIN`, or the transaction rolled back). Panics when nothing matches.
fn tx_of(log: &[String], needle: &str) -> Option<usize> {
    let i = log
        .iter()
        .position(|s| s.contains(needle))
        .unwrap_or_else(|| panic!("no statement matching {needle:?} in {log:#?}"));
    let begin = log[..i].iter().rposition(|s| s.starts_with("BEGIN"))?;
    if log[begin..i]
        .iter()
        .any(|s| s.starts_with("COMMIT") || s.starts_with("ROLLBACK"))
    {
        return None;
    }
    let end = log[i..]
        .iter()
        .position(|s| {
            s.starts_with("COMMIT") || s.starts_with("ROLLBACK") || s.starts_with("BEGIN")
        })
        .map(|k| i + k)?;
    log[end].starts_with("COMMIT").then_some(begin)
}

const CONFLICT: &str = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\n";
const FLAG_UPDATE: &str = "file_hash = ?2, conflicted = ?3";

fn conflicted_flag(store: &Store) -> i64 {
    store
        .conn()
        .query_row("SELECT conflicted FROM docs", [], |r| r.get(0))
        .unwrap()
}

/// §5.4 step 12: the observed path writes `docs.conflicted` with the
/// pointers, inside the commit's transaction — never as an autocommit after
/// it — and the `api`/reconciling path leaves the column alone.
#[test]
fn conflicted_flag_is_written_inside_the_ingest_transaction() {
    let (mut store, repo) = fixture_store();
    start_trace(store.conn());
    let o = observe(&mut store, &repo, "a.md", CONFLICT, T0);
    assert!(o.conflicted);
    assert_eq!(conflicted_flag(&store), 1);
    let log = traced();
    let flag_tx = tx_of(&log, FLAG_UPDATE);
    assert!(
        flag_tx.is_some(),
        "the flag update rides a transaction: {log:#?}"
    );
    assert_eq!(
        flag_tx,
        tx_of(&log, "INSERT INTO commits"),
        "… the commit's own transaction: {log:#?}"
    );
    assert!(
        !log.iter()
            .any(|s| s.starts_with("UPDATE docs SET conflicted")),
        "no standalone flag update: {log:#?}"
    );

    // The api / reconciling ingest (`docs_create`, `docs_set_meta`, the sync
    // layer's recovery) never touches the flag: a clean source through it
    // leaves the row conflicted, as before.
    start_trace(store.conn());
    store
        .reconciling_ingest(
            &repo,
            "a.md",
            "resolved by api\n",
            T1,
            Origin::Api,
            Some("t"),
            None,
            &Config::default(),
        )
        .unwrap();
    assert_eq!(conflicted_flag(&store), 1, "api ingest leaves the flag");
    let log = traced();
    assert!(
        !log.iter().any(|s| s.contains("conflicted =")),
        "api ingest never names the column: {log:#?}"
    );
    assert!(
        tx_of(
            &log,
            "UPDATE docs SET current_rev = ?1, file_hash = ?2 WHERE"
        )
        .is_some()
    );

    // The next observation clears it — again inside its commit.
    start_trace(store.conn());
    let o = observe(&mut store, &repo, "a.md", "resolved\n", T2);
    assert!(!o.conflicted);
    assert_eq!(conflicted_flag(&store), 0);
    let log = traced();
    assert_eq!(tx_of(&log, FLAG_UPDATE), tx_of(&log, "INSERT INTO commits"));
    assert!(tx_of(&log, FLAG_UPDATE).is_some(), "{log:#?}");
}

/// `observe_delete`: the tombstone is one transaction; the trailing pool
/// sweep is its own autocommit (a one-liner that cannot half-apply).
#[test]
fn observe_delete_tombstones_in_one_transaction() {
    let (mut store, repo) = fixture_store();
    observe(&mut store, &repo, "a.md", "# A\n\nOne.\n", T0);
    start_trace(store.conn());
    let d = store.observe_delete(&repo, "a.md", T1).unwrap();
    assert!(d.doc_id.is_some());
    let log = traced();
    let tomb = tx_of(&log, "UPDATE docs SET deleted_commit");
    assert!(tomb.is_some(), "{log:#?}");
    assert_eq!(tomb, tx_of(&log, "INSERT INTO commits"));
    assert_eq!(tomb, tx_of(&log, "UPDATE blocks SET deleted_commit"));
    assert_eq!(
        tomb,
        tx_of(&log, "INSERT OR REPLACE INTO resurrection_pool")
    );
    assert_eq!(
        tx_of(&log, "DELETE FROM resurrection_pool WHERE expires_ts"),
        None,
        "the sweep is a separate autocommit: {log:#?}"
    );
}

// ---- the api path: one request, one transaction, one commit (store 13.7) -----------------

fn api_origin() -> ApplyOrigin {
    ApplyOrigin::new("agent:test", Some("fixture"))
}

fn insert_end(doc: &str, markdown: &str) -> Op {
    Op::Insert {
        doc: Some(doc.to_owned()),
        to: To {
            parent: Parent::Doc,
            at: At::End,
        },
        markdown: markdown.to_owned(),
        expect: None,
    }
}

fn commits_by_origin(store: &Store, origin: &str) -> i64 {
    store
        .conn()
        .query_row(
            "SELECT count(*) FROM commits WHERE origin = ?1",
            params![origin],
            |r| r.get(0),
        )
        .unwrap()
}

fn current_revs(store: &Store) -> Vec<(String, String)> {
    let mut stmt = store
        .conn()
        .prepare("SELECT path, current_rev FROM docs ORDER BY path")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

/// Observe `files` into the store at `T0` and seed the doc store with them.
fn seeded(files: &[(&str, &str)]) -> (Store, String, MemDocStore) {
    let (mut store, repo) = fixture_store();
    let mut ds = MemDocStore::new();
    let items: Vec<BatchItem> = files
        .iter()
        .map(|(p, s)| BatchItem::observed(p, s))
        .collect();
    store
        .observe_batch(&repo, &items, T0, &Config::default())
        .unwrap();
    for (p, s) in files {
        ds.write(p, s).unwrap();
    }
    (store, repo, ds)
}

/// `spec/mutate` §4 step 5 (2.1): a changeset over N documents is one
/// `commits` row with N `revisions`; every block the request wrote carries
/// that row as `created_commit`, and `changes_since` shows one digest with
/// the N revisions. Ids mint `c` once, then `r` per document in load order.
#[test]
fn a_changeset_is_one_commit_with_n_revisions() {
    let (mut store, repo, mut ds) =
        seeded(&[("a.md", "# A\n\nAlpha.\n"), ("b.md", "# B\n\nBravo.\n")]);
    assert_eq!(count(&store, "commits"), 2);
    start_trace(store.conn());
    let res = store
        .apply(
            &ApplyRequest {
                repo_id: repo.clone(),
                ops: vec![insert_end("a.md", "A tail."), insert_end("b.md", "B tail.")],
                origin: api_origin(),
                dry_run: false,
            },
            &mut ds,
            T1,
        )
        .unwrap();
    assert!(res.committed);
    assert_eq!(res.revisions.len(), 2);
    let log = traced();
    assert_eq!(
        log.iter()
            .filter(|s| s.starts_with("INSERT INTO commits"))
            .count(),
        1,
        "one commit row for the request: {log:#?}"
    );
    let tx = tx_of(&log, "INSERT INTO commits");
    assert!(tx.is_some());
    assert_eq!(tx, tx_of(&log, "INSERT INTO revisions"), "{log:#?}");
    assert_eq!(count(&store, "commits"), 3);
    assert_eq!(commits_by_origin(&store, "api"), 1);
    let revs: Vec<(String, String, String)> = {
        let mut stmt = store
            .conn()
            .prepare("SELECT rev_id, doc_id, commit_id FROM revisions WHERE commit_id = 'c_2' ORDER BY rowid")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(
        revs,
        vec![
            ("r_2".into(), "d_0".into(), "c_2".into()),
            ("r_3".into(), "d_1".into(), "c_2".into()),
        ],
        "c once, then r per document in load order"
    );
    let created: Vec<String> = {
        let mut stmt = store
            .conn()
            .prepare("SELECT DISTINCT created_commit FROM blocks WHERE deleted_commit IS NULL")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(
        created,
        vec!["c_2".to_owned()],
        "every live block restamped by the shared row"
    );
    assert_eq!(
        current_revs(&store),
        vec![("a.md".into(), "r_2".into()), ("b.md".into(), "r_3".into())]
    );
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("# A\n\nAlpha.\n\nA tail.\n")
    );
    assert_eq!(
        ds.read("b.md").unwrap().as_deref(),
        Some("# B\n\nBravo.\n\nB tail.\n")
    );

    let page = store.changes_since(&repo, 2, 50, None).unwrap();
    assert_eq!(page.digests.len(), 1, "one digest for the request");
    let d = &page.digests[0];
    assert_eq!(d.commit, "c_2");
    assert_eq!(d.revisions.len(), 2);
    assert_eq!(d.revisions[0].path, "a.md");
    assert_eq!(d.revisions[1].path, "b.md");
    // The two appended tails are `inserted`; the four carried blocks are
    // `same` — bytes, parent and index unchanged (`spec/mutate` §4 step
    // 5(b)) — and not persisted (store 14.2; through 14.1 the summary read
    // `4 edited, 2 inserted`).
    assert_eq!(d.summary, "api(agent:test): a.md, b.md — 2 inserted");
}

/// §4 step 5 + §10 Fixed (2.1): every loaded document's disk bytes are
/// compared inside the transaction before anything is minted or written, so
/// a dirty third document aborts the whole request — no `api` commit row, no
/// revision, no pending row, the first two files untouched; the dirty bytes
/// are ingested as one `observed` commit and the request fails
/// `sync_conflict` (retriable).
#[test]
fn a_dirty_third_document_commits_nothing() {
    let (mut store, repo, mut ds) = seeded(&[
        ("a.md", "# A\n\nAlpha.\n"),
        ("b.md", "# B\n\nBravo.\n"),
        ("c.md", "# C\n\nCharlie.\n"),
    ]);
    ds.write("c.md", "# C\n\nCharlie, by a human.\n").unwrap();
    let before = current_revs(&store);
    start_trace(store.conn());
    let err = store
        .apply(
            &ApplyRequest {
                repo_id: repo.clone(),
                ops: vec![
                    insert_end("a.md", "A tail."),
                    insert_end("b.md", "B tail."),
                    insert_end("c.md", "C tail."),
                ],
                origin: api_origin(),
                dry_run: false,
            },
            &mut ds,
            T1,
        )
        .unwrap_err();
    match &err {
        Error::Mutation(m) => {
            assert_eq!(m.code, omgbase_mutate::ErrorCode::SyncConflict);
            assert_eq!(m.data["retriable"], serde_json::json!(true));
        }
        other => panic!("expected sync_conflict, got {other:?}"),
    }
    assert_eq!(commits_by_origin(&store, "api"), 0, "no api row at all");
    assert_eq!(
        commits_by_origin(&store, "observed"),
        4,
        "the three + c.md's disk bytes"
    );
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("# A\n\nAlpha.\n"),
        "the commit validated before any file was written"
    );
    assert_eq!(count(&store, "pending_materializations"), 0);
    assert_eq!(ds.read("b.md").unwrap().as_deref(), Some("# B\n\nBravo.\n"));
    let after = current_revs(&store);
    assert_eq!(after[0], before[0]);
    assert_eq!(after[1], before[1]);
    assert_ne!(after[2], before[2], "c.md advanced by the observed ingest");
    assert_eq!(
        store.reconstruct("d_2").unwrap().as_deref(),
        Some("# C\n\nCharlie, by a human.\n")
    );
    let log = traced();
    assert_eq!(
        log.iter()
            .filter(|s| s.starts_with("INSERT INTO commits"))
            .count(),
        1,
        "only the observed ingest wrote a commit: {log:#?}"
    );
}

/// §6 `docs_move` (2.1): the rename and its inbound retarget are one
/// transaction and one `api` commit (`move <from> -> <to>`), the rewritten
/// source's revision under it; the moved document's own revision does not
/// advance (it is not a source here); the digest reads `moved a → b; src —
/// …`. A moved document that links to itself by path IS a source: loaded
/// under the old path, it is written and ingested under the new one, so one
/// `docs` row remains.
#[test]
fn docs_move_with_retarget_is_one_commit() {
    let (mut store, repo) = fixture_store();
    let mut ds = MemDocStore::new();
    let ctx = DocOpContext {
        repo_id: repo.clone(),
        actor: Some("agent:mcp".to_owned()),
        ts: T0.to_owned(),
    };
    store
        .docs_create(&ctx, &mut ds, "b.md", "# B\n\nTarget.\n", None)
        .unwrap();
    store
        .docs_create(&ctx, &mut ds, "a.md", "# A\n\nSee [b](b.md).\n", None)
        .unwrap();
    assert_eq!(count(&store, "commits"), 2);
    let ctx1 = DocOpContext {
        ts: T1.to_owned(),
        ..ctx.clone()
    };
    start_trace(store.conn());
    let moved = store
        .docs_move(&ctx1, &mut ds, "b.md", "n/b.md", true)
        .unwrap();
    assert_eq!(moved.doc_id, "d_0");
    assert_eq!(moved.path, "n/b.md");
    assert_eq!(
        moved.retargeted.as_ref().unwrap().docs,
        vec!["d_1".to_owned()]
    );
    assert!(moved.dangling.is_empty());
    let log = traced();
    assert_eq!(
        log.iter()
            .filter(|s| s.starts_with("INSERT INTO commits"))
            .count(),
        1,
        "{log:#?}"
    );
    let tx = tx_of(&log, "INSERT INTO commits");
    assert!(tx.is_some());
    assert_eq!(tx, tx_of(&log, "UPDATE docs SET path"), "{log:#?}");
    assert_eq!(tx, tx_of(&log, "INSERT INTO revisions"), "{log:#?}");
    assert_eq!(count(&store, "commits"), 3);
    let (reason, revs): (String, i64) = store
        .conn()
        .query_row(
            "SELECT reason, (SELECT count(*) FROM revisions WHERE commit_id = 'c_2') FROM commits WHERE commit_id = 'c_2'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(reason, "move b.md -> n/b.md");
    assert_eq!(revs, 1, "the rewritten source only");
    assert_eq!(
        current_revs(&store),
        vec![
            ("a.md".into(), "r_2".into()),
            ("n/b.md".into(), "r_0".into())
        ],
        "the moved doc's revision does not advance"
    );
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("# A\n\nSee [b](n/b.md).\n")
    );
    assert_eq!(
        ds.read("n/b.md").unwrap().as_deref(),
        Some("# B\n\nTarget.\n")
    );
    assert!(!ds.exists("b.md"));
    // The source's edge resolves to the moved document, not a phantom.
    let dst: String = store
        .conn()
        .query_row(
            "SELECT dst_node FROM edges WHERE src_doc = 'd_1' AND to_commit IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(dst, "d_0");
    let page = store.changes_since(&repo, 2, 50, None).unwrap();
    assert_eq!(page.digests.len(), 1);
    // Only the paragraph whose link was rewritten is `edited`; the heading's
    // `same` carry leaves no row (store 14.2; `2 edited` through 14.1).
    assert_eq!(
        page.digests[0].summary,
        "api(agent:mcp): moved b.md → n/b.md; a.md — 1 edited"
    );
    assert_eq!(page.digests[0].revisions.len(), 1);
    assert_eq!(page.digests[0].revisions[0].path, "a.md");

    // The self-link hazard: a document whose link names its own path.
    let ctx2 = DocOpContext {
        ts: T2.to_owned(),
        ..ctx.clone()
    };
    store
        .docs_create(&ctx2, &mut ds, "s.md", "# S\n\nSee [me](/s.md).\n", None)
        .unwrap();
    let docs_before = count(&store, "docs");
    let moved = store
        .docs_move(&ctx2, &mut ds, "s.md", "t/s.md", true)
        .unwrap();
    assert_eq!(
        moved.retargeted.as_ref().unwrap().docs,
        vec![moved.doc_id.clone()]
    );
    assert_eq!(
        count(&store, "docs"),
        docs_before,
        "no second row at the new path"
    );
    let (path, rev_path): (String, String) = store
        .conn()
        .query_row(
            "SELECT d.path, r.path FROM docs d JOIN revisions r ON r.rev_id = d.current_rev WHERE d.doc_id = ?1",
            params![moved.doc_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(path, "t/s.md");
    assert_eq!(
        rev_path, "t/s.md",
        "the retarget's revision names the new path"
    );
    assert_eq!(
        ds.read("t/s.md").unwrap().as_deref(),
        Some("# S\n\nSee [me](/t/s.md).\n")
    );
    assert!(!ds.exists("s.md"));
    assert_eq!(
        store.reconstruct(&moved.doc_id).unwrap().as_deref(),
        ds.read("t/s.md").unwrap().as_deref()
    );
}

/// A failure inside the commit transaction rolls the whole request back —
/// no commit, no revision, no pending row, every block as before — and,
/// since 14.0 writes files only after COMMIT, **no file is touched**: the
/// next observation of each file is an echo (§10 "Fixed (2.2)": the 2.1
/// pin of files left ahead of the database is gone).
#[test]
fn a_failure_in_the_commit_phase_rolls_back_and_touches_no_file() {
    let (mut store, repo, mut ds) =
        seeded(&[("a.md", "# A\n\nAlpha.\n"), ("b.md", "# B\n\nBravo.\n")]);
    let before = current_revs(&store);
    let blocks_before = count(&store, "blocks");
    // Step 10 of the ingest writes `dispositions`; take the table away so
    // the ingest fails inside the transaction, after the commit row, the
    // revision and the blocks are in (no mint probes that table, so the
    // request reaches BEGIN).
    store
        .conn()
        .execute("ALTER TABLE dispositions RENAME TO dispositions_gone", [])
        .unwrap();
    start_trace(store.conn());
    let err = store
        .apply(
            &ApplyRequest {
                repo_id: repo.clone(),
                ops: vec![insert_end("a.md", "A tail."), insert_end("b.md", "B tail.")],
                origin: api_origin(),
                dry_run: false,
            },
            &mut ds,
            T1,
        )
        .unwrap_err();
    assert!(matches!(err, Error::Sqlite(_)), "{err}");
    let log = traced();
    assert!(
        log.iter().any(|s| s.starts_with("ROLLBACK")),
        "the transaction rolled back: {log:#?}"
    );
    assert!(
        log.iter().any(|s| s.starts_with("INSERT INTO revisions")),
        "it got as far as a revision before failing: {log:#?}"
    );
    assert_eq!(count(&store, "commits"), 2, "no commit row survives");
    assert_eq!(count(&store, "revisions"), 2);
    assert_eq!(count(&store, "blocks"), blocks_before);
    assert_eq!(count(&store, "pending_materializations"), 0);
    assert_eq!(current_revs(&store), before);
    assert_eq!(
        store.reconstruct("d_0").unwrap().as_deref(),
        Some("# A\n\nAlpha.\n")
    );
    // Nothing reached the working tree.
    assert_eq!(ds.read("a.md").unwrap().as_deref(), Some("# A\n\nAlpha.\n"));
    assert_eq!(ds.read("b.md").unwrap().as_deref(), Some("# B\n\nBravo.\n"));

    store
        .conn()
        .execute("ALTER TABLE dispositions_gone RENAME TO dispositions", [])
        .unwrap();
    for path in ["a.md", "b.md"] {
        let bytes = ds.read(path).unwrap().unwrap();
        let o = observe(&mut store, &repo, path, &bytes, T2);
        assert!(o.echo, "{path}: the file never diverged: {o:?}");
    }
    assert_eq!(commits_by_origin(&store, "observed"), 2);
    assert_eq!(commits_by_origin(&store, "api"), 0);
}

/// §6 `docs_delete` is one transaction with one `api` commit and no
/// revision; nothing is pooled; the file goes after the commit.
#[test]
fn docs_delete_is_one_commit_without_pooling() {
    let (mut store, repo, mut ds) = seeded(&[("a.md", "# A\n\nAlpha.\n")]);
    let ctx = DocOpContext {
        repo_id: repo.clone(),
        actor: Some("agent:mcp".to_owned()),
        ts: T1.to_owned(),
    };
    start_trace(store.conn());
    let res = store.docs_delete(&ctx, &mut ds, "a.md").unwrap();
    assert!(res.committed);
    let log = traced();
    let tx = tx_of(&log, "INSERT INTO commits");
    assert!(tx.is_some());
    assert_eq!(
        tx,
        tx_of(&log, "UPDATE docs SET deleted_commit"),
        "{log:#?}"
    );
    assert_eq!(
        tx,
        tx_of(&log, "UPDATE blocks SET deleted_commit"),
        "{log:#?}"
    );
    assert!(
        !log.iter().any(|s| s.contains("INTO resurrection_pool")),
        "{log:#?}"
    );
    assert_eq!(count(&store, "resurrection_pool"), 0);
    assert_eq!(count(&store, "revisions"), 1);
    let reason: String = store
        .conn()
        .query_row("SELECT reason FROM commits WHERE origin = 'api'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(reason, "delete a.md");
    assert!(!ds.exists("a.md"));
    assert_eq!(
        tx,
        tx_of(&log, "INSERT OR REPLACE INTO pending_materializations"),
        "the remove intent rides the commit: {log:#?}"
    );
    assert_eq!(
        count(&store, "pending_materializations"),
        0,
        "… and is fulfilled"
    );
    let page = store.changes_since(&repo, 1, 50, None).unwrap();
    assert_eq!(page.digests[0].summary, "api(agent:mcp): deleted a.md");
}

// ---- CAS inside the transaction (mutate 2.2) ----------------------------------------------

/// A file-backed store under the sequential minter, so a second connection
/// can reach the same database between the phases of a request.
fn file_store() -> (Store, String, std::path::PathBuf, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("omgbase-store-{}", ids::random_suffix()));
    let path = dir.join("omgbase.db");
    let mut store = Store::open_with_minter(&path, Box::new(SequentialMinter::new())).unwrap();
    let repo = store.create_repo("fixture").unwrap();
    assert_eq!(repo, "rp_0");
    (store, repo, dir, path)
}

/// `seeded` on a file-backed store.
fn file_seeded(
    files: &[(&str, &str)],
) -> (
    Store,
    String,
    MemDocStore,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    let (mut store, repo, dir, path) = file_store();
    let mut ds = MemDocStore::new();
    let items: Vec<BatchItem> = files
        .iter()
        .map(|(p, s)| BatchItem::observed(p, s))
        .collect();
    store
        .observe_batch(&repo, &items, T0, &Config::default())
        .unwrap();
    for (p, s) in files {
        ds.write(p, s).unwrap();
    }
    (store, repo, ds, dir, path)
}

fn one_op(repo: &str, doc: &str) -> ApplyRequest {
    ApplyRequest {
        repo_id: repo.to_owned(),
        ops: vec![insert_end(doc, "A tail.")],
        origin: api_origin(),
        dry_run: false,
    }
}

/// §4 step 5 (a) by hand, up to and excluding the transaction: the reads
/// `apply` runs after the ops, so a test can interleave a second connection
/// between staging and the commit. Nothing is written (14.0).
fn staged_effects(loaded: &[crate::mutate::LoadedDoc], ds: &MemDocStore) -> Vec<Effect> {
    let on_disk = crate::mutate::read_on_disk(loaded, ds).unwrap();
    crate::mutate::stage(loaded, on_disk, |d| d.doc.path.clone())
        .into_iter()
        .map(crate::mutate::Staged::into_effect)
        .collect()
}

const API_HEAD: CommitHead<'static> = CommitHead {
    origin: Origin::Api,
    actor: Some("agent:test"),
    reason: Some("fixture"),
    clear_pending: false,
    ops: None,
};

fn expect_mutation(err: &Error, code: omgbase_mutate::ErrorCode) -> &omgbase_mutate::MutationError {
    match err {
        Error::Mutation(m) if m.code == code => m,
        other => panic!("expected {code:?}, got {other:?}"),
    }
}

/// 2.2: a second connection advancing `docs.current_rev` after the plan
/// was computed is caught inside the transaction — `stale_plan` carrying
/// the current truth (the shape `docs_update` emits), the transaction
/// rolled back before the commit row, no id minted (the next `c` is the one
/// the request would have taken), and — 14.0 — **no file written**: the
/// rendered bytes exist only in the rolled-back request.
#[test]
fn a_concurrent_revision_between_plan_and_commit_is_stale_plan() {
    let (mut store, repo, ds, dir, path) = file_seeded(&[("a.md", "# A\n\nAlpha.\n")]);
    let hash = hex(&sha256("# A\n\nAlpha.\n".as_bytes()));
    let loaded = store.apply_ops(&one_op(&repo, "a.md")).unwrap().loaded;
    let base = loaded[0].base.as_ref().expect("a loaded row has a base");
    assert_eq!(base.current_rev.as_deref(), Some("r_0"));
    assert_eq!(base.file_hash.as_deref().map(hex), Some(hash.clone()));
    let effects = staged_effects(&loaded, &ds);
    // Another writer commits a revision underneath the plan.
    let other = Connection::open(&path).unwrap();
    other
        .execute(
            "UPDATE docs SET current_rev = 'r_9' WHERE path = 'a.md'",
            [],
        )
        .unwrap();
    start_trace(store.conn());
    let err = store
        .commit_effects(&repo, &API_HEAD, &effects, T1)
        .unwrap_err();
    let m = expect_mutation(&err, omgbase_mutate::ErrorCode::StalePlan);
    assert_eq!(
        serde_json::Value::Object(m.data.clone()),
        serde_json::json!({
            "doc": "d_0",
            "expected_revision": "r_0",
            "current": { "revision": "r_9", "hash": hash },
            "retriable": true,
        })
    );
    let log = traced();
    assert!(
        log.iter().any(|s| s.starts_with("BEGIN IMMEDIATE")),
        "{log:#?}"
    );
    assert!(log.iter().any(|s| s.starts_with("ROLLBACK")), "{log:#?}");
    assert!(
        !log.iter().any(|s| s.starts_with("INSERT INTO commits")),
        "validation runs before the commit row: {log:#?}"
    );
    assert_eq!(count(&store, "commits"), 1, "no commit row");
    assert_eq!(count(&store, "revisions"), 1);
    assert_eq!(count(&store, "pending_materializations"), 0, "no intent");
    assert_eq!(store.mint("c").unwrap(), "c_1", "no id burned");
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("# A\n\nAlpha.\n"),
        "nothing written: the file is exactly as it was"
    );
    drop(other);
    store.close().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

/// 2.2: `docs.path` changed by a concurrent move (a move advances no
/// revision) is a `stale_plan` too — the triple, not the revision alone,
/// is the precondition.
#[test]
fn a_concurrent_move_between_plan_and_commit_is_stale_plan() {
    let (mut store, repo, ds, dir, path) = file_seeded(&[("a.md", "# A\n\nAlpha.\n")]);
    let loaded = store.apply_ops(&one_op(&repo, "a.md")).unwrap().loaded;
    let effects = staged_effects(&loaded, &ds);
    let other = Connection::open(&path).unwrap();
    other
        .execute("UPDATE docs SET path = 'z.md' WHERE doc_id = 'd_0'", [])
        .unwrap();
    let err = store
        .commit_effects(&repo, &API_HEAD, &effects, T1)
        .unwrap_err();
    let m = expect_mutation(&err, omgbase_mutate::ErrorCode::StalePlan);
    assert_eq!(m.data["doc"], "d_0");
    assert_eq!(m.data["expected_revision"], "r_0");
    assert_eq!(
        m.data["current"]["revision"], "r_0",
        "the revision did not move; the path did"
    );
    assert_eq!(count(&store, "commits"), 1);
    assert_eq!(store.mint("c").unwrap(), "c_1", "no id burned");
    assert_eq!(ds.read("a.md").unwrap().as_deref(), Some("# A\n\nAlpha.\n"));
    drop(other);
    store.close().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

/// A file edited after the plan's load (and after phase (a) would have
/// read it, had the request been split): the request reads the disk bytes
/// outside the transaction and compares them with the row's `file_hash`
/// **inside** it — 14.0 has no file-first short-circuit, the in-transaction
/// compare is the one check. The human's bytes are ingested as one
/// `observed` commit, the request fails `sync_conflict`, and nothing is
/// written or recorded.
#[test]
fn a_disk_edit_after_the_plan_is_caught_inside_the_transaction_before_any_write() {
    let (mut store, repo, mut ds) = seeded(&[("a.md", "# A\n\nAlpha.\n")]);
    ds.write("a.md", "# A\n\nAlpha, by a human.\n").unwrap();
    start_trace(store.conn());
    let err = store
        .apply(&one_op(&repo, "a.md"), &mut ds, T1)
        .unwrap_err();
    let m = expect_mutation(&err, omgbase_mutate::ErrorCode::SyncConflict);
    assert_eq!(m.data["retriable"], serde_json::json!(true));
    let log = traced();
    let begins: Vec<usize> = (0..log.len())
        .filter(|&i| log[i].starts_with("BEGIN"))
        .collect();
    assert!(
        log[begins[0]].starts_with("BEGIN IMMEDIATE"),
        "the request's transaction opened first: {log:#?}"
    );
    assert!(
        log.iter().any(|s| s.starts_with("ROLLBACK")),
        "… and rolled back: {log:#?}"
    );
    assert!(
        !log.iter()
            .any(|s| s.contains("INTO pending_materializations")),
        "no intent recorded: {log:#?}"
    );
    assert_eq!(commits_by_origin(&store, "observed"), 2, "one observed row");
    assert_eq!(commits_by_origin(&store, "api"), 0);
    assert_eq!(count(&store, "pending_materializations"), 0);
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("# A\n\nAlpha, by a human.\n"),
        "nothing written"
    );
    assert_eq!(
        store.reconstruct("d_0").unwrap().as_deref(),
        Some("# A\n\nAlpha, by a human.\n")
    );
}

/// The in-transaction disk check on its own: an `ingest_known` whose
/// phase-(a) bytes do not hash to the row's `file_hash` comes back as
/// `Outcome::Conflict` with those bytes, the transaction rolled back before
/// the commit row (no id minted); the caller's `disk_conflict` then ingests
/// them `observed` in a transaction of its own and raises `sync_conflict`.
#[test]
fn the_in_tx_disk_check_returns_a_conflict_without_minting() {
    let (mut store, repo, ds) = seeded(&[("a.md", "# A\n\nAlpha.\n")]);
    let loaded = store.apply_ops(&one_op(&repo, "a.md")).unwrap().loaded;
    let mut effects = staged_effects(&loaded, &ds);
    let human = "# A\n\nSomeone else.\n";
    match &mut effects[0] {
        Effect::IngestKnown {
            guard: crate::effects::Guard::Doc { on_disk, .. },
            ..
        } => *on_disk = Some(human.to_owned()),
        other => panic!("{other:?}"),
    }
    start_trace(store.conn());
    let out = store
        .commit_effects(&repo, &API_HEAD, &effects, T1)
        .unwrap();
    let conflict = match out {
        Outcome::Conflict(c) => c,
        Outcome::Committed(c) => panic!("committed {c:?}"),
    };
    assert_eq!(conflict.path, "a.md");
    assert_eq!(conflict.bytes, human);
    let log = traced();
    assert!(
        log.iter().any(|s| s.starts_with("BEGIN IMMEDIATE")),
        "{log:#?}"
    );
    assert!(log.iter().any(|s| s.starts_with("ROLLBACK")), "{log:#?}");
    assert!(
        !log.iter().any(|s| s.starts_with("INSERT INTO commits")),
        "{log:#?}"
    );
    assert_eq!(count(&store, "commits"), 1);
    assert_eq!(store.mint("c").unwrap(), "c_1", "no id burned");
    let err = store.disk_conflict(&repo, &conflict.path, &conflict.bytes, T1);
    let m = expect_mutation(&err, omgbase_mutate::ErrorCode::SyncConflict);
    assert_eq!(m.data["retriable"], serde_json::json!(true));
    assert_eq!(commits_by_origin(&store, "observed"), 2);
    assert_eq!(commits_by_origin(&store, "api"), 0);
    assert_eq!(store.reconstruct("d_0").unwrap().as_deref(), Some(human));
}

/// §6 `docs_set_meta` (2.2): the file it patches must hash to the
/// document's `file_hash` — a dirty file is ingested `observed` and the
/// operation fails `sync_conflict`, the patch unwritten (today's unchecked
/// gap closed; the precondition is the same as a changeset's).
#[test]
fn docs_set_meta_on_a_dirty_file_is_a_sync_conflict() {
    let (mut store, repo, mut ds) = seeded(&[("a.md", "# A\n\nAlpha.\n")]);
    ds.write("a.md", "# A\n\nAlpha, by a human.\n").unwrap();
    let ctx = DocOpContext {
        repo_id: repo.clone(),
        actor: Some("agent:mcp".to_owned()),
        ts: T1.to_owned(),
    };
    let mut set = serde_json::Map::new();
    set.insert("status".to_owned(), serde_json::json!("done"));
    let err = store
        .docs_set_meta(&ctx, &mut ds, "a.md", Some(&set), &[])
        .unwrap_err();
    let m = expect_mutation(&err, omgbase_mutate::ErrorCode::SyncConflict);
    assert_eq!(m.data["retriable"], serde_json::json!(true));
    assert_eq!(commits_by_origin(&store, "observed"), 2);
    assert_eq!(commits_by_origin(&store, "api"), 0);
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("# A\n\nAlpha, by a human.\n"),
        "the patch is not written"
    );
    assert_eq!(
        store.reconstruct("d_0").unwrap().as_deref(),
        Some("# A\n\nAlpha, by a human.\n")
    );
    // Retried, it succeeds against the healed row.
    let res = store
        .docs_set_meta(&ctx, &mut ds, "a.md", Some(&set), &[])
        .unwrap();
    assert!(res.committed);
    assert_eq!(commits_by_origin(&store, "api"), 1);
    assert!(
        ds.read("a.md")
            .unwrap()
            .unwrap()
            .starts_with("---\nstatus: done\n")
    );
}

/// `move_path` and `tombstone` re-validate too: the moved document must
/// still be at `from` with its revision (`stale_plan`), a document that
/// appeared at `to` is `path_taken`, a vanished document `doc_missing`; a
/// tombstone needs the document live at the captured revision.
#[test]
fn move_path_and_tombstone_revalidate_inside_the_transaction() {
    let (mut store, repo, _ds) =
        seeded(&[("a.md", "# A\n\nAlpha.\n"), ("b.md", "# B\n\nBravo.\n")]);
    let stale_move = Effect::MovePath {
        doc_id: "d_0".into(),
        from: "a.md".into(),
        to: "c.md".into(),
        current_rev: Some("r_7".into()),
        inbound: Vec::new(),
    };
    let err = store
        .commit_effects(&repo, &API_HEAD, &[stale_move], T1)
        .unwrap_err();
    let m = expect_mutation(&err, omgbase_mutate::ErrorCode::StalePlan);
    assert_eq!(m.data["expected_revision"], "r_7");
    assert_eq!(m.data["current"]["revision"], "r_0");

    let taken = Effect::MovePath {
        doc_id: "d_0".into(),
        from: "a.md".into(),
        to: "b.md".into(),
        current_rev: Some("r_0".into()),
        inbound: Vec::new(),
    };
    let err = store
        .commit_effects(&repo, &API_HEAD, &[taken], T1)
        .unwrap_err();
    expect_mutation(&err, omgbase_mutate::ErrorCode::PathTaken);

    let gone = Effect::Tombstone {
        doc_id: "d_9".into(),
        path: "z.md".into(),
        pool: false,
        current_rev: None,
    };
    let err = store
        .commit_effects(&repo, &API_HEAD, &[gone], T1)
        .unwrap_err();
    expect_mutation(&err, omgbase_mutate::ErrorCode::DocMissing);

    let stale_tomb = Effect::Tombstone {
        doc_id: "d_1".into(),
        path: "b.md".into(),
        pool: false,
        current_rev: Some("r_0".into()),
    };
    let err = store
        .commit_effects(&repo, &API_HEAD, &[stale_tomb], T1)
        .unwrap_err();
    let m = expect_mutation(&err, omgbase_mutate::ErrorCode::StalePlan);
    assert_eq!(m.data["doc"], "d_1");
    assert_eq!(m.data["current"]["revision"], "r_1");

    assert_eq!(count(&store, "commits"), 2, "nothing committed");
    assert_eq!(
        store.mint("c").unwrap(),
        "c_2",
        "no id burned by any of them"
    );
    assert_eq!(
        current_revs(&store),
        vec![("a.md".into(), "r_0".into()), ("b.md".into(), "r_1".into())]
    );
}

/// The commit transaction is `BEGIN IMMEDIATE`: while a request is inside
/// it, a second connection's own `BEGIN IMMEDIATE` fails `SQLITE_BUSY`
/// (after its busy timeout) instead of racing the validation.
#[test]
fn the_commit_transaction_is_immediate() {
    let (mut store, repo, mut ds, dir, path) = file_seeded(&[("a.md", "# A\n\nAlpha.\n")]);
    let other = Connection::open(&path).unwrap();
    other
        .busy_timeout(std::time::Duration::from_millis(50))
        .unwrap();
    let seen: std::sync::Arc<std::sync::Mutex<Option<String>>> = Default::default();
    let record = seen.clone();
    store.after_begin = Some(Box::new(move || {
        let r = other
            .execute_batch("BEGIN IMMEDIATE")
            .map(|()| "began".to_owned())
            .unwrap_or_else(|e| e.to_string());
        if r == "began" {
            other.execute_batch("ROLLBACK").unwrap();
        }
        *record.lock().unwrap() = Some(r);
    }));
    start_trace(store.conn());
    let res = store.apply(&one_op(&repo, "a.md"), &mut ds, T1).unwrap();
    assert!(res.committed);
    let seen = seen.lock().unwrap().clone().expect("the hook ran");
    assert!(
        seen.contains("locked") || seen.contains("busy"),
        "the second writer was refused: {seen}"
    );
    let log = traced();
    assert!(
        log.iter().any(|s| s.starts_with("BEGIN IMMEDIATE")),
        "{log:#?}"
    );
    assert_eq!(count(&store, "commits"), 2);
    store.after_begin = None;
    store.close().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- DB-first materialization (store 14.0) ------------------------------------------------

/// A doc store whose reads pass through and whose writes all fail: what a
/// request's phase B' meets when the process dies right after COMMIT.
struct Crashed<'a>(&'a mut MemDocStore);

impl DocStore for Crashed<'_> {
    fn exists(&self, path: &str) -> bool {
        self.0.exists(path)
    }
    fn read(&self, path: &str) -> Result<Option<String>> {
        self.0.read(path)
    }
    fn write(&mut self, path: &str, _bytes: &str) -> Result<()> {
        Err(Error::Other(format!("crashed before writing {path}")))
    }
    fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        Err(Error::Other(format!(
            "crashed before renaming {from} -> {to}"
        )))
    }
    fn remove(&mut self, path: &str) -> Result<()> {
        Err(Error::Other(format!("crashed before removing {path}")))
    }
}

/// A doc store on which `rename` fails (another device), everything else
/// works.
struct NoRename<'a>(&'a mut MemDocStore);

impl DocStore for NoRename<'_> {
    fn exists(&self, path: &str) -> bool {
        self.0.exists(path)
    }
    fn read(&self, path: &str) -> Result<Option<String>> {
        self.0.read(path)
    }
    fn write(&mut self, path: &str, bytes: &str) -> Result<()> {
        self.0.write(path, bytes)
    }
    fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        Err(Error::Other(format!("EXDEV: {from} -> {to}")))
    }
    fn remove(&mut self, path: &str) -> Result<()> {
        self.0.remove(path)
    }
}

/// A request whose phase B' died: the error is the doc store's, the
/// transaction before it committed.
fn crashed<T: std::fmt::Debug>(r: Result<T>) {
    match r {
        Err(Error::Other(msg)) if msg.starts_with("crashed before") => {}
        other => panic!("expected the crash to surface, got {other:?}"),
    }
}

fn pending(store: &Store, repo: &str) -> Vec<PendingRow> {
    store.pending_materializations(repo).unwrap()
}

fn mcp_ctx(repo: &str, ts: &str) -> DocOpContext {
    DocOpContext {
        repo_id: repo.to_owned(),
        actor: Some("agent:mcp".to_owned()),
        ts: ts.to_owned(),
    }
}

/// §5.7: the intent rows ride the commit transaction — one `write` per
/// document, carrying the revision just minted and the hash of its bytes —
/// and phase B' writes each file and deletes its row in autocommit, after
/// COMMIT. A request that completes leaves no row.
#[test]
fn an_api_commit_records_intent_in_its_transaction_and_phase_b_prime_clears_it() {
    let (mut store, repo, mut ds) =
        seeded(&[("a.md", "# A\n\nAlpha.\n"), ("b.md", "# B\n\nBravo.\n")]);
    start_trace(store.conn());
    let res = store
        .apply(
            &ApplyRequest {
                repo_id: repo.clone(),
                ops: vec![insert_end("a.md", "A tail."), insert_end("b.md", "B tail.")],
                origin: api_origin(),
                dry_run: false,
            },
            &mut ds,
            T1,
        )
        .unwrap();
    assert!(res.committed);
    let log = traced();
    let tx = tx_of(&log, "INSERT INTO commits").expect("the commit rides a transaction");
    let inserts: Vec<usize> = (0..log.len())
        .filter(|&i| log[i].starts_with("INSERT OR REPLACE INTO pending_materializations"))
        .collect();
    assert_eq!(inserts.len(), 2, "one row per document: {log:#?}");
    assert_eq!(
        tx_of(&log, "INSERT OR REPLACE INTO pending_materializations"),
        Some(tx),
        "… inside the commit transaction: {log:#?}"
    );
    let commit_at = log.iter().position(|s| s.starts_with("COMMIT")).unwrap();
    let deletes: Vec<usize> = (0..log.len())
        .filter(|&i| log[i].starts_with("DELETE FROM pending_materializations"))
        .collect();
    assert_eq!(deletes.len(), 2);
    assert!(
        deletes.iter().all(|&i| i > commit_at),
        "every row is deleted after COMMIT, as its file lands: {log:#?}"
    );
    assert!(
        log[commit_at..].iter().all(|s| !s.starts_with("BEGIN")),
        "… in autocommit: {log:#?}"
    );
    assert!(pending(&store, &repo).is_empty());
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("# A\n\nAlpha.\n\nA tail.\n")
    );
    assert_eq!(
        ds.read("b.md").unwrap().as_deref(),
        Some("# B\n\nBravo.\n\nB tail.\n")
    );
}

/// A crash between COMMIT and the writes: the commit, its revisions and its
/// `changes_since` digest are durable, the files are the old ones, and the
/// rows say exactly what is owed. `materialize_pending` replays them (files
/// written, rows gone, the paths returned, the digest unchanged), and the
/// next observation of each file is an echo.
#[test]
fn a_crash_after_commit_leaves_rows_the_materializer_replays() {
    let (mut store, repo, mut ds) =
        seeded(&[("a.md", "# A\n\nAlpha.\n"), ("b.md", "# B\n\nBravo.\n")]);
    crashed(store.apply(
        &ApplyRequest {
            repo_id: repo.clone(),
            ops: vec![insert_end("a.md", "A tail."), insert_end("b.md", "B tail.")],
            origin: api_origin(),
            dry_run: false,
        },
        &mut Crashed(&mut ds),
        T1,
    ));
    assert_eq!(commits_by_origin(&store, "api"), 1);
    assert_eq!(
        current_revs(&store),
        vec![("a.md".into(), "r_2".into()), ("b.md".into(), "r_3".into())]
    );
    assert_eq!(ds.read("a.md").unwrap().as_deref(), Some("# A\n\nAlpha.\n"));
    assert_eq!(ds.read("b.md").unwrap().as_deref(), Some("# B\n\nBravo.\n"));
    let rows = pending(&store, &repo);
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0],
        PendingRow {
            path: "a.md".into(),
            kind: PendingKind::Write,
            from_path: None,
            doc_id: "d_0".into(),
            rev_id: Some("r_2".into()),
            rendered_hash: sha256("# A\n\nAlpha.\n\nA tail.\n".as_bytes()).to_vec(),
            commit_id: "c_2".into(),
        }
    );
    assert_eq!(rows[1].path, "b.md");
    assert_eq!(rows[1].rev_id.as_deref(), Some("r_3"));
    let page = store.changes_since(&repo, 2, 50, None).unwrap();
    assert_eq!(page.digests.len(), 1);
    assert_eq!(page.digests[0].commit, "c_2");
    assert_eq!(page.digests[0].revisions.len(), 2);

    // Recovery: whoever runs next replays the rows.
    let done = store.materialize_pending(&repo, &mut ds).unwrap();
    assert_eq!(done, ["a.md", "b.md"]);
    assert!(pending(&store, &repo).is_empty());
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("# A\n\nAlpha.\n\nA tail.\n")
    );
    assert_eq!(
        ds.read("b.md").unwrap().as_deref(),
        Some("# B\n\nBravo.\n\nB tail.\n")
    );
    let after = store.changes_since(&repo, 2, 50, None).unwrap();
    assert_eq!(after.digests.len(), 1, "materializing records nothing");
    for path in ["a.md", "b.md"] {
        let bytes = ds.read(path).unwrap().unwrap();
        let o = observe(&mut store, &repo, path, &bytes, T2);
        assert!(o.echo, "{path}: {o:?}");
    }
    assert_eq!(count(&store, "commits"), 3);
}

/// §5.7's gate rule in the crash window, through `observe_batch`:
/// the materialized bytes → echo and the row goes; a member gone under a
/// `write` row → no tombstone (`deleted: false`), the row stays, the doc
/// stays live; foreign bytes → the file wins, a normal `observed` ingest
/// that clears the row in its own transaction. A stale file that still
/// hashes to the previous revision is foreign to the gate too (the design's
/// rule: only the materializer tells "behind" from "reverted").
#[test]
fn observation_in_the_crash_window_follows_the_gate_rule() {
    let (mut store, repo, mut ds) = seeded(&[
        ("a.md", "# A\n\nAlpha.\n"),
        ("b.md", "# B\n\nBravo.\n"),
        ("c.md", "# C\n\nCharlie.\n"),
        ("s.md", "# S\n\nStale.\n"),
    ]);
    crashed(store.apply(
        &ApplyRequest {
            repo_id: repo.clone(),
            ops: vec![
                insert_end("a.md", "A tail."),
                insert_end("b.md", "B tail."),
                insert_end("c.md", "C tail."),
                insert_end("s.md", "S tail."),
            ],
            origin: api_origin(),
            dry_run: false,
        },
        &mut Crashed(&mut ds),
        T1,
    ));
    assert_eq!(pending(&store, &repo).len(), 4);
    let revs_before = current_revs(&store);
    start_trace(store.conn());
    let out = store
        .observe_batch(
            &repo,
            &[
                // a: the materialized bytes (a watcher saw B' land elsewhere).
                BatchItem::observed("a.md", "# A\n\nAlpha.\n\nA tail.\n"),
                // b: gone — the file the materializer owes is not there yet.
                BatchItem::gone("b.md"),
                // c: a human's bytes.
                BatchItem::observed("c.md", "# C\n\nCharlie, by a human.\n"),
                // s: the stale file, exactly the previous revision.
                BatchItem::observed("s.md", "# S\n\nStale.\n"),
            ],
            T2,
            &Config::default(),
        )
        .unwrap();
    let a = out[0].as_observed().unwrap();
    assert!(a.echo && a.converged, "{a:?}");
    assert_eq!(a.doc_id, "d_0");
    let b = out[1].as_deleted().unwrap();
    assert!(!b.deleted(), "{b:?}");
    assert_eq!(b.doc_id, None);
    let c = out[2].as_observed().unwrap();
    assert!(!c.echo, "{c:?}");
    assert_eq!(
        c.commit_id.as_deref(),
        Some("c_5"),
        "after c_0..c_3 and the api c_4"
    );
    let s = out[3].as_observed().unwrap();
    assert!(
        !s.echo,
        "the stale file is observed, not materialized: {s:?}"
    );
    let log = traced();
    let c_tx = tx_of(&log, "INSERT INTO commits").expect("c.md's observed commit");
    // a.md's row went in autocommit (the echo); c.md's goes with its commit.
    let from_c = &log[c_tx..];
    assert_eq!(
        tx_of(from_c, "DELETE FROM pending_materializations"),
        Some(0),
        "c.md's row goes in its member's transaction: {log:#?}"
    );
    let rows = pending(&store, &repo);
    assert_eq!(
        rows.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(),
        ["b.md"],
        "a.md confirmed, c.md and s.md superseded by the files, b.md still owed"
    );
    let revs = current_revs(&store);
    assert_eq!(revs[0], revs_before[0], "a.md: an echo");
    assert_eq!(
        revs[1], revs_before[1],
        "b.md: not tombstoned, not advanced"
    );
    assert_ne!(
        revs[2], revs_before[2],
        "c.md advanced by the observed ingest"
    );
    assert_eq!(
        store.reconstruct("d_2").unwrap().as_deref(),
        Some("# C\n\nCharlie, by a human.\n")
    );
    assert_eq!(
        store.reconstruct("d_3").unwrap().as_deref(),
        Some("# S\n\nStale.\n"),
        "file wins"
    );
    let live: i64 = store
        .conn()
        .query_row(
            "SELECT count(*) FROM docs WHERE path = 'b.md' AND deleted_commit IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(live, 1);
    // `observe_delete` applies the same gone rule.
    let d = store.observe_delete(&repo, "b.md", T2).unwrap();
    assert!(!d.deleted());
    assert_eq!(pending(&store, &repo).len(), 1);
    // The materializer still owes b.md and lands it.
    assert_eq!(store.materialize_pending(&repo, &mut ds).unwrap(), ["b.md"]);
    assert_eq!(
        ds.read("b.md").unwrap().as_deref(),
        Some("# B\n\nBravo.\n\nB tail.\n")
    );
    assert!(pending(&store, &repo).is_empty());
}

/// The materializer never overwrites a human's edit: a `write` row lands
/// over nothing, over its own bytes or over the previous revision's bytes
/// (the file the commit left behind); foreign bytes keep the row until the
/// sweep observes them (file wins) — a `docs_create` whose path a foreign
/// file took meanwhile is the same rule with no previous revision.
#[test]
fn the_materializer_leaves_a_foreign_file_and_keeps_the_row() {
    let (mut store, repo, mut ds) = seeded(&[("a.md", "# A\n\nAlpha.\n")]);
    crashed(store.apply(&one_op(&repo, "a.md"), &mut Crashed(&mut ds), T1));
    let ctx = mcp_ctx(&repo, T1);
    crashed(store.docs_create(&ctx, &mut Crashed(&mut ds), "n.md", "# N\n", None));
    assert_eq!(pending(&store, &repo).len(), 2);
    assert!(!ds.exists("n.md"));
    // Humans edit both paths in the window.
    ds.write("a.md", "# A\n\nAlpha, by a human.\n").unwrap();
    ds.write("n.md", "# Someone else's N\n").unwrap();
    assert!(
        store
            .materialize_pending(&repo, &mut ds)
            .unwrap()
            .is_empty()
    );
    assert_eq!(pending(&store, &repo).len(), 2, "both rows stay");
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("# A\n\nAlpha, by a human.\n")
    );
    assert_eq!(
        ds.read("n.md").unwrap().as_deref(),
        Some("# Someone else's N\n")
    );
    // The sweep's observation: the files win and the rows go.
    let out = store
        .observe_batch(
            &repo,
            &[
                BatchItem::observed("a.md", "# A\n\nAlpha, by a human.\n"),
                BatchItem::observed("n.md", "# Someone else's N\n"),
            ],
            T2,
            &Config::default(),
        )
        .unwrap();
    assert!(out.iter().all(|o| !o.as_observed().unwrap().echo));
    assert!(pending(&store, &repo).is_empty());
    assert_eq!(
        store.reconstruct("d_0").unwrap().as_deref(),
        Some("# A\n\nAlpha, by a human.\n")
    );
    assert_eq!(
        store.reconstruct("d_1").unwrap().as_deref(),
        Some("# Someone else's N\n")
    );
    // An absent file is written; the previous revision's bytes are replaced.
    crashed(store.apply(&one_op(&repo, "a.md"), &mut Crashed(&mut ds), T2));
    ds.remove("n.md").unwrap();
    crashed(store.apply(&one_op(&repo, "n.md"), &mut Crashed(&mut ds), T2));
    assert_eq!(
        store.materialize_pending(&repo, &mut ds).unwrap(),
        ["a.md", "n.md"]
    );
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("# A\n\nAlpha, by a human.\n\nA tail.\n")
    );
    assert_eq!(
        ds.read("n.md").unwrap().as_deref(),
        Some("# Someone else's N\n\nA tail.\n")
    );
}

/// §6 `docs_delete` (14.0): the tombstone commits with a `remove` row
/// carrying the last revision's hash; the file is unlinked only while it
/// still holds those bytes — after a crash, a replay unlinks an unchanged
/// file and leaves a human's, resolving the row either way (today's
/// lingering file after a delete crash is healed).
#[test]
fn docs_delete_after_a_crash_unlinks_only_an_unchanged_file() {
    let (mut store, repo, mut ds) =
        seeded(&[("a.md", "# A\n\nAlpha.\n"), ("b.md", "# B\n\nBravo.\n")]);
    let ctx = mcp_ctx(&repo, T1);
    crashed(store.docs_delete(&ctx, &mut Crashed(&mut ds), "a.md"));
    crashed(store.docs_delete(&ctx, &mut Crashed(&mut ds), "b.md"));
    let rows = pending(&store, &repo);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].kind, PendingKind::Remove);
    assert_eq!(rows[0].rev_id, None);
    assert_eq!(
        rows[0].rendered_hash,
        sha256("# A\n\nAlpha.\n".as_bytes()).to_vec()
    );
    assert!(ds.exists("a.md") && ds.exists("b.md"));
    // b.md is edited by a human before the replay.
    ds.write("b.md", "# B\n\nBravo, kept by a human.\n")
        .unwrap();
    assert_eq!(
        store.materialize_pending(&repo, &mut ds).unwrap(),
        ["a.md", "b.md"]
    );
    assert!(!ds.exists("a.md"), "unchanged: unlinked");
    assert_eq!(
        ds.read("b.md").unwrap().as_deref(),
        Some("# B\n\nBravo, kept by a human.\n"),
        "foreign: left for the sweep"
    );
    assert!(pending(&store, &repo).is_empty());
    // The gate rule for a `remove` row whose file is observed unchanged:
    // nothing to ingest, the row stays for the materializer.
    let (mut store, repo, mut ds) = seeded(&[("a.md", "# A\n\nAlpha.\n")]);
    crashed(store.docs_delete(&ctx, &mut Crashed(&mut ds), "a.md"));
    let o = observe(&mut store, &repo, "a.md", "# A\n\nAlpha.\n", T2);
    assert!(o.echo, "{o:?}");
    assert_eq!(pending(&store, &repo).len(), 1);
    assert_eq!(count(&store, "commits"), 2, "no revival");
    assert_eq!(store.materialize_pending(&repo, &mut ds).unwrap(), ["a.md"]);
    assert!(!ds.exists("a.md"));
}

/// §6 `docs_move` (14.0): one `rename` row at the new path carrying the
/// moved document's revision (plus a `write` per other rewritten source).
/// B' renames; when the rename fails (another device) it writes the
/// revision's bytes at `to` and retires the old file; when the old file is
/// gone it writes; when `to` holds foreign bytes the row stays. A moved
/// document that is itself a retarget source lands its rewritten bytes at
/// `to` through the same row, and its old file goes with it.
#[test]
fn docs_move_falls_back_to_writing_when_the_rename_fails() {
    let (mut store, repo) = fixture_store();
    let mut ds = MemDocStore::new();
    let ctx = mcp_ctx(&repo, T0);
    store
        .docs_create(&ctx, &mut ds, "b.md", "# B\n\nTarget.\n", None)
        .unwrap();
    store
        .docs_create(&ctx, &mut ds, "a.md", "# A\n\nSee [b](b.md).\n", None)
        .unwrap();
    let ctx1 = mcp_ctx(&repo, T1);
    // Crash first: the rows say what a move owes.
    crashed(store.docs_move(&ctx1, &mut Crashed(&mut ds), "b.md", "n/b.md", true));
    let rows = pending(&store, &repo);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].kind, PendingKind::Rename);
    assert_eq!(rows[0].path, "n/b.md");
    assert_eq!(rows[0].from_path.as_deref(), Some("b.md"));
    assert_eq!(
        rows[0].rev_id.as_deref(),
        Some("r_0"),
        "the moved doc's revision"
    );
    assert_eq!(
        rows[0].rendered_hash,
        sha256("# B\n\nTarget.\n".as_bytes()).to_vec()
    );
    assert_eq!(rows[1].kind, PendingKind::Write);
    assert_eq!(rows[1].path, "a.md");
    assert!(ds.exists("b.md") && !ds.exists("n/b.md"));
    // Replay on a device where rename fails: write + retire.
    assert_eq!(
        store
            .materialize_pending(&repo, &mut NoRename(&mut ds))
            .unwrap(),
        ["n/b.md", "a.md"]
    );
    assert_eq!(
        ds.read("n/b.md").unwrap().as_deref(),
        Some("# B\n\nTarget.\n")
    );
    assert!(!ds.exists("b.md"), "the old file is retired");
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("# A\n\nSee [b](n/b.md).\n")
    );
    assert!(pending(&store, &repo).is_empty());

    // The old file gone before the replay: written from the revision.
    let ctx2 = mcp_ctx(&repo, T2);
    crashed(store.docs_move(&ctx2, &mut Crashed(&mut ds), "n/b.md", "m/b.md", false));
    ds.remove("n/b.md").unwrap();
    assert_eq!(
        store.materialize_pending(&repo, &mut ds).unwrap(),
        ["m/b.md"]
    );
    assert_eq!(
        ds.read("m/b.md").unwrap().as_deref(),
        Some("# B\n\nTarget.\n")
    );

    // `to` taken by a foreign file in the window: the row stays.
    crashed(store.docs_move(&ctx2, &mut Crashed(&mut ds), "m/b.md", "o/b.md", false));
    ds.write("o/b.md", "# Someone else\n").unwrap();
    assert!(
        store
            .materialize_pending(&repo, &mut ds)
            .unwrap()
            .is_empty()
    );
    assert_eq!(pending(&store, &repo).len(), 1);
    assert!(ds.exists("m/b.md"));
    ds.remove("o/b.md").unwrap();
    assert_eq!(
        store.materialize_pending(&repo, &mut ds).unwrap(),
        ["o/b.md"]
    );
    assert!(!ds.exists("m/b.md"));

    // A self-linking source: the rename row carries the NEW revision, and
    // the straight B' (no crash) lands the rewritten bytes at `to` only.
    store
        .docs_create(&ctx2, &mut ds, "s.md", "# S\n\nSee [me](/s.md).\n", None)
        .unwrap();
    start_trace(store.conn());
    let moved = store
        .docs_move(&ctx2, &mut ds, "s.md", "t/s.md", true)
        .unwrap();
    let log = traced();
    assert_eq!(
        log.iter()
            .filter(|s| s.starts_with("INSERT OR REPLACE INTO pending_materializations"))
            .count(),
        1,
        "one rename row, no separate write for the moved source: {log:#?}"
    );
    assert_eq!(moved.retargeted.unwrap().docs, vec![moved.doc_id.clone()]);
    assert!(!ds.exists("s.md"));
    assert_eq!(
        ds.read("t/s.md").unwrap().as_deref(),
        Some("# S\n\nSee [me](/t/s.md).\n")
    );
    assert_eq!(
        store.reconstruct(&moved.doc_id).unwrap().as_deref(),
        ds.read("t/s.md").unwrap().as_deref()
    );
    assert!(pending(&store, &repo).is_empty());
}

/// `docs_set_meta` under the same order: the patched bytes are recorded and
/// written after the commit; a crash leaves the row and the replay lands
/// them over the previous revision's file.
#[test]
fn docs_set_meta_materializes_after_the_commit() {
    let (mut store, repo, mut ds) = seeded(&[("a.md", "# A\n\nAlpha.\n")]);
    let ctx = mcp_ctx(&repo, T1);
    let mut set = serde_json::Map::new();
    set.insert("status".to_owned(), serde_json::json!("done"));
    crashed(store.docs_set_meta(&ctx, &mut Crashed(&mut ds), "a.md", Some(&set), &[]));
    assert_eq!(ds.read("a.md").unwrap().as_deref(), Some("# A\n\nAlpha.\n"));
    let rows = pending(&store, &repo);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].rev_id.as_deref(), Some("r_1"));
    assert_eq!(store.materialize_pending(&repo, &mut ds).unwrap(), ["a.md"]);
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("---\nstatus: done\n---\n\n# A\n\nAlpha.\n")
    );
    assert_eq!(
        store.reconstruct("d_0").unwrap().as_deref(),
        ds.read("a.md").unwrap().as_deref()
    );
}

/// An `observed` commit records no intent: the file is the source.
#[test]
fn observed_commits_record_no_intent() {
    let (mut store, repo) = fixture_store();
    start_trace(store.conn());
    observe(&mut store, &repo, "a.md", "# A\n", T0);
    store
        .reconciling_ingest(
            &repo,
            "b.md",
            "# B\n",
            T0,
            Origin::Observed,
            None,
            None,
            &Config::default(),
        )
        .unwrap();
    store.observe_delete(&repo, "a.md", T1).unwrap();
    let log = traced();
    assert!(
        !log.iter()
            .any(|s| s.contains("INTO pending_materializations")),
        "{log:#?}"
    );
    assert!(pending(&store, &repo).is_empty());
}

/// `spec/mutate` §4 step 5 (a): a later request touching a path with a
/// pending row lands the row before reading the file, so the stale file is
/// brought to the committed revision instead of being read back as a human
/// edit (which would have been a `sync_conflict` reverting the first intent).
/// Rows at other paths are not this request's business: they stay for the
/// sweep (`materialize::crash-then-second-request-materializes-first`).
#[test]
fn a_later_request_materializes_the_pending_row_before_reading() {
    let (mut store, repo, mut ds) =
        seeded(&[("a.md", "# A\n\nAlpha.\n"), ("b.md", "# B\n\nBravo.\n")]);
    crashed(store.apply(&one_op(&repo, "a.md"), &mut Crashed(&mut ds), T1));
    crashed(store.apply(&one_op(&repo, "b.md"), &mut Crashed(&mut ds), T1));
    assert_eq!(pending(&store, &repo).len(), 2);
    let res = store
        .apply(
            &ApplyRequest {
                repo_id: repo.clone(),
                ops: vec![insert_end("a.md", "Second tail.")],
                origin: api_origin(),
                dry_run: false,
            },
            &mut ds,
            T2,
        )
        .unwrap();
    assert!(res.committed);
    assert_eq!(
        commits_by_origin(&store, "observed"),
        2,
        "no conflict ingest"
    );
    assert_eq!(commits_by_origin(&store, "api"), 3);
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("# A\n\nAlpha.\n\nA tail.\n\nSecond tail.\n")
    );
    assert_eq!(
        store.reconstruct("d_0").unwrap().as_deref(),
        ds.read("a.md").unwrap().as_deref()
    );
    let rows = pending(&store, &repo);
    assert_eq!(
        rows.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(),
        ["b.md"],
        "b.md's row is another request's: left for the sweep"
    );
    assert_eq!(ds.read("b.md").unwrap().as_deref(), Some("# B\n\nBravo.\n"));
}

// ---- the public Effect layer (spec/mutate §11, mutate 2.3) --------------------------------

use crate::effects_plan::{EffectsOutcome, PlanContext, Receipt};
use omgbase_mutate::effects::Target;
use omgbase_mutate::{Effect as Fx, ErrorCode};
use serde_json::{Value, json};

const FM_DOC: &str = "---\nstatus: open\n---\n\n# A\n\nAlpha.\n";

fn ctx(repo: &str, ts: &str) -> PlanContext {
    PlanContext {
        repo_id: repo.to_owned(),
        ts: ts.to_owned(),
        config: Config::default(),
    }
}

fn doc_by_path(path: &str) -> Target {
    Target::Document {
        id: None,
        path: Some(path.to_owned()),
    }
}

fn set_fm(target: Target, key: &str, value: Value) -> Fx {
    Fx::Set {
        target,
        field: format!("frontmatter.{key}"),
        value,
        expect: None,
    }
}

fn insert_section(heading: &str, markdown: &str) -> Fx {
    Fx::Insert {
        into: Target::Section {
            heading_id: heading.to_owned(),
        },
        at: At::End,
        markdown: markdown.to_owned(),
        expect: None,
    }
}

/// Slice 1's effects: `set frontmatter.status` + `insert into section`.
fn slice_one() -> Vec<Fx> {
    vec![
        set_fm(doc_by_path("a.md"), "status", json!("done")),
        insert_section("b_0", "Tail."),
    ]
}

const SLICE_ONE_AFTER: &str = "---\nstatus: done\n---\n\n# A\n\nAlpha.\n\nTail.\n";

/// Everything a request leaves behind, for the one-shot vs plan+execute
/// comparison: commit rows (with `ops`), doc pointers, live blocks, files.
fn footprint(store: &Store, ds: &MemDocStore) -> Value {
    let conn = store.conn();
    let rows = |sql: &str| -> Vec<Vec<Value>> {
        let mut stmt = conn.prepare(sql).unwrap();
        let n = stmt.column_count();
        stmt.query_map([], |r| {
            (0..n)
                .map(|i| {
                    Ok(match r.get_ref(i)? {
                        rusqlite::types::ValueRef::Null => Value::Null,
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
    json!({
        "commits": rows("SELECT commit_id, seq, origin, actor, reason, ops FROM commits ORDER BY seq"),
        "docs": rows("SELECT doc_id, path, current_rev, file_hash, deleted_commit FROM docs ORDER BY path"),
        "blocks": rows("SELECT block_id, doc_id, parent_block, ordinal, type, raw_hash, created_commit FROM blocks WHERE deleted_commit IS NULL ORDER BY doc_id, ordinal"),
        "revisions": rows("SELECT rev_id, doc_id, seq, rendered_hash, path, commit_id FROM revisions ORDER BY rev_id"),
        "pending": rows("SELECT path FROM pending_materializations"),
        "files": ds.files().iter().map(|(k, v)| (k.clone(), json!(v))).collect::<serde_json::Map<_, _>>(),
    })
}

fn expect_code(err: &Error, code: ErrorCode) -> &MutationError {
    match err {
        Error::Mutation(m) if m.code == code => m,
        other => panic!("expected {code:?}, got {other:?}"),
    }
}

/// §11.6 `plan`: the frozen plan with an exact preview; nothing written, no
/// commit row, and — the symbolic minter — no id consumed: the next `b` the
/// store mints is the one it would have minted before the plan.
#[test]
fn plan_effects_burns_no_id_and_previews_the_exact_bytes() {
    let (mut store, repo, ds) = seeded(&[("a.md", FM_DOC)]);
    let next_b = store.mint("b").unwrap();
    assert_eq!(next_b, "b_2", "b_0, b_1 are the observed blocks");
    let plan = store
        .plan_effects(&ctx(&repo, T1), &slice_one(), &ds)
        .unwrap();
    assert_eq!(plan.version, 1);
    assert_eq!(plan.planner_v, "p3");
    assert_eq!(plan.plan_id.len(), 64);
    assert_eq!(plan.plan_id, plan.digest(), "sealed over its core");
    // Resolved: the document target carries id and path.
    assert_eq!(
        plan.effects[0].to_json()["target"],
        json!({ "kind": "document", "id": "d_0", "path": "a.md" })
    );
    // Lowered: one file head (set_meta's bytes) + one insert; every opset key present.
    assert_eq!(
        plan.opset.to_json(),
        json!({
            "creates": [], "moves": [], "tombstones": [],
            "set_frontmatter": [{ "doc": "d_0", "raw": "---\nstatus: done\n---\n\n" }],
            "ops": [{ "op": "insert", "to": { "parent": { "heading": "b_0", "scope": "section" }, "at": "end" }, "markdown": "Tail." }],
        })
    );
    // Pinned: the DocBase triple (nulls kept as values); the new block is symbolic.
    assert_eq!(
        plan.preconditions.to_json(),
        json!({
            "docs": [{ "id": "d_0", "path": "a.md", "base_revision": "r_0", "hash": hex(&sha256(FM_DOC.as_bytes())) }],
            "blocks": [], "parents": [], "absent_paths": [],
        })
    );
    assert_eq!(
        plan.to_json(false)["new_ids"],
        json!([{ "symbol": "$new.0", "kind": "block" }])
    );
    let preview = plan.preview.as_ref().expect("plan carries a preview");
    assert_eq!(preview.results[0].ids, ["$new.0"]);
    assert_eq!(preview.revisions.len(), 1);
    assert_eq!(preview.revisions[0].id, "d_0");
    assert_eq!(
        preview.revisions[0].hash,
        hex(&sha256(SLICE_ONE_AFTER.as_bytes()))
    );
    assert_eq!(preview.diffs[0].0, "a.md");
    assert_eq!(
        preview.diffs[0].1,
        (FM_DOC.to_owned(), SLICE_ONE_AFTER.to_owned())
    );
    // Nothing happened to the store, the files, or the minter.
    assert_eq!(count(&store, "commits"), 1);
    assert_eq!(count(&store, "revisions"), 1);
    assert_eq!(count(&store, "pending_materializations"), 0);
    assert_eq!(ds.read("a.md").unwrap().as_deref(), Some(FM_DOC));
    assert_eq!(store.mint("b").unwrap(), "b_3", "the plan minted nothing");
    // The preview is outside the digest; the wire form round-trips and admits.
    let back = Plan::admit(&plan.to_json(false)).unwrap();
    assert_eq!(back.digest(), plan.plan_id);
    assert!(back.preview.is_none());
}

/// `apply_effects_detailed` is the plan plus the receipt the one-shot
/// produces (the sugar tools read the committed ids from the preview through
/// `new_ids`), and a plan alone burns nothing (`spec/surface` §9 closed at
/// 4.0: the next mint after a plan is the mint a commit takes).
#[test]
fn apply_effects_detailed_returns_the_plan_and_the_receipt_and_a_plan_burns_nothing() {
    let (mut store, repo, mut ds) = seeded(&[("a.md", FM_DOC)]);
    let effects = vec![
        insert_section("b_0", "One.\n\nTwo."),
        insert_section("b_0", "Three."),
    ];
    let plan = store.plan_effects(&ctx(&repo, T1), &effects, &ds).unwrap();
    assert_eq!(
        plan.to_json(false)["new_ids"],
        json!([
            { "symbol": "$new.0", "kind": "block" },
            { "symbol": "$new.1", "kind": "block" },
            { "symbol": "$new.2", "kind": "block" },
        ])
    );
    let preview = plan.preview.as_ref().expect("preview");
    assert_eq!(preview.results[0].ids, ["$new.0", "$new.1"]);
    assert_eq!(preview.results[1].ids, ["$new.2"]);
    assert_eq!(count(&store, "commits"), 1, "nothing committed");
    // Committed: b_0, b_1 are the observed blocks; the three symbols take
    // b_2, b_3, b_4 — the plan above consumed nothing.
    let (plan2, receipt) = store
        .apply_effects_detailed(&ctx(&repo, T1), &effects, &api_origin(), &mut ds)
        .unwrap();
    assert_eq!(plan2.plan_id, plan.plan_id);
    assert_eq!(plan2.plan_id, receipt.plan_id);
    assert_eq!(
        receipt.new_ids,
        [
            ("$new.0".to_owned(), "b_2".to_owned()),
            ("$new.1".to_owned(), "b_3".to_owned()),
            ("$new.2".to_owned(), "b_4".to_owned()),
        ]
    );
    assert_eq!(receipt.commit.as_deref(), Some("c_1"));
    assert_eq!(count(&store, "commits"), 2);
    assert_eq!(store.mint("b").unwrap(), "b_5");
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("---\nstatus: open\n---\n\n# A\n\nAlpha.\n\nOne.\n\nTwo.\n\nThree.\n")
    );
}

/// 3.2 (§11.8 "Sugar"): a plan carrying `templates` (the effects as written
/// of a selector-less request that evaluated an expression) commits an
/// intent record with the same `templates`; without it the record is the
/// 3.1 shape — and both plans have one `plan_id`, `templates` being outside
/// the digest.
#[test]
fn the_intent_record_carries_the_templates_a_plan_carries() {
    let origin = api_origin();
    let (mut a, repo_a, mut ds_a) = seeded(&[("a.md", FM_DOC)]);
    let effects = vec![set_fm(doc_by_path("a.md"), "status", json!("done"))];
    let mut plan = a.plan_effects(&ctx(&repo_a, T1), &effects, &ds_a).unwrap();
    let plain_id = plan.plan_id.clone();
    let written = json!([{ "op": "set", "target": "a.md", "field": "frontmatter.status", "value": "-> `done`" }]);
    plan.templates = written.as_array().cloned();
    let receipt = a
        .execute_plan(&ctx(&repo_a, T1), &plan, &origin, &mut ds_a)
        .unwrap();
    assert_eq!(receipt.plan_id, plain_id);
    let ops: String = a
        .conn()
        .query_row("SELECT ops FROM commits WHERE commit_id = 'c_1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let record: Value = serde_json::from_str(&ops).unwrap();
    assert_eq!(record["templates"], written);
    assert_eq!(record["plan_id"], json!(plain_id));
    assert_eq!(record["v"], 1);
    assert!(record.get("selection").is_none());
    let (mut b, repo_b, mut ds_b) = seeded(&[("a.md", FM_DOC)]);
    let plan = b.plan_effects(&ctx(&repo_b, T1), &effects, &ds_b).unwrap();
    assert_eq!(plan.plan_id, plain_id);
    b.execute_plan(&ctx(&repo_b, T1), &plan, &origin, &mut ds_b)
        .unwrap();
    let ops: String = b
        .conn()
        .query_row("SELECT ops FROM commits WHERE commit_id = 'c_1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(!ops.contains("templates"), "{ops}");
}

/// `plan` → `execute` and the one-shot `apply({ effects })` leave the same
/// store and files behind: one `api` commit whose `ops` is the intent
/// record, one revision, the inserted block minted under the same id.
#[test]
fn plan_then_execute_and_one_shot_apply_leave_identical_footprints() {
    let origin = api_origin();
    let (mut a, repo_a, mut ds_a) = seeded(&[("a.md", FM_DOC)]);
    let plan = a
        .plan_effects(&ctx(&repo_a, T1), &slice_one(), &ds_a)
        .unwrap();
    let r1 = a
        .execute_plan(&ctx(&repo_a, T1), &plan, &origin, &mut ds_a)
        .unwrap();
    let (mut b, repo_b, mut ds_b) = seeded(&[("a.md", FM_DOC)]);
    let EffectsOutcome::Receipt(r2) = b
        .apply_effects(&ctx(&repo_b, T1), &slice_one(), &origin, &mut ds_b, false)
        .unwrap()
    else {
        panic!("a committing apply returns a receipt")
    };
    assert_eq!(r1, r2);
    assert_eq!(
        r1.to_json(),
        json!({
            "plan_id": plan.plan_id,
            "commit": "c_1",
            "revisions": [{ "id": "d_0", "path": "a.md", "hash": hex(&sha256(SLICE_ONE_AFTER.as_bytes())) }],
            "new_ids": { "$new.0": "b_2" },
            "committed": true,
            "summary": [
                "set frontmatter.status = \"done\" in /a.md",
                "insert 1 block at the end of section \"A\" in /a.md",
            ],
        })
    );
    assert_eq!(footprint(&a, &ds_a), footprint(&b, &ds_b));
    assert_eq!(ds_a.read("a.md").unwrap().as_deref(), Some(SLICE_ONE_AFTER));
    assert_eq!(
        a.reconstruct("d_0").unwrap().as_deref(),
        Some(SLICE_ONE_AFTER)
    );
    // ADR-003: the commit records the intent, not the lowered ops.
    let ops: String = a
        .conn()
        .query_row("SELECT ops FROM commits WHERE commit_id = 'c_1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let record: Value = serde_json::from_str(&ops).unwrap();
    assert_eq!(record["v"], 1);
    assert_eq!(record["plan_id"], json!(plan.plan_id));
    assert_eq!(record["effects"].as_array().unwrap().len(), 2);
    assert_eq!(record["effects"][0]["op"], "set");
    assert_eq!(
        ops,
        omgbase_mutate::effects::canonical_json(&record),
        "stored in canonical form"
    );
    // The observed commit keeps `ops` NULL.
    let null_ops: Option<String> = a
        .conn()
        .query_row("SELECT ops FROM commits WHERE commit_id = 'c_0'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(null_ops, None);
    assert_eq!(
        a.changes_since(&repo_a, 1, 10, None).unwrap().digests.len(),
        1
    );
}

/// A failure inside the transaction (`dispositions` taken away so the
/// ingest fails after the commit row) leaves no row, no revision, no
/// pending intent and no file change; the plan is still executable after.
#[test]
fn an_execute_that_fails_mid_transaction_commits_nothing() {
    let (mut store, repo, mut ds) = seeded(&[("a.md", FM_DOC)]);
    let plan = store
        .plan_effects(&ctx(&repo, T1), &slice_one(), &ds)
        .unwrap();
    let before = footprint(&store, &ds);
    store
        .conn()
        .execute("ALTER TABLE dispositions RENAME TO dispositions_gone", [])
        .unwrap();
    start_trace(store.conn());
    let err = store
        .execute_plan(&ctx(&repo, T1), &plan, &api_origin(), &mut ds)
        .unwrap_err();
    assert!(matches!(err, Error::Sqlite(_)), "{err}");
    let log = traced();
    assert!(log.iter().any(|s| s.starts_with("ROLLBACK")), "{log:#?}");
    assert!(
        log.iter().any(|s| s.starts_with("INSERT INTO commits")),
        "it reached the commit row: {log:#?}"
    );
    store
        .conn()
        .execute("ALTER TABLE dispositions_gone RENAME TO dispositions", [])
        .unwrap();
    assert_eq!(footprint(&store, &ds), before, "nothing survived");
    // (The `c` and `b` ids drawn before the failure stay issued in this
    // process, as for `apply`; nothing in the database names them.)
    let r = store
        .execute_plan(&ctx(&repo, T2), &plan, &api_origin(), &mut ds)
        .unwrap();
    assert_eq!(r.commit.as_deref(), Some("c_2"));
    assert_eq!(ds.read("a.md").unwrap().as_deref(), Some(SLICE_ONE_AFTER));
}

/// Replaying a committed plan fails `stale_plan` with the current truth; a
/// plan computed before an observed change fails the same way; the plan
/// form refuses a version it does not read and a core that does not digest
/// to its `plan_id`.
#[test]
fn replay_and_stale_plans_are_refused_and_so_are_bad_plan_objects() {
    let (mut store, repo, mut ds) = seeded(&[("a.md", FM_DOC)]);
    let plan = store
        .plan_effects(&ctx(&repo, T1), &slice_one(), &ds)
        .unwrap();
    store
        .execute_plan(&ctx(&repo, T1), &plan, &api_origin(), &mut ds)
        .unwrap();
    let err = store
        .execute_plan(&ctx(&repo, T2), &plan, &api_origin(), &mut ds)
        .unwrap_err();
    let m = expect_code(&err, ErrorCode::StalePlan);
    assert_eq!(m.data["doc"], "d_0");
    assert_eq!(m.data["expected_revision"], "r_0");
    assert_eq!(m.data["current"]["revision"], "r_1");
    assert_eq!(m.data["retriable"], true);
    assert_eq!(count(&store, "commits"), 2, "the replay committed nothing");

    // A fresh plan, then the file changes underneath it.
    let plan = store
        .plan_effects(&ctx(&repo, T2), &[insert_section("b_0", "More.")], &ds)
        .unwrap();
    let edited = format!("{SLICE_ONE_AFTER}\nEdited.\n");
    observe(&mut store, &repo, "a.md", &edited, T2);
    ds.write("a.md", &edited).unwrap();
    let err = store
        .execute_plan(&ctx(&repo, T2), &plan, &api_origin(), &mut ds)
        .unwrap_err();
    let m = expect_code(&err, ErrorCode::StalePlan);
    assert_eq!(m.data["expected_revision"], "r_1");
    assert_eq!(m.data["current"]["revision"], "r_2");

    // Bad plan objects.
    let mut unsupported = plan.clone();
    unsupported.version = 2;
    let err = store
        .execute_plan(&ctx(&repo, T2), &unsupported, &api_origin(), &mut ds)
        .unwrap_err();
    let m = expect_code(&err, ErrorCode::UnsupportedPlanVersion);
    assert_eq!(m.data["version"], 2);
    assert_eq!(m.data["supported"], json!([1]));
    let mut tampered = plan.clone();
    tampered.opset.ops.clear();
    let err = store
        .execute_plan(&ctx(&repo, T2), &tampered, &api_origin(), &mut ds)
        .unwrap_err();
    let m = expect_code(&err, ErrorCode::PlanMismatch);
    assert_eq!(m.data["expected"], json!(plan.plan_id));
    assert_eq!(m.data["actual"], json!(tampered.digest()));
    assert_eq!(count(&store, "commits"), 3, "none of them committed");
}

/// The digest form: `execute({ plan_id, effects })` re-plans and commits on
/// digest equality; a different digest is `plan_mismatch { expected, actual }`.
#[test]
fn execute_by_digest_commits_on_equality_and_refuses_a_mismatch() {
    let (mut store, repo, mut ds) = seeded(&[("a.md", FM_DOC)]);
    let plan = store
        .plan_effects(&ctx(&repo, T1), &slice_one(), &ds)
        .unwrap();
    let wrong = "0".repeat(64);
    let err = store
        .execute_by_digest(
            &ctx(&repo, T1),
            &wrong,
            &slice_one(),
            &api_origin(),
            &mut ds,
        )
        .unwrap_err();
    let m = expect_code(&err, ErrorCode::PlanMismatch);
    assert_eq!(m.data["expected"], json!(wrong));
    assert_eq!(m.data["actual"], json!(plan.plan_id));
    assert_eq!(count(&store, "commits"), 1);
    let r = store
        .execute_by_digest(
            &ctx(&repo, T1),
            &plan.plan_id,
            &slice_one(),
            &api_origin(),
            &mut ds,
        )
        .unwrap();
    assert_eq!(r.plan_id, plan.plan_id);
    assert_eq!(r.commit.as_deref(), Some("c_1"));
    assert_eq!(ds.read("a.md").unwrap().as_deref(), Some(SLICE_ONE_AFTER));
}

/// Decision 4 at the store: two writes to one scalar focus conflict unless
/// identical (then the later is dropped with a diagnostic and lowers once);
/// an effect after `remove` of its target conflicts on identity; a
/// `$new.<n>` nobody created is `target_missing` naming the symbol; every
/// planner error names its effect.
#[test]
fn conflicting_effects_are_rejected_when_planned() {
    let (mut store, repo, ds) = seeded(&[("a.md", FM_DOC)]);
    let c = ctx(&repo, T1);
    let differ = [
        set_fm(doc_by_path("a.md"), "status", json!("done")),
        set_fm(doc_by_path("a.md"), "status", json!("open")),
    ];
    let err = store.plan_effects(&c, &differ, &ds).unwrap_err();
    let m = expect_code(&err, ErrorCode::ConflictingEffects);
    assert_eq!(m.data["effects"], json!([0, 1]));
    assert_eq!(
        m.data["focus"],
        json!({ "kind": "scalar", "target": { "kind": "document", "id": "d_0" }, "field": "frontmatter.status" })
    );
    assert_eq!(m.data["retriable"], false);
    assert_eq!(m.data["effect_index"], 1);

    let same = [
        set_fm(doc_by_path("a.md"), "status", json!("done")),
        set_fm(doc_by_path("a.md"), "status", json!("done")),
    ];
    let plan = store.plan_effects(&c, &same, &ds).unwrap();
    assert_eq!(plan.effects.len(), 1, "the repeat is dropped");
    assert_eq!(
        plan.diagnostics,
        ["effect 1 (set frontmatter.status on document d_0) duplicates effect 0; dropped"]
    );
    assert_eq!(plan.opset.set_frontmatter.len(), 1);

    let after_remove = [
        Fx::RemoveBlocks {
            targets: vec!["b_1".into()],
            expect: None,
        },
        Fx::Set {
            target: Target::Block { id: "b_1".into() },
            field: "markdown".into(),
            value: json!("Beta."),
            expect: None,
        },
    ];
    let err = store.plan_effects(&c, &after_remove, &ds).unwrap_err();
    let m = expect_code(&err, ErrorCode::ConflictingEffects);
    assert_eq!(
        m.data["focus"],
        json!({ "kind": "identity", "target": { "kind": "block", "id": "b_1" } })
    );

    let unknown = [set_fm(
        Target::Document {
            id: Some("$new.0".into()),
            path: None,
        },
        "k",
        json!(1),
    )];
    let err = store.plan_effects(&c, &unknown, &ds).unwrap_err();
    let m = expect_code(&err, ErrorCode::TargetMissing);
    assert_eq!(m.data["symbol"], "$new.0");
    assert_eq!(m.data["effect_index"], 0);

    // A stale `expect.revision` is caught when planning.
    let stale = [Fx::Set {
        target: doc_by_path("a.md"),
        field: "frontmatter.k".into(),
        value: json!(1),
        expect: Some(omgbase_mutate::EffectExpect {
            revision: Some("r_9".into()),
            ..Default::default()
        }),
    }];
    let err = store.plan_effects(&c, &stale, &ds).unwrap_err();
    let m = expect_code(&err, ErrorCode::StalePlan);
    assert_eq!(m.data["expected_revision"], "r_9");
    assert_eq!(m.data["current"]["revision"], "r_0");
    // A pinned CAS the caller gets wrong is the kernel's own error, naming the op and the effect.
    let wrong_hash = [Fx::Set {
        target: Target::Block { id: "b_1".into() },
        field: "markdown".into(),
        value: json!("Beta."),
        expect: Some(omgbase_mutate::EffectExpect {
            content_hash: Some("00".into()),
            ..Default::default()
        }),
    }];
    let err = store.plan_effects(&c, &wrong_hash, &ds).unwrap_err();
    let m = expect_code(&err, ErrorCode::StaleExpectation);
    assert_eq!(m.data["op_index"], 0);
    assert_eq!(m.data["effect_index"], 0);
    assert_eq!(count(&store, "commits"), 1, "plans write nothing");
}

/// Slice 2 + 3 (3.0): `create` adopts the composed file as a loaded tree
/// whose blocks are `$new.1`, `$new.2` in pre-order; `set frontmatter.<k>`
/// on `$new.0` is a file head on it like on any loaded document (the bytes
/// are `docs_create`'s for the same mapping); the receipt maps the document
/// symbol to the `d` minted in the transaction and the block symbols to the
/// `b`s the replay's parse minted; the intent record names the symbol, not
/// the minted id.
#[test]
fn create_then_set_on_the_new_document_folds_and_maps_the_symbols() {
    let (mut store, repo, mut ds) = seeded(&[("a.md", FM_DOC)]);
    let fm: serde_json::Map<String, Value> = serde_json::from_str(r#"{"title":"N"}"#).unwrap();
    let effects = [
        Fx::Create {
            path: "/notes/n.md".into(),
            markdown: "# N\n\nNew.".into(),
            frontmatter: Some(fm),
        },
        set_fm(
            Target::Document {
                id: Some("$new.0".into()),
                path: None,
            },
            "owner",
            json!("me"),
        ),
    ];
    let plan = store.plan_effects(&ctx(&repo, T1), &effects, &ds).unwrap();
    assert_eq!(
        plan.to_json(false)["new_ids"],
        json!([
            { "symbol": "$new.0", "kind": "document" },
            { "symbol": "$new.1", "kind": "block" },
            { "symbol": "$new.2", "kind": "block" },
        ]),
        "the create's symbol, then its blocks' in pre-order"
    );
    let composed = "---\ntitle: N\nowner: me\n---\n\n# N\n\nNew.\n";
    assert_eq!(
        plan.opset.to_json()["creates"],
        json!([{ "symbol": "$new.0", "path": "notes/n.md", "source": "---\ntitle: N\n---\n\n# N\n\nNew.\n", "before_op": 0 }])
    );
    assert_eq!(
        plan.opset.to_json()["set_frontmatter"],
        json!([{ "doc": "$new.0", "raw": "---\ntitle: N\nowner: me\n---\n\n" }]),
        "the set is a head on the adopted document"
    );
    assert!(plan.opset.ops.is_empty(), "a head is not a kernel op");
    assert_eq!(plan.preconditions.absent_paths, ["notes/n.md"]);
    assert_eq!(
        plan.effects[1].to_json()["target"],
        json!({ "kind": "document", "id": "$new.0", "path": "notes/n.md" })
    );
    let preview = plan.preview.as_ref().unwrap();
    assert_eq!(preview.revisions[0].id, "$new.0");
    assert_eq!(preview.revisions[0].hash, hex(&sha256(composed.as_bytes())));
    assert_eq!(
        preview.diffs[0],
        (
            "notes/n.md".to_owned(),
            (String::new(), composed.to_owned())
        )
    );
    assert_eq!(store.mint("d").unwrap(), "d_1", "no document id burned");

    let r = store
        .execute_plan(&ctx(&repo, T1), &plan, &api_origin(), &mut ds)
        .unwrap();
    assert_eq!(
        r.to_json()["new_ids"],
        json!({ "$new.0": "d_2", "$new.1": "b_2", "$new.2": "b_3" })
    );
    assert_eq!(r.revisions.len(), 1);
    assert_eq!(r.revisions[0].doc, "d_2");
    assert_eq!(r.revisions[0].path, "notes/n.md");
    assert_eq!(ds.read("notes/n.md").unwrap().as_deref(), Some(composed));
    assert_eq!(store.reconstruct("d_2").unwrap().as_deref(), Some(composed));
    let ops: String = store
        .conn()
        .query_row(
            "SELECT ops FROM commits WHERE commit_id = ?1",
            params![r.commit],
            |r| r.get(0),
        )
        .unwrap();
    assert!(ops.contains("\"$new.0\""), "{ops}");
    assert!(!ops.contains("d_2"), "{ops}");
    // The same effects over the same state plan to the same digest.
    let (mut other, repo_b, ds_b) = seeded(&[("a.md", FM_DOC)]);
    let again = other
        .plan_effects(&ctx(&repo_b, T1), &effects, &ds_b)
        .unwrap();
    assert_eq!(again.plan_id, plan.plan_id);
}

/// `$new.n` blocks: a later effect anchors on, and edits, a block an
/// earlier insert minted — lowered through the kernel placeholder of the op
/// that minted it; the receipt maps every block symbol (a discarded re-parse
/// mint included) to the ids the replay minted, in order.
#[test]
fn new_blocks_are_referenced_through_kernel_placeholders() {
    let (mut store, repo, mut ds) = seeded(&[("a.md", FM_DOC)]);
    let effects = [
        Fx::Insert {
            into: doc_by_path("a.md"),
            at: At::End,
            markdown: "Para A.".into(),
            expect: None,
        },
        Fx::Insert {
            into: doc_by_path("a.md"),
            at: At::After("$new.0".into()),
            markdown: "Para B.".into(),
            expect: None,
        },
        Fx::Set {
            target: Target::Block {
                id: "$new.0".into(),
            },
            field: "markdown".into(),
            value: json!("Para A, edited."),
            expect: None,
        },
    ];
    let plan = store.plan_effects(&ctx(&repo, T1), &effects, &ds).unwrap();
    let ops = plan.opset.to_json()["ops"].clone();
    assert_eq!(ops[1]["to"]["at"], json!({ "after": "$0.ids[0]" }));
    assert_eq!(ops[2]["block"], "$0.ids[0]");
    assert!(ops[2].get("expect").is_none() || ops[2]["expect"]["content_hash"].is_string());
    assert_eq!(
        plan.preconditions.blocks.len(),
        0,
        "a $new block is not pinned"
    );
    assert_eq!(
        plan.to_json(false)["new_ids"],
        json!([
            { "symbol": "$new.0", "kind": "block" },
            { "symbol": "$new.1", "kind": "block" },
            { "symbol": "$new.2", "kind": "block" },
        ]),
        "two inserts and the re-parse's discarded mint"
    );
    let r = store
        .execute_plan(&ctx(&repo, T1), &plan, &api_origin(), &mut ds)
        .unwrap();
    assert_eq!(
        r.to_json()["new_ids"],
        json!({ "$new.0": "b_2", "$new.1": "b_3", "$new.2": "b_4" })
    );
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("---\nstatus: open\n---\n\n# A\n\nAlpha.\n\nPara A, edited.\n\nPara B.\n")
    );
}

/// Slice 2: `move document` with its inbound retarget is one plan and one
/// commit — the row moves, the linking source is rewritten under the same
/// commit (its hash pinned), the file is renamed; `remove document`
/// tombstones in the same vocabulary.
#[test]
fn move_document_retargets_inbound_links_in_one_commit() {
    let (mut store, repo, mut ds) = seeded(&[
        ("a.md", "# A\n\nSee [b](b.md).\n"),
        ("b.md", "# B\n\nBravo.\n"),
    ]);
    let effects = [Fx::MoveDocument {
        target: doc_by_path("b.md"),
        to: "notes/b.md".into(),
        retarget_inbound: true,
    }];
    let plan = store.plan_effects(&ctx(&repo, T1), &effects, &ds).unwrap();
    assert_eq!(plan.preconditions.absent_paths, ["notes/b.md"]);
    assert_eq!(
        plan.opset.to_json()["moves"],
        json!([{ "id": "d_1", "from": "b.md", "to": "notes/b.md" }])
    );
    assert_eq!(
        plan.opset.ops.len(),
        1,
        "one CAS-pinned update of a.md's paragraph"
    );
    assert!(matches!(
        &plan.opset.ops[0],
        Op::Update {
            expect: Some(_),
            ..
        }
    ));
    assert_eq!(plan.preconditions.blocks.len(), 1);
    assert_eq!(plan.preconditions.blocks[0].id, "b_1");
    let docs: Vec<&str> = plan
        .preconditions
        .docs
        .iter()
        .map(|d| d.id.as_str())
        .collect();
    assert_eq!(
        docs,
        ["d_0", "d_1"],
        "the source first (loaded), then the moved document"
    );
    let preview = plan.preview.as_ref().unwrap();
    let paths: Vec<&str> = preview.diffs.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(paths, ["a.md", "b.md", "notes/b.md"]);
    assert_eq!(preview.diffs[0].1.1, "# A\n\nSee [b](notes/b.md).\n");
    assert_eq!(
        preview.diffs[2].1,
        (String::new(), "# B\n\nBravo.\n".to_owned())
    );
    // The retarget's `update` re-parses its markdown, minting one id the
    // kernel then replaces by the target's: a mint with no block, a symbol
    // all the same (§10).
    assert_eq!(
        plan.to_json(false)["new_ids"],
        json!([{ "symbol": "$new.0", "kind": "block" }])
    );

    let r = store
        .execute_plan(&ctx(&repo, T1), &plan, &api_origin(), &mut ds)
        .unwrap();
    assert_eq!(r.commit.as_deref(), Some("c_2"));
    assert_eq!(
        r.revisions.len(),
        1,
        "the rewritten source; a move alone has no revision"
    );
    assert_eq!(r.revisions[0].doc, "d_0");
    assert_eq!(r.new_ids.len(), 1, "{:?}", r.new_ids);
    assert_eq!(count(&store, "commits"), 3);
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("# A\n\nSee [b](notes/b.md).\n")
    );
    assert!(!ds.exists("b.md"));
    assert_eq!(
        ds.read("notes/b.md").unwrap().as_deref(),
        Some("# B\n\nBravo.\n")
    );
    assert_eq!(
        current_revs(&store),
        vec![
            ("a.md".into(), "r_2".into()),
            ("notes/b.md".into(), "r_1".into())
        ]
    );

    let EffectsOutcome::Receipt(r) = store
        .apply_effects(
            &ctx(&repo, T2),
            &[Fx::RemoveDocument {
                target: doc_by_path("notes/b.md"),
            }],
            &api_origin(),
            &mut ds,
            false,
        )
        .unwrap()
    else {
        panic!("receipt")
    };
    assert!(r.commit.is_some());
    assert!(r.revisions.is_empty());
    assert!(!ds.exists("notes/b.md"));
    assert_eq!(store.reconstruct("d_1").unwrap(), None);
    let _: Receipt = r;
}

// ---- slice 3: writing into a created document (spec/mutate §11.3, mutate 3.0) -------------

/// A `create` is a loaded tree: its blocks are `$new.k` in pre-order right
/// after its document symbol, and every later effect addresses them — an
/// insert into the document (by symbol) and into one of its sections, a
/// `set markdown` on one of its blocks, a cross-document move INTO it, a
/// remove of one of its blocks. The kernel ops carry the symbols; the plan
/// records the create's `before_op`; the replay re-adopts the file at that
/// position under the production minter, so the i-th `b` IS the i-th block
/// symbol and the receipt maps every symbol; the created document's rows
/// are `inserted / 1 / api / NULL` — the known-id path, no matcher.
#[test]
fn a_created_document_is_a_loaded_tree_later_effects_address() {
    let (mut store, repo, mut ds) = seeded(&[("a.md", FM_DOC)]);
    let new_doc = Target::Document {
        id: Some("$new.0".into()),
        path: None,
    };
    let effects = [
        Fx::Create {
            path: "notes/n.md".into(),
            markdown: "# N\n\n## Section\n\nBody.".into(),
            frontmatter: None,
        },
        Fx::Insert {
            into: new_doc.clone(),
            at: At::End,
            markdown: "Tail.".into(),
            expect: None,
        },
        insert_section("$new.2", "In section."),
        Fx::Set {
            target: Target::Block {
                id: "$new.3".into(),
            },
            field: "markdown".into(),
            value: json!("Body, edited."),
            expect: None,
        },
        Fx::MoveBlocks {
            targets: vec!["b_1".into()],
            into: new_doc,
            at: At::Start,
            expect: None,
        },
        Fx::RemoveBlocks {
            targets: vec!["$new.1".into()],
            expect: None,
        },
    ];
    let plan = store.plan_effects(&ctx(&repo, T1), &effects, &ds).unwrap();
    assert_eq!(
        plan.to_json(false)["new_ids"],
        json!([
            { "symbol": "$new.0", "kind": "document" },
            { "symbol": "$new.1", "kind": "block" },
            { "symbol": "$new.2", "kind": "block" },
            { "symbol": "$new.3", "kind": "block" },
            { "symbol": "$new.4", "kind": "block" },
            { "symbol": "$new.5", "kind": "block" },
            { "symbol": "$new.6", "kind": "block" },
        ]),
        "the document, its three blocks in pre-order, the two inserts', the re-parse's discarded mint"
    );
    let opset = plan.opset.to_json();
    assert_eq!(
        opset["creates"],
        json!([{ "symbol": "$new.0", "path": "notes/n.md", "source": "# N\n\n## Section\n\nBody.\n", "before_op": 0 }])
    );
    assert_eq!(
        opset["ops"],
        json!([
            { "op": "insert", "doc": "$new.0", "to": { "parent": { "doc": true }, "at": "end" }, "markdown": "Tail." },
            { "op": "insert", "to": { "parent": { "heading": "$new.2", "scope": "section" }, "at": "end" }, "markdown": "In section." },
            { "op": "update", "block": "$new.3", "markdown": "Body, edited.", "expect": { "content_hash": omgbase_mutate::raw_hash_hex("Body.") } },
            { "op": "move", "blocks": ["b_1"], "to": { "parent": { "doc": true }, "at": "start" }, "doc": "$new.0" },
            { "op": "remove", "blocks": ["$new.1"], "expect": { "$new.1": { "content_hash": omgbase_mutate::raw_hash_hex("# N") } } },
        ]),
        "the created document's blocks are named by their symbols"
    );
    // Preconditions: the loaded document's triple only (the created one is
    // absent by path); no pin for a symbol.
    assert_eq!(plan.preconditions.docs.len(), 1);
    assert_eq!(plan.preconditions.docs[0].id, "d_0");
    assert!(plan.preconditions.blocks.is_empty());
    assert_eq!(plan.preconditions.absent_paths, ["notes/n.md"]);
    let after = "Alpha.\n\n## Section\n\nBody, edited.\n\nTail.\n\nIn section.\n";
    let preview = plan.preview.as_ref().unwrap();
    assert_eq!(
        preview
            .revisions
            .iter()
            .map(|r| (r.id.as_str(), r.path.as_str()))
            .collect::<Vec<_>>(),
        [("$new.0", "notes/n.md"), ("d_0", "a.md")],
        "load order: the create first, then the move's source"
    );
    assert_eq!(preview.revisions[0].hash, hex(&sha256(after.as_bytes())));
    assert_eq!(
        preview.diffs[0],
        ("notes/n.md".to_owned(), (String::new(), after.to_owned()))
    );
    assert_eq!(preview.results[0].ids, ["$new.4"], "the insert's block");
    assert_eq!(
        preview.results[4].removed.as_deref(),
        Some(&["$new.1".to_owned()][..])
    );
    assert_eq!(store.mint("b").unwrap(), "b_2", "the plan minted nothing");

    let r = store
        .execute_plan(&ctx(&repo, T1), &plan, &api_origin(), &mut ds)
        .unwrap();
    assert_eq!(
        r.to_json()["new_ids"],
        json!({
            "$new.0": "d_1",
            "$new.1": "b_3", "$new.2": "b_4", "$new.3": "b_5",
            "$new.4": "b_6", "$new.5": "b_7", "$new.6": "b_8",
        }),
        "the parse's mints (after the b_2 above), the inserts', the update's re-parse; the d from the ingest"
    );
    assert_eq!(
        r.revisions
            .iter()
            .map(|r| (r.doc.as_str(), r.path.as_str()))
            .collect::<Vec<_>>(),
        [("d_1", "notes/n.md"), ("d_0", "a.md")]
    );
    assert_eq!(ds.read("notes/n.md").unwrap().as_deref(), Some(after));
    assert_eq!(store.reconstruct("d_1").unwrap().as_deref(), Some(after));
    assert_eq!(
        ds.read("a.md").unwrap().as_deref(),
        Some("---\nstatus: open\n---\n\n# A\n\n"),
        "the source keeps the moved block's separator (the kernel's move rule)"
    );
    // The created document's dispositions: known-id `inserted / api`, no
    // matcher; the removed heading was never committed.
    type Row = (String, String, Option<f64>, Option<String>, Option<String>);
    let rows: Vec<Row> = {
        let mut stmt = store
            .conn()
            .prepare(
                "SELECT d.block_id, d.kind, d.confidence, d.reason, d.matcher_v FROM dispositions d
                 JOIN blocks b ON b.block_id = d.block_id
                 WHERE b.doc_id = 'd_1' AND d.commit_id = ?1 ORDER BY d.block_id",
            )
            .unwrap();
        stmt.query_map(params![r.commit.as_deref().unwrap()], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
    };
    let ids: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
    assert_eq!(
        ids,
        ["b_1", "b_4", "b_5", "b_6", "b_7"],
        "b_3 (`# N`) was removed before the commit; b_1 moved in from a.md"
    );
    for (id, kind, confidence, reason, matcher_v) in &rows {
        assert_eq!(
            (
                kind.as_str(),
                *confidence,
                reason.as_deref(),
                matcher_v.as_deref()
            ),
            ("inserted", Some(1.0), Some("api"), None),
            "{id}"
        );
    }
    // Deterministic: the same effects over the same state digest the same.
    let (mut other, repo_b, ds_b) = seeded(&[("a.md", FM_DOC)]);
    let again = other
        .plan_effects(&ctx(&repo_b, T1), &effects, &ds_b)
        .unwrap();
    assert_eq!(again.plan_id, plan.plan_id);
}

/// A `create` later in the list: its blocks are minted after the ops before
/// it, `before_op` records the position, and the replay re-adopts it there —
/// so the positional zip pairs the right ids wherever the create sits.
#[test]
fn a_create_after_a_minting_effect_keeps_the_plan_mint_order() {
    let (mut store, repo, mut ds) = seeded(&[("a.md", FM_DOC)]);
    let effects = [
        insert_section("b_0", "Tail."),
        Fx::Create {
            path: "n.md".into(),
            markdown: "# N\n\nNew.".into(),
            frontmatter: None,
        },
        Fx::Insert {
            into: Target::Document {
                id: Some("$new.1".into()),
                path: None,
            },
            at: At::Start,
            markdown: "Lead.".into(),
            expect: None,
        },
    ];
    let plan = store.plan_effects(&ctx(&repo, T1), &effects, &ds).unwrap();
    assert_eq!(
        plan.to_json(false)["new_ids"],
        json!([
            { "symbol": "$new.0", "kind": "block" },
            { "symbol": "$new.1", "kind": "document" },
            { "symbol": "$new.2", "kind": "block" },
            { "symbol": "$new.3", "kind": "block" },
            { "symbol": "$new.4", "kind": "block" },
        ])
    );
    assert_eq!(plan.opset.creates[0].before_op, 1);
    let r = store
        .execute_plan(&ctx(&repo, T1), &plan, &api_origin(), &mut ds)
        .unwrap();
    assert_eq!(
        r.to_json()["new_ids"],
        json!({ "$new.0": "b_2", "$new.1": "d_1", "$new.2": "b_3", "$new.3": "b_4", "$new.4": "b_5" })
    );
    assert_eq!(
        ds.read("n.md").unwrap().as_deref(),
        Some("Lead.\n\n# N\n\nNew.\n")
    );
    assert_eq!(
        store.reconstruct("d_1").unwrap().as_deref(),
        Some("Lead.\n\n# N\n\nNew.\n")
    );
    // The created document's first block is the insert's; its row is b_5.
    let first: String = store
        .conn()
        .query_row(
            "SELECT block_id FROM blocks WHERE doc_id = 'd_1' AND deleted_commit IS NULL ORDER BY ordinal LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(first, "b_5");
}

/// `$new.0` named before the create that allocates it is `target_missing`
/// naming the symbol (and the effect).
#[test]
fn a_symbol_named_before_its_create_is_target_missing() {
    let (mut store, repo, ds) = seeded(&[("a.md", FM_DOC)]);
    let effects = [
        Fx::Insert {
            into: Target::Document {
                id: Some("$new.0".into()),
                path: None,
            },
            at: At::End,
            markdown: "World.".into(),
            expect: None,
        },
        Fx::Create {
            path: "new.md".into(),
            markdown: "# New".into(),
            frontmatter: None,
        },
    ];
    let err = store
        .plan_effects(&ctx(&repo, T1), &effects, &ds)
        .unwrap_err();
    let m = expect_code(&err, ErrorCode::TargetMissing);
    assert_eq!(m.message, "$new.0 is not created by an earlier effect");
    assert_eq!(m.data["symbol"], json!("$new.0"));
    assert_eq!(m.data["effect_index"], json!(0));
    // A `set content` on a created document is refused: its content is the
    // create's markdown.
    let err = store
        .plan_effects(
            &ctx(&repo, T1),
            &[
                Fx::Create {
                    path: "new.md".into(),
                    markdown: "# New".into(),
                    frontmatter: None,
                },
                Fx::Set {
                    target: Target::Document {
                        id: Some("$new.0".into()),
                        path: None,
                    },
                    field: "content".into(),
                    value: json!("# Other\n"),
                    expect: None,
                },
            ],
            &ds,
        )
        .unwrap_err();
    let m = expect_code(&err, ErrorCode::TargetMissing);
    assert!(
        m.message.contains("its content is the create's markdown"),
        "{}",
        m.message
    );
}

/// `set document.content` surfaces the whole-document planner's decision as
/// `preview.identity[doc]` — the Opset's `matcher_v`, `summary`, per-op
/// `{ op_index, disposition, blocks, confidence, reason, detail? }` and
/// `diagnostics` — and a content already current plans nothing: no op, no
/// loaded document, the triple kept as a precondition, no commit.
#[test]
fn set_content_previews_the_identity_decision_and_a_no_change_commits_nothing() {
    let (mut store, repo, mut ds) = seeded(&[("a.md", FM_DOC)]);
    let content = "---\nstatus: open\n---\n\n# A\n\nAlpha, revised.\n\nBeta.\n";
    let opset = store
        .plan_update(&repo, "a.md", content, &Config::default())
        .unwrap();
    let set = |value: &str| Fx::Set {
        target: doc_by_path("a.md"),
        field: "content".into(),
        value: json!(value),
        expect: None,
    };
    let plan = store
        .plan_effects(&ctx(&repo, T1), &[set(content)], &ds)
        .unwrap();
    assert_eq!(plan.opset.ops.len(), opset.ops.len());
    let preview = plan.preview.as_ref().unwrap();
    assert_eq!(preview.identity.len(), 1);
    let (doc, identity) = &preview.identity[0];
    assert_eq!(doc, "d_0");
    assert_eq!(identity.matcher_v, opset.matcher_v);
    assert_eq!(identity.summary, opset.summary);
    assert_eq!(identity.diagnostics, opset.diagnostics);
    assert_eq!(identity.ops.len(), opset.ops.len());
    for (i, (got, want)) in identity.ops.iter().zip(&opset.ops).enumerate() {
        assert_eq!(got.op_index, i, "the i-th op of the plan's opset");
        assert_eq!(got.disposition, want.disposition);
        assert_eq!(got.blocks, want.blocks);
        assert_eq!(got.confidence, want.confidence);
        assert_eq!(got.reason, want.reason);
        assert_eq!(got.detail, want.detail);
    }
    assert!(preview.retarget.is_empty());
    let wire = plan.to_json(true);
    let identity_json = &wire["preview"]["identity"]["d_0"];
    assert_eq!(identity_json["summary"], opset.summary.to_json());
    assert_eq!(identity_json["ops"][0]["op_index"], json!(0));
    assert!(
        wire["preview"].get("retarget").is_none(),
        "absent when empty"
    );
    // The wire round-trips.
    let back = Plan::from_json(&wire).unwrap();
    assert_eq!(back.preview, plan.preview);

    // The content already current: a plan with nothing to do.
    let same = store
        .plan_effects(&ctx(&repo, T1), &[set(FM_DOC)], &ds)
        .unwrap();
    assert!(same.opset.ops.is_empty());
    assert!(same.opset.set_frontmatter.is_empty());
    assert_eq!(
        same.preconditions.docs.len(),
        1,
        "the triple stays a precondition"
    );
    let preview = same.preview.as_ref().unwrap();
    assert!(preview.revisions.is_empty(), "nothing is loaded");
    assert_eq!(preview.identity[0].1.summary.preserved, 2);
    assert!(preview.identity[0].1.ops.is_empty());
    let commits = count(&store, "commits");
    let r = store
        .execute_plan(&ctx(&repo, T1), &same, &api_origin(), &mut ds)
        .unwrap();
    assert_eq!(r.commit, None);
    assert!(r.revisions.is_empty());
    assert_eq!(count(&store, "commits"), commits, "no commit row");
    assert_eq!(ds.read("a.md").unwrap().as_deref(), Some(FM_DOC));
}

/// A `retarget` effect surfaces what `links_repair` found as
/// `preview.retarget[]`: `{ effect_index, hits: [{ id, path, oldRaw, newRaw }],
/// pairs: [{ from, to, hits }] }`.
#[test]
fn a_retarget_effect_previews_its_hits_and_pairs() {
    let (mut store, repo, ds) = seeded(&[
        ("a.md", "# A\n\nSee [b](b.md) and [c](c.md).\n"),
        ("b.md", "# B\n"),
        ("c.md", "# C\n"),
    ]);
    let effects = [Fx::Retarget {
        repairs: vec![
            omgbase_mutate::effects::Repair {
                from: "/b.md".into(),
                to: "/moved/b.md".into(),
            },
            omgbase_mutate::effects::Repair {
                from: "/nope.md".into(),
                to: "/x.md".into(),
            },
        ],
        path_glob: None,
    }];
    let plan = store.plan_effects(&ctx(&repo, T1), &effects, &ds).unwrap();
    let preview = plan.preview.as_ref().unwrap();
    assert_eq!(preview.retarget.len(), 1);
    let rt = &preview.retarget[0];
    assert_eq!(rt.effect_index, 0);
    assert_eq!(rt.hits.len(), 1);
    assert_eq!(rt.hits[0].id, "b_1");
    assert_eq!(rt.hits[0].path, "a.md");
    assert_eq!(rt.hits[0].old_raw, "See [b](b.md) and [c](c.md).");
    assert_eq!(rt.hits[0].new_raw, "See [b](/moved/b.md) and [c](c.md).");
    assert_eq!(
        rt.pairs
            .iter()
            .map(|p| (p.from.as_str(), p.to.as_str(), p.hits))
            .collect::<Vec<_>>(),
        [("/b.md", "/moved/b.md", 1), ("/nope.md", "/x.md", 0)]
    );
    let wire = plan.to_json(true);
    assert_eq!(
        wire["preview"]["retarget"][0]["hits"][0]["oldRaw"],
        json!("See [b](b.md) and [c](c.md).")
    );
    assert!(wire["preview"].get("identity").is_none());
    assert_eq!(Plan::from_json(&wire).unwrap().preview, plan.preview);
}
