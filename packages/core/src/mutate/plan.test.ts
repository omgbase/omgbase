import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { setIdMinter, sequentialMinter, mintId } from "../core/ids.js";
import { sha256 } from "../core/hash.js";
import { NullDocStore } from "./doc-store.js";
import { canonicalJson, planDigest, planEffects, executePlan, executeByDigest, applyEffects, admitPlan, type Plan, type Receipt } from "./plan.js";
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

  it("planDigest covers exactly the six core keys", () => {
    const core = { version: 1 as const, planner_v: "p1", effects: [], opset: { creates: [], moves: [], tombstones: [], set_frontmatter: [], ops: [] }, preconditions: { docs: [], blocks: [], parents: [], absent_paths: [] }, new_ids: [] };
    const digest = planDigest(core);
    expect(digest).toBe("a20097a9c319b59a1313c83e1fd494bbb3cf4895040fbbddd2866e56b16cddd3");
    expect(planDigest({ ...core, plan_id: "x", diagnostics: ["d"], preview: { results: [] } } as never)).toBe(digest);
    expect(digest).toBe(sha256(canonicalJson(core)).toString("hex"));
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
    expect(receipt).toEqual({ plan_id: plan.plan_id, commit: "c_1", revisions: [{ id: "d_0", path: "a.md", hash: expect.any(String) }], new_ids: { "$new.0": "b_7" }, committed: true });
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
    expect(() => admitPlan(edited)).toThrow(expect.objectContaining({ code: "plan_mismatch", data: { expected: plan.plan_id, actual: planDigest(edited as Plan) } }));
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
    // The replay minted b_6 (the insert's paragraph) before the transaction and the
    // create's reconciling ingest b_7 inside it; both are burned (rows: none).
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
    expect(receipt.new_ids).toEqual({ "$new.0": "b_6", "$new.1": "d_1", "$new.2": "b_7" });
    expect(receipt.revisions.map((r) => [r.id, r.path])).toEqual([["d_1", "n.md"], ["d_0", "a.md"]]);
    const created = store.db.prepare("SELECT path FROM docs WHERE doc_id = 'd_1'").get();
    expect(created).toEqual({ path: "n.md" });
  });
});
