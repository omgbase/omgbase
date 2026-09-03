import type { MatchBlock, Disposition } from "./types.js";
import type { PhaseState } from "./phases.js";
import { shingles, dice, tokenCount, tokenize } from "./similarity.js";

// Phase 6a — compound classification (03 §4): split, merge, copy over the
// still-unmatched. Split/merge use dominant-fragment inheritance (tunable via
// split.dominant_share; set to 1.01 to disable). Copies never steal identity.

function unmatchedOld(state: PhaseState): MatchBlock[] {
  return state.old.filter((b) => !state.usedOld.has(b.blockId!));
}
function unmatchedNew(state: PhaseState): MatchBlock[] {
  return state.neu.filter((b) => !state.usedNew.has(b.key));
}

// coverage(concat(N), O): how much of O's shingles the concatenation covers.
function coverage(concatText: string, oText: string): number {
  const os = shingles(oText);
  if (os.size === 0) return 0;
  const cs = shingles(concatText);
  let covered = 0;
  for (const s of os) if (cs.has(s)) covered++;
  return covered / os.size;
}

function carryTo(state: PhaseState, oldId: string, newB: MatchBlock, kind: Disposition["kind"], confidence: number, detail: Record<string, unknown>): void {
  state.matched.set(newB.key, oldId);
  state.usedOld.add(oldId);
  state.usedNew.add(newB.key);
  state.dispositions.push({ blockId: oldId, kind, confidence, reason: "scored", matcherV: state.config.matcherV, detail });
}

// Record a mint-with-lineage disposition against a still-minted new block. The
// new block gets a fresh id later (assignment step); here we note the lineage
// keyed by the new block's positional key in detail.
function noteLineage(state: PhaseState, newB: MatchBlock, kind: Disposition["kind"], counterpartOldId: string): void {
  state.usedNew.add(newB.key);
  state.dispositions.push({
    blockId: `NEW:${newB.key}`,
    kind,
    confidence: null,
    reason: "scored",
    matcherV: state.config.matcherV,
    detail: { counterpart: counterpartOldId, newKey: newB.key },
  });
}

/** Detect splits: one old block O covered by a run of ≥2 adjacent new blocks. */
function detectSplits(state: PhaseState): void {
  const { splitCoverage, splitDominantShare } = state.config;
  for (const o of unmatchedOld(state)) {
    const news = unmatchedNew(state)
      .filter((n) => n.parentKey === o.parentKey && n.type === o.type)
      .sort((a, b) => a.index - b.index);
    // find a contiguous run (by index) of length ≥2 covering O
    for (let start = 0; start < news.length; start++) {
      for (let end = news.length; end > start + 1; end--) {
        const run = news.slice(start, end);
        if (!isContiguous(run)) continue;
        const concat = run.map((n) => n.text).join(" ");
        const cov = coverage(concat, o.text);
        if (cov < splitCoverage) continue;
        // leftover < 0.2 of the run's content is novel? approximate via reverse coverage.
        const leftover = 1 - coverage(o.text, concat);
        if (leftover >= 0.2) continue;

        // dominant fragment: first fragment holding ≥ share of O's tokens?
        const oTokens = tokenCount(o.text) || 1;
        const first = run[0]!;
        const firstShare = sharedTokenFraction(first.text, o.text, oTokens);
        if (firstShare >= splitDominantShare) {
          carryTo(state, o.blockId!, first, "edited", 0.8 * cov, { split: run.map((n) => n.key), dominant: first.key });
          for (const n of run.slice(1)) noteLineage(state, n, "split_from", o.blockId!);
        } else {
          state.usedOld.add(o.blockId!);
          state.dispositions.push({ blockId: o.blockId!, kind: "deleted", confidence: null, reason: "tombstone", matcherV: state.config.matcherV, detail: { splitInto: run.map((n) => n.key) } });
          for (const n of run) noteLineage(state, n, "split_from", o.blockId!);
        }
        return; // one split per pass (conservative)
      }
    }
  }
}

/** Detect merges: a run of ≥2 adjacent old blocks covered by one new block. */
function detectMerges(state: PhaseState): void {
  const { splitCoverage, splitDominantShare } = state.config;
  for (const n of unmatchedNew(state)) {
    const olds = unmatchedOld(state)
      .filter((o) => o.parentKey === n.parentKey && o.type === n.type)
      .sort((a, b) => a.index - b.index);
    for (let start = 0; start < olds.length; start++) {
      for (let end = olds.length; end > start + 1; end--) {
        const run = olds.slice(start, end);
        if (!isContiguous(run)) continue;
        const concat = run.map((o) => o.text).join(" ");
        const cov = coverage(n.text, concat);
        if (cov < splitCoverage) continue;

        const nTokens = tokenCount(n.text) || 1;
        // dominant contributor: first old block holding ≥ share of N's tokens.
        const first = run[0]!;
        const firstShare = sharedTokenFraction(first.text, n.text, nTokens);
        if (firstShare >= splitDominantShare) {
          carryTo(state, first.blockId!, n, "edited", 0.8 * cov, { merge: run.map((o) => o.blockId!), dominant: first.blockId! });
          for (const o of run.slice(1)) {
            state.usedOld.add(o.blockId!);
            state.dispositions.push({ blockId: o.blockId!, kind: "merged_into", confidence: 0.8 * cov, reason: "scored", matcherV: state.config.matcherV, detail: { into: first.blockId! } });
          }
        } else {
          state.usedNew.add(n.key);
          for (const o of run) {
            state.usedOld.add(o.blockId!);
            state.dispositions.push({ blockId: o.blockId!, kind: "merged_into", confidence: null, reason: "scored", matcherV: state.config.matcherV, detail: { mergedKey: n.key } });
          }
          noteLineage(state, n, "merged_into", first.blockId!);
        }
        return;
      }
    }
  }
}

/** Detect copies: unmatched new block ≥ copy.sim to a MATCHED (present) old block. */
function detectCopies(state: PhaseState): void {
  const matchedOldIds = new Set(state.matched.values());
  const matchedOld = state.old.filter((o) => matchedOldIds.has(o.blockId!));
  for (const n of unmatchedNew(state)) {
    for (const o of matchedOld) {
      if (o.type !== n.type) continue;
      if (dice(shingles(o.text), shingles(n.text)) >= state.config.copySim) {
        noteLineage(state, n, "copied_from", o.blockId!);
        break;
      }
    }
  }
}

export function phase6aCompound(state: PhaseState): void {
  detectSplits(state);
  detectMerges(state);
  detectCopies(state);
}

function isContiguous(run: MatchBlock[]): boolean {
  for (let i = 1; i < run.length; i++) if (run[i]!.index !== run[i - 1]!.index + 1) return false;
  return true;
}

function sharedTokenFraction(fragment: string, whole: string, wholeTokenCount: number): number {
  const fragTokens = new Set(tokenize(fragment));
  const wholeTokens = tokenize(whole);
  let shared = 0;
  for (const t of wholeTokens) if (fragTokens.has(t)) shared++;
  return shared / wholeTokenCount;
}
