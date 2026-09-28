// Fixture bridge for spec/surface (README §6). Pure pieces, no vitest:
//
//   suiteKind()             the three case shapes, told apart by the file stem
//   loadCorpus()            a suite's `corpus` (path → source) observed into a fresh `:memory:`
//                           store under the fixture minter — one `observeBatch` in path order
//   runQueryCase()          §1 / §6: one `query` through the runner (`oqxRun`) — planned AND pure
//                           in-memory (`plan: false`), which must agree — as the JSON `OqxResult`,
//                           or `{ error, message_includes }`
//   runReadsCase()          §2–§4 / §6: an observation script (spec/store §9.4) plus `read` steps
//                           that call the MCP tool handlers through the built `McpServer`
//   runCursorCase()         §1.4 / §6: `encodeCursor` / `decodeCursor`
//   readCorpusFromDisk()    the alchemy repository as the spec embeds it (path → source)
//   validateFixtureFile()   the shape check a runner applies before trusting a file
//                           (also `interop.json`, §7 — run by interop.test.ts, not spec.test.ts)
//   describeChange()        the `+`/`~`/`-` regeneration report both runners print
//
// Nothing here decides anything about the surface; it drives the same code paths
// production uses (`oqxRun`, `buildServer`'s tool handlers, `observeBatch`,
// `encodeCursor`/`decodeCursor`) with the fixture minter installed and a pinned
// clock, and re-expresses the results as JSON so two implementations can be
// compared.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../src/core/store/store.js";
import { ensureRepo } from "../../src/core/attach.js";
import { sequentialMinter, setIdMinter } from "../../src/core/ids.js";
import { withClock } from "../../src/core/clock.js";
import { CursorInvalid, decodeCursor, encodeCursor } from "../../src/core/cursor.js";
import { sweepResurrectionPool } from "../../src/core/store/gc.js";
import { observeBatch } from "../../src/sync/observe.js";
import { oqxRun, type OqxResult } from "../../src/oqx-js/run.js";
import { FilterInvalid } from "../../src/search/cel/parser.js";
import { buildServer, type ServerContext } from "../../src/mcp/server.js";
import { deepEqualTol } from "../reconcile/fixture.js";
import { FIXTURE_REPO_SLUG, TS_RE, toOutcome, validateSteps, type ExtraStepValidator, type Step as StoreStep, type StepOutcome as StoreStepOutcome } from "../store/fixture.js";

export { deepEqualTol, FIXTURE_REPO_SLUG };

// ---- fixture shapes ------------------------------------------------------------

/** The reference's alchemy repository (README §6): `packages/core/corpus/oqx/fixtures/alchemy`. */
export const ALCHEMY_DIR = fileURLToPath(new URL("../oqx/fixtures/alchemy/", import.meta.url));
/** The commit `ts` every corpus-backed suite observes its documents under. */
export const CORPUS_TS = "2026-09-27T00:00:00.000Z";

/** A recorded query error: the code and a substring of the engine's message (README §1.4, §6). */
export interface QueryErrorExpect {
  error: "filter_invalid";
  message_includes: string;
}

export interface QueryCase {
  name: string;
  notes?: string;
  query: string;
  /** the runner's page cap (default 50) */
  limit?: number;
  /** a cursor a previous page issued */
  cursor?: string;
  expect: OqxResult | QueryErrorExpect;
}

export interface QuerySuite {
  suite: string;
  /** path → exact source, the 18 alchemy documents (regenerated from disk) */
  corpus: Record<string, string>;
  cases: QueryCase[];
}

/** A `read` step: one MCP tool call. `ts` pins the wall clock for the call (a mutating tool stamps its commit with "now"). */
export interface ReadStep {
  read: { tool: string; args: Record<string, unknown>; ts?: string };
}
export type Step = StoreStep | ReadStep;

/** A tool error, as the fixture records it: the envelope minus its prose. */
export interface ReadErrorOutcome {
  error: string;
  retriable: boolean;
  data?: unknown;
}
export type ReadOutcome = unknown;
export type StepOutcome = StoreStepOutcome | ReadOutcome;

