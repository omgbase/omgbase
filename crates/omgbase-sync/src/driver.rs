//! The driver (`spec/sync/README.md` §6): the engine-side loop over a
//! [`SyncSource`] — `reconcile_changes` (fetch, `observe_batch`, checkpoint)
//! and `attach_source` (`ensure_repo`, then ingest every enumerated member).

use omgbase_reconcile::Config;
use omgbase_store::{BatchItem, Origin, Store};
use serde_json::Value;

use crate::checkpoint::{CheckpointResult, finish_checkpoint};
use crate::error::Result;
use crate::registry::ensure_repo;
use crate::source::{SourceIdentity, SyncSource};

/// Fetch every path through the source (`None` → gone), `observe_batch`,
/// record the checkpoint exactly as §4.1.
pub fn reconcile_changes(
    store: &mut Store,
    repo_id: &str,
    source: &mut dyn SyncSource,
    paths: &[String],
    ts: &str,
    git_head: Option<&str>,
    config: &Config,
) -> Result<CheckpointResult> {
    let mut items = Vec::with_capacity(paths.len());
    for path in paths {
        items.push(BatchItem {
            path: path.clone(),
            source: source.fetch(path)?.map(|it| it.content),
        });
    }
    let outcomes = store.observe_batch(repo_id, &items, ts, config)?;
    finish_checkpoint(store, repo_id, &outcomes, ts, git_head)
}

/// What `attach_source` did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachResult {
    pub repo_id: String,
    pub file_count: usize,
    pub all_converged: bool,
}

impl AttachResult {
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "repo_id": self.repo_id,
            "file_count": self.file_count,
            "all_converged": self.all_converged,
        })
    }
}

/// `ensure_repo`, then for every enumerated entry fetch and ingest — with
/// the reconciling resolver when `identity` is `inferred`, the plain re-mint
/// ingest otherwise (§9) — counting files and whether all converged. A
/// member whose fetch returns `None` is skipped.
pub fn attach_source(
    store: &mut Store,
    slug: &str,
    root_path: Option<&str>,
    source: &mut dyn SyncSource,
    ts: &str,
    config: &Config,
) -> Result<AttachResult> {
    let repo_id = ensure_repo(store, slug, root_path)?;
    let inferred = source.capabilities().identity == SourceIdentity::Inferred;
    let mut file_count = 0;
    let mut all_converged = true;
    for entry in source.enumerate()? {
        let Some(item) = source.fetch(&entry.path)? else {
            continue;
        };
        let committed = if inferred {
            store.reconciling_ingest(
                &repo_id,
                &entry.path,
                &item.content,
                ts,
                Origin::Observed,
                None,
                None,
                config,
            )?
        } else {
            store.fresh_ingest(&repo_id, &entry.path, &item.content, ts, Origin::Observed)?
        };
        file_count += 1;
        if !committed.converged {
            all_converged = false;
        }
    }
    Ok(AttachResult {
        repo_id,
        file_count,
        all_converged,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{MemSource, SourceCapabilities};
    use omgbase_store::SequentialMinter;
    use rusqlite::params;

    const TS: &str = "2026-09-26T10:00:00.000Z";

    #[test]
    fn attach_then_reconcile_changes() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let cfg = Config::default();
        let mut source = MemSource::with_files(&[("a.md", "# A\n\nOne.\n"), ("b.md", "# B\n")]);
        let r = attach_source(
            &mut store,
            "vault",
            Some("/data/vault"),
            &mut source,
            TS,
            &cfg,
        )
        .unwrap();
        assert_eq!(
            r,
            AttachResult {
                repo_id: "rp_0".into(),
                file_count: 2,
                all_converged: true
            }
        );
        assert_eq!(r.to_json()["file_count"], 2);
        let fs_source: String = store
            .conn()
            .query_row("SELECT name FROM sources WHERE adapter = 'fs'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(fs_source, "vault-fs");
        let dispositions: i64 = store
            .conn()
            .query_row("SELECT count(*) FROM dispositions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            dispositions, 3,
            "inferred identity: the reconciling resolver records dispositions"
        );

        // Attaching again re-ingests (no echo gate on attach) and reuses the repo.
        let again = attach_source(&mut store, "vault", None, &mut source, TS, &cfg).unwrap();
        assert_eq!(again.repo_id, "rp_0");
        let commits: i64 = store
            .conn()
            .query_row("SELECT count(*) FROM commits", [], |r| r.get(0))
            .unwrap();
        assert_eq!(commits, 4);

        source.set("a.md", "# A\n\nOne, edited.\n");
        source.files.remove("b.md");
        let paths: Vec<String> = ["a.md", "b.md", "nope.md"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let cp = reconcile_changes(
            &mut store,
            "rp_0",
            &mut source,
            &paths,
            TS,
            Some("deadbeef"),
            &cfg,
        )
        .unwrap();
        assert_eq!(cp.ingested, ["a.md"]);
        assert_eq!(cp.deleted, ["b.md"]);
        assert_eq!(cp.checkpoint_id, "cp_0");
        let head: Option<String> = store
            .conn()
            .query_row("SELECT git_head FROM checkpoints", [], |r| r.get(0))
            .unwrap();
        assert_eq!(head.as_deref(), Some("deadbeef"));
        let cp = reconcile_changes(
            &mut store,
            "rp_0",
            &mut source,
            &["a.md".to_owned()],
            TS,
            None,
            &cfg,
        )
        .unwrap();
        assert_eq!(cp.suppressed, ["a.md"]);
    }

    #[test]
    fn borne_sources_re_mint() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let mut source = MemSource::new(SourceCapabilities {
            identity: SourceIdentity::Borne,
            write_through: false,
            watch: false,
        });
        source.set("a.md", "# A\n\nOne.\n");
        let r = attach_source(&mut store, "b", None, &mut source, TS, &Config::default()).unwrap();
        assert_eq!(r.file_count, 1);
        assert!(r.all_converged);
        let dispositions: i64 = store
            .conn()
            .query_row("SELECT count(*) FROM dispositions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dispositions, 0, "the re-mint path records no dispositions");
        let blocks: i64 = store
            .conn()
            .query_row(
                "SELECT count(*) FROM blocks WHERE repo_id = ?1",
                params![r.repo_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(blocks, 2);
        assert!(
            store
                .conn()
                .query_row("SELECT 1 FROM sources", [], |_| Ok(()))
                .is_err(),
            "no root: no fs source"
        );
    }
}
