import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BlockIds } from "../src/lib/document.ts";
import { anchorsSummary, candidateRaw, candidateRaws, childrenOf, docHrefPath, isDocHref, markdown, mdBlockTree, pairBlocks, renderBody, sha256Hex, verifyAnchors } from "../src/lib/markdown.ts";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// A body in the alchemy corpus's shape: top-level blocks, a list with items, a quote.
const BODY = [
  "# Calcination",
  "",
  "Heating a substance in air.",
  "The first of the twelve gates.",
  "",
  "## Products",
  "",
  "- calcined lead → yellow massicot",
  "- calcined copper → black tenorite",
  "- plant matter → ash, source of the [[salt]]",
  "",
  "> One becomes two,",
  "> two becomes three.",
  "",
  "```text",
  "crucible → grind",
  "```",
  "",
  "See [dissolution](/processes/dissolution.md) and [the index](../index.md) or <https://example.com/x>.",
  "",
].join("\n");

/** The store's view of that body: ids in pre-order with parents and hashes computed the store's way. */
function storeIds(): BlockIds {
  const h1 = "# Calcination";
  const p1 = "Heating a substance in air.\nThe first of the twelve gates.";
  const h2 = "## Products";
  const li = ["- calcined lead → yellow massicot", "- calcined copper → black tenorite", "- plant matter → ash, source of the [[salt]]"];
  const list = li.join("\n");
  const quote = "> One becomes two,\n> two becomes three.";
  // The format layer's raw of the quoted paragraph drops the marker on the first line only.
  const quoteP = "One becomes two,\n> two becomes three.";
  const fence = "```text\ncrucible → grind\n```";
  const p2 = "See [dissolution](/processes/dissolution.md) and [the index](../index.md) or <https://example.com/x>.";
  const ids = ["b_h1", "b_p1", "b_h2", "b_list", "b_li0", "b_li1", "b_li2", "b_quote", "b_quoteP", "b_fence", "b_p2"];
  const parents: Record<string, string | null> = { b_h1: null, b_p1: null, b_h2: null, b_list: null, b_li0: "b_list", b_li1: "b_list", b_li2: "b_list", b_quote: null, b_quoteP: "b_quote", b_fence: null, b_p2: null };
  const hashes: Record<string, string> = { b_h1: sha(h1), b_p1: sha(p1), b_h2: sha(h2), b_list: sha(list), b_li0: sha(li[0]!), b_li1: sha(li[1]!), b_li2: sha(li[2]!), b_quote: sha(quote), b_quoteP: sha(quoteP), b_fence: sha(fence), b_p2: sha(p2) };
  return { ids, parents, hashes };
}

