import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { defaultChoice, isIntrinsic, projectionOf, rowFields, selectKind } from "../src/lib/projection.ts";

const TIMELINE = `select _path, _title, phase, before, after
from docs
where _path == "/timeline/kickoff.md"
follow distinct refs(before), _in_links collect { from _doc where ^_path in list(after) }
order by $ordinal`;

describe("projectionOf", () => {
  it("lists the select items in order with their kinds; the label defaults to `_title`, shown is the label alone", () => {
    const p = projectionOf(parse(TIMELINE), []);
    expect(p.fields.map((f) => [f.name, f.kind, f.source])).toEqual([
      ["_path", "intrinsic", "select"],
      ["_title", "intrinsic", "select"],
      ["phase", "field", "select"],
      ["before", "field", "select"],
      ["after", "field", "select"],
    ]);
    expect(p.defaults).toEqual({ label: "_title", shown: ["_title"] });
    // The spans point at the items, so the editor can highlight them.
    expect(TIMELINE.slice(...p.fields[2]!.span!)).toBe("phase");
  });

  it("the starter: the _title attribute is the label, the attributes are intrinsics (5.0's `_title`, or 4.x's `_title`)", () => {
    const p = projectionOf(parse(`select _path, _title from docs order by _updated_at desc limit 40`), []);
    expect(p.fields.map((f) => [f.name, f.kind])).toEqual([["_path", "intrinsic"], ["_title", "intrinsic"]]);
    expect(p.defaults).toEqual({ label: "_title", shown: ["_title"] });
    // The authored _title is a navigation off the `_data` handle: a field.
    expect(projectionOf(parse(`select _path, t: _data.title from docs`), []).fields.map((f) => f.kind)).toEqual(["intrinsic", "field"]);
    // The 4.x spelling reads the same way.
    const old = projectionOf(parse(`select path, title from docs order by updated_at desc limit 40`), []);
    expect(old.fields.map((f) => [f.name, f.kind])).toEqual([["path", "intrinsic"], ["title", "intrinsic"]]);
    expect(old.defaults).toEqual({ label: "title", shown: ["title"] });
    expect(projectionOf(parse(`select path, t: data.title from docs`), []).fields.map((f) => f.kind)).toEqual(["intrinsic", "field"]);
  });

  it("keys an item by its alias or its navigation's last segment; an aliased intrinsic is still intrinsic-valued", () => {
    const p = projectionOf(parse(`select t: _title, meta.slug, n: size(before), _id, d: $depth from docs`), []);
    expect(p.fields.map((f) => [f.name, f.kind])).toEqual([["t", "intrinsic"], ["slug", "field"], ["n", "field"], ["_id", "intrinsic"], ["d", "intrinsic"]]);
    // No `_title`/`name` key → the path is the label and nothing else is shown.
    expect(p.defaults).toEqual({ label: null, shown: [] });
  });

  it("nested blocks (collect / first / single) are nested", () => {
    const src = `select name, jobs: jobs collect { employer }, last: jobs first { employer }, one: jobs single { employer } from people`;
    const p = projectionOf(parse(src), []);
    expect(p.fields.map((f) => [f.name, f.kind])).toEqual([["name", "field"], ["jobs", "nested"], ["last", "nested"], ["one", "nested"]]);
    expect(p.defaults.label).toBe("name");
    expect(src.slice(...p.fields[1]!.span!)).toBe("jobs: jobs collect { employer }");
  });

  it("values mode is a single unnamed value", () => {
    expect(projectionOf(parse(`title values from docs`), []).fields).toEqual([{ name: "title", kind: "values", span: [0, 5], source: "select" }]);
    const p = projectionOf(parse(`name.upper() values from people`), []);
    expect(p.fields.map((f) => [f.name, f.kind])).toEqual([["value", "values"]]);
    expect(p.defaults).toEqual({ label: null, shown: [] });
  });

  it("an empty projection (or no query) describes itself from the rows: union, first-seen order, kinded by value, minus the hit envelope", () => {
    // `_id`/`_path` are the envelope, never fields; a `$`-keyed value (a walk's `$depth`) and a `_`-keyed one (`_title`) are intrinsics.
    const rows = [
      { _id: "d_1", _path: "/a.md", _title: "A", tags: null, $depth: 1 },
      { _id: "d_2", _path: "/b.md", tags: ["x", "y"], meta: { k: 1 }, count: 3, done: false },
    ];
    const fromDocs = projectionOf(parse(`from docs where _path == "/a.md"`), rows);
    expect(fromDocs.fields.map((f) => [f.name, f.kind, f.source])).toEqual([
      ["_title", "intrinsic", "row"], // a 5.0 row's `_title` is the computed title: an engine value
      ["tags", "nested", "row"], // null first, then a list: the list decides
      ["$depth", "intrinsic", "row"], ["meta", "nested", "row"], ["count", "field", "row"], ["done", "field", "row"],
    ]);
    expect(fromDocs.defaults).toEqual({ label: "_title", shown: ["_title"] });
    expect(projectionOf(null, rows).fields.map((f) => f.name)).toEqual(fromDocs.fields.map((f) => f.name));
    expect(projectionOf(null, [])).toEqual({ fields: [], defaults: { label: null, shown: [] } });
    expect(rowFields([]).length).toBe(0);
  });

  it("a bare `from docs` offers nothing: the envelope is all the rows carry (in either spelling)", () => {
    expect(rowFields([{ _id: "d_1", _path: "/a.md" }, { _id: "d_2", _path: "/b.md" }])).toEqual([]);
    expect(rowFields([{ _id: "d_1", _path: "/a.md" }, { _id: "d_2", _path: "/b.md" }])).toEqual([]);
    const p = projectionOf(parse(`from docs`), [{ _id: "d_1", _path: "/a.md" }]);
    expect(p).toEqual({ fields: [], defaults: { label: null, shown: [] } });
    // A 5.0 row's `_title` is the computed title and the label; the walk's `$depth` an intrinsic.
    const five = projectionOf(parse(`from docs where _path == "/a.md"`), [{ _id: "d_1", _path: "/a.md", _title: "A", phase: "plan", $depth: 0 }]);
    expect(five.fields.map((f) => [f.name, f.kind])).toEqual([["_title", "intrinsic"], ["phase", "field"], ["$depth", "intrinsic"]]);
    expect(five.defaults).toEqual({ label: "_title", shown: ["_title"] });
  });
});

