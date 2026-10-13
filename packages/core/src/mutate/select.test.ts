import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { print } from "@omgbase/oqx";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { setIdMinter, sequentialMinter } from "../core/ids.js";
import { oqxRun } from "../oqx-js/run.js";
import { FilterInvalid } from "../search/cel/parser.js";
import { NullDocStore } from "./doc-store.js";
import { applyEffects, executeByDigest, planEffects, type Plan, type Receipt } from "./plan.js";
import { SELECTION_CEILING, compileSelection, selectionQuery } from "./select.js";
import { MutationError } from "./tree.js";

// spec/mutate §11.8: the selector binding — the rewrite (printed), the static
// admission pass, the row → effects binding table and its typing, the
// cardinality rules, order determinism, and the cross-hit conflict semantics
// the unchanged lowering loop provides. The Rust compiler must mirror every
// rule pinned here.

let store: Store;
let repoId: string;
const docStore = new NullDocStore();
const HUB = "---\ntype: project\n---\n\n# Hub\n\n## Status\n\nNothing yet.\n";
const ALPHA = "---\ntype: workstream\nstatus: completed\nproject: hub.md\n---\n\n# Alpha\n\n- [ ] task one\n- [x] task two\n";
const BETA = "---\ntype: workstream\nstatus: completed\nproject: hub.md\n---\n\n# Beta\n\nSee [the hub](hub.md).\n";
const GAMMA = "---\ntype: workstream\nstatus: active\nproject: hub.md\n---\n\n# Gamma\n";
const COMPLETED = 'from docs where type == "workstream" and status == "completed"';
const ROLLUP = [
  { op: "insert", into: { kind: "document", path: { oqx: "project" } }, at: "end", markdown: { oqx: '"- completed: [" + title + "](" + path + ")"' } },
  { op: "set", field: "frontmatter.rolled_up", value: true },
];
const MARK = [{ op: "set", field: "frontmatter.rolled_up", value: true }];
const origin = { actor: "agent:test", reason: "test" };

function plan(select: unknown, effects: unknown, expectMax?: number): Plan {
  return planEffects(store, { repoId, docStore, select, effects, ...(expectMax !== undefined ? { expect: { max: expectMax } } : {}) });
}
function failure(fn: () => unknown): MutationError {
  try {
    fn();
  } catch (e) {
    if (e instanceof MutationError) return e;
    throw e;
  }
  throw new Error("expected a MutationError");
}
function refused(select: unknown, effects: unknown, expectMax?: number): MutationError {
  return failure(() => plan(select, effects, expectMax));
}

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  setIdMinter(sequentialMinter());
  repoId = ensureRepo(store, "t", null);
  ingestFile(store, repoId, "hub.md", HUB);
  ingestFile(store, repoId, "ws/alpha.md", ALPHA);
  ingestFile(store, repoId, "ws/beta.md", BETA);
  ingestFile(store, repoId, "ws/gamma.md", GAMMA);
});
afterEach(() => {
  setIdMinter(null);
  store.close();
});

