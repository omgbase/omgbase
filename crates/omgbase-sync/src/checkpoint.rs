//! The batch and the status row (`spec/sync/README.md` §4.1, 4.0): every
//! batch observed through the filesystem fast path or the adapter driver
//! updates the repository's reserved **status row** of `sync_state` —
//! `(repo_id, '', '')` with `last_batch_ts`, `last_batch_id`,
//! `last_batch_files` — then sweeps the pool: the row and the sweep in **one**
//! transaction, so a batch never leaves a status whose sweep did not run (or
//! the reverse). Each member's commit is still its own transaction
//! (`spec/store` §5.4). Since store 17.0 (D4) a batch records no row of its
//! own: the `checkpoints` table is gone, its id is the feed's `batch_id` (the
//! first committing member's commit id, which every member's feed row
//! carries) and no `cp` is minted.

use std::path::Path;

use omgbase_reconcile::Config;
use omgbase_store::{BatchItem, BatchOutcome, Store};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::error::Result;
use crate::fs::FileSystem;

/// What a batch produced, in batch order (§4.1, 4.0): `batch_id` is the
/// feed's `batch_id` — `None` when nothing committed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BatchResult {
    pub batch_id: Option<String>,
    /// Paths that produced observed commits.
    pub ingested: Vec<String>,
    /// Echoes: the hash already matched.
    pub suppressed: Vec<String>,
    /// Gone members that had a live doc.
    pub deleted: Vec<String>,
    /// Ingested but carrying git conflict markers.
    pub conflicted: Vec<String>,
}

/// The name the result carried through `spec/sync` 3.x (`checkpoint_id`
/// then; `batch_id` since 4.0).
pub type CheckpointResult = BatchResult;

impl BatchResult {
    /// `{ batch_id, ingested, suppressed, deleted, conflicted }`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "batch_id": self.batch_id,
            "ingested": self.ingested,
            "suppressed": self.suppressed,
            "deleted": self.deleted,
            "conflicted": self.conflicted,
        })
    }
}

/// The last observed batch as the status row records it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastBatch {
    pub ts: String,
    /// The feed's `batch_id`; `None` when the batch committed nothing.
    pub batch_id: Option<String>,
    /// The member count.
    pub files: i64,
}

impl LastBatch {
    /// `{ ts, batchId, files }` as `sync_status.lastBatch` carries it.
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({ "ts": self.ts, "batchId": self.batch_id, "files": self.files })
    }
}

/// The batch's id (`spec/store` §5.4 step 5, D4): the first committing
/// member's commit id, or `None` when nothing committed.
#[must_use]
pub fn batch_id_of(outcomes: &[BatchOutcome]) -> Option<String> {
    outcomes.iter().find_map(|o| match o {
        BatchOutcome::Deleted(d) => d.commit_id.clone(),
        BatchOutcome::Observed(ob) => ob.commit_id.clone(),
    })
}

/// The repository's status row (§4.1; `spec/store` §3.1 `sync_state`):
/// `(repo_id, '', '')` with the last batch's `ts`, `batch_id` and member
/// count. Runs on the caller's connection (the batch's transaction).
pub fn write_status_row(
    conn: &Connection,
    repo_id: &str,
    ts: &str,
    batch_id: Option<&str>,
    files: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_state (repo_id, source_id, path, revision, cursor, last_batch_ts, last_batch_id, last_batch_files) VALUES (?1, '', '', NULL, NULL, ?2, ?3, ?4)
         ON CONFLICT(repo_id, source_id, path) DO UPDATE SET last_batch_ts = excluded.last_batch_ts, last_batch_id = excluded.last_batch_id, last_batch_files = excluded.last_batch_files",
        params![repo_id, ts, batch_id, files],
    )?;
    Ok(())
}