describe("defaultChoice", () => {
  const f = (name: string) => ({ name, kind: "field" as const, span: null, source: "row" as const });
  it("prefers `_title` (the computed title attribute; a 4.x server's `title`), then `name`; else the path", () => {
    expect(defaultChoice([f("name"), f("_title")]).label).toBe("_title");
    expect(defaultChoice([f("name"), f("_title")]).label).toBe("_title");
    expect(defaultChoice([f("_title"), f("_title")]).label).toBe("_title");
    expect(defaultChoice([f("phase"), f("name")]).label).toBe("name");
    expect(defaultChoice([f("phase")])).toEqual({ label: null, shown: [] });
  });
});

describe("selectKind / isIntrinsic", () => {
  const exprOf = (src: string) => {
    const item = parse(`select x: ${src} from docs`).select[0]!;
    return item.kind === "field" ? item.expr : null!;
  };

  it("reads one item: attributes, $it and navigations off it, and lifts (no key on the row)", () => {
    const q = parse(`select _path, $it, x: $it.title, _updated_at, phase from docs`);
    expect(q.select.map((item) => selectKind(item))).toEqual(["intrinsic", "field", "field", "intrinsic", "field"]);
    // A lift lives in a where-position collect; it binds outward and projects nothing here.
    const where = parse(`select name from people where jobs collect { ^emp: employer }`).where!;
    expect(where.kind).toBe("op");
    if (where.kind === "op") expect(where.sub.select.map((item) => selectKind(item))).toEqual([null]);
  });

  it("isIntrinsic is a `_`-name (the 5.0 engine namespace), a bare 4.x docs attribute, or a $name of OQX's own other than $it", () => {
    expect(isIntrinsic(exprOf("_title"))).toBe(true);
    expect(isIntrinsic(exprOf("_updated_at"))).toBe(true);
    expect(isIntrinsic(exprOf("_path"))).toBe(true);
    expect(isIntrinsic(exprOf("$it._title"))).toBe(false);
    expect(isIntrinsic(exprOf("_data.title"))).toBe(false); // the authored _title, a navigation
    expect(isIntrinsic(exprOf("title"))).toBe(true);
    expect(isIntrinsic(exprOf("updated_at"))).toBe(true);
    expect(isIntrinsic(exprOf("$depth"))).toBe(true);
    expect(isIntrinsic(exprOf("$it"))).toBe(false);
    expect(isIntrinsic(exprOf("$it.title"))).toBe(false);
    expect(isIntrinsic(exprOf("phase"))).toBe(false);
    expect(isIntrinsic(exprOf("data.title"))).toBe(false); // the authored title, a navigation
    expect(isIntrinsic(exprOf("size(tags)"))).toBe(false);
  });
});
