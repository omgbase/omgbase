import { describe, it, expect } from "vitest";
import { byteOffsetTable, byteOffsetOf, codeUnitSpanToBytes, byteSpanToCodeUnits, codeUnitIndexOf } from "./utf8.js";

const utf8Len = (s: string): number => Buffer.byteLength(s, "utf8");

describe("utf8 — code-unit ⇄ byte offsets (spec/graph §2.3)", () => {
  it("ASCII is the identity", () => {
    const s = "See [a](/x.md).";
    const t = byteOffsetTable(s);
    for (let i = 0; i <= s.length; i++) expect(t[i]).toBe(i);
    expect(codeUnitSpanToBytes(s, 4, 14)).toEqual({ start: 4, end: 14 });
    expect(byteSpanToCodeUnits(s, 4, 14)).toEqual({ start: 4, end: 14 });
  });

  it("a 2-byte character before the feature shifts the byte span by one", () => {
    const s = "Café [a](/x.md)";
    const i = s.indexOf("[a]");
    const j = s.length;
    expect(utf8Len("Café ")).toBe(6);
    expect(codeUnitSpanToBytes(s, i, j)).toEqual({ start: 6, end: 6 + utf8Len("[a](/x.md)") });
    expect(byteSpanToCodeUnits(s, 6, 6 + utf8Len("[a](/x.md)"))).toEqual({ start: i, end: j });
    expect(s.slice(i, j)).toBe("[a](/x.md)");
  });

  it("a surrogate pair (4 bytes, 2 code units) before the feature", () => {
    const s = "🚀 [[note]] tail";
    const i = s.indexOf("[[");
    const j = s.indexOf("]]") + 2;
    expect(i).toBe(3); // two code units for the emoji, one space
    const bytes = codeUnitSpanToBytes(s, i, j);
    expect(bytes).toEqual({ start: 5, end: 5 + utf8Len("[[note]]") });
    expect(Buffer.from(s, "utf8").subarray(bytes.start, bytes.end).toString("utf8")).toBe("[[note]]");
    expect(byteSpanToCodeUnits(s, bytes.start, bytes.end)).toEqual({ start: i, end: j });
  });

  it("the whole-string span round-trips (task spans are [0, len(raw)))", () => {
    const s = "- [ ] naïve ☕ 🚀";
    expect(codeUnitSpanToBytes(s, 0, s.length)).toEqual({ start: 0, end: utf8Len(s) });
    expect(byteSpanToCodeUnits(s, 0, utf8Len(s))).toEqual({ start: 0, end: s.length });
    expect(byteOffsetOf(s, s.length)).toBe(utf8Len(s));
  });

  it("a byte offset inside a multi-byte sequence rounds down to the character's start", () => {
    const s = "é🚀x";
    // bytes: é = [0,2), 🚀 = [2,6), x = [6,7)
    expect(codeUnitIndexOf(s, 1)).toBe(0);
    expect(codeUnitIndexOf(s, 2)).toBe(1);
    expect(codeUnitIndexOf(s, 3)).toBe(1);
    expect(codeUnitIndexOf(s, 5)).toBe(1);
    expect(codeUnitIndexOf(s, 6)).toBe(3);
    expect(codeUnitIndexOf(s, 99)).toBe(s.length);
  });

  it("a lone surrogate counts the 3 bytes Buffer emits for U+FFFD", () => {
    const s = "a\ud800b";
    expect(byteOffsetTable(s)[3]).toBe(utf8Len(s));
    expect(utf8Len(s)).toBe(5);
  });

  it("clamps out-of-range indices instead of throwing", () => {
    expect(codeUnitSpanToBytes("ab", -3, 10)).toEqual({ start: 0, end: 2 });
    expect(codeUnitSpanToBytes("ab", 2, 1)).toEqual({ start: 2, end: 2 });
    expect(byteSpanToCodeUnits("ab", 5, 1)).toEqual({ start: 2, end: 2 });
  });
});
