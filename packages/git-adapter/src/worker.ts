import type { Store, CommitRecord, CommitDigest, HistoryCheckpointResult } from "@omgbase/core";
import { changesSince, ExpiredCursor, faultPoint, feedStatus, reconstructContent, repoEpoch, storagePath, clearProviderUnavailable } from "@omgbase/core";
import { GitRepo, type GitIdentity } from "./git.js";
import { parseMessage, renderMessage, type CommitTrailers, type DocTrailer } from "./trailers.js";
import { writeGitCursor } from "./cursor.js";
import type { GitHistoryConfig } from "./config.js";

// The checkpoint worker (spec/store §5.12 "The checkpoint worker"): a consumer
// of the change feed that turns feed rows into git commits in the bare
// repository. Commits are built from the DATABASE ROWS — never from the
// vault's files: for every document a row touched, the accepted bytes
// (`reconstruct`, spec/store §6.1) become a blob, the previous commit's tree
// plus the adds and removes becomes a tree, the commit carries the trailers of
// `trailers.ts`, and the branch ref moves by compare-and-swap. The worker is
// idempotent across the non-atomic gap between the database and git: it
// resumes from the branch tip's `omgbase-seq` trailer (the `$git` cursor row is
// a cache), a commit already present for a seq is skipped, and the fault site
// `git.commit` — after the objects are written, before `update-ref` — leaves
// dangling objects the next run re-creates byte for byte.
//
// Cadence (`config.cadence`): `"every"` writes one commit per feed row;
// `{ debounce_ms }` folds the rows pending when the worker runs into one
// commit whose `omgbase-seq` is the range (6a has no timer: the worker is run
// by `omg history checkpoint` and by the freshness sweep).
//
// What the rows cannot give: the bytes of a document as of a row OLDER than
// its current head — the core keeps current state only. A document a pending
// row touched whose `docs.file_hash` no longer equals the row's entry hash is
// SUPERSEDED within the pending span: its blob is written by the later row (the
// one whose hash matches), the earlier commit lists it in `omgbase-doc` and
// leaves its path's blob as it was. Under `every` with a worker run after every
// write this never happens; stated in the spec as the asynchronous-capture
// tradeoff.

export interface WorkerContext {
  store: Store;
  repoId: string;
  git: GitRepo;
  config: GitHistoryConfig;
  /** the committer (and the author's email); the author's NAME is the row's actor when it has one */
  identity: GitIdentity;
}

interface Pending {
  adds: Map<string, string>; // path → blob sha
  removes: Set<string>;
  docs: Map<string, DocTrailer>; // doc id → the last trailer
}

/** The feed seq the branch tip covers (its trailer), or null without a tip or with a foreign/malformed one. */
export function tipPosition(git: GitRepo, branch: string): { tip: string; epoch: string; seq: number } | null {
  const tip = git.tip(branch);
  if (tip === null) return null;
  const t = parseMessage(git.message(tip));
  if (!t) return null;
  return { tip, epoch: t.epoch, seq: t.to };
}

function authorFor(identity: GitIdentity, actor: string | null): GitIdentity {
  return { name: actor ?? identity.name, email: identity.email };
}

/** Write the blob of a live document whose current bytes are what the entry recorded (or whatever they are, when `anyHash`). */
function stageDoc(ctx: WorkerContext, pending: Pending, docId: string, path: string, entryHash: string | null): void {
  const db = ctx.store.db;
  const doc = db.prepare("SELECT file_hash, deleted_at FROM docs WHERE doc_id = ?").get(docId) as { file_hash: Buffer | null; deleted_at: string | null } | undefined;
  if (!doc || doc.deleted_at !== null || !doc.file_hash) return; // gone since: a later row removes the path
  if (entryHash !== null && doc.file_hash.toString("hex") !== entryHash) return; // superseded within the pending span
  const bytes = reconstructContent(db, docId);
  if (bytes === null) return;
  pending.removes.delete(path);
  pending.adds.set(path, ctx.git.writeBlob(bytes));
}

