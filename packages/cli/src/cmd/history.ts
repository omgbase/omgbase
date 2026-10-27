import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  evaluateRetention, retentionPolicy, exportHistory, attachArchive, detachArchive, listArchives, humanBytes, withWriterLock,
  enableHistory, disableHistory, purgeHistory, openCoverageFrom, historyProviderOf, readCapability, requireProvider, providerConfigOf, NATIVE_PROVIDER, HistoryProviderConflict,
  RetentionPolicyError, NotASegment, StaleSegment, ARCHIVE_DIR, EngineError, fsVaultSink,
  type RetentionPlan, type ExportResult, type ArchiveListing, type Workspace, type HistoryLifecycleResult, type HistoryPurgeResult, type HistoryCheckpointResult, type HistoryVaultSink, type ManifestRow,
} from "@omgbase/core";
import { parseCadence, GIT_PROVIDER, GitHistoryProvider, PUSH_POLICIES, FETCH_POLICIES, rewrittenMessage, type FetchResult, type ReconcileMode, type ReconcileResult, type RemoteStatus, type ResolveResult } from "@omgbase/git-adapter";
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

const SUBCOMMANDS = ["enable", "disable", "purge", "checkpoint", "push", "fetch", "remote", "plan", "export", "attach", "detach", "list"] as const;
const REMOTE_SUBCOMMANDS = ["set", "unset", "status", "resolve", "reconcile"] as const;
const RECONCILE_MODES: readonly ReconcileMode[] = ["rebase", "merge", "adopt", "fork"];
const PROVIDERS = [NATIVE_PROVIDER, GIT_PROVIDER] as const;
type Sub = (typeof SUBCOMMANDS)[number];

