import type { Store } from "../core/store/store.js";
import { ingestFile } from "../core/ingest.js";
import { ensureRepo } from "../core/attach.js";
import { makeReconcilingResolver } from "./reconciling-ingest.js";
import { observeBatch, type BatchItem } from "./observe.js";
import type { SyncSource } from "./plugin.js";
import { finishCheckpoint, type FileChange, type CheckpointResult } from "./checkpoint.js";

// Source-agnostic reconciliation driver (sync-plugins §5, §10). One loop for
// every EXTERNAL source: fetch each changed member through the SyncSource (a pipe
// to an adapter process), engine-hash the bytes for the authoritative echo gate,
// and reconcile+commit non-echoes as one checkpoint. Everything here is
// engine-owned; the adapter only transports bytes and reports membership. Async
// because every source call crosses a process boundary (13 §9). The in-process
// filesystem fast-path (checkpoint.ts) mirrors this loop synchronously.

export type { FileChange, CheckpointResult };

/**
 * Reconcile a batch of changed members against a repo as one checkpoint.
 * `source.fetch(path)` supplies current bytes (or null = left the scope). The
 * engine hashes the bytes itself: a hash equal to the stored file_hash is an
 * echo (no commit); otherwise the member is ingested as an observed commit; a
 * member that left the scope tombstones its live doc (drop FTS, tombstone
 * blocks + doc, pool blocks) so it stops being served. Every member is fetched
 * first, then the whole batch goes through `observeBatch` — the one
 * implementation of echo gate + identity threading + conflict flagging (D2),
 * including the cross-document move phase over the batch — so a live watcher
 * batch that cuts a block from one member and pastes it into another keeps the
 * id. (v1 sources are identity-inferred; borne identity is deferred, ADR-010/D4.)
 */
export async function reconcileChanges(
  store: Store,
  repoId: string,
  source: SyncSource,
  changes: FileChange[],
  opts: { ts?: string; gitHead?: string | null } = {},
): Promise<CheckpointResult> {
  const ts = opts.ts ?? new Date().toISOString();
  const items: BatchItem[] = [];
  for (const change of changes) {
    const item = await source.fetch(change.path);
    items.push({ path: change.path, content: item === null ? null : item.content });
  }
  return finishCheckpoint(store, repoId, observeBatch(store, repoId, items, ts), { ts, gitHead: opts.gitHead ?? null });
}

export interface AttachResult {
  repoId: string;
  fileCount: number;
  allConverged: boolean;
}

/**
 * Attach a source scope as a repo: create/reuse the repo row, then ingest every
 * member the source enumerates (identity-inferred sources thread the reconciling
 * resolver so edges + identity are established on the initial walk).
 */
export async function attachSource(
  store: Store,
  slug: string,
  rootPath: string | null,
  source: SyncSource,
): Promise<AttachResult> {
  const repoId = ensureRepo(store, slug, rootPath);
  const inferred = source.capabilities().identity === "inferred";
  const ts = new Date().toISOString();
  let fileCount = 0;
  let allConverged = true;
  for (const entry of await source.enumerate()) {
    const item = await source.fetch(entry.path);
    if (!item) continue;
    const res = ingestFile(store, repoId, entry.path, item.content, {
      ts,
      ...(inferred ? { resolveIds: makeReconcilingResolver(store, repoId, { ts, path: entry.path }) } : {}),
    });
    fileCount++;
    if (!res.converged) allConverged = false;
  }
  return { repoId, fileCount, allConverged };
}
