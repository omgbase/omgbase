import { parseArgs } from "node:util";
import { applySugar, planEffects, retargetEffects, surfacePlan, surfaceReceipt, type Plan, type Receipt, type RetargetHit } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EXIT_OK, renderHelp } from "../output.js";
import { defaultActor, renderPlan as renderPlanDiffs, renderReceipt, unifiedDiffLines } from "./_mutate.js";
import { remoteCall, remoteSugar } from "./_remote.js";

// `omg retarget <from> <to> [--scope glob] [--apply]` (11 §5.6; cli 4.0) —
// plan-by-default. Without --apply it is `plan { effects: [retarget] }` and
// prints, per hit of the Plan's `preview.retarget[0].hits`, the unified diff of
// the block's raw (the same diff every other preview prints — the 06 §4 "always
// preview first" contract, encoded as the default); the retarget effect comes
// from the shared `links_retarget` builder. --apply commits it (the Receipt +
// `hits` + `pairs`, as the `links_retarget` tool returns) and honors the global
// --dry-run as every mutator does (§3.6).

/** The retarget effect's preview (spec/mutate §11.4 `preview.retarget[0]`): the hits and per-pair counts. */
type Retarget = { hits: RetargetHit[]; pairs: { from: string; to: string; hits: number }[] };

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
  const sugar = retargetEffects([{ from, to }], values.scope, "links_retarget");

  // Remote: the `plan` tool previews, `links_retarget` commits server-side.
  if (cli.flags.server) {
    if (!values.apply || cli.flags.dryRun) {
      const plan = await remoteCall<Plan>(cli, "plan", { effects: sugar.effects, diffs: true });
      return values.apply ? renderPlanDiffs(cli, plan) : renderHits(cli, from, to, retargetOf(plan).hits);
    }
    // `links_retarget` where listed (its result adds `hits`/`pairs`), else `apply { retarget }` (spec/cli §2.3, 4.2).
    const r = await remoteSugar<Receipt & Partial<Retarget>>(cli, "links_retarget", { from_target: from, to_target: to, ...(values.scope ? { path_glob: values.scope } : {}) }, () => sugar.effects);
    return renderReceipt(cli, r);
  }

  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const request = { repoId: repo.repoId, ...(repo.rootPath ? { rootPath: repo.rootPath } : {}), omgbaseDir: ws.omgbaseDir };
  if (!values.apply) {
    // The plan (default): what WOULD change, commit nothing, mint nothing.
    const plan = surfacePlan(planEffects(ws.store, { ...request, effects: sugar.effects }));
    return renderHits(cli, from, to, retargetOf(plan).hits);
  }
  // --apply → commit (the global --dry-run plans and renders the file diffs instead, §3.6).
  const { plan, receipt } = applySugar(ws.store, { ...request, actor: values.actor ?? defaultActor(), ...(cli.flags.dryRun ? { dryRun: true } : {}) }, sugar);
  const rooted = surfacePlan(plan);
  if (!receipt) return renderPlanDiffs(cli, rooted);
  const { hits, pairs } = retargetOf(rooted);
  return renderReceipt(cli, { hits, pairs, ...surfaceReceipt(receipt) } as Receipt & Retarget, plan);
}

/** The one retarget effect's preview; a plan over no hit still carries it (empty hits, a zero count). */
function retargetOf(plan: Plan): Retarget {
  const r = plan.preview?.retarget?.[0];
  return { hits: r?.hits ?? [], pairs: r?.pairs ?? [] };
}

// Plan (default): show what WOULD change, commit nothing.
function renderHits(cli: Cli, from: string, to: string, hits: RetargetHit[]): number {
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
    io.out(style.id(h._id));
    for (const line of unifiedDiffLines(cli, h.oldRaw, h.newRaw)) io.out(line);
    io.out("");
  }
  return EXIT_OK;
}

export const cmdRetarget: Command = { name: "retarget", summary: "Rewrite a link target (plan-by-default)", run: (c, a) => runRetarget(c, a) };
