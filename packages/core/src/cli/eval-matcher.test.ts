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

describe("omg eval-matcher — structured mode", () => {
  it("runs the structured suite with threshold overrides and labels the header", () => {
    const { report, text } = evalMatcher({ n: 20, mode: "structured", itemWords: 5, contextSimFloor: 0.3 });
    expect(report.mode).toBe("structured");
    expect(report.config.contextSimFloor).toBe(0.3);
    expect(text).toContain("mode=structured");
    expect(text).toMatch(/item-edit-mid\s+precision=/);
  });

  it("default output does not mention the mode", () => {
    const { text } = evalMatcher({ n: 5 });
    expect(text).not.toContain("mode=");
  });
});
