import { parseArgs } from "node:util";
import { serveStdio, Watcher, WatchLease, watchLeaseLive, freshnessSweep, EmbedDrainer, EngineError, type SyncSource } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { EngineErrorLike, EXIT_OK, renderHelp } from "../output.js";
import { loadEmbedding } from "./_embed.js";
import { openRepoSource } from "./_source.js";

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
    return renderHelp(cli, {
      name: "mcp",
      summary: "Serve the MCP tool surface on stdio for an MCP host (Claude Code, Cursor, …); the host owns the process lifetime",
      usage: "mcp [-C <workspace-dir>] [--repo <slug>] [--no-watch]",
      options: [
        ["-C <dir>", "the workspace to serve — a directory at or below one containing .omgbase/ (the host rarely starts you inside it)"],
        ["--repo <slug>", "which repo, when the workspace has several"],
        ["--no-watch", "don't run the in-process file watcher (it is auto-off when another live watcher holds the lease)"],
      ],
      notes: [`host config: {"command": "${cli.prog}", "args": ["mcp", "-C", "/path/to/notes"]}`],
    });
  }

  // The host launches us from its own cwd, so a missing workspace here almost
  // always means the host config lacks `-C <dir>` — say so, rather than the
  // generic "run init" hint (which would create an empty workspace in the wrong place).
  let ws: ReturnType<Cli["workspace"]>;
  try {
    ws = cli.workspace();
  } catch (err) {
    if (err instanceof EngineErrorLike && err.code === "repo_not_found") {
      throw new EngineErrorLike("repo_not_found", err.message, {
        hint: `\`${cli.prog} mcp\` serves one workspace: point it there with -C, e.g. {"command": "${cli.prog}", "args": ["mcp", "-C", "/path/to/notes"]} in the MCP host config — or create one first with \`${cli.prog} init <dir>\` and \`${cli.prog} -C <dir> source add .\``,
      });
    }
    throw err;
  }
  const repo = cli.repo(ws);

  // Connect the configured embedder once (if any) so the query tool's
  // `semantic` mode has a vectorizer for the session. Unset ⇒ semantic queries
  // return semantic_unavailable. The spawned process lives for the session and
  // is released on shutdown.
  //
  // A CONFIGURED-but-broken embedder must never be mistaken for "no embedder":
  // we don't take the whole server down over it (non-semantic tools work fine),
  // but we complain loudly at startup and make every semantic access fail with a
  // clear `embedder_failed` (see the throwing embedQuery below), so the fault is
  // impossible to miss instead of silently degrading to keyword-only search.
  let embedding: Awaited<ReturnType<typeof loadEmbedding>> = null;
  let embedderError: EngineError | null = null;
  try {
    embedding = await loadEmbedding(ws, repo.repoId);
    if (embedding) cli.io.err(cli.style.dim(`[mcp] semantic query enabled via ${embedding.providerName}`));
  } catch (err) {
    embedderError = err instanceof EngineError && err.code === "embedder_failed" ? err : null;
    if (!embedderError) throw err; // an unexpected failure is still fatal
    const d = (embedderError.data ?? {}) as { provider?: string; reason?: string };
    cli.io.err(cli.style.err("[mcp] ✖ EMBEDDER NONFUNCTIONAL — semantic search + auto-embed disabled"));
    cli.io.err(cli.style.err(`      provider: ${d.provider ?? "?"}`));
    cli.io.err(cli.style.err(`      reason:   ${d.reason ?? embedderError.message}`));
    cli.io.err(cli.style.err("      semantic queries will fail with embedder_failed until this is fixed."));
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
      source = await openRepoSource(ws.store, repo);
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

  // The query surface's `embedQuery`: a live vectorizer when the embedder loaded,
  // or — when it's configured-but-broken — a hook that throws `embedder_failed`
  // so semantic access fails loudly and specifically (not the misleading
  // `semantic_unavailable`, which the server emits only when embedQuery is
  // absent, i.e. genuinely no provider configured). `const` captures satisfy
  // closure narrowing over the `let`-bound state above.
  const loaded = embedding;
  const failed = embedderError;
  const embedQuery = loaded
    ? async (text: string) => ({ model: loaded.provider.model, vec: await loaded.worker.embedQuery(text) })
    : failed
      ? (_text: string): Promise<{ model: string; vec: Float32Array }> => Promise.reject(failed)
      : undefined;

  const handle = await serveStdio({
    store: ws.store,
    repoId: repo.repoId,
    ...(repo.rootPath ? { rootPath: repo.rootPath } : {}),
    ...(drainer ? { onMutation: () => drainer.schedule() } : {}),
    ...(embedQuery ? { embedQuery } : {}),
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
