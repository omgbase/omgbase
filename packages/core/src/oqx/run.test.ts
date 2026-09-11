import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { oqxRun } from "./run.js";
import { query } from "../search/query.js";
import { FilterInvalid } from "../search/cel/parser.js";
import "../format/index.js"; // register format adapters so nodes are projected

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

describe("OQX end-to-end — the headline case (docs filtered by their nodes)", () => {
  beforeEach(() => {
    ingest("canon/tasks.md", "---\nlayer: canon\n---\n\n# Work\n\n- [ ] ship oqx\n- [x] write spec\n");
    ingest("draft/tasks.md", "---\nlayer: draft\n---\n\n# Work\n\n- [ ] draft thing\n");
    ingest("canon/prose.md", "---\nlayer: canon\n---\n\n# Prose\n\njust text, no tasks\n");
  });

  it("returns only docs that contain a matching node", () => {
    const { hits } = run('from docs where nodes.exists(where kind == "md:task")');
    expect(hits.map((h) => h.path).sort()).toEqual(["canon/tasks.md", "draft/tasks.md"]);
  });

  it("composes a doc-level scalar with a node-level correlated predicate", () => {
    const { hits } = run('from docs where layer == "canon" && nodes.exists(where kind == "md:task")');
    expect(hits.map((h) => h.path)).toEqual(["canon/tasks.md"]);
  });

  it("correlates per row — a node in ANOTHER doc must not qualify this one", () => {
    // canon/prose.md has no tasks; if the subquery were a global scan it would
    // match every doc.
    const { hits } = run('from docs where nodes.exists(where kind == "md:task")');
    expect(hits.map((h) => h.path)).not.toContain("canon/prose.md");
  });

  it("narrows on nested node attrs (unchecked tasks only)", () => {
    const { hits } = run('from docs where nodes.exists(where kind == "md:task" && !attrs.checked)');
    expect(hits.map((h) => h.path).sort()).toEqual(["canon/tasks.md", "draft/tasks.md"]);
  });

  it("reaches through to the owning doc from inside a nested node query", () => {
    const { hits } = run('from docs where nodes.exists(where kind == "md:task" && doc.layer == "draft")');
    expect(hits.map((h) => h.path)).toEqual(["draft/tasks.md"]);
  });

  it("count in where position means non-empty", () => {
    const { hits } = run('from docs where nodes.count(where kind == "md:task")');
    expect(hits.map((h) => h.path).sort()).toEqual(["canon/tasks.md", "draft/tasks.md"]);
  });
});

describe("OQX end-to-end — blocks and nodes targets", () => {
  beforeEach(() => {
    ingest("a.md", "---\nlayer: canon\n---\n\n# Launch\n\n- [ ] deploy\n- [x] docs\n\nSee [api](/api.md).\n");
    ingest("b.md", "---\nlayer: draft\n---\n\n# Other\n\n- [ ] unrelated\n");
  });

  it("filters blocks with a scalar predicate (parity with query())", () => {
    const oqx = run('from blocks where type == "task" && !attrs.checked');
    const cel = query(store, repoId, { from: "blocks", filter: 'type == "task" && !attrs.checked' });
    expect(oqx.hits.map((h) => h.id).sort()).toEqual(cel.hits.map((h) => h.id).sort());
  });

  it("filters docs by a correlated block predicate (doc.blocks)", () => {
    const { hits } = run('from docs where blocks.exists(where type == "code_fence")');
    expect(hits).toEqual([]); // neither fixture has a code fence
    const withTasks = run('from docs where blocks.exists(where type == "task")');
    expect(withTasks.hits.map((h) => h.path).sort()).toEqual(["a.md", "b.md"]);
  });

  it("fails loudly on block.nodes instead of returning an empty result", () => {
    // nodes.block_id is never populated by the format adapters today.
    expect(() => run('from blocks where nodes.exists(where kind == "md:link")')).toThrow(/unavailable/);
  });

  it("filters nodes with doc reach-through", () => {
    const { hits } = run('from nodes where kind == "md:task" && doc.layer == "canon"');
    expect(hits.length).toBe(2); // both tasks in a.md
    expect(hits.every((h) => h.path === "a.md")).toBe(true);
  });
});

