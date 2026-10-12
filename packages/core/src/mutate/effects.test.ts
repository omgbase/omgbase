import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { observeBatch } from "../sync/observe.js";
import { setIdMinter, sequentialMinter } from "../core/ids.js";
import { NullDocStore } from "./doc-store.js";
import { validateEffects, validateEffect, type Effect } from "./effects.js";
import { planEffects, type Plan } from "./plan.js";
import { MutationError } from "./tree.js";

// spec/mutate §11.1–§11.3: the vocabulary's shape check, the lowering table
// row by row (what each effect becomes in the plan's opset), and each conflict
// rule. The fixtures (`spec/mutate/cases/effects.json`) pin the projections;
// these tests name the rules.

let store: Store;
let repoId: string;
const DOC = "---\nstatus: draft\n---\n\n# Title\n\nIntro paragraph.\n\n## Notes\n\nFirst note.\n\nSecond note.\n\n- [ ] alpha\n- [ ] beta\n\n## Later\n\nTail.\n";

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  setIdMinter(sequentialMinter());
  repoId = ensureRepo(store, "t", null);
  // d_0: b_0 # Title, b_1 Intro, b_2 ## Notes, b_3 First note., b_4 Second note., b_5 list (b_6, b_7 tasks), b_8 ## Later, b_9 Tail.
  // d_1: b_10 # B, b_11 the paragraph linking to a.md.
  // Observed (not `ingestFile`d): the edge index the inbound retarget reads is the sync layer's.
  observeBatch(store, repoId, [{ path: "a.md", content: DOC }, { path: "b.md", content: "# B\n\nSee [a](/a.md).\n" }], "2026-10-12T09:00:00.000Z", {});
});
afterEach(() => {
  setIdMinter(null);
  store.close();
});

function plan(effects: unknown): Plan {
  return planEffects(store, { repoId, docStore: new NullDocStore(), effects });
}
function failure(effects: unknown): MutationError {
  try {
    plan(effects);
  } catch (e) {
    if (e instanceof MutationError) return e;
    throw e;
  }
  throw new Error("expected the plan to fail");
}

const doc = { kind: "document", path: "a.md" } as const;

describe("validateEffects (§11.1)", () => {
  it("accepts the nine ops and normalizes nothing (defaults stay absent until resolution)", () => {
    const es = validateEffects([
      { op: "create", path: "x.md", markdown: "# X" },
      { op: "insert", into: doc, markdown: "p" },
      { op: "set", target: doc, field: "frontmatter.k", value: 1 },
      { op: "unset", target: doc, field: "frontmatter.k" },
      { op: "move", target: doc, to: "y.md" },
      { op: "move", targets: [{ kind: "block", id: "b_1" }], into: doc },
      { op: "remove", target: doc },
      { op: "remove", targets: [{ kind: "block", id: "b_1" }] },
      { op: "split", target: { kind: "block", id: "b_1" }, at: [3] },
      { op: "merge", targets: [{ kind: "block", id: "b_1" }, { kind: "block", id: "b_3" }] },
      { op: "retarget", repairs: [{ from: "/a.md", to: "/b.md" }] },
    ]);
    expect(es).toHaveLength(11);
    expect((es[1] as { at?: unknown }).at).toBeUndefined();
  });

  it.each([
    [[], "must name at least one effect"],
    ["nope", "must be an array"],
    [[{ op: "zap" }], 'effects[0]: `op` must be one of'],
    [[{ op: "insert", into: doc, markdown: "p", bogus: 1 }], "effects[0]: unknown key `bogus`"],
    [[{ op: "insert", into: { kind: "node", id: "n_1" }, markdown: "p" }], "effects[0].into: `kind` must be one of document, section, block"],
    [[{ op: "set", target: doc, field: "title", value: 1 }], "a document's `field` is `frontmatter.<key>` or `content`"],
    [[{ op: "unset", target: doc, field: "content" }], "a document's `field` is `frontmatter.<key>`"],
    [[{ op: "set", target: { kind: "block", id: "b_1" }, field: "attrs.level", value: 2 }], "a block's `field` is `markdown` or `attrs.checked`"],
    [[{ op: "set", target: doc, field: "frontmatter.k" }], "`value` is required"],
    [[{ op: "insert", into: doc, at: { near: "b_1" }, markdown: "p" }], "`at` must be"],
    [[{ op: "split", target: { kind: "block", id: "b_1" }, at: [-1] }], "`at` must be an array of byte offsets"],
    [[{ op: "move", target: doc, to: "y.md", retarget_inbound: "yes" }], "`retarget_inbound` must be a boolean"],
    [[{ op: "insert", into: { kind: "document" }, markdown: "p" }], "a document target needs `id` or `path`"],
  ])("rejects %j as filter_invalid with hint arguments", (effects, message) => {
    const e = failure(effects);
    expect(e.code).toBe("filter_invalid");
    expect(e.data.hint).toBe("arguments");
    expect(e.message).toContain(message);
  });

  it("names the effect index in a nested failure", () => {
    expect(() => validateEffect({ op: "retarget", repairs: [{ from: 1 }] }, 4)).toThrow(/effects\[4\]\.repairs\[0\]: `from` must be a string/);
  });
});

