// omgbase's OQX entry point, served by `@omgbase/oqx`: parse the source, run it
// through the in-memory engine over a store-backed DataContext (context.ts), and
// shape the engine's result into omgbase's OqxResult (lean {id, path, …} hits,
// keyset pagination, count/exists scalars). Same signature + shape as the former
// in-tree compiler, so every caller and the corpus are unchanged.

import { parse, PlannedEngine, InMemoryEngine, OqxError } from "@omgbase/oqx";
import type { Engine } from "@omgbase/oqx";
import type { Query, Expr, Where, OpNode, SelectItem, Subquery, Follow } from "@omgbase/oqx";
import { makeStoreContext, type StoreContextOptions } from "./context.js";
import { SQLiteQueryPlanner } from "./planner.js";
import type { Store } from "../core/store/store.js";
import { FilterInvalid } from "../search/cel/parser.js";
import type { SemanticVec } from "../search/cel/compile.js";
import { float32ToBlob } from "../core/vec.js";

export type OqxConsumer = "collect" | "count" | "exists" | "first" | "single";

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
  consumer: OqxConsumer;
  count?: number;
  exists?: boolean;
}

export interface OqxOptions {
  limit?: number;
  cursor?: string | null;
  semanticVectors?: Map<string, SemanticVec>;
  /** Force the pure in-memory engine (skip tier-3 pushdown). Internal — used by
   * the differential conformance suite to prove planned == in-memory. */
  plan?: boolean;
}

// Row-scoped domain functions: authored as free calls (`text("x")`) that
// implicitly reference the current row. `@omgbase/oqx` free functions receive no
// row, so we rewrite them to `$self.fn(…)` (a method whose receiver is the row).
const ROW_FNS = new Set([
  "text", "semantic", "under", "under_heading", "within", "under_kind",
  "yaml_path", "json_pointer", "has_edge", "has_anchor", "child_count", "parent_type",
]);

const selfRef: Expr = { kind: "ident", name: "$self" };

function rewriteExpr(e: Expr): Expr {
  switch (e.kind) {
    case "member": return { ...e, recv: rewriteExpr(e.recv) };
    case "index": return { ...e, recv: rewriteExpr(e.recv), index: rewriteExpr(e.index) };
    case "unary": return { ...e, expr: rewriteExpr(e.expr) };
    case "binary": case "logical": case "in":
      return { ...e, left: rewriteExpr(e.left), right: rewriteExpr(e.right) };
    case "range":
      return { ...e, lo: e.lo ? rewriteExpr(e.lo) : null, hi: e.hi ? rewriteExpr(e.hi) : null };
    case "call": {
      const recv = e.recv ? rewriteExpr(e.recv) : null;
      const args = e.args.map(rewriteExpr);
      if (recv === null && ROW_FNS.has(e.name)) return { kind: "call", recv: selfRef, name: e.name, args };
      return { kind: "call", recv, name: e.name, args };
    }
    default: return e; // lit, ident, outer, binding
  }
}

function rewriteWhere(w: Where): Where {
  switch (w.kind) {
    case "and": return { kind: "and", parts: w.parts.map(rewriteWhere) };
    case "or": return { kind: "or", parts: w.parts.map(rewriteWhere) };
    case "not": return { kind: "not", expr: rewriteWhere(w.expr) };
    case "scalar": return { kind: "scalar", expr: rewriteExpr(w.expr) };
    case "op": return rewriteOp(w);
  }
}

