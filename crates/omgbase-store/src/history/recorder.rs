//! The default [`HistoryRecorder`]: today's history code behind the trait.
//! Every method is the call it replaced — the writers of `history::writers`,
//! the reads of `history::read`, the mark-and-sweep of `history::gc`, the
//! retention and archive entry points — so Phase 1 changes no row and no
//! byte. Since 17.0 (3d) the commit row is the feed row's twin
//! ([`HistoryRecorder::record_commit`]) and the change feed is the core's.

use std::collections::HashSet;
use std::path::Path;

use omgbase_format::hash::hex;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value as Json;

use crate::core::capabilities::{
    DispositionRow, GcResult, HistoryRecorder, HistorySizeFigures, RecordedRevision,
    RevisionQueryRow, RevisionRead, RevisionTransition,
};
use crate::core::claims;
use crate::core::graph::EdgeTransitions;
use crate::core::history_shapes::{
    ArchiveListing, AttachResult, ExportOptions, ExportResult, RetentionOptions, RetentionPlan,
    RetentionPolicy,
};
use crate::core::mint::Mint;
use crate::core::observe::persists_disposition;
use crate::core::size::{SizeArchived, SizeRetention};
use crate::core::writers::CommitRecord;
use crate::error::Result;
use crate::history::delta::TreeResolver;
use crate::history::writers::{
    NewRevision, TreeWriteContext, is_checkpoint_revision, previous_revision, record_commit,
    write_block_tree_in, write_frontmatter_blob, write_revision,
};
use crate::history::{archive, gc, read, retention};

/// The `revisions` × `commits` columns the query binding reads
/// (`spec/surface` §1.1/§1.2): `is_current` is `docs_history`'s `isCurrent`
/// (the revision is its document's `head`); the `revisions` table carries no
/// `repo_id`, so the repository guard joins `docs`.
const REVISION_COLS: &str = "r.rev_id, r.doc_id, r.seq, r.rendered_hash, r.path, r.commit_id, c.ts, c.origin, c.actor, c.reason, (d.head = r.rev_id) AS is_current, (r.archive IS NOT NULL) AS archived";
const REVISION_FROM: &str =
    "revisions r JOIN docs d ON d.doc_id = r.doc_id JOIN commits c ON c.commit_id = r.commit_id";

