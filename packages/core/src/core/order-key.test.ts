import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { keyBetween, sequentialKeys } from "./order-key.js";

describe("keyBetween", () => {
  it("produces strictly increasing sequential append keys", () => {
    const keys = sequentialKeys(200);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1]! < keys[i]!).toBe(true);
    }
  });

  it("inserts strictly between two adjacent keys", () => {
    const keys = sequentialKeys(10);
    const mid = keyBetween(keys[3]!, keys[4]!);
    expect(keys[3]! < mid).toBe(true);
    expect(mid < keys[4]!).toBe(true);
  });

  it("handles open bounds", () => {
    const first = keyBetween(null, null);
    const before = keyBetween(null, first);
    const after = keyBetween(first, null);
    expect(before < first).toBe(true);
    expect(first < after).toBe(true);
  });

  it("rejects inverted bounds", () => {
    expect(() => keyBetween("Z", "A")).toThrow();
  });

  it("property: repeated midpoint insertion stays ordered", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (n) => {
        let lo = keyBetween(null, null);
        let hi = keyBetween(lo, null);
        for (let i = 0; i < n; i++) {
          const mid = keyBetween(lo, hi);
          expect(lo < mid && mid < hi).toBe(true);
          hi = mid; // keep squeezing toward lo
        }
      }),
      { numRuns: 100 },
    );
  });
});
