import { describe, it, expect } from "vitest";
import { reconcileDocument } from "./reconcile.js";
import { flatten, type FlatSource } from "./flatten.js";
import { DEFAULT_CONFIG } from "./types.js";

// Phase 4b — children vouch for their parent (03 §4). A container's visible
// text is its children's text, so a list of one-word items has no shingle
// evidence of its own; the carried ids of its children are the evidence.

let seq = 0;
function block(type: string, raw: string, children: FlatSource[] = [], withId = true): FlatSource {
  return { ...(withId ? { blockId: `b_${type}_${++seq}` } : {}), type, raw, children };
}
function list(items: string[], withId = true): FlatSource {
  return block("list", items.map((i) => `- ${i}`).join("\n"), items.map((i) => block("list_item", `- ${i}`, [], withId)), withId);
}
// Strip ids from an old tree to build the "new" side of the same structure.
function strip(blocks: FlatSource[]): FlatSource[] {
  return blocks.map((b) => ({ type: b.type, raw: b.raw, children: strip(b.children) }));
}
function dispositionOf(res: ReturnType<typeof reconcileDocument>, id: string) {
  return res.dispositions.find((d) => d.blockId === id)!;
}

describe("phase 4b — children vouch for their parent", () => {
  it("carries a list of one-word items when one item is edited (context_children)", () => {
    const old = [block("heading", "# Title"), list(["one", "two", "three"])];
    const listId = old[1]!.blockId!;
    const itemIds = old[1]!.children.map((c) => c.blockId!);
    const neu = strip([block("heading", "# Title"), list(["one", "two changed", "three"])]);

    const res = reconcileDocument(flatten(old), flatten(neu));

    // "one two three" vs "one two changed three" share no 3-gram (text_sim 0),
    // yet two of three children locked exactly under the new list: it carries.
    expect(res.assignment.get("/1")).toBe(listId);
    const d = dispositionOf(res, listId);
    expect(d.reason).toBe("context_children");
    expect(d.kind).toBe("edited");
    expect(d.confidence).toBeCloseTo(0.75 + 0.2 * (2 / 3), 10);
    expect(d.detail).toEqual({ children_carried: 2, children_total: 3 });
    expect(d.matcherV).toBe(DEFAULT_CONFIG.matcherV);

    // Untouched items carry exactly; the edited one-word item is NOT carried
    // ("two" vs "two changed" has no shared shingle; small-block policy mints).
    expect(res.assignment.get("/1/0")).toBe(itemIds[0]);
    expect(res.assignment.get("/1/2")).toBe(itemIds[2]);
    expect(res.assignment.get("/1/1")).not.toBe(itemIds[1]);
    expect(res.deleted).toEqual([itemIds[1]]);
  });

  it("carries the edited item too when its text is long enough to share a shingle", () => {
    const old = [list(["alpha item text here", "bravo item text here", "gamma item text here"])];
    const listId = old[0]!.blockId!;
    const bravoId = old[0]!.children[1]!.blockId!;
    const neu = strip([list(["alpha item text here", "bravo item text CHANGED", "gamma item text here"])]);
    const res = reconcileDocument(flatten(old), flatten(neu));
    expect(res.assignment.get("/0")).toBe(listId);
    // After the list pairs, phase 4 re-runs: the item is the lone unmatched old
    // child between matched neighbours and text_sim ≥ floor → context_unique.
    expect(res.assignment.get("/0/1")).toBe(bravoId);
    expect(dispositionOf(res, bravoId).reason).toBe("context_unique");
    expect(res.deleted).toEqual([]);
  });

  it("reaches a fixed point through nested containers (list > item > list)", () => {
    // outer list: three items; the middle item contains an inner list of one-word
    // items; one inner item is edited. Nothing above the inner items has any
    // shingle overlap, so every container must be carried by its children.
    const inner = list(["x", "y", "z"]);
    const midItem = block("list_item", "- mid\n  - x\n  - y\n  - z", [inner]);
    const outer = block("list", "- first\n- mid\n  - x\n  - y\n  - z\n- last", [
      block("list_item", "- first"),
      midItem,
      block("list_item", "- last"),
    ]);
    const old = [outer];
    const innerNew = list(["x", "y changed", "z"], false);
    const neu: FlatSource[] = [
      { type: "list", raw: "- first\n- mid\n  - x\n  - y changed\n  - z\n- last", children: [
        { type: "list_item", raw: "- first", children: [] },
        { type: "list_item", raw: "- mid\n  - x\n  - y changed\n  - z", children: [innerNew] },
        { type: "list_item", raw: "- last", children: [] },
      ] },
    ];
    const res = reconcileDocument(flatten(old), flatten(neu));

    expect(res.assignment.get("/0")).toBe(outer.blockId);
    expect(res.assignment.get("/0/1")).toBe(midItem.blockId);
    expect(res.assignment.get("/0/1/0")).toBe(inner.blockId);
    // the inner list is vouched for by 2/3 children (parents still undecided
    // at that point); the middle item by its sole child (1/1); the outer list
    // by "first"/"last" (2/3).
    expect(dispositionOf(res, inner.blockId!)).toMatchObject({ reason: "context_children", detail: { children_carried: 2, children_total: 3 } });
    expect(dispositionOf(res, midItem.blockId!)).toMatchObject({ reason: "context_children", detail: { children_carried: 1, children_total: 1 } });
    expect(dispositionOf(res, outer.blockId!)).toMatchObject({ reason: "context_children", detail: { children_carried: 2, children_total: 3 } });
    expect(dispositionOf(res, midItem.blockId!).confidence).toBe(0.95);
    // only the edited one-word inner item resets
    expect(res.deleted).toEqual([inner.children[1]!.blockId]);
  });

  it("does not vouch when the children scatter evenly across two new containers", () => {
    const old = [block("heading", "# T"), list(["one", "two", "three", "four"])];
    const listId = old[1]!.blockId!;
    const itemIds = old[1]!.children.map((c) => c.blockId!);
    // The four items are split into two lists (separated by a paragraph so they
    // parse as two lists). 2 + 2: no destination holds a clear majority.
    const neu = strip([block("heading", "# T"), list(["one", "two"]), block("paragraph", "between"), list(["three", "four"])]);
    const res = reconcileDocument(flatten(old), flatten(neu));

    // items carry exactly (phase 1) into their new homes …
    expect(res.assignment.get("/1/0")).toBe(itemIds[0]);
    expect(res.assignment.get("/1/1")).toBe(itemIds[1]);
    expect(res.assignment.get("/3/0")).toBe(itemIds[2]);
    expect(res.assignment.get("/3/1")).toBe(itemIds[3]);
    // … but neither new list inherits the old list's id: ambiguity mints (R4).
    expect(res.assignment.get("/1")).not.toBe(listId);
    expect(res.assignment.get("/3")).not.toBe(listId);
    expect(res.deleted).toEqual([listId]);
    expect(res.dispositions.some((d) => d.reason === "context_children")).toBe(false);
  });

  it("does vouch when a clear majority lands in one new container", () => {
    // A second edited top-level block keeps phase 4's "lone unmatched old"
    // rule from firing for the roots, so the list can only carry via 4b.
    const old = [block("paragraph", "alpha beta gamma"), list(["one", "two", "three", "four"])];
    const listId = old[1]!.blockId!;
    const neu = strip([block("paragraph", "delta epsilon zeta"), list(["one", "two", "three"]), block("paragraph", "between"), list(["four"])]);
    const res = reconcileDocument(flatten(old), flatten(neu));
    expect(res.assignment.get("/1")).toBe(listId);
    expect(dispositionOf(res, listId)).toMatchObject({ reason: "context_children", confidence: 0.75 + 0.2 * 0.75, detail: { children_carried: 3, children_total: 4 } });
    expect(res.assignment.get("/3")).not.toBe(listId);
  });

  it("does not let two old lists both claim one merged new list", () => {
    const old = [list(["one", "two", "three"]), block("paragraph", "between"), list(["four", "five", "six"])];
    const neu = strip([list(["one", "two", "three", "four", "five", "six"])]);
    const res = reconcileDocument(flatten(old), flatten(neu));
    // Each old list sends 100% of its children to the new list, but neither is
    // the unique source of the new list's carried children (3 vs 3): mint.
    expect(res.assignment.get("/0")).not.toBe(old[0]!.blockId);
    expect(res.assignment.get("/0")).not.toBe(old[2]!.blockId);
    expect(res.dispositions.some((d) => d.reason === "context_children")).toBe(false);
  });

  it("is deterministic: same input, same carries, dispositions and confidences", () => {
    const build = () => {
      seq = 100;
      const inner = list(["x", "y", "z"]);
      const old = [
        block("heading", "# T"),
        block("list", "- a\n- mid\n  - x\n  - y\n  - z\n- c", [block("list_item", "- a"), block("list_item", "- mid\n  - x\n  - y\n  - z", [inner]), block("list_item", "- c")]),
        list(["one", "two", "three", "four"]),
      ];
      const neu = strip([
        block("heading", "# T"),
        block("list", "- a\n- mid\n  - x\n  - y!\n  - z\n- c", [block("list_item", "- a"), block("list_item", "- mid\n  - x\n  - y!\n  - z", [list(["x", "y!", "z"])]), block("list_item", "- c")]),
        list(["one", "two", "three"]),
        block("paragraph", "between"),
        list(["four"]),
      ]);
      const res = reconcileDocument(flatten(old), flatten(neu));
      // strip minted ids (CSPRNG) — compare only the decisions
      const carried = [...res.assignment].filter(([, id]) => res.dispositions.some((d) => d.blockId === id && d.kind !== "inserted"));
      const dispos = res.dispositions.filter((d) => d.kind !== "inserted").map(({ blockId, kind, confidence, reason, detail }) => ({ blockId, kind, confidence, reason, detail }));
      return { carried, dispos, deleted: res.deleted };
    };
    const a = build();
    const b = build();
    expect(a).toEqual(b);
    expect(a.dispos.filter((d) => d.reason === "context_children").length).toBe(4); // inner, mid item, outer list, one-two-three list
  });
});
