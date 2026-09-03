import type { MatchBlock, Disposition } from "./types.js";
import type { PhaseState } from "./phases.js";
import { shingles, dice, tokenCount } from "./similarity.js";

// Phase 5 — order-constrained scored assignment (03 §4, §5). For remaining
// same-type candidates: prune by shingle overlap + token-count ratio, score,
// then greedily accept highest-scoring pairs subject to R3 (matched pairs must
// not cross in sibling order unless classified moved).

interface Candidate {
  old: MatchBlock;
  neu: MatchBlock;
  score: number;
}

// score(o,n) = 0.55 text_sim + 0.15 neighbor_ctx + 0.10 parent_match
//            + 0.10 position_prior + 0.10 anchor_evidence
function scorePair(o: MatchBlock, n: MatchBlock, state: PhaseState, oldCount: number, newCount: number): number {
  const textSimVal = dice(shingles(o.text), shingles(n.text));

  // neighbor_ctx: fraction of {prev,next} siblings that are matched pairs.
  const neighborCtx = neighborContext(o, n, state);

  // parent_match: 1 if parents are a matched pair (or both roots).
  const parentMatch = parentsMatched(o, n, state) ? 1 : 0;

  // position_prior: 1 - |rel_pos(o) - rel_pos(n)|
  const relO = oldCount > 1 ? o.index / (oldCount - 1) : 0;
  const relN = newCount > 1 ? n.index / (newCount - 1) : 0;
  const positionPrior = 1 - Math.abs(relO - relN);

  // anchor_evidence: shared anchors / code-fence info / heading prefix.
  const anchorEvidence = sharedAnchorEvidence(o, n);

  return (
    0.55 * textSimVal +
    0.15 * neighborCtx +
    0.1 * parentMatch +
    0.1 * positionPrior +
    0.1 * anchorEvidence
  );
}

function siblingAt(blocks: MatchBlock[], parentKey: string | null, index: number): MatchBlock | undefined {
  return blocks.find((b) => b.parentKey === parentKey && b.index === index);
}

function neighborContext(o: MatchBlock, n: MatchBlock, state: PhaseState): number {
  let matched = 0;
  let total = 0;
  for (const delta of [-1, 1]) {
    const oldSib = siblingAt(state.old, o.parentKey, o.index + delta);
    const newSib = siblingAt(state.neu, n.parentKey, n.index + delta);
    if (oldSib || newSib) {
      total++;
      // matched pair if the old sibling's id is assigned to the new sibling's key
      if (oldSib && newSib && state.matched.get(newSib.key) === oldSib.blockId) matched++;
    }
  }
  return total === 0 ? 0 : matched / total;
}

function parentsMatched(o: MatchBlock, n: MatchBlock, state: PhaseState): boolean {
  if (o.parentKey === null && n.parentKey === null) return true;
  if (o.parentKey === null || n.parentKey === null) return false;
  // old parent block whose key === o.parentKey; check its id maps to n.parentKey
  const oldParent = state.old.find((b) => b.key === o.parentKey);
  if (!oldParent?.blockId) return false;
  return state.matched.get(n.parentKey) === oldParent.blockId;
}

function sharedAnchorEvidence(o: MatchBlock, n: MatchBlock): number {
  if (o.anchors.length > 0 && n.anchors.some((a) => o.anchors.includes(a))) return 1;
  return 0;
}

// Candidate pruning (03 §5): |token_count diff| ≤ 3× and a shared 3-gram; cap
// 12 candidates per block by shingle overlap.
function pruneCandidates(olds: MatchBlock[], news: MatchBlock[]): Candidate[] {
  const oldShingles = new Map<MatchBlock, Set<string>>();
  for (const o of olds) oldShingles.set(o, shingles(o.text));

  const candidates: Candidate[] = [];
  for (const n of news) {
    const ns = shingles(n.text);
    const nCount = tokenCount(n.text);
    const perBlock: Candidate[] = [];
    for (const o of olds) {
      if (o.type !== n.type) continue;
      const oCount = tokenCount(o.text);
      const ratio = Math.max(oCount, nCount) / Math.max(1, Math.min(oCount, nCount));
      if (ratio > 3) continue;
      const os = oldShingles.get(o)!;
      let shares = false;
      for (const s of ns) if (os.has(s)) { shares = true; break; }
      if (!shares && ns.size > 0 && os.size > 0) continue;
      perBlock.push({ old: o, neu: n, score: 0 });
    }
    // cap at 12 by shingle overlap
    perBlock.sort((a, b) => dice(oldShingles.get(b.old)!, ns) - dice(oldShingles.get(a.old)!, ns));
    candidates.push(...perBlock.slice(0, 12));
  }
  return candidates;
}

