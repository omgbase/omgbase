import { readFileSync, readSync } from "node:fs";
import { userInfo } from "node:os";
import { applyEffectsDetailed, applySugar, executePlan, isValidId, substituteSymbols, unifiedDiff, surfacePlan, surfaceReceipt, type EffectTarget, type Plan, type Receipt, type Sugar } from "@omgbase/core";
import type { Cli } from "../context.js";
import type { RepoRow } from "@omgbase/core";
import type { Workspace } from "@omgbase/core";
import { CliUsageError, EXIT_OK, EXIT_ERROR } from "../output.js";
import { remoteCall, remoteSugar } from "./_remote.js";

// Shared plumbing for every write command (spec/cli §3.6, §4; ADR-021's
// retirement release, cli 4.0). The sugar verbs build their effects with the
// shared builders of `@omgbase/core` (`mutate/sugar.ts` — the same table the
// MCP tools use), then hand them here: this sets origin.actor (human:$USER by
// default, override --actor), runs under the writer flock (omgbaseDir),
// threads the global --dry-run as a `plan` (render the preview's diffs, mint
// nothing, commit nothing), and renders the Receipt or the Plan uniformly.
// Typed conflicts are rendered by the caller's catch via the output contract;
// we let the planner throw.

/** Read markdown content from -m, -f (file, or "-" = stdin), or bare stdin. */
export function readContent(values: { m?: string; f?: string }, allowStdin = true): string {
  if (values.m !== undefined) return values.m;
  if (values.f !== undefined) return values.f === "-" ? readStdin() : readFileSync(values.f, "utf8");
  if (allowStdin) return readStdin();
  throw new CliUsageError("provide content with -m <md> or -f <file>");
}

/**
 * Pull content-bearing options out of argv before `parseArgs` sees them, so a
 * value that starts with `-` (list/task markdown like "- [ ] x") is taken
 * verbatim as the next token rather than mis-parsed as a flag. Handles
 * -m/--message and -f/--file (and their `=` forms). Returns the extracted
 * values plus the remaining argv for normal option parsing.
 */
export function extractContentOpts(args: string[]): { m?: string; f?: string; rest: string[] } {
  const rest: string[] = [];
  let m: string | undefined;
  let f: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      rest.push(...args.slice(i));
      break;
    }
    if (a === "-m" || a === "--message") {
      m = args[++i];
      if (m === undefined) throw new CliUsageError(`${a} requires a value`);
    } else if (a.startsWith("-m=")) {
      m = a.slice(3);
    } else if (a.startsWith("--message=")) {
      m = a.slice("--message=".length);
    } else if (a === "-f" || a === "--file") {
      f = args[++i];
      if (f === undefined) throw new CliUsageError(`${a} requires a value`);
    } else if (a.startsWith("-f=")) {
      f = a.slice(3);
    } else if (a.startsWith("--file=")) {
      f = a.slice("--file=".length);
    } else {
      rest.push(a);
    }
  }
  return { ...(m !== undefined ? { m } : {}), ...(f !== undefined ? { f } : {}), rest };
}

export function readStdin(): string {
  // Read fd 0 to EOF synchronously. `readFileSync(0)` is not enough: when stdin
  // is a pipe whose writer hasn't produced data yet (the common `… | omg done -`
  // case) the fd is non-blocking and the read throws EAGAIN — swallowing that as
  // "" is why the piped idiom used to lose its input. Loop with an EAGAIN retry
  // so we actually block for the upstream command's output.
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue; // pipe not ready yet — retry
      if (code === "EOF") break; // some platforms signal EOF this way
      break; // fd not readable (no stdin) — treat as empty
    }
    if (n === 0) break; // clean EOF
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read a list of ids from stdin (one per line), for `-` block-list args. */
export function readIdsFromStdin(): string[] {
  return readStdin()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Expand a block-list argument list, substituting stdin ids for a bare "-". */
export function expandBlockArgs(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a === "-") out.push(...readIdsFromStdin());
    else out.push(a);
  }
  return out;
}

export function defaultActor(): string {
  try {
    return `human:${userInfo().username}`;
  } catch {
    return "human:unknown";
  }
}

export interface RunOpts {
  reason?: string;
  actor?: string;
}

/**
 * Run a builder's effects as one request (`applySugar`: plan + execute under the
 * writer flock, the sugar's reason unless `--reason` overrides it) and render the
 * outcome. Honors cli.flags.dryRun — the Plan: per-file unified diffs to stdout,
 * nothing minted, nothing committed (§3.6) — and cli.flags.mode (--json emits
 * the Receipt, or the Plan on a dry run, verbatim). An empty effect list is
 * `  nothing to do`.
 */
