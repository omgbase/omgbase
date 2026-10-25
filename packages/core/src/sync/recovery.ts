import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { ingestFile } from "../core/ingest.js";
import { makeReconcilingResolver } from "./reconciling-ingest.js";
import { nodeFs, type SyncFs } from "./fs-util.js";
import { materializePending } from "../mutate/materialize.js";
import { FsDocStore, type DocStore } from "../mutate/doc-store.js";

// Crash recovery (spec/sync §4.3 "Recovery"). Since store 14.0 the api path
// commits DB-first and records each file it still owes as a pending
// materialization row (spec/store §5.7), so step 0 replays those rows — the
// recorded intent, with the commit already in history — before anything is
// compared. What remains is the pre-14.0 rule: a file whose hash ≠ its
// recorded rendered_hash (a human edit the engine never observed, a write that
// landed with no row) is reconciled through the normal observed ingest path,
// one document at a time (§9 — a block moved between two files while the
// engine was down is `deleted` + `inserted`, the pool may still resurrect it).

export interface RecoveryResult {
  /** step 0: paths whose pending materialization rows were replayed */
  materialized: string[];
  healed: string[]; // paths re-ingested
  missing: string[]; // tracked docs whose file vanished
}

export function recoverRepo(store: Store, repoId: string, rootPath: string, opts: { ts?: string; fs?: SyncFs; docStore?: DocStore } = {}): RecoveryResult {
  const fs = opts.fs ?? nodeFs;
  const materialized = materializePending(store, repoId, opts.docStore ?? new FsDocStore(rootPath));
  // seam: HistoryRecorder.renderedHash → `docs.file_hash` (Phase 3, M4; inventory-ts §2.8 row `recoverRepo` 26–60, §3.11)
  const docs = store.db
    .prepare(
      `SELECT d.doc_id, d.path, d.file_hash, r.rendered_hash
       FROM docs d LEFT JOIN revisions r ON r.rev_id = d.head
       WHERE d.repo_id = ? AND d.deleted_at IS NULL`,
    )
    .all(repoId) as { doc_id: string; path: string; file_hash: Buffer | null; rendered_hash: Buffer | null }[];

  const healed: string[] = [];
  const missing: string[] = [];
  const ts = opts.ts ?? new Date().toISOString();

  for (const doc of docs) {
    const bytes = fs.read(rootPath, doc.path);
    if (bytes === null) {
      missing.push(doc.path);
      continue;
    }
    const onDisk = sha256(bytes);
    const recorded = doc.rendered_hash ?? doc.file_hash;
    if (!recorded || !onDisk.equals(recorded)) {
      // Divergence: the file moved ahead of (or behind) the store. Re-ingest.
      ingestFile(store, repoId, doc.path, bytes, {
        ts,
        resolveIds: makeReconcilingResolver(store, repoId, { ts, path: doc.path }),
      });
      healed.push(doc.path);
    }
  }

  return { materialized, healed, missing };
}
