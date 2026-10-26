import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  evaluateRetention, retentionPolicy, exportHistory, attachArchive, detachArchive, listArchives, humanBytes, withWriterLock,
  enableHistory, disableHistory, purgeHistory, openCoverageFrom,
  RetentionPolicyError, NotASegment, StaleSegment, ARCHIVE_DIR,
  type RetentionPlan, type ExportResult, type ArchiveListing, type Workspace, type HistoryLifecycleResult, type HistoryPurgeResult,
} from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK, emitMachine, renderHelp } from "../output.js";
import { columns } from "../render.js";

// `omg history <enable|disable|purge|plan|export|attach|detach|list>` (spec/cli
// §6 `history`, cli 4.6; `enable|disable` cli 5.1 — store 17.1 Phase 4a;
// `purge` cli 5.2 — store 17.2 Phase 4b): the operator surface of history
// CAPTURE (spec/store §5.9: `enable` turns the repository's capture on with a
// baseline commit and opens a coverage interval, `disable` closes it — the rows
// stay, reads of what was captured keep working; §7.6: `purge` removes the rows)
// and of history RETENTION (spec/store §7 "Retention", 15.0: `plan` evaluates
// the policy and prints what would move; `export` writes one archive segment
// and with `--prune` squashes the store; `attach` / `detach` / `list` manage
// the segment registry). No MCP tool: the catalog's traces are
// `version.capabilities.history`, the `revisions.archived` attribute,
// `capability_unavailable` and `revision_archived`.

const SUBCOMMANDS = ["enable", "disable", "purge", "plan", "export", "attach", "detach", "list"] as const;
type Sub = (typeof SUBCOMMANDS)[number];

function renderCard(cli: Cli): number {
  return renderHelp(cli, {
    name: "history",
    summary: "History capture (enable/disable/purge per repository) and retention: plan what the policy would archive, export it to a segment, attach/detach/list segments",
    usage: [
      "history enable [--best-effort]",
      "history disable",
      "history purge [--before <ts>]",
      "history plan [--before <ts>] [--policy <json|@file>]",
      "history export [--prune] [--dest <dir>] [--before <ts>] [--policy <json|@file>] [--dry-run]",
      "history attach <file|dir>",
      "history detach <segment_id|path>",
      "history list",
    ],
    options: [
      ["enable", "turn capture on for the repository: one baseline commit (origin import) records every live document's current head, a coverage interval opens, every later write is captured; idempotent"],
      ["disable", "turn capture off: the coverage interval closes, later writes record no history (the feed still does); what was captured stays readable; idempotent"],
      ["--best-effort", "(enable) do not require capture: a writer without the history module may still write (default: such a writer is refused — writer_requires)"],
      ["purge", "delete the repository's captured history — every commit, or with --before those before an instant (a live head's revision stays while capture is on); the recorder's id holds are released; the history tables are dropped when no repository is enabled and nothing is left"],
      ["plan", "per document: revisions kept / to archive and the bytes only they reach; the policy in effect"],
      ["export", "write ONE new segment file (default dest .omgbase/archives/) holding the archived revisions' bodies; --prune then squashes the store and records the segment"],
      ["attach <path>", "record a segment file (or every segment of a directory that belongs to this repo) so reads at its revisions work again"],
      ["detach <ref>", "forget a segment by id or path (its revisions stay listed; reading one is revision_archived)"],
      ["list", "the repo's segments: commit range, revisions, bytes, state (attached, missing, pending, detached, stale)"],
      ["--before <ts>", "(plan/export/purge) only revisions committed before this RFC 3339 instant are candidates"],
      ["--policy <p>", "a JSON object (or @file) merged over the effective history.retention settings for this run"],
      ["--prune", "(export) after the segment is durable: NULL the archived bodies, drop their change rows, sweep, record"],
      ["--dest <dir>", "(export) where the segment file goes"],
      ["--dry-run", "(export) the plan, nothing written"],
    ],
    notes: [
      "policy keys: keep_days, ladder [{ after_days, keep: \"one per day|week|month|year\" }], per_doc_max, keep_origins, overrides [{ glob, … }]",
      `e.g. ${cli.prog} history export --prune --policy '{"keep_days":90}'`,
    ],
  });
}

function parsePolicy(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliUsageError(`--policy: not JSON (${raw.startsWith("@") ? raw : "pass an object, or @file"})`);
  }
}

