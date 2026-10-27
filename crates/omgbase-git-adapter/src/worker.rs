//! The checkpoint worker (`spec/store` §5.12 "The checkpoint worker"): a
//! consumer of the change feed that turns feed rows into git commits in the
//! bare repository. Commits are built from the DATABASE ROWS — never from the
//! vault's files: for every document a row touched, the accepted bytes
//! (`reconstruct`, `spec/store` §6.1) become a blob, the previous commit's
//! tree plus the adds and removes becomes a tree, the commit carries the
//! trailers of [`crate::trailers`], and the branch ref moves by
//! compare-and-swap. The worker is idempotent across the non-atomic gap
//! between the database and git: it resumes from the branch tip's
//! `omgbase-seq` trailer (the `$git` cursor row is a cache), a commit already
//! present for a seq is skipped, and the fault site `git.commit` — after the
//! objects are written, before `update-ref` — leaves dangling objects the
//! next run re-creates byte for byte.
//!
//! Cadence (`config.cadence`): `every` writes one commit per feed row;
//! `{ debounce_ms }` folds the rows pending when the worker runs into one
//! commit whose `omgbase-seq` is the range (the timer that runs the worker
//! `debounce_ms` after the last mutation is the MCP host's — [`crate::scheduler`]).
//!
//! Two rules of 17.6 (Phase 6b). (1) THE NO-OP RULE: a checkpoint whose staged
//! tree equals its parent's writes NO commit — the rows' bytes are already in
//! the tree (the remote's commits brought them in through the vault, a
//! document edited and edited back within the pending span) — and the cursor
//! row alone advances past the rows. (2) THE RESUME RULE: the tip's
//! `omgbase-seq` trailer is the position, unless the cursor row names the same
//! tip and stands further on (rule 1 moved it; a fetch fast-forwarded the
//! branch to a tip that is not the worker's own — a foreign epoch or no
//! trailer — and set the row at the head); a tip neither rule can place is a
//! rescan.
//!
//! Beside every content commit the worker writes the IDS REF ([`crate::ids`]):
//! the touched documents' id-map blobs on `refs/omgbase/ids`, one commit
//! carrying the same `omgbase-seq` and `omgbase-content: <content sha>`.
//!
//! What the rows cannot give: the bytes of a document as of a row OLDER than
//! its current head — the core keeps current state only. A document a pending
//! row touched whose `docs.file_hash` no longer equals the row's entry hash is
//! SUPERSEDED within the pending span: its blob is written by the later row
//! (the one whose hash matches), the earlier commit lists it in `omgbase-doc`
//! and leaves its path's blob as it was. Under `every` with a worker run after
//! every write this never happens; stated in the spec as the
//! asynchronous-capture tradeoff.

use omgbase_format::hash::hex;
use omgbase_store::feed::changes_since;
use omgbase_store::{
    ChangesSinceOptions, CheckpointResult, CommitDigest, CommitRecord, Error, FaultSite,
    FeedEntryKind, Result, clear_provider_unavailable, fault_point, feed_status, repo_epoch,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::config::{Cadence, GitHistoryConfig};
use crate::cursor::{GitCursor, read_git_cursor, write_git_cursor};
use crate::git::{GitIdentity, GitRepo};
use crate::ids::{IdsSyncInput, sync_ids};
use crate::trailers::{CommitTrailers, DocTrailer, parse_message, render_message};

/// What one worker run needs.
pub struct WorkerContext<'a> {
    pub conn: &'a Connection,
    pub repo_id: &'a str,
    pub git: &'a GitRepo,
    pub config: &'a GitHistoryConfig,
    /// The committer (and the author's email); the author's NAME is the row's
    /// actor when it has one.
    pub identity: &'a GitIdentity,
}

/// What is staged for one commit.
#[derive(Default)]
struct Pending {
    /// path → blob sha, in first-add order.
    adds: Vec<(String, String)>,
    removes: Vec<String>,
    /// doc id → the last trailer, in first-touch order.
    docs: Vec<DocTrailer>,
}

impl Pending {
    fn add(&mut self, path: &str, blob: String) {
        self.removes.retain(|p| p != path);
        match self.adds.iter_mut().find(|(p, _)| p == path) {
            Some(slot) => slot.1 = blob,
            None => self.adds.push((path.to_owned(), blob)),
        }
    }

    fn remove(&mut self, path: &str) {
        self.adds.retain(|(p, _)| p != path);
        if !self.removes.iter().any(|p| p == path) {
            self.removes.push(path.to_owned());
        }
    }

    fn doc(&mut self, t: DocTrailer) {
        match self.docs.iter_mut().find(|d| d.doc_id == t.doc_id) {
            Some(slot) => *slot = t,
            None => self.docs.push(t),
        }
    }
}

