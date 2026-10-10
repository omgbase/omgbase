import { describe, expect, it } from "vitest";
import type { Candidate } from "../src/lib/candidates.ts";
import { NO_OVERRIDES, defaultView, resolveView, sameView, withAxis, withDirection, withEdge } from "../src/lib/view.ts";

const cand = (name: string, edge: boolean, layout: boolean, direction: "forward" | "backward" = "forward"): Candidate => ({
  name, kind: "frontmatter", sources: ["inferred"], spans: [], defaults: { edge, layout, direction },
});

const C = [cand("after", true, true, "backward"), cand("before", false, false), cand("owner", false, false)];

describe("view", () => {
  it("defaults follow the candidates", () => {
    expect(defaultView(C)).toEqual({ edges: ["after"], layout: { axis: "after", direction: "backward" } });
    expect(defaultView([])).toEqual({ edges: [], layout: { axis: null, direction: "forward" } });
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
    expect(resolveView(C, o)).toEqual({ edges: ["after"], layout: { axis: "after", direction: "backward" } });
  });

  it("sameView compares structurally", () => {
    expect(sameView(defaultView(C), defaultView(C))).toBe(true);
    expect(sameView(defaultView(C), resolveView(C, withAxis(NO_OVERRIDES, null)))).toBe(false);
  });
});