/// The last observed batch of the repository (the status row), or `None`
/// when none ran.
pub fn last_batch(conn: &Connection, repo_id: &str) -> Result<Option<LastBatch>> {
    let row: Option<(Option<String>, Option<String>, Option<i64>)> = conn
        .query_row(
            "SELECT last_batch_ts, last_batch_id, last_batch_files FROM sync_state WHERE repo_id = ?1 AND source_id = '' AND path = ''",
            params![repo_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    Ok(match row {
        Some((Some(ts), batch_id, files)) => Some(LastBatch {
            ts,
            batch_id,
            files: files.unwrap_or(0),
        }),
        _ => None,
    })
}

/// §4.1: bucket the outcomes, write the status row and sweep the pool at
/// `ts` (`spec/store` §5.5) in one transaction: a failing sweep rolls the
/// row back. Nothing is minted — the batch's id is the feed's (D4).
pub fn finish_checkpoint(
    store: &mut Store,
    repo_id: &str,
    outcomes: &[BatchOutcome],
    ts: &str,
) -> Result<BatchResult> {
    let mut result = BatchResult {
        batch_id: batch_id_of(outcomes),
        ..BatchResult::default()
    };
    for o in outcomes {
        match o {
            BatchOutcome::Deleted(d) => {
                if d.doc_id.is_some() {
                    result.deleted.push(d.path.clone());
                }
            }
            BatchOutcome::Observed(ob) => {
                if ob.echo {
                    result.suppressed.push(ob.path.clone());
                } else if ob.conflicted {
                    result.conflicted.push(ob.path.clone());
                } else {
                    result.ingested.push(ob.path.clone());
                }
            }
        }
    }
    let tx = store.transaction()?;
    write_status_row(
        &tx,
        repo_id,
        ts,
        result.batch_id.as_deref(),
        i64::try_from(outcomes.len()).unwrap_or(i64::MAX),
    )?;
    omgbase_store::derived::sweep_pool(&tx, ts)?;
    tx.commit()?;
    Ok(result)
}

/// §4.1 `process_checkpoint`: read each path under `root` (`None` when
/// absent), `observe_batch`, write the status row.
pub fn process_checkpoint(
    store: &mut Store,
    repo_id: &str,
    fs: &dyn FileSystem,
    root: &Path,
    paths: &[String],
    ts: &str,
    config: &Config,
) -> Result<BatchResult> {
    let mut items = Vec::with_capacity(paths.len());
    for path in paths {
        items.push(BatchItem {
            path: path.clone(),
            source: fs.read(root, path)?,
        });
    }
    let outcomes = store.observe_batch(repo_id, &items, ts, config)?;
    finish_checkpoint(store, repo_id, &outcomes, ts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::MemFileSystem;
    use omgbase_store::SequentialMinter;

    const TS: &str = "2026-09-26T10:00:00.000Z";
    const TS2: &str = "2026-09-26T10:01:00.000Z";

    fn status_row(
        store: &Store,
        repo: &str,
    ) -> Option<(Option<String>, Option<String>, Option<i64>)> {
        store
            .conn()
            .query_row(
                "SELECT last_batch_ts, last_batch_id, last_batch_files FROM sync_state WHERE repo_id = ?1 AND source_id = '' AND path = ''",
                params![repo],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .unwrap()
    }

    #[test]
    fn batch_buckets_batch_id_and_the_status_row() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let mut fs = MemFileSystem::new();
        fs.set("a.md", "# A\n\nOne.\n", 1);
        fs.set("c.md", "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n", 2);
        let root = Path::new("/r");
        let paths: Vec<String> = ["a.md", "c.md", "gone.md"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let r = process_checkpoint(&mut store, &repo, &fs, root, &paths, TS, &Config::default())
            .unwrap();
        assert_eq!(r.batch_id.as_deref(), Some("c_0"));
        assert_eq!(r.ingested, ["a.md"]);
        assert_eq!(r.conflicted, ["c.md"]);
        assert!(r.deleted.is_empty(), "nothing was live at gone.md");
        assert!(r.suppressed.is_empty());
        // Both committing members' feed rows carry the batch id; the first is its own.
        let batches: Vec<(String, String)> = {
            let mut stmt = store
                .conn()
                .prepare("SELECT commit_id, batch_id FROM feed WHERE repo_id = ?1 ORDER BY seq")
                .unwrap();
            stmt.query_map(params![repo], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        assert_eq!(
            batches,
            [
                ("c_0".to_owned(), "c_0".to_owned()),
                ("c_1".to_owned(), "c_0".to_owned())
            ]
        );
        assert_eq!(
            status_row(&store, &repo),
            Some((Some(TS.to_owned()), Some("c_0".to_owned()), Some(3)))
        );
        assert_eq!(
            last_batch(store.conn(), &repo).unwrap(),
            Some(LastBatch {
                ts: TS.to_owned(),
                batch_id: Some("c_0".to_owned()),
                files: 3
            })
        );

        // Echo + a real deletion: the tombstone is the batch's first commit.
        fs.remove("c.md");
        let r2 = process_checkpoint(
            &mut store,
            &repo,
            &fs,
            root,
            &paths,
            TS2,
            &Config::default(),
        )
        .unwrap();
        assert_eq!(r2.batch_id.as_deref(), Some("c_2"));
        assert_eq!(r2.suppressed, ["a.md"]);
        assert_eq!(r2.deleted, ["c.md"]);
        assert_eq!(r2.to_json()["deleted"], serde_json::json!(["c.md"]));
        assert_eq!(r2.to_json()["batch_id"], "c_2");
        assert_eq!(
            status_row(&store, &repo),
            Some((Some(TS2.to_owned()), Some("c_2".to_owned()), Some(3)))
        );

        // An empty batch (every member an echo): a row with no batch id.
        let r3 = process_checkpoint(
            &mut store,
            &repo,
            &fs,
            root,
            &["a.md".to_owned()],
            TS2,
            &Config::default(),
        )
        .unwrap();
        assert_eq!(r3.batch_id, None);
        assert_eq!(
            status_row(&store, &repo),
            Some((Some(TS2.to_owned()), None, Some(1)))
        );
        assert_eq!(
            last_batch(store.conn(), &repo).unwrap().unwrap().to_json(),
            serde_json::json!({ "ts": TS2, "batchId": null, "files": 1 })
        );
        // No `checkpoints` table, no `cp` minted (D4).
        let has_table: Option<i64> = store
            .conn()
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'checkpoints'",
                [],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(has_table, None);
        let cps: i64 = store
            .conn()
            .query_row(
                "SELECT count(*) FROM id_claims WHERE prefix = 'cp'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cps, 0);
        assert_eq!(last_batch(store.conn(), "rp_nope").unwrap(), None);
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

    fn status_rows(store: &Store) -> i64 {
        store
            .conn()
            .query_row(
                "SELECT count(*) FROM sync_state WHERE source_id = '' AND path = ''",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    /// §4.1: the status row and the pool sweep are one transaction.
    #[test]
    fn status_row_and_sweep_share_one_transaction() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        start_trace(store.conn());
        let r = finish_checkpoint(&mut store, &repo, &[], TS).unwrap();
        assert_eq!(r.batch_id, None);
        let log = traced();
        let row = tx_of(&log, "INSERT INTO sync_state");
        assert!(row.is_some(), "the row rides a transaction: {log:#?}");
        assert_eq!(
            row,
            tx_of(&log, "DELETE FROM resurrection_pool WHERE expires_ts"),
            "… the same one as the sweep: {log:#?}"
        );
        assert_eq!(status_rows(&store), 1);
        assert!(store.conn().is_autocommit(), "nothing left open");

        // Through `process_checkpoint` too (a member commit is its own
        // transaction; the row + sweep follow in theirs).
        let mut fs = MemFileSystem::new();
        fs.set("a.md", "# A\n\nOne.\n", 1);
        start_trace(store.conn());
        let paths = vec!["a.md".to_owned()];
        process_checkpoint(
            &mut store,
            &repo,
            &fs,
            Path::new("/r"),
            &paths,
            TS,
            &Config::default(),
        )
        .unwrap();
        let log = traced();
        let member = tx_of(&log, "INSERT INTO commits");
        let row = tx_of(&log, "INSERT INTO sync_state");
        assert!(member.is_some() && row.is_some(), "{log:#?}");
        assert_ne!(member, row, "the member's commit is its own transaction");
        assert_eq!(
            row,
            tx_of(&log, "DELETE FROM resurrection_pool WHERE expires_ts")
        );
        assert_eq!(status_rows(&store), 1, "one status row per repository");
    }

    /// Failure injection: a sweep that fails rolls the status row back,
    /// leaving neither half.
    #[test]
    fn a_failing_sweep_leaves_no_status_row() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        store
            .conn()
            .execute_batch("DROP TABLE resurrection_pool")
            .unwrap();
        start_trace(store.conn());
        let err = finish_checkpoint(&mut store, &repo, &[], TS).unwrap_err();
        assert!(
            err.to_string().contains("resurrection_pool"),
            "the sweep failed: {err}"
        );
        assert_eq!(status_rows(&store), 0, "the row was rolled back");
        assert!(store.conn().is_autocommit(), "the transaction is closed");
        let log = traced();
        assert!(
            log.iter().any(|s| s.starts_with("INSERT INTO sync_state")),
            "the row was attempted: {log:#?}"
        );
        assert!(
            log.iter().any(|s| s.starts_with("ROLLBACK")),
            "… and rolled back: {log:#?}"
        );
        assert!(!log.iter().any(|s| s.starts_with("COMMIT")));
    }
}
