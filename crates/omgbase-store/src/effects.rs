//! The `api` commit as one transaction (`spec/mutate/README.md` §4 step 5,
//! §6; `spec/store` §5.4 "The api path", store 13.7): a request — a
//! changeset over N documents, a `docs_move` with its inbound retarget, a
//! `links_repair`, a `docs_create` / `docs_set_meta` / `docs_delete` —
//! lowers to an ordered list of [`Effect`]s that [`Store::commit_effects`]
//! runs under **one** `commits` row in **one** SQLite transaction, all or
//! nothing. The set is internal: the tools keep their wire shapes, and the
//! public effect vocabulary of the planner is a later step.
//!
//! Every read an effect needs (the inbound links of a move, its retarget
//! plan, the reconcile of a create) happens before the transaction, because
//! the transaction borrows the connection; inside it only the store's minter
//! over the transaction and the writers of [`crate::observe`] run.
//!
//! **CAS inside the transaction** (mutate 2.2). The transaction is `BEGIN
//! IMMEDIATE`, and before anything is minted every effect's precondition is
//! re-read through it: per touched document the triple `(path, current_rev,
//! file_hash)` captured when the document was loaded (invariant I3 of
//! `spec/store` §8 makes `current_rev` the version vector of every live
//! block, so no block is re-read), the on-disk hash phase A took, "no live
//! document at the path" for a create or a move's destination, "still live"
//! for a tombstone. A database that moved underneath the plan fails
//! `stale_plan` with the current truth; a destination that appeared fails
//! `path_taken`; a document that vanished fails `doc_missing`; and a file
//! that no longer hashes to `file_hash` returns [`Outcome::Conflict`] so the
//! caller can ingest the disk bytes as `observed` in a transaction of its
//! own and raise `sync_conflict`. The validation runs before `new_commit`,
//! so a conflict burns no id.
//!
//! **Recorded intent** (store 14.0). An `api` commit writes no file inside
//! the transaction: after its effects it inserts one
//! `pending_materializations` row per path the request owes the working tree
//! (`spec/store` §5.7), and the caller materializes them after COMMIT
//! ([`Store::materialize_pending`](crate::materialize)). An `observed`
//! commit records nothing — the file is the source.

use omgbase_format::hash::{hex, sha256};
use omgbase_format::parse_markdown;
use omgbase_mutate::{ErrorCode, MutationError};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::json;

use crate::Store;
use crate::error::Result;
use crate::graph::{adopt_phantoms, rebuild_doc_edges};
use crate::links::InboundLink;
use crate::materialize::{PendingKind, PendingRow, delete_pending, insert_pending};
use crate::mint::Mint;
use crate::mutate::known_plan;
use crate::observe::{Committed, Prepared, ingest_in, tombstone_in};
use crate::time::pool_expiry;
use crate::writers::{NewCommit, Origin, new_commit};

/// The commit row a request records (`spec/store` §5.4 step 5). `ops` is
/// ADR-003's intent record — `canonical({ v: 1, plan_id, effects })` for an
/// effect-driven commit (`spec/mutate` §11), `NULL` for every other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CommitHead<'a> {
    pub origin: Origin,
    pub actor: Option<&'a str>,
    pub reason: Option<&'a str>,
    /// An `observed` ingest of a file that superseded an `api` intent still
    /// pending at its path (`spec/store` §5.7, the file wins): the row is
    /// deleted in this transaction, with the commit that supersedes it.
    pub clear_pending: bool,
    /// `commits.ops`.
    pub ops: Option<&'a str>,
}

/// A live document's precondition as captured when it was loaded (the opset
/// precondition shape `{ id, path, base_revision, hash }` the planner will
/// freeze later): the row's `(path, current_rev, file_hash)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DocBase {
    pub doc_id: String,
    pub path: String,
    pub current_rev: Option<String>,
    pub file_hash: Option<Vec<u8>>,
}

/// The live row's triple for `doc_id`, or `None` for an unknown or
/// tombstoned document.
pub(crate) fn doc_base(conn: &Connection, doc_id: &str) -> Result<Option<DocBase>> {
    Ok(conn
        .query_row(
            "SELECT path, current_rev, file_hash FROM docs WHERE doc_id = ?1 AND deleted_commit IS NULL",
            params![doc_id],
            |r| {
                Ok(DocBase {
                    doc_id: doc_id.to_owned(),
                    path: r.get(0)?,
                    current_rev: r.get(1)?,
                    file_hash: r.get(2)?,
                })
            },
        )
        .optional()?)
}

