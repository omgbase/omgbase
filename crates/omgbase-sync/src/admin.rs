//! Status (`spec/sync/README.md` §4.4, 4.0): `repos_status` and
//! `sync_status`. Disk agreement is only ever reported from a read-only scan
//! the caller asked for; without one `checked` is false and nothing is ever
//! green. Since store 17.0 (D7/D9) the counts name the FEED — `{ epoch,
//! oldest, head }` in place of a `commits` count and the retired
//! `unconverged` (identically zero under I1; `disk.changed` is the signal) —
//! and `sync_status` reports the last observed batch from the repository's
//! status row (D4) instead of a checkpoint id.

use std::path::Path;

use omgbase_store::{FeedStatus, Store};
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use crate::capability_state::capability_states;
use crate::checkpoint::{LastBatch, last_batch};
use crate::error::Result;
use crate::freshness::{DiskDrift, detect_disk_drift};
use crate::fs::FileSystem;

/// The drift counts plus whether a scan ran.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DiskStatus {
    pub drift: DiskDrift,
    /// `true` iff a root was supplied and the read-only scan ran.
    pub checked: bool,
}

impl DiskStatus {
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "changed": self.drift.changed,
            "deleted": self.drift.deleted,
            "untracked": self.drift.untracked,
            "checked": self.checked,
        })
    }
}

/// `repos_status`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoStatus {
    pub repo_id: String,
    pub slug: String,
    /// §9: the caller's argument or `""`, never the derived root.
    pub root_path: String,
    pub docs: i64,
    pub blocks: i64,
    /// The change feed's position (`spec/store` §3.1 `feed`): the
    /// repository's epoch, the oldest retained `seq`, the head.
    pub feed: FeedStatus,
    pub open_edges: i64,
    pub disk: DiskStatus,
}

impl RepoStatus {
    /// The MCP shape (`camelCase`; `_id` is the root row's id — `spec/surface`
    /// §1.2, 5.0 — the rest of the keys are the status's own).
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "_id": self.repo_id,
            "slug": self.slug,
            "rootPath": self.root_path,
            "docs": self.docs,
            "blocks": self.blocks,
            "feed": self.feed.to_json(),
            "openEdges": self.open_edges,
            "disk": self.disk.to_json(),
        })
    }
}

/// §4.4 `repos_status`: counts, the feed's position, and the drift with
/// `checked: true` when a root (and filesystem) was supplied.
pub fn repos_status(
    store: &Store,
    repo_id: &str,
    disk: Option<(&dyn FileSystem, &Path)>,
) -> Result<RepoStatus> {
    let conn = store.conn();
    let slug: Option<String> = conn
        .query_row(
            "SELECT slug FROM repos WHERE repo_id = ?1",
            params![repo_id],
            |r| r.get(0),
        )
        .optional()?;
    let count =
        |sql: &str| -> Result<i64> { Ok(conn.query_row(sql, params![repo_id], |r| r.get(0))?) };
    let (root_path, disk) = match disk {
        Some((fs, root)) => (
            root.to_string_lossy().into_owned(),
            DiskStatus {
                drift: detect_disk_drift(store, repo_id, fs, root)?,
                checked: true,
            },
        ),
        None => (String::new(), DiskStatus::default()),
    };
    // A repository the store does not know has no epoch to report: the
    // status reads as an empty feed under an empty epoch (the reference's
    // `repoEpoch` throws; the surface's `repo_not_found` guards both).
    let feed = match slug {
        Some(_) => store.feed_status(repo_id)?,
        None => FeedStatus {
            epoch: String::new(),
            oldest: 0,
            head: 0,
        },
    };
    Ok(RepoStatus {
        repo_id: repo_id.to_owned(),
        slug: slug.unwrap_or_default(),
        root_path,
        docs: count("SELECT count(*) FROM docs WHERE repo_id = ?1 AND deleted_at IS NULL")?,
        blocks: count("SELECT count(*) FROM blocks WHERE repo_id = ?1 AND deleted_at IS NULL")?,
        feed,
        open_edges: count("SELECT count(*) FROM edges WHERE repo_id = ?1")?,
        disk,
    })
}

/// `sync_status`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncStatus {
    /// The feed's epoch (a cursor is `(epoch, seq)`).
    pub epoch: String,
    /// The oldest retained feed `seq` (0 when the feed is empty).
    pub oldest: i64,
    /// The feed's head: the greatest `seq` (0 when empty).
    pub head: i64,
    /// The last observed batch (the repository's status row, §4.1), or
    /// `None` when none ran.
    pub last_batch: Option<LastBatch>,
    /// `checked && no drift`: never green on an unverified disk.
    pub convergent: bool,
    pub disk: DiskStatus,
    /// The capabilities as `version` reports them.
    pub capabilities: Value,
}

