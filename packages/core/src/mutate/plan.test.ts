import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { setIdMinter, sequentialMinter, mintId } from "../core/ids.js";
import { sha256 } from "../core/hash.js";
import { NullDocStore } from "./doc-store.js";
import { canonicalJson, planDigest, planCore, planEffects, executePlan, executeByDigest, applyEffects, admitPlan, PLANNER_V, type Plan, type Receipt } from "./plan.js";
import { MutationError } from "./tree.js";

// spec/mutate §11.4–§11.7: the canonical JSON and the digest (the exact rules
// a port must match), the symbolic `$new` map, the plan/execute protocol and
// its failure modes — a mid-transaction failure leaves no row and no file and
// burns no `c`/`d`/`r`, a replay is `stale_plan`, one-shot and plan+execute
// project identically.

describe("canonicalJson (§11.5)", () => {
  it.each<[unknown, string]>([
    [null, "null"],
    [true, "true"],
    [{ b: 1, a: 2 }, '{"a":2,"b":1}'],
    [{ "é": 1, z: 2 }, '{"z":2,"é":1}'],
    [{ a: undefined, b: null }, '{"b":null}'],
    [[1, undefined, 2], "[1,null,2]"],
    [1.0, "1"],
    [-0, "0"],
    [100, "100"],
    [2 ** 53 - 1, "9007199254740991"],
    [2 ** 53, "9007199254740992"],
    [1.5, "1.5"],
    [0.1 + 0.2, "0.30000000000000004"],
    [1e21, "1e+21"],
    [1e-7, "1e-7"],
    [0.000001, "0.000001"],
    [123456789012345680000, "123456789012345680000"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [5e-324, "5e-324"],
    [-2.5, "-2.5"],
    ['a"b\\c', '"a\\"b\\\\c"'],
    ["\n\r\t\b\f", '"\\n\\r\\t\\b\\f"'],
    ["", '"\\u0001\\u001f"'],
    ["/    é 😀", '"/    é 😀"'],
    [{ nested: { arr: [{ y: 1, x: [] }, {}] } }, '{"nested":{"arr":[{"x":[],"y":1},{}]}}'],
  ])("canonical(%j) = %s", (value, text) => {
    expect(canonicalJson(value)).toBe(text);
  });

  it("refuses what cannot be digested: NaN, Infinity, a lone surrogate, a function", () => {
    for (const v of [NaN, Infinity, -Infinity, "\ud800", () => 1]) {
      expect(() => canonicalJson(v)).toThrow(MutationError);
    }
  });

  it("planDigest covers exactly the six core keys — seven with `selection` (3.1); the pinned vectors", () => {
    const core = { version: 1 as const, planner_v: "p1", effects: [], opset: { creates: [], moves: [], tombstones: [], set_frontmatter: [], ops: [] }, preconditions: { docs: [], blocks: [], parents: [], absent_paths: [] }, new_ids: [] };
    const digest = planDigest(core);
    expect(digest).toBe("a20097a9c319b59a1313c83e1fd494bbb3cf4895040fbbddd2866e56b16cddd3");
    expect(planDigest({ ...core, plan_id: "x", diagnostics: ["d"], preview: { results: [] } } as never)).toBe(digest);
    expect(digest).toBe(sha256(canonicalJson(core)).toString("hex"));
    expect(planDigest({ ...core, planner_v: "p2" })).toBe("6f43b302fdcd58ca4fd182b21a5bdab6fee3787ddc074f5e7c5c23b2cc368bf9");
    expect(planDigest({ ...core, planner_v: PLANNER_V })).toBe("5051e40051314fa855721d1943b42a9acb867c79a7b49eb4db0fd811559289ff");
    expect(PLANNER_V).toBe("p3");
    // `selection` present ⇒ digested (the zero-hit vector of §11.5); absent ⇒ absent, never null.
    const selection = { query: 'from docs where type == "nope"', templates: [{ op: "set", field: "frontmatter.x", value: 1 }], cardinality: 0, identities: [] };
    expect(planDigest({ ...core, planner_v: PLANNER_V, selection })).toBe("73ca03407ddf05fb522c4118bd5ef1e88887f8430acbaba7428378a0b1e342c9");
    expect(planCore({ ...core, planner_v: PLANNER_V, selection })).toEqual({ ...core, planner_v: PLANNER_V, selection });
    expect(Object.keys(planCore({ ...core, planner_v: PLANNER_V }))).not.toContain("selection");
    expect(planDigest({ ...core, planner_v: PLANNER_V, selection: { ...selection, expect: { max: 3 } } })).not.toBe(planDigest({ ...core, planner_v: PLANNER_V, selection }));
  });
});

let store: Store;
let repoId: string;
const DOC = "---\nstatus: draft\n---\n\n# Title\n\nIntro paragraph.\n\n## Notes\n\nFirst note.\n\n## Later\n\nTail.\n";
const SLICE1 = [
  { op: "set", target: { kind: "document", path: "a.md" }, field: "frontmatter.status", value: "active" },
  { op: "insert", into: { kind: "section", heading_id: "b_2" }, at: "end", markdown: "Second note." },
];
const origin = { actor: "agent:test", reason: "test" };

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  setIdMinter(sequentialMinter());
  repoId = ensureRepo(store, "t", null);
  ingestFile(store, repoId, "a.md", DOC);
});
afterEach(() => {
  setIdMinter(null);
  store.close();
});

