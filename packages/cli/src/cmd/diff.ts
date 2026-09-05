import { parseArgs } from "node:util";
import { findDoc, diffUnified } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK } from "../output.js";

// `omg diff <doc>` (11 §5.5) — unified diff. With no revisions: current vs
// previous ("what did the last commit do here").

function runDiff(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { from: { type: "string" }, to: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.out("  diff <doc> [--from rev] [--to rev]  — unified diff (default: current vs previous)");
    return EXIT_OK;
  }
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("diff requires a <doc>");

  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const info = ref.startsWith("d_") ? findDoc(ws.store, { docId: ref }) : findDoc(ws.store, { repoId: repo.repoId, path: ref });
  if (!info) throw new EngineErrorLike("doc_missing", `no document ${ref}`);

  // Resolve from/to revisions: default is (previous, current) by seq desc.
  const revs = ws.store.db
    .prepare("SELECT rev_id, seq FROM revisions WHERE doc_id = ? ORDER BY seq DESC LIMIT 2")
    .all(info.docId) as { rev_id: string; seq: number }[];
  const toRev = values.to ?? revs[0]?.rev_id;
  const fromRev = values.from ?? revs[1]?.rev_id ?? revs[0]?.rev_id;
  if (!toRev || !fromRev) throw new EngineErrorLike("doc_missing", `no revisions to diff for ${ref}`);

  const text = diffUnified(ws.store, info.docId, fromRev, toRev);

  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify({ doc: info.docId, path: info.path, from: fromRev, to: toRev, diff: text }));
    return EXIT_OK;
  }

  const { style, io } = cli;
  if (!text) {
    io.err(style.dim("  no changes"));
    return EXIT_OK;
  }
  for (const line of text.split("\n")) {
    if (line.startsWith("+")) io.out(style.ok(line));
    else if (line.startsWith("-")) io.out(style.err(line));
    else io.out(line);
  }
  return EXIT_OK;
}

export const cmdDiff: Command = { name: "diff", summary: "Unified diff of a document", run: (cli, a) => runDiff(cli, a) };
