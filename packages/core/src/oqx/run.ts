// OQX runner. Mirrors search/query.ts: assembles one SELECT from the compiled
// Query, applies a total order on (path, id) for stable keyset cursors, limit+1
// truncation, and lean projected hits. collect(...) columns arrive as JSON text
// and are parsed into arrays. The top-level consumer (default `collect`) shapes
// the result: `count`/`exists` reduce the query to a scalar (no projections, no
// pagination); `first`/`single` return zero-or-one hit (`single` errors on >1).

import type { Store } from "../core/store/store.js";
import { docsRead } from "../core/read/document.js";
import { parseOqx } from "./parser.js";
import { lowerQuery } from "./lower.js";
import { compileQuery, type CompiledQuery } from "./compile.js";
import { FilterInvalid } from "../search/cel/parser.js";
import type { SemanticResolver, SemanticVec } from "../search/cel/compile.js";
import { float32ToBlob } from "../core/vec.js";
import type { CelTarget, OqxConsumer } from "./ir.js";

/** Embeds a query phrase to a vector + model — the runner's provider hook for
 * `semantic("phrase")`. Async and provider-specific; supplied by the caller
 * (MCP/CLI), never by the query language itself (which stays provider-free). */
export type EmbedQuery = (text: string) => Promise<{ model: string; vec: Float32Array }>;

export interface OqxHit {
  id: string;
  path: string;
  [k: string]: unknown;
}

export interface OqxResult {
  hits: OqxHit[];
  truncated: boolean;
  cursor: string | null;
  /** how the query was consumed/shaped; `collect` unless `repo.<op>(…)` wrapped it. */
  consumer: OqxConsumer;
  /** scalar reduction — present only for its consumer (`count` / `exists`). */
  count?: number;
  exists?: boolean;
}

export interface OqxOptions {
  limit?: number;
  cursor?: string | null;
  /** Pre-computed query vectors for `semantic("phrase")`, keyed by phrase. The
   * async `oqxRunAsync` fills this (embedding the literals); the sync core stays
   * provider-free. A `semantic(...)` with no entry here is a loud error. */
  semanticVectors?: Map<string, SemanticVec>;
}

const ID_COL: Record<CelTarget, string> = {
  docs: "d.doc_id",
  blocks: "b.block_id",
  nodes: "n.node_id",
};

export function oqxRun(store: Store, repoId: string, source: string, opts: OqxOptions = {}): OqxResult {
  const q = lowerQuery(parseOqx(source));
  const semantic: SemanticResolver | undefined = opts.semanticVectors
    ? (phrase) => opts.semanticVectors!.get(phrase)
    : undefined;
  const compiled = compileQuery(q, repoId, semantic);
  const idCol = ID_COL[q.target];

  // Scalar reductions ignore projections and pagination entirely: they answer a
  // single question about the outer row set. Only whereParams are bound.
  if (q.consumer === "count") {
    const row = store.db
      .prepare(`SELECT COUNT(*) AS n FROM ${compiled.from} WHERE ${compiled.where}`)
      .get(...compiled.whereParams) as { n: number };
    return { hits: [], truncated: false, cursor: null, consumer: "count", count: row.n };
  }
  if (q.consumer === "exists") {
    const row = store.db
      .prepare(`SELECT EXISTS(SELECT 1 FROM ${compiled.from} WHERE ${compiled.where}) AS e`)
      .get(...compiled.whereParams) as { e: number };
    return { hits: [], truncated: false, cursor: null, consumer: "exists", exists: row.e === 1 };
  }

  // collect / first / single all project rows. `first`/`single` are single-shot
  // (LIMIT 1 / capped at 2, no cursor); `collect` paginates with limit+1.
  const cap = q.consumer === "first" ? 1 : q.consumer === "single" ? 2 : (opts.limit ?? 50);

  const cols = [`${idCol} AS id`, `d.path AS path`];
  const params: unknown[] = [];
  for (const p of compiled.projections) {
    cols.push(p.sql); // already `<expr> AS "name"`
    params.push(...p.params);
  }
  // whereParams follow projection params in statement order.
  params.push(...compiled.whereParams);

  // A custom `order by` reorders the result off (path, id), so the keyset cursor
  // (which resumes by path,id) no longer matches — pagination is disabled for
  // ordered queries (you get the top `limit`, `truncated` still tells you there
  // is more). first/single never paginate.
  let cursorClause = "";
  if (q.consumer === "collect" && !compiled.orderBy && opts.cursor) {
    const { path: cp, id: ci } = decodeCursor(opts.cursor);
    cursorClause = ` AND (d.path > ? OR (d.path = ? AND ${idCol} > ?))`;
    params.push(cp, cp, ci);
  }

  // User order terms sort first; (path, id) always breaks ties to keep a total,
  // deterministic order. Order params sit textually between WHERE/cursor and
  // LIMIT, so they bind here — after the cursor params, before `fetch`.
  const orderPrefix = compiled.orderBy ? `${compiled.orderBy.sql}, ` : "";
  if (compiled.orderBy) params.push(...compiled.orderBy.params);

  // collect fetches limit+1 to detect truncation; first/single fetch exactly cap.
  const fetch = q.consumer === "collect" ? cap + 1 : cap;
  const sql = `SELECT ${cols.join(", ")} FROM ${compiled.from} WHERE ${compiled.where}${cursorClause} ORDER BY ${orderPrefix}d.path ASC, ${idCol} ASC LIMIT ?`;
  params.push(fetch);

  const rows = store.db.prepare(sql).all(...params) as Record<string, unknown>[];

  if (q.consumer === "single" && rows.length > 1) {
    throw new FilterInvalid("single(...) matched more than one row; use first(...) for zero-or-one", "OQX §2");
  }

  if (q.consumer !== "collect") {
    const hits = rows.map((r) => rowToHit(r, compiled, store));
    return { hits, truncated: false, cursor: null, consumer: q.consumer };
  }

  const truncated = rows.length > cap;
  const page = rows.slice(0, cap);
  const last = page[page.length - 1];
  // No keyset cursor for a custom-ordered result (see above): report truncation
  // but no resumable cursor.
  const cursor = truncated && last && !compiled.orderBy ? encodeCursor(String(last.path), String(last.id)) : null;
  const hits = page.map((r) => rowToHit(r, compiled, store));
  return { hits, truncated, cursor, consumer: "collect" };
}

