import { describe, it, expect, afterEach } from "vitest";
import { Store } from "./store.js";
import { ensureRepo } from "../attach.js";
import { ingestFile } from "../ingest.js";
import { flattenFrontmatter, detectRange } from "./properties.js";

let store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; });

interface Row { source: string; key: string; card: string; ord: number; val_text: string | null; val_num: number | null; val_bool: number | null; val_json: string | null; type: string; }

function props(content: string): Row[] {
  store = new Store({ path: ":memory:" });
  const repoId = ensureRepo(store, "t", "/tmp");
  const { docId } = ingestFile(store, repoId, "a.md", content);
  return store.db.prepare(
    "SELECT source, key, card, ord, val_text, val_num, val_bool, val_json, type FROM properties WHERE doc_id = ? ORDER BY source, key, ord",
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

describe("detectRange", () => {
  it("parses numeric ranges (inclusive / exclusive / open-ended)", () => {
    expect(detectRange("1..5")).toEqual({ lo: 1, hi: 5, exclusiveEnd: false });
    expect(detectRange("1...5")).toEqual({ lo: 1, hi: 5, exclusiveEnd: true });
    expect(detectRange("..5")).toEqual({ lo: null, hi: 5, exclusiveEnd: false });
    expect(detectRange("1..")).toEqual({ lo: 1, hi: null, exclusiveEnd: false });
    expect(detectRange("1.5..2.5")).toEqual({ lo: 1.5, hi: 2.5, exclusiveEnd: false });
    expect(detectRange("-5..5")).toEqual({ lo: -5, hi: 5, exclusiveEnd: false });
  });

  it("parses ISO-8601 date/datetime ranges, keeping the strings", () => {
    expect(detectRange("2026-01-01..2026-01-31")).toEqual({ lo: "2026-01-01", hi: "2026-01-31", exclusiveEnd: false });
    expect(detectRange("2026-01-01...2026-02-01")).toEqual({ lo: "2026-01-01", hi: "2026-02-01", exclusiveEnd: true });
    expect(detectRange("..2026-01-31")).toEqual({ lo: null, hi: "2026-01-31", exclusiveEnd: false });
  });

  it("rejects non-ranges and mis-shapen inputs (no false promotion)", () => {
    expect(detectRange("hello")).toBeNull();
    expect(detectRange("a..z")).toBeNull(); // bounds not a scalar domain
    expect(detectRange("1..2026-01-01")).toBeNull(); // mixed domains
    expect(detectRange("1.2.3..4.5.6")).toBeNull(); // bounds aren't numbers
    expect(detectRange("../foo")).toBeNull(); // a relative path, not a range
    expect(detectRange("1....5")).toBeNull(); // 4-dot run is not an operator
    expect(detectRange("..")).toBeNull(); // no bounds
    expect(detectRange("3.14")).toBeNull(); // a plain decimal, no operator
  });
});

describe("range-valued frontmatter → properties rows", () => {
  it("stores a range as type='string' with verbatim val_text and bounds in val_json", () => {
    const rows = props("---\nwindow: 2026-01-01..2026-01-31\nqty: 1..5\n---\n\n# H\n");
    const win = rows.find((r) => r.key === "window")!;
    expect(win).toMatchObject({ card: "scalar", type: "string", val_text: "2026-01-01..2026-01-31" });
    expect(JSON.parse(win.val_json!)).toEqual({ __range: true, lo: "2026-01-01", hi: "2026-01-31", exclusiveEnd: false });
    const qty = rows.find((r) => r.key === "qty")!;
    expect(qty).toMatchObject({ type: "string", val_text: "1..5" });
    expect(JSON.parse(qty.val_json!)).toEqual({ __range: true, lo: 1, hi: 5, exclusiveEnd: false });
  });

  it("keeps an ordinary dotted string a plain string (no val_json side channel)", () => {
    const rows = props("---\nversion: alpha..omega\n---\n\n# H\n");
    const v = rows.find((r) => r.key === "version")!;
    expect(v).toMatchObject({ type: "string", val_text: "alpha..omega", val_json: null });
  });
});

describe("frontmatter rows come from the `frontmatter` block only (spec/properties §3.1, §8 Fixed)", () => {
  it("an invalid closing fence means no frontmatter block, so no frontmatter rows", () => {
    // `---bar` does not close the fence: the parse is a thematic break + a
    // paragraph. The old regex over the raw source still matched `\n---` and
    // produced a `foo` row.
    const rows = props("---\nfoo: 1\n---bar\n");
    expect(rows.filter((r) => r.source === "frontmatter")).toEqual([]);
  });

  it("a YAML line that starts with `---` is part of the fence, not its end", () => {
    // The fence closes at the bare `---` line; `---x: 2` is an ordinary key.
    // The old regex cut the YAML short at `\n---x`, dropping the second key.
    const rows = props("---\na: 1\n---x: 2\n---\n\n# T\n");
    expect(rows.filter((r) => r.source === "frontmatter").map((r) => [r.key, r.val_num])).toEqual([["---x", 2], ["a", 1]]);
  });

  it("a BOM-prefixed document still yields its frontmatter rows (the block parses; the source does not start with `---`)", () => {
    const rows = props("\uFEFF---\na: 1\n---\n\n# T\n");
    expect(rows.filter((r) => r.source === "frontmatter").map((r) => [r.key, r.val_num])).toEqual([["a", 1]]);
  });

  it("CRLF fences and a closing fence with trailing whitespace parse", () => {
    expect(props("---\r\na: 1\r\n---\r\n\r\n# T\r\n").filter((r) => r.source === "frontmatter").map((r) => [r.key, r.val_num])).toEqual([["a", 1]]);
    expect(props("---\na: 1\n---   \n\n# T\n").filter((r) => r.source === "frontmatter").map((r) => [r.key, r.val_num])).toEqual([["a", 1]]);
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
