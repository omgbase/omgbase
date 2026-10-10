import { describe, expect, it } from "vitest";
import type { Candidate } from "../src/lib/candidates.ts";
import { NO_OVERRIDES, NO_PROJECTION_OVERRIDES, axisStatus, defaultView, resolveProjection, resolveView, sameProjection, sameView, withAxis, withDirection, withEdge, withLabel, withShown } from "../src/lib/view.ts";
import type { ProjectedField } from "../src/lib/projection.ts";

const cand = (name: string, edge: boolean, layout: boolean, direction: "forward" | "backward" = "forward"): Candidate => ({
  name, kind: "frontmatter", sources: ["inferred"], spans: [], defaults: { edge, layout, direction },
});

const C = [cand("after", true, true, "backward"), cand("before", false, false), cand("owner", false, false)];

describe("view", () => {
  it("defaults follow the candidates", () => {
    expect(defaultView(C)).toEqual({ edges: ["after"], layout: { axis: "after", direction: "backward" }, projection: { label: null, shown: [] } });
    expect(defaultView([])).toEqual({ edges: [], layout: { axis: null, direction: "forward" }, projection: { label: null, shown: [] } });
  });

  it("edge overrides toggle per name and keep candidate order", () => {
    const o = withEdge(withEdge(NO_OVERRIDES, "owner", true), "after", false);
    expect(resolveView(C, o).edges).toEqual(["owner"]);
    expect(resolveView(C, withEdge(NO_OVERRIDES, "before", true)).edges).toEqual(["after", "before"]);
  });

  it("pinning an axis adopts its direction; null means force", () => {
    expect(resolveView(C, withAxis(NO_OVERRIDES, "before")).layout).toEqual({ axis: "before", direction: "forward" });
    expect(resolveView(C, withAxis(NO_OVERRIDES, null)).layout).toEqual({ axis: null, direction: "forward" });
    expect(resolveView(C, withDirection(NO_OVERRIDES, "forward")).layout).toEqual({ axis: "after", direction: "forward" });
    // Changing the axis resets a pinned direction.
    expect(resolveView(C, withAxis(withDirection(NO_OVERRIDES, "forward"), "after")).layout.direction).toBe("backward");
  });

  it("overrides naming a vanished candidate are ignored, a vanished pinned axis falls back to the inferred one", () => {
    const o = withAxis(withEdge(NO_OVERRIDES, "gone", true), "gone");
    expect(resolveView(C, o)).toEqual({ edges: ["after"], layout: { axis: "after", direction: "backward" }, projection: { label: null, shown: [] } });
  });

  it("sameView compares structurally", () => {
    expect(sameView(defaultView(C), defaultView(C))).toBe(true);
    expect(sameView(defaultView(C), resolveView(C, withAxis(NO_OVERRIDES, null)))).toBe(false);
  });
});

describe("axisStatus — an axis with no edges in the result", () => {
  const pair: Candidate = { name: "before/after", kind: "sequence", sources: ["pair"], spans: [], defaults: { edge: true, layout: true, direction: "forward" }, pair: { forward: "before", backward: "after", by: "name" } };
  const all = [pair, cand("before", false, false), cand("after", false, false, "backward"), cand("owner", false, false)];

  it("is empty exactly when the axis's known count is zero and there are two or more nodes", () => {
    expect(axisStatus("before", all, { before: 0, "before/after": 7 }, 12).empty).toBe(true);
    expect(axisStatus("before", all, { before: 3 }, 12).empty).toBe(false);
    // No axis (force), a single node, or a count not fetched yet: nothing to say.
    expect(axisStatus(null, all, { before: 0 }, 12)).toEqual({ empty: false, alternatives: [] });
    expect(axisStatus("before", all, { before: 0 }, 1).empty).toBe(false);
    expect(axisStatus("before", all, {}, 12).empty).toBe(false);
  });

  it("offers the axis's own pair first, then every other relationship with edges, never the empty ones", () => {
    const counts = { before: 0, "before/after": 7, after: 7, owner: 4, "doc.out": 0 };
    expect(axisStatus("before", all, counts, 12).alternatives).toEqual([
      { name: "before/after", edges: 7 }, { name: "after", edges: 7 }, { name: "owner", edges: 4 },
    ]);
    // An empty pair is not offered; an axis that is not a member gets the rest in candidate order.
    expect(axisStatus("owner", all, { owner: 0, "before/after": 7, before: 2 }, 12).alternatives).toEqual([{ name: "before/after", edges: 7 }, { name: "before", edges: 2 }]);
    expect(axisStatus("before", all, { before: 0, "before/after": 0 }, 12).alternatives).toEqual([]);
  });
});

const field = (name: string, kind: ProjectedField["kind"] = "field"): ProjectedField => ({ name, kind, span: null, source: "select" });
const F = [field("$path", "intrinsic"), field("title"), field("phase"), field("before"), field("after")];
const D = { label: "title", shown: ["title"] };

describe("projection in the view record", () => {
  it("defaults: the label is shown and nothing else", () => {
    expect(resolveProjection(F, D, NO_PROJECTION_OVERRIDES)).toEqual({ label: "title", shown: ["title"] });
    expect(defaultView(C, D).projection).toEqual(D);
    expect(defaultView(C).projection).toEqual({ label: null, shown: [] });
  });

  it("show toggles per field, kept in projection order; the label is always shown", () => {
    const o = withShown(withShown(NO_PROJECTION_OVERRIDES, "after", true), "phase", true);
    expect(resolveProjection(F, D, o).shown).toEqual(["title", "phase", "after"]);
    // Unchecking the label does nothing: it is the title line.
    expect(resolveProjection(F, D, withShown(NO_PROJECTION_OVERRIDES, "title", false)).shown).toEqual(["title"]);
  });

  it("pinning the label keeps the old label shown as a line; null means the path", () => {
    const o = withLabel(NO_PROJECTION_OVERRIDES, "$path");
    expect(resolveProjection(F, D, o)).toEqual({ label: "$path", shown: ["$path", "title"] });
    expect(resolveProjection(F, D, withLabel(NO_PROJECTION_OVERRIDES, null))).toEqual({ label: null, shown: ["title"] });
    // The path label with the title unchecked: an empty card body.
    expect(resolveProjection(F, D, withShown(withLabel(NO_PROJECTION_OVERRIDES, null), "title", false))).toEqual({ label: null, shown: [] });
  });

  it("overrides naming a vanished field are dropped; a vanished pinned label falls back to the inferred one", () => {
    const o = withShown(withLabel(NO_PROJECTION_OVERRIDES, "gone"), "also_gone", true);
    expect(resolveProjection(F, D, o)).toEqual({ label: "title", shown: ["title"] });
    // The inferred label vanished too (a different query): the path.
    expect(resolveProjection([field("phase")], { label: null, shown: [] }, o)).toEqual({ label: null, shown: [] });
    // A default label that is not among the fields is not invented.
    expect(resolveProjection([field("phase")], D, NO_PROJECTION_OVERRIDES)).toEqual({ label: null, shown: [] });
  });

  it("sameView / sameProjection compare the projection too", () => {
    const a = defaultView(C, D);
    expect(sameView(a, defaultView(C, { label: "title", shown: ["title"] }))).toBe(true);
    expect(sameView(a, defaultView(C, { label: "title", shown: ["title", "phase"] }))).toBe(false);
    expect(sameProjection({ label: null, shown: [] }, { label: null, shown: [] })).toBe(true);
    expect(sameProjection({ label: "a", shown: ["a"] }, { label: "a", shown: ["a", "b"] })).toBe(false);
  });
});