fn revision_rows_where(
    conn: &Connection,
    where_order: &str,
    param: &str,
) -> Result<Vec<RevisionQueryRow>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {REVISION_COLS} FROM {REVISION_FROM} {where_order}"
    ))?;
    let rows = stmt.query_map(params![param], |r| {
        let is_current: Option<i64> = r.get(10)?;
        let archived: i64 = r.get(11)?;
        Ok(RevisionQueryRow {
            rev_id: r.get(0)?,
            doc_id: r.get(1)?,
            seq: r.get(2)?,
            rendered_hash: r.get(3)?,
            path: r.get(4)?,
            commit_id: r.get(5)?,
            ts: r.get(6)?,
            origin: r.get(7)?,
            actor: r.get(8)?,
            reason: r.get(9)?,
            is_current: is_current == Some(1),
            archived: archived == 1,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// The recorder over the store's own history tables (`revisions`,
/// `tree_nodes`, `blobs`, `commits`, `dispositions`, `block_changes`,
/// `edge_transitions`, `archives`).
#[derive(Clone, Copy, Debug, Default)]
pub struct Recorder;

impl HistoryRecorder for Recorder {
    /// `spec/store` §5.4 step 15 (17.0, 3d): the `commits` row — the log's
    /// copy of the feed row the core appended, under the same id, epoch and
    /// seq, with `ops` (the ADR-003 intent record of an api commit) — and the
    /// recorder's hold on the commit id's claim (§2.1).
    fn record_commit(&self, tx: &Connection, commit: &CommitRecord<'_>) -> Result<()> {
        record_commit(tx, commit)?;
        claims::hold(tx, &[commit.commit_id])
    }

    /// `spec/store` §5.4 step 15 (17.0): 16.0's steps 0, 1, 4 and 6 from
    /// the recorder's OWN state, under the head token the core minted.
    fn record_revision(
        &self,
        tx: &Connection,
        t: &RevisionTransition<'_>,
    ) -> Result<RecordedRevision> {
        // 0. The revision's place (§4.4, 16.0): its seq decides whether it is
        //    a checkpoint; a non-checkpoint revision writes its tree and
        //    frontmatter as deltas against the previous revision's RESOLVED
        //    tree and raw where that is smaller. The previous revision is the
        //    recorder's OWN state (17.0 M1: the core hands the transition and
        //    reads nothing here) — the document's greatest captured seq, on
        //    every path the current revision, never archived (retention rule
        //    1) — but the rule is stated for the general case: no live
        //    predecessor ⇒ a checkpoint.
        let previous = previous_revision(tx, t.doc_id)?;
        let seq = previous.as_ref().map_or(1, |p| p.seq + 1);
        let checkpoint = is_checkpoint_revision(seq, previous.as_ref());
        let mut resolver = TreeResolver::new(tx);
        let base = match &previous {
            Some(p) if !checkpoint => match &p.root_tree {
                Some(root) => Some(resolver.tree(t.doc_id, p.seq, &hex(root))?),
                None => None,
            },
            _ => None,
        };
        let tree_ctx = TreeWriteContext { base, checkpoint };

        // 1. Frontmatter blob: the raw at a checkpoint, else the smaller of a
        //    line delta over the previous revision's frontmatter and the raw.
        let fm_blob_hex = match t.frontmatter_raw {
            Some(raw) => {
                let base_raw = match &previous {
                    Some(p) if !checkpoint => match &p.frontmatter_blob {
                        Some(fm) => Some(resolver.frontmatter(t.doc_id, p.seq, &hex(fm))?),
                        None => None,
                    },
                    _ => None,
                };
                Some(write_frontmatter_blob(
                    tx,
                    raw,
                    base_raw.as_deref(),
                    checkpoint,
                )?)
            }
            None => None,
        };

        // 4. Write the tree.
        let root_tree_hex = write_block_tree_in(tx, t.body, &tree_ctx)?;

        // 6. The revision row under the core's head (the commit row, step 5,
        //    is the caller's).
        let (rev_id, seq) = write_revision(
            tx,
            &NewRevision {
                rev_id: t.head,
                doc_id: t.doc_id,
                root_tree_hex: &root_tree_hex,
                frontmatter_blob_hex: fm_blob_hex.as_deref(),
                rendered_hash: t.rendered_hash,
                path: t.path,
                commit_id: t.commit_id,
                seq: Some(seq),
            },
        )?;
        // §2.1 (17.0): the recorder's hold (bit 1) on every id its
        // `revisions` row names — the head and the document — so the claims
        // prune never releases an id the history still refers to.
        claims::hold(tx, &[t.head, t.doc_id])?;
        Ok(RecordedRevision { rev_id, seq })
    }

    /// §5.4 step 10: `dispositions` and `block_changes` — every verdict but
    /// `same` (14.2). The matcher (and the known-id resolver) still produce
    /// one per untouched block, and the outcome counts them, but the two
    /// tables record what CHANGED: a block's rows are its own history, so
    /// `MAX(commits.ts)` over its `block_changes` and `blocks_history` are the
    /// block's changes, not its siblings'. Every other kind is written, and
    /// the block ids named gain the recorder's hold on their claims (§2.1,
    /// 17.0) — this, not an earliest row the squash keeps, is what keeps an
    /// archived block's id reserved (§7.1 step 2).
    fn record_dispositions(
        &self,
        tx: &Connection,
        commit_id: &str,
        rows: &[DispositionRow],
    ) -> Result<()> {
        let mut ins = tx.prepare(
            "INSERT OR IGNORE INTO dispositions (commit_id, block_id, kind, confidence, reason, matcher_v, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        let mut bc = tx.prepare(
            "INSERT OR IGNORE INTO block_changes (block_id, commit_id, kind) VALUES (?1, ?2, ?3)",
        )?;
        // §2.1 (17.0): the recorder's hold (bit 1) on every block id a
        // `block_changes` row now names, each once, in first-seen order.
        let mut held: Vec<&str> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        for d in rows.iter().filter(|d| persists_disposition(&d.kind)) {
            ins.execute(params![
                commit_id,
                d.block_id,
                d.kind,
                d.confidence,
                d.reason,
                d.matcher_v,
                d.detail,
            ])?;
            bc.execute(params![d.block_id, commit_id, d.kind])?;
            if d.block_id != "DOC" && seen.insert(d.block_id.as_str()) {
                held.push(&d.block_id);
            }
        }
        claims::hold(tx, &held)?;
        Ok(())
    }

    /// `spec/graph` §3.3 (17.0, M6): the interval record. One
    /// `edge_transitions` row per opened edge — 16.x's `edges` row verbatim,
    /// `from_commit` this commit, `to_commit` NULL — and `to_commit = this
    /// commit` on every row the core deleted; the opened ids gain the
    /// recorder's hold (§2.1).
    fn record_edge_transitions(
        &self,
        tx: &Connection,
        commit_id: &str,
        t: &EdgeTransitions,
    ) -> Result<()> {
        let mut open = tx.prepare_cached(
            "INSERT OR REPLACE INTO edge_transitions (edge_id, repo_id, src_doc, src_block, src_field, predicate, dst_kind, dst_node, anchor, provenance, via_node, from_commit, to_commit)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL)",
        )?;
        for e in &t.opened {
            open.execute(params![
                e.edge_id,
                e.repo_id,
                e.src_doc,
                e.src_block,
                e.src_field,
                e.predicate,
                e.dst_kind,
                e.dst_node,
                e.anchor,
                e.provenance,
                e.via_node,
                commit_id,
            ])?;
        }
        let mut close = tx.prepare_cached(
            "UPDATE edge_transitions SET to_commit = ?1 WHERE edge_id = ?2 AND to_commit IS NULL",
        )?;
        for id in &t.closed {
            close.execute(params![commit_id, id])?;
        }
        let held: Vec<&str> = t.opened.iter().map(|e| e.edge_id.as_str()).collect();
        claims::hold(tx, &held)
    }

    fn retarget_edges(&self, tx: &Connection, edge_ids: &[&str], dst_node: &str) -> Result<()> {
        if edge_ids.is_empty() {
            return Ok(());
        }
        let mut stmt = tx.prepare_cached(
            "UPDATE edge_transitions SET dst_node = ?1 WHERE edge_id = ?2 AND to_commit IS NULL",
        )?;
        for id in edge_ids {
            stmt.execute(params![dst_node, id])?;
        }
        Ok(())
    }

    fn read_at_revision(
        &self,
        conn: &Connection,
        doc_id: &str,
        rev_id: &str,
    ) -> Result<Option<RevisionRead>> {
        read::read_at_revision(conn, doc_id, rev_id)
    }

    /// A captured revision's frontmatter raw (§6.2 "Resolving", 16.0): the
    /// blob the row names, resolved when it is a `{"f":…}` delta over the
    /// previous revision's ([`TreeResolver::frontmatter`], at most 15 steps
    /// back). `None` when the revision has no frontmatter (or is not a
    /// revision). Through 16.x this was the CURRENT frontmatter read
    /// (`core::read::current_frontmatter_raw`); since 17.0 the head carries
    /// its own and only migration 17 resolves through here.
    fn frontmatter_at_revision(&self, conn: &Connection, rev_id: &str) -> Result<Option<String>> {
        let row: Option<(String, i64, Option<Vec<u8>>)> = conn
            .query_row(
                "SELECT doc_id, seq, frontmatter_blob FROM revisions WHERE rev_id = ?1",
                params![rev_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((doc_id, seq, Some(fm))) = row else {
            return Ok(None);
        };
        Ok(Some(TreeResolver::new(conn).frontmatter(
            &doc_id,
            seq,
            &hex(&fm),
        )?))
    }

    /// The disposition counts of a captured commit (`kind → n`, `same`
    /// never persisted), `None` when the recorder has no `commits` row for it.
    fn disposition_counts(
        &self,
        conn: &Connection,
        commit_id: &str,
    ) -> Result<Option<Vec<(String, i64)>>> {
        let known = conn
            .query_row(
                "SELECT 1 FROM commits WHERE commit_id = ?1",
                params![commit_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !known {
            return Ok(None);
        }
        let mut stmt = conn.prepare_cached(
            "SELECT kind, count(*) FROM dispositions WHERE commit_id = ?1 GROUP BY kind ORDER BY kind",
        )?;
        let rows = stmt.query_map(params![commit_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(Some(rows.collect::<std::result::Result<Vec<_>, _>>()?))
    }

    fn revision_rows(&self, conn: &Connection, repo_id: &str) -> Result<Vec<RevisionQueryRow>> {
        revision_rows_where(
            conn,
            "WHERE d.repo_id = ?1 ORDER BY r.path, r.rev_id",
            repo_id,
        )
    }

    fn doc_revision_rows(&self, conn: &Connection, doc_id: &str) -> Result<Vec<RevisionQueryRow>> {
        revision_rows_where(conn, "WHERE r.doc_id = ?1 ORDER BY r.seq", doc_id)
    }

    fn has_revision(&self, conn: &Connection, rev_id: &str) -> Result<bool> {
        Ok(conn
            .query_row(
                "SELECT 1 FROM revisions WHERE rev_id = ?1",
                params![rev_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    fn uncaptured_heads(&self, conn: &Connection, repo_id: &str, since: &str) -> Result<i64> {
        Ok(conn.query_row(
            "SELECT count(*) FROM docs d WHERE d.repo_id = ?1 AND d.deleted_at IS NULL AND d.head IS NOT NULL AND d.updated_at >= ?2 AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.rev_id = d.head)",
            params![repo_id, since],
            |r| r.get(0),
        )?)
    }

    /// `spec/store` §5.9 (Phase 4a; `phase-1-contracts.md` §1.14): the
    /// baseline `history enable` writes under the feed row the core appended.
    /// The `commits` row; then, per live document whose head has no
    /// `revisions` row (one changed while capture was off, or never
    /// captured), a CHECKPOINT revision under the existing head — the current
    /// tree and frontmatter raw from the rows, `seq` = 1 + the document's
    /// greatest captured seq — so `docs_read { at: head }` reads through the
    /// recorder and H1/H3 hold for every live document; the recorder's hold
    /// on every live doc, head and block id (I7's rule: a live block has a
    /// `block_changes` row or a hold); and the edge interval record
    /// reconciled with the open edges (H6): every open transition whose edge
    /// is gone is closed at this commit, every open edge without a transition
    /// is opened at it, a dangling open transition whose `dst` was rewritten
    /// while capture was off follows the edge. No dispositions (nothing was
    /// reconciled).
    fn baseline(&self, tx: &Connection, commit: &CommitRecord<'_>) -> Result<usize> {
        self.record_commit(tx, commit)?;
        type Live = (String, String, String, Vec<u8>, Option<String>);
        let live: Vec<Live> = {
            let mut stmt = tx.prepare(
                "SELECT doc_id, head, path, file_hash, frontmatter_raw FROM docs WHERE repo_id = ?1 AND deleted_at IS NULL AND head IS NOT NULL ORDER BY rowid",
            )?;
            let rows = stmt.query_map(params![commit.repo_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        let mut revisions = 0usize;
        let mut held: Vec<String> = Vec::new();
        for (doc_id, head, path, file_hash, frontmatter_raw) in &live {
            held.push(doc_id.clone());
            held.push(head.clone());
            let mut blocks = tx.prepare_cached(
                "SELECT block_id FROM blocks WHERE doc_id = ?1 AND deleted_at IS NULL",
            )?;
            for b in blocks.query_map(params![doc_id], |r| r.get::<_, String>(0))? {
                held.push(b?);
            }
            if self.has_revision(tx, head)? {
                continue;
            }
            let previous = previous_revision(tx, doc_id)?;
            let seq = previous.as_ref().map_or(1, |p| p.seq + 1);
            let body = crate::core::effects::current_tree_input(tx, doc_id)?;
            let root_tree_hex = write_block_tree_in(tx, &body, &TreeWriteContext::checkpoint())?;
            let fm_blob_hex = match frontmatter_raw {
                Some(raw) => Some(write_frontmatter_blob(tx, raw, None, true)?),
                None => None,
            };
            let mut rendered_hash = [0u8; 32];
            if file_hash.len() == 32 {
                rendered_hash.copy_from_slice(file_hash);
            } else {
                return Err(crate::error::Error::Other(format!(
                    "baseline: docs.file_hash of {doc_id} is not a 32-byte hash"
                )));
            }
            write_revision(
                tx,
                &NewRevision {
                    rev_id: head,
                    doc_id,
                    root_tree_hex: &root_tree_hex,
                    frontmatter_blob_hex: fm_blob_hex.as_deref(),
                    rendered_hash,
                    path,
                    commit_id: commit.commit_id,
                    seq: Some(seq),
                },
            )?;
            revisions += 1;
        }
        let held_refs: Vec<&str> = held.iter().map(String::as_str).collect();
        claims::hold(tx, &held_refs)?;
        // The edge record (`spec/graph` §3.3; H6): close what is gone, open
        // what is missing.
        tx.execute(
            "UPDATE edge_transitions SET to_commit = ?1 WHERE repo_id = ?2 AND to_commit IS NULL AND edge_id NOT IN (SELECT edge_id FROM edges)",
            params![commit.commit_id, commit.repo_id],
        )?;
        type Missing = (
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            String,
            String,
            String,
            Option<String>,
            String,
            Option<String>,
        );
        let missing: Vec<Missing> = {
            let mut stmt = tx.prepare(
                "SELECT edge_id, repo_id, src_doc, src_block, src_field, predicate, dst_kind, dst_node, anchor, provenance, via_node FROM edges e
                 WHERE e.repo_id = ?1 AND NOT EXISTS (SELECT 1 FROM edge_transitions t WHERE t.edge_id = e.edge_id AND t.to_commit IS NULL) ORDER BY rowid",
            )?;
            let rows = stmt.query_map(params![commit.repo_id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                ))
            })?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        {
            let mut open = tx.prepare_cached(
                "INSERT OR REPLACE INTO edge_transitions (edge_id, repo_id, src_doc, src_block, src_field, predicate, dst_kind, dst_node, anchor, provenance, via_node, from_commit, to_commit)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL)",
            )?;
            for e in &missing {
                open.execute(params![
                    e.0,
                    e.1,
                    e.2,
                    e.3,
                    e.4,
                    e.5,
                    e.6,
                    e.7,
                    e.8,
                    e.9,
                    e.10,
                    commit.commit_id,
                ])?;
            }
        }
        let opened: Vec<&str> = missing.iter().map(|e| e.0.as_str()).collect();
        claims::hold(tx, &opened)?;
        // A dangling open transition whose dst was rewritten while capture
        // was off follows the edge now.
        tx.execute(
            "UPDATE edge_transitions SET dst_node = (SELECT e.dst_node FROM edges e WHERE e.edge_id = edge_transitions.edge_id)
             WHERE repo_id = ?1 AND to_commit IS NULL AND dst_node != (SELECT e.dst_node FROM edges e WHERE e.edge_id = edge_transitions.edge_id)",
            params![commit.repo_id],
        )?;
        Ok(revisions)
    }

    fn rebuild_projection(&self, tx: &Connection) -> Result<()> {
        gc::rebuild_block_changes(tx)
    }

    fn gc(&self, tx: &Connection) -> Result<GcResult> {
        gc::run_gc_in(tx)
    }

    fn gc_dry_run(&self, conn: &Connection) -> Result<GcResult> {
        gc::gc_dry_run(conn)
    }

    fn count_same_dispositions(&self, conn: &Connection) -> Result<usize> {
        gc::count_same_dispositions(conn)
    }

    /// The size report's history figures (`spec/store` §7 "Size"): the `same`
    /// rows (14.2), the archived summary and every repository's retention plan
    /// under its effective policy, summed at one clock (15.0).
    fn size_figures(&self, conn: &Connection, now: &str) -> Result<HistorySizeFigures> {
        let same_dispositions = {
            let n: i64 = conn.query_row(
                "SELECT count(*) FROM dispositions WHERE kind = 'same'",
                [],
                |r| r.get(0),
            )?;
            u64::try_from(n).unwrap_or(0)
        };
        let (archived_revisions, segments, archived_bytes) = archive::archived_summary(conn)?;
        let archived = SizeArchived {
            revisions: archived_revisions,
            segments,
            bytes: archived_bytes,
        };
        let mut ret = SizeRetention::default();
        let repos: Vec<String> = {
            let mut stmt = conn.prepare("SELECT repo_id FROM repos ORDER BY repo_id")?;
            let it = stmt.query_map([], |r| r.get(0))?;
            it.collect::<std::result::Result<Vec<_>, _>>()?
        };
        for repo_id in &repos {
            let policy = retention::retention_policy(conn, repo_id, None)?;
            let plan = retention::evaluate_retention(
                conn,
                repo_id,
                &RetentionOptions {
                    now: now.to_owned(),
                    before: None,
                    policy,
                },
            )?;
            ret.revisions += u64::try_from(plan.totals.archive).unwrap_or(0);
            ret.bytes += plan.totals.bytes;
        }
        Ok(HistorySizeFigures {
            same_dispositions,
            archived,
            retention: ret,
        })
    }

    fn retention_policy(
        &self,
        conn: &Connection,
        repo_id: &str,
        override_: Option<&Json>,
    ) -> Result<RetentionPolicy> {
        retention::retention_policy(conn, repo_id, override_)
    }

    fn retention_plan(
        &self,
        conn: &Connection,
        repo_id: &str,
        opts: &RetentionOptions,
    ) -> Result<RetentionPlan> {
        retention::evaluate_retention(conn, repo_id, opts)
    }

    fn export_history(
        &self,
        conn: &Connection,
        mint: &mut Mint<'_>,
        repo_id: &str,
        opts: &ExportOptions,
    ) -> Result<ExportResult> {
        archive::export_history(conn, mint, repo_id, opts)
    }

    fn attach_archive(
        &self,
        conn: &Connection,
        repo_id: &str,
        target: &Path,
    ) -> Result<AttachResult> {
        archive::attach_archive(conn, repo_id, target)
    }

    fn detach_archive(&self, conn: &Connection, repo_id: &str, r: &str) -> Result<Option<String>> {
        archive::detach_archive(conn, repo_id, r)
    }

    fn list_archives(
        &self,
        conn: &Connection,
        repo_id: &str,
        dest: Option<&Path>,
    ) -> Result<Vec<ArchiveListing>> {
        archive::list_archives(conn, repo_id, dest)
    }
}