impl SyncStatus {
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "epoch": self.epoch,
            "oldest": self.oldest,
            "head": self.head,
            "lastBatch": self.last_batch.as_ref().map(LastBatch::to_json),
            "convergent": self.convergent,
            "diskChecked": self.disk.checked,
            "disk": self.disk.to_json(),
            "capabilities": self.capabilities,
        })
    }
}

/// §4.4 `sync_status` (4.0).
pub fn sync_status(
    store: &Store,
    repo_id: &str,
    disk: Option<(&dyn FileSystem, &Path)>,
) -> Result<SyncStatus> {
    let status = repos_status(store, repo_id, disk)?;
    Ok(SyncStatus {
        epoch: status.feed.epoch,
        oldest: status.feed.oldest,
        head: status.feed.head,
        last_batch: last_batch(store.conn(), repo_id)?,
        convergent: status.disk.checked && status.disk.drift.is_clean(),
        disk: status.disk,
        capabilities: capability_states(Some(store), Some(repo_id)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoint::process_checkpoint;
    use crate::fs::MemFileSystem;
    use omgbase_reconcile::Config;
    use omgbase_store::SequentialMinter;

    const TS: &str = "2026-09-26T10:00:00.000Z";

    #[test]
    fn status_counts_and_never_green_unverified() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let s = sync_status(&store, &repo, None).unwrap();
        assert_eq!((s.epoch.as_str(), s.oldest, s.head), ("ep_0", 0, 0));
        assert_eq!(s.last_batch, None);
        assert!(!s.convergent, "an unverified disk is never convergent");
        let rs = repos_status(&store, &repo, None).unwrap();
        assert_eq!(
            (rs.docs, rs.blocks, rs.feed.head, rs.open_edges),
            (0, 0, 0, 0)
        );
        assert_eq!(rs.slug, "fixture");
        assert_eq!(rs.root_path, "");
        assert!(!rs.disk.checked);

        let mut fs = MemFileSystem::new();
        fs.set("a.md", "# A\n\nSee [b](b.md).\n", 1);
        let root = Path::new("/r");
        process_checkpoint(
            &mut store,
            &repo,
            &fs,
            root,
            &["a.md".to_owned()],
            TS,
            &Config::default(),
        )
        .unwrap();
        let rs = repos_status(&store, &repo, Some((&fs, root))).unwrap();
        assert_eq!((rs.docs, rs.blocks, rs.open_edges), (1, 2, 1));
        assert_eq!(
            rs.feed,
            FeedStatus {
                epoch: "ep_0".into(),
                oldest: 1,
                head: 1
            }
        );
        assert_eq!(rs.root_path, "/r");
        assert!(rs.disk.checked);
        // The batch did not record file_stats, so a.md is a candidate but
        // its bytes match the doc: no drift.
        assert!(rs.disk.drift.is_clean());
        let s = sync_status(&store, &repo, Some((&fs, root))).unwrap();
        assert_eq!((s.oldest, s.head), (1, 1));
        assert_eq!(
            s.last_batch,
            Some(LastBatch {
                ts: TS.into(),
                batch_id: Some("c_0".into()),
                files: 1
            })
        );
        assert!(s.convergent);
        let j = s.to_json();
        assert_eq!(j["diskChecked"], true);
        assert_eq!(j["lastBatch"]["batchId"], "c_0");
        assert_eq!(
            j.as_object().unwrap().keys().collect::<Vec<_>>(),
            [
                "epoch",
                "oldest",
                "head",
                "lastBatch",
                "convergent",
                "diskChecked",
                "disk",
                "capabilities"
            ]
        );
        assert_eq!(j["capabilities"]["history"]["state"], "enabled");
        let rj = rs.to_json();
        assert_eq!(rj["openEdges"], 1);
        assert_eq!(
            rj["feed"],
            serde_json::json!({ "epoch": "ep_0", "oldest": 1, "head": 1 })
        );
        assert!(rj.get("commits").is_none() && rj.get("unconverged").is_none());

        fs.set("a.md", "# A\n\nEdited.\n", 2);
        let s = sync_status(&store, &repo, Some((&fs, root))).unwrap();
        assert!(!s.convergent);
        assert_eq!(s.disk.drift.changed, 1);
        assert_eq!(repos_status(&store, "rp_nope", None).unwrap().slug, "");
    }
}
