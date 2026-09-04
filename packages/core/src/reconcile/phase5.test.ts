import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { phase1Exact, phase2Normalized, phase3Anchor, phase4Context, type PhaseState } from "./phases.js";
import { phase5Scored } from "./phase5.js";
import { DEFAULT_CONFIG, type MatchBlock } from "./types.js";
import { sha256, normalizeVisibleText } from "../core/hash.js";

function mb(raw: string, index: number, opts: { id?: string; type?: string; parentKey?: string | null } = {}): MatchBlock {
  const type = opts.type ?? "paragraph";
  const text = normalizeVisibleText(raw, type);
  const parentKey = opts.parentKey ?? null;
  const block: MatchBlock = {
    type,
    rawHashHex: sha256(raw).toString("hex"),
    normHashHex: sha256(text).toString("hex"),
    text,
    anchors: [],
    parentKey,
    index,
    key: `${parentKey ?? ""}/${index}`,
  };
  if (opts.id) block.blockId = opts.id;
  return block;
}

function state(old: MatchBlock[], neu: MatchBlock[]): PhaseState {
  return { old, neu, matched: new Map(), usedOld: new Set(), usedNew: new Set(), dispositions: [], config: DEFAULT_CONFIG };
}

function runAll(s: PhaseState): void {
  phase1Exact(s);
  phase2Normalized(s);
  phase3Anchor(s);
  phase4Context(s);
  phase5Scored(s);
}

describe("phase 5 — scored assignment", () => {
  it("carries edited paragraphs via score when >1 block is unmatched (phase 4 can't)", () => {
    // Two adjacent edited paragraphs: phase 4's "exactly one unmatched child"
    // condition fails, so phase 5's scoring must resolve both by text overlap.
    const s = state(
      [
        mb("the quick brown fox jumps over the lazy dog every single morning here now while birds sing softly above the field", 0, { id: "b_1" }),
        mb("a separate second paragraph discussing entirely different subject matter today with many words to raise the shingle overlap count high", 1, { id: "b_2" }),
      ],
      [
        mb("the quick brown fox jumps over the lazy dog every single evening here now while birds sing softly above the field", 0),
        mb("a separate second paragraph discussing entirely different subject matter tomorrow with many words to raise the shingle overlap count high", 1),
      ],
    );
    runAll(s);
    expect(s.matched.get("/0")).toBe("b_1");
    expect(s.matched.get("/1")).toBe("b_2");
    expect(s.dispositions.find((d) => d.blockId === "b_1")!.reason).toBe("scored");
  });

  it("applies θ_small to tiny blocks (harder to accept)", () => {
    const s = state([mb("cat dog", 0, { id: "b_1" })], [mb("cat fish", 0)]);
    runAll(s);
    // 2-token blocks with 1 shared token: dice below θ_small (0.80) ⇒ not carried.
    expect(s.matched.has("/0")).toBe(false);
  });
});

describe("hard rules R1–R3 (property test)", () => {
  it("never violates R1 (id used once), R2 (type gate), R3 (no order crossing)", () => {
    const blockArb = fc.record({
      text: fc.stringMatching(/^[a-z]{2,8}( [a-z]{2,8}){0,6}$/),
      type: fc.constantFrom("paragraph", "heading", "code_fence"),
    });

    fc.assert(
      fc.property(
        fc.array(blockArb, { minLength: 1, maxLength: 8 }),
        fc.array(blockArb, { minLength: 1, maxLength: 8 }),
        (oldSpecs, newSpecs) => {
          const old = oldSpecs.map((sp, i) => mb(sp.text, i, { id: `b_o${i}`, type: sp.type }));
          const neu = newSpecs.map((sp, i) => mb(sp.text, i, { type: sp.type }));
          const s = state(old, neu);
          runAll(s);

          // R1: each old id appears at most once as a value.
          const usedIds = [...s.matched.values()];
          expect(new Set(usedIds).size).toBe(usedIds.length);

          // R2: every carry pairs same-type blocks.
          const oldById = new Map(old.map((b) => [b.blockId!, b]));
          const newByKey = new Map(neu.map((b) => [b.key, b]));
          for (const [newKey, oldId] of s.matched) {
            expect(oldById.get(oldId)!.type).toBe(newByKey.get(newKey)!.type);
          }

          // R3: within a parent, matched pairs preserve relative order unless moved.
          // Here all blocks are top-level; check non-crossing among non-"moved" carries.
          const pairs = [...s.matched.entries()]
            .map(([newKey, oldId]) => ({ o: oldById.get(oldId)!, n: newByKey.get(newKey)! }))
            .filter(({ o, n }) => {
              const disp = s.dispositions.find((d) => d.blockId === o.blockId);
              return disp && disp.kind !== "moved" && disp.kind !== "edited_moved" && o.parentKey === n.parentKey;
            })
            .sort((a, b) => a.o.index - b.o.index);
          for (let i = 1; i < pairs.length; i++) {
            expect(pairs[i]!.n.index).toBeGreaterThanOrEqual(pairs[i - 1]!.n.index);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
