import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";

// Embedding worker (05 §6). Blocks are embedded with a context prefix; the
// cache is keyed by (content_hash, ctx_hash, model) so identity errors cannot
// poison it. The provider is a configured hook (vault text leaves the machine);
// no provider ⇒ semantic_unavailable. v1 recompute is synchronous-on-demand
// with a queue abstraction for a future async worker.

export interface EmbeddingProvider {
  model: string;
  dim: number;
  /**
   * Max input length (in tokens) the model accepts before it truncates. Used to
   * decide the doc-embedding strategy: inputs within budget take the whole-doc
   * path, larger ones fall back to pooling block vectors. Absent ⇒ the caller's
   * configured/default budget applies (05 §6; don't hardcode the threshold).
   */
  maxInputTokens?: number;
  /** Embed a batch of input strings → float32 vectors. */
  embed(texts: string[]): Promise<number[][]>;
}

export class SemanticUnavailable extends Error {
  code = "semantic_unavailable" as const;
}

// Context prefix (05 §6): "{doc title} · {path} · {heading chain} · {type}\n{text}".
export function contextPrefix(input: { docTitle: string; path: string; headingChain: string[]; blockType: string }): string {
  const chain = input.headingChain.join(" › ");
  return `${input.docTitle} · ${input.path} · ${chain} · ${input.blockType}`;
}

export function embedInput(ctx: string, blockText: string): string {
  return `${ctx}\n${blockText}`;
}

export function ctxHashHex(ctx: string): string {
  return sha256(ctx).toString("hex");
}

export interface EmbedTask {
  blockId: string;
  contentHashHex: string; // block raw_hash
  ctx: string;
  text: string;
}

// Default cache-miss chunk size for process(). Embedding is done in bounded
// batches so a single request never grows unbounded — a large all-at-once
// request can exceed the provider's per-request limits (stdio line size, HTTP
// body cap) and fail silently. Callers may override via opts.batchSize; the
// value only affects request chunking, never whether work happens.
const DEFAULT_EMBED_BATCH = 32;

// Rows < minTokens roll into their section aggregate rather than embedding
// alone (05 §6). We surface this as a filter the caller applies.
export function shouldEmbed(text: string, minTokens = 24): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length >= minTokens;
}

// Coarse token estimate for budget decisions and pool weighting. We don't have
// the provider's tokenizer (it's out-of-process), so approximate: word-piece
// tokenizers emit slightly MORE tokens than whitespace words (subword splits,
// punctuation), so scale words up by ~1.3 to stay on the safe side of the
// budget rather than under-counting and letting a doc silently truncate.
export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

// Default whole-doc token budget when the provider doesn't report its own
// maxInputTokens and config doesn't override. Deliberately conservative: beyond
// a model's real input limit the input is truncated, at which point pooling the
// block vectors represents the whole document better than an embedding of only
// its first N tokens. Callers should prefer the provider's actual limit.
export const DEFAULT_DOC_TOKEN_BUDGET = 512;
// Tokens reserved for the doc-embedding header line so the budget check leaves
// room for it (the header is prepended to the body — see buildDocEmbedTasks).
const DOC_HEADER_MARGIN_TOKENS = 16;

// A block's contribution to the pooled-fallback doc vector: where to find its
// cached vector (contentHashHex + ctx, the block embeddings cache key) and its
// token weight. Token-weighted (not naive) mean so a few substantive blocks
// aren't outvoted by many short boilerplate ones (approximates embedding the
// concatenation).
export interface DocEmbedBlockRef {
  contentHashHex: string;
  ctx: string;
  tokens: number;
}

// One doc-embedding unit of work. `input` is the whole-document embed input
// (header + reconstructed body, minus server `$` frontmatter — see
// buildDocEmbedTasks); its sha256 is the freshness key for BOTH strategies, so
// any content edit invalidates the stored vector regardless of how it was
// computed. `blocks` feeds the pooled fallback (used only when `input` exceeds
// the token budget); it reuses vectors already in the block embeddings cache,
// so the fallback path costs zero embedding calls.
export interface DocEmbedTask {
  docId: string;
  input: string;
  blocks: DocEmbedBlockRef[];
}

export type DocEmbedMethod = "whole" | "pooled";

export interface DocVectorRow {
  vec: Float32Array;
  method: DocEmbedMethod;
}

export class EmbeddingWorker {
  constructor(private store: Store, private provider: EmbeddingProvider | null) {}

  get available(): boolean {
    return this.provider !== null;
  }

  private cacheKey(contentHashHex: string, ctxHex: string): [Buffer, Buffer, string] {
    return [Buffer.from(contentHashHex, "hex"), Buffer.from(ctxHex, "hex"), this.provider!.model];
  }

