import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { LEGACY_SURFACE, docArg, pathExpr, pathOperand, rooted, rootsPaths, samePath, serverPath, surfaceMajor, surfaceOf, unrooted } from "../src/lib/paths.ts";

describe("surfaceOf", () => {
  it("reads specs.surface off the version tool's result", () => {
    expect(surfaceOf({ engine: "typescript", specs: { oqx: "0.16", surface: "2.0" } })).toBe("2.0");
    expect(surfaceOf({ specs: { surface: "1.5" } })).toBe("1.5");
  });
  it("falls back to 1.x when the tool is missing or the shape is off", () => {
    for (const v of [undefined, null, {}, { specs: {} }, { specs: { surface: 2 } }, { specs: { surface: "two" } }, "not found"]) {
      expect(surfaceOf(v), JSON.stringify(v)).toBe(LEGACY_SURFACE);
    }
  });
});

describe("rootsPaths / surfaceMajor", () => {
  it("is true from 2.0 on, false for 1.x, unknown and the legacy marker", () => {
    expect(rootsPaths("2.0")).toBe(true);
    expect(rootsPaths("2.3")).toBe(true);
    expect(rootsPaths("10.0")).toBe(true);
    expect(rootsPaths("1.5")).toBe(false);
    expect(rootsPaths("1.99")).toBe(false);
    expect(rootsPaths(LEGACY_SURFACE)).toBe(false);
    expect(rootsPaths(null)).toBe(false);
    expect(surfaceMajor(null)).toBeNull();
    expect(surfaceMajor("1.x")).toBe(1);
    expect(surfaceMajor("2.0")).toBe(2);
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

describe("pathExpr / pathOperand", () => {
  it("yields the intrinsic alone on 2.0 and a slash-prefixed one before", () => {
    expect(pathExpr("2.0")).toBe("$path");
    expect(pathExpr("2.0", "^$path")).toBe("^$path");
    expect(pathExpr("1.5")).toBe('"/" + $path');
    expect(pathExpr("1.5", "^$path")).toBe('"/" + ^$path');
    expect(pathExpr(LEGACY_SURFACE, "^^$dst_path")).toBe('"/" + ^^$dst_path');
    expect(pathExpr(null)).toBe('"/" + $path'); // unknown → the conservative form
  });
  it("parenthesizes the 1.x form as an operand, and both forms parse", () => {
    expect(pathOperand("2.0", "^$path")).toBe("^$path");
    expect(pathOperand("1.5", "^$path")).toBe('("/" + ^$path)');
    for (const surface of ["1.5", "2.0"]) {
      expect(() => parse(`select $path from docs follow $it.in collect { where ${pathOperand(surface, "^$path")} in list(after) }`)).not.toThrow();
    }
  });
});

describe("serverPath / docArg", () => {
  it("spells a literal bare for 1.x and rooted for 2.0", () => {
    expect(serverPath("1.5", "/timeline/kickoff.md")).toBe("timeline/kickoff.md");
    expect(serverPath("1.5", "timeline/kickoff.md")).toBe("timeline/kickoff.md");
    expect(serverPath("2.0", "timeline/kickoff.md")).toBe("/timeline/kickoff.md");
    expect(serverPath("2.0", "/timeline/kickoff.md")).toBe("/timeline/kickoff.md");
    expect(serverPath(null, "/a.md")).toBe("a.md");
  });
  it("de-roots a path doc argument for 1.x only and never touches an id", () => {
    expect(docArg("1.5", "/timeline/kickoff.md")).toBe("timeline/kickoff.md");
    expect(docArg("2.0", "/timeline/kickoff.md")).toBe("/timeline/kickoff.md");
    expect(docArg("1.5", "d_77ptprj")).toBe("d_77ptprj");
    expect(docArg("2.0", "d_77ptprj")).toBe("d_77ptprj");
  });
});
