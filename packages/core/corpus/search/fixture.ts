// Fixture bridge for spec/search (README §7). Pure pieces, no vitest:
//
//   fixtureEmbedder()       README §6: the `fixture-hash-8` hash embedder every runner implements
//   runSanitizeCase()       §7 `sanitize.json`: string → MATCH expression
//   runCosineCase()         §7 `cosine.json`: two float32 vectors → cosine
//   runObserveCase()        §7 observation scripts: `observe`/`sweep` (spec/store §9.4) plus
//                           `drain` / `search` / `resolve`, then the §7 projection
//   projectSearch()         the §7 projection: `embed_tasks`, `doc_tasks` (with the §2.4 header), `embeddings`, `doc_embeddings`
//   checkSearch()           runner checks: vector byte lengths / dims, method values, model isolation
//   compareExpect()         the §7 comparison with its tolerances (bm25 1e-6, cosine 1e-9,
//                           vectors 1e-9 after float32 rounding)
//   validateFixtureFile()   the shape check a runner applies before trusting a file
//
// Nothing here decides anything about search; it drives the same code paths
// production uses (`observeBatch`, `buildEmbedTasks` → `EmbeddingWorker.process`,
// `buildDocEmbedTasks` → `processDocs`, `textSearch`, `vectorSearch`,
// `hybridSearch`, `resolve`) with the fixture minter and the fixture embedder
// installed, and re-expresses the results so the two implementations can be
// compared. The fixture embedder is a runner device like the id minter: it is
// never wired into a product path.
import { createHash } from "node:crypto";
import { Store } from "../../src/core/store/store.js";
import { ensureRepo } from "../../src/core/attach.js";
import { sequentialMinter, setIdMinter } from "../../src/core/ids.js";
import { sha256 } from "../../src/core/hash.js";
import { cosineFloat32 } from "../../src/core/vec.js";
import { sweepResurrectionPool } from "../../src/core/store/gc.js";
import { observeBatch } from "../../src/sync/observe.js";
import { sanitizeFtsQuery } from "../../src/search/fts-query.js";
import { EmbeddingWorker, estimateTokens, type EmbeddingProvider } from "../../src/search/embeddings.js";
import { buildEmbedTasks, buildDocEmbedTasks } from "../../src/search/tasks.js";
import { textSearch } from "../../src/search/text.js";
import { vectorSearch } from "../../src/search/vector.js";
import { hybridSearch, type HybridHit } from "../../src/search/rrf.js";
import { resolve as resolveSearch } from "../../src/search/resolve.js";
import { toReconcileConfig, deepEqualTol, type FixtureConfig } from "../reconcile/fixture.js";
import {
  FIXTURE_REPO_SLUG, toOutcome, validateSteps,
  type Step as StoreStep, type StepOutcome as StoreStepOutcome,
} from "../store/fixture.js";

export { deepEqualTol, FIXTURE_REPO_SLUG };

// ---- the fixture embedder (README §6) --------------------------------------------------

export const FIXTURE_MODEL = "fixture-hash-8";
export const FIXTURE_DIM = 8;
export const FIXTURE_MAX_INPUT_TOKENS = 64;

/**
 * README §6: `h = sha256(utf8(s))`; `u = h[2i] × 256 + h[2i+1]`; `raw[i] = u / 65535 × 2 − 1`
 * in f64; L2-normalized in f64. Returned as numbers — the worker stores float32.
 */
export function fixtureVector(s: string): number[] {
  const h = createHash("sha256").update(s, "utf8").digest();
  const raw: number[] = [];
  for (let i = 0; i < FIXTURE_DIM; i++) raw.push(((h[2 * i]! * 256 + h[2 * i + 1]!) / 65535) * 2 - 1);
  let norm = 0;
  for (const x of raw) norm += x * x;
  norm = Math.sqrt(norm);
  return norm === 0 ? raw : raw.map((x) => x / norm);
}

/** The fixture embedder as an `EmbeddingProvider` (never a product default). */
export function fixtureEmbedder(): EmbeddingProvider {
  return {
    model: FIXTURE_MODEL,
    dim: FIXTURE_DIM,
    maxInputTokens: FIXTURE_MAX_INPUT_TOKENS,
    embed: async (texts) => texts.map(fixtureVector),
  };
}

/** README §2.4: `max(1, (max_input_tokens ?? 512) − 16)`. */
export function docTokenBudget(provider: EmbeddingProvider): number {
  return Math.max(1, (provider.maxInputTokens ?? 512) - 16);
}