function unmatchedOld(state: PhaseState): MatchBlock[] {
  return state.old.filter((b) => !state.usedOld.has(b.blockId!));
}
function unmatchedNew(state: PhaseState): MatchBlock[] {
  return state.neu.filter((b) => !state.usedNew.has(b.key));
}

/**
 * Phase 5 — scored assignment. Greedy-by-score with R3 order constraints:
 * accept the highest-scoring candidate, discard conflicting candidates
 * (same old or new, or order-crossing with an already-accepted same-parent
 * pair), repeat. Accept while score ≥ θ (θ_small for tiny blocks).
 */
export function phase5Scored(state: PhaseState): void {
  const olds = unmatchedOld(state);
  const news = unmatchedNew(state);
  if (olds.length === 0 || news.length === 0) return;
  // Bulk path guard: too many unmatched ⇒ skip (handled by give-up logic 2.5).
  if (olds.length + news.length > state.config.maxScoredBlocks * 2) return;

  const oldCount = state.old.length;
  const newCount = state.neu.length;

  const candidates = pruneCandidates(olds, news);
  for (const c of candidates) c.score = scorePair(c.old, c.neu, state, oldCount, newCount);
  // Deterministic order: score desc, then old key, then new key.
  candidates.sort((a, b) => b.score - a.score || cmp(a.old.key, b.old.key) || cmp(a.neu.key, b.neu.key));

  // All scored candidates per new key, for near-miss recording (R5).
  const byNewKey = new Map<string, Candidate[]>();
  for (const c of candidates) (byNewKey.get(c.neu.key) ?? byNewKey.set(c.neu.key, []).get(c.neu.key)!).push(c);

  // accepted pairs per parent for the order (R3) check
  const acceptedByParent = new Map<string | null, { oldIndex: number; newIndex: number }[]>();

  for (const c of candidates) {
    if (state.usedOld.has(c.old.blockId!) || state.usedNew.has(c.neu.key)) continue;
    const threshold = tokenCount(c.neu.text) < state.config.smallBlockTokens ? state.config.thetaSmall : state.config.thetaAccept;
    if (c.score < threshold) break; // sorted desc: nothing below will qualify either

    // R3: within the same new parent, accepted pairs must not cross in order.
    if (c.old.parentKey === c.neu.parentKey) {
      const list = acceptedByParent.get(c.neu.parentKey) ?? [];
      const crosses = list.some((p) => (p.oldIndex - c.old.index) * (p.newIndex - c.neu.index) < 0);
      if (crosses) continue;
    }

    // Near-misses (R5): other candidates for this new block whose score fell
    // within 0.1 below the acceptance threshold. Recorded on the winner.
    const nearMisses = (byNewKey.get(c.neu.key) ?? [])
      .filter((o) => o.old.blockId !== c.old.blockId && o.score < threshold && o.score >= threshold - 0.1)
      .map((o) => ({ blockId: o.old.blockId!, score: round(o.score) }));

    // accept
    state.matched.set(c.neu.key, c.old.blockId!);
    state.usedOld.add(c.old.blockId!);
    state.usedNew.add(c.neu.key);
    const moved = c.old.parentKey !== c.neu.parentKey || c.old.index !== c.neu.index;
    const kind: Disposition["kind"] = moved ? "edited_moved" : "edited";
    state.dispositions.push({
      blockId: c.old.blockId!,
      kind,
      confidence: c.score,
      reason: "scored",
      matcherV: state.config.matcherV,
      detail: nearMisses.length > 0 ? { near_misses: nearMisses } : {},
    });
    const list = acceptedByParent.get(c.neu.parentKey) ?? [];
    list.push({ oldIndex: c.old.index, newIndex: c.neu.index });
    acceptedByParent.set(c.neu.parentKey, list);
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
