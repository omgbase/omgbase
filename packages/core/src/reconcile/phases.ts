import type { MatchBlock, Disposition, ReconcileConfig } from "./types.js";
import { textSim } from "./similarity.js";

// Matcher phases 1–4 (03 §4). Phases run in order of strictly decreasing
// certainty; each phase only sees blocks unmatched by earlier phases. R2
// (type equality) is a hard gate for every carry.

export interface PhaseState {
  old: MatchBlock[];
  neu: MatchBlock[];
  /** new key → old id */
  matched: Map<string, string>;
  /** old ids already consumed */
  usedOld: Set<string>;
  /** new keys already matched */
  usedNew: Set<string>;
  dispositions: Disposition[];
  config: ReconcileConfig;
}

function carry(state: PhaseState, oldB: MatchBlock, newB: MatchBlock, kind: Disposition["kind"], confidence: number, reason: Disposition["reason"], detail: Record<string, unknown> = {}): void {
  state.matched.set(newB.key, oldB.blockId!);
  state.usedOld.add(oldB.blockId!);
  state.usedNew.add(newB.key);
  state.dispositions.push({
    blockId: oldB.blockId!,
    kind,
    confidence,
    reason,
    matcherV: state.config.matcherV,
    detail,
  });
}

function unmatchedOld(state: PhaseState): MatchBlock[] {
  return state.old.filter((b) => !state.usedOld.has(b.blockId!));
}
function unmatchedNew(state: PhaseState): MatchBlock[] {
  return state.neu.filter((b) => !state.usedNew.has(b.key));
}

// Determine same-vs-edited-vs-moved kind. Content equality is always judged by
// raw-hash (byte identity); a normalized-only match is an edit, not "same".
function classifyKind(oldB: MatchBlock, newB: MatchBlock): Disposition["kind"] {
  const moved = oldB.parentKey !== newB.parentKey || oldB.index !== newB.index;
  const contentEqual = oldB.rawHashHex === newB.rawHashHex;
  if (contentEqual && !moved) return "same";
  if (contentEqual && moved) return "moved";
  if (!contentEqual && moved) return "edited_moved";
  return "edited";
}

// Pair groups of equal hash 1:1 in document order. A hash unique on both sides
// pairs directly; equal-cardinality groups pair positionally.
function lockByHash(state: PhaseState, hashOf: (b: MatchBlock) => string, confidence: number, reason: Disposition["reason"]): void {
  const oldByHash = new Map<string, MatchBlock[]>();
  for (const b of unmatchedOld(state)) {
    const h = `${b.type}\u0000${hashOf(b)}`; // R2: type-gated
    (oldByHash.get(h) ?? oldByHash.set(h, []).get(h)!).push(b);
  }
  const newByHash = new Map<string, MatchBlock[]>();
  for (const b of unmatchedNew(state)) {
    const h = `${b.type}\u0000${hashOf(b)}`;
    (newByHash.get(h) ?? newByHash.set(h, []).get(h)!).push(b);
  }
  for (const [h, olds] of oldByHash) {
    const news = newByHash.get(h);
    if (!news) continue;
    if (olds.length === news.length) {
      // pair positionally (document order preserved by construction)
      for (let i = 0; i < olds.length; i++) {
        carry(state, olds[i]!, news[i]!, classifyKind(olds[i]!, news[i]!), confidence, reason);
      }
    }
  }
}

/** Phase 1 — exact raw-hash lock. */
export function phase1Exact(state: PhaseState): void {
  lockByHash(state, (b) => b.rawHashHex, 1.0, "exact_hash");
}

/** Phase 2 — normalized-hash lock. */
export function phase2Normalized(state: PhaseState): void {
  lockByHash(state, (b) => b.normHashHex, 0.99, "normalized_hash");
}

/** Phase 3 — anchor lock: same authored ^ref, unique on both sides. */
export function phase3Anchor(state: PhaseState): void {
  const oldByAnchor = new Map<string, MatchBlock[]>();
  for (const b of unmatchedOld(state)) for (const a of b.anchors) (oldByAnchor.get(a) ?? oldByAnchor.set(a, []).get(a)!).push(b);
  const newByAnchor = new Map<string, MatchBlock[]>();
  for (const b of unmatchedNew(state)) for (const a of b.anchors) (newByAnchor.get(a) ?? newByAnchor.set(a, []).get(a)!).push(b);
  for (const [a, olds] of oldByAnchor) {
    const news = newByAnchor.get(a);
    if (olds.length === 1 && news && news.length === 1 && olds[0]!.type === news[0]!.type) {
      const o = olds[0]!, n = news[0]!;
      // The groups were built before any carry in this phase: a block with two
      // anchors sits in two groups, and its second group is stale once the first
      // carried it (R1: an id is carried at most once).
      if (state.usedOld.has(o.blockId!) || state.usedNew.has(n.key)) continue;
      carry(state, o, n, classifyKind(o, n), 0.99, "anchor");
    }
  }
}

