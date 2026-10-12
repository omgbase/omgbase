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

use omgbase_format::parse_markdown;
use rusqlite::{Connection, Transaction, TransactionBehavior, params};

use crate::Store;
use crate::error::Result;
use crate::graph::{adopt_phantoms, rebuild_doc_edges};
use crate::links::InboundLink;
use crate::mint::Mint;
use crate::mutate::known_plan;
use crate::observe::{Committed, Prepared, ingest_in, tombstone_in};
use crate::time::pool_expiry;
use crate::writers::{NewCommit, Origin, new_commit};

/// The commit row a request records (`spec/store` §5.4 step 5): `ops` stays
/// `NULL` until the planner step populates ADR-003's intent record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CommitHead<'a> {
    pub origin: Origin,
    pub actor: Option<&'a str>,
    pub reason: Option<&'a str>,
}

/// One step of a request's commit, run in order under the shared row.
pub(crate) enum Effect {
    /// `spec/store` §5.4 steps 1–4, 6–13 with the **known-id** resolver
    /// (`spec/mutate` §4 step 5): the rendered bytes of a working tree whose
    /// ids are known by position. `path` is the row the ingest finds or
    /// creates — a document moved in the same request names its **new**
    /// path here even though it was loaded under the old one.
    IngestKnown {
        doc_id: String,
        path: String,
        rendered: String,
        /// Positional key (`"/i/j"`) → block id of the working tree.
        by_key: std::collections::BTreeMap<String, String>,
        /// The live ids before any op (labels the `api` dispositions).
        prior_ids: Vec<String>,
    },
    /// The same steps with the **reconciling** resolver, the member already
    /// parsed and matched outside the transaction (`docs_create`,
    /// `docs_set_meta`, the sync layer's recovery).
    IngestReconciled { prepared: Prepared },
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
    /// deletion) or not (`docs_delete`).
    Tombstone { doc_id: String, pool: bool },
}

impl std::fmt::Debug for Effect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Effect::IngestKnown { doc_id, path, .. } => f
                .debug_struct("IngestKnown")
                .field("doc_id", doc_id)
                .field("path", path)
                .finish_non_exhaustive(),
            Effect::IngestReconciled { prepared } => f
                .debug_struct("IngestReconciled")
                .field("path", &prepared.path)
                .finish_non_exhaustive(),
            Effect::MovePath {
                doc_id, from, to, ..
            } => f
                .debug_struct("MovePath")
                .field("doc_id", doc_id)
                .field("from", from)
                .field("to", to)
                .finish_non_exhaustive(),
            Effect::Tombstone { doc_id, pool } => f
                .debug_struct("Tombstone")
                .field("doc_id", doc_id)
                .field("pool", pool)
                .finish(),
        }
    }
}

impl Store {
    /// Commit `effects` in order under one `commits` row (`head`, stamped
    /// `ts`) in one transaction: BEGIN, step 5 once, every effect against
    /// the transaction, COMMIT. An error anywhere rolls the whole request
    /// back — files the caller wrote before this are then ahead of the
    /// database until the next observation heals them (`spec/mutate` §10).
    /// Returns one [`Committed`] per ingest effect, in order. Mints `c`
    /// first, then per document `r`, `x`, `e` (and `d` for a new path). No
    /// effects, no row: a request that touched no document — a macro that
    /// expanded to nothing, a `links_repair` with no hit — records nothing
    /// (`spec/mutate` `macros::sections-move-unknown-heading`).
    pub(crate) fn commit_effects(
        &mut self,
        repo_id: &str,
        head: &CommitHead<'_>,
        effects: &[Effect],
        ts: &str,
    ) -> Result<Vec<Committed>> {
        if effects.is_empty() {
            return Ok(Vec::new());
        }
        let expires = pool_expiry(ts)?;
        let Store { conn, ids } = self;
        let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;
        let committed = {
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
                    ops: None,
                },
            )?;
            let mut committed = Vec::new();
            for effect in effects {
                if let Some(c) =
                    run_effect(&tx, &mut mint, repo_id, head, effect, &expires, &commit_id)?
                {
                    committed.push(c);
                }
            }
            committed
        };
        tx.commit()?;
        Ok(committed)
    }
}

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
        Effect::IngestReconciled { prepared } => {
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
        Effect::Tombstone { doc_id, pool } => {
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
