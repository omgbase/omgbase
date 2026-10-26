//! Materialization (`spec/store/README.md` §5.7, store 14.0; the
//! self-contained row 17.0 — modular-core Phase 3c, M4): the file writes an
//! `api` commit owes the working tree, recorded as intent.
//!
//! Since 14.0 the commit phase is **A → C → B'**: the reads, then one
//! `BEGIN IMMEDIATE` transaction that validates, commits and inserts one
//! `pending_materializations` row per path the request must write, rename or
//! remove, then — after COMMIT — the files. Each row is deleted as its file
//! lands (autocommit, so partial progress is durable). The database is
//! therefore all-or-nothing; the files are eventually consistent: a crash
//! between COMMIT and the writes leaves the rows, and whoever runs next —
//! the request's own B', the freshness sweep's step 0, recovery, or the
//! observation of the path (the gate rule of [`crate::observe`]) — replays
//! them with the commit, its intent and its `changes_since` digest intact. A
//! request also replays the rows at the paths it touches before reading
//! their files (`spec/mutate` §4 step 5 (a)), so a stale file never reads
//! back as a human edit. The row carries everything that replay needs and
//! touches no history table: `head` (the token whose bytes it renders; no
//! foreign key), `rendered_hash` (the bytes expected at `path`),
//! `prior_hash` (the bytes the engine itself last wrote at `path` — captured
//! at commit time from the `file_hash` the transaction validated the file
//! against, or inherited from the row it supersedes; `NULL` when the engine
//! never wrote there), `commit_id` (no foreign key) and `created_at`.
//!
//! **A file a human changes meanwhile wins** (ADR-004). The materializer
//! writes a `write` row only over nothing, over the bytes it already
//! expects, or over the engine's OWN previous bytes — `prior_hash`, which is
//! what a file holds when the process died between COMMIT and the write;
//! anything else is a foreign edit the row stays behind for, until the sweep
//! observes it (file wins, row cleared). A `rename` lands the moved
//! document's bytes at `to` — by rename when the old file is still there and
//! `to` is free, by writing the document's bytes otherwise — and keeps the
//! row when `to` holds foreign bytes. A `remove` unlinks only a file that
//! still hashes to what the deleted document rendered; a foreign file is
//! left for the sweep.
//!
//! One row per path (§5.7 "Supersession"; [`supersede`]): a later `write` to
//! a path that still owes a file replaces the row's TARGET (`head`,
//! `rendered_hash`, `commit_id`, `created_at`) and keeps the EARLIEST
//! `prior_hash` — the bytes that can still be on the disk are the ones the
//! engine wrote before the first unfinished commit, never the superseded
//! row's own target (over a `remove` row the inherited prior is the bytes it
//! owed an unlink); a `write` over a `rename` keeps the rename and its
//! `from_path` obligation and replaces its target; a `rename` supersedes a
//! `write`/`rename` at `from_path` by carrying its `prior_hash` (the commit
//! deletes that row — [`crate::effects`]); a `remove` drops whatever the
//! path owed. Unresolved recovery work is never discarded for a storage
//! limit: there is none — a row lives until a materializer or an observation
//! settles its path.

use omgbase_format::hash::sha256;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value as Json};

use crate::Store;
use crate::core::alerts::{
    AlertInput, AlertSeverity, MATERIALIZATION_FAILED_ALERT, clear_alert,
    materialization_failed_message, raise_alert, refresh_backlog_alert,
};
use crate::core::fault::{FaultSite, fault_point};
use crate::doc_store::DocStore;
use crate::error::Result;
use crate::read::reconstruct;

/// What a pending row asks the working tree for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PendingKind {
    /// The document's bytes at `path`.
    Write,
    /// The file at `from_path` must end up at `path` holding the document's
    /// bytes (a `docs_move`).
    Rename,
    /// The file at `path` must go (a `docs_delete`); `rendered_hash` is the
    /// bytes it is safe to unlink.
    Remove,
}

impl PendingKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            PendingKind::Write => "write",
            PendingKind::Rename => "rename",
            PendingKind::Remove => "remove",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "write" => Some(PendingKind::Write),
            "rename" => Some(PendingKind::Rename),
            "remove" => Some(PendingKind::Remove),
            _ => None,
        }
    }
}

/// One `pending_materializations` row (`spec/store` §3.1; `repo_id`
/// implied), hashes as the 32 raw bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingRow {
    pub path: String,
    pub kind: PendingKind,
    /// `rename`: the old path.
    pub from_path: Option<String>,
    pub doc_id: String,
    /// `write`/`rename`: the document's head token whose bytes the row
    /// renders; `None` for `remove`.
    pub head: Option<String>,
    /// The bytes expected at `path` (`remove`: the bytes safe to unlink).
    pub rendered_hash: Vec<u8>,
    /// The bytes the engine itself last wrote at `path` (what a crash leaves
    /// on the disk); `None` when it never did.
    pub prior_hash: Option<Vec<u8>>,
    pub commit_id: String,
    /// The recording commit's `ts` (`spec/store` §2.4).
    pub created_at: String,
}

