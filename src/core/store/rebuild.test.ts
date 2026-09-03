import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { ensureRepo } from "../attach.js";
import { processCheckpoint } from "../../sync/checkpoint.js";
import { rebuildIndex } from "./rebuild.js";

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-rebuild-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(): void {
  writeFileSync(join(dir, "a.md"), "# Doc\n\n## Section One\n\nbody with a [link](/b.md)\n\n- [ ] a task\n\n## Section Two\n\nmore body text here\n");
  writeFileSync(join(dir, "b.md"), "# B\n\nreferences [a](/a.md)\n");
  processCheckpoint(store, repoId, dir, [{ path: "a.md" }, { path: "b.md" }]);
}

function snapshot(table: string): unknown[] {
  return store.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).all();
}
function ftsCount(): number {
  return (store.db.prepare("SELECT count(*) c FROM blocks_fts").get() as { c: number }).c;
}

describe("rebuild-index — drop-and-rebuild equivalence (02 §6, invariant #8)", () => {
  it("sections rebuild byte-identically", () => {
    seed();
    const before = snapshot("sections");
    store.db.prepare("DELETE FROM sections").run();
    rebuildIndex(store, "sections");
    expect(snapshot("sections")).toEqual(before);
  });

  it("doc_edges rebuild byte-identically", () => {
    seed();
    const before = snapshot("doc_edges");
    store.db.prepare("DELETE FROM doc_edges").run();
    rebuildIndex(store, "edges");
    expect(snapshot("doc_edges")).toEqual(before);
  });

  it("block_changes rebuild from dispositions byte-identically", () => {
    seed();
    const before = snapshot("block_changes");
    store.db.prepare("DELETE FROM block_changes").run();
    rebuildIndex(store, "block_changes");
    expect(snapshot("block_changes")).toEqual(before);
  });

  it("fts rebuilds and still matches queries", () => {
    seed();
    const before = ftsCount();
    store.db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('delete-all')");
    rebuildIndex(store, "fts");
    expect(ftsCount()).toBe(before);
    const hit = store.db.prepare("SELECT count(*) c FROM blocks_fts WHERE blocks_fts MATCH 'task'").get() as { c: number };
    expect(hit.c).toBeGreaterThan(0);
  });

  it("rebuild all leaves every derived table equivalent", () => {
    seed();
    const secs = snapshot("sections");
    const edges = snapshot("doc_edges");
    const changes = snapshot("block_changes");
    store.db.prepare("DELETE FROM sections").run();
    store.db.prepare("DELETE FROM doc_edges").run();
    store.db.prepare("DELETE FROM block_changes").run();
    rebuildIndex(store, "all");
    expect(snapshot("sections")).toEqual(secs);
    expect(snapshot("doc_edges")).toEqual(edges);
    expect(snapshot("block_changes")).toEqual(changes);
  });
});
