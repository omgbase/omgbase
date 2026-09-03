import type { Store } from "../core/store/store.js";
import { textSearch } from "./text.js";
import { vectorSearch } from "./vector.js";

// Hybrid retrieval & ranking (05 §5). Reciprocal-rank fusion of the FTS and
// vector rankers, then explainable multiplicative boosts. Every hit carries its
// evidence (ranks, cosine, boost breakdown). No learned ranker (ADR-009).

const RRF_K = 60;

export interface Boosts {
  title?: number;
  heading?: number;
  path?: number;
  layer?: number;
  recency?: number;
}

export interface HybridHit {
  blockId: string;
  docId: string;
  path: string;
  score: number;
  evidence: {
    ftsRank?: number;
    vectorRank?: number;
    cosine?: number;
    rrf: number;
    boosts: Boosts;
  };
}

export interface HybridInput {
  repoId: string;
  /** FTS query string (optional). */
  text?: string;
  /** query vector + model for the vector ranker (optional). */
  vector?: { model: string; vec: Float32Array };
  /** raw terms for boost matching (title/heading/path). */
  terms?: string[];
  limit?: number;
}

const LAYER_BOOST: Record<string, number> = { canon: 1.3, working: 1.15, proposed: 1.0, draft: 0.85 };

function computeBoosts(store: Store, docId: string, blockId: string, terms: string[]): Boosts {
  const boosts: Boosts = {};
  const doc = store.db.prepare("SELECT path, frontmatter FROM documents WHERE doc_id = ?").get(docId) as { path: string; frontmatter: string } | undefined;
  if (!doc) return boosts;
  const fm = JSON.parse(doc.frontmatter) as Record<string, unknown>;
  const lowerTerms = terms.map((t) => t.toLowerCase()).filter(Boolean);

  // title match (frontmatter title or first heading text)
  const title = String(fm.title ?? "").toLowerCase();
  if (title && lowerTerms.some((t) => title.includes(t))) boosts.title = 1.25;

  // heading-chain match: any ancestor section heading contains a term
  const headings = store.db.prepare(
    `SELECT hb.text FROM sections s JOIN blocks hb ON hb.block_id = s.heading_block
     JOIN blocks b ON b.doc_id = s.doc_id AND b.ordinal BETWEEN s.first_ordinal AND s.last_ordinal
     WHERE b.block_id = ?`,
  ).all(blockId) as { text: string }[];
  if (headings.some((h) => lowerTerms.some((t) => h.text.toLowerCase().includes(t)))) boosts.heading = 1.15;

  // path segment match
  if (lowerTerms.some((t) => doc.path.toLowerCase().includes(t))) boosts.path = 1.1;

  // epistemic layer
  const layer = String(fm.layer ?? "");
  const layerBoost = LAYER_BOOST[layer];
  if (layerBoost !== undefined && layerBoost !== 1.0) boosts.layer = layerBoost;

  return boosts;
}

function applyBoosts(base: number, b: Boosts): number {
  return base * (b.title ?? 1) * (b.heading ?? 1) * (b.path ?? 1) * (b.layer ?? 1) * (b.recency ?? 1);
}

/** Hybrid search: RRF-fuse FTS + vector rankings, then multiplicative boosts. */
export function hybridSearch(store: Store, input: HybridInput): HybridHit[] {
  const limit = input.limit ?? 50;
  const terms = input.terms ?? (input.text ? input.text.split(/\s+/).filter(Boolean) : []);

  const ftsRanks = new Map<string, number>();
  if (input.text) {
    textSearch(store, input.repoId, input.text, { limit: 200 }).hits.forEach((h, i) => {
      if (!ftsRanks.has(h.blockId)) ftsRanks.set(h.blockId, i + 1);
    });
  }

  const vecRanks = new Map<string, number>();
  const cosineByBlock = new Map<string, number>();
  if (input.vector) {
    vectorSearch(store, input.repoId, input.vector.model, input.vector.vec, { limit: 200 }).forEach((h, i) => {
      vecRanks.set(h.blockId, i + 1);
      cosineByBlock.set(h.blockId, h.cosine);
    });
  }

  // Union of candidate block ids.
  const candidates = new Set<string>([...ftsRanks.keys(), ...vecRanks.keys()]);
  const meta = store.db.prepare("SELECT doc_id, (SELECT path FROM documents WHERE doc_id = blocks.doc_id) AS path FROM blocks WHERE block_id = ?");

  const hits: HybridHit[] = [];
  for (const blockId of candidates) {
    const fr = ftsRanks.get(blockId);
    const vr = vecRanks.get(blockId);
    const rrf = (fr ? 1 / (RRF_K + fr) : 0) + (vr ? 1 / (RRF_K + vr) : 0);
    const m = meta.get(blockId) as { doc_id: string; path: string } | undefined;
    if (!m) continue;
    const boosts = computeBoosts(store, m.doc_id, blockId, terms);
    const evidence: HybridHit["evidence"] = { rrf, boosts };
    if (fr !== undefined) evidence.ftsRank = fr;
    if (vr !== undefined) {
      evidence.vectorRank = vr;
      const cos = cosineByBlock.get(blockId);
      if (cos !== undefined) evidence.cosine = cos;
    }
    hits.push({ blockId, docId: m.doc_id, path: m.path, score: applyBoosts(rrf, boosts), evidence });
  }

  hits.sort((a, b) => b.score - a.score || (a.blockId < b.blockId ? -1 : 1));
  return hits.slice(0, limit);
}
