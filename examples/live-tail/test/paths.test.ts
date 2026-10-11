import { describe, expect, it } from "vitest";
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
  it("reads $id/$path (3.0) and id/path (2.x), preferring the $ spelling", () => {
    expect(hitId({ $id: "d_1", $path: "/a.md" })).toBe("d_1");
    expect(hitPath({ $id: "d_1", $path: "/a.md" })).toBe("/a.md");
    expect(hitId({ id: "d_1", path: "/a.md" })).toBe("d_1");
    expect(hitPath({ id: "d_1", path: "/a.md" })).toBe("/a.md");
    expect(hitPath({ id: "d_1", path: "a.md", $path: "/a.md" })).toBe("/a.md");
    expect(hitId({})).toBeNull();
    expect(hitPath(null)).toBeNull();
    expect(hitId({ $id: 3 })).toBeNull();
  });
  it("roots paths idempotently", () => {
    expect(rooted("a/b.md")).toBe("/a/b.md");
    expect(rooted("/a/b.md")).toBe("/a/b.md");
    expect(rooted("//a.md")).toBe("/a.md");
  });
});
