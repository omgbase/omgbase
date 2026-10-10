import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { codePointToUtf16, describeOqxError, describeQueryError } from "../src/lib/errors.ts";

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

describe("describeQueryError", () => {
  const HIT = 'a hit must be a document, block, node or edge row — the query reached a string ("/timeline/beta.md"); to follow document references held in a property use refs(<field>)';

  it("makes the hit rule's remedy concrete from the query's bare follow field", () => {
    const info = describeQueryError(new Error(HIT), parse(`select $path, before from docs where $path == "timeline/alpha.md" follow before`));
    expect(info).toEqual({
      message: 'a hit must be a document, block, node or edge row — the query reached a string ("/timeline/beta.md")',
      reached: 'a string ("/timeline/beta.md")',
      suggestion: "follow refs(before)",
    });
    expect(describeQueryError(HIT, parse(`$path from docs follow before, after`)).suggestion).toBe("follow refs(before), refs(after)");
  });

  it("keeps the engine's generic remedy when the AST names no bare field", () => {
    expect(describeQueryError(new Error(HIT), parse(`$path from docs follow $repo.docs collect { select $it from tags }`)).suggestion).toBe("refs(<field>)");
    expect(describeQueryError(new Error(HIT), null).suggestion).toBe("refs(<field>)");
  });

  it("passes other errors through", () => {
    expect(describeQueryError(new Error("unknown field"), null)).toEqual({ message: "unknown field", reached: null, suggestion: null });
  });
});