function stageDigest(ctx: WorkerContext, pending: Pending, d: CommitDigest): void {
  for (const r of d.revisions) {
    const path = storagePath(r._path);
    if (r.kind === "deleted") {
      pending.adds.delete(path);
      pending.removes.add(path);
      pending.docs.set(r._id, { docId: r._id, path, head: null });
      continue;
    }
    if (r.kind === "moved" && r.from_path !== undefined) {
      const from = storagePath(r.from_path);
      pending.adds.delete(from);
      pending.removes.add(from);
    }
    const head = (ctx.store.db.prepare("SELECT head FROM feed_entries WHERE doc_id = ? AND seq = ? AND repo_id = ?").get(r._id, d.seq, ctx.repoId) as { head: string | null } | undefined)?.head ?? null;
    pending.docs.set(r._id, { docId: r._id, path, head });
    stageDoc(ctx, pending, r._id, path, r._hash);
  }
}

/** One git commit over the staged changes; the new tip. */
function commitPending(ctx: WorkerContext, pending: Pending, parent: string | null, subject: string, trailers: CommitTrailers, actor: string | null, snapshot: boolean): string {
  const baseTree = snapshot || parent === null ? null : ctx.git.treeOf(parent);
  const tree = ctx.git.buildTree(baseTree, [...pending.adds].map(([path, blob]) => ({ path, blob })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), [...pending.removes].sort());
  const message = renderMessage(subject, trailers);
  const sha = ctx.git.commitTree(tree, parent, message, { author: authorFor(ctx.identity, actor), committer: ctx.identity, ts: trailers.ts });
  // OMGBASE_FAULT=git.commit (spec/store §9.7): the objects are written, the ref has not moved.
  faultPoint("git.commit");
  ctx.git.updateRef(ctx.config.branch, sha, parent);
  writeGitCursor(ctx.store.db, ctx.repoId, { tip: sha, epoch: trailers.epoch, seq: trailers.to });
  return sha;
}

/** The whole live tree of the repository staged (a rescan / the baseline). */
function stageSnapshot(ctx: WorkerContext): Pending {
  const pending: Pending = { adds: new Map(), removes: new Set(), docs: new Map() };
  const live = ctx.store.db.prepare("SELECT doc_id, path, head FROM docs WHERE repo_id = ? AND deleted_at IS NULL AND head IS NOT NULL ORDER BY path").all(ctx.repoId) as { doc_id: string; path: string; head: string }[];
  for (const d of live) {
    pending.docs.set(d.doc_id, { docId: d.doc_id, path: d.path, head: d.head });
    stageDoc(ctx, pending, d.doc_id, d.path, null);
  }
  return pending;
}

/**
 * A SNAPSHOT commit (spec/store §5.12 "Rescan"): the full current tree at the
 * feed head, `omgbase-rescan: <epoch>:<head>`; the baseline `history enable`
 * writes (`record` given: subject `history enabled`, `omgbase-commit`/`origin`
 * of the baseline feed row) and the recovery from an `expired_cursor` or a
 * tipless branch (subject `rescan: <n> document(s)`).
 */
export function commitSnapshot(ctx: WorkerContext, now: string, record: CommitRecord | null): { tip: string; documents: number; head: number } {
  // A purged (or never initialised) repository is created afresh: the snapshot is its first commit.
  ctx.git.init(ctx.config.branch);
  const status = feedStatus(ctx.store.db, ctx.repoId);
  const pending = stageSnapshot(ctx);
  const docs = [...pending.docs.values()];
  const trailers: CommitTrailers = {
    epoch: status.epoch, from: status.head, to: status.head, ts: record?.ts ?? now,
    commits: record ? [record.commitId] : [], origin: record?.origin ?? null, actor: record?.actor ?? null, plan: null,
    docs, rescan: { epoch: status.epoch, head: status.head },
  };
  const subject = record ? (record.reason ?? `${record.origin}: ${docs.length} document(s)`) : `rescan: ${docs.length} document(s)`;
  const parent = ctx.git.tip(ctx.config.branch);
  const tip = commitPending(ctx, pending, parent, subject, trailers, record?.actor ?? null, true);
  return { tip, documents: docs.length, head: status.head };
}

