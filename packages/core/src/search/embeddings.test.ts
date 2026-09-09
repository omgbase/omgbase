import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { EmbeddingWorker, SemanticUnavailable, contextPrefix, embedInput, shouldEmbed, ctxHashHex, type EmbeddingProvider, type EmbedTask } from "./embeddings.js";
import { sha256 } from "../core/hash.js";

let store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; });

// Deterministic fake provider: vector = per-word hashed bag (stable, no egress).
function fakeProvider(dim = 8, model = "fake-1"): EmbeddingProvider {
  return {
    model,
    dim,
    embed: async (texts) =>
      texts.map((t) => {
        const v = new Array<number>(dim).fill(0);
        for (const w of t.toLowerCase().split(/\s+/)) {
          const h = sha256(w).readUInt32BE(0);
          v[h % dim] = (v[h % dim] ?? 0) + 1;
        }
        return v;
      }),
  };
}

function task(text: string, ctx = "doc · a.md ·  · paragraph"): EmbedTask {
  return { blockId: "b_" + sha256(text).toString("hex").slice(0, 7), contentHashHex: sha256(text).toString("hex"), ctx, text };
}

describe("embedding worker", () => {
  it("no provider ⇒ semantic_unavailable", async () => {
    store = new Store({ path: ":memory:" });
    const w = new EmbeddingWorker(store, null);
    expect(w.available).toBe(false);
    await expect(w.process([task("hello world")])).rejects.toBeInstanceOf(SemanticUnavailable);
  });

  it("embeds misses and serves the cache on repeat", async () => {
    store = new Store({ path: ":memory:" });
    const w = new EmbeddingWorker(store, fakeProvider());
    const t = task("stable identity across edits is the goal");
    const first = await w.process([t]);
    expect(first.embedded).toBe(1);
    const second = await w.process([t]);
    expect(second.cached).toBe(1);
    expect(second.embedded).toBe(0);
    expect(w.getCached(t.contentHashHex, t.ctx)).not.toBeNull();
  });

  it("batches misses and reports per-batch progress", async () => {
    store = new Store({ path: ":memory:" });
    const w = new EmbeddingWorker(store, fakeProvider());
    const tasks = Array.from({ length: 7 }, (_, i) => task(`distinct block number ${i} with unique words here`));
    const progress: { embedded: number; total: number }[] = [];
    const result = await w.process(tasks, { batchSize: 3, onProgress: (p) => progress.push(p) });
    expect(result.embedded).toBe(7);
    // 7 misses in batches of 3 ⇒ progress ticks at 3, 6, 7.
    expect(progress).toEqual([
      { embedded: 3, total: 7 },
      { embedded: 6, total: 7 },
      { embedded: 7, total: 7 },
    ]);
  });

  it("default drain chunks misses into bounded requests (no all-at-once)", async () => {
    // Regression: process() used to default to one batch of ALL misses, so a
    // large drain sent a single oversized request that could fail silently.
    // A batch cap belongs in the worker, independent of any caller flag.
    store = new Store({ path: ":memory:" });
    const MAX_PER_REQUEST = 50;
    const requestSizes: number[] = [];
    const provider: EmbeddingProvider = {
      model: "capped-1",
      dim: 8,
      embed: async (texts) => {
        requestSizes.push(texts.length);
        if (texts.length > MAX_PER_REQUEST) throw new Error(`batch too large: ${texts.length}`);
        return texts.map(() => new Array<number>(8).fill(0));
      },
    };
    const w = new EmbeddingWorker(store, provider);
    const tasks = Array.from({ length: 100 }, (_, i) => task(`distinct block number ${i} with unique words here`));
    // No opts: relies on the worker's own default batch, not a caller-supplied one.
    const result = await w.process(tasks);
    expect(result.embedded).toBe(100);
    expect(requestSizes.length).toBeGreaterThan(1);
    expect(Math.max(...requestSizes)).toBeLessThanOrEqual(MAX_PER_REQUEST);
  });

  it("context prefix + input formatting (05 §6)", () => {
    const ctx = contextPrefix({ docTitle: "Doc", path: "a.md", headingChain: ["H1", "H2"], blockType: "paragraph" });
    expect(ctx).toBe("Doc · a.md · H1 › H2 · paragraph");
    expect(embedInput(ctx, "body")).toBe(ctx + "\nbody");
  });

  it("rename invalidates a subtree's vectors (ctx_hash change ⇒ cache miss)", async () => {
    store = new Store({ path: ":memory:" });
    const w = new EmbeddingWorker(store, fakeProvider());
    const text = "a paragraph under a heading that will be renamed shortly here with enough additional words to clear the twenty four token minimum for embedding eligibility now";
    const oldCtx = contextPrefix({ docTitle: "Doc", path: "a.md", headingChain: ["Old Heading"], blockType: "paragraph" });
    await w.process([{ blockId: "b_1", contentHashHex: sha256(text).toString("hex"), ctx: oldCtx, text }]);
    // After a heading rename, the block's context changes → its cached vector
    // (keyed by the old ctx_hash) no longer matches → stale.
    const newCtx = contextPrefix({ docTitle: "Doc", path: "a.md", headingChain: ["New Heading"], blockType: "paragraph" });
    expect(ctxHashHex(newCtx)).not.toBe(ctxHashHex(oldCtx));
    const stale = w.staleBlocks([{ blockId: "b_1", contentHashHex: sha256(text).toString("hex"), ctx: newCtx, text }]);
    expect(stale).toEqual(["b_1"]);
  });

  it("tiny blocks are not embedded alone (< 24 tokens)", () => {
    expect(shouldEmbed("short")).toBe(false);
    expect(shouldEmbed(new Array(30).fill("word").join(" "))).toBe(true);
  });

  it("prune reclaims other models' vectors, keeps the current model's", async () => {
    store = new Store({ path: ":memory:" });
    const t = task("stable identity across edits is the goal for this embedding");

    // Embed once under the old model, then again under a new one (as a model
    // switch would): the cache keys on model, so both rows coexist.
    await new EmbeddingWorker(store, fakeProvider(8, "old-model")).process([t]);
    const current = new EmbeddingWorker(store, fakeProvider(8, "new-model"));
    await current.process([t]);

    // From the new model's view, the old row is foreign dead weight.
    expect(current.foreignVectorCount()).toEqual({ blocks: 1, docs: 0 });

    const pruned = current.pruneForeignVectors();
    expect(pruned).toEqual({ blocks: 1, docs: 0 });
    // Current model's vector survives; nothing foreign remains.
    expect(current.getCached(t.contentHashHex, t.ctx)).not.toBeNull();
    expect(current.foreignVectorCount()).toEqual({ blocks: 0, docs: 0 });
    const rows = (store.db.prepare("SELECT count(*) c FROM embeddings").get() as { c: number }).c;
    expect(rows).toBe(1);
  });
});