function parseBefore(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new CliUsageError(`bad --before '${raw}' (use an RFC 3339 instant)`);
  return new Date(t).toISOString();
}

/** The repo's effective policy with the run's `--policy` over it; a malformed policy is a usage error. */
function policyOf(ws: Workspace, repoId: string, raw: string | undefined) {
  try {
    return retentionPolicy(ws.store, repoId, parsePolicy(raw));
  } catch (e) {
    if (e instanceof RetentionPolicyError) throw new CliUsageError(`--policy: ${e.message}`);
    throw e;
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The plan rendering (`history plan`, `history export --dry-run`). */
function renderPlan(cli: Cli, plan: RetentionPlan): number {
  if (cli.flags.mode !== "human") return emitMachine(cli, plan, { items: plan.docs, ids: plan.docs.map((d) => d.id) });
  const { io, style } = cli;
  if (plan.docs.length > 0) {
    const rows: string[][] = [[style.dim("path"), style.dim("revisions"), style.dim("keep"), style.dim("archive"), style.dim("bytes")]];
    for (const d of plan.docs) rows.push([style.accent(d.path), String(d.revisions), String(d.keep.length), String(d.archive.length), humanBytes(d.bytes)]);
    for (const line of columns(rows, [{}, { align: "right" }, { align: "right" }, { align: "right" }, { align: "right" }])) io.out(`  ${line}`);
  }
  const t = plan.totals;
  if (t.archive === 0) io.out(`  nothing to archive: ${plural(t.revisions, "revision")}, all kept`);
  else io.out(`  ${t.archive} of ${plural(t.revisions, "revision")} in ${plural(t.docs, "document")} would archive ${humanBytes(t.bytes)}`);
  io.out(`  ${style.dim("policy")}  ${JSON.stringify(plan.policy)}`);
  if (plan.before !== null) io.out(`  ${style.dim("before")}  ${plan.before}`);
  return EXIT_OK;
}

function commitRange(lo: number, hi: number): string {
  return lo === hi ? `commit #${lo}` : `commits #${lo}–#${hi}`;
}

function runPlan(cli: Cli, args: string[]): number {
  const { values } = parseArgs({ args, allowPositionals: false, options: { before: { type: "string" }, policy: { type: "string" } } });
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const before = parseBefore(values.before);
  const plan = evaluateRetention(ws.store, repo.repoId, { policy: policyOf(ws, repo.repoId, values.policy), ...(before !== undefined ? { before } : {}) });
  return renderPlan(cli, plan);
}

function renderExport(cli: Cli, r: ExportResult): number {
  if (cli.flags.mode !== "human") return emitMachine(cli, { segment: r.segment, reused: r.reused, squashed: r.squashed, gc: r.gc, totals: r.plan.totals });
  const { io, style } = cli;
  if (!r.segment) {
    io.err(style.dim("  nothing to archive"));
    return EXIT_OK;
  }
  const s = r.segment;
  io.out(s.path);
  io.err(style.dim(`  ${r.reused ? `finished the unrecorded segment ${s.id}` : `wrote segment ${s.id}`}: ${plural(s.revision_count, "revision")} (${commitRange(s.seq_lo, s.seq_hi)}), ${humanBytes(s.bytes)}`));
  if (r.squashed && r.gc) {
    const q = r.squashed;
    io.err(style.dim(`  squashed ${plural(q.revisions, "revision")}, ${plural(q.commits, "commit")}, ${plural(q.dispositions, "disposition")}, ${plural(q.block_changes, "block change")}; swept ${plural(r.gc.blobs, "blob")}, ${plural(r.gc.tree_nodes, "tree node")}`));
  }
  return EXIT_OK;
}

function defaultDest(ws: Workspace): string {
  return join(ws.omgbaseDir, ARCHIVE_DIR);
}

function runExport(cli: Cli, args: string[]): number {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: { prune: { type: "boolean" }, dest: { type: "string" }, before: { type: "string" }, policy: { type: "string" }, "dry-run": { type: "boolean" } },
  });
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const before = parseBefore(values.before);
  const policy = policyOf(ws, repo.repoId, values.policy);
  const opts = { policy, ...(before !== undefined ? { before } : {}) };
  if (values["dry-run"] || cli.flags.dryRun) return renderPlan(cli, evaluateRetention(ws.store, repo.repoId, opts));
  const dest = values.dest ? resolve(cli.cwd, values.dest) : defaultDest(ws);
  const run = (): ExportResult => exportHistory(ws.store, repo.repoId, { ...opts, dest, prune: Boolean(values.prune) });
  try {
    // The squash is a write: under the workspace writer lock like every other.
    const result = values.prune ? withWriterLock(ws.omgbaseDir, run) : run();
    return renderExport(cli, result);
  } catch (e) {
    if (e instanceof StaleSegment) throw new EngineErrorLike("target_missing", e.message, { data: { path: e.path, rev: e.rev } });
    throw e;
  }
}

