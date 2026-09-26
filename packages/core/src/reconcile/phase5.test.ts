import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { phase1Exact, phase2Normalized, phase3Anchor, phase4Context, type PhaseState } from "./phases.js";
import { phase5Scored } from "./phase5.js";
import { DEFAULT_CONFIG, type MatchBlock } from "./types.js";
import { flatten } from "./flatten.js";
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

  it("m2.1: a sub-threshold tiny-block candidate is skipped, not a stopping point (spec §10)", () => {
    // The tiny block's candidate (text_sim 1 by case folding) scores 0.75 and
    // sorts first, but its θ is θ_small (0.80). The regular paragraph behind it
    // scores 0.55 × 0.875 + 0.10 + 0.10 = 0.68125 ≥ θ_accept and must still carry.
    const s = state(
      [mb("cat dog bird", 0, { id: "b_1" }), mb("one two three four five six seven eight nine ten", 1, { id: "b_2" })],
      [mb("Cat Dog Bird", 0), mb("one two three four five six seven eight nine eleven", 1)],
    );
    runAll(s);
    expect(s.matched.has("/0")).toBe(false);
    expect(s.matched.get("/1")).toBe("b_2");
    const d = s.dispositions.find((x) => x.blockId === "b_2")!;
    expect(d.reason).toBe("scored");
    expect(d.confidence).toBeCloseTo(0.68125, 9);
  });

  it("m2.1: position_prior is over the block's sibling count, not the flattened list size (spec §10)", () => {
    // Five ten-token items; the 2nd and 4th have two adjacent mid-item tokens
    // changed (text_sim 0.5). Two paragraphs are inserted above the list, so
    // the flattened sizes differ (6 old vs 8 new) while every item keeps its
    // index among five siblings. The list carries by context and the untouched
    // items lock, so each edited item scores 0.275 + 0.15 + 0.10 + 0.10 × prior.
    // Sibling-count prior: 1 → 0.625 ≥ 0.62, carry. The m2.0 whole-list prior
    // gave 0.943 / 0.829 → 0.619 / 0.608, and both items minted.
    const items = (b: string, d: string) => [
      "apple banana cherry date elder fig grape honey iris jade",
      b,
      "umber violet wheat xenon yarrow zinc amber bronze copper delta",
      d,
      "oscar papa quebec romeo sierra tango uniform victor whiskey xray",
    ];
    const oldItems = items("kite lemon mango nectar olive peach quince rasp sage thyme", "echo fox golf hotel india juliet kilo lima mike november");
    const newItems = items("kite lemon mango nectarine olivine peach quince rasp sage thyme", "echo fox golf hostel indigo juliet kilo lima mike november");
    const list = (raws: string[], ids?: string[]) => ({
      ...(ids ? { blockId: "b_list" } : {}),
      type: "list",
      raw: raws.map((r) => `- ${r}`).join("\n"),
      children: raws.map((r, i) => ({ ...(ids ? { blockId: ids[i]! } : {}), type: "list_item", raw: `- ${r}`, children: [] })),
    });
    const old = flatten([list(oldItems, ["b_1", "b_2", "b_3", "b_4", "b_5"])]);
    const neu = flatten([
      { type: "paragraph", raw: "Intro paragraph one.", children: [] },
      { type: "paragraph", raw: "Intro paragraph two.", children: [] },
      list(newItems),
    ]);
    const s = state(old, neu);
    runAll(s);
    expect(s.matched.get("/2")).toBe("b_list");
    expect(s.matched.get("/2/1")).toBe("b_2");
    expect(s.matched.get("/2/3")).toBe("b_4");
    for (const id of ["b_2", "b_4"]) {
      const d = s.dispositions.find((x) => x.blockId === id)!;
      expect(d.reason).toBe("scored");
      expect(d.confidence).toBeCloseTo(0.625, 9);
    }
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