export interface ReadsCase {
  name: string;
  notes?: string;
  /** give the default repo a working tree (a temp dir seeded from the observe steps) so mutating tools can run */
  workspace?: boolean;
  steps: Step[];
  expect: { steps: StepOutcome[] };
}

export interface CursorCase {
  name: string;
  notes?: string;
  /** encode these parts */
  parts?: string[];
  /** decode this cursor … */
  cursor?: string;
  /** … requiring this many parts (default 2, the `query` keyset) */
  arity?: number;
  expect: { cursor: string } | { parts: string[] } | { error: "filter_invalid" };
}

export interface ReadsSuite {
  suite: string;
  cases: ReadsCase[];
}
export interface CursorSuite {
  suite: string;
  cases: CursorCase[];
}

/** One MCP tool call of the interop suite (README §7): no `ts` — the whole process runs under the case's clock. */
export interface InteropCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * README §7: a cross-engine case. The writer observes the corpus, then runs
 * `writes`; the reader runs `reads`; both sequences are recorded as `reads.json`
 * records outcomes (§7.3). `ts` is the writer's (and reader's) pinned clock,
 * default `CORPUS_TS`.
 */
export interface InteropCase {
  name: string;
  notes?: string;
  ts?: string;
  writes?: InteropCall[];
  reads: InteropCall[];
  expect: { writes: ReadOutcome[]; reads: ReadOutcome[] };
}

export interface InteropSuite {
  suite: string;
  /** path → exact source, the 18 alchemy documents (regenerated from disk) */
  corpus: Record<string, string>;
  cases: InteropCase[];
}
export type FixtureFile = QuerySuite | ReadsSuite | CursorSuite | InteropSuite;

export type CaseKind = "query" | "reads" | "cursor" | "interop";

/** The four suite kinds, told apart by the file stem (README §6). */
export function suiteKind(suite: string): CaseKind {
  if (suite === "reads") return "reads";
  if (suite === "cursor") return "cursor";
  if (suite === "interop") return "interop";
  return "query";
}

/** The suites that embed the alchemy corpus (README §6). */
export function carriesCorpus(kind: CaseKind): boolean {
  return kind === "query" || kind === "interop";
}

export const CASE_KEYS: Record<CaseKind, readonly string[]> = {
  query: ["name", "notes", "query", "limit", "cursor", "expect"],
  reads: ["name", "notes", "workspace", "steps", "expect"],
  cursor: ["name", "notes", "parts", "cursor", "arity", "expect"],
  interop: ["name", "notes", "ts", "writes", "reads", "expect"],
};

// ---- helpers ------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Bytewise (UTF-8) string order — the corpus batch order (README §6). */
export function cmpBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** What a JSON emitter would produce: `undefined` object members dropped, array holes → null. */
function canonical<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Recursively rebuild objects with sorted keys so vitest's diff ignores key order. */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v === "object" && v !== null) {
    const rec = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec).sort()) out[k] = sortKeys(rec[k]);
    return out;
  }
  return v;
}

/** Install a fresh fixture minter (spec/store §2.2) for an async body, restoring the previous one afterwards. */
async function withFixtureMinterAsync<T>(body: () => Promise<T>): Promise<T> {
  setIdMinter(sequentialMinter());
  try {
    return await body();
  } finally {
    setIdMinter(null);
  }
}

// The clock for a `read` step that writes is `withClock` (core/clock.ts): mutating
// tools stamp their commits with "now" (there is no `ts` argument on the wire),
// so the step carries the clock it runs under; `omg mcp` pins the same clock
// process-wide under OMGBASE_SPEC_CLOCK (README §7.1).

/** The regeneration report both runners print: `+` new, `~` changed, `-` gone (by case name). */
export function describeChange(suite: string, before: { name: string; expect?: unknown }[], after: { name: string; expect?: unknown }[]): string[] {
  const lines: string[] = [];
  const old = new Map(before.map((c) => [c.name, c] as const));
  const seen = new Set<string>();
  for (const c of after) {
    seen.add(c.name);
    const prev = old.get(c.name);
    if (!prev || prev.expect === undefined) lines.push(`  + ${suite}::${c.name}`);
    else if (JSON.stringify(prev.expect) !== JSON.stringify(c.expect)) lines.push(`  ~ ${suite}::${c.name}`);
  }
  for (const name of old.keys()) if (!seen.has(name)) lines.push(`  - ${suite}::${name}`);
  return lines;
}

