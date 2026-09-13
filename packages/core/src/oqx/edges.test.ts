import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { oqxRun } from "./run.js";
import { FilterInvalid } from "../search/cel/parser.js";
import "../format/index.js";

// The `edges` OQX target: query the authored edge graph as first-class rows.
// Edges are populated by the sync path (extraction + resolution + maintainEdges),
// so these tests write real files and run processCheckpoint.

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-edges-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function save(path: string, content: string): void {
  writeFileSync(join(dir, path), content);
  processCheckpoint(store, repoId, dir, [{ path }]);
}
function run(src: string) {
  return oqxRun(store, repoId, src, { limit: 100 });
}

// A corpus exercising every edge shape:
//  a → b  : depends_on (frontmatter)  +  references (link)
//  a → external https://example.com/x : references (link, dst_kind external)
//  a → /missing.md : references (link, dst_kind document, PHANTOM — dangling)
//  a → c#Intro : references (link, anchor "Intro")
//  b → c : related (inline_field)
beforeEach(() => {
  save(
    "a.md",
    "---\ndepends_on: /b.md\n---\n# A\n\nSee [b](/b.md) and the [site](https://example.com/x).\nAlso [gone](/missing.md) and [c intro](/c.md#Intro).\n",
  );
  save("b.md", "# B\n\nrelated:: /c.md\n");
  save("c.md", "# C\n\n## Intro\n\ntext\n");
});

describe("from edges — the edge scan", () => {
  it("selects an edge's predicate, endpoints, and source-doc path", () => {
    const hits = run(
      'from edges where predicate == "depends_on" select p: predicate, src: $src, dst: $dst, kind: dst_kind, prov: provenance, origin: $path',
    ).hits;
    expect(hits.length).toBe(1);
    const e = hits[0]!;
    expect(e.p).toBe("depends_on");
    expect(e.prov).toBe("frontmatter");
    expect(e.kind).toBe("document");
    expect(e.origin).toBe("a.md"); // source-doc reach-through ($path)
    expect(String(e.dst).length).toBeGreaterThan(0);
  });

  it("resolves a document edge's destination path via $dst_path", () => {
    const hits = run(
      'from edges where predicate == "depends_on" select dpath: $dst_path',
    ).hits;
    expect(hits[0]!.dpath).toBe("b.md");
  });

  it("exposes external edges with their URI via $dst_uri", () => {
    const hits = run('from edges where dst_kind == "external" select uri: $dst_uri, dpath: $dst_path').hits;
    expect(hits.length).toBe(1);
    expect(hits[0]!.uri).toBe("https://example.com/x");
    expect(hits[0]!.dpath).toBeNull(); // external: no destination document
  });

  it("distinguishes provenance: frontmatter vs inline_field vs link", () => {
    expect(run('from edges where provenance == "frontmatter"').hits.length).toBe(1); // depends_on
    expect(run('from edges where provenance == "inline_field"').hits.length).toBe(1); // related::
    // links: references to b, external, phantom, c#Intro = 4
    expect(run('from edges where provenance == "link"').hits.length).toBe(4);
  });

  it("filters by predicate and by dst_kind", () => {
    expect(run('from edges where predicate == "references"').hits.length).toBe(4);
    expect(run('from edges where predicate == "related"').hits.length).toBe(1);
    expect(run('from edges where dst_kind == "document"').hits.length).toBe(5); // b(dep), b(ref), missing, c#Intro, c(related)
  });

  it("surfaces the anchor of a fragment link", () => {
    const hits = run('from edges where anchor == "Intro" select p: predicate, dpath: $dst_path').hits;
    expect(hits.length).toBe(1);
    expect(hits[0]!.dpath).toBe("c.md");
  });

  it("finds dangling internal edges (phantom target ⇒ $dst_path IS NULL)", () => {
    // A document-kind edge whose destination does not resolve to a real doc.
    const doc = run('from edges where dst_kind == "document" select dst: $dst, dpath: $dst_path').hits;
    const dangling = doc.filter((h) => h.dpath === null);
    expect(dangling.length).toBe(1);
    expect(String(dangling[0]!.dst)).toContain("missing.md"); // phantom id is path-keyed
  });

  it("reaches the source document's metadata (doc.* reach-through)", () => {
    // every edge whose source doc is a.md: depends_on + 4 links
    expect(run('from edges where $path == "a.md"').hits.length).toBe(5);
    // doc.<key> reach-through resolves against the SOURCE document's frontmatter
    // (a.md carries `depends_on: /b.md`); b.md has no such key.
    expect(run('from edges where doc.depends_on == "/b.md"').hits.length).toBe(5);
  });

  it("hit id is the edge id; path is the source document path", () => {
    const h = run('from edges where predicate == "related"').hits[0]!;
    expect(String(h.id)).toMatch(/^e/);
    expect(h.path).toBe("b.md");
  });

  it("rejects text()/semantic() on edges (no index)", () => {
    expect(() => run('from edges where text("x")')).toThrow(FilterInvalid);
    expect(() => run('from edges where semantic("x") > 0.5')).toThrow(FilterInvalid);
  });
});

