import { parseArgs } from "node:util";
import { serveStdio, Watcher, WatchLease, watchLeaseLive, freshnessSweep, EmbedDrainer, type SyncSource } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { EXIT_OK } from "../output.js";
import { loadEmbedding } from "./_embed.js";
import { openFsSource } from "./_source.js";

// `omg mcp [--no-watch]` (11 §5.8) — MCP server on stdio; the host owns the
// process lifetime. Runs an in-process watcher by default so a lone session is
// always fresh, auto-disabled when another live watch lease exists; --no-watch
// forces it off.
//
// CRITICAL: on stdio, stdout is the MCP protocol channel. Nothing may write to
// stdout here — every diagnostic goes to stderr (cli.io.err).

async function runMcp(cli: Cli, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: { "no-watch": { type: "boolean" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  mcp [--no-watch]  — serve the MCP tool surface on stdio (host owns lifetime)");
    return EXIT_OK;
  }

  const ws = cli.workspace();
  const repo = cli.repo(ws);

  // Connect the configured embedder once (if any) so the query tool's
  // `semantic` mode has a vectorizer for the session. Absent ⇒ semantic queries
  // return semantic_unavailable. The spawned process lives for the session and
  // is released on shutdown.
  const embedding = await loadEmbedding(ws, repo.repoId);
  if (embedding) {
    cli.io.err(cli.style.dim(`[mcp] semantic query enabled via ${embedding.providerName}`));
  }

  // Keep embeddings timely: a background drainer embeds blocks touched by a
  // mutation (or a watcher checkpoint) without blocking the tool's response.
  // Only meaningful when a provider is configured.
  const drainer = embedding
    ? new EmbedDrainer(ws.store, repo.repoId, embedding.worker, {
        onDrain: ({ embedded }) => cli.io.err(cli.style.dim(`[mcp] embedded ${embedded} block(s)`)),
        onError: (err) => cli.io.err(cli.style.dim(`[mcp] embed drain failed: ${String(err)}`)),
      })
    : null;

  // Decide whether to run the in-process watcher. Off if --no-watch, or if a
  // live watcher already holds the lease (another `omg watch`/`omg mcp`).
  const leaseHeld = watchLeaseLive(ws.omgbaseDir);
  const wantWatch = !values["no-watch"] && !leaseHeld;

  let lease: WatchLease | null = null;
  let watcher: Watcher | null = null;
  let source: SyncSource | null = null;

  if (wantWatch) {
    lease = WatchLease.tryAcquire(ws.omgbaseDir);
    if (lease) {
      // Prime with a one-shot sweep so the session starts fresh, then watch via
      // the external fs-adapter process (chokidar lives there, not in-engine).
      if (repo.rootPath) freshnessSweep(ws.store, repo.repoId, repo.rootPath);
      source = await openFsSource(repo);
      if (source) {
        watcher = new Watcher(ws.store, repo.repoId, source, {
          onCheckpoint: (r) => {
            if (r.ingested.length > 0 || r.deleted.length > 0) {
              cli.io.err(cli.style.dim(`[watch] checkpoint: +${r.ingested.length} -${r.deleted.length}`));
              // A file change the watcher ingested may also need (re-)embedding.
              drainer?.schedule();
            }
          },
          onError: (err) => cli.io.err(cli.style.dim(`[watch] error: ${String(err)}`)),
        });
        await watcher.start();
        cli.io.err(cli.style.dim(`[mcp] serving ${repo.slug} on stdio · watcher live`));
      } else {
        cli.io.err(cli.style.dim(`[mcp] serving ${repo.slug} on stdio · sourceless (no watch)`));
      }
    } else {
      // Lost the race for the lease; another watcher is live — serve without one.
      cli.io.err(cli.style.dim(`[mcp] serving ${repo.slug} on stdio · watcher elsewhere`));
    }
  } else {
    const why = values["no-watch"] ? "watcher off (--no-watch)" : "watcher elsewhere";
    cli.io.err(cli.style.dim(`[mcp] serving ${repo.slug} on stdio · ${why}`));
  }

  if (drainer) cli.io.err(cli.style.dim(`[mcp] auto-embed on mutation enabled`));

  const handle = await serveStdio({
    store: ws.store,
    repoId: repo.repoId,
    ...(repo.rootPath ? { rootPath: repo.rootPath } : {}),
    ...(drainer ? { onMutation: () => drainer.schedule() } : {}),
    ...(embedding
      ? {
          embedQuery: async (text: string) => ({
            model: embedding.provider.model,
            vec: await embedding.worker.embedQuery(text),
          }),
        }
      : {}),
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (watcher) await watcher.stop();
    if (source) await source.close();
    lease?.release();
    // Drain any pending embeds before killing the provider process. flush()
    // runs a debounced-but-not-yet-fired drain; close() then awaits in-flight.
    if (drainer) { try { await drainer.flush(); } catch { /* reported via onError */ } await drainer.close(); }
    if (embedding) await embedding.close();
    await handle.close();
    ws.close();
  };

  // Host-owned lifetime: end on client disconnect or a signal. The in-process
  // watcher keeps the event loop alive, so we can't rely on the loop draining —
  // exit explicitly once cleanup completes. Three end triggers: the transport's
  // onclose (handle.closed), stdin EOF, and SIGINT/SIGTERM.
  const finish = (): void => {
    void shutdown().finally(() => process.exit(0));
  };
  process.once("SIGINT", finish);
  process.once("SIGTERM", finish);
  process.stdin.once("end", finish);
  process.stdin.once("close", finish);
  handle.closed.then(finish, finish);

  await handle.closed;
  return EXIT_OK;
}

export const cmdMcp: Command = {
  name: "mcp",
  summary: "Serve the MCP tool surface on stdio",
  run: (cli, a) => runMcp(cli, a),
};