function runAttach(cli: Cli, args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const target = positionals[0];
  if (!target) throw new CliUsageError("history attach requires a <file|dir>");
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  let result;
  try {
    result = withWriterLock(ws.omgbaseDir, () => attachArchive(ws.store, repo.repoId, resolve(cli.cwd, target)));
  } catch (e) {
    if (e instanceof NotASegment) throw new EngineErrorLike("target_missing", e.message, { data: { path: e.path } });
    throw e;
  }
  if (cli.flags.mode !== "human") return emitMachine(cli, result, { items: result.attached, ids: result.attached.map((a) => a.segment_id) });
  const { io, style } = cli;
  if (result.attached.length === 0) io.err(style.dim("  nothing to attach"));
  for (const a of result.attached) io.err(style.dim(`  attached ${a.segment_id}: ${plural(a.revision_count, "revision")} (${commitRange(a.seq_lo, a.seq_hi)}) ${a.path}`));
  if (result.skipped > 0) io.err(style.dim(`  skipped ${plural(result.skipped, "file")} that ${result.skipped === 1 ? "is" : "are"} not this repository's segments`));
  return EXIT_OK;
}

function runDetach(cli: Cli, args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const ref = positionals[0];
  if (!ref) throw new CliUsageError("history detach requires a <segment_id|path>");
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const detached = withWriterLock(ws.omgbaseDir, () => detachArchive(ws.store, repo.repoId, ref.includes("/") || ref.endsWith(".db") ? resolve(cli.cwd, ref) : ref));
  if (detached === null) throw new EngineErrorLike("target_missing", `no archive segment ${JSON.stringify(ref)}`, { data: { segment: ref } });
  if (cli.flags.mode !== "human") return emitMachine(cli, { detached });
  cli.io.err(cli.style.dim(`  detached ${detached}`));
  return EXIT_OK;
}

function runList(cli: Cli, args: string[]): number {
  parseArgs({ args, allowPositionals: false, options: {} });
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const segments: ArchiveListing[] = listArchives(ws.store, repo.repoId, { dest: defaultDest(ws) });
  if (cli.flags.mode !== "human") return emitMachine(cli, segments, { items: segments, ids: segments.map((s) => s.segment_id) });
  const { io, style } = cli;
  if (segments.length === 0) {
    io.err(style.dim("  no segments"));
    return EXIT_OK;
  }
  const rows: string[][] = [[style.dim("segment"), style.dim("commits"), style.dim("revisions"), style.dim("bytes"), style.dim("state"), style.dim("path")]];
  for (const s of segments) rows.push([style.id(s.segment_id), s.seq_lo === s.seq_hi ? `#${s.seq_lo}` : `#${s.seq_lo}–#${s.seq_hi}`, String(s.revision_count), humanBytes(s.bytes), s.state, style.path(s.path)]);
  for (const line of columns(rows, [{}, {}, { align: "right" }, { align: "right" }])) io.out(`  ${line}`);
  return EXIT_OK;
}

/** A coverage interval's `from..to` as the human lines print it. */
function interval(i: { from: string; to: string | null }): string {
  return `${i.from}..${i.to ?? "now"}`;
}

/**
 * The `enable`/`disable` rendering: `--json` the manifest row's capture state
 * `{ state, coverage, writer_requires, changed, baseline? }` (`baseline` the
 * commit and the revisions it wrote, on an `enable` that changed something);
 * human one stderr line — `  history enabled since <ts>` / `  history already
 * enabled since <ts>` / `  history disabled (captured <from>..<to>[, …])` /
 * `  history already disabled`.
 */
