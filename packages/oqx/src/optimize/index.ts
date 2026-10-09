// The optimizer: a logical plan per nested block, rules that rewrite it, a
// driver that applies them to a fixpoint, and the equality-faithful hash index
// the hash-probe rule executes with. See `rules.ts` for the catalog and each
// rule's semantics argument; README "Performance: relational patterns" for the
// user-facing summary.

export type { BlockPlan, Correlation, Rule, RuleContext } from "./ir.ts";
export { logicalBlock } from "./ir.ts";
export { optimizeBlock, planFor } from "./driver.ts";
export { correlatedEqualityProbe, stableReceiver, invariantBlock, cardinalityOnly, DEFAULT_RULES } from "./rules.ts";
export type { RowIndex } from "./hash-index.ts";
export { HashIndex, primitiveKey, intersectPositions } from "./hash-index.ts";
export {
  exprReadsScopeIn, whereReadsScopeIn, opReadsScopeIn, exprReadsCurrentScope,
  exprRaiseFree, whereRaiseFree, opRaiseFree, opHasLifts, whereHasLifts, localPath,
} from "./analysis.ts";