describe("the rewrite (§11.8 step 2)", () => {
  it("appends one reserved field per slot after the user's items; the worked example prints as pinned", () => {
    expect(print(selectionQuery(COMPLETED, ROLLUP))).toBe(
      'select __omg_sel_0_into: project, __omg_sel_0_markdown: "- completed: [" + title + "](" + path + ")" from docs where type == "workstream" and status == "completed"',
    );
    // A user alias stays first, so the runner's alias resolution inlines it into the slots.
    expect(print(selectionQuery(`select hub: project ${COMPLETED}`, [{ op: "insert", into: { kind: "document", path: { oqx: "hub" } }, markdown: "x" }]))).toBe(
      `select hub: project, __omg_sel_0_into: hub ${COMPLETED}`,
    );
    // Every slot kind has its name: target/into/targets_k/at/markdown/to/path/separator/value/fm_j.
    const q = selectionQuery("from blocks", [
      { op: "move", targets: [{ kind: "block", id: { oqx: "id" } }], into: { kind: "block", id: { oqx: "doc_id" } }, at: { after: { oqx: "id" } } },
      { op: "set", target: { kind: "block", id: { oqx: "id" } }, field: "markdown", value: { oqx: "text" } },
      { op: "create", path: { oqx: "path" }, markdown: { oqx: "text" }, frontmatter: { a: 1, b: { oqx: "type" } } },
      { op: "merge", targets: [{ kind: "block", id: "b_1" }, { kind: "block", id: { oqx: "id" } }], separator: { oqx: '" "' } },
      { op: "move", target: { kind: "document", id: { oqx: "doc_id" } }, to: { oqx: "path" } },
    ]);
    expect(q.select.map((i) => i.name)).toEqual([
      "__omg_sel_0_targets_0", "__omg_sel_0_into", "__omg_sel_0_at",
      "__omg_sel_1_target", "__omg_sel_1_value",
      "__omg_sel_2_path", "__omg_sel_2_markdown", "__omg_sel_2_fm_1",
      "__omg_sel_3_targets_1", "__omg_sel_3_separator",
      "__omg_sel_4_target", "__omg_sel_4_to",
    ]);
  });

  it("a user alias is visible to the templates and the plan equals the literal form (but for the recorded selection)", () => {
    const literal = plan(COMPLETED, [{ op: "insert", into: { kind: "document", path: { oqx: "project" } }, markdown: { oqx: '"- " + title' } }]);
    const aliased = plan(`select hub: project ${COMPLETED}`, [{ op: "insert", into: { kind: "document", path: { oqx: "hub" } }, markdown: { oqx: '"- " + title' } }]);
    expect(aliased.effects).toEqual(literal.effects);
    expect(aliased.opset).toEqual(literal.opset);
    expect(aliased.plan_id).not.toBe(literal.plan_id);
    expect(aliased.selection!.query).toBe(`select hub: project ${COMPLETED}`);
  });

  it("refuses a user alias under the reserved prefixes — in a selector and on every plain query", () => {
    for (const alias of ["__omg_x", "__omg_sel_0_into", "__oqx_id"]) {
      const e = refused(`select ${alias}: 1 ${COMPLETED}`, MARK);
      expect(e.code).toBe("filter_invalid");
      expect(e.data).toMatchObject({ hint: "selection" });
      expect(e.message).toContain("reserved prefix");
      expect(() => oqxRun(store, repoId, `select ${alias}: 1 from docs`)).toThrow(FilterInvalid);
    }
    // The gap this closes: `__oqx_id` used to overwrite the hit's id.
    expect(oqxRun(store, repoId, 'select t: title from docs where type == "project"').hits[0]!.id).toBe("d_0");
  });
});

