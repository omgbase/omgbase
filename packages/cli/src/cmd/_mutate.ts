import { readFileSync, readSync } from "node:fs";
import { userInfo } from "node:os";
import { apply, applyEffectsDetailed, executePlan, substituteSymbols, unifiedDiff, surfaceApplyResult, surfacePlan, surfaceReceipt, type ApplyRequest, type ApplyResult, type Op, type Plan, type Receipt } from "@omgbase/core";
import type { Cli } from "../context.js";
import type { RepoRow } from "@omgbase/core";
import type { Workspace } from "@omgbase/core";
import { CliUsageError, EXIT_OK, EXIT_ERROR } from "../output.js";
import { remoteCall } from "./_remote.js";

// Shared plumbing for every write command (11 §5.6, §5.7). Sugar commands build
// their kernel Ops, then hand them here: this sets origin.actor (human:$USER by
// default, override --actor), runs under the writer flock (omgbaseDir), threads
// --dry-run (validate + render diffs, commit nothing), and renders results or
// typed conflicts uniformly.

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

export interface RunOpsOptions {
  reason?: string;
  actor?: string;
}

/**
 * Apply a set of kernel ops as one changeset and render the outcome. Honors
 * cli.flags.dryRun (per-file unified diffs to stdout, nothing committed) and
 * cli.flags.mode (--json emits ApplyResult verbatim). Typed conflicts are
 * rendered by the caller's catch via the output contract; we let apply throw.
 */
export function runOps(cli: Cli, ws: Workspace, repo: RepoRow, ops: Op[], opts: RunOpsOptions = {}): number {
  if (ops.length === 0) {
    cli.io.err(cli.style.dim("  nothing to do"));
    return EXIT_OK;
  }
  const req: ApplyRequest = {
    repoId: repo.repoId,
    ...(repo.rootPath ? { rootPath: repo.rootPath } : {}),
    ops,
    origin: { actor: opts.actor ?? defaultActor(), ...(opts.reason ? { reason: opts.reason } : {}) },
    omgbaseDir: ws.omgbaseDir,
    ...(cli.flags.dryRun ? { dryRun: true } : {}),
  };

  // The reference form on every printed path (spec/surface §1 "Paths"): the
  // kernel's result is re-shaped exactly as the MCP server re-shapes it.
  const result = surfaceApplyResult(apply(ws.store, req));
  return renderApply(cli, result);
}

/**
 * Remote peer of runOps: call the changeset-producing tool that mirrors this
 * command (blocks_insert, blocks_check, …) against the `--server` engine — the
 * server resolves refs + pins CAS + applies — then render the returned
 * ApplyResult with the SAME renderers as local. --dry-run is threaded as the
 * tool's dry_run so the preview comes back without committing.
 */
export async function runOpsRemote(cli: Cli, tool: string, toolArgs: Record<string, unknown>): Promise<number> {
  const result = await remoteCall<ApplyResult>(cli, tool, {
    ...toolArgs,
    ...(cli.flags.dryRun ? { dry_run: true } : {}),
  });
  return renderApply(cli, result);
}

// ---- the Effect layer (ADR-021; spec/cli 3.2 `apply -f { effects }`, `execute`) ----

/**
 * `apply` given `{ effects }`: plan + execute as one transaction
 * (`applyEffects`, spec/mutate §11.7) under the writer flock, rendered as a
 * Receipt. `--dry-run` plans only and renders the Plan — unlike every other
 * dry run (§3.6) it burns no id: planning runs under the symbolic minter and
 * the ids it reports are `$new.n`. An empty list is `nothing to do`, as for `ops`.
 */
export function runEffects(cli: Cli, ws: Workspace, repo: RepoRow, effects: unknown[], opts: RunOpsOptions = {}): number {
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

/** Remote peer of `runEffects`: the `apply` tool with `effects` (its `dry_run` returns the Plan, else the Receipt). */
export async function runEffectsRemote(cli: Cli, effects: unknown[], reason?: string): Promise<number> {
  const res = await remoteCall<Plan | Receipt>(cli, "apply", { effects, ...(reason ? { reason } : {}), ...(cli.flags.dryRun ? { dry_run: true } : {}) });
  return cli.flags.dryRun ? renderPlan(cli, res as Plan) : renderReceipt(cli, res as Receipt);
}

/** `execute`: commit exactly a Plan (the plan form, spec/mutate §11.7 — admission, then the one transaction), rendered as a Receipt. */
export function runExecutePlan(cli: Cli, ws: Workspace, repo: RepoRow, plan: unknown, opts: RunOpsOptions = {}): number {
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
 * A Receipt: `--json` verbatim; human the commit confirmation of §4 (one
 * revision per touched document) and, on stdout, the ids the write names —
 * the plan's `preview.results[].ids` with every `$new.n` realized from
 * `new_ids` when the plan is at hand with its preview (a local `apply`, any
 * `execute`), exactly the ids the `ops` form prints; else (a plan echoed
 * without `preview`, a remote `apply`) every id the plan minted, the `new_ids`
 * values in order — which includes the discarded mints of a re-parse
 * (`spec/mutate` §10), ids that name no row.
 */
export function renderReceipt(cli: Cli, receipt: Receipt, plan?: unknown): number {
  cli.capture?.(receipt);
  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify(receipt));
    return EXIT_OK;
  }
  const { render, style, io } = cli;
  const n = receipt.revisions.length;
  io.err(style.dim(`  ${style.ok(render.g.ok)} committed · ${n} document${n === 1 ? "" : "s"} touched`));
  for (const id of receiptIds(receipt, plan)) io.out(id);
  return EXIT_OK;
}

export function receiptIds(receipt: Receipt, plan: unknown): string[] {
  const results = (plan as { preview?: { results?: { ids?: unknown }[] } } | null)?.preview?.results;
  if (!Array.isArray(results)) return Object.values(receipt.new_ids);
  const ids: string[] = [];
  for (const r of results) if (Array.isArray(r.ids)) for (const id of r.ids) if (typeof id === "string") ids.push(id);
  return substituteSymbols(ids, receipt.new_ids);
}

/** Capture + render an ApplyResult (shared by the local and remote paths). */
function renderApply(cli: Cli, result: ApplyResult): number {
  cli.capture?.(result); // shell: ApplyResult — its minted/affected ids are the frame
  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify(result));
    return EXIT_OK;
  }
  return cli.flags.dryRun ? renderDryRun(cli, result) : renderCommitted(cli, result);
}

function renderDryRun(cli: Cli, result: ApplyResult): number {
  renderDiffs(cli, result.diffs ?? {});
  return EXIT_OK;
}

/**
 * The dry-run rendering every write verb shares (spec/cli §3.6): the note on
 * stderr, then per changed file the path, the unified diff of before → after
 * (`spec/surface` §3) and an empty line. Document verbs hand their
 * `DocOpResult.diffs` here; block verbs their `ApplyResult.diffs`.
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

function renderCommitted(cli: Cli, result: ApplyResult): number {
  const { render, style, io } = cli;
  const g = render.g;
  const n = result.revisions.length;
  io.err(style.dim(`  ${style.ok(g.ok)} committed · ${n} document${n === 1 ? "" : "s"} touched`));
  // stdout stays useful for pipes: the ids minted/affected, one per line.
  const ids = result.results.flatMap((r) => r.ids);
  for (const id of ids) io.out(id);
  return EXIT_OK;
}

export { EXIT_OK, EXIT_ERROR };