const COLUMNS: &str =
    "path, kind, from_path, doc_id, head, rendered_hash, prior_hash, commit_id, created_at";

fn row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<PendingRow> {
    let kind: String = r.get(1)?;
    Ok(PendingRow {
        path: r.get(0)?,
        kind: PendingKind::parse(&kind).unwrap_or(PendingKind::Write),
        from_path: r.get(2)?,
        doc_id: r.get(3)?,
        head: r.get(4)?,
        rendered_hash: r.get(5)?,
        prior_hash: r.get(6)?,
        commit_id: r.get(7)?,
        created_at: r.get(8)?,
    })
}

/// Every pending row of the repo in insertion order (the order the request's
/// effects ran, so a move's rename precedes its sources' writes).
pub(crate) fn pending_rows(conn: &Connection, repo_id: &str) -> Result<Vec<PendingRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM pending_materializations WHERE repo_id = ?1 ORDER BY rowid"
    ))?;
    let rows = stmt.query_map(params![repo_id], row_from)?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// The pending row at `(repo, path)`, if any.
pub(crate) fn pending_at(
    conn: &Connection,
    repo_id: &str,
    path: &str,
) -> Result<Option<PendingRow>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM pending_materializations WHERE repo_id = ?1 AND path = ?2"
            ),
            params![repo_id, path],
            row_from,
        )
        .optional()?)
}

/// The row that results when `incoming` is recorded at a path `existing`
/// still owes (`spec/store` §5.7 "Supersession"; no `existing` → `incoming`
/// as is). A `write` replaces the target and inherits the earliest prior:
/// over a `write` its `prior_hash`, over a `remove` the bytes that row owed
/// an unlink (`rendered_hash`), over a `rename` the rename itself stays —
/// `from_path` and `prior_hash` kept, `head`/`rendered_hash`/`commit_id`/
/// `created_at` the write's (the self-linking source of a `docs_move`, whose
/// retarget renders new bytes at the new path). A `rename` or a `remove`
/// replaces whatever is there (a rename's carry of the row at `from_path` is
/// the commit's, which knows both paths — [`crate::effects`]).
#[must_use]
pub fn supersede(existing: Option<&PendingRow>, incoming: PendingRow) -> PendingRow {
    let Some(existing) = existing else {
        return incoming;
    };
    if incoming.kind != PendingKind::Write {
        return incoming;
    }
    if existing.kind == PendingKind::Rename {
        return PendingRow {
            head: incoming.head,
            rendered_hash: incoming.rendered_hash,
            commit_id: incoming.commit_id,
            created_at: incoming.created_at,
            ..existing.clone()
        };
    }
    PendingRow {
        prior_hash: match existing.kind {
            PendingKind::Remove => Some(existing.rendered_hash.clone()),
            _ => existing.prior_hash.clone(),
        },
        ..incoming
    }
}

/// Record intent (inside the commit transaction): one row per path — a row
/// already at the path (an earlier request's unmaterialized intent) is
/// superseded by [`supersede`], then `INSERT OR REPLACE`.
pub(crate) fn insert_pending(conn: &Connection, repo_id: &str, row: &PendingRow) -> Result<()> {
    let existing = pending_at(conn, repo_id, &row.path)?;
    let row = supersede(existing.as_ref(), row.clone());
    conn.execute(
        "INSERT OR REPLACE INTO pending_materializations
           (repo_id, path, kind, from_path, doc_id, head, rendered_hash, prior_hash, commit_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            repo_id,
            row.path,
            row.kind.as_str(),
            row.from_path,
            row.doc_id,
            row.head,
            row.rendered_hash,
            row.prior_hash,
            row.commit_id,
            row.created_at,
        ],
    )?;
    Ok(())
}

/// The intent at `(repo, path)` is fulfilled (or superseded by a file that
/// wins).
pub(crate) fn delete_pending(conn: &Connection, repo_id: &str, path: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM pending_materializations WHERE repo_id = ?1 AND path = ?2",
        params![repo_id, path],
    )?;
    Ok(())
}

