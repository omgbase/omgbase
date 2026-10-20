import { describe, it, expect } from "vitest";
import { tokenize, TokenizeError } from "../src/shell/tokenize.js";
import { parseRef, deriveRows, coerce, RefError } from "../src/shell/refs.js";

// Pure unit coverage for the shell's parsing/dereferencing pieces (no workspace).

describe("tokenize", () => {
  it("splits on whitespace", () => {
    expect(tokenize("show b_1 b_2")).toEqual(["show", "b_1", "b_2"]);
  });
  it("keeps single-quoted OQX source as one token, verbatim", () => {
    expect(tokenize(`query 'from docs where layer == "canon"'`)).toEqual([
      "query",
      'from docs where layer == "canon"',
    ]);
  });
  it("handles double quotes with escapes and empty quoted tokens", () => {
    expect(tokenize('a "b c" "" d')).toEqual(["a", "b c", "", "d"]);
    expect(tokenize('x "a\\"b"')).toEqual(["x", 'a"b']);
  });
  it("throws on an unterminated quote", () => {
    expect(() => tokenize("query 'oops")).toThrow(TokenizeError);
  });
  it("honors a backslash escape outside quotes", () => {
    expect(tokenize("a\\ b c")).toEqual(["a b", "c"]);
  });
  it("returns no tokens for whitespace only", () => {
    expect(tokenize("   \t ")).toEqual([]);
  });
});

describe("parseRef", () => {
  it("returns null for non-references", () => {
    expect(parseRef("show")).toBeNull();
    expect(parseRef("email@example.com")).toBeNull(); // doesn't start with @
  });
  it("parses base / index / field", () => {
    expect(parseRef("@1")).toEqual({ base: "1" });
    expect(parseRef("@_")).toEqual({ base: "_" });
    expect(parseRef("@foo")).toEqual({ base: "foo" });
    expect(parseRef("@foo[2]")).toEqual({ base: "foo", index: 2 });
    expect(parseRef("@foo[2]._path")).toEqual({ base: "foo", index: 2, field: "_path" });
    expect(parseRef("@_._id")).toEqual({ base: "_", field: "_id" });
    expect(parseRef("@1.layer")).toEqual({ base: "1", field: "layer" }); // an authored key reads too
  });
  it("rejects malformed references", () => {
    expect(() => parseRef("@foo.bar.baz")).toThrow(RefError);
    expect(() => parseRef("@foo[x]")).toThrow(RefError);
  });
});

describe("deriveRows", () => {
  it("derives from a {hits} envelope (query/oqx)", () => {
    const rows = deriveRows({ hits: [{ _id: "b_1", _path: "a.md" }, { _id: "b_2", _path: "b.md" }] });
    expect(rows?.map((r) => r.ref)).toEqual(["b_1", "b_2"]);
    expect(rows?.[0]!.label).toBe("a.md");
  });
  it("derives from a bare array of entities (find)", () => {
    const rows = deriveRows([{ _id: "b_1", locator: "a.md#x" }]);
    expect(rows?.[0]).toMatchObject({ ref: "b_1", label: "a.md#x" });
  });
  it("derives ids from a write's Receipt as the verbs capture it (the realized ids beside the receipt)", () => {
    const rows = deriveRows({ plan_id: "x", commit: "c_1", revisions: [{}], new_ids: { "$new.0": "b_9" }, committed: true, ids: ["b_9", "b_10"] });
    expect(rows?.map((r) => r.ref)).toEqual(["b_9", "b_10"]);
  });
  it("derives far nodes from links (out+in): `_doc_id` (5.0), `node` as a role key", () => {
    const rows = deriveRows({ out: [{ _predicate: "references", _doc_id: "d_1" }], in: [{ _doc_id: "d_2" }] });
    expect(rows?.map((r) => r.ref)).toEqual(["d_1", "d_2"]);
    const role = deriveRows({ out: [{ node: "d_1", _predicate: "references" }], in: [{ node: "d_2" }] });
    expect(role?.map((r) => r.ref)).toEqual(["d_1", "d_2"]);
  });
  it("a 5.0 row's `_id` is the ref and `_path` the label (ls rows, hits, docs_read)", () => {
    const rows = deriveRows([{ _id: "d_1", _path: "/a.md", _updated_at: null, blocks: 3 }]);
    expect(rows?.[0]).toMatchObject({ ref: "d_1", label: "/a.md" });
    expect(coerce({ _id: "d_1", _path: "/a.md", rev: "r_1" })).toBe("d_1");
    // an edge row (links --blocks, dangling): the far doc leads, the block is next
    expect(coerce({ _doc_id: "d_2", _block_id: "b_7", _predicate: "references" })).toBe("d_2");
    expect(coerce({ _block_id: "b_7", target: "/x.md" })).toBe("b_7");
  });
  it("a bare `id`/`path` is an authored key, never the row's identity (the 4.x tolerance is gone)", () => {
    expect(() => coerce({ id: "d_1", path: "/a.md" })).toThrow(RefError);
    expect(() => coerce({ $id: "d_1", $path: "/a.md" })).toThrow(RefError);
    // a hit that projects an authored `id` still addresses by its envelope `_id`
    expect(coerce({ _id: "d_1", _path: "/a.md", id: "ORG-7" })).toBe("d_1");
  });
  it("returns null for a card / scalar / string (frame stays intact)", () => {
    expect(deriveRows({ kind: "document", _id: "d_1", _path: "a.md" })).toBeNull();
    expect(deriveRows("some bytes")).toBeNull();
    expect(deriveRows(42)).toBeNull();
  });
  it("uses `_path` as the ref when there is no `_id` (a path-only row)", () => {
    const rows = deriveRows([{ _path: "a.md", blocks: 3 }]);
    expect(rows?.[0]).toMatchObject({ ref: "a.md", label: "a.md" });
  });
});

describe("coerce", () => {
  it("passes strings through and stringifies scalars", () => {
    expect(coerce("b_1")).toBe("b_1");
    expect(coerce(7)).toBe("7");
    expect(coerce(true)).toBe("true");
  });
  it("collapses an entity to its _id/locator", () => {
    expect(coerce({ _id: "b_1", _path: "a.md" })).toBe("b_1");
    expect(coerce({ _path: "a.md" })).toBe("a.md");
  });
  it("refuses to flatten a collection into one argument", () => {
    expect(() => coerce([1, 2])).toThrow(RefError);
    expect(() => coerce({ hits: [{ _id: "b_1" }] })).toThrow(RefError);
  });
  it("refuses null/undefined and id-less records", () => {
    expect(() => coerce(null)).toThrow(RefError);
    expect(() => coerce(undefined)).toThrow(RefError);
    expect(() => coerce({ note: "no id here" })).toThrow(RefError);
  });
});
