import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store, ensureRepo, docsCreate, findDoc, NullDocStore, type SyncSource, type SourceCapabilities, type SourceEntry, type SourceItem, type WatchListener, type SourceWatch } from "@omgbase/core";
import { InProcessEngineClient } from "./engine-client.js";
import { Coordinator } from "./coordinator.js";

// An in-memory write-through source for exercising the Coordinator without a
// filesystem or an adapter process. Content is the change-token (the engine
// echo-gates on the real content hash regardless).
class MemorySource implements SyncSource {
  readonly files = new Map<string, string>();
  private listener: WatchListener | null = null;

  capabilities(): SourceCapabilities {
    return { identity: "inferred", writeThrough: true, watch: true };
  }
  enumerate(): Promise<SourceEntry[]> {
    return Promise.resolve([...this.files.keys()].map((path) => ({ path, revision: this.files.get(path)! })));
  }
  fetch(path: string): Promise<SourceItem | null> {
    return Promise.resolve(this.files.has(path) ? { path, revision: this.files.get(path)!, content: this.files.get(path)! } : null);
  }
  write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }
  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
  watch(onBatch: WatchListener): Promise<SourceWatch> {
    this.listener = onBatch;
    return Promise.resolve({ stop: () => { this.listener = null; return Promise.resolve(); } });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  /** test helper: pretend the source emitted a change batch. */
  emit(paths: string[]): void {
    this.listener?.(paths);
  }
}

let store: Store;
let repoId: string;
let engine: InProcessEngineClient;
let source: MemorySource;
let coord: Coordinator;

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", null); // headless repo (no working tree)
  engine = new InProcessEngineClient(store, repoId);
  source = new MemorySource();
  coord = new Coordinator(engine, source);
});
afterEach(() => store.close());

function docCount(): number {
  return (store.db.prepare("SELECT count(*) c FROM docs WHERE deleted_commit IS NULL").get() as { c: number }).c;
}

describe("Coordinator", () => {
  it("syncIn ingests the source's scope into the engine", async () => {
    source.files.set("a.md", "# A\n");
    source.files.set("b.md", "# B\n");
    const s = await coord.syncIn();
    expect(s.ingested.sort()).toEqual(["a.md", "b.md"]);
    expect(docCount()).toBe(2);
  });

  it("reconcile: change → ingested, unchanged → suppressed, gone → deleted", async () => {
    source.files.set("a.md", "# A\n");
    source.files.set("b.md", "# B\n");
    await coord.syncIn();

    source.files.set("a.md", "# A edited\n"); // changed
    // b.md unchanged
    source.files.delete("c-was-never-there.md");
    const changed = await coord.reconcile(["a.md", "b.md"]);
    expect(changed.ingested).toEqual(["a.md"]);
    expect(changed.suppressed).toEqual(["b.md"]);

    source.files.delete("b.md"); // now gone
    const gone = await coord.reconcile(["b.md"]);
    expect(gone.deleted).toEqual(["b.md"]);
    expect(findDoc(store, { repoId, path: "b.md" })).toBeNull();
  });

  it("syncOut writes engine-authored changes to the source, skipping observed ones", async () => {
    // observed-origin: came from the source via syncIn — must NOT be pushed back.
    source.files.set("from-source.md", "# From Source\n");
    await coord.syncIn();

    // engine-authored (import origin), headless: should be exported to the source.
    docsCreate(store, { repoId, docStore: new NullDocStore() }, "authored.md", "# Authored\n", {});

    const out = await coord.syncOut();
    expect(out.written).toContain("authored.md");
    expect(out.written).not.toContain("from-source.md");
    expect(source.files.get("authored.md")).toContain("# Authored");
  });

  it("watchIn reconciles emitted batches", async () => {
    const summaries: number[] = [];
    const sub = await coord.watchIn({ onSummary: (s) => summaries.push(s.ingested.length) });
    expect(sub).not.toBeNull();

    source.files.set("w.md", "# W\n");
    source.emit(["w.md"]);
    await new Promise((r) => setTimeout(r, 20)); // let the async reconcile settle
    expect(docCount()).toBe(1);
    expect(summaries).toContain(1);
    await sub!.stop();
  });
});
