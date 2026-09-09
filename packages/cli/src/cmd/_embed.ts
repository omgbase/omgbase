import { EmbeddingWorker, buildEmbedTasks, buildDocEmbedTasks, embeddingSettings, createExternalProvider, resolveSettings, type EmbeddingProvider } from "@omgbase/core";
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

export interface DrainDecision {
  /** number of blocks that would be embedded (cache misses). */
  pending: number;
  /** true if the provider is a remote endpoint (block text leaves the machine). */
  remote: boolean;
  providerName: string;
}

/**
 * Embed the repo's queued blocks now, connecting the configured provider and
 * releasing it afterward. No-op (returns null) when no provider is configured.
 * `verbose` prints per-batch progress in human mode. An optional `confirm` gate
 * is consulted BEFORE any block text is handed to the provider — returning
 * false skips the drain (also null). Callers that are themselves the explicit
 * "drain now" intent (`omg embed drain`) omit `confirm`; callers doing it as a
 * side effect (post-`attach`) pass one so the user consents to the egress.
 * Shared by both so they speak the same egress notice + progress output.
 */
export async function drainEmbeddings(
  cli: Cli,
  ws: ReturnType<Cli["workspace"]>,
  repoId: string,
  opts: { verbose?: boolean; prune?: boolean; confirm?: (d: DrainDecision) => Promise<boolean> } = {},
): Promise<{ embedded: number; cached: number; pruned?: { blocks: number; docs: number } } | null> {
  const loaded = await loadEmbedding(ws, repoId);
  if (!loaded) return null;
  try {
    const tasks = buildEmbedTasks(ws.store, repoId);
    const pending = loaded.worker.staleBlocks(tasks);

    if (opts.confirm) {
      const ok = await opts.confirm({ pending: pending.length, remote: loaded.remote, providerName: loaded.providerName });
      if (!ok) return null;
    }

    // Egress notice (05 §6): a remote provider receives block text off-machine.
    if (loaded.remote) {
      cli.io.err(cli.style.warn(`  embedding ${pending.length} block(s) via ${loaded.providerName} — block text is sent to this remote endpoint`));
    } else {
      cli.io.err(cli.style.dim(`  embedding ${pending.length} block(s) via ${loaded.providerName} (local process)`));
    }
    const verboseHuman = Boolean(opts.verbose) && cli.flags.mode === "human";
    const result = await loaded.worker.process(tasks, {
      ...(verboseHuman
        ? { onProgress: ({ embedded, total }) => cli.io.err(cli.style.dim(`    … ${embedded}/${total} embedded`)) }
        : {}),
    });
    // Doc-grain vectors: embed whole documents (or pool block vectors for
    // oversized docs) after blocks, so the pooled fallback can reuse the
    // vectors just cached. This is also the one-time backfill path for existing
    // repos — a fresh doc_embeddings table fills on the first drain.
    const docTasks = buildDocEmbedTasks(ws.store, repoId);
    const docResult = await loaded.worker.processDocs(docTasks, {
      ...(verboseHuman
        ? { onProgress: ({ embedded, total }) => cli.io.err(cli.style.dim(`    … ${embedded}/${total} doc(s) embedded`)) }
        : {}),
    });
    // Prune AFTER the drain, so the current model's vectors are in place before
    // we reclaim the old model's — a crash mid-way leaves the new vectors, not a
    // half-empty cache. Only touches rows for models other than the current one.
    let pruned: { blocks: number; docs: number } | undefined;
    if (opts.prune) {
      pruned = loaded.worker.pruneForeignVectors();
      if (cli.flags.mode === "human" && (pruned.blocks || pruned.docs)) {
        cli.io.err(cli.style.dim(`  pruned ${pruned.blocks} block + ${pruned.docs} doc vector(s) from other models`));
      }
    }

    // Fold doc work into the block counts so callers' "embedded/cached" report
    // covers both grains (pooled docs count as embedded work done).
    return { embedded: result.embedded + docResult.embedded + docResult.pooled, cached: result.cached + docResult.cached, ...(pruned ? { pruned } : {}) };
  } finally {
    await loaded.close();
  }
}
