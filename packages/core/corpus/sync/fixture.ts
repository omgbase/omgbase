// Fixture bridge for spec/sync (README §8). Pure pieces, no vitest:
//
//   runPure()               `pure.json`: render_config_flags / deep_merge / select_repo / sweep_plan
//   runRegistryCase()       `registry.json`: a registry + settings script on a fresh store, projected
//   runCheckpointCase()     `checkpoint.json`: disk/rm/sweep/checkpoint/drift/recover over an in-memory
//                           filesystem, spec/store §8 invariants after every ingesting step, projected
//   runAdapterCase()        `protocol.json` (kind `adapter`): a scripted fake adapter process plays the
//                           transcript's `in` lines; the engine's request lines are captured and compared
//                           byte for byte with the `out` lines; before each request the runner waits for
//                           the watch events the transcript promised so far (§8 Ordering, 1.2)
//   MemoryFs                the in-memory `SyncFs` (path → { content, mtime_ns }) — the walk is §4.2's bytewise order
//   validateFixtureFile()   the shape check a runner applies before trusting a file
//
// Nothing here decides anything about sync; it drives the production paths
// (`freshnessSweep`, `processCheckpoint`, `detectDiskDrift`, `recoverRepo`,
// `createExternalSource`, the registry and settings functions) with the fixture
// minter installed and pinned timestamps, and re-expresses the results so two
// engines can be compared. The coordinator cases of `protocol.json` (kind
// `coordinator`) run from `packages/sync/corpus/sync` — the coordinator lives there.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/core/store/store.js";
import { ensureRepo } from "../../src/core/attach.js";
import { sequentialMinter, withIdMinter } from "../../src/core/ids.js";
import { sha256 } from "../../src/core/hash.js";
import { selectRepo, RepoSelectionError, type RepoRow } from "../../src/sync/workspace.js";
import type { WatchEvent } from "../../src/sync/plugin.js";
import { renderConfigFlags, ensureAdapter, createSource, deleteSource, attachSourceToRepo, detachSourceFromRepo } from "../../src/sync/sources.js";
import { deepMerge, resolveSettings, writeRepoSettings, writeWorkspaceSettings, type Settings } from "../../src/sync/settings.js";
import { freshnessSweep, detectDiskDrift, rebuildFileStats, sweepPlan, type StatCacheRow, type SnapshotEntry } from "../../src/sync/freshness.js";
import { processCheckpoint, type CheckpointResult } from "../../src/sync/checkpoint.js";
import { recoverRepo } from "../../src/sync/recovery.js";
import { reposStatus } from "../../src/sync/admin.js";
import { createExternalSource } from "../../src/sync/external-source.js";
import type { SyncFs } from "../../src/sync/fs-util.js";
import type { SourceWatch, SyncSource } from "../../src/sync/plugin.js";
import { toReconcileConfig, deepEqualTol, type FixtureConfig } from "../reconcile/fixture.js";
import { FIXTURE_REPO_SLUG, TS_RE, checkInvariants, projectStore, type Row, type Projection as StoreProjection } from "../store/fixture.js";

export { deepEqualTol, FIXTURE_REPO_SLUG };

// ---- helpers ------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Run `body` with a fresh fixture minter installed (spec/store §2.2). */
function withFixtureMinter<T>(body: () => T): T {
  return withIdMinter(sequentialMinter(), body);
}

function hex(v: Buffer | null): string | null {
  return v === null ? null : v.toString("hex");
}

/** The root every checkpoint case runs under; the in-memory filesystem ignores it. */
export const FIXTURE_ROOT = "/fixture";

// ---- the in-memory filesystem -------------------------------------------------------

const IGNORED_SEGMENTS = new Set([".omgbase", ".git", "node_modules"]);

/** Bytewise (UTF-8) name order — what `readdir` yields per directory (README §4.2). */
function bytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * README §8 `checkpoint.json`: "scripts over an in-memory filesystem (`disk`
 * steps set `{ path, content, mtime_ns }`; `rm` steps remove)". The walk is
 * §4.2's: each directory's entries (files and subdirectories together) in
 * bytewise name order, depth-first, `.md` files only, skipping the ignored
 * directory names; `size` is the UTF-8 byte length.
 */
export class MemoryFs implements SyncFs {
  readonly files = new Map<string, { content: string; mtime_ns: bigint }>();
  set(path: string, content: string, mtimeNs: bigint): void {
    this.files.set(path, { content, mtime_ns: mtimeNs });
  }
  rm(path: string): void {
    this.files.delete(path);
  }
  walk(): string[] {
    const out: string[] = [];
    const recur = (prefix: string): void => {
      const entries = new Set<string>();
      for (const p of this.files.keys()) {
        if (!p.startsWith(prefix)) continue;
        entries.add(p.slice(prefix.length).split("/")[0]!);
      }
      for (const entry of [...entries].sort(bytewise)) {
        if (IGNORED_SEGMENTS.has(entry)) continue;
        const full = prefix + entry;
        if (this.files.has(full)) {
          if (entry.endsWith(".md")) out.push(full);
        } else recur(full + "/");
      }
    };
    recur("");
    return out;
  }
  stat(_root: string, path: string): { mtimeNs: bigint; size: number } | null {
    const f = this.files.get(path);
    return f ? { mtimeNs: f.mtime_ns, size: Buffer.byteLength(f.content, "utf8") } : null;
  }
  read(_root: string, path: string): string | null {
    return this.files.get(path)?.content ?? null;
  }
}

// ---- pure.json ------------------------------------------------------------------------

