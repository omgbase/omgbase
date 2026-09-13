import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { oqxRun } from "./run.js";
import "../format/index.js";

// `follow doc.out` / `doc.in` recurse the authored EDGE graph (doc→doc), which
// is cross-document and may CYCLE. Edges are populated by the sync path
// (extraction + link resolution + maintainEdges), so these tests write real
// files and run processCheckpoint — plain ingestFile does not extract edges.

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-follow-graph-"));
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

// A cyclic citation graph via markdown links: a → b → c → a, plus a → d (leaf).
beforeEach(() => {
  save("a.md", "# A\n\nSee [b](/b.md) and [d](/d.md).\n");
  save("b.md", "# B\n\nSee [c](/c.md).\n");
  save("c.md", "# C\n\nBack to [a](/a.md).\n");
  save("d.md", "# D\n\nA leaf note.\n");
});

describe("follow doc.out — outgoing citation graph (cross-document, cyclic)", () => {
  it("resolves markdown links to real doc→doc edges (sanity)", () => {
    const edges = store.db
      .prepare("SELECT src_doc, dst_node, dst_kind FROM edges WHERE to_commit IS NULL AND dst_kind = 'document'")
      .all() as { src_doc: string; dst_node: string; dst_kind: string }[];
    expect(edges.length).toBe(4); // a→b, a→d, b→c, c→a
  });

  it("walks outgoing links across documents and admits a revisit as $stop == 'cycle'", () => {
    const hits = run(
      'from docs where $path == "a.md" select p: $path, d: $depth, s: $stop follow doc.out',
    ).hits;
    // a(1) → b(2), d(2); b → c(3); c → a(4) revisits the seed → cycle, not re-expanded.
    // (a.md appears twice — seed and cycle — so assert on the occurrence list, not a map.)
    const occ = hits.map((h) => `${h.p}@${h.d}:${h.s}`).sort();
    expect(occ).toEqual([
      "a.md@1:interior", "a.md@4:cycle", "b.md@2:interior", "c.md@3:interior", "d.md@2:leaf",
    ]);
    // termination proof: a appears exactly twice (seed@1 + one cycle occurrence@4)
    expect(hits.filter((h) => h.p === "a.md").length).toBe(2);
  });

  it("doc.in walks backlinks (a ← c ← b ← a cycle)", () => {
    const hits = run('from docs where $path == "a.md" select p: $path, d: $depth, s: $stop follow doc.in').hits;
    const occ = hits.map((h) => `${h.p}@${h.d}:${h.s}`).sort();
    expect(occ).toEqual(["a.md@1:interior", "a.md@4:cycle", "b.md@3:interior", "c.md@2:interior"]);
  });

  it("`follow distinct` collapses the cycle; depth 1 keeps only the seed", () => {
    const dist = run('from docs where $path == "a.md" follow distinct doc.out').hits;
    expect(dist.map((h) => h.path).sort()).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    const seedOnly = run('from docs where $path == "a.md" follow doc.out { depth 1 }').hits;
    expect(seedOnly.map((h) => h.path)).toEqual(["a.md"]);
  });

  it("repo.count counts occurrences over the cyclic walk", () => {
    // a(1), b(2), d(2), c(3), a-cycle(4) = 5 occurrences
    expect(run('repo.docs count { where $path == "a.md" follow doc.out }').count).toBe(5);
  });

  it("`by <expr>` changes node identity for cycle detection", () => {
    // g1(group X) → g2(group X) → g3(group Y). By entity id there is no cycle.
    save("g1.md", "---\ngroup: X\n---\n# G1\n\nSee [g2](/g2.md).\n");
    save("g2.md", "---\ngroup: X\n---\n# G2\n\nSee [g3](/g3.md).\n");
    save("g3.md", "---\ngroup: Y\n---\n# G3\n");

    // default identity (doc id): the whole chain is walked, no cycle.
    const byId = run('from docs where $path == "g1.md" select p: $path, s: $stop follow doc.out').hits
      .filter((h) => (h.p as string).startsWith("g"));
    expect(byId.map((h) => h.p).sort()).toEqual(["g1.md", "g2.md", "g3.md"]);
    expect(byId.some((h) => h.s === "cycle")).toBe(false);

    // identity by `group`: g2 shares g1's group (X) → reached as a cycle, so g3
    // (behind g2) is never expanded to.
    const byGroup = run('from docs where $path == "g1.md" select p: $path, s: $stop follow doc.out { by group }').hits
      .filter((h) => (h.p as string).startsWith("g"));
    expect(byGroup.map((h) => h.p).sort()).toEqual(["g1.md", "g2.md"]);
    expect(byGroup.find((h) => h.p === "g2.md")!.s).toBe("cycle");
    expect(byGroup.some((h) => h.p === "g3.md")).toBe(false);
  });
});
