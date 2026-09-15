// Pushdown analysis helpers shared by planner adapters (tier 3). The unit of
// pushdown here is the top-level `where` conjunction: an adapter classifies each
// AND-conjunct as pushable (translatable into its native query) or residual
// (must be evaluated in-memory afterward). Whatever it pushes reduces the rows it
// produces; the residual Query re-runs over those rows in the in-memory engine,
// which preserves correctness even for partial pushdown.
//
// Deliberately conservative: only positive scalar leaves are pushable. Consumer
// ops (exists/count/collect), negation, and disjunction stay residual — an
// adapter that wants to push those can special-case them itself.

import type { Query, Where, Expr } from "./ast.ts";

/** The synthetic root name the residual query scans — the rows a plan produced. */
export const ROWS_ROOT = "__oqx_rows__";

/** Split a top-level where into pushable scalar conjuncts and a residual tree. */
export function partitionPushable(
  where: Where | null,
  canPush: (e: Expr) => boolean,
): { pushed: Expr[]; residual: Where | null } {
  if (!where) return { pushed: [], residual: null };
  const parts = where.kind === "and" ? where.parts : [where];
  const pushed: Expr[] = [];
  const rest: Where[] = [];
  for (const p of parts) {
    if (p.kind === "scalar" && canPush(p.expr)) pushed.push(p.expr);
    else rest.push(p);
  }
  const residual: Where | null = rest.length === 0 ? null : rest.length === 1 ? rest[0]! : { kind: "and", parts: rest };
  return { pushed, residual };
}

/** Rebuild a query to run in-memory over a plan's produced rows: scan the rows
 * root, drop pushed top-level `from`/predicates, keep projection/order/consumer. */
export function residualQuery(query: Query, residualWhere: Where | null): Query {
  return { ...query, source: { kind: "ident", name: ROWS_ROOT }, from: [], where: residualWhere };
}

/** A literal or binding — a value known without a row context. */
export function isConst(e: Expr): boolean {
  return e.kind === "lit" || e.kind === "binding";
}

/** Evaluate a constant expression against the query bindings. */
export function constValue(e: Expr, params: readonly unknown[]): unknown {
  if (e.kind === "lit") return e.value;
  if (e.kind === "binding") return params[e.index];
  throw new Error("constValue: not a constant expression");
}

/** Recognize `field == const` / `const == field` (field is a bare row column). */
export function asEquality(e: Expr): { field: string; value: Expr } | null {
  if (e.kind !== "binary" || e.op !== "==") return null;
  if (e.left.kind === "ident" && isConst(e.right)) return { field: e.left.name, value: e.right };
  if (e.right.kind === "ident" && isConst(e.left)) return { field: e.right.name, value: e.left };
  return null;
}
