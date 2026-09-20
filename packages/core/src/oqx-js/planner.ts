// Tier-3 pushdown planner (ADR-013). Reduces the row set a query scans by
// translating its pushable top-level `where` conjuncts into ONE SQL statement
// against the store, then handing the produced rows (+ the untranslatable
// residual) back to the in-memory engine to finish. Correctness is guaranteed by
// the residual fallback — anything `translate.ts` declines stays in-memory — and
// verified by the differential conformance suite (planned == in-memory).
//
// This is deliberately conservative: only simple top-level target scans (no
// `follow`, no source re-projection) with at least one pushable scalar conjunct
// are planned; everything else declines to a full in-memory run.

import type { Query, Expr, QueryPlanner, Plan, DataContext } from "@omgbase/oqx";
import { ROWS_ROOT, partitionPushable, residualQuery } from "@omgbase/oqx";
import type { Store } from "../core/store/store.js";
import { makeStoreContext, tagRows, type StoreContextOptions } from "./context.js";
import { translatePredicate, type Target, type TranslateCtx } from "./sql/translate.js";

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
