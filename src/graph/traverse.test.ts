import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { graphTraverse, graphPath, graphSubgraph } from "./traverse.js";

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-trav-"));
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
function docId(path: string): string {
  return (store.db.prepare("SELECT doc_id FROM documents WHERE path=?").get(path) as { doc_id: string }).doc_id;
}

describe("graph_traverse", () => {
  beforeEach(() => {
    // a → b → c chain of doc references; c → d.
    save("a.md", "# A\n\nlinks to [b](/b.md)\n");
    save("b.md", "# B\n\nlinks to [c](/c.md)\n");
    save("c.md", "# C\n\nlinks to [d](/d.md)\n");
    save("d.md", "# D\n\nleaf\n");
  });

  it("expands the out-frontier to a given depth", () => {
    const res = graphTraverse(store, { from: [docId("a.md")], via: ["references"], direction: "out", depth: 3 });
    // a reaches b, c, d
    expect(res.nodes).toContain(docId("b.md"));
    expect(res.nodes).toContain(docId("c.md"));
    expect(res.nodes).toContain(docId("d.md"));
  });

  it("respects depth = 1 (only immediate neighbors)", () => {
    const res = graphTraverse(store, { from: [docId("a.md")], via: ["references"], direction: "out", depth: 1 });
    expect(res.nodes).toContain(docId("b.md"));
    expect(res.nodes).not.toContain(docId("c.md"));
  });

  it("direction:in finds backlinks", () => {
    const res = graphTraverse(store, { from: [docId("c.md")], via: ["references"], direction: "in", depth: 1 });
    // b references c → b is a backlink source
    expect(res.nodes).toContain(docId("b.md"));
  });

  it("enforces the node budget and flags truncation", () => {
    const res = graphTraverse(store, { from: [docId("a.md")], via: ["references"], direction: "out", depth: 8, budget: { maxNodes: 2 } });
    expect(res.truncated).toBe(true);
    expect(res.nodes.length).toBeLessThanOrEqual(2);
  });
});

describe("graph_path", () => {
  beforeEach(() => {
    save("a.md", "# A\n\n[b](/b.md)\n");
    save("b.md", "# B\n\n[c](/c.md)\n");
    save("c.md", "# C\n\nleaf\n");
  });
  it("finds a shortest path a → c", () => {
    const { paths } = graphPath(store, { from: docId("a.md"), to: docId("c.md"), via: ["references"], direction: "out", maxLen: 4 });
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(paths[0]![0]).toBe(docId("a.md"));
    expect(paths[0]![paths[0]!.length - 1]).toBe(docId("c.md"));
  });
});

describe("temporal traversal (as_of)", () => {
  it("excludes an edge that was later removed when querying at its removal", () => {
    save("a.md", "# A\n\n[b](/b.md)\n");
    save("b.md", "# B\n");
    const beforeSeq = (store.db.prepare("SELECT MAX(seq) s FROM commits").get() as { s: number }).s;
    // Remove the link.
    save("a.md", "# A\n\nno link now\n");

    // as_of the earlier commit: edge present.
    const past = graphTraverse(store, { from: [docId("a.md")], via: ["references"], direction: "out", depth: 1, asOf: beforeSeq });
    expect(past.nodes).toContain(docId("b.md"));
    // current: edge gone.
    const now = graphTraverse(store, { from: [docId("a.md")], via: ["references"], direction: "out", depth: 1 });
    expect(now.nodes).not.toContain(docId("b.md"));
  });
});

describe("graph_subgraph", () => {
  it("returns the induced neighborhood around a seed", () => {
    save("a.md", "# A\n\n[b](/b.md)\n");
    save("b.md", "# B\n\n[c](/c.md)\n");
    save("c.md", "# C\n");
    const res = graphSubgraph(store, { seeds: [docId("b.md")], via: ["references"], radius: 1 });
    // b's neighborhood includes a (in) and c (out)
    expect(res.nodes).toContain(docId("a.md"));
    expect(res.nodes).toContain(docId("c.md"));
  });
});
