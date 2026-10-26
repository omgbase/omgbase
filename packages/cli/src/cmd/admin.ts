import { parseArgs } from "node:util";
import {
  rebuildIndex,
  runGc,
  buildEmbedTasks,
  buildDocEmbedTasks,
  indexIdentity,
  requireSemantic,
  resolveSettings,
  workspaceSettings,
  repoOwnSettings,
  writeWorkspaceSettings,
  writeRepoSettings,
  ftsIndexedRowCount,
  liveLeafCount,
  sizeReport,
  activeAlerts,
  vacuum,
  reclaimableBytes,
  humanBytes,
  formatShare,
  type SizeReport,
  type Settings,
  type RebuildTarget,
} from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK, EXIT_ERROR, emitMachine, renderHelp } from "../output.js";
import { columns } from "../render.js";
import { loadEmbedding, drainEmbeddings } from "./_embed.js";

// admin/maintenance (11 §5.8–5.9). The live watcher moved to `omg sync --watch`.

// ---- rebuild-index ----------------------------------------------------------

function runRebuild(cli: Cli, args: string[]): number {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: { sections: { type: "boolean" }, edges: { type: "boolean" }, fts: { type: "boolean" }, "block-changes": { type: "boolean" }, all: { type: "boolean" }, help: { type: "boolean" } },
  });
  if (values.help) {
    return renderHelp(cli, {
      name: "rebuild-index",
      summary: "Rebuild derived tables from the authoritative docs/blocks (safe any time; never touches content or history)",
      usage: "rebuild-index [--sections|--edges|--fts|--block-changes|--all]",
      options: [
        ["--sections", "section spans"],
        ["--edges", "the link graph"],
        ["--fts", "the full-text index"],
        ["--block-changes", "the per-block change log"],
        ["--all", "everything (default)"],
      ],
    });
  }
  const target: RebuildTarget = values.sections ? "sections" : values.edges ? "edges" : values.fts ? "fts" : values["block-changes"] ? "block_changes" : "all";
  const ws = cli.workspace();
  rebuildIndex(ws.store, target);
  // The library call returns nothing; the machine result names what was rebuilt.
  if (cli.flags.mode !== "human") return emitMachine(cli, { rebuilt: target });
  cli.io.err(cli.style.dim(`  ${cli.style.ok(cli.render.g.ok)} rebuilt ${target}`));
  return EXIT_OK;
}

// ---- gc ---------------------------------------------------------------------

