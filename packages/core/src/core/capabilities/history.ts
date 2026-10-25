import type { Store } from "../store/store.js";
import type { CapturedRevision, HistoryRecorder, RevisionTransition } from "./types.js";
import type { DispositionRow } from "../ingest.js";
import { persistsDisposition } from "../ingest.js";
import type { DocsReadAtResult } from "../read/document.js";
import {
  isCheckpointRevision, newCommit, previousRevision, writeBlockTree, writeFrontmatterBlob, writeRevision,
  type NewCommitInput, type TreeWriteContext,
} from "../store/writers.js";
import { TreeResolver } from "../store/delta.js";
import { markReachable } from "../store/gc.js";
import { evaluateRetention, retentionPolicy, type EvaluateOptions, type RetentionPlan, type RetentionPolicy } from "../store/retention.js";
import {
  archivedSummary, attachArchive, detachArchive, exportHistory, listArchives,
  type ArchiveListing, type AttachResult, type ExportOptions, type ExportResult,
} from "../store/archive.js";
import {
  changesSince, diffBlocks, diffUnified, docDiffUnified, docHistory, historyNode, reconstructAtRevision,
  type CommitDigest, type DiffEntry, type DocDiffUnified, type DocVersions, type NodeChange,
} from "../../graph/history.js";

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

  newCommit(input: NewCommitInput): { commitId: string; seq: number } {
    return newCommit(this.store.db, input);
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

  // ---- current state through history (M4, Phase 3c retires these) ----

  renderedHash(revId: string): Buffer | null {
    const row = this.store.db.prepare("SELECT rendered_hash FROM revisions WHERE rev_id = ?").get(revId) as { rendered_hash: Buffer } | undefined;
    return row?.rendered_hash ?? null;
  }

  /** The rendered hash of the revision BEFORE `revId` of the same document, or null for a first revision / an unknown one. */
  priorRenderedHash(revId: string | null): Buffer | null {
    if (revId === null) return null;
    const r = this.store.db
      .prepare("SELECT p.rendered_hash FROM revisions r JOIN revisions p ON p.doc_id = r.doc_id AND p.seq = r.seq - 1 WHERE r.rev_id = ?")
      .get(revId) as { rendered_hash: Buffer } | undefined;
    return r?.rendered_hash ?? null;
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

  changesSince(repoId: string, opts: { cursor?: number; limit?: number; origin?: string } = {}): { digests: CommitDigest[]; cursor: number; truncated: boolean; head: number } {
    return changesSince(this.store, repoId, opts);
  }

  // ---- maintenance ----

  markReachable(): { trees: Set<string>; blobs: Set<string> } {
    return markReachable(this.store);
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
