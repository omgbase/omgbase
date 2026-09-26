import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { EmbeddingWorker, contextPrefix, type EmbeddingProvider } from "./embeddings.js";
import { vectorSearch } from "./vector.js";
import { buildEmbedTasks } from "./tasks.js";
import { sha256 } from "../core/hash.js";

let store: Store;
let repoId: string;

// Bag-of-words provider: cosine reflects lexical overlap — good enough to
// assert that a semantically-closer block ranks higher.
function bowProvider(dim = 64): EmbeddingProvider {
  return {
    model: "bow-1", dim,
    embed: async (texts) => texts.map((t) => {
      const v = new Array<number>(dim).fill(0);
      for (const w of t.toLowerCase().split(/\s+/).filter(Boolean)) {
        const h = sha256(w).readUInt32BE(0);
        v[h % dim] = (v[h % dim] ?? 0) + 1;
      }
      return v;
    }),
  };
}

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", "/tmp");
});
afterEach(() => store.close());

// Embed exactly what the drain would: every embeddable block under its current
// context (spec/search §2.2) — the only rows vectorSearch reads (§3, 1.1).
function embedBlocks(worker: EmbeddingWorker): Promise<unknown> {
  return worker.process(buildEmbedTasks(store, repoId));
}

describe("vectorSearch (semantic mode, brute-force cosine)", () => {
  it("ranks the block closest to the query first", async () => {
    ingestFile(store, repoId, "a.md",
      "# Doc\n\nthe cat sat on the warm mat by the fireplace all afternoon long today while the rain fell softly outside the window and the kettle sang\n\n" +
      "distributed consensus protocols require careful handling of network partitions and failures so that replicas agree on one log even when messages are delayed or lost\n\n" +
      "kittens and cats enjoy sitting on soft mats near a warm cozy fireplace indoors especially in winter when the house is quiet and the evenings are long\n");
    const worker = new EmbeddingWorker(store, bowProvider());
    await embedBlocks(worker);

    const q = await worker.embedQuery("cats sitting on a mat near the fireplace");
    const hits = vectorSearch(store, repoId, "bow-1", q, { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    // The cat/mat/fireplace blocks should outrank the consensus one.
    expect(hits[0]!.path).toBe("a.md");
    const consensusRank = hits.findIndex((h) => {
      const t = store.db.prepare("SELECT text FROM blocks WHERE block_id=?").get(h.blockId) as { text: string };
      return t.text.includes("consensus");
    });
    // consensus block is last (or absent from top results)
    expect(consensusRank === -1 || consensusRank === hits.length - 1).toBe(true);
  });

  it("a block's vector is its current-context row; a stale ctx row is ignored even when it scores higher (spec/search §3, 1.1)", async () => {
    const text = "the cat sat on the warm mat by the fireplace all afternoon long today and then slept while the rain fell softly outside the window and the kettle sang";
    ingestFile(store, repoId, "a.md", `# Old\n\n${text}\n`);
    const worker = new EmbeddingWorker(store, bowProvider());
    const row = store.db.prepare("SELECT block_id, lower(hex(raw_hash)) h FROM blocks WHERE type='paragraph' AND deleted_commit IS NULL").get() as { block_id: string; h: string };
    // Two cache rows for the same content: the block's current context (heading
    // "Old") and a foreign one (as a heading rename to "New" would leave behind).
    const current = buildEmbedTasks(store, repoId)[0]!.ctx;
    expect(current).toBe(contextPrefix({ docTitle: "Old", path: "a.md", headingChain: ["Old"], blockType: "paragraph" }));
    const foreign = contextPrefix({ docTitle: "New", path: "a.md", headingChain: ["New"], blockType: "paragraph" });
    await worker.process([
      { blockId: row.block_id, contentHashHex: row.h, ctx: current, text },
      { blockId: row.block_id, contentHashHex: row.h, ctx: foreign, text },
    ]);
    expect((store.db.prepare("SELECT count(*) c FROM embeddings").get() as { c: number }).c).toBe(2);
    // A query leaning on the foreign context's words scores that row higher…
    const q = await worker.embedQuery("New a.md cat mat fireplace");
    const cosines = (store.db.prepare("SELECT lower(hex(ctx_hash)) k, cosine(?, vec) c FROM embeddings").all(Buffer.from(q.buffer)) as { k: string; c: number }[]);
    const byCtx = new Map(cosines.map((r) => [r.k, r.c]));
    expect(byCtx.get(sha256(foreign).toString("hex"))!).toBeGreaterThan(byCtx.get(sha256(current).toString("hex"))!);
    // …and the hit still carries the current-context cosine.
    const hits = vectorSearch(store, repoId, "bow-1", q);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.blockId).toBe(row.block_id);
    expect(hits[0]!.cosine).toBeCloseTo(byCtx.get(sha256(current).toString("hex"))!, 12);
  });

  it("a block whose only cached row is under a stale context is absent until re-embedded (spec/search §3, 1.1)", async () => {
    const text = "the cat sat on the warm mat by the fireplace all afternoon long today and then slept while the rain fell softly outside the window and the kettle sang";
    ingestFile(store, repoId, "a.md", `# Old\n\n${text}\n`);
    const worker = new EmbeddingWorker(store, bowProvider());
    await embedBlocks(worker);
    const q = await worker.embedQuery("cat mat fireplace");
    expect(vectorSearch(store, repoId, "bow-1", q)).toHaveLength(1);
    // The heading rename changes the block's current ctx: the old row is now stale.
    ingestFile(store, repoId, "a.md", `# New\n\n${text}\n`);
    expect((store.db.prepare("SELECT count(*) c FROM embeddings").get() as { c: number }).c).toBe(1);
    expect(vectorSearch(store, repoId, "bow-1", q)).toHaveLength(0);
    // The drain re-embeds under the current ctx and the block is back.
    await worker.process(buildEmbedTasks(store, repoId));
    expect(vectorSearch(store, repoId, "bow-1", q)).toHaveLength(1);
  });

  it("returns nothing when no vectors are indexed", async () => {
    ingestFile(store, repoId, "a.md", "# H\n\nun-embedded paragraph content here for the test, long enough to be embeddable on its own were the drain ever to run over it in this case\n");
    const worker = new EmbeddingWorker(store, bowProvider());
    const q = await worker.embedQuery("anything");
    expect(vectorSearch(store, repoId, "bow-1", q)).toHaveLength(0);
  });
});
