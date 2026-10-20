import { describe, expect, it } from "vitest";
import { ancestorsOf, baseName, dirOf, docLocator, hitId, hitPath, idKind, profileOf, rooted, surfaceAtLeast, surfaceOf, surfaceParts, surfaceProblem, unrooted } from "../src/lib/paths.ts";

describe("the surface gate (spec/surface 5.0: the underscore engine names — _id/_path arguments)", () => {
  it("reads specs.surface and profile off the version result", () => {
    expect(surfaceOf({ specs: { surface: "5.0" }, profile: "minimal" })).toBe("5.0");
    expect(profileOf({ specs: { surface: "5.0" }, profile: "minimal" })).toBe("minimal");
    expect(surfaceOf({ error: "repo_not_found" })).toBeNull();
    expect(surfaceOf(null)).toBeNull();
    expect(profileOf({})).toBeNull();
    expect(surfaceParts("10.2")).toEqual([10, 2]);
    expect(surfaceParts("x")).toBeNull();
  });
  it("passes 5.0 and later, by major then minor; a 4.x server (bare `path` arguments, no `_path`) is refused", () => {
    expect(surfaceAtLeast("5.0")).toBe(true);
    expect(surfaceAtLeast("5.3")).toBe(true);
    expect(surfaceAtLeast("6.0")).toBe(true);
    expect(surfaceAtLeast("4.11")).toBe(false);
    expect(surfaceAtLeast("4.7")).toBe(false);
    expect(surfaceAtLeast("3.9")).toBe(false);
    expect(surfaceAtLeast(null)).toBe(false);
    expect(surfaceProblem("5.0")).toBeNull();
    expect(surfaceProblem("4.11")).toMatch(/needs omgbase surface ≥ 5\.0 .*_id\/_path.*the server reports 4\.11/);
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
  it("reads the 5.0 hit envelope { _id, _path } and spells a docs_* locator { _id } | { _path }", () => {
    expect(hitId({ _id: "d_1", _path: "/a.md" })).toBe("d_1");
    expect(hitPath({ _id: "d_1", _path: "/a.md" })).toBe("/a.md");
    expect(hitId({ _id: 3 })).toBeNull();
    expect(hitPath(null)).toBeNull();
    // The 4.x bare envelope is not read: a bare `id`/`path` is an authored key in 5.0.
    expect(hitId({ id: "d_1", path: "/a.md" })).toBeNull();
    expect(hitPath({ id: "d_1", path: "/a.md" })).toBeNull();
    expect(docLocator("d_zbz0k2v")).toEqual({ _id: "d_zbz0k2v" });
    expect(docLocator("/a.md")).toEqual({ _path: "/a.md" });
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
