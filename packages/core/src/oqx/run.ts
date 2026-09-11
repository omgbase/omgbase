// OQX runner (slice 1). Mirrors search/query.ts: assembles one SELECT from the
// compiled Query, applies a total order on (path, id) for stable keyset cursors,
// limit+1 truncation, and lean projected hits. collect(...) columns arrive as
// JSON text and are parsed into arrays.

import type { Store } from "../core/store/store.js";
import { parseOqx } from "./parser.js";
import { lowerQuery } from "./lower.js";
import { compileQuery } from "./compile.js";
import { FilterInvalid } from "../search/cel/parser.js";
import type { CelTarget } from "./ir.js";

export interface OqxHit {
  id: string;
  path: string;
  [k: string]: unknown;
}

export interface OqxResult {
  hits: OqxHit[];
  truncated: boolean;
  cursor: string | null;
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
  const limit = opts.limit ?? 50;
  const idCol = ID_COL[q.target];

  const cols = [`${idCol} AS id`, `d.path AS path`];
  const params: unknown[] = [];
  for (const p of compiled.projections) {
    cols.push(p.sql); // already `<expr> AS "name"`
    params.push(...p.params);
  }
  // whereParams follow projection params in statement order.
  params.push(...compiled.whereParams);

  let cursorClause = "";
  if (opts.cursor) {
    const { path: cp, id: ci } = decodeCursor(opts.cursor);
    cursorClause = ` AND (d.path > ? OR (d.path = ? AND ${idCol} > ?))`;
    params.push(cp, cp, ci);
  }

  const sql = `SELECT ${cols.join(", ")} FROM ${compiled.from} WHERE ${compiled.where}${cursorClause} ORDER BY d.path ASC, ${idCol} ASC LIMIT ?`;
  params.push(limit + 1);

  const rows = store.db.prepare(sql).all(...params) as Record<string, unknown>[];
  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const cursor = truncated && last ? encodeCursor(String(last.path), String(last.id)) : null;

  const hits: OqxHit[] = page.map((r) => {
    const hit: OqxHit = { id: String(r.id), path: String(r.path) };
    for (const p of compiled.projections) {
      let val = r[p.name];
      // JSON columns (collect arrays, lifted collections, first/single records)
      // arrive as text.
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
  });

  return { hits, truncated, cursor };
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
