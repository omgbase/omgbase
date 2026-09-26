import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { ingestFile } from "../core/ingest.js";
import { makeReconcilingResolver, prepareReconcile, loadOldMatchBlocks, loadPool, type PreparedReconcile } from "./reconciling-ingest.js";
import { hasConflictMarkers } from "./git-heuristics.js";
import { tombstoneObservedDeletion } from "./tombstone.js";
import { sweepResurrectionPool } from "../core/store/gc.js";
import { crossDocMatch, applyCrossDocMatches, type PerDocUnmatched } from "../reconcile/crossdoc.js";
import type { DocReconcileResult } from "../reconcile/reconcile.js";
import { DEFAULT_CONFIG, type MatchBlock, type ReconcileConfig } from "../reconcile/types.js";

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

/** Outcome of one batch member: an observation (echo or commit) or a deletion. */
export type BatchOutcome =
  | ({ kind: "observed" } & ObserveOneResult)
  | {
      kind: "deleted";
      path: string;
      /** the tombstoned doc, or null when no live doc existed at `path` (no-op). */
      docId: string | null;
      oldHashHex: string | null;
    };

// Pass-1 state per non-echo member.
type Pending =
  | { kind: "echo"; outcome: BatchOutcome }
  | { kind: "gone"; path: string; docId: string | null; oldHashHex: string | null; oldBlocks: MatchBlock[]; result: DocReconcileResult | null }
  | { kind: "ingest"; prepared: PreparedReconcile; oldHashHex: string | null; newHashHex: string };

/**
 * The batch reconcile primitive — one checkpoint's worth of members, in order.
 * Two passes with the cross-document phase between them (reconciliation-spec §8):
 *
 *   1. every member is echo-gated and, when it differs from the stored revision,
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
  const liveDoc = db.prepare("SELECT doc_id, file_hash FROM docs WHERE repo_id = ? AND path = ? AND deleted_commit IS NULL");

  // ---- pass 1: echo gate + reconcile, no commits -------------------------------
  const pool = loadPool(db, repoId, ts);
  const consumed = new Set<string>();
  const pending: Pending[] = [];
  for (const it of items) {
    const existing = liveDoc.get(repoId, it.path) as { doc_id: string; file_hash: Buffer | null } | undefined;
    const oldHashHex = existing?.file_hash?.toString("hex") ?? null;

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
      pending.push({
        kind: "echo",
        outcome: { kind: "observed", docId: existing.doc_id, path: it.path, rev: null, commitId: null, converged: true, echo: true, conflicted: false, dispositions: [], oldHashHex, newHashHex },
      });
      continue;
    }

    const prepared = prepareReconcile(store, repoId, it.path, it.content, { ts, config, pool, consumed });
    pending.push({ kind: "ingest", prepared, oldHashHex, newHashHex });
  }

  // ---- cross-document phase (spec/reconcile §7) --------------------------------
  if (pending.length > 1) crossDocPhase(pending, config);

  // ---- pass 2: commit, in batch order ------------------------------------------
  const out: BatchOutcome[] = [];
  for (const p of pending) {
    if (p.kind === "echo") {
      out.push(p.outcome);
    } else if (p.kind === "gone") {
      if (p.docId) tombstoneObservedDeletion(store, repoId, p.docId, ts);
      out.push({ kind: "deleted", path: p.path, docId: p.docId, oldHashHex: p.oldHashHex });
    } else {
      out.push({ kind: "observed", ...commitPrepared(store, repoId, p.prepared, ts, p.oldHashHex, p.newHashHex) });
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
// revision (one transaction), flag conflict markers, summarize dispositions.
function commitPrepared(store: Store, repoId: string, prepared: PreparedReconcile, ts: string, oldHashHex: string | null, newHashHex: string): ObserveOneResult {
  const { path, content } = prepared;
  const conflicted = hasConflictMarkers(content);
  const resolveIds = makeReconcilingResolver(store, repoId, { ts, path, prepared });
  const res = ingestFile(store, repoId, path, content, { ts, origin: "observed", resolveIds, parsed: prepared.tree });
  store.db.prepare("UPDATE docs SET conflicted = ? WHERE repo_id = ? AND path = ?").run(conflicted ? 1 : 0, repoId, path);

  const rows = store.db
    .prepare("SELECT kind, count(*) n FROM dispositions WHERE commit_id = ? GROUP BY kind ORDER BY kind")
    .all(res.commitId) as { kind: string; n: number }[];

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
  const existing = store.db
    .prepare("SELECT doc_id FROM docs WHERE repo_id = ? AND path = ? AND deleted_commit IS NULL")
    .get(repoId, path) as { doc_id: string } | undefined;
  if (!existing) return { docId: null, path, deleted: false };
  tombstoneObservedDeletion(store, repoId, existing.doc_id, ts);
  sweepResurrectionPool(store, ts);
  return { docId: existing.doc_id, path, deleted: true };
}
