import { describe, it, expect } from "vitest";
import { phase1Exact, type PhaseState } from "./phases.js";
import { phase6aCompound } from "./phase6a.js";
import { DEFAULT_CONFIG, type MatchBlock, type ReconcileConfig } from "./types.js";
import { sha256, normalizeVisibleText } from "../core/hash.js";

function mb(raw: string, index: number, opts: { id?: string; type?: string } = {}): MatchBlock {
  const type = opts.type ?? "paragraph";
  const text = normalizeVisibleText(raw, type);
  const b: MatchBlock = {
    type, rawHashHex: sha256(raw).toString("hex"), normHashHex: sha256(text).toString("hex"),
    text, anchors: [], parentKey: null, index, key: `/${index}`,
  };
  if (opts.id) b.blockId = opts.id;
  return b;
}
function state(old: MatchBlock[], neu: MatchBlock[], config: ReconcileConfig = DEFAULT_CONFIG): PhaseState {
  return { old, neu, matched: new Map(), usedOld: new Set(), usedNew: new Set(), dispositions: [], config };
}

describe("phase 6a — split", () => {
  it("dominant first fragment carries the old id; rest are split_from", () => {
    const s = state(
      [mb("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", 0, { id: "b_1" })],
      [
        mb("alpha beta gamma delta epsilon zeta eta theta iota", 0),
        mb("kappa lambda mu", 1),
      ],
    );
    phase6aCompound(s);
    expect(s.matched.get("/0")).toBe("b_1"); // dominant fragment carries
    const splitDisp = s.dispositions.find((d) => d.kind === "split_from");
    expect(splitDisp).toBeTruthy();
    expect(splitDisp!.detail.counterpart).toBe("b_1");
  });

  it("disable flag (dominant_share = 1.01) mints all fragments, old deleted", () => {
    const s = state(
      [mb("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", 0, { id: "b_1" })],
      [mb("alpha beta gamma delta epsilon zeta", 0), mb("eta theta iota kappa lambda mu", 1)],
      { ...DEFAULT_CONFIG, splitDominantShare: 1.01 },
    );
    phase6aCompound(s);
    expect(s.matched.has("/0")).toBe(false); // no carry
    expect(s.dispositions.find((d) => d.blockId === "b_1")!.kind).toBe("deleted");
    expect(s.dispositions.filter((d) => d.kind === "split_from").length).toBe(2);
  });
});

describe("phase 6a — every split per run (m2.1, spec §10)", () => {
  it("two old paragraphs each split into quarters both resolve as splits", () => {
    const s = state(
      [
        mb("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", 0, { id: "b_1" }),
        mb("one two three four five six seven eight nine ten eleven twelve", 1, { id: "b_2" }),
      ],
      [
        mb("alpha beta gamma", 0), mb("delta epsilon zeta", 1), mb("eta theta iota", 2), mb("kappa lambda mu", 3),
        mb("one two three", 4), mb("four five six", 5), mb("seven eight nine", 6), mb("ten eleven twelve", 7),
      ],
    );
    phase6aCompound(s);
    // Non-dominant (first quarter holds 3/12 of the tokens): both tombstoned with splitInto.
    const d1 = s.dispositions.find((d) => d.blockId === "b_1")!;
    const d2 = s.dispositions.find((d) => d.blockId === "b_2")!;
    expect(d1.kind).toBe("deleted");
    expect(d1.detail.splitInto).toEqual(["/0", "/1", "/2", "/3"]);
    expect(d2.kind).toBe("deleted"); // m2.0 returned after the first split and left b_2 to phase 7
    expect(d2.detail.splitInto).toEqual(["/4", "/5", "/6", "/7"]);
    const lineage = s.dispositions.filter((d) => d.kind === "split_from");
    expect(lineage.length).toBe(8);
    expect(lineage.filter((d) => d.detail.counterpart === "b_2").map((d) => d.detail.newKey)).toEqual(["/4", "/5", "/6", "/7"]);
  });

  it("two merges in one document both resolve", () => {
    const s = state(
      [
        mb("alpha beta gamma delta epsilon zeta eta theta iota", 0, { id: "b_1" }),
        mb("kappa lambda mu", 1, { id: "b_2" }),
        mb("one two three four five six seven eight nine", 2, { id: "b_3" }),
        mb("ten eleven twelve", 3, { id: "b_4" }),
      ],
      [
        mb("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", 0),
        mb("one two three four five six seven eight nine ten eleven twelve", 1),
      ],
    );
    phase6aCompound(s);
    expect(s.matched.get("/0")).toBe("b_1");
    expect(s.dispositions.find((d) => d.blockId === "b_2")!.kind).toBe("merged_into");
    expect(s.matched.get("/1")).toBe("b_3"); // m2.0 returned after the first merge
    expect(s.dispositions.find((d) => d.blockId === "b_4")!.kind).toBe("merged_into");
  });
});

describe("phase 6a — merge", () => {
  it("dominant contributor carries; others merged_into", () => {
    const s = state(
      [
        mb("alpha beta gamma delta epsilon zeta eta theta iota", 0, { id: "b_1" }),
        mb("kappa lambda mu", 1, { id: "b_2" }),
      ],
      [mb("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", 0)],
    );
    phase6aCompound(s);
    expect(s.matched.get("/0")).toBe("b_1");
    expect(s.dispositions.find((d) => d.blockId === "b_2")!.kind).toBe("merged_into");
  });
});

describe("phase 6a — copy", () => {
  it("a near-duplicate of a matched block mints with copied_from lineage", () => {
    const dup = "shared reusable sentence that appears twice within this rather long document body spanning many tokens indeed here";
    const s = state(
      [mb(dup, 0, { id: "b_1" })],
      [
        mb(dup, 0), // exact → matched in phase 1
        mb(dup + " today", 1), // copy (≥0.95 sim: one extra token over a long sentence)
      ],
    );
    phase1Exact(s); // locks new[0] to b_1
    phase6aCompound(s);
    const copyDisp = s.dispositions.find((d) => d.kind === "copied_from");
    expect(copyDisp).toBeTruthy();
    expect(copyDisp!.detail.counterpart).toBe("b_1");
    // copy never steals identity: b_1 stays with new[0]
    expect(s.matched.get("/0")).toBe("b_1");
  });
});
