import { parseArgs } from "node:util";
import { docsUpdate, renderOpsetPlan, isValidId, type DocsUpdateContext } from "@omgbase/core";
import type { Cli } from "../context.js";
import type { Command } from "../commands.js";
import { CliUsageError, EXIT_OK } from "../output.js";
import { readContent, extractContentOpts } from "./_mutate.js";
import { cmdUpdate as cmdUpdateBlock } from "./mutate.js";
import { remoteCall } from "./_remote.js";

// `omg update <target> (-f file | -)`: a polymorphic-target command (the omgbase
// north-star — every command accepts any entity ref). A block id (b_…) replaces
// that block's markdown (CAS-pinned, the low-level op). A doc id or path is the
// note's docs.update: submit a complete proposed document; the engine reconciles
// it against the current tree, preserves stable block ids for recognizably-same
// structure, and commits the derived opset through the kernel write path. Global
// --dry-run (or --plan) prints the plan (identity effects + summary), commits
// nothing.

function runUpdate(cli: Cli, args: string[]): number | Promise<number> {
  // Peek at the target to dispatch: a b_ id is a block replace; anything else
  // (d_ id or path) is a whole-document update. The block path re-parses args.
  const peek = extractContentOpts(args);
  const target = peek.rest.find((a) => !a.startsWith("-"));
  if (target && isValidId(target, "b")) return cmdUpdateBlock.run(cli, args);
  return runDocUpdate(cli, args);
}

async function runDocUpdate(cli: Cli, args: string[]): Promise<number> {
  const content = extractContentOpts(args);
  const { values, positionals } = parseArgs({
    args: content.rest,
    allowPositionals: true,
    options: { actor: { type: "string" }, reason: { type: "string" }, plan: { type: "boolean" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  update <target> (-f file | -)  — replace a block (b_… target) or reconcile a whole document (doc id/path)");
    cli.io.err("    --plan / --dry-run   (doc) show the opset (identity effects + summary), commit nothing");
    return EXIT_OK;
  }
  const doc = positionals[0];
  if (!doc) throw new CliUsageError("update requires a <doc> (id or path)");
  const bytes = readContent(content);
  const dryRun = Boolean(values.plan) || cli.flags.dryRun;

  let opset: ReturnType<typeof docsUpdate>["opset"];
  let result: ReturnType<typeof docsUpdate>["result"];
  if (cli.flags.server) {
    // Remote: docs_update reconciles + commits server-side, returning the same
    // { opset, result } — render unchanged.
    const r = await remoteCall<{ opset: typeof opset; result: typeof result }>(cli, "docs_update", {
      doc,
      content: bytes,
      ...(values.reason ? { reason: values.reason } : {}),
      ...(dryRun ? { dry_run: true } : {}),
    });
    opset = r.opset;
    result = r.result;
  } else {
    const ws = cli.workspace();
    const repo = cli.repo(ws);
    if (!repo.rootPath) throw new CliUsageError(`repo '${repo.slug}' has no filesystem source; 'update' needs a working tree`);
    const ctx: DocsUpdateContext = {
      repoId: repo.repoId,
      rootPath: repo.rootPath,
      ...(ws.omgbaseDir ? { omgbaseDir: ws.omgbaseDir } : {}),
      ...(values.actor ? { actor: values.actor } : {}),
    };
    ({ opset, result } = docsUpdate(ws.store, ctx, doc, bytes, {
      dryRun,
      ...(values.reason ? { reason: values.reason } : {}),
    }));
  }

  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify({ opset, result }));
    return EXIT_OK;
  }

  if (dryRun || result === null) {
    const s = opset.summary;
    cli.io.err(cli.style.dim(`  plan for ${cli.style.accent(opset.target.path)}${opset.converges ? "" : " — DOES NOT CONVERGE (will not apply)"}`));
    cli.io.out(renderOpsetPlan(opset));
    void s;
    return EXIT_OK;
  }

  const g = cli.render.g;
  cli.io.err(cli.style.dim(`  ${cli.style.ok(g.ok)} updated ${cli.style.accent(opset.target.path)} · ${opset.summary.preserved} preserved, ${opset.summary.updated} updated, ${opset.summary.moved} moved, ${opset.summary.created} created, ${opset.summary.removed} removed`));
  for (const id of result.results.flatMap((r) => r.ids)) cli.io.out(id);
  return EXIT_OK;
}

export const cmdUpdateDoc: Command = { name: "update", summary: "Replace a block, or reconcile a whole document (identity-preserving)", run: (c, a) => runUpdate(c, a) };