// ---- the corpus ---------------------------------------------------------------------

/** Every `*.md` under `dir` as `{ "<relative posix path>": "<source>" }`, keys in bytewise order. */
export function readCorpusFromDisk(dir = ALCHEMY_DIR): Record<string, string> {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".md")) files.push(full);
    }
  };
  walk(dir);
  const out: Record<string, string> = {};
  const rel = files.map((f) => [relative(dir, f).split(sep).join("/"), f] as const).sort((a, b) => cmpBytes(a[0], b[0]));
  for (const [path, full] of rel) out[path] = readFileSync(full, "utf8");
  return out;
}

export interface LoadedCorpus {
  store: Store;
  repoId: string;
}

/**
 * README §6: a fresh `:memory:` store under the fixture minter, repo `rp_0`
 * (slug `fixture`, sourceless), the corpus observed as ONE batch in bytewise
 * path order at `CORPUS_TS`. The caller closes the store.
 */
export function loadCorpus(corpus: Record<string, string>): LoadedCorpus {
  setIdMinter(sequentialMinter());
  try {
    const store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, FIXTURE_REPO_SLUG, null);
    const items = Object.keys(corpus).sort(cmpBytes).map((path) => ({ path, content: corpus[path]! }));
    observeBatch(store, repoId, items, CORPUS_TS);
    return { store, repoId };
  } finally {
    setIdMinter(null);
  }
}

// ---- §1 query cases -----------------------------------------------------------------

export type QueryCaseInput = Omit<QueryCase, "expect"> & { expect?: QueryCase["expect"] };

export interface QueryEvaluation {
  expect: OqxResult | QueryErrorExpect;
  /** planned ≠ in-memory, or a non-OQX exception (empty = fine) */
  problems: string[];
}

function runOnce(c: LoadedCorpus, q: QueryCaseInput, plan: boolean): { ok: true; result: OqxResult } | { ok: false; message: string } {
  try {
    const result = oqxRun(c.store, c.repoId, q.query, {
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(plan ? {} : { plan: false }),
    });
    return { ok: true, result: canonical(result) };
  } catch (e) {
    // An OQX error (the library's, normalized) and a malformed cursor are the
    // surface's `filter_invalid`; anything else is a bug and is rethrown.
    if (e instanceof FilterInvalid) return { ok: false, message: e.message };
    if (e instanceof CursorInvalid) return { ok: false, message: e.message };
    throw e;
  }
}

/**
 * One query through the runner, planned (the default) and pure in-memory
 * (`plan: false`); the two must agree (README §1: the planner is invisible).
 * `expect` is the JSON `OqxResult`, or `{ error, message_includes }` — the
 * authored substring is kept while the message still contains it, otherwise
 * the whole message is recorded for the author to trim.
 */
export function runQueryCase(c: LoadedCorpus, q: QueryCaseInput): QueryEvaluation {
  const planned = runOnce(c, q, true);
  const memory = runOnce(c, q, false);
  const problems: string[] = [];
  if (planned.ok !== memory.ok) {
    problems.push(`planned ${planned.ok ? "returned rows" : "failed"} but in-memory ${memory.ok ? "returned rows" : "failed"}`);
  } else if (planned.ok && memory.ok) {
    const diff = deepEqualTol(planned.result, memory.result, 1e-9);
    if (diff !== null) problems.push(`planned != in-memory: ${diff}`);
  } else if (!planned.ok && !memory.ok && planned.message !== memory.message) {
    problems.push(`planned error "${planned.message}" != in-memory error "${memory.message}"`);
  }
  if (planned.ok) return { expect: planned.result, problems };
  const prev = q.expect && "error" in q.expect ? q.expect.message_includes : undefined;
  const message_includes = prev !== undefined && planned.message.includes(prev) ? prev : planned.message;
  return { expect: { error: "filter_invalid", message_includes }, problems };
}

