// Fixture bridge for the `coordinator` cases of spec/sync `protocol.json`
// (README §6, §8). The coordinator lives in this package, so its cases run here;
// the rest of spec/sync runs from packages/core/corpus/sync.
//
//   runCoordinatorCase()   a script over a scripted in-memory source and a recording engine
//                          client (an in-process `Store` under the fixture minter): every
//                          `sync_in` / `reconcile` / `sync_out` step records its summary and the
//                          engine + source calls it made, in order; the projection adds the
//                          source's files and the store's docs and commits
//   validateCoordinatorCase()  the shape check
//
// Nothing here decides anything about sync: the `Coordinator` under test is the
// production class; the engine client is `InProcessEngineClient`'s four calls
// with the step's `ts` and the case's page limit threaded through (the
// coordinator itself passes neither), wrapped to record.
import {
  Store, ensureRepo, sequentialMinter, setIdMinter, observeMany, observeDelete, changesSince, docsRead, docsCreate, docsDelete, ingestFile, NullDocStore,
  type ObserveResult, type ObserveDeleteResult, type SyncSource, type SourceCapabilities, type SourceEntry, type SourceItem,
} from "@omgbase/core";
import { Coordinator, type SyncInSummary, type SyncOutSummary } from "../../src/coordinator.js";
import type { EngineClient, ChangesPage, DocBytes } from "../../src/engine-client.js";

// ---- fixture shapes ------------------------------------------------------------

export interface SourceStep {
  set?: Record<string, string>;
  rm?: string[];
}

export interface EngineStep {
  ts: string;
  /** an `api` commit through docs_create (actor defaults to null) */
  create?: { path: string; markdown: string; actor?: string };
  /** an `import` commit through the plain ingest */
  import?: { path: string; content: string };
  /** an `api` tombstone through docs_delete */
  delete?: { path: string; actor?: string };
  /** observed commits through observe_many (the engine's own observe path, not the coordinator) */
  observe?: { path: string; content: string }[];
}

export type CoordinatorStep =
  | { source: SourceStep }
  | { engine: EngineStep }
  | { sync_in: { ts: string } }
  | { reconcile: { ts: string; paths: string[] } }
  | { sync_out: { cursor?: number } };

export const COORDINATOR_STEPS = ["source", "engine", "sync_in", "reconcile", "sync_out"] as const;

export type Call = Record<string, unknown>;

export interface CoordinatorProjection {
  steps: Record<string, unknown>[];
  /** the source's files after the last step, path → bytes, sorted by path */
  files: Record<string, string>;
  docs: { doc_id: string; path: string; deleted: boolean }[];
  commits: { commit_id: string; seq: number; origin: string; actor: string | null }[];
}

export const COORDINATOR_PROJECTION_KEYS = ["steps", "files", "docs", "commits"] as const;

export interface CoordinatorCase {
  name: string;
  kind: "coordinator";
  notes?: string;
  source?: { write_through?: boolean };
  /** the `limit` the recording client passes to changes_since (default: the engine's 50) */
  page_limit?: number;
  steps: CoordinatorStep[];
  expect: CoordinatorProjection;
}

export const FIXTURE_REPO_SLUG = "fixture";
export const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---- the scripted source --------------------------------------------------------------

interface ScriptedSource extends SyncSource {
  readonly files: Map<string, { content: string; revision: number }>;
  set(path: string, content: string): void;
  /** path → bytes, sorted by path (the `files` projection) */
  snapshot(): Record<string, string>;
}

/**
 * An in-memory source whose `revision` is a per-path write counter; records
 * every call into `calls`. `write`/`remove` exist only when `writeThrough` (the
 * coordinator tests `source.write` for the export direction).
 */