describe("OQX end-to-end — projection", () => {
  beforeEach(() => {
    ingest("canon/tasks.md", "---\nlayer: canon\n---\n\n# Work\n\n- [ ] ship oqx\n- [x] write spec\n");
    ingest("canon/prose.md", "---\nlayer: canon\n---\n\n# Prose\n\njust text\n");
  });

  it("projects a named scalar value from frontmatter", () => {
    const { hits } = run("from docs select lay: layer");
    expect(hits.every((h) => h.lay === "canon")).toBe(true);
  });

  it("projects a collect() as an array per row", () => {
    const { hits } = run('from docs select tasks: nodes.collect(where kind == "md:task")');
    const byPath = new Map(hits.map((h) => [h.path, h.tasks as unknown[]]));
    expect(byPath.get("canon/tasks.md")!.length).toBe(2);
    // projection does NOT filter: a doc with no tasks still appears, with []
    expect(byPath.get("canon/prose.md")).toEqual([]);
  });

  it("collect honors an explicit nested select", () => {
    const { hits } = run('from docs where nodes.exists(where kind == "md:task") select tasks: nodes.collect(where kind == "md:task" select text: value)');
    const tasks = hits[0]!.tasks as { text: string }[];
    expect(tasks.length).toBe(2);
    expect(tasks.map((t) => t.text).sort()).toEqual(["ship oqx", "write spec"]);
  });

  it("projection and filtering compose (filter narrows, collect shapes)", () => {
    const { hits } = run('from docs where nodes.exists(where kind == "md:task") select tasks: nodes.collect(where kind == "md:task")');
    expect(hits.map((h) => h.path)).toEqual(["canon/tasks.md"]);
    expect((hits[0]!.tasks as unknown[]).length).toBe(2);
  });
});

describe("OQX end-to-end — absence semantics parity", () => {
  beforeEach(() => {
    ingest("a.md", "---\nlayer: canon\n---\n\n# A\n\nbody\n");
    ingest("b.md", "# B\n\nbody\n"); // no frontmatter at all
  });

  it("a missing key never matches (same rows as query())", () => {
    const oqx = run('from docs where layer == "canon"');
    const cel = query(store, repoId, { from: "docs", filter: 'layer == "canon"' });
    expect(oqx.hits.map((h) => h.path)).toEqual(cel.hits.map((h) => h.path));
    expect(oqx.hits.map((h) => h.path)).toEqual(["a.md"]);
  });

  it("negation of an absent field is true (same as query())", () => {
    const oqx = run('from docs where !layer');
    const cel = query(store, repoId, { from: "docs", filter: "!layer" });
    expect(oqx.hits.map((h) => h.path)).toEqual(cel.hits.map((h) => h.path));
    expect(oqx.hits.map((h) => h.path)).toEqual(["b.md"]);
  });
});

describe("OQX end-to-end — pagination", () => {
  beforeEach(() => {
    for (const name of ["a", "b", "c", "d", "e"]) {
      ingest(`${name}.md`, `---\nlayer: canon\n---\n\n# ${name}\n\nbody\n`);
    }
  });

  it("limit + truncated + cursor walk the whole set in path order", () => {
    const first = run("from docs", { limit: 2 });
    expect(first.hits.map((h) => h.path)).toEqual(["a.md", "b.md"]);
    expect(first.truncated).toBe(true);
    expect(first.cursor).toBeTruthy();

    const second = run("from docs", { limit: 2, cursor: first.cursor! });
    expect(second.hits.map((h) => h.path)).toEqual(["c.md", "d.md"]);

    const third = run("from docs", { limit: 2, cursor: second.cursor! });
    expect(third.hits.map((h) => h.path)).toEqual(["e.md"]);
    expect(third.truncated).toBe(false);
    expect(third.cursor).toBeNull();
  });

  it("rejects a malformed cursor", () => {
    expect(() => run("from docs", { limit: 2, cursor: "not-a-cursor" })).toThrow(FilterInvalid);
  });
});

