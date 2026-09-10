// Canonical structural relations (slice 1). Graph relations (out/in/traverse)
// are deferred. Each relation is one hop from a known target; join columns
// correlate a nested scope to the current outer row via the canonical per-target
// alias (documents=d, blocks=b, nodes=n) that the CEL compiler emits.

import type { CelTarget, Relation } from "./ir.js";

interface RelationDef extends Relation {
  /** the outer target this relation may be walked FROM. */
  from: CelTarget;
  /** true for single-valued relations (node.doc, node.block). */
  singleValued: boolean;
  /** true when the child row always belongs to the SAME document as the outer
   * row. Load-bearing: it lets a nested scope reuse the OUTER query's `documents
   * d` binding for doc-field and `$path` reach-through instead of joining its
   * own — an inner join would shadow `d` and silently break the correlation.
   * compile.ts asserts this before allowing such reach-through. */
  sameDoc: boolean;
  /** when set, the relation is not usable yet — the reason is reported to the
   * caller as filter_invalid rather than silently returning no rows. */
  unavailable?: string;
}

// Keyed by "<surfaceReceiver>.<relation>". The receiver token in source (doc /
// block / node / nodes / blocks) resolves to one of these by the enclosing
// scope's target — see lower.ts.
export const RELATIONS: Record<string, RelationDef> = {
  "doc.nodes": {
    name: "doc.nodes", from: "docs", childTarget: "nodes",
    innerCol: "n.doc_id", outerCol: "d.doc_id", singleValued: false, sameDoc: true,
  },
  "doc.blocks": {
    name: "doc.blocks", from: "docs", childTarget: "blocks",
    innerCol: "b.doc_id", outerCol: "d.doc_id", singleValued: false, sameDoc: true,
  },
  // block.nodes is modeled but NOT usable: no format adapter populates a real
  // `b_` block id on projected nodes (projectNodes receives RawBlocks, whose ids
  // are not minted yet), so `nodes.block_id` is universally NULL and this
  // relation would match nothing. Failing loudly beats a silent empty result.
  "block.nodes": {
    name: "block.nodes", from: "blocks", childTarget: "nodes",
    innerCol: "n.block_id", outerCol: "b.block_id", singleValued: false, sameDoc: true,
    unavailable:
      "node→block anchoring is not populated yet (nodes.block_id is always NULL), so this relation cannot match. Query `from nodes` with doc.* reach-through instead.",
  },
  "node.doc": {
    name: "node.doc", from: "nodes", childTarget: "docs",
    innerCol: "d.doc_id", outerCol: "n.doc_id", singleValued: true, sameDoc: true,
  },
  "node.block": {
    name: "node.block", from: "nodes", childTarget: "blocks",
    innerCol: "b.block_id", outerCol: "n.block_id", singleValued: true, sameDoc: true,
  },
};

export type { RelationDef };
