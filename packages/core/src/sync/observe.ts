import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { ingestFile } from "../core/ingest.js";
import { makeReconcilingResolver, prepareReconcile, loadOldMatchBlocks, loadPool, type PreparedReconcile } from "./reconciling-ingest.js";
import { hasConflictMarkers } from "./git-heuristics.js";
import { tombstoneObservedDeletion } from "./tombstone.js";
import { CaptureFailed } from "../core/capabilities/errors.js";
import { raiseCaptureFailed, requireWriter } from "../core/store/manifest.js";
import { sweepResurrectionPool } from "../core/store/gc.js";
import { crossDocMatch, applyCrossDocMatches, type PerDocUnmatched } from "../reconcile/crossdoc.js";
import type { DocReconcileResult } from "../reconcile/reconcile.js";
import { DEFAULT_CONFIG, type MatchBlock, type ReconcileConfig } from "../reconcile/types.js";
import { deletePending, readPending } from "../mutate/materialize.js";

// Observe (ADR-014 §7, D2): the SINGLE reconcile primitive. "Given the current
// authoritative bytes for a path, echo-gate + reconcile identity + commit as an
// observed revision." Every path funnels through `observeOne`:
//   • the MCP `observe` tool (single) and `observe_many` (batch) — file→DB over
//     the wire for @omgbase/sync;
//   • the local filesystem checkpoint (sync/checkpoint.ts, disk bytes);
//   • the external-source driver (sync/driver.ts, adapter bytes).
// One implementation of the echo/conflict/reconcile algorithm means those paths
// cannot drift (the pre-ADR-014 risk was two near-duplicate copies). It never
// writes a file (file→DB direction), so it works on a headless/sourceless
// server. Callers own their bytes (disk read vs pipe fetch) and their checkpoint
// rows; `observeBatch` owns the batch itself — the two-pass checkpoint with the
// cross-document move phase in between (reconciliation-spec §8, spec/reconcile
// §7) — and the resurrection-pool sweep is the caller's, once per batch.

export interface ObserveResult {
  docId: string;
  path: string;
  /** null on an echo (bytes already matched the stored revision — no commit). */
  rev: string | null;
  commitId: string | null;
  /** convergence: sha256(bytes) === the committed revision's rendered_hash. */
  converged: boolean;
  /** true when the bytes already matched the stored revision (no new commit). */
  echo: boolean;
  /** true when the bytes carry git conflict markers (doc flagged conflicted). */
  conflicted: boolean;
  /** disposition kind → count for the commit this observation produced. */
  dispositions: { kind: string; count: number }[];
}

/** `observeOne` plus the change-tracking hashes batch callers need for their
 *  checkpoint file-entries: the prior `file_hash` and the new bytes' hash. */
export interface ObserveOneResult extends ObserveResult {
  /** prior stored file_hash (hex), or null if the doc was new/absent. */
  oldHashHex: string | null;
  /** sha256(content) (hex) — the new file hash. */
  newHashHex: string;
}

/** One member of a batch: its current bytes, or `null` when it left the source
 *  scope (deleted on disk / adapter fetch returned null). */
export interface BatchItem {
  path: string;
  content: string | null;
}

/** Outcome of one batch member: an observation (echo or commit), a deletion, or (Phase 4a) a member rolled back because its capture failed. */
export type BatchOutcome =
  | ({ kind: "observed" } & ObserveOneResult)
  | {
      kind: "deleted";
      path: string;
      /** the tombstoned doc, or null when no live doc existed at `path` (no-op). */
      docId: string | null;
      /** the tombstone's commit (17.0, 3d — the feed row), or null for a no-op. */
      commitId: string | null;
      oldHashHex: string | null;
    }
  | {
      /** spec/store §5.4 step 15 (resolution 18): the recorder threw inside the member's transaction — nothing of the member landed, the `capture_failed` alert is raised, the next sweep retries it. */
      kind: "failed";
      path: string;
      /** the live doc at the path before the attempt, or null for a new path. */
      docId: string | null;
      commitId: null;
      error: string;
    };

