import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { defaultChoice, isIntrinsic, projectionOf, rowFields, selectKind } from "../src/lib/projection.ts";

const TIMELINE = `select $path, title, phase, before, after
from docs
where $path == "/timeline/kickoff.md"
follow distinct refs(before), $it.in collect { where ^$path in list(after) }
order by $ordinal`;

describe("projectionOf", () => {
  it("lists the select items in order with their kinds; the label defaults to title, shown is the label alone", () => {
    const p = projectionOf(parse(TIMELINE), []);
    expect(p.fields.map((f) => [f.name, f.kind, f.source])).toEqual([
      ["$path", "intrinsic", "select"],
      ["title", "field", "select"],
      ["phase", "field", "select"],
      ["before", "field", "select"],
      ["after", "field", "select"],
    ]);
    expect(p.defaults).toEqual({ label: "title", shown: ["title"] });
    // The spans point at the items, so the editor can highlight them.
    expect(TIMELINE.slice(...p.fields[2]!.span!)).toBe("phase");
  });

  it("the starter: $title is the label, intrinsics are flagged", () => {
    const p = projectionOf(parse(`select $path, $title from docs order by $updated_at desc limit 40`), []);
    expect(p.fields.map((f) => [f.name, f.kind])).toEqual([["$path", "intrinsic"], ["$title", "intrinsic"]]);
    expect(p.defaults).toEqual({ label: "$title", shown: ["$title"] });
  });

  it("keys an item by its alias or its navigation's last segment; an aliased intrinsic is still intrinsic-valued", () => {
    const p = projectionOf(parse(`select t: $title, meta.slug, n: size(before), $id from docs`), []);
    expect(p.fields.map((f) => [f.name, f.kind])).toEqual([["t", "intrinsic"], ["slug", "field"], ["n", "field"], ["$id", "intrinsic"]]);
    // No $title/title/name key → the path is the label and nothing else is shown.
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
    expect(projectionOf(parse(`$title values from docs`), []).fields).toEqual([{ name: "$title", kind: "values", span: [0, 6], source: "select" }]);
    const p = projectionOf(parse(`name.upper() values from people`), []);
    expect(p.fields.map((f) => [f.name, f.kind])).toEqual([["value", "values"]]);
    expect(p.defaults).toEqual({ label: null, shown: [] });
  });

  it("an empty projection (or no query) describes itself from the rows: union, first-seen order, kinded by value, minus the hit envelope", () => {
    // Surface 3.0 hits: `$id`/`$path` are the envelope, never fields; `$title` here is a projected intrinsic.
    const rows = [
      { $id: "d_1", $path: "/a.md", title: "A", tags: null, $title: "A" },
      { $id: "d_2", $path: "/b.md", tags: ["x", "y"], meta: { k: 1 }, count: 3, done: false },
    ];
    const fromDocs = projectionOf(parse(`from docs where $path == "/a.md"`), rows);
    expect(fromDocs.fields.map((f) => [f.name, f.kind, f.source])).toEqual([
      ["title", "field", "row"],
      ["tags", "nested", "row"], // null first, then a list: the list decides
      ["$title", "intrinsic", "row"], ["meta", "nested", "row"], ["count", "field", "row"], ["done", "field", "row"],
    ]);
    expect(fromDocs.defaults).toEqual({ label: "$title", shown: ["$title"] });
    expect(projectionOf(null, rows).fields.map((f) => f.name)).toEqual(fromDocs.fields.map((f) => f.name));
    expect(projectionOf(null, [])).toEqual({ fields: [], defaults: { label: null, shown: [] } });
    expect(rowFields([]).length).toBe(0);
  });

  it("the 1.x/2.x envelope (`id`/`path`) is dropped from the rows' keys too, and a bare `from docs` offers nothing", () => {
    expect(rowFields([{ id: "d_1", path: "/a.md", $path: "/a.md" }, { id: "d_2", path: "/b.md" }])).toEqual([]);
    const p = projectionOf(parse(`from docs`), [{ $id: "d_1", $path: "/a.md" }]);
    expect(p).toEqual({ fields: [], defaults: { label: null, shown: [] } });
  });

});

describe("defaultChoice", () => {
  const f = (name: string) => ({ name, kind: "field" as const, span: null, source: "row" as const });
  it("prefers $title, then title, then name; else the path", () => {
    expect(defaultChoice([f("name"), f("title"), f("$title")]).label).toBe("$title");
    expect(defaultChoice([f("name"), f("title")]).label).toBe("title");
    expect(defaultChoice([f("phase"), f("name")]).label).toBe("name");
    expect(defaultChoice([f("phase")])).toEqual({ label: null, shown: [] });
  });
});

describe("selectKind / isIntrinsic", () => {
  const exprOf = (src: string) => {
    const item = parse(`select x: ${src} from docs`).select[0]!;
    return item.kind === "field" ? item.expr : null!;
  };

  it("reads one item: $-intrinsics, $it and navigations off it, and lifts (no key on the row)", () => {
    const q = parse(`select $path, $it, x: $it.title, $updated_at from docs`);
    expect(q.select.map(selectKind)).toEqual(["intrinsic", "field", "field", "intrinsic"]);
    // A lift lives in a where-position collect; it binds outward and projects nothing here.
    const where = parse(`select name from people where jobs collect { ^emp: employer }`).where!;
    expect(where.kind).toBe("op");
    if (where.kind === "op") expect(where.sub.select.map(selectKind)).toEqual([null]);
  });

  it("isIntrinsic is a bare $name other than $it", () => {
    expect(isIntrinsic(exprOf("$updated_at"))).toBe(true);
    expect(isIntrinsic(exprOf("$it"))).toBe(false);
    expect(isIntrinsic(exprOf("$it.title"))).toBe(false);
    expect(isIntrinsic(exprOf("title"))).toBe(false);
    expect(isIntrinsic(exprOf("size($tags)"))).toBe(false);
  });
});
