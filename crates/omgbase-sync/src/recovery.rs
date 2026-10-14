//! Startup recovery (`spec/sync/README.md` §4.3 "Recovery"): first the
//! pending materializations are replayed (store 14.0 — the files an `api`
//! commit still owes are written, not mistaken for divergence), then every
//! live doc's file is checked against its current revision; a divergent file
//! is re-ingested as an observed commit, one document at a time (§9).

use std::path::Path;

use omgbase_format::hash::sha256;
use omgbase_reconcile::Config;
use omgbase_store::{Origin, Store};
use rusqlite::params;
use serde_json::Value;

use crate::error::Result;
use crate::fs::FileSystem;

/// What recovery found.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RecoveryResult {
    /// Step 0: paths whose pending materialization landed (not on the wire).
    pub materialized: Vec<String>,
    /// Paths re-ingested.
    pub healed: Vec<String>,
    /// Live docs whose file is gone.
    pub missing: Vec<String>,
}

impl RecoveryResult {
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({ "healed": self.healed, "missing": self.missing })
    }
}

/// Step 0: [`crate::freshness::materialize_pending`]. Then for every live
/// doc (in row order): a missing file is `missing`; a file whose hash
/// differs from the current revision's `rendered_hash` (or `file_hash` when
/// there is no revision) is re-ingested with the reconciling resolver and
/// listed `healed`.
pub fn recover_repo(
    store: &mut Store,
    repo_id: &str,
    fs: &dyn FileSystem,
    root: &Path,
    ts: &str,
    config: &Config,
) -> Result<RecoveryResult> {
    let materialized = crate::freshness::materialize_pending(store, repo_id, fs, root)?;
    type Row = (String, Option<Vec<u8>>, Option<Vec<u8>>);
    let docs: Vec<Row> = {
        let mut stmt = store.conn().prepare(
            "SELECT d.path, d.file_hash, r.rendered_hash
             FROM docs d LEFT JOIN revisions r ON r.rev_id = d.current_rev
             WHERE d.repo_id = ?1 AND d.deleted_commit IS NULL ORDER BY d.rowid",
        )?;
        let rows = stmt.query_map(params![repo_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    let mut result = RecoveryResult {
        materialized,
        ..RecoveryResult::default()
    };
    for (path, file_hash, rendered_hash) in docs {
        let Some(content) = fs.read(root, &path)? else {
            result.missing.push(path);
            continue;
        };
        let on_disk = sha256(content.as_bytes());
        let recorded = rendered_hash.or(file_hash);
        if recorded.is_none_or(|r| r[..] != on_disk[..]) {
            store.reconciling_ingest(
                repo_id,
                &path,
                &content,
                ts,
                Origin::Observed,
                None,
                None,
                config,
            )?;
            result.healed.push(path);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::MemFileSystem;
    use omgbase_store::{BatchItem, SequentialMinter};

    const TS: &str = "2026-09-26T10:00:00.000Z";

    #[test]
    fn heals_divergent_files_and_reports_missing() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let cfg = Config::default();
        let items = [
            BatchItem::observed("a.md", "# A\n\nOne.\n"),
            BatchItem::observed("b.md", "# B\n"),
            BatchItem::observed("c.md", "# C\n"),
        ];
        store.observe_batch(&repo, &items, TS, &cfg).unwrap();
        let mut fs = MemFileSystem::new();
        fs.set("a.md", "# A\n\nOne, edited.\n", 1);
        fs.set("b.md", "# B\n", 2);
        let root = Path::new("/r");
        let r = recover_repo(&mut store, &repo, &fs, root, TS, &cfg).unwrap();
        assert_eq!(r.healed, ["a.md"]);
        assert_eq!(r.missing, ["c.md"]);
        assert_eq!(r.to_json()["healed"], serde_json::json!(["a.md"]));
        let commits: i64 = store
            .conn()
            .query_row(
                "SELECT count(*) FROM commits WHERE repo_id = ?1",
                params![repo],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(commits, 4);
        let origin: String = store
            .conn()
            .query_row("SELECT origin FROM commits WHERE seq = 4", [], |r| r.get(0))
            .unwrap();
        assert_eq!(origin, "observed");
        let doc: String = store
            .conn()
            .query_row("SELECT doc_id FROM docs WHERE path = 'a.md'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            store.reconstruct(&doc).unwrap().as_deref(),
            Some("# A\n\nOne, edited.\n")
        );
        // The heading kept its id: the reconciling resolver was used. Its
        // `same` verdict is not persisted (store 14.2; through 14.1 this
        // commit held one `same` row), so the commit's rows are the short
        // paragraph's replacement alone — a fresh ingest would have written
        // `inserted` for the heading too, under a new id.
        let kinds: Vec<String> = {
            let mut stmt = store
                .conn()
                .prepare("SELECT kind FROM dispositions WHERE commit_id = 'c_3' ORDER BY kind")
                .unwrap();
            stmt.query_map([], |r| r.get(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        assert_eq!(kinds, ["deleted", "inserted"]);
        let heading: String = store
            .conn()
            .query_row(
                "SELECT block_id FROM blocks WHERE doc_id = ?1 AND type = 'heading' AND deleted_commit IS NULL",
                params![doc],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(heading, "b_0");
        // Idempotent.
        let again = recover_repo(&mut store, &repo, &fs, root, TS, &cfg).unwrap();
        assert!(again.healed.is_empty());
        assert_eq!(again.missing, ["c.md"]);
    }

    /// Step 0 (2.2): recovery replays the pending rows a crashed request left
    /// before comparing files, so the file the api commit owed is written —
    /// not counted as divergence and re-ingested as `observed`.
    #[test]
    fn recovery_materializes_pending_rows_first() {
        /// Reads from the working tree, dies on the first write.
        struct Crashed(omgbase_store::FsDocStore);
        impl omgbase_store::DocStore for Crashed {
            fn exists(&self, p: &str) -> bool {
                self.0.exists(p)
            }
            fn read(&self, p: &str) -> omgbase_store::Result<Option<String>> {
                self.0.read(p)
            }
            fn write(&mut self, p: &str, _b: &str) -> omgbase_store::Result<()> {
                Err(omgbase_store::Error::Other(format!("crashed before {p}")))
            }
            fn rename(&mut self, f: &str, _t: &str) -> omgbase_store::Result<()> {
                Err(omgbase_store::Error::Other(format!("crashed before {f}")))
            }
            fn remove(&mut self, p: &str) -> omgbase_store::Result<()> {
                Err(omgbase_store::Error::Other(format!("crashed before {p}")))
            }
        }
        let dir = std::env::temp_dir().join(format!(
            "omgbase-sync-recover-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "# A\n").unwrap();
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let cfg = Config::default();
        let fs = crate::fs::RealFileSystem;
        store
            .observe_batch(&repo, &[BatchItem::observed("a.md", "# A\n")], TS, &cfg)
            .unwrap();
        let ctx = omgbase_store::DocOpContext {
            repo_id: repo.clone(),
            actor: Some("agent:test".to_owned()),
            ts: TS.to_owned(),
        };
        let mut set = serde_json::Map::new();
        set.insert("status".to_owned(), serde_json::json!("done"));
        store
            .docs_set_meta(
                &ctx,
                &mut Crashed(omgbase_store::FsDocStore::new(&dir)),
                "a.md",
                Some(&set),
                &[],
            )
            .unwrap_err();
        assert_eq!(store.pending_materializations(&repo).unwrap().len(), 1);

        let r = recover_repo(&mut store, &repo, &fs, &dir, TS, &cfg).unwrap();
        assert_eq!(r.materialized, ["a.md"]);
        assert!(r.healed.is_empty(), "the file was owed, not divergent");
        assert!(r.missing.is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.join("a.md")).unwrap(),
            "---\nstatus: done\n---\n\n# A\n"
        );
        assert!(store.pending_materializations(&repo).unwrap().is_empty());
        assert_eq!(
            r.to_json(),
            serde_json::json!({ "healed": [], "missing": [] }),
            "step 0 is not on the wire"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