describe("OQX end-to-end — text() full-text predicate", () => {
  beforeEach(() => {
    ingest("alpha.md", "---\nlayer: canon\n---\n\n# Alpha\n\nThe crimson salamander dances.\n\n- [ ] distill the quintessence\n");
    ingest("beta.md", "---\nlayer: draft\n---\n\n# Beta\n\nA gray pigeon rests.\n\n- [ ] grind the cinnabar\n");
  });

  it("blocks target: matches the block whose text contains the term", () => {
    const { hits } = run('from blocks where text("salamander")');
    expect(hits.length).toBe(1);
    expect(hits[0]!.path).toBe("alpha.md");
  });

  it("docs target: a doc matches when any of its blocks does", () => {
    expect(run('from docs where text("salamander")').hits.map((h) => h.path)).toEqual(["alpha.md"]);
    expect(run('from docs where text("pigeon")').hits.map((h) => h.path)).toEqual(["beta.md"]);
  });

  it("composes with a scalar predicate (AND)", () => {
    expect(run('from docs where text("crimson") && layer == "canon"').hits.map((h) => h.path)).toEqual(["alpha.md"]);
    expect(run('from docs where text("crimson") && layer == "draft"').hits.map((h) => h.path)).toEqual([]);
  });

  it("nodes target: matches a task node by its indexed text", () => {
    const { hits } = run('from nodes where kind == "md:task" && text("quintessence")');
    expect(hits.length).toBe(1);
    expect(hits[0]!.path).toBe("alpha.md");
  });

  it("composes INSIDE a correlated subquery — the win query() cannot express", () => {
    // docs that contain a task node whose text matches — a per-row full-text
    // predicate nested in an exists(). The old `query` tool has no such form.
    const { hits } = run('from docs where nodes.exists(where kind == "md:task" && text("cinnabar"))');
    expect(hits.map((h) => h.path)).toEqual(["beta.md"]);
  });

  it("a query that reduces to no searchable token matches nothing", () => {
    expect(run('from docs where text("")').hits).toEqual([]);
    expect(run('from docs where text("()")').hits).toEqual([]);
  });

  it("matches query()'s text: envelope for the same terms (parity)", () => {
    const oqx = run('from docs where text("salamander")');
    const cel = query(store, repoId, { from: "docs", text: "salamander" });
    expect(oqx.hits.map((h) => h.path)).toEqual(cel.hits.map((h) => h.path));
  });
});

