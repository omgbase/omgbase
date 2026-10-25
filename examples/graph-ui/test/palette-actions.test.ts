import { describe, expect, it } from "vitest";
import { filterActions } from "@omgbase/elements/palette";
import { actionArgument, paletteActions, type PaletteState } from "../src/lib/palette-actions.ts";

const base: PaletteState = {
  connected: true, canWrite: true, hasQuery: true, algorithm: "layered", labelFit: "truncate", edgeStyle: "curved",
  armed: null, writable: ["before", "after"], confirm: true, undoLabel: null, redoLabel: null,
};

describe("paletteActions", () => {
  it("offers this page's controls: run, fit, create, the other layouts and label fits, the other edge style, arm / confirm, starter, reconnect", () => {
    const ids = paletteActions(base).map((a) => a.id);
    expect(ids).toEqual([
      "run", "fit", "create",
      "layout:force", "layout:stress", "layout:radial", "layout:tree", "layout:grid", "layout:auto",
      "label-fit:wrap", "label-fit:expand",
      "edge-style",
      "arm:before", "arm:after", "confirm",
      "starter", "reconnect",
    ]);
    expect(paletteActions(base).find((a) => a.id === "edge-style")?.label).toBe("edges: straight");
    expect(paletteActions({ ...base, edgeStyle: "straight" }).find((a) => a.id === "edge-style")?.label).toBe("edges: curved");
    expect(paletteActions(base).find((a) => a.id === "create")?.hint).toMatch(/loose node/);
  });

  it("undo / redo appear with the log's labels; an armed relationship offers disarm and the others; read-only drops the writes", () => {
    const s = { ...base, armed: "after", undoLabel: "undo: add /b.md to `after` of /a.md", redoLabel: "redo: x" };
    const a = paletteActions(s);
    expect(a.find((x) => x.id === "undo")).toMatchObject({ label: "undo: add /b.md to `after` of /a.md", shortcut: "⌘Z" });
    expect(a.find((x) => x.id === "redo")).toMatchObject({ shortcut: "⇧⌘Z" });
    expect(a.find((x) => x.id === "disarm")?.label).toBe("stop editing `after`");
    expect(a.filter((x) => x.id.startsWith("arm:")).map((x) => x.id)).toEqual(["arm:before"]);
    const ro = paletteActions({ ...base, canWrite: false, connected: false }).map((x) => x.id);
    expect(ro).not.toContain("create");
    expect(ro).not.toContain("confirm");
    expect(ro).not.toContain("run");
    expect(ro.some((id) => id.startsWith("arm:"))).toBe(false);
  });

  it("is what the palette's fuzzy filter ranks: `> stress` finds the layout, `> undo` the undo", () => {
    expect(filterActions(paletteActions(base), "stress")[0]?.id).toBe("layout:stress");
    expect(filterActions(paletteActions({ ...base, undoLabel: "undo: x" }), "undo")[0]?.id).toBe("undo");
    expect(filterActions(paletteActions(base), "edit after")[0]?.id).toBe("arm:after");
  });

  it("actionArgument reads the id's argument", () => {
    expect(actionArgument("layout:stress", "layout")).toBe("stress");
    expect(actionArgument("label-fit:wrap", "label-fit")).toBe("wrap");
    expect(actionArgument("layout", "layout")).toBeNull();
    expect(actionArgument("arm:after", "layout")).toBeNull();
  });
});
