import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { reconcileDocument, type ResurrectionCandidate } from "./reconcile.js";
import { flatten, type FlatSource } from "./flatten.js";
import { DEFAULT_CONFIG } from "./types.js";
import { sha256, normalizeVisibleText } from "../core/hash.js";

// Build a flat "old" tree with assigned ids from [id, raw] pairs (top-level).
function oldTree(pairs: [string, string][]): FlatSource[] {
  return pairs.map(([blockId, raw]) => ({ blockId, type: "paragraph", raw, children: [] }));
}
function newTree(raws: string[], type = "paragraph"): FlatSource[] {
  return raws.map((raw) => ({ type, raw, children: [] }));
}

describe("reconcileDocument — end to end", () => {
  it("brief example (03 §10): insertion mints, edited paragraph carries", () => {
    const old = flatten([
      { blockId: "b_h", type: "heading", raw: "## Risks", children: [] },
      { blockId: "b_p1", type: "paragraph", raw: "Stable block identity is difficult.", children: [] },
      { blockId: "b_p2", type: "paragraph", raw: "Another paragraph.", children: [] },
    ]);
    const neu = flatten([
      { type: "heading", raw: "## Risks", children: [] },
      { type: "paragraph", raw: "A newly inserted paragraph.", children: [] },
      { type: "paragraph", raw: "Stable block identity is quite difficult.", children: [] },
      { type: "paragraph", raw: "Another paragraph.", children: [] },
    ]);
    const res = reconcileDocument(old, neu);

    // heading and "Another paragraph." carry via exact hash.
    expect(res.assignment.get("/0")).toBe("b_h");
    expect(res.assignment.get("/3")).toBe("b_p2");
    // The edited paragraph carries b_p1 (at its new position /2).
    expect(res.assignment.get("/2")).toBe("b_p1");
    // The inserted paragraph is minted (not b_p1) with kind inserted.
    const insertedId = res.assignment.get("/1")!;
    expect(insertedId).not.toBe("b_p1");
    expect(res.dispositions.find((d) => d.blockId === insertedId)!.kind).toBe("inserted");
  });

  it("deletes an old block that vanished", () => {
    const old = flatten(oldTree([["b_1", "keep this line"], ["b_2", "delete this line"]]));
    const neu = flatten(newTree(["keep this line"]));
    const res = reconcileDocument(old, neu);
    expect(res.assignment.get("/0")).toBe("b_1");
    expect(res.deleted).toEqual(["b_2"]);
    expect(res.dispositions.find((d) => d.blockId === "b_2")!.kind).toBe("deleted");
  });

  it("resurrects a block from the pool by exact hash", () => {
    const raw = "a resurrected paragraph from a prior checkpoint";
    const pool: ResurrectionCandidate[] = [{
      blockId: "b_old",
      rawHashHex: sha256(raw).toString("hex"),
      normHashHex: sha256(normalizeVisibleText(raw, "paragraph")).toString("hex"),
      type: "paragraph",
    }];
    const old = flatten(oldTree([["b_1", "existing content here"]]));
    const neu = flatten(newTree(["existing content here", raw]));
    const res = reconcileDocument(old, neu, { pool });
    expect(res.assignment.get("/1")).toBe("b_old");
    expect(res.consumedPool).toEqual(["b_old"]);
    expect(res.dispositions.find((d) => d.blockId === "b_old")!.kind).toBe("resurrected");
  });

  it("bulk-rewrite give-up on a mostly-rewritten large document", () => {
    const oldPairs: [string, string][] = Array.from({ length: 120 }, (_, i) => [`b_${i}`, `original sentence number ${i} with distinct words`]);
    const newRaws = Array.from({ length: 120 }, (_, i) => `completely fresh replacement text alpha${i} beta${i} gamma${i} unrelated`);
    const res = reconcileDocument(flatten(oldTree(oldPairs)), flatten(newTree(newRaws)));
    expect(res.dispositions.some((d) => d.kind === "bulk_rewrite")).toBe(true);
    expect(res.deleted.length).toBe(120);
  });

  it("m2.1: a non-dominant split tombstone is listed in `deleted` (spec §10)", () => {
    // split_dominant_share 1.01 disables inheritance: the split old block gets a
    // `deleted` disposition with splitInto and must be in `deleted` (old document
    // order, after the plainly deleted b_0) so it can enter the resurrection pool.
    const old = flatten(oldTree([["b_0", "zzz yyy"], ["b_1", "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu"]]));
    const neu = flatten(newTree(["alpha beta gamma delta epsilon zeta eta theta iota", "kappa lambda mu"]));
    const res = reconcileDocument(old, neu, { config: { ...DEFAULT_CONFIG, splitDominantShare: 1.01 } });
    const d = res.dispositions.find((x) => x.blockId === "b_1")!;
    expect(d.kind).toBe("deleted");
    expect(d.detail.splitInto).toEqual(["/0", "/1"]);
    expect(res.deleted).toEqual(["b_0", "b_1"]);
    expect(res.dispositions.filter((x) => x.kind === "split_from").length).toBe(2);
  });

  it("stamps matcher_v = \"m\" + spec/reconcile/VERSION on every disposition", () => {
    const version = readFileSync(fileURLToPath(new URL("../../../../spec/reconcile/VERSION", import.meta.url)), "utf8").trim();
    expect(DEFAULT_CONFIG.matcherV).toBe(`m${version}`);
    const res = reconcileDocument(flatten(oldTree([["b_1", "keep this line"]])), flatten(newTree(["keep this line", "a new line"])));
    expect(res.dispositions.map((d) => d.matcherV)).toEqual(["m2.1", "m2.1"]);
  });

  it("is deterministic: identical inputs yield identical assignments", () => {
    const old = flatten(oldTree([["b_1", "the first paragraph text"], ["b_2", "the second paragraph text"]]));
    const build = () => reconcileDocument(
      flatten(oldTree([["b_1", "the first paragraph text"], ["b_2", "the second paragraph text"]])),
      flatten(newTree(["the first paragraph text", "the second paragraph text"])),
    );
    const a = build();
    const b = build();
    // carried ids are stable (minted ids differ, but carries must match)
    expect(a.assignment.get("/0")).toBe("b_1");
    expect(b.assignment.get("/0")).toBe("b_1");
    void old;
  });
});