// ---- fixture shapes ------------------------------------------------------------

export interface SanitizeCase {
  name: string;
  notes?: string;
  input: string;
  expect: string;
}

export interface CosineCase {
  name: string;
  notes?: string;
  a: number[];
  b: number[];
  expect: number;
}

export type SearchQuery = { text?: string; semantic?: string; limit?: number };
export type ResolveQuery = { query: string; semantic?: string; limit?: number };
export type Step = StoreStep | { drain: true } | { search: SearchQuery } | { resolve: ResolveQuery };

export interface DrainOutcome {
  embedded: number;
  cached: number;
  doc_embedded: number;
  doc_cached: number;
  doc_pooled: number;
}
export interface TextHitRow {
  block_id: string;
  doc_id: string;
  path: string;
  type: string;
  text: string;
  score: number;
}
export interface VectorHitRow {
  block_id: string;
  doc_id: string;
  path: string;
  cosine: number;
}
export interface Evidence {
  fts_rank?: number;
  vector_rank?: number;
  cosine?: number;
  rrf: number;
  boosts: Record<string, number>;
}
export interface HybridHitRow {
  block_id: string;
  doc_id: string;
  path: string;
  score: number;
  evidence: Evidence;
}
export interface ResolveHitRow {
  id: string;
  locator: string;
  preview: string;
  evidence: Evidence;
}
export type SearchOutcome =
  | { hits: TextHitRow[]; truncated: boolean }
  | { hits: VectorHitRow[] }
  | { hits: HybridHitRow[] };
export type ResolveOutcome = { hits: ResolveHitRow[] };
export type StepOutcome = StoreStepOutcome | DrainOutcome | SearchOutcome | ResolveOutcome;

export interface EmbedTaskRow {
  block_id: string;
  content_hash: string;
  ctx: string;
}
export interface DocTaskRow {
  doc_id: string;
  /** the §2.4 header line (the input's first line), so a header mismatch is diagnosable */
  header: string;
  input_hash: string;
  method_if_embedded: "whole" | "pooled";
  blocks: { content_hash: string; tokens: number }[];
}
export interface EmbeddingRow {
  content_hash: string;
  ctx_hash: string;
  model: string;
  dim: number;
  vec: number[];
}
export interface DocEmbeddingRow {
  doc_id: string;
  model: string;
  input_hash: string;
  method: string;
  dim: number;
  vec: number[];
}

export interface Projection {
  steps: StepOutcome[];
  embed_tasks: EmbedTaskRow[];
  doc_tasks: DocTaskRow[];
  embeddings: EmbeddingRow[];
  doc_embeddings: DocEmbeddingRow[];
}

/** The projected tables, in the order the fixture emits them (README §7). */
export const PROJECTED_TABLES = ["embed_tasks", "doc_tasks", "embeddings", "doc_embeddings"] as const;

export interface ObserveCase {
  name: string;
  notes?: string;
  /** optional spec/reconcile §6 overrides, as spec/store §9.4 */
  config?: FixtureConfig;
  steps: Step[];
  expect: Projection;
}

export type FixtureCase = SanitizeCase | CosineCase | ObserveCase;

export interface FixtureFile {
  suite: string;
  cases: FixtureCase[];
}

export type CaseKind = "sanitize" | "cosine" | "observe";

/** The three case shapes, told apart by the file stem (README §7). */
export function suiteKind(suite: string): CaseKind {
  if (suite === "sanitize") return "sanitize";
  if (suite === "cosine") return "cosine";
  return "observe";
}

export const CASE_KEYS: Record<CaseKind, readonly string[]> = {
  sanitize: ["name", "notes", "input", "expect"],
  cosine: ["name", "notes", "a", "b", "expect"],
  observe: ["name", "notes", "config", "steps", "expect"],
};

// ---- helpers ------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Bytewise (UTF-8) string order. */
export function cmpBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function hex(b: Buffer): string {
  return b.toString("hex");
}

/** A stored little-endian float32 BLOB as the numbers it holds (each exactly a float32 value). */
function blobToNumbers(b: Buffer): number[] {
  return Array.from(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)));
}

// ---- pure cases (README §7) ----------------------------------------------------------

export function runSanitizeCase(c: Omit<SanitizeCase, "expect">): string {
  return sanitizeFtsQuery(c.input);
}

