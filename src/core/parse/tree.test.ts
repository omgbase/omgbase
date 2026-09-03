import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseTree, assertFullCoverage } from "./tree.js";

describe("parseTree — trivia attachment", () => {
  it("attaches inter-block blank lines to the preceding block (trailing-attach)", () => {
    const src = "# A\n\n\nParagraph.\n";
    const tree = parseTree(src);
    expect(tree.leadingTrivia).toBe("");
    expect(tree.children[0]?.raw).toBe("# A");
    expect(tree.children[0]?.trivia).toBe("\n\n\n");
    expect(tree.children[1]?.raw).toBe("Paragraph.");
    expect(tree.children[1]?.trivia).toBe("\n");
  });

  it("attaches bytes before the first block as document-leading trivia", () => {
    const src = "\n\n<!-- top comment -->\n\n# A\n";
    const tree = parseTree(src);
    // The HTML comment parses as its own block; leading blanks precede it.
    expect(tree.leadingTrivia).toBe("\n\n");
    expect(tree.children[0]?.type).toBe("html_block");
  });

  it("treats an all-whitespace file as pure leading trivia", () => {
    const src = "\n\n   \n";
    const tree = parseTree(src);
    expect(tree.children).toHaveLength(0);
    expect(tree.leadingTrivia).toBe(src);
    expect(assertFullCoverage(tree)).toBe(true);
  });
});

describe("full-coverage invariant (03 §2.1 #2)", () => {
  const fixtures = [
    "# Heading\n\nParagraph one.\n\nParagraph two.\n",
    "---\ntitle: x\n---\n\n# H\n\nBody.\n",
    "- [ ] a\n- [x] b\n\n```js\ncode\n```\n",
    "no trailing newline",
    "\n\n\nleading blanks then text\n",
    "| a | b |\n| - | - |\n| 1 | 2 |\n\ntrailing para\n",
    "> quote\n>\n> more\n\npara\n",
  ];

  it.each(fixtures)("tiles the source exactly: %j", (src) => {
    const tree = parseTree(src);
    expect(assertFullCoverage(tree)).toBe(true);
    const rebuilt =
      tree.leadingTrivia + tree.children.map((b) => b.raw + b.trivia).join("");
    expect(rebuilt).toBe(src);
  });

  it("holds over generated multi-block documents", () => {
    const blockArb = fc.oneof(
      fc.constant("# Heading"),
      fc.constant("Just a paragraph."),
      fc.constant("- item one\n- item two"),
      fc.constant("```\ncode\n```"),
      fc.constant("> a quote"),
      fc.constant("---"),
      fc.stringMatching(/^[a-z ]{1,20}$/),
    );
    const sepArb = fc.oneof(fc.constant("\n\n"), fc.constant("\n\n\n"));

    fc.assert(
      fc.property(fc.array(blockArb, { minLength: 1, maxLength: 8 }), sepArb, (blocks, sep) => {
        const src = blocks.join(sep) + "\n";
        const tree = parseTree(src);
        expect(assertFullCoverage(tree)).toBe(true);
        const rebuilt =
          tree.leadingTrivia + tree.children.map((b) => b.raw + b.trivia).join("");
        expect(rebuilt).toBe(src);
      }),
      { numRuns: 300 },
    );
  });
});
