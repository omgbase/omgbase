import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { ingestFile } from "../core/ingest.js";
import { makeReconcilingResolver } from "./reconciling-ingest.js";
import { nodeFs, type SyncFs } from "./fs-util.js";
import { deletePending, materializePending } from "../mutate/materialize.js";
import { FsDocStore, type DocStore } from "../mutate/doc-store.js";

// Crash recovery (spec/sync §4.3 "Recovery"). Since store 14.0 the api path
// commits DB-first and records each file it still owes as a pending
// materialization row (spec/store §5.7), so step 0 replays those rows — the
// recorded intent, self-contained since 17.0 (the row's `head`, `rendered_hash`
// and `prior_hash`; no history read) — before anything is compared. What
// remains is the pre-14.0 rule: a file whose hash ≠ the document's `file_hash`
// (a human edit the engine never observed, a write that landed with no row) is
// reconciled through the normal observed ingest path, one document at a time
// (§9 — a block moved between two files while the engine was down is `deleted`
// + `inserted`, the pool may still resurrect it); a row step 0 kept for that
// path (foreign bytes) goes with the heal — the file won (spec/store §5.7 gate
// rule).

export interface RecoveryResult {
  /** step 0: paths whose pending materialization rows were replayed */
  materialized: string[];
  healed: string[]; // paths re-ingested
  missing: string[]; // tracked docs whose file vanished
}

export function recoverRepo(store: Store, repoId: string, rootPath: string, opts: { ts?: string; fs?: SyncFs; docStore?: DocStore } = {}): RecoveryResult {
  const fs = opts.fs ?? nodeFs;
  const materialized = materializePending(store, repoId, opts.docStore ?? new FsDocStore(rootPath));
  // 17.0 (M4): the convergence oracle is the document row's own `file_hash`
  // (I1/C1: the hash of the bytes its head renders to); no `revisions` read.
  const docs = store.db
    .prepare("SELECT doc_id, path, file_hash FROM docs WHERE repo_id = ? AND deleted_at IS NULL")
    .all(repoId) as { doc_id: string; path: string; file_hash: Buffer | null }[];

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
    if (!doc.file_hash || !onDisk.equals(doc.file_hash)) {
      // Divergence: the file moved ahead of (or behind) the store. Re-ingest;
      // a pending row the replay kept at this path is superseded (file wins).
      store.write((db) => {
        ingestFile(store, repoId, doc.path, bytes, {
          ts,
          resolveIds: makeReconcilingResolver(store, repoId, { ts, path: doc.path }),
        });
        deletePending(db, repoId, doc.path);
      });
      healed.push(doc.path);
    }
  }

  return { materialized, healed, missing };
}