/// What an ingest effect re-validates inside the transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Guard {
    /// Nothing: an `observed` ingest — the file wins (ADR-004), whatever
    /// the database holds.
    None,
    /// `docs_create`, and a planner `create` (`spec/mutate` §11.3, 3.0): no
    /// live document at the ingested path (`path_taken`).
    Absent,
    /// A loaded document (`docs_set_meta`, every changeset document): its
    /// triple, and the bytes read before the write must still hash to
    /// `file_hash`.
    Doc {
        base: DocBase,
        /// The file as read before the write (`None`: no file).
        on_disk: Option<String>,
    },
}

/// One step of a request's commit, run in order under the shared row.
pub(crate) enum Effect {
    /// `spec/store` §5.4 steps 1–4, 6–13 with the **known-id** resolver
    /// (`spec/mutate` §4 step 5): the rendered bytes of a working tree whose
    /// ids are known by position. `path` is the row the ingest finds or
    /// creates — a document moved in the same request names its **new**
    /// path here even though it was loaded under the old one (`base.path`).
    IngestKnown {
        /// The loaded document's id — or, for a document a plan creates, its
        /// `$new.<n>` symbol: the ingest finds no row at `path` and mints
        /// the `d` (3.0).
        doc_id: String,
        path: String,
        rendered: String,
        /// Positional key (`"/i/j"`) → block id of the working tree.
        by_key: std::collections::BTreeMap<String, String>,
        /// The live ids before any op (labels the `api` dispositions; empty
        /// for a created document, so every block is `inserted`).
        prior_ids: Vec<String>,
        /// [`Guard::Doc`] with the row as loaded (§4 step 1) and the file at
        /// its path as phase A read it; [`Guard::Absent`] for a created
        /// document (`spec/mutate` §11.3, 3.0).
        guard: Guard,
    },
    /// The same steps with the **reconciling** resolver, the member already
    /// parsed and matched outside the transaction (`docs_create`,
    /// `docs_set_meta`, the sync layer's recovery).
    IngestReconciled {
        prepared: Box<Prepared>,
        guard: Guard,
    },
    /// `spec/mutate` §6 `docs_move`'s row changes: the doc and current
    /// revision take the new path, every open edge from another document
    /// (and a self edge whose link names the path) re-points to
    /// `phantom:<from>`, the affected rollups are rebuilt, phantoms at the
    /// new path are adopted. No revision. Runs **first**, so the retarget
    /// ingests that follow resolve `[x](<to>)` to the document.
    MovePath {
        doc_id: String,
        from: String,
        to: String,
        current_rev: Option<String>,
        /// The inbound links as computed before the move (its self edges
        /// are the ones re-pointed).
        inbound: Vec<InboundLink>,
    },
    /// `spec/store` §5.6's tombstone: `pool` the live blocks (an observed
    /// deletion) or not (`docs_delete`). `current_rev` as found; `path` the
    /// document's (the file the `remove` intent names, 14.0).
    Tombstone {
        doc_id: String,
        path: String,
        pool: bool,
        current_rev: Option<String>,
    },
}

impl std::fmt::Debug for Effect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Effect::IngestKnown { doc_id, path, .. } => f
                .debug_struct("IngestKnown")
                .field("doc_id", doc_id)
                .field("path", path)
                .finish_non_exhaustive(),
            Effect::IngestReconciled { prepared, guard } => f
                .debug_struct("IngestReconciled")
                .field("path", &prepared.path)
                .field("guard", guard)
                .finish_non_exhaustive(),
            Effect::MovePath {
                doc_id, from, to, ..
            } => f
                .debug_struct("MovePath")
                .field("doc_id", doc_id)
                .field("from", from)
                .field("to", to)
                .finish_non_exhaustive(),
            Effect::Tombstone {
                doc_id,
                path,
                pool,
                current_rev,
            } => f
                .debug_struct("Tombstone")
                .field("doc_id", doc_id)
                .field("path", path)
                .field("pool", pool)
                .field("current_rev", current_rev)
                .finish(),
        }
    }
}

/// A file that no longer hashes to its document's `file_hash`, found inside
/// the transaction: the path and the bytes phase A read there, for the
/// caller's `observed` ingest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DiskConflict {
    pub path: String,
    pub bytes: String,
}

