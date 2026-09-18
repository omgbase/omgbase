import { parseArgs } from "node:util";
import { changesSince } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, truncationFooter, EXIT_OK } from "../output.js";
import { remoteCall } from "./_remote.js";

type ChangesResult = ReturnType<typeof changesSince>;

// `omg log` (11 §5.5) — changes_since, one digest summary per line. Relative
// --since (24h/7d) is resolved to a literal ISO timestamp client-side, then to
// the commit seq at/just-before that time (the query language stays clock-free).

function resolveSinceSeq(cli: Cli, repoId: string, since: string | undefined): number {
  if (!since) return 0;
  const iso = relativeToIso(since);
  const ws = cli.workspace();
  const row = ws.store.db
    .prepare("SELECT MAX(seq) AS seq FROM commits WHERE repo_id = ? AND ts < ?")
    .get(repoId, iso) as { seq: number | null };
  return row.seq ?? 0;
}

function relativeToIso(since: string): string {
  const m = /^(\d+)([hdwm])$/.exec(since.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const ms = unit === "h" ? 3600e3 : unit === "d" ? 86400e3 : unit === "w" ? 7 * 86400e3 : 30 * 86400e3;
    return new Date(Date.now() - n * ms).toISOString();
  }
  // Absolute timestamp: pass through (Date normalizes).
  const t = Date.parse(since);
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}

async function runLog(cli: Cli, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      cursor: { type: "string" },
      origin: { type: "string" },
      n: { type: "string", short: "n" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    cli.io.out("  log [--since 24h|7d|ISO] [--cursor n] [--origin api|observed] [-n N]  — commit digests");
    return EXIT_OK;
  }

  let result: ChangesResult;
  if (cli.flags.server) {
    // Remote: changes_since by cursor/limit/origin. `--since` resolves a
    // timestamp against the local commits table, which a remote client lacks —
    // use `--cursor` remotely.
    if (values.since) throw new CliUsageError("--since is not supported with --server; use --cursor <seq>");
    result = await remoteCall<ChangesResult>(cli, "changes_since", {
      ...(values.cursor ? { cursor: Number(values.cursor) } : {}),
      ...(values.n ? { limit: Number(values.n) } : {}),
      ...(values.origin ? { origin: values.origin } : {}),
    });
  } else {
    const ws = cli.workspace();
    const repo = cli.repo(ws);
    const cursor = values.cursor ? Number(values.cursor) : resolveSinceSeq(cli, repo.repoId, values.since);
    const opts: Parameters<typeof changesSince>[2] = { cursor };
    if (values.n) opts.limit = Number(values.n);
    if (values.origin) opts.origin = values.origin;
    result = changesSince(ws.store, repo.repoId, opts);
  }

  if (cli.flags.mode === "json") {
    cli.io.out(JSON.stringify(result));
    return EXIT_OK;
  }
  if (cli.flags.mode === "jsonl") {
    for (const d of result.digests) cli.io.out(JSON.stringify(d));
    if (result.truncated) truncationFooter(cli.io, cli.style, result.cursor);
    return EXIT_OK;
  }
  if (cli.flags.mode === "ids") {
    for (const d of result.digests) cli.io.out(d.commit);
    return EXIT_OK;
  }

  const { style, io } = cli;
  if (result.digests.length === 0) {
    io.err(style.dim("  no changes"));
    return EXIT_OK;
  }
  for (const d of result.digests) {
    const origin = d.origin === "observed" ? style.accent(d.origin.padEnd(8)) : style.warn(d.origin.padEnd(8));
    io.out(`${style.dim(`#${d.seq}`)} ${origin} ${d.summary}`);
  }
  if (result.truncated) truncationFooter(io, style, result.cursor);
  return EXIT_OK;
}

export const cmdLog: Command = { name: "log", summary: "Commit digests (change feed)", run: (cli, a) => runLog(cli, a) };
