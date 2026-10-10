import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { codePointToUtf16, describeOqxError } from "../src/lib/errors.ts";

describe("describeOqxError", () => {
  it("reads the parser's `(at offset N)` suffix", () => {
    let err: unknown;
    try { parse("select $path from docs where"); } catch (e) { err = e; }
    const info = describeOqxError(err);
    expect(info.stage).toBe("parse");
    expect(info.offset).toBeTypeOf("number");
    expect(info.message).not.toMatch(/at offset/);
  });

  it("reads the lexer's `at N` position", () => {
    let err: unknown;
    try { parse('select $path from docs where $path in ["a"]'); } catch (e) { err = e; }
    const info = describeOqxError(err);
    expect(info.stage).toBe("lex");
    expect(info.offset).toBe(38);
  });

  it("tolerates plain errors and strings", () => {
    expect(describeOqxError(new Error("boom"))).toEqual({ message: "boom", offset: null, stage: null });
    expect(describeOqxError("nope (at offset 7)")).toEqual({ message: "nope", offset: 7, stage: null });
  });
});

describe("codePointToUtf16", () => {
  it("counts astral characters as one code point but two UTF-16 units", () => {
    const s = "a😀b";
    expect(codePointToUtf16(s, 0)).toBe(0);
    expect(codePointToUtf16(s, 1)).toBe(1);
    expect(codePointToUtf16(s, 2)).toBe(3);
    expect(codePointToUtf16(s, 99)).toBe(s.length);
  });
});
