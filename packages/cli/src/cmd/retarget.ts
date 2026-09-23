import { parseArgs } from "node:util";
import { linksRetarget } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EXIT_OK, renderHelp } from "../output.js";
import { runOps } from "./_mutate.js";
import { remoteCall } from "./_remote.js";

interface RetargetHit { block: string; oldRaw: string; newRaw: string; }

// `omg retarget <from> <to> [--scope glob] [--apply]` (11 §5.6) — plan-by-default.
// Without --apply it runs the dry-run and prints the per-block diffs (the 06 §4
// "always dry-run first" contract, encoded as the default). --apply commits.

async function runRetarget(cli: Cli, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { scope: { type: "string" }, apply: { type: "boolean" }, actor: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "retarget",
      summary: "Rewrite every link that points at <from> to point at <to> — plan-by-default, --apply commits",
      usage: "retarget <from> <to> [--scope <glob>] [--apply] [--actor <s>] [--dry-run]",
      options: [
        ["--scope <glob>", "only rewrite links in documents matching the path glob"],
        ["--apply", "commit the rewrite (default: print the plan only)"],
        ["--actor <s>", "commit actor (default human:$USER)"],
      ],
    });
  }
  const from = positionals[0];
  const to = positionals[1];
  if (!from || !to) throw new CliUsageError("retarget requires <from> and <to> targets");

  // Remote: links_retarget resolves + (optionally) applies server-side.
  if (cli.flags.server) {
    const r = await remoteCall<{ hits: RetargetHit[]; applied: boolean }>(cli, "links_retarget", { from_target: from, to_target: to, dry_run: !values.apply });
    if (values.apply) {
      if (cli.flags.mode !== "human") cli.io.out(JSON.stringify(r));
      else cli.io.err(cli.style.dim(`  ${cli.style.ok(cli.render.g.ok)} retargeted ${r.hits.length} block(s)`));
      return EXIT_OK;
    }
    return renderPlan(cli, from, to, r.hits);
  }

  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const { ops, hits } = linksRetarget(ws.store, repo.repoId, from, to);

  // --apply → commit via the shared helper (honors --dry-run too, if combined).
  if (values.apply) {
    return runOps(cli, ws, repo, ops, values.actor ? { actor: values.actor } : {});
  }
  return renderPlan(cli, from, to, hits);
}

// Plan (default): show what WOULD change, commit nothing.
function renderPlan(cli: Cli, from: string, to: string, hits: RetargetHit[]): number {
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