describe("OQX end-to-end — top-level consumers (repo.<op>)", () => {
  beforeEach(() => {
    ingest("canon/a.md", "---\nlayer: canon\n---\n\n# A\n\n- [ ] t\n");
    ingest("canon/b.md", "---\nlayer: canon\n---\n\n# B\n\nprose\n");
    ingest("draft/c.md", "---\nlayer: draft\n---\n\n# C\n\nprose\n");
  });

  it("a bare query defaults to the collect consumer", () => {
    const r = run("from docs");
    expect(r.consumer).toBe("collect");
    expect(r.hits.map((h) => h.path)).toEqual(["canon/a.md", "canon/b.md", "draft/c.md"]);
  });

  it("repo.collect(...) is explicitly the same as the bare form", () => {
    const bare = run('from docs where layer == "canon"');
    const wrapped = run('repo.collect(from docs where layer == "canon")');
    expect(wrapped.consumer).toBe("collect");
    expect(wrapped.hits.map((h) => h.path)).toEqual(bare.hits.map((h) => h.path));
  });

  it("repo.count(...) reduces the query to the matching-row count (no hits)", () => {
    const r = run('repo.count(from docs where layer == "canon")');
    expect(r.consumer).toBe("count");
    expect(r.count).toBe(2);
    expect(r.hits).toEqual([]);
    expect(r.cursor).toBeNull();
  });

  it("repo.count over a correlated where counts docs, not their nodes", () => {
    // only canon/a.md has a task; the count is of DOCS, one per matching row.
    const r = run('repo.count(from docs where nodes.exists(where kind == "md:task"))');
    expect(r.count).toBe(1);
  });

  it("repo.exists(...) is a boolean over the outer row set", () => {
    expect(run('repo.exists(from docs where layer == "draft")').exists).toBe(true);
    expect(run('repo.exists(from docs where layer == "ghost")').exists).toBe(false);
  });

  it("repo.first(...) returns exactly the first row in path order (with its projections)", () => {
    const r = run('repo.first(from docs where layer == "canon" select l: layer)');
    expect(r.consumer).toBe("first");
    expect(r.hits.length).toBe(1);
    expect(r.hits[0]!.path).toBe("canon/a.md");
    expect(r.hits[0]!.l).toBe("canon");
    expect(r.truncated).toBe(false);
  });

  it("repo.first(...) over an empty match is zero rows, not an error", () => {
    expect(run('repo.first(from docs where layer == "ghost")').hits).toEqual([]);
  });

  it("repo.single(...) returns the one matching row", () => {
    const r = run('repo.single(from docs where layer == "draft")');
    expect(r.consumer).toBe("single");
    expect(r.hits.map((h) => h.path)).toEqual(["draft/c.md"]);
  });

  it("repo.single(...) fails loudly when more than one row matches", () => {
    expect(() => run('repo.single(from docs where layer == "canon")')).toThrow(/matched more than one row/);
  });

  it("repo.single(...) over no match is zero rows (like the nested single)", () => {
    expect(run('repo.single(from docs where layer == "ghost")').hits).toEqual([]);
  });

  it("consumers wrap a full query — where + a nested collect projection survive", () => {
    const r = run('repo.first(from docs where nodes.exists(where kind == "md:task") select tasks: nodes.collect(where kind == "md:task" select v: value))');
    expect(r.hits[0]!.path).toBe("canon/a.md");
    expect((r.hits[0]!.tasks as { v: string }[]).map((t) => t.v)).toEqual(["t"]);
  });

  it("rejects an unknown top-level consumer", () => {
    expect(() => run("repo.frobnicate(from docs)")).toThrow(/unknown top-level consumer/);
  });

  it("reserves `all` but reports it unimplemented", () => {
    expect(() => run("repo.all(from docs)")).toThrow(/not implemented yet/);
  });

  it("rejects a consumer wrapper with no closing paren", () => {
    expect(() => run("repo.count(from docs")).toThrow(FilterInvalid);
  });

  it("a top-level consumer and the repo.<target> ROOT RELATION coexist (same sigil, different roles)", () => {
    // repo.first(...) is the top-level consumer; repo.docs.collect(...) inside
    // the select is the root-relation receiver — both parse in one query.
    const r = run('repo.first(from docs where layer == "draft" select canon: repo.docs.collect(where layer == "canon" select p: $path))');
    expect(r.consumer).toBe("first");
    expect(r.hits[0]!.path).toBe("draft/c.md");
    expect((r.hits[0]!.canon as { p: string }[]).map((x) => x.p).sort()).toEqual(["canon/a.md", "canon/b.md"]);
  });
});

describe("OQX end-to-end — count comparisons", () => {
  beforeEach(() => {
    ingest("one.md", "# One\n\n- [ ] a\n");
    ingest("two.md", "# Two\n\n- [ ] a\n- [ ] b\n");
    ingest("three.md", "# Three\n\n- [ ] a\n- [ ] b\n- [ ] c\n");
  });

  it("count(...) >= N keeps only docs meeting the threshold", () => {
    const { hits } = run('from docs where nodes.count(where kind == "md:task") >= 2');
    expect(hits.map((h) => h.path).sort()).toEqual(["three.md", "two.md"]);
  });

  it("count(...) == N is exact", () => {
    const { hits } = run('from docs where nodes.count(where kind == "md:task") == 1');
    expect(hits.map((h) => h.path)).toEqual(["one.md"]);
  });
});

