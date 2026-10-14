import { describe, expect, it } from "vitest";
import { diffLineKind, diffStats, editScript, formatStats, hunksOf, splitLines, unifiedDiff } from "../src/lib/diff.ts";

describe("the edit script (Myers, spec/surface §3's tie rule)", () => {
  it("identical, empty, pure insertion, pure deletion", () => {
    expect(editScript(["a"], ["a"])).toEqual([{ kind: "ctx", text: "a" }]);
    expect(editScript([], [])).toEqual([]);
    expect(editScript([], ["a", "b"])).toEqual([{ kind: "add", text: "a" }, { kind: "add", text: "b" }]);
    expect(editScript(["a", "b"], [])).toEqual([{ kind: "del", text: "a" }, { kind: "del", text: "b" }]);
  });
  it("a change in the middle: deletion before insertion", () => {
    expect(editScript(["a", "b", "c"], ["a", "x", "c"])).toEqual([
      { kind: "ctx", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "x" }, { kind: "ctx", text: "c" },
    ]);
  });
  it("is a valid script: deletions and context replay the old text, additions and context the new", () => {
    const a = "the quick brown fox\njumps over\nthe lazy dog\nend".split("\n");
    const b = "the quick red fox\njumps over\nthe lazy cat\nand more\nend".split("\n");
    const s = editScript(a, b);
    expect(s.filter((l) => l.kind !== "add").map((l) => l.text)).toEqual(a);
    expect(s.filter((l) => l.kind !== "del").map((l) => l.text)).toEqual(b);
    expect(diffStats(s)).toEqual({ added: 3, removed: 2 });
    expect(formatStats(diffStats(s))).toBe("+3 −2");
  });
  it("splitLines: exactly split on \\n; an empty text has no lines; a trailing newline is an empty last line", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\n")).toEqual(["a", ""]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
  });
});

describe("unified hunks (3 lines of context, docs_diff_unified's format)", () => {
  it("one change with context on both sides", () => {
    const before = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";
    const after = "l1\nl2\nl3\nl4\nL5\nl6\nl7\nl8\nl9\n";
    expect(unifiedDiff(before, after)).toBe("@@ -2,7 +2,7 @@\n l2\n l3\n l4\n-l5\n+L5\n l6\n l7\n l8");
  });
  it("two changes whose contexts touch share a hunk; far apart they do not", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n");
    const near = before.replace("l5", "X").replace("l10", "Y");
    const hunks = hunksOf(editScript(splitLines(before), splitLines(near)));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldCount: 12, newStart: 1, newCount: 12 });
    const far = before.replace("l2", "X").replace("l19", "Y");
    expect(hunksOf(editScript(splitLines(before), splitLines(far)))).toHaveLength(2);
  });
  it("hunk headers: a length of 1 is the start alone; 0 lines is `a,0` with the line before the insertion point", () => {
    expect(unifiedDiff("a", "b")).toBe("@@ -1 +1 @@\n-a\n+b");
    expect(unifiedDiff("", "new")).toBe("@@ -0,0 +1 @@\n+new");
    expect(unifiedDiff("gone", "")).toBe("@@ -1 +0,0 @@\n-gone");
    // An insertion after the last of two lines: old side `2,0`? No: context lines count — the hunk is -1,2 +1,3.
    expect(unifiedDiff("a\nb", "a\nb\nc")).toBe("@@ -1,2 +1,3 @@\n a\n b\n+c");
  });
  it("the alchemy frontmatter edit, as docs_diff_unified prints it", () => {
    const before = "---\ntitle: Alpha\nstatus: active\n---\n\n# Alpha\n\nBody.\n";
    const after = "---\ntitle: Alpha\nstatus: done\nowner: ada\n---\n\n# Alpha\n\nBody.\n";
    expect(unifiedDiff(before, after)).toBe("@@ -1,6 +1,7 @@\n ---\n title: Alpha\n-status: active\n+status: done\n+owner: ada\n ---\n \n # Alpha");
    expect(unifiedDiff(before, before)).toBe("");
  });
  it("classifies rendered lines", () => {
    expect("@@ -1 +1 @@\n-a\n+b\n c".split("\n").map(diffLineKind)).toEqual(["hunk", "del", "add", "ctx"]);
  });
});