export function runSugar(cli: Cli, ws: Workspace, repo: RepoRow, sugar: Sugar, opts: RunOpts = {}): number {
  if (sugar.effects.length === 0) {
    cli.io.err(cli.style.dim("  nothing to do"));
    return EXIT_OK;
  }
  const { plan, receipt } = applySugar(ws.store, {
    repoId: repo.repoId,
    ...(repo.rootPath ? { rootPath: repo.rootPath } : {}),
    omgbaseDir: ws.omgbaseDir,
    actor: opts.actor ?? defaultActor(),
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(cli.flags.dryRun ? { dryRun: true } : {}),
  }, sugar);
  if (!receipt) return renderPlan(cli, surfacePlan(plan));
  return renderReceipt(cli, surfaceReceipt(receipt), plan);
}

/**
 * Remote peer of runSugar: call the sugar tool that mirrors this command
 * (blocks_insert, blocks_check, …) against the `--server` engine — the server
 * resolves refs + pins CAS + applies — and render the returned Receipt with the
 * SAME renderers as local. The global --dry-run is the `plan` tool over the
 * effects the verb would build (`effects` composes them from the refs as given:
 * an id names its row, anything else a document path — the server resolves);
 * no tool takes `dry_run` since surface 4.0. A server that does not list the
 * tool (spec/surface §4 "Profiles": `--tools minimal`) gets `apply { effects,
 * reason: <tool> }` from the same closure (`remoteSugar`, spec/cli §2.3);
 * `refs` are the refs the verb received, refused there when one is a locator.
 */
export async function runSugarRemote(cli: Cli, tool: string, toolArgs: Record<string, unknown>, effects: () => unknown[] | Promise<unknown[]>, refs: string[] = []): Promise<number> {
  if (cli.flags.dryRun) return renderPlan(cli, await remoteCall<Plan>(cli, "plan", { effects: await effects(), diffs: true }));
  return renderReceipt(cli, await remoteSugar<Receipt>(cli, tool, toolArgs, effects, refs));
}

/** A ref as an effect target for a remote `plan`: a `b_` id is the block, a `d_` id the document, anything else a document path. */
export function targetOf(ref: string): EffectTarget {
  if (isValidId(ref, "b")) return { kind: "block", id: ref };
  if (isValidId(ref, "d")) return { kind: "document", id: ref };
  return { kind: "document", path: ref };
}

// ---- the Effect layer (ADR-021; spec/cli 3.2 `apply -f { effects }`, `execute`) ----

/**
 * `apply` given `{ effects }`: plan + execute as one transaction
 * (`applyEffects`, spec/mutate §11.7) under the writer flock, rendered as a
 * Receipt. `--dry-run` plans only and renders the Plan (§3.6: planning runs
 * under the symbolic minter and the ids it reports are `$new.n`). An empty
 * list is `nothing to do`.
 */
export function runEffects(cli: Cli, ws: Workspace, repo: RepoRow, effects: unknown[], opts: RunOpts = {}): number {
  if (effects.length === 0) {
    cli.io.err(cli.style.dim("  nothing to do"));
    return EXIT_OK;
  }
  const req = {
    repoId: repo.repoId,
    ...(repo.rootPath ? { rootPath: repo.rootPath } : {}),
    effects,
    origin: { actor: opts.actor ?? defaultActor(), ...(opts.reason ? { reason: opts.reason } : {}) },
    omgbaseDir: ws.omgbaseDir,
  };
  const { plan, receipt } = applyEffectsDetailed(ws.store, { ...req, ...(cli.flags.dryRun ? { dryRun: true } : {}) });
  if (!receipt) return renderPlan(cli, surfacePlan(plan));
  return renderReceipt(cli, surfaceReceipt(receipt), plan);
}

/** Remote peer of `runEffects`: the `apply` tool with `effects` (the Receipt), or on a dry run the `plan` tool (the Plan). */
export async function runEffectsRemote(cli: Cli, effects: unknown[], reason?: string): Promise<number> {
  if (cli.flags.dryRun) return renderPlan(cli, await remoteCall<Plan>(cli, "plan", { effects, diffs: true }));
  return renderReceipt(cli, await remoteCall<Receipt>(cli, "apply", { effects, ...(reason ? { reason } : {}) }));
}

