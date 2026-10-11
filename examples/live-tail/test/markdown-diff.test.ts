import { describe, expect, it } from "vitest";
import { alignRows, blockTree, coalesceGaps, consistent, describePieces, dropTrailingEmpty, markdown, markdownDiff, parseUnified, renderMarkdownDiff, sidesFromHunks, splitLines } from "../src/lib/markdown-diff.ts";
import type { Block, Piece } from "../src/lib/markdown-diff.ts";

/** A unified diff of two texts for the tests: ONE hunk over the changed region with `context` lines around it (a tiny LCS is overkill here: the fixtures change a contiguous run). */
function unified(before: string, after: string, context = 3): string {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const from = Math.max(0, head - context);
  const aEnd = Math.min(a.length, a.length - tail + context);
  const bEnd = Math.min(b.length, b.length - tail + context);
  const lines = [
    ...a.slice(from, head).map((l) => ` ${l}`),
    ...a.slice(head, a.length - tail).map((l) => `-${l}`),
    ...b.slice(head, b.length - tail).map((l) => `+${l}`),
    ...a.slice(a.length - tail, aEnd).map((l) => ` ${l}`),
  ];
  const oldCount = aEnd - from;
  const newCount = bEnd - from;
  return [`@@ -${oldCount === 0 ? from : from + 1},${oldCount} +${newCount === 0 ? from : from + 1},${newCount} @@`, ...lines].join("\n");
}

const DOC = [
  "---", "title: Alpha", "status: active", "---",
  "# Alpha", "",
  "The first cut of the renderer. Known gaps: wide tables,", "nested lists.", "",
  "## Steps", "",
  "- gather", "- build", "  - parse the tokens", "  - map the lines", "  - render the pieces", "- ship", "",
  "```js", "const a = 1;", "const b = 2;", "const c = 3;", "```", "",
  "| name | status |", "| --- | --- |", "| alpha | active |", "| beta | active |", "| gamma | planned |", "",
  "> quoted line one", "> quoted line two", "",
  "Tail paragraph.", "",
].join("\n");

const edit = (find: string, replace: string, doc = DOC) => { expect(doc).toContain(find); return doc.replace(find, replace); };

