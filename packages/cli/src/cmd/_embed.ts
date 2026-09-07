import { EmbeddingWorker, embeddingSettings, createExternalProvider, resolveSettings, type EmbeddingProvider } from "@omgbase/core";
import type { Cli } from "../context.js";

// Shared embedding setup for the CLI (05 §6). Reads embedding.* from the repo's
// EFFECTIVE settings (workspace defaults ← repo overrides, config-scope) and
// connects to the configured external provider — a spawned command (stdio JSON)
// or an http(s) endpoint. No in-process ML dependency and no JS module import:
// the embedder is a separate process/service the user installs and names in
// config. Returns null when no provider is configured — callers surface
// semantic_unavailable. The embedder is typically set once at the workspace
// level so every repo shares one vector space.

export interface LoadedEmbedding {
  worker: EmbeddingWorker;
  provider: EmbeddingProvider;
  /** the command/URL that was connected, for diagnostics */
  providerName: string;
  /** whether the provider is a remote endpoint (text leaves the machine) */
  remote: boolean;
  /** release resources (kill the spawned process). */
  close(): Promise<void>;
}

/**
 * Connect the configured embedding provider + build a worker for a repo, or
 * null when embedding.provider is unset. Throws only on misconfiguration
 * (command won't spawn, endpoint unreachable, bad handshake). Callers MUST call
 * close() when done (e.g. in a finally) to release a spawned process.
 */
export async function loadEmbedding(ws: ReturnType<Cli["workspace"]>, repoId: string): Promise<LoadedEmbedding | null> {
  const settings = embeddingSettings(resolveSettings(ws.store, repoId));
  if (!settings.provider) return null;
  const ext = await createExternalProvider(settings);
  if (!ext) return null;
  return {
    worker: new EmbeddingWorker(ws.store, ext.provider),
    provider: ext.provider,
    providerName: settings.provider,
    remote: /^https?:\/\//i.test(settings.provider),
    close: ext.close,
  };
}
