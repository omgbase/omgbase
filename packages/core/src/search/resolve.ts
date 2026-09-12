import type { Store } from "../core/store/store.js";
import { hybridSearch, type HybridInput } from "./rrf.js";

// resolve (05 §7, 06 §3): hybrid search specialized for "give me the ID of the
// thing I mean".

export interface ResolveHit {
  id: string;
  locator: string;
  preview: string;
  evidence: unknown;
}

function locatorFor(store: Store, blockId: string): string {
  const row = store.db.prepare(
    "SELECT d.path AS path, b.ordinal AS ordinal, b.type AS type FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ?",
  ).get(blockId) as { path: string; ordinal: number; type: string } | undefined;
  if (!row) return blockId;
  return `${row.path}#${row.type}[${row.ordinal}]`;
}
function previewFor(store: Store, blockId: string, words = 12): string {
  const row = store.db.prepare("SELECT text FROM blocks WHERE block_id = ?").get(blockId) as { text: string } | undefined;
  if (!row) return "";
  const w = row.text.split(/\s+/).filter(Boolean);
  return w.length <= words ? w.join(" ") : w.slice(0, words).join(" ") + "…";
}

export interface ResolveInput {
  repoId: string;
  query: string;
  vector?: { model: string; vec: Float32Array };
  limit?: number;
}

/** resolve: ranked candidates for the thing the caller means. */
export function resolve(store: Store, input: ResolveInput): ResolveHit[] {
  const hi: HybridInput = { repoId: input.repoId, text: input.query, limit: input.limit ?? 10 };
  if (input.vector) hi.vector = input.vector;
  const hits = hybridSearch(store, hi);
  return hits.map((h) => ({ id: h.blockId, locator: locatorFor(store, h.blockId), preview: previewFor(store, h.blockId), evidence: h.evidence }));
}