describe("the lowering table (§11.3)", () => {
  it("insert into document / section / block → the three kernel placements", () => {
    const p = plan([
      { op: "insert", into: doc, markdown: "A" },
      { op: "insert", into: { kind: "section", heading_id: "b_2" }, at: "start", markdown: "B" },
      { op: "insert", into: { kind: "block", id: "b_5" }, markdown: "- gamma" },
    ]);
    expect(p.opset.ops).toEqual([
      { op: "insert", doc: "d_0", to: { parent: { doc: true }, at: "end" }, markdown: "A" },
      { op: "insert", to: { parent: { heading: "b_2", scope: "section" }, at: "start" }, markdown: "B" },
      { op: "insert", to: { parent: "b_5", at: "end" }, markdown: "- gamma" },
    ]);
    expect(p.effects.map((e) => (e as { at?: unknown }).at)).toEqual(["end", "start", "end"]);
    expect(p.new_ids.map((n) => n.symbol)).toEqual(["$new.0", "$new.1", "$new.2", "$new.3"]);
  });

  it("set/unset frontmatter.<k> → one file head per document, the last patch winning, no kernel op", () => {
    const p = plan([
      { op: "set", target: doc, field: "frontmatter.owner", value: "me" },
      { op: "unset", target: doc, field: "frontmatter.status" },
    ]);
    expect(p.opset.ops).toEqual([]);
    expect(p.opset.set_frontmatter).toEqual([{ doc: "d_0", raw: "---\nowner: me\n---\n\n" }]);
    expect(p.preview!.diffs["a.md"]!.after).toBe(DOC.replace("status: draft", "owner: me"));
    expect(p.preconditions.docs).toEqual([{ id: "d_0", path: "a.md", base_revision: "r_0", hash: expect.any(String) }]);
  });

  it("set block.markdown → update with the live hash pinned (and the caller's hash honoured)", () => {
    const p = plan([{ op: "set", target: { kind: "block", id: "b_3" }, field: "markdown", value: "First note, edited." }]);
    const op = p.opset.ops[0] as { op: string; block: string; expect: { content_hash: string } };
    expect(op.op).toBe("update");
    expect(op.block).toBe("b_3");
    expect(op.expect.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.preconditions.blocks).toEqual([{ id: "b_3", content_hash: op.expect.content_hash }]);
    const stale = failure([{ op: "set", target: { kind: "block", id: "b_3" }, field: "markdown", value: "x", expect: { content_hash: "00" } }]);
    expect(stale.code).toBe("stale_expectation");
    expect(stale.data.effect_index).toBe(0);
  });

  it("set block.attrs.checked → update { attrs: { checked } }; a non-boolean is filter_invalid", () => {
    const p = plan([{ op: "set", target: { kind: "block", id: "b_6" }, field: "attrs.checked", value: true }]);
    expect(p.opset.ops[0]).toMatchObject({ op: "update", block: "b_6", attrs: { checked: true } });
    expect(failure([{ op: "set", target: { kind: "block", id: "b_6" }, field: "attrs.checked", value: "yes" }]).code).toBe("filter_invalid");
  });

  it("set document.content → the whole-document planner's ops with a file head; a non-string is filter_invalid", () => {
    const p = plan([{ op: "set", target: doc, field: "content", value: "---\nstatus: done\n---\n\n# Title\n\nIntro paragraph.\n" }]);
    expect(p.opset.set_frontmatter).toEqual([{ doc: "d_0", raw: "---\nstatus: done\n---\n\n" }]);
    expect(p.opset.ops.length).toBeGreaterThan(0);
    expect(p.preview!.diffs["a.md"]!.after).toBe("---\nstatus: done\n---\n\n# Title\n\nIntro paragraph.\n");
    expect(failure([{ op: "set", target: doc, field: "content", value: 1 }]).code).toBe("filter_invalid");
  });

  it("move document → moves[] + the inbound retarget update; retarget_inbound:false → no update", () => {
    const withRetarget = plan([{ op: "move", target: doc, to: "/moved/a.md" }]);
    expect(withRetarget.opset.moves).toEqual([{ id: "d_0", from: "a.md", to: "moved/a.md" }]);
    expect(withRetarget.opset.ops).toHaveLength(1);
    expect(withRetarget.opset.ops[0]).toMatchObject({ op: "update", block: "b_11", markdown: "See [a](/moved/a.md)." });
    expect(withRetarget.preconditions.absent_paths).toEqual(["moved/a.md"]);
    expect(withRetarget.preconditions.docs.map((d) => d.id)).toEqual(["d_1", "d_0"]);
    expect(Object.keys(withRetarget.preview!.diffs).sort()).toEqual(["a.md", "b.md", "moved/a.md"]);
    const without = plan([{ op: "move", target: doc, to: "moved/a.md", retarget_inbound: false }]);
    expect(without.opset.ops).toEqual([]);
    expect((without.effects[0] as { retarget_inbound: boolean }).retarget_inbound).toBe(false);
  });

  it("move blocks / remove blocks / split / merge → the kernel op 1:1 with pins", () => {
    const p = plan([
      { op: "move", targets: [{ kind: "block", id: "b_9" }], into: { kind: "section", heading_id: "b_2" } },
      { op: "remove", targets: [{ kind: "block", id: "b_8" }] },
      { op: "split", target: { kind: "block", id: "b_1" }, at: [6] },
      { op: "merge", targets: [{ kind: "block", id: "b_3" }, { kind: "block", id: "b_4" }] },
    ]);
    expect(p.opset.ops.map((o) => o.op)).toEqual(["move", "remove", "split", "merge"]);
    expect(p.opset.ops[1]).toMatchObject({ blocks: ["b_8"], expect: { b_8: { content_hash: expect.any(String) } } });
    expect(p.opset.ops[3]).toMatchObject({ blocks: ["b_3", "b_4"], separator: " " });
    expect(p.preconditions.blocks.map((b) => b.id)).toEqual(["b_8", "b_1", "b_3", "b_4"]);
    const after = p.preview!.diffs["a.md"]!.after;
    expect(after).toContain("Intro \n\nparagraph.\n\n## Notes\n\nFirst note. Second note.\n\n- [ ] alpha\n- [ ] beta\n\nTail.");
    expect(after).not.toContain("## Later");
  });

  it("remove document → tombstones[] with the document's triple pinned", () => {
    const p = plan([{ op: "remove", target: { kind: "document", path: "b.md" } }]);
    expect(p.opset.tombstones).toEqual([{ id: "d_1", path: "b.md" }]);
    expect(p.preconditions.docs).toEqual([{ id: "d_1", path: "b.md", base_revision: "r_1", hash: expect.any(String) }]);
    expect(p.preview!.revisions).toEqual([]);
  });

  it("retarget → links_repair's updates; create → creates[] with later sets folded in", () => {
    const p = plan([
      { op: "retarget", repairs: [{ from: "/a.md", to: "/elsewhere.md" }] },
      { op: "create", path: "/new.md", markdown: "# New", frontmatter: { type: "note" } },
      { op: "set", target: { kind: "document", id: "$new.1" }, field: "frontmatter.status", value: "draft" },
      { op: "unset", target: { kind: "document", id: "$new.1" }, field: "frontmatter.type" },
    ]);
    expect(p.opset.ops[0]).toMatchObject({ op: "update", block: "b_11", markdown: "See [a](/elsewhere.md)." });
    expect(p.opset.creates).toEqual([{ path: "new.md", source: "---\nstatus: draft\n---\n\n# New\n" }]);
    expect(p.new_ids).toEqual([{ symbol: "$new.0", kind: "block" }, { symbol: "$new.1", kind: "document" }]);
    expect(p.effects[2]).toMatchObject({ op: "set", target: { kind: "document", id: "$new.1", path: "new.md" } });
    expect(p.preview!.revisions.find((r) => r.id === "$new.1")).toMatchObject({ path: "new.md" });
  });

  it("$new.n blocks lower through the kernel placeholder of the op that minted them", () => {
    const p = plan([
      { op: "insert", into: doc, markdown: "Para A." },
      { op: "insert", into: doc, at: { after: "$new.0" }, markdown: "Para B." },
      { op: "set", target: { kind: "block", id: "$new.0" }, field: "markdown", value: "Para A, edited." },
    ]);
    expect(p.opset.ops[1]).toMatchObject({ to: { parent: { doc: true }, at: { after: "$0.ids[0]" } } });
    expect(p.opset.ops[2]).toMatchObject({ op: "update", block: "$0.ids[0]" });
    expect(p.preconditions.blocks).toEqual([]);
    expect(p.preview!.results[0]).toEqual({ ids: ["$new.0"] });
  });

  it("$new.n before its creation, of the wrong kind, or as an insert target is target_missing naming the symbol", () => {
    expect(failure([{ op: "set", target: { kind: "block", id: "$new.3" }, field: "markdown", value: "x" }])).toMatchObject({ code: "target_missing", data: { symbol: "$new.3" } });
    expect(failure([{ op: "create", path: "n.md", markdown: "x" }, { op: "set", target: { kind: "block", id: "$new.0" }, field: "markdown", value: "x" }])).toMatchObject({ code: "target_missing", data: { symbol: "$new.0" } });
    expect(failure([{ op: "create", path: "n.md", markdown: "x" }, { op: "insert", into: { kind: "document", id: "$new.0" }, markdown: "x" }])).toMatchObject({ code: "target_missing", data: { symbol: "$new.0" } });
  });

  it("create at a taken path, twice in one plan, or at a move's destination is path_taken", () => {
    expect(failure([{ op: "create", path: "a.md", markdown: "x" }]).code).toBe("path_taken");
    expect(failure([{ op: "create", path: "n.md", markdown: "x" }, { op: "create", path: "/n.md", markdown: "y" }])).toMatchObject({ code: "path_taken", data: { effect_index: 1 } });
    expect(failure([{ op: "move", target: doc, to: "n.md" }, { op: "create", path: "n.md", markdown: "y" }]).code).toBe("path_taken");
  });

  it("expect.revision is checked at plan time: stale_plan", () => {
    const e = failure([{ op: "insert", into: doc, markdown: "x", expect: { revision: "r_9" } }]);
    expect(e.code).toBe("stale_plan");
    expect(e.data).toMatchObject({ doc: "d_0", expected_revision: "r_9", current: { revision: "r_0" }, retriable: true });
    expect(plan([{ op: "insert", into: doc, markdown: "x", expect: { revision: "r_0" } }]).opset.ops).toHaveLength(1);
  });
});

