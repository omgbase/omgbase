import { describe, it, expect } from "vitest";
import {
  hashHex,
  shortHash,
  normalizeText,
  normalizeVisibleText,
  visibleText,
  isTextContainer,
  canonicalAttrs,
  serializeTreeEntries,
  treeHash,
} from "./hash.js";

describe("hash — golden vectors", () => {
  it("sha256 of known strings", () => {
    expect(hashHex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(hashHex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("shortHash is first 16 hex chars", () => {
    expect(shortHash(hashHex("hello"))).toBe("2cf24dba5fb0a30e");
  });
});

describe("normalizeText — 02 §5.2", () => {
  it("collapses internal whitespace and drops blank lines", () => {
    expect(normalizeText("a   b")).toBe("a b");
    expect(normalizeText("  leading\n\n  trailing  ")).toBe("leading trailing");
    expect(normalizeText("one\ntwo\nthree")).toBe("one two three");
  });

  it("handles CRLF and tabs", () => {
    expect(normalizeText("a\tb\r\nc")).toBe("a b c");
  });

  it("NFC-normalizes unicode", () => {
    // 'e' + combining acute === precomposed 'é'
    expect(normalizeText("café")).toBe("café");
  });
});

// spec/format/README.md §4.1 (block model 0.2): `text` is what a reader sees.
describe("normalizeVisibleText — leaf rule (spec/format §4.1)", () => {
  describe("heading", () => {
    it("ATX: strips the opening hashes", () => {
      expect(normalizeVisibleText("# Title", "heading")).toBe("Title");
      expect(normalizeVisibleText("###   Deep  title", "heading")).toBe("Deep title");
    });
    it("ATX: strips closing hashes and trailing whitespace", () => {
      expect(normalizeVisibleText("## Title ##", "heading")).toBe("Title");
      expect(normalizeVisibleText("# Spaced #   ", "heading")).toBe("Spaced");
      expect(normalizeVisibleText("### Trailing spaces   ", "heading")).toBe("Trailing spaces");
    });
    it("ATX: an empty heading and closing sequences (tightened 0.2 prose)", () => {
      expect(normalizeVisibleText("#", "heading")).toBe("");
      expect(normalizeVisibleText("### ###", "heading")).toBe("");
      expect(normalizeVisibleText("# a #", "heading")).toBe("a");
      expect(normalizeVisibleText("# a#", "heading")).toBe("a#");
      expect(normalizeVisibleText("#\ttabbed\t#", "heading")).toBe("tabbed");
      expect(normalizeVisibleText("   # indented", "heading")).toBe("indented");
    });
    it("setext iff raw has a line ending: content starting with # keeps it and loses the underline", () => {
      expect(normalizeVisibleText("#hashtag\n====", "heading")).toBe("#hashtag");
    });
    it("ATX: an escaped or inline hash is content", () => {
      expect(normalizeVisibleText("# C# and \\# stay", "heading")).toBe("C# and \\# stay");
    });
    it("setext: drops the underline, keeps every content line", () => {
      expect(normalizeVisibleText("Title\n=====", "heading")).toBe("Title");
      expect(normalizeVisibleText("Sub\n---  ", "heading")).toBe("Sub");
      expect(normalizeVisibleText("Title spans\ntwo lines\n===", "heading")).toBe("Title spans two lines");
    });
  });

  describe("frontmatter", () => {
    it("drops the fences and keeps the body lines", () => {
      expect(normalizeVisibleText("---\ntitle: x\ntags: [a, b]\n---", "frontmatter")).toBe("title: x tags: [a, b]");
    });
    it("blank lines inside the body are dropped like any other", () => {
      expect(normalizeVisibleText("---\ntitle: x\n\ntags: [a]\n\n---", "frontmatter")).toBe("title: x tags: [a]");
    });
    it("empty frontmatter has no text", () => {
      expect(normalizeVisibleText("---\n---", "frontmatter")).toBe("");
    });
  });

  describe("code_fence", () => {
    it("backtick fence: drops the info line and the closing fence", () => {
      expect(normalizeVisibleText("```js\nconst x = 1;\nconsole.log(x);\n```", "code_fence")).toBe("const x = 1; console.log(x);");
    });
    it("tilde fence", () => {
      expect(normalizeVisibleText("~~~py\nprint(1)\n~~~", "code_fence")).toBe("print(1)");
    });
    it("unclosed fence: only the opener is dropped", () => {
      expect(normalizeVisibleText("```js\nconst x = 1;\nnever closed", "code_fence")).toBe("const x = 1; never closed");
      expect(normalizeVisibleText("```js", "code_fence")).toBe("");
    });
    it("a closing fence longer than the opener still closes", () => {
      expect(normalizeVisibleText("```\ncode\n`````", "code_fence")).toBe("code");
    });
    it("the closer must be the opener's character, at least as long", () => {
      expect(normalizeVisibleText("```\ncode\n~~~", "code_fence")).toBe("code ~~~");
      expect(normalizeVisibleText("````\ncode\n```", "code_fence")).toBe("code ```");
      expect(normalizeVisibleText("~~~\ncode\n   ~~~~\t", "code_fence")).toBe("code");
    });
    it("a last line with text after the backticks is content, not a closer", () => {
      expect(normalizeVisibleText("```\ncode\n``` trailing", "code_fence")).toBe("code ``` trailing");
    });
    it("indented code: nothing to drop, indentation trims away", () => {
      expect(normalizeVisibleText("    indented code\n    second line", "code_fence")).toBe("indented code second line");
    });
    it("code lines that themselves begin with > survive at depth 0", () => {
      expect(normalizeVisibleText("```\n> quoted in code\n```", "code_fence")).toBe("> quoted in code");
    });
  });

  describe("list_item / task (childless)", () => {
    it("strips bullet and ordered markers at the very start only", () => {
      expect(normalizeVisibleText("- one", "list_item")).toBe("one");
      expect(normalizeVisibleText("* star", "list_item")).toBe("star");
      expect(normalizeVisibleText("+ plus", "list_item")).toBe("plus");
      expect(normalizeVisibleText("100. hundred", "list_item")).toBe("hundred");
      expect(normalizeVisibleText("1) paren", "list_item")).toBe("paren");
      expect(normalizeVisibleText("- a\n  2. not a marker", "list_item")).toBe("a 2. not a marker");
    });
    it("strips the checkbox after the marker", () => {
      expect(normalizeVisibleText("- [ ] open", "task")).toBe("open");
      expect(normalizeVisibleText("- [x] done", "task")).toBe("done");
      expect(normalizeVisibleText("- [X] DONE", "task")).toBe("DONE");
    });
    it("a lone checkbox-looking paragraph is untouched", () => {
      expect(normalizeVisibleText("[ ] not a task", "paragraph")).toBe("[ ] not a task");
    });
  });

  describe("table_row", () => {
    it("removes the outer pipes and turns cell separators into spaces", () => {
      expect(normalizeVisibleText("| Name | Value |", "table_row")).toBe("Name Value");
      expect(normalizeVisibleText("a | b", "table_row")).toBe("a b");
      expect(normalizeVisibleText("| p||q | r |", "table_row")).toBe("p q r");
    });
    it("an escaped pipe is inline content and stays; odd backslashes escape, even do not", () => {
      expect(normalizeVisibleText("| x \\| y | z |", "table_row")).toBe("x \\| y z");
      expect(normalizeVisibleText("| a | b\\|", "table_row")).toBe("a b\\|");
      expect(normalizeVisibleText("| a | b \\|  ", "table_row")).toBe("a b \\|");
      expect(normalizeVisibleText("| p \\\\| q |", "table_row")).toBe("p \\\\ q");
      expect(normalizeVisibleText("| p \\\\\\| q |", "table_row")).toBe("p \\\\\\| q");
    });
  });

  it("thematic_break has no visible text", () => {
    expect(normalizeVisibleText("---", "thematic_break")).toBe("");
    expect(normalizeVisibleText("* * *", "thematic_break")).toBe("");
    expect(normalizeVisibleText("___", "thematic_break")).toBe("");
  });

  it("paragraph, html_block and opaque keep everything but whitespace", () => {
    expect(normalizeVisibleText("First paragraph across\nmultiple   lines.", "paragraph")).toBe("First paragraph across multiple lines.");
    expect(normalizeVisibleText("<div>\n  <p>raw</p>\n</div>", "html_block")).toBe("<div> <p>raw</p> </div>");
    expect(normalizeVisibleText("[^1]: note", "opaque")).toBe("[^1]: note");
    expect(normalizeVisibleText("Text with *italic* and `code`", "paragraph")).toBe("Text with *italic* and `code`");
  });

  describe("blockquote depth (step 1)", () => {
    it("removes up to q markers from continuation lines, never from the first", () => {
      expect(normalizeVisibleText("level one\n> still one", "paragraph", 1)).toBe("level one still one");
      expect(normalizeVisibleText("deep\n> > still deep", "paragraph", 2)).toBe("deep still deep");
    });
    it("a lazy continuation line carries fewer than q markers", () => {
      expect(normalizeVisibleText("deep\nlazy line\n> back to one", "paragraph", 2)).toBe("deep lazy line back to one");
    });
    it("only q markers come off: a code line that itself starts with > survives", () => {
      expect(normalizeVisibleText("```\n> > not a quote\n> >> still code\n> ```", "code_fence", 1)).toBe("> not a quote >> still code");
    });
    it("marker stripping happens before the kind rule, so nested fences and underlines are recognized", () => {
      expect(normalizeVisibleText("Quoted title\n> ===", "heading", 1)).toBe("Quoted title");
    });
    it("a tab after > is not part of the marker; it trims away", () => {
      expect(normalizeVisibleText("a\n>\tb", "paragraph", 1)).toBe("a b");
      expect(normalizeVisibleText("a\n>  two spaces", "paragraph", 1)).toBe("a two spaces");
    });
    it("depth 0 strips nothing, even when a line starts with >", () => {
      expect(normalizeVisibleText("a\n> b", "paragraph")).toBe("a > b");
    });
  });

  it("CRLF and CR line endings split lines", () => {
    expect(normalizeVisibleText("Title\r\n=====", "heading")).toBe("Title");
    expect(normalizeVisibleText("```\rcode\r```", "code_fence")).toBe("code");
  });

  it("NFC-normalizes and keeps inner NBSP/FEFF", () => {
    expect(normalizeVisibleText("# Café", "heading")).toBe("Café");
    expect(normalizeVisibleText("a\u00a0b", "paragraph")).toBe("a\u00a0b");
  });
});

describe("visibleText — containers (spec/format §4.1)", () => {
  const leaf = (type: string, raw: string) => ({ type, raw, children: [] });

  it("classifies containers", () => {
    expect(isTextContainer("list", false)).toBe(true);
    expect(isTextContainer("blockquote", false)).toBe(true);
    expect(isTextContainer("table", false)).toBe(true);
    expect(isTextContainer("list_item", true)).toBe(true);
    expect(isTextContainer("task", true)).toBe(true);
    expect(isTextContainer("list_item", false)).toBe(false);
    expect(isTextContainer("paragraph", false)).toBe(false);
  });

  it("joins children's text with one space, skipping empties", () => {
    const list = { type: "list", raw: "- one\n- two\n- three", children: [leaf("list_item", "- one"), leaf("list_item", "- two"), leaf("list_item", "- three")] };
    expect(visibleText(list)).toBe("one two three");
    const table = {
      type: "table",
      raw: "| a | b |\n| - | - |\n| 1 | 2 |",
      children: [leaf("table_row", "| a | b |"), leaf("table_row", "| 1 | 2 |")],
    };
    expect(visibleText(table)).toBe("a b 1 2");
  });

  it("a container whose children all have empty text has empty text", () => {
    const bq = { type: "blockquote", raw: "> ---", children: [leaf("thematic_break", "---")] };
    expect(visibleText(bq)).toBe("");
    expect(visibleText({ type: "blockquote", raw: ">", children: [] })).toBe("");
  });

  it("a list_item with children loses its bullet through its children", () => {
    const item = {
      type: "list_item",
      raw: "- item with code:\n\n  ```sh\n  echo hi\n  ```",
      children: [leaf("paragraph", "item with code:"), leaf("code_fence", "```sh\n  echo hi\n  ```")],
    };
    expect(visibleText(item)).toBe("item with code: echo hi");
    const task = { type: "task", raw: "- [x] done\n  - [ ] nested", children: [leaf("paragraph", "done"), { type: "list", raw: "- [ ] nested", children: [leaf("task", "- [ ] nested")] }] };
    expect(visibleText(task)).toBe("done nested");
  });

  it("increments blockquote depth for a blockquote's descendants only", () => {
    const tree = {
      type: "blockquote",
      raw: "> level one\n> still one\n>\n> > nested two\n> > more",
      children: [
        leaf("paragraph", "level one\n> still one"),
        { type: "blockquote", raw: "> nested two\n> > more", children: [leaf("paragraph", "nested two\n> > more")] },
      ],
    };
    expect(visibleText(tree)).toBe("level one still one nested two more");
    // Inside a list inside the quote, depth is still 1.
    const quotedList = {
      type: "blockquote",
      raw: "> - a\n>   b",
      children: [{ type: "list", raw: "- a\n>   b", children: [leaf("list_item", "- a\n>   b")] }],
    };
    expect(visibleText(quotedList)).toBe("a b");
  });

  it("delegates leaves to normalizeVisibleText with the given depth", () => {
    expect(visibleText(leaf("heading", "# H"))).toBe("H");
    expect(visibleText(leaf("paragraph", "a\n> b"), 1)).toBe("a b");
  });

  it("leaves non-Markdown adapter kinds alone (whitespace normalization only)", () => {
    expect(visibleText({ type: "yaml:mapping_entry", raw: "key:  value", children: [leaf("yaml:scalar", "x")] })).toBe("key: value");
  });
});

describe("canonicalAttrs — 02 §5.1", () => {
  it("sorts keys lexicographically, no whitespace", () => {
    expect(canonicalAttrs({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalAttrs({})).toBe("{}");
  });

  it("recurses into nested objects and arrays", () => {
    expect(canonicalAttrs({ z: [3, 1], a: { y: 1, x: 2 } })).toBe(
      '{"a":{"x":2,"y":1},"z":[3,1]}',
    );
  });
});

describe("tree serialization — 02 §5.1", () => {
  const entry = {
    blockId: "b_k7z2p9q",
    rawHashHex: "deadbeef",
    childTreeHashHex: null,
    type: "paragraph",
    attrs: {},
    triviaHashHex: null,
  };

  it("serializes positional entries canonically", () => {
    expect(serializeTreeEntries([entry])).toBe(
      '[["b_k7z2p9q","deadbeef",null,"paragraph",{},null]]',
    );
  });

  it("tree hash matches golden vector", () => {
    expect(treeHash([entry]).toString("hex")).toBe(
      "1d1679899502cbd6996749f2eb8f2ebdc4f786fbb144edd4bec82a3dbd4cd4c1",
    );
  });

  it("structurally identical subtrees produce identical hashes", () => {
    const a = treeHash([entry]);
    const b = treeHash([{ ...entry }]);
    expect(a.equals(b)).toBe(true);
  });
});
