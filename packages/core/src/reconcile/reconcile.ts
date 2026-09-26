import { mintId } from "../core/ids.js";
import type { MatchBlock, Disposition, ReconcileConfig, MatchResult } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { phase1Exact, phase2Normalized, phase3Anchor, phase4Propagate, type PhaseState } from "./phases.js";
import { phase5Scored } from "./phase5.js";
import { phase6aCompound } from "./phase6a.js";

// Document reconciler (03 §4): run phases in order, then phase 7 defaults.
// Produces a per-new-block assignment (carried or minted id) and dispositions.

export interface ResurrectionCandidate {
  blockId: string;
  rawHashHex: string;
  normHashHex: string;
  type: string;
}

export interface ReconcileOptions {
  config?: ReconcileConfig;
  /** resurrection pool (cross-checkpoint) matched by raw/norm hash only. */
  pool?: ResurrectionCandidate[];
}

function newState(old: MatchBlock[], neu: MatchBlock[], config: ReconcileConfig): PhaseState {
  return { old, neu, matched: new Map(), usedOld: new Set(), usedNew: new Set(), dispositions: [], config };
}

// Bulk-rewrite give-up (03 §6): after phase 2, if a large doc is mostly
// unmatched with low mean similarity, mint everything + one bulk_rewrite.
function shouldBulkRewrite(state: PhaseState): boolean {
  const total = state.neu.length;
  if (total < state.config.bulkMinBlocks) return false;
  const unmatchedFrac = (state.neu.length - state.usedNew.size) / total;
  return unmatchedFrac > state.config.bulkUnmatchedFrac;
}

/** Resurrection (03 §4 phase 6b, cross-checkpoint): match remaining new blocks
 * against a pool by exact raw/norm hash only. Consumes matched pool rows. */
function phase6bResurrection(state: PhaseState, pool: ResurrectionCandidate[], consumed: Set<string>): void {
  const byRaw = new Map<string, ResurrectionCandidate>();
  const byNorm = new Map<string, ResurrectionCandidate>();
  for (const c of pool) {
    byRaw.set(`${c.type} ${c.rawHashHex}`, c);
    byNorm.set(`${c.type} ${c.normHashHex}`, c);
  }
  for (const n of state.neu) {
    if (state.usedNew.has(n.key)) continue;
    const hit = byRaw.get(`${n.type} ${n.rawHashHex}`) ?? byNorm.get(`${n.type} ${n.normHashHex}`);
    if (hit && !consumed.has(hit.blockId)) {
      consumed.add(hit.blockId);
      state.matched.set(n.key, hit.blockId);
      state.usedNew.add(n.key);
      state.dispositions.push({ blockId: hit.blockId, kind: "resurrected", confidence: 0.99, reason: "exact_hash", matcherV: state.config.matcherV, detail: {} });
    }
  }
}

export interface DocReconcileResult extends MatchResult {
  /** pool ids consumed by resurrection this run */
  consumedPool: string[];
}

/**
 * Reconcile one document. `oldBlocks` carry ids; `newBlocks` do not. Returns the
 * assignment (new key → id), dispositions, and deleted old ids.
 */
export function reconcileDocument(
  oldBlocks: MatchBlock[],
  newBlocks: MatchBlock[],
  opts: ReconcileOptions = {},
): DocReconcileResult {
  const config = opts.config ?? DEFAULT_CONFIG;
  const state = newState(oldBlocks, newBlocks, config);
  const consumedPool = new Set<string>();

  phase1Exact(state);
  phase2Normalized(state);

  if (shouldBulkRewrite(state)) {
    return bulkRewrite(state);
  }

  phase3Anchor(state);
  phase4Propagate(state); // phases 4 + 4b to a fixed point
  phase5Scored(state);
  phase6aCompound(state);
  if (opts.pool && opts.pool.length > 0) phase6bResurrection(state, opts.pool, consumedPool);

  return finalize(state, [...consumedPool]);
}

// Phase 7 defaults + assignment resolution. Every new block gets a final id:
// carried (from state.matched), lineage-minted (NEW:<key> dispositions), or a
// plain minted 'inserted'. Remaining old blocks are 'deleted'.
function finalize(state: PhaseState, consumedPool: string[]): DocReconcileResult {
  const assignment = new Map<string, string>();
  const dispositions = [...state.dispositions];

  // Carried assignments.
  for (const [newKey, oldId] of state.matched) assignment.set(newKey, oldId);

  // Lineage placeholders (split_from/merged_into/copied_from on NEW:<key>):
  // mint a fresh id and rewrite the disposition to the minted id.
  for (const d of dispositions) {
    if (d.blockId.startsWith("NEW:")) {
      const newKey = d.detail.newKey as string;
      const minted = assignment.get(newKey) ?? mintId("b");
      assignment.set(newKey, minted);
      d.blockId = minted;
    }
  }

  // Remaining new blocks with no assignment → minted 'inserted'.
  for (const n of state.neu) {
    if (!assignment.has(n.key)) {
      const minted = mintId("b");
      assignment.set(n.key, minted);
      dispositions.push({ blockId: minted, kind: "inserted", confidence: null, reason: null, matcherV: state.config.matcherV, detail: {} });
    }
  }

  // Remaining old blocks (not carried) → deleted.
  const deleted: string[] = [];
  for (const o of state.old) {
    if (!state.usedOld.has(o.blockId!)) {
      deleted.push(o.blockId!);
      dispositions.push({ blockId: o.blockId!, kind: "deleted", confidence: null, reason: "tombstone", matcherV: state.config.matcherV, detail: {} });
    }
  }

  return { assignment, dispositions, deleted, consumedPool };
}

function bulkRewrite(state: PhaseState): DocReconcileResult {
  // Mint everything; emit one doc-scoped bulk_rewrite + deleted for all old.
  const assignment = new Map<string, string>();
  const dispositions: Disposition[] = [
    { blockId: "DOC", kind: "bulk_rewrite", confidence: null, reason: null, matcherV: state.config.matcherV, detail: { unmatchedFrac: (state.neu.length - state.usedNew.size) / state.neu.length } },
  ];
  for (const n of state.neu) {
    const minted = mintId("b");
    assignment.set(n.key, minted);
    dispositions.push({ blockId: minted, kind: "inserted", confidence: null, reason: null, matcherV: state.config.matcherV, detail: {} });
  }
  const deleted: string[] = [];
  for (const o of state.old) {
    deleted.push(o.blockId!);
    dispositions.push({ blockId: o.blockId!, kind: "deleted", confidence: null, reason: "tombstone", matcherV: state.config.matcherV, detail: {} });
  }
  return { assignment, dispositions, deleted, consumedPool: [] };
}