export const PURE_FNS = ["render_config_flags", "deep_merge", "select_repo", "sweep_plan"] as const;
export type PureFn = (typeof PURE_FNS)[number];

export interface PureCase {
  name: string;
  notes?: string;
  fn: PureFn;
  args: Record<string, unknown>;
  expect: unknown;
}

/** README §8 `pure.json`: one function over its `args`. */
export function runPure(c: Omit<PureCase, "expect">): unknown {
  const a = c.args;
  switch (c.fn) {
    case "render_config_flags":
      return renderConfigFlags(a.config as Record<string, unknown>);
    case "deep_merge":
      return deepMerge(a.base as Settings, a.over as Settings);
    case "select_repo": {
      const repos = (a.repos as { slug: string; root_path: string | null }[]).map((r): RepoRow => ({ repoId: r.slug, slug: r.slug, rootPath: r.root_path }));
      try {
        return selectRepo(repos, a.cwd as string, typeof a.slug === "string" ? a.slug : undefined).slug;
      } catch (e) {
        if (e instanceof RepoSelectionError) return { error: e.code, candidates: e.candidates };
        throw e;
      }
    }
    case "sweep_plan": {
      const cache = new Map<string, StatCacheRow>();
      for (const r of a.cache as { path: string; mtime_ns: number; size: number; hash: string }[]) {
        cache.set(r.path, { path: r.path, mtime_ns: BigInt(r.mtime_ns), size: r.size, hash: Buffer.from(r.hash, "hex") });
      }
      const snapshot: SnapshotEntry[] = (a.disk as { path: string; mtime_ns: number; size?: number; content: string }[]).map((d) => ({
        path: d.path,
        mtime_ns: BigInt(d.mtime_ns),
        size: d.size ?? Buffer.byteLength(d.content, "utf8"),
        hash: () => sha256(d.content),
      }));
      const plan = sweepPlan(cache, snapshot);
      return { candidates: plan.candidates, changed: plan.changed, deletions: plan.deletions, refreshed: plan.refreshed };
    }
  }
}

// ---- registry.json --------------------------------------------------------------------

export type RegistryStep =
  | { ensure_repo: { slug: string; root?: string } }
  | { ensure_adapter: { name: string; command: string; args?: string[] } }
  | { create_source: { name: string; adapter: string; config?: Record<string, unknown>; env?: Record<string, string> } }
  | { delete_source: { source: string } }
  | { attach: { repo: string; source: string } }
  | { detach: { repo: string; source: string } }
  | { settings: { scope: string; set: Record<string, unknown> } }
  | { resolve_settings: { repo?: string } };

export const REGISTRY_STEPS = ["ensure_repo", "ensure_adapter", "create_source", "delete_source", "attach", "detach", "settings", "resolve_settings"] as const;

export type JsonValue = unknown;

export interface RegistryProjection {
  steps: Record<string, unknown>[];
  repos: { repo_id: string; slug: string; settings: Record<string, unknown> }[];
  adapters: { name: string; command: string; args: unknown }[];
  sources: { source_id: string; name: string; adapter: string; config: unknown; env: unknown }[];
  attachments: { repo_id: string; source_id: string }[];
  sync_state: Row[];
  workspace_settings: Record<string, unknown>;
  repos_status: { slug: string; docs: number; blocks: number; commits: number; open_edges: number; unconverged: number }[];
}

export const REGISTRY_PROJECTION_KEYS = ["steps", "repos", "adapters", "sources", "attachments", "sync_state", "workspace_settings", "repos_status"] as const;

export interface RegistryCase {
  name: string;
  notes?: string;
  steps: RegistryStep[];
  expect: RegistryProjection;
}

/** A SQLite constraint failure → the pinned error code; anything else is a runner bug. */
function constraintCode(e: unknown): string {
  const code = (e as { code?: string }).code;
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") return "unique";
  if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") return "foreign_key";
  throw e;
}

function repoIdBySlug(store: Store, slug: string): string | null {
  const r = store.db.prepare("SELECT repo_id FROM repos WHERE slug = ?").get(slug) as { repo_id: string } | undefined;
  return r?.repo_id ?? null;
}

