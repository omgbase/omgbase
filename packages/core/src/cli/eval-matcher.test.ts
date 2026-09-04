import { describe, it, expect } from "vitest";
import { evalMatcher, formatReport } from "./eval-matcher.js";

describe("omg eval-matcher", () => {
  it("runs the suite and reports gates passing", () => {
    const { report, text, gatesPass } = evalMatcher({ n: 150 });
    expect(report.cases).toBe(150);
    expect(text).toContain("OVERALL");
    expect(text).toContain("matcher_v=");
    expect(gatesPass).toBe(true);
  });

  it("formatReport renders per-class rows", () => {
    const { report } = evalMatcher({ n: 50 });
    const text = formatReport(report);
    expect(text).toMatch(/edit\s+precision=/);
  });
});
