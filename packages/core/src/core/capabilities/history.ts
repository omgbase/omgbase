import type { Database } from "better-sqlite3";
import type { Store } from "../store/store.js";
import type { CapturedRevision, CommitRecord, HistoryRecorder, RevisionQueryRow, RevisionTransition } from "./types.js";
import type { DispositionRow } from "../ingest.js";
import type { EdgeTransitions } from "../store/edges.js";
import { persistsDisposition } from "../ingest.js";
import type { DocsReadAtResult } from "../read/document.js";
import {
  isCheckpointRevision, previousRevision, recordCommit, writeBlockTree, writeFrontmatterBlob, writeRevision,
  type TreeWriteContext,
} from "../store/history-writers.js";
import type { TreeInputBlock } from "../store/writers.js";
import { TreeResolver } from "../store/delta.js";
import { collectHistory, countSameDispositions, markReachable } from "../store/history-gc.js";
import { evaluateRetention, retentionPolicy, type EvaluateOptions, type RetentionPlan, type RetentionPolicy } from "../store/retention.js";
import {
  archivedSummary, attachArchive, detachArchive, exportHistory, listArchives,
  type ArchiveListing, type AttachResult, type ExportOptions, type ExportResult,
} from "../store/archive.js";
import {
  diffBlocks, diffUnified, docDiffUnified, docHistory, historyNode, reconstructAtRevision,
  type DiffEntry, type DocDiffUnified, type DocVersions, type NodeChange,
} from "../../graph/history.js";

const REVISION_COLS = "r.rev_id, r.doc_id, r.seq, r.rendered_hash, r.path, r.commit_id, c.ts, c.origin, c.actor, c.reason, (d.head = r.rev_id) AS is_current, (r.archive IS NOT NULL) AS archived";
const REVISION_FROM = "revisions r JOIN docs d ON d.doc_id = r.doc_id JOIN commits c ON c.commit_id = r.commit_id";

/** The document's live body tree from the current rows (`TreeInputBlock[]`, pre-order by `parent_block` + `ordinal`) — the baseline's input; the same read `mutate/commit.ts` makes for a `docs_move`. */
function currentTree(db: Database, docId: string): TreeInputBlock[] {
  const rows = db
    .prepare("SELECT block_id, parent_block, ordinal, type, attrs, raw, trivia FROM blocks WHERE doc_id = ? AND deleted_at IS NULL ORDER BY ordinal, block_id")
    .all(docId) as { block_id: string; parent_block: string | null; ordinal: number; type: string; attrs: string; raw: string; trivia: string | null }[];
  const ids = new Set(rows.map((r) => r.block_id));
  const byParent = new Map<string | null, typeof rows>();
  for (const r of rows) {
    const parent = r.parent_block !== null && ids.has(r.parent_block) ? r.parent_block : null;
    let list = byParent.get(parent);
    if (!list) byParent.set(parent, (list = []));
    list.push(r);
  }
  const build = (parent: string | null): TreeInputBlock[] =>
    (byParent.get(parent) ?? []).map((r) => ({ blockId: r.block_id, type: r.type, raw: r.raw, trivia: r.trivia ?? "", attrs: JSON.parse(r.attrs) as Record<string, unknown>, children: build(r.block_id) }));
  return build(null);
}

/**
 * The default `HistoryRecorder`: today's history code behind the interface,
 * statement for statement. The capture half is what `core/ingest.ts`
 * (`ingestInto` steps 0–2 and 10), `mutate/commit.ts` (`runPhases` phase C)
 * and `sync/tombstone.ts` ran inline before Phase 1 — since 17.0 (Phase 3a)
 * under the head token the core mints, with a `docs_move` captured as a
 * transition of the unchanged tree at the new path (D11); the reads are
 * `graph/history.ts` and `mutate/materialize.ts`'s prior-bytes rule; the maintenance half is
 * `core/store/{gc,retention,archive}.ts`. Bound to one store; the capture
 * methods run on its connection inside the caller's transaction.
 */
