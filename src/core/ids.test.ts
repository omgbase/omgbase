import { describe, it, expect } from "vitest";
import { mintId, isValidId, prefixOf, randomSuffix } from "./ids.js";

describe("ids", () => {
  it("mints prefixed 7-char Crockford base32 ids", () => {
    const id = mintId("b");
    expect(id).toMatch(/^b_[0-9a-hjkmnp-tv-z]{7}$/);
    expect(isValidId(id, "b")).toBe(true);
    expect(prefixOf(id)).toBe("b");
  });

  it("rejects ambiguous Crockford letters (i, l, o, u)", () => {
    // 100 suffixes should never contain excluded letters.
    for (let i = 0; i < 100; i++) {
      expect(randomSuffix()).not.toMatch(/[ilou]/);
    }
  });

  it("validates prefix mismatches", () => {
    expect(isValidId("b_k7z2p9q", "d")).toBe(false);
    expect(isValidId("b_k7z2p9q", "b")).toBe(true);
    expect(isValidId("nope")).toBe(false);
    expect(isValidId("b_TOOLONGX")).toBe(false);
  });

  it("supports multi-char prefixes (col_, cp_)", () => {
    expect(isValidId(mintId("col"), "col")).toBe(true);
    expect(isValidId(mintId("cp"), "cp")).toBe(true);
  });

  it("mints with high uniqueness", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(mintId("b"));
    expect(seen.size).toBe(5000); // collisions astronomically unlikely at 32^7
  });
});