const base = () => ({ repoId, docStore: new NullDocStore(), origin, ts: "2026-10-12T10:00:00.000Z" });
/** The rows a commit leaves: docs, live blocks, commits (with `ops`), revisions, pending rows — enough to see one more or one fewer. */
function project(): unknown {
  const q = (sql: string): unknown[] => store.db.prepare(sql).all();
  return {
    docs: q("SELECT doc_id, path, current_rev, lower(hex(file_hash)) h, deleted_commit FROM docs ORDER BY path"),
    blocks: q("SELECT block_id, doc_id, parent_block, ordinal, text FROM blocks WHERE deleted_commit IS NULL ORDER BY doc_id, ordinal, block_id"),
    commits: q("SELECT commit_id, seq, origin, actor, reason, ops FROM commits ORDER BY seq"),
    revisions: q("SELECT rev_id, doc_id, seq, path, commit_id FROM revisions ORDER BY doc_id, seq"),
    pending: q("SELECT path, kind FROM pending_materializations ORDER BY path"),
  };
}

describe("plan + execute (§11.6, §11.7)", () => {
  it("a plan mints no real id; execute maps $new.n in mint order and records the intent", () => {
    const plan = planEffects(store, { ...base(), effects: SLICE1 });
    expect(plan.new_ids).toEqual([{ symbol: "$new.0", kind: "block" }]);
    expect(mintId("b")).toBe("b_6"); // nothing burned by planning
    const receipt = executePlan(store, { ...base(), plan });
    expect(receipt).toEqual({ plan_id: plan.plan_id, commit: "c_1", revisions: [{ id: "d_0", path: "a.md", hash: expect.any(String) }], new_ids: { "$new.0": "b_7" }, committed: true, summary: ['set frontmatter.status = "active" in /a.md', 'insert 1 block at the end of section "Notes" in /a.md'] });
    const commit = store.db.prepare("SELECT ops FROM commits WHERE commit_id = 'c_1'").get() as { ops: string };
    expect(commit.ops).toBe(canonicalJson({ v: 1, plan_id: plan.plan_id, effects: plan.effects }));
    expect(store.db.prepare("SELECT text FROM blocks WHERE block_id = 'b_7'").get()).toEqual({ text: "Second note." });
  });

  it("one-shot apply and plan+execute project identically", () => {
    const receipt = applyEffects(store, { ...base(), effects: SLICE1 }) as Receipt;
    const oneShot = project();
    store.close();
    store = new Store({ path: ":memory:" });
    setIdMinter(sequentialMinter());
    repoId = ensureRepo(store, "t", null);
    ingestFile(store, repoId, "a.md", DOC);
    const plan = planEffects(store, { ...base(), effects: SLICE1 });
    const second = executePlan(store, { ...base(), plan });
    expect(second).toEqual(receipt);
    expect(project()).toEqual(oneShot);
  });

  it("a replay is stale_plan; the digest form commits on equality and refuses a mismatch", () => {
    const plan = planEffects(store, { ...base(), effects: SLICE1 });
    executePlan(store, { ...base(), plan });
    expect(() => executePlan(store, { ...base(), plan })).toThrow(expect.objectContaining({ code: "stale_plan", data: expect.objectContaining({ doc: "d_0", expected_revision: "r_0", retriable: true }) }));
    // The document moved on, so the same effects now plan differently.
    expect(() => executeByDigest(store, { ...base(), planId: plan.plan_id, effects: SLICE1 })).toThrow(expect.objectContaining({ code: "plan_mismatch", data: expect.objectContaining({ expected: plan.plan_id }) }));
    const fresh = planEffects(store, { ...base(), effects: [{ op: "insert", into: { kind: "document", path: "a.md" }, markdown: "Third." }] });
    const r = executeByDigest(store, { ...base(), planId: fresh.plan_id, effects: [{ op: "insert", into: { kind: "document", path: "a.md" }, markdown: "Third." }] });
    expect(r.commit).toBe("c_2");
  });

  it("admitPlan: version first, then the shape, then the digest; preview and diagnostics are ignored", () => {
    expect(() => admitPlan({ version: 2 })).toThrow(expect.objectContaining({ code: "unsupported_plan_version", data: { version: 2, supported: [1] } }));
    expect(() => admitPlan({ version: 1, planner_v: "p1" })).toThrow(expect.objectContaining({ code: "filter_invalid" }));
    const plan = planEffects(store, { ...base(), effects: SLICE1 });
    const { preview: _p, ...noPreview } = plan;
    expect(admitPlan({ ...noPreview, diagnostics: ["whatever"] }).plan_id).toBe(plan.plan_id);
    const edited = { ...noPreview, effects: [...plan.effects].reverse() };
    expect(() => admitPlan(edited)).toThrow(expect.objectContaining({ code: "plan_mismatch", data: { expected: plan.plan_id, actual: planDigest(edited as Plan), fix: canonicalJson({ effects: edited.effects }) } }));
    expect(() => admitPlan("nope")).toThrow(expect.objectContaining({ code: "filter_invalid" }));
  });

  it("a failure inside the transaction leaves no row and no file; the plan stays executable (the pre-transaction b ids are burned, as every request's are)", () => {
    const docStore = new (class extends NullDocStore {
      readonly files = new Map<string, string>();
      override write(path: string, bytes: string): void {
        this.files.set(path, bytes);
      }
    })();
    const plan = planEffects(store, { ...base(), docStore, effects: [...SLICE1, { op: "create", path: "n.md", markdown: "# N" }] });
    const before = project();
    // Inject: the pending-row insert — the last statement of the transaction — dies.
    store.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON pending_materializations BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(() => executePlan(store, { ...base(), docStore, plan })).toThrow(/injected/);
    store.db.exec("DROP TRIGGER boom");
    // No row of any kind, no file: the rollback is total (the fixture minter's
    // counters advance for the ids the rolled-back transaction drew — a
    // sequence artefact; the database has no trace of them).
    expect(project()).toEqual(before);
    expect(docStore.files.size).toBe(0);
    // The replay minted b_6 (the insert's paragraph) and b_7 (the created
    // document's one block, its parse at `before_op`) before the transaction;
    // both are burned (rows: none).
    expect(mintId("b")).toBe("b_8");
    // And the plan is still executable: nothing moved.
    const receipt = executePlan(store, { ...base(), docStore, plan });
    expect(receipt.committed).toBe(true);
    expect(store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 1 });
    const live = (id: string): boolean => store.db.prepare("SELECT 1 FROM blocks WHERE block_id = ? AND deleted_commit IS NULL UNION SELECT 1 FROM docs WHERE doc_id = ? AND deleted_commit IS NULL").get(id, id) !== undefined;
    expect(live(receipt.new_ids["$new.0"]!)).toBe(true);
    expect(live(receipt.new_ids["$new.1"]!)).toBe(true);
    expect(docStore.files.get("n.md")).toBe("# N\n");
  });

  it("the document symbol zips onto the d minted inside the transaction, after the blocks", () => {
    const receipt = applyEffects(store, {
      ...base(),
      effects: [
        { op: "insert", into: { kind: "document", path: "a.md" }, markdown: "P." },
        { op: "create", path: "n.md", markdown: "# N\n\nBody." },
        { op: "set", target: { kind: "document", id: "$new.1" }, field: "frontmatter.k", value: [1, "two", { three: null }] },
        { op: "insert", into: { kind: "document", path: "a.md" }, markdown: "Q." },
      ],
    }) as Receipt;
    // $new.0 the first insert; $new.1 the document, $new.2/$new.3 its heading and paragraph (3.0: the
    // created tree's blocks are symbols too, minted by the replay's parse at the create's position);
    // $new.4 the second insert. Revisions in load order: a.md was touched first.
    expect(receipt.new_ids).toEqual({ "$new.0": "b_6", "$new.1": "d_1", "$new.2": "b_7", "$new.3": "b_8", "$new.4": "b_9" });
    expect(receipt.revisions.map((r) => [r.id, r.path])).toEqual([["d_0", "a.md"], ["d_1", "n.md"]]);
    const created = store.db.prepare("SELECT path FROM docs WHERE doc_id = 'd_1'").get();
    expect(created).toEqual({ path: "n.md" });
    expect(store.db.prepare("SELECT block_id, text FROM blocks WHERE doc_id = 'd_1' ORDER BY ordinal").all()).toEqual([{ block_id: "b_7", text: "N" }, { block_id: "b_8", text: "Body." }]);
    expect(store.db.prepare("SELECT frontmatter_blob IS NOT NULL fm FROM revisions WHERE doc_id = 'd_1'").get()).toEqual({ fm: 1 });
  });

  it("slice 3: writing into a created document — $new.k aliased at execute, api dispositions, the file whole; a replay is path_taken", () => {
    const docStore = new (class extends NullDocStore {
      readonly files = new Map<string, string>();
      override write(path: string, bytes: string): void {
        this.files.set(path, bytes);
      }
    })();
    const plan = planEffects(store, {
      ...base(), docStore,
      effects: [
        { op: "create", path: "n.md", markdown: "# N\n\nBody.", frontmatter: { k: 1 } },
        { op: "insert", into: { kind: "section", heading_id: "$new.1" }, markdown: "Tail." },
        { op: "set", target: { kind: "block", id: "$new.2" }, field: "markdown", value: "Body, edited." },
        { op: "move", targets: [{ kind: "block", id: "b_5" }], into: { kind: "document", id: "$new.0" }, at: "start" },
      ],
    });
    expect(mintId("b")).toBe("b_6"); // nothing burned by planning
    const receipt = executePlan(store, { ...base(), docStore, plan });
    // b_7/b_8 the parse (pre-order), b_9 the insert, b_10 the update's discarded re-parse mint.
    expect(receipt.new_ids).toEqual({ "$new.0": "d_1", "$new.1": "b_7", "$new.2": "b_8", "$new.3": "b_9", "$new.4": "b_10" });
    expect(receipt.revisions.map((r) => r.id)).toEqual(["d_1", "d_0"]);
    expect(docStore.files.get("n.md")).toBe("---\nk: 1\n---\n\nTail.\n\n# N\n\nBody, edited.\n\nTail.\n");
    expect(store.db.prepare("SELECT block_id, text FROM blocks WHERE doc_id = 'd_1' AND deleted_commit IS NULL ORDER BY ordinal").all()).toEqual([
      { block_id: "b_5", text: "Tail." }, { block_id: "b_7", text: "N" }, { block_id: "b_8", text: "Body, edited." }, { block_id: "b_9", text: "Tail." },
    ]);
    // The api rule: every block of the created document is `inserted / 1 / api / null` — the moved one included.
    expect(store.db.prepare("SELECT block_id, kind, confidence, reason, matcher_v FROM dispositions WHERE commit_id = 'c_1' AND block_id IN ('b_5','b_7','b_8','b_9') ORDER BY block_id").all()).toEqual([
      { block_id: "b_5", kind: "inserted", confidence: 1, reason: "api", matcher_v: null },
      { block_id: "b_7", kind: "inserted", confidence: 1, reason: "api", matcher_v: null },
      { block_id: "b_8", kind: "inserted", confidence: 1, reason: "api", matcher_v: null },
      { block_id: "b_9", kind: "inserted", confidence: 1, reason: "api", matcher_v: null },
    ]);
    // A replay: the source document moved on (its triple is a precondition) — stale_plan first.
    expect(() => executePlan(store, { ...base(), docStore, plan })).toThrow(expect.objectContaining({ code: "stale_plan", data: expect.objectContaining({ doc: "d_0" }) }));
    // A create-only plan replayed hits the Absent guard: path_taken, nothing minted.
    const only = planEffects(store, { ...base(), docStore, effects: [{ op: "create", path: "m.md", markdown: "# M" }] });
    expect(executePlan(store, { ...base(), docStore, plan: only }).new_ids).toEqual({ "$new.0": "d_2", "$new.1": "b_11" });
    expect(() => executePlan(store, { ...base(), docStore, plan: only })).toThrow(expect.objectContaining({ code: "path_taken", data: { path: "m.md" } }));
    expect(store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 2 });
  });
});

