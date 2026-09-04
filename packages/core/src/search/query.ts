import type { Store } from "../core/store/store.js";
import { parseFilter, FilterInvalid } from "./cel/parser.js";
import { compile, type Target } from "./cel/compile.js";

// query tool (10-query-language; 07 task 1.7). Compiles a CEL filter to indexed
// SQL over documents|blocks, intersects with optional text (FTS5), applies
// order + limit + cursor. Returns lean projected hits (ids/paths); callers
// hydrate by id.

export interface QueryEnvelope {
  from: Target;
  filter?: string;
  text?: string;
  select?: string[];
  order?: string[];
  limit?: number;
  cursor?: string | null;
}

export interface QueryHit {
  id: string;
  path: string;
  [k: string]: unknown;
}

export interface QueryResult {
  hits: QueryHit[];
  truncated: boolean;
  cursor: string | null;
}

const ORDERABLE_INTRINSIC: Record<string, string> = {
  "$path": "path",
  "$id": "id",
  "$ordinal": "ordinal",
};

export function query(store: Store, repoId: string, env: QueryEnvelope): QueryResult {
  const target = env.from;
  if (target !== "documents" && target !== "blocks") {
    throw new FilterInvalid(`'from' must be 'documents' or 'blocks'`, "10 §1");
  }
  const limit = env.limit ?? 50;

  const where: string[] = [];
  const params: unknown[] = [];

  if (target === "documents") {
    where.push("d.repo_id = ?", "d.deleted_commit IS NULL");
    params.push(repoId);
  } else {
    where.push("b.repo_id = ?", "b.deleted_commit IS NULL");
    params.push(repoId);
  }

  if (env.filter && env.filter.trim().length > 0) {
    const ast = parseFilter(env.filter);
    const compiled = compile(ast, target);
    where.push(compiled.sql);
    params.push(...compiled.params);
  }

  if (env.text && env.text.trim().length > 0) {
    if (target === "blocks") {
      where.push("b.rowid IN (SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?)");
    } else {
      where.push("d.doc_id IN (SELECT b2.doc_id FROM blocks_fts JOIN blocks b2 ON b2.rowid = blocks_fts.rowid WHERE blocks_fts MATCH ?)");
    }
    params.push(env.text);
  }

  // ordering: total order for stable cursors (ties break by id asc — 10 §7).
  const orderCols = buildOrder(env.order, target);

  const base =
    target === "documents"
      ? `SELECT d.doc_id AS id, d.path AS path, d.path AS ordId FROM documents d`
      : `SELECT b.block_id AS id, d.path AS path, b.block_id AS ordId, b.ordinal AS ordinal
         FROM blocks b JOIN documents d ON d.doc_id = b.doc_id`;

  // Cursor: composite keyset on (path, id) matching the default order. The
  // opaque cursor encodes the last emitted row's path and id; the keyset
  // predicate `(path > p) OR (path = p AND id > i)` resumes exactly after it.
  // Custom `order` clauses use the same (path,id) tiebreak, so this stays valid.
  const idCol = target === "documents" ? "d.doc_id" : "b.block_id";
  let cursorClause = "";
  if (env.cursor) {
    const { path: cp, id: ci } = decodeCursor(env.cursor);
    cursorClause = ` AND (d.path > ? OR (d.path = ? AND ${idCol} > ?))`;
    params.push(cp, cp, ci);
  }

  const sql = `${base} WHERE ${where.join(" AND ")}${cursorClause} ORDER BY ${orderCols} LIMIT ?`;
  const runParams = [...params, limit + 1];

  const rows = store.db.prepare(sql).all(...runParams) as { id: string; path: string }[];
  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const cursor = truncated && last ? encodeCursor(last.path, last.id) : null;

  const hits: QueryHit[] = page.map((r) => ({ id: r.id, path: r.path }));
  return { hits, truncated, cursor };
}

function buildOrder(order: string[] | undefined, target: Target): string {
  const idCol = target === "documents" ? "d.doc_id" : "b.block_id";
  // Default: path asc, id asc. A total order on (path, id) keeps the keyset
  // cursor valid (§7). Explicit `order` fields sort first; (path, id) always
  // breaks ties so the cursor predicate remains correct.
  const prefix = target === "documents"
    ? `d.path`
    : `d.path`; // path column is `d.path` for both targets in the SELECT/JOIN
  const parts: string[] = [];
  for (const spec of order ?? []) {
    const desc = spec.startsWith("-");
    const name = desc ? spec.slice(1) : spec;
    const col = ORDERABLE_INTRINSIC[name];
    if (!col) throw new FilterInvalid(`cannot order by '${name}'`, "10 §7");
    const sqlCol = col === "path" ? "d.path" : col === "id" ? idCol : `b.${col}`;
    parts.push(`${sqlCol} ${desc ? "DESC" : "ASC"}`);
  }
  parts.push(`${prefix} ASC`, `${idCol} ASC`);
  return parts.join(", ");
}

function encodeCursor(path: string, id: string): string {
  return Buffer.from(JSON.stringify([path, id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { path: string; id: string } {
  try {
    const [path, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [string, string];
    return { path, id };
  } catch {
    throw new FilterInvalid("invalid cursor", "10 §7");
  }
}

export { FilterInvalid };
