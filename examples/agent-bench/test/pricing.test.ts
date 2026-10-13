import { describe, expect, it } from "vitest";
import { PRICING, bareModelId, costOf, fmtDollars, pricingFor, runCost } from "../src/pricing.ts";

describe("pricing", () => {
  it("keys the table by the bare Anthropic id, however the model was addressed", () => {
    expect(bareModelId("claude-opus-5")).toBe("claude-opus-5");
    expect(bareModelId("global.anthropic.claude-opus-5")).toBe("claude-opus-5");
    expect(bareModelId("us.anthropic.claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(bareModelId("eu.anthropic.claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(bareModelId("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(pricingFor("global.anthropic.claude-opus-5")).toBe(PRICING["claude-opus-5"]);
    expect(pricingFor("scripted")).toBeUndefined();
  });

  it("holds the list prices with cache reads at a tenth and cache writes at 1.25× of input", () => {
    for (const p of Object.values(PRICING)) {
      expect(p.cache_read).toBeCloseTo(p.input * 0.1);
      expect(p.cache_write).toBeCloseTo(p.input * 1.25);
    }
    expect(PRICING["claude-opus-5"]).toEqual({ input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 });
    expect(PRICING["claude-sonnet-5"]).toEqual({ input: 2, cache_read: 0.2, cache_write: 2.5, output: 10 });
  });

  it("prices a run from its four counters", () => {
    const million = { input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, output_tokens: 1_000_000 };
    expect(costOf(million, PRICING["claude-opus-5"]!)).toBeCloseTo(36.75);
    // the real run's minimal-profile cell: 28k uncached is the expensive part, 5.7k cached nearly free
    const turn = { input_tokens: 28_314, cache_read_input_tokens: 5_690, cache_creation_input_tokens: 0, output_tokens: 632 };
    expect(costOf(turn, PRICING["claude-opus-5"]!)).toBeCloseTo(0.141570 + 0.002845 + 0.0158, 6);
    expect(runCost({ ...turn, model: "global.anthropic.claude-opus-5" })).toBeCloseTo(0.160215, 6);
    expect(runCost({ ...turn, model: "scripted" })).toBeUndefined();
  });

  it("formats dollars to three significant places", () => {
    expect(fmtDollars(0.160215)).toBe("$0.160");
    expect(fmtDollars(9.2345)).toBe("$9.235");
    expect(fmtDollars(11.034)).toBe("$11.03");
    expect(fmtDollars(0)).toBe("$0.000");
  });
});
