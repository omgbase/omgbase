import { describe, it, expect } from "vitest";
import { canonicalLinkPath, docDirOf, rewriteLinkDestinations, splitDestination } from "./link-destinations.js";

describe("link-destinations: destination-aware scanning", () => {
  it("splitDestination separates the path from a #heading / ^ref fragment", () => {
    expect(splitDestination("/a.md")).toEqual({ path: "/a.md", fragment: "" });
    expect(splitDestination("/a.md#Top")).toEqual({ path: "/a.md", fragment: "#Top" });
    expect(splitDestination("/a.md^ref")).toEqual({ path: "/a.md", fragment: "^ref" });
  });

  it("canonicalLinkPath drops the root slash and resolves ./ ../ against the doc dir", () => {
    expect(canonicalLinkPath("/a/b.md")).toBe("a/b.md");
    expect(canonicalLinkPath("a/b.md")).toBe("a/b.md");
    expect(canonicalLinkPath("./x.md", "sub/")).toBe("sub/x.md");
    expect(canonicalLinkPath("../x.md", "sub/deep/")).toBe("sub/x.md");
    expect(docDirOf("sub/deep/a.md")).toBe("sub/deep/");
    expect(docDirOf("a.md")).toBe("");
  });

  it("rewriteLinkDestinations touches only link destinations, never prose or inline code", () => {
    const raw = "See /b.md in prose, `[c](/b.md)` in code, [l](/b.md \"T\"), ![i](/b.md), [[/b.md]], [[/b.md|alias]], ``x `[[/b.md]]` y``\nrel:: /b.md";
    const seen: string[] = [];
    const out = rewriteLinkDestinations(raw, (dest) => { seen.push(dest); return dest === "/b.md" ? "/c.md" : null; });
    expect(seen).toEqual(["/b.md", "/b.md", "/b.md", "/b.md", "/b.md"]);
    expect(out).toBe("See /b.md in prose, `[c](/b.md)` in code, [l](/c.md \"T\"), ![i](/c.md), [[/c.md]], [[/c.md|alias]], ``x `[[/b.md]]` y``\nrel:: /c.md");
  });

  it("returning null leaves a link byte-identical", () => {
    const raw = "[a](/keep.md) [b](/go.md)";
    expect(rewriteLinkDestinations(raw, (d) => (d === "/go.md" ? "/gone.md" : null))).toBe("[a](/keep.md) [b](/gone.md)");
    expect(rewriteLinkDestinations(raw, () => null)).toBe(raw);
  });
});
