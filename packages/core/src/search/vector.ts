import type { Store } from "../core/store/store.js";

// Vector search (05 §5, 02 §4). v1 uses brute-force cosine over the embeddings
// cache joined to current blocks — acceptable to ~10^5 vectors (documented
// ceiling; sqlite-vec/pgvector are the pressure valve). The embeddings table is
// keyed by content_hash, so we join blocks.raw_hash = embeddings.content_hash
// and keep only rows for the requested model.

export interface VectorHit {
  blockId: string;
  docId: string;
  path: string;
  cosine: number;
}

export interface DocVectorHit {
  docId: string;
  path: string;
  cosine: number;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function vectorSearch(store: Store, repoId: string, model: string, queryVec: Float32Array, opts: { limit?: number } = {}): VectorHit[] {
  const limit = opts.limit ?? 50;
  const rows = store.db
    .prepare(
      `SELECT b.block_id AS blockId, b.doc_id AS docId, d.path AS path, e.vec AS vec
       FROM embeddings e
       JOIN blocks b ON b.raw_hash = e.content_hash AND b.deleted_commit IS NULL
       JOIN docs d ON d.doc_id = b.doc_id
       WHERE b.repo_id = ? AND e.model = ?`,
    )
    .all(repoId, model) as { blockId: string; docId: string; path: string; vec: Buffer }[];

  // One hit per live block (spec/search §3). Several cache rows can join to the
  // same block — a stale ctx row survives a heading rename next to the fresh one
  // — and the block keeps its best cosine, not one hit per row.
  const best = new Map<string, VectorHit>();
  for (const r of rows) {
    const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
    const c = cosine(queryVec, v);
    const prev = best.get(r.blockId);
    if (!prev || c > prev.cosine) best.set(r.blockId, { blockId: r.blockId, docId: r.docId, path: r.path, cosine: c });
  }
  const scored = [...best.values()];
  scored.sort((a, b) => b.cosine - a.cosine || (a.blockId < b.blockId ? -1 : 1));
  return scored.slice(0, limit);
}

// Doc-grain vector search (doc semantic retrieval). Brute-force cosine over the
// doc_embeddings cache joined to live docs — one vector per document, so results
// are ranked whole documents (mrplex-parity), never multiple blocks of the same
// file. Keyed by doc_id (not content_hash), so we join doc_embeddings.doc_id =
// docs.doc_id and keep only rows for the requested model.
export function docVectorSearch(store: Store, repoId: string, model: string, queryVec: Float32Array, opts: { limit?: number } = {}): DocVectorHit[] {
  const limit = opts.limit ?? 50;
  const rows = store.db
    .prepare(
      `SELECT d.doc_id AS docId, d.path AS path, e.vec AS vec
       FROM doc_embeddings e
       JOIN docs d ON d.doc_id = e.doc_id AND d.deleted_commit IS NULL
       WHERE d.repo_id = ? AND e.model = ?`,
    )
    .all(repoId, model) as { docId: string; path: string; vec: Buffer }[];

  // (doc_id, model) is the primary key, so this is one row per doc already;
  // keep the best-cosine rule for symmetry with vectorSearch.
  const best = new Map<string, DocVectorHit>();
  for (const r of rows) {
    const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
    const c = cosine(queryVec, v);
    const prev = best.get(r.docId);
    if (!prev || c > prev.cosine) best.set(r.docId, { docId: r.docId, path: r.path, cosine: c });
  }
  const scored = [...best.values()];
  scored.sort((a, b) => b.cosine - a.cosine || (a.docId < b.docId ? -1 : 1));
  return scored.slice(0, limit);
}
