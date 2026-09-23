import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { linksStale } from "./link-health.js";
import { linksRepair } from "../mutate/macros.js";
import { apply } from "../mutate/apply.js";

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-linkhealth-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function save(path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  processCheckpoint(store, repoId, dir, [{ path }]);
}

describe("linksStale (dangling internal link detector)", () => {
  it("reports a dangling doc link, then clears it once the target exists", () => {
    save("a.md", "# A\n\nSee [b](/b.md) for details.\n");

    let health = linksStale(store, repoId);
    expect(health.stale).toHaveLength(1);
    const s = health.stale[0]!;
    expect(s.target).toBe("b.md");
    expect(s.srcPath).toBe("a.md");
    expect(s.reason).toBe("dangling_doc");
    expect(s.predicate).toBe("references");

    // Creating b.md resolves the phantom (adoptPhantoms), so it is no longer stale.
    save("b.md", "# B\n");
    save("a.md", "# A\n\nSee [b](/b.md) for details still.\n");
    health = linksStale(store, repoId);
    expect(health.stale).toHaveLength(0);
  });

  it("counts external links but never marks them stale", () => {
    save("ext.md", "# Ext\n\nSee <https://example.com/page> for more.\n");
    const health = linksStale(store, repoId);
    expect(health.stale).toHaveLength(0);
    expect(health.externalCount).toBeGreaterThanOrEqual(1);
  });

  it("scopes source docs by pathGlob", () => {
    save("journal/day1.md", "# Day 1\n\nlink to [gone](/missing-j.md)\n");
    save("guides/setup.md", "# Setup\n\nlink to [gone](/missing-g.md)\n");

    const scoped = linksStale(store, repoId, { pathGlob: "journal/*" });
    expect(scoped.stale).toHaveLength(1);
    expect(scoped.stale[0]!.srcPath).toBe("journal/day1.md");
    expect(scoped.stale[0]!.target).toBe("missing-j.md");

    const all = linksStale(store, repoId);
    expect(all.stale.map((s) => s.target).sort()).toEqual(["missing-g.md", "missing-j.md"]);
  });

  it("truncates and flags when over the limit", () => {
    save("many.md", "# Many\n\n[a](/x1.md)\n\n[b](/x2.md)\n\n[c](/x3.md)\n");
    const health = linksStale(store, repoId, { limit: 2 });
    expect(health.stale).toHaveLength(2);
    expect(health.truncated).toBe(true);
  });

  it("skips dangling links from a tombstoned source doc", () => {
    save("gone.md", "# Gone\n\nlink to [missing](/nope.md)\n");
    expect(linksStale(store, repoId).stale).toHaveLength(1);
    // Delete gone.md on disk and re-checkpoint → tombstone.
    rmSync(join(dir, "gone.md"));
    processCheckpoint(store, repoId, dir, [{ path: "gone.md" }]);
    expect(linksStale(store, repoId).stale).toHaveLength(0);
  });
});

describe("linksRepair (bulk stale-link fix)", () => {
  it("dry-run previews without committing; a real run rewrites and re-resolves", () => {
    save("c.md", "# C\n");
    save("a.md", "# A\n\nSee [b](/b.md).\n");
    expect(linksStale(store, repoId).stale.map((s) => s.target)).toEqual(["b.md"]);

    // Dry run: hits present, nothing written yet.
    const { ops, hits } = linksRepair(store, repoId, [{ from: "/b.md", to: "/c.md" }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.newRaw).toContain("/c.md");
    expect(linksStale(store, repoId).stale.map((s) => s.target)).toEqual(["b.md"]);

    // Commit the ops → block raw rewritten, edge re-resolves to the real c.md.
    apply(store, { repoId, rootPath: dir, ops, origin: { actor: "test", reason: "links_repair" } });
    expect(linksStale(store, repoId).stale).toHaveLength(0);
  });

  it("applies a batch of repairs in one pass", () => {
    save("c.md", "# C\n");
    save("d.md", "# D\n");
    save("a.md", "# A\n\nlink [x](/x.md) and [y](/y.md)\n");
    expect(linksStale(store, repoId).stale.map((s) => s.target).sort()).toEqual(["x.md", "y.md"]);

    const { ops, hits } = linksRepair(store, repoId, [
      { from: "/x.md", to: "/c.md" },
      { from: "/y.md", to: "/d.md" },
    ]);
    // Both rewrites land on the same block → one coalesced op.
    expect(ops).toHaveLength(1);
    expect(hits[0]!.newRaw).toContain("/c.md");
    expect(hits[0]!.newRaw).toContain("/d.md");
    apply(store, { repoId, rootPath: dir, ops, origin: { actor: "test", reason: "links_repair" } });
    expect(linksStale(store, repoId).stale).toHaveLength(0);
  });
});

describe("linksStale reports the destination AS AUTHORED next to the canonical target", () => {
  it("`authored` is the exact destination text (fragment included); `target` stays the canonical path", () => {
    save("a.md", "# A\n\nSee [b](/b.md#Setup) and [[wiki-page]].\n");
    const { stale } = linksStale(store, repoId);
    const byTarget = new Map(stale.map((s) => [s.target, s]));
    expect(byTarget.get("b.md")).toMatchObject({ target: "b.md", anchor: "Setup", authored: "/b.md#Setup" });
    expect(byTarget.get("wiki-page")).toMatchObject({ target: "wiki-page", anchor: null, authored: "wiki-page" });
  });

  it("a relative destination canonicalizes against the source dir but is reported as written", () => {
    save("sub/a.md", "# A\n\nSee [x](./x.md).\n");
    const { stale } = linksStale(store, repoId);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ target: "sub/x.md", authored: "./x.md" });
  });

  it("either `target` or `authored` is a valid links_repair `from`", () => {
    save("c.md", "# C\n");
    save("a.md", "# A\n\nSee [b](/b.md).\n");
    const s = linksStale(store, repoId).stale[0]!;
    expect(s.target).toBe("b.md");
    expect(s.authored).toBe("/b.md");
    const viaTarget = linksRepair(store, repoId, [{ from: s.target, to: "/c.md" }]);
    const viaAuthored = linksRepair(store, repoId, [{ from: s.authored!, to: "/c.md" }]);
    expect(viaTarget.hits.map((h) => h.newRaw)).toEqual(viaAuthored.hits.map((h) => h.newRaw));
    expect(viaTarget.hits[0]!.newRaw).toContain("[b](/c.md)");
    apply(store, { repoId, rootPath: dir, ops: viaAuthored.ops, origin: { actor: "test" } });
    expect(linksStale(store, repoId).stale).toHaveLength(0);
  });
});
