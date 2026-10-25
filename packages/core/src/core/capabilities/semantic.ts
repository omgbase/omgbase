import type { Store } from "../store/store.js";
import type { SemanticBlockRow, SemanticDrainOptions, SemanticFreshness, SemanticProvider, SemanticScorer, SemanticVec } from "./types.js";
import type { EmbeddingWorker } from "../../semantic/embeddings.js";
import { anyEmbedded, blockVectorRow, docVectorRow } from "../../semantic/cache.js";
import { buildDocEmbedTasks, buildEmbedTasks, makeBlockContextResolver, staleEmbedCount, type BlockContextResolver } from "../../semantic/tasks.js";
import { docVectorSearch, vectorSearch, type DocVectorHit, type VectorHit } from "../../semantic/vector.js";
import { cosineBytes } from "../../semantic/vec.js";
import { drainRepo, freshness, type DrainResult, type SemanticIndexIdentity } from "../../semantic/indexer.js";
import { vectorSizeAdvice } from "../../semantic/advice.js";

/**
 * The default `SemanticProvider`: `semantic/{embeddings,tasks,vector,indexer}.ts`
 * behind the interface. Constructing it is what gives the connection its
 * `cosine(a, b)` SQL function (phase-1-contracts §1.4.3: "registered by this
 * bundle's module") — a store on the core-only composition has none. The two
 * reads `semantic()` makes (`oqx-js/context.ts`, through `scorer`) and the gate
 * `mcp/server.ts` applies are the statements those sites ran inline before
 * Phase 1; the drain is the indexer's pass.
 */
export class SemanticProviderImpl implements SemanticProvider {
  constructor(private readonly store: Store) {
    // cosine(vecBlob, queryBlob) → REAL: deterministic (same inputs → same
    // score) so SQLite may cache it. Registered once per connection.
    store.db.function("cosine", { deterministic: true }, (a, b) => cosineBytes(a as Uint8Array | null, b as Uint8Array | null));
  }

  blockContexts(scope: { repoId: string } | { docId: string }): BlockContextResolver {
    return makeBlockContextResolver(this.store, scope);
  }

  blockVector(rawHash: Buffer, ctx: string, model: string): Buffer | null {
    return blockVectorRow(this.store, rawHash, ctx, model);
  }

  docVector(docId: string, model: string): Buffer | null {
    return docVectorRow(this.store, docId, model);
  }

  // A block's vector is the cache row for its CURRENT (raw_hash, ctx_hash)
  // (spec/surface §1.3, spec/search §3 — since search 1.1). The context
  // resolver is built once per query (one scan of titles and sections), then a
  // per-block chain walk.
  scorer(repoId: string): SemanticScorer {
    let contexts: BlockContextResolver | undefined;
    return {
      block: (r: SemanticBlockRow, q: SemanticVec): number | null => {
        contexts ??= this.blockContexts({ repoId });
        const vec = this.blockVector(r.raw_hash, contexts.ctx({ doc_id: r.doc_id, path: r.path, ordinal: r.ordinal, type: r.type }), q.model);
        return cosineBytes(vec, q.vec);
      },
      doc: (docId: string, q: SemanticVec): number | null => cosineBytes(this.docVector(docId, q.model), q.vec),
    };
  }

  available(repoId: string, model: string): boolean {
    return anyEmbedded(this.store, repoId, model);
  }

  drain(worker: EmbeddingWorker, repoId: string, opts: SemanticDrainOptions = {}): Promise<DrainResult> {
    const provider = worker.provider;
    if (!provider) return Promise.reject(new Error("no embedding provider configured"));
    return drainRepo(this.store, repoId, worker, provider, opts);
  }

  embed(worker: EmbeddingWorker, repoId: string, opts: { batchSize?: number; onProgress?: (p: { embedded: number; total: number }) => void } = {}): Promise<{ embedded: number; cached: number }> {
    return worker.process(buildEmbedTasks(this.store, repoId), opts);
  }

  embedDocs(worker: EmbeddingWorker, repoId: string, opts: { batchSize?: number; onProgress?: (p: { embedded: number; total: number }) => void } = {}): Promise<{ embedded: number; cached: number; pooled: number }> {
    return worker.processDocs(buildDocEmbedTasks(this.store, repoId), opts);
  }

  pruneForeign(worker: EmbeddingWorker): { blocks: number; docs: number } {
    return worker.pruneForeignVectors();
  }

  freshness(repoId: string, identity?: SemanticIndexIdentity): SemanticFreshness {
    return freshness(this.store, repoId, identity);
  }

  staleCount(repoId: string, model?: string): number {
    return staleEmbedCount(this.store, repoId, model);
  }

  vectorSearch(repoId: string, model: string, queryVec: Float32Array, opts: { limit?: number } = {}): VectorHit[] {
    return vectorSearch(this.store, repoId, model, queryVec, opts);
  }

  docVectorSearch(repoId: string, model: string, queryVec: Float32Array, opts: { limit?: number } = {}): DocVectorHit[] {
    return docVectorSearch(this.store, repoId, model, queryVec, opts);
  }

  sizeAdvice(vectorBytes: number, totalBytes: number): string[] {
    return vectorSizeAdvice(vectorBytes, totalBytes);
  }
}
