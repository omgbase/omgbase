import { describe, it, expect } from "vitest";
import { parseTree } from "../core/parse/tree.js";
import { mintId } from "../core/ids.js";
import { renderDoc, rawHashHex, MutationError, locate, type MutBlock, type MutDoc } from "./tree.js";
import { opInsert, opUpdate, opMove, opRemove, opSplit, opMerge } from "./ops.js";

// Build a MutDoc from markdown (parse + mint ids), top-level blocks only.
function doc(markdown: string): MutDoc {
  const tree = parseTree(markdown);
  const toMut = (b: { type: string; raw: string; trivia: string; attrs: Record<string, unknown>; children: unknown[] }): MutBlock => ({
    id: mintId("b"), type: b.type, raw: b.raw, trivia: b.trivia, attrs: b.attrs,
    children: (b.children as (typeof b)[]).map(toMut),
  });
  return {
    docId: "d_1", path: "a.md", format: "markdown", leadingTrivia: tree.leadingTrivia, frontmatterRaw: null,
    children: tree.children.filter((b) => b.type !== "frontmatter").map(toMut as never),
  };
}
const idAt = (d: MutDoc, i: number): string => d.children[i]!.id;
const hashAt = (d: MutDoc, i: number): string => rawHashHex(d.children[i]!.raw);