/** Compare a generated query outcome with the committed `expect` (an error compares by code + substring). Null = equal. */
export function diffQueryExpect(actual: OqxResult | QueryErrorExpect, expect: OqxResult | QueryErrorExpect): string | null {
  if ("error" in actual || "error" in expect) {
    if (!("error" in actual)) return "expected an error, got a result";
    if (!("error" in expect)) return `expected a result, got error "${actual.message_includes}"`;
    if (actual.error !== expect.error) return `error ${actual.error} vs ${expect.error}`;
    if (!actual.message_includes.includes(expect.message_includes)) return `message "${actual.message_includes}" does not include "${expect.message_includes}"`;
    return null;
  }
  return deepEqualTol(actual, expect, 1e-9);
}

// ---- §2–§4 reads cases -----------------------------------------------------------------

export type ReadsCaseInput = Omit<ReadsCase, "expect">;

export interface ReadsEvaluation {
  expect: { steps: StepOutcome[] };
  /** runner problems (a tool result that was not JSON) — empty = fine */
  problems: string[];
}

export interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/**
 * A tool result as the fixture records it: the parsed JSON payload, or — for
 * `isError` — the envelope without its prose: `{ error, retriable, data? }`.
 * `data` is dropped for `filter_invalid` (it restates the message plus a
 * reference-doc hint); `changes_since` digests lose `summary` (README §3:
 * unpinned).
 */
/**
 * README §6: a `version` read is recorded by SHAPE — its values name the engine
 * and the release. Every leaf becomes its type name (`"<string>"`, `"<number>"`,
 * `"<null>"`, `"<boolean>"`); objects keep their keys with values normalized
 * recursively; arrays keep their length. The two engine-specific parts are the
 * exceptions: `components` (keyed by the engine's own packages) is recorded as
 * `"<object>"`, and the optional `mcp.sdk` (present only when an SDK is used) is
 * dropped; `commit` and `built`, null or not by build environment, are recorded
 * as `"<string|null>"`. The CLI runner applies the same rule to `omg version --json`.
 */
export function typeShape(v: unknown, path: string[] = []): unknown {
  if (v === null) return "<null>";
  if (Array.isArray(v)) return v.map((x, i) => typeShape(x, [...path, String(i)]));
  if (typeof v === "object") {
    if (path.length === 1 && path[0] === "components") return "<object>";
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (path.length === 1 && path[0] === "mcp" && k === "sdk") continue;
      // `commit`/`built` are null or not by BUILD ENVIRONMENT (a git checkout or
      // not), which no fixture can pin: one token for either.
      out[k] = path.length === 0 && (k === "commit" || k === "built") ? "<string|null>" : typeShape(x, [...path, k]);
    }
    return out;
  }
  return `<${typeof v}>`;
}

