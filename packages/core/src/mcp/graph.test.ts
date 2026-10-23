import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { graphNeighborhood } from "./graph.js";
import { EngineError } from "./errors.js";
import "../format/index.js";

// `graph` is a MACRO over OQX `follow _out_links { from _dst }` /
// `_in_links { from _doc }` — it compiles args into a
// follow query and runs it through the shared runner. Edges are populated by the
// sync path (extraction + resolution + maintainEdges), so these tests write real
// files and run processCheckpoint, exactly like follow-graph.test.ts.

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-graph-"));
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
function graph(args: Parameters<typeof graphNeighborhood>[2]) {
  return graphNeighborhood(store, repoId, args);
}

// A small corpus exercising every edge shape the macro must surface:
//   a → b : depends_on (frontmatter) + references (link)
//   a → external https://example.com/x : references (link, dst_kind external)
//   a → /missing.md : references (link, PHANTOM — dangling doc target)
//   b → c : references (link)
//   c → a : references (link)  [closes a cycle a→b→c→a]
//   d → a : references (link)  [an inbound-only neighbor of a]
beforeEach(() => {
  save(
    "a.md",
    "---\ndepends_on: /b.md\n---\n# A\n\nSee [b](/b.md), [ext](https://example.com/x), [gone](/missing.md).\n",
  );
  save("b.md", "# B\n\nSee [c](/c.md).\n");
  save("c.md", "# C\n\nBack to [a](/a.md).\n");
  save("d.md", "# D\n\nOnly [a](/a.md).\n");
});

