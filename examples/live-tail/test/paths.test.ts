import { describe, expect, it } from "vitest";
import { NAMES_4, NAMES_5, REQUIRED_SURFACE_MAJOR, UNDERSCORE_SURFACE_MAJOR, docLocator, hitId, hitPath, namesFor, rooted, surfaceMajor, surfaceOf, surfaceProblem } from "../src/lib/paths.ts";

describe("docLocator — the document argument (spec/surface §4 Arguments)", () => {
  it("spells an id `{ _id }` and anything else `{ _path }` (surface 5.0, the default)", () => {
    expect(docLocator("d_0")).toEqual({ _id: "d_0" });
    expect(docLocator("d_77ptprj")).toEqual({ _id: "d_77ptprj" });
    expect(docLocator("/notes/a.md")).toEqual({ _path: "/notes/a.md" });
    expect(docLocator("a.md")).toEqual({ _path: "a.md" });
    expect(docLocator("d_0", NAMES_5)).toEqual({ _id: "d_0" });
  });
  it("spells them bare under the 4.x names", () => {
    expect(docLocator("d_0", NAMES_4)).toEqual({ id: "d_0" });
    expect(docLocator("/notes/a.md", NAMES_4)).toEqual({ path: "/notes/a.md" });
  });
});

describe("namesFor — the engine names a server's surface spells (spec/surface 5.0 §1.2)", () => {
  it("is the `_`-prefixed spelling from 5.0 on, the bare one before, and the native (5.0) one while unknown", () => {
    expect(UNDERSCORE_SURFACE_MAJOR).toBe(5);
    expect(namesFor("5.0")).toBe(NAMES_5);
    expect(namesFor("6.2")).toBe(NAMES_5);
    expect(namesFor("4.11")).toBe(NAMES_4);
    expect(namesFor("3.0")).toBe(NAMES_4);
    expect(namesFor(null)).toBe(NAMES_5);
    expect(namesFor("nope")).toBe(NAMES_5);
  });
  it("names the attributes the page generates", () => {
    expect(NAMES_5).toEqual({ major: 5, id: "_id", path: "_path", title: "_title", updated_at: "_updated_at" });
    expect(NAMES_4).toEqual({ major: 4, id: "id", path: "path", title: "title", updated_at: "updated_at" });
  });
});

describe("surfaceOf / surfaceMajor / surfaceProblem — the `version` tool and the gate", () => {
  it("reads specs.surface, else null", () => {
    expect(surfaceOf({ specs: { surface: "3.0" } })).toBe("3.0");
    expect(surfaceOf({ specs: { surface: "5.0" } })).toBe("5.0");
    expect(surfaceOf({})).toBeNull();
    expect(surfaceOf(null)).toBeNull();
    expect(surfaceOf({ specs: { surface: "nope" } })).toBeNull();
  });
  it("surfaceMajor: the major number; null for junk and while unknown", () => {
    expect(surfaceMajor("3.0")).toBe(3);
    expect(surfaceMajor("12.1")).toBe(12);
    expect(surfaceMajor("nope")).toBeNull();
    expect(surfaceMajor(null)).toBeNull();
  });
  it("the gate passes 3.0 and later (5.0 included), and names what an older server reports", () => {
    expect(REQUIRED_SURFACE_MAJOR).toBe(3);
    expect(surfaceProblem("3.0")).toBeNull();
    expect(surfaceProblem("3.1")).toBeNull();
    expect(surfaceProblem("4.0")).toBeNull();
    expect(surfaceProblem("5.0")).toBeNull();
    expect(surfaceProblem("2.0")).toBe("this demo needs omgbase surface ≥ 3.0 — the server reports 2.0");
    expect(surfaceProblem("1.5")).toBe("this demo needs omgbase surface ≥ 3.0 — the server reports 1.5");
    expect(surfaceProblem(null)).toBe("this demo needs omgbase surface ≥ 3.0 — the server reports no surface version (no `version` tool)");
  });
});

describe("the hit envelope", () => {
  it("reads _id/_path (spec/surface §1.4), and a 4.x hit's id/path", () => {
    expect(hitId({ _id: "d_1", _path: "/a.md" })).toBe("d_1");
    expect(hitPath({ _id: "d_1", _path: "/a.md" })).toBe("/a.md");
    expect(hitPath({ _id: "d_1", _path: "a.md" })).toBe("a.md");
    expect(hitId({ id: "d_1", path: "/a.md" })).toBe("d_1");
    expect(hitPath({ id: "d_1", path: "/a.md" })).toBe("/a.md");
    // On a 5.0 server a bare `id`/`path` is an authored key; the envelope wins.
    expect(hitId({ _id: "d_1", _path: "/a.md", id: "authored", path: "authored" })).toBe("d_1");
    expect(hitPath({ _id: "d_1", _path: "/a.md", id: "authored", path: "authored" })).toBe("/a.md");
    expect(hitId({})).toBeNull();
    expect(hitPath(null)).toBeNull();
    expect(hitId({ _id: 3 })).toBeNull();
  });
  it("roots paths idempotently", () => {
    expect(rooted("a/b.md")).toBe("/a/b.md");
    expect(rooted("/a/b.md")).toBe("/a/b.md");
    expect(rooted("//a.md")).toBe("/a.md");
  });
});
