//! Materialization (`spec/store/README.md` §5.7, store 14.0): the file
//! writes an `api` commit owes the working tree, recorded as intent.
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
//! back as a human edit.
//!
//! **A file a human changes meanwhile wins** (ADR-004). The materializer
//! writes a `write` row only over nothing, over the bytes it already
//! expects, or over the bytes of the document's *previous* revision (the
//! file the commit left behind); anything else is a foreign edit the row
//! stays behind for, until the sweep observes it (file wins, row cleared).
//! A `rename` lands the moved document's bytes at `to` — by rename when the
//! old file is still there and `to` is free, by writing the revision's bytes
//! otherwise — and keeps the row when `to` holds foreign bytes. A `remove`
//! unlinks only a file that still hashes to what the deleted revision
//! rendered; a foreign file is left for the sweep.

use omgbase_format::hash::sha256;
use rusqlite::{Connection, OptionalExtension, params};

use crate::Store;
use crate::doc_store::DocStore;
use crate::error::Result;
use crate::read::{read_at_revision, reconstruct};

/// What a pending row asks the working tree for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PendingKind {
    /// The revision's bytes at `path`.
    Write,
    /// The file at `from_path` must end up at `path` holding the revision's
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

/// One `pending_materializations` row (`repo_id` implied).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingRow {
    pub path: String,
    pub kind: PendingKind,
    /// `rename`: the old path.
    pub from_path: Option<String>,
    pub doc_id: String,
    /// `write`/`rename`: the revision the bytes render; `None` for `remove`.
    pub rev_id: Option<String>,
    /// The bytes expected at `path` (`remove`: the bytes safe to unlink).
    pub rendered_hash: Vec<u8>,
    pub commit_id: String,
}

const COLUMNS: &str = "path, kind, from_path, doc_id, rev_id, rendered_hash, commit_id";

fn row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<PendingRow> {
    let kind: String = r.get(1)?;
    Ok(PendingRow {
        path: r.get(0)?,
        kind: PendingKind::parse(&kind).unwrap_or(PendingKind::Write),
        from_path: r.get(2)?,
        doc_id: r.get(3)?,
        rev_id: r.get(4)?,
        rendered_hash: r.get(5)?,
        commit_id: r.get(6)?,
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

/// Record intent (inside the commit transaction). A row already at the path
/// — an earlier request's unmaterialized intent — is superseded: the newer
/// revision is the one the file must hold.
pub(crate) fn insert_pending(conn: &Connection, repo_id: &str, row: &PendingRow) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO pending_materializations
           (repo_id, path, kind, from_path, doc_id, rev_id, rendered_hash, commit_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            repo_id,
            row.path,
            row.kind.as_str(),
            row.from_path,
            row.doc_id,
            row.rev_id,
            row.rendered_hash,
            row.commit_id,
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

/// The `rendered_hash` of the document's revision before `rev_id`: the bytes
/// a file left behind by the commit still holds.
fn previous_rendered_hash(
    conn: &Connection,
    doc_id: &str,
    rev_id: &str,
) -> Result<Option<Vec<u8>>> {
    Ok(conn
        .query_row(
            "SELECT rendered_hash FROM revisions
             WHERE doc_id = ?1 AND seq < (SELECT seq FROM revisions WHERE rev_id = ?2)
             ORDER BY seq DESC LIMIT 1",
            params![doc_id, rev_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// The bytes a `write`/`rename` row must land: the revision's (§6.2), or the
/// live document's current bytes when the row names no revision — and only
/// when they hash to `rendered_hash`. `None` when nothing can be rendered
/// (the document is no longer live, the revision is unknown, the
/// reconstruction does not hash to the row): the row is kept for a later
/// materializer rather than guessed.
fn bytes_for(conn: &Connection, row: &PendingRow) -> Result<Option<String>> {
    let bytes = match &row.rev_id {
        Some(rev) => read_at_revision(conn, &row.doc_id, rev)?.map(|r| r.content),
        None => reconstruct(conn, &row.doc_id)?,
    };
    Ok(bytes.filter(|b| hashes_to(b, &row.rendered_hash)))
}

fn hashes_to(bytes: &str, hash: &[u8]) -> bool {
    sha256(bytes.as_bytes())[..] == hash[..]
}

/// Whether the bytes at a path are ones the row may replace: the expected
/// bytes themselves or the previous revision's.
fn replaceable(conn: &Connection, row: &PendingRow, bytes: &str) -> Result<bool> {
    if hashes_to(bytes, &row.rendered_hash) {
        return Ok(true);
    }
    match &row.rev_id {
        Some(rev) => {
            Ok(previous_rendered_hash(conn, &row.doc_id, rev)?
                .is_some_and(|h| hashes_to(bytes, &h)))
        }
        None => Ok(false),
    }
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
    match row.kind {
        PendingKind::Write => match doc_store.read(&row.path)? {
            Some(on_disk) if hashes_to(&on_disk, &row.rendered_hash) => Ok(true),
            Some(on_disk) if !replaceable(conn, row, &on_disk)? => Ok(false),
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
                remove_if_replaceable(conn, row, from, doc_store)?;
                return Ok(true);
            }
            if let Some(from) = from.filter(|f| doc_store.exists(f)) {
                match doc_store.rename(from, &row.path) {
                    Ok(()) => {
                        // The old bytes moved; a self-linking source renders
                        // new bytes under its new path, so a renamed file
                        // holding the prior bytes is rewritten. Foreign bytes
                        // win at the new path, as the sweep will see.
                        if let Some(moved) = doc_store.read(&row.path)? {
                            if !hashes_to(&moved, &row.rendered_hash)
                                && replaceable(conn, row, &moved)?
                            {
                                if let Some(bytes) = bytes_for(conn, row)? {
                                    doc_store.write(&row.path, &bytes)?;
                                }
                            }
                        }
                        Ok(true)
                    }
                    Err(_) => {
                        // EXDEV or the like: write the revision's bytes at
                        // the new path and retire the old file while it still
                        // holds the engine's own bytes.
                        let Some(bytes) = bytes_for(conn, row)? else {
                            return Ok(false);
                        };
                        doc_store.write(&row.path, &bytes)?;
                        remove_if_replaceable(conn, row, Some(from), doc_store)?;
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
            if let Some(on_disk) = doc_store.read(&row.path)? {
                if hashes_to(&on_disk, &row.rendered_hash) {
                    doc_store.remove(&row.path)?;
                }
                // Foreign bytes stay: untracked now, the next sweep re-creates
                // the path (§5.6).
            }
            Ok(true)
        }
    }
}

/// Unlink the moved document's old file when it still holds bytes the row
/// accounts for (the revision's or the previous revision's).
fn remove_if_replaceable(
    conn: &Connection,
    row: &PendingRow,
    from: Option<&str>,
    doc_store: &mut dyn DocStore,
) -> Result<()> {
    let Some(from) = from else {
        return Ok(());
    };
    if let Some(bytes) = doc_store.read(from)? {
        if replaceable(conn, row, &bytes)? {
            doc_store.remove(from)?;
        }
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
        let mut done = Vec::new();
        for row in pending_rows(&self.conn, repo_id)? {
            if materialize_row(&self.conn, &row, doc_store)? {
                delete_pending(&self.conn, repo_id, &row.path)?;
                done.push(row.path);
            }
        }
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
