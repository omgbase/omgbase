import { parseArgs } from "node:util";
import { linksRetarget } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EXIT_OK } from "../output.js";
import { runOps } from "./_mutate.js";

// `omg retarget <from> <to> [--scope glob] [--apply]` (11 §5.6) — plan-by-default.
// Without --apply it runs the dry-run and prints the per-block diffs (the 06 §4
// "always dry-run first" contract, encoded as the default). --apply commits.

function runRetarget(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { scope: { type: "string" }, apply: { type: "boolean" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  retarget <from> <to> [--scope glob] [--apply]  — rewrite a link target; plan-by-default");
    return EXIT_OK;
  }
  const from = positionals[0];
  const to = positionals[1];
  if (!from || !to) throw new CliUsageError("retarget requires <from> and <to> targets");

  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const { ops, hits } = linksRetarget(ws.store, repo.repoId, from, to);

  // --apply → commit via the shared helper (honors --dry-run too, if combined).
  if (values.apply) {
    return runOps(cli, ws, repo, ops, values.actor ? { actor: values.actor } : {});
  }

  // Plan (default): show what WOULD change, commit nothing.
  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify({ from, to, hits }));
    return EXIT_OK;
  }
  const { style, io } = cli;
  if (hits.length === 0) {
    io.err(style.dim(`  no blocks reference ${from}`));
    return EXIT_OK;
  }
  io.err(style.dim(`  plan — ${hits.length} block(s) would change; re-run with --apply to commit`));
  for (const h of hits) {
    io.out(style.id(h.block));
    for (const line of lineDiff(h.oldRaw, h.newRaw)) {
      io.out(line.startsWith("+") ? style.ok(line) : line.startsWith("-") ? style.err(line) : style.dim(line));
    }
    io.out("");
  }
  return EXIT_OK;
}

function lineDiff(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(`- ${a[i]}`);
    if (b[i] !== undefined) out.push(`+ ${b[i]}`);
  }
  return out;
}

export const cmdRetarget: Command = { name: "retarget", summary: "Rewrite a link target (plan-by-default)", run: (c, a) => runRetarget(c, a) };
