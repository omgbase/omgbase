import { describe, expect, it } from "vitest";
import { REQUIRED_SURFACE_MAJOR, docLocator, hitId, hitPath, rooted, surfaceMajor, surfaceOf, surfaceProblem } from "../src/lib/paths.ts";

describe("docLocator — the document argument (spec/surface §4 Arguments)", () => {
  it("spells an id `{ id }` and anything else `{ path }`", () => {
    expect(docLocator("d_0")).toEqual({ id: "d_0" });
    expect(docLocator("d_77ptprj")).toEqual({ id: "d_77ptprj" });
    expect(docLocator("/notes/a.md")).toEqual({ path: "/notes/a.md" });
    expect(docLocator("a.md")).toEqual({ path: "a.md" });
  });
});

describe("surfaceOf / surfaceMajor / surfaceProblem — the `version` tool and the gate", () => {
  it("reads specs.surface, else null", () => {
    expect(surfaceOf({ specs: { surface: "3.0" } })).toBe("3.0");
    expect(surfaceOf({ specs: { surface: "3.2" } })).toBe("3.2");
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
  it("the gate passes 3.0 and later, and names what an older server reports", () => {
    expect(REQUIRED_SURFACE_MAJOR).toBe(3);
    expect(surfaceProblem("3.0")).toBeNull();
    expect(surfaceProblem("3.1")).toBeNull();
    expect(surfaceProblem("4.0")).toBeNull();
    expect(surfaceProblem("2.0")).toBe("this demo needs omgbase surface ≥ 3.0 — the server reports 2.0");
    expect(surfaceProblem("1.5")).toBe("this demo needs omgbase surface ≥ 3.0 — the server reports 1.5");
    expect(surfaceProblem(null)).toBe("this demo needs omgbase surface ≥ 3.0 — the server reports no surface version (no `version` tool)");
  });
});

describe("the hit envelope", () => {
  it("reads id/path (spec/surface §1.4)", () => {
    expect(hitId({ id: "d_1", path: "/a.md" })).toBe("d_1");
    expect(hitPath({ id: "d_1", path: "/a.md" })).toBe("/a.md");
    expect(hitPath({ id: "d_1", path: "a.md" })).toBe("a.md");
    expect(hitId({})).toBeNull();
    expect(hitPath(null)).toBeNull();
    expect(hitId({ id: 3 })).toBeNull();
  });
  it("roots paths idempotently", () => {
    expect(rooted("a/b.md")).toBe("/a/b.md");
    expect(rooted("/a/b.md")).toBe("/a/b.md");
    expect(rooted("//a.md")).toBe("/a.md");
  });
});
