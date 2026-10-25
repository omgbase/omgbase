import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { EmbeddingWorker, SemanticUnavailable, contextPrefix, embedInput, shouldEmbed, ctxHashHex, type EmbeddingProvider, type EmbedTask } from "./embeddings.js";
import { sha256 } from "../core/hash.js";

let store: Store | undefined;
let repoId = "";
let docN = 0;
afterEach(() => { store?.close(); store = undefined; });

function open(): Store {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", "/tmp");
  docN = 0;
  return store;
}

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

// Tasks over REAL blocks: the worker's late-result guard (Phase 2) writes a
// vector only while the task's block is live with the task's content hash, so
// each text is ingested as a paragraph of its own document and the task is
// keyed by the row's raw_hash.
function tasks(texts: string[], ctx = "doc · a.md ·  · paragraph"): EmbedTask[] {
  const path = `t${docN++}.md`;
  ingestFile(store!, repoId, path, texts.join("\n\n") + "\n");
  const rows = store!.db
    .prepare("SELECT b.block_id, lower(hex(b.raw_hash)) AS h, b.text FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE d.path = ? AND b.type = 'paragraph' ORDER BY b.ordinal")
    .all(path) as { block_id: string; h: string; text: string }[];
  expect(rows.length).toBe(texts.length);
  return rows.map((r) => ({ blockId: r.block_id, contentHashHex: r.h, ctx, text: r.text }));
}
function task(text: string, ctx?: string): EmbedTask {
  return tasks([text], ctx)[0]!;
}

describe("embedding worker", () => {
  it("no provider ⇒ semantic_unavailable", async () => {
    open();
    const w = new EmbeddingWorker(store!, null);
    expect(w.available).toBe(false);
    await expect(w.process([task("hello world")])).rejects.toBeInstanceOf(SemanticUnavailable);
  });

  it("embeds misses and serves the cache on repeat", async () => {
    open();
    const w = new EmbeddingWorker(store!, fakeProvider());
    const t = task("stable identity across edits is the goal");
    const first = await w.process([t]);
    expect(first.embedded).toBe(1);
    const second = await w.process([t]);
    expect(second.cached).toBe(1);
    expect(second.embedded).toBe(0);
    expect(w.getCached(t.contentHashHex, t.ctx)).not.toBeNull();
  });

  it("batches misses and reports per-batch progress", async () => {
    open();
    const w = new EmbeddingWorker(store!, fakeProvider());
    const seven = tasks(Array.from({ length: 7 }, (_, i) => `distinct block number ${i} with unique words here`));
    const progress: { embedded: number; total: number }[] = [];
    const result = await w.process(seven, { batchSize: 3, onProgress: (p) => progress.push(p) });
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
    open();
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
    const w = new EmbeddingWorker(store!, provider);
    const hundred = tasks(Array.from({ length: 100 }, (_, i) => `distinct block number ${i} with unique words here`));
    // No opts: relies on the worker's own default batch, not a caller-supplied one.
    const result = await w.process(hundred);
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
    open();
    const w = new EmbeddingWorker(store!, fakeProvider());
    const text = "a paragraph under a heading that will be renamed shortly here with enough additional words to clear the twenty four token minimum for embedding eligibility now";
    const oldCtx = contextPrefix({ docTitle: "Doc", path: "a.md", headingChain: ["Old Heading"], blockType: "paragraph" });
    const [t] = tasks([text], oldCtx);
    await w.process([t!]);
    // After a heading rename, the block's context changes → its cached vector
    // (keyed by the old ctx_hash) no longer matches → stale.
    const newCtx = contextPrefix({ docTitle: "Doc", path: "a.md", headingChain: ["New Heading"], blockType: "paragraph" });
    expect(ctxHashHex(newCtx)).not.toBe(ctxHashHex(oldCtx));
    const stale = w.staleBlocks([{ ...t!, ctx: newCtx }]);
    expect(stale).toEqual([t!.blockId]);
  });

  it("tiny blocks are not embedded alone (< 24 tokens)", () => {
    expect(shouldEmbed("short")).toBe(false);
    expect(shouldEmbed(new Array(30).fill("word").join(" "))).toBe(true);
  });

  it("prune reclaims other models' vectors, keeps the current model's", async () => {
    open();
    const t = task("stable identity across edits is the goal for this embedding");

    // Embed once under the old model, then again under a new one (as a model
    // switch would): the cache keys on model, so both rows coexist.
    await new EmbeddingWorker(store!, fakeProvider(8, "old-model")).process([t]);
    const current = new EmbeddingWorker(store!, fakeProvider(8, "new-model"));
    await current.process([t]);

    // From the new model's view, the old row is foreign dead weight.
    expect(current.foreignVectorCount()).toEqual({ blocks: 1, docs: 0 });

    const pruned = current.pruneForeignVectors();
    expect(pruned).toEqual({ blocks: 1, docs: 0 });
    // Current model's vector survives; nothing foreign remains.
    expect(current.getCached(t.contentHashHex, t.ctx)).not.toBeNull();
    expect(current.foreignVectorCount()).toEqual({ blocks: 0, docs: 0 });
    const rows = (store!.db.prepare("SELECT count(*) c FROM embeddings").get() as { c: number }).c;
    expect(rows).toBe(1);
  });
});

describe("the late-result guard", () => {
  it("drops a vector whose block was edited or removed while the provider answered, and counts it", async () => {
    open();
    const [a, b] = tasks(["alpha paragraph with words enough here", "beta paragraph with words enough here"]);
    const w = new EmbeddingWorker(store!, {
      model: "g", dim: 2,
      embed: async (texts) => {
        // The provider "takes a while": the document is rewritten underneath it — beta edited, alpha gone.
        ingestFile(store!, repoId, "t0.md", "beta paragraph with words enough here and more\n");
        return texts.map(() => [1, 0]);
      },
    });
    const r = await w.process([a!, b!]);
    expect(r.embedded).toBe(0);
    expect(r.stale).toBe(2);
    expect(r.docIds).toEqual([]);
    expect((store!.db.prepare("SELECT count(*) c FROM embeddings").get() as { c: number }).c).toBe(0);
  });
});
