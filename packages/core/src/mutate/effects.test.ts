import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { observeBatch } from "../sync/observe.js";
import { setIdMinter, sequentialMinter } from "../core/ids.js";
import { NullDocStore } from "./doc-store.js";
import { bareTarget, validateEffects, validateEffect, type Effect } from "./effects.js";
import { planEffects, type Plan } from "./plan.js";
import { planUpdate } from "./plan-update.js";
import { MutationError, rawHashHex } from "./tree.js";
import { canonicalJson } from "./canonical.js";

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

const doc = { kind: "document", _path: "a.md" } as const;

describe("validateEffects (§11.1)", () => {
  it("accepts the nine ops and normalizes nothing (defaults stay absent until resolution)", () => {
    const es = validateEffects([
      { op: "create", path: "x.md", markdown: "# X" },
      { op: "insert", into: doc, markdown: "p" },
      { op: "set", target: doc, field: "_frontmatter.k", value: 1 },
      { op: "unset", target: doc, field: "_frontmatter.k" },
      { op: "move", target: doc, to: "y.md" },
      { op: "move", targets: [{ kind: "block", _id: "b_1" }], into: doc },
      { op: "remove", target: doc },
      { op: "remove", targets: [{ kind: "block", _id: "b_1" }] },
      { op: "split", target: { kind: "block", _id: "b_1" }, at: [3] },
      { op: "merge", targets: [{ kind: "block", _id: "b_1" }, { kind: "block", _id: "b_3" }] },
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
    [[{ op: "insert", into: { kind: "node", _id: "n_1" }, markdown: "p" }], "effects[0].into: `kind` must be one of document, section, block"],
    [[{ op: "set", target: doc, field: "title", value: 1 }], "a document's `field` is `_frontmatter.<key>` or `content`"],
    [[{ op: "unset", target: doc, field: "content" }], "a document's `field` is `_frontmatter.<key>`"],
    [[{ op: "set", target: { kind: "block", _id: "b_1" }, field: "attrs.level", value: 2 }], "a block's `field` is `markdown` or `_attrs.checked`"],
    [[{ op: "set", target: doc, field: "_frontmatter.k" }], "`value` is required"],
    [[{ op: "insert", into: doc, at: { near: "b_1" }, markdown: "p" }], "`at` must be"],
    [[{ op: "split", target: { kind: "block", _id: "b_1" }, at: [-1] }], "`at` must be an array of byte offsets"],
    [[{ op: "move", target: doc, to: "y.md", retarget_inbound: "yes" }], "`retarget_inbound` must be a boolean"],
    [[{ op: "insert", into: { kind: "document" }, markdown: "p" }], "a document target needs `_id` or `_path`"],
  ])("rejects %j as filter_invalid with hint arguments", (effects, message) => {
    const e = failure(effects);
    expect(e.code).toBe("filter_invalid");
    expect(e.data.hint).toBe("arguments");
    expect(e.message).toContain(message);
  });

  it("names the effect index in a nested failure", () => {
    expect(() => validateEffect({ op: "retarget", repairs: [{ from: 1 }] }, 4)).toThrow(/effects\[4\]\.repairs\[0\]: `from` must be a string/);
  });

  describe("bare targets (3.2, §11.8 Sugar)", () => {
    it("a bare string where a target object is expected: a path-looking string is a document, an id its kind, `$new.n` a deferred symbol", () => {
      expect(bareTarget("ws/alpha.md", "x")).toEqual({ kind: "document", _path: "ws/alpha.md" });
      expect(bareTarget("/a.md", "x")).toEqual({ kind: "document", _path: "/a.md" });
      expect(bareTarget("notes.md", "x")).toEqual({ kind: "document", _path: "notes.md" });
      expect(bareTarget("dir/file.yaml", "x")).toEqual({ kind: "document", _path: "dir/file.yaml" });
      expect(bareTarget("d_0", "x")).toEqual({ kind: "document", _id: "d_0" });
      expect(bareTarget("b_1", "x")).toEqual({ kind: "block", _id: "b_1" });
      expect(bareTarget("n_0123456789ab", "x")).toEqual({ kind: "node", _id: "n_0123456789ab" });
      expect(bareTarget("$new.3", "x")).toEqual({ kind: "symbol", _id: "$new.3" });
      // the shape check normalizes them in every target slot; the op's kind table applies to the normalized kind
      expect(validateEffect({ op: "insert", into: "a.md", markdown: "p" }, 0)).toEqual({ op: "insert", into: { kind: "document", _path: "a.md" }, markdown: "p" });
      expect(validateEffect({ op: "set", target: "b_1", field: "markdown", value: "p" }, 0)).toEqual({ op: "set", target: { kind: "block", _id: "b_1" }, field: "markdown", value: "p" });
      expect(validateEffect({ op: "remove", targets: ["b_1", { kind: "block", _id: "b_2" }] }, 0)).toEqual({ op: "remove", targets: [{ kind: "block", _id: "b_1" }, { kind: "block", _id: "b_2" }] });
      expect(validateEffect({ op: "move", targets: ["b_1"], into: "$new.0" }, 0)).toEqual({ op: "move", targets: [{ kind: "block", _id: "b_1" }], into: { kind: "symbol", _id: "$new.0" } });
      expect(() => validateEffect({ op: "split", target: "a.md", at: [1] }, 0)).toThrow('effects[0].target: `kind` must be one of block (got "document")');
      expect(() => validateEffect({ op: "unset", target: "b_1", field: "_frontmatter.k" }, 0)).toThrow('effects[0].target: `kind` must be one of document (got "block")');
      // a symbol defers its kind AND its field check (§11.2) to resolution
      expect(validateEffect({ op: "set", target: "$new.0", field: "_frontmatter.k", value: 1 }, 0)).toEqual({ op: "set", target: { kind: "symbol", _id: "$new.0" }, field: "_frontmatter.k", value: 1 });
      expect(validateEffect({ op: "set", target: "$new.0", field: "markdown", value: "x" }, 0)).toMatchObject({ target: { kind: "symbol" } });
    });

    it.each<[string, string, string]>([
      ["a locator", "hub.md#Status", "is a locator, not a target"],
      ["a bare word", "hello", 'a target is { kind: …, … } or a bare document path, a `b_`/`d_`/`n_` id or `$new.n` (got "hello")'],
      ["an id of another prefix", "c_0", '(got "c_0")'],
      ["a node id of the wrong length", "n_01", '(got "n_01")'],
      ["a `-> ` leader (the planner's, not the shape check's)", "-> project", "is bound by the planner"],
    ])("refuses %s as filter_invalid", (_what, ref, message) => {
      // the shape check itself (the planner desugars a leader before it gets here)
      let e: MutationError | undefined;
      try {
        validateEffects([{ op: "insert", into: ref, markdown: "p" }]);
      } catch (x) {
        e = x as MutationError;
      }
      expect(e).toBeInstanceOf(MutationError);
      e = e!;
      expect(e.code).toBe("filter_invalid");
      expect(e.message).toContain(message);
      if (ref.includes("#")) expect(e.data).toMatchObject({ hint: "arguments", fix: expect.stringContaining("blocks_resolve") });
    });
  });
});

describe("the lowering table (§11.3)", () => {
  it("insert into document / section / block → the three kernel placements", () => {
    const p = plan([
      { op: "insert", into: doc, markdown: "A" },
      { op: "insert", into: { kind: "section", heading_id: "b_2" }, at: "start", markdown: "B" },
      { op: "insert", into: { kind: "block", _id: "b_5" }, markdown: "- gamma" },
    ]);
    expect(p.opset.ops).toEqual([
      { op: "insert", doc: "d_0", to: { parent: { doc: true }, at: "end" }, markdown: "A" },
      { op: "insert", to: { parent: { heading: "b_2", scope: "section" }, at: "start" }, markdown: "B" },
      { op: "insert", to: { parent: "b_5", at: "end" }, markdown: "- gamma" },
    ]);
    expect(p.effects.map((e) => (e as { at?: unknown }).at)).toEqual(["end", "start", "end"]);
    expect(p.new_ids.map((n) => n.symbol)).toEqual(["$new.0", "$new.1", "$new.2", "$new.3"]);
  });

  it("set/unset _frontmatter.<k> → one file head per document, the last patch winning, no kernel op", () => {
    const p = plan([
      { op: "set", target: doc, field: "_frontmatter.owner", value: "me" },
      { op: "unset", target: doc, field: "_frontmatter.status" },
    ]);
    expect(p.opset.ops).toEqual([]);
    expect(p.opset.set_frontmatter).toEqual([{ doc: "d_0", raw: "---\nowner: me\n---\n\n" }]);
    expect(p.preview!.diffs["a.md"]!.after).toBe(DOC.replace("status: draft", "owner: me"));
    expect(p.preconditions.docs).toEqual([{ _id: "d_0", _path: "a.md", base_revision: "r_0", _hash: expect.any(String) }]);
  });

  it("set block.markdown → update with the live hash pinned (and the caller's hash honoured)", () => {
    const p = plan([{ op: "set", target: { kind: "block", _id: "b_3" }, field: "markdown", value: "First note, edited." }]);
    const op = p.opset.ops[0] as { op: string; block: string; expect: { content_hash: string } };
    expect(op.op).toBe("update");
    expect(op.block).toBe("b_3");
    expect(op.expect.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.preconditions.blocks).toEqual([{ _id: "b_3", content_hash: op.expect.content_hash }]);
    const stale = failure([{ op: "set", target: { kind: "block", _id: "b_3" }, field: "markdown", value: "x", expect: { content_hash: "00" } }]);
    expect(stale.code).toBe("stale_expectation");
    expect(stale.data.effect_index).toBe(0);
  });

  it("set block._attrs.checked → update { attrs: { checked } }; a non-boolean is filter_invalid", () => {
    const p = plan([{ op: "set", target: { kind: "block", _id: "b_6" }, field: "_attrs.checked", value: true }]);
    expect(p.opset.ops[0]).toMatchObject({ op: "update", block: "b_6", attrs: { checked: true } });
    expect(failure([{ op: "set", target: { kind: "block", _id: "b_6" }, field: "_attrs.checked", value: "yes" }]).code).toBe("filter_invalid");
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
    expect(withRetarget.opset.moves).toEqual([{ _id: "d_0", from: "a.md", to: "moved/a.md" }]);
    expect(withRetarget.opset.ops).toHaveLength(1);
    expect(withRetarget.opset.ops[0]).toMatchObject({ op: "update", block: "b_11", markdown: "See [a](/moved/a.md)." });
    expect(withRetarget.preconditions.absent_paths).toEqual(["moved/a.md"]);
    expect(withRetarget.preconditions.docs.map((d) => d._id)).toEqual(["d_1", "d_0"]);
    expect(Object.keys(withRetarget.preview!.diffs).sort()).toEqual(["a.md", "b.md", "moved/a.md"]);
    const without = plan([{ op: "move", target: doc, to: "moved/a.md", retarget_inbound: false }]);
    expect(without.opset.ops).toEqual([]);
    expect((without.effects[0] as { retarget_inbound: boolean }).retarget_inbound).toBe(false);
  });

  it("move blocks / remove blocks / split / merge → the kernel op 1:1 with pins", () => {
    const p = plan([
      { op: "move", targets: [{ kind: "block", _id: "b_9" }], into: { kind: "section", heading_id: "b_2" } },
      { op: "remove", targets: [{ kind: "block", _id: "b_8" }] },
      { op: "split", target: { kind: "block", _id: "b_1" }, at: [6] },
      { op: "merge", targets: [{ kind: "block", _id: "b_3" }, { kind: "block", _id: "b_4" }] },
    ]);
    expect(p.opset.ops.map((o) => o.op)).toEqual(["move", "remove", "split", "merge"]);
    expect(p.opset.ops[1]).toMatchObject({ blocks: ["b_8"], expect: { b_8: { content_hash: expect.any(String) } } });
    expect(p.opset.ops[3]).toMatchObject({ blocks: ["b_3", "b_4"], separator: " " });
    expect(p.preconditions.blocks.map((b) => b._id)).toEqual(["b_8", "b_1", "b_3", "b_4"]);
    const after = p.preview!.diffs["a.md"]!.after;
    // The split at byte 6 falls on the space after `Intro`; the cut edge is trimmed (spec/mutate §2.5, 3.5).
    expect(after).toContain("Intro\n\nparagraph.\n\n## Notes\n\nFirst note. Second note.\n\n- [ ] alpha\n- [ ] beta\n\nTail.");
    expect(after).not.toContain("## Later");
  });

  it("remove document → tombstones[] with the document's triple pinned", () => {
    const p = plan([{ op: "remove", target: { kind: "document", _path: "b.md" } }]);
    expect(p.opset.tombstones).toEqual([{ _id: "d_1", _path: "b.md" }]);
    expect(p.preconditions.docs).toEqual([{ _id: "d_1", _path: "b.md", base_revision: "r_1", _hash: expect.any(String) }]);
    expect(p.preview!.revisions).toEqual([]);
  });

  it("retarget → links_repair's updates (+ preview.retarget); create → creates[] (an adopted tree), a later set/unset on it a head", () => {
    const p = plan([
      { op: "retarget", repairs: [{ from: "/a.md", to: "/elsewhere.md" }] },
      { op: "create", path: "/new.md", markdown: "# New", frontmatter: { type: "note" } },
      { op: "set", target: { kind: "document", _id: "$new.1" }, field: "_frontmatter.status", value: "draft" },
      { op: "unset", target: { kind: "document", _id: "$new.1" }, field: "_frontmatter.type" },
    ]);
    expect(p.opset.ops[0]).toMatchObject({ op: "update", block: "b_11", markdown: "See [a](/elsewhere.md)." });
    expect(p.preview!.retarget).toEqual([{ effect_index: 0, hits: [expect.objectContaining({ _id: "b_11", _path: "b.md", oldRaw: "See [a](/a.md).", newRaw: "See [a](/elsewhere.md)." })], pairs: [{ from: "/a.md", to: "/elsewhere.md", hits: 1 }] }]);
    // The create's source is its own composition; the later frontmatter patches are a head on the symbol (3.0).
    expect(p.opset.creates).toEqual([{ symbol: "$new.1", path: "new.md", source: "---\ntype: note\n---\n\n# New\n", before_op: 1 }]);
    expect(p.opset.set_frontmatter).toEqual([{ doc: "$new.1", raw: "---\nstatus: draft\n---\n\n" }]);
    // $new.0: the retarget update's discarded re-parse mint; $new.1 the document; $new.2 its heading.
    expect(p.new_ids).toEqual([{ symbol: "$new.0", kind: "block" }, { symbol: "$new.1", kind: "document" }, { symbol: "$new.2", kind: "block" }]);
    expect(p.effects[2]).toMatchObject({ op: "set", target: { kind: "document", _id: "$new.1", _path: "new.md" } });
    expect(p.preview!.revisions.find((r) => r._id === "$new.1")).toMatchObject({ _path: "new.md" });
    expect(p.preview!.diffs["new.md"]).toEqual({ before: "", after: "---\nstatus: draft\n---\n\n# New\n" });
    expect(p.preconditions.docs.map((d) => d._id)).toEqual(["d_1"]);
    expect(p.preconditions.absent_paths).toEqual(["new.md"]);
  });

  it("slice 3: a created document is a loaded tree — its blocks are $new.k in pre-order and every later effect writes into it", () => {
    const p = plan([
      { op: "create", path: "n.md", markdown: "# New\n\n## Sec\n\nBody." },
      { op: "insert", into: { kind: "document", _id: "$new.0" }, markdown: "Tail." },
      { op: "insert", into: { kind: "section", heading_id: "$new.2" }, markdown: "In sec." },
      { op: "set", target: { kind: "block", _id: "$new.3" }, field: "markdown", value: "Body, edited." },
    ]);
    expect(p.new_ids.map((s) => `${s.symbol}:${s.kind}`)).toEqual(["$new.0:document", "$new.1:block", "$new.2:block", "$new.3:block", "$new.4:block", "$new.5:block", "$new.6:block"]);
    expect(p.opset.creates).toEqual([{ symbol: "$new.0", path: "n.md", source: "# New\n\n## Sec\n\nBody.\n", before_op: 0 }]);
    // The created document is addressed by its symbol (`doc`), its blocks by theirs — no kernel placeholder names them.
    expect(p.opset.ops[0]).toEqual({ op: "insert", doc: "$new.0", to: { parent: { doc: true }, at: "end" }, markdown: "Tail." });
    expect(p.opset.ops[1]).toEqual({ op: "insert", to: { parent: { heading: "$new.2", scope: "section" }, at: "end" }, markdown: "In sec." });
    expect(p.opset.ops[2]).toEqual({ op: "update", block: "$new.3", markdown: "Body, edited.", expect: { content_hash: rawHashHex("Body.") } });
    expect(p.preconditions).toEqual({ docs: [], blocks: [], parents: [], absent_paths: ["n.md"] });
    expect(p.preview!.results).toEqual([{ ids: ["$new.4"] }, { ids: ["$new.5"] }, { ids: ["$new.3"] }]);
    expect(p.preview!.diffs["n.md"]).toEqual({ before: "", after: "# New\n\n## Sec\n\nBody, edited.\n\nTail.\n\nIn sec.\n" });
    expect(p.preview!.revisions).toEqual([{ _id: "$new.0", _path: "n.md", _hash: expect.any(String) }]);
  });

  it("slice 3: move a block into a created document (the kernel move's `doc`), remove a created block, set _attrs.checked on one", () => {
    const p = plan([
      { op: "create", path: "n.md", markdown: "# N\n\n- [ ] task" },
      { op: "move", targets: [{ kind: "block", _id: "b_9" }], into: { kind: "document", _id: "$new.0" } },
      { op: "set", target: { kind: "block", _id: "$new.3" }, field: "_attrs.checked", value: true },
      { op: "remove", targets: [{ kind: "block", _id: "$new.1" }] },
    ]);
    expect(p.opset.ops[0]).toEqual({ op: "move", blocks: ["b_9"], to: { parent: { doc: true }, at: "end" }, doc: "$new.0" });
    expect(p.opset.ops[1]).toMatchObject({ op: "update", block: "$new.3", attrs: { checked: true } });
    expect(p.opset.ops[2]).toEqual({ op: "remove", blocks: ["$new.1"], expect: { "$new.1": { content_hash: rawHashHex("# N") } } });
    expect(p.preview!.diffs["n.md"]!.after).toBe("- [x] task\n\nTail.\n");
    expect(p.preview!.diffs["a.md"]!.after).not.toContain("Tail.");
    expect(p.preconditions.docs.map((d) => d._id)).toEqual(["d_0"]);
    expect(p.preconditions.blocks).toEqual([]); // a block move pins no content hash (§11.2: only `set`, `split`, `remove`, `merge` do)
    // A move into an EXISTING document at its top-level end names that document too.
    const q = plan([{ op: "move", targets: [{ kind: "block", _id: "b_9" }], into: { kind: "document", _path: "b.md" } }]);
    expect(q.opset.ops[0]).toMatchObject({ op: "move", doc: "d_1" });
    expect(q.preview!.diffs["b.md"]!.after).toBe("# B\n\nSee [a](/a.md).\n\nTail.\n");
  });

  it("slice 3: `set content` on a created document is refused; `create` after ops records its position", () => {
    expect(failure([{ op: "create", path: "n.md", markdown: "x" }, { op: "set", target: { kind: "document", _id: "$new.0" }, field: "content", value: "y" }])).toMatchObject({ code: "target_missing", data: { symbol: "$new.0", effect_index: 1 } });
    const p = plan([{ op: "insert", into: doc, markdown: "P." }, { op: "create", path: "n.md", markdown: "x" }, { op: "insert", into: { kind: "document", _id: "$new.1" }, markdown: "Q." }]);
    expect(p.opset.creates[0]).toMatchObject({ symbol: "$new.1", before_op: 1 });
    expect(p.new_ids.map((s) => s.kind)).toEqual(["block", "document", "block", "block"]);
  });

  it("set content → preview.identity carries exactly the whole-document planner's annotations; unchanged content plans nothing and pins the triple", () => {
    const content = "---\nstatus: draft\n---\n\n# Title\n\nIntro paragraph, revised.\n\n## Notes\n\nFirst note.\n\nSecond note.\n\n- [ ] alpha\n- [ ] beta\n\n## Later\n\nTail.\n\nNew tail.\n";
    const opset = planUpdate(store, repoId, "", "a.md", content);
    const p = plan([{ op: "set", target: doc, field: "content", value: content }]);
    const identity = p.preview!.identity!["d_0"]!;
    expect(Object.keys(p.preview!.identity!)).toEqual(["d_0"]);
    expect(identity.matcher_v).toBe(opset.matcherV);
    expect(identity.summary).toEqual(opset.summary);
    expect(identity.diagnostics).toEqual(opset.diagnostics);
    expect(identity.ops).toEqual(opset.ops.map((o, k) => ({ op_index: k, disposition: o.disposition, blocks: o.blocks, confidence: o.confidence, reason: o.reason, ...(o.detail !== undefined ? { detail: o.detail } : {}) })));
    expect(p.opset.ops).toHaveLength(opset.ops.length);
    expect(p.preview!.retarget).toBeUndefined();
    // The zero-effects rule: the content IS the document.
    const same = plan([{ op: "set", target: doc, field: "content", value: DOC }]);
    expect(same.opset).toEqual({ creates: [], moves: [], tombstones: [], set_frontmatter: [], ops: [] });
    expect(same.preconditions.docs).toEqual([{ _id: "d_0", _path: "a.md", base_revision: "r_0", _hash: expect.any(String) }]);
    expect(same.preview!.revisions).toEqual([]);
    expect(same.preview!.identity!["d_0"]).toMatchObject({ ops: [], summary: expect.objectContaining({ updated: 0, created: 0, removed: 0 }) });
    expect(plan([{ op: "insert", into: doc, markdown: "x" }]).preview!.identity).toBeUndefined();
  });

  it("$new.n blocks lower through the kernel placeholder of the op that minted them", () => {
    const p = plan([
      { op: "insert", into: doc, markdown: "Para A." },
      { op: "insert", into: doc, at: { after: "$new.0" }, markdown: "Para B." },
      { op: "set", target: { kind: "block", _id: "$new.0" }, field: "markdown", value: "Para A, edited." },
    ]);
    expect(p.opset.ops[1]).toMatchObject({ to: { parent: { doc: true }, at: { after: "$0.ids[0]" } } });
    expect(p.opset.ops[2]).toMatchObject({ op: "update", block: "$0.ids[0]" });
    expect(p.preconditions.blocks).toEqual([]);
    expect(p.preview!.results[0]).toEqual({ ids: ["$new.0"] });
  });

  it("$new.n before its creation or of the wrong kind is target_missing naming the symbol; an insert into a created document resolves (3.0)", () => {
    expect(failure([{ op: "set", target: { kind: "block", _id: "$new.3" }, field: "markdown", value: "x" }])).toMatchObject({ code: "target_missing", data: { symbol: "$new.3" } });
    expect(failure([{ op: "create", path: "n.md", markdown: "x" }, { op: "set", target: { kind: "block", _id: "$new.0" }, field: "markdown", value: "x" }])).toMatchObject({ code: "target_missing", data: { symbol: "$new.0" } });
    expect(failure([{ op: "insert", into: { kind: "document", _id: "$new.0" }, markdown: "x" }, { op: "create", path: "n.md", markdown: "x" }])).toMatchObject({ code: "target_missing", data: { symbol: "$new.0", effect_index: 0 } });
    expect(plan([{ op: "create", path: "n.md", markdown: "x" }, { op: "insert", into: { kind: "document", _id: "$new.0" }, markdown: "y" }]).opset.ops[0]).toMatchObject({ op: "insert", doc: "$new.0" });
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
  const set = (value: unknown): Effect => ({ op: "set", target: doc, field: "_frontmatter.status", value });

  it("scalar: a different value is conflicting_effects naming both effects and the focus", () => {
    const e = failure([set("a"), set("b")]);
    expect(e.code).toBe("conflicting_effects");
    expect(e.data).toEqual({ effects: [0, 1], focus: { kind: "scalar", target: { kind: "document", _id: "d_0" }, field: "_frontmatter.status" }, retriable: false, effect_index: 1, fix: canonicalJson({ effects: [set("b")] }) });
  });

  it("scalar: an identical value is dropped with a diagnostic (canonical JSON equality: 1 and 1.0 are identical)", () => {
    const p = plan([set({ a: 1, b: [true] }), set({ b: [true], a: 1.0 })]);
    expect(p.effects).toHaveLength(1);
    expect(p.diagnostics).toEqual(["effect 1 (set _frontmatter.status on document d_0) duplicates effect 0; dropped"]);
  });

  it("scalar: set then unset, unset then set, and move-then-move of a document all conflict", () => {
    expect(failure([set("a"), { op: "unset", target: doc, field: "_frontmatter.status" }]).code).toBe("conflicting_effects");
    expect(failure([{ op: "unset", target: doc, field: "_frontmatter.status" }, set("a")]).code).toBe("conflicting_effects");
    expect(failure([{ op: "move", target: doc, to: "x.md" }, { op: "move", target: doc, to: "y.md" }]).data).toMatchObject({ focus: { kind: "scalar", field: "_path" } });
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
    const removed = failure([{ op: "remove", targets: [{ kind: "block", _id: "b_3" }] }, { op: "set", target: { kind: "block", _id: "b_3" }, field: "markdown", value: "x" }]);
    expect(removed.data).toMatchObject({ effects: [0, 1], focus: { kind: "identity", target: { kind: "block", _id: "b_3" } } });
    const descendant = failure([{ op: "remove", targets: [{ kind: "block", _id: "b_5" }] }, { op: "set", target: { kind: "block", _id: "b_7" }, field: "_attrs.checked", value: true }]);
    expect(descendant.data).toMatchObject({ focus: { target: { _id: "b_7" } } });
    const merged = failure([{ op: "merge", targets: [{ kind: "block", _id: "b_3" }, { kind: "block", _id: "b_4" }] }, { op: "split", target: { kind: "block", _id: "b_4" }, at: [2] }]);
    expect(merged.data).toMatchObject({ focus: { target: { _id: "b_4" } } });
    const reparsed = failure([{ op: "set", target: { kind: "block", _id: "b_5" }, field: "markdown", value: "- [ ] a" }, { op: "insert", into: { kind: "block", _id: "b_6" }, markdown: "x" }]);
    expect(reparsed.data).toMatchObject({ focus: { target: { _id: "b_6" } } });
    // an anchor counts as addressing
    const anchor = failure([{ op: "remove", targets: [{ kind: "block", _id: "b_9" }] }, { op: "insert", into: doc, at: { after: "b_9" }, markdown: "x" }]);
    expect(anchor.code).toBe("conflicting_effects");
  });

  it("identity: a removed document, and an old path after a move", () => {
    expect(failure([{ op: "remove", target: doc }, { op: "insert", into: doc, markdown: "x" }]).data).toMatchObject({ focus: { kind: "identity", target: { kind: "document", _id: "d_0" } } });
    expect(failure([{ op: "move", target: doc, to: "m.md" }, { op: "create", path: "a.md", markdown: "x" }]).data).toMatchObject({ focus: { kind: "identity", target: { kind: "path", _path: "a.md" } } });
    expect(failure([{ op: "move", target: doc, to: "m.md" }, { op: "move", target: { kind: "document", _path: "b.md" }, to: "a.md" }]).data).toMatchObject({ focus: { target: { kind: "path", _path: "a.md" } } });
  });

  it("identity: set content conflicts with any earlier or later effect on the document", () => {
    const content = { op: "set", target: doc, field: "content", value: "# Title\n" };
    expect(failure([{ op: "insert", into: doc, markdown: "x" }, content]).data).toMatchObject({ effects: [0, 1], focus: { target: { kind: "document", _id: "d_0" } } });
    // The document is retired as a whole, so a block of it is reported through the document (the more informative focus).
    expect(failure([content, { op: "set", target: { kind: "block", _id: "b_3" }, field: "markdown", value: "x" }]).data).toMatchObject({ effects: [0, 1], focus: { kind: "identity", target: { kind: "document", _id: "d_0" } } });
    expect(failure([content, set("x")]).code).toBe("conflicting_effects");
  });

  it("a retarget's hits are scalar (block, markdown) foci", () => {
    const e = failure([
      { op: "set", target: { kind: "block", _id: "b_11" }, field: "markdown", value: "See nothing." },
      { op: "retarget", repairs: [{ from: "/a.md", to: "/z.md" }] },
    ]);
    expect(e.data).toMatchObject({ effects: [0, 1], focus: { kind: "scalar", target: { kind: "block", _id: "b_11" }, field: "markdown" } });
  });
});

describe("the summary (§11.9, 3.3)", () => {
  const lines = (effects: unknown): string[] => plan(effects).preview!.summary;

  it("names documents by rooted path, headings by text, other blocks by type and id; counts pluralize", () => {
    expect(lines([{ op: "set", target: "a.md", field: "_frontmatter.verified", value: false }])).toEqual(["set _frontmatter.verified = false in /a.md"]);
    expect(lines([{ op: "unset", target: doc, field: "_frontmatter.status" }])).toEqual(["unset _frontmatter.status in /a.md"]);
    expect(lines([{ op: "insert", into: "a.md", markdown: "P1\n\nP2" }])).toEqual(["insert 2 blocks at the end of /a.md"]);
    expect(lines([{ op: "insert", into: { kind: "section", heading_id: "b_2" }, markdown: "- [ ] x" }])).toEqual(['insert 1 block at the end of section "Notes" in /a.md']);
    expect(lines([{ op: "insert", into: doc, at: { after: "b_1" }, markdown: "P" }])).toEqual(["insert 1 block after paragraph b_1 in /a.md"]);
    expect(lines([{ op: "insert", into: doc, at: { before: "b_2" }, markdown: "P" }])).toEqual(['insert 1 block before heading "Notes" in /a.md']);
    expect(lines([{ op: "insert", into: { kind: "block", _id: "b_5" }, at: "start", markdown: "- [ ] gamma" }])).toEqual(["insert 1 block at the start of list b_5 in /a.md"]);
    expect(lines([{ op: "set", target: "b_1", field: "markdown", value: "New intro." }])).toEqual(["set markdown of paragraph b_1 in /a.md"]);
    expect(lines([{ op: "set", target: "b_6", field: "_attrs.checked", value: true }, { op: "set", target: "b_7", field: "_attrs.checked", value: false }])).toEqual(["check task b_6 in /a.md", "uncheck task b_7 in /a.md"]);
    expect(lines([{ op: "set", target: doc, field: "content", value: DOC.replace("Tail.", "Tail!") }])).toEqual(["set content of /a.md"]);
    const node = (store.db.prepare("SELECT node_id FROM nodes WHERE kind = 'md:task' AND block_id = 'b_6'").get() as { node_id: string }).node_id;
    expect(lines([{ op: "set", target: { kind: "node", _id: node }, field: "checked", value: true }])).toEqual([`set checked = true on node ${node} in /a.md`]);
  });

  it("create, move, remove, split, merge, retarget — and a created document's blocks are named from its tree", () => {
    expect(lines([
      { op: "create", path: "lab/x.md", markdown: "# X\n\nHello.\n" },
      { op: "insert", into: "$new.0", markdown: "More." },
      { op: "set", target: "$new.0", field: "_frontmatter.k", value: [1, 2] },
      { op: "set", target: "$new.2", field: "markdown", value: "Hi." },
      { op: "insert", into: { kind: "section", heading_id: "$new.1" }, markdown: "Under X." },
    ])).toEqual(["create /lab/x.md (2 blocks)", "insert 1 block at the end of /lab/x.md", "set _frontmatter.k = [1,2] in /lab/x.md", "set markdown of paragraph $new.2 in /lab/x.md", 'insert 1 block at the end of section "X" in /lab/x.md']);
    expect(lines([{ op: "move", target: doc, to: "c.md" }])).toEqual(["move /a.md → /c.md (retarget 1 link in 1 document)"]);
    expect(lines([{ op: "move", target: doc, to: "c.md", retarget_inbound: false }])).toEqual(["move /a.md → /c.md"]);
    expect(lines([{ op: "move", targets: ["b_3"], into: { kind: "section", heading_id: "b_8" } }, { op: "move", targets: ["b_4", "b_1"], into: "b.md" }]))
      .toEqual(['move paragraph b_3 to the end of section "Later" in /a.md', "move 2 blocks to the end of /b.md"]);
    expect(lines([{ op: "remove", target: "b.md" }])).toEqual(["remove /b.md"]);
    expect(lines([{ op: "remove", targets: ["b_3"] }, { op: "remove", targets: ["b_4", "b_9"] }])).toEqual(["remove paragraph b_3 from /a.md", "remove 2 blocks from /a.md"]);
    expect(lines([{ op: "split", target: "b_1", at: [5] }, { op: "split", target: "b_3", at: [2, 4] }])).toEqual(["split paragraph b_1 at offset 5 in /a.md", "split paragraph b_3 at offsets 2, 4 in /a.md"]);
    expect(lines([{ op: "merge", targets: ["b_3", "b_4"] }])).toEqual(["merge 2 blocks into paragraph b_3 in /a.md"]);
    expect(lines([{ op: "retarget", repairs: [{ from: "/a.md", to: "/z.md" }] }, { op: "retarget", repairs: [{ from: "/q.md", to: "/z.md" }, { from: "/r.md", to: "/s.md" }] }]))
      .toEqual(["retarget 1 link /a.md → /z.md in 1 document", "retarget 0 links over 2 pairs in 0 documents"]);
  });

  it("a dropped duplicate has no line; the lines are not digested", () => {
    const p = plan([{ op: "set", target: doc, field: "_frontmatter.k", value: 1 }, { op: "set", target: doc, field: "_frontmatter.k", value: 1 }]);
    expect(p.preview!.summary).toEqual(["set _frontmatter.k = 1 in /a.md"]);
    expect(p.diagnostics).toHaveLength(1);
  });
});

describe("the fix (§8, 3.3): a literal corrected call", () => {
  it("conflicting_effects keeps the later effect; a stale expect.revision takes the current one; a stray leader is spelled literally", () => {
    const conflict = failure([{ op: "set", target: "a.md", field: "_frontmatter.x", value: 1 }, { op: "set", target: "a.md", field: "_frontmatter.x", value: 2 }]);
    expect(conflict.data.fix).toBe('{"effects":[{"field":"_frontmatter.x","op":"set","target":"a.md","value":2}]}');
    const stale = failure([{ op: "set", target: "a.md", field: "_frontmatter.x", value: 1, expect: { revision: "r_999" } }]);
    expect(stale.code).toBe("stale_plan");
    expect(stale.data.fix).toBe('{"effects":[{"expect":{"revision":"r_0"},"field":"_frontmatter.x","op":"set","target":"a.md","value":1}]}');
    const leader = failure([{ op: "set", target: "a.md", field: "-> _frontmatter.x", value: 1 }]);
    expect(leader.code).toBe("filter_invalid");
    expect(leader.data.fix).toBe('{"effects":[{"field":"_frontmatter.x","op":"set","target":"a.md","value":1}]}');
  });

  it("a $new.n used before its create: the create moved first, the symbol renamed to the one it will allocate; no later create, no fix", () => {
    const e = failure([{ op: "set", target: "a.md", field: "_frontmatter.x", value: 1 }, { op: "insert", into: "$new.3", markdown: "x" }, { op: "create", path: "n.md", markdown: "# N" }]);
    expect(e.code).toBe("target_missing");
    expect(e.data.symbol).toBe("$new.3");
    expect(e.data.fix).toBe('{"effects":[{"field":"_frontmatter.x","op":"set","target":"a.md","value":1},{"markdown":"# N","op":"create","path":"n.md"},{"into":"$new.0","markdown":"x","op":"insert"}]}');
    expect(failure([{ op: "insert", into: "$new.0", markdown: "x" }]).data.fix).toBeUndefined();
  });
});
