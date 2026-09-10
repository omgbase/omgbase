import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { attachRepo } from "./attach.js";
import { rebuildFileStats, freshnessSweep, detectDiskDrift } from "./freshness.js";
import { reposStatus, syncStatus } from "./admin.js";

let store: Store | undefined;
let dir: string | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function setup(): { store: Store; root: string; repoId: string } {
  dir = mkdtempSync(join(tmpdir(), "omg-admin-"));
  const root = join(dir, "vault");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.md"), "# A\n\nalpha paragraph\n");
  writeFileSync(join(root, "b.md"), "# B\n\nbeta paragraph\n");
  store = new Store({ path: ":memory:" });
  const { repoId } = attachRepo(store, "vault", root);
  rebuildFileStats(store, repoId, root);
  return { store, root, repoId };
}

/** Bump mtime into the future so the stat-cheap change detector treats it as a candidate. */
function bumpMtime(abs: string): void {
  const future = Date.now() / 1000 + 5;
  utimesSync(abs, future, future);
}

describe("reposStatus / syncStatus disk drift", () => {
  it("clean repo: convergent true, all drift counts 0, diskChecked true", () => {
    const { store, root, repoId } = setup();
    const rs = reposStatus(store, repoId, root);
    expect(rs.unconverged).toBe(0);
    expect(rs.disk).toEqual({ changed: 0, deleted: 0, untracked: 0, checked: true });

    const ss = syncStatus(store, repoId, root);
    expect(ss.convergent).toBe(true);
    expect(ss.diskChecked).toBe(true);
    expect(ss.disk).toEqual({ changed: 0, deleted: 0, untracked: 0, checked: true });
  });

  // HEADLINE BUG: a file deleted on disk but not yet re-ingested must flip the
  // green light to red. Previously this reported convergent: true (stale served).
  it("file deleted on disk (not ingested): deleted>=1 and convergent false", () => {
    const { store, root, repoId } = setup();
    unlinkSync(join(root, "a.md"));

    const rs = reposStatus(store, repoId, root);
    expect(rs.disk.deleted).toBeGreaterThanOrEqual(1);
    expect(rs.unconverged).toBe(0); // DB-internal signal is still (misleadingly) clean

    const ss = syncStatus(store, repoId, root);
    expect(ss.convergent).toBe(false);
    expect(ss.disk.deleted).toBeGreaterThanOrEqual(1);
  });

  it("file edited on disk (not ingested): changed>=1 and convergent false", () => {
    const { store, root, repoId } = setup();
    writeFileSync(join(root, "a.md"), "# A\n\nEDITED alpha paragraph\n");
    bumpMtime(join(root, "a.md"));

    const rs = reposStatus(store, repoId, root);
    expect(rs.disk.changed).toBeGreaterThanOrEqual(1);

    const ss = syncStatus(store, repoId, root);
    expect(ss.convergent).toBe(false);
    expect(ss.disk.changed).toBeGreaterThanOrEqual(1);
  });

  it("new *.md on disk (not ingested): untracked>=1 and convergent false", () => {
    const { store, root, repoId } = setup();
    writeFileSync(join(root, "c.md"), "# C\n\ngamma\n");

    const rs = reposStatus(store, repoId, root);
    expect(rs.disk.untracked).toBeGreaterThanOrEqual(1);

    const ss = syncStatus(store, repoId, root);
    expect(ss.convergent).toBe(false);
    expect(ss.disk.untracked).toBeGreaterThanOrEqual(1);
  });

  it("touch-only (mtime bumped, content identical) is NOT drift", () => {
    const { store, root, repoId } = setup();
    bumpMtime(join(root, "a.md")); // same bytes

    const rs = reposStatus(store, repoId, root);
    expect(rs.disk).toEqual({ changed: 0, deleted: 0, untracked: 0, checked: true });
    expect(syncStatus(store, repoId, root).convergent).toBe(true);
  });

  it("no rootPath: convergence is NOT reported true on the DB signal alone", () => {
    const { store, repoId } = setup();
    const rs = reposStatus(store, repoId); // no path
    expect(rs.disk.checked).toBe(false);
    expect(rs.unconverged).toBe(0);

    const ss = syncStatus(store, repoId); // no path
    // Disk agreement is unverified => must not be a bare green light.
    expect(ss.diskChecked).toBe(false);
    expect(ss.convergent).toBe(false);
  });

  // processCheckpoint/freshnessSweep now reconcile an observed deletion: the
  // sweep tombstones the doc (docs.deleted_commit set), so the disk-drift detector
  // stops counting the gone file and convergence returns to true. Before the fix
  // the doc row stayed live forever — a queryable ghost for a file that's gone.
  it("freshnessSweep reconciles a deletion: doc tombstoned, drift clears, convergent", () => {
    const { store, root, repoId } = setup();
    unlinkSync(join(root, "a.md"));
    expect(syncStatus(store, repoId, root).convergent).toBe(false);

    freshnessSweep(store, repoId, root);

    // The doc for the deleted file is now tombstoned (deleted_commit set) and no
    // longer served by the live-docs query.
    const live = store.db
      .prepare("SELECT doc_id FROM docs WHERE repo_id = ? AND path = 'a.md' AND deleted_commit IS NULL")
      .get(repoId);
    expect(live).toBeUndefined();
    const tombstoned = store.db
      .prepare("SELECT deleted_commit FROM docs WHERE repo_id = ? AND path = 'a.md'")
      .get(repoId) as { deleted_commit: string | null };
    expect(tombstoned.deleted_commit).not.toBeNull();

    // Disk drift clears and the green light returns.
    expect(detectDiskDrift(store, repoId, root).deleted).toBe(0);
    expect(reposStatus(store, repoId, root).disk.deleted).toBe(0);
    expect(syncStatus(store, repoId, root).convergent).toBe(true);
  });

  it("freshnessSweep reconciles an edit: status returns to convergent", () => {
    const { store, root, repoId } = setup();
    writeFileSync(join(root, "a.md"), "# A\n\nEDITED\n");
    bumpMtime(join(root, "a.md"));
    expect(syncStatus(store, repoId, root).convergent).toBe(false);

    freshnessSweep(store, repoId, root);

    expect(syncStatus(store, repoId, root).convergent).toBe(true);
    expect(reposStatus(store, repoId, root).disk.changed).toBe(0);
  });
});