// A sentinel binding used only to DISCOVER which phrases a query embeds: a
// recording compile pass (collectSemanticPhrases) hands this back for every
// semantic("…") so compilation succeeds and records the phrase; the SQL it
// produces is thrown away.
const RECORD_SENTINEL: SemanticVec = { vec: Buffer.alloc(0), model: "" };

// Distinct phrases referenced by `semantic("…")` in a query, found by compiling
// once with a recording resolver (the compiler already visits every scalar, so
// this reuses the real traversal instead of a bespoke AST walk). repoId is
// irrelevant here — the compiled SQL is discarded.
export function collectSemanticPhrases(source: string): string[] {
  const q = lowerQuery(parseOqx(source));
  const phrases = new Set<string>();
  const rec: SemanticResolver = (p) => { phrases.add(p); return RECORD_SENTINEL; };
  compileQuery(q, "rp_record", rec);
  return [...phrases];
}

// Async entry point: embed any `semantic("…")` phrases (provider-specific, so
// async) into query vectors, then run the sync core with them pre-resolved.
// Queries with no semantic() go straight to the sync path. Keeping the core
// synchronous means every existing caller/test is untouched.
export async function oqxRunAsync(
  store: Store, repoId: string, source: string, opts: OqxOptions = {}, embedQuery?: EmbedQuery,
): Promise<OqxResult> {
  const phrases = collectSemanticPhrases(source);
  if (phrases.length === 0) return oqxRun(store, repoId, source, opts);
  if (!embedQuery) {
    throw new FilterInvalid("semantic(...) needs an embedding provider; none is configured", "OQX semantic");
  }
  const semanticVectors = new Map<string, SemanticVec>();
  for (const phrase of phrases) {
    const { model, vec } = await embedQuery(phrase);
    semanticVectors.set(phrase, { model, vec: float32ToBlob(vec) });
  }
  return oqxRun(store, repoId, source, { ...opts, semanticVectors });
}

// Map a projected SQL row to a lean hit: parse JSON columns (collect arrays,
// lifted collections, first/single records), unwrap+check `single` columns, and
// fill a docs `$body` projection from the reconstructed document (docsRead).
function rowToHit(r: Record<string, unknown>, compiled: CompiledQuery, store: Store): OqxHit {
  const hit: OqxHit = { id: String(r.id), path: String(r.path) };
  for (const p of compiled.projections) {
    // docs `$body`: not a SQL column — reconstruct the file per hit.
    if (p.docBody) {
      hit[p.name] = docsRead(store, hit.id)?.content ?? null;
      continue;
    }
    let val = r[p.name];
    if (p.isJson && typeof val === "string") {
      val = JSON.parse(val) as unknown;
    }
    // `single` returns a capped array; enforce ≤1 and unwrap to the record.
    if (p.unwrapSingle) {
      const arr = Array.isArray(val) ? val : [];
      if (arr.length > 1) {
        throw new FilterInvalid(`single(...) for '${p.name}' matched ${arr.length} rows`, "OQX §2");
      }
      val = arr.length === 1 ? arr[0] : null;
    }
    hit[p.name] = val ?? null;
  }
  return hit;
}

function encodeCursor(path: string, id: string): string {
  return Buffer.from(JSON.stringify([path, id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { path: string; id: string } {
  try {
    const [path, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [string, string];
    return { path, id };
  } catch {
    throw new FilterInvalid("invalid cursor", "OQX §3");
  }
}

export { parseOqx };
