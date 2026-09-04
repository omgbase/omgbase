import type { MatchBlock, Disposition, ReconcileConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { textSim, tokenCount } from "./similarity.js";
import type { DocReconcileResult } from "./reconcile.js";

// Cross-document move detection (03 §4 phase 6b). After each document is
// reconciled independently, pool the checkpoint's unmatched-DELETED blocks
// (all docs) against unmatched-INSERTED blocks (all docs) and match at θ_xdoc.
// A carried cross-doc block becomes moved / edited_moved and is REMOVED from
// the deleted set of its source doc.

export interface PerDocUnmatched {
  docId: string;
  /** old blocks that ended up deleted this run (id + content) */
  deleted: { block: MatchBlock }[];
  /** new blocks minted as 'inserted' this run (key + assigned id + content) */
  inserted: { block: MatchBlock; mintedId: string }[];
}

export interface CrossDocMatch {
  /** source doc where the block was deleted */
  fromDoc: string;
  /** destination doc where it reappeared */
  toDoc: string;
  /** the surviving id (the deleted block's id carries across) */
  carriedId: string;
  /** the minted id that should be REPLACED by carriedId */
  replacedMintedId: string;
  newKey: string;
  kind: "moved" | "edited_moved";
  confidence: number;
}

export function crossDocMatch(
  docs: PerDocUnmatched[],
  config: ReconcileConfig = DEFAULT_CONFIG,
): CrossDocMatch[] {
  // Pool everything.
  const deleted: { docId: string; block: MatchBlock }[] = [];
  const inserted: { docId: string; block: MatchBlock; mintedId: string }[] = [];
  for (const d of docs) {
    for (const del of d.deleted) deleted.push({ docId: d.docId, block: del.block });
    for (const ins of d.inserted) inserted.push({ docId: d.docId, block: ins.block, mintedId: ins.mintedId });
  }

  // Score all cross-doc pairs (same type), greedy accept ≥ θ_xdoc.
  interface Pair { di: number; ii: number; score: number }
  const pairs: Pair[] = [];
  for (let di = 0; di < deleted.length; di++) {
    for (let ii = 0; ii < inserted.length; ii++) {
      const o = deleted[di]!.block;
      const n = inserted[ii]!.block;
      if (o.type !== n.type) continue;
      // don't match within the same doc (that's the intra-doc matcher's job)
      if (deleted[di]!.docId === inserted[ii]!.docId) continue;
      const ratio = Math.max(tokenCount(o.text), tokenCount(n.text)) / Math.max(1, Math.min(tokenCount(o.text), tokenCount(n.text)));
      if (ratio > 3) continue;
      const score = textSim(o.text, n.text);
      if (score >= config.thetaXdoc) pairs.push({ di, ii, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.di - b.di || a.ii - b.ii);

  const usedDel = new Set<number>();
  const usedIns = new Set<number>();
  const matches: CrossDocMatch[] = [];
  for (const p of pairs) {
    if (usedDel.has(p.di) || usedIns.has(p.ii)) continue;
    usedDel.add(p.di);
    usedIns.add(p.ii);
    const o = deleted[p.di]!;
    const n = inserted[p.ii]!;
    const edited = o.block.rawHashHex !== n.block.rawHashHex;
    matches.push({
      fromDoc: o.docId,
      toDoc: n.docId,
      carriedId: o.block.blockId!,
      replacedMintedId: n.mintedId,
      newKey: n.block.key,
      kind: edited ? "edited_moved" : "moved",
      confidence: p.score,
    });
  }
  return matches;
}

/**
 * Apply cross-doc matches back into per-doc reconcile results: the destination
 * doc's minted 'inserted' id is replaced by the carried id (moved/edited_moved),
 * and the source doc's 'deleted' disposition for that id is dropped.
 */
export function applyCrossDocMatches(
  resultsByDoc: Map<string, DocReconcileResult>,
  matches: CrossDocMatch[],
  matcherV: string,
): void {
  for (const m of matches) {
    const dest = resultsByDoc.get(m.toDoc);
    const src = resultsByDoc.get(m.fromDoc);
    if (!dest || !src) continue;

    // Replace minted id with carried id in the destination assignment.
    dest.assignment.set(m.newKey, m.carriedId);
    // Drop the 'inserted' disposition for the minted id; add moved/edited_moved.
    dest.dispositions = dest.dispositions.filter((d: Disposition) => !(d.blockId === m.replacedMintedId && d.kind === "inserted"));
    dest.dispositions.push({ blockId: m.carriedId, kind: m.kind, confidence: m.confidence, reason: "scored", matcherV, detail: { fromDoc: m.fromDoc } });

    // Drop the 'deleted' disposition in the source doc.
    src.dispositions = src.dispositions.filter((d: Disposition) => !(d.blockId === m.carriedId && d.kind === "deleted"));
    src.deleted = src.deleted.filter((id: string) => id !== m.carriedId);
  }
}