/// The bytes a `write`/`rename` row must land: `spec/store` §6.1 reconstruct
/// of the document's CURRENT state (17.0, §5.7: a row always names its
/// document's current head, because a later commit to the same path replaces
/// the row, and §6.1 is byte-exact for the head), which must hash to
/// `rendered_hash`. `None` when nothing can be rendered (the row names no
/// head, the document is no longer live, or the head moved under the row —
/// impossible while the replace rule holds, checked anyway): the row is kept
/// for a later materializer rather than guessed. Through 16.x this was
/// `reconstruct at rev_id` through the Merkle tree, and the prior bytes a
/// `revisions` self-join on `seq − 1`; no history table is read here now
/// (M4).
fn bytes_for(conn: &Connection, row: &PendingRow) -> Result<Option<String>> {
    if row.head.is_none() {
        return Ok(None);
    }
    let bytes = reconstruct(conn, &row.doc_id)?;
    Ok(bytes.filter(|b| hashes_to(b, &row.rendered_hash)))
}

fn hashes_to(bytes: &str, hash: &[u8]) -> bool {
    sha256(bytes.as_bytes())[..] == hash[..]
}

/// Whether the bytes at a path are the row's own: the expected bytes
/// themselves or `prior_hash` — the engine's previous bytes, what a file
/// left behind by the commit still holds.
fn own(row: &PendingRow, bytes: &str) -> bool {
    hashes_to(bytes, &row.rendered_hash)
        || row
            .prior_hash
            .as_deref()
            .is_some_and(|prior| hashes_to(bytes, prior))
}

/// Replay one row against the working tree (the §5.7 table). `Ok(true)`:
/// the intent is fulfilled and the row may go; `Ok(false)`: the row stays —
/// a foreign file at the path, or bytes that cannot be rendered. A doc store
/// that refuses a write propagates its error with the row intact (the row
/// is the durable record either way); so do database errors.
fn materialize_row(
    conn: &Connection,
    row: &PendingRow,
    doc_store: &mut dyn DocStore,
) -> Result<bool> {
    // OMGBASE_FAULT (Phase 5a): a fault before any write leaves the row and
    // the disk as they were; one after the write leaves the file in place and
    // the row owed — the next replay finds the bytes as recorded and clears it.
    fault_point(FaultSite::MaterializeBeforeWrite)?;
    let done = materialize_row_inner(conn, row, doc_store)?;
    if done {
        fault_point(FaultSite::MaterializeAfterWrite)?;
    }
    Ok(done)
}

/// [`materialize_row`]'s table, without the fault sites.
fn materialize_row_inner(
    conn: &Connection,
    row: &PendingRow,
    doc_store: &mut dyn DocStore,
) -> Result<bool> {
    match row.kind {
        PendingKind::Write => match doc_store.read(&row.path)? {
            Some(on_disk) if hashes_to(&on_disk, &row.rendered_hash) => Ok(true),
            Some(on_disk) if !own(row, &on_disk) => Ok(false),
            _ => {
                let Some(bytes) = bytes_for(conn, row)? else {
                    return Ok(false);
                };
                doc_store.write(&row.path, &bytes)?;
                Ok(true)
            }
        },
        PendingKind::Rename => {
            let from = row.from_path.as_deref();
            if let Some(at_to) = doc_store.read(&row.path)? {
                // The destination is occupied: by the moved bytes (done — a
                // stale copy of the engine's own bytes at `from` goes) or by
                // a foreign file (the row stays; the sweep sees `to` win and
                // `from` become untracked).
                if !hashes_to(&at_to, &row.rendered_hash) {
                    return Ok(false);
                }
                remove_if_own(row, from, doc_store)?;
                return Ok(true);
            }
            if let Some(from) = from.filter(|f| doc_store.exists(f)) {
                match doc_store.rename(from, &row.path) {
                    Ok(()) => {
                        // The old bytes moved; a self-linking source renders
                        // new bytes under its new path, so a renamed file
                        // holding the prior bytes is rewritten. Foreign bytes
                        // win at the new path, as the sweep will see.
                        if let Some(moved) = doc_store.read(&row.path)?
                            && !hashes_to(&moved, &row.rendered_hash)
                            && own(row, &moved)
                            && let Some(bytes) = bytes_for(conn, row)?
                        {
                            doc_store.write(&row.path, &bytes)?;
                        }
                        Ok(true)
                    }
                    Err(_) => {
                        // EXDEV or the like: write the document's bytes at
                        // the new path and retire the old file while it still
                        // holds the engine's own bytes.
                        let Some(bytes) = bytes_for(conn, row)? else {
                            return Ok(false);
                        };
                        doc_store.write(&row.path, &bytes)?;
                        remove_if_own(row, Some(from), doc_store)?;
                        Ok(true)
                    }
                }
            } else {
                let Some(bytes) = bytes_for(conn, row)? else {
                    return Ok(false);
                };
                doc_store.write(&row.path, &bytes)?;
                Ok(true)
            }
        }
        PendingKind::Remove => {
            // Unlink only the bytes the deleted document rendered
            // (`docs.file_hash` before the tombstone); a file a human rewrote
            // meanwhile stays — untracked now, the next sweep re-creates the
            // path (§5.6).
            if let Some(on_disk) = doc_store.read(&row.path)?
                && hashes_to(&on_disk, &row.rendered_hash)
            {
                doc_store.remove(&row.path)?;
            }
            Ok(true)
        }
    }
}