describe("the summary and the fix (§11.9, §8; 3.3)", () => {
  const caught = (fn: () => unknown): MutationError => {
    try {
      fn();
    } catch (e) {
      if (e instanceof MutationError) return e;
      throw e;
    }
    throw new Error("expected a MutationError");
  };

  it("the summary is one line per effect, deterministic, outside the digest, and the Receipt repeats it", () => {
    const a = planEffects(store, { ...base(), effects: SLICE1 });
    const b = planEffects(store, { ...base(), effects: SLICE1 });
    expect(a.preview!.summary).toEqual(['set frontmatter.status = "active" in /a.md', 'insert 1 block at the end of section "Notes" in /a.md']);
    expect(b.preview!.summary).toEqual(a.preview!.summary);
    expect(Object.keys(planCore(a))).not.toContain("summary");
    const receipt = executePlan(store, { ...base(), plan: a });
    expect(receipt.summary).toEqual(a.preview!.summary);
    // The plan form handed back without its preview: nothing to repeat.
    const bare = planEffects(store, { ...base(), effects: [{ op: "set", target: "a.md", field: "frontmatter.k", value: 1 }] });
    const { preview: _p, ...noPreview } = bare;
    expect(executePlan(store, { ...base(), plan: noPreview }).summary).toEqual([]);
  });

  it("a stale replay and a digest mismatch carry the `apply` that re-plans: the plan's effects, or its selector form", () => {
    const plan = planEffects(store, { ...base(), effects: SLICE1 });
    executePlan(store, { ...base(), plan });
    const stale = caught(() => executePlan(store, { ...base(), plan }));
    expect(stale.code).toBe("stale_plan");
    expect(stale.data.fix).toBe(canonicalJson({ effects: plan.effects }));
    const mismatch = caught(() => executeByDigest(store, { ...base(), planId: "0".repeat(64), effects: SLICE1 }));
    expect(mismatch.code).toBe("plan_mismatch");
    expect(mismatch.data.fix).toBe(canonicalJson({ effects: SLICE1 }));
    const select = 'from docs where path == "/a.md"';
    const templates = [{ op: "set", field: "frontmatter.seen", value: true }];
    const sp = planEffects(store, { ...base(), select, effects: templates });
    executePlan(store, { ...base(), plan: sp });
    const staleSel = caught(() => executePlan(store, { ...base(), plan: sp }));
    expect(staleSel.data.fix).toBe(canonicalJson({ select, effects: templates, expect: { max: 1 } }));
    const mismatchSel = caught(() => executeByDigest(store, { ...base(), planId: "0".repeat(64), effects: templates, select, expect: { max: 3 } }));
    expect(mismatchSel.data.fix).toBe(canonicalJson({ select, effects: templates, expect: { max: 3 } }));
  });

  it("apply with select and no expect.max: the fix is the same call bounded at the selection's size", () => {
    const select = "from docs";
    const templates = [{ op: "set", field: "frontmatter.seen", value: true }];
    const e = caught(() => applyEffects(store, { ...base(), select, effects: templates }));
    expect(e.code).toBe("filter_invalid");
    expect(e.data.fix).toBe(canonicalJson({ select, effects: templates, expect: { max: 1 } }));
  });
});