export class HistoryRecorderImpl implements HistoryRecorder {
  constructor(private readonly store: Store) {}

  // ---- capture ----

  /**
   * spec/store §5.4 step 15 (17.0, 3d): the `commits` row — the log's copy of
   * the feed row the core appended, under the same id, epoch and seq, with
   * `ops` (the ADR-003 intent record of an api commit) — and the recorder's
   * hold on the commit id's claim (§2.1).
   */
  recordCommit(commit: CommitRecord): void {
    recordCommit(this.store.db, commit);
    this.store.capabilities.claims.hold([commit.commitId]);
  }

  /**
   * spec/store §4.4 (16.0): the revision's seq decides whether it is a
   * checkpoint; a non-checkpoint revision writes its tree and frontmatter as
   * deltas against the previous revision's RESOLVED tree and raw where that is
   * smaller. The previous revision is the recorder's OWN state (17.0 M1: the
   * core hands the transition and reads nothing here) — the document's greatest
   * captured seq, on every path the current revision, never archived (retention
   * rule 1) — but the rule is stated for the general case: no live predecessor
   * ⇒ a checkpoint.
   * Then the frontmatter blob (spec/store §5.4 step 1): the raw at a
   * checkpoint, else the smaller of a line delta over the previous revision's
   * frontmatter and the raw. Then the `revisions` row (step 2).
   */
  captureRevision(t: RevisionTransition): CapturedRevision {
    const db = this.store.db;
    const previous = previousRevision(db, t.docId);
    const seq = previous ? previous.seq + 1 : 1;
    const checkpoint = isCheckpointRevision(seq, previous);
    const resolver = new TreeResolver(db);
    const treeCtx: TreeWriteContext = {
      checkpoint,
      base: !checkpoint && previous?.root_tree ? resolver.tree(t.docId, previous.seq, previous.root_tree.toString("hex")) : null,
    };
    const rootTreeHex = writeBlockTree(db, t.blocks, treeCtx);

    let fmBlobHex: string | null = null;
    if (t.frontmatterRaw !== null) {
      const baseRaw = !checkpoint && previous?.frontmatter_blob ? resolver.frontmatter(t.docId, previous.seq, previous.frontmatter_blob.toString("hex")) : null;
      fmBlobHex = writeFrontmatterBlob(db, t.frontmatterRaw, baseRaw, checkpoint);
    }

    const written = writeRevision(db, {
      revId: t.head,
      docId: t.docId,
      rootTreeHex,
      frontmatterBlobHex: fmBlobHex,
      renderedHash: t.renderedHash,
      path: t.path,
      commitId: t.commitId,
      seq,
    });
    // spec/store §2.1 (17.0): the recorder's hold (bit 1) on every id its
    // `revisions` row names — the head and the document — so the claims prune
    // never releases an id the history still refers to.
    this.store.capabilities.claims.hold([t.head, t.docId]);
    return written;
  }

