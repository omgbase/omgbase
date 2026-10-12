import { describe, expect, it } from "vitest";
import { DOC_ATTRIBUTES, HIT_ENVELOPE_KEYS, REQUIRED_SURFACE_MAJOR, docLocator, hitId, hitPath, rooted, rowRef, samePath, surfaceMajor, surfaceOf, surfaceProblem, unrooted } from "../src/lib/paths.ts";

describe("hitId / hitPath / rowRef — the hit envelope (spec/surface §1.4)", () => {
  it("reads `id`/`path` as returned", () => {
    expect(hitId({ id: "d_1", path: "/a.md" })).toBe("d_1");
    expect(hitPath({ id: "d_1", path: "/a.md" })).toBe("/a.md");
    expect(hitPath({ id: "d_1", path: "a.md" })).toBe("a.md");
  });
  it("is null for a hit without an identity, a non-string value, or no hit", () => {
    expect(hitId({ title: "A" })).toBeNull();
    expect(hitPath({ path: 3 })).toBeNull();
    expect(hitId(null)).toBeNull();
    expect(hitPath(undefined)).toBeNull();
  });
  it("rowRef recognizes a row surfacing as a value, rooted, and nothing else", () => {
    expect(rowRef({ id: "b_0", path: "/a.md" })).toEqual({ id: "b_0", path: "/a.md" });
    expect(rowRef({ id: "d_1", path: "a.md" })).toEqual({ id: "d_1", path: "/a.md" });
    expect(rowRef("/a.md")).toBeNull();
    expect(rowRef({ id: "d_1", path: "/a.md", title: "A" })).toBeNull(); // a hit with a projection is not a bare ref
    expect(rowRef({ id: "d_1" })).toBeNull();
    expect(rowRef([{ id: "d_1", path: "/a.md" }])).toBeNull();
    expect(rowRef(null)).toBeNull();
  });
  it("names the envelope and the docs attributes", () => {
    expect([...HIT_ENVELOPE_KEYS].sort()).toEqual(["id", "path"]);
    expect([...DOC_ATTRIBUTES].sort()).toEqual(["format", "hash", "id", "path", "raw", "tags", "title", "updated_at"]);
  });
});

describe("surfaceOf / surfaceMajor — the `version` tool's specs.surface", () => {
  it("reads specs.surface off the result", () => {
    expect(surfaceOf({ engine: "typescript", specs: { oqx: "0.20", surface: "3.0" } })).toBe("3.0");
    expect(surfaceOf({ specs: { surface: "3.1" } })).toBe("3.1");
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
  it("passes 3.0 and later", () => {
    expect(REQUIRED_SURFACE_MAJOR).toBe(3);
    expect(surfaceProblem("3.0")).toBeNull();
    expect(surfaceProblem("3.4")).toBeNull();
    expect(surfaceProblem("4.0")).toBeNull();
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
  it("spells an id `{ id }` and anything else `{ path }`", () => {
    expect(docLocator("d_77ptprj")).toEqual({ id: "d_77ptprj" });
    expect(docLocator("d_0")).toEqual({ id: "d_0" });
    expect(docLocator("/timeline/kickoff.md")).toEqual({ path: "/timeline/kickoff.md" });
    expect(docLocator("timeline/kickoff.md")).toEqual({ path: "timeline/kickoff.md" });
    expect(docLocator("d_toolongforanid")).toEqual({ path: "d_toolongforanid" });
  });
});