// Pass-1 state per non-echo member. `clearPending`: the member's bytes
// superseded an api intent still pending at its path (spec/store §5.7) — the
// row goes in the member's transaction.
type Pending =
  | { kind: "echo"; outcome: BatchOutcome }
  | { kind: "gone"; path: string; docId: string | null; oldHashHex: string | null; oldBlocks: MatchBlock[]; result: DocReconcileResult | null }
  | { kind: "ingest"; prepared: PreparedReconcile; oldHashHex: string | null; newHashHex: string; clearPending: boolean };

/**
 * The batch reconcile primitive — one checkpoint's worth of members, in order.
 * Two passes with the cross-document phase between them (reconciliation-spec §8):
 *
 *   1. every member is gated against a pending materialization row at its path
 *      (spec/store §5.7: the bytes the api path owes confirm the row, an absent
 *      file is not a deletion, anything else lets the file win), echo-gated and,
 *      when it differs from the stored revision,
 *      parsed + reconciled against its own prior tree WITHOUT committing
 *      (`prepareReconcile`; members gone from the source contribute their whole
 *      live tree as deleted). All members see one resurrection-pool snapshot with
 *      a shared consumed-set, so no pooled id resurrects twice in a batch.
 *   2. the per-doc leftovers are pooled — deleted old blocks × inserted new
 *      blocks, across documents only — and matched at theta_xdoc
 *      (`crossDocMatch`). Each accepted pair is applied to both results: the
 *      destination's minted id becomes the carried id (`moved`/`edited_moved`,
 *      `detail.fromDoc`), the source's `deleted` disposition and pool entry for
 *      it vanish (`applyCrossDocMatches`).
 *   3. every member commits, in batch order, each in its own transaction:
 *      `ingestFile` with the finished result (a carried-in id evicts the row the
 *      source doc may still hold — see `IdResolver.crossDocIds` — so the order
 *      of A and B in the batch does not matter), or `tombstoneObservedDeletion`.
 *
 * A moved block is therefore never `deleted` + `inserted`, never pooled, and
 * never `resurrected` inside one batch. Across batches the pool still does that
 * job (spec/reconcile §5 phase 6b). Does NOT sweep the pool — the caller does,
 * once per batch. Does NOT write a file.
 */
