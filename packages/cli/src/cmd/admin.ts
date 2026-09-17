import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import {
  Watcher,
  WatchLease,
  EmbedDrainer,
  freshnessSweep,
  rebuildIndex,
  runGc,
  planImport,
  importDocs,
  reposStatus,
  buildEmbedTasks,
  buildDocEmbedTasks,
  resolveSettings,
  workspaceSettings,
  repoOwnSettings,
  writeWorkspaceSettings,
  writeRepoSettings,
  RepoSelectionError,
  type Settings,
  type RebuildTarget,
  type MrplexDoc,
} from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK, EXIT_ERROR } from "../output.js";
import { loadEmbedding, drainEmbeddings } from "./_embed.js";
import { openRepoSource } from "./_source.js";

// watch + admin/maintenance (11 §5.8–5.9).

// ---- watch ------------------------------------------------------------------

async function runWatch(cli: Cli, args: string[]): Promise<number> {
  parseArgs({ args, allowPositionals: true, options: { help: { type: "boolean" } } });
  const ws = cli.workspace();
  const repo = cli.repo(ws);

  const lease = WatchLease.tryAcquire(ws.omgbaseDir);
  if (!lease) throw new EngineErrorLike("target_missing", "another watcher already holds the lease for this workspace");

  // Keep embeddings timely: when a checkpoint ingests changed files, schedule a
  // background embed drain so their vectors don't go stale until a manual `omg
  // embed drain`. Off when no provider is configured.
  const embedding = await loadEmbedding(ws, repo.repoId);
  const drainer = embedding
    ? new EmbedDrainer(ws.store, repo.repoId, embedding.worker, {
        onDrain: ({ embedded }) => cli.io.err(cli.style.dim(`  embedded ${embedded} block(s)`)),
        onError: (err) => cli.io.err(cli.style.dim(`  embed drain failed: ${String(err)}`)),
      })
    : null;

  if (repo.rootPath) freshnessSweep(ws.store, repo.repoId, repo.rootPath); // start fresh

  // Live watching runs in the external fs-adapter process (chokidar lives there,
  // not in the engine). A sourceless repo has nothing to watch.
  const source = await openRepoSource(ws.store, repo);
  if (!source) {
    cli.io.err(cli.style.dim(`  ${repo.slug} has no filesystem source — nothing to watch`));
    lease.release();
    return EXIT_OK;
  }

  const watcher = new Watcher(ws.store, repo.repoId, source, {
    onCheckpoint: (r) => {
      if (r.ingested.length || r.deleted.length || r.conflicted.length) {
        cli.io.err(`${cli.style.ok(cli.render.g.sync)} +${r.ingested.length} -${r.deleted.length}${r.conflicted.length ? ` !${r.conflicted.length}` : ""}`);
        drainer?.schedule();
      }
    },
    onError: (err) => cli.io.err(cli.style.err(`  watch error: ${String(err)}`)),
  });
  await watcher.start();
  // Prime: embed anything already stale at startup (post-sweep), in the background.
  drainer?.schedule();
  cli.io.err(cli.style.dim(`  watching ${repo.slug} — Ctrl-C to stop${drainer ? " · auto-embed on" : ""}`));

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      // Graceful shutdown closes the child fs-adapter process, the drainer, and
      // the embedder. Any of those could stall (a wedged child, a slow flush) —
      // and `watch` must never become unkillable by a signal, or Ctrl-C hangs
      // the terminal and a supervising process (a test's SIGTERM) leaks it. A
      // watchdog force-exits if graceful cleanup doesn't finish promptly.
      const watchdog = setTimeout(() => process.exit(EXIT_OK), 3000);
      void (async () => {
        try {
          await watcher.stop();
          await source.close();
          if (drainer) { try { await drainer.flush(); } catch { /* reported via onError */ } await drainer.close(); }
          if (embedding) await embedding.close();
          lease.release();
        } finally {
          clearTimeout(watchdog);
          resolve();
        }
      })();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return EXIT_OK;
}

// ---- rebuild-index ----------------------------------------------------------

