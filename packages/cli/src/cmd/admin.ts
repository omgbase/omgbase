import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import {
  Watcher,
  WatchLease,
  freshnessSweep,
  rebuildIndex,
  runGc,
  planImport,
  importDocs,
  reposStatus,
  buildEmbedTasks,
  type RebuildTarget,
  type MrplexDoc,
} from "@omgbase/core";
import type { Command } from "../commands.js";
import type { Cli } from "../context.js";
import { CliUsageError, EngineErrorLike, EXIT_OK, EXIT_ERROR } from "../output.js";
import { loadEmbedding } from "./_embed.js";

// watch + admin/maintenance (11 §5.8–5.9).

// ---- watch ------------------------------------------------------------------

async function runWatch(cli: Cli, args: string[]): Promise<number> {
  parseArgs({ args, allowPositionals: true, options: { help: { type: "boolean" } } });
  const ws = cli.workspace();
  const repo = cli.repo(ws);

  const lease = WatchLease.tryAcquire(ws.omgbaseDir);
  if (!lease) throw new EngineErrorLike("target_missing", "another watcher already holds the lease for this workspace");

  freshnessSweep(ws.store, repo.repoId, repo.rootPath); // start fresh
  const watcher = new Watcher(ws.store, repo.repoId, repo.rootPath, {
    onCheckpoint: (r) => {
      if (r.ingested.length || r.deleted.length || r.conflicted.length) {
        cli.io.err(`${cli.style.ok(cli.render.g.sync)} +${r.ingested.length} -${r.deleted.length}${r.conflicted.length ? ` !${r.conflicted.length}` : ""}`);
      }
    },
  });
  watcher.start();
  cli.io.err(cli.style.dim(`  watching ${repo.slug} — Ctrl-C to stop`));

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void watcher.stop().then(() => {
        lease.release();
        resolve();
      });
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
  const settings = repoSettings(ws, repo.repoId);
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

  const dangling = (db.prepare("SELECT count(*) c FROM documents d WHERE d.deleted_commit IS NULL AND d.current_rev IS NOT NULL AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.rev_id = d.current_rev)").get() as { c: number }).c;
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

function runConfig(cli: Cli, args: string[]): number {
  const [sub, ...rest] = args;
  const ws = cli.workspace();
  const repo = cli.repo(ws);
  if (sub === "list" || sub === undefined) {
    const s = repoSettings(ws, repo.repoId);
    if (cli.flags.mode !== "human") cli.io.out(JSON.stringify(s));
    else for (const [k, v] of Object.entries(s)) cli.io.out(`${cli.style.accent(k)} ${cli.style.dim("=")} ${JSON.stringify(v)}`);
    return EXIT_OK;
  }
  if (sub === "get") {
    const key = rest[0];
    if (!key) throw new CliUsageError("config get <key>");
    const val = getPath(repoSettings(ws, repo.repoId), key);
    cli.io.out(val === undefined ? "" : typeof val === "string" ? val : JSON.stringify(val));
    return EXIT_OK;
  }
  if (sub === "set") {
    const key = rest[0];
    const raw = rest[1];
    if (!key || raw === undefined) throw new CliUsageError("config set <key> <value>");
    const settings = repoSettings(ws, repo.repoId);
    setPath(settings, key, coerce(raw));
    ws.store.db.prepare("UPDATE repos SET settings = ? WHERE repo_id = ?").run(JSON.stringify(settings), repo.repoId);
    cli.io.err(cli.style.dim(`  set ${key}`));
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
  const [sub] = args;
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

  try {
    const tasks = buildEmbedTasks(ws.store, repo.repoId);
    // Queue depth = embeddable blocks whose current-context vector isn't cached.
    const pending = loaded.worker.staleBlocks(tasks);

    if (sub === "drain") {
      // Egress notice (05 §6): a remote provider receives block text off-machine.
      if (loaded.remote) {
        cli.io.err(cli.style.warn(`  embedding ${pending.length} block(s) via ${loaded.providerName} — block text is sent to this remote endpoint`));
      } else {
        cli.io.err(cli.style.dim(`  embedding ${pending.length} block(s) via ${loaded.providerName} (local process)`));
      }
      const result = await loaded.worker.process(tasks);
      if (cli.flags.mode !== "human") cli.io.out(JSON.stringify({ provider: loaded.providerName, ...result }));
      else cli.io.err(`  ${cli.style.ok(cli.render.g.ok)} embedded ${result.embedded}, cached ${result.cached}`);
      return EXIT_OK;
    }

    // status
    const payload = { provider: loaded.providerName, model: loaded.provider.model, dim: loaded.provider.dim, embeddable: tasks.length, queued: pending.length };
    if (cli.flags.mode !== "human") cli.io.out(JSON.stringify(payload));
    else {
      cli.io.out(`  provider  ${cli.style.accent(loaded.providerName)} ${cli.style.dim(`(${loaded.provider.model}, ${loaded.provider.dim}d)`)}`);
      cli.io.out(`  embeddable ${tasks.length}   ${cli.style.dim("queued")} ${payload.queued}`);
    }
    return EXIT_OK;
  } finally {
    await loaded.close();
  }
}

// helpers ---------------------------------------------------------------------

function repoSettings(ws: ReturnType<Cli["workspace"]>, repoId: string): Record<string, unknown> {
  const row = ws.store.db.prepare("SELECT settings FROM repos WHERE repo_id = ?").get(repoId) as { settings: string } | undefined;
  try {
    return row ? (JSON.parse(row.settings) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
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
export const cmdEmbed: Command = { name: "embed", summary: "Embedding queue status/drain", run: (c, a) => runEmbed(c, a) };
// (runEmbed help)  omg embed [status|drain]  — provider status or process the queue