export function toReadOutcome(tool: string, r: ToolResult): ReadOutcome {
  const text = r.content[0]?.text ?? "";
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${tool}: result is not JSON: ${text}`);
  }
  if (r.isError) {
    const env = payload as { error: string; retriable?: boolean; data?: unknown };
    const out: ReadErrorOutcome = { error: env.error, retriable: Boolean(env.retriable) };
    if (env.data !== undefined && env.error !== "filter_invalid") out.data = env.data;
    return canonical(out);
  }
  if (tool === "version") return canonical(typeShape(payload)) as ReadOutcome;
  if (tool === "changes_since" && isRecord(payload) && Array.isArray(payload.digests)) {
    payload = { ...payload, digests: payload.digests.map((d: unknown) => (isRecord(d) ? Object.fromEntries(Object.entries(d).filter(([k]) => k !== "summary")) : d)) };
  }
  return canonical(payload);
}

/**
 * Run a case: fresh `:memory:` store under the fixture minter, repo `rp_0`
 * (slug `fixture`; sourceless unless `workspace`, which registers a seeded
 * temp dir as its fs source and the server's `rootPath`), an MCP client over
 * an in-memory transport to `buildServer`; then every step — `observe` /
 * `sweep` through the store paths, `read` through the tool handler under its
 * pinned clock.
 */
export async function runReadsCase(c: ReadsCaseInput): Promise<ReadsEvaluation> {
  return withFixtureMinterAsync(async () => {
    const store = new Store({ path: ":memory:" });
    const dir = c.workspace ? mkdtempSync(join(tmpdir(), "omgbase-surface-spec-")) : null;
    let client: Client | null = null;
    let server: ReturnType<typeof buildServer> | null = null;
    try {
      const repoId = ensureRepo(store, FIXTURE_REPO_SLUG, dir);
      const ctx: ServerContext = { store, repoId, ...(dir ? { rootPath: dir } : {}) };
      server = buildServer(ctx);
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: "surface-spec", version: "0" });
      await Promise.all([server.connect(serverT), client.connect(clientT)]);

      const steps: StepOutcome[] = [];
      const problems: string[] = [];
      for (const step of c.steps) {
        if ("observe" in step) {
          const items = step.observe.items.map((it) => ({ path: it.path, content: it.source }));
          const outcomes = observeBatch(store, repoId, items, step.observe.ts);
          if (dir) {
            // The working tree mirrors the observation: an observed file IS the bytes on disk.
            for (const it of step.observe.items) {
              const abs = join(dir, it.path);
              if (it.source === null) {
                try { unlinkSync(abs); } catch { /* already gone */ }
              } else {
                mkdirSync(dirname(abs), { recursive: true });
                writeFileSync(abs, it.source);
              }
            }
          }
          steps.push(outcomes.map(toOutcome));
        } else if ("sweep" in step) {
          steps.push({ swept: sweepResurrectionPool(store, step.sweep.ts) });
        } else {
          const { tool, args, ts } = step.read;
          const cl = client;
          const r = (await withClock(ts, () => cl.callTool({ name: tool, arguments: args }))) as ToolResult;
          try {
            steps.push(toReadOutcome(tool, r));
          } catch (e) {
            problems.push(String(e));
            steps.push(null);
          }
        }
      }
      return { expect: { steps }, problems };
    } finally {
      try { await client?.close(); } catch { /* transport already down */ }
      try { await server?.close(); } catch { /* transport already down */ }
      store.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ---- §1.4 cursor cases --------------------------------------------------------------------

export type CursorCaseInput = Omit<CursorCase, "expect">;

/** `parts` → the cursor; `cursor` (+ `arity`) → its parts, or `filter_invalid` when the surface would refuse it. */
export function runCursorCase(c: CursorCaseInput): CursorCase["expect"] {
  if (c.parts !== undefined) return { cursor: encodeCursor(c.parts) };
  try {
    return { parts: decodeCursor(c.cursor ?? "", c.arity === 1 ? "docs_list/docs_tree" : "query", c.arity ?? 2) };
  } catch (e) {
    if (e instanceof CursorInvalid) return { error: "filter_invalid" };
    throw e;
  }
}

// ---- validation -------------------------------------------------------------------------

export interface ValidateOptions {
  /** false while regenerating: cases may not have an `expect` yet */
  requireExpect?: boolean;
}

const validateRead: ExtraStepValidator = (body, here, problems) => {
  if (!isRecord(body)) {
    problems.push(`${here}: not an object`);
    return;
  }
  const extra = Object.keys(body).filter((k) => !["tool", "args", "ts"].includes(k));
  if (extra.length > 0) problems.push(`${here}: read takes \`tool\`, \`args\`, \`ts\` (got ${extra.join(", ")})`);
  if (typeof body.tool !== "string" || body.tool === "") problems.push(`${here}: \`tool\` must be a tool name`);
  if (!isRecord(body.args)) problems.push(`${here}: \`args\` must be an object`);
  if (body.ts !== undefined && (typeof body.ts !== "string" || !TS_RE.test(body.ts))) problems.push(`${here}: \`ts\` must be RFC 3339 UTC with three fractional digits and Z (spec/store §2.4)`);
};

