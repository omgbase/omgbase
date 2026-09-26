import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { EmbeddingWorker, contextPrefix, type EmbeddingProvider, type EmbedTask } from "./embeddings.js";
import { vectorSearch } from "./vector.js";
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

function embedBlocks(worker: EmbeddingWorker, docPath: string): Promise<unknown> {
  const docId = (store.db.prepare("SELECT doc_id FROM docs WHERE path=?").get(docPath) as { doc_id: string }).doc_id;
  const rows = store.db.prepare("SELECT block_id, text, lower(hex(raw_hash)) h, type FROM blocks WHERE doc_id=? AND type='paragraph'").all(docId) as { block_id: string; text: string; h: string; type: string }[];
  const tasks: EmbedTask[] = rows.map((r) => ({
    blockId: r.block_id,
    contentHashHex: r.h,
    ctx: contextPrefix({ docTitle: docPath, path: docPath, headingChain: [], blockType: r.type }),
    text: r.text,
  }));
  return worker.process(tasks);
}

describe("vectorSearch (semantic mode, brute-force cosine)", () => {
  it("ranks the block closest to the query first", async () => {
    ingestFile(store, repoId, "a.md",
      "# Doc\n\nthe cat sat on the warm mat by the fireplace all afternoon long today\n\n" +
      "distributed consensus protocols require careful handling of network partitions and failures\n\n" +
      "kittens and cats enjoy sitting on soft mats near a warm cozy fireplace indoors\n");
    const worker = new EmbeddingWorker(store, bowProvider());
    await embedBlocks(worker, "a.md");

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

  it("one hit per live block: a stale ctx row next to the fresh one keeps the best cosine (spec/search §3)", async () => {
    const text = "the cat sat on the warm mat by the fireplace all afternoon long today and then slept";
    ingestFile(store, repoId, "a.md", `# Old\n\n${text}\n`);
    const worker = new EmbeddingWorker(store, bowProvider());
    const row = store.db.prepare("SELECT block_id, lower(hex(raw_hash)) h FROM blocks WHERE type='paragraph' AND deleted_commit IS NULL").get() as { block_id: string; h: string };
    // Two cache rows for the same content under two contexts (a heading rename).
    await worker.process([
      { blockId: row.block_id, contentHashHex: row.h, ctx: contextPrefix({ docTitle: "Old", path: "a.md", headingChain: ["Old"], blockType: "paragraph" }), text },
      { blockId: row.block_id, contentHashHex: row.h, ctx: contextPrefix({ docTitle: "New", path: "a.md", headingChain: ["New"], blockType: "paragraph" }), text },
    ]);
    expect((store.db.prepare("SELECT count(*) c FROM embeddings").get() as { c: number }).c).toBe(2);
    const q = await worker.embedQuery("New a.md cat mat fireplace");
    const hits = vectorSearch(store, repoId, "bow-1", q);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.blockId).toBe(row.block_id);
    // The surviving cosine is the best of the two rows.
    const cosines = (store.db.prepare("SELECT cosine(?, vec) c FROM embeddings").all(Buffer.from(q.buffer)) as { c: number }[]).map((r) => r.c);
    expect(hits[0]!.cosine).toBeCloseTo(Math.max(...cosines), 12);
  });

  it("returns nothing when no vectors are indexed", async () => {
    ingestFile(store, repoId, "a.md", "# H\n\nun-embedded paragraph content here for the test\n");
    const worker = new EmbeddingWorker(store, bowProvider());
    const q = await worker.embedQuery("anything");
    expect(vectorSearch(store, repoId, "bow-1", q)).toHaveLength(0);
  });
});