/** §3: both vectors are rounded to float32 first (the stored representation). */
export function runCosineCase(c: Omit<CosineCase, "expect">): number {
  return cosineFloat32(Float32Array.from(c.a), Float32Array.from(c.b));
}

// ---- observation scripts (README §7) -----------------------------------------------------

export type ObserveCaseInput = Omit<ObserveCase, "expect">;

export interface Evaluation {
  expect: Projection;
  /** runner-check problems (empty = fine). */
  problems: string[];
}

function evidenceOf(e: HybridHit["evidence"]): Evidence {
  const out: Evidence = { rrf: e.rrf, boosts: {} };
  if (e.ftsRank !== undefined) out.fts_rank = e.ftsRank;
  if (e.vectorRank !== undefined) out.vector_rank = e.vectorRank;
  if (e.cosine !== undefined) out.cosine = e.cosine;
  // Only the boosts that applied are present (README §4); `recency` is never set.
  for (const k of ["title", "heading", "path", "layer", "recency"] as const) {
    const v = e.boosts[k];
    if (v !== undefined) out.boosts[k] = v;
  }
  return out;
}

/**
 * Run a case: fresh `:memory:` store under the fixture minter (repo `rp_0`,
 * slug `fixture`) with the fixture embedder as the provider; every step through
 * the production paths, then the §7 projection and checks after the last step.
 */
export async function runObserveCase(c: ObserveCaseInput): Promise<Evaluation> {
  const config = toReconcileConfig(c.config);
  const provider = fixtureEmbedder();
  // The minter is process-global and `withIdMinter` restores it when its body
  // *returns* — too early for an async body — so install it for the whole case
  // (cases run sequentially, never interleaved) and restore in `finally`.
  setIdMinter(sequentialMinter());
  const store = new Store({ path: ":memory:" });
  try {
    const repoId = ensureRepo(store, FIXTURE_REPO_SLUG, null);
    const worker = new EmbeddingWorker(store, provider);
    const steps: StepOutcome[] = [];
    for (const step of c.steps) {
      if ("observe" in step) {
        const items = step.observe.items.map((it) => ({ path: it.path, content: it.source }));
        steps.push(observeBatch(store, repoId, items, step.observe.ts, { config }).map(toOutcome));
      } else if ("sweep" in step) {
        steps.push({ swept: sweepResurrectionPool(store, step.sweep.ts) });
      } else if ("drain" in step) {
        // README §2.6: the block pass, then the document pass, in one drain.
        const blocks = await worker.process(buildEmbedTasks(store, repoId));
        const docs = await worker.processDocs(buildDocEmbedTasks(store, repoId));
        steps.push({ embedded: blocks.embedded, cached: blocks.cached, doc_embedded: docs.embedded, doc_cached: docs.cached, doc_pooled: docs.pooled });
      } else if ("search" in step) {
        steps.push(await runSearch(store, repoId, provider, step.search));
      } else {
        steps.push(await runResolve(store, repoId, provider, step.resolve));
      }
    }
    const projected: Projection = { steps, ...projectSearch(store, repoId, provider) };
    return { expect: projected, problems: checkSearch(store, provider, projected) };
  } finally {
    store.close();
    setIdMinter(null);
  }
}

/** The query embedded bare with the fixture embedder (§2.3 `embedQuery`), as the float32 vector the engine searches with. */
async function queryVector(provider: EmbeddingProvider, phrase: string): Promise<Float32Array> {
  const [v] = await provider.embed([phrase]);
  return Float32Array.from(v!);
}

async function runSearch(store: Store, repoId: string, provider: EmbeddingProvider, q: SearchQuery): Promise<SearchOutcome> {
  const limit = q.limit;
  if (q.text !== undefined && q.semantic === undefined) {
    const r = textSearch(store, repoId, q.text, limit !== undefined ? { limit } : {});
    return {
      hits: r.hits.map((h) => ({ block_id: h.blockId, doc_id: h.docId, path: h.path, type: h.type, text: h.text, score: h.score })),
      truncated: r.truncated,
    };
  }
  const vec = await queryVector(provider, q.semantic!);
  if (q.text === undefined) {
    const hits = vectorSearch(store, repoId, provider.model, vec, limit !== undefined ? { limit } : {});
    return { hits: hits.map((h) => ({ block_id: h.blockId, doc_id: h.docId, path: h.path, cosine: h.cosine })) };
  }
  const hits = hybridSearch(store, { repoId, text: q.text, vector: { model: provider.model, vec }, ...(limit !== undefined ? { limit } : {}) });
  return { hits: hits.map((h) => ({ block_id: h.blockId, doc_id: h.docId, path: h.path, score: h.score, evidence: evidenceOf(h.evidence) })) };
}