describe("kernel ops", () => {
  it("insert adds blocks at a position and returns minted ids", () => {
    const d = doc("# Title\n\nTail.\n");
    const { ids } = opInsert(d, { parent: { doc: true }, at: { after: idAt(d, 0) } }, "Inserted paragraph.");
    expect(ids).toHaveLength(1);
    expect(d.children[1]!.id).toBe(ids[0]);
    expect(renderDoc(d)).toContain("Inserted paragraph.");
  });

  it("insert after a trivia-less final block adds a separator (no jammed blocks)", () => {
    const d = doc("# H\n\nbody"); // no trailing newline ⇒ last block trivia is ""
    opInsert(d, { parent: { doc: true }, at: { after: idAt(d, 1) } }, "new para");
    expect(renderDoc(d)).toBe("# H\n\nbody\n\nnew para\n");
  });

  it("insert of a heading between existing blocks keeps blank lines on both sides", () => {
    const d = doc("# H\n\nfirst\n\nsecond\n");
    // insert after "first" (index 1) — a following block ("second") exists.
    opInsert(d, { parent: { doc: true }, at: { after: idAt(d, 1) } }, "## Mid\n\nmid body\n");
    const out = renderDoc(d);
    expect(out).toContain("first\n\n## Mid");
    expect(out).not.toContain("first\n## Mid");
    expect(out).toContain("mid body\n\nsecond");
    expect(out).not.toContain("mid body\nsecond");
  });

  it("update requires content_hash CAS and replaces content in place", () => {
    const d = doc("# Title\n\nOld body.\n");
    const bId = idAt(d, 1);
    expect(() => opUpdate(d, bId, 0, "New body.")).toThrow(MutationError); // missing expect
    opUpdate(d, bId, 0, "New body.", undefined, { content_hash: hashAt(d, 1) });
    expect(locate(d, bId)!.block.raw).toBe("New body.");
    expect(locate(d, bId)!.block.id).toBe(bId); // placement/identity untouched
  });

  it("update with multi-block content: the target takes the first block, the rest follow as fresh siblings", () => {
    const d = doc("# Title\n\nOld body.\n\nTail.\n");
    const bId = idAt(d, 1);
    const tailId = idAt(d, 2);
    const { ids } = opUpdate(d, bId, 0, "New body.\n\n- one\n- two\n\n## Sub", undefined, { content_hash: hashAt(d, 1) });
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(bId);
    expect(d.children.map((b) => b.id)).toEqual([idAt(d, 0), ...ids, tailId]);
    expect(d.children.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "heading", "paragraph"]);
    // separators between the new run, the old trailing trivia after its last block
    expect(renderDoc(d)).toBe("# Title\n\nNew body.\n\n- one\n- two\n\n## Sub\n\nTail.\n");
  });

  it("update of a list item with a multi-item list: first item replaces, the rest become sibling items", () => {
    const d = doc("- a\n- c\n");
    const list = d.children[0]!;
    const a = list.children[0]!;
    const cId = list.children[1]!.id;
    const { ids } = opUpdate(d, a.id, 0, "- a1\n- b", undefined, { content_hash: rawHashHex(a.raw) });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(a.id);
    expect(list.children.map((b) => b.id)).toEqual([a.id, ids[1], cId]);
    expect(renderDoc(d)).toBe("- a1\n- b\n- c\n");
  });

  it("update rejects a stale content_hash with current truth", () => {
    const d = doc("para one\n");
    try {
      opUpdate(d, idAt(d, 0), 3, "x", undefined, { content_hash: "deadbeef" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MutationError);
      const err = e as MutationError;
      expect(err.code).toBe("stale_expectation");
      expect(err.data.op_index).toBe(3);
      expect((err.data.current as { markdown: string }).markdown).toBe("para one");
    }
  });

  it("update toggles a task checkbox via attrs", () => {
    const d = doc("- [ ] do the thing\n");
    const item = d.children[0]!.children[0]!;
    opUpdate(d, item.id, 0, undefined, { checked: true }, { content_hash: rawHashHex(item.raw) });
    expect(locate(d, item.id)!.block.raw).toContain("[x]");
  });

  it("move relocates a contiguous run; content untouched", () => {
    const d = doc("# A\n\nfirst\n\nsecond\n\n## B\n");
    const firstId = idAt(d, 1);
    opMove(d, [firstId], { parent: { doc: true }, at: "end" }, 0);
    expect(d.children[d.children.length - 1]!.id).toBe(firstId);
    expect(locate(d, firstId)!.block.raw).toBe("first");
  });

  it("move rejects a non-contiguous run", () => {
    const d = doc("a\n\nb\n\nc\n");
    expect(() => opMove(d, [idAt(d, 0), idAt(d, 2)], { parent: { doc: true }, at: "start" }, 0)).toThrow(/not_contiguous|contiguous/);
  });

  it("move rejects a cycle (target inside moved subtree)", () => {
    const d = doc("- parent\n  - child\n");
    const list = d.children[0]!;
    const item = list.children[0]!;
    expect(() => opMove(d, [list.id], { parent: item.id, at: "end" }, 0)).toThrow(MutationError);
    try { opMove(d, [list.id], { parent: item.id, at: "end" }, 0); } catch (e) { expect((e as MutationError).code).toBe("cycle_move"); }
  });

  it("remove deletes a subtree and reports removed ids", () => {
    const d = doc("# A\n\ndoomed\n\ntail\n");
    const before = d.children.length;
    const { removed } = opRemove(d, [idAt(d, 1)], 0);
    expect(removed.length).toBeGreaterThanOrEqual(1);
    expect(d.children.length).toBe(before - 1);
  });

  it("split: first fragment keeps the id, rest minted", () => {
    const d = doc("first sentence. second sentence.\n");
    const bId = idAt(d, 0);
    const raw = d.children[0]!.raw;
    const cut = raw.indexOf("second");
    const { ids } = opSplit(d, bId, [cut], 0, { content_hash: hashAt(d, 0) });
    expect(ids[0]).toBe(bId); // first fragment carries
    expect(ids.length).toBe(2);
    expect(d.children[0]!.raw.trim()).toBe("first sentence.");
    expect(d.children[1]!.raw.trim()).toBe("second sentence.");
  });

  it("merge: contiguous same-type siblings become one; first keeps id", () => {
    const d = doc("alpha\n\nbeta\n");
    const firstId = idAt(d, 0);
    const { ids, mergedInto } = opMerge(d, [idAt(d, 0), idAt(d, 1)], 0, " ");
    expect(ids[0]).toBe(firstId);
    expect(mergedInto).toHaveLength(1);
    expect(d.children).toHaveLength(1);
    expect(d.children[0]!.raw).toBe("alpha beta");
  });

  // Freshly parsed content is authoritative: a blockquote/table inserted or
  // replaced whole renders its raw verbatim (no child rebuild). A NESTED edit
  // inside one rebuilds the container faithfully (markers / delimiter row).
  it("insert of a blockquote and a table renders them verbatim", () => {
    const d = doc("# H\n\ntail\n");
    opInsert(d, { parent: { doc: true }, at: { after: idAt(d, 0) } }, "> quoted line\n> second line\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n");
    expect(renderDoc(d)).toBe("# H\n\n> quoted line\n> second line\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\ntail\n");
  });

  it("update replacing a blockquote / table whole keeps markers and the delimiter row", () => {
    const d = doc("# H\n\n> old quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    opUpdate(d, idAt(d, 1), 0, "> new quote\n> more", undefined, { content_hash: hashAt(d, 1) });
    opUpdate(d, idAt(d, 2), 1, "| c | d |\n|---|---|\n| 3 | 4 |", undefined, { content_hash: hashAt(d, 2) });
    expect(renderDoc(d)).toBe("# H\n\n> new quote\n> more\n\n| c | d |\n|---|---|\n| 3 | 4 |\n");
  });

  it("nested update inside a blockquote re-prefixes `> `; inside a table keeps the delimiter row", () => {
    const d = doc("> first para\n>\n> second para\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n");
    const bq = d.children[0]!;
    const inner = bq.children[1]!;
    opUpdate(d, inner.id, 0, "second para edited", undefined, { content_hash: rawHashHex(inner.raw) });
    const table = d.children[1]!;
    const row = table.children[2]!;
    opUpdate(d, row.id, 1, "| 3 | 40 |", undefined, { content_hash: rawHashHex(row.raw) });
    expect(renderDoc(d)).toBe("> first para\n>\n> second para edited\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 40 |\n");
  });
});

// spec/mutate §2.5 (§10 "Fixed"): `split.at` are UTF-8 byte offsets, not the
// UTF-16 indices a JavaScript string slices at. Non-ASCII text BEFORE the cut
// makes the two disagree.
describe("split — byte offsets", () => {
  it("cuts at UTF-8 byte offsets when multi-byte characters precede the cut", () => {
    const d = doc("héllo wörld — café tail\n");
    const raw = d.children[0]!.raw;
    // "héllo wörld — café " is 19 characters but 24 bytes (é ö é = 2 bytes each, — = 3).
    const cutBytes = Buffer.byteLength("héllo wörld — café ", "utf8");
    expect(cutBytes).toBe(24);
    const { ids } = opSplit(d, idAt(d, 0), [cutBytes], 0, { content_hash: hashAt(d, 0) });
    expect(ids).toHaveLength(2);
    expect(d.children[0]!.raw).toBe("héllo wörld — café ");
    expect(d.children[1]!.raw).toBe("tail");
    void raw;
  });

  it("an offset inside a multi-byte sequence rounds down to the character's start", () => {
    const d = doc("aé b\n");
    // bytes: a(0) é(1,2) ' '(3) b(4); byte 2 is inside é → cut before é.
    opSplit(d, idAt(d, 0), [2], 0, { content_hash: hashAt(d, 0) });
    expect(d.children.map((b) => b.raw)).toEqual(["a", "é b"]);
  });
});

// spec/mutate §2.5: split seams follow update's extra-sibling path — the target's
// trailing trivia moves to the LAST piece, earlier pieces get the separator.
describe("split — seams", () => {
  it("splitting a document's last block keeps the pieces apart and moves the tail trivia to the last piece", () => {
    const d = doc("Alpha beta gamma.\n");
    expect(d.children[0]!.trivia).toBe("\n");
    const { ids } = opSplit(d, idAt(d, 0), [6], 0, { content_hash: hashAt(d, 0) });
    expect(ids).toHaveLength(2);
    expect(d.children.map((b) => b.trivia)).toEqual(["\n\n", "\n"]);
    expect(renderDoc(d)).toBe("Alpha \n\nbeta gamma.\n");
  });

  it("three pieces: every earlier piece separates, the last carries the original trivia", () => {
    const d = doc("one two three\n\nTail.\n");
    opSplit(d, idAt(d, 0), [4, 8], 0, { content_hash: hashAt(d, 0) });
    expect(d.children.map((b) => b.trivia)).toEqual(["\n\n", "\n\n", "\n\n", "\n"]);
    expect(renderDoc(d)).toBe("one \n\ntwo \n\nthree\n\nTail.\n");
  });
});