function renderLifecycle(cli: Cli, verb: "enable" | "disable", r: HistoryLifecycleResult): number {
  const row = r.row;
  if (cli.flags.mode !== "human") {
    return emitMachine(cli, { state: row.state, coverage: row.coverage, writer_requires: row.writer_requires, changed: r.changed, ...(r.baseline ? { baseline: r.baseline } : {}) });
  }
  const { io, style } = cli;
  if (verb === "enable") {
    const since = openCoverageFrom(row);
    io.err(style.dim(`  history ${r.changed ? "enabled" : "already enabled"}${since ? ` since ${since}` : ""}${r.baseline ? ` (baseline ${r.baseline.commit}: ${plural(r.baseline.revisions, "revision")})` : ""}`));
  } else {
    io.err(style.dim(r.changed || row.coverage.length > 0 ? `  history ${r.changed ? "disabled" : "already disabled"} (captured ${row.coverage.map(interval).join(", ")})` : "  history already disabled"));
  }
  return EXIT_OK;
}

/**
 * `history purge [--before <ts>]` (spec/store §7.6, Phase 4b): the receipt
 * `{ purged: { <table>: n }, claims_released, coverage, tables_dropped }` under
 * `--json`; human one stderr line — `  purged <c> commit(s), <r> revision(s),
 * <d> disposition(s), <b> block change(s), <e> edge transition(s), <s>
 * segment(s); swept <x> blob(s), <y> tree node(s); released <n> id claim(s)` —
 * then `  history tables dropped` when the bundle left, or `  nothing to
 * purge` when every count is zero. Coverage is untouched (it records when
 * capture was on; a purged token reads `pruned`).
 */
function renderPurge(cli: Cli, r: HistoryPurgeResult): number {
  if (cli.flags.mode !== "human") return emitMachine(cli, { purged: r.purged, claims_released: r.claims_released, coverage: r.coverage, tables_dropped: r.tables_dropped });
  const { io, style } = cli;
  const p = r.purged;
  const total = Object.values(p).reduce((n, v) => n + v, 0) + r.claims_released;
  if (total === 0 && !r.tables_dropped) {
    io.err(style.dim("  nothing to purge"));
    return EXIT_OK;
  }
  io.err(style.dim(`  purged ${plural(p.commits, "commit")}, ${plural(p.revisions, "revision")}, ${plural(p.dispositions, "disposition")}, ${plural(p.block_changes, "block change")}, ${plural(p.edge_transitions, "edge transition")}, ${plural(p.archives, "segment")}; swept ${plural(p.blobs, "blob")}, ${plural(p.tree_nodes, "tree node")}; released ${plural(r.claims_released, "id claim")}`));
  if (r.tables_dropped) io.err(style.dim("  history tables dropped"));
  return EXIT_OK;
}

function runPurge(cli: Cli, args: string[]): number {
  const { values } = parseArgs({ args, allowPositionals: false, options: { before: { type: "string" } } });
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const before = parseBefore(values.before);
  const result = withWriterLock(ws.omgbaseDir, () => purgeHistory(ws.store.db, repo.repoId, { ...(before !== undefined ? { before } : {}) }));
  return renderPurge(cli, result);
}

function runEnable(cli: Cli, args: string[]): number {
  const { values } = parseArgs({ args, allowPositionals: false, options: { "best-effort": { type: "boolean" } } });
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  // A write (the baseline commit): under the workspace writer lock like every other.
  const result = withWriterLock(ws.omgbaseDir, () => enableHistory(ws.store.db, repo.repoId, { writerRequires: !values["best-effort"] }));
  return renderLifecycle(cli, "enable", result);
}

function runDisable(cli: Cli, args: string[]): number {
  parseArgs({ args, allowPositionals: false, options: {} });
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const result = withWriterLock(ws.omgbaseDir, () => disableHistory(ws.store.db, repo.repoId));
  return renderLifecycle(cli, "disable", result);
}

function runHistory(cli: Cli, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help" || rest.includes("--help") || rest.includes("-h")) return renderCard(cli);
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new CliUsageError(`unknown history subcommand '${sub}' (${SUBCOMMANDS.join("|")})`, `run '${cli.prog} history --help'`);
  }
  switch (sub as Sub) {
    case "enable": return runEnable(cli, rest);
    case "disable": return runDisable(cli, rest);
    case "purge": return runPurge(cli, rest);
    case "plan": return runPlan(cli, rest);
    case "export": return runExport(cli, rest);
    case "attach": return runAttach(cli, rest);
    case "detach": return runDetach(cli, rest);
    case "list": return runList(cli, rest);
  }
}

export const cmdHistory: Command = { name: "history", summary: "Capture: enable/disable/purge per repository; retention: plan/export archive segments, attach/detach/list", run: (cli, a) => runHistory(cli, a) };
