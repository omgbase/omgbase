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
//! re-read through it: per touched document the triple `(path, head,
//! file_hash)` captured when the document was loaded (the head token, store
//! 17.0 D1, is minted on every change to the document — content, structure,
//! path or liveness — so no block is re-read), the on-disk hash phase A took, "no live
//! document at the path" for a create or a move's destination, "still live"
//! for a tombstone. A database that moved underneath the plan fails
//! `stale_plan` with the current truth; a destination that appeared fails
//! `path_taken`; a document that vanished fails `doc_missing`; and a file
//! that no longer hashes to `file_hash` returns [`Outcome::Conflict`] so the
//! caller can ingest the disk bytes as `observed` in a transaction of its
//! own and raise `sync_conflict`. The validation runs before the feed row
//! is appended, so a conflict burns no id.
//!
//! **Recorded intent** (store 14.0). An `api` commit writes no file inside
//! the transaction: after its effects it inserts one
//! `pending_materializations` row per path the request owes the working tree
//! (`spec/store` §5.7), and the caller materializes them after COMMIT
//! ([`Store::materialize_pending`](crate::materialize)). An `observed`
//! commit records nothing — the file is the source.

use omgbase_format::hash::{hex, sha256};
use omgbase_format::parse_path;
use omgbase_mutate::{ErrorCode, MutationError};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::json;

use std::collections::HashSet;

use crate::Store;
use crate::core::capabilities::{HistoryRecorder, RevisionTransition, require_history};
use crate::core::codec::attrs_from_json;
use crate::core::feed::{
    FeedEntryKind, FeedRow, NewFeedEntry, NewFeedRow, append_feed_entry, append_feed_row,
};
use crate::core::manifest::require_writer;
use crate::error::Result;
use crate::graph::{adopt_phantoms, rebuild_doc_edges, retarget_open_edges};
use crate::links::InboundLink;
use crate::materialize::{
    PendingKind, PendingRow, delete_pending, insert_pending, pending_at, supersede,
};
use crate::mint::Mint;
use crate::mutate::known_plan;
use crate::observe::{Committed, Prepared, ingest_in, tombstone_in};
use crate::time::pool_expiry;
use crate::writers::{Origin, TreeInputBlock};

/// The feed row a request records (`spec/store` §5.4 step 5; the recorder's
/// `commits` row is its twin). `plan_id` is the admitted plan's digest for an
/// effect-driven commit (resolution 3 — carried on the feed row so a Receipt
/// correlates with the documents it touched when history is off); `ops` is
/// ADR-003's intent record — `canonical({ v: 1, plan_id, effects })` for an
/// effect-driven commit (`spec/mutate` §11), the recorder's column alone.
/// Both `NULL` for every other request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CommitHead<'a> {
    pub origin: Origin,
    pub actor: Option<&'a str>,
    pub reason: Option<&'a str>,
    /// An `observed` ingest of a file that superseded an `api` intent still
    /// pending at its path (`spec/store` §5.7, the file wins): the row is
    /// deleted in this transaction, with the commit that supersedes it.
    pub clear_pending: bool,
    /// `feed.plan_id`.
    pub plan_id: Option<&'a str>,
    /// `commits.ops`.
    pub ops: Option<&'a str>,
}

/// A live document's precondition as captured when it was loaded (the opset
/// precondition shape `{ id, path, base_revision, hash }` the planner will
/// freeze later): the row's `(path, head, file_hash)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DocBase {
    pub doc_id: String,
    pub path: String,
    /// The head token (`docs.head`, store 17.0 D1).
    pub current_rev: Option<String>,
    pub file_hash: Option<Vec<u8>>,
}

