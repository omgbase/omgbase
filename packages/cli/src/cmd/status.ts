import { parseArgs } from "node:util";
import { reposStatus, syncStatus, watchLeaseLive, staleEmbedCount, resolveSettings, embeddingSettings } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { EXIT_OK, emitMachine, renderHelp } from "../output.js";

// `omg status` (11 §5.2): repos_status + sync_status + watch-lease probe +
// embedding queue depth. The "where am I" command — the visual showcase. The
// machine shape is the two tools' results, nested as they are on the wire
// (spec/cli §6): `{ ...repos_status, sync: sync_status, watcher, embedQueue }`.

function runStatus(cli: Cli, args: string[]): number {
  const { values } = parseArgs({ args, allowPositionals: true, options: { help: { type: "boolean" } } });
  if (values.help) {
    return renderHelp(cli, {
      name: "status",
      summary: "Where am I: the active repo, doc/block/commit counts, sync convergence, watcher, embed queue",
      usage: "status [--repo <slug>] [--json]",
      options: [["--json", "the repos_status result, plus `sync` (the sync_status result), `watcher` (live|none) and `embedQueue` (stale embeddable blocks)"]],
    });
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const rs = reposStatus(ws.store, repo.repoId, repo.rootPath ?? undefined);
  const ss = syncStatus(ws.store, repo.repoId, repo.rootPath ?? undefined);
  const watcher = watchLeaseLive(ws.omgbaseDir);
  // Embedding queue depth (spec/search §2.3): the embeddable blocks whose
  // current context has no cached vector — for the configured model when one is
  // named, else for any. Counted from the cache alone: no provider is spawned.
  const queued = staleEmbedCount(ws.store, repo.repoId, embeddingSettings(resolveSettings(ws.store, repo.repoId)).model);

  const payload = { ...rs, sync: ss, watcher: watcher ? "live" : "none", embedQueue: queued };
  if (cli.flags.mode !== "human") return emitMachine(cli, payload);

  const { render, style, io } = cli;
  const g = render.g;
  io.out(render.wordmark(repo.slug));
  io.out(`  ${style.path(repo.rootPath ? shortenHome(repo.rootPath) : "(no source — headless)")}`);
  io.out(render.rule(40));

  // Two-column figure grid.
  const left: [string, string][] = [
    [`${style.path(g.doc)} docs`, String(rs.docs)],
    [`${style.dim(g.block)} blocks`, String(rs.blocks)],
    [`${g.diamond} commits`, String(rs.commits)],
    [`${g.arrow} edges`, String(rs.openEdges)],
  ];
  const right: [string, string][] = [
    ["watcher", watcher ? render.statusDot("live", "live") : render.statusDot("none", "none")],
    ["synced", ss.convergent ? render.statusDot("ok", "converged") : render.statusDot("warn", syncedLabel(ss, rs.unconverged))],
    ["queue", queued === 0 ? style.dim("empty") : style.warn(`${queued} queued`)],
    ["commit#", style.dim(String(ss.lastCommitSeq))],
  ];

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    const lCell = l ? `  ${l[0]}  ${style.bold(l[1])}` : "  ";
    const rCell = r ? `${style.dim(r[0].padEnd(8))}${r[1]}` : "";
    io.out(padVisible(lCell, 26) + rCell);
  }
  return EXIT_OK;
}

// Summarize why the repo isn't convergent: DB-internal lag and/or on-disk drift.
function syncedLabel(ss: ReturnType<typeof syncStatus>, unconverged: number): string {
  const parts: string[] = [];
  if (unconverged > 0) parts.push(`${unconverged} behind`);
  if (ss.disk.deleted > 0) parts.push(`${ss.disk.deleted} deleted`);
  if (ss.disk.changed > 0) parts.push(`${ss.disk.changed} drifted`);
  if (ss.disk.untracked > 0) parts.push(`${ss.disk.untracked} untracked`);
  if (!ss.diskChecked) parts.push("disk unverified");
  return parts.length > 0 ? parts.join(", ") : "unconverged";
}

// Local width-aware pad (mirrors render.visibleWidth without importing the class).
const ANSI = /\x1b\[[0-9;]*m/g;
function padVisible(s: string, w: number): string {
  const vis = s.replace(ANSI, "").length;
  return vis >= w ? s : s + " ".repeat(w - vis);
}
function shortenHome(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export const cmdStatus: Command = { name: "status", summary: "Where am I: repo, sync, watcher, queue", run: (cli, a) => runStatus(cli, a) };