/**
 * Phase 4a — context propagation (spec/reconcile §5). Matched siblings vouch
 * for the stranger between them: within a gap bounded by matched blocks, if
 * exactly one unmatched OLD child remains, pair it with its best-matching
 * unmatched NEW child in that same gap (text_sim ≥ floor, unique best).
 * Insertions in the gap do not block the carry — they simply lose to the
 * better-matching candidate, which is why an inserted block never steals an
 * edited block's identity.
 *
 * Step 5, the singleton rule (m2.3): when the floor test fails (or there is
 * no best), a carried container (not the root pair) with exactly one unmatched
 * old child and exactly one unmatched new child of its type carries them
 * without a text floor, provided the new child sits in the SAME SLOT — same
 * index, or the siblings just before both (or just after both) are a carried
 * pair — and anchors do not veto (if either block has anchors they must share
 * one). Reason `context_unique`, confidence 0.75 + 0.2 × text_sim, whatever
 * text_sim is (0 for a two-word item whose one word changed). Root-level
 * singletons are excluded: an unrelated replacement paragraph is common there
 * and paragraphs carry the block references R4 protects.
 */
export function phase4Context(state: PhaseState): void {
  const parentPairs = matchedParentPairs(state);
  for (const [oldParent, newParent] of parentPairs) {
    const oldKids = unmatchedOld(state).filter((b) => b.parentKey === oldParent);
    if (oldKids.length !== 1) continue; // "lone unmatched old" — the certain case
    const o = oldKids[0]!;

    // Candidate new children: unmatched, same type, same parent.
    const candidates = unmatchedNew(state).filter((n) => n.parentKey === newParent && n.type === o.type);
    if (candidates.length === 0) continue;

    let best: MatchBlock | null = null;
    let bestSim = -1;
    let tie = false;
    for (const n of candidates) {
      const sim = textSim(o.text, n.text);
      if (sim > bestSim) { bestSim = sim; best = n; tie = false; }
      else if (sim === bestSim) tie = true;
    }
    if (best && !tie && bestSim >= state.config.contextSimFloor) {
      carry(state, o, best, classifyKind(o, best), 0.75 + 0.2 * bestSim, "context_unique");
      continue;
    }

    // Step 5 — singleton rule (m2.3): nested containers only, one candidate,
    // same slot, anchors not contradicting.
    if (oldParent === null || newParent === null) continue;
    if (candidates.length !== 1) continue;
    const n = candidates[0]!;
    if (!sameSlot(state, o, n)) continue;
    if (anchorsVeto(o, n)) continue;
    carry(state, o, n, classifyKind(o, n), 0.75 + 0.2 * textSim(o.text, n.text), "context_unique");
  }
}

// The singleton rule's slot test: same sibling index, or the siblings just
// before both (or just after both) are a carried pair. The neighbours are
// looked up under each block's own parent; a missing neighbour on either side
// makes that clause false.
function sameSlot(state: PhaseState, o: MatchBlock, n: MatchBlock): boolean {
  if (o.index === n.index) return true;
  for (const d of [-1, 1]) {
    const os = state.old.find((b) => b.parentKey === o.parentKey && b.index === o.index + d);
    const ns = state.neu.find((b) => b.parentKey === n.parentKey && b.index === n.index + d);
    if (os && ns && state.matched.get(ns.key) === os.blockId) return true;
  }
  return false;
}

// Anchors veto a singleton carry: if either block carries anchors, they must
// share one (an authored ^ref that moved elsewhere is evidence against).
function anchorsVeto(o: MatchBlock, n: MatchBlock): boolean {
  if (o.anchors.length === 0 && n.anchors.length === 0) return false;
  return !o.anchors.some((a) => n.anchors.includes(a));
}

/**
 * Phase 4b — children vouch for their parent (03 §4). Phase 4 lets a matched
 * parent vouch for the stranger among its children; this is the converse. For
 * each unmatched OLD container, look at where its already-carried children
 * landed. If a clear majority of them (≥ childrenVouchFrac of ALL its children)
 * sit under one unmatched NEW block of the same type, and that block is the
 * unique destination for them, and the old container is in turn the unique
 * source of that block's carried children (mutual best by children), and the
 * two containers' own parents do not contradict the pairing (a matched pair,
 * both roots, or both still undecided), the containers pair. Reason
 * `context_children`, confidence 0.75 + 0.2 × fraction.
 *
 * Text is deliberately not consulted: a container's visible text is its
 * children's text, so a one-word-per-item list has no shingle evidence to give
 * — its children's carried ids are the evidence. Returns true if any pair was
 * made (phase4Propagate iterates to a fixed point).
 */
