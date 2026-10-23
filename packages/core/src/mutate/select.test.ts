import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { print } from "@omgbase/oqx";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { setIdMinter, sequentialMinter } from "../core/ids.js";
import { oqxRun } from "../oqx-js/run.js";
import { FilterInvalid } from "../search/cel/parser.js";
import { NullDocStore } from "./doc-store.js";
import { admitPlan, applyEffects, executeByDigest, executePlan, planDigest, planEffects, type Plan, type Receipt } from "./plan.js";
import { SELECTION_CEILING, compileSelection, desugarEffect, selectionQuery } from "./select.js";
import { MutationError } from "./tree.js";
import { canonicalJson } from "./canonical.js";

/** The `fix` of a selection error: the same request bounded (spec/mutate §8). */
const fixOf = (select: unknown, effects: unknown, max: number): string => canonicalJson({ select, effects, expect: { max } });

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
  { op: "insert", into: { kind: "document", _path: { oqx: "project" } }, at: "end", markdown: { oqx: '"- completed: [" + _title + "](" + _path + ")"' } },
  { op: "set", field: "_frontmatter.rolled_up", value: true },
];
const MARK = [{ op: "set", field: "_frontmatter.rolled_up", value: true }];
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
      'docs { __omg_sel_0_into: project, __omg_sel_0_markdown: "- completed: [" + _title + "](" + _path + ")" where type == "workstream" and status == "completed" }',
    );
    // A user alias stays first, so the runner's alias resolution inlines it into the slots.
    expect(print(selectionQuery(`select hub: project ${COMPLETED}`, [{ op: "insert", into: { kind: "document", _path: { oqx: "hub" } }, markdown: "x" }]))).toBe(
      'docs { hub: project, __omg_sel_0_into: hub where type == "workstream" and status == "completed" }',
    );
    // Every slot kind has its name: target/into/targets_k/at/markdown/to/path/separator/value/fm_j.
    const q = selectionQuery("from blocks", [
      { op: "move", targets: [{ kind: "block", _id: { oqx: "_id" } }], into: { kind: "block", _id: { oqx: "_doc_id" } }, at: { after: { oqx: "_id" } } },
      { op: "set", target: { kind: "block", _id: { oqx: "_id" } }, field: "markdown", value: { oqx: "_text" } },
      { op: "create", path: { oqx: "_path" }, markdown: { oqx: "_text" }, frontmatter: { a: 1, b: { oqx: "_type" } } },
      { op: "merge", targets: [{ kind: "block", _id: "b_1" }, { kind: "block", _id: { oqx: "_id" } }], separator: { oqx: '" "' } },
      { op: "move", target: { kind: "document", _id: { oqx: "_doc_id" } }, to: { oqx: "_path" } },
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
    const literal = plan(COMPLETED, [{ op: "insert", into: { kind: "document", _path: { oqx: "project" } }, markdown: { oqx: '"- " + _title' } }]);
    const aliased = plan(`select hub: project ${COMPLETED}`, [{ op: "insert", into: { kind: "document", _path: { oqx: "hub" } }, markdown: { oqx: '"- " + _title' } }]);
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
    // The gap this closes: `__oqx_id` used to overwrite the hit's `_id`.
    expect(oqxRun(store, repoId, 'select t: _title from docs where type == "project"').hits[0]!._id).toBe("d_0");
  });
});

