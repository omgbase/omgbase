import { describe, it, expect } from "vitest";
import { parseBlocks } from "./parse.js";

describe("parseBlocks", () => {
  it("maps top-level block types in document order", () => {
    const src = "---\ntitle: x\n---\n\n# Heading\n\nA paragraph.\n\n---\n\n<div>raw</div>\n";
    const blocks = parseBlocks(src);
    expect(blocks.map((b) => b.type)).toEqual([
      "frontmatter",
      "heading",
      "paragraph",
      "thematic_break",
      "html_block",
    ]);
  });

  it("records heading level in attrs", () => {
    const [h] = parseBlocks("### Deep\n");
    expect(h?.type).toBe("heading");
    expect(h?.attrs.level).toBe(3);
  });

  it("distinguishes tasks from plain list items via GFM checkbox", () => {
    const src = "- [ ] open\n- [x] done\n- plain\n";
    const [list] = parseBlocks(src);
    expect(list?.type).toBe("list");
    expect(list?.children.map((c) => c.type)).toEqual(["task", "task", "list_item"]);
    expect(list?.children[0]?.attrs.checked).toBe(false);
    expect(list?.children[1]?.attrs.checked).toBe(true);
    expect(list?.children[2]?.attrs).toEqual({});
  });

  it("captures code fence lang and info", () => {
    const [code] = parseBlocks("```ts title=x\nconst a = 1;\n```\n");
    expect(code?.type).toBe("code_fence");
    expect(code?.attrs.lang).toBe("ts");
    expect(code?.attrs.info).toBe("title=x");
  });

  it("preserves exact raw source slice per block", () => {
    const src = "# Title\n\nBody text.\n";
    const blocks = parseBlocks(src);
    expect(blocks[0]?.raw).toBe("# Title");
    expect(blocks[1]?.raw).toBe("Body text.");
  });

  it("treats frontmatter as first block with raw fences", () => {
    const src = "---\na: 1\n---\n\n# H\n";
    const [fm] = parseBlocks(src);
    expect(fm?.type).toBe("frontmatter");
    expect(fm?.raw).toBe("---\na: 1\n---");
  });

  it("nests table rows as blocks under a table", () => {
    const src = "| a | b |\n| - | - |\n| 1 | 2 |\n";
    const [table] = parseBlocks(src);
    expect(table?.type).toBe("table");
    expect(table?.children.every((c) => c.type === "table_row")).toBe(true);
    expect(table?.children.length).toBe(2);
  });

  describe("byte-order mark (spec/format §1 inv. 6, §6)", () => {
    // micromark strips one leading U+FEFF before tokenizing and reports
    // positions relative to the stripped string; spans must index the source.
    it("shifts every span by one code unit so raw matches the true source", () => {
      const src = "\uFEFF# Doc with BOM\n\nBody.\n";
      const blocks = parseBlocks(src);
      expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph"]);
      expect(blocks[0]?.span).toEqual({ start: 1, end: 15 });
      expect(blocks[0]?.raw).toBe("# Doc with BOM");
      expect(blocks[0]?.text).toBe("Doc with BOM");
      expect(blocks[1]?.span).toEqual({ start: 17, end: 22 });
      expect(blocks[1]?.raw).toBe("Body.");
      for (const b of blocks) expect(b.raw).toBe(src.slice(b.span.start, b.span.end));
    });

    it("shifts nested spans too", () => {
      const src = "\uFEFF- a\n- b\n";
      const [list] = parseBlocks(src);
      expect(list?.span).toEqual({ start: 1, end: 8 });
      expect(list?.children.map((c) => c.raw)).toEqual(["- a", "- b"]);
      expect(list?.children.map((c) => c.span)).toEqual([
        { start: 1, end: 4 },
        { start: 5, end: 8 },
      ]);
    });

    it("does not shift when there is no leading BOM, even with U+FEFF elsewhere", () => {
      const blocks = parseBlocks("x \uFEFF y\n\npara\n");
      expect(blocks.map((b) => b.span)).toEqual([
        { start: 0, end: 5 },
        { start: 7, end: 11 },
      ]);
      expect(blocks[0]?.raw).toBe("x \uFEFF y");
    });

    it("strips only one BOM: a second one is content", () => {
      const src = "\uFEFF\uFEFF# not a heading\n";
      const [p] = parseBlocks(src);
      expect(p?.type).toBe("paragraph");
      expect(p?.span).toEqual({ start: 1, end: 17 });
      expect(p?.raw).toBe("\uFEFF# not a heading");
    });
  });

  describe("spans exclude the terminating line ending (spec/format §1 inv. 4)", () => {
    it("trims the trailing line endings micromark hands an unclosed fence at EOF", () => {
      const [code] = parseBlocks("```js\nconst x = 1;\n\n\n");
      expect(code?.type).toBe("code_fence");
      expect(code?.raw).toBe("```js\nconst x = 1;");
      expect(code?.span).toEqual({ start: 0, end: 18 });
    });

    it("trims CRLF too", () => {
      const [code] = parseBlocks("```\ncode\r\n");
      expect(code?.raw).toBe("```\ncode");
    });

    it("trims an unclosed HTML comment at EOF", () => {
      const [html] = parseBlocks("<!-- open\n");
      expect(html?.type).toBe("html_block");
      expect(html?.raw).toBe("<!-- open");
    });

    it("trims the containers of an unclosed fence as well as the fence", () => {
      const [list] = parseBlocks("- item\n\n  ```\n  code\n");
      expect(list?.raw).toBe("- item\n\n  ```\n  code");
      const item = list?.children[0];
      expect(item?.raw).toBe("- item\n\n  ```\n  code");
      expect(item?.children.map((c) => c.raw)).toEqual(["item", "```\n  code"]);
    });

    it("leaves a fence-only document as the bare fence", () => {
      const [code] = parseBlocks("```\n");
      expect(code?.raw).toBe("```");
    });
  });
});