export function observeBatch(
  store: Store,
  repoId: string,
  items: BatchItem[],
  ts: string,
  opts: { config?: ReconcileConfig } = {},
): BatchOutcome[] {
  const db = store.db;
  const config = opts.config ?? DEFAULT_CONFIG;
  const liveDoc = db.prepare("SELECT doc_id, file_hash FROM docs WHERE repo_id = ? AND path = ? AND deleted_at IS NULL");

  // ---- pass 1: echo gate + reconcile, no commits -------------------------------
  const pool = loadPool(db, repoId, ts);
  const consumed = new Set<string>();
  const pending: Pending[] = [];
  for (const it of items) {
    const existing = liveDoc.get(repoId, it.path) as { doc_id: string; file_hash: Buffer | null } | undefined;
    const oldHashHex = existing?.file_hash?.toString("hex") ?? null;

    // The materialization gate (spec/store §5.7): an api commit still owes this
    // path a file. The observation decides what the row meant for the disk —
    // the bytes it named confirm it (echo; a `remove` row stays until the file
    // is gone), an absent file is NOT a deletion (the materializer still owes
    // it; `remove` rows are confirmed by the absence), anything else is a later
    // human edit and the file wins: the normal reconciling ingest below, the
    // row dropped with it.
    const owed = readPending(db, repoId, it.path);
    if (owed && it.content === null) {
      if (owed.kind === "remove") deletePending(db, repoId, it.path);
      else {
        pending.push({ kind: "echo", outcome: { kind: "deleted", path: it.path, docId: null, commitId: null, oldHashHex } });
        continue;
      }
    } else if (owed && sha256(it.content!).equals(owed.renderedHash)) {
      if (owed.kind !== "remove") deletePending(db, repoId, it.path);
      pending.push({
        kind: "echo",
        outcome: { kind: "observed", docId: owed.docId, path: it.path, rev: null, commitId: null, converged: true, echo: true, conflicted: false, dispositions: [], oldHashHex, newHashHex: sha256(it.content!).toString("hex") },
      });
      continue;
    }

    if (it.content === null) {
      const oldBlocks = existing ? loadOldMatchBlocks(db, existing.doc_id) : [];
      const result: DocReconcileResult | null = existing
        ? { assignment: new Map(), dispositions: [], deleted: oldBlocks.map((b) => b.blockId!), consumedPool: [] }
        : null;
      pending.push({ kind: "gone", path: it.path, docId: existing?.doc_id ?? null, oldHashHex, oldBlocks, result });
      continue;
    }

    const diskHash = sha256(it.content);
    const newHashHex = diskHash.toString("hex");
    // Echo: the stored revision already equals these bytes → no commit. The
    // loop-breaker the coordinator relies on (§6): re-observing what the engine
    // already holds is a no-op.
    if (existing && existing.file_hash && existing.file_hash.equals(diskHash)) {
      // (A row that names other bytes than the file the database already
      // agrees with is stale either way; the observation settles it.)
      if (owed) deletePending(db, repoId, it.path);
      pending.push({
        kind: "echo",
        outcome: { kind: "observed", docId: existing.doc_id, path: it.path, rev: null, commitId: null, converged: true, echo: true, conflicted: false, dispositions: [], oldHashHex, newHashHex },
      });
      continue;
    }

    const prepared = prepareReconcile(store, repoId, it.path, it.content, { ts, config, pool, consumed });
    pending.push({ kind: "ingest", prepared, oldHashHex, newHashHex, clearPending: owed !== null });
  }

  // ---- cross-document phase (spec/reconcile §7) --------------------------------
  if (pending.length > 1) crossDocPhase(pending, config);

  // ---- pass 2: commit, in batch order ------------------------------------------
  // The batch id (spec/store §5.4 step 5, D4): the first committing member's
  // commit id; every later member's feed row carries it. An echo commits
  // nothing and names none.
  // spec/store §5.4 step 0 (resolution 17), once for the batch and OUTSIDE any
  // transaction, so the `writer_refused` alert survives the refusal: a writer
  // without the history module on a repository that requires capture commits
  // nothing (the echoes above wrote nothing either — pass 1 only reads).
  if (pending.some((p) => p.kind !== "echo")) requireWriter(db, repoId, ts);
  const out: BatchOutcome[] = [];
  const batch: { id: string | null } = { id: null };
  const joined = (commitId: string | null): void => {
    if (batch.id === null && commitId !== null) batch.id = commitId;
  };
  // A member whose capture threw (step 15, resolution 18): its transaction
  // rolled back with the throw, so nothing of it landed; the alert is raised
  // here, after the rollback, and the batch goes on — the member stays a
  // candidate for the next sweep (its stat is not recorded).
  const failed = (path: string, docId: string | null, e: CaptureFailed): void => {
    raiseCaptureFailed(db, repoId, e.at(path), ts);
    out.push({ kind: "failed", path, docId, commitId: null, error: e.message });
  };
  for (const p of pending) {
    if (p.kind === "echo") {
      out.push(p.outcome);
      continue;
    }
    try {
      if (p.kind === "gone") {
        const commitId = p.docId ? tombstoneObservedDeletion(store, repoId, p.docId, ts, batch.id) : null;
        joined(commitId);
        out.push({ kind: "deleted", path: p.path, docId: p.docId, commitId, oldHashHex: p.oldHashHex });
      } else if (p.clearPending) {
        // File wins (spec/store §5.7): the pending row and the observed commit
        // that supersedes it go together.
        const r = store.write((db) => {
          const r = commitPrepared(store, repoId, p.prepared, ts, p.oldHashHex, p.newHashHex, batch.id);
          deletePending(db, repoId, p.prepared.path);
          return r;
        });
        joined(r.commitId);
        out.push({ kind: "observed", ...r });
      } else {
        const r = commitPrepared(store, repoId, p.prepared, ts, p.oldHashHex, p.newHashHex, batch.id);
        joined(r.commitId);
        out.push({ kind: "observed", ...r });
      }
    } catch (e) {
      if (!(e instanceof CaptureFailed)) throw e;
      failed(p.kind === "gone" ? p.path : p.prepared.path, p.kind === "gone" ? p.docId : p.prepared.docId, e);
    }
  }
  return out;
}

