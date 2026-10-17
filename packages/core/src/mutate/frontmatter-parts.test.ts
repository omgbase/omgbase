import { describe, expect, it } from "vitest";
import { entryKeyOf, joinFrontmatterParts, leadOf, splitFrontmatterRaw, splitFrontmatterTrivia, splitLines } from "./frontmatter-parts.js";

// spec/mutate §11.3 "Frontmatter entries" — the split rule, byte-exact and lexical.

const keysOf = (raw: string): (string | null)[] => splitFrontmatterRaw(raw).map((p) => p.key);
const bytesOf = (raw: string): string[] => splitFrontmatterRaw(raw).map((p) => p.bytes);

describe("splitFrontmatterRaw (spec/mutate §11.3 'Frontmatter entries')", () => {
  it("fences are null-key parts; one part per top-level entry", () => {
    const raw = "---\nlayer: draft\ntitle: A\n---";
    expect(bytesOf(raw)).toEqual(["---\n", "layer: draft\n", "title: A\n", "---"]);
    expect(keysOf(raw)).toEqual([null, "layer", "title", null]);
  });

  it("concatenates back to the raw for every shape", () => {
    for (const raw of [
      "---\n---",
      "---\r\n---",
      "---\nlayer: draft\n---",
      "---\n# c\n\na: 1\n# d\nb:\n- x\n- y\nc: |\n  l1\n\n  l3\n# end\n\n---",
      "---\n- a\n- b\n---",
      "---\njust text\n---",
      "---\r\na: 1\r\nb:\r\n  - x\r\n---",
      "---\ndup: 1\ndup: 2\n---",
      "---\n\"q\": 1\n'single': 2\n---",
    ]) {
      expect(joinFrontmatterParts(splitFrontmatterRaw(raw))).toBe(raw);
    }
  });

  it("lines before the first entry are one null part; a comment between entries leads the FOLLOWING key; trailing lead lines are one null part", () => {
    const raw = "---\n# doc\n\na: 1\n# about b\nb: 2\n# end\n\n---";
    expect(bytesOf(raw)).toEqual(["---\n", "# doc\n\n", "a: 1\n", "# about b\nb: 2\n", "# end\n\n", "---"]);
    expect(keysOf(raw)).toEqual([null, null, "a", "b", null, null]);
  });

  it("continuation lines belong to the entry above: column-0 sequences, block scalars with blank lines, nested mappings, indented comments", () => {
    const raw = "---\ntags:\n- a\n- b\ndesc: |\n  one\n\n  three\n  # not a comment\nnested:\n  x: 1\n---";
    expect(bytesOf(raw)).toEqual(["---\n", "tags:\n- a\n- b\n", "desc: |\n  one\n\n  three\n  # not a comment\n", "nested:\n  x: 1\n", "---"]);
  });

  it("a body with no entry line is one null part", () => {
    expect(bytesOf("---\n- a\n- b\n---")).toEqual(["---\n", "- a\n- b\n", "---"]);
    expect(keysOf("---\nscalar\n---")).toEqual([null, null, null]);
    expect(bytesOf("---\n# only\n---")).toEqual(["---\n", "# only\n", "---"]);
    expect(bytesOf("---\n---")).toEqual(["---\n", "---"]);
  });

  it("keeps CRLF endings per part", () => {
    expect(bytesOf("---\r\na: 1\r\nb: 2\r\n---")).toEqual(["---\r\n", "a: 1\r\n", "b: 2\r\n", "---"]);
  });

  it("spells quoted keys unquoted; duplicates are separate parts with the same key", () => {
    const parts = splitFrontmatterRaw("---\n\"quoted key\": 1\n'it''s': 2\n\"a\\\"b\": 3\ndup: 1\ndup: 2\n---");
    expect(parts.map((p) => p.key)).toEqual([null, "quoted key", "it's", 'a"b', "dup", "dup", null]);
  });

  it("an empty or null value is still an entry", () => {
    expect(keysOf("---\nempty:\nnothing: null\n---")).toEqual([null, "empty", "nothing", null]);
  });
});

describe("entryKeyOf", () => {
  it("accepts plain and quoted keys and refuses what cannot open an entry", () => {
    expect(entryKeyOf("a: 1\n")).toBe("a");
    expect(entryKeyOf("a:b: 1")).toBe("a:b");
    expect(entryKeyOf("a:\n")).toBe("a");
    expect(entryKeyOf("a:\t1")).toBe("a");
    expect(entryKeyOf("-x: 1")).toBe("-x");
    expect(entryKeyOf("---x: 2")).toBe("---x");
    expect(entryKeyOf("key with spaces : 1")).toBe("key with spaces");
    expect(entryKeyOf('"q": 1')).toBe("q");
    expect(entryKeyOf("'s' : 1")).toBe("s");
    for (const line of ["", "  a: 1", "# a: 1", "- a: 1", "-", "? a", ": a", "--- ", "...", "[a]: 1", "{a: 1}", "&x a: 1", "*x", "!tag a: 1", "|", "a #b: 1", "a:1", "a", '"unclosed: 1', '"q" 1', "%YAML 1.2"]) {
      expect(entryKeyOf(line), line).toBeNull();
    }
  });
});

describe("splitFrontmatterTrivia / leadOf / splitLines", () => {
  it("cuts a document head at the closing fence", () => {
    expect(splitFrontmatterTrivia("---\na: 1\n---\n\n")).toEqual({ raw: "---\na: 1\n---", trivia: "\n\n" });
    expect(splitFrontmatterTrivia("---\r\na: 1\r\n--- \r\n")).toEqual({ raw: "---\r\na: 1\r\n--- ", trivia: "\r\n" });
    expect(splitFrontmatterTrivia("---\na: 1\n")).toBeNull();
  });
  it("leadOf is the comment/blank run before the key line", () => {
    const parts = splitFrontmatterRaw("---\na: 1\n\n# about b\nb: 2\n---");
    expect(leadOf(parts[2]!)).toBe("\n# about b\n");
    expect(leadOf(parts[1]!)).toBe("");
    expect(leadOf(parts[0]!)).toBe("");
  });
  it("splitLines keeps endings", () => {
    expect(splitLines("a\nb\r\nc")).toEqual(["a\n", "b\r\n", "c"]);
    expect(splitLines("")).toEqual([""]);
    expect(splitLines("a\n")).toEqual(["a\n", ""]);
  });
});