describe("static admission (§11.8 step 1)", () => {
  it.each<[string, string, unknown[], string]>([
    ["count", 'docs count { where type == "workstream" }', MARK, "yields no rows"],
    ["exists", 'docs exists { where type == "workstream" }', MARK, "yields no rows"],
    ["none", 'docs none { where type == "workstream" }', MARK, "yields no rows"],
    ["values", 'select _title values from docs where type == "workstream"', MARK, "not `values`"],
    ["links", 'from links where _predicate == "links_to"', MARK, "`links` rows have no effect target"],
    ["follow", 'from docs where type == "project" follow _out_links collect { from _dst }', MARK, "`follow` is not allowed"],
    ["body from", 'docs collect { from ^blocks where _type == "paragraph" }', MARK, "a body `from`"],
    ["offset", `${COMPLETED} offset 1`, MARK, "`offset` is not allowed"],
    ["distinct", 'select distinct type from docs where type == "workstream"', MARK, "`distinct` is not allowed"],
    ["retarget template", COMPLETED, [{ op: "retarget", repairs: [{ from: "a.md", to: "b.md" }] }], "not row-shaped"],
    ["{ oqx } out of a slot (field)", COMPLETED, [{ op: "set", field: { oqx: '"_frontmatter.x"' }, value: 1 }], "`{ oqx }` is not allowed here"],
    ["{ oqx } out of a slot (expect)", COMPLETED, [{ op: "set", field: "_frontmatter.x", value: 1, expect: { revision: { oqx: "rev" } } }], "`{ oqx }` is not allowed here"],
    ["{ oqx } out of a slot (nested in a target)", COMPLETED, [{ op: "set", target: { kind: "document", _id: "d_0", extra: { oqx: "x" } }, field: "_frontmatter.x", value: 1 }], "`{ oqx }` is not allowed here"],
    ["both _id and _path as expressions", COMPLETED, [{ op: "set", target: { kind: "document", _id: { oqx: "_id" }, _path: { oqx: "_path" } }, field: "_frontmatter.x", value: 1 }], "not both"],
    ["merge without targets", "from blocks", [{ op: "merge" }], "`merge` needs `targets`"],
    ["an unknown op", COMPLETED, [{ op: "frobnicate" }], "`op` must be one of"],
    ["a selector parse error", "from docs where", MARK, "select:"],
    ["an expression parse error (offset shifted back by the wrapper)", COMPLETED, [{ op: "set", field: "_frontmatter.x", value: { oqx: "1 +" } }], "(at offset 4)"],
    ["a query smuggled into a slot (the wrapper's body reads its `from` as a re-projection: not one expression)", COMPLETED, [{ op: "set", field: "_frontmatter.x", value: { oqx: "title from blocks" } }], "effects[0].value:"],
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
    expect(refused(COMPLETED, [{ op: "set", field: "title", value: 1 }]).message).toContain("a document's `field` is `_frontmatter.<key>` or `content`");
    expect(refused(COMPLETED, [{ op: "set", field: "_frontmatter.x", value: 1, bogus: true }]).message).toContain("unknown key `bogus`");
    // The remove forms: `target` over docs, `targets` over blocks; a block form over docs is the kind table's refusal.
    expect(plan(COMPLETED, [{ op: "remove" }]).effects.map((e) => e.op)).toEqual(["remove", "remove"]);
    expect(refused(COMPLETED, [{ op: "remove", targets: [{ kind: "block", _id: { oqx: "_id" } }] }], 5).message).toContain("not found");
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
      { op: "set", target: { kind: "document", _id: "d_1", _path: "ws/alpha.md" }, field: "_frontmatter.rolled_up", value: true },
      { op: "set", target: { kind: "document", _id: "d_2", _path: "ws/beta.md" }, field: "_frontmatter.rolled_up", value: true },
    ]);
    const blocks = plan('from blocks where _type == "task" and _attrs.checked == false', [{ op: "set", field: "_attrs.checked", value: true }]);
    expect(blocks.effects).toEqual([{ op: "set", target: { kind: "block", _id: "b_5" }, field: "_attrs.checked", value: true }]);
    expect(blocks.opset.ops).toEqual([{ op: "update", block: "b_5", attrs: { checked: true }, expect: { content_hash: expect.any(String) } }]);
    const nodes = plan('from nodes where _kind == "md:link" and _value == "hub.md"', [{ op: "set", field: "value", value: "hub.md#status" }]);
    expect(nodes.effects).toEqual([{ op: "set", target: { kind: "node", _id: expect.stringMatching(/^n_/) }, field: "value", value: "hub.md#status" }]);
    expect(nodes.preview!.diffs["ws/beta.md"]!.after).toContain("[the hub](hub.md#status)");
    // the lowering's own node rule still applies to a hit: no editor → node_not_editable, carrying the origin
    const inert = refused('from nodes where _kind == "md:link"', [{ op: "set", field: "title", value: "x" }]);
    expect(inert.code).toBe("node_not_editable");
    expect(inert.data).toMatchObject({ effect_index: 0, template_index: 0, row: { _path: "/ws/beta.md" } });
    // the block forms: `targets` defaults to [the hit]
    const moved = plan('from blocks where _type == "paragraph" and _text == "Nothing yet."', [{ op: "move", into: { kind: "section", heading_id: "b_1" }, at: "start" }]);
    expect(moved.effects).toEqual([{ op: "move", targets: [{ kind: "block", _id: "b_2" }], into: { kind: "section", heading_id: "b_1" }, at: "start" }]);
    const removed = plan('from blocks where _type == "paragraph" and _text == "Nothing yet."', [{ op: "remove" }]);
    expect(removed.effects).toEqual([{ op: "remove", targets: [{ kind: "block", _id: "b_2" }] }]);
  });

  it("an expression target: a string is the `_id`/`_path` as written, a row binds by its id, absent is target_missing, a list is ambiguous_target, anything else filter_invalid", () => {
    const byPath = plan(COMPLETED, [{ op: "insert", into: { kind: "document", _path: { oqx: "project" } }, markdown: "x" }]);
    expect(byPath.effects.map((e) => (e as { into: unknown }).into)).toEqual([{ kind: "document", _id: "d_0", _path: "hub.md" }, { kind: "document", _id: "d_0", _path: "hub.md" }]);
    const byRow = plan(COMPLETED, [{ op: "insert", into: { kind: "document", _path: { oqx: '^docs single { where type == "project" }' } }, markdown: "x" }]);
    expect(byRow.effects).toEqual(byPath.effects);
    const byRowId = plan(COMPLETED, [{ op: "insert", into: { kind: "document", _id: { oqx: '^docs single { where type == "project" }' } }, markdown: "x" }]);
    expect(byRowId.effects).toEqual(byPath.effects);
    const byIdString = plan(COMPLETED, [{ op: "insert", into: { kind: "document", _id: { oqx: '"d_0"' } }, markdown: "x" }]);
    expect(byIdString.effects).toEqual(byPath.effects);

    const missing = refused(COMPLETED, [{ op: "insert", into: { kind: "document", _path: { oqx: "parent" } }, markdown: "x" }]);
    expect(missing.code).toBe("target_missing");
    expect(missing.data).toEqual({ effect_index: 0, template_index: 0, row: { _id: "d_1", _path: "/ws/alpha.md" }, expression: "parent" });
    const emptyList = refused(COMPLETED, [{ op: "set", target: { kind: "document", _id: { oqx: '^docs collect { where type == "nope" }' } }, field: "_frontmatter.x", value: 1 }]);
    expect(emptyList.code).toBe("target_missing");
    const one = refused(COMPLETED, [{ op: "set", target: { kind: "document", _id: { oqx: '^docs collect { where type == "project" }' } }, field: "_frontmatter.x", value: 1 }]);
    expect(one.code).toBe("ambiguous_target");
    expect(one.data).toEqual({
      effect_index: 0, template_index: 0, row: { _id: "d_1", _path: "/ws/alpha.md" }, expression: '^docs collect { where type == "project" }', count: 1,
      // (3.3) the fix: the slot spelled as the first identity, the selector narrowed to the hit
      fix: '{"effects":[{"field":"_frontmatter.x","op":"set","target":{"_id":"d_0","kind":"document"},"value":1}],"expect":{"max":1},"select":"from docs where _id == \\"d_1\\""}',
    });
    const many = refused(COMPLETED, [{ op: "set", target: { kind: "document", _id: { oqx: '^docs collect { where type == "workstream" }' } }, field: "_frontmatter.x", value: 1 }]);
    expect(many.data).toMatchObject({ count: 3 });
    const other = refused(COMPLETED, [{ op: "set", target: { kind: "document", _id: { oqx: "1" } }, field: "_frontmatter.x", value: 1 }]);
    expect(other.code).toBe("filter_invalid");
    expect(other.data).toMatchObject({ hint: "selection", effect_index: 0, template_index: 0, row: { _id: "d_1", _path: "/ws/alpha.md" }, expression: "1" });
    expect(other.message).toContain("not an identity");
    // Then today's resolution: a string that names nothing is doc_missing, carrying the origin.
    const gone = refused(COMPLETED, [{ op: "set", target: { kind: "document", _path: { oqx: '"nowhere.md"' } }, field: "_frontmatter.x", value: 1 }]);
    expect(gone.code).toBe("doc_missing");
    expect(gone.data).toMatchObject({ effect_index: 0, template_index: 0, row: { _id: "d_1", _path: "/ws/alpha.md" } });
    // targets[k] elements bind the same way
    const t = plan('from blocks where _type == "paragraph" and _text == "Nothing yet."', [{ op: "remove", targets: [{ kind: "block", _id: "b_1" }, { kind: "block", _id: { oqx: "_id" } }] }]);
    expect((t.effects[0] as { targets: unknown[] }).targets).toEqual([{ kind: "block", _id: "b_1" }, { kind: "block", _id: "b_2" }]);
  });

  it("value typing: strings must be strings, `value`/frontmatter any JSON, absent refused; nothing is re-formatted", () => {
    const num = refused(COMPLETED, [{ op: "insert", into: { kind: "document", _path: { oqx: "project" } }, markdown: { oqx: "1 + 1" } }]);
    expect(num.code).toBe("filter_invalid");
    expect(num.message).toContain("expected a string");
    expect(num.data).toMatchObject({ hint: "selection", effect_index: 0, template_index: 0, expression: "1 + 1" });
    const absentMd = refused(COMPLETED, [{ op: "insert", into: { kind: "document", _path: { oqx: "project" } }, markdown: { oqx: "nothing" } }]);
    expect(absentMd.message).toContain("yielded absent");
    const absentValue = refused(COMPLETED, [{ op: "set", field: "_frontmatter.x", value: { oqx: "nothing" } }]);
    expect(absentValue.message).toContain("use `unset`");
    // OQX's own string form rides through (`"a" + 7` is "a7"); a number value is a number; a row value is the record { _id, _path }.
    const p = plan(COMPLETED, [
      { op: "set", field: "_frontmatter.n", value: { oqx: "1 + 1" } },
      { op: "set", field: "_frontmatter.s", value: { oqx: '"a" + 7' } },
      { op: "set", field: "_frontmatter.hub", value: { oqx: '^docs single { where type == "project" }' } },
      { op: "set", field: "_frontmatter.list", value: { oqx: "(1, 2)" } },
    ]);
    const alpha = p.effects.slice(0, 4).map((e) => (e as { value: unknown }).value);
    expect(alpha).toEqual([2, "a7", { _id: "d_0", _path: "/hub.md" }, [1, 2]]);
    expect(p.opset.set_frontmatter[0]!.raw).toContain("hub:\n  _id: d_0\n  _path: /hub.md\n");
    // a create per hit: path/markdown/frontmatter values as expressions, a literal beside them
    const created = plan(COMPLETED, [{ op: "create", path: { oqx: '"notes/" + _title.lower() + ".md"' }, markdown: { oqx: '"# Notes on " + _title' }, frontmatter: { kind: "note", source: { oqx: "_path" } } }]);
    expect(created.effects).toEqual([
      { op: "create", path: "notes/alpha.md", markdown: "# Notes on Alpha", frontmatter: { kind: "note", source: "/ws/alpha.md" } },
      { op: "create", path: "notes/beta.md", markdown: "# Notes on Beta", frontmatter: { kind: "note", source: "/ws/beta.md" } },
    ]);
    expect(created.preconditions.absent_paths).toEqual(["notes/alpha.md", "notes/beta.md"]);
    // the type rules of the lowering still apply to a bound value
    expect(refused('from blocks where _type == "task"', [{ op: "set", field: "_attrs.checked", value: { oqx: "_text" } }]).message).toContain("`_attrs.checked` takes a boolean value");
  });

  it("the expansion is hits × templates in result order and feeds the lowering unchanged: dedupe vs conflict across hits", () => {
    const p = plan(COMPLETED, ROLLUP);
    expect(p.effects.map((e) => e.op)).toEqual(["insert", "set", "insert", "set"]);
    expect(p.selection).toEqual({ query: COMPLETED, templates: ROLLUP, cardinality: 2, identities: ["d_1", "d_2"] });
    expect(p.preview!.diffs["hub.md"]!.after).toBe(HUB + "\n- completed: [Alpha](/ws/alpha.md)\n\n- completed: [Beta](/ws/beta.md)\n");
    // identical scalar on the shared hub → the later hit's effect is dropped with a diagnostic
    const same = plan(COMPLETED, [{ op: "set", target: { kind: "document", _path: { oqx: "project" } }, field: "_frontmatter.rolled_up", value: true }]);
    expect(same.effects).toHaveLength(1);
    expect(same.diagnostics).toEqual(["effect 1 (set _frontmatter.rolled_up on document d_0) duplicates effect 0; dropped"]);
    // different values → conflicting_effects, naming the later effect's template and row
    const clash = refused(COMPLETED, [{ op: "set", target: { kind: "document", _path: { oqx: "project" } }, field: "_frontmatter.last", value: { oqx: "_title" } }]);
    expect(clash.code).toBe("conflicting_effects");
    expect(clash.data).toMatchObject({ effects: [0, 1], focus: { kind: "scalar", target: { kind: "document", _id: "d_0" }, field: "_frontmatter.last" }, effect_index: 1, template_index: 0, row: { _id: "d_2", _path: "/ws/beta.md" } });
  });

  it("`order by` fixes the effect order; the default order is (path, id)", () => {
    const asc = plan(COMPLETED, [{ op: "insert", into: { kind: "document", _path: { oqx: "project" } }, markdown: { oqx: '"- " + _title' } }]);
    const desc = plan(`${COMPLETED} order by _title desc`, [{ op: "insert", into: { kind: "document", _path: { oqx: "project" } }, markdown: { oqx: '"- " + _title' } }]);
    expect(asc.selection!.identities).toEqual(["d_1", "d_2"]);
    expect(desc.selection!.identities).toEqual(["d_2", "d_1"]);
    expect(asc.preview!.diffs["hub.md"]!.after.endsWith("- Alpha\n\n- Beta\n")).toBe(true);
    expect(desc.preview!.diffs["hub.md"]!.after.endsWith("- Beta\n\n- Alpha\n")).toBe(true);
    // first / single are allowed: 0–1 hits
    expect(plan(`docs first { where type == "workstream" and status == "completed" }`, MARK).selection!.identities).toEqual(["d_1"]);
    expect(plan(`docs single { where type == "project" }`, [{ op: "set", field: "_frontmatter.x", value: 1 }]).selection!.cardinality).toBe(1);
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
    expect(r).toEqual({ plan_id: expect.any(String), commit: null, revisions: [], new_ids: {}, committed: true, summary: [] });
    expect(store.db.prepare("SELECT count(*) n FROM commits WHERE origin = 'api'").get()).toEqual({ n: 0 });
  });

  it("expect.max bounds the selection: equal passes, more is selection_too_large with the exact count; required on a one-shot apply", () => {
    expect(plan(COMPLETED, MARK, 2).selection).toMatchObject({ expect: { max: 2 }, cardinality: 2 });
    const e = refused(COMPLETED, MARK, 1);
    expect(e.code).toBe("selection_too_large");
    expect(e.data).toEqual({ cardinality: 2, max: 1, fix: fixOf(COMPLETED, MARK, 2) });
    // a bound of 0 runs with a page of 1, so the page is truncated: the ">" form (the fix counts the selection again, unbounded)
    expect(refused(COMPLETED, MARK, 0).data).toEqual({ cardinality: ">0", max: 0, fix: fixOf(COMPLETED, MARK, 2) });
    // a first/single selection against max 0: the exact count too
    expect(refused('docs first { where type == "project" }', MARK, 0).data).toEqual({ cardinality: 1, max: 0, fix: fixOf('docs first { where type == "project" }', MARK, 1) });
    const noMax = failure(() => applyEffects(store, { repoId, docStore, select: COMPLETED, effects: MARK, origin }));
    expect(noMax.code).toBe("filter_invalid");
    expect(noMax.data).toMatchObject({ hint: "selection", fix: fixOf(COMPLETED, MARK, 2) });
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
    const many = 'from docs where type == "many"';
    expect(e.data).toEqual({ cardinality: SELECTION_CEILING + 1, max: SELECTION_CEILING, implicit: true, fix: fixOf(many, MARK, SELECTION_CEILING + 1) });
    expect(refused(many, MARK, SELECTION_CEILING).data).toEqual({ cardinality: SELECTION_CEILING + 1, max: SELECTION_CEILING, fix: fixOf(many, MARK, SELECTION_CEILING + 1) });
    ingestFile(store, repoId, "many/9999.md", "---\ntype: many\n---\n\n# M\n");
    expect(refused(many, MARK).data).toEqual({ cardinality: `>${SELECTION_CEILING}`, max: SELECTION_CEILING, implicit: true, fix: fixOf(many, MARK, SELECTION_CEILING + 2) });
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
      { template_index: 0, row: { _id: "d_1", _path: "/ws/alpha.md" } },
      { template_index: 1, row: { _id: "d_1", _path: "/ws/alpha.md" } },
      { template_index: 0, row: { _id: "d_2", _path: "/ws/beta.md" } },
      { template_index: 1, row: { _id: "d_2", _path: "/ws/beta.md" } },
    ]);
    expect(c.selection.templates).toBe(ROLLUP);
  });
});