function runRegistryStep(store: Store, step: RegistryStep): Record<string, unknown> {
  try {
    if ("ensure_repo" in step) return { repo: ensureRepo(store, step.ensure_repo.slug, step.ensure_repo.root ?? null) };
    if ("ensure_adapter" in step) {
      ensureAdapter(store, step.ensure_adapter.name, step.ensure_adapter.command, step.ensure_adapter.args ?? []);
      return {};
    }
    if ("create_source" in step) {
      const s = step.create_source;
      return { source: createSource(store, { name: s.name, adapter: s.adapter, ...(s.config !== undefined ? { config: s.config } : {}), ...(s.env !== undefined ? { env: s.env } : {}) }) };
    }
    if ("delete_source" in step) {
      deleteSource(store, step.delete_source.source);
      return {};
    }
    if ("attach" in step) {
      attachSourceToRepo(store, step.attach.repo, step.attach.source);
      return {};
    }
    if ("detach" in step) {
      detachSourceFromRepo(store, step.detach.repo, step.detach.source);
      return {};
    }
    if ("settings" in step) {
      if (step.settings.scope === "workspace") writeWorkspaceSettings(store, step.settings.set);
      else {
        const repoId = repoIdBySlug(store, step.settings.scope);
        if (repoId === null) return { error: "repo_not_found" };
        writeRepoSettings(store, repoId, step.settings.set);
      }
      return {};
    }
    const slug = step.resolve_settings.repo;
    if (slug === undefined) return { settings: resolveSettings(store, null) };
    const repoId = repoIdBySlug(store, slug);
    if (repoId === null) return { error: "repo_not_found" };
    return { settings: resolveSettings(store, repoId) };
  } catch (e) {
    return { error: constraintCode(e) };
  }
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/** README §8 `registry.json` projection: the registry tables, both settings layers, the disk-free status fields. */
export function projectRegistry(store: Store): Omit<RegistryProjection, "steps"> {
  const db = store.db;
  const repos = (db.prepare("SELECT repo_id, slug, settings FROM repos ORDER BY slug").all() as { repo_id: string; slug: string; settings: string }[]).map((r) => ({
    repo_id: r.repo_id,
    slug: r.slug,
    settings: parseJson(r.settings) as Record<string, unknown>,
  }));
  const adapters = (db.prepare("SELECT name, command, args FROM adapters ORDER BY name").all() as { name: string; command: string; args: string }[]).map((r) => ({
    name: r.name,
    command: r.command,
    args: parseJson(r.args),
  }));
  const sources = (db.prepare("SELECT source_id, name, adapter, config, env FROM sources ORDER BY name").all() as { source_id: string; name: string; adapter: string; config: string; env: string }[]).map(
    (r) => ({ source_id: r.source_id, name: r.name, adapter: r.adapter, config: parseJson(r.config), env: parseJson(r.env) }),
  );
  const attachments = db.prepare("SELECT repo_id, source_id FROM attachments ORDER BY repo_id, source_id").all() as { repo_id: string; source_id: string }[];
  const sync_state = db.prepare("SELECT repo_id, source_id, path, revision, cursor FROM sync_state ORDER BY repo_id, source_id, path").all() as Row[];
  const ws = db.prepare("SELECT settings FROM workspace_settings WHERE id = 0").get() as { settings: string } | undefined;
  const workspace_settings = ws ? (parseJson(ws.settings) as Record<string, unknown>) : {};
  const repos_status = repos.map((r) => {
    const s = reposStatus(store, r.repo_id);
    return { slug: r.slug, docs: s.docs, blocks: s.blocks, commits: s.commits, open_edges: s.openEdges, unconverged: s.unconverged };
  });
  return { repos, adapters, sources, attachments, sync_state, workspace_settings, repos_status };
}

/** Run a registry script on a fresh `:memory:` store under the fixture minter (no repo is pre-created). */
export function runRegistryCase(c: Omit<RegistryCase, "expect">): { expect: RegistryProjection } {
  return withFixtureMinter(() => {
    const store = new Store({ path: ":memory:" });
    try {
      const steps = c.steps.map((s) => runRegistryStep(store, s));
      return { expect: { steps, ...projectRegistry(store) } };
    } finally {
      store.close();
    }
  });
}

// ---- checkpoint.json --------------------------------------------------------------------

export type CheckpointStep =
  | { disk: { path: string; content: string; mtime_ns: number } }
  | { rm: { path: string } }
  | { sweep: { ts: string; git_head?: string } }
  | { checkpoint: { ts: string; paths: string[]; git_head?: string } }
  | { drift: Record<string, never> }
  | { recover: { ts: string } }
  | { rebuild_stats: Record<string, never> };

export const CHECKPOINT_STEPS = ["disk", "rm", "sweep", "checkpoint", "drift", "recover", "rebuild_stats"] as const;

export interface CheckpointProjection extends Omit<StoreProjection, "steps"> {
  steps: Record<string, unknown>[];
  checkpoints: { id: string; ts: string; files: [string, string | null, string | null][]; git_head: string | null }[];
  file_stats: { path: string; mtime_ns: number; size: number; hash: string }[];
}

export const CHECKPOINT_PROJECTION_KEYS = [
  "steps", "docs", "commits", "revisions", "blobs", "tree_nodes", "blocks", "dispositions", "block_changes", "resurrection_pool", "sections", "checkpoints", "file_stats",
] as const;

export interface CheckpointCase {
  name: string;
  notes?: string;
  /** optional spec/reconcile §6 overrides (unused by the sweep today; accepted for parity with spec/store) */
  config?: FixtureConfig;
  steps: CheckpointStep[];
  expect: CheckpointProjection;
}

export interface CheckpointEvaluation {
  expect: CheckpointProjection;
  /** spec/store §8 invariant violations, prefixed with the step they were found after (empty = fine). */
  problems: string[];
}

function checkpointOutcome(r: CheckpointResult): Record<string, unknown> {
  return { checkpoint_id: r.checkpointId, ingested: r.ingested, suppressed: r.suppressed, deleted: r.deleted, conflicted: r.conflicted };
}

/**
 * Run a checkpoint script: fresh `:memory:` store, fixture minter, repo `rp_0`
 * (slug `fixture`, sourceless — the root is the in-memory filesystem), then
 * every step through the production paths. spec/store §8 is checked after every
 * step that can ingest and at the end; the projection is taken after the last step.
 */
export function runCheckpointCase(c: Omit<CheckpointCase, "expect">): CheckpointEvaluation {
  // `config` is accepted for shape parity; the sweep runs the store's default matcher config.
  void toReconcileConfig(c.config);
  return withFixtureMinter(() => {
    const store = new Store({ path: ":memory:" });
    try {
      const repoId = ensureRepo(store, FIXTURE_REPO_SLUG, null);
      const fs = new MemoryFs();
      // The bytes the store is supposed to hold per live path (I1): refreshed
      // from the filesystem for every path an ingesting step touched.
      const lastSource = new Map<string, string>();
      const touched = (paths: string[]): void => {
        for (const p of paths) {
          const bytes = fs.read(FIXTURE_ROOT, p);
          if (bytes === null) lastSource.delete(p);
          else lastSource.set(p, bytes);
        }
      };
      const steps: Record<string, unknown>[] = [];
      const problems: string[] = [];
      c.steps.forEach((step, i) => {
        let ingesting = false;
        if ("disk" in step) {
          fs.set(step.disk.path, step.disk.content, BigInt(step.disk.mtime_ns));
          steps.push({});
        } else if ("rm" in step) {
          fs.rm(step.rm.path);
          steps.push({});
        } else if ("sweep" in step) {
          const r = freshnessSweep(store, repoId, FIXTURE_ROOT, { ts: step.sweep.ts, fs, ...(step.sweep.git_head !== undefined ? { gitHead: step.sweep.git_head } : {}) });
          touched([...r.ingested, ...r.suppressed, ...r.conflicted, ...r.deleted]);
          steps.push({ ...checkpointOutcome(r), scanned: r.scanned, candidates: r.candidates, changed: r.changed });
          ingesting = true;
        } else if ("checkpoint" in step) {
          const s = step.checkpoint;
          const r = processCheckpoint(store, repoId, FIXTURE_ROOT, s.paths.map((path) => ({ path })), { ts: s.ts, fs, ...(s.git_head !== undefined ? { gitHead: s.git_head } : {}) });
          touched(s.paths);
          steps.push(checkpointOutcome(r));
          ingesting = true;
        } else if ("drift" in step) {
          steps.push({ ...detectDiskDrift(store, repoId, FIXTURE_ROOT, { fs }) });
        } else if ("recover" in step) {
          const r = recoverRepo(store, repoId, FIXTURE_ROOT, { ts: step.recover.ts, fs });
          touched(r.healed);
          steps.push({ healed: r.healed, missing: r.missing });
          ingesting = true;
        } else {
          steps.push({ scanned: rebuildFileStats(store, repoId, FIXTURE_ROOT, { fs }) });
        }
        if (ingesting) for (const p of checkInvariants(store, repoId, lastSource)) problems.push(`after step ${i}: ${p}`);
      });
      for (const p of checkInvariants(store, repoId, lastSource)) problems.push(`at end: ${p}`);
      return { expect: { steps, ...projectStore(store.db, repoId), ...projectSyncTables(store, repoId) }, problems };
    } finally {
      store.close();
    }
  });
}

/** `checkpoints` (by `ts`, then insertion) with `files` parsed, and `file_stats` by path. */
export function projectSyncTables(store: Store, repoId: string): Pick<CheckpointProjection, "checkpoints" | "file_stats"> {
  const checkpoints = (store.db.prepare("SELECT id, ts, files, git_head FROM checkpoints WHERE repo_id = ? ORDER BY ts, rowid").all(repoId) as { id: string; ts: string; files: string; git_head: string | null }[]).map(
    (r) => ({ id: r.id, ts: r.ts, files: parseJson(r.files) as [string, string | null, string | null][], git_head: r.git_head }),
  );
  const file_stats = (store.db.prepare("SELECT path, mtime_ns, size, hash FROM file_stats WHERE repo_id = ? ORDER BY path").safeIntegers(true).all(repoId) as { path: string; mtime_ns: bigint; size: bigint; hash: Buffer }[]).map(
    (r) => ({ path: r.path, mtime_ns: Number(r.mtime_ns), size: Number(r.size), hash: hex(r.hash)! }),
  );
  return { checkpoints, file_stats };
}

// ---- protocol.json (kind `adapter`) ---------------------------------------------------------

export interface TranscriptEntry {
  /** `in`: a line the adapter writes to the engine; `out`: a request line the engine writes to the adapter. */
  dir: "in" | "out";
  line: string;
}

export interface AdapterExpect {
  capabilities?: { identity: string; write_through: boolean; watch: boolean };
  /** one entry per `out` line, in order */
  results?: unknown[];
  /** every event delivered to the watch listener, in order, as parsed JSON: `{"event":"ready"}` | `{"event":"batch","paths":[…]}` (§8, 1.2) */
  events?: WatchEvent[];
  /** the source failed to connect: `invalid_handshake` | `exited` | `spawn` */
  error?: string;
}

export interface AdapterCase {
  name: string;
  kind: "adapter";
  notes?: string;
  transcript: TranscriptEntry[];
  expect: AdapterExpect;
}

/** The env vars the fake adapter reads (`fake-adapter.mjs`). */
export const FAKE_ADAPTER_TRANSCRIPT_ENV = "OMGBASE_FAKE_ADAPTER_TRANSCRIPT";
export const FAKE_ADAPTER_LOG_ENV = "OMGBASE_FAKE_ADAPTER_LOG";

export interface AdapterEvaluation {
  expect: AdapterExpect;
  /** the request lines the fake adapter actually received (the engine's `out` lines) */
  received: string[];
}

const ADAPTER_ERROR_RE = /^sync adapter error \(\w+\): /;

function classifyConnectError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes("invalid handshake")) return "invalid_handshake";
  if (m.includes("exited early")) return "exited";
  if (m.includes("failed to spawn")) return "spawn";
  throw e;
}

