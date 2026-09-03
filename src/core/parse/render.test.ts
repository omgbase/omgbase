import { describe, it, expect } from "vitest";
import { parseTree } from "./tree.js";
import { render } from "./render.js";
import type { RawBlock } from "./types.js";

function newBlock(raw: string, trivia: string): RawBlock {
  return {
    type: "paragraph",
    span: { start: 0, end: 0 },
    raw,
    text: raw,
    attrs: {},
    children: [],
    trivia,
    dirty: true,
    anchors: [],
    outLinks: [],
  };
}

describe("render — splice", () => {
  it("is the identity on an unmodified tree (round-trip law)", () => {
    const src = "# Title\n\nBody paragraph.\n\n- a\n- b\n";
    expect(render(parseTree(src))).toBe(src);
  });

  it("splices an updated block, leaving neighbors' bytes verbatim", () => {
    const src = "# Title\n\nOld body.\n\nTail.\n";
    const tree = parseTree(src);
    const target = tree.children[1]!;
    target.raw = "New body text.";
    target.dirty = true;
    expect(render(tree)).toBe("# Title\n\nNew body text.\n\nTail.\n");
  });

  it("splices an inserted block with its own trivia", () => {
    const src = "# Title\n\nTail.\n";
    const tree = parseTree(src);
    // Insert a paragraph between the heading and the tail.
    tree.children.splice(1, 0, newBlock("Inserted.", "\n\n"));
    expect(render(tree)).toBe("# Title\n\nInserted.\n\nTail.\n");
  });

  it("splices a removed block by dropping it and its trivia", () => {
    const src = "# Title\n\nDoomed.\n\nTail.\n";
    const tree = parseTree(src);
    tree.children.splice(1, 1); // remove the middle paragraph
    expect(render(tree)).toBe("# Title\n\nTail.\n");
  });

  it("only re-serializes dirty blocks; untouched blocks keep exact bytes", () => {
    const src = "para one with   odd   spacing\n\npara two\n";
    const tree = parseTree(src);
    // Mark neither dirty: odd spacing must survive verbatim.
    expect(render(tree)).toBe(src);
  });
});
