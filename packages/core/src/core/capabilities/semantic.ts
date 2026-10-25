import type { Store } from "../store/store.js";
import type { SemanticProvider } from "./types.js";
import { ctxHashHex, type EmbeddingWorker } from "../../search/embeddings.js";
import { buildDocEmbedTasks, buildEmbedTasks, makeBlockContextResolver, type BlockContextResolver } from "../../search/tasks.js";
import { docVectorSearch, vectorSearch, type DocVectorHit, type VectorHit } from "../../search/vector.js";

/**
 * The default `SemanticProvider`: `search/{embeddings,tasks,vector,drain}.ts`
 * behind the interface, unchanged. The two reads `semantic()` makes
 * (`oqx-js/context.ts`) and the gate `mcp/server.ts` applies are the
 * statements those sites ran inline before Phase 1; the drain halves are what
 * `EmbedDrainer.loop` does per pass.
 */
export class SemanticProviderImpl implements SemanticProvider {
  constructor(private readonly store: Store) {}

  blockContexts(scope: { repoId: string } | { docId: string }): BlockContextResolver {
    return makeBlockContextResolver(this.store, scope);
  }

  blockVector(rawHash: Buffer, ctx: string, model: string): Buffer | null {
    const row = this.store.db
      .prepare("SELECT vec FROM embeddings WHERE content_hash = ? AND ctx_hash = ? AND model = ?")
      .get(rawHash, Buffer.from(ctxHashHex(ctx), "hex"), model) as { vec: Buffer } | undefined;
    return row?.vec ?? null;
  }

  docVector(docId: string, model: string): Buffer | null {
    const row = this.store.db
      .prepare("SELECT vec FROM doc_embeddings WHERE doc_id = ? AND model = ?")
      .get(docId, model) as { vec: Buffer } | undefined;
    return row?.vec ?? null;
  }

  available(repoId: string, model: string): boolean {
    const row = this.store.db
      .prepare(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM doc_embeddings de JOIN docs d ON d.doc_id = de.doc_id WHERE d.repo_id = ? AND de.model = ?)
            OR EXISTS (SELECT 1 FROM embeddings WHERE model = ?)`,
      )
      .get(repoId, model, model);
    return row !== undefined;
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

  vectorSearch(repoId: string, model: string, queryVec: Float32Array, opts: { limit?: number } = {}): VectorHit[] {
    return vectorSearch(this.store, repoId, model, queryVec, opts);
  }

  docVectorSearch(repoId: string, model: string, queryVec: Float32Array, opts: { limit?: number } = {}): DocVectorHit[] {
    return docVectorSearch(this.store, repoId, model, queryVec, opts);
  }
}