describe("static admission (§11.8 step 1)", () => {
  it.each<[string, string, unknown[], string]>([
    ["count", 'docs count { where type == "workstream" }', MARK, "yields no rows"],
    ["exists", 'docs exists { where type == "workstream" }', MARK, "yields no rows"],
    ["none", 'docs none { where type == "workstream" }', MARK, "yields no rows"],
    ["values", 'select title values from docs where type == "workstream"', MARK, "not `values`"],
    ["links", 'from links where predicate == "links_to"', MARK, "`links` rows have no effect target"],
    ["follow", 'from docs where type == "project" follow out_links collect { from dst }', MARK, "`follow` is not allowed"],
    ["body from", 'docs collect { from blocks where type == "paragraph" }', MARK, "a body `from`"],
    ["offset", `${COMPLETED} offset 1`, MARK, "`offset` is not allowed"],
    ["distinct", 'select distinct type from docs where type == "workstream"', MARK, "`distinct` is not allowed"],
    ["retarget template", COMPLETED, [{ op: "retarget", repairs: [{ from: "a.md", to: "b.md" }] }], "not row-shaped"],
    ["{ oqx } out of a slot (field)", COMPLETED, [{ op: "set", field: { oqx: '"frontmatter.x"' }, value: 1 }], "`{ oqx }` is not allowed here"],
    ["{ oqx } out of a slot (expect)", COMPLETED, [{ op: "set", field: "frontmatter.x", value: 1, expect: { revision: { oqx: "rev" } } }], "`{ oqx }` is not allowed here"],
    ["{ oqx } out of a slot (nested in a target)", COMPLETED, [{ op: "set", target: { kind: "document", id: "d_0", extra: { oqx: "x" } }, field: "frontmatter.x", value: 1 }], "`{ oqx }` is not allowed here"],
    ["both id and path as expressions", COMPLETED, [{ op: "set", target: { kind: "document", id: { oqx: "id" }, path: { oqx: "path" } }, field: "frontmatter.x", value: 1 }], "not both"],
    ["merge without targets", "from blocks", [{ op: "merge" }], "`merge` needs `targets`"],
    ["an unknown op", COMPLETED, [{ op: "frobnicate" }], "`op` must be one of"],
    ["a selector parse error", "from docs where", MARK, "select:"],
    ["an expression parse error (offset shifted back by the wrapper)", COMPLETED, [{ op: "set", field: "frontmatter.x", value: { oqx: "1 +" } }], "(at offset 4)"],
    ["a query smuggled into a slot (the wrapper's trailing `from docs` makes it a parse error)", COMPLETED, [{ op: "set", field: "frontmatter.x", value: { oqx: "title from blocks" } }], "effects[0].value:"],
    ["`$repo` (the root-row spellings are checked)", "from docs where $repo.x == 1", MARK, "select:"],
  ])("refuses %s with filter_invalid { hint: \"selection\" }", (_what, select, effects, message) => {
    const e = refused(select, effects);
    expect(e.code).toBe("filter_invalid");
    expect(e.data).toMatchObject({ hint: "selection" });
    expect(e.message).toContain(message);
  });

  it("refuses a malformed request: select, expect, templates", () => {
    expect(refused("", MARK).message).toContain("`select` must be an OQX query");
    expect(refused(COMPLETED, []).message).toContain("at least one template");
    expect(refused(COMPLETED, "nope").message).toContain("array of effect templates");
    expect(failure(() => planEffects(store, { repoId, docStore, select: COMPLETED, effects: MARK, expect: "3" })).message).toContain("`expect` must be an object");
    expect(failure(() => planEffects(store, { repoId, docStore, select: COMPLETED, effects: MARK, expect: { max: -1 } })).message).toContain("non-negative integer");
    expect(failure(() => planEffects(store, { repoId, docStore, select: COMPLETED, effects: MARK, expect: { max: 1.5 } })).message).toContain("non-negative integer");
    expect(failure(() => planEffects(store, { repoId, docStore, select: COMPLETED, effects: MARK, expect: { max: 1, min: 0 } })).message).toContain("unknown key `min`");
    expect(failure(() => planEffects(store, { repoId, docStore, effects: MARK, expect: { max: 1 } })).message).toContain("pass `select` with it");
  });

  it("the template's shape is checked with a probe in every slot — the ordinary effects[i] errors, hint arguments", () => {
    const e = refused("from nodes", [{ op: "insert", markdown: "x" }]);
    expect(e.data).toMatchObject({ hint: "arguments" });
    expect(e.message).toBe('effects[0].into: `kind` must be one of document, section, block (got "node")');
    expect(refused(COMPLETED, [{ op: "remove", targets: [] }]).message).toContain("`targets` must be a non-empty array");
    expect(refused(COMPLETED, [{ op: "set", field: "title", value: 1 }]).message).toContain("a document's `field` is `frontmatter.<key>` or `content`");
    expect(refused(COMPLETED, [{ op: "set", field: "frontmatter.x", value: 1, bogus: true }]).message).toContain("unknown key `bogus`");
    // The remove forms: `target` over docs, `targets` over blocks; a block form over docs is the kind table's refusal.
    expect(plan(COMPLETED, [{ op: "remove" }]).effects.map((e) => e.op)).toEqual(["remove", "remove"]);
    expect(refused(COMPLETED, [{ op: "remove", targets: [{ kind: "block", id: { oqx: "id" } }] }], 5).message).toContain("not found");
    // No store is read for a static refusal: an empty store refuses identically.
    const empty = new Store({ path: ":memory:" });
    const r = ensureRepo(empty, "e", null);
    expect(failure(() => planEffects(empty, { repoId: r, docStore, select: `${COMPLETED} offset 1`, effects: MARK })).message).toContain("`offset`");
    empty.close();
  });
});

