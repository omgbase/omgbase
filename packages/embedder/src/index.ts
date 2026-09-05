import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

// @omgbase/embedder — the default local embedding provider (05 §6). Runs
// all-MiniLM-L6-v2 (384-dim sentence embeddings) via transformers.js: pure
// JS + WASM/ONNX, no native build. Model weights (~90MB) download to the
// transformers.js cache on first use, then run fully offline.
//
// This package is a standalone process (see bin.ts, the `omgbase-embedder` binary):
// the engine spawns it and speaks the stdio embedding protocol, so omgbase's
// core and CLI carry NO ML dependency and never import this module. The
// createProvider() factory is exported for programmatic/embedded use.

/** Minimal structural provider contract (mirrors @omgbase/core's EmbeddingProvider). */
export interface EmbeddingProvider {
  model: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_DIM = 384;

export interface CreateProviderOptions {
  /** transformers.js model id; defaults to Xenova/all-MiniLM-L6-v2. */
  model?: string;
  /** embedding dimension the model produces; defaults to 384 (MiniLM-L6). */
  dim?: number;
}

class TransformersProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  private extractor: FeatureExtractionPipeline | null = null;
  private loading: Promise<FeatureExtractionPipeline> | null = null;

  constructor(model: string, dim: number) {
    this.model = model;
    this.dim = dim;
  }

  private async pipe(): Promise<FeatureExtractionPipeline> {
    if (this.extractor) return this.extractor;
    // Single-flight the (slow) first load so concurrent embed() calls share it.
    if (!this.loading) this.loading = pipeline("feature-extraction", this.model);
    this.extractor = await this.loading;
    return this.extractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.pipe();
    // Mean-pool token embeddings and L2-normalize → one sentence vector per input.
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    // output is a Tensor [n, dim]; tolist() → number[][].
    return output.tolist() as number[][];
  }
}

/**
 * Build the default local embedding provider. The heavy model load is deferred
 * to the first embed() call, so constructing a provider is cheap; callers that
 * only probe availability pay nothing until they actually embed.
 */
export function createProvider(opts: CreateProviderOptions = {}): EmbeddingProvider {
  return new TransformersProvider(opts.model ?? DEFAULT_MODEL, opts.dim ?? DEFAULT_DIM);
}

export default createProvider;
