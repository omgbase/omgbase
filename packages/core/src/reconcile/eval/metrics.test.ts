import { describe, it, expect } from "vitest";
import { runEval } from "./metrics.js";
import { generateCase, generateStructuredCase, STRUCTURED_ITEM_CLASSES } from "./generator.js";
import { DEFAULT_CONFIG } from "../types.js";

describe("eval harness", () => {
  it("generateCase is deterministic for a seed", () => {
    const a = generateCase(42);
    const b = generateCase(42);
    expect(a.neu.map((x) => x.rawHashHex)).toEqual(b.neu.map((x) => x.rawHashHex));
    expect([...a.truth.carries.entries()]).toEqual([...b.truth.carries.entries()]);
  });

  it("produces a metrics report with overall + per-class precision/recall", () => {
    const report = runEval({ n: 100, config: DEFAULT_CONFIG });
    expect(report.cases).toBe(100);
    expect(report.mode).toBe("flat");
    expect(report.overall.precision).toBeGreaterThan(0);
    expect(report.overall.recall).toBeGreaterThan(0);
    // sanity: precision/recall are in [0,1]
    for (const m of [report.overall, ...Object.values(report.perClass)]) {
      expect(m.precision).toBeGreaterThanOrEqual(0);
      expect(m.precision).toBeLessThanOrEqual(1);
      expect(m.recall).toBeGreaterThanOrEqual(0);
      expect(m.recall).toBeLessThanOrEqual(1);
    }
  });

  it("meets the precision gate (>= 0.995 overall) — asymmetric loss (R4)", () => {
    const report = runEval({ n: 300, config: DEFAULT_CONFIG });
    expect(report.overall.precision).toBeGreaterThanOrEqual(0.995);
    // Recall gates for the reliable classes.
    for (const cls of ["edit", "move", "reorder"] as const) {
      const m = report.perClass[cls];
      if (m) expect(m.recall).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("configOverrides layer on top of the config and are echoed back", () => {
    const report = runEval({ n: 5, configOverrides: { contextSimFloor: 0.3 } });
    expect(report.config.contextSimFloor).toBe(0.3);
    expect(report.config.thetaAccept).toBe(DEFAULT_CONFIG.thetaAccept);
    expect(runEval({ n: 5 }).config).toEqual(DEFAULT_CONFIG);
  });
});

describe("eval harness — structured mode", () => {
  it("generateStructuredCase is deterministic for a seed and options", () => {
    const a = generateStructuredCase(42, { itemWords: 4 });
    const b = generateStructuredCase(42, { itemWords: 4 });
    expect(a.neu.map((x) => [x.key, x.type, x.rawHashHex])).toEqual(b.neu.map((x) => [x.key, x.type, x.rawHashHex]));
    expect([...a.truth.carries.entries()]).toEqual([...b.truth.carries.entries()]);
    expect([...a.truth.classOf.entries()]).toEqual([...b.truth.classOf.entries()]);
    expect([...a.truth.deleted]).toEqual([...b.truth.deleted]);
    // A different seed produces a different document.
    expect(generateStructuredCase(43, { itemWords: 4 }).old.map((x) => x.rawHashHex)).not.toEqual(a.old.map((x) => x.rawHashHex));
  });

  it("builds well-formed trees whose text follows spec/format §4.1 and whose truth is consistent", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const c = generateStructuredCase(seed, { itemWords: 2 + (seed % 5) });
      for (const side of [c.old, c.neu]) {
        const byKey = new Map(side.map((b) => [b.key, b]));
        for (const b of side) {
          // positional key = parentKey + '/' + index, parent present
          expect(b.key).toBe(`${b.parentKey ?? ""}/${b.index}`);
          if (b.parentKey !== null) expect(byKey.has(b.parentKey)).toBe(true);
          const children = side.filter((x) => x.parentKey === b.key);
          if (b.type === "list") {
            expect(children.length).toBeGreaterThan(0);
            expect(children.every((x) => x.type === "list_item")).toBe(true);
            // container text = children's texts joined by one space; raw = item raws joined by \n
            expect(b.text).toBe(children.map((x) => x.text).join(" "));
          } else if (b.type === "list_item" && children.length > 0) {
            expect(children.map((x) => x.type)).toEqual(["paragraph", "list"]);
            expect(b.text).toBe(children.map((x) => x.text).join(" "));
          } else {
            expect(b.text.length).toBeGreaterThan(0);
          }
        }
      }
      // every old block has an id; no new block does
      expect(c.old.every((b) => typeof b.blockId === "string")).toBe(true);
      expect(c.neu.every((b) => b.blockId === undefined)).toBe(true);
      // truth: carries point at old ids, keys exist in new, classes cover every new key,
      // deleted ∪ carried = old ids exactly
      const oldIds = new Set(c.old.map((b) => b.blockId!));
      const newKeys = new Set(c.neu.map((b) => b.key));
      const carried = new Set<string>();
      for (const [key, id] of c.truth.carries) {
        expect(newKeys.has(key)).toBe(true);
        expect(oldIds.has(id)).toBe(true);
        expect(carried.has(id)).toBe(false);
        carried.add(id);
      }
      for (const key of newKeys) expect(c.truth.classOf.has(key)).toBe(true);
      for (const id of oldIds) expect(carried.has(id) !== c.truth.deleted.has(id)).toBe(true);
      // minted classes never carry; carried classes always do
      for (const [key, cls] of c.truth.classOf) {
        if (cls === "item-insert" || cls === "nested-new") expect(c.truth.carries.has(key)).toBe(false);
        else expect(c.truth.carries.has(key)).toBe(true);
      }
    }
  });

  it("exercises every item class and reports nested keys per class", () => {
    const report = runEval({ n: 150, mode: "structured" });
    expect(report.mode).toBe("structured");
    for (const cls of STRUCTURED_ITEM_CLASSES) {
      if (cls === "item-delete") continue; // deletions have no new key; they show up in report.deleted
      const m = report.perClass[cls];
      expect(m, cls).toBeDefined();
      expect(m!.newBlocks).toBeGreaterThan(0);
    }
    expect(report.perClass["list"]!.truePairs).toBeGreaterThan(0);
    expect(report.perClass["nested-new"]!.truePairs).toBe(0);
    expect(report.deleted.expected).toBeGreaterThan(0);
    for (const m of [report.overall, ...Object.values(report.perClass)]) {
      expect(m.precision).toBeGreaterThanOrEqual(0);
      expect(m.precision).toBeLessThanOrEqual(1);
      expect(m.recall).toBeGreaterThanOrEqual(0);
      expect(m.recall).toBeLessThanOrEqual(1);
    }
    // Sanity, not a gate: untouched blocks and unchanged-text items lock exactly.
    expect(report.perClass["same"]!.recall).toBe(1);
    expect(report.perClass["item-move"]!.recall).toBe(1);
    expect(report.perClass["item-reorder"]!.recall).toBe(1);
    expect(report.overall.precision).toBeGreaterThan(0.99);
  });
});