/** README §7: an interop call is exactly `{ tool, args }`. Returns the number of calls (or -1 when not an array). */
function validateCalls(at: string, calls: unknown, problems: string[]): number {
  if (!Array.isArray(calls)) {
    problems.push(`${at}: must be an array of { tool, args }`);
    return -1;
  }
  calls.forEach((c: unknown, i: number) => {
    const here = `${at}[${i}]`;
    if (!isRecord(c)) {
      problems.push(`${here}: not an object`);
      return;
    }
    const extra = Object.keys(c).filter((k) => !["tool", "args"].includes(k));
    if (extra.length > 0) problems.push(`${here}: a call takes \`tool\`, \`args\` (got ${extra.join(", ")})`);
    if (typeof c.tool !== "string" || c.tool === "") problems.push(`${here}: \`tool\` must be a tool name`);
    else if (c.tool === "query_syntax") problems.push(`${here}: query_syntax is not compared (README §7.3)`);
    else if (c.tool === "version") problems.push(`${here}: version is engine-specific by nature and never interop-compared (README §6)`);
    if (!isRecord(c.args)) problems.push(`${here}: \`args\` must be an object`);
  });
  return calls.length;
}

const OQX_RESULT_KEYS = ["hits", "truncated", "cursor", "consumer", "count", "exists", "none", "values"];

