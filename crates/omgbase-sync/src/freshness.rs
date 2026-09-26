//! The freshness sweep (`spec/sync/README.md` §4.3): the `file_stats` cache
//! against a filesystem snapshot — as a pure plan ([`sweep_plan`]) and as the
//! I/O around it; read-only disk drift; the cache rebuild.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use omgbase_format::hash::{hex, sha256};
use omgbase_reconcile::Config;
use omgbase_store::Store;
use rusqlite::params;
use serde_json::Value;

use crate::checkpoint::{CheckpointResult, process_checkpoint};
use crate::error::Result;
use crate::fs::{FileStat, FileSystem};

/// A `file_stats` row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CacheRow {
    pub path: String,
    pub mtime_ns: i64,
    pub size: i64,
    pub hash: [u8; 32],
}

/// One walked file with its stat.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiskEntry {
    pub path: String,
    pub stat: FileStat,
}

/// The §4.3 decisions over a snapshot.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SweepPlan {
    /// Paths not in the cache or whose `(mtime_ns, size)` differs, in walk order.
    pub candidates: Vec<String>,
    /// Candidates whose bytes' hash differs from the cache (or have no row).
    pub changed: Vec<String>,
    /// Cached paths not on disk, in cache order.
    pub deletions: Vec<String>,
    /// Candidates whose hash matched: only the stat is refreshed.
    pub refreshed: Vec<String>,
    /// The hash of every candidate (for the cache refresh).
    pub hashes: HashMap<String, [u8; 32]>,
}

impl SweepPlan {
    /// `{ candidates, changed, deletions, refreshed }` (the `pure.json` shape).
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "candidates": self.candidates,
            "changed": self.changed,
            "deletions": self.deletions,
            "refreshed": self.refreshed,
        })
    }

    /// The paths a checkpoint processes: `changed ++ deletions`.
    #[must_use]
    pub fn to_ingest(&self) -> Vec<String> {
        self.changed
            .iter()
            .chain(self.deletions.iter())
            .cloned()
            .collect()
    }
}

/// §4.3 steps 1–2 as a pure function: `hash_of(path)` is called once per
/// candidate, in candidate order.
pub fn sweep_plan(
    cache: &[CacheRow],
    disk: &[DiskEntry],
    hash_of: &mut dyn FnMut(&str) -> Result<[u8; 32]>,
) -> Result<SweepPlan> {
    let cached: HashMap<&str, &CacheRow> = cache.iter().map(|r| (r.path.as_str(), r)).collect();
    let seen: HashSet<&str> = disk.iter().map(|d| d.path.as_str()).collect();
    let mut plan = SweepPlan::default();
    for d in disk {
        let differs = cached
            .get(d.path.as_str())
            .is_none_or(|c| c.mtime_ns != d.stat.mtime_ns || c.size != d.stat.size);
        if differs {
            plan.candidates.push(d.path.clone());
        }
    }
    for c in cache {
        if !seen.contains(c.path.as_str()) {
            plan.deletions.push(c.path.clone());
        }
    }
    for path in &plan.candidates {
        let hash = hash_of(path)?;
        plan.hashes.insert(path.clone(), hash);
        if cached.get(path.as_str()).is_none_or(|c| c.hash != hash) {
            plan.changed.push(path.clone());
        } else {
            plan.refreshed.push(path.clone());
        }
    }
    Ok(plan)
}

