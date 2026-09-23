import { describe, it, expect } from "vitest";
import { extractFromBlock, extractFromFrontmatter, normalizeUri, maskCode } from "./extract.js";

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

describe("extractFromBlock — code is not prose (extraction_version x2)", () => {
  it("a code_fence block yields no edges even when it contains links", () => {
    const raw = "```md\nSee [guide](/docs/guide.md) and [[Some Note]] or https://example.com\n```";
    expect(extractFromBlock("b_1", "code_fence", raw)).toHaveLength(0);
  });

  it("a fence nested in a container block's raw is masked too", () => {
    const raw = "- item\n\n  ```\n  [placeholder](/missing.md)\n  ```\n";
    expect(extractFromBlock("b_1", "list_item", raw)).toHaveLength(0);
  });

  it("an inline-code wikilink is not an edge", () => {
    expect(extractFromBlock("b_1", "paragraph", "Write `[[Some Note]]` to link a note.")).toHaveLength(0);
    // multi-backtick span containing single backticks
    expect(extractFromBlock("b_2", "paragraph", "Use `` `[[x]]` `` for literal backticks.")).toHaveLength(0);
    // regex fragment with square brackets + parens
    expect(extractFromBlock("b_3", "paragraph", "Match `[a-z]+(foo)` here.")).toHaveLength(0);
  });

  it("the same link outside code is still an edge", () => {
    const e = extractFromBlock("b_1", "paragraph", "See [[Some Note]] for details.");
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ predicate: "references", target: "Some Note" });
  });

  it("a paragraph mixing prose and code links yields only the prose link", () => {
    const e = extractFromBlock("b_1", "paragraph", "Prose [[Real]] and code `[[Fake]]` plus `[t](/fake.md)` but [t](/real.md).");
    expect(e.map((x) => x.target).sort()).toEqual(["/real.md", "Real"]);
  });

  it("an unmatched backtick run stays literal (CommonMark) and does not swallow the rest", () => {
    const e = extractFromBlock("b_1", "paragraph", "A stray ` here, then [[Real]].");
    expect(e.map((x) => x.target)).toEqual(["Real"]);
  });

  it("maskCode is length-preserving and keeps newlines", () => {
    const raw = "x `[[a]]` y\n```\n[b](/b.md)\n```\nz";
    const masked = maskCode(raw);
    expect(masked.length).toBe(raw.length);
    expect(masked.split("\n").length).toBe(raw.split("\n").length);
    expect(masked).not.toContain("[[a]]");
    expect(masked).not.toContain("/b.md");
    expect(masked.startsWith("x ")).toBe(true);
    expect(masked.endsWith("\nz")).toBe(true);
  });
});