/** `execute`: commit exactly a Plan (the plan form, spec/mutate §11.7 — admission, then the one transaction), rendered as a Receipt. */
export function runExecutePlan(cli: Cli, ws: Workspace, repo: RepoRow, plan: unknown, opts: RunOpts = {}): number {
  const receipt = executePlan(ws.store, {
    repoId: repo.repoId,
    ...(repo.rootPath ? { rootPath: repo.rootPath } : {}),
    plan,
    origin: { actor: opts.actor ?? defaultActor(), ...(opts.reason ? { reason: opts.reason } : {}) },
    omgbaseDir: ws.omgbaseDir,
  });
  return renderReceipt(cli, surfaceReceipt(receipt), plan);
}

/** Remote peer of `runExecutePlan`: the `execute` tool's plan form. */
export async function runExecutePlanRemote(cli: Cli, plan: unknown, reason?: string): Promise<number> {
  return renderReceipt(cli, await remoteCall<Receipt>(cli, "execute", { plan, ...(reason ? { reason } : {}) }), plan);
}

/** A Plan, dry-run style: `--json` the Plan verbatim (what `execute` takes back); human the §3.6 note and the per-file diffs of its preview. */
export function renderPlan(cli: Cli, plan: Plan): number {
  cli.capture?.(plan);
  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify(plan));
    return EXIT_OK;
  }
  renderDiffs(cli, plan.preview?.diffs ?? {});
  return EXIT_OK;
}

/**
 * A Receipt (any write tool's result since 4.0 — a `links_*` result carries its
 * `hits`/`pairs` beside the receipt's keys): `--json` verbatim; human the
 * commit confirmation of §4 (one revision per touched document), the plan's
 * summary lines under it (4.3: what was committed, in words) and, on
 * stdout, the ids the write names — the plan's `preview.results[].ids` with
 * every `$new.n` realized from `new_ids` when the plan is at hand with its
 * preview (a local write, any `execute`); else (a plan echoed without
 * `preview`, a remote write) every id the plan minted, the `new_ids` values in
 * order — which includes the discarded mints of a re-parse (`spec/mutate` §10),
 * ids that name no row.
 */
export function renderReceipt(cli: Cli, receipt: Receipt, plan?: unknown): number {
  const ids = receiptIds(receipt, plan);
  cli.capture?.({ ...receipt, ids }); // shell: the ids the write names are the frame
  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify(receipt));
    return EXIT_OK;
  }
  const { render, style, io } = cli;
  const n = receipt.revisions.length;
  io.err(style.dim(`  ${style.ok(render.g.ok)} committed · ${n} document${n === 1 ? "" : "s"} touched`));
  renderSummary(cli, receipt.summary);
  for (const id of ids) io.out(id);
  return EXIT_OK;
}

/** The Receipt's `summary` (spec/cli §4, 4.3): what was committed in words, one line per effect, indented under the confirmation on stderr. */
export function renderSummary(cli: Cli, summary: readonly string[] | undefined): void {
  for (const line of summary ?? []) cli.io.err(cli.style.dim(`    ${line}`));
}

export function receiptIds(receipt: Receipt, plan: unknown): string[] {
  const results = (plan as { preview?: { results?: { ids?: unknown }[] } } | null)?.preview?.results;
  if (!Array.isArray(results)) return Object.values(receipt.new_ids);
  const ids: string[] = [];
  for (const r of results) if (Array.isArray(r.ids)) for (const id of r.ids) if (typeof id === "string") ids.push(id);
  return substituteSymbols(ids, receipt.new_ids);
}

/**
 * The dry-run rendering every write verb shares (spec/cli §3.6): the note on
 * stderr, then per changed file of the Plan's `preview.diffs` the path, the
 * unified diff of before → after (`spec/surface` §3) and an empty line.
 */
export function renderDiffs(cli: Cli, diffs: Record<string, { before: string; after: string }>): void {
  const { style, io } = cli;
  io.err(style.dim(`  dry run — ${Object.keys(diffs).length} file(s) would change, nothing committed`));
  for (const [path, { before, after }] of Object.entries(diffs)) {
    io.out(`${style.bold(path)}`);
    for (const line of unifiedDiffLines(cli, before, after)) io.out(line);
    io.out("");
  }
}

/** The unified diff of before → after (`spec/surface` §3), one styled line per entry. */
export function unifiedDiffLines(cli: Cli, before: string, after: string): string[] {
  const { style } = cli;
  return unifiedDiff(before, after).split("\n").map((line) => {
    if (line.startsWith("+")) return style.ok(line);
    if (line.startsWith("-")) return style.err(line);
    return style.dim(line);
  });
}

export { EXIT_OK, EXIT_ERROR };
