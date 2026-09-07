import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { Watcher } from "./watcher.js";
import type { SyncSource, SourceCapabilities, SourceEntry, SourceItem, SourceWatch, WatchListener } from "./plugin.js";
import type { CheckpointResult } from "./checkpoint.js";

// The Watcher wires a SyncSource's watch stream to the reconcile driver. Debounce
// lives adapter-side, so here a controllable in-memory source lets us fire a
// batch synchronously and assert it reconciles into one checkpoint — no chokidar,
// no timers, no filesystem (that all lives in the external @omgbase/fs-adapter).

let store: Store;
let repoId: string;
let watcher: Watcher | undefined;

// A source we can push batches into by hand.
class ControllableSource implements SyncSource {
  files = new Map<string, string>();
  private listener: WatchListener | null = null;
  capabilities(): SourceCapabilities { return { identity: "inferred", writeThrough: true, watch: true }; }
  enumerate(): Promise<SourceEntry[]> {
    return Promise.resolve([...this.files].map(([path, content]) => ({ path, revision: String(content.length) })));
  }
  fetch(path: string): Promise<SourceItem | null> {
    const content = this.files.get(path);
    return Promise.resolve(content === undefined ? null : { path, revision: String(content.length), content });
  }
  watch(onBatch: WatchListener): Promise<SourceWatch> {
    this.listener = onBatch;
    return Promise.resolve({ stop: () => { this.listener = null; return Promise.resolve(); } });
  }
  close(): Promise<void> { return Promise.resolve(); }
  /** test helper: simulate the adapter emitting a debounced batch */
  emit(paths: string[]): void { this.listener?.(paths); }
}

let source: ControllableSource;

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", null);
  source = new ControllableSource();
});
afterEach(async () => {
  await watcher?.stop();
  watcher = undefined;
  store.close();
});

describe("Watcher", () => {
  it("reconciles a watch batch into a checkpoint", async () => {
    const results: CheckpointResult[] = [];
    watcher = new Watcher(store, repoId, source, { onCheckpoint: (r) => results.push(r) });
    await watcher.start();

    source.files.set("a.md", "# A\n");
    source.files.set("b.md", "# B\n");
    source.emit(["a.md", "b.md"]);

    // The batch reconcile is async; wait a microtask turn for it to settle.
    await new Promise((r) => setTimeout(r, 20));

    expect(results.length).toBe(1);
    expect(results[0]!.ingested.sort()).toEqual(["a.md", "b.md"]);
  });

  it("start() throws if the source cannot watch", async () => {
    const noWatch: SyncSource = {
      capabilities: () => ({ identity: "inferred", writeThrough: false, watch: false }),
      enumerate: () => Promise.resolve([]),
      fetch: () => Promise.resolve(null),
      close: () => Promise.resolve(),
    };
    const w = new Watcher(store, repoId, noWatch);
    await expect(w.start()).rejects.toThrow(/does not support watch/);
  });
});
