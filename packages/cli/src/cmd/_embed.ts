import { EmbeddingWorker, buildEmbedTasks, embeddingSettings, createExternalProvider, resolveSettings, requireSemantic, CapabilityUnavailable, EngineError, type EmbeddingProvider, type DrainMode } from "@omgbase/core";
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
 * null when embedding.provider is UNSET (callers surface semantic_unavailable).
 * When a provider IS configured but can't be reached (command won't spawn,
 * endpoint unreachable, bad handshake) this throws a loud, typed `embedder_failed`
 * EngineError naming the provider + reason — never a silent null, so a broken
 * embedder is never mistaken for an unconfigured one. Callers MUST call close()
 * when done (e.g. in a finally) to release a spawned process.
 */
export async function loadEmbedding(ws: ReturnType<Cli["workspace"]>, repoId: string): Promise<LoadedEmbedding | null> {
  const settings = embeddingSettings(resolveSettings(ws.store, repoId));
  if (!settings.provider) return null;
  // A configured provider on a store that runs WITHOUT the semantic module
  // (`OMGBASE_CAPABILITIES=core`) cannot embed or rank: `capability_unavailable
  // { semantic, disabled }` (modular-core Phase 2). An unconfigured one stays
  // the quiet null above on every composition.
  if (!ws.store.capabilities.semantic) throw CapabilityUnavailable.semanticDisabled();
  let ext;
  try {
    ext = await createExternalProvider(settings);
  } catch (err) {
    throw embedderFailed(settings.provider, err);
  }
  if (!ext) return null;
  return {
    worker: new EmbeddingWorker(ws.store, ext.provider),
    provider: ext.provider,
    providerName: settings.provider,
    remote: /^https?:\/\//i.test(settings.provider),
    close: ext.close,
  };
}

/** Build the shared `embedder_failed` error: a configured embedder that can't be
 *  reached is a hard, clearly-diagnosed fault (not `semantic_unavailable`, which
 *  means "no provider configured"). */
export function embedderFailed(provider: string, err: unknown): EngineError {
  const reason = err instanceof Error ? err.message : String(err);
  return new EngineError(
    "embedder_failed",
    `embedder '${provider}' is configured but failed to start: ${reason}. Fix: put it on PATH or use an absolute path / http(s) URL for embedding.provider — or unset embedding.provider to run without semantic search.`,
    { data: { provider, reason } },
  );
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
): Promise<{ embedded: number; cached: number; mode: DrainMode; processed_seq: number | null; head: number | null; pruned: { blocks: number; docs: number } } | null> {
  const loaded = await loadEmbedding(ws, repoId);
  if (!loaded) return null;
  try {
    const pending = loaded.worker.staleBlocks(buildEmbedTasks(ws.store, repoId));

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
    // The drain is the semantic capability's (modular-core Phase 2): blocks
    // then documents — so the pooled fallback can reuse the vectors just cached
    // — bootstrapping from a consistent snapshot when the repository has no
    // watermark, catching up from it otherwise. `--prune` forces the full
    // rescan with its cleanup: the current model's vectors are written before
    // the dead ones go, and other models' rows go with them.
    const semantic = requireSemantic(ws.store.db);
    const result = await semantic.drain(loaded.worker, repoId, {
      rescan: Boolean(opts.prune),
      ...(verboseHuman
        ? { onProgress: ({ phase, embedded, total }) => cli.io.err(cli.style.dim(`    … ${embedded}/${total} ${phase === "docs" ? "doc(s) " : ""}embedded`)) }
        : {}),
    });
    // What the pass cleaned up: an identity change's invalidation and the S1
    // sweep every pass does; with `--prune`, other models' leftovers as well.
    const pruned = { ...result.pruned };
    if (opts.prune) {
      const foreign = semantic.pruneForeign(loaded.worker);
      pruned.blocks += foreign.blocks;
      pruned.docs += foreign.docs;
    }
    if (cli.flags.mode === "human" && (pruned.blocks || pruned.docs)) {
      cli.io.err(cli.style.dim(`  pruned ${pruned.blocks} block + ${pruned.docs} doc vector(s) (other models, vanished content)`));
    }

    // Fold doc work into the block counts so callers' "embedded/cached" report
    // covers both grains (pooled docs count as embedded work done).
    return {
      embedded: result.embedded + result.docEmbedded + result.pooled, cached: result.cached + result.docCached,
      mode: result.mode, processed_seq: result.processed_seq, head: result.head, pruned,
    };
  } finally {
    await loaded.close();
  }
}
