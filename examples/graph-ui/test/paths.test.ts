import { describe, expect, it } from "vitest";
import { DOC_ATTRIBUTES, HIT_ENVELOPE_KEYS, NAMES_4, NAMES_5, REQUIRED_SURFACE_MAJOR, UNDERSCORE_SURFACE_MAJOR, docLocator, hitId, hitPath, isEngineAttribute, namesFor, rooted, rowRef, samePath, surfaceMajor, surfaceOf, surfaceProblem, unrooted } from "../src/lib/paths.ts";

describe("hitId / hitPath / rowRef — the hit envelope (spec/surface §1.4)", () => {
  it("reads `_id`/`_path` as returned (surface 5.0), and a 4.x server's `id`/`path`", () => {
    expect(hitId({ _id: "d_1", _path: "/a.md" })).toBe("d_1");
    expect(hitPath({ _id: "d_1", _path: "/a.md" })).toBe("/a.md");
    expect(hitPath({ _id: "d_1", _path: "a.md" })).toBe("a.md");
    expect(hitId({ id: "d_1", path: "/a.md" })).toBe("d_1");
    expect(hitPath({ id: "d_1", path: "/a.md" })).toBe("/a.md");
    // On 5.0 a bare `id`/`path` is an authored key; the envelope wins.
    expect(hitId({ _id: "d_1", _path: "/a.md", id: "authored", path: "authored" })).toBe("d_1");
    expect(hitPath({ _id: "d_1", _path: "/a.md", id: "authored", path: "authored" })).toBe("/a.md");
  });
  it("is null for a hit without an identity, a non-string value, or no hit", () => {
    expect(hitId({ title: "A" })).toBeNull();
    expect(hitPath({ path: 3 })).toBeNull();
    expect(hitId(null)).toBeNull();
    expect(hitPath(undefined)).toBeNull();
  });
  it("rowRef recognizes a row surfacing as a value, rooted, in either spelling, and nothing else", () => {
    expect(rowRef({ _id: "b_0", _path: "/a.md" })).toEqual({ id: "b_0", path: "/a.md" });
    expect(rowRef({ _id: "d_1", _path: "a.md" })).toEqual({ id: "d_1", path: "/a.md" });
    expect(rowRef({ id: "b_0", path: "/a.md" })).toEqual({ id: "b_0", path: "/a.md" }); // 4.x
    expect(rowRef("/a.md")).toBeNull();
    expect(rowRef({ _id: "d_1", _path: "/a.md", title: "A" })).toBeNull(); // a hit with a projection is not a bare ref
    expect(rowRef({ _id: "d_1" })).toBeNull();
    expect(rowRef({ _id: "d_1", path: "/a.md" })).toBeNull(); // the two spellings do not mix
    expect(rowRef([{ _id: "d_1", _path: "/a.md" }])).toBeNull();
    expect(rowRef(null)).toBeNull();
  });
  it("names the envelope (both spellings), the 4.x docs attributes, and judges an engine attribute by the `_` prefix or the 4.x list", () => {
    expect([...HIT_ENVELOPE_KEYS].sort()).toEqual(["_id", "_path", "id", "path"]);
    expect([...DOC_ATTRIBUTES].sort()).toEqual(["format", "hash", "id", "path", "raw", "tags", "title", "updated_at"]);
    for (const n of ["_path", "_title", "_updated_at", "_out_links", "_anything", "path", "title", "updated_at"]) expect(isEngineAttribute(n), n).toBe(true);
    for (const n of ["phase", "before", "name", "$depth", "data"]) expect(isEngineAttribute(n), n).toBe(false);
  });
});

describe("namesFor — the engine names a server's surface spells (spec/surface 5.0 §1.2)", () => {
  it("is the `_`-prefixed spelling from 5.0 on, the bare one before, and the native (5.0) one while unknown", () => {
    expect(UNDERSCORE_SURFACE_MAJOR).toBe(5);
    expect(namesFor("5.0")).toBe(NAMES_5);
    expect(namesFor("6.1")).toBe(NAMES_5);
    expect(namesFor("4.11")).toBe(NAMES_4);
    expect(namesFor("3.0")).toBe(NAMES_4);
    expect(namesFor(null)).toBe(NAMES_5);
  });
  it("spells the attributes, relations and builtin candidate names per family", () => {
    expect(NAMES_5).toMatchObject({ major: 5, id: "_id", path: "_path", title: "_title", updated_at: "_updated_at", dst_path: "_dst_path", field: "_field", provenance: "_provenance", dst_kind: "_dst_kind", out_links: "_out_links", in_links: "_in_links", dst: "_dst", doc: "_doc", builtinLinks: "_out_links", builtinBacklinks: "_in_links" });
    expect(NAMES_4).toMatchObject({ major: 4, id: "id", path: "path", title: "title", updated_at: "updated_at", dst_path: "dst_path", field: "field", provenance: "provenance", dst_kind: "dst_kind", out_links: "out_links", in_links: "in_links", dst: "dst", doc: "doc", builtinLinks: "doc.out_links", builtinBacklinks: "doc.in_links" });
  });
});