function runRebuild(cli: Cli, args: string[]): number {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: { sections: { type: "boolean" }, edges: { type: "boolean" }, fts: { type: "boolean" }, "block-changes": { type: "boolean" }, all: { type: "boolean" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  rebuild-index [--sections|--edges|--fts|--block-changes|--all]");
    return EXIT_OK;
  }
  const target: RebuildTarget = values.sections ? "sections" : values.edges ? "edges" : values.fts ? "fts" : values["block-changes"] ? "block_changes" : "all";
  const ws = cli.workspace();
  rebuildIndex(ws.store, target);
  cli.io.err(cli.style.dim(`  ${cli.style.ok(cli.render.g.ok)} rebuilt ${target}`));
  return EXIT_OK;
}

// ---- gc ---------------------------------------------------------------------

function runGcCmd(cli: Cli, args: string[]): number {
  const { values } = parseArgs({ args, allowPositionals: true, options: { "dry-run": { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) {
    cli.io.err("  gc [--dry-run]  — mark-and-sweep (refuses unless gc.enabled in repo settings)");
    return EXIT_OK;
  }
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const settings = resolveSettings(ws.store, repo.repoId);
  const enabled = Boolean((settings.gc as { enabled?: boolean } | undefined)?.enabled);
  if (!enabled && !values["dry-run"]) {
    throw new EngineErrorLike("target_missing", "gc is disabled; set gc.enabled=true (or use --dry-run)");
  }
  const result = runGc(ws.store, { enabled: enabled || Boolean(values["dry-run"]) });
  if (cli.flags.mode !== "human") cli.io.out(JSON.stringify(result));
  else cli.io.err(cli.style.dim(`  swept ${result.blobsSwept} blobs, ${result.treeNodesSwept} tree nodes`));
  return EXIT_OK;
}

// ---- doctor -----------------------------------------------------------------

function runDoctor(cli: Cli, args: string[]): number {
  parseArgs({ args, allowPositionals: true, options: { help: { type: "boolean" } } });
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  const db = ws.store.db;
  const checks: { name: string; ok: boolean; detail?: string }[] = [];

  const status = reposStatus(ws.store, repo.repoId);
  checks.push({ name: "convergence", ok: status.unconverged === 0, detail: `${status.unconverged} unconverged` });

  const ftsCount = (db.prepare("SELECT count(*) c FROM blocks_fts").get() as { c: number }).c;
  const liveBlocks = (db.prepare("SELECT count(*) c FROM blocks WHERE deleted_commit IS NULL").get() as { c: number }).c;
  checks.push({ name: "fts rows == live blocks", ok: ftsCount === liveBlocks, detail: `fts=${ftsCount} live=${liveBlocks}` });

  const dangling = (db.prepare("SELECT count(*) c FROM docs d WHERE d.deleted_commit IS NULL AND d.current_rev IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.rev_id = d.current_rev)").get() as { c: number }).c;
  checks.push({ name: "no dangling current_rev", ok: dangling === 0, detail: `${dangling} dangling` });

  const integrity = db.pragma("integrity_check", { simple: true }) as string;
  checks.push({ name: "sqlite integrity", ok: integrity === "ok", detail: integrity });

  const allOk = checks.every((c) => c.ok);
  if (cli.flags.mode !== "human") {
    cli.io.out(JSON.stringify({ ok: allOk, checks }));
    return allOk ? EXIT_OK : EXIT_ERROR;
  }
  const { style, io, render } = cli;
  for (const c of checks) {
    const mark = c.ok ? style.ok(render.g.ok) : style.err(render.g.err);
    io.out(`  ${mark} ${c.name}${c.detail && !c.ok ? style.dim(`  (${c.detail})`) : ""}`);
  }
  return allOk ? EXIT_OK : EXIT_ERROR;
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
    if (cli.flags.repo) throw err;
    if (err instanceof RepoSelectionError) return { kind: "workspace" };
    throw err;
  }
}

function runConfig(cli: Cli, args: string[]): number {
  const [sub, ...rest] = args;
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
      if (cli.flags.mode !== "human") cli.io.out(JSON.stringify(s));
      else {
        cli.io.err(cli.style.dim(`  workspace defaults`));
        for (const [k, v] of Object.entries(s)) cli.io.out(`  ${cli.style.accent(k)} ${cli.style.dim("=")} ${JSON.stringify(v)}`);
      }
      return EXIT_OK;
    }
    const effective = resolveSettings(ws.store, scope.repoId);
    const own = repoOwnSettings(ws.store, scope.repoId);
    if (cli.flags.mode !== "human") { cli.io.out(JSON.stringify(effective)); return EXIT_OK; }
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
  throw new CliUsageError(`unknown config subcommand '${sub}' (get|set|list)`);
}

// ---- import -----------------------------------------------------------------

function runImport(cli: Cli, args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { execute: { type: "boolean" }, help: { type: "boolean" } },
  });
  if (values.help) {
    cli.io.err("  import mrplex <export.json> [--execute]  — plan-by-default; --execute imports");
    return EXIT_OK;
  }
  if (positionals[0] !== "mrplex") throw new CliUsageError("only `import mrplex <export>` is supported");
  const file = positionals[1];
  if (!file) throw new CliUsageError("import mrplex requires an <export.json>");
  const docs = JSON.parse(readFileSync(file, "utf8")) as MrplexDoc[];
  const ws = cli.workspace();
  const repo = cli.repo(ws);

  if (!values.execute) {
    const plan = planImport(repo.repoId, docs);
    if (cli.flags.mode !== "human") cli.io.out(JSON.stringify(plan));
    else cli.io.err(cli.style.dim(`  plan — ${docs.length} docs; re-run with --execute to import`));
    return EXIT_OK;
  }
  const result = importDocs(ws.store, repo.repoId, docs);
  if (cli.flags.mode !== "human") cli.io.out(JSON.stringify(result));
  else cli.io.err(cli.style.dim(`  ${cli.style.ok(cli.render.g.ok)} imported ${docs.length} docs`));
  return EXIT_OK;
}

