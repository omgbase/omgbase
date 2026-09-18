import { parseArgs } from "node:util";
import { freshnessSweep } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { EXIT_OK } from "../output.js";

// `omg sync` (11 §5.8) — one-shot freshness sweep, verbose: files ingested,
// dispositions summary. Idempotent; safe alongside a live watcher (hash-based
// echo suppression makes a double ingest a no-op). The router skips its implicit
// sweep for this command (SKIP_FRESHNESS) — sync IS the sweep.

function runSync(cli: Cli, args: string[]): number {
  parseArgs({ args, allowPositionals: true, options: { help: { type: "boolean" } } });
  const ws = cli.workspace();
  const repo = cli.repo(ws);
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

export const cmdSync: Command = { name: "sync", summary: "One-shot freshness sweep", run: (cli, a) => runSync(cli, a) };
