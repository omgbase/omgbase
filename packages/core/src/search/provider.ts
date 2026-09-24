// Provider configuration (05 §6). The embedding provider is an external
// *process or endpoint* named in repo settings — `embedding.provider` is either
// a shell command (spawned and spoken to over the stdio JSON protocol) or an
// http(s) URL (GET metadata, POST embed) — see `search/external.ts`. Nothing is
// imported in-process, so core carries no ML dependency and the embedder can be
// any language. `@omgbase/embedder`'s `omgbase-embedder` binary is the default
// local implementation; an HTTP endpoint is the same contract over the wire —
// nothing privileges local vs. remote.

export interface EmbeddingSettings {
  /** The embedder: a command to spawn (e.g. "omgbase-embedder") or an http(s)
   *  URL. Absent ⇒ no provider (`semantic_unavailable`). */
  provider?: string;
  /** Optional model id. For a spawned command it is exported as
   *  OMGBASE_EMBEDDER_MODEL (explicit setting wins over an inherited variable);
   *  the provider's handshake/metadata reply overrides it for reporting. */
  model?: string;
  /** Optional dimension. For a spawned command it is exported as
   *  OMGBASE_EMBEDDER_DIM; the handshake/metadata reply overrides it. */
  dim?: number;
  /**
   * Optional max input length (tokens) the provider's model accepts before it
   * truncates. Sets the doc-embedding whole-doc vs pooled-fallback threshold; a
   * provider that reports it in its handshake overrides this. Absent everywhere
   * ⇒ the worker's conservative default budget applies.
   */
  maxInputTokens?: number;
}

/** Read the embedding.* block out of a repo's parsed settings JSON. */
export function embeddingSettings(settings: Record<string, unknown>): EmbeddingSettings {
  const e = settings.embedding;
  return e && typeof e === "object" ? (e as EmbeddingSettings) : {};
}