// Pool each reconciled member's leftovers (README §7: deleted = old blocks whose
// ids are in `deleted`, in that order; inserted = new blocks whose disposition
// is `inserted`, with the minted id, in disposition order), match across
// documents, and apply. Members are keyed by doc id; a brand-new path has none
// yet, so it is keyed by path — it can only ever be a destination, and
// `detail.fromDoc` is always a real doc id.
function crossDocPhase(pending: Pending[], config: ReconcileConfig): void {
  const docs: PerDocUnmatched[] = [];
  const results = new Map<string, DocReconcileResult>();
  const prepared = new Map<string, PreparedReconcile>();
  for (const p of pending) {
    if (p.kind === "echo") continue;
    if (p.kind === "gone") {
      if (!p.docId || !p.result) continue;
      docs.push({ docId: p.docId, deleted: p.oldBlocks.map((block) => ({ block })), inserted: [] });
      results.set(p.docId, p.result);
      continue;
    }
    const key = p.prepared.docId ?? `new:${p.prepared.path}`;
    const oldById = new Map(p.prepared.oldBlocks.map((b) => [b.blockId!, b]));
    const newByKey = new Map(p.prepared.newBlocks.map((b) => [b.key, b]));
    const keyOfId = new Map<string, string>();
    for (const [k, id] of p.prepared.result.assignment) keyOfId.set(id, k);
    const deleted: PerDocUnmatched["deleted"] = [];
    for (const id of p.prepared.result.deleted) {
      const block = oldById.get(id);
      if (block) deleted.push({ block });
    }
    const inserted: PerDocUnmatched["inserted"] = [];
    for (const d of p.prepared.result.dispositions) {
      if (d.kind !== "inserted") continue;
      const k = keyOfId.get(d.blockId);
      const block = k ? newByKey.get(k) : undefined;
      if (block) inserted.push({ block, mintedId: d.blockId });
    }
    docs.push({ docId: key, deleted, inserted });
    results.set(key, p.prepared.result);
    prepared.set(key, p.prepared);
  }
  if (docs.length < 2) return;

  const matches = crossDocMatch(docs, config);
  if (matches.length === 0) return;
  applyCrossDocMatches(results, matches, config.matcherV);
  for (const m of matches) prepared.get(m.toDoc)?.crossDocIds.push(m.carriedId);
}

// Pass 2 for one reconciled member: commit the finished result as an observed
// revision — ONE transaction, the conflict-marker flag written inside it with
// the revision pointers (spec/store §5.4 step 14) — then summarize dispositions.
function commitPrepared(store: Store, repoId: string, prepared: PreparedReconcile, ts: string, oldHashHex: string | null, newHashHex: string, batchId: string | null): ObserveOneResult {
  const { path, content } = prepared;
  const conflicted = hasConflictMarkers(content);
  const resolveIds = makeReconcilingResolver(store, repoId, { ts, path, prepared });
  const res = ingestFile(store, repoId, path, content, { ts, origin: "observed", resolveIds, parsed: prepared.tree, conflicted, batchId });

  // The outcome counts every verdict the matcher produced, `same` included —
  // it describes what the matcher saw; the `dispositions` table describes
  // what changed (spec/store §5.4 step 10, 14.2: `same` is not persisted), so
  // the counts come from the in-memory result, not the table. Kinds in
  // bytewise order, as the table query listed them through 14.1.
  const counts = new Map<string, number>();
  for (const d of prepared.result.dispositions) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
  const rows = [...counts].map(([kind, n]) => ({ kind, n })).sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  return {
    docId: res.docId,
    path,
    rev: res.revId,
    commitId: res.commitId,
    converged: res.converged,
    echo: false,
    conflicted,
    dispositions: rows.map((r) => ({ kind: r.kind, count: r.n })),
    oldHashHex,
    newHashHex,
  };
}