describe("row → effects (§11.8 step 3)", () => {
  it("a targetless template writes to the hit by root kind: document, block, node", () => {
    expect(plan(COMPLETED, MARK).effects).toEqual([
      { op: "set", target: { kind: "document", id: "d_1", path: "ws/alpha.md" }, field: "frontmatter.rolled_up", value: true },
      { op: "set", target: { kind: "document", id: "d_2", path: "ws/beta.md" }, field: "frontmatter.rolled_up", value: true },
    ]);
    const blocks = plan('from blocks where type == "task" and attrs.checked == false', [{ op: "set", field: "attrs.checked", value: true }]);
    expect(blocks.effects).toEqual([{ op: "set", target: { kind: "block", id: "b_5" }, field: "attrs.checked", value: true }]);
    expect(blocks.opset.ops).toEqual([{ op: "update", block: "b_5", attrs: { checked: true }, expect: { content_hash: expect.any(String) } }]);
    const nodes = plan('from nodes where kind == "md:link" and value == "hub.md"', [{ op: "set", field: "value", value: "hub.md#status" }]);
    expect(nodes.effects).toEqual([{ op: "set", target: { kind: "node", id: expect.stringMatching(/^n_/) }, field: "value", value: "hub.md#status" }]);
    expect(nodes.preview!.diffs["ws/beta.md"]!.after).toContain("[the hub](hub.md#status)");
    // the lowering's own node rule still applies to a hit: no editor → node_not_editable, carrying the origin
    const inert = refused('from nodes where kind == "md:link"', [{ op: "set", field: "title", value: "x" }]);
    expect(inert.code).toBe("node_not_editable");
    expect(inert.data).toMatchObject({ effect_index: 0, template_index: 0, row: { path: "/ws/beta.md" } });
    // the block forms: `targets` defaults to [the hit]
    const moved = plan('from blocks where type == "paragraph" and text == "Nothing yet."', [{ op: "move", into: { kind: "section", heading_id: "b_1" }, at: "start" }]);
    expect(moved.effects).toEqual([{ op: "move", targets: [{ kind: "block", id: "b_2" }], into: { kind: "section", heading_id: "b_1" }, at: "start" }]);
    const removed = plan('from blocks where type == "paragraph" and text == "Nothing yet."', [{ op: "remove" }]);
    expect(removed.effects).toEqual([{ op: "remove", targets: [{ kind: "block", id: "b_2" }] }]);
  });

  it("an expression target: a string is the id/path as written, a row binds by its id, absent is target_missing, a list is ambiguous_target, anything else filter_invalid", () => {
    const byPath = plan(COMPLETED, [{ op: "insert", into: { kind: "document", path: { oqx: "project" } }, markdown: "x" }]);
    expect(byPath.effects.map((e) => (e as { into: unknown }).into)).toEqual([{ kind: "document", id: "d_0", path: "hub.md" }, { kind: "document", id: "d_0", path: "hub.md" }]);
    const byRow = plan(COMPLETED, [{ op: "insert", into: { kind: "document", path: { oqx: '^docs single { where type == "project" }' } }, markdown: "x" }]);
    expect(byRow.effects).toEqual(byPath.effects);
    const byRowId = plan(COMPLETED, [{ op: "insert", into: { kind: "document", id: { oqx: '^docs single { where type == "project" }' } }, markdown: "x" }]);
    expect(byRowId.effects).toEqual(byPath.effects);
    const byIdString = plan(COMPLETED, [{ op: "insert", into: { kind: "document", id: { oqx: '"d_0"' } }, markdown: "x" }]);
    expect(byIdString.effects).toEqual(byPath.effects);

    const missing = refused(COMPLETED, [{ op: "insert", into: { kind: "document", path: { oqx: "parent" } }, markdown: "x" }]);
    expect(missing.code).toBe("target_missing");
    expect(missing.data).toEqual({ effect_index: 0, template_index: 0, row: { id: "d_1", path: "/ws/alpha.md" }, expression: "parent" });
    const emptyList = refused(COMPLETED, [{ op: "set", target: { kind: "document", id: { oqx: '^docs collect { where type == "nope" }' } }, field: "frontmatter.x", value: 1 }]);
    expect(emptyList.code).toBe("target_missing");
    const one = refused(COMPLETED, [{ op: "set", target: { kind: "document", id: { oqx: '^docs collect { where type == "project" }' } }, field: "frontmatter.x", value: 1 }]);
    expect(one.code).toBe("ambiguous_target");
    expect(one.data).toEqual({ effect_index: 0, template_index: 0, row: { id: "d_1", path: "/ws/alpha.md" }, expression: '^docs collect { where type == "project" }', count: 1 });
    const many = refused(COMPLETED, [{ op: "set", target: { kind: "document", id: { oqx: '^docs collect { where type == "workstream" }' } }, field: "frontmatter.x", value: 1 }]);
    expect(many.data).toMatchObject({ count: 3 });
    const other = refused(COMPLETED, [{ op: "set", target: { kind: "document", id: { oqx: "1" } }, field: "frontmatter.x", value: 1 }]);
    expect(other.code).toBe("filter_invalid");
    expect(other.data).toMatchObject({ hint: "selection", effect_index: 0, template_index: 0, row: { id: "d_1", path: "/ws/alpha.md" }, expression: "1" });
    expect(other.message).toContain("not an identity");
    // Then today's resolution: a string that names nothing is doc_missing, carrying the origin.
    const gone = refused(COMPLETED, [{ op: "set", target: { kind: "document", path: { oqx: '"nowhere.md"' } }, field: "frontmatter.x", value: 1 }]);
    expect(gone.code).toBe("doc_missing");
    expect(gone.data).toMatchObject({ effect_index: 0, template_index: 0, row: { id: "d_1", path: "/ws/alpha.md" } });
    // targets[k] elements bind the same way
    const t = plan('from blocks where type == "paragraph" and text == "Nothing yet."', [{ op: "remove", targets: [{ kind: "block", id: "b_1" }, { kind: "block", id: { oqx: "id" } }] }]);
    expect((t.effects[0] as { targets: unknown[] }).targets).toEqual([{ kind: "block", id: "b_1" }, { kind: "block", id: "b_2" }]);
  });

  it("value typing: strings must be strings, `value`/frontmatter any JSON, absent refused; nothing is re-formatted", () => {
    const num = refused(COMPLETED, [{ op: "insert", into: { kind: "document", path: { oqx: "project" } }, markdown: { oqx: "1 + 1" } }]);
    expect(num.code).toBe("filter_invalid");
    expect(num.message).toContain("expected a string");
    expect(num.data).toMatchObject({ hint: "selection", effect_index: 0, template_index: 0, expression: "1 + 1" });
    const absentMd = refused(COMPLETED, [{ op: "insert", into: { kind: "document", path: { oqx: "project" } }, markdown: { oqx: "nothing" } }]);
    expect(absentMd.message).toContain("yielded absent");
    const absentValue = refused(COMPLETED, [{ op: "set", field: "frontmatter.x", value: { oqx: "nothing" } }]);
    expect(absentValue.message).toContain("use `unset`");
    // OQX's own string form rides through (`"a" + 7` is "a7"); a number value is a number; a row value is the record { id, path }.
    const p = plan(COMPLETED, [
      { op: "set", field: "frontmatter.n", value: { oqx: "1 + 1" } },
      { op: "set", field: "frontmatter.s", value: { oqx: '"a" + 7' } },
      { op: "set", field: "frontmatter.hub", value: { oqx: '^docs single { where type == "project" }' } },
      { op: "set", field: "frontmatter.list", value: { oqx: "(1, 2)" } },
    ]);
    const alpha = p.effects.slice(0, 4).map((e) => (e as { value: unknown }).value);
    expect(alpha).toEqual([2, "a7", { id: "d_0", path: "/hub.md" }, [1, 2]]);
    expect(p.opset.set_frontmatter[0]!.raw).toContain("hub:\n  id: d_0\n  path: /hub.md\n");
    // a create per hit: path/markdown/frontmatter values as expressions, a literal beside them
    const created = plan(COMPLETED, [{ op: "create", path: { oqx: '"notes/" + title.lower() + ".md"' }, markdown: { oqx: '"# Notes on " + title' }, frontmatter: { kind: "note", source: { oqx: "path" } } }]);
    expect(created.effects).toEqual([
      { op: "create", path: "notes/alpha.md", markdown: "# Notes on Alpha", frontmatter: { kind: "note", source: "/ws/alpha.md" } },
      { op: "create", path: "notes/beta.md", markdown: "# Notes on Beta", frontmatter: { kind: "note", source: "/ws/beta.md" } },
    ]);
    expect(created.preconditions.absent_paths).toEqual(["notes/alpha.md", "notes/beta.md"]);
    // the type rules of the lowering still apply to a bound value
    expect(refused('from blocks where type == "task"', [{ op: "set", field: "attrs.checked", value: { oqx: "text" } }]).message).toContain("`attrs.checked` takes a boolean value");
  });

  it("the expansion is hits × templates in result order and feeds the lowering unchanged: dedupe vs conflict across hits", () => {
    const p = plan(COMPLETED, ROLLUP);
    expect(p.effects.map((e) => e.op)).toEqual(["insert", "set", "insert", "set"]);
    expect(p.selection).toEqual({ query: COMPLETED, templates: ROLLUP, cardinality: 2, identities: ["d_1", "d_2"] });
    expect(p.preview!.diffs["hub.md"]!.after).toBe(HUB + "\n- completed: [Alpha](/ws/alpha.md)\n\n- completed: [Beta](/ws/beta.md)\n");
    // identical scalar on the shared hub → the later hit's effect is dropped with a diagnostic
    const same = plan(COMPLETED, [{ op: "set", target: { kind: "document", path: { oqx: "project" } }, field: "frontmatter.rolled_up", value: true }]);
    expect(same.effects).toHaveLength(1);
    expect(same.diagnostics).toEqual(["effect 1 (set frontmatter.rolled_up on document d_0) duplicates effect 0; dropped"]);
    // different values → conflicting_effects, naming the later effect's template and row
    const clash = refused(COMPLETED, [{ op: "set", target: { kind: "document", path: { oqx: "project" } }, field: "frontmatter.last", value: { oqx: "title" } }]);
    expect(clash.code).toBe("conflicting_effects");
    expect(clash.data).toMatchObject({ effects: [0, 1], focus: { kind: "scalar", target: { kind: "document", id: "d_0" }, field: "frontmatter.last" }, effect_index: 1, template_index: 0, row: { id: "d_2", path: "/ws/beta.md" } });
  });

  it("`order by` fixes the effect order; the default order is (path, id)", () => {
    const asc = plan(COMPLETED, [{ op: "insert", into: { kind: "document", path: { oqx: "project" } }, markdown: { oqx: '"- " + title' } }]);
    const desc = plan(`${COMPLETED} order by title desc`, [{ op: "insert", into: { kind: "document", path: { oqx: "project" } }, markdown: { oqx: '"- " + title' } }]);
    expect(asc.selection!.identities).toEqual(["d_1", "d_2"]);
    expect(desc.selection!.identities).toEqual(["d_2", "d_1"]);
    expect(asc.preview!.diffs["hub.md"]!.after.endsWith("- Alpha\n\n- Beta\n")).toBe(true);
    expect(desc.preview!.diffs["hub.md"]!.after.endsWith("- Beta\n\n- Alpha\n")).toBe(true);
    // first / single are allowed: 0–1 hits
    expect(plan(`docs first { where type == "workstream" and status == "completed" }`, MARK).selection!.identities).toEqual(["d_1"]);
    expect(plan(`docs single { where type == "project" }`, [{ op: "set", field: "frontmatter.x", value: 1 }]).selection!.cardinality).toBe(1);
    // the selector's own limit defines the set
    expect(plan(`${COMPLETED} limit 1`, MARK).selection!.identities).toEqual(["d_1"]);
  });
});

