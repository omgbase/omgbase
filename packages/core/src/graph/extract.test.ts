import { describe, it, expect } from "vitest";
import { extractFromBlock, extractFromFrontmatter, normalizeUri } from "./extract.js";

describe("extractFromBlock — link matrix (05 §2)", () => {
  it("inline markdown link → references document with anchor", () => {
    const e = extractFromBlock("b_1", "paragraph", "See [the risks](/projects/foo.md#Risks) here.");
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ predicate: "references", dstKind: "document", target: "/projects/foo.md", anchor: "Risks", provenance: "link" });
  });

  it("wikilink with ^ref → block-kind edge", () => {
    const e = extractFromBlock("b_1", "paragraph", "As in [[note^abc123]].");
    expect(e[0]).toMatchObject({ predicate: "references", dstKind: "block", target: "note", anchor: "abc123" });
  });

  it("image → embeds external", () => {
    const e = extractFromBlock("b_1", "paragraph", "![alt](https://example.com/x.png)");
    expect(e[0]).toMatchObject({ predicate: "embeds", dstKind: "external" });
    expect(e[0]!.target).toBe("https://example.com/x.png");
  });

  it("bare URL and autolink → external references", () => {
    const bare = extractFromBlock("b_1", "paragraph", "visit https://example.com/page for more");
    expect(bare[0]).toMatchObject({ predicate: "references", dstKind: "external" });
    const auto = extractFromBlock("b_2", "paragraph", "email <https://ex.com>");
    expect(auto[0]!.dstKind).toBe("external");
  });

  it("inline field key:: [[target]] → typed edge, not double-counted as a link", () => {
    const e = extractFromBlock("b_1", "paragraph", "related:: [[Concept One]]");
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ predicate: "related", srcField: "related", dstKind: "document", target: "Concept One", provenance: "inline_field" });
  });

  it("inline field key:: /path.md", () => {
    const e = extractFromBlock("b_1", "paragraph", "source:: /refs/a.md");
    expect(e[0]).toMatchObject({ predicate: "source", target: "/refs/a.md", provenance: "inline_field" });
  });

  it("dedups repeated identical links in one block", () => {
    const e = extractFromBlock("b_1", "paragraph", "[a](/x.md) and again [b](/x.md)");
    expect(e).toHaveLength(1);
  });
});

describe("extractFromFrontmatter", () => {
  it("path and wikilink relation fields → doc-grain edges with the field recorded", () => {
    const e = extractFromFrontmatter({ depends_on: ["/a.md", "[[B Note]]"], title: "not a link" });
    expect(e).toHaveLength(2);
    expect(e.every((x) => x.predicate === "depends_on" && x.srcBlock === null && x.provenance === "frontmatter")).toBe(true);
    expect(e.map((x) => x.target).sort()).toEqual(["/a.md", "B Note"]);
  });

  it("ignores non-link scalar frontmatter", () => {
    expect(extractFromFrontmatter({ layer: "working", count: 3 })).toHaveLength(0);
  });
});

describe("normalizeUri", () => {
  it("lowercases scheme/host, drops default port + fragment + trailing slash", () => {
    expect(normalizeUri("HTTPS://Example.COM:443/path/#frag")).toBe("https://example.com/path");
  });
});