describe("the unified diff", () => {
  it("parseUnified: hunks with 0-based starts, counts defaulting to 1, prefixes stripped, `\\ No newline` skipped", () => {
    const hunks = parseUnified("@@ -1,3 +1,4 @@\n title: Alpha\n-status: active\n+status: done\n+owner: ada\n # Alpha\n@@ -10 +11,0 @@\n-gone\n\\ No newline at end of file");
    expect(hunks).toEqual([
      { oldStart: 0, oldCount: 3, newStart: 0, newCount: 4, lines: [{ kind: "ctx", text: "title: Alpha" }, { kind: "del", text: "status: active" }, { kind: "add", text: "status: done" }, { kind: "add", text: "owner: ada" }, { kind: "ctx", text: "# Alpha" }] },
      { oldStart: 9, oldCount: 1, newStart: 11, newCount: 0, lines: [{ kind: "del", text: "gone" }] },
    ]);
    expect(parseUnified("@@ -0,0 +1,2 @@\n+a\n+")).toEqual([{ oldStart: 0, oldCount: 0, newStart: 0, newCount: 2, lines: [{ kind: "add", text: "a" }, { kind: "add", text: "" }] }]);
    expect(parseUnified("")).toEqual([]);
  });
  it("splitLines is the server's verbatim split (a trailing newline is an empty last line, as docs_diff_unified counts it); dropTrailingEmpty is createdDiff's count", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b", ""]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
    expect(dropTrailingEmpty(["a", "b", ""])).toEqual(["a", "b"]);
    expect(dropTrailingEmpty(["a", ""])).toEqual(["a"]);
    expect(dropTrailingEmpty(["a", "b"])).toEqual(["a", "b"]);
    expect(dropTrailingEmpty([])).toEqual([]);
  });
  it("the texts match the diff under either count: a server diff whose hunk reaches the empty last line, and a createdDiff that does not", () => {
    const before = "# A\n\nold\n";
    const after = "# A\n\nnew\n";
    const server = "@@ -1,4 +1,4 @@\n # A\n \n-old\n+new\n ";
    expect(markdownDiff(server, before, after).source).toBe("documents");
    expect(describePieces(markdownDiff(server, before, after).pieces)).toEqual(["ctx heading new 0-1", "del paragraph old 2-3", "add paragraph new 2-3"]);
    const created = "@@ -0,0 +1,3 @@\n+# A\n+\n+new";
    expect(markdownDiff(created, "", after).source).toBe("documents");
    expect(describePieces(markdownDiff(created, "", after).pieces)).toEqual(["add heading new 0-1", "add paragraph new 2-3"]);
  });
  it("alignRows: every line of either text is a row with its old/new line and hunk; consistent() tells the texts match the diff", () => {
    const before = ["x", "y", "a", "b", "c", "z"];
    const after = ["x", "y", "a", "B", "B2", "c", "z"];
    const hunks = parseUnified("@@ -3,3 +3,4 @@\n a\n-b\n+B\n+B2\n c");
    expect(consistent(before, after, hunks)).toBe(true);
    expect(consistent(before, ["x", "y", "a", "B", "c", "z"], hunks)).toBe(false);
    expect(consistent(["other"], after, hunks)).toBe(false);
    const rows = alignRows(before, after, hunks);
    expect(rows.map((r) => [r.kind, r.text, r.oldLine, r.newLine, r.hunk])).toEqual([
      ["ctx", "x", 0, 0, null], ["ctx", "y", 1, 1, null],
      ["ctx", "a", 2, 2, 0], ["del", "b", 3, null, 0], ["add", "B", null, 3, 0], ["add", "B2", null, 4, 0], ["ctx", "c", 4, 5, 0],
      ["ctx", "z", 5, 6, null],
    ]);
  });
  it("sidesFromHunks: the excerpt alone, the hunks rebased onto it", () => {
    const hunks = parseUnified("@@ -3,3 +3,4 @@\n a\n-b\n+B\n+B2\n c\n@@ -20,2 +21,2 @@\n p\n-q\n+Q");
    const sides = sidesFromHunks(hunks);
    expect(sides.before).toEqual(["a", "b", "c", "p", "q"]);
    expect(sides.after).toEqual(["a", "B", "B2", "c", "p", "Q"]);
    expect(sides.hunks.map((h) => [h.oldStart, h.newStart])).toEqual([[0, 0], [3, 4]]);
    expect(consistent(sides.before, sides.after, sides.hunks)).toBe(true);
  });
});

describe("blocks", () => {
  it("blockTree: containers (lists, items, blockquotes) nest, everything else is a leaf with its source lines; frontmatter is one block", () => {
    const tokens = markdown().parse(DOC, {});
    const tree = blockTree(tokens, splitLines(DOC));
    expect(tree.map((b) => `${b.type} ${b.start}-${b.end}`)).toEqual([
      "frontmatter 0-4", "heading 4-5", "paragraph 6-8", "heading 9-10", "bullet_list 11-17", "fence 18-23", "table 24-29", "blockquote 30-32", "paragraph 33-34",
    ]);
    const list = tree[4]!;
    expect(list.children.map((b) => `${b.type} ${b.start}-${b.end}`)).toEqual(["list_item 11-12", "list_item 12-16", "list_item 16-17"]);
    expect(blockTree(tokens)[4]!.end).toBe(18); // markdown-it's own map runs over the blank line after the list; with the lines it is trimmed
    expect(list.children[1]!.children.map((b) => `${b.type} ${b.start}-${b.end}`)).toEqual(["paragraph 12-13", "bullet_list 13-16"]);
    expect(tree[6]!.container).toBe(false); // a table is one piece
    expect(tree[7]!.children.map((b) => b.type)).toEqual(["paragraph"]);
  });
});