describe("conflict rules (§11.3)", () => {
  const set = (value: unknown): Effect => ({ op: "set", target: doc, field: "frontmatter.status", value });

  it("scalar: a different value is conflicting_effects naming both effects and the focus", () => {
    const e = failure([set("a"), set("b")]);
    expect(e.code).toBe("conflicting_effects");
    expect(e.data).toEqual({ effects: [0, 1], focus: { kind: "scalar", target: { kind: "document", id: "d_0" }, field: "frontmatter.status" }, retriable: false, effect_index: 1 });
  });

  it("scalar: an identical value is dropped with a diagnostic (canonical JSON equality: 1 and 1.0 are identical)", () => {
    const p = plan([set({ a: 1, b: [true] }), set({ b: [true], a: 1.0 })]);
    expect(p.effects).toHaveLength(1);
    expect(p.diagnostics).toEqual(["effect 1 (set frontmatter.status on document d_0) duplicates effect 0; dropped"]);
  });

  it("scalar: set then unset, unset then set, and move-then-move of a document all conflict", () => {
    expect(failure([set("a"), { op: "unset", target: doc, field: "frontmatter.status" }]).code).toBe("conflicting_effects");
    expect(failure([{ op: "unset", target: doc, field: "frontmatter.status" }, set("a")]).code).toBe("conflicting_effects");
    expect(failure([{ op: "move", target: doc, to: "x.md" }, { op: "move", target: doc, to: "y.md" }]).data).toMatchObject({ focus: { kind: "scalar", field: "path" } });
  });

  it("positional: any number of inserts, in order", () => {
    const p = plan([
      { op: "insert", into: { kind: "section", heading_id: "b_2" }, markdown: "1" },
      { op: "insert", into: { kind: "section", heading_id: "b_2" }, markdown: "2" },
      { op: "insert", into: { kind: "section", heading_id: "b_2" }, at: "start", markdown: "0" },
    ]);
    expect(p.opset.ops).toHaveLength(3);
    expect(p.preview!.diffs["a.md"]!.after).toContain("## Notes\n\n0\n\nFirst note.\n\nSecond note.\n\n- [ ] alpha\n- [ ] beta\n\n1\n\n2\n\n## Later");
  });

  it("identity: a removed block, a removed block's descendant, a merged-away block, a reparsed block's child", () => {
    const removed = failure([{ op: "remove", targets: [{ kind: "block", id: "b_3" }] }, { op: "set", target: { kind: "block", id: "b_3" }, field: "markdown", value: "x" }]);
    expect(removed.data).toMatchObject({ effects: [0, 1], focus: { kind: "identity", target: { kind: "block", id: "b_3" } } });
    const descendant = failure([{ op: "remove", targets: [{ kind: "block", id: "b_5" }] }, { op: "set", target: { kind: "block", id: "b_7" }, field: "attrs.checked", value: true }]);
    expect(descendant.data).toMatchObject({ focus: { target: { id: "b_7" } } });
    const merged = failure([{ op: "merge", targets: [{ kind: "block", id: "b_3" }, { kind: "block", id: "b_4" }] }, { op: "split", target: { kind: "block", id: "b_4" }, at: [2] }]);
    expect(merged.data).toMatchObject({ focus: { target: { id: "b_4" } } });
    const reparsed = failure([{ op: "set", target: { kind: "block", id: "b_5" }, field: "markdown", value: "- [ ] a" }, { op: "insert", into: { kind: "block", id: "b_6" }, markdown: "x" }]);
    expect(reparsed.data).toMatchObject({ focus: { target: { id: "b_6" } } });
    // an anchor counts as addressing
    const anchor = failure([{ op: "remove", targets: [{ kind: "block", id: "b_9" }] }, { op: "insert", into: doc, at: { after: "b_9" }, markdown: "x" }]);
    expect(anchor.code).toBe("conflicting_effects");
  });

  it("identity: a removed document, and an old path after a move", () => {
    expect(failure([{ op: "remove", target: doc }, { op: "insert", into: doc, markdown: "x" }]).data).toMatchObject({ focus: { kind: "identity", target: { kind: "document", id: "d_0" } } });
    expect(failure([{ op: "move", target: doc, to: "m.md" }, { op: "create", path: "a.md", markdown: "x" }]).data).toMatchObject({ focus: { kind: "identity", target: { kind: "path", path: "a.md" } } });
    expect(failure([{ op: "move", target: doc, to: "m.md" }, { op: "move", target: { kind: "document", path: "b.md" }, to: "a.md" }]).data).toMatchObject({ focus: { target: { kind: "path", path: "a.md" } } });
  });

  it("identity: set content conflicts with any earlier or later effect on the document", () => {
    const content = { op: "set", target: doc, field: "content", value: "# Title\n" };
    expect(failure([{ op: "insert", into: doc, markdown: "x" }, content]).data).toMatchObject({ effects: [0, 1], focus: { target: { kind: "document", id: "d_0" } } });
    // The document is retired as a whole, so a block of it is reported through the document (the more informative focus).
    expect(failure([content, { op: "set", target: { kind: "block", id: "b_3" }, field: "markdown", value: "x" }]).data).toMatchObject({ effects: [0, 1], focus: { kind: "identity", target: { kind: "document", id: "d_0" } } });
    expect(failure([content, set("x")]).code).toBe("conflicting_effects");
  });

  it("a retarget's hits are scalar (block, markdown) foci", () => {
    const e = failure([
      { op: "set", target: { kind: "block", id: "b_11" }, field: "markdown", value: "See nothing." },
      { op: "retarget", repairs: [{ from: "/a.md", to: "/z.md" }] },
    ]);
    expect(e.data).toMatchObject({ effects: [0, 1], focus: { kind: "scalar", target: { kind: "block", id: "b_11" }, field: "markdown" } });
  });
});