async function runResolve(store: Store, repoId: string, provider: EmbeddingProvider, q: ResolveQuery): Promise<ResolveOutcome> {
  const hits = resolveSearch(store, {
    repoId,
    query: q.query,
    ...(q.semantic !== undefined ? { vector: { model: provider.model, vec: await queryVector(provider, q.semantic) } } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
  });
  return { hits: hits.map((h) => ({ id: h.id, locator: h.locator, preview: h.preview, evidence: evidenceOf(h.evidence as HybridHit["evidence"]) })) };
}

// ---- projection (README §7) -----------------------------------------------------------

/** The §7 projection after the last step. */
export function projectSearch(store: Store, repoId: string, provider: EmbeddingProvider): Omit<Projection, "steps"> {
  // `(path, ordinal)` is the reference's order; nested blocks share ordinals
  // with top-level ones, so ties are broken by block_id (bytewise) to make the
  // projection deterministic. Only equal-ordinal neighbours ever move.
  const ordinalOf = new Map(
    (store.db.prepare("SELECT b.block_id, d.path, b.ordinal FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.repo_id = ?").all(repoId) as { block_id: string; path: string; ordinal: number }[])
      .map((r) => [r.block_id, r] as const),
  );
  const embed_tasks = buildEmbedTasks(store, repoId)
    .map((t): EmbedTaskRow => ({ block_id: t.blockId, content_hash: t.contentHashHex, ctx: t.ctx }))
    .sort((a, b) => {
      const x = ordinalOf.get(a.block_id)!;
      const y = ordinalOf.get(b.block_id)!;
      return cmpBytes(x.path, y.path) || x.ordinal - y.ordinal || cmpBytes(a.block_id, b.block_id);
    });

  const budget = docTokenBudget(provider);
  const doc_tasks = buildDocEmbedTasks(store, repoId).map((t): DocTaskRow => ({
    doc_id: t.docId,
    header: t.input.slice(0, t.input.indexOf("\n")),
    input_hash: hex(sha256(t.input)),
    method_if_embedded: estimateTokens(t.input) <= budget ? "whole" : "pooled",
    blocks: t.blocks.map((b) => ({ content_hash: b.contentHashHex, tokens: b.tokens })),
  }));

  const embeddings = (store.db
    .prepare("SELECT content_hash, ctx_hash, model, dim, vec FROM embeddings")
    .all() as { content_hash: Buffer; ctx_hash: Buffer; model: string; dim: number; vec: Buffer }[])
    .map((r): EmbeddingRow => ({ content_hash: hex(r.content_hash), ctx_hash: hex(r.ctx_hash), model: r.model, dim: r.dim, vec: blobToNumbers(r.vec) }))
    .sort((a, b) => cmpBytes(a.content_hash, b.content_hash) || cmpBytes(a.ctx_hash, b.ctx_hash) || cmpBytes(a.model, b.model));

  const doc_embeddings = (store.db
    .prepare("SELECT doc_id, model, input_hash, method, dim, vec FROM doc_embeddings")
    .all() as { doc_id: string; model: string; input_hash: Buffer; method: string; dim: number; vec: Buffer }[])
    .map((r): DocEmbeddingRow => ({ doc_id: r.doc_id, model: r.model, input_hash: hex(r.input_hash), method: r.method, dim: r.dim, vec: blobToNumbers(r.vec) }))
    .sort((a, b) => cmpBytes(a.doc_id, b.doc_id) || cmpBytes(a.model, b.model));

  return { embed_tasks, doc_tasks, embeddings, doc_embeddings };
}

// ---- runner checks -----------------------------------------------------------------------

/**
 * Checks a runner applies after the last step:
 *  - every vector row has `dim` = the provider's dim and `|vec| = dim × 4` bytes;
 *  - every row was written under the fixture model (a drain never writes
 *    another model's rows);
 *  - `doc_embeddings.method` is `whole` or `pooled`;
 *  - an `embeddings` row is a unit vector or all zeros (the provider and the
 *    pooling both normalize), within float32 slack.
 */
export function checkSearch(store: Store, provider: EmbeddingProvider, projected: Omit<Projection, "steps">): string[] {
  const problems: string[] = [];
  const blobLen = (table: string, where: string, args: (string | Buffer)[]): number =>
    (store.db.prepare(`SELECT length(vec) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n;
  for (const r of projected.embeddings) {
    const at = `embeddings ${r.content_hash.slice(0, 12)}/${r.ctx_hash.slice(0, 12)}`;
    if (r.model !== provider.model) problems.push(`${at}: model ${r.model} is not the fixture model`);
    if (r.dim !== provider.dim) problems.push(`${at}: dim ${r.dim} != ${provider.dim}`);
    const n = blobLen("embeddings", "content_hash = ? AND ctx_hash = ? AND model = ?", [Buffer.from(r.content_hash, "hex"), Buffer.from(r.ctx_hash, "hex"), r.model]);
    if (n !== r.dim * 4) problems.push(`${at}: vec is ${n} bytes, expected ${r.dim * 4}`);
    const norm = Math.sqrt(r.vec.reduce((s, x) => s + x * x, 0));
    if (norm !== 0 && Math.abs(norm - 1) > 1e-6) problems.push(`${at}: vec norm ${norm} is neither 0 nor 1`);
  }
  for (const r of projected.doc_embeddings) {
    const at = `doc_embeddings ${r.doc_id}`;
    if (r.model !== provider.model) problems.push(`${at}: model ${r.model} is not the fixture model`);
    if (r.dim !== provider.dim) problems.push(`${at}: dim ${r.dim} != ${provider.dim}`);
    if (r.method !== "whole" && r.method !== "pooled") problems.push(`${at}: method ${r.method}`);
    const n = blobLen("doc_embeddings", "doc_id = ? AND model = ?", [r.doc_id, r.model]);
    if (n !== r.dim * 4) problems.push(`${at}: vec is ${n} bytes, expected ${r.dim * 4}`);
    const norm = Math.sqrt(r.vec.reduce((s, x) => s + x * x, 0));
    if (norm !== 0 && Math.abs(norm - 1) > 1e-6) problems.push(`${at}: vec norm ${norm} is neither 0 nor 1`);
  }
  return problems;
}

// ---- comparison (README §7 tolerances) -------------------------------------------------------

/** bm25 scores (text-search hits) compare within 1e-6; everything else within 1e-9. */
export const EPS_BM25 = 1e-6;
export const EPS = 1e-9;

/** Vectors compare after float32 rounding (a fixture may print them as f32 or as the f64 value of the f32). */
function froundVecs(p: unknown): unknown {
  if (!isRecord(p)) return p;
  const round = (rows: unknown): unknown =>
    Array.isArray(rows) ? rows.map((r) => (isRecord(r) && Array.isArray(r.vec) ? { ...r, vec: r.vec.map((x) => (typeof x === "number" ? Math.fround(x) : x)) } : r)) : rows;
  return { ...p, embeddings: round(p.embeddings), doc_embeddings: round(p.doc_embeddings) };
}

/**
 * Compare an evaluated projection to a committed `expect`; null when equal
 * within the §7 tolerances, else the first difference (a path + values).
 */
export function compareExpect(actual: Projection, expected: unknown): string | null {
  if (!isRecord(expected)) return "$: expect is not an object";
  const a = froundVecs(actual) as Record<string, unknown>;
  const e = froundVecs(expected) as Record<string, unknown>;
  const ka = Object.keys(a).sort();
  const ke = Object.keys(e).sort();
  if (ka.length !== ke.length || ka.some((k, i) => k !== ke[i])) return `$: keys {${ka.join(",")}} vs {${ke.join(",")}}`;
  // Steps: a text-search outcome (the one with `truncated`) carries bm25 scores.
  const sa = a.steps;
  const se = e.steps;
  if (!Array.isArray(sa) || !Array.isArray(se)) return "$.steps: not arrays";
  if (sa.length !== se.length) return `$.steps: length ${sa.length} vs ${se.length}`;
  for (let i = 0; i < sa.length; i++) {
    const isText = isRecord(sa[i]) && "truncated" in (sa[i] as Record<string, unknown>);
    const d = deepEqualTol(sa[i], se[i], isText ? EPS_BM25 : EPS, `$.steps[${i}]`);
    if (d) return d;
  }
  for (const k of PROJECTED_TABLES) {
    const d = deepEqualTol(a[k], e[k], EPS, `$.${k}`);
    if (d) return d;
  }
  return null;
}

// ---- validation ------------------------------------------------------------------------

export interface ValidateOptions {
  /** false while regenerating: cases may not have an `expect` yet */
  requireExpect?: boolean;
}

const optPosInt = (v: unknown): boolean => v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 1);

/** The two search-spec steps (README §7) plus `resolve` (§4). */
export const EXTRA_STEPS = {
  drain: (body: unknown, here: string, problems: string[]): void => {
    if (body !== true) problems.push(`${here}: \`drain\` is exactly \`true\``);
  },
  search: (body: unknown, here: string, problems: string[]): void => {
    if (!isRecord(body)) {
      problems.push(`${here}: \`search\` is an object`);
      return;
    }
    if (Object.keys(body).some((k) => !["text", "semantic", "limit"].includes(k))) problems.push(`${here}: search takes \`text\`, \`semantic\`, \`limit\``);
    if (body.text === undefined && body.semantic === undefined) problems.push(`${here}: search needs \`text\` and/or \`semantic\``);
    if (body.text !== undefined && typeof body.text !== "string") problems.push(`${here}: \`text\` must be a string`);
    if (body.semantic !== undefined && typeof body.semantic !== "string") problems.push(`${here}: \`semantic\` must be a string`);
    if (!optPosInt(body.limit)) problems.push(`${here}: \`limit\` must be a positive integer`);
  },
  resolve: (body: unknown, here: string, problems: string[]): void => {
    if (!isRecord(body)) {
      problems.push(`${here}: \`resolve\` is an object`);
      return;
    }
    if (Object.keys(body).some((k) => !["query", "semantic", "limit"].includes(k))) problems.push(`${here}: resolve takes \`query\`, \`semantic\`, \`limit\``);
    if (typeof body.query !== "string") problems.push(`${here}: \`query\` must be a string`);
    if (body.semantic !== undefined && typeof body.semantic !== "string") problems.push(`${here}: \`semantic\` must be a string`);
    if (!optPosInt(body.limit)) problems.push(`${here}: \`limit\` must be a positive integer`);
  },
};

function isFloatArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

function validateProjection(at: string, e: unknown, stepCount: number, problems: string[]): void {
  if (!isRecord(e)) {
    problems.push(`${at}: must be an object`);
    return;
  }
  const want = ["steps", ...PROJECTED_TABLES];
  const keys = Object.keys(e).sort();
  const wantSorted = [...want].sort();
  if (keys.length !== wantSorted.length || keys.some((k, i) => k !== wantSorted[i])) {
    problems.push(`${at}: must have exactly the keys ${want.join(", ")} (got ${keys.join(", ")})`);
    return;
  }
  for (const k of want) if (!Array.isArray(e[k])) problems.push(`${at}.${k}: must be an array`);
  if (Array.isArray(e.steps) && stepCount >= 0 && e.steps.length !== stepCount) problems.push(`${at}.steps: ${e.steps.length} outcomes for ${stepCount} steps`);
  for (const table of ["embeddings", "doc_embeddings"] as const) {
    if (!Array.isArray(e[table])) continue;
    (e[table] as unknown[]).forEach((r, i) => {
      if (!isRecord(r) || !isFloatArray(r.vec) || r.vec.length !== FIXTURE_DIM) problems.push(`${at}.${table}[${i}]: vec must be ${FIXTURE_DIM} finite numbers`);
    });
  }
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
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) return [...problems, `${file}: \`cases\` must be a non-empty array`];
  const kind = suiteKind(stem);

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
    if (kind === "sanitize") {
      if (typeof c.input !== "string") problems.push(`${at}: \`input\` must be a string`);
    } else if (kind === "cosine") {
      if (!isFloatArray(c.a) || !isFloatArray(c.b)) problems.push(`${at}: \`a\` and \`b\` must be arrays of finite numbers`);
    } else {
      if (c.config !== undefined && !isRecord(c.config)) problems.push(`${at}: \`config\` must be an object`);
      stepCount = validateSteps(at, c.steps, problems, EXTRA_STEPS);
    }

    if (c.expect === undefined) {
      if (requireExpect) problems.push(`${at}: missing \`expect\` (run SEARCH_SPEC_UPDATE=1)`);
      return;
    }
    if (kind === "sanitize") {
      if (typeof c.expect !== "string") problems.push(`${at}.expect: must be a string`);
    } else if (kind === "cosine") {
      if (typeof c.expect !== "number" || !Number.isFinite(c.expect)) problems.push(`${at}.expect: must be a finite number`);
    } else {
      validateProjection(`${at}.expect`, c.expect, stepCount, problems);
    }
  });
  return problems;
}
