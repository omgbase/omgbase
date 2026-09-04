import { describe, it, expect } from "vitest";
import { phase1Exact, phase2Normalized, phase3Anchor, phase4Context, type PhaseState } from "./phases.js";
import { DEFAULT_CONFIG, type MatchBlock } from "./types.js";
import { sha256, normalizeVisibleText } from "../core/hash.js";

// Build a top-level MatchBlock from raw text (old blocks carry an id).
function mb(raw: string, index: number, opts: { id?: string; type?: string; anchors?: string[] } = {}): MatchBlock {
  const type = opts.type ?? "paragraph";
  const text = normalizeVisibleText(raw, type);
  const block: MatchBlock = {
    type,
    rawHashHex: sha256(raw).toString("hex"),
    normHashHex: sha256(text).toString("hex"),
    text,
    anchors: opts.anchors ?? [],
    parentKey: null,
    index,
    key: `/${index}`,
  };
  if (opts.id) block.blockId = opts.id;
  return block;
}

function state(old: MatchBlock[], neu: MatchBlock[]): PhaseState {
  return { old, neu, matched: new Map(), usedOld: new Set(), usedNew: new Set(), dispositions: [], config: DEFAULT_CONFIG };
}

describe("phase 1 — exact raw-hash lock", () => {
  it("carries identical blocks with confidence 1.0", () => {
    const s = state(
      [mb("Hello world.", 0, { id: "b_1" }), mb("Second.", 1, { id: "b_2" })],
      [mb("Hello world.", 0), mb("Second.", 1)],
    );
    phase1Exact(s);
    expect(s.matched.get("/0")).toBe("b_1");
    expect(s.matched.get("/1")).toBe("b_2");
    expect(s.dispositions.every((d) => d.reason === "exact_hash" && d.confidence === 1)).toBe(true);
    expect(s.dispositions.every((d) => d.kind === "same")).toBe(true);
  });

  it("does not carry across a type change (R2)", () => {
    const s = state([mb("Text", 0, { id: "b_1", type: "paragraph" })], [mb("Text", 0, { type: "heading" })]);
    phase1Exact(s);
    expect(s.matched.size).toBe(0);
  });

  it("marks a moved block when position differs", () => {
    const s = state(
      [mb("A", 0, { id: "b_1" }), mb("B", 1, { id: "b_2" })],
      [mb("B", 0), mb("A", 1)],
    );
    phase1Exact(s);
    expect(s.dispositions.find((d) => d.blockId === "b_1")!.kind).toBe("moved");
  });
});

describe("phase 2 — normalized lock", () => {
  it("carries blocks differing only in whitespace with confidence 0.99 (edited)", () => {
    const s = state([mb("Hello   world.", 0, { id: "b_1" })], [mb("Hello world.", 0)]);
    phase2Normalized(s);
    const d = s.dispositions[0]!;
    expect(s.matched.get("/0")).toBe("b_1");
    expect(d.reason).toBe("normalized_hash");
    expect(d.confidence).toBe(0.99);
    expect(d.kind).toBe("edited");
  });
});

describe("phase 3 — anchor lock", () => {
  it("pairs blocks sharing a unique anchor even when text changed", () => {
    const s = state(
      [mb("Old text about risks", 0, { id: "b_1", anchors: ["^risk-1"] })],
      [mb("Completely rewritten risk statement", 0, { anchors: ["^risk-1"] })],
    );
    phase3Anchor(s);
    expect(s.matched.get("/0")).toBe("b_1");
    expect(s.dispositions[0]!.reason).toBe("anchor");
  });
});

describe("phase 4 — context propagation", () => {
  it("pairs the lone unmatched child between matched neighbors", () => {
    // b_1 and b_3 lock exactly; b_2 (edited) is the lone survivor and carries.
    const s = state(
      [mb("Heading", 0, { id: "b_1", type: "heading" }), mb("Stable block identity is difficult.", 1, { id: "b_2" }), mb("Tail.", 2, { id: "b_3" })],
      [mb("Heading", 0, { type: "heading" }), mb("Stable block identity is quite difficult.", 1), mb("Tail.", 2)],
    );
    phase1Exact(s);
    expect(s.matched.has("/1")).toBe(false); // survives phase 1
    phase4Context(s);
    expect(s.matched.get("/1")).toBe("b_2");
    expect(s.dispositions.find((d) => d.blockId === "b_2")!.reason).toBe("context_unique");
  });

  it("does not pair when text_sim is below the floor", () => {
    const s = state(
      [mb("Heading", 0, { id: "b_1", type: "heading" }), mb("apple banana cherry date", 1, { id: "b_2" }), mb("Tail.", 2, { id: "b_3" })],
      [mb("Heading", 0, { type: "heading" }), mb("xylophone quartz nebula fjord", 1), mb("Tail.", 2)],
    );
    phase1Exact(s);
    phase4Context(s);
    expect(s.matched.has("/1")).toBe(false);
  });
});
