import { parseArgs } from "node:util";
import { serveStdio, Watcher, WatchLease, watchLeaseLive, freshnessSweep } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { EXIT_OK } from "../output.js";
import { loadEmbedding } from "./_embed.js";

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

  // Decide whether to run the in-process watcher. Off if --no-watch, or if a
  // live watcher already holds the lease (another `omg watch`/`omg mcp`).
  const leaseHeld = watchLeaseLive(ws.omgbaseDir);
  const wantWatch = !values["no-watch"] && !leaseHeld;

  let lease: WatchLease | null = null;
  let watcher: Watcher | null = null;

  if (wantWatch) {
    lease = WatchLease.tryAcquire(ws.omgbaseDir);
    if (lease) {
      // Prime with a one-shot sweep so the session starts fresh, then watch.
      freshnessSweep(ws.store, repo.repoId, repo.rootPath);
      watcher = new Watcher(ws.store, repo.repoId, repo.rootPath, {
        onCheckpoint: (r) => {
          if (r.ingested.length > 0 || r.deleted.length > 0) {
            cli.io.err(cli.style.dim(`[watch] checkpoint: +${r.ingested.length} -${r.deleted.length}`));
          }
        },
      });
      watcher.start();
      cli.io.err(cli.style.dim(`[mcp] serving ${repo.slug} on stdio · watcher live`));
    } else {
      // Lost the race for the lease; another watcher is live — serve without one.
      cli.io.err(cli.style.dim(`[mcp] serving ${repo.slug} on stdio · watcher elsewhere`));
    }
  } else {
    const why = values["no-watch"] ? "watcher off (--no-watch)" : "watcher elsewhere";
    cli.io.err(cli.style.dim(`[mcp] serving ${repo.slug} on stdio · ${why}`));
  }

  // Connect the configured embedder once (if any) so the query tool's
  // `semantic` mode has a vectorizer for the session. Absent ⇒ semantic queries
  // return semantic_unavailable. The spawned process lives for the session and
  // is released on shutdown.
  const embedding = await loadEmbedding(ws, repo.repoId);
  if (embedding) {
    cli.io.err(cli.style.dim(`[mcp] semantic query enabled via ${embedding.providerName}`));
  }

  const handle = await serveStdio({
    store: ws.store,
    repoId: repo.repoId,
    rootPath: repo.rootPath,
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
    lease?.release();
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
