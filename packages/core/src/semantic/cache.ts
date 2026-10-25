import type { Store } from "../core/store/store.js";
import { ctxHashHex } from "./embeddings.js";

// The vector cache's point reads (spec/search §2.3, §3): the rows `semantic()`
// scores with and the gate `blocks_resolve`/`query` apply. The one place the
// `embeddings`/`doc_embeddings` tables are read outside the worker and the
// brute-force searches; the seam (`core/capabilities/semantic.ts`) delegates.

/** A block's vector: the `embeddings` row keyed by its CURRENT `(content_hash = raw_hash, ctx_hash, model)`, or null when stale/missing. */
export function blockVectorRow(store: Store, rawHash: Buffer, ctx: string, model: string): Buffer | null {
  const row = store.db
    .prepare("SELECT vec FROM embeddings WHERE content_hash = ? AND ctx_hash = ? AND model = ?")
    .get(rawHash, Buffer.from(ctxHashHex(ctx), "hex"), model) as { vec: Buffer } | undefined;
  return row?.vec ?? null;
}

/** A document's vector: the `doc_embeddings` row for `(doc_id, model)`, or null. */
export function docVectorRow(store: Store, docId: string, model: string): Buffer | null {
  const row = store.db
    .prepare("SELECT vec FROM doc_embeddings WHERE doc_id = ? AND model = ?")
    .get(docId, model) as { vec: Buffer } | undefined;
  return row?.vec ?? null;
}

/** The gate (spec/surface §4, 3.0): has anything in the repository been embedded under `model`? */
export function anyEmbedded(store: Store, repoId: string, model: string): boolean {
  const row = store.db
    .prepare(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM doc_embeddings de JOIN docs d ON d.doc_id = de.doc_id WHERE d.repo_id = ? AND de.model = ?)
          OR EXISTS (SELECT 1 FROM embeddings WHERE model = ?)`,
    )
    .get(repoId, model, model);
  return row !== undefined;
}
