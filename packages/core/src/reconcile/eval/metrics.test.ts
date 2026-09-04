import { describe, it, expect } from "vitest";
import { runEval } from "./metrics.js";
import { generateCase } from "./generator.js";
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
});
