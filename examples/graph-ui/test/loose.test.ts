import { describe, expect, it } from "vitest";
import { graphNodes } from "../src/lib/graph-view.ts";
import { addLoose, looseNode, looseNodeQuery, withLoose } from "../src/lib/loose.ts";
import { NAMES_4, NAMES_5 } from "../src/lib/paths.ts";

describe("looseNodeQuery", () => {
  it("selects the envelope, the title and the projected plain fields (deduped; expressions, $-names and the envelope dropped), by rooted path", () => {
    expect(looseNodeQuery("timeline/x.md", ["_path", "_title", "phase", "before", "n: size(before)", "$depth", "phase", "meta.slug"], NAMES_5))
      .toBe('docs { select _id, _path, _title, phase, before where _path == "/timeline/x.md" }');
    expect(looseNodeQuery("/x.md", [], NAMES_4)).toBe('docs { select id, path, title where path == "/x.md" }');
  });
});

describe("looseNode / withLoose / addLoose", () => {
  it("flags the hit as loose and merges it after the rows without doubling a shown path", () => {
    const rows = graphNodes([{ _id: "d_a", _path: "/a.md", _title: "A" }]);
    const l = looseNode({ _id: "d_b", _path: "/b.md", _title: "B" })!;
    expect(l).toMatchObject({ id: "d_b", path: "/b.md", label: "b", loose: true });
    const dup = looseNode({ _id: "d_a", _path: "/a.md" })!;
    expect(withLoose(rows, [l, dup]).map((n) => n.path)).toEqual(["/a.md", "/b.md"]);
    expect(withLoose(rows, [l, dup])[0]!.loose).toBeUndefined();
    expect(looseNode({})).toBeNull();
    const again = looseNode({ _id: "d_b", _path: "/b.md", _title: "B2" })!;
    expect(addLoose([l, dup], again).map((n) => `${n.path}:${n.row._title}`)).toEqual(["/a.md:undefined", "/b.md:B2"]);
  });
});
