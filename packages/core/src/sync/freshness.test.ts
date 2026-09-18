import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ingestDirectory } from "./attach.js";
import { freshnessSweep, rebuildFileStats } from "./freshness.js";

let store: Store | undefined;
let dir: string | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function setup(): { store: Store; root: string; repoId: string } {
  dir = mkdtempSync(join(tmpdir(), "omg-fresh-"));
  const root = join(dir, "vault");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.md"), "# A\n\nalpha paragraph\n");
  store = new Store({ path: ":memory:" });
  const { repoId } = ingestDirectory(store, "vault", root);
  // Prime the stat cache so subsequent sweeps have a baseline.
  rebuildFileStats(store, repoId, root);
  return { store, root, repoId };
}

describe("freshnessSweep", () => {
  it("no-op when nothing changed on disk", () => {
    const { store, root, repoId } = setup();
    const res = freshnessSweep(store, repoId, root);
    expect(res.changed).toBe(false);
    expect(res.ingested).toEqual([]);
    expect(res.scanned).toBe(1);
  });

  it("picks up an out-of-band edit (content changed)", () => {
    const { store, root, repoId } = setup();
    const before = store.db.prepare("SELECT text FROM blocks WHERE type='paragraph'").get() as { text: string };
    expect(before.text).toContain("alpha");

    // Edit the file directly, bumping mtime.
    writeFileSync(join(root, "a.md"), "# A\n\nbeta paragraph\n");
    const future = Date.now() / 1000 + 5;
    utimesSync(join(root, "a.md"), future, future);

    const res = freshnessSweep(store, repoId, root);
    expect(res.changed).toBe(true);
    expect(res.ingested).toContain("a.md");
    const after = store.db.prepare("SELECT text FROM blocks WHERE type='paragraph'").get() as { text: string };
    expect(after.text).toContain("beta");
  });

  it("detects a new file and a deletion", () => {
    const { store, root, repoId } = setup();
    writeFileSync(join(root, "b.md"), "# B\n\nbee\n");
    const addRes = freshnessSweep(store, repoId, root);
    expect(addRes.ingested).toContain("b.md");

    unlinkSync(join(root, "a.md"));
    const delRes = freshnessSweep(store, repoId, root);
    expect(delRes.deleted).toContain("a.md");
  });

  it("does not re-ingest when only mtime changes but content is identical", () => {
    const { store, root, repoId } = setup();
    const future = Date.now() / 1000 + 10;
    utimesSync(join(root, "a.md"), future, future); // touch, same bytes
    const res = freshnessSweep(store, repoId, root);
    expect(res.ingested).toEqual([]);
    expect(res.changed).toBe(false);
  });
});