describe("hunk → block context", () => {
  const pieces = (before: string, after: string) => describePieces(markdownDiff(unified(before, after), before, after).pieces);

  it("a change inside a fenced code block is ONE code block with the fence's language, its lines coloured one by one, the rest of the document elided", () => {
    const after = edit("const b = 2;", "const b = 22;");
    expect(pieces(DOC, after)).toEqual(["gap", "verbatim fence new 18-23  const a = 1;|-const b = 2;|+const b = 22;| const c = 3;", "gap"]);
    const { html } = renderMarkdownDiff(unified(DOC, after), DOC, after);
    expect(html).toBe('<div class="gap">⋯</div>\n<pre class="verbatim"><code class="language-js"><span class="line" data-kind="ctx">const a = 1;\n</span><span class="line" data-kind="del">const b = 2;\n</span><span class="line" data-kind="add">const b = 22;\n</span><span class="line" data-kind="ctx">const c = 3;\n</span></code></pre>\n<div class="gap">⋯</div>\n');
  });
  it("lines added to or removed from a fence are coloured in place; the fence's info string changing shows the block twice instead", () => {
    const added = edit("const c = 3;\n", "const c = 3;\nconst d = 4;\n");
    expect(pieces(DOC, added)[1]).toBe("verbatim fence new 18-24  const a = 1;| const b = 2;| const c = 3;|+const d = 4;");
    expect(pieces(added, DOC)[1]).toBe("verbatim fence new 18-23  const a = 1;| const b = 2;| const c = 3;|-const d = 4;");
    const relabelled = edit("```js", "```ts");
    expect(pieces(DOC, relabelled)).toEqual([
      "gap", // the ONE marker for everything elided before `render the pieces` — the document's head, `gather`, `build`'s own text, `parse the tokens`, `map the lines` (each level's own gap, coalesced)
      "container bullet_list new 11-17 [container list_item new 12-16 [container bullet_list new 13-16 [ctx list_item new 15-16]], ctx list_item new 16-17]", // the hunk's context reaches the list's last items
      "del fence old 18-23", "add fence new 18-23",
      "gap",
    ]);
    const { html } = renderMarkdownDiff(unified(DOC, relabelled), DOC, relabelled);
    expect(html).toContain('<div class="piece" data-kind="del"><pre><code class="language-js">');
    expect(html).toContain('<div class="piece" data-kind="add"><pre><code class="language-ts">');
  });
  it("an indented code block and a fence inside a list item are coloured line by line too, with the indentation stripped", () => {
    const before = "para\n\n    one\n    two\n    three\n\n- item\n\n  ```sh\n  echo a\n  echo b\n  ```\n";
    const after = before.replace("    two", "    TWO").replace("  echo b", "  echo B");
    const diff = "@@ -3,3 +3,3 @@\n     one\n-    two\n+    TWO\n     three\n@@ -10,3 +10,3 @@\n   echo a\n-  echo b\n+  echo B\n   ```"; // two hunks, one line of context each
    const d = markdownDiff(diff, before, after);
    expect(d.source).toBe("documents");
    expect(describePieces(d.pieces)).toEqual([
      "gap",
      "verbatim code_block new 2-5  one|-two|+TWO| three",
      "container bullet_list new 6-12 [container list_item new 6-12 [gap, verbatim fence new 8-12  echo a|-echo b|+echo B]]",
    ]);
    const { html } = renderMarkdownDiff(diff, before, after);
    expect(html).toContain('<pre class="verbatim"><code><span class="line" data-kind="ctx">one\n</span><span class="line" data-kind="del">two\n</span><span class="line" data-kind="add">TWO\n</span><span class="line" data-kind="ctx">three\n</span></code></pre>');
    expect(html).toContain('<li>\n<div class="gap">⋯</div>\n<pre class="verbatim"><code class="language-sh"><span class="line" data-kind="ctx">echo a\n</span><span class="line" data-kind="del">echo b\n</span><span class="line" data-kind="add">echo B\n</span></code></pre>\n</li>');
  });
  it("a change to a nested list item keeps the list's chrome: the containing list and item recurse, only the changed item's text is coloured, siblings outside the hunk are elided", () => {
    const after = edit("  - map the lines", "  - map the rows");
    expect(pieces(DOC, after)).toEqual([
      "gap",
      "container bullet_list new 11-17 [ctx list_item new 11-12, container list_item new 12-16 [ctx paragraph new 12-13, container bullet_list new 13-16 [ctx list_item new 13-14, del list_item old 14-15, add list_item new 14-15, ctx list_item new 15-16]], ctx list_item new 16-17]",
      "gap",
    ]);
    const { html } = renderMarkdownDiff(unified(DOC, after), DOC, after);
    expect(html).toBe('<div class="gap">⋯</div>\n<ul>\n<li>gather</li>\n<li>build\n<ul>\n<li>parse the tokens</li>\n<li data-kind="del">map the lines</li>\n<li data-kind="add">map the rows</li>\n<li>render the pieces</li>\n</ul>\n</li>\n<li>ship</li>\n</ul>\n<div class="gap">⋯</div>\n');
  });
  it("an item ADDED to a nested list is one green item inside the kept nesting", () => {
    const after = edit("  - map the lines\n", "  - map the lines\n  - colour them\n");
    expect(pieces(DOC, after)).toEqual([
      "gap", // the document's head and `gather` (the list's own leading gap folded into this one)
      "container bullet_list new 11-18 [container list_item new 12-17 [ctx paragraph new 12-13, container bullet_list new 13-17 [ctx list_item new 13-14, ctx list_item new 14-15, add list_item new 15-16, ctx list_item new 16-17]], ctx list_item new 17-18]",
      "gap",
    ]);
  });
  it("a changed table cell is its ROW twice (red, then green) inside ONE table that keeps the header and alignment rows — never a bare row", () => {
    const after = edit("| beta | active |", "| beta | done |");
    expect(pieces(DOC, after)).toEqual(["gap", "table new 24-29  | alpha | active ||-| beta | active ||+| beta | done || | gamma | planned |", "container blockquote new 30-32 [ctx paragraph new 30-32]", "gap"]);
    const { html } = renderMarkdownDiff(unified(DOC, after), DOC, after);
    expect(html).toContain('<table class="rows">\n<thead>\n<tr>\n<th>name</th>\n<th>status</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>alpha</td>\n<td>active</td>\n</tr>\n<tr data-kind="del">\n<td>beta</td>\n<td>active</td>\n</tr>\n<tr data-kind="add">\n<td>beta</td>\n<td>done</td>\n</tr>\n<tr>\n<td>gamma</td>\n<td>planned</td>\n</tr>\n</tbody>\n</table>');
    expect(html.match(/<table/g)).toHaveLength(1);
  });
  it("rows added to or removed from a table are coloured in place; a header or alignment change shows the whole table twice", () => {
    const added = edit("| gamma | planned |\n", "| gamma | planned |\n| delta | idea |\n");
    expect(pieces(DOC, added)[1]).toBe("table new 24-30  | alpha | active || | beta | active || | gamma | planned ||+| delta | idea |");
    expect(pieces(added, DOC)[1]).toBe("table new 24-29  | alpha | active || | beta | active || | gamma | planned ||-| delta | idea |");
    const header = edit("| name | status |", "| name | state |");
    expect(pieces(DOC, header)).toEqual(["gap", "ctx fence new 18-23", "del table old 24-29", "add table new 24-29", "gap"]); // the hunk's context reaches the fence
    const aligned = edit("| --- | --- |", "| :-- | --: |");
    expect(pieces(DOC, aligned)).toEqual(["gap", "ctx fence new 18-23", "del table old 24-29", "add table new 24-29", "gap"]);
    const { html } = renderMarkdownDiff(unified(DOC, header), DOC, header);
    const tables = html.match(/<table>[\s\S]*?<\/table>/g)!;
    expect(tables).toHaveLength(2);
    for (const t of tables) expect(t).toContain("<thead>");
    expect(html).toContain('<div class="piece" data-kind="del"><table>');
    expect(html).toContain('<div class="piece" data-kind="add"><table>');
  });
  it("a heading change is the heading twice; the paragraphs around it are context, rendered once", () => {
    const after = edit("## Steps", "## The steps");
    // The hunk's context ends at `build`: its sub-list, `ship` and the rest of the document are three levels of elision and ONE marker, the top-level one.
    expect(pieces(DOC, after)).toEqual(["gap", "ctx paragraph new 6-8", "del heading old 9-10", "add heading new 9-10", "container bullet_list new 11-17 [ctx list_item new 11-12, container list_item new 12-16 [ctx paragraph new 12-13]]", "gap"]);
    const { html } = renderMarkdownDiff(unified(DOC, after), DOC, after);
    expect(html).toContain('<div class="piece" data-kind="del"><h2>Steps</h2>\n</div>');
    expect(html).toContain('<div class="piece" data-kind="add"><h2>The steps</h2>\n</div>');
  });
  it("one changed line of a two-line paragraph is the whole paragraph twice", () => {
    const after = edit("nested lists.", "nested lists, footnotes.");
    expect(pieces(DOC, after)).toEqual(["gap", "ctx heading new 4-5", "del paragraph old 6-8", "add paragraph new 6-8", "ctx heading new 9-10", "gap"]);
    const { html } = renderMarkdownDiff(unified(DOC, after), DOC, after);
    expect(html).toContain('<div class="piece" data-kind="del"><p>The first cut of the renderer. Known gaps: wide tables,\nnested lists.</p>\n</div>');
    expect(html).toContain('<div class="piece" data-kind="add"><p>The first cut of the renderer. Known gaps: wide tables,\nnested lists, footnotes.</p>\n</div>');
  });
  it("a frontmatter value change (the demo's usual edit) is ONE yaml block with the changed line red and green and the other keys neutral — not a thematic break and a setext heading", () => {
    const after = edit("status: active\n---", "status: done\n---");
    expect(pieces(DOC, after)).toEqual(["verbatim frontmatter new 0-4  title: Alpha|-status: active|+status: done", "ctx heading new 4-5", "gap"]);
    const { html } = renderMarkdownDiff(unified(DOC, after), DOC, after);
    expect(html).toContain('<pre class="verbatim frontmatter"><code class="frontmatter language-yaml"><span class="line" data-kind="ctx">title: Alpha\n</span><span class="line" data-kind="del">status: active\n</span><span class="line" data-kind="add">status: done\n</span></code></pre>');
    expect(html).not.toContain("<hr>");
    const keyAdded = edit("status: active\n---", "status: active\nowner: ada\n---");
    expect(pieces(DOC, keyAdded)[0]).toBe("verbatim frontmatter new 0-5  title: Alpha| status: active|+owner: ada");
    const unchangedFrontmatter = renderMarkdownDiff(unified(DOC, edit("# Alpha", "# Alpha!")), DOC, edit("# Alpha", "# Alpha!")).html;
    expect(unchangedFrontmatter).toContain('<pre class="frontmatter"><code class="language-yaml">title: Alpha\nstatus: active\n</code></pre>'); // context: rendered once, neutral
  });
  it("a changed quoted line keeps the blockquote and shows its paragraph twice inside it", () => {
    const after = edit("> quoted line two", "> quoted line 2");
    expect(pieces(DOC, after)).toEqual(["gap", "ctx table new 24-29", "container blockquote new 30-32 [del paragraph old 30-32, add paragraph new 30-32]", "ctx paragraph new 33-34"]);
    const { html } = renderMarkdownDiff(unified(DOC, after), DOC, after);
    expect(html).toContain('<blockquote>\n<div class="piece" data-kind="del"><p>quoted line one\nquoted line two</p>\n</div>\n<div class="piece" data-kind="add"><p>quoted line one\nquoted line 2</p>\n</div>\n</blockquote>');
  });
  it("a whole new paragraph is one green block between its neighbours; a deleted one is one red block", () => {
    const after = edit("Tail paragraph.\n", "Tail paragraph.\n\nA new tail.\n");
    expect(pieces(DOC, after)).toEqual(["gap", "ctx paragraph new 33-34", "add paragraph new 35-36"]);
    expect(pieces(after, DOC)).toEqual(["gap", "ctx paragraph new 33-34", "del paragraph old 35-36"]);
  });
  it("a created document (one all-addition hunk, no before text) is every block green, in order", () => {
    const content = "# New\n\n- bullet\n- second\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    const diff = `@@ -0,0 +1,8 @@\n${splitLines(content).map((l) => `+${l}`).join("\n")}`;
    const d = markdownDiff(diff, "", content);
    expect(d.source).toBe("documents");
    expect(describePieces(d.pieces)).toEqual(["add heading new 0-1", "add bullet_list new 2-4", "add table new 5-8"]);
    const { html } = renderMarkdownDiff(diff, "", content);
    expect(html).toContain('<div class="piece" data-kind="add"><h1>New</h1>');
    expect(html).toContain('<div class="piece" data-kind="add"><ul>\n<li>bullet</li>\n<li>second</li>\n</ul>');
    expect(html).toContain('<div class="piece" data-kind="add"><table>');
  });
  it("an ordered list whose first items are elided keeps its numbering", () => {
    const before = "1. one\n2. two\n3. three\n4. four\n5. five\n6. six\n7. seven\n";
    const after = before.replace("6. six", "6. SIX");
    const diff = unified(before, after, 1);
    const { html } = renderMarkdownDiff(diff, before, after);
    expect(html).toBe('<ol start="5">\n<li class="gap">⋯</li>\n<li>five</li>\n<li data-kind="del">six</li>\n<li data-kind="add">SIX</li>\n<li>seven</li>\n</ol>\n');
  });
  it("without the full texts — or with texts that do not match the diff — the excerpt alone is rendered and said so", () => {
    const diff = "@@ -2,3 +2,3 @@\n const a = 1;\n-const b = 2;\n+const b = 22;\n const c = 3;";
    const d = markdownDiff(diff);
    expect(d.source).toBe("excerpt");
    expect(describePieces(d.pieces)).toEqual(["del paragraph old 0-3", "add paragraph new 0-3"]); // the known limitation: no fence in sight
    expect(markdownDiff(diff, "unrelated\n", "texts\n").source).toBe("excerpt");
    const full = "```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\n";
    const withTexts = markdownDiff(diff, full, full.replace("2;", "22;"));
    expect(withTexts.source).toBe("documents");
    expect(describePieces(withTexts.pieces)).toEqual(["verbatim fence new 0-5  const a = 1;|-const b = 2;|+const b = 22;| const c = 3;"]);
  });
  it("an empty diff renders nothing", () => {
    expect(renderMarkdownDiff("", "a\n", "a\n")).toEqual({ html: "", source: "documents" });
  });
});

