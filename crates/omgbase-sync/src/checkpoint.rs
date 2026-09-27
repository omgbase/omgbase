//! Checkpoints (`spec/sync/README.md` §4.1): one `checkpoints` row per batch
//! observed through the filesystem fast path or the adapter driver, then the
//! pool sweep.

use std::path::Path;

use omgbase_reconcile::Config;
use omgbase_store::{BatchItem, BatchOutcome, Store};
use rusqlite::params;
use serde_json::Value;

use crate::error::Result;
use crate::fs::FileSystem;

/// What a checkpoint produced, in batch order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CheckpointResult {
    pub checkpoint_id: String,
    /// Paths that produced observed commits.
    pub ingested: Vec<String>,
    /// Echoes: the hash already matched.
    pub suppressed: Vec<String>,
    /// Gone members that had a live doc.
    pub deleted: Vec<String>,
    /// Ingested but carrying git conflict markers.
    pub conflicted: Vec<String>,
}

impl CheckpointResult {
    /// `{ checkpoint_id, ingested, suppressed, deleted, conflicted }`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "checkpoint_id": self.checkpoint_id,
            "ingested": self.ingested,
            "suppressed": self.suppressed,
            "deleted": self.deleted,
            "conflicted": self.conflicted,
        })
    }
}

/// The `files` column of a checkpoint: `[[path, old_hash | null, new_hash |
/// null], …]` in batch order.
#[must_use]
pub fn files_json(outcomes: &[BatchOutcome]) -> Value {
    Value::Array(
        outcomes
            .iter()
            .map(|o| match o {
                BatchOutcome::Deleted(d) => {
                    serde_json::json!([d.path, d.old_hash_hex, Value::Null])
                }
                BatchOutcome::Observed(ob) => {
                    serde_json::json!([ob.path, ob.old_hash_hex, ob.new_hash_hex])
                }
            })
            .collect(),
    )
}

/// §4.1: bucket the outcomes, **mint `cp`**, insert the row, sweep the pool
/// at `ts` (`spec/store` §5.5).
pub fn finish_checkpoint(
    store: &mut Store,
    repo_id: &str,
    outcomes: &[BatchOutcome],
    ts: &str,
    git_head: Option<&str>,
) -> Result<CheckpointResult> {
    let checkpoint_id = store.mint("cp")?;
    let mut result = CheckpointResult {
        checkpoint_id: checkpoint_id.clone(),
        ..CheckpointResult::default()
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
    store.conn().execute(
        "INSERT INTO checkpoints (id, repo_id, ts, files, git_head) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            checkpoint_id,
            repo_id,
            ts,
            files_json(outcomes).to_string(),
            git_head
        ],
    )?;
    store.sweep_pool(ts)?;
    Ok(result)
}

/// §4.1 `process_checkpoint`: read each path under `root` (`None` when
/// absent), `observe_batch`, record the checkpoint.
#[allow(clippy::too_many_arguments)]
pub fn process_checkpoint(
    store: &mut Store,
    repo_id: &str,
    fs: &dyn FileSystem,
    root: &Path,
    paths: &[String],
    ts: &str,
    git_head: Option<&str>,
    config: &Config,
) -> Result<CheckpointResult> {
    let mut items = Vec::with_capacity(paths.len());
    for path in paths {
        items.push(BatchItem {
            path: path.clone(),
            source: fs.read(root, path)?,
        });
    }
    let outcomes = store.observe_batch(repo_id, &items, ts, config)?;
    finish_checkpoint(store, repo_id, &outcomes, ts, git_head)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::MemFileSystem;
    use omgbase_store::SequentialMinter;

    const TS: &str = "2026-09-26T10:00:00.000Z";

    #[test]
    fn checkpoint_buckets_and_files_column() {
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
        let r = process_checkpoint(
            &mut store,
            &repo,
            &fs,
            root,
            &paths,
            TS,
            None,
            &Config::default(),
        )
        .unwrap();
        assert_eq!(r.checkpoint_id, "cp_0");
        assert_eq!(r.ingested, ["a.md"]);
        assert_eq!(r.conflicted, ["c.md"]);
        assert!(r.deleted.is_empty(), "nothing was live at gone.md");
        assert!(r.suppressed.is_empty());

        // Echo + a real deletion, with a git head.
        fs.remove("c.md");
        let r2 = process_checkpoint(
            &mut store,
            &repo,
            &fs,
            root,
            &paths,
            TS,
            Some("abc123"),
            &Config::default(),
        )
        .unwrap();
        assert_eq!(r2.checkpoint_id, "cp_1");
        assert_eq!(r2.suppressed, ["a.md"]);
        assert_eq!(r2.deleted, ["c.md"]);
        assert_eq!(r2.to_json()["deleted"], serde_json::json!(["c.md"]));

        let rows: Vec<(String, String, Option<String>)> = {
            let mut stmt = store
                .conn()
                .prepare(
                    "SELECT id, files, git_head FROM checkpoints WHERE repo_id = ?1 ORDER BY rowid",
                )
                .unwrap();
            stmt.query_map(params![repo], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        assert_eq!(rows.len(), 2);
        let files: Value = serde_json::from_str(&rows[0].1).unwrap();
        assert_eq!(files.as_array().unwrap().len(), 3);
        assert_eq!(files[0][0], "a.md");
        assert_eq!(files[0][1], Value::Null);
        assert_eq!(files[0][2].as_str().unwrap().len(), 64);
        assert_eq!(files[2], serde_json::json!(["gone.md", null, null]));
        assert_eq!(rows[1].2.as_deref(), Some("abc123"));
        let files2: Value = serde_json::from_str(&rows[1].1).unwrap();
        assert_eq!(files2[0][1], files2[0][2], "an echo repeats the hash");
        assert_eq!(files2[1][2], Value::Null);
        assert!(files2[1][1].is_string(), "the gone member's prior hash");
        assert!(!rows[0].1.contains(' '), "compact JSON like JSON.stringify");
    }
}