// ---- embed ------------------------------------------------------------------

async function runEmbed(cli: Cli, args: string[]): Promise<number> {
  const sub = args.find((a) => !a.startsWith("-"));
  if (args.includes("--help") || args.includes("-h") || sub === "help") {
    cli.io.err("  embed [status|drain] [--verbose] [--prune]  — embedding queue");
    cli.io.err(cli.style.dim("    status (default)  report provider + how many blocks are queued (embeddable but not yet embedded)"));
    cli.io.err(cli.style.dim("    drain             embed the queued blocks now; status alone makes no progress"));
    cli.io.err(cli.style.dim("    --verbose         (with drain) print per-batch progress as blocks are embedded"));
    cli.io.err(cli.style.dim("    --prune           (with drain) after embedding, delete vectors left by other models (e.g. after switching models)"));
    return EXIT_OK;
  }
  const verbose = args.includes("--verbose") || args.includes("-v");
  const prune = args.includes("--prune");
  const ws = cli.workspace();
  const repo = cli.repo(ws);

  const loaded = await loadEmbedding(ws, repo.repoId);
  if (!loaded) {
    // No provider configured (05 §6). Honest report; not an error.
    const hint = 'set one with `omg config set embedding.provider <command|url>` (e.g. omgbase-embedder)';
    if (cli.flags.mode !== "human") cli.io.out(JSON.stringify({ provider: null, queued: 0 }));
    else cli.io.err(cli.style.dim(`  no embedding provider configured — ${hint}`));
    return EXIT_OK;
  }

  if (sub === "drain") {
    await loaded.close(); // drainEmbeddings connects its own provider
    const result = await drainEmbeddings(cli, ws, repo.repoId, { verbose, prune });
    if (cli.flags.mode !== "human") cli.io.out(JSON.stringify({ provider: loaded.providerName, ...(result ?? { embedded: 0, cached: 0 }) }));
    else if (result) cli.io.err(`  ${cli.style.ok(cli.render.g.ok)} embedded ${result.embedded}, cached ${result.cached}`);
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

    // status
    const payload = { provider: loaded.providerName, model: loaded.provider.model, dim: loaded.provider.dim, embeddable: tasks.length, queued: pending.length, docs: docTasks.length, docsQueued: docPending.length, foreignBlocks: foreign.blocks, foreignDocs: foreign.docs };
    if (cli.flags.mode !== "human") cli.io.out(JSON.stringify(payload));
    else {
      cli.io.out(`  provider  ${cli.style.accent(loaded.providerName)} ${cli.style.dim(`(${loaded.provider.model}, ${loaded.provider.dim}d)`)}`);
      cli.io.out(`  embeddable ${tasks.length}   ${cli.style.dim("queued")} ${payload.queued}`);
      cli.io.out(`  docs ${docTasks.length}   ${cli.style.dim("queued")} ${payload.docsQueued}`);
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

export const cmdWatch: Command = { name: "watch", summary: "Foreground watcher (holds the lease)", run: (c, a) => runWatch(c, a) };
export const cmdRebuild: Command = { name: "rebuild-index", summary: "Rebuild derived tables", run: (c, a) => runRebuild(c, a) };
export const cmdGc: Command = { name: "gc", summary: "Mark-and-sweep (flag-gated)", run: (c, a) => runGcCmd(c, a) };
export const cmdDoctor: Command = { name: "doctor", summary: "Invariant sweep (CI-able)", run: (c, a) => runDoctor(c, a) };
export const cmdConfig: Command = { name: "config", summary: "Read/write repo settings", run: (c, a) => runConfig(c, a) };
export const cmdImport: Command = { name: "import", summary: "Import from mrplex (plan-by-default)", run: (c, a) => runImport(c, a) };
export const cmdEmbed: Command = { name: "embed", summary: "Embedding queue: status, or drain to embed", run: (c, a) => runEmbed(c, a) };