function renderCard(cli: Cli): number {
  return renderHelp(cli, {
    name: "history",
    summary: "History capture (enable/disable/purge per repository; native or git provider) and retention: plan what the policy would archive, export it to a segment, attach/detach/list segments",
    usage: [
      "history enable [--best-effort] [--provider native|git] [--branch <b>] [--cadence every|<ms>]",
      "history disable",
      "history purge [--before <ts>]",
      "history checkpoint",
      "history remote set --url <url> [--name <remote>] [--branch <b>] [--push off|on-checkpoint|periodic] [--fetch off|periodic|webhook]",
      "history remote unset | status",
      "history push",
      "history fetch",
      "history remote resolve <path> --ours|--theirs",
      "history remote reconcile --rebase|--merge|--adopt|--fork",
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
      ["--provider <p>", "(enable) who keeps the history: native (the store's own tables, captured in every commit — the default) or git (a bare repository at .omgbase/git, committed from the rows by the checkpoint worker); one provider per repository — switch with disable, then enable --provider"],
      ["--branch <b>", "(enable --provider git) the branch the commits go on (default omgbase)"],
      ["--cadence <c>", "(enable --provider git) every: one commit per feed row (default); <ms>: the rows pending when the worker runs fold into one commit"],
      ["checkpoint", "(git provider) run the checkpoint worker once: the feed rows since the branch tip become commits; prints { committed, from_seq, to_seq, tip, rescanned }"],
      ["remote set", "(git provider) bind a remote: its URL (never with credentials — git resolves access through the host), the remote branch (default: the local one), when to push (off — the default; on-checkpoint — after every checkpoint that committed; periodic — on every freshness sweep) and when to fetch (off; periodic — on every sweep; webhook — reserved: an external caller runs history fetch)"],
      ["remote unset", "(git provider) forget the remote, its tracking refs and its alerts"],
      ["remote status", "(git provider) local refs only, no network: { remote, branch, local_tip, remote_tip, pushed_through, state: in-sync|ahead|behind|diverged|unknown }"],
      ["push", "(git provider) push the branch and the ids ref — never --force; a rejected push raises git_remote_diverged and exits 1 (run fetch to merge, then push again)"],
      ["fetch", "(git provider) fetch the remote branch: fast-forward (the remote's changes enter the vault as external edits), a tree-level three-way merge when both sides moved (one merge commit), conflicts kept as <stem>.remote-<sha>.md beside yours with git_merge_conflict raised, or git_remote_diverged when the remote was rewritten (push and fetch pause)"],
      ["remote resolve", "(git provider) settle one conflict: --ours keeps your bytes, --theirs takes the remote's; the sidecar leaves; the merge commit is written when none remains"],
      ["remote reconcile", "(git provider; only while git_remote_diverged or git_remote_forked is active) --rebase replays your unpushed checkpoints onto the new remote head (trailers preserved, the ids ref rebased alongside); --merge one merge commit keeping both histories; --adopt the remote's head becomes truth (its tree into the vault, your edits kept beside as <stem>.local-<sha>.md, your old tip on refs/omgbase/backup/<ts>); --fork pushes your branch as <branch>-omgbase-<ts> for a human to merge with git"],
      ["purge", "delete the repository's captured history — every commit, or with --before those before an instant (a live head's revision stays while capture is on); the recorder's id holds are released; the history tables are dropped when no repository is enabled and nothing is left; on a git-provider repository the bare repository and the worker's cursor are removed"],
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
  const provider = historyProviderOf(row);
  if (cli.flags.mode !== "human") {
    // The git provider's enable (spec/cli §6, 5.5) adds `provider` and the branch `tip` of its baseline commit.
    return emitMachine(cli, { state: row.state, coverage: row.coverage, writer_requires: row.writer_requires, changed: r.changed, ...(provider !== NATIVE_PROVIDER ? { provider } : {}), ...(r.baseline ? { baseline: r.baseline } : {}), ...(r.tip !== undefined ? { tip: r.tip } : {}) });
  }
  const { io, style } = cli;
  if (verb === "enable") {
    const since = openCoverageFrom(row);
    const via = provider === NATIVE_PROVIDER ? "" : ` via ${provider}`;
    const baseline = r.baseline ? (provider === NATIVE_PROVIDER ? ` (baseline ${r.baseline.commit}: ${plural(r.baseline.revisions, "revision")})` : ` (baseline ${r.baseline.commit}: ${plural(r.baseline.revisions, "document")}${r.tip ? `, tip ${r.tip}` : ""})`) : "";
    io.err(style.dim(`  history ${r.changed ? "enabled" : "already enabled"}${since ? ` since ${since}` : ""}${via}${baseline}`));
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
  if (cli.flags.mode !== "human") return emitMachine(cli, { purged: r.purged, claims_released: r.claims_released, coverage: r.coverage, tables_dropped: r.tables_dropped, ...(r.provider ? { provider: r.provider } : {}) });
  const { io, style } = cli;
  // The git provider (spec/cli §6, 5.5): the bare repository and the worker's cursor leave; `  purged the git history (<path> removed)` / `  nothing to purge (<path> is already gone)`.
  if (r.provider) {
    io.err(style.dim(r.provider.removed ? `  purged the ${r.provider.name} history (${r.provider.path} removed, cursor cleared)` : `  nothing to purge (${r.provider.path} is already gone)`));
    return EXIT_OK;
  }
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
  // A git history is one line of commits: `--before` has no meaning there (spec/cli §6, 5.5).
  if (before !== undefined && historyProviderOf(readCapability(ws.store.db, repo.repoId, "history")) !== NATIVE_PROVIDER) throw new CliUsageError("--before has no meaning for the git provider: history purge removes the whole bare repository");
  const result = withWriterLock(ws.omgbaseDir, () => purgeHistory(ws.store.db, repo.repoId, { ...(before !== undefined ? { before } : {}) }));
  return renderPurge(cli, result);
}

/**
 * `history checkpoint` (spec/cli §6, 5.5; spec/store §5.12): the git provider's
 * worker, once, under the writer lock; `--json` the receipt `{ committed,
 * from_seq, to_seq, tip, rescanned }`, human `  checkpointed <n> commit(s)
 * (seq <from>..<to>), tip <sha>` / `  nothing to checkpoint (tip <sha>)` /
 * `  rescanned: 1 commit at seq <head>, tip <sha>`. On a native repository it
 * is a usage error: the recorder captures in every commit.
 */
function runCheckpoint(cli: Cli, args: string[]): number {
  parseArgs({ args, allowPositionals: false, options: {} });
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const row = readCapability(ws.store.db, repo.repoId, "history");
  const provider = historyProviderOf(row);
  if (provider === NATIVE_PROVIDER) throw new CliUsageError("history checkpoint is the git provider's: this repository's history is native (captured in every commit)", `run '${cli.prog} history enable --provider git' after '${cli.prog} history disable' to switch`);
  if (!row || row.state !== "enabled") throw new CliUsageError(`history is disabled for this repository — enable it with '${cli.prog} history enable --provider ${provider}'`);
  const result: HistoryCheckpointResult = withWriterLock(ws.omgbaseDir, () => requireProvider(ws.store.db, repo.repoId, provider).checkpoint(repo.repoId, providerConfigOf(row)));
  if (cli.flags.mode !== "human") return emitMachine(cli, result);
  const { io, style } = cli;
  if (result.rescanned) io.err(style.dim(`  rescanned: 1 commit at seq ${result.to_seq}, tip ${result.tip}`));
  else if (result.committed === 0) io.err(style.dim(`  nothing to checkpoint (tip ${result.tip ?? "none"})`));
  else io.err(style.dim(`  checkpointed ${plural(result.committed, "commit")} (seq ${result.from_seq}..${result.to_seq}), tip ${result.tip}`));
  // `push: "on-checkpoint"` (cli 5.6): the push that followed, or why it did not.
  if (result.push) io.err(style.dim("error" in result.push ? `  push failed: ${result.push.error}` : result.push.pushed ? `  pushed ${result.push.tip}${result.push.pushed_through === null ? "" : ` (through seq ${result.push.pushed_through})`}` : `  nothing to push`));
  return EXIT_OK;
}

// ---- the remote half (spec/cli §6 `history`, 5.6; spec/store §5.12 "The remote binding" …, 17.6 — Phase 6b) ----

interface GitRepoContext {
  ws: Workspace;
  repoId: string;
  rootPath: string | null;
  row: ManifestRow;
  provider: GitHistoryProvider;
}

/** The selected repository as a git-provider repository, or the usage errors every remote verb shares. */
function gitContext(cli: Cli, verb: string): GitRepoContext {
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const row = readCapability(ws.store.db, repo.repoId, "history");
  const provider = historyProviderOf(row);
  if (provider === NATIVE_PROVIDER) throw new CliUsageError(`history ${verb} is the git provider's: this repository's history is native (captured in every commit)`, `run '${cli.prog} history enable --provider git' after '${cli.prog} history disable' to switch`);
  if (!row || row.state !== "enabled") throw new CliUsageError(`history is disabled for this repository — enable it with '${cli.prog} history enable --provider ${provider}'`);
  const p = requireProvider(ws.store.db, repo.repoId, provider);
  if (!(p instanceof GitHistoryProvider)) throw new CliUsageError(`history ${verb} is the git provider's (this repository's provider is ${provider})`);
  return { ws, repoId: repo.repoId, rootPath: repo.rootPath, row, provider: p };
}

/** The vault the remote half writes inbound content into: the repository's filesystem root through the observe path. A sourceless repository has none. */
function vaultOf(cli: Cli, ctx: GitRepoContext, verb: string): HistoryVaultSink {
  if (ctx.rootPath === null) throw new CliUsageError(`history ${verb} needs a repository with a filesystem source: inbound content is written into its root as external edits`, `attach one with '${cli.prog} source add <dir> --repo <slug>'`);
  return fsVaultSink(ctx.ws.store, ctx.repoId, ctx.rootPath);
}

/** A thrown `EngineError` of the remote half (`git_remote_diverged`, `git_merge_conflict`) renders as the engine error it is (exit 1); anything else propagates. */
function remoteError(e: unknown): never {
  if (e instanceof EngineError) throw new EngineErrorLike(e.code, e.message, { data: e.data, retriable: e.retriable });
  throw e;
}

function runRemote(cli: Cli, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === undefined || !(REMOTE_SUBCOMMANDS as readonly string[]).includes(sub)) throw new CliUsageError(`history remote takes one of ${REMOTE_SUBCOMMANDS.join("|")}${sub === undefined ? "" : ` (got ${JSON.stringify(sub)})`}`, `run '${cli.prog} history --help'`);
  switch (sub as (typeof REMOTE_SUBCOMMANDS)[number]) {
    case "set": return runRemoteSet(cli, rest);
    case "unset": return runRemoteUnset(cli, rest);
    case "status": return runRemoteStatus(cli, rest);
    case "resolve": return runRemoteResolve(cli, rest);
    case "reconcile": return runRemoteReconcile(cli, rest);
  }
}

function runRemoteSet(cli: Cli, args: string[]): number {
  const { values } = parseArgs({ args, allowPositionals: false, options: { url: { type: "string" }, name: { type: "string" }, branch: { type: "string" }, push: { type: "string" }, fetch: { type: "string" } } });
  if (values.url === undefined) throw new CliUsageError("history remote set requires --url <url>");
  if (values.push !== undefined && !(PUSH_POLICIES as readonly string[]).includes(values.push)) throw new CliUsageError(`--push must be one of ${PUSH_POLICIES.join("|")} (got ${JSON.stringify(values.push)})`);
  if (values.fetch !== undefined && !(FETCH_POLICIES as readonly string[]).includes(values.fetch)) throw new CliUsageError(`--fetch must be one of ${FETCH_POLICIES.join("|")} (got ${JSON.stringify(values.fetch)})`);
  const ctx = gitContext(cli, "remote set");
  let config;
  try {
    config = withWriterLock(ctx.ws.omgbaseDir, () => ctx.provider.remoteSet(ctx.repoId, providerConfigOf(ctx.row), { url: values.url!, ...(values.name !== undefined ? { name: values.name } : {}), ...(values.branch !== undefined ? { branch: values.branch } : {}), ...(values.push !== undefined ? { push: values.push } : {}), ...(values.fetch !== undefined ? { fetch: values.fetch } : {}) }));
  } catch (e) {
    // The binding's own refusals (credentials in the URL, a bad name, branch or policy) are usage errors.
    if (e instanceof Error && !(e instanceof EngineError) && /credentials|not a remote name|not a branch name|--push|--fetch|--url/.test(e.message)) throw new CliUsageError(e.message);
    throw e;
  }
  const r = config.remote!;
  if (cli.flags.mode !== "human") return emitMachine(cli, { remote: r });
  cli.io.err(cli.style.dim(`  remote ${r.name} → ${r.url} (branch ${r.branch}, push ${r.push}, fetch ${r.fetch})`));
  return EXIT_OK;
}

function runRemoteUnset(cli: Cli, args: string[]): number {
  parseArgs({ args, allowPositionals: false, options: {} });
  const ctx = gitContext(cli, "remote unset");
  const had = (ctx.row.config.remote as { name?: string } | null | undefined)?.name ?? null;
  withWriterLock(ctx.ws.omgbaseDir, () => ctx.provider.remoteUnset(ctx.repoId, providerConfigOf(ctx.row)));
  if (cli.flags.mode !== "human") return emitMachine(cli, { remote: null });
  cli.io.err(cli.style.dim(had === null ? "  no remote was bound" : `  remote ${had} unbound`));
  return EXIT_OK;
}

function renderRemoteStatus(cli: Cli, s: RemoteStatus): number {
  if (cli.flags.mode !== "human") return emitMachine(cli, s);
  const { io, style } = cli;
  const rows: string[][] = [
    [style.dim("remote"), `${s.remote}/${s.branch}`],
    [style.dim("state"), s.state],
    [style.dim("local tip"), s.local_tip ?? "—"],
    [style.dim("remote tip"), s.remote_tip ?? "—"],
    [style.dim("pushed through"), s.pushed_through === null ? "—" : `seq ${s.pushed_through}`],
  ];
  for (const line of columns(rows, [{}, {}])) io.out(`  ${line}`);
  return EXIT_OK;
}

function runRemoteStatus(cli: Cli, args: string[]): number {
  parseArgs({ args, allowPositionals: false, options: {} });
  const ctx = gitContext(cli, "remote status");
  if (!ctx.row.config.remote) throw new CliUsageError("no remote is bound to this repository's git history", `bind one with '${cli.prog} history remote set --url <url>'`);
  return renderRemoteStatus(cli, ctx.provider.remoteStatus(ctx.repoId, providerConfigOf(ctx.row)));
}

function runPush(cli: Cli, args: string[]): number {
  parseArgs({ args, allowPositionals: false, options: {} });
  const ctx = gitContext(cli, "push");
  if (!ctx.row.config.remote) throw new CliUsageError("no remote is bound to this repository's git history", `bind one with '${cli.prog} history remote set --url <url>'`);
  let r;
  try {
    r = withWriterLock(ctx.ws.omgbaseDir, () => ctx.provider.push(ctx.repoId, providerConfigOf(ctx.row)));
  } catch (e) {
    remoteError(e);
  }
  if (cli.flags.mode !== "human") return emitMachine(cli, r);
  const remote = ctx.row.config.remote as { name: string; branch: string };
  const ids = r.ids === "rejected" ? " (the ids ref was rejected: the remote's identity record is another engine's)" : "";
  cli.io.err(cli.style.dim(r.pushed ? `  pushed ${r.tip} to ${remote.name}/${remote.branch}${r.pushed_through === null ? "" : ` (through seq ${r.pushed_through})`}${ids}` : `  nothing to push (${remote.name}/${remote.branch} at ${r.tip ?? "none"})${ids}`));
  return EXIT_OK;
}

function renderFetch(cli: Cli, remote: { name: string; branch: string }, f: FetchResult): number {
  if (f.state === "diverged") {
    // Detect, stop, alert (spec/store §5.12 "Divergence"): the verb itself fails so the operator sees it; the alert line follows.
    throw new EngineErrorLike("git_remote_diverged", rewrittenMessage(remote.name, remote.branch, f.remote_tip, f.old_remote_tip ?? null), { data: { remote: remote.name, branch: remote.branch, local_tip: f.tip, remote_tip: f.remote_tip, old_remote_tip: f.old_remote_tip ?? null }, retriable: true });
  }
  if (cli.flags.mode !== "human") return emitMachine(cli, f);
  const { io, style } = cli;
  switch (f.state) {
    case "nothing": io.err(style.dim(`  nothing to fetch from ${remote.name}/${remote.branch}${f.remote_tip ? ` (at ${f.remote_tip})` : ""}`)); break;
    case "fast-forward": io.err(style.dim(`  fast-forwarded to ${f.tip}: ${plural(f.applied.length, "file")} written into the vault`)); break;
    case "merged": io.err(style.dim(`  merged ${remote.name}/${remote.branch} at ${f.remote_tip}: ${plural(f.applied.length, "file")} written into the vault, merge commit ${f.tip}`)); break;
    case "conflict": io.err(style.dim(`  ${plural(f.conflicts.length, "conflict")}: ${f.conflicts.join(", ")} — the remote's versions are beside yours; settle each with ${cli.prog} history remote resolve <path> --ours|--theirs`)); break;
  }
  return EXIT_OK;
}

function runFetch(cli: Cli, args: string[]): number {
  parseArgs({ args, allowPositionals: false, options: {} });
  const ctx = gitContext(cli, "fetch");
  if (!ctx.row.config.remote) throw new CliUsageError("no remote is bound to this repository's git history", `bind one with '${cli.prog} history remote set --url <url>'`);
  const vault = vaultOf(cli, ctx, "fetch");
  let f: FetchResult;
  try {
    f = withWriterLock(ctx.ws.omgbaseDir, () => ctx.provider.fetch(ctx.repoId, providerConfigOf(ctx.row), vault));
  } catch (e) {
    remoteError(e);
  }
  return renderFetch(cli, ctx.row.config.remote as { name: string; branch: string }, f);
}

function runRemoteResolve(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { ours: { type: "boolean" }, theirs: { type: "boolean" } } });
  const path = positionals[0];
  if (!path) throw new CliUsageError("history remote resolve requires a <path>");
  if (Boolean(values.ours) === Boolean(values.theirs)) throw new CliUsageError("history remote resolve takes exactly one of --ours or --theirs");
  const ctx = gitContext(cli, "remote resolve");
  const vault = vaultOf(cli, ctx, "remote resolve");
  const storage = path.replace(/^\/+/, "");
  let r: ResolveResult;
  try {
    r = withWriterLock(ctx.ws.omgbaseDir, () => ctx.provider.resolve(ctx.repoId, providerConfigOf(ctx.row), vault, storage, values.ours ? "ours" : "theirs"));
  } catch (e) {
    if (e instanceof Error && !(e instanceof EngineError) && /no merge conflict is pending|is not a pending conflict/.test(e.message)) throw new CliUsageError(e.message);
    remoteError(e);
  }
  if (cli.flags.mode !== "human") return emitMachine(cli, r);
  cli.io.err(cli.style.dim(`  resolved ${r.path} (--${r.choice}); ${plural(r.remaining.length, "conflict")} remaining${r.merged ? `; merge commit ${r.merged}` : ""}`));
  return EXIT_OK;
}

function renderReconcile(cli: Cli, r: ReconcileResult): number {
  if (cli.flags.mode !== "human") return emitMachine(cli, r);
  const { io, style } = cli;
  const conflicts = r.conflicts.length > 0 ? `; ${plural(r.conflicts.length, "conflict")}: ${r.conflicts.join(", ")} (settle each with ${cli.prog} history remote resolve <path> --ours|--theirs)` : "";
  const applied = `${plural(r.applied.length, "file")} written into the vault`;
  switch (r.mode) {
    case "rebase": io.err(style.dim(`  rebased ${plural(r.rewritten, "commit")} onto the remote's head, tip ${r.tip}; the previous tip is kept on refs/omgbase/backup; ${applied}${conflicts}`)); break;
    case "merge": io.err(style.dim(r.rewritten === 1 ? `  merged the remote's head: merge commit ${r.tip}; the previous tip is kept on refs/omgbase/backup; ${applied}` : `  merge pending: ${applied}${conflicts}`)); break;
    case "adopt": io.err(style.dim(`  adopted the remote's head ${r.tip}; the previous tip is kept on refs/omgbase/backup; ${applied}${conflicts}`)); break;
    case "fork": io.err(style.dim(`  pushed the engine's branch as ${r.fork}; merge it with git, then run ${cli.prog} history remote reconcile --adopt`)); break;
  }
  return EXIT_OK;
}

function runRemoteReconcile(cli: Cli, args: string[]): number {
  const { values } = parseArgs({ args, allowPositionals: false, options: { rebase: { type: "boolean" }, merge: { type: "boolean" }, adopt: { type: "boolean" }, fork: { type: "boolean" } } });
  const modes = RECONCILE_MODES.filter((m) => (values as Record<string, boolean | undefined>)[m]);
  if (modes.length !== 1) throw new CliUsageError(`history remote reconcile takes exactly one of ${RECONCILE_MODES.map((m) => `--${m}`).join(" | ")}`);
  const ctx = gitContext(cli, "remote reconcile");
  const vault = vaultOf(cli, ctx, "remote reconcile");
  let r: ReconcileResult;
  try {
    r = withWriterLock(ctx.ws.omgbaseDir, () => ctx.provider.reconcile(ctx.repoId, providerConfigOf(ctx.row), vault, modes[0]!));
  } catch (e) {
    if (e instanceof Error && !(e instanceof EngineError) && /is not diverged|no remote is bound/.test(e.message)) throw new CliUsageError(e.message);
    remoteError(e);
  }
  return renderReconcile(cli, r);
}

function runEnable(cli: Cli, args: string[]): number {
  const { values } = parseArgs({ args, allowPositionals: false, options: { "best-effort": { type: "boolean" }, provider: { type: "string" }, branch: { type: "string" }, cadence: { type: "string" } } });
  const provider = values.provider ?? NATIVE_PROVIDER;
  if (!(PROVIDERS as readonly string[]).includes(provider)) throw new CliUsageError(`--provider must be one of ${PROVIDERS.join("|")} (got ${JSON.stringify(provider)})`);
  if (provider === NATIVE_PROVIDER && (values.branch !== undefined || values.cadence !== undefined)) throw new CliUsageError("--branch and --cadence go with --provider git");
  const providerOptions: Record<string, unknown> = {};
  if (values.branch !== undefined) providerOptions.branch = values.branch;
  if (values.cadence !== undefined) {
    try {
      providerOptions.cadence = parseCadence(values.cadence);
    } catch (e) {
      throw new CliUsageError((e as Error).message);
    }
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  // A write (the baseline commit): under the workspace writer lock like every other.
  try {
    const result = withWriterLock(ws.omgbaseDir, () => enableHistory(ws.store.db, repo.repoId, { writerRequires: !values["best-effort"], ...(provider !== NATIVE_PROVIDER ? { provider, providerOptions } : {}) }));
    return renderLifecycle(cli, "enable", result);
  } catch (e) {
    // spec/store §5.12: one provider per repository — the switch is `disable` then `enable --provider`.
    if (e instanceof HistoryProviderConflict) throw new CliUsageError(e.message);
    throw e;
  }
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
    case "checkpoint": return runCheckpoint(cli, rest);
    case "push": return runPush(cli, rest);
    case "fetch": return runFetch(cli, rest);
    case "remote": return runRemote(cli, rest);
    case "plan": return runPlan(cli, rest);
    case "export": return runExport(cli, rest);
    case "attach": return runAttach(cli, rest);
    case "detach": return runDetach(cli, rest);
    case "list": return runList(cli, rest);
  }
}

export const cmdHistory: Command = { name: "history", summary: "Capture: enable/disable/purge per repository (native or git provider), checkpoint, remote set/status, push/fetch, resolve/reconcile; retention: plan/export archive segments, attach/detach/list", run: (cli, a) => runHistory(cli, a) };