describe("the block trees", () => {
  it("mdBlockTree: top-level blocks in order, a list's items as children, a quote's paragraph as a child", () => {
    const tree = mdBlockTree(markdown().parse(BODY, {}));
    expect(tree.map((b) => b.type)).toEqual(["heading", "paragraph", "heading", "bullet_list", "blockquote", "fence", "paragraph"]);
    expect(tree[3]!.children.map((b) => [b.type, b.start, b.end])).toEqual([["list_item", 7, 8], ["list_item", 8, 9], ["list_item", 9, 11]]);
    expect(tree[4]!.children.map((b) => b.type)).toEqual(["paragraph"]);
    expect(tree[5]).toMatchObject({ type: "fence", start: 14, end: 17 });
  });
  it("childrenOf: the store's pre-order ids grouped by parent", () => {
    const c = childrenOf(storeIds());
    expect(c.get(null)).toEqual(["b_h1", "b_p1", "b_h2", "b_list", "b_quote", "b_fence", "b_p2"]);
    expect(c.get("b_list")).toEqual(["b_li0", "b_li1", "b_li2"]);
  });
  it("pairBlocks: positional, level by level; everything paired when the counts agree", () => {
    const { anchors, unmatched } = pairBlocks(mdBlockTree(markdown().parse(BODY, {})), storeIds());
    expect(unmatched).toBe(0);
    expect(anchors.map((a) => [a.id, a.type])).toEqual([
      ["b_h1", "heading"], ["b_p1", "paragraph"], ["b_h2", "heading"], ["b_list", "bullet_list"], ["b_li0", "list_item"], ["b_li1", "list_item"], ["b_li2", "list_item"],
      ["b_quote", "blockquote"], ["b_quoteP", "paragraph"], ["b_fence", "fence"], ["b_p2", "paragraph"],
    ]);
  });
  it("pairBlocks: a level whose counts disagree gets no anchors and is counted, the rest still pairs", () => {
    const ids = storeIds();
    ids.ids = ids.ids.filter((i) => i !== "b_li2"); // the store has two items where the text has three
    const { anchors, unmatched } = pairBlocks(mdBlockTree(markdown().parse(BODY, {})), ids);
    expect(unmatched).toBe(2);
    expect(anchors.map((a) => a.id)).toEqual(["b_h1", "b_p1", "b_h2", "b_list", "b_quote", "b_quoteP", "b_fence", "b_p2"]);
    // A top-level mismatch: nothing at all.
    const fewer = { ...storeIds(), ids: ["b_h1", "b_p1"], parents: { b_h1: null, b_p1: null } };
    expect(pairBlocks(mdBlockTree(markdown().parse(BODY, {})), fewer)).toEqual({ anchors: [], unmatched: 2 });
  });
  it("pairBlocks: a list item's paragraph tokens are not store children (the item IS the text); its nested list is", () => {
    const body = "- a\n  - a1\n  - a2\n- b\n";
    const ids: BlockIds = { ids: ["b_l", "b_a", "b_al", "b_a1", "b_a2", "b_b"], parents: { b_l: null, b_a: "b_l", b_al: "b_a", b_a1: "b_al", b_a2: "b_al", b_b: "b_l" }, hashes: {} };
    const { anchors, unmatched } = pairBlocks(mdBlockTree(markdown().parse(body, {})), ids);
    expect(unmatched).toBe(0);
    expect(anchors.map((a) => [a.id, a.type])).toEqual([["b_l", "bullet_list"], ["b_a", "list_item"], ["b_al", "bullet_list"], ["b_a1", "list_item"], ["b_a2", "list_item"], ["b_b", "list_item"]]);
  });
});

describe("verification by hash", () => {
  const lines = BODY.split("\n");
  it("candidateRaw: the token's lines, trailing blank lines dropped (a list's trailing blank belongs to the list in markdown-it)", () => {
    expect(candidateRaw(lines, 7, 11)).toBe("- calcined lead → yellow massicot\n- calcined copper → black tenorite\n- plant matter → ash, source of the [[salt]]");
    expect(candidateRaw(lines, 14, 17)).toBe("```text\ncrucible → grind\n```");
    expect(candidateRaws(lines, 11, 13)).toEqual(["> One becomes two,\n> two becomes three.", "One becomes two,\n> two becomes three."]);
    expect(candidateRaws(lines, 0, 1)).toEqual(["# Calcination"]);
  });
  it("sha256Hex matches node's sha256 over UTF-8", async () => {
    expect(await sha256Hex("## Procedure")).toBe("5da93bd3e25731d2786cd3c17c54b84047ba82401bc69b04138a3a1a9b0c0402");
    expect(await sha256Hex("crucible → grind")).toBe(sha("crucible → grind"));
  });
  it("verifyAnchors: every anchor of the corpus-shaped body verifies, including the quoted paragraph; a wrong hash does not", async () => {
    const ids = storeIds();
    const { anchors } = pairBlocks(mdBlockTree(markdown().parse(BODY, {})), ids);
    const verdicts = await verifyAnchors(anchors, lines, ids.hashes);
    expect([...verdicts.values()].every(Boolean)).toBe(true);
    const wrong = await verifyAnchors(anchors, lines, { ...ids.hashes, b_p1: sha("other") });
    expect(wrong.get("b_p1")).toBe(false);
    expect(wrong.get("b_h1")).toBe(true);
    const none = await verifyAnchors(anchors.slice(0, 1), lines, {});
    expect(none.get("b_h1")).toBe(false);
  });
});

