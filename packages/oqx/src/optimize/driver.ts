// The optimizer driver: applies a rule set to a block's logical plan until no
// rule changes it (a fixpoint, bounded), and caches the result per AST node —
// the analysis is syntactic, so a plan depends only on the node, its static
// depth, the run's binding count and the rule set.

import type { OpNode } from "../ast.ts";
import type { BlockPlan, Rule, RuleContext } from "./ir.ts";
import { logicalBlock } from "./ir.ts";

const MAX_PASSES = 8;

/** Rewrite `logicalBlock(node, depth)` to a fixpoint of `rules`. */
export function optimizeBlock(node: OpNode, depth: number, ctx: RuleContext, rules: readonly Rule[]): BlockPlan {
  let plan = logicalBlock(node, depth);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    for (const rule of rules) {
      const next = rule(plan, ctx);
      if (next !== null && next !== plan) { plan = next; changed = true; }
    }
    if (!changed) break;
  }
  return plan;
}

interface Cached { depth: number; bindingCount: number; rules: readonly Rule[]; plan: BlockPlan }
const cache = new WeakMap<OpNode, Cached>();

/** `optimizeBlock`, memoized on the node (re-planned when depth, binding count
 * or rule set differ from the cached entry). */
export function planFor(node: OpNode, depth: number, ctx: RuleContext, rules: readonly Rule[]): BlockPlan {
  const hit = cache.get(node);
  if (hit && hit.depth === depth && hit.bindingCount === ctx.bindingCount && hit.rules === rules) return hit.plan;
  const plan = optimizeBlock(node, depth, ctx, rules);
  cache.set(node, { depth, bindingCount: ctx.bindingCount, rules, plan });
  return plan;
}
