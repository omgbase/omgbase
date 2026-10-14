import { describe, expect, it } from "vitest";
import { ancestorsOf, baseName, dirOf, docLocator, hitId, hitPath, idKind, profileOf, rooted, surfaceAtLeast, surfaceOf, surfaceParts, surfaceProblem, unrooted } from "../src/lib/paths.ts";

describe("the surface gate (spec/surface 4.7: revisions + docs_read { at })", () => {
  it("reads specs.surface and profile off the version result", () => {
    expect(surfaceOf({ specs: { surface: "4.7" }, profile: "minimal" })).toBe("4.7");
    expect(profileOf({ specs: { surface: "4.7" }, profile: "minimal" })).toBe("minimal");
    expect(surfaceOf({ error: "repo_not_found" })).toBeNull();
    expect(surfaceOf(null)).toBeNull();
    expect(profileOf({})).toBeNull();
    expect(surfaceParts("10.2")).toEqual([10, 2]);
    expect(surfaceParts("x")).toBeNull();
  });
  it("passes 4.7 and later, by major then minor", () => {
    expect(surfaceAtLeast("4.7")).toBe(true);
    expect(surfaceAtLeast("4.10")).toBe(true);
    expect(surfaceAtLeast("5.0")).toBe(true);
    expect(surfaceAtLeast("4.6")).toBe(false);
    expect(surfaceAtLeast("3.9")).toBe(false);
    expect(surfaceAtLeast(null)).toBe(false);
    expect(surfaceProblem("4.7")).toBeNull();
    expect(surfaceProblem("4.6")).toMatch(/needs omgbase surface ≥ 4\.7 .*the server reports 4\.6/);
    expect(surfaceProblem(null)).toMatch(/no surface version/);
  });
});

describe("paths", () => {
  it("roots and unroots idempotently", () => {
    expect(rooted("a/b.md")).toBe("/a/b.md");
    expect(rooted("//a.md")).toBe("/a.md");
    expect(unrooted("/a.md")).toBe("a.md");
    expect(dirOf("/a/b/c.md")).toBe("/a/b/");
    expect(dirOf("x.md")).toBe("/");
    expect(baseName("/a/b/c.md")).toBe("c.md");
    expect(baseName("/a/b/")).toBe("b");
    expect(ancestorsOf("/a/b/c.md")).toEqual(["/", "/a/", "/a/b/"]);
    expect(ancestorsOf("/x.md")).toEqual(["/"]);
  });
  it("reads the hit envelope and spells a docs_* locator", () => {
    expect(hitId({ id: "d_1", path: "/a.md" })).toBe("d_1");
    expect(hitPath({ id: "d_1", path: "/a.md" })).toBe("/a.md");
    expect(hitId({ id: 3 })).toBeNull();
    expect(hitPath(null)).toBeNull();
    expect(docLocator("d_zbz0k2v")).toEqual({ id: "d_zbz0k2v" });
    expect(docLocator("/a.md")).toEqual({ path: "/a.md" });
  });
  it("knows an id's kind by prefix", () => {
    expect(idKind("d_zbz0k2v")).toBe("doc");
    expect(idKind("b_153")).toBe("block");
    expect(idKind("n_12")).toBe("node");
    expect(idKind("e_xtg54rj")).toBe("link");
    expect(idKind("r_x65zxta")).toBe("revision");
    expect(idKind("c_fgjkrpv")).toBe("commit");
    expect(idKind("/a.md")).toBeNull();
    expect(idKind("d_")).toBeNull();
  });
});
