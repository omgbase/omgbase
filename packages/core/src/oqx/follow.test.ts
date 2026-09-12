import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { oqxRun } from "./run.js";
import { FilterInvalid } from "../search/cel/parser.js";
import "../format/index.js"; // register format adapters

// Recursive `follow`: a query becomes a bounded WITH RECURSIVE walk over a
// type-preserving relation. These exercise `block.children` (blocks→blocks via
// parent_block) over a nested list, the two knobs (successor `where` shapes the
// relation → leaf; `frontier` cuts a continuable relation → frontier), the
// `$depth`/`$stop` intrinsics, `follow distinct`, consumers, and loud failures.
//
// Semantics: the query `where` selects the SEED rows (level 1); the follow-local
// `where` filters successors at each hop; membership is NOT re-applied during
// recursion (that is the follow-local `where`'s job), so a single-root subtree
// walk is expressible.

let store: Store;
let repoId: string;

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", "/tmp");
});
afterEach(() => store.close());

function ingest(path: string, content: string): void {
  ingestFile(store, repoId, path, content);
}
function run(src: string, opts?: { limit?: number; cursor?: string }) {
  return oqxRun(store, repoId, src, opts ?? {});
}

// A nested list. The block tree (markdown wraps each item's own text in a
// paragraph and nests sub-lists as `list` blocks):
//   list_item root ─┬─ paragraph "root"
//                   └─ list ─┬─ list_item mid ─┬─ paragraph "mid"
//                            │                 └─ list ─ list_item leaf
//                            └─ list_item sibling
//   list_item other
const TREE = `# Tree

- root
  - mid
    - leaf
  - sibling
- other
`;

// The list_items are named by their first word (their text aggregates
// descendants, e.g. root → "root - mid - leaf - sibling").
function firstWord(t: unknown): string {
  return String(t).split(" ")[0]!;
}

describe("follow block.children — single-root subtree walk", () => {
  beforeEach(() => ingest("tree.md", TREE));

  function walkRoot(clause = "") {
    return run(
      `from blocks where type == "list_item" && text.startsWith("root") ` +
        `select t: text, k: type, d: $depth, s: $stop ` +
        `follow block.children ${clause}`,
    ).hits;
  }

  it("reaches the whole block subtree with recursion depths", () => {
    const hits = walkRoot();
    // root(1) ; para-root(2) list(2) ; mid(3) sibling(3) ; para-mid(4) list(4) ; leaf(5)
    expect(hits.length).toBe(8);
    const items = hits.filter((h) => h.k === "list_item");
    expect(items.map((h) => [firstWord(h.t), h.d]).sort()).toEqual([
      ["leaf", 5], ["mid", 3], ["root", 1], ["sibling", 3],
    ]);
  });

  it("classifies $stop: interior vs leaf (relation ran out)", () => {
    const byItem = new Map(walkRoot().filter((h) => h.k === "list_item").map((h) => [firstWord(h.t), h.s]));
    expect(byItem.get("root")).toBe("interior");   // has children
    expect(byItem.get("mid")).toBe("interior");    // has a leaf child
    expect(byItem.get("sibling")).toBe("leaf");    // no children
    expect(byItem.get("leaf")).toBe("leaf");       // no children
  });

  it("`depth 2` bounds the walk; rows at the cap classify $stop == 'depth'", () => {
    const hits = walkRoot("depth 2");
    expect(hits.length).toBe(3); // root(1), paragraph "root"(2), list(2)
    const atCap = hits.filter((h) => h.d === 2);
    expect(atCap.length).toBe(2);
    expect(atCap.every((h) => h.s === "depth")).toBe(true); // depth precedence over leaf
    expect(hits.find((h) => h.d === 1)!.s).toBe("interior");
  });

  it("`frontier type == 'list'` cuts a continuable relation (→ frontier), unlike a leaf", () => {
    const hits = walkRoot('frontier type == "list"');
    // the frontier list is not expanded, so mid/sibling/leaf are never reached
    expect(hits.map((h) => firstWord(h.t))).not.toContain("mid");
    expect(hits.map((h) => firstWord(h.t))).not.toContain("sibling");
    const list = hits.find((h) => h.k === "list")!;
    expect(list.s).toBe("frontier");
    // the paragraph is a genuine leaf (relation ran out), NOT a frontier
    expect(hits.find((h) => h.k === "paragraph")!.s).toBe("leaf");
  });

  it("follow-local `where` shapes the relation (skip paragraphs, keep descending)", () => {
    const hits = walkRoot('where type != "paragraph"');
    expect(hits.some((h) => h.k === "paragraph")).toBe(false);
    // still reaches the deep leaf item through the (kept) list blocks
    const leaf = hits.find((h) => h.k === "list_item" && firstWord(h.t) === "leaf")!;
    expect(leaf.d).toBe(5);
  });
});