function runGcCmd(cli: Cli, args: string[]): number {
  const { values } = parseArgs({ args, allowPositionals: true, options: { "dry-run": { type: "boolean" }, vacuum: { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) {
    return renderHelp(cli, {
      name: "gc",
      summary: "Mark-and-sweep unreferenced blobs and tree nodes, the `same` disposition rows a pre-14.2 store wrote, and (store 17.0) the id claims older than identity.claims_retain_days that name no row and the change-feed rows past feed.retain_days / feed.retain_entries (refuses unless gc.enabled is set in repo settings)",
      usage: "gc [--dry-run] [--vacuum]",
      options: [
        ["--dry-run", "report what would be swept, sweep nothing (allowed even when gc is disabled)"],
        ["--vacuum", "after the sweep, VACUUM the database to return its free pages to the filesystem (`doctor --size` shows how many)"],
      ],
    });
  }
  // `--dry-run` is also a global flag (parseGlobals consumes it) — honor either spelling.
  const dryRun = Boolean(values["dry-run"]) || cli.flags.dryRun;
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const settings = resolveSettings(ws.store, repo.repoId);
  const enabled = Boolean((settings.gc as { enabled?: boolean } | undefined)?.enabled);
  if (!enabled && !dryRun) {
    throw new EngineErrorLike("target_missing", "gc is disabled; set gc.enabled=true (or use --dry-run)");
  }
  // A dry run counts every sweep — blobs, tree nodes and the `same` disposition
  // rows a 14.1 store wrote (spec/store §7, 14.2) — and deletes nothing.
  const swept = runGc(ws.store, { enabled: enabled || dryRun, dryRun });
  // `--vacuum` runs after the sweep (the sweep's freed pages are what it returns);
  // a dry run measures the free pages and vacuums nothing (spec/store §7).
  const vac = values.vacuum
    ? dryRun
      ? { reclaimable: reclaimableBytes(ws.store), applied: false }
      : { ...vacuum(ws.store), applied: true }
    : undefined;
  const result = vac ? { ...swept, vacuum: vac } : swept;
  if (cli.flags.mode !== "human") return emitMachine(cli, result);
  // spec/store §7.3 (17.0): the claims prune's count is shown only when it
  // released something — the line is pinned by shape without it, and the
  // setting is off by default.
  const released = swept.claimsReleased > 0 ? `, ${swept.claimsReleased} id claims released` : "";
  // spec/store §7.4 (17.0): likewise the feed rows pruned under the floors, only when non-zero.
  const pruned = swept.feedPruned > 0 ? `, ${swept.feedPruned} feed rows pruned` : "";
  cli.io.err(cli.style.dim(`  swept ${swept.blobsSwept} blobs, ${swept.treeNodesSwept} tree nodes, ${swept.sameDispositionsSwept} same dispositions${released}${pruned}`));
  if (vac) cli.io.err(cli.style.dim(vac.applied ? `  vacuumed, reclaimed ${humanBytes(vac.reclaimable)}` : `  would vacuum ${humanBytes(vac.reclaimable)}`));
  return EXIT_OK;
}

// ---- doctor -----------------------------------------------------------------

function runDoctor(cli: Cli, args: string[]): number {
  const { values } = parseArgs({ args, allowPositionals: true, options: { size: { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) {
    return renderHelp(cli, {
      name: "doctor",
      summary: "Invariant sweep: FTS rows vs live leaf blocks, head present, capture complete, active alerts, SQLite integrity — exit 1 on any failure (CI-able)",
      usage: ["doctor [--json]", "doctor --size [--json]"],
      options: [
        ["--size", "instead of the checks: what the database is made of — bytes and rows per category (content, identity, recovery, history, search, sync — the change feed under sync) and table, the file's pages, the feed's position, what VACUUM would reclaim, advice"],
        ["--json", "`{ ok, checks: [{ name, ok, detail }] }`; with --size `{ file, categories, same_dispositions, id_claims, archived, feed, capabilities, advice }`"],
      ],
    });
  }
  const ws = cli.workspace();
  // The size report is store-wide; its `feed` line is a repository's (spec/store
  // §7.2, 17.0) — the selected one when the selection resolves, else the
  // store's only one (the report decides), never an error.
  if (values.size) {
    const repoId = selectedRepoId(cli, ws);
    return runDoctorSize(cli, sizeReport(ws.store, repoId === undefined ? {} : { repoId }));
  }
  const repo = cli.repo(ws); // the selected repo must resolve (`repo_not_found` otherwise); the checks are store-wide but the alerts are its
  const db = ws.store.db;
  const checks: { name: string; ok: boolean; detail?: string }[] = [];

  // (The `convergence` check — `repos_status.unconverged === 0` — left with the
  // count in store 17.0, D9: `file_hash` IS the head's hash by construction
  // (I1), so it was identically true; `disk.changed` is the signal, `status`
  // shows it.)
  // The index holds exactly the live LEAF blocks (spec/search §1.1): a container
  // has no row, a tombstone none. Counted from the index's shadow table — a plain
  // count(*) on an external-content FTS table answers from `blocks` instead.
  const ftsCount = ftsIndexedRowCount(db);
  const leaves = liveLeafCount(db);
  checks.push({ name: "fts rows == live leaf blocks", ok: ftsCount === leaves, detail: `fts=${ftsCount} leaves=${leaves}` });

  // Store 17.0 (D1): every live document has a head token, and while legacy
  // capture is on the recorder's `revisions` row agrees with it (spec/store §8
  // H1 — the check `doctor` used to call "no dangling current_rev").
  const headless = (db.prepare("SELECT count(*) c FROM docs d WHERE d.deleted_at IS NULL AND d.head IS NULL").get() as { c: number }).c;
  checks.push({ name: "head present", ok: headless === 0, detail: `${headless} without a head` });
  const uncaptured = (db.prepare("SELECT count(*) c FROM docs d WHERE d.deleted_at IS NULL AND d.head IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.rev_id = d.head)").get() as { c: number }).c;
  checks.push({ name: "capture complete", ok: uncaptured === 0, detail: `${uncaptured} heads without a revision` });

  // Store 17.0 (3e-ii): the alert channel (spec/store §3.1 `alerts`) — the
  // conditions the engine raised for a human on the selected repository; any
  // active one fails the check and is named in its detail.
  const alerts = activeAlerts(db, repo.repoId);
  checks.push({ name: "alerts", ok: alerts.length === 0, detail: alerts.length === 0 ? "none active" : alerts.map((a) => `${a.code}[${a.severity}]: ${a.message}`).join("; ") });

  const integrity = db.pragma("integrity_check", { simple: true }) as string;
  checks.push({ name: "sqlite integrity", ok: integrity === "ok", detail: integrity });

  const allOk = checks.every((c) => c.ok);
  if (cli.flags.mode !== "human") {
    emitMachine(cli, { ok: allOk, checks });
    return allOk ? EXIT_OK : EXIT_ERROR;
  }
  const { style, io, render } = cli;
  for (const c of checks) {
    const mark = c.ok ? style.ok(render.g.ok) : style.err(render.g.err);
    io.out(`  ${mark} ${c.name}${c.detail && !c.ok ? style.dim(`  (${c.detail})`) : ""}`);
  }
  return allOk ? EXIT_OK : EXIT_ERROR;
}

/** The selected repository's id when the selection resolves; undefined when it does not (an explicit `--repo <slug>` that fails is still the error). */
function selectedRepoId(cli: Cli, ws: ReturnType<Cli["workspace"]>): string | undefined {
  try {
    return cli.repo(ws).repoId;
  } catch (err) {
    if (cli.flags.repo) throw err;
    if (err instanceof EngineErrorLike && err.code === "repo_not_found") return undefined;
    throw err;
  }
}

// `doctor --size` (spec/cli §6, cli 4.3): the store's size report (spec/store
// §7 "Size") as one aligned table — each category, then its three biggest
// tables indented — the file's page accounting, and the advice lines. Exit 0:
// a size report is information, not a check. The bytes and share cells are
// right-aligned in fixed widths (the widest humanized size, `1023.9 KB`, is 9;
// the widest share, `100.0%`, 6) so the layout is the same whatever the
// numbers — which is what lets the fixtures pin it by shape (§8).
const TOP_TABLES = 3;
const NO_BYTES = "—";
const BYTES_CELL = 9;
const SHARE_CELL = 6;

function runDoctorSize(cli: Cli, report: SizeReport): number {
  if (cli.flags.mode !== "human") return emitMachine(cli, report);
  const { style, io } = cli;
  const bytes = (n: number | null): string => (n === null ? NO_BYTES : humanBytes(n)).padStart(BYTES_CELL);
  const share = (n: number | null): string => (n === null ? NO_BYTES : formatShare(n)).padStart(SHARE_CELL);
  // The last column is never padded by `columns`, so the row counts are
  // right-aligned here (to the widest count, or the header).
  const shown = report.categories.flatMap((c) => [c.rows, ...c.tables.slice(0, TOP_TABLES).map((t) => t.rows)]);
  const rowsWidth = Math.max(4, ...shown.map((n) => String(n).length));
  const count = (n: number): string => String(n).padStart(rowsWidth);
  const rows: string[][] = [[style.dim("category"), style.dim("bytes".padStart(BYTES_CELL)), style.dim("share".padStart(SHARE_CELL)), style.dim("rows".padStart(rowsWidth))]];
  for (const c of report.categories) {
    rows.push([style.accent(c.name), bytes(c.bytes), share(c.share), count(c.rows)]);
    for (const t of c.tables.slice(0, TOP_TABLES)) rows.push([`  ${t.name}`, bytes(t.bytes), share(t.share), count(t.rows)]);
  }
  for (const line of columns(rows, [{}, { align: "right" }, { align: "right" }])) io.out(`  ${line}`);
  if (report.detail) io.out(style.dim(`  ${report.detail}: row counts only`));
  io.out("");
  const f = report.file;
  const file: string[][] = [
    ["file", style.path(f.path)],
    ["size", `${humanBytes(f.bytes)} on disk, wal ${humanBytes(f.wal_bytes)}`],
    ["pages", `${f.page_count} x ${f.page_size} bytes, ${f.freelist_count} free`],
    ["reclaimable", humanBytes(f.reclaimable)],
    // 15.0: the history that already moved to archive segments (spec/store §7 "Retention").
    ["archived", `${report.archived.revisions} revisions in ${report.archived.segments} segments, ${humanBytes(report.archived.bytes)} on disk`],
    // 17.0: the identity claims (spec/store §2.1) — one row per id ever minted and still held; `identity.claims_retain_days` lets `gc` release old ones (§7.3).
    ["id claims", `${report.id_claims} ids claimed`],
    // 17.0 (3e): the change feed's position (spec/store §7.2 `feed`, §7.4) — the report's repository's; none when the store has several and none was selected.
    ["feed", report.feed ? `epoch ${report.feed.epoch}, ${report.feed.entries} entries, seq ${report.feed.oldest}..${report.feed.head}` : "no repository selected"],
    // 17.0 (3e-ii): the capability manifest of the same repository (spec/store §3.1 `capabilities`): `history  enabled since <ts> | disabled`, `semantic  enabled (<model>) | disabled`.
    ["history", capabilityLine(report.capabilities, "history")],
    ["semantic", capabilityLine(report.capabilities, "semantic")],
  ];
  for (const line of columns(file)) io.out(`  ${line}`);
  for (const a of report.advice) io.out(`  ${style.dim("advice:")} ${a}`);
  return EXIT_OK;
}

/** The manifest line of one capability: `enabled since <coverage_from>` for history, `enabled (<model>)` for semantic, `disabled`, or `no repository selected` like `feed`. */
function capabilityLine(capabilities: SizeReport["capabilities"], name: "history" | "semantic"): string {
  if (!capabilities) return "no repository selected";
  const c = capabilities.find((x) => x.capability === name);
  if (!c || c.state === "disabled") return "disabled";
  if (name === "history") return c.coverage_from ? `enabled since ${c.coverage_from}` : "enabled";
  const model = c.config.model;
  return typeof model === "string" ? `enabled (${model})` : "enabled";
}

// ---- config -----------------------------------------------------------------

// Config is one settings schema at two layers (config-scope). Which layer a
// command targets follows normal repo selection: a resolved repo → that repo's
// layer; `--repo ""` forces the workspace (default) layer; and an unresolvable
// selection (ambiguous or none — e.g. standing at the workspace root with >1
// repo) falls back to the workspace layer rather than erroring, since the
// workspace IS what you mean when you're not clearly inside a repo.
type ConfigScope = { kind: "workspace" } | { kind: "repo"; repoId: string; slug: string };

function resolveConfigScope(cli: Cli, ws: ReturnType<Cli["workspace"]>): ConfigScope {
  if (cli.flags.repo === "") return { kind: "workspace" };
  try {
    const repo = cli.repo(ws);
    return { kind: "repo", repoId: repo.repoId, slug: repo.slug };
  } catch (err) {
    // An explicit --repo <slug> that doesn't resolve is a real error. A bare
    // (cwd-based) selection that's ambiguous or empty just means "workspace
    // layer" — the workspace is what you mean when not clearly inside a repo.
    // (`Cli.repo` has already wrapped the RepoSelectionError as repo_not_found.)
    if (cli.flags.repo) throw err;
    if (err instanceof EngineErrorLike && err.code === "repo_not_found") return { kind: "workspace" };
    throw err;
  }
}

function runConfig(cli: Cli, args: string[]): number {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "help" || args.includes("--help")) {
    return renderHelp(cli, {
      name: "config",
      summary: "Read/write settings — one schema at two layers: workspace defaults, overridable per repo",
      usage: ["config [list]", "config get <key>", "config set <key> <value>"],
      options: [
        ["list", "show the effective settings (default); at repo scope, overrides are marked"],
        ["get <key>", "print one effective value (dotted path, e.g. embedding.provider)"],
        ["set <key> <value>", "write a value at the selected layer (true/false/null/numbers are typed)"],
        ["--repo <slug>", "target a repo's layer"],
        ['--repo ""', "target the workspace layer (what every repo inherits)"],
      ],
      notes: [`e.g. ${cli.prog} config set embedding.provider omgbase-embedder --repo ""`],
    });
  }
  const ws = cli.workspace();
  const scope = resolveConfigScope(cli, ws);
  const label = scope.kind === "workspace" ? "workspace" : scope.slug;

  const readLayer = (): Settings =>
    scope.kind === "workspace" ? workspaceSettings(ws.store) : repoOwnSettings(ws.store, scope.repoId);
  const writeLayer = (s: Settings): void =>
    scope.kind === "workspace" ? writeWorkspaceSettings(ws.store, s) : writeRepoSettings(ws.store, scope.repoId, s);

  if (sub === "list" || sub === undefined) {
    // At repo scope show the EFFECTIVE (merged) view with an override marker;
    // at workspace scope the layer is the effective view.
    if (scope.kind === "workspace") {
      const s = workspaceSettings(ws.store);
      if (cli.flags.mode !== "human") return emitMachine(cli, s);
      else {
        cli.io.err(cli.style.dim(`  workspace defaults`));
        for (const [k, v] of Object.entries(s)) cli.io.out(`  ${cli.style.accent(k)} ${cli.style.dim("=")} ${JSON.stringify(v)}`);
      }
      return EXIT_OK;
    }
    const effective = resolveSettings(ws.store, scope.repoId);
    const own = repoOwnSettings(ws.store, scope.repoId);
    if (cli.flags.mode !== "human") return emitMachine(cli, effective);
    cli.io.err(cli.style.dim(`  ${label} (effective; ${cli.render.g.diamond} = overrides workspace default)`));
    for (const [k, v] of Object.entries(effective)) {
      const overridden = Object.prototype.hasOwnProperty.call(own, k);
      const mark = overridden ? cli.style.accent(cli.render.g.diamond) : " ";
      cli.io.out(`  ${mark} ${cli.style.accent(k)} ${cli.style.dim("=")} ${JSON.stringify(v)}`);
    }
    return EXIT_OK;
  }
  if (sub === "get") {
    const key = rest[0];
    if (!key) throw new CliUsageError("config get <key>");
    // get returns the EFFECTIVE value (what actually takes effect for the scope).
    const source = scope.kind === "workspace" ? workspaceSettings(ws.store) : resolveSettings(ws.store, scope.repoId);
    const val = getPath(source, key);
    cli.io.out(val === undefined ? "" : typeof val === "string" ? val : JSON.stringify(val));
    return EXIT_OK;
  }
  if (sub === "set") {
    const key = rest[0];
    const raw = rest[1];
    if (!key || raw === undefined) throw new CliUsageError("config set <key> <value>");
    const settings = readLayer();
    setPath(settings, key, coerce(raw));
    writeLayer(settings);
    cli.io.err(cli.style.dim(`  set ${key} (${label})`));
    return EXIT_OK;
  }
  throw new CliUsageError(`unknown config subcommand '${sub}' (get|set|list)`, `run '${cli.prog} config --help'`);
}

// ---- embed ------------------------------------------------------------------

async function runEmbed(cli: Cli, args: string[]): Promise<number> {
  const sub = args.find((a) => !a.startsWith("-"));
  if (args.includes("--help") || args.includes("-h") || sub === "help") {
    return renderHelp(cli, {
      name: "embed",
      summary: "The embedding queue: report the provider + what is queued, or drain it to embed now",
      usage: ["embed [status]", "embed drain [--verbose] [--prune]"],
      options: [
        ["status", "(default) provider, model, and how many blocks/docs are embeddable but not yet embedded"],
        ["drain", "embed the queued blocks now — status alone makes no progress"],
        ["-v, --verbose", "(drain) per-batch progress"],
        ["--prune", "(drain) afterwards delete vectors left by other models (e.g. after switching models)"],
      ],
      notes: [`needs embedding.provider (\`${cli.prog} config set embedding.provider omgbase-embedder --repo ""\`); without one, semantic search is simply off.`],
    });
  }
  const verbose = args.includes("--verbose") || args.includes("-v");
  const prune = args.includes("--prune");
  const ws = cli.workspace();
  const repo = cli.repo(ws);

  const loaded = await loadEmbedding(ws, repo.repoId);
  if (!loaded) {
    // No provider configured (05 §6). Honest report; not an error.
    const hint = 'set one with `omg config set embedding.provider <command|url>` (e.g. omgbase-embedder)';
    if (cli.flags.mode !== "human") return emitMachine(cli, { provider: null, queued: 0 });
    cli.io.err(cli.style.dim(`  no embedding provider configured — ${hint}`));
    return EXIT_OK;
  }

  if (sub === "drain") {
    await loaded.close(); // drainEmbeddings connects its own provider
    const result = await drainEmbeddings(cli, ws, repo.repoId, { verbose, prune });
    if (cli.flags.mode !== "human") return emitMachine(cli, { provider: loaded.providerName, ...(result ?? { embedded: 0, cached: 0 }) });
    if (result) cli.io.err(`  ${cli.style.ok(cli.render.g.ok)} embedded ${result.embedded}, cached ${result.cached}`);
    return EXIT_OK;
  }

  try {
    const tasks = buildEmbedTasks(ws.store, repo.repoId);
    // Queue depth = embeddable blocks whose current-context vector isn't cached.
    const pending = loaded.worker.staleBlocks(tasks);
    // Doc-grain queue depth = live docs whose current-content vector isn't cached.
    const docTasks = buildDocEmbedTasks(ws.store, repo.repoId);
    const docPending = loaded.worker.staleDocs(docTasks);
    // Vectors left by a previous model (dead weight after a model switch).
    const foreign = loaded.worker.foreignVectorCount();
    // The indexer's watermark against the feed head (modular-core Phase 2):
    // how far the index is behind, and whether it was built under this provider.
    const fresh = requireSemantic(ws.store.db).freshness(repo.repoId, indexIdentity(loaded.provider));

    // status
    const payload = {
      provider: loaded.providerName, model: loaded.provider.model, dim: loaded.provider.dim, embeddable: tasks.length, queued: pending.length, docs: docTasks.length, docsQueued: docPending.length, foreignBlocks: foreign.blocks, foreignDocs: foreign.docs,
      watermark: { processed_seq: fresh.processed_seq, head: fresh.head, fresh: fresh.fresh, identity: fresh.identity },
    };
    if (cli.flags.mode !== "human") return emitMachine(cli, payload);
    else {
      cli.io.out(`  provider  ${cli.style.accent(loaded.providerName)} ${cli.style.dim(`(${loaded.provider.model}, ${loaded.provider.dim}d)`)}`);
      cli.io.out(`  embeddable ${tasks.length}   ${cli.style.dim("queued")} ${payload.queued}`);
      cli.io.out(`  docs ${docTasks.length}   ${cli.style.dim("queued")} ${payload.docsQueued}`);
      const wm = fresh.processed_seq === null ? "none (the first drain bootstraps)" : `${fresh.processed_seq}${fresh.head !== null ? ` of ${fresh.head}` : ""}${fresh.fresh === true ? " (current)" : fresh.fresh === false ? " (behind)" : ""}`;
      cli.io.out(`  watermark ${wm}`);
      if (fresh.identity && (fresh.identity.model !== loaded.provider.model || fresh.identity.dims !== loaded.provider.dim)) cli.io.out(cli.style.dim(`  the index was built under ${fresh.identity.model} (${fresh.identity.dims}d) — the next drain rebuilds it`));
      // `status` reports but never embeds — point the reader at the verb that does.
      if (payload.queued > 0 || payload.docsQueued > 0) cli.io.out(cli.style.dim(`  run \`omg embed drain\` to embed the ${payload.queued} queued block(s) + ${payload.docsQueued} doc(s)`));
      // Stale vectors from another model don't affect search (queries filter by
      // model) but waste space — nudge toward reclaiming them.
      if (foreign.blocks > 0 || foreign.docs > 0) cli.io.out(cli.style.dim(`  ${foreign.blocks} block + ${foreign.docs} doc vector(s) from other models — \`omg embed drain --prune\` to reclaim`));
    }
    return EXIT_OK;
  } finally {
    await loaded.close();
  }
}

// helpers ---------------------------------------------------------------------

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}
function coerce(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

export const cmdRebuild: Command = { name: "rebuild-index", summary: "Rebuild derived tables", run: (c, a) => runRebuild(c, a) };
export const cmdGc: Command = { name: "gc", summary: "Mark-and-sweep (flag-gated)", run: (c, a) => runGcCmd(c, a) };
export const cmdDoctor: Command = { name: "doctor", summary: "Invariant sweep (CI-able)", run: (c, a) => runDoctor(c, a) };
export const cmdConfig: Command = { name: "config", summary: "Read/write repo settings", run: (c, a) => runConfig(c, a) };
export const cmdEmbed: Command = { name: "embed", summary: "Embedding queue: status, or drain to embed", run: (c, a) => runEmbed(c, a) };
