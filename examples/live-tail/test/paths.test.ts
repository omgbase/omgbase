import { describe, expect, it } from "vitest";
import { attr, bareArguments, bareAttributes, diffUnifiedTool, docLocator } from "../src/lib/paths.ts";

describe("docLocator — the document argument by surface version (spec/surface §4 Arguments)", () => {
  it("spells `id`/`path` on 3.0 and `doc` before", () => {
    expect(bareArguments("3.0")).toBe(true);
    expect(bareArguments("2.0")).toBe(false);
    expect(bareArguments(null)).toBe(false);
    expect(docLocator("3.0", "d_0")).toEqual({ id: "d_0" });
    expect(docLocator("3.0", "d_77ptprj")).toEqual({ id: "d_77ptprj" });
    expect(docLocator("3.0", "/notes/a.md")).toEqual({ path: "/notes/a.md" });
    expect(docLocator("2.0", "/notes/a.md")).toEqual({ doc: "/notes/a.md" });
    expect(docLocator("2.0", "d_0")).toEqual({ doc: "d_0" });
    expect(docLocator(null, "a.md")).toEqual({ doc: "a.md" });
  });
});

describe("diffUnifiedTool — the unified-diff tool's name by surface version (spec/surface §3)", () => {
  it("is `docs_diff_unified` on 3.0 and later, `diff_unified` before and while unknown", () => {
    expect(diffUnifiedTool("3.0")).toBe("docs_diff_unified");
    expect(diffUnifiedTool("3.1")).toBe("docs_diff_unified");
    expect(diffUnifiedTool("2.0")).toBe("diff_unified");
    expect(diffUnifiedTool("1.5")).toBe("diff_unified");
    expect(diffUnifiedTool(null)).toBe("diff_unified");
  });
});
import { LEGACY_SURFACE, hitId, hitPath, rooted, surfaceMajor, surfaceOf } from "../src/lib/paths.ts";

describe("surfaceOf", () => {
  it("reads the version tool's specs.surface, else 1.x", () => {
    expect(surfaceOf({ specs: { surface: "3.0" } })).toBe("3.0");
    expect(surfaceOf({ specs: { surface: "2.0" } })).toBe("2.0");
    expect(surfaceOf({})).toBe(LEGACY_SURFACE);
    expect(surfaceOf(null)).toBe(LEGACY_SURFACE);
    expect(surfaceOf({ specs: { surface: "nope" } })).toBe(LEGACY_SURFACE);
  });
  it("surfaceMajor: the major number; 1 for the legacy marker and junk; null while unknown", () => {
    expect(surfaceMajor("3.0")).toBe(3);
    expect(surfaceMajor("2.1")).toBe(2);
    expect(surfaceMajor(LEGACY_SURFACE)).toBe(1);
    expect(surfaceMajor("nope")).toBe(1);
    expect(surfaceMajor(null)).toBeNull();
  });
});

describe("the hit envelope", () => {
  it("reads id/path — the envelope under every surface version", () => {
    expect(hitId({ id: "d_1", path: "/a.md" })).toBe("d_1");
    expect(hitPath({ id: "d_1", path: "/a.md" })).toBe("/a.md");
    expect(hitPath({ id: "d_1", path: "a.md" })).toBe("a.md");
    expect(hitId({})).toBeNull();
    expect(hitPath(null)).toBeNull();
    expect(hitId({ id: 3 })).toBeNull();
    expect(hitId({ $id: "d_1", $path: "/a.md" })).toBeNull(); // the unreleased `$` interlude is not read
  });
  it("spells the attributes for the server's language: bare on 3.0, `$` before and while unknown", () => {
    expect(bareAttributes("3.0")).toBe(true);
    expect(bareAttributes("2.0")).toBe(false);
    expect(bareAttributes(null)).toBe(false);
    expect(attr("3.0", "title")).toBe("title");
    expect(attr("3.1", "updated_at")).toBe("updated_at");
    expect(attr("2.0", "path")).toBe("$path");
    expect(attr(null, "path")).toBe("$path");
  });
  it("roots paths idempotently", () => {
    expect(rooted("a/b.md")).toBe("/a/b.md");
    expect(rooted("/a/b.md")).toBe("/a/b.md");
    expect(rooted("//a.md")).toBe("/a.md");
  });
});
