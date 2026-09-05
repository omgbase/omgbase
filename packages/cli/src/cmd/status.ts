import { parseArgs } from "node:util";
import { reposStatus, syncStatus, watchLeaseLive } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { EXIT_OK } from "../output.js";

// `omg status` (11 §5.2): repos_status + sync_status + watch-lease probe +
// embedding queue depth. The "where am I" command — the visual showcase.

function runStatus(cli: Cli, args: string[]): number {
  parseArgs({ args, allowPositionals: true, options: { help: { type: "boolean" } } });
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const rs = reposStatus(ws.store, repo.repoId);
  const ss = syncStatus(ws.store, repo.repoId);
  const watcher = watchLeaseLive(ws.omgbaseDir);
  // Embedding queue depth: count blocks whose embeddings are missing is a v1
  // approximation; the queue table isn't wired yet, so report 0 (05 §6 stub).
  const queued = 0;

  const payload = {
    repo: repo.slug,
    root: repo.rootPath,
    documents: rs.documents,
    blocks: rs.blocks,
    commits: rs.commits,
    openEdges: rs.openEdges,
    unconverged: rs.unconverged,
    convergent: ss.convergent,
    lastCommitSeq: ss.lastCommitSeq,
    watcher: watcher ? "live" : "none",
    embedQueue: queued,
  };

  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify(payload));
    return EXIT_OK;
  }

  const { render, style, io } = cli;
  const g = render.g;
  io.out(render.wordmark(repo.slug));
  io.out(`  ${style.path(shortenHome(repo.rootPath))}`);
  io.out(render.rule(40));

  // Two-column figure grid.
  const left: [string, string][] = [
    [`${style.path(g.doc)} docs`, String(rs.documents)],
    [`${style.dim(g.block)} blocks`, String(rs.blocks)],
    [`${g.diamond} commits`, String(rs.commits)],
    [`${g.arrow} edges`, String(rs.openEdges)],
  ];
  const right: [string, string][] = [
    ["watcher", watcher ? render.statusDot("live", "live") : render.statusDot("none", "none")],
    ["synced", ss.convergent ? render.statusDot("ok", "converged") : render.statusDot("warn", `${rs.unconverged} behind`)],
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