describe("cardinality (§11.8 step 2)", () => {
  it("zero hits is an empty plan whose execution commits nothing", () => {
    const p = plan('from docs where type == "nope"', MARK);
    expect(p.effects).toEqual([]);
    expect(p.opset).toEqual({ creates: [], moves: [], tombstones: [], set_frontmatter: [], ops: [] });
    expect(p.preconditions).toEqual({ docs: [], blocks: [], parents: [], absent_paths: [] });
    expect(p.selection).toEqual({ query: 'from docs where type == "nope"', templates: MARK, cardinality: 0, identities: [] });
    const r = applyEffects(store, { repoId, docStore, select: 'from docs where type == "nope"', expect: { max: 10 }, effects: MARK, origin }) as Receipt;
    expect(r).toEqual({ plan_id: expect.any(String), commit: null, revisions: [], new_ids: {}, committed: true });
    expect(store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 0 });
  });

  it("expect.max bounds the selection: equal passes, more is selection_too_large with the exact count; required on a one-shot apply", () => {
    expect(plan(COMPLETED, MARK, 2).selection).toMatchObject({ expect: { max: 2 }, cardinality: 2 });
    const e = refused(COMPLETED, MARK, 1);
    expect(e.code).toBe("selection_too_large");
    expect(e.data).toEqual({ cardinality: 2, max: 1 });
    // a bound of 0 runs with a page of 1, so the page is truncated: the ">" form
    expect(refused(COMPLETED, MARK, 0).data).toEqual({ cardinality: ">0", max: 0 });
    // a first/single selection against max 0: the exact count too
    expect(refused('docs first { where type == "project" }', MARK, 0).data).toEqual({ cardinality: 1, max: 0 });
    const noMax = failure(() => applyEffects(store, { repoId, docStore, select: COMPLETED, effects: MARK, origin }));
    expect(noMax.code).toBe("filter_invalid");
    expect(noMax.data).toMatchObject({ hint: "selection" });
    expect(noMax.message).toBe("`expect.max` is required on `apply` with `select` — bound the selection, or preview it with `plan`");
    expect(store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 0 });
    // a dry run is a plan: no bound needed
    expect((applyEffects(store, { repoId, docStore, select: COMPLETED, effects: MARK, origin, dryRun: true }) as Plan).selection!.cardinality).toBe(2);
    // the bound in the digest: two plans differing only in expect.max differ
    expect(plan(COMPLETED, MARK, 2).plan_id).not.toBe(plan(COMPLETED, MARK, 3).plan_id);
  });

  it("without expect.max the implicit ceiling applies: a selection past it is selection_too_large { implicit }", () => {
    for (let i = 0; i < SELECTION_CEILING + 1; i++) ingestFile(store, repoId, `many/${String(i).padStart(4, "0")}.md`, "---\ntype: many\n---\n\n# M\n");
    const e = refused('from docs where type == "many"', MARK);
    expect(e.code).toBe("selection_too_large");
    expect(e.data).toEqual({ cardinality: SELECTION_CEILING + 1, max: SELECTION_CEILING, implicit: true });
    expect(refused('from docs where type == "many"', MARK, SELECTION_CEILING).data).toEqual({ cardinality: SELECTION_CEILING + 1, max: SELECTION_CEILING });
    ingestFile(store, repoId, "many/9999.md", "---\ntype: many\n---\n\n# M\n");
    expect(refused('from docs where type == "many"', MARK).data).toEqual({ cardinality: `>${SELECTION_CEILING}`, max: SELECTION_CEILING, implicit: true });
    // exactly the ceiling passes
    expect(plan('from docs where type == "many" limit 1000', MARK).selection!.cardinality).toBe(SELECTION_CEILING);
  });
});