/// The feed seq the branch tip covers (its trailer), or `None` without a tip
/// or with a foreign/malformed one.
pub fn tip_position(git: &GitRepo, branch: &str) -> Result<Option<GitCursor>> {
    let Some(tip) = git.tip(branch)? else {
        return Ok(None);
    };
    let Some(t) = parse_message(&git.message(&tip)?) else {
        return Ok(None);
    };
    Ok(Some(GitCursor {
        tip,
        epoch: t.epoch,
        seq: t.to,
        pushed: None,
    }))
}

/// The resume rule (17.6): the position the worker resumes from — the tip's
/// trailer when it is of this epoch, refined by the `$git` row when the row
/// names the tip and stands further on; the row alone when the tip has no
/// usable trailer but the row names it; `None` otherwise (a rescan).
pub fn resume_position(ctx: &WorkerContext<'_>, epoch: &str) -> Result<Option<(String, i64)>> {
    let Some(tip) = ctx.git.tip(&ctx.config.branch)? else {
        return Ok(None);
    };
    let from_trailer = parse_message(&ctx.git.message(&tip)?)
        .filter(|t| t.epoch == epoch)
        .map(|t| t.to);
    let from_row = read_git_cursor(ctx.conn, ctx.repo_id)?
        .filter(|row| row.tip == tip && row.epoch == epoch)
        .map(|row| row.seq);
    Ok(match (from_trailer, from_row) {
        (None, None) => None,
        (a, b) => Some((tip, a.unwrap_or(-1).max(b.unwrap_or(-1)))),
    })
}

fn author_for(identity: &GitIdentity, actor: Option<&str>) -> GitIdentity {
    GitIdentity {
        name: actor.unwrap_or(&identity.name).to_owned(),
        email: identity.email.clone(),
    }
}

/// The storage form of a path (`spec/surface` §1: no leading slash).
fn storage_path(p: &str) -> &str {
    p.strip_prefix('/').unwrap_or(p)
}

