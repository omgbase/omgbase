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
});