/**
 * The single-member reconcile primitive: echo-gate `content` for `path` and,
 * when it differs from the stored revision, ingest it as an observed commit
 * (reconciling block identity against the prior revision). A batch of one — so
 * no cross-document matching; use `observeBatch` for that. Does NOT sweep the
 * resurrection pool — the caller does that once per batch. Does NOT write a file.
 */
export function observeOne(store: Store, repoId: string, path: string, content: string, ts: string): ObserveOneResult {
  const [outcome] = observeBatch(store, repoId, [{ path, content }], ts);
  if (!outcome || outcome.kind !== "observed") throw new Error(`observeOne: unexpected outcome for ${path}`);
  const { kind: _k, ...rest } = outcome;
  return rest;
}

function toPublic(r: ObserveOneResult): ObserveResult {
  const { oldHashHex: _o, newHashHex: _n, ...pub } = r;
  return pub;
}

/** Observe one file's authoritative bytes as an observed commit (echo-suppressed). */
export function observeFile(store: Store, repoId: string, path: string, content: string, opts: { ts?: string } = {}): ObserveResult {
  const ts = opts.ts ?? new Date().toISOString();
  const r = observeOne(store, repoId, path, content, ts);
  sweepResurrectionPool(store, ts);
  return toPublic(r);
}

/** Observe a batch of files under one timestamp + one resurrection sweep. The
 *  batch form of `observeFile`; each item is echo-gated independently, and a
 *  block cut from one file and pasted into another in the same batch keeps its
 *  id (`moved`/`edited_moved`) via the cross-document phase of `observeBatch`. */
export function observeMany(store: Store, repoId: string, items: { path: string; content: string }[], opts: { ts?: string } = {}): ObserveResult[] {
  const ts = opts.ts ?? new Date().toISOString();
  const out = observeBatch(store, repoId, items, ts).map((o) => {
    if (o.kind !== "observed") throw new Error(`observeMany: unexpected outcome for ${o.path}`);
    const { kind: _k, ...rest } = o;
    return toPublic(rest);
  });
  sweepResurrectionPool(store, ts);
  return out;
}

export interface ObserveDeleteResult {
  docId: string | null;
  path: string;
  /** true when a live doc existed at `path` and was tombstoned. */
  deleted: boolean;
}

/**
 * Observe that `path` left the source scope: tombstone the live doc as an
 * OBSERVED deletion (blocks pooled for resurrection; no file removed — the file
 * is already gone from the source). The deletion counterpart to `observeFile`,
 * for a synchronizer mirroring an external delete. Idempotent: a path with no
 * live doc is a no-op (`deleted:false`). Distinct from `docs_delete`, which is
 * an api-origin, intentional, non-pooled removal that also unlinks the file.
 */
export function observeDelete(store: Store, repoId: string, path: string, opts: { ts?: string } = {}): ObserveDeleteResult {
  const ts = opts.ts ?? new Date().toISOString();
  // The §5.7 gate for a gone member: a path the api path still owes a `write`
  // or `rename` is not tombstoned (the materializer owes the file); a `remove`
  // row is confirmed by the absence.
  const owed = readPending(store.db, repoId, path);
  if (owed) {
    if (owed.kind !== "remove") return { docId: null, path, deleted: false };
    deletePending(store.db, repoId, path);
  }
  const existing = store.db
    .prepare("SELECT doc_id FROM docs WHERE repo_id = ? AND path = ? AND deleted_at IS NULL")
    .get(repoId, path) as { doc_id: string } | undefined;
  if (!existing) return { docId: null, path, deleted: false };
  tombstoneObservedDeletion(store, repoId, existing.doc_id, ts);
  sweepResurrectionPool(store, ts);
  return { docId: existing.doc_id, path, deleted: true };
}

/** The batch's id (spec/store §5.4 step 5, D4): the first committing member's commit id, or null when nothing committed. */
export function batchIdOf(outcomes: readonly BatchOutcome[]): string | null {
  for (const o of outcomes) if (o.commitId !== null) return o.commitId;
  return null;
}
