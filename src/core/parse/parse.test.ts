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
});
