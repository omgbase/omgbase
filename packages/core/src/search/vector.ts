import type { Store } from "../core/store/store.js";
import { ctxHashHex } from "./embeddings.js";
import { buildEmbedTasks } from "./tasks.js";

// Vector search (spec/search §3). v1 uses brute-force cosine over the live
// embeddable blocks' vectors — acceptable to ~10^5 vectors (documented ceiling;
// sqlite-vec/pgvector are the pressure valve). A block's vector is the
// `embeddings` row for the requested model keyed by the block's CURRENT
// (content_hash = raw_hash, ctx_hash = sha256(ctx)) (§2.2) — the same key the
// drain writes — so a block whose context changed (a heading rename) has no
// vector until the next drain, and a stale row is cache, never a candidate
// (1.1). One candidate per block by construction.

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
  // The candidates are exactly the drain's tasks: every live embeddable block
  // with its current (content_hash, ctx). Reusing buildEmbedTasks keeps the
  // context rule in one place; its cost is one walk of the repo's blocks and
  // sections per query (fine at v1 scale, see the ceiling above).
  const tasks = buildEmbedTasks(store, repoId);
  const docPath = store.db.prepare("SELECT doc_id AS docId, path FROM blocks JOIN docs USING (doc_id) WHERE block_id = ?");
  const vecFor = store.db.prepare("SELECT vec FROM embeddings WHERE content_hash = ? AND ctx_hash = ? AND model = ?");

  const scored: VectorHit[] = [];
  for (const t of tasks) {
    const row = vecFor.get(Buffer.from(t.contentHashHex, "hex"), Buffer.from(ctxHashHex(t.ctx), "hex"), model) as { vec: Buffer } | undefined;
    if (!row) continue; // stale (§2.3): no vector until the next drain
    const meta = docPath.get(t.blockId) as { docId: string; path: string } | undefined;
    if (!meta) continue;
    const v = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4);
    scored.push({ blockId: t.blockId, docId: meta.docId, path: meta.path, cosine: cosine(queryVec, v) });
  }
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
