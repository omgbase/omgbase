import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { DOC_ATTRIBUTES, HIT_ENVELOPE_KEYS, LEGACY_SURFACE, attr, bareArguments, bareAttributes, docArg, docLocator, hitId, hitPath, outerPathOperand, pathExpr, pathOperand, rooted, rootsPaths, rowRef, samePath, serverPath, surfaceMajor, surfaceOf, unrooted } from "../src/lib/paths.ts";

describe("hitId / hitPath / rowRef — the hit envelope (`id`/`path` on every surface version)", () => {
  it("reads `id`/`path` as returned", () => {
    expect(hitId({ id: "d_1", path: "/a.md" })).toBe("d_1");
    expect(hitPath({ id: "d_1", path: "/a.md" })).toBe("/a.md");
    expect(hitId({ id: "d_1", path: "a.md" })).toBe("d_1");
    expect(hitPath({ id: "d_1", path: "a.md" })).toBe("a.md");
    // The unreleased `$id`/`$path` interlude is not read: a 3.0 server spells the envelope bare.
    expect(hitId({ $id: "d_1", $path: "/a.md" })).toBeNull();
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
  it("names the envelope", () => {
    expect([...HIT_ENVELOPE_KEYS].sort()).toEqual(["id", "path"]);
  });
});

describe("attr / bareAttributes — the attribute spelling in the language (spec/surface §1.2)", () => {
  it("is bare on 3.0 and later, `$`-prefixed before and while unknown", () => {
    expect(bareAttributes("3.0")).toBe(true);
    expect(bareAttributes("3.2")).toBe(true);
    expect(bareAttributes("2.0")).toBe(false);
    expect(bareAttributes(LEGACY_SURFACE)).toBe(false);
    expect(bareAttributes(null)).toBe(false);
    expect(attr("3.0", "path")).toBe("path");
    expect(attr("3.0", "updated_at")).toBe("updated_at");
    expect(attr("2.0", "path")).toBe("$path");
    expect(attr(null, "title")).toBe("$title");
  });
  it("lists the docs attributes a bare name reads on 3.0", () => {
    expect([...DOC_ATTRIBUTES].sort()).toEqual(["format", "hash", "id", "path", "raw", "tags", "title", "updated_at"]);
  });
});

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

describe("pathExpr / pathOperand / outerPathOperand", () => {
  it("yields the attribute alone on ≥ 2.0 (bare on 3.0) and a slash-prefixed one before", () => {
    expect(pathExpr("3.0")).toBe("path");
    expect(pathExpr("2.0")).toBe("$path");
    expect(pathExpr("2.0", "^$path")).toBe("^$path");
    expect(pathExpr("1.5")).toBe('"/" + $path');
    expect(pathExpr("1.5", "^$path")).toBe('"/" + ^$path');
    expect(pathExpr(LEGACY_SURFACE, "^^$dst_path")).toBe('"/" + ^^$dst_path');
    expect(pathExpr(null)).toBe('"/" + $path'); // unknown → the conservative form
  });
  it("parenthesizes the 1.x form as an operand, and every form parses", () => {
    expect(pathOperand("3.0", "^path")).toBe("^path");
    expect(pathOperand("2.0", "^$path")).toBe("^$path");
    expect(pathOperand("1.5", "^$path")).toBe('("/" + ^$path)');
    expect(outerPathOperand("3.0")).toBe("^path");
    expect(outerPathOperand("2.0")).toBe("^$path");
    expect(outerPathOperand("1.5")).toBe('("/" + ^$path)');
    for (const surface of ["1.5", "2.0", "3.0"]) {
      expect(() => parse(`select ${attr(surface, "path")} from docs follow $it.in collect { where ${outerPathOperand(surface)} in list(after) }`)).not.toThrow();
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
  it("spells the document argument `id`/`path` on 3.0 and `doc` before (spec/surface §4 Arguments)", () => {
    expect(bareArguments("3.0")).toBe(true);
    expect(bareArguments("2.0")).toBe(false);
    expect(bareArguments(null)).toBe(false);
    expect(docLocator("3.0", "d_77ptprj")).toEqual({ id: "d_77ptprj" });
    expect(docLocator("3.0", "d_0")).toEqual({ id: "d_0" });
    expect(docLocator("3.0", "/timeline/kickoff.md")).toEqual({ path: "/timeline/kickoff.md" });
    expect(docLocator("2.0", "/timeline/kickoff.md")).toEqual({ doc: "/timeline/kickoff.md" });
    expect(docLocator("1.5", "/timeline/kickoff.md")).toEqual({ doc: "timeline/kickoff.md" });
    expect(docLocator("2.0", "d_77ptprj")).toEqual({ doc: "d_77ptprj" });
  });
});
