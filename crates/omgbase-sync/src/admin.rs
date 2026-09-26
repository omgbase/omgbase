//! Status (`spec/sync/README.md` §4.4): `repos_status` and `sync_status`.
//! Disk agreement is only ever reported from a read-only scan the caller
//! asked for; without one `checked` is false and nothing is ever green.

use std::path::Path;

use omgbase_store::Store;
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

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
    pub commits: i64,
    pub open_edges: i64,
    /// Live docs whose `file_hash` differs from their current revision's
    /// `rendered_hash`.
    pub unconverged: i64,
    pub disk: DiskStatus,
}

impl RepoStatus {
    /// The MCP shape (`camelCase`).
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "repoId": self.repo_id,
            "slug": self.slug,
            "rootPath": self.root_path,
            "docs": self.docs,
            "blocks": self.blocks,
            "commits": self.commits,
            "openEdges": self.open_edges,
            "unconverged": self.unconverged,
            "disk": self.disk.to_json(),
        })
    }
}

/// §4.4 `repos_status`: counts, `unconverged`, and the drift with `checked:
/// true` when a root (and filesystem) was supplied.
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
    let unconverged = count(
        "SELECT count(*) FROM docs d JOIN revisions r ON r.rev_id = d.current_rev
         WHERE d.repo_id = ?1 AND d.deleted_commit IS NULL AND d.file_hash IS NOT r.rendered_hash",
    )?;
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
    Ok(RepoStatus {
        repo_id: repo_id.to_owned(),
        slug: slug.unwrap_or_default(),
        root_path,
        docs: count("SELECT count(*) FROM docs WHERE repo_id = ?1 AND deleted_commit IS NULL")?,
        blocks: count("SELECT count(*) FROM blocks WHERE repo_id = ?1 AND deleted_commit IS NULL")?,
        commits: count("SELECT count(*) FROM commits WHERE repo_id = ?1")?,
        open_edges: count("SELECT count(*) FROM edges WHERE repo_id = ?1 AND to_commit IS NULL")?,
        unconverged,
        disk,
    })
}

/// `sync_status`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncStatus {
    pub last_commit_seq: i64,
    /// The latest checkpoint by `ts`.
    pub last_checkpoint: Option<String>,
    /// `unconverged == 0 && checked && no drift`.
    pub convergent: bool,
    pub disk: DiskStatus,
}

impl SyncStatus {
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "lastCommitSeq": self.last_commit_seq,
            "lastCheckpoint": self.last_checkpoint,
            "convergent": self.convergent,
            "diskChecked": self.disk.checked,
            "disk": self.disk.to_json(),
        })
    }
}

/// §4.4 `sync_status`.
pub fn sync_status(
    store: &Store,
    repo_id: &str,
    disk: Option<(&dyn FileSystem, &Path)>,
) -> Result<SyncStatus> {
    let conn = store.conn();
    let last_commit_seq: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM commits WHERE repo_id = ?1",
        params![repo_id],
        |r| r.get(0),
    )?;
    let last_checkpoint: Option<String> = conn
        .query_row(
            "SELECT id FROM checkpoints WHERE repo_id = ?1 ORDER BY ts DESC LIMIT 1",
            params![repo_id],
            |r| r.get(0),
        )
        .optional()?;
    let status = repos_status(store, repo_id, disk)?;
    Ok(SyncStatus {
        last_commit_seq,
        last_checkpoint,
        convergent: status.unconverged == 0 && status.disk.checked && status.disk.drift.is_clean(),
        disk: status.disk,
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
        assert_eq!(s.last_commit_seq, 0);
        assert_eq!(s.last_checkpoint, None);
        assert!(!s.convergent, "an unverified disk is never convergent");
        let rs = repos_status(&store, &repo, None).unwrap();
        assert_eq!(
            (
                rs.docs,
                rs.blocks,
                rs.commits,
                rs.open_edges,
                rs.unconverged
            ),
            (0, 0, 0, 0, 0)
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
            None,
            &Config::default(),
        )
        .unwrap();
        let rs = repos_status(&store, &repo, Some((&fs, root))).unwrap();
        assert_eq!(
            (
                rs.docs,
                rs.blocks,
                rs.commits,
                rs.open_edges,
                rs.unconverged
            ),
            (1, 2, 1, 1, 0)
        );
        assert_eq!(rs.root_path, "/r");
        assert!(rs.disk.checked);
        // The checkpoint did not record file_stats, so a.md is a candidate
        // but its bytes match the doc: no drift.
        assert!(rs.disk.drift.is_clean());
        let s = sync_status(&store, &repo, Some((&fs, root))).unwrap();
        assert_eq!(s.last_commit_seq, 1);
        assert_eq!(s.last_checkpoint.as_deref(), Some("cp_0"));
        assert!(s.convergent);
        assert_eq!(s.to_json()["diskChecked"], true);
        assert_eq!(rs.to_json()["openEdges"], 1);

        fs.set("a.md", "# A\n\nEdited.\n", 2);
        let s = sync_status(&store, &repo, Some((&fs, root))).unwrap();
        assert!(!s.convergent);
        assert_eq!(s.disk.drift.changed, 1);

        // unconverged: a doc whose file_hash no longer matches its revision.
        store
            .conn()
            .execute("UPDATE docs SET file_hash = x'00'", [])
            .unwrap();
        assert_eq!(repos_status(&store, &repo, None).unwrap().unconverged, 1);
        assert_eq!(repos_status(&store, "rp_nope", None).unwrap().slug, "");
    }
}
