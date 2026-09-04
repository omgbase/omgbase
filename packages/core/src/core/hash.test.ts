import { describe, it, expect } from "vitest";
import {
  hashHex,
  shortHash,
  normalizeText,
  canonicalAttrs,
  serializeTreeEntries,
  treeHash,
} from "./hash.js";

describe("hash — golden vectors", () => {
  it("sha256 of known strings", () => {
    expect(hashHex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(hashHex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("shortHash is first 16 hex chars", () => {
    expect(shortHash(hashHex("hello"))).toBe("2cf24dba5fb0a30e");
  });
});

describe("normalizeText — 02 §5.2", () => {
  it("collapses internal whitespace and drops blank lines", () => {
    expect(normalizeText("a   b")).toBe("a b");
    expect(normalizeText("  leading\n\n  trailing  ")).toBe("leading trailing");
    expect(normalizeText("one\ntwo\nthree")).toBe("one two three");
  });

  it("handles CRLF and tabs", () => {
    expect(normalizeText("a\tb\r\nc")).toBe("a b c");
  });

  it("NFC-normalizes unicode", () => {
    // 'e' + combining acute === precomposed 'é'
    expect(normalizeText("café")).toBe("café");
  });
});

describe("canonicalAttrs — 02 §5.1", () => {
  it("sorts keys lexicographically, no whitespace", () => {
    expect(canonicalAttrs({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalAttrs({})).toBe("{}");
  });

  it("recurses into nested objects and arrays", () => {
    expect(canonicalAttrs({ z: [3, 1], a: { y: 1, x: 2 } })).toBe(
      '{"a":{"x":2,"y":1},"z":[3,1]}',
    );
  });
});

describe("tree serialization — 02 §5.1", () => {
  const entry = {
    blockId: "b_k7z2p9q",
    rawHashHex: "deadbeef",
    childTreeHashHex: null,
    type: "paragraph",
    attrs: {},
    triviaHashHex: null,
  };

  it("serializes positional entries canonically", () => {
    expect(serializeTreeEntries([entry])).toBe(
      '[["b_k7z2p9q","deadbeef",null,"paragraph",{},null]]',
    );
  });

  it("tree hash matches golden vector", () => {
    expect(treeHash([entry]).toString("hex")).toBe(
      "1d1679899502cbd6996749f2eb8f2ebdc4f786fbb144edd4bec82a3dbd4cd4c1",
    );
  });

  it("structurally identical subtrees produce identical hashes", () => {
    const a = treeHash([entry]);
    const b = treeHash([{ ...entry }]);
    expect(a.equals(b)).toBe(true);
  });
});