function scriptedSource(writeThrough: boolean, calls: Call[]): ScriptedSource {
  const files = new Map<string, { content: string; revision: number }>();
  const set = (path: string, content: string): void => {
    const prev = files.get(path);
    files.set(path, { content, revision: (prev?.revision ?? 0) + 1 });
  };
  return {
    files,
    set,
    snapshot() {
      const out: Record<string, string> = {};
      for (const k of [...files.keys()].sort()) out[k] = files.get(k)!.content;
      return out;
    },
    capabilities(): SourceCapabilities {
      return { identity: "inferred", writeThrough, watch: false };
    },
    enumerate(): Promise<SourceEntry[]> {
      calls.push({ source: "enumerate" });
      return Promise.resolve([...files].map(([path, f]) => ({ path, revision: String(f.revision) })));
    },
    fetch(path: string): Promise<SourceItem | null> {
      calls.push({ source: "fetch", path });
      const f = files.get(path);
      return Promise.resolve(f ? { path, revision: String(f.revision), content: f.content } : null);
    },
    ...(writeThrough
      ? {
          write(path: string, content: string): Promise<void> {
            calls.push({ source: "write", path, content });
            set(path, content);
            return Promise.resolve();
          },
          remove(path: string): Promise<void> {
            calls.push({ source: "remove", path });
            files.delete(path);
            return Promise.resolve();
          },
        }
      : {}),
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

// ---- the recording engine client ---------------------------------------------------------

/** `InProcessEngineClient`'s calls with a pinned `ts` and page limit, recorded. */
class RecordingEngine implements EngineClient {
  ts = "1970-01-01T00:00:00.000Z";
  constructor(
    private readonly store: Store,
    private readonly repoId: string,
    private readonly pageLimit: number | undefined,
    private readonly calls: Call[],
  ) {}
  observeMany(files: { path: string; content: string }[]): Promise<ObserveResult[]> {
    this.calls.push({ engine: "observe_many", files });
    return Promise.resolve(observeMany(this.store, this.repoId, files, { ts: this.ts }));
  }
  observeDelete(path: string): Promise<ObserveDeleteResult> {
    this.calls.push({ engine: "observe_delete", path });
    return Promise.resolve(observeDelete(this.store, this.repoId, path, { ts: this.ts }));
  }
  changesSince(cursor?: number, opts?: { origin?: "api" | "observed" | "import"; limit?: number }): Promise<ChangesPage> {
    const limit = opts?.limit ?? this.pageLimit;
    this.calls.push({ engine: "changes_since", cursor: cursor ?? 0, ...(limit !== undefined ? { limit } : {}) });
    return Promise.resolve(
      changesSince(this.store, this.repoId, {
        ...(cursor !== undefined ? { cursor } : {}),
        ...(opts?.origin ? { origin: opts.origin } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    );
  }
  readDoc(path: string): Promise<DocBytes | null> {
    this.calls.push({ engine: "read_doc", path });
    const row = this.store.db
      .prepare("SELECT doc_id, file_hash FROM docs WHERE repo_id = ? AND path = ? AND deleted_commit IS NULL")
      .get(this.repoId, path) as { doc_id: string; file_hash: Buffer | null } | undefined;
    if (!row) return Promise.resolve(null);
    const res = docsRead(this.store, row.doc_id);
    if (!res) return Promise.resolve(null);
    return Promise.resolve({ content: res.content, contentHash: row.file_hash?.toString("hex") ?? "" });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ---- running a case -----------------------------------------------------------------------

function inSummary(s: SyncInSummary, calls: Call[]): Record<string, unknown> {
  return { ingested: s.ingested, suppressed: s.suppressed, conflicted: s.conflicted, deleted: s.deleted, calls };
}

function outSummary(s: SyncOutSummary, calls: Call[]): Record<string, unknown> {
  return { cursor: s.cursor, written: s.written, removed: s.removed, calls };
}

/**
 * Run a coordinator script: fresh `:memory:` store under the fixture minter with
 * repo `rp_0` (slug `fixture`, sourceless), a scripted source, the production
 * `Coordinator` over the recording client. Every step's outcome carries the
 * calls made while it ran.
 */
export async function runCoordinatorCase(c: Omit<CoordinatorCase, "expect">): Promise<{ expect: CoordinatorProjection }> {
  // The minter is a process-global seam and the coordinator's work spans awaits,
  // so it is installed for the whole case (vitest runs a file's tests serially).
  setIdMinter(sequentialMinter());
  const store = new Store({ path: ":memory:" });
  try {
    const repoId = ensureRepo(store, FIXTURE_REPO_SLUG, null);
    const calls: Call[] = [];
    const source = scriptedSource(c.source?.write_through ?? true, calls);
    const engine = new RecordingEngine(store, repoId, c.page_limit, calls);
    const coord = new Coordinator(engine, source);
    const steps: Record<string, unknown>[] = [];
    for (const step of c.steps) {
      calls.length = 0;
      if ("source" in step) {
        for (const [path, content] of Object.entries(step.source.set ?? {})) source.set(path, content);
        for (const path of step.source.rm ?? []) source.files.delete(path);
        steps.push({});
      } else if ("engine" in step) {
        steps.push(runEngineStep(store, repoId, step.engine));
      } else if ("sync_in" in step) {
        engine.ts = step.sync_in.ts;
        steps.push(inSummary(await coord.syncIn(), [...calls]));
      } else if ("reconcile" in step) {
        engine.ts = step.reconcile.ts;
        steps.push(inSummary(await coord.reconcile(step.reconcile.paths), [...calls]));
      } else {
        const s = await coord.syncOut(step.sync_out.cursor);
        steps.push(outSummary(s, [...calls]));
      }
    }
    const docs = (store.db.prepare("SELECT doc_id, path, deleted_commit FROM docs WHERE repo_id = ? ORDER BY path").all(repoId) as { doc_id: string; path: string; deleted_commit: string | null }[]).map(
      (d) => ({ doc_id: d.doc_id, path: d.path, deleted: d.deleted_commit !== null }),
    );
    const commits = store.db.prepare("SELECT commit_id, seq, origin, actor FROM commits WHERE repo_id = ? ORDER BY seq").all(repoId) as CoordinatorProjection["commits"];
    return { expect: { steps, files: source.snapshot(), docs, commits } };
  } finally {
    store.close();
    setIdMinter(null);
  }
}

function runEngineStep(store: Store, repoId: string, s: EngineStep): Record<string, unknown> {
  if (s.create) {
    const res = docsCreate(store, { repoId, docStore: new NullDocStore(), ts: s.ts, ...(s.create.actor !== undefined ? { actor: s.create.actor } : {}) }, s.create.path, s.create.markdown, {});
    return { doc: res.docId, committed: res.committed };
  }
  if (s.import) {
    const res = ingestFile(store, repoId, s.import.path, s.import.content, { ts: s.ts, origin: "import" });
    return { doc: res.docId, commit: res.commitId };
  }
  if (s.delete) {
    const res = docsDelete(store, { repoId, docStore: new NullDocStore(), ts: s.ts, ...(s.delete.actor !== undefined ? { actor: s.delete.actor } : {}) }, s.delete.path);
    return { doc: res.docId, committed: res.committed };
  }
  const out = observeMany(store, repoId, s.observe ?? [], { ts: s.ts });
  return { observed: out.map((o) => ({ path: o.path, echo: o.echo, commit: o.commitId })) };
}

// ---- validation -----------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[], here: string, problems: string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) problems.push(`${here}: unknown keys ${extra.join(", ")}`);
}

function requireTs(body: Record<string, unknown>, here: string, problems: string[]): void {
  if (typeof body.ts !== "string" || !TS_RE.test(body.ts)) problems.push(`${here}: \`ts\` must be RFC 3339 UTC with three fractional digits and Z (spec/store §2.4)`);
}

/** Validate one `coordinator` case (`at` names it); returns the step count or -1. */
export function validateCoordinatorCase(at: string, c: Record<string, unknown>, requireExpect: boolean, problems: string[]): void {
  onlyKeys(c, ["name", "kind", "notes", "source", "page_limit", "steps", "expect"], at, problems);
  if (c.source !== undefined) {
    if (!isRecord(c.source)) problems.push(`${at}: \`source\` must be an object`);
    else {
      onlyKeys(c.source, ["write_through"], `${at}.source`, problems);
      if (c.source.write_through !== undefined && typeof c.source.write_through !== "boolean") problems.push(`${at}.source: \`write_through\` must be a boolean`);
    }
  }
  if (c.page_limit !== undefined && (typeof c.page_limit !== "number" || !Number.isInteger(c.page_limit) || c.page_limit < 1)) problems.push(`${at}: \`page_limit\` must be a positive integer`);
  let n = -1;
  if (!Array.isArray(c.steps) || c.steps.length === 0) problems.push(`${at}: \`steps\` must be a non-empty array`);
  else {
    n = c.steps.length;
    c.steps.forEach((s, i) => {
      const here = `${at}.steps[${i}]`;
      if (!isRecord(s) || Object.keys(s).length !== 1 || !(COORDINATOR_STEPS as readonly string[]).includes(Object.keys(s)[0]!)) {
        problems.push(`${here}: a step is exactly one of ${COORDINATOR_STEPS.map((k) => `\`${k}\``).join(" / ")}`);
        return;
      }
      const kind = Object.keys(s)[0]!;
      const body = s[kind];
      if (!isRecord(body)) {
        problems.push(`${here}: not an object`);
        return;
      }
      switch (kind) {
        case "source":
          onlyKeys(body, ["set", "rm"], here, problems);
          if (body.set !== undefined && (!isRecord(body.set) || !Object.values(body.set).every((v) => typeof v === "string"))) problems.push(`${here}: \`set\` is path → content`);
          if (body.rm !== undefined && (!Array.isArray(body.rm) || !body.rm.every((v) => typeof v === "string"))) problems.push(`${here}: \`rm\` is a path list`);
          break;
        case "engine": {
          onlyKeys(body, ["ts", "create", "import", "delete", "observe"], here, problems);
          requireTs(body, here, problems);
          const ops = ["create", "import", "delete", "observe"].filter((k) => body[k] !== undefined);
          if (ops.length !== 1) problems.push(`${here}: exactly one of create/import/delete/observe`);
          break;
        }
        case "sync_in":
          onlyKeys(body, ["ts"], here, problems);
          requireTs(body, here, problems);
          break;
        case "reconcile":
          onlyKeys(body, ["ts", "paths"], here, problems);
          requireTs(body, here, problems);
          if (!Array.isArray(body.paths) || !body.paths.every((p) => typeof p === "string")) problems.push(`${here}: \`paths\` must be a string array`);
          break;
        case "sync_out":
          onlyKeys(body, ["cursor"], here, problems);
          if (body.cursor !== undefined && typeof body.cursor !== "number") problems.push(`${here}: \`cursor\` must be a number`);
          break;
      }
    });
  }
  if (c.expect === undefined) {
    if (requireExpect) problems.push(`${at}: missing \`expect\` (run SYNC_SPEC_UPDATE=1 in packages/sync)`);
    return;
  }
  if (!isRecord(c.expect)) {
    problems.push(`${at}.expect: must be an object`);
    return;
  }
  const keys = Object.keys(c.expect).sort();
  const want = [...COORDINATOR_PROJECTION_KEYS].sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) problems.push(`${at}.expect: must have exactly the keys ${COORDINATOR_PROJECTION_KEYS.join(", ")}`);
  else if (!Array.isArray(c.expect.steps) || (n >= 0 && c.expect.steps.length !== n)) problems.push(`${at}.expect.steps: one outcome per step`);
}
