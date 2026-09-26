import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { reconcileChanges, attachSource } from "./driver.js";
import type { SyncSource, SourceCapabilities, SourceEntry, SourceItem } from "./plugin.js";

// The driver is source-agnostic: it reconciles whatever a SyncSource hands back.
// An in-memory source proves the seam works with NO filesystem and NO process —
// enumerate/fetch over a Map, revision = content hash — and that engine
// echo-suppression, deletion, and re-ingest all key off (repoId, path, content).

let store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; });

class MemorySource implements SyncSource {
  constructor(private files: Map<string, string>) {}
  capabilities(): SourceCapabilities { return { identity: "inferred", writeThrough: true, watch: false }; }
  enumerate(): Promise<SourceEntry[]> {
    return Promise.resolve([...this.files].map(([path, content]) => ({ path, revision: rev(content) })));
  }
  fetch(path: string): Promise<SourceItem | null> {
    const content = this.files.get(path);
    return Promise.resolve(content === undefined ? null : { path, revision: rev(content), content });
  }
  close(): Promise<void> { return Promise.resolve(); }
}
function rev(s: string): string { return String(s.length) + ":" + s.slice(0, 8); }

describe("reconcile driver over a non-filesystem source", () => {
  it("attaches + ingests an in-memory source (no node:fs, no process)", async () => {
    store = new Store({ path: ":memory:" });
    const src = new MemorySource(new Map([
      ["a.md", "# A\n\nlinks to [b](/b.md)\n"],
      ["b.md", "# B\n\nleaf\n"],
    ]));
    const res = await attachSource(store, "mem", null, src);
    expect(res.fileCount).toBe(2);
    expect(res.allConverged).toBe(true);
    const edges = store.db.prepare("SELECT count(*) c FROM edges WHERE to_commit IS NULL").get() as { c: number };
    expect(edges.c).toBeGreaterThanOrEqual(1);
  });

  it("ingests, echo-suppresses an unchanged member, and detects a scope removal", async () => {
    store = new Store({ path: ":memory:" });
    const files = new Map([["a.md", "# A\n\nbody\n"]]);
    const src = new MemorySource(files);
    const repoId = ensureRepo(store, "mem", null);

    const first = await reconcileChanges(store, repoId, src, [{ path: "a.md" }]);
    expect(first.ingested).toEqual(["a.md"]);

    const second = await reconcileChanges(store, repoId, src, [{ path: "a.md" }]);
    expect(second.suppressed).toEqual(["a.md"]);
    expect(second.ingested).toEqual([]);

    files.delete("a.md");
    const third = await reconcileChanges(store, repoId, src, [{ path: "a.md" }]);
    expect(third.deleted).toEqual(["a.md"]);
  });

  it("tombstones a member that left the source scope (fetch → null)", async () => {
    store = new Store({ path: ":memory:" });
    const files = new Map([["a.md", "# A\n\nuniquescopeword body\n"]]);
    const src = new MemorySource(files);
    const repoId = ensureRepo(store, "mem", null);
    await reconcileChanges(store, repoId, src, [{ path: "a.md" }]);
    const doc = store.db.prepare("SELECT doc_id FROM docs WHERE path='a.md'").get() as { doc_id: string };

    // Member leaves the scope: fetch now returns null for a.md.
    files.delete("a.md");
    const res = await reconcileChanges(store, repoId, src, [{ path: "a.md" }]);
    expect(res.deleted).toEqual(["a.md"]);

    // Doc + blocks tombstoned; no longer served by the live-docs query.
    const live = store.db.prepare("SELECT doc_id FROM docs WHERE path='a.md' AND deleted_commit IS NULL").get();
    expect(live).toBeUndefined();
    const tombstoned = store.db.prepare("SELECT deleted_commit FROM docs WHERE doc_id=?").get(doc.doc_id) as { deleted_commit: string | null };
    expect(tombstoned.deleted_commit).not.toBeNull();
    const liveBlocks = store.db.prepare("SELECT count(*) c FROM blocks WHERE doc_id=? AND deleted_commit IS NULL").get(doc.doc_id) as { c: number };
    expect(liveBlocks.c).toBe(0);
    // Blocks are pooled for resurrection on re-appearance.
    const pooled = store.db.prepare("SELECT count(*) c FROM resurrection_pool WHERE doc_id=?").get(doc.doc_id) as { c: number };
    expect(pooled.c).toBeGreaterThanOrEqual(1);
  });

  it("carries a block cut from one member and pasted into another in the same batch (cross-doc move)", async () => {
    store = new Store({ path: ":memory:" });
    const P = "the quick brown fox jumps over the lazy dog while the cat watches from the warm kitchen window sill";
    const files = new Map([
      ["a.md", `# A\n\nalpha intro about apples\n\n${P}\n`],
      ["b.md", "# B\n\nbeta intro about boats\n"],
    ]);
    const src = new MemorySource(files);
    const repoId = ensureRepo(store, "mem", null);
    await reconcileChanges(store, repoId, src, [{ path: "a.md" }, { path: "b.md" }]);
    const before = store.db.prepare("SELECT block_id id FROM blocks WHERE text LIKE 'the quick brown fox%' AND deleted_commit IS NULL").get() as { id: string };

    // One watcher batch: the paragraph leaves a.md and lands in b.md (b listed first).
    files.set("a.md", "# A\n\nalpha intro about apples\n");
    files.set("b.md", `# B\n\nbeta intro about boats\n\n${P}\n`);
    const res = await reconcileChanges(store, repoId, src, [{ path: "b.md" }, { path: "a.md" }]);
    expect(res.ingested).toEqual(["b.md", "a.md"]);

    const after = store.db.prepare("SELECT b.block_id id, d.path FROM blocks b JOIN docs d ON d.doc_id=b.doc_id WHERE b.text LIKE 'the quick brown fox%'").all() as { id: string; path: string }[];
    expect(after).toEqual([{ id: before.id, path: "b.md" }]);
    const kinds = (store.db.prepare("SELECT kind FROM dispositions WHERE block_id=? ORDER BY rowid").all(before.id) as { kind: string }[]).map((d) => d.kind);
    expect(kinds).toEqual(["inserted", "moved"]);
    const pooled = store.db.prepare("SELECT count(*) c FROM resurrection_pool WHERE block_id=?").get(before.id) as { c: number };
    expect(pooled.c).toBe(0);
    // Convergence for both members.
    const docs = store.db.prepare("SELECT d.path, d.file_hash, r.rendered_hash FROM docs d JOIN revisions r ON r.rev_id=d.current_rev").all() as { path: string; file_hash: Buffer; rendered_hash: Buffer }[];
    expect(docs).toHaveLength(2);
    for (const d of docs) expect(d.file_hash.equals(d.rendered_hash), d.path).toBe(true);
  });

  it("re-ingests a genuinely changed member as a new revision", async () => {
    store = new Store({ path: ":memory:" });
    const files = new Map([["a.md", "# A\n"]]);
    const src = new MemorySource(files);
    const repoId = ensureRepo(store, "mem", null);
    await reconcileChanges(store, repoId, src, [{ path: "a.md" }]);
    files.set("a.md", "# A\n\nnow with a body\n");
    const res = await reconcileChanges(store, repoId, src, [{ path: "a.md" }]);
    expect(res.ingested).toEqual(["a.md"]);
    const doc = store.db.prepare("SELECT doc_id FROM docs WHERE path='a.md'").get() as { doc_id: string };
    const revs = store.db.prepare("SELECT count(*) c FROM revisions WHERE doc_id=?").get(doc.doc_id) as { c: number };
    expect(revs.c).toBe(2);
  });
});