describe("renderBody", () => {
  it("renders with id/data-block/data-verified on every paired block, wikilinks and doc links marked, external links in a new tab, html escaped", async () => {
    const r = await renderBody(BODY, storeIds());
    expect(r.unmatched).toBe(0);
    expect(r.unverified).toBe(0);
    expect(r.anchors).toHaveLength(11);
    expect(r.html).toContain('<h1 id="b_h1" data-block="b_h1" data-verified="true">Calcination</h1>');
    expect(r.html).toContain('<ul id="b_list" data-block="b_list" data-verified="true">');
    expect(r.html).toContain('<li id="b_li0" data-block="b_li0" data-verified="true">');
    expect(r.html).toContain('<a class="wikilink" href="#wiki:salt" data-wiki="salt">salt</a>');
    expect(r.html).toContain('<a href="/processes/dissolution.md" data-doc="/processes/dissolution.md">dissolution</a>');
    expect(r.html).toContain('<a href="../index.md" data-doc="../index.md">the index</a>');
    expect(r.html).toContain('<a href="https://example.com/x" target="_blank" rel="noopener">https://example.com/x</a>');
    expect(anchorsSummary(r)).toBe("11 blocks anchored");
    const html = (await renderBody("<script>alert(1)</script>\n\n![pic](http://x/y.png)\n", null)).html;
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<span class="image">[image: pic]</span>');
    expect(html).not.toContain("<img");
  });
  it("marks an anchor whose raw does not hash to the stored hash as unverified and says so in the summary", async () => {
    const ids = storeIds();
    ids.hashes.b_p1 = sha("something else");
    const r = await renderBody(BODY, ids);
    expect(r.unverified).toBe(1);
    expect(r.html).toContain('<p id="b_p1" data-block="b_p1" data-verified="false">');
    expect(anchorsSummary(r)).toBe("11 blocks anchored (1 unverified)");
    expect(anchorsSummary({ anchors: r.anchors.slice(0, 9), unmatched: 2, unverified: 0 })).toBe("9 of 11 blocks anchored");
    expect(anchorsSummary({ anchors: [], unmatched: 0, unverified: 0 })).toBeNull();
  });
  it("without ids renders plain (no anchors)", async () => {
    const r = await renderBody("# T\n\np\n", null);
    expect(r.anchors).toEqual([]);
    expect(r.html).toBe("<h1>T</h1>\n<p>p</p>\n");
  });
  it("isDocHref / docHrefPath: rooted and relative paths open in place; schemes and bare anchors do not", () => {
    expect(isDocHref("/a.md")).toBe(true);
    expect(isDocHref("b.md#x")).toBe(true);
    expect(isDocHref("https://x")).toBe(false);
    expect(isDocHref("mailto:a@b")).toBe(false);
    expect(isDocHref("#anchor")).toBe(false);
    expect(isDocHref("")).toBe(false);
    expect(docHrefPath("/a.md#x")).toBe("/a.md");
  });
});

