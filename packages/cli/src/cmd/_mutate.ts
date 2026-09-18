import { readFileSync, readSync } from "node:fs";
import { userInfo } from "node:os";
import { apply, type ApplyRequest, type ApplyResult, type Op } from "@omgbase/core";
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

function defaultActor(): string {
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

  const result = apply(ws.store, req);
  return renderApply(cli, result);
}

/**
 * Remote peer of runOps: call the changeset-producing tool that mirrors this
 * command (blocks_insert, tasks_complete, …) against the `--server` engine — the
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
  const { render, style, io } = cli;
  io.err(style.dim(`  dry run — ${Object.keys(result.diffs ?? {}).length} file(s) would change, nothing committed`));
  for (const [path, { before, after }] of Object.entries(result.diffs ?? {})) {
    io.out(`${style.bold(path)}`);
    for (const line of unifiedDiff(before, after)) {
      if (line.startsWith("+")) io.out(style.ok(line));
      else if (line.startsWith("-")) io.out(style.err(line));
      else io.out(style.dim(line));
    }
    io.out("");
  }
  void render;
  return EXIT_OK;
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

// Minimal line-based unified diff (matches the engine's diffUnified style; a
// full Myers isn't needed for a human preview).
function unifiedDiff(before: string, after: string): string[] {
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

export { EXIT_OK, EXIT_ERROR };
