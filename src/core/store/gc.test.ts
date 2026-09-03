import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { ensureRepo } from "../attach.js";
import { processCheckpoint } from "../../sync/checkpoint.js";
import { runGc, sweepResurrectionPool } from "./gc.js";
import { rebuildIndex } from "./rebuild.js";

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-gc-"));
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
function count(table: string): number {
  return (store.db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;
}

describe("GC (flag-gated, off by default)", () => {
  it("is a no-op when disabled (v1.0 default)", () => {
    save("a.md", "# A\n\nbody one\n\nbody two\n");
    const before = { blobs: count("blobs"), trees: count("tree_nodes") };
    const res = runGc(store); // enabled defaults false
    expect(res).toEqual({ blobsSwept: 0, treeNodesSwept: 0 });
    expect(count("blobs")).toBe(before.blobs);
    expect(count("tree_nodes")).toBe(before.trees);
  });

  it("keeps everything reachable from revision roots when enabled (append-only ⇒ no sweep)", () => {
    save("a.md", "# A\n\nbody one\n");
    save("a.md", "# A\n\nbody one edited\n\nbody two added\n"); // second revision
    const before = { blobs: count("blobs"), trees: count("tree_nodes") };
    const res = runGc(store, { enabled: true });
    // All revisions are still live (never pruned), so nothing is unreachable.
    expect(res.blobsSwept).toBe(0);
    expect(res.treeNodesSwept).toBe(0);
    expect(count("blobs")).toBe(before.blobs);

    // Derived tables still rebuild equivalently after GC.
    const secs = store.db.prepare("SELECT * FROM sections ORDER BY 1,2").all();
    store.db.prepare("DELETE FROM sections").run();
    rebuildIndex(store, "sections");
    expect(store.db.prepare("SELECT * FROM sections ORDER BY 1,2").all()).toEqual(secs);
  });

  it("sweeps expired resurrection-pool rows", () => {
    save("a.md", "# A\n\nkeep this paragraph forever please and ever\n\ndelete this whole paragraph soon\n");
    save("a.md", "# A\n\nkeep this paragraph forever please and ever\n"); // deletes 2nd para → pool
    expect(count("resurrection_pool")).toBeGreaterThanOrEqual(1);
    // Nothing expired yet (default TTL 30d).
    expect(sweepResurrectionPool(store, "2000-01-01T00:00:00.000Z")).toBe(0);
    // Far-future sweep expires everything.
    const swept = sweepResurrectionPool(store, "2999-01-01T00:00:00.000Z");
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(count("resurrection_pool")).toBe(0);
  });
});