describe("gap markers", () => {
  const gaps = (html: string) => html.match(/⋯/g)?.length ?? 0;
  const pieces = (before: string, after: string, context = 3) => describePieces(markdownDiff(unified(before, after, context), before, after).pieces);
  const fake = (type: string, start: number, end: number, container = false): Block => ({ type, start, end, open: -1, close: -1, container, markup: "", children: [] });
  const gap = (): Piece => ({ kind: "gap" });
  const block = (type: string, start: number): Piece => ({ kind: "block", side: "after", block: fake(type, start, start + 1), mark: null });
  const container = (type: string, children: Piece[]): Piece => ({ kind: "container", block: fake(type, 0, 0, true), children });

  it("coalesceGaps: a run of consecutive gaps across nesting levels keeps one marker — the shallowest — and drops a container left with nothing to show", () => {
    const run = [gap(), container("bullet_list", [gap(), container("list_item", [gap(), block("paragraph", 3)])]), gap(), container("bullet_list", [gap()]), gap(), container("blockquote", [block("paragraph", 9), gap()]), gap()];
    expect(describePieces(coalesceGaps(run))).toEqual([
      "gap", // the three leading gaps (depths 0, 1, 2) → the top-level one
      "container bullet_list new 0-0 [container list_item new 0-0 [ctx paragraph new 3-4]]",
      "gap", // depth 0, an empty list's gap (dropped with the list), depth 0 → one
      "container blockquote new 0-0 [ctx paragraph new 9-10]",
      "gap", // the quote's trailing gap and the document's → the document's
    ]);
    const tie = [container("bullet_list", [block("list_item", 0), gap()]), container("bullet_list", [gap(), block("list_item", 5)])];
    expect(describePieces(coalesceGaps(tie))).toEqual(["container bullet_list new 0-0 [ctx list_item new 0-1, gap]", "container bullet_list new 0-0 [ctx list_item new 5-6]"]); // equal depth: the first stays
    const lone = [gap(), block("paragraph", 2), gap(), block("paragraph", 5)];
    expect(coalesceGaps(lone)).toEqual(lone); // nothing to coalesce: the same pieces
  });
  it("consecutive elided runs are ONE marker: the elided items of three nested lists above a change render one `⋯`, outside the list, and the elided tail of an item + its list + the document one below", () => {
    const relabelled = edit("```js", "```ts");
    const above = renderMarkdownDiff(unified(DOC, relabelled), DOC, relabelled).html;
    expect(above.startsWith('<div class="gap">⋯</div>\n<ul>\n<li>\n<ul>\n<li>render the pieces</li>\n</ul>\n</li>\n<li>ship</li>\n</ul>\n')).toBe(true);
    expect(above).not.toContain('<li class="gap">');
    expect(gaps(above)).toBe(2); // one above the list, one after the fence
    const heading = edit("## Steps", "## The steps");
    const below = renderMarkdownDiff(unified(DOC, heading), DOC, heading).html;
    expect(below.endsWith('<ul>\n<li>gather</li>\n<li>build</li>\n</ul>\n<div class="gap">⋯</div>\n')).toBe(true); // no `<li class="gap">` inside `build` or after it
    expect(gaps(below)).toBe(2); // one above the paragraph, one after `build`
    const deep = edit("  - render the pieces", "  - render the PIECES");
    expect(pieces(DOC, deep, 1)).toEqual([
      "gap", // the head of the document, `gather`, `build`'s text and `parse the tokens`: four levels, one marker
      "container bullet_list new 11-17 [container list_item new 12-16 [container bullet_list new 13-16 [ctx list_item new 14-15, del list_item old 15-16, add list_item new 15-16]], ctx list_item new 16-17]",
      "gap",
    ]);
    expect(gaps(renderMarkdownDiff(unified(DOC, deep, 1), DOC, deep).html)).toBe(2);
  });
  it("no marker at an edge the document's first or last block is shown at, none at all when both are, and none for a created document", () => {
    expect(pieces(DOC, edit("status: active\n---", "status: done\n---"))[0]).toBe("verbatim frontmatter new 0-4  title: Alpha|-status: active|+status: done"); // the first block is shown: no leading gap
    expect(pieces(DOC, edit("Tail paragraph.", "Tail paragraph!")).slice(-2)).toEqual(["del paragraph old 33-34", "add paragraph new 33-34"]); // the last block is shown: no trailing gap
    const short = "# T\n\none\n\ntwo\n";
    const both = short.replace("one", "ONE");
    expect(pieces(short, both)).toEqual(["ctx heading new 0-1", "del paragraph old 2-3", "add paragraph new 2-3", "ctx paragraph new 4-5"]);
    expect(gaps(renderMarkdownDiff(unified(short, both), short, both).html)).toBe(0);
    const content = "# New\n\n- a\n- b\n";
    expect(gaps(renderMarkdownDiff(`@@ -0,0 +1,4 @@\n${splitLines(content).map((l) => `+${l}`).join("\n")}`, "", content).html)).toBe(0);
  });
  it("no marker between two shown clusters that are adjacent in the source — two hunks whose context meets at one paragraph — and exactly one when blocks between them are skipped", () => {
    const before = "p0\n\np1\n\np2\n\np3\n\np4\n\np5\n";
    const after = before.replace("p1", "P1").replace("p3", "P3");
    const meeting = "@@ -2,4 +2,4 @@\n \n-p1\n+P1\n \n p2\n@@ -6,3 +6,3 @@\n \n-p3\n+P3\n "; // hunk 1 reaches p2; hunk 2 starts right after it
    expect(describePieces(markdownDiff(meeting, before, after).pieces)).toEqual(["gap", "del paragraph old 2-3", "add paragraph new 2-3", "ctx paragraph new 4-5", "del paragraph old 6-7", "add paragraph new 6-7", "gap"]);
    expect(gaps(renderMarkdownDiff(meeting, before, after).html)).toBe(2);
    const apart = before.replace("p1", "P1").replace("p4", "P4");
    const separated = "@@ -2,3 +2,3 @@\n \n-p1\n+P1\n \n@@ -8,3 +8,3 @@\n \n-p4\n+P4\n "; // p2 and p3 skipped between the hunks: one marker
    expect(describePieces(markdownDiff(separated, before, apart).pieces)).toEqual(["gap", "del paragraph old 2-3", "add paragraph new 2-3", "gap", "del paragraph old 8-9", "add paragraph new 8-9", "gap"]);
    expect(gaps(renderMarkdownDiff(separated, before, apart).html)).toBe(3);
  });
});

describe("rendering is safe", () => {
  it("raw HTML is escaped, an image is named rather than fetched, an unsafe link scheme is not a link", () => {
    const before = "x\n";
    const after = 'x\n\n<script>alert(1)</script> <b>bold</b> ![i](http://evil/x.png) [l](javascript:alert(1)) [ok](https://example.com)\n';
    const { html } = renderMarkdownDiff(unified(before, after), before, after);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<img");
    expect(html).toContain('<span class="image">[image: i]</span>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("[l](javascript:alert(1))"); // markdown-it leaves it as text
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('<a href="https://example.com">ok</a>');
  });
});
