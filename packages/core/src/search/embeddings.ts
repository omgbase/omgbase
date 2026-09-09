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

  /**
   * Staleness: a heading rename changes descendants' context prefixes, so their
   * cached vectors (keyed by the OLD ctx_hash) no longer match the current
   * context. This returns the block ids in a doc whose current ctx has no cached
   * vector — i.e. stale/pending — for the worker queue.
   */
  staleBlocks(tasks: EmbedTask[]): string[] {
    return tasks.filter((t) => shouldEmbed(t.text) && !this.getCached(t.contentHashHex, t.ctx)).map((t) => t.blockId);
  }
}