/// The live row's triple for `doc_id`, or `None` for an unknown or
/// tombstoned document.
pub(crate) fn doc_base(conn: &Connection, doc_id: &str) -> Result<Option<DocBase>> {
    Ok(conn
        .query_row(
            "SELECT path, head, file_hash FROM docs WHERE doc_id = ?1 AND deleted_at IS NULL",
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
    /// `spec/mutate` §6 `docs_move`'s row changes: the doc takes the new
    /// path and — a move is a TRANSITION (store 17.0, D11) — a new head with
    /// `updated_at = ts`, handed to the recorder as a revision of the
    /// unchanged tree at the new path (skipped when the document is itself
    /// a retarget source of the request: its `IngestKnown` below mints the
    /// head and carries the path — one revision, not two); every open edge
    /// from another document (and a self edge whose link names the path)
    /// re-points to `phantom:<from>`, the affected rollups are rebuilt,
    /// phantoms at the new path are adopted. Runs **first**, so the retarget
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

/// What a `MovePath` effect minted (store 17.0, D11): the moved document's
/// new head and the hash of its (unchanged) bytes — `head: None` when the
/// document is itself a retarget source of the request, whose `IngestKnown`
/// carries the move, or had no bytes to capture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MoveOutcome {
    pub doc_id: String,
    pub head: Option<String>,
    pub file_hash: Option<Vec<u8>>,
}

/// What one effect produced inside the transaction.
enum EffectOutcome {
    Ingested(Committed),
    Moved(MoveOutcome),
    Nothing,
}

/// What [`Store::commit_effects`] came back with.
#[derive(Debug)]
pub(crate) enum Outcome {
    /// Committed: one [`Committed`] per ingest effect and one
    /// [`MoveOutcome`] per `MovePath` effect, each in effect order.
    Committed {
        ingests: Vec<Committed>,
        moves: Vec<MoveOutcome>,
    },
    /// Rolled back before anything was minted: a file moved under the plan.
    Conflict(DiskConflict),
}

impl Outcome {
    /// The committed ingests, or a plain error for a caller whose effects
    /// carry no disk precondition (nothing it could re-ingest).
    pub(crate) fn committed(self) -> Result<Vec<Committed>> {
        match self {
            Outcome::Committed { ingests, .. } => Ok(ingests),
            Outcome::Conflict(c) => Err(crate::error::Error::Other(format!(
                "commit_effects: unexpected disk conflict at {}",
                c.path
            ))),
        }
    }
}

impl Store {
    /// Commit `effects` in order under one feed row (`head`, stamped `ts`;
    /// the recorder's `commits` row under the same id) in one `BEGIN
    /// IMMEDIATE` transaction: BEGIN, re-validate every effect's precondition
    /// through the transaction, step 5 once, every effect against the
    /// transaction — each writing its feed entry — COMMIT. A precondition the database
    /// no longer meets fails `stale_plan` / `path_taken` / `doc_missing`
    /// (`spec/mutate` §8) and a file that moved returns
    /// [`Outcome::Conflict`] — in both cases the transaction rolls back
    /// before any id is minted. An error anywhere else rolls the whole
    /// request back — files the caller wrote before this are then ahead of
    /// the database until the next observation heals them (`spec/mutate`
    /// §10). Mints `c` first, then per document `r`, `x`, `e` (and `d` for
    /// a new path; a `MovePath` mints its `r` first, 17.0 D11). No effects,
    /// no row: a request that touched no document
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
            return Ok((
                Outcome::Committed {
                    ingests: Vec::new(),
                    moves: Vec::new(),
                },
                None,
            ));
        }
        let expires = pool_expiry(ts)?;
        let Store {
            conn, ids, history, ..
        } = self;
        // `spec/store` §5.4 step 0 (17.0, 3e-ii — resolution 17): a writer
        // without the recorder refuses on a repository whose manifest
        // requires capture.
        require_writer(conn, history.is_some(), repo_id, ts)?;
        let history = require_history(history.as_deref())?;
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
            let commit = append_feed_row(
                &tx,
                &mut mint,
                Some(history),
                &NewFeedRow {
                    repo_id,
                    ts,
                    origin: head.origin,
                    actor: head.actor,
                    reason: head.reason,
                    batch_id: None,
                    plan_id: head.plan_id,
                    ops: head.ops,
                },
            )?;
            // A moved document that the SAME request also rewrites (a
            // self-linking retarget source): its `IngestKnown` mints the head
            // at the new path, so the move itself mints none (D11).
            let rewritten_later: HashSet<&str> = effects
                .iter()
                .filter_map(|e| match e {
                    Effect::IngestKnown { doc_id, .. } => Some(doc_id.as_str()),
                    _ => None,
                })
                .collect();
            let mut outcomes = Vec::with_capacity(effects.len());
            for effect in effects {
                let mints_head = match effect {
                    Effect::MovePath { doc_id, .. } => !rewritten_later.contains(doc_id.as_str()),
                    _ => false,
                };
                outcomes.push(run_effect(
                    &tx, &mut mint, history, repo_id, head, effect, ts, &expires, &commit,
                    mints_head,
                )?);
            }
            // 14.0: the files this request owes the working tree, recorded
            // before COMMIT so a crash loses nothing (`spec/store` §5.7).
            if head.origin == Origin::Api {
                record_intent(&tx, repo_id, effects, &outcomes, &commit.commit_id, ts)?;
            }
            if head.clear_pending {
                for path in touched_paths(effects) {
                    delete_pending(&tx, repo_id, &path)?;
                }
            }
            let mut ingests = Vec::new();
            let mut moves = Vec::new();
            for o in outcomes {
                match o {
                    EffectOutcome::Ingested(c) => ingests.push(c),
                    EffectOutcome::Moved(m) => moves.push(m),
                    EffectOutcome::Nothing => {}
                }
            }
            ((ingests, moves), commit.commit_id)
        };
        tx.commit()?;
        let (ingests, moves) = committed;
        Ok((Outcome::Committed { ingests, moves }, Some(commit_id)))
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

/// The document's `(head, bytes hash)` after the effects ran: the row's
/// `file_hash` (what its head renders to, I1 — the ingest's `sha256(source)`,
/// a move's unchanged bytes), else the hash of what it reconstructs to (a
/// row no observation has hashed yet). Since 17.0 nothing here reads a
/// revision: `docs.file_hash` holds the value.
fn current_bytes_hash(tx: &Connection, doc_id: &str) -> Result<Option<(Option<String>, Vec<u8>)>> {
    let row: Option<(Option<String>, Option<Vec<u8>>)> = tx
        .query_row(
            "SELECT head, file_hash FROM docs WHERE doc_id = ?1",
            params![doc_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((head, file_hash)) = row else {
        return Ok(None);
    };
    let hash = match file_hash {
        Some(h) => h,
        None => match crate::read::reconstruct(tx, doc_id)? {
            Some(bytes) => sha256(bytes.as_bytes()).to_vec(),
            None => return Ok(None),
        },
    };
    Ok(Some((head, hash)))
}

/// One `pending_materializations` row per path the request must write,
/// rename or remove, in effect order, each carrying what its replay needs
/// (17.0, M4 — `spec/store` §5.7): a `write` per ingested document (the head
/// just minted, `rendered_hash = sha256(source)` — the row's `file_hash` —
/// and `prior_hash` = the `file_hash` the transaction validated the file
/// against, `None` for a created document: the engine never wrote there), a
/// `rename` for a moved document (the move's new head and its unchanged
/// `file_hash` as both target and prior — the bytes the engine last wrote at
/// `from`), a `remove` for a tombstoned one (the bytes its head rendered, so
/// a foreign file is never unlinked; no head, no prior). One row per path,
/// keyed by where the file must end up, in the order the paths were first
/// owed (the reference's `Map`): a later `write` at a path already owed
/// applies [`supersede`] — so the self-linking source of a `docs_move`
/// renders its rewrite's bytes under the move's `rename` row, which keeps
/// the rename's `from_path` and prior; a `rename` whose `from_path` still
/// owes a `write`/`rename` (this request's or an earlier request's row in
/// the table) carries its obligation — the rename's prior is that row's and
/// the row goes, in this transaction. The same rule is applied again against
/// the table's row at each path when the rows are inserted
/// ([`insert_pending`]).
fn record_intent(
    tx: &Connection,
    repo_id: &str,
    effects: &[Effect],
    outcomes: &[EffectOutcome],
    commit_id: &str,
    ts: &str,
) -> Result<()> {
    let mut pending: Vec<PendingRow> = Vec::new();
    fn set(pending: &mut Vec<PendingRow>, row: PendingRow) {
        match pending.iter_mut().find(|r| r.path == row.path) {
            Some(slot) => *slot = row,
            None => pending.push(row),
        }
    }
    let record_write = |pending: &mut Vec<PendingRow>,
                        path: &str,
                        c: &Committed,
                        prior: Option<Vec<u8>>|
     -> Result<()> {
        let rendered_hash: Vec<u8> = current_bytes_hash(tx, &c.doc_id)?
            .map(|(_, h)| h)
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let incoming = PendingRow {
            path: path.to_owned(),
            kind: PendingKind::Write,
            from_path: None,
            doc_id: c.doc_id.clone(),
            head: Some(c.rev_id.clone()),
            rendered_hash,
            prior_hash: prior,
            commit_id: commit_id.to_owned(),
            created_at: ts.to_owned(),
        };
        let row = supersede(pending.iter().find(|r| r.path == path), incoming);
        set(pending, row);
        Ok(())
    };
    for (effect, outcome) in effects.iter().zip(outcomes) {
        match (effect, outcome) {
            (Effect::IngestKnown { path, guard, .. }, EffectOutcome::Ingested(c)) => {
                let prior = match guard {
                    Guard::Doc { base, .. } => base.file_hash.clone(),
                    _ => None,
                };
                record_write(&mut pending, path, c, prior)?;
            }
            (Effect::IngestReconciled { prepared, guard }, EffectOutcome::Ingested(c)) => {
                let prior = match guard {
                    Guard::Doc { base, .. } => base.file_hash.clone(),
                    _ => None,
                };
                record_write(&mut pending, &prepared.path, c, prior)?;
            }
            (
                Effect::MovePath {
                    doc_id,
                    from,
                    to,
                    current_rev,
                    ..
                },
                EffectOutcome::Moved(moved),
            ) => {
                // A `write`/`rename` row still owed at `from` (this request's,
                // or an earlier request's unfinished file half) is superseded
                // by this rename, which carries its obligation: the bytes the
                // engine must still recognise at `from` are that row's
                // `prior_hash`, and the row goes (§5.7 "Supersession").
                let owed_at_from = match pending.iter().find(|r| r.path == *from) {
                    Some(row) => Some(row.clone()),
                    None => pending_at(tx, repo_id, from)?,
                };
                // The bytes expected at `to`: the moved document's current
                // bytes — `docs.file_hash` (I1) — under its new head (a
                // self-linking source's retarget replaces both with its own
                // through `supersede`). The prior at `from` is the same hash —
                // what the engine last wrote there — unless a pending row says
                // the disk never caught up with it.
                let current: Vec<u8> = match &moved.file_hash {
                    Some(h) => h.clone(),
                    None => match current_bytes_hash(tx, doc_id)? {
                        Some((_, h)) => h,
                        None => continue,
                    },
                };
                let mut prior = Some(current.clone());
                if let Some(owed) = owed_at_from
                    && owed.kind != PendingKind::Remove
                {
                    prior = owed.prior_hash;
                    pending.retain(|r| r.path != *from);
                    delete_pending(tx, repo_id, from)?;
                }
                set(
                    &mut pending,
                    PendingRow {
                        path: to.clone(),
                        kind: PendingKind::Rename,
                        from_path: Some(from.clone()),
                        doc_id: doc_id.clone(),
                        head: moved.head.clone().or_else(|| current_rev.clone()),
                        rendered_hash: current,
                        prior_hash: prior,
                        commit_id: commit_id.to_owned(),
                        created_at: ts.to_owned(),
                    },
                );
            }
            (
                Effect::Tombstone {
                    doc_id, path, pool, ..
                },
                _,
            ) => {
                if *pool {
                    continue; // an observed deletion owes the tree nothing
                }
                // A remove drops whatever the path owed (§5.7 "Supersession"):
                // no prior, no head; `rendered_hash` the bytes the deleted
                // document rendered (`docs.file_hash` before the tombstone, or
                // the observed bytes when it never had a head).
                let rendered_hash = current_bytes_hash(tx, doc_id)?
                    .map_or_else(|| sha256(b"").to_vec(), |(_, h)| h);
                set(
                    &mut pending,
                    PendingRow {
                        path: path.clone(),
                        kind: PendingKind::Remove,
                        from_path: None,
                        doc_id: doc_id.clone(),
                        head: None,
                        rendered_hash,
                        prior_hash: None,
                        commit_id: commit_id.to_owned(),
                        created_at: ts.to_owned(),
                    },
                );
            }
            _ => {}
        }
    }
    for row in &pending {
        insert_pending(tx, repo_id, row)?;
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
                "_hash": current.and_then(|c| c.file_hash.as_deref().map(hex)),
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
            "SELECT 1 FROM docs WHERE repo_id = ?1 AND path = ?2 AND deleted_at IS NULL",
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
    if let (Some(bytes), Some(hash)) = (on_disk, &current.file_hash)
        && sha256(bytes.as_bytes())[..] != hash[..]
    {
        return Ok(Some(DiskConflict {
            path: base.path.clone(),
            bytes: bytes.to_owned(),
        }));
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

#[allow(clippy::too_many_arguments)]
fn run_effect(
    tx: &Connection,
    mint: &mut Mint<'_>,
    history: &dyn HistoryRecorder,
    repo_id: &str,
    head: &CommitHead<'_>,
    effect: &Effect,
    ts: &str,
    expires: &str,
    commit: &FeedRow,
    mints_head: bool,
) -> Result<EffectOutcome> {
    match effect {
        Effect::IngestKnown {
            doc_id,
            path,
            rendered,
            by_key,
            prior_ids,
            guard,
        } => {
            let tree = parse_path(path, rendered);
            // The live rows the carries are classified against (`spec/mutate`
            // §4 step 5(b), store 14.2) — read inside the transaction, after
            // every earlier effect; none for a created document (no row yet,
            // and its `doc_id` is a `$new` symbol).
            let prior = if prior_ids.is_empty() {
                std::collections::HashMap::new()
            } else {
                crate::mutate::prior_rows(tx, doc_id)?
            };
            let plan = known_plan(
                &tree,
                path,
                rendered,
                by_key,
                prior_ids,
                &prior,
                mint,
                head.origin,
                head.actor,
                head.reason,
            )?;
            // A document loaded under another path (the moved document of a
            // `docs_move` that this request also rewrites) gets a `moved`
            // feed entry (D11).
            let moved_from = match guard {
                Guard::Doc { base, .. } if base.path != *path => Some(base.path.as_str()),
                _ => None,
            };
            Ok(EffectOutcome::Ingested(ingest_in(
                tx, mint, history, repo_id, &plan, ts, expires, commit, moved_from,
            )?))
        }
        Effect::IngestReconciled { prepared, .. } => {
            let plan = prepared.plan(mint, head.origin, head.actor, head.reason, None)?;
            Ok(EffectOutcome::Ingested(ingest_in(
                tx, mint, history, repo_id, &plan, ts, expires, commit, None,
            )?))
        }
        Effect::MovePath {
            doc_id,
            from,
            to,
            inbound,
            ..
        } => Ok(EffectOutcome::Moved(move_path_in(
            tx, mint, history, doc_id, from, to, inbound, ts, commit, mints_head,
        )?)),
        Effect::Tombstone { doc_id, pool, .. } => {
            tombstone_in(tx, repo_id, commit, doc_id, ts, pool.then_some(expires))?;
            Ok(EffectOutcome::Nothing)
        }
    }
}

/// The document's live body tree as the recorder's input ([`TreeInputBlock`]
/// pre-order by `parent_block` + `ordinal`), read from the current rows — the
/// unchanged tree a `docs_move` hands the recorder (store 17.0, D11). A row
/// whose parent is not live counts as top level. `text`/`span` are not
/// stored and not needed by the tree encoding; they are left empty.
pub(crate) fn current_tree_input(conn: &Connection, doc_id: &str) -> Result<Vec<TreeInputBlock>> {
    struct Row {
        block_id: String,
        parent_block: Option<String>,
        kind: String,
        attrs: String,
        raw: String,
        trivia: Option<String>,
    }
    let rows: Vec<Row> = {
        let mut stmt = conn.prepare(
            "SELECT block_id, parent_block, type, attrs, raw, trivia FROM blocks
             WHERE doc_id = ?1 AND deleted_at IS NULL ORDER BY ordinal, block_id",
        )?;
        let it = stmt.query_map(params![doc_id], |r| {
            Ok(Row {
                block_id: r.get(0)?,
                parent_block: r.get(1)?,
                kind: r.get(2)?,
                attrs: r.get(3)?,
                raw: r.get(4)?,
                trivia: r.get(5)?,
            })
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let ids: HashSet<&str> = rows.iter().map(|r| r.block_id.as_str()).collect();
    let mut by_parent: std::collections::HashMap<Option<&str>, Vec<&Row>> =
        std::collections::HashMap::new();
    for r in &rows {
        let parent = r.parent_block.as_deref().filter(|p| ids.contains(p));
        by_parent.entry(parent).or_default().push(r);
    }
    fn build(
        parent: Option<&str>,
        by_parent: &std::collections::HashMap<Option<&str>, Vec<&Row>>,
    ) -> Vec<TreeInputBlock> {
        by_parent
            .get(&parent)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|r| TreeInputBlock {
                block_id: r.block_id.clone(),
                kind: r.kind.clone(),
                raw: r.raw.clone(),
                text: String::new(),
                trivia: r.trivia.clone().unwrap_or_default(),
                attrs: attrs_from_json(&r.attrs),
                span: omgbase_format::Span { start: 0, end: 0 },
                children: build(Some(&r.block_id), by_parent),
            })
            .collect()
    }
    Ok(build(None, &by_parent))
}

/// [`Effect::MovePath`]'s statements (the reference's `movePath` write
/// block; `spec/mutate` §6, store 17.0 §5.4 step 6, D11): the document
/// row's path and — a move is a TRANSITION — a new head token with
/// `updated_at = ts`, handed to the recorder as a revision of the unchanged
/// tree at the new path (`revisions.path` is immutable from 17.0; through
/// 16.x the current revision's path was rewritten in place) and its `moved`
/// feed entry (`spec/store` §5.4 step 5; D11: `from_path` the old path, the
/// new head, the unchanged bytes). `mints_head` is false for a self-linking
/// source whose own `IngestKnown` follows in the request: that ingest mints
/// the head, writes the entry and carries the new path, so the document gets
/// one revision, not two. Then the edge index: the re-point to the old path's
/// phantom, the affected rollups, phantom adoption at the new path.
#[allow(clippy::too_many_arguments)]
fn move_path_in(
    tx: &Connection,
    mint: &mut Mint<'_>,
    history: &dyn HistoryRecorder,
    doc_id: &str,
    from: &str,
    to: &str,
    inbound: &[InboundLink],
    ts: &str,
    commit: &FeedRow,
    mints_head: bool,
) -> Result<MoveOutcome> {
    let doc: Option<(String, Option<Vec<u8>>, Option<String>)> = tx
        .query_row(
            "SELECT repo_id, file_hash, frontmatter_raw FROM docs WHERE doc_id = ?1",
            params![doc_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (repo_id, file_hash, frontmatter_raw) = doc.unwrap_or((String::new(), None, None));
    let mut head: Option<String> = None;
    match (&file_hash, mints_head) {
        (Some(hash), true) => {
            let minted = mint.mint("r")?;
            // §2.1 (17.0): the head's claim, with the row that carries it.
            mint.claim("r", &minted, Some(&repo_id), ts)?;
            tx.execute(
                "UPDATE docs SET path = ?1, head = ?2, updated_at = ?3 WHERE doc_id = ?4",
                params![to, minted, ts, doc_id],
            )?;
            append_feed_entry(
                tx,
                &NewFeedEntry {
                    repo_id: &repo_id,
                    epoch: &commit.epoch,
                    seq: commit.seq,
                    doc_id,
                    path: to,
                    head: Some(&minted),
                    hash: Some(&hash[..]),
                    kind: FeedEntryKind::Moved,
                    from_path: Some(from),
                },
            )?;
            let body = current_tree_input(tx, doc_id)?;
            let mut rendered_hash = [0u8; 32];
            if hash.len() == 32 {
                rendered_hash.copy_from_slice(hash);
            } else {
                return Err(crate::error::Error::Other(format!(
                    "move_path: docs.file_hash of {doc_id} is not a 32-byte hash"
                )));
            }
            history.record_revision(
                tx,
                &RevisionTransition {
                    doc_id,
                    head: &minted,
                    path: to,
                    frontmatter_raw: frontmatter_raw.as_deref(),
                    body: &body,
                    rendered_hash,
                    commit_id: &commit.commit_id,
                },
            )?;
            head = Some(minted);
        }
        _ => {
            tx.execute(
                "UPDATE docs SET path = ?1 WHERE doc_id = ?2",
                params![to, doc_id],
            )?;
        }
    }
    // The re-phantoming (spec/graph §3.5 in reverse; M6): the open edges of
    // OTHER documents that pointed at this one re-point to the old path's
    // phantom in place — the rows keep their ids, the recorder's open
    // transitions follow — and so does a self-link's edge the inbound list
    // names; the affected rollups are rebuilt; links already written against
    // the NEW path adopt this document.
    let phantom = format!("phantom:{from}");
    let mut affected: Vec<String> = retarget_open_edges(
        tx,
        history,
        doc_id,
        &phantom,
        "AND src_doc != ?",
        &[&doc_id],
    )?;
    for l in inbound {
        let Some(block) = &l.block else {
            continue;
        };
        if l.doc != doc_id {
            continue;
        }
        for src in retarget_open_edges(
            tx,
            history,
            doc_id,
            &phantom,
            "AND src_doc = ? AND src_block = ? AND anchor IS ?",
            &[&doc_id, block, &l.anchor],
        )? {
            if !affected.contains(&src) {
                affected.push(src);
            }
        }
    }
    for d in &affected {
        rebuild_doc_edges(tx, d)?;
    }
    adopt_phantoms(tx, history, to, doc_id)?;
    Ok(MoveOutcome {
        doc_id: doc_id.to_owned(),
        head,
        file_hash,
    })
}
