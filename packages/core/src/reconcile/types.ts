// Reconciliation types (reconciliation-spec). The matcher takes the last
// persisted block tree (blocks carrying ids) and the newly parsed tree (blocks
// without ids) and produces an assignment: each new block either CARRIES an
// existing id or is MINTED, plus a disposition per carry/mint.

export type DispositionKind =
  | "same" | "edited" | "moved" | "edited_moved" | "inserted" | "deleted"
  | "split_from" | "merged_into" | "copied_from" | "resurrected" | "bulk_rewrite";

export type Reason =
  | "exact_hash" | "normalized_hash" | "anchor" | "context_unique" | "context_children"
  | "scored" | "tombstone" | "api";

// A flattened block for matching. Old blocks carry their id; new blocks don't
// until assigned. We flatten the containment tree to a list keyed by a stable
// path so order/parent constraints are checkable.
export interface MatchBlock {
  /** present on old blocks; undefined on new blocks until assigned */
  blockId?: string;
  type: string;
  rawHashHex: string;
  normHashHex: string;
  text: string; // normalized visible text (for text_sim)
  anchors: string[];
  parentKey: string | null; // parent's positional key (null at top level)
  index: number; // ordinal among siblings
  /** stable positional key: parentKey + '/' + index */
  key: string;
}

export interface Disposition {
  blockId: string;
  kind: DispositionKind;
  confidence: number | null;
  reason: Reason | null;
  matcherV: string;
  detail: Record<string, unknown>;
}

export interface ReconcileConfig {
  matcherV: string;
  thetaAccept: number; // phase-5 acceptance
  thetaSmall: number; // acceptance for < 8 tokens
  thetaXdoc: number; // cross-document acceptance
  splitCoverage: number;
  splitDominantShare: number;
  copySim: number;
  bulkUnmatchedFrac: number;
  bulkMinBlocks: number;
  maxScoredBlocks: number;
  smallBlockTokens: number;
  contextSimFloor: number; // phase-4 text_sim floor (0.35)
  /** phase-4b: minimum fraction of an old container's children that must have
   * carried into one new container for the children to vouch for it (0.5). */
  childrenVouchFrac: number;
}

export const DEFAULT_CONFIG: ReconcileConfig = {
  // m2.0: phase 4b (children vouch for their parent, reason context_children)
  // and the phase-4 fixed point; a phase change bumps the major (03 §7).
  matcherV: "m2.0",
  thetaAccept: 0.62,
  thetaSmall: 0.8,
  thetaXdoc: 0.8,
  splitCoverage: 0.8,
  splitDominantShare: 0.7,
  copySim: 0.95,
  bulkUnmatchedFrac: 0.45,
  bulkMinBlocks: 100,
  maxScoredBlocks: 2000,
  smallBlockTokens: 8,
  contextSimFloor: 0.35,
  childrenVouchFrac: 0.5,
};

/** The result of matching one document's old tree against new blocks. */
export interface MatchResult {
  /** new block key → assigned id (carried) or minted id */
  assignment: Map<string, string>;
  dispositions: Disposition[];
  /** old block ids that were not carried (deleted) */
  deleted: string[];
}