describe("task items", () => {
  // The alchemy corpus's Tasks section shape: a heading, a tight list of three tasks.
  const TASKS = ["## Tasks", "", "- [x] Verify the weight gain on lead with a balance", "- [ ] Repeat with copper and record the colour sequence", "- [X] Chase down the [[salt]] *measurement*", ""].join("\n");
  const items = ["- [x] Verify the weight gain on lead with a balance", "- [ ] Repeat with copper and record the colour sequence", "- [X] Chase down the [[salt]] *measurement*"];
  const taskIds = (): BlockIds => ({
    ids: ["b_h", "b_l", "b_t0", "b_t1", "b_t2"],
    parents: { b_h: null, b_l: null, b_t0: "b_l", b_t1: "b_l", b_t2: "b_l" },
    hashes: { b_h: sha("## Tasks"), b_l: sha(items.join("\n")), b_t0: sha(items[0]!), b_t1: sha(items[1]!), b_t2: sha(items[2]!) },
  });
  it("render an input first, checked from the marker, the marker gone from the text, the li classed task — enabled when verified and writable", async () => {
    const r = await renderBody(TASKS, taskIds());
    expect(r.unmatched).toBe(0);
    expect(r.unverified).toBe(0);
    expect(r.tasks).toEqual({ total: 3, editable: 3 });
    expect(r.html).toContain('<li class="task" id="b_t0" data-block="b_t0" data-verified="true"><input type="checkbox" class="task-check" data-block="b_t0" checked> Verify the weight gain on lead with a balance</li>');
    expect(r.html).toContain('<li class="task" id="b_t1" data-block="b_t1" data-verified="true"><input type="checkbox" class="task-check" data-block="b_t1"> Repeat with copper and record the colour sequence</li>');
    expect(r.html).toContain('<input type="checkbox" class="task-check" data-block="b_t2" checked> Chase down the <a class="wikilink"');
    expect(r.html).not.toContain("[x]");
    expect(r.html).not.toContain("[ ]");
    expect(r.html).not.toContain("disabled");
  });
  it("an unverified item's box is disabled with the reason; a read-only server disables every box", async () => {
    const ids = taskIds();
    ids.hashes.b_t1 = sha("edited elsewhere");
    const r = await renderBody(TASKS, ids);
    expect(r.unverified).toBe(1);
    expect(r.tasks).toEqual({ total: 3, editable: 2 });
    expect(r.html).toContain(`<li class="task" id="b_t1" data-block="b_t1" data-verified="false"><input type="checkbox" class="task-check" data-block="b_t1" disabled title="this item's block could not be verified against the store (its raw did not hash to the stored hash) — not editable here">`);
    expect(r.html).toContain('data-block="b_t0" checked> Verify');
    const ro = await renderBody(TASKS, taskIds(), { canApply: false });
    expect(ro.tasks).toEqual({ total: 3, editable: 0 });
    expect(ro.html.match(/disabled title="read-only: this server does not list `apply`"/g)).toHaveLength(3);
    expect(ro.html).toContain('data-block="b_t0" checked disabled title=');
  });
  it("an item the pairing could not place (no ids, or a level whose counts disagree) has a disabled box and no data-block", async () => {
    const none = await renderBody(TASKS, null);
    expect(none.tasks).toEqual({ total: 3, editable: 0 });
    expect(none.html).toContain(`<li class="task"><input type="checkbox" class="task-check" checked disabled title="this item has no block anchor (its level did not pair with the store's ids) — not editable here"> Verify`);
    const ids = taskIds();
    ids.ids = ids.ids.filter((i) => i !== "b_t2"); // the store has two items where the text has three
    const r = await renderBody(TASKS, ids);
    expect(r.unmatched).toBe(2);
    expect(r.tasks).toEqual({ total: 3, editable: 0 });
    expect(r.html).toContain('<ul id="b_l" data-block="b_l" data-verified="true">');
    expect(r.html).not.toContain('data-block="b_t0"');
  });
  it("nested tasks pair with the nested list's children and each gets its own box; a plain item among tasks stays plain", async () => {
    const body = "- [ ] parent\n  - [x] child one\n  - [ ] child two\n- plain item\n";
    const ids: BlockIds = {
      ids: ["b_l", "b_a", "b_al", "b_a1", "b_a2", "b_b"],
      parents: { b_l: null, b_a: "b_l", b_al: "b_a", b_a1: "b_al", b_a2: "b_al", b_b: "b_l" },
      hashes: { b_l: sha(body.trimEnd()), b_a: sha("- [ ] parent\n  - [x] child one\n  - [ ] child two"), b_al: sha("  - [x] child one\n  - [ ] child two"), b_a1: sha("  - [x] child one"), b_a2: sha("  - [ ] child two"), b_b: sha("- plain item") },
    };
    const r = await renderBody(body, ids);
    expect(r.unmatched).toBe(0);
    expect(r.unverified).toBe(0);
    expect(r.tasks).toEqual({ total: 3, editable: 3 });
    expect(r.html).toContain('<li class="task" id="b_a" data-block="b_a" data-verified="true"><input type="checkbox" class="task-check" data-block="b_a"> parent');
    expect(r.html).toContain('<li class="task" id="b_a1" data-block="b_a1" data-verified="true"><input type="checkbox" class="task-check" data-block="b_a1" checked> child one</li>');
    expect(r.html).toContain('<li class="task" id="b_a2" data-block="b_a2" data-verified="true"><input type="checkbox" class="task-check" data-block="b_a2"> child two</li>');
    expect(r.html).toContain('<li id="b_b" data-block="b_b" data-verified="true">plain item</li>');
  });
  it("what is not a task: a link starting with [x], a marker without a space, a marker in a paragraph, a loose item keeps its <p>", async () => {
    const r = await renderBody("- [x](https://example.com/x) a link\n- [ ]no space\n- [y] other\n\n[ ] a paragraph\n\n- [ ] loose\n\n  second paragraph\n", null);
    expect(r.tasks.total).toBe(1);
    expect(r.html).toContain('<li><a href="https://example.com/x" target="_blank" rel="noopener">x</a> a link</li>');
    expect(r.html).toContain("<li>[ ]no space</li>");
    expect(r.html).toContain("<li>[y] other</li>");
    expect(r.html).toContain("<p>[ ] a paragraph</p>");
    expect(r.html).toContain('<li class="task">\n<p><input type="checkbox" class="task-check" disabled title=');
    expect(r.html).toContain("> loose</p>\n<p>second paragraph</p>");
  });
});