const PAGE = 200;

/**
 * The worker, once (spec/store §5.12): resume from the tip's trailer (the
 * cursor row when the tip is foreign — then a RESCAN: one snapshot commit at
 * the head), page `changes_since` from there, one commit per row under `every`
 * or one commit over every pending row under `{ debounce_ms }`, and report
 * `{ committed, from_seq, to_seq, tip, rescanned }`.
 */
export function runCheckpoint(ctx: WorkerContext, opts: { now?: string } = {}): HistoryCheckpointResult {
  const now = opts.now ?? new Date().toISOString();
  const { store, repoId, git, config } = ctx;
  const epoch = repoEpoch(store.db, repoId);
  // The tip's trailer is the truth; the `$git` cursor row is its cache (it may lag the tip after a crash between the two writes).
  const position = tipPosition(git, config.branch);
  const start = position && position.epoch === epoch ? position.seq : null;
  const rescan = (): HistoryCheckpointResult => {
    const snap = commitSnapshot(ctx, now, null);
    clearProviderUnavailable(store.db, repoId, now);
    return { committed: 1, from_seq: snap.head, to_seq: snap.head, tip: snap.tip, rescanned: true };
  };
  // No usable position — no tip (the repository was purged or never baselined), or a tip of another epoch — is a rescan.
  if (start === null) return rescan();
  let cursor = start;
  let committed = 0;
  let tip: string | null = position?.tip ?? null;
  const digests: CommitDigest[] = [];
  // Collect every pending row first (paging), so a debounce cadence folds them all.
  for (;;) {
    let page;
    try {
      page = changesSince(store, repoId, { cursor, limit: PAGE });
    } catch (e) {
      if (e instanceof ExpiredCursor) return rescan();
      throw e;
    }
    digests.push(...page.digests);
    cursor = page.cursor;
    if (!page.truncated) break;
  }
  if (digests.length === 0) {
    clearProviderUnavailable(store.db, repoId, now);
    return { committed: 0, from_seq: start, to_seq: start, tip, rescanned: false };
  }
  const groups: CommitDigest[][] = config.cadence === "every" ? digests.map((d) => [d]) : [digests];
  for (const group of groups) {
    const pending: Pending = { adds: new Map(), removes: new Set(), docs: new Map() };
    for (const d of group) stageDigest(ctx, pending, d);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const docs = [...pending.docs.values()];
    const trailers: CommitTrailers = {
      epoch, from: first.seq, to: last.seq, ts: last.ts,
      commits: group.map((d) => d.commit), origin: last.origin, actor: last.actor, plan: last.plan_id ?? null,
      docs, rescan: null,
    };
    const reason = group.length === 1 ? reasonOf(store, first.commit) : null;
    const subject = group.length === 1 ? (reason ?? `${first.origin}: ${docs.length} document(s)`) : `checkpoint: ${group.length} commits, ${docs.length} document(s)`;
    tip = commitPending(ctx, pending, tip, subject, trailers, last.actor, false);
    committed++;
  }
  clearProviderUnavailable(store.db, repoId, now);
  return { committed, from_seq: start + 1, to_seq: cursor, tip, rescanned: false };
}

/** The feed row's `reason` (the digest carries `summary`, not the reason). */
function reasonOf(store: Store, commitId: string): string | null {
  const row = store.db.prepare("SELECT reason FROM feed WHERE commit_id = ?").get(commitId) as { reason: string | null } | undefined;
  return row?.reason ?? null;
}