describe("follow distinct — dedup overlapping seeds by identity", () => {
  beforeEach(() => ingest("tree.md", TREE));

  it("default keeps per-path occurrences; distinct keeps one per node", () => {
    // Seeding ALL list_items: a nested item is both a seed (depth 1) and a
    // descendant of an ancestor seed — so it recurs more than once by default.
    const occ = run("from blocks where type == \"list_item\" follow block.children").hits;
    const dist = run("from blocks where type == \"list_item\" follow distinct block.children").hits;
    expect(dist.length).toBeLessThan(occ.length);
    // distinct really is one row per id
    expect(new Set(dist.map((h) => h.id)).size).toBe(dist.length);
  });
});

describe("follow — consumers over a recursive query", () => {
  beforeEach(() => ingest("tree.md", TREE));

  it("repo.count folds the walk to a number (CTE binds first in the reduced branch)", () => {
    expect(run('repo.count(from blocks where type == "list_item" && text.startsWith("root") follow block.children)').count).toBe(8);
  });

  it("repo.exists answers presence over the walk", () => {
    expect(run('repo.exists(from blocks where text.startsWith("root") follow block.children)').exists).toBe(true);
    expect(run('repo.exists(from blocks where text == "nope" follow block.children)').exists).toBe(false);
  });
});

describe("follow — post-walk filtering by recursion metadata", () => {
  beforeEach(() => ingest("tree.md", TREE));

  // seed the root item; the walk covers its subtree; a recursion-intrinsic term
  // in the top `where` filters the RESULT post-walk (separate from the seed).
  function walkRootFiltered(recurTerm: string) {
    return run(
      `from blocks where type == "list_item" && text.startsWith("root") && ${recurTerm} ` +
        "select t: text, k: type, d: $depth, s: $stop follow block.children",
    ).hits;
  }

  it("`&& $leaf` keeps only the leaves of the walk", () => {
    const hits = walkRootFiltered("$leaf");
    // leaves under root: paragraph "root", sibling, paragraph "mid", list_item leaf
    expect(hits.every((h) => h.s === "leaf")).toBe(true);
    expect(hits.length).toBe(4);
    const leafItems = hits.filter((h) => h.k === "list_item").map((h) => firstWord(h.t)).sort();
    expect(leafItems).toEqual(["leaf", "sibling"]);
  });

  it("`&& $stop == \"interior\"` keeps only interior rows", () => {
    const hits = walkRootFiltered('$stop == "interior"');
    expect(hits.every((h) => h.s === "interior")).toBe(true);
    // root, list L1, mid, list L2
    expect(hits.length).toBe(4);
  });

  it("`&& $depth >= 3` filters by recursion depth", () => {
    const depths = walkRootFiltered("$depth >= 3").map((h) => h.d as number);
    expect(depths.length).toBeGreaterThan(0);
    expect(depths.every((d) => d >= 3)).toBe(true);
  });

  it("the seed conjuncts still bound the walk (post-filter does not widen the seed)", () => {
    // filtering to $leaf must not resurrect rows outside root's subtree (e.g. `other`)
    const hits = walkRootFiltered("$leaf");
    expect(hits.map((h) => firstWord(h.t))).not.toContain("other");
  });
});

// A 3-level heading outline to distinguish immediate-child from transitive.
const OUTLINE = `# Top

Intro.

## Mid A

### Deep A1

### Deep A2

## Mid B

Tail.
`;

describe("follow section.children — immediate-child outline ladder", () => {
  beforeEach(() => ingest("outline.md", OUTLINE));

  it("walks the outline one level per hop ($depth == outline depth)", () => {
    const hits = run(
      'from nodes where kind == "md:section" && name == "Top" ' +
        "select n: name, d: $depth, s: $stop follow section.children",
    ).hits;
    const byName = new Map(hits.map((h) => [h.n as string, { d: h.d, s: h.s }]));
    expect(byName.get("Top")).toEqual({ d: 1, s: "interior" });
    expect(byName.get("Mid A")).toEqual({ d: 2, s: "interior" }); // has Deep A1/A2
    expect(byName.get("Mid B")).toEqual({ d: 2, s: "leaf" });     // no subsections
    expect(byName.get("Deep A1")).toEqual({ d: 3, s: "leaf" });
    expect(byName.get("Deep A2")).toEqual({ d: 3, s: "leaf" });
    expect(hits.length).toBe(5);
  });

  it("contrasts with transitive section.subsections (which flattens to depth 2)", () => {
    // subsections reaches every descendant in one hop, so the deep sections
    // appear at depth 2 (distinct dedups the multi-path occurrences).
    const subs = run(
      'from nodes where kind == "md:section" && name == "Top" ' +
        "select n: name, d: $depth follow distinct section.subsections",
    ).hits;
    const deep = subs.find((h) => h.n === "Deep A1")!;
    expect(deep.d).toBe(2); // transitive: not the true outline depth (3)
  });
});

