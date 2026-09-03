import type { Store } from "../core/store/store.js";
import { hybridSearch, type HybridInput } from "./rrf.js";
import { graphTraverse, type Direction } from "../graph/traverse.js";

// resolve + pipeline (05 §7, 06 §3). resolve is hybrid search specialized for
// "give me the ID of the thing I mean". pipeline composes seed → expand →
// hydrate in one round trip; stages share the budget.

export interface ResolveHit {
  id: string;
  locator: string;
  preview: string;
  evidence: unknown;
}

function locatorFor(store: Store, blockId: string): string {
  const row = store.db.prepare(
    "SELECT d.path AS path, b.ordinal AS ordinal, b.type AS type FROM blocks b JOIN documents d ON d.doc_id = b.doc_id WHERE b.block_id = ?",
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

// --- pipeline ----------------------------------------------------------------

export interface PipelineInput {
  repoId: string;
  seed?: { text?: string; vector?: { model: string; vec: Float32Array }; limit?: number };
  expand?: { via?: string[]; direction?: Direction; depth?: number; budget?: { maxNodes?: number; maxEdges?: number } };
  hydrate?: { budgetTokens?: number };
}

export interface PipelineResult {
  seeds: { id: string; locator: string; preview: string; evidence: unknown }[];
  graph?: { nodes: string[]; edges: { src: string; predicate: string; dst: string }[]; truncated: boolean };
  content?: { blocks: { id: string; text: string }[]; truncated: boolean };
}

/** pipeline: seed → expand → hydrate in one round trip (05 §7). */
export function pipeline(store: Store, input: PipelineInput): PipelineResult {
  const result: PipelineResult = { seeds: [] };

  // seed
  let seedIds: string[] = [];
  if (input.seed) {
    const hi: HybridInput = { repoId: input.repoId, limit: input.seed.limit ?? 8 };
    if (input.seed.text) hi.text = input.seed.text;
    if (input.seed.vector) hi.vector = input.seed.vector;
    const hits = hybridSearch(store, hi);
    result.seeds = hits.map((h) => ({ id: h.blockId, locator: locatorFor(store, h.blockId), preview: previewFor(store, h.blockId), evidence: h.evidence }));
    // seed the graph from the seed blocks' documents (doc-grain traversal)
    seedIds = [...new Set(hits.map((h) => h.docId))];
  }

  // expand
  if (input.expand && seedIds.length > 0) {
    const spec: Parameters<typeof graphTraverse>[1] = { from: seedIds, direction: input.expand.direction ?? "both", depth: input.expand.depth ?? 2 };
    if (input.expand.via) spec.via = input.expand.via;
    if (input.expand.budget) spec.budget = input.expand.budget;
    const g = graphTraverse(store, spec);
    result.graph = { nodes: g.nodes, edges: g.edges, truncated: g.truncated };
  }

  // hydrate: pull text for seed blocks (and expanded doc headings) within budget
  if (input.hydrate) {
    const budget = input.hydrate.budgetTokens ?? 4000;
    let spent = 0;
    let truncated = false;
    const blocks: { id: string; text: string }[] = [];
    for (const s of result.seeds) {
      const row = store.db.prepare("SELECT text FROM blocks WHERE block_id = ?").get(s.id) as { text: string } | undefined;
      if (!row) continue;
      const cost = Math.ceil(row.text.length / 4);
      if (spent + cost > budget) { truncated = true; break; }
      spent += cost;
      blocks.push({ id: s.id, text: row.text });
    }
    result.content = { blocks, truncated };
  }

  return result;
}
