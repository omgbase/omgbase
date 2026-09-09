import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { ingestFile } from "../core/ingest.js";
import { makeReconcilingResolver } from "./reconciling-ingest.js";

// Crash recovery (04 §6). The write protocol is file-first: bytes are written
// (step 5) before the DB transaction (step 7). A crash between them leaves a
// file whose hash ≠ its recorded rendered_hash. On startup we reconcile every
// such file through the normal ingest path — the interrupted write is simply
// observed, healing the store with no special-case logic.

export interface RecoveryResult {
  healed: string[]; // paths re-ingested
  missing: string[]; // tracked docs whose file vanished
}

export function recoverRepo(store: Store, repoId: string, rootPath: string): RecoveryResult {
  const docs = store.db
    .prepare(
      `SELECT d.doc_id, d.path, d.file_hash, r.rendered_hash
       FROM docs d LEFT JOIN revisions r ON r.rev_id = d.current_rev
       WHERE d.repo_id = ? AND d.deleted_commit IS NULL`,
    )
    .all(repoId) as { doc_id: string; path: string; file_hash: Buffer | null; rendered_hash: Buffer | null }[];

  const healed: string[] = [];
  const missing: string[] = [];
  const ts = new Date().toISOString();

  for (const doc of docs) {
    const abs = join(rootPath, doc.path);
    if (!existsSync(abs)) {
      missing.push(doc.path);
      continue;
    }
    const onDisk = sha256(readFileSync(abs, "utf8"));
    const recorded = doc.rendered_hash ?? doc.file_hash;
    if (!recorded || !onDisk.equals(recorded)) {
      // Divergence: the file moved ahead of (or behind) the store. Re-ingest.
      ingestFile(store, repoId, doc.path, readFileSync(abs, "utf8"), {
        ts,
        resolveIds: makeReconcilingResolver(store, repoId, { ts, path: doc.path }),
      });
      healed.push(doc.path);
    }
  }

  return { healed, missing };
}