describe("surfaceOf / surfaceMajor — the `version` tool's specs.surface", () => {
  it("reads specs.surface off the result", () => {
    expect(surfaceOf({ engine: "typescript", specs: { oqx: "0.20", surface: "3.0" } })).toBe("3.0");
    expect(surfaceOf({ specs: { surface: "3.1" } })).toBe("3.1");
    expect(surfaceOf({ specs: { surface: "5.0" } })).toBe("5.0");
  });
  it("is null when the tool is missing or the shape is off", () => {
    for (const v of [undefined, null, {}, { specs: {} }, { specs: { surface: 3 } }, { specs: { surface: "three" } }, "not found"]) {
      expect(surfaceOf(v), JSON.stringify(v)).toBeNull();
    }
  });
  it("surfaceMajor: the major number, null for anything else", () => {
    expect(surfaceMajor("3.0")).toBe(3);
    expect(surfaceMajor("10.2")).toBe(10);
    expect(surfaceMajor("nope")).toBeNull();
    expect(surfaceMajor(null)).toBeNull();
  });
});

describe("surfaceProblem — the gate: this demo speaks surface 3.0", () => {
  it("passes 3.0 and later (5.0 included)", () => {
    expect(REQUIRED_SURFACE_MAJOR).toBe(3);
    expect(surfaceProblem("3.0")).toBeNull();
    expect(surfaceProblem("3.4")).toBeNull();
    expect(surfaceProblem("4.0")).toBeNull();
    expect(surfaceProblem("5.0")).toBeNull();
  });
  it("refuses an older server, naming what it reports", () => {
    expect(surfaceProblem("2.0")).toBe("this demo needs omgbase surface ≥ 3.0 — the server reports 2.0");
    expect(surfaceProblem("1.5")).toBe("this demo needs omgbase surface ≥ 3.0 — the server reports 1.5");
    expect(surfaceProblem(null)).toBe("this demo needs omgbase surface ≥ 3.0 — the server reports no surface version (no `version` tool)");
  });
});

describe("rooted / unrooted", () => {
  it("are idempotent and inverse of each other modulo the slash", () => {
    for (const p of ["timeline/kickoff.md", "/timeline/kickoff.md", "//timeline/kickoff.md", "a.md", "/a.md"]) {
      const r = rooted(p);
      const u = unrooted(p);
      expect(r).toBe(`/${u}`);
      expect(rooted(r)).toBe(r);
      expect(unrooted(u)).toBe(u);
      expect(unrooted(r)).toBe(u);
      expect(rooted(u)).toBe(r);
    }
    expect(rooted("timeline/kickoff.md")).toBe("/timeline/kickoff.md");
    expect(unrooted("/timeline/kickoff.md")).toBe("timeline/kickoff.md");
  });
});

describe("samePath", () => {
  it("compares modulo the leading slash only", () => {
    expect(samePath("timeline/kickoff.md", "/timeline/kickoff.md")).toBe(true);
    expect(samePath("/a.md", "/a.md")).toBe(true);
    expect(samePath("a.md", "b.md")).toBe(false);
    expect(samePath("a.md", "a")).toBe(false); // the `.md` is part of the path
    expect(samePath("x/a.md", "a.md")).toBe(false);
  });
});

describe("docLocator — the document argument (spec/surface §4 Arguments)", () => {
  it("spells an id `{ _id }` and anything else `{ _path }` (surface 5.0, the default)", () => {
    expect(docLocator("d_77ptprj")).toEqual({ _id: "d_77ptprj" });
    expect(docLocator("d_0")).toEqual({ _id: "d_0" });
    expect(docLocator("/timeline/kickoff.md")).toEqual({ _path: "/timeline/kickoff.md" });
    expect(docLocator("timeline/kickoff.md")).toEqual({ _path: "timeline/kickoff.md" });
    expect(docLocator("d_toolongforanid")).toEqual({ _path: "d_toolongforanid" });
    expect(docLocator("d_0", NAMES_5)).toEqual({ _id: "d_0" });
  });
  it("spells them bare under the 4.x names", () => {
    expect(docLocator("d_77ptprj", NAMES_4)).toEqual({ id: "d_77ptprj" });
    expect(docLocator("/timeline/kickoff.md", NAMES_4)).toEqual({ path: "/timeline/kickoff.md" });
  });
});
