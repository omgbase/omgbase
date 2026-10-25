import { describe, it, expect, afterEach, vi } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { EmbeddingWorker, type EmbeddingProvider } from "./embeddings.js";
import { buildEmbedTasks } from "./tasks.js";
import { EmbedDrainer } from "./drain.js";
import { sha256 } from "../core/hash.js";

let store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; });

// A block of prose long enough to clear the 24-token embed floor.
const LONG = "this is a paragraph with plenty of words so that it comfortably clears the twenty four token minimum needed for embedding eligibility in these tests here now";

// Provider whose embed() we can gate: each call parks on a promise we release
// manually, so we can observe scheduling/single-flight while a drain is inflight.
// releaseAll is sticky — once called, later embed() calls resolve immediately
// (still counted). A drain now runs two embed phases (blocks, then docs), so
// without the sticky behavior the follow-on doc-embed call would park forever
// and hang close(); tests that care about drain mechanics count drains via
// onDrain rather than raw embed calls.
function gatedProvider(dim = 8): { provider: EmbeddingProvider; calls: number; releaseAll: () => void } {
  const gates: (() => void)[] = [];
  const state = {
    calls: 0,
    released: false,
    provider: {
      model: "gated-1",
      dim,
      embed: async (texts: string[]) => {
        state.calls++;
        if (!state.released) await new Promise<void>((r) => gates.push(r));
        return texts.map(() => new Array<number>(dim).fill(0.1));
      },
    } as EmbeddingProvider,
    releaseAll: () => { state.released = true; while (gates.length) gates.shift()!(); },
  };
  return state;
}

function seedRepo(): { repoId: string } {
  store = new Store({ path: ":memory:" });
  const repoId = ensureRepo(store, "t", "/tmp");
  ingestFile(store, repoId, "a.md", `# Doc\n\n${LONG}\n`);
  return { repoId };
}

describe("EmbedDrainer", () => {
  it("schedule() returns immediately and drains in the background (does not block)", async () => {
    const { repoId } = seedRepo();
    const resolving: EmbeddingProvider = { model: "r", dim: 8, embed: async (t) => t.map(() => new Array(8).fill(0.2)) };
    const worker = new EmbeddingWorker(store!, resolving);
    const drainer = new EmbedDrainer(store!, repoId, worker, { debounceMs: 20 });

    // schedule() is synchronous and instant — no await, no DB embedding yet.
    expect(worker.staleBlocks(buildEmbedTasks(store!, repoId)).length).toBe(1);
    drainer.schedule();
    // Nothing embedded synchronously, on the caller's path.
    expect(worker.staleBlocks(buildEmbedTasks(store!, repoId)).length).toBe(1);

    await new Promise((r) => setTimeout(r, 60)); // let the debounce fire + drain
    await drainer.close();
    expect(worker.staleBlocks(buildEmbedTasks(store!, repoId)).length).toBe(0);
  });

  it("coalesces a burst of schedules into one drain", async () => {
    vi.useFakeTimers();
    try {
      const { repoId } = seedRepo();
      const g = gatedProvider();
      const worker = new EmbeddingWorker(store!, g.provider);
      const drainer = new EmbedDrainer(store!, repoId, worker, { debounceMs: 100 });

      drainer.schedule();
      await vi.advanceTimersByTimeAsync(40);
      drainer.schedule(); // re-arms the debounce
      await vi.advanceTimersByTimeAsync(40);
      drainer.schedule();
      // Still within a debounce window each time ⇒ no drain has fired yet.
      expect(g.calls).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      // One drain fired for the whole burst.
      expect(g.calls).toBe(1);
      g.releaseAll();
      await drainer.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is single-flight and re-runs once for edits arriving mid-drain", async () => {
    const { repoId } = seedRepo();
    const g = gatedProvider();
    const worker = new EmbeddingWorker(store!, g.provider);
    // Each drain pass calls worker.process exactly once (the block phase), so
    // counting process calls counts drains — robust to the two-phase
    // (blocks-then-docs) drain now doing multiple provider.embed calls per pass.
    const passes = vi.spyOn(worker, "process");
    const drainer = new EmbedDrainer(store!, repoId, worker, { debounceMs: 0 });

    const done = drainer.flush(); // start drain #1; embed() parks (do NOT await)
    await new Promise((r) => setTimeout(r, 5)); // let the drain reach embed()
    // While inflight, more edits land + schedule.
    ingestFile(store!, repoId, "b.md", `# B\n\n${LONG} extra distinct words appended here to differ\n`);
    drainer.schedule();
    drainer.schedule();
    expect(passes).toHaveBeenCalledTimes(1); // still just the one inflight pass
    expect(g.calls).toBe(1);                 // parked on the block embed

    g.releaseAll();              // let drain #1 finish → loop sees dirty → drain #2
    await new Promise((r) => setTimeout(r, 5));
    expect(passes).toHaveBeenCalledTimes(2); // exactly one re-run, not one per schedule
    await done;
    await drainer.close();
  });

  it("flush() embeds synchronously-awaitable for shutdown", async () => {
    const { repoId } = seedRepo();
    const worker = new EmbeddingWorker(store!, gatedProvider().provider);
    // ungated: gatedProvider parks — use a resolving provider for flush timing
    const resolving: EmbeddingProvider = {
      model: "r", dim: 8,
      embed: async (t) => t.map(() => new Array(8).fill(0.2)),
    };
    const w2 = new EmbeddingWorker(store!, resolving);
    const drainer = new EmbedDrainer(store!, repoId, w2, { debounceMs: 10_000 });
    drainer.schedule(); // debounce is long; flush must bypass it
    await drainer.flush();
    expect(w2.staleBlocks(buildEmbedTasks(store!, repoId)).length).toBe(0);
    void worker;
  });

  it("no-provider worker ⇒ schedule/flush are no-ops", async () => {
    const { repoId } = seedRepo();
    const worker = new EmbeddingWorker(store!, null);
    const drainer = new EmbedDrainer(store!, repoId, worker, { debounceMs: 0 });
    drainer.schedule();
    await drainer.flush();
    await drainer.close();
    // nothing to assert beyond "did not throw"; worker unavailable
    expect(worker.available).toBe(false);
  });

  it("a provider error is reported and swallowed (host stays alive)", async () => {
    const { repoId } = seedRepo();
    const boom: EmbeddingProvider = {
      model: "boom", dim: 8,
      embed: async () => { throw new Error("provider down"); },
    };
    const worker = new EmbeddingWorker(store!, boom);
    const errors: unknown[] = [];
    const drainer = new EmbedDrainer(store!, repoId, worker, { debounceMs: 0, onError: (e) => errors.push(e) });
    await drainer.flush();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("provider down");
    await drainer.close();
    void sha256;
  });

  it("close() prevents further drains", async () => {
    const { repoId } = seedRepo();
    const g = gatedProvider();
    const worker = new EmbeddingWorker(store!, g.provider);
    const drainer = new EmbedDrainer(store!, repoId, worker, { debounceMs: 0 });
    await drainer.close();
    drainer.schedule();
    await new Promise((r) => setTimeout(r, 5));
    expect(g.calls).toBe(0);
  });
});
