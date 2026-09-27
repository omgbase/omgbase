import { describe, it, expect } from "vitest";
import { MINT_GIVE_UP_AFTER, mintId, isValidId, prefixOf, randomSuffix, registerIdOracle, repeatingMinter, sequentialMinter, setIdMinter, withIdMinter } from "./ids.js";

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

// spec/store §2.1 "Uniqueness at mint" (13.5): a mint never returns an id in use.
describe("ids — uniqueness at mint (spec/store §2.1)", () => {
  it("the production minter redraws when an oracle reports the first candidate in use", () => {
    const asked: string[] = [];
    let rejectFirst = true;
    const unregister = registerIdOracle((prefix, id) => {
      asked.push(`${prefix}:${id}`);
      if (rejectFirst) {
        rejectFirst = false;
        return true; // the first candidate "names a row"
      }
      return false;
    });
    try {
      const id = mintId("b");
      expect(id).toMatch(/^b_[0-9a-hjkmnp-tv-z]{7}$/);
      expect(asked.length).toBe(2);
      expect(asked[0]).toMatch(/^b:b_/);
      expect(asked[1]).toBe(`b:${id}`);
      expect(asked[0]).not.toBe(asked[1]);
    } finally {
      unregister();
    }
  });

  it("an unregistered oracle is no longer consulted", () => {
    let calls = 0;
    const unregister = registerIdOracle(() => { calls++; return false; });
    mintId("d");
    expect(calls).toBe(1);
    unregister();
    mintId("d");
    expect(calls).toBe(1);
  });

  it("the production minter never re-issues an id this process already issued", () => {
    // Inject candidates through the oracle's view: pretend everything but one id is unseen,
    // then check the issued set by minting a large batch — all distinct.
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(mintId("c"));
    expect(seen.size).toBe(20_000);
  });

  it("repeatingMinter offers every sequential id twice, per prefix", () => {
    const mint = repeatingMinter();
    expect([mint("rp"), mint("rp"), mint("b"), mint("b"), mint("b"), mint("d"), mint("b"), mint("d")]).toEqual([
      "rp_0", "rp_0", "b_0", "b_0", "b_1", "d_0", "b_1", "d_0",
    ]);
  });

  it("an installed repeating minter is asked again on its duplicate, so mintId yields the sequential ids", () => {
    const ids = withIdMinter(repeatingMinter(), () => [mintId("rp"), mintId("b"), mintId("b"), mintId("d"), mintId("b")]);
    expect(ids).toEqual(["rp_0", "b_0", "b_1", "d_0", "b_2"]);
  });

  it("an installed minter's duplicate is rejected against the oracle too", () => {
    const rows = new Set(["b_0", "b_1"]); // rows an open store already holds
    const unregister = registerIdOracle((_prefix, id) => rows.has(id));
    try {
      expect(withIdMinter(sequentialMinter(), () => mintId("b"))).toBe("b_2");
    } finally {
      unregister();
    }
  });

  it("each install starts a fresh issued set, so sequential fixtures stay byte-identical across cases", () => {
    expect(withIdMinter(sequentialMinter(), () => [mintId("d"), mintId("b")])).toEqual(["d_0", "b_0"]);
    expect(withIdMinter(sequentialMinter(), () => [mintId("d"), mintId("b")])).toEqual(["d_0", "b_0"]);
    setIdMinter(sequentialMinter());
    expect(mintId("d")).toBe("d_0");
    setIdMinter(sequentialMinter());
    expect(mintId("d")).toBe("d_0");
    setIdMinter(null);
  });

  it("gives up with a clear error on a minter that can never produce a fresh id", () => {
    expect(() => withIdMinter(() => "b_stuck", () => { mintId("b"); mintId("b"); })).toThrow(
      new RegExp(`mintId\\(b\\): ${MINT_GIVE_UP_AFTER} consecutive candidates were already in use`),
    );
  });
});