describe("query-directed plans (§11.8)", () => {
  const SELECT = 'from docs where type == "note"';
  const TEMPLATES = [{ op: "set", field: "frontmatter.seen", value: true }];
  function seed(): void {
    ingestFile(store, repoId, "n/one.md", "---\ntype: note\n---\n\n# One\n");
    ingestFile(store, repoId, "n/two.md", "---\ntype: note\n---\n\n# Two\n");
  }

  it("the selection is the seventh core member: digested, admitted, replayed by the plan form, recorded in the intent", () => {
    seed();
    const plan = planEffects(store, { ...base(), select: SELECT, effects: TEMPLATES });
    expect(plan.selection).toEqual({ query: SELECT, templates: TEMPLATES, cardinality: 2, identities: ["d_1", "d_2"] });
    expect(plan.effects.map((e) => (e as { target: { id: string } }).target.id)).toEqual(["d_1", "d_2"]);
    expect(plan.plan_id).toBe(planDigest(plan));
    expect(planDigest({ ...plan, selection: undefined } as never)).not.toBe(plan.plan_id);
    // the plan form: a plan with a selection is admitted as it is; an edited selection is plan_mismatch; a malformed one filter_invalid
    expect(admitPlan(plan).plan_id).toBe(plan.plan_id);
    expect(() => admitPlan({ ...plan, selection: { ...plan.selection, identities: ["d_1"] } })).toThrow(expect.objectContaining({ code: "plan_mismatch" }));
    expect(() => admitPlan({ ...plan, selection: { query: SELECT } })).toThrow(expect.objectContaining({ code: "filter_invalid" }));
    expect(() => admitPlan({ ...plan, selection: { ...plan.selection, expect: { max: "3" } } })).toThrow(expect.objectContaining({ code: "filter_invalid" }));
    const receipt = executePlan(store, { ...base(), plan });
    expect(receipt).toMatchObject({ plan_id: plan.plan_id, commit: "c_3", revisions: [{ id: "d_1" }, { id: "d_2" }] });
    const row = store.db.prepare("SELECT ops FROM commits WHERE commit_id = 'c_3'").get() as { ops: string };
    expect(row.ops).toBe(canonicalJson({ v: 1, plan_id: plan.plan_id, effects: plan.effects, selection: plan.selection }));
  });

  it("the digest form takes select + expect: equal state commits, a vanished hit is plan_mismatch; expect rides in the digest", () => {
    seed();
    const plan = planEffects(store, { ...base(), select: SELECT, expect: { max: 5 }, effects: TEMPLATES });
    expect(plan.selection!.expect).toEqual({ max: 5 });
    expect(() => executeByDigest(store, { ...base(), planId: plan.plan_id, select: SELECT, effects: TEMPLATES })).toThrow(expect.objectContaining({ code: "plan_mismatch" }));
    expect(() => executeByDigest(store, { ...base(), planId: plan.plan_id, select: SELECT, expect: { max: 6 }, effects: TEMPLATES })).toThrow(expect.objectContaining({ code: "plan_mismatch" }));
    const r = executeByDigest(store, { ...base(), planId: plan.plan_id, select: SELECT, expect: { max: 5 }, effects: TEMPLATES });
    expect(r.commit).toBe("c_3");
    // replanned after the write: the hits are the same documents but their triples moved → the digest form is a mismatch now
    expect(() => executeByDigest(store, { ...base(), planId: plan.plan_id, select: SELECT, expect: { max: 5 }, effects: TEMPLATES })).toThrow(expect.objectContaining({ code: "plan_mismatch" }));
  });

  it("one-shot apply with select needs expect.max; a request without select is byte-identical to 3.0's", () => {
    seed();
    expect(() => applyEffects(store, { ...base(), select: SELECT, effects: TEMPLATES })).toThrow(expect.objectContaining({ code: "filter_invalid", data: expect.objectContaining({ hint: "selection" }) }));
    expect(() => planEffects(store, { ...base(), expect: { max: 1 }, effects: TEMPLATES })).toThrow(expect.objectContaining({ code: "filter_invalid", data: expect.objectContaining({ hint: "selection" }) }));
    const r = applyEffects(store, { ...base(), select: SELECT, expect: { max: 2 }, effects: TEMPLATES }) as Receipt;
    expect(r.commit).toBe("c_3");
    const plain = planEffects(store, { ...base(), effects: SLICE1 });
    expect(plain).not.toHaveProperty("selection");
    expect(canonicalJson(planCore(plain))).not.toContain("selection");
  });
});
