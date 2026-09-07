import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { EmbeddingWorker, SemanticUnavailable, contextPrefix, embedInput, shouldEmbed, ctxHashHex, type EmbeddingProvider, type EmbedTask } from "./embeddings.js";
import { sha256 } from "../core/hash.js";

let store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; });

// Deterministic fake provider: vector = per-word hashed bag (stable, no egress).
function fakeProvider(dim = 8): EmbeddingProvider {
  return {
    model: "fake-1",
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
});
