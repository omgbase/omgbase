// The rule catalog. Each rule states its precondition and the argument that the
// rewritten plan is indistinguishable from the scan it replaces — same rows in
// the same order, same lifts, same error (same message) at the same point, or
// no error — under SEMANTICS §13's strict left-to-right `&&`.

import type { Expr, Where } from "../ast.ts";
import {
  exprRaiseFree, exprReadsCurrentScope, exprReadsScopeIn, localPath, opHasLifts, opReadsScopeIn,
  whereHasLifts, whereRaiseFree,
} from "./analysis.ts";
import type { Correlation, Rule, RuleContext } from "./ir.ts";
import { conjunction, conjuncts } from "./ir.ts";

// ---- rule 1: correlated equality → hash probe ------------------------------------
//
// Precondition. The block has no `from` re-projection (its rows ARE the
// receiver's rows) and no `follow`; its `where` has no lift anywhere (a lift
// into an enclosing scope by one row could change what the outer side reads
// for the next row); some top-level conjunct k is `local == outer` (either
// side) with `local` an identifier/member chain on the block's row and `outer`
// a raise-free expression reading nothing from the block's row; and every
// conjunct left of k is raise-free (no call, no `single`, no lift, no bound, no
// binding past the run's count).
//
// Argument. The scan evaluates, per receiver row r in order, c1(r) && … &&
// ck(r) && …, short-circuiting. The probe selects exactly the rows with
// local(r) == outer (the index reproduces §5 equality, `outer` is evaluated
// once because nothing in the block can change what it reads) and evaluates the
// residual conjunction over them, in receiver order. For a selected row every
// conjunct is evaluated as the scan would (ck is dropped: it is true by
// construction and, being two reads, cannot raise or bind). For a row the probe
// rejects, the scan would have evaluated c1..c(k-1) — which cannot raise or
// bind — then ck, false, and stopped: no result, no error, no lift. So the two
// paths keep the same rows, raise the same first error, and bind the same
// lifts. A probe that cannot be built at run time (a receiver that is not
// stable, an index whose construction throws) falls back to the scan itself.

export const correlatedEqualityProbe: Rule = (plan, ctx) => {
  if (plan.correlated.length > 0 || plan.from.length > 0 || plan.follow || !plan.where) return null;
  if (whereHasLifts(plan.where)) return null;
  const correlated: Correlation[] = [];
  const residual: Where[] = [];
  let prefixRaiseFree = true;
  conjuncts(plan.where).forEach((part, index) => {
    const eq = prefixRaiseFree ? asCorrelation(part, index, ctx) : null;
    if (eq) correlated.push(eq);
    else {
      residual.push(part);
      prefixRaiseFree &&= whereRaiseFree(part, ctx);
    }
  });
  if (correlated.length === 0) return null;
  return { ...plan, correlated, residual: conjunction(residual) };
};

/** `local == outer` / `outer == local` as a correlation, else null. */
function asCorrelation(w: Where, index: number, ctx: RuleContext): Correlation | null {
  if (w.kind !== "scalar" || w.expr.kind !== "binary" || w.expr.op !== "==") return null;
  const { left, right } = w.expr;
  return pair(left, right, index, ctx) ?? pair(right, left, index, ctx);
}

function pair(local: Expr, outer: Expr, index: number, ctx: RuleContext): Correlation | null {
  const path = localPath(local);
  if (path === null) return null;
  if (exprReadsCurrentScope(outer) || !exprRaiseFree(outer, ctx)) return null;
  return { local, outer, path, index };
}

// ---- rule 1b: a receiver stable across enclosing rows ----------------------------
//
// Precondition. The receiver expression, read in the enclosing scope (depth
// `plan.depth`), reads no scope at depth 1..depth: only the root (named roots,
// `^…^name` reaching it, or past it) and bindings.
//
// Argument. Such an expression yields the same value for every enclosing row
// (evaluation is pure; the root and the bindings do not change within a run),
// so its rows can be materialized once per run and indexed once per path. A
// receiver that does read an enclosing row is still indexable when it happens
// to evaluate to the same object twice (the engine keys indexes by collection
// identity as well); a receiver that yields a fresh value per row is scanned.

export const stableReceiver: Rule = (plan) => {
  if (plan.receiverStable) return null;
  if (exprReadsScopeIn(plan.receiver, plan.depth, plan.depth)) return null;
  return { ...plan, receiverStable: true };
};

// ---- rule 2: invariant nested block → evaluate once per run ----------------------
//
// Precondition. Nothing in the block — receiver, `from`, `where`, `select`,
// `order by`, bound, `follow` — reads a scope at depth 1..depth (an enclosing
// row), and the block lifts nothing (a lift is a side effect on an enclosing
// scope that must recur per row).
//
// Argument. The block's value is a function of the root scope, the bindings
// and its own rows only, all constant within a run, so every evaluation yields
// the same value or raises the same error. The engine evaluates it the first
// time the scan would (so an error surfaces at the same point) and returns the
// memoized value afterwards; a run that raised never reaches a second
// evaluation. The memoized value is shared by reference across the enclosing
// rows that project it.

export const invariantBlock: Rule = (plan) => {
  if (plan.invariant) return null;
  if (opHasLifts(plan.node)) return null;
  if (opReadsScopeIn(plan.node, plan.depth, plan.depth)) return null;
  return { ...plan, invariant: true };
};

// ---- rule 3: exists / none / count from cardinality -------------------------------
//
// Precondition. A where-position `exists`, `none` or `count` without `distinct`
// (dedup projects every row), without `order by` (`count` evaluates the keys),
// without `follow`, and with nothing left to evaluate per row: either the block
// has no `where`, or every conjunct is correlated (so the probe's bucket is the
// matched set).
//
// Argument. With no residual predicate the matched rows are exactly the
// accessed rows (§13: the receiver's rows filtered by `where`), entering a row
// as a scope cannot raise, and the consumers only need the count after the
// bound (§18): `count` is `boundedCount(n)`, `exists` is `boundedCount(n) > 0`,
// `none` its negation — what the scan computes after materializing. When the
// probe is unavailable at run time the residual is the whole `where` and the
// engine takes the per-row path.

export const cardinalityOnly: Rule = (plan) => {
  if (plan.fromCardinality) return null;
  if (plan.consumer !== "exists" && plan.consumer !== "none" && plan.consumer !== "count") return null;
  if (plan.distinct || plan.orderBy || plan.follow) return null;
  if (plan.where !== null && plan.residual !== null) return null;
  return { ...plan, fromCardinality: true };
};

/** The rules the engine applies by default, in order. */
export const DEFAULT_RULES: readonly Rule[] = [correlatedEqualityProbe, stableReceiver, invariantBlock, cardinalityOnly];