describe("execute (§11.8 step 4)", () => {
  it("the digest form re-runs the selector: equal hits commit, a new hit is plan_mismatch; the intent record carries the selection", () => {
    const p = plan(COMPLETED, MARK);
    ingestFile(store, repoId, "ws/delta.md", "---\ntype: workstream\nstatus: completed\nproject: hub.md\n---\n\n# Delta\n");
    const e = failure(() => executeByDigest(store, { repoId, docStore, planId: p.plan_id, select: COMPLETED, effects: MARK, origin }));
    expect(e.code).toBe("plan_mismatch");
    expect(e.data).toMatchObject({ expected: p.plan_id });
    const again = plan(COMPLETED, MARK);
    expect(again.selection!.identities).toEqual(["d_1", "d_2", "d_4"]);
    const r = executeByDigest(store, { repoId, docStore, planId: again.plan_id, select: COMPLETED, effects: MARK, origin });
    expect(r.commit).toBe("c_5");
    const ops = store.db.prepare("SELECT ops FROM commits WHERE commit_id = ?").pluck().get("c_5") as string;
    const intent = JSON.parse(ops) as { v: number; plan_id: string; effects: unknown[]; selection: unknown };
    expect(intent.v).toBe(1);
    expect(intent.plan_id).toBe(again.plan_id);
    expect(intent.effects).toHaveLength(3);
    expect(intent.selection).toEqual(again.selection);
  });

  it("compileSelection is the pure half: the effects, the selection and the origins", () => {
    const c = compileSelection(store, repoId, COMPLETED, undefined, ROLLUP);
    expect(c.effects).toHaveLength(4);
    expect(c.origins).toEqual([
      { template_index: 0, row: { id: "d_1", path: "/ws/alpha.md" } },
      { template_index: 1, row: { id: "d_1", path: "/ws/alpha.md" } },
      { template_index: 0, row: { id: "d_2", path: "/ws/beta.md" } },
      { template_index: 1, row: { id: "d_2", path: "/ws/beta.md" } },
    ]);
    expect(c.selection.templates).toBe(ROLLUP);
  });
});