/// The repo's `file_stats` rows in row order.
pub fn load_cache(store: &Store, repo_id: &str) -> Result<Vec<CacheRow>> {
    let mut stmt = store.conn().prepare(
        "SELECT path, mtime_ns, size, hash FROM file_stats WHERE repo_id = ?1 ORDER BY rowid",
    )?;
    let rows = stmt.query_map(params![repo_id], |r| {
        let hash: Vec<u8> = r.get(3)?;
        Ok(CacheRow {
            path: r.get(0)?,
            mtime_ns: r.get(1)?,
            size: r.get(2)?,
            hash: hash.try_into().unwrap_or([0; 32]),
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// The walk with each file's stat (a file that vanished between the walk and
/// the stat is skipped).
pub fn snapshot(fs: &dyn FileSystem, root: &Path) -> Result<Vec<DiskEntry>> {
    let mut out = Vec::new();
    for path in fs.walk_markdown(root)? {
        if let Some(stat) = fs.stat(root, &path)? {
            out.push(DiskEntry { path, stat });
        }
    }
    Ok(out)
}

/// Hash the file at `path` (`sha256` of its bytes); `None` when absent.
fn hash_file(fs: &dyn FileSystem, root: &Path, path: &str) -> Result<Option<[u8; 32]>> {
    Ok(fs.read(root, path)?.map(|s| sha256(s.as_bytes())))
}

/// §4.3 step 4 `record_file_stat`: upsert the fresh stat and `hash`; a path
/// that vanished meanwhile deletes its row.
pub fn record_file_stat(
    store: &Store,
    repo_id: &str,
    fs: &dyn FileSystem,
    root: &Path,
    path: &str,
    hash: &[u8; 32],
) -> Result<()> {
    match fs.stat(root, path)? {
        None => {
            store.conn().execute(
                "DELETE FROM file_stats WHERE repo_id = ?1 AND path = ?2",
                params![repo_id, path],
            )?;
        }
        Some(st) => {
            store.conn().execute(
                "INSERT INTO file_stats (repo_id, path, mtime_ns, size, hash) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(repo_id, path) DO UPDATE SET mtime_ns = excluded.mtime_ns, size = excluded.size, hash = excluded.hash",
                params![repo_id, path, st.mtime_ns, st.size, &hash[..]],
            )?;
        }
    }
    Ok(())
}

/// The checkpoint result plus the scan counters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SweepResult {
    pub checkpoint: CheckpointResult,
    /// Files walked.
    pub scanned: usize,
    /// Stat-mismatched (or new) files hashed.
    pub candidates: usize,
    /// `ingested`, `deleted` or `conflicted` non-empty.
    pub changed: bool,
}

impl SweepResult {
    /// The checkpoint fields plus `scanned`, `candidates`, `changed`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut v = self.checkpoint.to_json();
        v["scanned"] = Value::from(self.scanned);
        v["candidates"] = Value::from(self.candidates);
        v["changed"] = Value::from(self.changed);
        v
    }
}

/// §4.3: plan over the cache and the snapshot, refresh touched-not-edited
/// stats, checkpoint `changed ++ deletions` at `ts` (with `git_head` on the
/// row), refresh the cache for the changed paths and drop the deletions'
/// rows.
pub fn freshness_sweep(
    store: &mut Store,
    repo_id: &str,
    fs: &dyn FileSystem,
    root: &Path,
    ts: &str,
    git_head: Option<&str>,
    config: &Config,
) -> Result<SweepResult> {
    let cache = load_cache(store, repo_id)?;
    let disk = snapshot(fs, root)?;
    let plan = {
        let mut hash_of = |path: &str| -> Result<[u8; 32]> {
            Ok(hash_file(fs, root, path)?.unwrap_or_else(|| sha256(b"")))
        };
        sweep_plan(&cache, &disk, &mut hash_of)?
    };
    let fresh: HashMap<&str, FileStat> = disk.iter().map(|d| (d.path.as_str(), d.stat)).collect();
    for path in &plan.refreshed {
        if let Some(st) = fresh.get(path.as_str()) {
            store.conn().execute(
                "UPDATE file_stats SET mtime_ns = ?1, size = ?2 WHERE repo_id = ?3 AND path = ?4",
                params![st.mtime_ns, st.size, repo_id, path],
            )?;
        }
    }
    let checkpoint = process_checkpoint(
        store,
        repo_id,
        fs,
        root,
        &plan.to_ingest(),
        ts,
        git_head,
        config,
    )?;
    for path in &plan.changed {
        let hash = plan.hashes.get(path).copied().unwrap_or([0; 32]);
        record_file_stat(store, repo_id, fs, root, path, &hash)?;
    }
    for path in &plan.deletions {
        store.conn().execute(
            "DELETE FROM file_stats WHERE repo_id = ?1 AND path = ?2",
            params![repo_id, path],
        )?;
    }
    let changed = !checkpoint.ingested.is_empty()
        || !checkpoint.deleted.is_empty()
        || !checkpoint.conflicted.is_empty();
    Ok(SweepResult {
        checkpoint,
        scanned: disk.len(),
        candidates: plan.candidates.len(),
        changed,
    })
}

/// How the database disagrees with the disk (§4.3 "Disk drift").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DiskDrift {
    /// Candidates whose live doc's `file_hash` differs from the bytes' hash.
    pub changed: usize,
    /// Live docs whose path is not on disk.
    pub deleted: usize,
    /// Candidates with no live doc at that path.
    pub untracked: usize,
}

impl DiskDrift {
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.changed == 0 && self.deleted == 0 && self.untracked == 0
    }
}

/// Read-only: the same cache and snapshot, counted, touching nothing.
pub fn detect_disk_drift(
    store: &Store,
    repo_id: &str,
    fs: &dyn FileSystem,
    root: &Path,
) -> Result<DiskDrift> {
    let cache = load_cache(store, repo_id)?;
    let cached: HashMap<&str, &CacheRow> = cache.iter().map(|r| (r.path.as_str(), r)).collect();
    let docs: HashMap<String, Option<Vec<u8>>> = {
        let mut stmt = store.conn().prepare(
            "SELECT path, file_hash FROM docs WHERE repo_id = ?1 AND deleted_commit IS NULL",
        )?;
        let rows = stmt.query_map(params![repo_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    let disk = snapshot(fs, root)?;
    let seen: HashSet<&str> = disk.iter().map(|d| d.path.as_str()).collect();
    let mut drift = DiskDrift::default();
    for d in &disk {
        let differs = cached
            .get(d.path.as_str())
            .is_none_or(|c| c.mtime_ns != d.stat.mtime_ns || c.size != d.stat.size);
        if !differs {
            continue;
        }
        match docs.get(&d.path) {
            None => drift.untracked += 1,
            Some(file_hash) => {
                let on_disk = hash_file(fs, root, &d.path)?;
                let same = matches!((file_hash, on_disk), (Some(h), Some(od)) if h[..] == od[..]);
                if !same {
                    drift.changed += 1;
                }
            }
        }
    }
    for path in docs.keys() {
        if !seen.contains(path.as_str()) {
            drift.deleted += 1;
        }
    }
    Ok(drift)
}

/// §4.3 (since 1.1): delete the repo's rows, then walk the tree and record a
/// row only for a file whose bytes' hash equals its live doc's `file_hash` —
/// the cache may say "known" only about bytes the store already holds. A file
/// with no live doc, or whose bytes differ from what was ingested, gets no row,
/// so the next sweep still sees it as a candidate and drift still reports it.
/// Returns the number of files walked, recorded or not.
pub fn rebuild_file_stats(
    store: &Store,
    repo_id: &str,
    fs: &dyn FileSystem,
    root: &Path,
) -> Result<usize> {
    store.conn().execute(
        "DELETE FROM file_stats WHERE repo_id = ?1",
        params![repo_id],
    )?;
    let live: HashMap<String, Vec<u8>> = {
        let mut stmt = store.conn().prepare(
            "SELECT path, file_hash FROM docs
             WHERE repo_id = ?1 AND deleted_commit IS NULL AND file_hash IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![repo_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    let paths = fs.walk_markdown(root)?;
    for path in &paths {
        let Some(want) = live.get(path) else {
            continue; // no live doc: nothing the cache may vouch for
        };
        if let Some(hash) = hash_file(fs, root, path)? {
            if hash[..] == want[..] {
                record_file_stat(store, repo_id, fs, root, path, &hash)?;
            }
        }
    }
    Ok(paths.len())
}

/// The cache as the fixtures project it: `(path, mtime_ns, size, hash hex)`
/// by `path`.
pub fn file_stats_rows(store: &Store, repo_id: &str) -> Result<Vec<(String, i64, i64, String)>> {
    let mut rows: Vec<(String, i64, i64, String)> = load_cache(store, repo_id)?
        .into_iter()
        .map(|c| (c.path, c.mtime_ns, c.size, hex(&c.hash)))
        .collect();
    rows.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::MemFileSystem;
    use omgbase_store::SequentialMinter;

    const TS: &str = "2026-09-26T10:00:00.000Z";
    const ROOT: &str = "/r";

    fn row(path: &str, mtime_ns: i64, content: &str) -> CacheRow {
        CacheRow {
            path: path.to_owned(),
            mtime_ns,
            size: content.len() as i64,
            hash: sha256(content.as_bytes()),
        }
    }

    fn entry(path: &str, mtime_ns: i64, content: &str) -> DiskEntry {
        DiskEntry {
            path: path.to_owned(),
            stat: FileStat {
                mtime_ns,
                size: content.len() as i64,
            },
        }
    }

    #[test]
    fn plan_decisions() {
        let cache = [
            row("a.md", 1, "A"),
            row("b.md", 2, "B"),
            row("gone.md", 3, "G"),
        ];
        let disk = [
            entry("new.md", 9, "N"),
            entry("a.md", 1, "A"), // unchanged stat: not a candidate
            entry("b.md", 5, "B"), // touched, same bytes: refreshed
        ];
        let mut hashed = Vec::new();
        let plan = sweep_plan(&cache, &disk, &mut |p: &str| {
            hashed.push(p.to_owned());
            Ok(sha256(match p {
                "new.md" => b"N",
                "b.md" => b"B",
                _ => b"?",
            }))
        })
        .unwrap();
        assert_eq!(plan.candidates, ["new.md", "b.md"]);
        assert_eq!(plan.changed, ["new.md"]);
        assert_eq!(plan.refreshed, ["b.md"]);
        assert_eq!(plan.deletions, ["gone.md"]);
        assert_eq!(
            hashed,
            ["new.md", "b.md"],
            "only candidates are hashed, in order"
        );
        assert_eq!(plan.to_ingest(), ["new.md", "gone.md"]);
        assert_eq!(
            plan.to_json(),
            serde_json::json!({"candidates": ["new.md", "b.md"], "changed": ["new.md"], "deletions": ["gone.md"], "refreshed": ["b.md"]})
        );
        // Size change alone is a candidate; a differing hash is changed.
        let plan = sweep_plan(
            &[row("a.md", 1, "A")],
            &[entry("a.md", 1, "AB")],
            &mut |_| Ok(sha256(b"AB")),
        )
        .unwrap();
        assert_eq!(plan.changed, ["a.md"]);
        let empty = sweep_plan(&[], &[], &mut |_| unreachable!()).unwrap();
        assert_eq!(empty, SweepPlan::default());
    }

    #[test]
    fn sweep_drift_and_rebuild_over_a_mem_fs() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let mut fs = MemFileSystem::new();
        let root = Path::new(ROOT);
        fs.set("a.md", "# A\n", 1);
        fs.set("d/b.md", "# B\n", 2);
        let cfg = Config::default();

        let drift = detect_disk_drift(&store, &repo, &fs, root).unwrap();
        assert_eq!(
            drift,
            DiskDrift {
                changed: 0,
                deleted: 0,
                untracked: 2
            }
        );

        let r = freshness_sweep(&mut store, &repo, &fs, root, TS, None, &cfg).unwrap();
        assert_eq!((r.scanned, r.candidates, r.changed), (2, 2, true));
        assert_eq!(r.checkpoint.ingested, ["a.md", "d/b.md"]);
        assert_eq!(r.to_json()["scanned"], 2);
        let stats = file_stats_rows(&store, &repo).unwrap();
        assert_eq!(stats.len(), 2);
        assert_eq!(stats[0].0, "a.md");
        assert_eq!((stats[0].1, stats[0].2), (1, 4));
        assert_eq!(stats[0].3, hex(&sha256(b"# A\n")));
        assert!(
            detect_disk_drift(&store, &repo, &fs, root)
                .unwrap()
                .is_clean()
        );

        // Quiet sweep: nothing hashed, nothing changed.
        let r = freshness_sweep(&mut store, &repo, &fs, root, TS, None, &cfg).unwrap();
        assert_eq!((r.scanned, r.candidates, r.changed), (2, 0, false));
        assert!(r.checkpoint.ingested.is_empty());

        // A touch without an edit: a candidate, refreshed, no ingest.
        fs.set("a.md", "# A\n", 10);
        let r = freshness_sweep(&mut store, &repo, &fs, root, TS, None, &cfg).unwrap();
        assert_eq!((r.scanned, r.candidates, r.changed), (2, 1, false));
        assert!(
            r.checkpoint.suppressed.is_empty(),
            "a refreshed path is not even observed"
        );
        assert_eq!(file_stats_rows(&store, &repo).unwrap()[0].1, 10);

        // An edit and a deletion.
        fs.set("a.md", "# A2\n", 11);
        fs.remove("d/b.md");
        assert_eq!(
            detect_disk_drift(&store, &repo, &fs, root).unwrap(),
            DiskDrift {
                changed: 1,
                deleted: 1,
                untracked: 0
            }
        );
        let r = freshness_sweep(&mut store, &repo, &fs, root, TS, None, &cfg).unwrap();
        assert_eq!(r.checkpoint.ingested, ["a.md"]);
        assert_eq!(r.checkpoint.deleted, ["d/b.md"]);
        assert!(r.changed);
        let stats = file_stats_rows(&store, &repo).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].3, hex(&sha256(b"# A2\n")));

        // Rebuild from scratch (1.1): a.md's bytes match its live doc and get a
        // row; d/b.md is back on disk but its doc is tombstoned, so it gets no
        // row and stays visible as untracked. The count is the walk, not the rows.
        fs.set("d/b.md", "# B\n", 3);
        assert_eq!(rebuild_file_stats(&store, &repo, &fs, root).unwrap(), 2);
        let stats = file_stats_rows(&store, &repo).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].0, "a.md");
        assert_eq!(
            detect_disk_drift(&store, &repo, &fs, root).unwrap(),
            DiskDrift {
                changed: 0,
                deleted: 0,
                untracked: 1
            },
            "a rebuild does not hide an untracked file"
        );
        let r = freshness_sweep(&mut store, &repo, &fs, root, TS, None, &cfg).unwrap();
        assert_eq!(r.checkpoint.ingested, ["d/b.md"]);
        assert_eq!(file_stats_rows(&store, &repo).unwrap().len(), 2);

        // Rebuild over a pending edit: the edited file gets no row, drift and
        // the sweep still see it; the rebuild's count still walks it.
        fs.set("a.md", "# A3\n", 12);
        assert_eq!(rebuild_file_stats(&store, &repo, &fs, root).unwrap(), 2);
        let stats = file_stats_rows(&store, &repo).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].0, "d/b.md");
        assert_eq!(
            detect_disk_drift(&store, &repo, &fs, root).unwrap(),
            DiskDrift {
                changed: 1,
                deleted: 0,
                untracked: 0
            },
            "a rebuild keeps a pending edit visible"
        );
        let r = freshness_sweep(&mut store, &repo, &fs, root, TS, None, &cfg).unwrap();
        assert_eq!(r.checkpoint.ingested, ["a.md"]);
        assert_eq!(
            file_stats_rows(&store, &repo).unwrap()[0].3,
            hex(&sha256(b"# A3\n"))
        );

        // record_file_stat deletes the row of a vanished file.
        fs.remove("d/b.md");
        record_file_stat(&store, &repo, &fs, root, "d/b.md", &[0; 32]).unwrap();
        assert_eq!(file_stats_rows(&store, &repo).unwrap().len(), 1);
    }
}