describe("follow — nested inside a select-position collect", () => {
  beforeEach(() => {
    ingest("outline.md", OUTLINE);
    ingest("other.md", "# Other\n\n## Only\n");
  });

  it("projects a per-document recursive subtree via a nested follow-collect", () => {
    const res = run(
      'from docs where $path == "outline.md" ' +
        'select tree: nodes.collect(where kind == "md:section" && name == "Top" ' +
        "select n: name, d: $depth, s: $stop follow section.children)",
    );
    expect(res.hits.length).toBe(1);
    const tree = res.hits[0]!.tree as { n: string; d: number; s: string }[];
    const byName = new Map(tree.map((t) => [t.n, { d: t.d, s: t.s }]));
    expect(byName.get("Top")).toEqual({ d: 1, s: "interior" });
    expect(byName.get("Mid A")).toEqual({ d: 2, s: "interior" });
    expect(byName.get("Mid B")).toEqual({ d: 2, s: "leaf" });
    expect(byName.get("Deep A1")).toEqual({ d: 3, s: "leaf" });
    expect(byName.get("Deep A2")).toEqual({ d: 3, s: "leaf" });
    expect(tree.length).toBe(5);
  });

  it("is correlated per row — the walk stays within each document", () => {
    const res = run(
      "from docs " + // both docs
        'select p: $path, secs: nodes.collect(where kind == "md:section" select n: name follow section.children)',
    );
    const byPath = new Map(res.hits.map((h) => [h.p as string, (h.secs as { n: string }[]).map((s) => s.n)]));
    // outline.md's walk must not reach other.md's "Only" section, and vice-versa
    expect(byPath.get("other.md")).toContain("Only");
    expect(byPath.get("other.md")).not.toContain("Top");
    expect(byPath.get("outline.md")).toContain("Top");
    expect(byPath.get("outline.md")).not.toContain("Only");
  });

  it("rejects `follow` on a where-position op and on first/single", () => {
    expect(() => run('from docs where nodes.exists(where kind == "md:section" follow section.children)')).toThrow(/only valid on a select-position collect/);
    expect(() => run('from docs select x: nodes.first(where kind == "md:section" follow section.children)')).toThrow(/only valid on collect/);
  });
});

describe("follow — $ordinal (deterministic rank + budget)", () => {
  beforeEach(() => ingest("tree.md", TREE));

  it("$ordinal is a contiguous 1..N rank ordered by (depth, path); the seed ranks first", () => {
    const hits = run(
      'from blocks where type == "list_item" && text.startsWith("root") ' +
        "select o: $ordinal, d: $depth order by $ordinal follow block.children",
    ).hits;
    const ords = hits.map((h) => h.o as number);
    expect(ords).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // 8 occurrences, contiguous, in order
    expect(hits[0]!.d).toBe(1); // ordinal 1 is the seed (shallowest, first path)
  });

  it("`where $ordinal <= N` is a deterministic budget cut (reuses the post-walk filter)", () => {
    const hits = run(
      'from blocks where type == "list_item" && text.startsWith("root") && $ordinal <= 3 ' +
        "select o: $ordinal follow block.children",
    ).hits;
    expect(hits.map((h) => h.o).sort((a, b) => (a as number) - (b as number))).toEqual([1, 2, 3]);
  });
});

describe("follow — loud failures", () => {
  beforeEach(() => ingest("tree.md", TREE));

  it("rejects a non-type-preserving relation (blocks → docs)", () => {
    // node.doc etc. are not from blocks; doc.* off blocks is a scalar reach-through,
    // not a relation. Use section (blocks→nodes) which is not type-preserving.
    expect(() => run("from blocks follow section")).toThrow(FilterInvalid);
  });

  it("rejects a root (repository-wide) relation as a follow target", () => {
    expect(() => run("from docs follow repo.docs")).toThrow(/root|per-row/);
  });

  it("rejects an unknown follow receiver", () => {
    expect(() => run("from blocks follow bogus")).toThrow(FilterInvalid);
  });

  it("rejects recursion intrinsics in a follow-local `where` (mid-walk, undefined)", () => {
    expect(() => run('from blocks follow block.children where $depth > 1')).toThrow(/recursion intrinsic/);
  });

  it("rejects recursion intrinsics in a `frontier` predicate", () => {
    expect(() => run('from blocks follow block.children frontier $leaf')).toThrow(/recursion intrinsic/);
  });

  it("rejects a recursion intrinsic inside a collection op in the where", () => {
    expect(() => run('from docs where nodes.exists(where $leaf) follow doc.out')).toThrow(/cannot appear inside a collection op/);
  });

  it("rejects an out-of-range depth", () => {
    expect(() => run("from blocks follow block.children depth 9")).toThrow(/between 1 and 8/);
  });
});
