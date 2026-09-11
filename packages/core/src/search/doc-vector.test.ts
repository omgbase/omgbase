import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { EmbeddingWorker, type EmbeddingProvider } from "./embeddings.js";
import { buildEmbedTasks, buildDocEmbedTasks } from "./tasks.js";
import { docVectorSearch } from "./vector.js";
import { sha256 } from "../core/hash.js";

let store: Store;
let repoId: string;

// Bag-of-words provider: vector = per-word hashed histogram, L2-normalized so
// cosine reflects lexical overlap. Good enough to assert ranking/diversity.
function bowProvider(dim = 64, maxInputTokens?: number): EmbeddingProvider {
  return {
    model: "bow-doc",
    dim,
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    embed: async (texts) =>
      texts.map((t) => {
        const v = new Array<number>(dim).fill(0);
        for (const w of t.toLowerCase().split(/\s+/).filter(Boolean)) {
          const h = sha256(w).readUInt32BE(0);
          v[h % dim] = (v[h % dim] ?? 0) + 1;
        }
        let norm = 0;
        for (const x of v) norm += x * x;
        norm = Math.sqrt(norm) || 1;
        return v.map((x) => x / norm);
      }),
  };
}

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", "/tmp");
});
afterEach(() => store.close());

async function drainAll(worker: EmbeddingWorker): Promise<void> {
  await worker.process(buildEmbedTasks(store, repoId));
  await worker.processDocs(buildDocEmbedTasks(store, repoId));
}

