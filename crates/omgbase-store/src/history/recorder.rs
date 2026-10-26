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
    DispositionRow, GcResult, HistoryRecorder, HistorySizeFigures, RecordedRevision, RevisionRead,
    RevisionTransition,
};
use crate::core::claims;
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

/// The recorder over the store's own history tables (`revisions`,
/// `tree_nodes`, `blobs`, `commits`, `dispositions`, `block_changes`,
/// `archives`).
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
