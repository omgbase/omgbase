// Tier-3 pushdown planner (ADR-013). Reduces the row set a query scans by
// translating its pushable top-level `where` conjuncts into ONE SQL statement
// against the store, then handing the produced rows (+ the untranslatable
// residual) back to the in-memory engine to finish. Correctness is guaranteed by
// the residual fallback — anything `translate.ts` declines stays in-memory — and
// verified by the differential conformance suite (planned == in-memory).
//
// This is deliberately conservative: only simple top-level target scans (no
// `follow`, no source re-projection) with at least one pushable scalar conjunct
// are planned; everything else declines to a full in-memory run. One more
// decline keeps the planned path invisible (spec/surface §1 decline (c)): a
// pushed conjunct that empties the scan would also hide an OQX eval error a
// residual conjunct raises in memory (`path == "x" && $path == "nope.md"` was
// `[]` planned, `filter_invalid` in memory), so when any residual conjunct could
// raise — a function or method call, a `single` block, a `^`-escaped name, or a
// bare reserved docs basename — the WHOLE query runs unplanned.

import type { Query, Expr, Where, OpNode, Subquery, Follow, QueryPlanner, Plan, DataContext } from "@omgbase/oqx";
import { ROWS_ROOT, partitionPushable, residualQuery } from "@omgbase/oqx";
import type { Store } from "../core/store/store.js";
import { makeStoreContext, tagRows, type StoreContextOptions } from "./context.js";
import { translatePredicate, RESERVED_DOC_BASENAMES, type Target, type TranslateCtx } from "./sql/translate.js";

const ALIAS: Record<Target, { self: string; doc: string }> = {
  docs: { self: "d", doc: "d" },
  blocks: { self: "b", doc: "d" },
  nodes: { self: "n", doc: "d" },
  edges: { self: "e", doc: "d" },
};
const FROM: Record<Target, string> = {
  docs: "docs d",
  blocks: "blocks b JOIN docs d ON d.doc_id = b.doc_id",
  nodes: "nodes n JOIN docs d ON d.doc_id = n.doc_id",
  edges: "edges e JOIN docs d ON d.doc_id = e.src_doc",
};
// Row columns + the owning-doc path as __path (matches the context roots so
// produced rows are indistinguishable from a full scan's).
const COLS: Record<Target, string> = {
  docs: "d.*",
  blocks: "b.*, d.path AS __path",
  nodes: "n.*, d.path AS __path",
  edges: "e.*, d.path AS __path",
};
const ORDER: Record<Target, string> = {
  docs: "d.path, d.doc_id",
  blocks: "d.path, b.block_id",
  nodes: "d.path, n.node_id",
  edges: "d.path, e.edge_id",
};
function guards(target: Target, repoId: string): { sql: string; params: unknown[] } {
  switch (target) {
    case "docs": return { sql: "d.repo_id = ? AND d.deleted_commit IS NULL", params: [repoId] };
    case "blocks": return { sql: "b.repo_id = ? AND b.deleted_commit IS NULL AND d.deleted_commit IS NULL", params: [repoId] };
    case "nodes": return { sql: "n.repo_id = ? AND d.deleted_commit IS NULL", params: [repoId] };
    case "edges": return { sql: "e.repo_id = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL", params: [repoId] };
  }
}

// The root collection a query scans, if it is a bare `docs|blocks|nodes|edges`
// or `$repo.<target>` source (else null — not a pushable shape).
function rootTarget(source: Expr): Target | null {
  const TARGETS = new Set<Target>(["docs", "blocks", "nodes", "edges"]);
  if (source.kind === "ident" && TARGETS.has(source.name as Target)) return source.name as Target;
  if (source.kind === "member" && source.recv.kind === "ident" && source.recv.name === "$repo" && TARGETS.has(source.name as Target)) {
    return source.name as Target;
  }
  return null;
}

// ---- the residual walk (decline (c)) -----------------------------------------

/**
 * True when evaluating `where` in memory could raise an OQX error the pushed
 * conjuncts might hide by emptying the scan. The walk is generic over the whole
 * residual tree — every `Where` node, every nested block (its `from`, `where`,
 * `select`, `order by`, `follow`, `limit`/`offset`) and every `Expr` — and flags:
 *
 *   • any `call` node (a function or method: unknown name, bad regex, wrong target…)
 *   • any nested block whose consumer is `single` (raises on 0 or >1 rows)
 *   • any `^`-escaped name: an `outer` reference or a `^name:` lift
 *   • a bare reserved docs basename (`id path updated_at content_hash body`): as
 *     an `ident` at the ROOT scope when the target is `docs`, or as `doc.<name>`
 *     on any target at any depth (the reach-through row is a doc)
 *
 * A residual made only of comparisons, logical operators, `in`/ranges, `!`,
 * literals, bindings and plain reads (including exists/none/count/collect/first
 * blocks of the same) cannot raise, so the pushed conjuncts are kept.
 */