/** How long the runner waits for the events a transcript promises before its next request (§8 Ordering); a shortfall fails the case. */
const EVENT_PATIENCE_MS = 5_000;

/**
 * The watch listener's log: every event in arrival order, plus `waitFor(n)` —
 * resolves once at least `n` events arrived, rejects after `EVENT_PATIENCE_MS`.
 */
class EventLog {
  readonly events: WatchEvent[] = [];
  private waiters: { n: number; resolve: () => void }[] = [];
  push(ev: WatchEvent): void {
    this.events.push(ev);
    const ready = this.waiters.filter((w) => this.events.length >= w.n);
    this.waiters = this.waiters.filter((w) => this.events.length < w.n);
    for (const w of ready) w.resolve();
  }
  waitFor(n: number, what: string): Promise<void> {
    if (this.events.length >= n) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error(`§8 Ordering: waited ${EVENT_PATIENCE_MS} ms for ${n} watch event(s) before ${what}, received ${this.events.length}: ${JSON.stringify(this.events)}`));
      }, EVENT_PATIENCE_MS);
      const done = (): void => { clearTimeout(timer); resolve(); };
      this.waiters.push({ n, resolve: done });
    });
  }
}

/**
 * §8 Ordering (1.2): for each `out` entry, how many watch events the listener
 * must have received before the runner issues it — the `in` event lines (a line
 * whose JSON has an `event` key) between the `watch` request and that entry.
 * Event lines before any `watch` request are engine-dropped and not counted;
 * nor are those after an `unwatch` request (the listener is gone by then).
 */