/// What [`Store::commit_effects`] came back with.
#[derive(Debug)]
pub(crate) enum Outcome {
    /// Committed: one [`Committed`] per ingest effect, in order.
    Committed(Vec<Committed>),
    /// Rolled back before anything was minted: a file moved under the plan.
    Conflict(DiskConflict),
}

impl Outcome {
    /// The committed ingests, or a plain error for a caller whose effects
    /// carry no disk precondition (nothing it could re-ingest).
    pub(crate) fn committed(self) -> Result<Vec<Committed>> {
        match self {
            Outcome::Committed(c) => Ok(c),
            Outcome::Conflict(c) => Err(crate::error::Error::Other(format!(
                "commit_effects: unexpected disk conflict at {}",
                c.path
            ))),
        }
    }
}

impl Store {
    /// Commit `effects` in order under one `commits` row (`head`, stamped
    /// `ts`) in one `BEGIN IMMEDIATE` transaction: BEGIN, re-validate every
    /// effect's precondition through the transaction, step 5 once, every
    /// effect against the transaction, COMMIT. A precondition the database
    /// no longer meets fails `stale_plan` / `path_taken` / `doc_missing`
    /// (`spec/mutate` §8) and a file that moved returns
    /// [`Outcome::Conflict`] — in both cases the transaction rolls back
    /// before any id is minted. An error anywhere else rolls the whole
    /// request back — files the caller wrote before this are then ahead of
    /// the database until the next observation heals them (`spec/mutate`
    /// §10). Mints `c` first, then per document `r`, `x`, `e` (and `d` for
    /// a new path). No effects, no row: a request that touched no document
    /// — a macro that expanded to nothing, a `links_repair` with no hit —
    /// records nothing (`spec/mutate` `macros::sections-move-unknown-heading`).
    pub(crate) fn commit_effects(
        &mut self,
        repo_id: &str,
        head: &CommitHead<'_>,
        effects: &[Effect],
        ts: &str,
    ) -> Result<Outcome> {
        self.commit_effects_with_id(repo_id, head, effects, ts)
            .map(|(outcome, _)| outcome)
    }

    /// [`Store::commit_effects`] with the commit id it minted (`None` when
    /// nothing was committed: no effects, or a conflict).
    pub(crate) fn commit_effects_with_id(
        &mut self,
        repo_id: &str,
        head: &CommitHead<'_>,
        effects: &[Effect],
        ts: &str,
    ) -> Result<(Outcome, Option<String>)> {
        if effects.is_empty() {
            return Ok((Outcome::Committed(Vec::new()), None));
        }
        let expires = pool_expiry(ts)?;
        let Store { conn, ids, .. } = self;
        let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
        #[cfg(test)]
        if let Some(hook) = self.after_begin.as_mut() {
            hook();
        }
        if let Some(conflict) = validate(&tx, repo_id, effects)? {
            drop(tx);
            return Ok((Outcome::Conflict(conflict), None));
        }
        let (committed, commit_id) = {
            let mut mint = ids.at(&tx);
            let (commit_id, _) = new_commit(
                &tx,
                &mut mint,
                &NewCommit {
                    repo_id,
                    ts,
                    origin: head.origin,
                    actor: head.actor,
                    reason: head.reason,
                    checkpoint_id: None,
                    ops: head.ops,
                },
            )?;
            let mut outcomes = Vec::with_capacity(effects.len());
            for effect in effects {
                outcomes.push(run_effect(
                    &tx, &mut mint, repo_id, head, effect, &expires, &commit_id,
                )?);
            }
            // 14.0: the files this request owes the working tree, recorded
            // before COMMIT so a crash loses nothing (`spec/store` §5.7).
            if head.origin == Origin::Api {
                record_intent(&tx, repo_id, effects, &outcomes, &commit_id)?;
            }
            if head.clear_pending {
                for path in touched_paths(effects) {
                    delete_pending(&tx, repo_id, &path)?;
                }
            }
            (
                outcomes.into_iter().flatten().collect::<Vec<_>>(),
                commit_id,
            )
        };
        tx.commit()?;
        Ok((Outcome::Committed(committed), Some(commit_id)))
    }
}

// ---- recorded intent (store 14.0) -----------------------------------------------------------