  /**
   * spec/store §5.4 step 10 (14.2): a `same` verdict is not persisted. The
   * matcher (and the known-id resolver) still produce one per untouched block
   * — the outcome counts them — but the table records what CHANGED, so a
   * block's `updated_at` (MAX commit ts over its `block_changes`) and its
   * `blocks_history` are the block's own changes, not its siblings'. Every
   * other kind is written, and the block ids named gain the recorder's hold on
   * their claims (§2.1, 17.0).
   */
  recordDispositions(commitId: string, dispositions: readonly DispositionRow[]): void {
    const db = this.store.db;
    const insDisp = db.prepare(
      `INSERT OR IGNORE INTO dispositions (commit_id, block_id, kind, confidence, reason, matcher_v, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const bc = db.prepare("INSERT OR IGNORE INTO block_changes (block_id, commit_id, kind) VALUES (?, ?, ?)");
    const held = new Set<string>();
    for (const d of dispositions) {
      if (!persistsDisposition(d.kind)) continue;
      insDisp.run(commitId, d.blockId, d.kind, d.confidence, d.reason, d.matcherV, JSON.stringify(d.detail));
      bc.run(d.blockId, commitId, d.kind);
      if (d.blockId !== "DOC") held.add(d.blockId);
    }
    // spec/store §2.1 (17.0): the recorder's hold (bit 1) on every block id a
    // `block_changes` row now names. This — not an earliest row the squash
    // keeps — is what keeps an archived block's id reserved (§7.1 step 2).
    this.store.capabilities.claims.hold(held);
  }

  /**
   * spec/graph §3.3 (17.0, M6): the interval record. One `edge_transitions`
   * row per opened edge — 16.x's `edges` row verbatim, `from_commit` this
   * commit, `to_commit` NULL — and `to_commit = this commit` on every row the
   * core deleted; the opened ids gain the recorder's hold (§2.1).
   */
  recordEdgeTransitions(commitId: string, t: EdgeTransitions): void {
    const db = this.store.db;
    const open = db.prepare(
      `INSERT OR REPLACE INTO edge_transitions (edge_id, repo_id, src_doc, src_block, src_field, predicate, dst_kind, dst_node, anchor, provenance, via_node, from_commit, to_commit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const e of t.opened) open.run(e.edgeId, e.repoId, e.srcDoc, e.srcBlock, e.srcField, e.predicate, e.dstKind, e.dstNode, e.anchor, e.provenance, e.viaNode, commitId);
    const close = db.prepare("UPDATE edge_transitions SET to_commit = ? WHERE edge_id = ? AND to_commit IS NULL");
    for (const id of t.closed) close.run(commitId, id);
    this.store.capabilities.claims.hold(t.opened.map((e) => e.edgeId));
  }

  retargetEdges(edgeIds: readonly string[], dstNode: string): void {
    if (edgeIds.length === 0) return;
    const stmt = this.store.db.prepare("UPDATE edge_transitions SET dst_node = ? WHERE edge_id = ? AND to_commit IS NULL");
    for (const id of edgeIds) stmt.run(dstNode, id);
  }

  // ---- the surface's reads ----

  readAtRevision(docId: string, revId: string): DocsReadAtResult | null {
    return reconstructAtRevision(this.store, docId, revId);
  }

  frontmatterAtRevision(revId: string): string | null {
    const db = this.store.db;
    const rev = db.prepare("SELECT doc_id, seq, frontmatter_blob FROM revisions WHERE rev_id = ?").get(revId) as
      | { doc_id: string; seq: number; frontmatter_blob: Buffer | null }
      | undefined;
    if (!rev?.frontmatter_blob) return null;
    return new TreeResolver(db).frontmatter(rev.doc_id, rev.seq, rev.frontmatter_blob.toString("hex"));
  }

  blocksHistory(blockId: string, opts: { limit?: number } = {}): NodeChange[] {
    return historyNode(this.store, blockId, opts);
  }

  diffBlocks(docId: string, fromRev: string, toRev: string): DiffEntry[] {
    return diffBlocks(this.store, docId, fromRev, toRev);
  }

  diffUnified(docId: string, fromRev: string, toRev: string): string {
    return diffUnified(this.store, docId, fromRev, toRev);
  }

  docDiffUnified(docId: string, opts: { fromRev?: string; toRev?: string; label?: string } = {}): DocDiffUnified {
    return docDiffUnified(this.store, docId, opts);
  }

  docsHistory(repoId: string, opts: { pathGlob?: string; doc?: string; includeDeleted?: boolean; limit?: number } = {}): { docs: DocVersions[]; truncated: boolean } {
    return docHistory(this.store, repoId, opts);
  }

  dispositionCounts(commitId: string): { kind: string; n: number }[] | null {
    const db = this.store.db;
    if (!db.prepare("SELECT 1 FROM commits WHERE commit_id = ?").get(commitId)) return null;
    return db.prepare("SELECT kind, count(*) AS n FROM dispositions WHERE commit_id = ? GROUP BY kind ORDER BY kind").all(commitId) as { kind: string; n: number }[];
  }

  // The revisions scan (spec/surface §1.1, 4.7): every revision of every
  // document of the repository — tombstoned documents included, history is
  // history — with its commit, in the keyset order `(path as of the revision,
  // rev_id)`. The `revisions` table carries no `repo_id`, so the repository
  // guard joins `docs`. `is_current` is `docs_history`'s `isCurrent`: the
  // revision is the document's `head`. Through Phase 3 the query binding ran
  // this SQL itself; Phase 4a moved it behind the seam (no SQL outside the
  // bundle names a history table).
  revisionRows(repoId: string): RevisionQueryRow[] {
    return this.store.db.prepare(`SELECT ${REVISION_COLS} FROM ${REVISION_FROM} WHERE d.repo_id = ? ORDER BY r.path, r.rev_id`).all(repoId) as RevisionQueryRow[];
  }

  docRevisionRows(docId: string): RevisionQueryRow[] {
    return this.store.db.prepare(`SELECT ${REVISION_COLS} FROM ${REVISION_FROM} WHERE r.doc_id = ? ORDER BY r.seq`).all(docId) as RevisionQueryRow[];
  }

  hasRevision(revId: string): boolean {
    return !!this.store.db.prepare("SELECT 1 FROM revisions WHERE rev_id = ?").get(revId);
  }

  uncapturedHeads(repoId: string, since: string): number {
    return (this.store.db
      .prepare("SELECT count(*) c FROM docs d WHERE d.repo_id = ? AND d.deleted_at IS NULL AND d.head IS NOT NULL AND d.updated_at >= ? AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.rev_id = d.head)")
      .get(repoId, since) as { c: number }).c;
  }

  // ---- the capture lifecycle ----

  /**
   * spec/store §5.9 (Phase 4a; phase-1-contracts §1.14): the baseline `history
   * enable` writes under the feed row the core appended. The `commits` row;
   * then, per live document whose head has no `revisions` row (one changed
   * while capture was off, or never captured), a CHECKPOINT revision under the
   * existing head — the current tree and frontmatter raw from the rows, `seq`
   * = 1 + the document's greatest captured seq — so `docs_read { at: head }`
   * reads through the recorder and H1/H3 hold for every live document; the
   * recorder's hold on every live doc, head and block id (I7's rule: a live
   * block has a `block_changes` row or a hold); and the edge interval record
   * reconciled with the open edges (H6): every open transition whose edge is
   * gone is closed at this commit, every open edge without a transition is
   * opened at it. No dispositions (nothing was reconciled).
   */
  baseline(commit: CommitRecord): { revisions: number } {
    const db = this.store.db;
    this.recordCommit(commit);
    const live = db
      .prepare("SELECT doc_id, head, path, file_hash, frontmatter_raw FROM docs WHERE repo_id = ? AND deleted_at IS NULL AND head IS NOT NULL ORDER BY rowid")
      .all(commit.repoId) as { doc_id: string; head: string; path: string; file_hash: Buffer; frontmatter_raw: string | null }[];
    let revisions = 0;
    const held = new Set<string>();
    for (const d of live) {
      held.add(d.doc_id);
      held.add(d.head);
      for (const b of db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND deleted_at IS NULL").all(d.doc_id) as { block_id: string }[]) held.add(b.block_id);
      if (this.hasRevision(d.head)) continue;
      const previous = previousRevision(db, d.doc_id);
      const seq = previous ? previous.seq + 1 : 1;
      const rootTreeHex = writeBlockTree(db, currentTree(db, d.doc_id), { base: null, checkpoint: true });
      const fmBlobHex = d.frontmatter_raw !== null ? writeFrontmatterBlob(db, d.frontmatter_raw, null, true) : null;
      writeRevision(db, { revId: d.head, docId: d.doc_id, rootTreeHex, frontmatterBlobHex: fmBlobHex, renderedHash: d.file_hash, path: d.path, commitId: commit.commitId, seq });
      revisions++;
    }
    this.store.capabilities.claims.hold(held);
    // The edge record (spec/graph §3.3; H6): close what is gone, open what is missing.
    db.prepare("UPDATE edge_transitions SET to_commit = ? WHERE repo_id = ? AND to_commit IS NULL AND edge_id NOT IN (SELECT edge_id FROM edges)").run(commit.commitId, commit.repoId);
    const missing = db
      .prepare(
        `SELECT edge_id, repo_id, src_doc, src_block, src_field, predicate, dst_kind, dst_node, anchor, provenance, via_node FROM edges e
         WHERE e.repo_id = ? AND NOT EXISTS (SELECT 1 FROM edge_transitions t WHERE t.edge_id = e.edge_id AND t.to_commit IS NULL) ORDER BY rowid`,
      )
      .all(commit.repoId) as { edge_id: string; repo_id: string; src_doc: string; src_block: string | null; src_field: string | null; predicate: string; dst_kind: string; dst_node: string; anchor: string | null; provenance: string; via_node: string | null }[];
    const open = db.prepare(
      `INSERT OR REPLACE INTO edge_transitions (edge_id, repo_id, src_doc, src_block, src_field, predicate, dst_kind, dst_node, anchor, provenance, via_node, from_commit, to_commit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const e of missing) open.run(e.edge_id, e.repo_id, e.src_doc, e.src_block, e.src_field, e.predicate, e.dst_kind, e.dst_node, e.anchor, e.provenance, e.via_node, commit.commitId);
    this.store.capabilities.claims.hold(missing.map((e) => e.edge_id));
    // A dangling open transition whose dst was rewritten while capture was off follows the edge now.
    db.prepare(
      `UPDATE edge_transitions SET dst_node = (SELECT e.dst_node FROM edges e WHERE e.edge_id = edge_transitions.edge_id)
       WHERE repo_id = ? AND to_commit IS NULL AND dst_node != (SELECT e.dst_node FROM edges e WHERE e.edge_id = edge_transitions.edge_id)`,
    ).run(commit.repoId);
    return { revisions };
  }

  // ---- maintenance ----

  markReachable(): { trees: Set<string>; blobs: Set<string> } {
    return markReachable(this.store);
  }

  collect(dry: boolean): { blobsSwept: number; treeNodesSwept: number; sameDispositionsSwept: number } {
    return collectHistory(this.store, dry);
  }

  rebuildProjections(): void {
    // block_changes is a pure projection of dispositions across commits
    // (spec/store §7, 17.0): delete and re-derive it verbatim from the
    // dispositions table (which is durable). A wholly archived commit (§7.1,
    // 15.0: every revision of it carries `archive`) has no dispositions and,
    // since 17.0, no block_changes either — the earliest-row exception the
    // 15.0–16.x rebuild preserved for the mint oracle is gone: the id's
    // `id_claims` row holds it (§2.1).
    const db = this.store.db;
    db.exec("DELETE FROM block_changes");
    db.exec("INSERT OR IGNORE INTO block_changes (block_id, commit_id, kind) SELECT block_id, commit_id, kind FROM dispositions");
  }

  sameDispositionCount(): number {
    return countSameDispositions(this.store);
  }

  retentionPolicy(repoId: string, override?: unknown): RetentionPolicy {
    return retentionPolicy(this.store, repoId, override);
  }

  evaluateRetention(repoId: string, opts: EvaluateOptions = {}): RetentionPlan {
    return evaluateRetention(this.store, repoId, opts);
  }

  exportHistory(repoId: string, opts: ExportOptions): ExportResult {
    return exportHistory(this.store, repoId, opts);
  }

  attachArchive(repoId: string, target: string): AttachResult {
    return attachArchive(this.store, repoId, target);
  }

  detachArchive(repoId: string, ref: string): string | null {
    return detachArchive(this.store, repoId, ref);
  }

  listArchives(repoId: string, opts: { dest?: string } = {}): ArchiveListing[] {
    return listArchives(this.store, repoId, opts);
  }

  archivedSummary(): { revisions: number; segments: number; bytes: number } {
    return archivedSummary(this.store);
  }
}
