import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { attachRepo } from "./attach.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-attach-"));
  store = new Store({ path: ":memory:" });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("attachRepo (sync) extracts edges on the initial walk", () => {
  it("ingests all files with convergence and populates edges", () => {
    writeFileSync(join(dir, "a.md"), "# A\n\nlinks to [b](/b.md)\n");
    writeFileSync(join(dir, "b.md"), "# B\n\nleaf\n");
    const res = attachRepo(store, "t", dir);
    expect(res.fileCount).toBe(2);
    expect(res.allConverged).toBe(true);
    const edges = store.db.prepare("SELECT count(*) c FROM edges WHERE to_commit IS NULL").get() as { c: number };
    expect(edges.c).toBeGreaterThanOrEqual(1);
  });
});