function rewriteOp(op: OpNode): OpNode {
  return { ...op, receiver: rewriteExpr(op.receiver), sub: rewriteSub(op.sub) };
}
function rewriteFollow(f: Follow): Follow {
  return {
    ...f,
    receiver: rewriteExpr(f.receiver),
    where: f.where ? rewriteExpr(f.where) : null,
    frontier: f.frontier ? rewriteExpr(f.frontier) : null,
    by: f.by ? rewriteExpr(f.by) : null,
  };
}
function rewriteSelect(items: SelectItem[]): SelectItem[] {
  return items.map((it) => it.kind === "field" ? { ...it, expr: rewriteExpr(it.expr) } : { ...it, op: rewriteOp(it.op) });
}
function rewriteSub(s: Subquery): Subquery {
  return {
    from: s.from.map(rewriteExpr),
    where: s.where ? rewriteWhere(s.where) : null,
    select: rewriteSelect(s.select),
    orderBy: s.orderBy ? s.orderBy.map((o) => ({ ...o, expr: rewriteExpr(o.expr) })) : null,
    follow: s.follow ? rewriteFollow(s.follow) : null,
  };
}
function rewriteQuery(q: Query): Query {
  return {
    source: rewriteExpr(q.source),
    from: q.from.map(rewriteExpr),
    where: q.where ? rewriteWhere(q.where) : null,
    select: rewriteSelect(q.select),
    orderBy: q.orderBy ? q.orderBy.map((o) => ({ ...o, expr: rewriteExpr(o.expr) })) : null,
    consumer: q.consumer,
    follow: q.follow ? rewriteFollow(q.follow) : null,
    ...(q.distinct ? { distinct: true } : {}),
  };
}

// Distinct phrases referenced by `semantic("…")` (free calls in the raw parse).
export function collectSemanticPhrases(source: string): string[] {
  const phrases = new Set<string>();
  const visitExpr = (e: Expr): void => {
    switch (e.kind) {
      case "call":
        if (e.recv === null && e.name === "semantic" && e.args[0]?.kind === "lit" && typeof e.args[0].value === "string") {
          phrases.add(e.args[0].value);
        }
        if (e.recv) visitExpr(e.recv);
        e.args.forEach(visitExpr);
        return;
      case "member": visitExpr(e.recv); return;
      case "index": visitExpr(e.recv); visitExpr(e.index); return;
      case "unary": visitExpr(e.expr); return;
      case "binary": case "logical": case "in": visitExpr(e.left); visitExpr(e.right); return;
      case "range": if (e.lo) visitExpr(e.lo); if (e.hi) visitExpr(e.hi); return;
      default: return;
    }
  };
  const visitWhere = (w: Where): void => {
    switch (w.kind) {
      case "and": case "or": w.parts.forEach(visitWhere); return;
      case "not": visitWhere(w.expr); return;
      case "scalar": visitExpr(w.expr); return;
      case "op": visitOp(w); return;
    }
  };
  const visitOp = (op: OpNode): void => { visitExpr(op.receiver); visitSub(op.sub); };
  const visitSub = (s: Subquery): void => {
    s.from.forEach(visitExpr);
    if (s.where) visitWhere(s.where);
    s.select.forEach((it) => it.kind === "field" ? visitExpr(it.expr) : visitOp(it.op));
    if (s.orderBy) s.orderBy.forEach((o) => visitExpr(o.expr));
    if (s.follow) { visitExpr(s.follow.receiver); [s.follow.where, s.follow.frontier, s.follow.by].forEach((x) => x && visitExpr(x)); }
  };
  let q: Query;
  try { q = parse(source); } catch { return []; }
  visitExpr(q.source);
  q.from.forEach(visitExpr);
  if (q.where) visitWhere(q.where);
  q.select.forEach((it) => it.kind === "field" ? visitExpr(it.expr) : visitOp(it.op));
  if (q.orderBy) q.orderBy.forEach((o) => visitExpr(o.expr));
  if (q.follow) { visitExpr(q.follow.receiver); [q.follow.where, q.follow.frontier, q.follow.by].forEach((x) => x && visitExpr(x)); }
  return [...phrases];
}

const ID_ITEM: SelectItem = { kind: "field", name: "__oqx_id", expr: { kind: "ident", name: "$id" }, lift: 0 };
const PATH_ITEM: SelectItem = { kind: "field", name: "__oqx_path", expr: { kind: "ident", name: "$path" }, lift: 0 };

function toHit(row: unknown): OqxHit {
  const o = row as Record<string, unknown>;
  const { __oqx_id, __oqx_path, ...rest } = o;
  return { id: String(__oqx_id), path: String(__oqx_path ?? ""), ...rest };
}

