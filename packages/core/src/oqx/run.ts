// OQX runner. Mirrors search/query.ts: assembles one SELECT from the compiled
// Query, applies a total order on (path, id) for stable keyset cursors, limit+1
// truncation, and lean projected hits. collect(...) columns arrive as JSON text
// and are parsed into arrays. The top-level consumer (default `collect`) shapes
// the result: `count`/`exists` reduce the query to a scalar (no projections, no
// pagination); `first`/`single` return zero-or-one hit (`single` errors on >1).

import type { Store } from "../core/store/store.js";
import { parseOqx } from "./parser.js";
import { lowerQuery } from "./lower.js";
import { compileQuery, type CompiledQuery } from "./compile.js";
import { FilterInvalid } from "../search/cel/parser.js";
import type { CelTarget, OqxConsumer } from "./ir.js";

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
}

const ID_COL: Record<CelTarget, string> = {
  docs: "d.doc_id",
  blocks: "b.block_id",
  nodes: "n.node_id",
};

export function oqxRun(store: Store, repoId: string, source: string, opts: OqxOptions = {}): OqxResult {
  const q = lowerQuery(parseOqx(source));
  const compiled = compileQuery(q, repoId);
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

  let cursorClause = "";
  if (q.consumer === "collect" && opts.cursor) {
    const { path: cp, id: ci } = decodeCursor(opts.cursor);
    cursorClause = ` AND (d.path > ? OR (d.path = ? AND ${idCol} > ?))`;
    params.push(cp, cp, ci);
  }

  // collect fetches limit+1 to detect truncation; first/single fetch exactly cap.
  const fetch = q.consumer === "collect" ? cap + 1 : cap;
  const sql = `SELECT ${cols.join(", ")} FROM ${compiled.from} WHERE ${compiled.where}${cursorClause} ORDER BY d.path ASC, ${idCol} ASC LIMIT ?`;
  params.push(fetch);

  const rows = store.db.prepare(sql).all(...params) as Record<string, unknown>[];

  if (q.consumer === "single" && rows.length > 1) {
    throw new FilterInvalid("single(...) matched more than one row; use first(...) for zero-or-one", "OQX §2");
  }

  if (q.consumer !== "collect") {
    const hits = rows.map((r) => rowToHit(r, compiled));
    return { hits, truncated: false, cursor: null, consumer: q.consumer };
  }

  const truncated = rows.length > cap;
  const page = rows.slice(0, cap);
  const last = page[page.length - 1];
  const cursor = truncated && last ? encodeCursor(String(last.path), String(last.id)) : null;
  const hits = page.map((r) => rowToHit(r, compiled));
  return { hits, truncated, cursor, consumer: "collect" };
}

// Map a projected SQL row to a lean hit: parse JSON columns (collect arrays,
// lifted collections, first/single records) and unwrap+check `single` columns.
function rowToHit(r: Record<string, unknown>, compiled: CompiledQuery): OqxHit {
  const hit: OqxHit = { id: String(r.id), path: String(r.path) };
  for (const p of compiled.projections) {
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
