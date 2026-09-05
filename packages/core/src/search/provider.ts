// Provider configuration (05 §6). The embedding provider is a plugin named in
// repo settings (embedding.provider = a package that exports
// `createProvider(opts?) => EmbeddingProvider`). The dynamic import itself lives
// in the application (the CLI), not here, so it resolves against the app's
// dependency tree and core carries no ML dependency. @omgbase/embedder is the
// default local implementation; a remote HTTP provider is the same contract
// behind a different package name — nothing privileges local vs. remote.

export interface EmbeddingSettings {
  /** Package name to import, e.g. "@omgbase/embedder". Absent ⇒ no provider. */
  provider?: string;
  /** Optional model id passed through to the provider factory. */
  model?: string;
  /** Optional dimension override passed through to the provider factory. */
  dim?: number;
}

/** Read the embedding.* block out of a repo's parsed settings JSON. */
export function embeddingSettings(settings: Record<string, unknown>): EmbeddingSettings {
  const e = settings.embedding;
  return e && typeof e === "object" ? (e as EmbeddingSettings) : {};
}