export function residualMayRaise(where: Where | null, target: Target): boolean {
  return where !== null && whereMayRaise(where, target, true);
}

function whereMayRaise(w: Where, target: Target, root: boolean): boolean {
  switch (w.kind) {
    case "and": case "or": return w.parts.some((p) => whereMayRaise(p, target, root));
    case "not": return whereMayRaise(w.expr, target, root);
    case "scalar": return exprMayRaise(w.expr, target, root);
    case "op": return opMayRaise(w, target, root);
  }
}

function opMayRaise(op: OpNode, target: Target, root: boolean): boolean {
  if (op.op === "single") return true;
  return exprMayRaise(op.receiver, target, root) || subMayRaise(op.sub, target);
}

// Inside a block the rows are a different scope (a relation's rows), so a bare
// reserved name is an ordinary read there — only `doc.<reserved>` still raises.
function subMayRaise(s: Subquery, target: Target): boolean {
  if (s.from.some((e) => exprMayRaise(e, target, false))) return true;
  if (s.where && whereMayRaise(s.where, target, false)) return true;
  for (const item of s.select) {
    if (item.kind === "field") {
      if (item.lift > 0 || exprMayRaise(item.expr, target, false)) return true;
    } else if (opMayRaise(item.op, target, false)) return true;
  }
  if (s.orderBy?.some((o) => exprMayRaise(o.expr, target, false))) return true;
  if (s.follow && followMayRaise(s.follow, target)) return true;
  if (s.limit && exprMayRaise(s.limit, target, false)) return true;
  if (s.offset && exprMayRaise(s.offset, target, false)) return true;
  return false;
}

function followMayRaise(f: Follow, target: Target): boolean {
  return [f.receiver, f.where, f.frontier, f.by].some((e) => e !== null && exprMayRaise(e, target, false));
}

function exprMayRaise(e: Expr, target: Target, root: boolean): boolean {
  switch (e.kind) {
    case "call": return true;
    case "outer": return true;
    case "ident": return root && target === "docs" && RESERVED_DOC_BASENAMES.has(e.name);
    case "member":
      if (e.recv.kind === "ident" && e.recv.name === "doc" && RESERVED_DOC_BASENAMES.has(e.name)) return true;
      return exprMayRaise(e.recv, target, root);
    case "index": return exprMayRaise(e.recv, target, root) || exprMayRaise(e.index, target, root);
    case "unary": return exprMayRaise(e.expr, target, root);
    case "binary": case "logical": case "in":
      return exprMayRaise(e.left, target, root) || exprMayRaise(e.right, target, root);
    case "range":
      return (e.lo !== null && exprMayRaise(e.lo, target, root)) || (e.hi !== null && exprMayRaise(e.hi, target, root));
    case "lit": case "binding": return false;
  }
}

// ---- the planner -------------------------------------------------------------

export class SQLiteQueryPlanner implements QueryPlanner {
  constructor(private store: Store, private repoId: string, private ctxOpts: StoreContextOptions = {}) {}

  plan(query: Query, params: readonly unknown[]): Plan | null {
    // Only simple top-level scans: no follow, no `from E` re-projection.
    if (query.follow || query.from.length > 0) return null;
    const target = rootTarget(query.source);
    if (!target) return null;

    const ctx: TranslateCtx = { target, self: ALIAS[target].self, doc: ALIAS[target].doc, params };
    const { pushed, residual } = partitionPushable(query.where, (e) => translatePredicate(e, ctx) !== null);
    if (pushed.length === 0) return null; // nothing to push — let the engine do it all
    if (residualMayRaise(residual, target)) return null; // decline (c): run unplanned

    const frags = pushed.map((e) => translatePredicate(e, ctx)!);
    const g = guards(target, this.repoId);
    const whereSql = [g.sql, ...frags.map((f) => `(${f.sql})`)].join(" AND ");
    const sqlParams = [...g.params, ...frags.flatMap((f) => f.params)];
    const sql = `SELECT ${COLS[target]} FROM ${FROM[target]} WHERE ${whereSql} ORDER BY ${ORDER[target]}`;
    const rows = tagRows(this.store.db.prepare(sql).all(...sqlParams) as Record<string, unknown>[], target);

    // The residual scans ROWS_ROOT; give it a store context that resolves those
    // produced rows (relations/intrinsics/domain fns still hit the store).
    const context: DataContext = makeStoreContext(this.store, this.repoId, { ...this.ctxOpts, rowsRoot: { name: ROWS_ROOT, rows } });
    return { rows: () => rows, residual: residualQuery(query, residual), context };
  }
}