export function phase4bChildren(state: PhaseState): boolean {
  const oldByKey = new Map(state.old.map((b) => [b.key, b]));
  const newByKey = new Map(state.neu.map((b) => [b.key, b]));
  const oldById = new Map(state.old.map((b) => [b.blockId!, b]));

  // Children counts per old container (only containers have any).
  const childTotal = new Map<string, number>();
  for (const b of state.old) if (b.parentKey !== null) childTotal.set(b.parentKey, (childTotal.get(b.parentKey) ?? 0) + 1);

  // Carried-children tally: old parent key × new parent key → count, over every
  // matched child pair whose both parents are real blocks.
  const landed = new Map<string, Map<string, number>>(); // oldParentKey → newParentKey → n
  const sourced = new Map<string, Map<string, number>>(); // newParentKey → oldParentKey → n
  for (const [newKey, oldId] of state.matched) {
    const o = oldById.get(oldId);
    const n = newByKey.get(newKey);
    if (!o || !n || o.parentKey === null || n.parentKey === null) continue;
    bump(landed, o.parentKey, n.parentKey);
    bump(sourced, n.parentKey, o.parentKey);
  }

  let paired = false;
  for (const o of state.old) {
    if (state.usedOld.has(o.blockId!)) continue;
    const total = childTotal.get(o.key);
    if (!total) continue; // not a container (or childless)
    const dests = landed.get(o.key);
    if (!dests) continue;
    const dest = uniqueMax(dests);
    if (!dest) continue; // tie between destinations ⇒ ambiguity mints (R4)
    const fraction = dest.count / total;
    if (fraction < state.config.childrenVouchFrac) continue;

    const n = newByKey.get(dest.key);
    if (!n || state.usedNew.has(n.key) || n.type !== o.type) continue; // R2
    const source = uniqueMax(sourced.get(n.key)!);
    if (!source || source.key !== o.key) continue; // another old container also feeds n
    if (!parentsCompatible(o, n, state, oldByKey)) continue;

    carry(state, o, n, classifyKind(o, n), 0.75 + 0.2 * fraction, "context_children", {
      children_carried: dest.count,
      children_total: total,
    });
    paired = true;
  }
  return paired;
}

/**
 * Phase 4 fixed point: context propagation (parents/siblings vouch for a
 * child) and children vouching (children vouch for their parent) feed each
 * other — a newly paired list unlocks its lone edited item; a newly paired
 * inner list unlocks the item that contains it, then the outer list. Iterate
 * until neither adds a pair. Terminates: every round consumes ≥ 1 old block.
 */
export function phase4Propagate(state: PhaseState): void {
  for (;;) {
    const before = state.matched.size;
    phase4Context(state);
    phase4bChildren(state);
    if (state.matched.size === before) return;
  }
}

function bump(m: Map<string, Map<string, number>>, a: string, b: string): void {
  const inner = m.get(a) ?? m.set(a, new Map()).get(a)!;
  inner.set(b, (inner.get(b) ?? 0) + 1);
}

// The entry with the strictly greatest count, or null on a tie.
function uniqueMax(counts: Map<string, number>): { key: string; count: number } | null {
  let best: { key: string; count: number } | null = null;
  let tie = false;
  for (const [key, count] of counts) {
    if (!best || count > best.count) { best = { key, count }; tie = false; }
    else if (count === best.count) tie = true;
  }
  return tie ? null : best;
}

// The containers' own parents must not contradict the pairing: both roots, a
// matched pair, or both still undecided (so nested containers can resolve
// bottom-up). Anything else — one at root and one nested, or either parent
// already matched elsewhere — rejects.
function parentsCompatible(o: MatchBlock, n: MatchBlock, state: PhaseState, oldByKey: Map<string, MatchBlock>): boolean {
  if (o.parentKey === null && n.parentKey === null) return true;
  if (o.parentKey === null || n.parentKey === null) return false;
  const oldParent = oldByKey.get(o.parentKey);
  if (!oldParent) return false;
  if (state.usedOld.has(oldParent.blockId!)) return state.matched.get(n.parentKey) === oldParent.blockId;
  return !state.usedNew.has(n.parentKey);
}

// Parent keys that are themselves a matched pair (or both roots).
function matchedParentPairs(state: PhaseState): [string | null, string | null][] {
  const pairs: [string | null, string | null][] = [[null, null]]; // both roots
  // For each matched (old id → new key), the old block's key is a potential
  // old-parent, the new block's key a potential new-parent.
  const oldById = new Map(state.old.map((b) => [b.blockId!, b]));
  for (const [newKey, oldId] of state.matched) {
    const oldB = oldById.get(oldId);
    if (oldB) pairs.push([oldB.key, newKey]);
  }
  return pairs;
}