/// Write the blob of a live document whose current bytes are what the entry
/// recorded (or whatever they are, with no `entry_hash`).
fn stage_doc(
    ctx: &WorkerContext<'_>,
    pending: &mut Pending,
    doc_id: &str,
    path: &str,
    entry_hash: Option<&str>,
) -> Result<()> {
    let doc: Option<(Option<Vec<u8>>, Option<String>)> = ctx
        .conn
        .query_row(
            "SELECT file_hash, deleted_at FROM docs WHERE doc_id = ?1",
            params![doc_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    // Gone since: a later row removes the path.
    let Some((Some(file_hash), None)) = doc else {
        return Ok(());
    };
    // Superseded within the pending span.
    if entry_hash.is_some_and(|h| hex(&file_hash) != h) {
        return Ok(());
    }
    let Some(bytes) = omgbase_store::read::reconstruct(ctx.conn, doc_id)? else {
        return Ok(());
    };
    let blob = ctx.git.write_blob(bytes.as_bytes())?;
    pending.add(path, blob);
    Ok(())
}

fn stage_digest(ctx: &WorkerContext<'_>, pending: &mut Pending, d: &CommitDigest) -> Result<()> {
    for r in &d.revisions {
        let path = storage_path(&r.path).to_owned();
        if r.kind == FeedEntryKind::Deleted {
            pending.remove(&path);
            pending.doc(DocTrailer {
                doc_id: r.doc.clone(),
                path,
                head: None,
            });
            continue;
        }
        if r.kind == FeedEntryKind::Moved
            && let Some(from) = &r.from_path
        {
            pending.remove(storage_path(from));
        }
        let head: Option<String> = ctx
            .conn
            .query_row(
                "SELECT head FROM feed_entries WHERE doc_id = ?1 AND seq = ?2 AND repo_id = ?3",
                params![r.doc, d.seq, ctx.repo_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        pending.doc(DocTrailer {
            doc_id: r.doc.clone(),
            path: path.clone(),
            head,
        });
        stage_doc(ctx, pending, &r.doc, &path, r.hash.as_deref())?;
    }
    Ok(())
}

/// One git commit over the staged changes — or none, when the staged tree is
/// the parent's (the no-op rule; never for a snapshot) — then the ids commit;
/// the new tip and whether a content commit was written.
fn commit_pending(
    ctx: &WorkerContext<'_>,
    pending: &Pending,
    parent: Option<&str>,
    subject: &str,
    trailers: &CommitTrailers,
    actor: Option<&str>,
    snapshot: bool,
) -> Result<(String, bool)> {
    let base_tree = match parent {
        Some(p) if !snapshot => Some(ctx.git.tree_of(p)?),
        _ => None,
    };
    let mut adds = pending.adds.clone();
    adds.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut removes = pending.removes.clone();
    removes.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    let tree = ctx.git.build_tree(base_tree.as_deref(), &adds, &removes)?;
    let touched: Vec<String> = pending.docs.iter().map(|d| d.doc_id.clone()).collect();
    let ids = |content: &str, docs: Option<&[String]>| -> Result<()> {
        sync_ids(&IdsSyncInput {
            conn: ctx.conn,
            repo_id: ctx.repo_id,
            git: ctx.git,
            config: ctx.config,
            identity: ctx.identity,
            docs,
            epoch: &trailers.epoch,
            from: trailers.from,
            to: trailers.to,
            ts: &trailers.ts,
            content,
            actor,
        })?;
        Ok(())
    };
    if let (Some(parent), Some(base)) = (parent, base_tree.as_deref())
        && !snapshot
        && tree == base
    {
        // The no-op rule (17.6): the bytes are already in the tree; the cursor
        // row advances, the identities are still recorded.
        write_git_cursor(ctx.conn, ctx.repo_id, parent, &trailers.epoch, trailers.to)?;
        ids(parent, Some(&touched))?;
        return Ok((parent.to_owned(), false));
    }
    let message = render_message(subject, trailers);
    let sha = ctx.git.commit_tree(
        &tree,
        parent,
        &message,
        &author_for(ctx.identity, actor),
        ctx.identity,
        &trailers.ts,
    )?;
    // OMGBASE_FAULT=git.commit (`spec/store` §9.7): the objects are written, the ref has not moved.
    fault_point(FaultSite::GitCommit)?;
    ctx.git.update_ref(&ctx.config.branch, &sha, parent)?;
    write_git_cursor(ctx.conn, ctx.repo_id, &sha, &trailers.epoch, trailers.to)?;
    ids(&sha, if snapshot { None } else { Some(&touched) })?;
    Ok((sha, true))
}

/// The whole live tree of the repository staged (a rescan / the baseline).
fn stage_snapshot(ctx: &WorkerContext<'_>) -> Result<Pending> {
    let mut pending = Pending::default();
    let live: Vec<(String, String, String)> = {
        let mut stmt = ctx.conn.prepare(
            "SELECT doc_id, path, head FROM docs WHERE repo_id = ?1 AND deleted_at IS NULL AND head IS NOT NULL ORDER BY path",
        )?;
        let rows = stmt.query_map(params![ctx.repo_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    for (doc_id, path, head) in live {
        pending.doc(DocTrailer {
            doc_id: doc_id.clone(),
            path: path.clone(),
            head: Some(head),
        });
        stage_doc(ctx, &mut pending, &doc_id, &path, None)?;
    }
    Ok(pending)
}

/// A snapshot commit's receipt: the tip, the documents it names, the feed head.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub tip: String,
    pub documents: usize,
    pub head: i64,
}

/// A SNAPSHOT commit (`spec/store` §5.12 "Rescan"): the full current tree at
/// the feed head, `omgbase-rescan: <epoch>:<head>`; the baseline `history
/// enable` writes (`record` given: subject `history enabled`,
/// `omgbase-commit`/`origin` of the baseline feed row) and the recovery from
/// an `expired_cursor` or a tipless branch (subject `rescan: <n> document(s)`).
pub fn commit_snapshot(
    ctx: &WorkerContext<'_>,
    now: &str,
    record: Option<&CommitRecord<'_>>,
) -> Result<Snapshot> {
    // A purged (or never initialised) repository is created afresh: the snapshot is its first commit.
    ctx.git.init(&ctx.config.branch)?;
    let status = feed_status(ctx.conn, ctx.repo_id)?;
    let pending = stage_snapshot(ctx)?;
    let docs = pending.docs.clone();
    let trailers = CommitTrailers {
        epoch: status.epoch.clone(),
        from: status.head,
        to: status.head,
        ts: record.map_or(now, |r| r.ts).to_owned(),
        commits: record
            .map(|r| vec![r.commit_id.to_owned()])
            .unwrap_or_default(),
        origin: record.map(|r| r.origin.as_str().to_owned()),
        actor: record.and_then(|r| r.actor.map(str::to_owned)),
        plan: None,
        docs: docs.clone(),
        rescan: Some((status.epoch.clone(), status.head)),
        merge: None,
        content: None,
    };
    let subject = match record {
        Some(r) => r.reason.map_or_else(
            || format!("{}: {} document(s)", r.origin.as_str(), docs.len()),
            str::to_owned,
        ),
        None => format!("rescan: {} document(s)", docs.len()),
    };
    let parent = ctx.git.tip(&ctx.config.branch)?;
    let (tip, _) = commit_pending(
        ctx,
        &pending,
        parent.as_deref(),
        &subject,
        &trailers,
        record.and_then(|r| r.actor),
        true,
    )?;
    Ok(Snapshot {
        tip,
        documents: docs.len(),
        head: status.head,
    })
}

const PAGE: usize = 200;

/// The feed row's `reason` (the digest carries `summary`, not the reason).
fn reason_of(conn: &Connection, commit_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT reason FROM feed WHERE commit_id = ?1",
            params![commit_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

/// The worker, once (`spec/store` §5.12): resume by the resume rule (none → a
/// RESCAN: one snapshot commit at the head), page `changes_since` from there,
/// one commit per row under `every` or one commit over every pending row
/// under `{ debounce_ms }` — a group whose tree is its parent's writes none —
/// and report `{ committed, from_seq, to_seq, tip, rescanned }`.
pub fn run_checkpoint(ctx: &WorkerContext<'_>, now: &str) -> Result<CheckpointResult> {
    let epoch = repo_epoch(ctx.conn, ctx.repo_id)?;
    // The resume rule (17.6): the tip's trailer, refined by the `$git` row
    // when it names the same tip and stands further on.
    let position = if ctx.git.exists() {
        resume_position(ctx, &epoch)?
    } else {
        None
    };
    let rescan = |ctx: &WorkerContext<'_>| -> Result<CheckpointResult> {
        let snap = commit_snapshot(ctx, now, None)?;
        clear_provider_unavailable(ctx.conn, ctx.repo_id, now)?;
        Ok(CheckpointResult {
            committed: 1,
            from_seq: snap.head,
            to_seq: snap.head,
            tip: Some(snap.tip),
            rescanned: true,
            push: None,
        })
    };
    // No usable position — no tip (the repository was purged or never
    // baselined), a tip of another epoch nobody placed — is a rescan.
    let Some((tip, start)) = position else {
        return rescan(ctx);
    };
    let mut cursor = start;
    let mut committed = 0usize;
    let mut tip: Option<String> = Some(tip);
    let mut digests: Vec<CommitDigest> = Vec::new();
    // Collect every pending row first (paging), so a debounce cadence folds them all.
    loop {
        let page = match changes_since(
            ctx.conn,
            None,
            ctx.repo_id,
            &ChangesSinceOptions {
                cursor,
                epoch: None,
                limit: PAGE,
                origin: None,
            },
        ) {
            Ok(p) => p,
            Err(Error::ExpiredCursor(_)) => return rescan(ctx),
            Err(e) => return Err(e),
        };
        digests.extend(page.digests);
        cursor = page.cursor;
        if !page.truncated {
            break;
        }
    }
    if digests.is_empty() {
        clear_provider_unavailable(ctx.conn, ctx.repo_id, now)?;
        return Ok(CheckpointResult {
            committed: 0,
            from_seq: start,
            to_seq: start,
            tip,
            rescanned: false,
            push: None,
        });
    }
    let groups: Vec<Vec<CommitDigest>> = match ctx.config.cadence {
        Cadence::Every => digests.into_iter().map(|d| vec![d]).collect(),
        Cadence::Debounce { .. } => vec![digests],
    };
    for group in &groups {
        let mut pending = Pending::default();
        for d in group {
            stage_digest(ctx, &mut pending, d)?;
        }
        let first = &group[0];
        let last = &group[group.len() - 1];
        let docs = pending.docs.clone();
        let trailers = CommitTrailers {
            epoch: epoch.clone(),
            from: first.seq,
            to: last.seq,
            ts: last.ts.clone(),
            commits: group.iter().map(|d| d.commit.clone()).collect(),
            origin: Some(last.origin.clone()),
            actor: last.actor.clone(),
            plan: last.plan_id.clone(),
            docs,
            rescan: None,
            merge: None,
            content: None,
        };
        let subject = if group.len() == 1 {
            reason_of(ctx.conn, &first.commit)?
                .unwrap_or_else(|| format!("{}: {} document(s)", first.origin, trailers.docs.len()))
        } else {
            format!(
                "checkpoint: {} commits, {} document(s)",
                group.len(),
                trailers.docs.len()
            )
        };
        let (sha, wrote) = commit_pending(
            ctx,
            &pending,
            tip.as_deref(),
            &subject,
            &trailers,
            last.actor.as_deref(),
            false,
        )?;
        tip = Some(sha);
        if wrote {
            committed += 1;
        }
    }
    clear_provider_unavailable(ctx.conn, ctx.repo_id, now)?;
    Ok(CheckpointResult {
        committed,
        from_seq: start + 1,
        to_seq: cursor,
        tip,
        rescanned: false,
        push: None,
    })
}