function validateQueryExpect(at: string, e: unknown, problems: string[]): void {
  if (!isRecord(e)) {
    problems.push(`${at}: must be an object`);
    return;
  }
  if ("error" in e) {
    const keys = Object.keys(e).sort();
    if (keys.join(",") !== "error,message_includes" || e.error !== "filter_invalid" || typeof e.message_includes !== "string") {
      problems.push(`${at}: a query error is exactly { error: "filter_invalid", message_includes: string }`);
    }
    return;
  }
  const extra = Object.keys(e).filter((k) => !OQX_RESULT_KEYS.includes(k));
  if (extra.length > 0) problems.push(`${at}: unknown result keys ${extra.join(", ")}`);
  if (!Array.isArray(e.hits)) problems.push(`${at}.hits must be an array`);
  if (typeof e.truncated !== "boolean") problems.push(`${at}.truncated must be a boolean`);
  if (e.cursor !== null && typeof e.cursor !== "string") problems.push(`${at}.cursor must be a string or null`);
  if (!["collect", "count", "exists", "none", "first", "single"].includes(e.consumer as string)) problems.push(`${at}.consumer must name a consumer`);
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
  const kind = suiteKind(stem);
  if (doc.suite !== stem) problems.push(`${file}: \`suite\` must equal the file stem '${stem}' (got ${JSON.stringify(doc.suite)})`);
  const topKeys = carriesCorpus(kind) ? ["suite", "corpus", "cases"] : ["suite", "cases"];
  const extra = Object.keys(doc).filter((k) => !topKeys.includes(k));
  if (extra.length > 0) problems.push(`${file}: unknown top-level keys ${extra.join(", ")}`);
  if (carriesCorpus(kind)) {
    if (!isRecord(doc.corpus)) problems.push(`${file}: \`corpus\` must be an object (path → source)`);
    else if (requireExpect && Object.keys(doc.corpus).length === 0) problems.push(`${file}: \`corpus\` is empty (run SURFACE_SPEC_UPDATE=1)`);
    else {
      for (const [p, s] of Object.entries(doc.corpus)) {
        if (typeof s !== "string") problems.push(`${file}: corpus[${JSON.stringify(p)}] must be a string`);
        if (p === "" || p.startsWith("/") || !p.endsWith(".md")) problems.push(`${file}: corpus path ${JSON.stringify(p)} must be repo-relative, no leading slash, ending in .md`);
      }
    }
  }
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) return [...problems, `${file}: \`cases\` must be a non-empty array`];

  const seen = new Set<string>();
  doc.cases.forEach((c: unknown, i: number) => {
    const at = `${file}#${i}`;
    if (!isRecord(c)) {
      problems.push(`${at}: not an object`);
      return;
    }
    const unknown = Object.keys(c).filter((k) => !CASE_KEYS[kind].includes(k));
    if (unknown.length > 0) problems.push(`${at}: unknown case keys ${unknown.join(", ")}`);
    if (typeof c.name !== "string" || c.name === "") problems.push(`${at}: missing \`name\``);
    else if (seen.has(c.name)) problems.push(`${at}: duplicate name '${c.name}'`);
    else seen.add(c.name);
    if (c.notes !== undefined && typeof c.notes !== "string") problems.push(`${at}: \`notes\` must be a string`);

    let stepCount = -1;
    let writeCount = 0;
    let readCount = -1;
    if (kind === "interop") {
      if (c.ts !== undefined && (typeof c.ts !== "string" || !TS_RE.test(c.ts))) problems.push(`${at}: \`ts\` must be RFC 3339 UTC with three fractional digits and Z (spec/store §2.4)`);
      if (c.writes !== undefined) writeCount = validateCalls(`${at}.writes`, c.writes, problems);
      readCount = validateCalls(`${at}.reads`, c.reads, problems);
      if (readCount === 0) problems.push(`${at}.reads: must not be empty (README §7.2)`);
    } else if (kind === "query") {
      if (typeof c.query !== "string") problems.push(`${at}: \`query\` must be an OQX source`);
      if (c.limit !== undefined && (typeof c.limit !== "number" || !Number.isInteger(c.limit) || c.limit < 0)) problems.push(`${at}: \`limit\` must be a non-negative integer`);
      if (c.cursor !== undefined && typeof c.cursor !== "string") problems.push(`${at}: \`cursor\` must be a string`);
    } else if (kind === "reads") {
      if (c.workspace !== undefined && typeof c.workspace !== "boolean") problems.push(`${at}: \`workspace\` must be a boolean`);
      stepCount = validateSteps(at, c.steps, problems, { read: validateRead });
    } else {
      const has = ["parts", "cursor"].filter((k) => c[k] !== undefined);
      if (has.length !== 1) problems.push(`${at}: exactly one of \`parts\` / \`cursor\``);
      if (c.parts !== undefined && (!Array.isArray(c.parts) || !c.parts.every((p) => typeof p === "string"))) problems.push(`${at}: \`parts\` must be an array of strings`);
      if (c.cursor !== undefined && typeof c.cursor !== "string") problems.push(`${at}: \`cursor\` must be a string`);
      if (c.arity !== undefined && (c.cursor === undefined || ![1, 2].includes(c.arity as number))) problems.push(`${at}: \`arity\` is 1 or 2 and goes with \`cursor\``);
    }

    if (c.expect === undefined) {
      if (requireExpect) problems.push(`${at}: missing \`expect\` (run SURFACE_SPEC_UPDATE=1)`);
      return;
    }
    if (kind === "interop") {
      const e = c.expect;
      if (!isRecord(e) || Object.keys(e).sort().join(",") !== "reads,writes" || !Array.isArray(e.writes) || !Array.isArray(e.reads)) {
        problems.push(`${at}.expect: must be exactly { writes: [...], reads: [...] }`);
      } else {
        if (writeCount >= 0 && e.writes.length !== writeCount) problems.push(`${at}.expect.writes: ${e.writes.length} outcomes for ${writeCount} writes`);
        if (readCount >= 0 && e.reads.length !== readCount) problems.push(`${at}.expect.reads: ${e.reads.length} outcomes for ${readCount} reads`);
      }
    } else if (kind === "query") validateQueryExpect(`${at}.expect`, c.expect, problems);
    else if (kind === "reads") {
      if (!isRecord(c.expect) || Object.keys(c.expect).join(",") !== "steps" || !Array.isArray(c.expect.steps)) problems.push(`${at}.expect: must be exactly { steps: [...] }`);
      else if (stepCount >= 0 && c.expect.steps.length !== stepCount) problems.push(`${at}.expect.steps: ${c.expect.steps.length} outcomes for ${stepCount} steps`);
    } else {
      const e = c.expect;
      const ok = isRecord(e) && Object.keys(e).length === 1 && (
        (c.parts !== undefined && typeof e.cursor === "string") ||
        (c.cursor !== undefined && (Array.isArray(e.parts) || e.error === "filter_invalid"))
      );
      if (!ok) problems.push(`${at}.expect: { cursor } for an encode case, { parts } or { error: "filter_invalid" } for a decode case`);
    }
  });
  return problems;
}
