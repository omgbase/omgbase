import type { Store } from "../core/store/store.js";
import { mintId } from "../core/ids.js";
import { ingestFile } from "../core/ingest.js";
import { ensureRepo } from "../core/attach.js";
import { makeReconcilingResolver } from "./reconciling-ingest.js";
import { observeOne } from "./observe.js";
import { sweepResurrectionPool } from "../core/store/gc.js";
import { tombstoneObservedDeletion } from "./tombstone.js";
import type { SyncSource } from "./plugin.js";
import type { FileChange, CheckpointResult } from "./checkpoint.js";

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
 * echo (no commit); otherwise the member is ingested as an observed commit.
 */
export async function reconcileChanges(
  store: Store,
  repoId: string,
  source: SyncSource,
  changes: FileChange[],
  opts: { ts?: string; gitHead?: string | null } = {},
): Promise<CheckpointResult> {
  const ts = opts.ts ?? new Date().toISOString();
  const checkpointId = mintId("cp");
  const ingested: string[] = [];
  const suppressed: string[] = [];
  const deleted: string[] = [];
  const conflicted: string[] = [];
  const fileEntries: [string, string | null, string | null][] = [];

  for (const change of changes) {
    const item = await source.fetch(change.path);
    if (item === null) {
      // Member left the source scope (deleted/moved out): tombstone the live doc
      // (drop FTS, tombstone blocks + doc, pool blocks) so it stops being served.
      const existing = store.db
        .prepare("SELECT doc_id, file_hash FROM docs WHERE repo_id = ? AND path = ? AND deleted_commit IS NULL")
        .get(repoId, change.path) as { doc_id: string; file_hash: Buffer | null } | undefined;
      if (existing) {
        tombstoneObservedDeletion(store, repoId, existing.doc_id, ts);
        deleted.push(change.path);
      }
      fileEntries.push([change.path, existing?.file_hash?.toString("hex") ?? null, null]);
      continue;
    }

    // Reconcile the fetched bytes through the shared observe primitive — the one
    // implementation of echo gate + identity threading + conflict flagging (D2).
    // (v1 sources are identity-inferred; borne identity is deferred, ADR-010/D4.)
    const r = observeOne(store, repoId, change.path, item.content, ts);
    if (r.echo) suppressed.push(change.path);
    else if (r.conflicted) conflicted.push(change.path);
    else ingested.push(change.path);
    fileEntries.push([change.path, r.oldHashHex, r.newHashHex]);
  }

  store.db
    .prepare("INSERT INTO checkpoints (id, repo_id, ts, files, git_head) VALUES (?, ?, ?, ?, ?)")
    .run(checkpointId, repoId, ts, JSON.stringify(fileEntries), opts.gitHead ?? null);

  sweepResurrectionPool(store, ts);

  return { checkpointId, ingested, suppressed, deleted, conflicted };
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
