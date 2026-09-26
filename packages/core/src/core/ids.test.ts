import { describe, it, expect } from "vitest";
import { mintId, isValidId, prefixOf, randomSuffix, sequentialMinter, setIdMinter, withIdMinter } from "./ids.js";

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

describe("ids — minter seam (spec/store §2.2)", () => {
  it("sequentialMinter counts per prefix from 0, independently", () => {
    const mint = sequentialMinter();
    expect([mint("d"), mint("b"), mint("b"), mint("d"), mint("c"), mint("r"), mint("rp"), mint("src")]).toEqual([
      "d_0", "b_0", "b_1", "d_1", "c_0", "r_0", "rp_0", "src_0",
    ]);
  });

  it("withIdMinter routes mintId through the installed minter and restores the default afterwards", () => {
    const ids = withIdMinter(sequentialMinter(), () => [mintId("b"), mintId("b"), mintId("d")]);
    expect(ids).toEqual(["b_0", "b_1", "d_0"]);
    expect(mintId("b")).toMatch(/^b_[0-9a-hjkmnp-tv-z]{7}$/);
  });

  it("withIdMinter restores the previous minter when the body throws", () => {
    expect(() => withIdMinter(sequentialMinter(), () => { throw new Error("boom"); })).toThrow("boom");
    expect(mintId("c")).toMatch(/^c_[0-9a-hjkmnp-tv-z]{7}$/);
  });

  it("setIdMinter(null) restores the CSPRNG default", () => {
    setIdMinter(sequentialMinter());
    expect(mintId("r")).toBe("r_0");
    setIdMinter(null);
    expect(mintId("r")).toMatch(/^r_[0-9a-hjkmnp-tv-z]{7}$/);
  });
});

// The id-or-path dispatch must recognize the fixture minter's ids (spec/store
// §2.2: `d_0`, `b_12`), or `insert.doc: "d_0"` would be looked up as a path.
describe("isValidId — fixture-minted ids", () => {
  it("accepts a sequential-minter id and still rejects non-ids", () => {
    const mint = sequentialMinter();
    expect(isValidId(mint("d"), "d")).toBe(true); // d_0
    expect(isValidId("b_12", "b")).toBe(true);
    expect(isValidId("d_0", "b")).toBe(false);
    expect(isValidId("a.md", "d")).toBe(false);
    expect(isValidId("d_", "d")).toBe(false);
  });
});
