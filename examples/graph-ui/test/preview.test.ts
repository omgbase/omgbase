import { describe, expect, it } from "vitest";
import type { GraphEdge } from "../src/lib/edges.ts";
import { isDrawn, isModifierKey, modified, modifierName, previewFor, type PreviewState } from "../src/lib/preview.ts";

interface N { path: string; label: string }
const alpha: N = { path: "timeline/alpha.md", label: "Alpha" };
const beta: N = { path: "timeline/beta.md", label: "Beta" };
const gamma: N = { path: "timeline/gamma.md", label: "Gamma" };
const nodes = [alpha, beta, gamma];
// beta.after = [alpha] is drawn beta → alpha; alpha.before = [beta] is drawn alpha → beta.
const edges: GraphEdge[] = [
  { src: beta.path, dst: alpha.path, rel: "after" },
  { src: alpha.path, dst: beta.path, rel: "before" },
];
const after = { name: "after", defaults: { direction: "backward" as const } };
const before = { name: "before", defaults: { direction: "forward" as const } };

const state = (over: Partial<PreviewState<N>> = {}): PreviewState<N> => ({
  modifier: true, nodes, selected: alpha.path, armed: before, hovered: null, hoveredEdge: null, writable: ["after", "before"], edges, ...over,
});

describe("previewFor", () => {
  it("previews nothing without the modifier, however complete the rest is", () => {
    expect(previewFor(state({ modifier: false, hovered: gamma.path }))).toBeNull();
    expect(previewFor(state({ modifier: false, hoveredEdge: edges[0]! }))).toBeNull();
  });

  it("previews nothing over empty canvas, over the selected node, or with nothing armed / selected", () => {
    expect(previewFor(state())).toBeNull();
    expect(previewFor(state({ hovered: alpha.path }))).toBeNull();
    expect(previewFor(state({ hovered: gamma.path, armed: null }))).toBeNull();
    expect(previewFor(state({ hovered: gamma.path, selected: null }))).toBeNull();
    expect(previewFor(state({ hovered: "timeline/missing.md" }))).toBeNull();
  });

  it("forward: the selected node owns the edge, the hovered one is the target — add when not drawn", () => {
    expect(previewFor(state({ hovered: gamma.path }))).toEqual({ kind: "add", rel: "before", owner: alpha, target: gamma, via: "node" });
  });

  it("backward: the hovered node owns the edge (its field changes), the selected one is the target", () => {
    expect(previewFor(state({ armed: after, hovered: gamma.path }))).toEqual({ kind: "add", rel: "after", owner: gamma, target: alpha, via: "node" });
  });

  it("remove when the edge is drawn the owner's way round, in either direction", () => {
    expect(previewFor(state({ hovered: beta.path }))).toEqual({ kind: "remove", rel: "before", owner: alpha, target: beta, via: "node" });
    expect(previewFor(state({ armed: after, hovered: beta.path }))).toEqual({ kind: "remove", rel: "after", owner: beta, target: alpha, via: "node" });
    // The inverse edge being drawn is not this edge: beta.before = [alpha] is absent.
    expect(previewFor(state({ selected: beta.path, hovered: alpha.path }))).toEqual({ kind: "add", rel: "before", owner: beta, target: alpha, via: "node" });
  });

  it("hovering a drawn edge of a writable relationship previews its removal, with or without a selection or armed relationship", () => {
    const want = { kind: "remove", rel: "after", owner: beta, target: alpha, via: "edge" };
    expect(previewFor(state({ hoveredEdge: edges[0]! }))).toEqual(want);
    expect(previewFor(state({ hoveredEdge: edges[0]!, selected: null, armed: null }))).toEqual(want);
  });

  it("ignores a hovered edge whose relationship is read-only", () => {
    expect(previewFor(state({ hoveredEdge: edges[0]!, writable: ["before"] }))).toBeNull();
    expect(previewFor(state({ hoveredEdge: { src: alpha.path, dst: gamma.path, rel: "doc.out_links" } }))).toBeNull();
  });

  it("a hovered node wins over a hovered edge", () => {
    expect(previewFor(state({ hovered: gamma.path, hoveredEdge: edges[0]! }))?.via).toBe("node");
  });

  it("isDrawn matches rel, src and dst exactly", () => {
    expect(isDrawn(edges, "after", beta.path, alpha.path)).toBe(true);
    expect(isDrawn(edges, "after", alpha.path, beta.path)).toBe(false);
    expect(isDrawn(edges, "before", beta.path, alpha.path)).toBe(false);
  });
});

describe("the modifier", () => {
  it("accepts either ⌘ or Ctrl, like the click handlers", () => {
    expect(modified({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(modified({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(modified({ metaKey: false, ctrlKey: false })).toBe(false);
  });

  it("knows which keys it listens for", () => {
    expect(isModifierKey("Meta")).toBe(true);
    expect(isModifierKey("Control")).toBe(true);
    expect(isModifierKey("Shift")).toBe(false);
    expect(isModifierKey("Alt")).toBe(false);
  });

  it("is named ⌘ on Apple platforms and Ctrl elsewhere", () => {
    expect(modifierName("MacIntel")).toBe("⌘");
    expect(modifierName("iPhone")).toBe("⌘");
    expect(modifierName("Win32")).toBe("Ctrl");
    expect(modifierName("Linux x86_64")).toBe("Ctrl");
    expect(modifierName("")).toBe("Ctrl");
  });
});
