import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Watcher, WatchLease, EmbedDrainer, freshnessSweep, type RepoRow, type Workspace } from "@omgbase/core";
import { runFsMirror } from "@omgbase/sync";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { EngineErrorLike, EXIT_OK } from "../output.js";
import { loadEmbedding } from "./_embed.js";
import { openRepoSource } from "./_source.js";

// `omg sync` — reconcile a repo with its filesystem source. One verb, three modes:
//   omg sync                     one-shot local freshness sweep (fs → DB)
//   omg sync --watch             stay live locally (external fs-adapter watcher)
//   omg sync --server <cmd> …    the same, but against a remote engine over MCP
//                                (the coordinator — mirrors `omgbase-sync`)
// The `--server` form is the global remote flag (context REMOTE_OK); it shares
// `runFsMirror` with the standalone `omgbase-sync` bin. There is no separate
// `omg watch` — watching is `omg sync --watch`. The local one-shot IS the
// explicit form of the freshness sweep every read runs by default.

function help(cli: Cli): number {
  cli.io.out("  sync — reconcile a repo with its filesystem source");
  cli.io.out(`  ${cli.style.dim("usage:")} omg sync [--watch] [--server <cmd> [--root <dir>] [--out]]`);
  cli.io.out("    (no flags)         one-shot: re-ingest what changed on disk");
  cli.io.out("    --watch            stay live and reconcile edits as they land");
  cli.io.out("    --server <cmd>     run against a remote engine over MCP (spawns <cmd>)");
  cli.io.out("    --root <dir>       [--server] the directory to mirror (default cwd)");
  cli.io.out("    --out              [--server] also export engine-authored changes back to disk");
  return EXIT_OK;
}

async function runSync(cli: Cli, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: { watch: { type: "boolean" }, out: { type: "boolean" }, root: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) return help(cli);

  // Remote mode: run the coordinator against an MCP server (shared with the
  // omgbase-sync bin). No local workspace needed — the fs dir is the source.
  if (cli.flags.server !== undefined) {
    const root = resolve(cli.cwd, values.root ?? ".");
    const server = cli.flags.server.split(/\s+/).filter(Boolean);
    await runFsMirror({
      server,
      root,
      ...(values.watch ? { watch: true } : {}),
      ...(values.out ? { out: true } : {}),
      log: (msg) => cli.io.err(cli.style.dim(`  ${msg}`)),
    });
    return EXIT_OK;
  }

  // Local mode: resolve the workspace + repo and reconcile in-process.
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  return values.watch ? runLocalWatch(cli, ws, repo) : runOneShot(cli, ws, repo);
}

function runOneShot(cli: Cli, ws: Workspace, repo: RepoRow): number {
  if (!repo.rootPath) {
    if (cli.flags.mode === "human") cli.io.out(cli.style.dim(`  ${repo.slug} has no filesystem source — nothing to sync`));
    else cli.io.out(JSON.stringify({ scanned: 0, ingested: [], deleted: [], conflicted: [], changed: false }));
    return EXIT_OK;
  }
  const result = freshnessSweep(ws.store, repo.repoId, repo.rootPath);

  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify(result));
    return EXIT_OK;
  }
  const { render, style, io } = cli;
  const g = render.g;
  io.out(render.wordmark("sync"));
  io.out(render.rule(40));
  io.out(`  ${style.dim("scanned")}   ${result.scanned} files`);
  if (result.ingested.length > 0) {
    io.out(`  ${style.ok(g.ok)} ingested  ${result.ingested.length}`);
    for (const p of result.ingested) io.out(`      ${style.accent(p)}`);
  }
  if (result.deleted.length > 0) {
    io.out(`  ${style.err(g.err)} deleted   ${result.deleted.length}`);
    for (const p of result.deleted) io.out(`      ${style.dim(p)}`);
  }
  if (result.conflicted.length > 0) {
    io.out(`  ${style.warn(g.warn)} conflicts ${result.conflicted.length}`);
    for (const p of result.conflicted) io.out(`      ${style.warn(p)}`);
  }
  if (!result.changed) io.out(`  ${style.dim("already up to date")}`);
  return EXIT_OK;
}

// Local live watcher (the former `omg watch`): prime with a sweep, then run the
// external fs-adapter watcher until a signal, keeping embeddings warm.
async function runLocalWatch(cli: Cli, ws: Workspace, repo: RepoRow): Promise<number> {
  const lease = WatchLease.tryAcquire(ws.omgbaseDir);
  if (!lease) throw new EngineErrorLike("target_missing", "another watcher already holds the lease for this workspace");

  const embedding = await loadEmbedding(ws, repo.repoId);
  const drainer = embedding
    ? new EmbedDrainer(ws.store, repo.repoId, embedding.worker, {
        onDrain: ({ embedded }) => cli.io.err(cli.style.dim(`  embedded ${embedded} block(s)`)),
        onError: (err) => cli.io.err(cli.style.dim(`  embed drain failed: ${String(err)}`)),
      })
    : null;

  if (repo.rootPath) freshnessSweep(ws.store, repo.repoId, repo.rootPath); // start fresh

  const source = await openRepoSource(ws.store, repo);
  if (!source) {
    cli.io.err(cli.style.dim(`  ${repo.slug} has no filesystem source — nothing to watch`));
    lease.release();
    if (drainer) await drainer.close();
    if (embedding) await embedding.close();
    return EXIT_OK;
  }

  const watcher = new Watcher(ws.store, repo.repoId, source, {
    onCheckpoint: (r) => {
      if (r.ingested.length || r.deleted.length || r.conflicted.length) {
        cli.io.err(`${cli.style.ok(cli.render.g.sync)} +${r.ingested.length} -${r.deleted.length}${r.conflicted.length ? ` !${r.conflicted.length}` : ""}`);
        drainer?.schedule();
      }
    },
    onError: (err) => cli.io.err(cli.style.err(`  watch error: ${String(err)}`)),
  });
  await watcher.start();
  drainer?.schedule(); // embed anything already stale at startup, in the background
  cli.io.err(cli.style.dim(`  watching ${repo.slug} — Ctrl-C to stop${drainer ? " · auto-embed on" : ""}`));

  await new Promise<void>((resolveWait) => {
    const stop = (): void => {
      const watchdog = setTimeout(() => process.exit(EXIT_OK), 3000);
      void (async () => {
        try {
          await watcher.stop();
          await source.close();
          if (drainer) { try { await drainer.flush(); } catch { /* reported via onError */ } await drainer.close(); }
          if (embedding) await embedding.close();
          lease.release();
        } finally {
          clearTimeout(watchdog);
          resolveWait();
        }
      })();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return EXIT_OK;
}

export const cmdSync: Command = { name: "sync", summary: "Reconcile a repo with its filesystem source (--watch to stay live; --server for remote)", run: (cli, a) => runSync(cli, a) };
