import { parseArgs } from "node:util";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { columns } from "../render.js";
import { EXIT_OK } from "../output.js";

// `omg ls [glob]` (11 §5.2) — live documents: path, block count, last-commit
// time. glob is a simple prefix/suffix match on the path (SQL LIKE with * → %).

interface DocRow {
  path: string;
  blocks: number;
  ts: string | null;
}

function runLs(cli: Cli, args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: { help: { type: "boolean" } } });
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const glob = positionals[0];

  const like = glob ? glob.replace(/[%_]/g, "\\$&").replace(/\*/g, "%") : "%";
  const rows = ws.store.db
    .prepare(
      `SELECT d.path AS path,
              (SELECT count(*) FROM blocks b WHERE b.doc_id = d.doc_id AND b.deleted_commit IS NULL) AS blocks,
              (SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id
                WHERE r.rev_id = d.current_rev) AS ts
       FROM docs d
       WHERE d.repo_id = ? AND d.deleted_commit IS NULL AND d.path LIKE ? ESCAPE '\\'
       ORDER BY d.path`,
    )
    .all(repo.repoId, like) as DocRow[];

  if (cli.flags.mode === "ids") {
    for (const r of rows) cli.io.out(r.path);
    return EXIT_OK;
  }
  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(rows));
    return EXIT_OK;
  }
  if (cli.flags.mode === "jsonl") {
    for (const r of rows) cli.io.out(JSON.stringify(r));
    return EXIT_OK;
  }

  const { render, style, io } = cli;
  if (rows.length === 0) {
    io.err(style.dim("  no documents"));
    return EXIT_OK;
  }
  const table = rows.map((r) => [
    `${style.path(render.g.doc)} ${style.accent(r.path)}`,
    style.dim(`${r.blocks} blocks`),
    style.dim(relTime(r.ts)),
  ]);
  for (const line of columns(table, [{}, { align: "right" }, { align: "right" }])) io.out(line);
  return EXIT_OK;
}

function relTime(ts: string | null): string {
  if (!ts) return "—";
  const then = Date.parse(ts);
  if (Number.isNaN(then)) return ts;
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export const cmdLs: Command = { name: "ls", summary: "List live documents", run: (cli, a) => runLs(cli, a) };