  /** Look up a cached vector; null if absent (stale/missing). */
  getCached(contentHashHex: string, ctx: string): Float32Array | null {
    if (!this.provider) return null;
    const ctxHex = ctxHashHex(ctx);
    const row = this.store.db
      .prepare("SELECT vec FROM embeddings WHERE content_hash = ? AND ctx_hash = ? AND model = ?")
      .get(...this.cacheKey(contentHashHex, ctxHex)) as { vec: Buffer } | undefined;
    if (!row) return null;
    return new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4);
  }

  /**
   * Embed a batch (skipping cache hits) and persist. Throws if no provider.
   * Cache misses are embedded in chunks of `batchSize` (default:
   * DEFAULT_EMBED_BATCH); `onProgress` fires after each chunk is persisted so
   * callers can show live progress on a long drain.
   */
  async process(
    tasks: EmbedTask[],
    opts: { batchSize?: number; onProgress?: (p: { embedded: number; total: number }) => void } = {},
  ): Promise<{ embedded: number; cached: number }> {
    if (!this.provider) throw new SemanticUnavailable("no embedding provider configured");
    const misses: EmbedTask[] = [];
    let cached = 0;
    for (const t of tasks) {
      if (this.getCached(t.contentHashHex, t.ctx)) cached++;
      else misses.push(t);
    }
    const insert = this.store.db.prepare(
      "INSERT OR REPLACE INTO embeddings (content_hash, ctx_hash, model, dim, vec) VALUES (?, ?, ?, ?, ?)",
    );
    const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : DEFAULT_EMBED_BATCH;
    let embedded = 0;
    for (let start = 0; start < misses.length; start += batchSize) {
      const chunk = misses.slice(start, start + batchSize);
      const vectors = await this.provider.embed(chunk.map((t) => embedInput(t.ctx, t.text)));
      this.store.write(() => {
        chunk.forEach((t, i) => {
          const v = Float32Array.from(vectors[i]!);
          insert.run(Buffer.from(t.contentHashHex, "hex"), Buffer.from(ctxHashHex(t.ctx), "hex"), this.provider!.model, this.provider!.dim, Buffer.from(v.buffer));
        });
      });
      embedded += chunk.length;
      opts.onProgress?.({ embedded, total: misses.length });
    }
    return { embedded, cached };
  }

  /** Embed a bare query string (no context prefix, 05 §6). */
  async embedQuery(query: string): Promise<Float32Array> {
    if (!this.provider) throw new SemanticUnavailable("no embedding provider configured");
    const [v] = await this.provider.embed([query]);
    return Float32Array.from(v!);
  }

  // ---- doc-grain embeddings (doc semantic retrieval) ------------------------

  private docTokenBudget(): number {
    const provider = this.provider!;
    const budget = provider.maxInputTokens ?? DEFAULT_DOC_TOKEN_BUDGET;
    return Math.max(1, budget - DOC_HEADER_MARGIN_TOKENS);
  }

  /** The freshness key for a doc task: sha256 of the whole-doc embed input. */
  private docInputHash(input: string): Buffer {
    return sha256(input);
  }

  /** Look up a cached doc vector; null if absent or stale (input changed). */
  getCachedDoc(docId: string, input: string): DocVectorRow | null {
    if (!this.provider) return null;
    const row = this.store.db
      .prepare("SELECT input_hash, method, vec FROM doc_embeddings WHERE doc_id = ? AND model = ?")
      .get(docId, this.provider.model) as { input_hash: Buffer; method: DocEmbedMethod; vec: Buffer } | undefined;
    if (!row) return null;
    if (!row.input_hash.equals(this.docInputHash(input))) return null; // stale
    return {
      vec: new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4),
      method: row.method,
    };
  }

  /** Doc ids whose current input has no fresh cached vector — the doc queue. */
  staleDocs(tasks: DocEmbedTask[]): string[] {
    return tasks.filter((t) => !this.getCachedDoc(t.docId, t.input)).map((t) => t.docId);
  }

  /**
   * Compute one vector per document and persist. Whole-doc path (primary):
   * embed the doc's input directly. Pooled fallback: only when the input
   * exceeds the provider's token budget, pool the doc's already-cached block
   * vectors (token-weighted mean, L2-normalized) — zero embedding calls. Skips
   * docs whose fresh vector is already cached. Throws if no provider.
   */
  async processDocs(
    tasks: DocEmbedTask[],
    opts: { batchSize?: number; onProgress?: (p: { embedded: number; total: number }) => void } = {},
  ): Promise<{ embedded: number; cached: number; pooled: number }> {
    if (!this.provider) throw new SemanticUnavailable("no embedding provider configured");
    const budget = this.docTokenBudget();

    const misses: DocEmbedTask[] = [];
    let cached = 0;
    for (const t of tasks) {
      if (this.getCachedDoc(t.docId, t.input)) cached++;
      else misses.push(t);
    }

    // Split misses by strategy: within budget ⇒ whole-doc embed; over budget ⇒
    // pooled fallback (no provider call).
    const whole = misses.filter((t) => estimateTokens(t.input) <= budget);
    const pooledTasks = misses.filter((t) => estimateTokens(t.input) > budget);

    const insert = this.store.db.prepare(
      "INSERT OR REPLACE INTO doc_embeddings (doc_id, model, input_hash, method, dim, vec) VALUES (?, ?, ?, ?, ?, ?)",
    );
    let embedded = 0;
    let pooled = 0;

    const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : DEFAULT_EMBED_BATCH;
    for (let start = 0; start < whole.length; start += batchSize) {
      const chunk = whole.slice(start, start + batchSize);
      const vectors = await this.provider.embed(chunk.map((t) => t.input));
      this.store.write(() => {
        chunk.forEach((t, i) => {
          const v = Float32Array.from(vectors[i]!);
          insert.run(t.docId, this.provider!.model, this.docInputHash(t.input), "whole", this.provider!.dim, Buffer.from(v.buffer));
        });
      });
      embedded += chunk.length;
      opts.onProgress?.({ embedded, total: whole.length });
    }

    // Pooled fallback: reuse block vectors already in the embeddings cache.
    if (pooledTasks.length > 0) {
      this.store.write(() => {
        for (const t of pooledTasks) {
          const v = this.poolBlockVectors(t.blocks);
          if (!v) continue; // no cached block vectors yet — leave it queued
          insert.run(t.docId, this.provider!.model, this.docInputHash(t.input), "pooled", this.provider!.dim, Buffer.from(v.buffer));
          pooled++;
        }
      });
    }

    return { embedded, cached, pooled };
  }

  /**
   * Token-weighted mean of a document's cached block vectors, L2-normalized.
   * Pool = Σ(wᵢ·vᵢ)/Σ(wᵢ) with wᵢ = block token count, then normalized (pooling
   * breaks unit norm; downstream cosine assumes unit vectors). Returns null when
   * no referenced block has a cached vector yet.
   */
  private poolBlockVectors(refs: DocEmbedBlockRef[]): Float32Array | null {
    const dim = this.provider!.dim;
    const acc = new Float64Array(dim);
    let weightSum = 0;
    for (const ref of refs) {
      const v = this.getCached(ref.contentHashHex, ref.ctx);
      if (!v) continue;
      const w = ref.tokens > 0 ? ref.tokens : 1;
      const n = Math.min(dim, v.length);
      for (let i = 0; i < n; i++) acc[i]! += w * v[i]!;
      weightSum += w;
    }
    if (weightSum === 0) return null;
    let norm = 0;
    for (let i = 0; i < dim; i++) { acc[i]! /= weightSum; norm += acc[i]! * acc[i]!; }
    norm = Math.sqrt(norm);
    const out = new Float32Array(dim);
    if (norm === 0) return out; // all-zero pool (degenerate) — return zeros
    for (let i = 0; i < dim; i++) out[i] = acc[i]! / norm;
    return out;
  }

  /**
   * Staleness: a heading rename changes descendants' context prefixes, so their
   * cached vectors (keyed by the OLD ctx_hash) no longer match the current
   * context. This returns the block ids in a doc whose current ctx has no cached
   * vector — i.e. stale/pending — for the worker queue.
   */
  staleBlocks(tasks: EmbedTask[]): string[] {
    return tasks.filter((t) => shouldEmbed(t.text) && !this.getCached(t.contentHashHex, t.ctx)).map((t) => t.blockId);
  }

  /**
   * Vectors left behind by a previous model. The cache and both search paths key
   * on model name, so after switching models the old model's rows are dead
   * weight: never read, never overwritten (the new model writes under its own
   * key). Reports how many block + doc vectors belong to a model OTHER than the
   * current provider's, so callers can offer to reclaim the space.
   */
  foreignVectorCount(): { blocks: number; docs: number } {
    if (!this.provider) return { blocks: 0, docs: 0 };
    const blocks = (this.store.db.prepare("SELECT count(*) c FROM embeddings WHERE model != ?").get(this.provider.model) as { c: number }).c;
    const docs = (this.store.db.prepare("SELECT count(*) c FROM doc_embeddings WHERE model != ?").get(this.provider.model) as { c: number }).c;
    return { blocks, docs };
  }

  /** Delete every cached vector not produced by the current model. */
  pruneForeignVectors(): { blocks: number; docs: number } {
    if (!this.provider) return { blocks: 0, docs: 0 };
    const model = this.provider.model;
    return this.store.write((db) => ({
      blocks: db.prepare("DELETE FROM embeddings WHERE model != ?").run(model).changes,
      docs: db.prepare("DELETE FROM doc_embeddings WHERE model != ?").run(model).changes,
    }));
  }
}
