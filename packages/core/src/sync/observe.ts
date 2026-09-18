import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { ingestFile } from "../core/ingest.js";
import { makeReconcilingResolver } from "./reconciling-ingest.js";
import { hasConflictMarkers } from "./git-heuristics.js";
import { tombstoneObservedDeletion } from "./tombstone.js";
import { sweepResurrectionPool } from "../core/store/gc.js";

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
// server. Callers own their own batch orchestration — disk read vs pipe fetch,
// deletion, checkpoint rows — and the resurrection-pool sweep (once per batch).

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

/**
 * The reconcile primitive: echo-gate `content` for `path` and, when it differs
 * from the stored revision, ingest it as an observed commit (reconciling block
 * identity against the prior revision). Does NOT sweep the resurrection pool —
 * the caller does that once per batch. Does NOT write a file.
 */
export function observeOne(store: Store, repoId: string, path: string, content: string, ts: string): ObserveOneResult {
  const existing = store.db
    .prepare("SELECT doc_id, file_hash FROM docs WHERE repo_id = ? AND path = ? AND deleted_commit IS NULL")
    .get(repoId, path) as { doc_id: string; file_hash: Buffer | null } | undefined;
  const oldHashHex = existing?.file_hash?.toString("hex") ?? null;
  const diskHash = sha256(content);
  const newHashHex = diskHash.toString("hex");

  // Echo: the stored revision already equals these bytes → no commit. The
  // loop-breaker the coordinator relies on (§6): re-observing what the engine
  // already holds is a no-op.
  if (existing && existing.file_hash && existing.file_hash.equals(diskHash)) {
    return { docId: existing.doc_id, path, rev: null, commitId: null, converged: true, echo: true, conflicted: false, dispositions: [], oldHashHex, newHashHex };
  }

  const conflicted = hasConflictMarkers(content);
  const resolveIds = makeReconcilingResolver(store, repoId, { ts, path });
  const res = ingestFile(store, repoId, path, content, { ts, origin: "observed", resolveIds });
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
 *  batch form of `observeFile`; each item is echo-gated independently. */
export function observeMany(store: Store, repoId: string, items: { path: string; content: string }[], opts: { ts?: string } = {}): ObserveResult[] {
  const ts = opts.ts ?? new Date().toISOString();
  const out = items.map((it) => toPublic(observeOne(store, repoId, it.path, it.content, ts)));
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
