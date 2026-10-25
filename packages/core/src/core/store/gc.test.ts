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
    expect(res).toEqual({ blobsSwept: 0, treeNodesSwept: 0, sameDispositionsSwept: 0, claimsReleased: 0 });
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

  it("sweeps the `same` disposition rows a 14.1 store wrote, from both tables, and a dry run only counts (spec/store §7, 14.2)", () => {
    save("a.md", "# A\n\nkeep this paragraph forever please and ever\n\nand this one too, edited later on\n");
    save("a.md", "# A\n\nkeep this paragraph forever please and ever\n\nand this one too, edited later on today\n");
    // A 14.2 store never writes `same`; the sweep has nothing to do.
    expect(count("dispositions")).toBe(4); // 3 inserted + 1 edited
    expect(runGc(store, { enabled: true })).toEqual({ blobsSwept: 0, treeNodesSwept: 0, sameDispositionsSwept: 0, claimsReleased: 0 });
    // What a 14.1 store would have persisted for the two untouched blocks under the second commit.
    const c1 = (store.db.prepare("SELECT commit_id FROM commits WHERE seq = 2").get() as { commit_id: string }).commit_id;
    const untouched = (store.db.prepare("SELECT block_id FROM blocks WHERE deleted_at IS NULL ORDER BY ordinal LIMIT 2").all() as { block_id: string }[]).map((r) => r.block_id);
    for (const id of untouched) {
      store.db.prepare("INSERT INTO dispositions (commit_id, block_id, kind, confidence, reason, matcher_v, detail) VALUES (?, ?, 'same', 1, 'exact_hash', 'm2.3', '{}')").run(c1, id);
      store.db.prepare("INSERT INTO block_changes (block_id, commit_id, kind) VALUES (?, ?, 'same')").run(id, c1);
    }
    expect(runGc(store, { enabled: true, dryRun: true })).toEqual({ blobsSwept: 0, treeNodesSwept: 0, sameDispositionsSwept: 2, claimsReleased: 0 });
    expect(count("dispositions")).toBe(6); // the dry run deleted nothing
    expect(runGc(store, { enabled: true })).toEqual({ blobsSwept: 0, treeNodesSwept: 0, sameDispositionsSwept: 2, claimsReleased: 0 });
    expect(count("dispositions")).toBe(4);
    expect(store.db.prepare("SELECT count(*) c FROM block_changes WHERE kind = 'same'").get()).toEqual({ c: 0 });
    // I8: block_changes still equals its rebuild out of dispositions.
    const before = store.db.prepare("SELECT * FROM block_changes ORDER BY 1,2,3").all();
    rebuildIndex(store, "block_changes");
    expect(store.db.prepare("SELECT * FROM block_changes ORDER BY 1,2,3").all()).toEqual(before);
    expect(runGc(store, { enabled: true }).sameDispositionsSwept).toBe(0);
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