/// The paths a request's effects touch on disk, in effect order without
/// repeats: where each document was loaded and where it lands, a move's
/// old and new path, a tombstoned document's path. What `spec/mutate` §4
/// step 5 (a) replays before reading and what B' materializes after COMMIT.
pub(crate) fn touched_paths(effects: &[Effect]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |p: &str| {
        if !out.iter().any(|q| q == p) {
            out.push(p.to_owned());
        }
    };
    for e in effects {
        match e {
            Effect::IngestKnown { path, guard, .. } => {
                if let Guard::Doc { base, .. } = guard {
                    push(&base.path);
                }
                push(path);
            }
            Effect::IngestReconciled { prepared, .. } => push(&prepared.path),
            Effect::MovePath { from, to, .. } => {
                push(from);
                push(to);
            }
            Effect::Tombstone { path, .. } => push(path),
        }
    }
    out
}

/// The document's `(current_rev, rendered_hash)` after the effects ran: the
/// revision's hash, else the row's `file_hash` (a document no revision
/// rendered yet), else the hash of what it reconstructs to.
fn current_bytes_hash(tx: &Connection, doc_id: &str) -> Result<Option<(Option<String>, Vec<u8>)>> {
    type Row = (Option<String>, Option<Vec<u8>>, Option<Vec<u8>>);
    let row: Option<Row> = tx
        .query_row(
            "SELECT d.current_rev, r.rendered_hash, d.file_hash
             FROM docs d LEFT JOIN revisions r ON r.rev_id = d.current_rev
             WHERE d.doc_id = ?1",
            params![doc_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((rev, rendered, file_hash)) = row else {
        return Ok(None);
    };
    let hash = match rendered.or(file_hash) {
        Some(h) => h,
        None => match crate::read::reconstruct(tx, doc_id)? {
            Some(bytes) => sha256(bytes.as_bytes()).to_vec(),
            None => return Ok(None),
        },
    };
    Ok(Some((rev, hash)))
}

/// One `pending_materializations` row per path the request must write,
/// rename or remove, in effect order: a `write` per ingested document (the
/// revision just minted), a `rename` for a moved document — carrying the
/// revision it holds after the whole request, so a moved document that was
/// also a retarget source lands its rewritten bytes at the new path and the
/// old file goes with it — and a `remove` for a tombstoned one (the bytes
/// its last revision rendered, so a foreign file is never unlinked).
fn record_intent(
    tx: &Connection,
    repo_id: &str,
    effects: &[Effect],
    outcomes: &[Option<Committed>],
    commit_id: &str,
) -> Result<()> {
    let moved: Option<&str> = effects.iter().find_map(|e| match e {
        Effect::MovePath { doc_id, .. } => Some(doc_id.as_str()),
        _ => None,
    });
    for (effect, outcome) in effects.iter().zip(outcomes) {
        let ingested_path = match effect {
            Effect::IngestKnown { path, .. } => Some(path.as_str()),
            Effect::IngestReconciled { prepared, .. } => Some(prepared.path.as_str()),
            _ => None,
        };
        let row = match (ingested_path, effect, outcome) {
            (Some(path), _, Some(c)) => {
                if moved == Some(c.doc_id.as_str()) {
                    continue; // the rename row lands these bytes
                }
                let rendered_hash: Vec<u8> = tx.query_row(
                    "SELECT rendered_hash FROM revisions WHERE rev_id = ?1",
                    params![c.rev_id],
                    |r| r.get(0),
                )?;
                PendingRow {
                    path: path.to_owned(),
                    kind: PendingKind::Write,
                    from_path: None,
                    doc_id: c.doc_id.clone(),
                    rev_id: Some(c.rev_id.clone()),
                    rendered_hash,
                    commit_id: commit_id.to_owned(),
                }
            }
            (
                _,
                Effect::MovePath {
                    doc_id, from, to, ..
                },
                _,
            ) => {
                let Some((rev_id, rendered_hash)) = current_bytes_hash(tx, doc_id)? else {
                    continue;
                };
                PendingRow {
                    path: to.clone(),
                    kind: PendingKind::Rename,
                    from_path: Some(from.clone()),
                    doc_id: doc_id.clone(),
                    rev_id,
                    rendered_hash,
                    commit_id: commit_id.to_owned(),
                }
            }
            (
                _,
                Effect::Tombstone {
                    doc_id, path, pool, ..
                },
                _,
            ) => {
                if *pool {
                    continue; // an observed deletion owes the tree nothing
                }
                let rendered_hash = current_bytes_hash(tx, doc_id)?
                    .map_or_else(|| sha256(b"").to_vec(), |(_, h)| h);
                PendingRow {
                    path: path.clone(),
                    kind: PendingKind::Remove,
                    from_path: None,
                    doc_id: doc_id.clone(),
                    rev_id: None,
                    rendered_hash,
                    commit_id: commit_id.to_owned(),
                }
            }
            _ => continue,
        };
        insert_pending(tx, repo_id, &row)?;
    }
    Ok(())
}

// ---- validation (mutate 2.2) ------------------------------------------------------------

/// `stale_plan` with the current truth, the shape `docs_update` emits for
/// an opset whose precondition is behind (`spec/mutate` §8).
pub(crate) fn stale_plan(base: &DocBase, current: Option<&DocBase>) -> crate::error::Error {
    MutationError::with_data(
        ErrorCode::StalePlan,
        "document changed since the plan was computed; re-plan",
        json!({
            "doc": base.doc_id,
            "expected_revision": base.current_rev,
            "current": {
                "revision": current.and_then(|c| c.current_rev.clone()),
                "hash": current.and_then(|c| c.file_hash.as_deref().map(hex)),
            },
            "retriable": true,
        }),
    )
    .into()
}

pub(crate) fn doc_missing(doc_id: &str) -> crate::error::Error {
    MutationError::with_data(
        ErrorCode::DocMissing,
        format!("doc {doc_id} not found"),
        json!({ "doc": doc_id }),
    )
    .into()
}

pub(crate) fn path_taken(path: &str) -> crate::error::Error {
    MutationError::new(
        ErrorCode::PathTaken,
        format!("a document already exists at {path}"),
    )
    .into()
}

fn live_doc_at(tx: &Connection, repo_id: &str, path: &str) -> Result<bool> {
    Ok(tx
        .query_row(
            "SELECT 1 FROM docs WHERE repo_id = ?1 AND path = ?2 AND deleted_commit IS NULL",
            params![repo_id, path],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// The document's row must still be the captured triple (`stale_plan`,
/// `doc_missing`), and the file phase A read must still hash to its
/// `file_hash` (a conflict). `file_hash IS NULL` — a row no observation has
/// hashed yet — or no file passes the disk check.
fn check_doc(
    tx: &Connection,
    base: &DocBase,
    on_disk: Option<&str>,
) -> Result<Option<DiskConflict>> {
    let Some(current) = doc_base(tx, &base.doc_id)? else {
        return Err(doc_missing(&base.doc_id));
    };
    if current != *base {
        return Err(stale_plan(base, Some(&current)));
    }
    if let (Some(bytes), Some(hash)) = (on_disk, &current.file_hash) {
        if sha256(bytes.as_bytes())[..] != hash[..] {
            return Ok(Some(DiskConflict {
                path: base.path.clone(),
                bytes: bytes.to_owned(),
            }));
        }
    }
    Ok(None)
}

/// An ingest's guard against the transaction: nothing, the path still free
/// (`path_taken`), or the document's triple and bytes ([`check_doc`]).
fn check_guard(
    tx: &Connection,
    repo_id: &str,
    path: &str,
    guard: &Guard,
) -> Result<Option<DiskConflict>> {
    match guard {
        Guard::None => Ok(None),
        Guard::Absent => {
            if live_doc_at(tx, repo_id, path)? {
                return Err(path_taken(path));
            }
            Ok(None)
        }
        Guard::Doc { base, on_disk } => check_doc(tx, base, on_disk.as_deref()),
    }
}

/// Every effect's precondition against the transaction, in effect order,
/// before anything is minted. The first database mismatch is the error; the
/// first disk mismatch is the conflict.
fn validate(tx: &Connection, repo_id: &str, effects: &[Effect]) -> Result<Option<DiskConflict>> {
    for effect in effects {
        match effect {
            Effect::IngestKnown { path, guard, .. } => {
                if let Some(c) = check_guard(tx, repo_id, path, guard)? {
                    return Ok(Some(c));
                }
            }
            Effect::IngestReconciled { prepared, guard } => {
                if let Some(c) = check_guard(tx, repo_id, &prepared.path, guard)? {
                    return Ok(Some(c));
                }
            }
            Effect::MovePath {
                doc_id,
                from,
                to,
                current_rev,
                ..
            } => {
                let Some(current) = doc_base(tx, doc_id)? else {
                    return Err(doc_missing(doc_id));
                };
                if current.path != *from || current.current_rev != *current_rev {
                    let base = DocBase {
                        doc_id: doc_id.clone(),
                        path: from.clone(),
                        current_rev: current_rev.clone(),
                        file_hash: current.file_hash.clone(),
                    };
                    return Err(stale_plan(&base, Some(&current)));
                }
                if live_doc_at(tx, repo_id, to)? {
                    return Err(path_taken(to));
                }
            }
            Effect::Tombstone {
                doc_id,
                current_rev,
                ..
            } => {
                let Some(current) = doc_base(tx, doc_id)? else {
                    return Err(doc_missing(doc_id));
                };
                if current.current_rev != *current_rev {
                    let base = DocBase {
                        doc_id: doc_id.clone(),
                        path: current.path.clone(),
                        current_rev: current_rev.clone(),
                        file_hash: current.file_hash.clone(),
                    };
                    return Err(stale_plan(&base, Some(&current)));
                }
            }
        }
    }
    Ok(None)
}

// ---- the effects -------------------------------------------------------------------------

fn run_effect(
    tx: &Connection,
    mint: &mut Mint<'_>,
    repo_id: &str,
    head: &CommitHead<'_>,
    effect: &Effect,
    expires: &str,
    commit_id: &str,
) -> Result<Option<Committed>> {
    match effect {
        Effect::IngestKnown {
            path,
            rendered,
            by_key,
            prior_ids,
            ..
        } => {
            let tree = parse_markdown(rendered);
            let plan = known_plan(
                &tree,
                path,
                rendered,
                by_key,
                prior_ids,
                mint,
                head.origin,
                head.actor,
                head.reason,
            )?;
            Ok(Some(ingest_in(
                tx, mint, repo_id, &plan, expires, commit_id,
            )?))
        }
        Effect::IngestReconciled { prepared, .. } => {
            let plan = prepared.plan(mint, head.origin, head.actor, head.reason, None)?;
            Ok(Some(ingest_in(
                tx, mint, repo_id, &plan, expires, commit_id,
            )?))
        }
        Effect::MovePath {
            doc_id,
            from,
            to,
            current_rev,
            inbound,
        } => {
            move_path_in(tx, doc_id, from, to, current_rev.as_deref(), inbound)?;
            Ok(None)
        }
        Effect::Tombstone { doc_id, pool, .. } => {
            tombstone_in(tx, doc_id, commit_id, pool.then_some(expires))?;
            Ok(None)
        }
    }
}

/// [`Effect::MovePath`]'s statements (the reference's `docsMove` write
/// block): path pointers, the edge re-point to the old path's phantom, the
/// affected rollups, phantom adoption at the new path.
fn move_path_in(
    tx: &Connection,
    doc_id: &str,
    from: &str,
    to: &str,
    current_rev: Option<&str>,
    inbound: &[InboundLink],
) -> Result<()> {
    tx.execute(
        "UPDATE docs SET path = ?1 WHERE doc_id = ?2",
        params![to, doc_id],
    )?;
    tx.execute(
        "UPDATE revisions SET path = ?1 WHERE doc_id = ?2 AND rev_id = ?3",
        params![to, doc_id, current_rev],
    )?;
    let phantom = format!("phantom:{from}");
    let mut affected: Vec<String> = Vec::new();
    {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT src_doc FROM edges WHERE dst_node = ?1 AND to_commit IS NULL AND src_doc != ?1",
        )?;
        let it = stmt.query_map(params![doc_id], |r| r.get::<_, String>(0))?;
        for src in it {
            let src = src?;
            if !affected.contains(&src) {
                affected.push(src);
            }
        }
    }
    tx.execute(
        "UPDATE edges SET dst_node = ?1 WHERE dst_node = ?2 AND to_commit IS NULL AND src_doc != ?2",
        params![phantom, doc_id],
    )?;
    for l in inbound {
        let Some(block) = &l.block else {
            continue;
        };
        if l.doc != doc_id {
            continue;
        }
        tx.execute(
            "UPDATE edges SET dst_node = ?1 WHERE dst_node = ?2 AND to_commit IS NULL AND src_doc = ?2 AND src_block = ?3 AND anchor IS ?4",
            params![phantom, doc_id, block, l.anchor],
        )?;
        if !affected.iter().any(|d| d == doc_id) {
            affected.push(doc_id.to_owned());
        }
    }
    for d in &affected {
        rebuild_doc_edges(tx, d)?;
    }
    adopt_phantoms(tx, to, doc_id)
}