// Top-level `select distinct`: dedup hits by their USER projection (every field
// except the injected id/path), keeping the first (so the retained hit carries a
// real id/path). Order-preserving.
function dedupHitsByProjection(hits: OqxHit[]): OqxHit[] {
  const seen = new Set<string>();
  const out: OqxHit[] = [];
  for (const h of hits) {
    const { id: _id, path: _path, ...proj } = h;
    void _id; void _path;
    const key = JSON.stringify(Object.keys(proj).sort().map((k) => [k, proj[k]]));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

export function oqxRun(store: Store, repoId: string, source: string, opts: OqxOptions = {}): OqxResult {
  try {
    return oqxRunInner(store, repoId, source, opts);
  } catch (e) {
    // Normalize the library's errors to omgbase's contract (filter_invalid).
    if (e instanceof OqxError) throw new FilterInvalid(e.message, "OQX");
    throw e;
  }
}

function oqxRunInner(store: Store, repoId: string, source: string, opts: OqxOptions): OqxResult {
  const parsed = rewriteQuery(parse(source));
  const consumer = parsed.consumer as OqxConsumer;
  const ctxOpts: StoreContextOptions = opts.semanticVectors ? { semanticVectors: opts.semanticVectors } : {};
  const ctx = makeStoreContext(store, repoId, ctxOpts);
  // Tier-3 pushdown reduces the scan in SQL; the in-memory fallback finishes the
  // residual (and runs anything not pushable), so results match a pure scan.
  const engine: Engine = opts.plan === false
    ? new InMemoryEngine(ctx)
    : new PlannedEngine(new SQLiteQueryPlanner(store, repoId, ctxOpts), ctx);

  if (consumer === "exists") {
    const res = engine.run(parsed, []);
    return { hits: [], truncated: false, cursor: null, consumer: "exists", exists: res.consumer === "exists" ? res.exists : false };
  }
  if (consumer === "count") {
    const res = engine.run(parsed, []);
    return { hits: [], truncated: false, cursor: null, consumer: "count", count: res.consumer === "count" ? res.count : 0 };
  }

  // collect / first / single: inject id + path so every hit carries them. A
  // top-level `select distinct` is applied HERE, not in the engine: the injected
  // id/path are unique per row and would defeat the engine's projection dedup, so
  // we run without engine-distinct and dedup hits by their USER projection below,
  // keeping the first row's id/path.
  const topDistinct = !!parsed.distinct;
  const q: Query = { ...parsed, distinct: false, select: [ID_ITEM, PATH_ITEM, ...parsed.select] };
  const res = engine.run(q, []);

  if (consumer === "first" || consumer === "single") {
    const row = res.consumer === "first" || res.consumer === "single" ? res.row : null;
    return { hits: row == null ? [] : [toHit(row)], truncated: false, cursor: null, consumer };
  }

  // collect: keyset pagination on (path, id) when the order is the default.
  let rows = (res.consumer === "collect" ? res.rows : []).map(toHit);
  if (topDistinct) rows = dedupHitsByProjection(rows);
  const custom = !!parsed.orderBy && parsed.orderBy.length > 0;
  const cap = opts.limit ?? 50;
  let page = rows;
  if (!custom && opts.cursor) {
    const { path, id } = decodeCursor(opts.cursor);
    page = page.filter((h) => h.path > path || (h.path === path && h.id > id));
  }
  const truncated = page.length > cap;
  page = page.slice(0, cap);
  const last = page[page.length - 1];
  const cursor = truncated && last && !custom ? encodeCursor(last.path, last.id) : null;
  return { hits: page, truncated, cursor, consumer: "collect" };
}

export async function oqxRunAsync(
  store: Store, repoId: string, source: string, opts: OqxOptions = {}, embedQuery?: EmbedQuery,
): Promise<OqxResult> {
  const phrases = collectSemanticPhrases(source);
  if (phrases.length === 0) return oqxRun(store, repoId, source, opts);
  if (!embedQuery) throw new FilterInvalid("semantic(...) needs an embedding provider; none is configured", "OQX semantic");
  const semanticVectors = new Map<string, SemanticVec>();
  for (const phrase of phrases) {
    const { model, vec } = await embedQuery(phrase);
    semanticVectors.set(phrase, { model, vec: float32ToBlob(vec) });
  }
  return oqxRun(store, repoId, source, { ...opts, semanticVectors });
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

/** Parse an OQX source into the `@omgbase/oqx` AST (re-exported for callers). */
export function parseOqx(source: string): Query {
  return parse(source);
}
