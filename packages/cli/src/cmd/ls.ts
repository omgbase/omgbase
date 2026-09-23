import { parseArgs } from "node:util";
import { docsList, type DocListRow, type DocListPage } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { columns } from "../render.js";
import { EXIT_OK, renderHelp } from "../output.js";
import { remoteCall } from "./_remote.js";

// `omg ls [glob]` (11 §5.2) — live documents: path, block count, last-commit
// time. glob is a simple prefix/suffix match on the path (SQL LIKE with * → %).
//
// The engine pages docs_list (uniform truncated+cursor contract, mcp-api §1);
// a terminal `ls` is complete by definition, so this walks every page — local
// or `--server` — and renders the concatenation.

async function runLs(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { help: { type: "boolean" } } });
  if (values.help) {
    return renderHelp(cli, {
      name: "ls",
      summary: "List live documents: path, block count, last-commit time (always the complete listing)",
      usage: "ls [<glob>] [--ids|--json|--jsonl]",
      options: [
        ["<glob>", "path filter; `*` matches any run of characters (`notes/*.md`)"],
        ["--ids", "paths only, one per line (pipe fuel)"],
      ],
    });
  }
  const glob = positionals[0];

  const rows: DocListRow[] = [];
  let cursor: string | null = null;
  do {
    let page: DocListPage;
    if (cli.flags.server) {
      page = await remoteCall<DocListPage>(cli, "docs_list", { ...(glob ? { path_glob: glob } : {}), ...(cursor ? { cursor } : {}) });
    } else {
      const ws = cli.workspace();
      const repo = cli.repo(ws);
      page = docsList(ws.store, repo.repoId, { ...(glob ? { pathGlob: glob } : {}), ...(cursor ? { cursor } : {}) });
    }
    rows.push(...page.items);
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  cli.capture?.(rows); // shell: docs become the addressable frame (ref = path)

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

  const { style, io } = cli;
  if (rows.length === 0) {
    io.err(style.dim("  no documents"));
    return EXIT_OK;
  }
  const table = rows.map((r) => [
    style.accent(r.path),
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
