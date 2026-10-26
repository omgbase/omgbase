import { parseArgs } from "node:util";
import { changesSince } from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, truncationFooter, EXIT_OK, emitMachine, renderHelp } from "../output.js";
import { remoteCall } from "./_remote.js";

type ChangesResult = ReturnType<typeof changesSince>;

// `omg log` (11 §5.5) — changes_since, one digest summary per line. Relative
// --since (24h/7d) is resolved to a literal ISO timestamp client-side, then to
// the feed seq at/just-before that time (the query language stays clock-free).
// A cursor is `(epoch, seq)` since store 17.0 (D7): `--cursor <n>` continues
// from a seq of the current epoch unless `--epoch <ep>` names the one it came
// from; a cursor the feed no longer serves is `expired_cursor` (exit 1).

function resolveSinceSeq(cli: Cli, repoId: string, since: string | undefined): number {
  if (!since) return 0;
  const iso = relativeToIso(since);
  const ws = cli.workspace();
  const row = ws.store.db
    .prepare("SELECT MAX(seq) AS seq FROM feed WHERE repo_id = ? AND epoch = (SELECT epoch FROM repos WHERE repo_id = ?) AND ts < ?")
    .get(repoId, repoId, iso) as { seq: number | null };
  // A `--since` before the oldest retained row means "everything the feed
  // holds" — cursor `oldest − 1` (cursor 0 on a feed pruned to `oldest ≥ 2`
  // is `expired_cursor` since store 17.0, spec/surface §3).
  const oldest = (ws.store.db.prepare("SELECT COALESCE(MIN(seq), 0) AS seq FROM feed WHERE repo_id = ? AND epoch = (SELECT epoch FROM repos WHERE repo_id = ?)").get(repoId, repoId) as { seq: number }).seq;
  const seq = row.seq ?? 0;
  return seq < oldest - 1 ? Math.max(oldest - 1, 0) : seq;
}

function relativeToIso(since: string): string {
  const m = /^(\d+)([hdwm])$/.exec(since.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const ms = unit === "h" ? 3600e3 : unit === "d" ? 86400e3 : unit === "w" ? 7 * 86400e3 : 30 * 86400e3;
    return new Date(Date.now() - n * ms).toISOString();
  }
  // Absolute timestamp: pass through (Date normalizes). Anything else is the
  // user's mistake, not "the epoch" (spec/cli §6 `log`).
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new CliUsageError(`bad --since '${since}' (use a relative age like 24h or 7d, or an ISO timestamp)`);
  return new Date(t).toISOString();
}

async function runLog(cli: Cli, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      cursor: { type: "string" },
      epoch: { type: "string" },
      origin: { type: "string" },
      n: { type: "string", short: "n" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "log",
      summary: "What changed: one digest per commit, newest first",
      usage: "log [--since <24h|7d|ISO>] [--cursor <n> [--epoch <ep>]] [--origin api|observed] [-n <N>]",
      options: [
        ["--since <t>", "only commits after a relative age (24h, 7d) or an ISO timestamp"],
        ["--cursor <n>", "continue from a feed sequence number (the `cursor` of a previous page)"],
        ["--epoch <ep>", "the epoch the cursor belongs to (a page's `epoch`; default: the repo's current one)"],
        ["--origin <o>", "api (agent/CLI writes) | observed (file edits picked up by sync)"],
        ["-n <N>", "max commits"],
      ],
    });
  }

  let result: ChangesResult;
  if (cli.flags.server) {
    // Remote: changes_since by cursor/limit/origin. `--since` resolves a
    // timestamp against the local commits table, which a remote client lacks —
    // use `--cursor` remotely.
    if (values.since) throw new CliUsageError("--since is not supported with --server; use --cursor <seq>");
    result = await remoteCall<ChangesResult>(cli, "changes_since", {
      ...(values.cursor ? { cursor: Number(values.cursor) } : {}),
      ...(values.epoch ? { epoch: values.epoch } : {}),
      ...(values.n ? { limit: Number(values.n) } : {}),
      ...(values.origin ? { origin: values.origin } : {}),
    });
  } else {
    const ws = cli.workspace();
    const repo = cli.repo(ws);
    const cursor = values.cursor ? Number(values.cursor) : resolveSinceSeq(cli, repo.repoId, values.since);
    const opts: Parameters<typeof changesSince>[2] = { cursor };
    if (values.epoch) opts.epoch = values.epoch;
    if (values.n) opts.limit = Number(values.n);
    if (values.origin) opts.origin = values.origin;
    result = changesSince(ws.store, repo.repoId, opts);
  }

  if (cli.flags.mode !== "human") {
    return emitMachine(cli, result, { items: result.digests, ids: result.digests.map((d) => d.commit), cursor: result.truncated ? result.cursor : null });
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
