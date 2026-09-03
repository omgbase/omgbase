import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { EmbeddingWorker, contextPrefix, type EmbeddingProvider, type EmbedTask } from "./embeddings.js";
import { hybridSearch } from "./rrf.js";
import { sha256 } from "../core/hash.js";

let store: Store;
let repoId: string;

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

async function embedAll(worker: EmbeddingWorker): Promise<void> {
  const rows = store.db.prepare("SELECT block_id, text, lower(hex(raw_hash)) h, type, doc_id FROM blocks WHERE type='paragraph'").all() as { block_id: string; text: string; h: string; type: string; doc_id: string }[];
  const tasks: EmbedTask[] = rows.map((r) => ({ blockId: r.block_id, contentHashHex: r.h, ctx: contextPrefix({ docTitle: "d", path: "d", headingChain: [], blockType: r.type }), text: r.text }));
  await worker.process(tasks);
}

describe("hybrid RRF search", () => {
  it("fuses FTS + vector rankings and returns evidence", async () => {
    ingestFile(store, repoId, "a.md", "# Doc\n\nstable block identity across edits is the design goal here today\n\nunrelated distributed consensus and network partition tolerance discussion here\n");
    const worker = new EmbeddingWorker(store, bowProvider());
    await embedAll(worker);
    const vec = await worker.embedQuery("stable identity across edits");

    const hits = hybridSearch(store, { repoId, text: "identity edits", vector: { model: "bow-1", vec }, limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0]!;
    // evidence present
    expect(top.evidence.rrf).toBeGreaterThan(0);
    expect(top.evidence.ftsRank !== undefined || top.evidence.vectorRank !== undefined).toBe(true);
    // the identity block ranks first
    const text = (store.db.prepare("SELECT text FROM blocks WHERE block_id=?").get(top.blockId) as { text: string }).text;
    expect(text).toContain("identity");
  });

  it("applies the layer boost (canon > draft) — deterministic", async () => {
    ingestFile(store, repoId, "canon.md", "---\nlayer: canon\ntitle: Canon\n---\n\n# C\n\nthe shared keyword phrase appears in this canon document paragraph\n");
    ingestFile(store, repoId, "draft.md", "---\nlayer: draft\ntitle: Draft\n---\n\n# D\n\nthe shared keyword phrase appears in this draft document paragraph\n");

    const hits = hybridSearch(store, { repoId, text: "shared keyword phrase", limit: 5 });
    const canon = hits.find((h) => h.path === "canon.md")!;
    const draft = hits.find((h) => h.path === "draft.md")!;
    expect(canon.evidence.boosts.layer).toBe(1.3);
    expect(draft.evidence.boosts.layer).toBe(0.85);
    // With equal RRF, the canon block outranks the draft block.
    expect(hits.indexOf(canon)).toBeLessThan(hits.indexOf(draft));
  });

  it("is deterministic across runs (fixed vectors)", async () => {
    ingestFile(store, repoId, "a.md", "# H\n\nalpha beta gamma delta epsilon zeta eta theta words here for indexing\n\niota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi\n");
    const worker = new EmbeddingWorker(store, bowProvider());
    await embedAll(worker);
    const vec = await worker.embedQuery("alpha beta gamma");
    const run = () => hybridSearch(store, { repoId, text: "alpha beta", vector: { model: "bow-1", vec }, limit: 5 }).map((h) => h.blockId);
    expect(run()).toEqual(run());
  });
});