describe("doc-grain semantic retrieval", () => {
  it("schema has doc_embeddings", () => {
    const cols = store.db.prepare("PRAGMA table_info(doc_embeddings)").all() as { name: string }[];
    expect(cols.map((c) => c.name).sort()).toEqual(["dim", "doc_id", "input_hash", "method", "model", "vec"]);
  });

  it("stores exactly one whole-doc vector per document", async () => {
    ingestFile(store, repoId, "a.md", "# Alpha\n\nsome content about distributed consensus and network partitions in databases\n");
    ingestFile(store, repoId, "b.md", "# Beta\n\ncats and kittens sit on a warm mat near the cozy fireplace indoors\n");
    const worker = new EmbeddingWorker(store, bowProvider());
    const res = await worker.processDocs(buildDocEmbedTasks(store, repoId));
    expect(res.embedded).toBe(2);
    expect(res.pooled).toBe(0);
    const rows = store.db.prepare("SELECT doc_id, method FROM doc_embeddings").all() as { doc_id: string; method: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.method === "whole")).toBe(true);
  });

  it("docVectorSearch ranks the on-topic document first — one hit per doc", async () => {
    ingestFile(store, repoId, "consensus.md", "# Consensus\n\ndistributed consensus protocols require careful handling of network partitions and leader election among replicas\n");
    ingestFile(store, repoId, "cats.md", "# Cats\n\nkittens and cats enjoy sitting on soft warm mats near a cozy fireplace on a lazy afternoon\n");
    const worker = new EmbeddingWorker(store, bowProvider());
    await drainAll(worker);

    const q = await worker.embedQuery("network partitions and leader election in distributed replicas");
    const hits = docVectorSearch(store, repoId, "bow-doc", q, { limit: 5 });
    expect(hits[0]!.path).toBe("consensus.md");
    // no doc appears twice
    const paths = hits.map((h) => h.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("fallback: an oversized doc pools its block vectors, token-weighted + unit-norm", async () => {
    // A doc whose input exceeds a tiny token budget ⇒ pooled fallback. One long
    // on-topic block + several short off-topic blocks. Token-weighting must let
    // the long on-topic block dominate (vs a naive mean over blocks).
    const onTopic = Array(60).fill("consensus").join(" "); // long, on-topic, high token weight
    const offTopic1 = "cats mats fireplace warm"; // short, off-topic
    const offTopic2 = "cooking recipes dinner soup"; // short, off-topic
    const offTopic3 = "weather sunny rain clouds sky"; // short, off-topic
    ingestFile(store, repoId, "big.md",
      `# Big\n\n${onTopic}\n\n${offTopic1} plus more filler words to clear the embed floor here now indeed\n\n` +
      `${offTopic2} plus more filler words to clear the embed floor here now indeed\n\n` +
      `${offTopic3} plus more filler words to clear the embed floor here now indeed today\n`);
    // Tiny budget forces the pooled path.
    const worker = new EmbeddingWorker(store, bowProvider(64, 5));
    await worker.process(buildEmbedTasks(store, repoId));
    const res = await worker.processDocs(buildDocEmbedTasks(store, repoId));
    expect(res.pooled).toBe(1);
    expect(res.embedded).toBe(0);

    const row = store.db.prepare("SELECT method, vec FROM doc_embeddings").get() as { method: string; vec: Buffer };
    expect(row.method).toBe("pooled");
    const v = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4);
    // L2-normalized ⇒ unit norm.
    let norm = 0;
    for (const x of v) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);

    // Token-weighting: a "consensus" query scores the pooled vector higher than
    // an equally-weighted naive mean would, because the long on-topic block
    // carries most of the weight. Assert the pooled doc ranks on-topic.
    const q = await worker.embedQuery("consensus");
    const hits = docVectorSearch(store, repoId, "bow-doc", q, { limit: 1 });
    expect(hits[0]!.path).toBe("big.md");
    expect(hits[0]!.cosine).toBeGreaterThan(0.5);
  });

  it("pooled fallback is token-weighted, not a naive mean", async () => {
    // A doc with ONE long on-topic block + MANY short off-topic blocks. Under a
    // naive (per-block) mean the many off-topic blocks outvote the one on-topic
    // block, so a "consensus" query scores low. Token-weighting lets the long
    // block dominate ⇒ higher cosine. We assert the pooled doc's score against
    // "consensus" beats a hand-computed naive-mean baseline over the same blocks.
    // Each block must clear the 24-token embed floor to get its own vector, so
    // the off-topic blocks are padded past it — but they stay SHORT relative to
    // the long on-topic block, so token-weighting still favors the on-topic one.
    const onTopic = Array(120).fill("consensus").join(" ");
    const pad = "and here are some additional filler words padding this block well past the twenty four token minimum floor today now indeed";
    ingestFile(store, repoId, "big.md",
      `# Big\n\n${onTopic}\n\n` +
      `cats mats fireplace warm cozy blanket ${pad}\n\n` +
      `cooking recipes dinner soup salad bread ${pad}\n\n` +
      `weather sunny rain clouds sky wind ${pad}\n\n` +
      `music guitar drums piano violin flute ${pad}\n`);
    const provider = bowProvider(64, 5); // tiny budget ⇒ pooled path
    const worker = new EmbeddingWorker(store, provider);
    await worker.process(buildEmbedTasks(store, repoId));
    await worker.processDocs(buildDocEmbedTasks(store, repoId));

    const cos = (a: Float32Array, b: Float32Array): number => {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
      return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
    };
    const q = await worker.embedQuery("consensus");
    const pooledVec = docVectorSearch(store, repoId, "bow-doc", q, { limit: 1 });
    // Reconstruct a NAIVE per-block mean over the same block vectors for baseline.
    const docId = (store.db.prepare("SELECT doc_id FROM docs WHERE path='big.md'").get() as { doc_id: string }).doc_id;
    const tasks = buildEmbedTasks(store, repoId);
    const dim = 64;
    const naive = new Float64Array(dim);
    let count = 0;
    for (const t of tasks) {
      const v = worker.getCached(t.contentHashHex, t.ctx);
      if (!v) continue;
      for (let i = 0; i < dim; i++) naive[i]! += v[i]!;
      count++;
    }
    for (let i = 0; i < dim; i++) naive[i]! /= count || 1;
    const naiveCos = cos(q, Float32Array.from(naive));
    void docId;
    // Token-weighted pooling scores the on-topic query strictly higher than the
    // naive per-block mean would.
    expect(pooledVec[0]!.cosine).toBeGreaterThan(naiveCos);
  });

  it("doc vector stays fresh: editing a block changes the doc score (AC6)", async () => {
    ingestFile(store, repoId, "note.md", "# Note\n\ncats and kittens sit on a warm mat near the cozy fireplace indoors all day\n");
    const worker = new EmbeddingWorker(store, bowProvider());
    await drainAll(worker);

    const q = await worker.embedQuery("distributed consensus network partitions replicas");
    const before = docVectorSearch(store, repoId, "bow-doc", q, { limit: 1 })[0]!.cosine;

    // Rewrite the file so its content is now about the query topic.
    ingestFile(store, repoId, "note.md", "# Note\n\ndistributed consensus protocols manage network partitions across replicas reliably every time\n");
    // A re-drain must recompute the doc vector (input changed ⇒ cache stale).
    expect(worker.staleDocs(buildDocEmbedTasks(store, repoId))).toContain(
      (store.db.prepare("SELECT doc_id FROM docs WHERE path='note.md'").get() as { doc_id: string }).doc_id,
    );
    await drainAll(worker);
    const after = docVectorSearch(store, repoId, "bow-doc", q, { limit: 1 })[0]!.cosine;

    expect(after).toBeGreaterThan(before);
  });
});
