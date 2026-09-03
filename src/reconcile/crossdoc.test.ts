import { describe, it, expect } from "vitest";
import { reconcileDocument } from "./reconcile.js";
import { flatten, type FlatSource } from "./flatten.js";
import { crossDocMatch, applyCrossDocMatches, type PerDocUnmatched } from "./crossdoc.js";
import { DEFAULT_CONFIG, type MatchBlock } from "./types.js";
import type { DocReconcileResult } from "./reconcile.js";

function tree(pairs: [string | undefined, string][]): FlatSource[] {
  return pairs.map(([blockId, raw]) => ({ ...(blockId ? { blockId } : {}), type: "paragraph", raw, children: [] }));
}

// Extract per-doc unmatched sets from a reconcile result for the cross-doc pass.
function unmatched(docId: string, oldFlat: MatchBlock[], newFlat: MatchBlock[], res: DocReconcileResult): PerDocUnmatched {
  const oldById = new Map(oldFlat.map((b) => [b.blockId!, b]));
  const newByKey = new Map(newFlat.map((b) => [b.key, b]));
  return {
    docId,
    deleted: res.deleted.map((id) => ({ block: oldById.get(id)! })),
    inserted: res.dispositions
      .filter((d) => d.kind === "inserted")
      .map((d) => {
        // find the new key assigned to this minted id
        const entry = [...res.assignment.entries()].find(([, v]) => v === d.blockId)!;
        return { block: newByKey.get(entry[0])!, mintedId: d.blockId };
      }),
  };
}

describe("cross-document move (phase 6b)", () => {
  it("cut-paste across files carries identity as moved", () => {
    // doc A loses a paragraph; doc B gains the same paragraph.
    const movedText = "this whole paragraph gets cut from file a and pasted into file b intact";

    const aOld = flatten(tree([["b_keep", "file a keeps this"], ["b_move", movedText]]));
    const aNew = flatten(tree([[undefined, "file a keeps this"]]));
    const aRes = reconcileDocument(aOld, aNew);

    const bOld = flatten(tree([["b_bkeep", "file b original line"]]));
    const bNew = flatten(tree([[undefined, "file b original line"], [undefined, movedText]]));
    const bRes = reconcileDocument(bOld, bNew);

    // Before cross-doc: b_move deleted in A, movedText minted+inserted in B.
    expect(aRes.deleted).toContain("b_move");

    const perDoc = [
      unmatched("A", aOld, aNew, aRes),
      unmatched("B", bOld, bNew, bRes),
    ];
    const matches = crossDocMatch(perDoc);
    expect(matches.length).toBe(1);
    expect(matches[0]!.carriedId).toBe("b_move");
    expect(matches[0]!.kind).toBe("moved");

    const byDoc = new Map<string, DocReconcileResult>([["A", aRes], ["B", bRes]]);
    applyCrossDocMatches(byDoc, matches, DEFAULT_CONFIG.matcherV);

    // After: B's paragraph carries b_move; A no longer reports it deleted.
    expect([...bRes.assignment.values()]).toContain("b_move");
    expect(aRes.deleted).not.toContain("b_move");
    expect(bRes.dispositions.find((d) => d.blockId === "b_move")!.kind).toBe("moved");
  });

  it("does not match within the same document", () => {
    const perDoc: PerDocUnmatched[] = [{
      docId: "A",
      deleted: [{ block: flatten(tree([["b_1", "some paragraph text here to match"]]))[0]! }],
      inserted: [{ block: flatten(tree([[undefined, "some paragraph text here to match"]]))[0]!, mintedId: "b_new" }],
    }];
    expect(crossDocMatch(perDoc)).toHaveLength(0);
  });
});