describe("the `-> ` sugar (§11.8 Sugar, 3.2)", () => {
  const insert = (into: unknown, markdown: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ op: "insert", into, markdown, ...extra });
  const planPlain = (effects: unknown): Plan => planEffects(store, { repoId, docStore, effects });
  const refusedPlain = (effects: unknown): MutationError => failure(() => planPlain(effects));

  describe("desugarEffect (the leader rule)", () => {
    it("exactly `-> ` opens an expression; `->x`, ` -> x`, `-->`, a mid-string `-> ` and `${` are literal", () => {
      expect(desugarEffect(insert("hub.md", "-> _title"), 0)).toEqual(insert("hub.md", { oqx: "_title" }));
      for (const literal of ["->x", " -> x", "--> x", "see -> there", "Costs: ${HOME}", "->", "- > x"]) {
        expect(desugarEffect(insert("hub.md", literal), 0)).toEqual(insert("hub.md", literal));
      }
    });

    it("folds a bare string literal and an interpolation-free template literal; `-> \"-> note\"` spells a literal that begins with the leader", () => {
      expect(desugarEffect(insert("hub.md", '-> "Hello"'), 0)).toEqual(insert("hub.md", "Hello"));
      expect(desugarEffect(insert("hub.md", "-> `Hello`"), 0)).toEqual(insert("hub.md", "Hello"));
      expect(desugarEffect(insert("hub.md", '-> "-> note"'), 0)).toEqual(insert("hub.md", "-> note"));
      expect(desugarEffect(insert("hub.md", "-> `a\\n${_title}`"), 0)).toEqual(insert("hub.md", { oqx: "`a\\n${_title}`" }));
      expect(desugarEffect(insert("hub.md", "-> 1 + 1"), 0)).toEqual(insert("hub.md", { oqx: "1 + 1" }));
      // a folded target stays a bare string for the shape check; an unfolded one is the whole-target directive
      expect(desugarEffect(insert('-> "hub.md"', "x"), 0)).toEqual(insert("hub.md", "x"));
      expect(desugarEffect(insert("-> project", "x"), 0)).toEqual(insert({ oqx: "project" }, "x"));
    });

    it("desugars every slot of the §11.8 table and nothing else", () => {
      expect(desugarEffect({ op: "create", path: "-> p", markdown: "-> m", frontmatter: { a: "-> x", b: { nested: "-> data" } } }, 0)).toEqual(
        { op: "create", path: { oqx: "p" }, markdown: { oqx: "m" }, frontmatter: { a: { oqx: "x" }, b: { nested: "-> data" } } },
      );
      expect(desugarEffect({ op: "insert", into: { kind: "document", _path: "-> project" }, at: { after: "-> _id" }, markdown: "x" }, 0)).toEqual(
        { op: "insert", into: { kind: "document", _path: { oqx: "project" } }, at: { after: { oqx: "_id" } }, markdown: "x" },
      );
      expect(desugarEffect({ op: "set", target: "-> _id", field: "_frontmatter.k", value: "-> n + 1" }, 0)).toEqual({ op: "set", target: { oqx: "_id" }, field: "_frontmatter.k", value: { oqx: "n + 1" } });
      expect(desugarEffect({ op: "set", target: "d_0", field: "_frontmatter.k", value: { note: "-> data" } }, 0)).toEqual({ op: "set", target: "d_0", field: "_frontmatter.k", value: { note: "-> data" } });
      expect(desugarEffect({ op: "move", targets: ["-> _id", { kind: "block", _id: "-> _id" }], into: "-> _doc_id", at: { before: "-> _id" } }, 0)).toEqual(
        { op: "move", targets: [{ oqx: "_id" }, { kind: "block", _id: { oqx: "_id" } }], into: { oqx: "_doc_id" }, at: { before: { oqx: "_id" } } },
      );
      expect(desugarEffect({ op: "move", target: "-> _id", to: "-> _path" }, 0)).toEqual({ op: "move", target: { oqx: "_id" }, to: { oqx: "_path" } });
      expect(desugarEffect({ op: "merge", targets: ["b_1", "-> _id"], separator: '-> " "' }, 0)).toEqual({ op: "merge", targets: ["b_1", { oqx: "_id" }], separator: " " });
      // not an effect object / an unknown op: untouched, the shape check names it
      expect(desugarEffect("nope", 0)).toBe("nope");
      expect(desugarEffect({ op: "zap", x: "-> y" }, 0)).toEqual({ op: "zap", x: "-> y" });
    });

    it.each<[string, Record<string, unknown>, string]>([
      ["field", { op: "set", target: "d_0", field: '-> "_frontmatter.x"', value: 1 }, "effects[0].field: `-> ` is not allowed here"],
      ["expect.revision", { op: "insert", into: "d_0", markdown: "x", expect: { revision: "-> rev" } }, "effects[0].expect.revision: `-> `"],
      ["a section's heading_id", { op: "insert", into: { kind: "section", heading_id: "-> _id" }, markdown: "x" }, "effects[0].into.heading_id: `-> `"],
      ["a whole `at`", { op: "insert", into: "d_0", at: "-> x", markdown: "x" }, "effects[0].at: `-> `"],
      ["split.at", { op: "split", target: "b_1", at: ["-> 3"] }, "effects[0].at[0]: `-> `"],
      ["retarget.repairs", { op: "retarget", repairs: [{ from: "-> a", to: "b" }] }, "effects[0].repairs[0].from: `-> `"],
      ["a targets[k] member beside _id", { op: "remove", targets: [{ kind: "block", _id: "b_1", extra: "-> x" }] }, "effects[0].targets[0].extra: `-> `"],
    ])("refuses the leader in a slot that takes no expression: %s", (_what, effect, message) => {
      const e = failure(() => desugarEffect(effect, 0));
      expect(e.code).toBe("filter_invalid");
      expect(e.data).toMatchObject({ hint: "selection" });
      expect(e.message).toContain(message);
    });

    it("a leader whose expression does not parse is filter_invalid with the offset counted from the written string", () => {
      const e = failure(() => desugarEffect(insert("hub.md", "-> 1 +"), 2));
      expect(e.code).toBe("filter_invalid");
      expect(e.data).toMatchObject({ hint: "selection" });
      expect(e.message).toContain("effects[2].markdown:");
      expect(e.message).toContain("(at offset 7)"); // "-> 1 +" — the error at the end of the 7-char string
      // a query smuggled into the leader: the wrapper's body reads its `from` as a re-projection, so it is not one expression — as for `{ oqx }`
      expect(failure(() => desugarEffect(insert("hub.md", "-> _title from blocks"), 0)).message).toContain("effects[0].markdown: `oqx` must be one expression over the hit, not a query");
    });
  });

  describe("bare targets", () => {
    it("a path-looking string is a document, an id its kind, `$new.n` the symbol table's kind; a locator and anything else are refused", () => {
      const p = planPlain([
        insert("ws/alpha.md", "A"),
        insert("/hub.md", "H"),
        insert("d_2", "B"),
        { op: "set", target: "b_5", field: "_attrs.checked", value: true },
        { op: "remove", targets: ["b_8"] },
      ]);
      expect(p.effects.map((e) => ("into" in e ? e.into : "target" in e ? e.target : (e as { targets: unknown[] }).targets))).toEqual([
        { kind: "document", _id: "d_1", _path: "ws/alpha.md" },
        { kind: "document", _id: "d_0", _path: "hub.md" },
        { kind: "document", _id: "d_2", _path: "ws/beta.md" },
        { kind: "block", _id: "b_5" },
        [{ kind: "block", _id: "b_8" }],
      ]);
      expect(p).not.toHaveProperty("templates");
      const nodeId = (oqxRun(store, repoId, 'from nodes where _kind == "md:link"').hits[0] as { _id: string })._id;
      expect(planPlain([{ op: "set", target: nodeId, field: "value", value: "hub.md#status" }]).effects[0]).toMatchObject({ target: { kind: "node", _id: nodeId } });
      // the bare form and the object form plan identically
      expect(planPlain([insert("ws/alpha.md", "A")]).plan_id).toBe(planPlain([insert({ kind: "document", _path: "ws/alpha.md" }, "A")]).plan_id);
      // the op's kind table still applies
      expect(refusedPlain([{ op: "split", target: "d_0", at: [1] }]).message).toBe('effects[0].target: `kind` must be one of block (got "document")');
      expect(refusedPlain([{ op: "remove", targets: ["ws/alpha.md"] }]).message).toBe('effects[0].targets[0]: `kind` must be one of block (got "document")');
      const locator = refusedPlain([insert("hub.md#Status", "x")]);
      expect(locator.code).toBe("filter_invalid");
      expect(locator.data).toMatchObject({ hint: "arguments", fix: expect.stringContaining("blocks_resolve") });
      expect(locator.message).toContain("is a locator, not a target");
      expect(refusedPlain([insert("hello", "x")]).message).toContain('a target is { kind: …, … } or a bare document path, a `b_`/`d_`/`n_` id or `$new.n` (got "hello")');
      expect(refusedPlain([insert("c_0", "x")]).message).toContain("(got \"c_0\")");
    });

    it("`$new.n` takes the kind the symbol table recorded when the effect is resolved", () => {
      const p = planPlain([
        { op: "create", path: "n.md", markdown: "# N\n\nBody." },
        insert("$new.0", "Tail."),
        { op: "set", target: "$new.2", field: "markdown", value: "Body, edited." },
        { op: "set", target: "$new.0", field: "_frontmatter.k", value: 1 },
        { op: "remove", targets: ["$new.1"] },
      ]);
      expect(p.effects.map((e) => ("into" in e ? e.into : "target" in e ? e.target : (e as { targets: unknown[] }).targets))).toEqual([
        undefined,
        { kind: "document", _id: "$new.0", _path: "n.md" },
        { kind: "block", _id: "$new.2" },
        { kind: "document", _id: "$new.0", _path: "n.md" },
        [{ kind: "block", _id: "$new.1" }],
      ]);
      expect(p.plan_id).toBe(planPlain([
        { op: "create", path: "n.md", markdown: "# N\n\nBody." },
        insert({ kind: "document", _id: "$new.0" }, "Tail."),
        { op: "set", target: { kind: "block", _id: "$new.2" }, field: "markdown", value: "Body, edited." },
        { op: "set", target: { kind: "document", _id: "$new.0" }, field: "_frontmatter.k", value: 1 },
        { op: "remove", targets: [{ kind: "block", _id: "$new.1" }] },
      ]).plan_id);
      // the slot's kind table applies to the recorded kind; a symbol nothing created is target_missing; the field rule follows the kind
      expect(refusedPlain([{ op: "create", path: "n.md", markdown: "# N" }, { op: "unset", target: "$new.1", field: "_frontmatter.k" }])).toMatchObject({ code: "filter_invalid", message: 'effects[1].target: `kind` must be one of document (got "block")' });
      expect(refusedPlain([insert("$new.0", "x")])).toMatchObject({ code: "target_missing", data: { symbol: "$new.0", effect_index: 0 } });
      expect(refusedPlain([{ op: "create", path: "n.md", markdown: "# N" }, { op: "set", target: "$new.1", field: "_frontmatter.k", value: 1 }]).message).toContain("a block's `field` is `markdown` or `_attrs.checked`");
      expect(refusedPlain([{ op: "create", path: "n.md", markdown: "# N" }, { op: "set", target: "$new.0", field: "markdown", value: "x" }]).message).toContain("a document's `field` is `_frontmatter.<key>` or `content`");
    });
  });

  describe("with a selector", () => {
    it("`into: \"-> project\"` is the worked example; a template literal builds the markdown; the plan is the `{ oqx }` plan but for the recorded templates", () => {
      const sugar = plan(COMPLETED, [insert("-> project", "-> `- completed: [${_title}](${_path})`", { at: "end" }), { op: "set", field: "_frontmatter.rolled_up", value: true }]);
      const spelled = plan(COMPLETED, ROLLUP);
      expect(sugar.effects).toEqual(spelled.effects);
      expect(sugar.opset).toEqual(spelled.opset);
      expect(sugar.plan_id).not.toBe(spelled.plan_id);
      expect(sugar.selection!.templates[0]).toEqual(insert("-> project", "-> `- completed: [${_title}](${_path})`", { at: "end" }));
      expect(sugar).not.toHaveProperty("templates");
      expect(print(selectionQuery(COMPLETED, sugar.selection!.templates))).toBe(
        "docs { __omg_sel_0_into: project, __omg_sel_0_markdown: `- completed: [${_title}](${_path})` where type == \"workstream\" and status == \"completed\" }",
      );
    });

    it("a whole-target expression binds the identity the value names: a row by its id's prefix, a path string as a document, an id string as its kind", () => {
      const byRow = plan(COMPLETED, [insert('-> ^docs single { where type == "project" }', "x")]);
      expect(byRow.effects.map((e) => (e as { into: unknown }).into)).toEqual([{ kind: "document", _id: "d_0", _path: "hub.md" }, { kind: "document", _id: "d_0", _path: "hub.md" }]);
      expect(plan(COMPLETED, [insert("-> project", "x")]).effects).toEqual(byRow.effects);
      expect(plan(COMPLETED, [insert('-> "d_0"', "x")]).effects).toEqual(byRow.effects);
      const block = plan('from blocks where _type == "paragraph" and _text == "Nothing yet."', [{ op: "move", targets: ["-> _id"], into: "-> _doc_id", at: "start" }]);
      expect(block.effects).toEqual([{ op: "move", targets: [{ kind: "block", _id: "b_2" }], into: { kind: "document", _id: "d_0", _path: "hub.md" }, at: "start" }]);
      // the op's kind table applies to the bound kind
      const wrong = refused(COMPLETED, [{ op: "split", target: "-> _id", at: [1] }]);
      expect(wrong.data).toMatchObject({ hint: "arguments" });
      expect(wrong.message).toBe('effects[0].target: `kind` must be one of block (got "document")');
      // a value that names no identity
      expect(refused(COMPLETED, [insert("-> parent", "x")])).toMatchObject({ code: "target_missing", data: { effect_index: 0, template_index: 0, row: { _id: "d_1", _path: "/ws/alpha.md" }, expression: "parent" } });
      expect(refused(COMPLETED, [insert('-> ^docs collect { where type == "workstream" }', "x")])).toMatchObject({ code: "ambiguous_target", data: { count: 3 } });
      expect(refused(COMPLETED, [insert("-> _title", "x")]).message).toContain("not an identity (a document path, an id or a row)");
      expect(refused(COMPLETED, [insert("-> 1", "x")]).message).toContain("not an identity (a string or a row)");
    });

    it("a typed value: `-> priority + 1` is a number; `value: \"-> \\\"x\\\"\"` folds to the string", () => {
      ingestFile(store, repoId, "ws/delta.md", "---\ntype: workstream\nstatus: completed\nproject: hub.md\npriority: 2\n---\n\n# Delta\n");
      const p = plan('from docs where type == "workstream" and priority != null', [{ op: "set", field: "_frontmatter.priority", value: "-> priority + 1" }, { op: "set", field: "_frontmatter.note", value: '-> "x"' }]);
      expect(p.effects.map((e) => (e as { value: unknown }).value)).toEqual([3, "x"]);
      expect(p.opset.set_frontmatter[0]!.raw).toContain("priority: 3\nnote: x\n");
    });

    it("constant folding: `-> \"x\"`, `-> `x`` and `\"x\"` plan to one plan_id (but for the recorded templates, which are as written)", () => {
      const a = plan(COMPLETED, [{ op: "set", field: "_frontmatter.note", value: '-> "x"' }]);
      const b = plan(COMPLETED, [{ op: "set", field: "_frontmatter.note", value: "-> `x`" }]);
      const c = plan(COMPLETED, [{ op: "set", field: "_frontmatter.note", value: "x" }]);
      expect(a.effects).toEqual(c.effects);
      expect(b.effects).toEqual(c.effects);
      expect(a.opset).toEqual(c.opset);
      expect(print(selectionQuery(COMPLETED, a.selection!.templates))).toBe('docs { where type == "workstream" and status == "completed" }'); // no slot item: nothing to evaluate
    });
  });

  describe("without a selector", () => {
    it("a `-> ` slot on a plain effect evaluates in its own target's row; the plan carries `templates` (as written), the core is the literal plan's", () => {
      const p = planPlain([insert("ws/alpha.md", "-> `## ${_title}`")]);
      expect(p.effects).toEqual([{ op: "insert", into: { kind: "document", _id: "d_1", _path: "ws/alpha.md" }, at: "end", markdown: "## Alpha" }]);
      expect(p.templates).toEqual([insert("ws/alpha.md", "-> `## ${_title}`")]);
      expect(p).not.toHaveProperty("selection");
      const literal = planPlain([insert("ws/alpha.md", "## Alpha")]);
      expect(p.plan_id).toBe(literal.plan_id);
      expect(planDigest(p)).toBe(p.plan_id); // `templates` is not digested
      expect(literal).not.toHaveProperty("templates");
      // `{ oqx }` spelled out is the same request
      expect(planPlain([insert("ws/alpha.md", { oqx: "`## ${_title}`" })]).plan_id).toBe(p.plan_id);
    });

    it("the scope is the primary target's row: a document, a block (`into` a block or section, a `set` target), a node", () => {
      const block = planPlain([{ op: "set", target: "b_2", field: "markdown", value: "-> `${_text} (archived)`" }]);
      expect(block.effects[0]).toMatchObject({ value: "Nothing yet. (archived)" });
      const section = planPlain([insert({ kind: "section", heading_id: "b_1" }, "-> `Under ${_text}`")]);
      expect(section.effects[0]).toMatchObject({ markdown: "Under Status" });
      const nodeId = (oqxRun(store, repoId, 'from nodes where _kind == "md:link"').hits[0] as { _id: string })._id;
      const node = planPlain([{ op: "set", target: nodeId, field: "value", value: "-> _value + \"#status\"" }]);
      expect(node.effects[0]).toMatchObject({ value: "hub.md#status" });
      // a block form: targets[0] is the scope; `into` and `at` may be expressions over it
      const moved = planPlain([{ op: "move", targets: ["b_2"], into: "-> _doc_id", at: "start" }]);
      expect(moved.effects[0]).toEqual({ op: "move", targets: [{ kind: "block", _id: "b_2" }], into: { kind: "document", _id: "d_0", _path: "hub.md" }, at: "start" });
    });

    it("effects on several targets run one synthetic query per target identity; a binding error names the effect and its row (no template)", () => {
      const p = planPlain([
        insert("ws/alpha.md", "-> `Summary of ${_title}`"),
        insert("ws/beta.md", "-> `Summary of ${_title}`"),
        insert("ws/alpha.md", "-> `Again ${_title}`"),
        { op: "set", target: "ws/gamma.md", field: "_frontmatter.seen", value: true },
      ]);
      expect(p.effects.map((e) => ("markdown" in e ? e.markdown : e.op))).toEqual(["Summary of Alpha", "Summary of Beta", "Again Alpha", "set"]);
      expect(p.templates).toHaveLength(4);
      const r = applyEffects(store, { repoId, docStore, effects: p.templates, origin }) as Receipt;
      expect(r.plan_id).toBe(p.plan_id);
      const ops = store.db.prepare("SELECT ops FROM commits WHERE commit_id = ?").pluck().get(r.commit) as string;
      const intent = JSON.parse(ops) as { effects: unknown[]; templates: unknown[]; selection?: unknown };
      expect(intent.templates).toEqual(p.templates);
      expect(intent.effects).toEqual(p.effects);
      expect(intent.selection).toBeUndefined();
      const absent = refusedPlain([insert("ws/alpha.md", "-> nothing")]);
      expect(absent.code).toBe("filter_invalid");
      expect(absent.data).toEqual({ reason: absent.message, hint: "selection", effect_index: 0, row: { _id: "d_1", _path: "/ws/alpha.md" }, expression: "nothing" });
      expect(absent.data).not.toHaveProperty("template_index");
    });

    it("refuses what has no row: a `create`, an expression as the primary target, a `$new.n` scope", () => {
      const create = refusedPlain([{ op: "create", path: "n.md", markdown: "-> _title" }]);
      expect(create.code).toBe("filter_invalid");
      expect(create.data).toMatchObject({ hint: "selection" });
      expect(create.message).toBe("effects[0]: a `create` has no row — an expression on a create needs a selector (`select`)");
      // a folded leader on a create is a literal: fine
      expect(planPlain([{ op: "create", path: '-> "n.md"', markdown: "-> `# N`" }]).effects[0]).toEqual({ op: "create", path: "n.md", markdown: "# N" });
      for (const effects of [[insert("-> project", "x")], [insert({ kind: "document", _path: "-> project" }, "x")], [{ op: "remove", targets: ["-> _id"] }], [{ op: "merge", targets: [{ kind: "block", _id: "-> _id" }, "b_2"] }]]) {
        const e = refusedPlain(effects);
        expect(e.code).toBe("filter_invalid");
        expect(e.message).toContain("an expression target needs a selector");
      }
      const fresh = refusedPlain([{ op: "create", path: "n.md", markdown: "# N" }, insert("$new.0", "-> _title")]);
      expect(fresh.message).toBe("effects[1].into: $new.0 has no row yet — it is created by this plan; use a literal target or a selector");
      // a literal that is no row is the lowering's own error
      expect(refusedPlain([insert("nowhere.md", "-> _title")]).code).toBe("doc_missing");
      expect(refusedPlain([{ op: "set", target: "b_99", field: "markdown", value: "-> text" }])).toMatchObject({ code: "block_missing", data: { block: "b_99" } });
      expect(refusedPlain([insert({ kind: "block", _id: "b_99" }, "-> text")]).code).toBe("parent_missing");
    });

    it("`templates` rides on the plan outside the digest: admitted by the plan form, recorded by execute; a mistyped one is filter_invalid", () => {
      const p = planPlain([insert("ws/alpha.md", "-> `## ${_title}`")]);
      expect(admitPlan(p).templates).toEqual(p.templates);
      expect(admitPlan({ ...p, templates: undefined }).plan_id).toBe(p.plan_id);
      expect(() => admitPlan({ ...p, templates: "nope" })).toThrow(expect.objectContaining({ code: "filter_invalid" }));
      const r = executePlan(store, { repoId, docStore, plan: p, origin });
      const ops = store.db.prepare("SELECT ops FROM commits WHERE commit_id = ?").pluck().get(r.commit) as string;
      expect(JSON.parse(ops)).toEqual({ v: 1, plan_id: p.plan_id, effects: p.effects, templates: p.templates });
      // the digest form re-plans from the written effects
      const again = planPlain([insert("ws/beta.md", "-> `## ${_title}`")]);
      expect(executeByDigest(store, { repoId, docStore, planId: again.plan_id, effects: again.templates, origin }).commit).toBe("c_5");
    });
  });
});

