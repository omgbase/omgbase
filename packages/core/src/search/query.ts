import type { Store } from "../core/store/store.js";
import { parseFilter, FilterInvalid } from "./cel/parser.js";
import { compile, type Target } from "./cel/compile.js";
import { hybridSearch } from "./rrf.js";

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
  /**
   * A pre-computed query vector for semantic retrieval. The query language is
   * clock-free and provider-free (10 §3.1); callers that want semantic search
   * embed the query string with their configured provider and pass the vector
   * here. When present, results are hybrid-ranked (FTS ⊕ vector) via RRF.
   */
  vector?: { model: string; vec: Float32Array };
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
  if (target !== "documents" && target !== "blocks" && target !== "nodes") {
    throw new FilterInvalid(`'from' must be 'documents', 'blocks', or 'nodes'`, "10 §1");
  }

  const limit = env.limit ?? 50;
  if (target === "nodes") return queryNodes(store, repoId, env, limit);

  // Semantic path: a query vector fuses FTS + vector rankings (RRF) at block
  // grain. An optional CEL filter narrows the fused candidates to the block ids
  // that also match structurally, so `--semantic` composes with `filter`.
  if (env.vector) {
    const hits = hybridSearch(store, {
      repoId,
      ...(env.text ? { text: env.text } : {}),
      vector: env.vector,
      limit: limit + 1 + (env.filter ? limit * 4 : 0),
    });
    let blockIds = hits.map((h) => h.blockId);
    if (env.filter && env.filter.trim().length > 0) {
      const allowed = filterBlockIds(store, repoId, env.filter, blockIds);
      blockIds = blockIds.filter((id) => allowed.has(id));
    }
    const pathById = new Map(hits.map((h) => [h.blockId, h.path]));
    const page = blockIds.slice(0, limit);
    return {
      hits: page.map((id) => ({ id, path: pathById.get(id) ?? "" })),
      truncated: blockIds.length > limit,
      cursor: null,
    };
  }

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

// Which of the given block ids satisfy a CEL filter (blocks target). Used by the
// semantic path to intersect vector/FTS candidates with a structural filter.
function filterBlockIds(store: Store, repoId: string, filter: string, blockIds: string[]): Set<string> {
  if (blockIds.length === 0) return new Set();
  const compiled = compile(parseFilter(filter), "blocks");
  const placeholders = blockIds.map(() => "?").join(",");
  const sql = `SELECT b.block_id AS id
     FROM blocks b JOIN documents d ON d.doc_id = b.doc_id
     WHERE b.repo_id = ? AND b.deleted_commit IS NULL AND b.block_id IN (${placeholders}) AND ${compiled.sql}`;
  const rows = store.db.prepare(sql).all(repoId, ...blockIds, ...compiled.params) as { id: string }[];
  return new Set(rows.map((r) => r.id));
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

function queryNodes(store: Store, repoId: string, env: QueryEnvelope, limit: number): QueryResult {
  const where: string[] = ["n.repo_id = ?"];
  const params: unknown[] = [repoId];

  if (env.filter && env.filter.trim().length > 0) {
    const ast = parseFilter(env.filter);
    const compiled = compile(ast, "nodes");
    where.push(compiled.sql);
    params.push(...compiled.params);
  }

  if (env.text && env.text.trim().length > 0) {
    where.push("n.rowid IN (SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?)");
    params.push(env.text);
  }

  const base = `SELECT n.node_id AS id, d.path AS path, n.kind AS kind, n.name AS name, n.value AS value
     FROM nodes n JOIN documents d ON d.doc_id = n.doc_id`;

  const idCol = "n.node_id";
  let cursorClause = "";
  if (env.cursor) {
    const { path: cp, id: ci } = decodeCursor(env.cursor);
    cursorClause = ` AND (d.path > ? OR (d.path = ? AND ${idCol} > ?))`;
    params.push(cp, cp, ci);
  }

  const sql = `${base} WHERE ${where.join(" AND ")}${cursorClause} ORDER BY d.path ASC, ${idCol} ASC LIMIT ?`;
  const rows = store.db.prepare(sql).all(...params, limit + 1) as { id: string; path: string; kind: string; name: string | null; value: string | null }[];
  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const cursor = truncated && last ? encodeCursor(last.path, last.id) : null;

  const hits: QueryHit[] = page.map((r) => ({
    id: r.id,
    path: r.path,
    kind: r.kind,
    ...(r.name !== null ? { name: r.name } : {}),
    ...(r.value !== null ? { value: r.value } : {}),
  }));
  return { hits, truncated, cursor };
}

export { FilterInvalid };