export function promisedEventsBefore(transcript: readonly TranscriptEntry[]): number[] {
  const counts: number[] = [];
  let live = false;
  let n = 0;
  for (const e of transcript) {
    if (e.dir === "out") {
      counts.push(n);
      const method = (JSON.parse(e.line) as { method?: string }).method;
      if (method === "watch") live = true;
      else if (method === "unwatch") live = false;
    } else if (live && isEventLine(e.line)) n++;
  }
  return counts;
}

function isEventLine(line: string): boolean {
  try {
    const v = JSON.parse(line) as unknown;
    return isRecord(v) && typeof v.event === "string";
  } catch {
    return false;
  }
}

async function playRequest(source: SyncSource, line: string, watches: SourceWatch[], events: EventLog): Promise<unknown> {
  const req = JSON.parse(line) as { method: string; params?: Record<string, unknown> };
  const p = req.params ?? {};
  try {
    switch (req.method) {
      case "enumerate":
        return { entries: await source.enumerate() };
      case "fetch":
        return { item: await source.fetch(p.path as string) };
      case "write":
        if (!source.write) return { error: "unsupported" };
        await source.write(p.path as string, p.content as string);
        return { ok: true };
      case "remove":
        if (!source.remove) return { error: "unsupported" };
        await source.remove(p.path as string);
        return { ok: true };
      case "watch": {
        if (!source.watch) return { error: "unsupported" };
        watches.push(await source.watch((ev) => events.push(ev)));
        return { ok: true };
      }
      case "unwatch": {
        const w = watches.pop();
        if (!w) return { error: "no watch" };
        await w.stop();
        return { ok: true };
      }
      default:
        return { error: `unknown method ${req.method}` };
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (!ADAPTER_ERROR_RE.test(m)) throw e;
    return { error: m.replace(ADAPTER_ERROR_RE, "") };
  }
}

/**
 * Spawn `fake-adapter.mjs` with the transcript; for every `out` entry — after
 * waiting for the watch events the transcript promised before it (§8 Ordering) —
 * issue the request it spells through the `SyncSource` and record the result;
 * the adapter plays each `in` line when its turn comes. Returns the expectation
 * and the request lines the adapter received (the runner compares them to the
 * `out` lines).
 */
export async function runAdapterCase(c: Omit<AdapterCase, "expect">, fakeAdapterPath: string): Promise<AdapterEvaluation> {
  const dir = mkdtempSync(join(tmpdir(), "omgbase-sync-spec-"));
  const log = join(dir, "requests.log");
  const received = (): string[] => {
    try {
      return readFileSync(log, "utf8").split("\n").filter((l) => l !== "");
    } catch {
      return [];
    }
  };
  try {
    let source: SyncSource;
    try {
      source = await createExternalSource({
        command: process.execPath,
        args: [fakeAdapterPath],
        env: { [FAKE_ADAPTER_TRANSCRIPT_ENV]: JSON.stringify(c.transcript), [FAKE_ADAPTER_LOG_ENV]: log },
      });
    } catch (e) {
      return { expect: { error: classifyConnectError(e) }, received: received() };
    }
    const caps = source.capabilities();
    const results: unknown[] = [];
    const events = new EventLog();
    const watches: SourceWatch[] = [];
    const promised = promisedEventsBefore(c.transcript);
    try {
      let k = 0;
      for (const entry of c.transcript) {
        if (entry.dir !== "out") continue;
        await events.waitFor(promised[k]!, `out[${k}] ${entry.line}`);
        results.push(await playRequest(source, entry.line, watches, events));
        k++;
      }
    } finally {
      await source.close();
    }
    return {
      expect: { capabilities: { identity: caps.identity, write_through: caps.writeThrough, watch: caps.watch }, results, events: events.events },
      received: received(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- files -------------------------------------------------------------------------------

export type CaseKind = "pure" | "registry" | "checkpoint" | "protocol";

export function suiteKind(suite: string): CaseKind | null {
  return suite === "pure" || suite === "registry" || suite === "checkpoint" || suite === "protocol" ? suite : null;
}

export type FixtureCase = PureCase | RegistryCase | CheckpointCase | AdapterCase | CoordinatorCaseShape;

/** The coordinator cases live in `protocol.json` too; this runner only validates their outline (packages/sync runs them). */
export interface CoordinatorCaseShape {
  name: string;
  kind: "coordinator";
  notes?: string;
  source?: unknown;
  page_limit?: number;
  steps: unknown[];
  expect?: unknown;
}

export interface FixtureFile {
  suite: string;
  cases: FixtureCase[];
}

// ---- validation -------------------------------------------------------------------------

export interface ValidateOptions {
  /** false while regenerating: cases may not have an `expect` yet */
  requireExpect?: boolean;
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[], here: string, problems: string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) problems.push(`${here}: unknown keys ${extra.join(", ")}`);
}

function requireTs(body: Record<string, unknown>, here: string, problems: string[]): void {
  if (typeof body.ts !== "string" || !TS_RE.test(body.ts)) problems.push(`${here}: \`ts\` must be RFC 3339 UTC with three fractional digits and Z (spec/store §2.4)`);
}

function requirePath(v: unknown, here: string, problems: string[]): void {
  if (typeof v !== "string" || v === "" || v.startsWith("/")) problems.push(`${here}: \`path\` must be repo-relative with no leading slash`);
}

function requireObject(v: unknown, here: string, what: string, problems: string[]): v is Record<string, unknown> {
  if (isRecord(v)) return true;
  problems.push(`${here}: \`${what}\` must be an object`);
  return false;
}

/** Validate a single-key step against `validators`; returns the step count or -1. */
function validateSteps(at: string, steps: unknown, kinds: readonly string[], validate: (kind: string, body: Record<string, unknown>, here: string, problems: string[]) => void, problems: string[]): number {
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push(`${at}: \`steps\` must be a non-empty array`);
    return -1;
  }
  steps.forEach((s, i) => {
    const here = `${at}.steps[${i}]`;
    if (!isRecord(s)) {
      problems.push(`${here}: not an object`);
      return;
    }
    const keys = Object.keys(s);
    if (keys.length !== 1 || !kinds.includes(keys[0]!)) {
      problems.push(`${here}: a step is exactly one of ${kinds.map((k) => `\`${k}\``).join(" / ")} (got ${keys.join(", ")})`);
      return;
    }
    const body = s[keys[0]!];
    if (!isRecord(body)) {
      problems.push(`${here}: not an object`);
      return;
    }
    validate(keys[0]!, body, here, problems);
  });
  return steps.length;
}

function validateRegistryStep(kind: string, body: Record<string, unknown>, here: string, problems: string[]): void {
  switch (kind) {
    case "ensure_repo":
      onlyKeys(body, ["slug", "root"], here, problems);
      if (typeof body.slug !== "string" || body.slug === "") problems.push(`${here}: \`slug\` must be a non-empty string`);
      if (body.root !== undefined && typeof body.root !== "string") problems.push(`${here}: \`root\` must be a string`);
      break;
    case "ensure_adapter":
      onlyKeys(body, ["name", "command", "args"], here, problems);
      if (typeof body.name !== "string" || typeof body.command !== "string") problems.push(`${here}: \`name\` and \`command\` must be strings`);
      if (body.args !== undefined && (!Array.isArray(body.args) || !body.args.every((a) => typeof a === "string"))) problems.push(`${here}: \`args\` must be a string array`);
      break;
    case "create_source":
      onlyKeys(body, ["name", "adapter", "config", "env"], here, problems);
      if (typeof body.name !== "string" || typeof body.adapter !== "string") problems.push(`${here}: \`name\` and \`adapter\` must be strings`);
      if (body.config !== undefined && !isRecord(body.config)) problems.push(`${here}: \`config\` must be an object`);
      if (body.env !== undefined && !isRecord(body.env)) problems.push(`${here}: \`env\` must be an object`);
      break;
    case "delete_source":
      onlyKeys(body, ["source"], here, problems);
      if (typeof body.source !== "string") problems.push(`${here}: \`source\` must be a source id`);
      break;
    case "attach":
    case "detach":
      onlyKeys(body, ["repo", "source"], here, problems);
      if (typeof body.repo !== "string" || typeof body.source !== "string") problems.push(`${here}: \`repo\` and \`source\` must be ids`);
      break;
    case "settings":
      onlyKeys(body, ["scope", "set"], here, problems);
      if (typeof body.scope !== "string" || body.scope === "") problems.push(`${here}: \`scope\` is "workspace" or a repo slug`);
      if (!isRecord(body.set)) problems.push(`${here}: \`set\` must be an object`);
      break;
    case "resolve_settings":
      onlyKeys(body, ["repo"], here, problems);
      if (body.repo !== undefined && typeof body.repo !== "string") problems.push(`${here}: \`repo\` must be a slug`);
      break;
  }
}

function validateCheckpointStep(kind: string, body: Record<string, unknown>, here: string, problems: string[]): void {
  switch (kind) {
    case "disk":
      onlyKeys(body, ["path", "content", "mtime_ns"], here, problems);
      requirePath(body.path, here, problems);
      if (typeof body.content !== "string") problems.push(`${here}: \`content\` must be a string`);
      if (typeof body.mtime_ns !== "number" || !Number.isSafeInteger(body.mtime_ns) || body.mtime_ns < 0) problems.push(`${here}: \`mtime_ns\` must be a non-negative safe integer`);
      break;
    case "rm":
      onlyKeys(body, ["path"], here, problems);
      requirePath(body.path, here, problems);
      break;
    case "sweep":
      onlyKeys(body, ["ts", "git_head"], here, problems);
      requireTs(body, here, problems);
      if (body.git_head !== undefined && typeof body.git_head !== "string") problems.push(`${here}: \`git_head\` must be a string`);
      break;
    case "checkpoint":
      onlyKeys(body, ["ts", "paths", "git_head"], here, problems);
      requireTs(body, here, problems);
      if (!Array.isArray(body.paths)) problems.push(`${here}: \`paths\` must be an array`);
      else body.paths.forEach((p, j) => requirePath(p, `${here}.paths[${j}]`, problems));
      if (body.git_head !== undefined && typeof body.git_head !== "string") problems.push(`${here}: \`git_head\` must be a string`);
      break;
    case "drift":
    case "rebuild_stats":
      onlyKeys(body, [], here, problems);
      break;
    case "recover":
      onlyKeys(body, ["ts"], here, problems);
      requireTs(body, here, problems);
      break;
  }
}

function validateExactKeys(at: string, e: unknown, want: readonly string[], problems: string[]): e is Record<string, unknown> {
  if (!isRecord(e)) {
    problems.push(`${at}: must be an object`);
    return false;
  }
  const keys = Object.keys(e).sort();
  const wantSorted = [...want].sort();
  if (keys.length !== wantSorted.length || keys.some((k, i) => k !== wantSorted[i])) {
    problems.push(`${at}: must have exactly the keys ${want.join(", ")} (got ${keys.join(", ")})`);
    return false;
  }
  return true;
}

function validateStepsCount(at: string, e: Record<string, unknown>, stepCount: number, problems: string[]): void {
  if (!Array.isArray(e.steps)) problems.push(`${at}.steps: must be an array`);
  else if (stepCount >= 0 && e.steps.length !== stepCount) problems.push(`${at}.steps: ${e.steps.length} outcomes for ${stepCount} steps`);
}

function validatePureCase(at: string, c: Record<string, unknown>, requireExpect: boolean, problems: string[]): void {
  onlyKeys(c, ["name", "notes", "fn", "args", "expect"], at, problems);
  if (typeof c.fn !== "string" || !(PURE_FNS as readonly string[]).includes(c.fn)) problems.push(`${at}: \`fn\` must be one of ${PURE_FNS.join("/")}`);
  if (!requireObject(c.args, at, "args", problems)) return;
  const a = c.args;
  switch (c.fn) {
    case "render_config_flags":
      onlyKeys(a, ["config"], `${at}.args`, problems);
      requireObject(a.config, `${at}.args`, "config", problems);
      break;
    case "deep_merge":
      onlyKeys(a, ["base", "over"], `${at}.args`, problems);
      requireObject(a.base, `${at}.args`, "base", problems);
      requireObject(a.over, `${at}.args`, "over", problems);
      break;
    case "select_repo":
      onlyKeys(a, ["repos", "cwd", "slug"], `${at}.args`, problems);
      if (!Array.isArray(a.repos)) problems.push(`${at}.args: \`repos\` must be an array of { slug, root_path }`);
      else a.repos.forEach((r, i) => {
        if (!isRecord(r) || typeof r.slug !== "string" || (r.root_path !== null && typeof r.root_path !== "string")) problems.push(`${at}.args.repos[${i}]: a repo is { slug, root_path: string | null }`);
      });
      if (typeof a.cwd !== "string" || !a.cwd.startsWith("/")) problems.push(`${at}.args: \`cwd\` must be an absolute path`);
      if (a.slug !== undefined && typeof a.slug !== "string") problems.push(`${at}.args: \`slug\` must be a string`);
      break;
    case "sweep_plan":
      onlyKeys(a, ["cache", "disk"], `${at}.args`, problems);
      if (!Array.isArray(a.cache)) problems.push(`${at}.args: \`cache\` must be an array`);
      else a.cache.forEach((r, i) => {
        if (!isRecord(r) || typeof r.path !== "string" || typeof r.mtime_ns !== "number" || typeof r.size !== "number" || typeof r.hash !== "string" || !/^[0-9a-f]{64}$/.test(r.hash)) {
          problems.push(`${at}.args.cache[${i}]: a cache row is { path, mtime_ns, size, hash: <sha256 hex> }`);
        }
      });
      if (!Array.isArray(a.disk)) problems.push(`${at}.args: \`disk\` must be an array`);
      else a.disk.forEach((r, i) => {
        if (!isRecord(r) || typeof r.path !== "string" || typeof r.mtime_ns !== "number" || typeof r.content !== "string" || (r.size !== undefined && typeof r.size !== "number")) {
          problems.push(`${at}.args.disk[${i}]: a disk entry is { path, mtime_ns, content, size? }`);
        }
      });
      break;
  }
  if (c.expect === undefined && requireExpect) problems.push(`${at}: missing \`expect\` (run SYNC_SPEC_UPDATE=1)`);
}

function validateTranscript(at: string, t: unknown, problems: string[]): void {
  if (!Array.isArray(t) || t.length === 0) {
    problems.push(`${at}: \`transcript\` must be a non-empty array of { dir, line }`);
    return;
  }
  t.forEach((e, i) => {
    if (!isRecord(e) || (e.dir !== "in" && e.dir !== "out") || typeof e.line !== "string" || Object.keys(e).length !== 2) {
      problems.push(`${at}.transcript[${i}]: an entry is { dir: "in" | "out", line }`);
      return;
    }
    if (e.dir === "out") {
      try {
        const req = JSON.parse(e.line) as unknown;
        if (!isRecord(req) || typeof req.method !== "string") problems.push(`${at}.transcript[${i}]: an \`out\` line is a request { id, method, params }`);
      } catch {
        problems.push(`${at}.transcript[${i}]: an \`out\` line must be JSON`);
      }
    }
  });
  if ((t[0] as TranscriptEntry).dir !== "in") problems.push(`${at}.transcript[0]: the first line is the adapter's handshake (dir "in")`);
}

/** `expect.events` (§8, 1.2): parsed event objects — `{"event":"ready"}` or `{"event":"batch","paths":[string…]}`. */
function validateWatchEvents(at: string, events: unknown, problems: string[]): void {
  if (!Array.isArray(events)) {
    problems.push(`${at}: must be an array of watch events`);
    return;
  }
  events.forEach((ev, i) => {
    const ok =
      isRecord(ev) &&
      ((ev.event === "ready" && Object.keys(ev).length === 1) ||
        (ev.event === "batch" && Object.keys(ev).length === 2 && Array.isArray(ev.paths) && ev.paths.every((p) => typeof p === "string")));
    if (!ok) problems.push(`${at}[${i}]: an event is {"event":"ready"} or {"event":"batch","paths":[…]} (got ${JSON.stringify(ev)})`);
  });
}

/**
 * Validate a parsed `cases/<suite>.json`; returns the problems found (empty = valid).
 * `file` is the file name (with `.json`); the suite must equal its stem.
 */
export function validateFixtureFile(file: string, doc: unknown, opts: ValidateOptions = {}): string[] {
  const requireExpect = opts.requireExpect ?? true;
  const problems: string[] = [];
  if (!isRecord(doc)) return [`${file}: not an object`];
  const stem = file.replace(/\.json$/, "");
  if (doc.suite !== stem) problems.push(`${file}: \`suite\` must equal the file stem '${stem}' (got ${JSON.stringify(doc.suite)})`);
  const extra = Object.keys(doc).filter((k) => !["suite", "cases"].includes(k));
  if (extra.length > 0) problems.push(`${file}: unknown top-level keys ${extra.join(", ")}`);
  const kind = suiteKind(stem);
  if (kind === null) return [...problems, `${file}: unknown suite (one of pure, registry, checkpoint, protocol)`];
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) return [...problems, `${file}: \`cases\` must be a non-empty array`];

  const seen = new Set<string>();
  doc.cases.forEach((c: unknown, i: number) => {
    const at = `${file}#${i}`;
    if (!isRecord(c)) {
      problems.push(`${at}: not an object`);
      return;
    }
    if (typeof c.name !== "string" || c.name === "") problems.push(`${at}: missing \`name\``);
    else if (seen.has(c.name)) problems.push(`${at}: duplicate name '${c.name}'`);
    else seen.add(c.name);
    if (c.notes !== undefined && typeof c.notes !== "string") problems.push(`${at}: \`notes\` must be a string`);

    if (kind === "pure") {
      validatePureCase(at, c, requireExpect, problems);
      return;
    }
    if (kind === "registry") {
      onlyKeys(c, ["name", "notes", "steps", "expect"], at, problems);
      const n = validateSteps(at, c.steps, REGISTRY_STEPS, validateRegistryStep, problems);
      if (c.expect === undefined) {
        if (requireExpect) problems.push(`${at}: missing \`expect\` (run SYNC_SPEC_UPDATE=1)`);
        return;
      }
      if (validateExactKeys(`${at}.expect`, c.expect, REGISTRY_PROJECTION_KEYS, problems)) validateStepsCount(`${at}.expect`, c.expect, n, problems);
      return;
    }
    if (kind === "checkpoint") {
      onlyKeys(c, ["name", "notes", "config", "steps", "expect"], at, problems);
      if (c.config !== undefined && !isRecord(c.config)) problems.push(`${at}: \`config\` must be an object`);
      const n = validateSteps(at, c.steps, CHECKPOINT_STEPS, validateCheckpointStep, problems);
      if (c.expect === undefined) {
        if (requireExpect) problems.push(`${at}: missing \`expect\` (run SYNC_SPEC_UPDATE=1)`);
        return;
      }
      if (validateExactKeys(`${at}.expect`, c.expect, CHECKPOINT_PROJECTION_KEYS, problems)) validateStepsCount(`${at}.expect`, c.expect, n, problems);
      return;
    }
    // protocol
    if (c.kind === "adapter") {
      onlyKeys(c, ["name", "kind", "notes", "transcript", "expect"], at, problems);
      validateTranscript(at, c.transcript, problems);
      if (c.expect === undefined) {
        if (requireExpect) problems.push(`${at}: missing \`expect\` (run SYNC_SPEC_UPDATE=1)`);
        return;
      }
      if (!isRecord(c.expect)) problems.push(`${at}.expect: must be an object`);
      else if (!("error" in c.expect)) {
        if (!validateExactKeys(`${at}.expect`, c.expect, ["capabilities", "results", "events"], problems)) return;
        // A regeneration rewrites `expect`, so its content is only checked when it is trusted.
        if (requireExpect) validateWatchEvents(`${at}.expect.events`, c.expect.events, problems);
      }
    } else if (c.kind === "coordinator") {
      // Outline only — packages/sync/corpus/sync validates and runs these.
      onlyKeys(c, ["name", "kind", "notes", "source", "page_limit", "steps", "expect"], at, problems);
      if (!Array.isArray(c.steps) || c.steps.length === 0) problems.push(`${at}: \`steps\` must be a non-empty array`);
      if (c.expect === undefined && requireExpect) problems.push(`${at}: missing \`expect\` (run SYNC_SPEC_UPDATE=1 in packages/sync)`);
    } else {
      problems.push(`${at}: \`kind\` must be "adapter" or "coordinator"`);
    }
  });
  return problems;
}