describe("OQX end-to-end — boolean composition over collection ops", () => {
  beforeEach(() => {
    ingest("tasks.md", "---\nlayer: draft\n---\n\n# T\n\n- [ ] work\n");
    ingest("links.md", "---\nlayer: draft\n---\n\n# L\n\nSee [x](/x.md).\n");
    ingest("plain.md", "---\nlayer: draft\n---\n\n# P\n\njust prose\n");
  });

  it("|| unions docs matching either correlated predicate", () => {
    const { hits } = run(
      'from docs where nodes.exists(where kind == "md:task") || nodes.exists(where kind == "md:link")',
    );
    expect(hits.map((h) => h.path).sort()).toEqual(["links.md", "tasks.md"]);
  });

  it("! excludes docs matching a correlated predicate", () => {
    const { hits } = run('from docs where layer == "draft" && !nodes.exists(where kind == "md:task")');
    expect(hits.map((h) => h.path).sort()).toEqual(["links.md", "plain.md"]);
  });
});

describe("OQX end-to-end — lifts (^name)", () => {
  beforeEach(() => {
    ingest("a.md", "---\nlayer: canon\n---\n\n# Work\n\n- [ ] ship oqx\n- [x] write spec\n- [ ] add lifts\n");
    ingest("b.md", "---\nlayer: draft\n---\n\n# Notes\n\njust prose, no tasks\n");
    ingest("c.md", "---\nlayer: canon\n---\n\n# More\n\n- [x] all done here\n");
  });

  it("filters by a where-collect AND lifts the matching values into the parent select", () => {
    const { hits } = run(
      'from docs where nodes.collect(^open: value where kind == "md:task" && !attrs.checked) select p: $path, open',
    );
    // only a.md has an OPEN task (c.md's task is checked, b.md has none)
    expect(hits.map((h) => h.p)).toEqual(["a.md"]);
    expect((hits[0]!.open as string[]).sort()).toEqual(["add lifts", "ship oqx"]);
  });

  it("the lift binding resolves under a renamed select column", () => {
    const { hits } = run(
      'from docs where nodes.collect(^open: value where kind == "md:task" && !attrs.checked) select todos: open',
    );
    expect((hits[0]!.todos as string[]).length).toBe(2);
  });

  it("an unreferenced lift still filters (the collect is a non-empty predicate)", () => {
    const { hits } = run(
      'from docs where nodes.collect(^ignored: value where kind == "md:task" && !attrs.checked) select p: $path',
    );
    expect(hits.map((h) => h.p)).toEqual(["a.md"]);
    expect(hits[0]!.ignored).toBeUndefined(); // not projected
  });

  it("composes with an outer scalar predicate", () => {
    const { hits } = run(
      'from docs where layer == "canon" && nodes.collect(^open: value where kind == "md:task" && !attrs.checked) select p: $path, open',
    );
    expect(hits.map((h) => h.p)).toEqual(["a.md"]); // canon + has an open task
  });
});

