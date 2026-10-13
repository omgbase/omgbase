import { parseArgs } from "node:util";
import { applyEffectsDetailed, planEffects, referencePath, renderIdentityPlan, surfacePlan, surfaceReceipt, type Effect, type Plan, type Receipt } from "@omgbase/core";
import type { Cli } from "../context.js";
import type { Command } from "../commands.js";
import { CliUsageError, EXIT_OK, renderHelp } from "../output.js";
import { readContent, extractContentOpts, receiptIds, defaultActor, renderSummary } from "./_mutate.js";
import { cmdUpdate as cmdUpdateBlock } from "./mutate.js";
import { remoteCall, remoteSugar, docLocator, requireDoc } from "./_remote.js";

// `omg update <target> (-f file | -)`: a polymorphic-target command (the omgbase
// north-star — every command accepts any entity ref). A block id (b_…) replaces
// that block's markdown (CAS-pinned, the low-level op). A doc id or path is the
// whole-document update: the complete proposed document is ONE `set content`
// effect (spec/mutate §11.3; the `docs_update` tool's sugar, spec/surface 4.0) —
// the engine reconciles it against the current tree, preserves stable block ids
// for recognizably-same structure, and commits the derived ops as one
// transaction. The global --dry-run is the plan: it prints the identity
// consequences from the Plan's `preview.identity` (spec/cli §3.6, 4.0: every dry
// run is a plan and burns no id) and commits nothing.

function runUpdate(cli: Cli, args: string[]): number | Promise<number> {
  // Peek at the target to dispatch: a `b_` token is a block replace — a token
  // that names no live block fails there as block_missing (spec/cli §6), never
  // as a document path; anything else (d_ id or path) is a whole-document
  // update. The block path re-parses args.
  const peek = extractContentOpts(args);
  const target = peek.rest.find((a) => !a.startsWith("-"));
  if (target && target.startsWith("b_")) return cmdUpdateBlock.run(cli, args);
  return runDocUpdate(cli, args);
}

async function runDocUpdate(cli: Cli, args: string[]): Promise<number> {
  const content = extractContentOpts(args);
  const { values, positionals } = parseArgs({
    args: content.rest,
    allowPositionals: true,
    options: { actor: { type: "string" }, reason: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "update",
      summary: "Replace a block's markdown (b_… target), or reconcile a whole document from complete new bytes (doc id/path)",
      usage: "update <block|doc> (-m <markdown> | -f <file> | -) [--expect <hash>] [--reason <s>] [--actor <s>] [--dry-run]",
      options: [
        ["-m <markdown>", "content inline"],
        ["-f <file>", "content from a file"],
        ["-", "content from stdin"],
        ["--dry-run", "(doc) print the reconciliation plan — identity effects + summary — and commit nothing"],
        ["--expect <hash>", "(block) fail with stale_expectation unless the block's hash still matches"],
        ["--reason <s>", "commit reason recorded in history"],
        ["--actor <s>", "commit actor (default human:$USER)"],
      ],
    });
  }
  const doc = positionals[0];
  if (!doc) throw new CliUsageError("update requires a <doc> (id or path)");
  const bytes = readContent(content);
  const dryRun = cli.flags.dryRun;

  let plan: Plan | undefined;
  let receipt: Receipt | undefined;
  if (cli.flags.server) {
    // Remote: the `docs_update` tool commits the `set content` server-side and
    // returns the Receipt (the confirmation then lists the ids it minted, as a
    // remote `apply` does); the dry run is the `plan` tool over the same effect.
    // A server without `docs_update` (a minimal profile) gets `apply` over the same effect (spec/cli §2.3, 4.2).
    const setContent = { op: "set", target: { kind: "document", ...docLocator(doc) }, field: "content", value: bytes };
    if (dryRun) plan = await remoteCall<Plan>(cli, "plan", { effects: [setContent] });
    else receipt = await remoteSugar<Receipt>(cli, "docs_update", { ...docLocator(doc), content: bytes, ...(values.reason ? { reason: values.reason } : {}) }, () => [setContent]);
  } else {
    const ws = cli.workspace();
    const repo = cli.repo(ws);
    if (!repo.rootPath) throw new CliUsageError(`repo '${repo.slug}' has no filesystem source; 'update' needs a working tree`);
    const effects: Effect[] = [{ op: "set", target: { kind: "document", id: requireDoc(ws.store, repo.repoId, doc) }, field: "content", value: bytes }];
    const req = {
      repoId: repo.repoId,
      rootPath: repo.rootPath,
      effects,
      origin: { actor: values.actor ?? defaultActor(), ...(values.reason ? { reason: values.reason } : {}) },
      ...(ws.omgbaseDir ? { omgbaseDir: ws.omgbaseDir } : {}),
    };
    if (dryRun) {
      plan = surfacePlan(planEffects(ws.store, req));
    } else {
      const res = applyEffectsDetailed(ws.store, req);
      plan = surfacePlan(res.plan);
      receipt = res.receipt === undefined ? undefined : surfaceReceipt(res.receipt);
    }
  }

  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify(receipt ?? plan));
    return EXIT_OK;
  }

  if (receipt === undefined) {
    // The plan: its one effect names the document; `preview.identity[<id>]` is
    // the opset plan (one line per op, an empty line, the summary).
    const target = plan!.effects[0] && "target" in plan!.effects[0] ? plan!.effects[0].target : undefined;
    const docId = target && target.kind === "document" ? target.id : undefined;
    const path = target && target.kind === "document" ? referencePath(target.path) : doc;
    const identity = docId !== undefined ? plan!.preview?.identity?.[docId] : undefined;
    cli.io.err(cli.style.dim(`  plan for ${cli.style.accent(path)}`));
    if (identity) cli.io.out(renderIdentityPlan(identity));
    return EXIT_OK;
  }

  // The Receipt confirmation (§4): one revision per touched document; every id
  // the plan's results name, once each (a block appears in several ops' results
  // — an update then a retile of the same block — and is listed a single time).
  const g = cli.render.g;
  const n = receipt.revisions.length;
  cli.io.err(cli.style.dim(`  ${cli.style.ok(g.ok)} committed · ${n} document${n === 1 ? "" : "s"} touched`));
  renderSummary(cli, receipt.summary);
  for (const id of new Set(receiptIds(receipt, plan))) cli.io.out(id);
  return EXIT_OK;
}

export const cmdUpdateDoc: Command = { name: "update", summary: "Replace a block, or reconcile a whole document (identity-preserving)", run: (c, a) => runUpdate(c, a) };
