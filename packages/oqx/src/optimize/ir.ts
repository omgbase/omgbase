// The optimizer's logical representation of one nested block (an `OpNode`):
// where its rows come from, which predicates correlate them with the enclosing
// rows, what remains to be checked per row, how they are shaped, and how the
// consumer reduces them. Rules rewrite a `BlockPlan`; the engine executes it.
//
// A plan starts as a faithful transcription of the AST (`logicalBlock`): every
// predicate residual, nothing correlated, nothing memoized. Rules move work
// from the per-row path into the per-run or per-probe path only when the
// semantics argument in `rules.ts` holds; the engine's fallbacks (an index that
// cannot be built, a receiver that is not stable) always degrade to the plain
// scan the plan started from.

import type { Consumer, Expr, Follow, OpNode, OrderSpec, SelectItem, Where } from "../ast.ts";

/** One hoisted equality `local == outer` from the block's top-level `&&`
 * conjunction: `local` reads only the block's row (an identifier or member
 * chain; `path` is its property path, `[]` for `$it`), `outer` reads nothing
 * from the block's row (outer references, bindings, literals, arithmetic over
 * them) and cannot raise. */
export interface Correlation {
  readonly local: Expr;
  readonly outer: Expr;
  readonly path: readonly string[];
  /** Position of the equality among `conjuncts(where)`, so a probe that
   * answers ONE correlation (a store-backed `lookupRows`) can put the others
   * back in their place as residual conjuncts. */
  readonly index: number;
}

/** The plan for one block. `receiver`/`from`/`projection`/`orderBy`/`bound`/
 * `consumer`/`follow`/`distinct` transcribe the AST; `correlated`/`residual`
 * split its `where`; `receiverStable`, `invariant` and `fromCardinality` are the
 * annotations rules add. */
export interface BlockPlan {
  readonly node: OpNode;
  /** Scope depth of the ENCLOSING scope (root = 0): the receiver is read there;
   * the block's rows are scopes at `depth + 1`. */
  readonly depth: number;
  readonly consumer: Consumer;
  readonly receiver: Expr;
  readonly from: readonly Expr[];
  readonly where: Where | null;
  readonly projection: { readonly select: readonly SelectItem[]; readonly values: boolean };
  readonly orderBy: readonly OrderSpec[] | null;
  readonly distinct: boolean;
  readonly bound: { readonly limit: Expr | undefined; readonly offset: Expr | undefined };
  readonly follow: Follow | null;
  /** Equalities answered by an index probe on the receiver (in conjunct order). */
  readonly correlated: readonly Correlation[];
  /** The conjuncts still evaluated per row once the probe has selected its
   * bucket; equals `where` when nothing is correlated. */
  readonly residual: Where | null;
  /** The receiver reads nothing from any enclosing row (only the root scope
   * and bindings), so its rows are the same for every enclosing row and can be
   * materialized and indexed once per run. */
  readonly receiverStable: boolean;
  /** The whole block reads nothing from any enclosing row and has no side
   * effects on one (no lifts): its value is the same for every enclosing row
   * and is computed once per run. */
  readonly invariant: boolean;
  /** `exists`/`none`/`count` may be answered from the cardinality of the
   * accessed rows when no residual predicate remains (nothing per row to
   * evaluate, order, dedup or project). */
  readonly fromCardinality: boolean;
}

/** What a rule may consult besides the plan. */
export interface RuleContext {
  /** How many positional bindings this run has (a `${i}` with `i` at or past
   * it raises when evaluated, so it is not raise-free). */
  readonly bindingCount: number;
}

/** A rewrite: return an improved plan, or `null` when the rule does not apply
 * (or has already been applied). Rules must be idempotent on their own output. */
export type Rule = (plan: BlockPlan, ctx: RuleContext) => BlockPlan | null;

/** The faithful transcription of a block: a scan with every predicate residual. */
export function logicalBlock(node: OpNode, depth: number): BlockPlan {
  const sub = node.sub;
  return {
    node,
    depth,
    consumer: node.op,
    receiver: node.receiver,
    from: sub.from,
    where: sub.where,
    projection: { select: sub.select, values: sub.values ?? false },
    orderBy: sub.orderBy,
    distinct: node.distinct ?? false,
    bound: { limit: sub.limit, offset: sub.offset },
    follow: sub.follow,
    correlated: [],
    residual: sub.where,
    receiverStable: false,
    invariant: false,
    fromCardinality: false,
  };
}

/** Rebuild a conjunction from its remaining parts. */
export function conjunction(parts: readonly Where[]): Where | null {
  return parts.length === 0 ? null : parts.length === 1 ? parts[0]! : { kind: "and", parts: [...parts] };
}

/** The top-level `&&` conjuncts of a where tree (a non-`and` tree is one). */
export function conjuncts(where: Where): readonly Where[] {
  return where.kind === "and" ? where.parts : [where];
}

/** The residual when exactly ONE correlation is answered by a probe (a context
 * index's `lookupRows`): every other conjunct, the remaining equalities
 * included, stays in its original place. A kept equality is true by
 * construction for the rows the probe selects and, being two reads, can neither
 * raise nor bind, so the scan's strict left-to-right order and outcome hold. */
export function residualWithout(plan: BlockPlan, answered: Correlation): Where | null {
  return plan.where ? conjunction(conjuncts(plan.where).filter((_, i) => i !== answered.index)) : null;
}

/** The order in which a single-correlation probe tries the plan's correlations:
 * those whose outer side varies with the enclosing row first (a literal selects
 * the same rows for every enclosing row and narrows nothing), each group in
 * conjunct order. */
export function lookupOrder(plan: BlockPlan): readonly Correlation[] {
  const all = plan.correlated;
  if (all.length < 2) return all;
  return [...all.filter((c) => c.outer.kind !== "lit"), ...all.filter((c) => c.outer.kind === "lit")];
}