describe("graph — neighborhood macro over OQX follow", () => {
  it("delegates: the generated query is an OQX `follow _out_links { from _dst }`", async () => {
    const r = await graph({ roots: ["a.md"], degrees: 1, direction: "out" });
    expect(r.queries).toHaveLength(1);
    expect(r.queries[0]).toContain("follow distinct _out_links { from _dst depth 2 }");
    expect(r.queries[0]).toMatch(/^docs \{ _depth: \$depth, .* where _id == "d_/);
  });

  it("degrees 0 — roots only (no hops); roots are the frontier", async () => {
    const r = await graph({ roots: ["a.md"], degrees: 0, direction: "out" });
    expect(r.documents.map((d) => d._path)).toEqual(["/a.md"]);
    expect(r.documents[0]!.degree).toBe(0);
    expect(r.documents[0]!.frontier).toBe(true);
    expect(r.frontier.map((f) => f._path)).toEqual(["/a.md"]);
    // depth 1 walk ⇒ seed only.
    expect(r.queries[0]).toContain("{ from _dst depth 1 }");
  });

  it("1-hop out — reaches directly linked docs; frontier is the outer ring", async () => {
    const r = await graph({ roots: ["a.md"], degrees: 1, direction: "out" });
    expect(r.documents.map((d) => d._path).sort()).toEqual(["/a.md", "/b.md"]);
    const a = r.documents.find((d) => d._path === "/a.md")!;
    const b = r.documents.find((d) => d._path === "/b.md")!;
    expect(a.degree).toBe(0);
    expect(a.frontier).toBe(false);
    expect(b.degree).toBe(1);
    expect(b.frontier).toBe(true);
    expect(r.frontier.map((f) => f._path)).toEqual(["/b.md"]);
  });

  it("2-hop out — walks the citation chain a → b → c", async () => {
    const r = await graph({ roots: ["a.md"], degrees: 2, direction: "out" });
    expect(r.documents.map((d) => d._path).sort()).toEqual(["/a.md", "/b.md", "/c.md"]);
    expect(r.documents.find((d) => d._path === "/c.md")!.degree).toBe(2);
    expect(r.frontier.map((f) => f._path)).toEqual(["/c.md"]);
  });

  it("1-hop in — reaches backlinks (docs that link TO the root)", async () => {
    // c → a and d → a link to a.
    const r = await graph({ roots: ["a.md"], degrees: 1, direction: "in" });
    expect(r.documents.map((d) => d._path).sort()).toEqual(["/a.md", "/c.md", "/d.md"]);
    expect(r.queries[0]).toContain("follow distinct _in_links { from _doc depth 2 }");
  });

  it("both directions — unions out and in neighbors", async () => {
    const r = await graph({ roots: ["a.md"], degrees: 1, direction: "both" });
    // out: b ; in: c, d ; plus the root a.
    expect(r.documents.map((d) => d._path).sort()).toEqual(["/a.md", "/b.md", "/c.md", "/d.md"]);
    expect(r.queries).toHaveLength(2);
    expect(r.queries[0]).toContain("_out_links { from _dst depth 2 }");
    expect(r.queries[1]).toContain("_in_links { from _doc depth 2 }");
  });

  it("edges carry provenance and preserve external + phantom endpoints", async () => {
    const r = await graph({ roots: ["a.md"], degrees: 1, direction: "out" });
    const byKind = (k: string) => r.links.filter((e) => e._dst_kind === k);

    // a → b appears twice: a depends_on (frontmatter) + a references (link).
    const toB = r.links.filter((e) => e._dst_path === "/b.md");
    expect(toB.map((e) => e._predicate).sort()).toEqual(["depends_on", "references"]);
    expect(toB.map((e) => e._provenance).sort()).toEqual(["frontmatter", "link"]);

    // External endpoint is NOT dropped — surfaced as an edge stub with its URI.
    const ext = byKind("external");
    expect(ext).toHaveLength(1);
    expect(ext[0]!._uri).toBe("https://example.com/x");
    expect(ext[0]!._dst_id).toMatch(/^x_/);
    expect(ext[0]!._dst_path).toBeNull();

    // Phantom (dangling internal) endpoint is preserved: dst_kind document, null path.
    const phantom = r.links.filter((e) => e._dst_kind === "document" && e._dst_path === null);
    expect(phantom).toHaveLength(1);
    expect(String(phantom[0]!._dst_id)).toContain("missing.md");
  });

  it("induced-subgraph: frontier out-edges to non-reached docs are dropped", async () => {
    // degrees 1 out reaches a, b. b → c is NOT traversed (c beyond the boundary),
    // so no edge to c.md is kept (but a's external/phantom stubs remain).
    const r = await graph({ roots: ["a.md"], degrees: 1, direction: "out" });
    expect(r.links.some((e) => e._dst_path === "/c.md")).toBe(false);
  });

  // `predicate` restricts the NEIGHBORHOOD to predicate-reachable docs (recomputed
  // over the walk's collected edges; no `via` clause emitted). a → b is the only
  // depends_on edge and b has no depends_on out-edge, so c (reached only via
  // `references`) is correctly excluded.
  it("predicate filter — restricts the neighborhood to predicate-reachable docs", async () => {
    const r = await graph({ roots: ["a.md"], degrees: 2, direction: "out", predicate: "depends_on" });
    expect(r.queries[0]).not.toMatch(/\bvia\b(?!_id)/); // no via clause is emitted (`_via_id` is a projected edge field)
    expect(r.documents.map((d) => d._path).sort()).toEqual(["/a.md", "/b.md"]);
    expect(r.links).toHaveLength(1);
    expect(r.links[0]!._predicate).toBe("depends_on");
    expect(r.links[0]!._dst_path).toBe("/b.md");
    // c is reachable only via `references`, so it is NOT in a depends_on neighborhood.
    expect(r.documents.map((d) => d._path)).not.toContain("/c.md");
  });

  it("select — projects extra document fields", async () => {
    const r = await graph({ roots: ["a.md"], degrees: 1, direction: "out", select: ["_path"] });
    const a = r.documents.find((d) => d._path === "/a.md")!;
    expect(a._path).toBe("/a.md"); // a `_path` selection collapses onto the envelope key
    expect(Object.keys(a)).toEqual(["_id", "_path", "degree", "frontier"]);
    expect(r.queries[0]).toContain("_u0: _path");
  });

  it("max_documents — caps the distinct set and reports truncation", async () => {
    const r = await graph({ roots: ["a.md"], degrees: 8, direction: "both", max_documents: 2 });
    expect(r.documents).toHaveLength(2);
    expect(r.truncated).toBe(true);
    // roots come first (nearest), so a.md is always kept.
    expect(r.documents.map((d) => d._path)).toContain("/a.md");
    // edges never reference a doc that was capped out of the set.
    const ids = new Set(r.documents.map((d) => d._id));
    for (const e of r.links) {
      const dangling = e._dst_kind === "external" || (e._dst_kind === "document" && e._dst_path === null);
      expect(ids.has(e._doc_id)).toBe(true);
      expect(ids.has(e._dst_id) || dangling).toBe(true);
    }
  });

  it("cyclic-safe: a→b→c→a resolves without looping (follow's cycle guard)", async () => {
    const r = await graph({ roots: ["a.md"], degrees: 8, direction: "out" });
    // Distinct nodes only, one entry per document despite the a→b→c→a cycle.
    expect(r.documents.map((d) => d._path).sort()).toEqual(["/a.md", "/b.md", "/c.md"]);
    expect(r.documents.filter((d) => d._path === "/a.md")).toHaveLength(1);
  });

  it("multiple roots + id refs — both seed the same walk", async () => {
    const aId = store.db.prepare("SELECT doc_id FROM docs WHERE path = 'a.md'").get() as { doc_id: string };
    const r = await graph({ roots: [aId.doc_id, "d.md"], degrees: 0, direction: "out" });
    expect(r.roots).toContain(aId.doc_id);
    expect(r.documents.map((d) => d._path).sort()).toEqual(["/a.md", "/d.md"]);
  });

  it("empty roots is a loud error, never a silent empty result", async () => {
    await expect(graph({ roots: [] })).rejects.toBeInstanceOf(EngineError);
  });

  it("an unresolvable root throws doc_missing", async () => {
    await expect(graph({ roots: ["nope.md"] })).rejects.toMatchObject({ code: "doc_missing" });
  });
});