describe("the fix (§8, 3.3) under a selector", () => {
  it("a refused source is respelled over an admitted root: links → blocks, anything else → docs", () => {
    const links = refused('from links where _dst_path == "/hub.md"', MARK);
    expect(links.data.fix).toBe(canonicalJson({ select: 'from blocks where _dst_path == "/hub.md"', effects: MARK }));
    const nested = refused("from docs._blocks", MARK, 5);
    expect(nested.code).toBe("filter_invalid");
    expect(nested.data.fix).toBe(canonicalJson({ select: "from docs", effects: MARK, expect: { max: 5 } }));
  });

  it("a cross-hit collision narrows the selector to the later hit; a same-hit collision drops the earlier template", () => {
    const cross = refused(COMPLETED, [{ op: "set", target: "hub.md", field: "_frontmatter.x", value: "-> _path" }]);
    expect(cross.code).toBe("conflicting_effects");
    expect(cross.data.fix).toBe(canonicalJson({ select: 'from docs where _id == "d_2"', effects: [{ op: "set", target: "hub.md", field: "_frontmatter.x", value: "-> _path" }], expect: { max: 1 } }));
    const same = refused(COMPLETED, [{ op: "set", field: "_frontmatter.x", value: 1 }, { op: "set", field: "_frontmatter.x", value: 2 }], 5);
    expect(same.code).toBe("conflicting_effects");
    expect(same.data.fix).toBe(canonicalJson({ select: COMPLETED, effects: [{ op: "set", field: "_frontmatter.x", value: 2 }], expect: { max: 5 } }));
  });

  it("a stray leader in a template is spelled literally in the same request", () => {
    const e = refused(COMPLETED, [{ op: "set", field: "-> _frontmatter.x", value: 1 }], 5);
    expect(e.code).toBe("filter_invalid");
    expect(e.data.fix).toBe(canonicalJson({ select: COMPLETED, effects: [{ op: "set", field: "_frontmatter.x", value: 1 }], expect: { max: 5 } }));
  });
});
