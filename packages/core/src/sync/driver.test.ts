import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { reconcileChanges, attachSource } from "./driver.js";
import type { SyncSource, SourceCapabilities, SourceEntry, SourceItem } from "./plugin.js";

// The driver is source-agnostic: it reconciles whatever a SyncSource hands back.
// An in-memory source proves the seam works with NO filesystem — enumerate/fetch
// over a Map, revision = content hash — and that engine echo-suppression,
// deletion, and re-ingest all key off (repoId, path, content) alone.

let store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; });

class MemorySource implements SyncSource {
  constructor(private files: Map<string, string>) {}
  capabilities(): SourceCapabilities { return { identity: "inferred", writeThrough: true }; }
  *enumerate(): Iterable<SourceEntry> {
    for (const [path, content] of this.files) yield { path, revision: rev(content) };
  }
  fetch(path: string): SourceItem | null {
    const content = this.files.get(path);
    return content === undefined ? null : { path, revision: rev(content), content };
  }
}
function rev(s: string): string { return String(s.length) + ":" + s.slice(0, 8); }

describe("reconcile driver over a non-filesystem source", () => {
  it("attaches + ingests an in-memory source (no node:fs)", () => {
    store = new Store({ path: ":memory:" });
    const src = new MemorySource(new Map([
      ["a.md", "# A\n\nlinks to [b](/b.md)\n"],
      ["b.md", "# B\n\nleaf\n"],
    ]));
    const res = attachSource(store, "mem", "/virtual/mem", src);
    expect(res.fileCount).toBe(2);
    expect(res.allConverged).toBe(true);
    const edges = store.db.prepare("SELECT count(*) c FROM edges WHERE to_commit IS NULL").get() as { c: number };
    expect(edges.c).toBeGreaterThanOrEqual(1);
  });

  it("ingests, echo-suppresses an unchanged member, and detects a scope removal", () => {
    store = new Store({ path: ":memory:" });
    const files = new Map([["a.md", "# A\n\nbody\n"]]);
    const src = new MemorySource(files);
    const repoId = ensureRepo(store, "mem", "/virtual/mem");

    const first = reconcileChanges(store, repoId, src, [{ path: "a.md" }]);
    expect(first.ingested).toEqual(["a.md"]);

    // Same bytes ⇒ engine-layer echo (content hash matches stored file_hash).
    const second = reconcileChanges(store, repoId, src, [{ path: "a.md" }]);
    expect(second.suppressed).toEqual(["a.md"]);
    expect(second.ingested).toEqual([]);

    // Removed from the source scope ⇒ deletion.
    files.delete("a.md");
    const third = reconcileChanges(store, repoId, src, [{ path: "a.md" }]);
    expect(third.deleted).toEqual(["a.md"]);
  });

  it("re-ingests a genuinely changed member as a new revision", () => {
    store = new Store({ path: ":memory:" });
    const files = new Map([["a.md", "# A\n"]]);
    const src = new MemorySource(files);
    const repoId = ensureRepo(store, "mem", "/virtual/mem");
    reconcileChanges(store, repoId, src, [{ path: "a.md" }]);
    files.set("a.md", "# A\n\nnow with a body\n");
    const res = reconcileChanges(store, repoId, src, [{ path: "a.md" }]);
    expect(res.ingested).toEqual(["a.md"]);
    const doc = store.db.prepare("SELECT doc_id FROM documents WHERE path='a.md'").get() as { doc_id: string };
    const revs = store.db.prepare("SELECT count(*) c FROM revisions WHERE doc_id=?").get(doc.doc_id) as { c: number };
    expect(revs.c).toBe(2);
  });
});
