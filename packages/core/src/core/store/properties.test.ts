import { describe, it, expect, afterEach } from "vitest";
import { Store } from "./store.js";
import { ensureRepo } from "../attach.js";
import { ingestFile } from "../ingest.js";
import { flattenFrontmatter } from "./properties.js";

let store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; });

interface Row { source: string; key: string; card: string; ord: number; val_text: string | null; val_num: number | null; val_bool: number | null; type: string; }

function props(content: string): Row[] {
  store = new Store({ path: ":memory:" });
  const repoId = ensureRepo(store, "t", "/tmp");
  const { docId } = ingestFile(store, repoId, "a.md", content);
  return store.db.prepare(
    "SELECT source, key, card, ord, val_text, val_num, val_bool, type FROM properties WHERE doc_id = ? ORDER BY source, key, ord",
  ).all(docId) as Row[];
}

describe("flattenFrontmatter", () => {
  it("scalars → one scalar row, typed", () => {
    expect(flattenFrontmatter({ layer: "canon", priority: 3, done: true })).toEqual([
      { key: "layer", card: "scalar", ord: 0, valText: "canon", valNum: null, valBool: null, valJson: null, type: "string" },
      { key: "priority", card: "scalar", ord: 0, valText: null, valNum: 3, valBool: null, valJson: null, type: "number" },
      { key: "done", card: "scalar", ord: 0, valText: null, valNum: null, valBool: 1, valJson: null, type: "bool" },
    ]);
  });

  it("scalar array → ord-indexed list rows", () => {
    const rows = flattenFrontmatter({ tags: ["a", "b", "c"] });
    expect(rows.map((r) => [r.key, r.card, r.ord, r.valText])).toEqual([
      ["tags", "list", 0, "a"], ["tags", "list", 1, "b"], ["tags", "list", 2, "c"],
    ]);
  });

  it("nested map → dotted keys", () => {
    const rows = flattenFrontmatter({ meta: { owner: "alice", team: "x" } });
    expect(rows.map((r) => [r.key, r.valText])).toEqual([["meta.owner", "alice"], ["meta.team", "x"]]);
  });

  it("array of objects → single json escape-hatch row", () => {
    const rows = flattenFrontmatter({ items: [{ a: 1 }, { b: 2 }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("json");
    expect(rows[0]!.card).toBe("list");
  });
});

describe("ingest → properties rows", () => {
  it("captures frontmatter scalar + list with card", () => {
    const rows = props("---\nlayer: canon\ntags: [a, b]\n---\n\n# H\n");
    const layer = rows.find((r) => r.key === "layer")!;
    expect(layer).toMatchObject({ source: "frontmatter", card: "scalar", val_text: "canon" });
    const tags = rows.filter((r) => r.key === "tags");
    expect(tags.map((r) => [r.card, r.ord, r.val_text])).toEqual([["list", 0, "a"], ["list", 1, "b"]]);
  });

  it("a lone inline field is card='scalar' (comparable), not list", () => {
    const rows = props("# H\n\nelement:: fire\n");
    const el = rows.filter((r) => r.source === "inline" && r.key === "element");
    expect(el.map((r) => [r.card, r.ord, r.val_text])).toEqual([["scalar", 0, "fire"]]);
  });

  it("accumulates repeated inline fields as card='list' rows in order", () => {
    const rows = props("# H\n\njob:: janitor\n\njob:: salesman\n");
    const job = rows.filter((r) => r.source === "inline" && r.key === "job");
    expect(job.map((r) => [r.card, r.ord, r.val_text])).toEqual([["list", 0, "janitor"], ["list", 1, "salesman"]]);
  });

  it("captures a multi-word inline value whole (not truncated at the first space)", () => {
    const rows = props("# H\n\nknown_for:: tria prima\n");
    const k = rows.find((r) => r.source === "inline" && r.key === "known_for")!;
    expect(k).toMatchObject({ card: "scalar", val_text: "tria prima" });
  });

  it("captures a bracketed in-prose inline value up to the closer", () => {
    const rows = props("# H\n\nSee [element:: quick silver] in the text (state:: liquid metal).\n");
    const el = rows.find((r) => r.source === "inline" && r.key === "element")!;
    const st = rows.find((r) => r.source === "inline" && r.key === "state")!;
    expect(el).toMatchObject({ val_text: "quick silver" });
    expect(st).toMatchObject({ val_text: "liquid metal" });
  });

  it("coerces numeric inline values", () => {
    const rows = props("# H\n\npriority:: 3\n");
    const p = rows.find((r) => r.source === "inline" && r.key === "priority")!;
    expect(p).toMatchObject({ val_num: 3, type: "number" });
  });
});
