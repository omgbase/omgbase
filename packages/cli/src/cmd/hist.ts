import { parseArgs } from "node:util";
import { resolveRef, historyNode } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK } from "../output.js";

// `omg hist <node>` (11 §5.5) — history_node: a block's biography.

function runHist(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { n: { type: "string", short: "n" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.out("  hist <node> [-n N]  — a block's change biography");
    return EXIT_OK;
  }
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("hist requires a <node>");

  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const resolved = resolveRef(ws.store, repo.repoId, ref);
  if (!resolved || resolved.kind !== "block") throw new EngineErrorLike("block_missing", `hist needs a block id; got ${ref}`);

  const changes = historyNode(ws.store, resolved.blockId!, values.n ? { limit: Number(values.n) } : {});

  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(changes));
    return EXIT_OK;
  }
  if (cli.flags.mode === "jsonl") {
    for (const c of changes) cli.io.out(JSON.stringify(c));
    return EXIT_OK;
  }

  const { style, io } = cli;
  if (changes.length === 0) {
    io.err(style.dim("  no history"));
    return EXIT_OK;
  }
  for (const c of changes) {
    const conf = c.confidence != null ? style.dim(` (${c.confidence.toFixed(2)})`) : "";
    io.out(`${style.dim(`#${c.seq}`)} ${style.accent(c.kind)}${conf} ${style.dim(c.origin)} ${style.dim(c.ts)}`);
  }
  return EXIT_OK;
}

export const cmdHist: Command = { name: "hist", summary: "A block's change biography", run: (cli, a) => runHist(cli, a) };
