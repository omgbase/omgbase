//! Startup recovery (`spec/sync/README.md` §4.3 "Recovery"): every live
//! doc's file is checked against its current revision; a divergent file is
//! re-ingested as an observed commit, one document at a time (§9).

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

/// For every live doc (in row order): a missing file is `missing`; a file
/// whose hash differs from the current revision's `rendered_hash` (or
/// `file_hash` when there is no revision) is re-ingested with the reconciling
/// resolver and listed `healed`.
pub fn recover_repo(
    store: &mut Store,
    repo_id: &str,
    fs: &dyn FileSystem,
    root: &Path,
    ts: &str,
    config: &Config,
) -> Result<RecoveryResult> {
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
    let mut result = RecoveryResult::default();
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
        // The heading kept its id: the reconciling resolver was used.
        let carried: i64 = store
            .conn()
            .query_row(
                "SELECT count(*) FROM dispositions WHERE commit_id = 'c_3' AND kind = 'same'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(carried, 1);
        // Idempotent.
        let again = recover_repo(&mut store, &repo, &fs, root, TS, &cfg).unwrap();
        assert!(again.healed.is_empty());
        assert_eq!(again.missing, ["c.md"]);
    }
}