describe("doc/block → edges relations", () => {
  it("doc.out_edges collects the edges leaving a document", () => {
    const hits = run(
      'from docs where $path == "a.md" select outs: doc.out_edges collect { p: predicate, k: dst_kind }',
    ).hits;
    const outs = hits[0]!.outs as { p: string; k: string }[];
    expect(outs.length).toBe(5); // depends_on + 4 links (b, external, phantom, c#Intro)
    const preds = outs.map((o) => o.p).sort();
    expect(preds).toEqual(["depends_on", "references", "references", "references", "references"]);
  });

  it("doc.in_edges collects backlink edges, resolving the SOURCE doc via reach-through", () => {
    const hits = run(
      'from docs where $path == "c.md" select ins: doc.in_edges collect { p: predicate, src: $path }',
    ).hits;
    const ins = (hits[0]!.ins as { p: string; src: string }[]).sort((x, y) => x.p.localeCompare(y.p));
    // a → c#Intro (references), b → c (related)
    expect(ins).toEqual([
      { p: "references", src: "a.md" },
      { p: "related", src: "b.md" },
    ]);
  });

  it("doc.out_edges count composes as a where-position predicate", () => {
    expect(run('from docs where doc.out_edges count { where dst_kind == "external" } >= 1').hits
      .map((h) => h.path)).toEqual(["a.md"]);
  });

  it("block.out_edges exposes an individual block's out-edges (src_block populated)", () => {
    // Body-link + inline-field edges are block-grain (src_block populated), so
    // block.out_edges reaches them: a.md's paragraph carries four `references`
    // links, b.md's carries one `related` inline field. The frontmatter
    // depends_on edge is doc-grain (NULL src_block) and is correctly excluded.
    const preds = run('from blocks select es: block.out_edges collect { p: predicate }').hits
      .flatMap((h) => (h.es as { p: string }[]).map((e) => e.p))
      .sort();
    expect(preds).toEqual(["references", "references", "references", "references", "related"].sort());
  });

  it("repo.edges is a root scan", () => {
    expect(run("repo.edges count { }").count).toBe(6); // total open edges
  });
});

describe("predicate-filtered follow (via)", () => {
  it("follow doc.out { via <edge predicate> } restricts the walk to matching edges", () => {
    // plain follow reaches a, b, c (any predicate); via depends_on reaches only a→b.
    // (distinct collapses c's two walk paths a→c and a→b→c to one occurrence.)
    const plain = run('from docs where $path == "a.md" follow distinct doc.out').hits.map((h) => h.path).sort();
    expect(plain).toEqual(["a.md", "b.md", "c.md"]);

    const viaDep = run('from docs where $path == "a.md" follow doc.out { via predicate == "depends_on" }').hits
      .map((h) => h.path).sort();
    expect(viaDep).toEqual(["a.md", "b.md"]); // b has no depends_on out-edge → walk stops
  });

  it("via composes with a successor `where` (edge filter + successor filter)", () => {
    const hits = run(
      'from docs where $path == "a.md" follow doc.out { where $path != "a.md" via predicate == "references" }',
    ).hits.map((h) => h.path).sort();
    // references edges: a→b, a→c; successor where excludes the seed's re-entry only.
    expect(hits).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("via is rejected on non-edge-backed relations", () => {
    expect(() =>
      run('from blocks where type == "paragraph" follow block.children { via predicate == "x" }'),
    ).toThrow(FilterInvalid);
  });
});