/// Unlink the moved document's old file when it still holds bytes the row
/// accounts for (the document's or the prior bytes).
fn remove_if_own(row: &PendingRow, from: Option<&str>, doc_store: &mut dyn DocStore) -> Result<()> {
    let Some(from) = from else {
        return Ok(());
    };
    if let Some(bytes) = doc_store.read(from)?
        && own(row, &bytes)
    {
        doc_store.remove(from)?;
    }
    Ok(())
}

impl Store {
    /// The repo's pending rows in insertion order (§5.7).
    pub fn pending_materializations(&self, repo_id: &str) -> Result<Vec<PendingRow>> {
        pending_rows(&self.conn, repo_id)
    }

    /// §5.7: replay every pending row of the repo against `doc_store`, in
    /// insertion order, deleting each row as its file lands (autocommit).
    /// Step 0 of the freshness sweep and of recovery (`spec/sync` §4.3).
    /// Returns the paths whose intent was fulfilled; a row whose path holds
    /// foreign bytes stays for the next materializer or observation; a doc
    /// store that refuses a write fails the call with the row intact.
    pub fn materialize_pending(
        &mut self,
        repo_id: &str,
        doc_store: &mut dyn DocStore,
    ) -> Result<Vec<String>> {
        self.materialize_pending_at(repo_id, doc_store, &crate::core::time::now_ts())
    }

    /// [`Store::materialize_pending`] at `now` — the clock of the alert
    /// channel (§5.8, 17.0 3e-ii): a replay that fails raises
    /// `materialization_failed` (the row intact, the error propagating —
    /// resolution 18), a full pass without a failure clears it, and the
    /// backlog condition is re-derived either way.
    pub fn materialize_pending_at(
        &mut self,
        repo_id: &str,
        doc_store: &mut dyn DocStore,
        now: &str,
    ) -> Result<Vec<String>> {
        let replayed = self.materialize_pending_rows(repo_id, doc_store, now);
        refresh_backlog_alert(&self.conn, repo_id, now)?;
        replayed
    }

    fn materialize_pending_rows(
        &mut self,
        repo_id: &str,
        doc_store: &mut dyn DocStore,
        now: &str,
    ) -> Result<Vec<String>> {
        let mut done = Vec::new();
        for row in pending_rows(&self.conn, repo_id)? {
            let landed = match materialize_row(&self.conn, &row, doc_store) {
                Ok(landed) => landed,
                Err(e) => {
                    // §5.8 (resolution 18): the stall is reported through the
                    // alert channel, not swallowed — the error still propagates.
                    let path = format!("/{}", row.path);
                    let reason = e.to_string();
                    let mut detail = Map::new();
                    detail.insert("path".to_owned(), Json::String(path.clone()));
                    detail.insert(
                        "kind".to_owned(),
                        Json::String(row.kind.as_str().to_owned()),
                    );
                    detail.insert("reason".to_owned(), Json::String(reason.clone()));
                    raise_alert(
                        &self.conn,
                        repo_id,
                        &AlertInput {
                            code: MATERIALIZATION_FAILED_ALERT,
                            severity: AlertSeverity::Error,
                            message: &materialization_failed_message(&path, &reason),
                            detail: Some(&detail),
                        },
                        now,
                    )?;
                    return Err(e);
                }
            };
            if landed {
                delete_pending(&self.conn, repo_id, &row.path)?;
                done.push(row.path);
            }
        }
        // A full pass with no failure ends the failure condition.
        clear_alert(&self.conn, repo_id, MATERIALIZATION_FAILED_ALERT, now)?;
        Ok(done)
    }

    /// §5.7 for the paths one request touches, in the order given: phase
    /// (a) of `spec/mutate` §4 step 5 (a row an earlier request left at a
    /// path is landed before the file is read, so a stale file is brought to
    /// its committed revision instead of being read back as a human edit)
    /// and phase B' (the request's own rows). Paths with no row are skipped.
    pub(crate) fn materialize_paths(
        &mut self,
        repo_id: &str,
        paths: &[String],
        doc_store: &mut dyn DocStore,
    ) -> Result<Vec<String>> {
        let mut done = Vec::new();
        for path in paths {
            let Some(row) = pending_at(&self.conn, repo_id, path)? else {
                continue;
            };
            if materialize_row(&self.conn, &row, doc_store)? {
                delete_pending(&self.conn, repo_id, path)?;
                done.push(path.clone());
            }
        }
        Ok(done)
    }
}