describe("OQX end-to-end — section relations (md:section nodes)", () => {
  beforeEach(() => {
    // Setup (h2) contains a Deep (h3) subsection; section ranges nest, so the
    // Deep content is transitively under Setup.
    ingest(
      "guide.md",
      "# Guide\n\n## Setup\n\n- alpha\n- beta\n\n### Deep\n\n- gamma\n\n## Teardown\n\n- delta\n",
    );
  });

  it("projects md:section nodes named by their heading text", () => {
    const { hits } = run('from nodes where kind == "md:section" select h: name');
    expect(hits.map((h) => h.h).sort()).toEqual(["Deep", "Guide", "Setup", "Teardown"]);
  });

  it("section.blocks reaches content transitively, including deeper headings' content", () => {
    const { hits } = run(
      'from nodes where kind == "md:section" && name == "Setup" select items: section.blocks.collect(where type == "list_item" select t: text)',
    );
    expect(hits.length).toBe(1);
    const items = (hits[0]!.items as { t: string }[]).map((i) => i.t).sort();
    expect(items).toEqual(["alpha", "beta", "gamma"]); // gamma is under the h3
  });

  it("a leaf section excludes content outside its range", () => {
    const { hits } = run(
      'from nodes where kind == "md:section" && name == "Teardown" select items: section.blocks.collect(where type == "list_item" select t: text)',
    );
    const items = (hits[0]!.items as { t: string }[]).map((i) => i.t);
    expect(items).toEqual(["delta"]);
  });

  it("section.subsections finds strictly-contained deeper sections (nodes→nodes)", () => {
    const { hits } = run(
      'from nodes where kind == "md:section" && name == "Setup" && section.subsections.exists(where name == "Deep")',
    );
    expect(hits.map((h) => h.name ?? h.id).length).toBe(1);
  });

  it("block.section reaches the enclosing sections of a block", () => {
    const { hits } = run(
      'from blocks where type == "list_item" && text == "gamma" && section.exists(where name == "Deep")',
    );
    expect(hits.length).toBe(1);
  });

  it("block.section spans all enclosing sections (Guide, Setup, and Deep contain gamma)", () => {
    for (const section of ["Guide", "Setup", "Deep"]) {
      const { hits } = run(
        `from blocks where type == "list_item" && text == "gamma" && section.exists(where name == "${section}")`,
      );
      expect(hits.length, `gamma should be under ${section}`).toBe(1);
    }
    // but NOT Teardown (a sibling section)
    const { hits } = run(
      'from blocks where type == "list_item" && text == "gamma" && section.exists(where name == "Teardown")',
    );
    expect(hits.length).toBe(0);
  });
});

describe("OQX end-to-end — errors surface as filter_invalid", () => {
  it("unknown relation", () => {
    expect(() => run('from nodes where blocks.exists(where type == "x")')).toThrow(FilterInvalid);
  });
  it("bad scalar syntax inside a nested op reaches the CEL layer", () => {
    expect(() => run("from docs where nodes.exists(where kind + 1)")).toThrow(FilterInvalid);
  });
  it("unknown field on a target", () => {
    expect(() => run("from blocks where bogus_field == 1")).toThrow(FilterInvalid);
  });
});

describe("OQX end-to-end — order by", () => {
  beforeEach(() => {
    ingest("a.md", "---\nord: 2\n---\n\n# A\n");
    ingest("b.md", "---\nord: 1\n---\n\n# B\n");
    ingest("c.md", "---\nord: 3\n---\n\n# C\n");
    ingest("d.md", "---\nord: 1\n---\n\n# D\n");
  });

  it("default (no order by) stays in path order", () => {
    expect(run("from docs").hits.map((h) => h.path)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
  });

  it("orders ascending by a frontmatter field, ties broken by path", () => {
    // b,d both ord=1 (path order between them), then a=2, c=3.
    expect(run("from docs order by ord asc").hits.map((h) => h.path)).toEqual(["b.md", "d.md", "a.md", "c.md"]);
  });

  it("orders descending", () => {
    expect(run("from docs order by ord desc").hits.map((h) => h.path)).toEqual(["c.md", "a.md", "b.md", "d.md"]);
  });

  it("a custom order disables the keyset cursor but still reports truncation", () => {
    const r = run("from docs order by ord asc", { limit: 2 });
    expect(r.hits.map((h) => h.path)).toEqual(["b.md", "d.md"]);
    expect(r.truncated).toBe(true);
    expect(r.cursor).toBeNull();
  });

  it("repo.first honors the order (the top-ranked row)", () => {
    expect(run("repo.first(from docs order by ord desc)").hits.map((h) => h.path)).toEqual(["c.md"]);
  });
});
