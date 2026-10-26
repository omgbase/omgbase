import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { tombstoneObservedDeletion } from "../sync/tombstone.js";
import { EmbeddingWorker, type EmbeddingProvider } from "./embeddings.js";
import { buildDocEmbedTasks, buildEmbedTasks } from "./tasks.js";
import {
  CHUNKING_VERSION, WATERMARK_SOURCE, clearWatermark, drainMode, drainRepo, feedHead, freshness, indexIdentity, readWatermark, writeWatermark,
} from "./indexer.js";

// The semantic indexer (modular-core Phase 2): the watermark, the three modes,
// the cleanup, the late-result guard. A deterministic provider that records
// what it was asked to embed stands in for the embedder.

let store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; });

const LONG = (seed: string) => `${seed} paragraph with plenty of words so that it comfortably clears the twenty four token minimum needed for embedding eligibility in these tests here now`;

function provider(model = "m", dim = 4, onEmbed?: (texts: string[]) => void): EmbeddingProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model, dim, calls,
    embed: async (texts) => {
      calls.push(texts);
      onEmbed?.(texts);
      return texts.map((t) => [t.length % 7, 1, 0, 0]);
    },
  };
}

function seed(): { repoId: string } {
  store = new Store({ path: ":memory:" });
  const repoId = ensureRepo(store, "t", "/tmp");
  ingestFile(store, repoId, "a.md", `# A\n\n${LONG("alpha")}\n`, { ts: "2026-01-01T00:00:00.000Z" });
  ingestFile(store, repoId, "b.md", `# B\n\n${LONG("beta")}\n`, { ts: "2026-01-02T00:00:00.000Z" });
  return { repoId };
}

const count = (sql: string, ...params: unknown[]): number => (store!.db.prepare(sql).get(...params) as { c: number }).c;

describe("the watermark", () => {
  it("is a row of the semantic bundle's bookkeeping under the sentinel source: identity + processed_seq, absent until the first drain", () => {
    const { repoId } = seed();
    expect(readWatermark(store!, repoId)).toBeNull();
    writeWatermark(store!, repoId, { processed_seq: 3, identity: { model: "m", dims: 4, chunking: CHUNKING_VERSION } });
    expect(readWatermark(store!, repoId)).toEqual({ processed_seq: 3, identity: { model: "m", dims: 4, chunking: 1 } });
    const row = store!.db.prepare("SELECT source_id, path, revision, cursor FROM sync_state WHERE repo_id = ?").get(repoId) as Record<string, string>;
    expect(row).toEqual({ source_id: WATERMARK_SOURCE, path: "", revision: '{"model":"m","dims":4,"chunking":1}', cursor: '{"processed_seq":3}' });
    writeWatermark(store!, repoId, { processed_seq: 4, identity: { model: "m", dims: 4, chunking: CHUNKING_VERSION } });
    expect(readWatermark(store!, repoId)?.processed_seq).toBe(4);
    clearWatermark(store!, repoId);
    expect(readWatermark(store!, repoId)).toBeNull();
    // A malformed row is no watermark (the next drain bootstraps).
    store!.db.prepare("INSERT INTO sync_state (repo_id, source_id, path, revision, cursor) VALUES (?, ?, '', 'junk', '{}')").run(repoId, WATERMARK_SOURCE);
    expect(readWatermark(store!, repoId)).toBeNull();
  });

  it("the feed head is the recorder's commit seq, through the capability", () => {
    const { repoId } = seed();
    expect(feedHead(store!, repoId)).toBe(2);
    ingestFile(store!, repoId, "c.md", "# C\n", { ts: "2026-01-03T00:00:00.000Z" });
    expect(feedHead(store!, repoId)).toBe(3);
  });

  it("drainMode: bootstrap without a watermark, catch-up under the same identity at or behind the head, rescan on an identity change, a cursor past the head, no feed, or by request", () => {
    const id = { model: "m", dims: 4, chunking: CHUNKING_VERSION };
    expect(drainMode(null, 5, id)).toBe("bootstrap");
    expect(drainMode({ processed_seq: 3, identity: id }, 5, id)).toBe("catch-up");
    expect(drainMode({ processed_seq: 5, identity: id }, 5, id)).toBe("catch-up");
    expect(drainMode({ processed_seq: 3, identity: { ...id, model: "other" } }, 5, id)).toBe("rescan");
    expect(drainMode({ processed_seq: 3, identity: { ...id, dims: 8 } }, 5, id)).toBe("rescan");
    expect(drainMode({ processed_seq: 3, identity: { ...id, chunking: 2 } }, 5, id)).toBe("rescan");
    expect(drainMode({ processed_seq: 9, identity: id }, 5, id)).toBe("rescan");
    expect(drainMode({ processed_seq: 3, identity: id }, null, id)).toBe("rescan");
    expect(drainMode({ processed_seq: 3, identity: id }, 5, id, true)).toBe("rescan");
    // Behind the oldest retained row (an expired cursor): 3 on a feed pruned to oldest 5 rescans, 4 catches up (oldest − 1 is served);
    // a watermark of 0 on a pruned feed rescans too (store 17.0: cursor 0 expires once oldest ≥ 2), on a fresh feed it catches up.
    expect(drainMode({ processed_seq: 3, identity: id }, 5, id, false, 5)).toBe("rescan");
    expect(drainMode({ processed_seq: 4, identity: id }, 5, id, false, 5)).toBe("catch-up");
    expect(drainMode({ processed_seq: 0, identity: id }, 5, id, false, 2)).toBe("rescan");
    expect(drainMode({ processed_seq: 0, identity: id }, 5, id, false, 1)).toBe("catch-up");
  });
});

describe("drainRepo", () => {
  it("bootstraps from the head read at the start, embeds blocks then documents, and writes the watermark last", async () => {
    const { repoId } = seed();
    const p = provider();
    const worker = new EmbeddingWorker(store!, p);
    const r = await drainRepo(store!, repoId, worker, p);
    expect(r.mode).toBe("bootstrap");
    expect(r.embedded).toBe(2);
    expect(r.docEmbedded).toBe(2);
    expect(r.stale).toBe(0);
    expect(r.processed_seq).toBe(2);
    expect(r.head).toBe(2);
    expect(readWatermark(store!, repoId)).toEqual({ processed_seq: 2, identity: indexIdentity(p) });
    expect(freshness(store!, repoId, indexIdentity(p))).toEqual({ processed_seq: 2, head: 2, identity: indexIdentity(p), fresh: true });
    // Blocks before docs: the first provider call carries context-prefixed block inputs, the second the doc inputs.
    expect(p.calls[0]!.every((t) => t.includes(" · paragraph\n"))).toBe(true);
    expect(p.calls[1]!.length).toBe(2);
  });

  it("catches up: a quiet repository reconstructs no document; a changed one re-embeds exactly the documents the feed names", async () => {
    const { repoId } = seed();
    const p = provider();
    const worker = new EmbeddingWorker(store!, p);
    await drainRepo(store!, repoId, worker, p);
    p.calls.length = 0;

    const quiet = await drainRepo(store!, repoId, worker, p);
    expect(quiet.mode).toBe("catch-up");
    expect(quiet.embedded + quiet.docEmbedded).toBe(0);
    expect(p.calls).toEqual([]); // nothing was handed to the provider at all
    expect(buildDocEmbedTasks(store!, repoId, { docIds: [] })).toEqual([]);

    ingestFile(store!, repoId, "b.md", `# B\n\n${LONG("beta two")}\n`, { ts: "2026-01-03T00:00:00.000Z" });
    const r = await drainRepo(store!, repoId, worker, p);
    expect(r.mode).toBe("catch-up");
    expect(r.embedded).toBe(1);
    expect(r.docEmbedded).toBe(1);
    expect(p.calls.length).toBe(2);
    expect(p.calls[1]!.length).toBe(1);
    expect(p.calls[1]![0]!.startsWith("B · b.md")).toBe(true);
    expect(readWatermark(store!, repoId)?.processed_seq).toBe(3);
    expect(freshness(store!, repoId).fresh).toBe(true);
  });

  it("reports the index behind the head until the next pass", async () => {
    const { repoId } = seed();
    const p = provider();
    await drainRepo(store!, repoId, new EmbeddingWorker(store!, p), p);
    ingestFile(store!, repoId, "c.md", `# C\n\n${LONG("gamma")}\n`, { ts: "2026-01-03T00:00:00.000Z" });
    expect(freshness(store!, repoId, indexIdentity(p))).toEqual({ processed_seq: 2, head: 3, identity: indexIdentity(p), fresh: false });
    // Another identity is never fresh, whatever the sequence says.
    expect(freshness(store!, repoId, { model: "other", dims: 4, chunking: CHUNKING_VERSION }).fresh).toBe(false);
  });

  it("a model switch invalidates: the old identity's vectors go and everything is re-embedded under the new one", async () => {
    const { repoId } = seed();
    const p1 = provider("one");
    await drainRepo(store!, repoId, new EmbeddingWorker(store!, p1), p1);
    expect(count("SELECT count(*) c FROM embeddings WHERE model = 'one'")).toBe(2);
    expect(count("SELECT count(*) c FROM doc_embeddings WHERE model = 'one'")).toBe(2);

    const p2 = provider("two");
    const r = await drainRepo(store!, repoId, new EmbeddingWorker(store!, p2), p2);
    expect(r.mode).toBe("rescan");
    expect(r.pruned).toEqual({ blocks: 2, docs: 2 });
    expect(r.embedded).toBe(2);
    expect(r.docEmbedded).toBe(2);
    expect(count("SELECT count(*) c FROM embeddings WHERE model = 'one'")).toBe(0);
    expect(count("SELECT count(*) c FROM embeddings WHERE model = 'two'")).toBe(2);
    expect(readWatermark(store!, repoId)?.identity).toEqual(indexIdentity(p2));
  });

  it("a cursor past the head is an expired cursor: full rescan with the cleanup, then the watermark is the head", async () => {
    const { repoId } = seed();
    const p = provider();
    const worker = new EmbeddingWorker(store!, p);
    await drainRepo(store!, repoId, worker, p);
    // A vector for content no live block carries (a leftover) and a foreign watermark.
    store!.db.prepare("INSERT INTO embeddings (content_hash, ctx_hash, model, dim, vec) VALUES (zeroblob(32), zeroblob(32), 'm', 4, zeroblob(16))").run();
    writeWatermark(store!, repoId, { processed_seq: 99, identity: indexIdentity(p) });
    const r = await drainRepo(store!, repoId, worker, p);
    expect(r.mode).toBe("rescan");
    expect(r.pruned.blocks).toBe(1);
    expect(r.cached).toBe(2);
    expect(readWatermark(store!, repoId)?.processed_seq).toBe(2);
  });

  it("a deleted document's vectors are cleaned up on every pass (S1)", async () => {
    const { repoId } = seed();
    const p = provider();
    const worker = new EmbeddingWorker(store!, p);
    await drainRepo(store!, repoId, worker, p);
    const docB = (store!.db.prepare("SELECT doc_id FROM docs WHERE path = 'b.md'").get() as { doc_id: string }).doc_id;
    tombstoneObservedDeletion(store!, repoId, docB, "2026-01-03T00:00:00.000Z");
    const r = await drainRepo(store!, repoId, worker, p);
    expect(r.mode).toBe("catch-up");
    expect(r.pruned.docs).toBe(1);
    expect(count("SELECT count(*) c FROM doc_embeddings WHERE doc_id = ?", docB)).toBe(0);
  });

  it("a provider failure leaves the watermark where it was", async () => {
    const { repoId } = seed();
    const p = provider();
    await drainRepo(store!, repoId, new EmbeddingWorker(store!, p), p);
    ingestFile(store!, repoId, "c.md", `# C\n\n${LONG("gamma")}\n`, { ts: "2026-01-03T00:00:00.000Z" });
    const down: EmbeddingProvider = { model: "m", dim: 4, embed: async () => { throw new Error("provider down"); } };
    await expect(drainRepo(store!, repoId, new EmbeddingWorker(store!, down), down)).rejects.toThrow("provider down");
    expect(readWatermark(store!, repoId)?.processed_seq).toBe(2);
  });

  it("a late result never publishes a stale vector: a block edited while the provider answers is dropped, and so is its document", async () => {
    const { repoId } = seed();
    // The provider edits b.md on the first call (the block pass) — the content it was asked about is gone before it answers.
    let edited = false;
    const p = provider("m", 4, () => {
      if (edited) return;
      edited = true;
      ingestFile(store!, repoId, "b.md", `# B\n\n${LONG("beta changed underneath")}\n`, { ts: "2026-01-03T00:00:00.000Z" });
    });
    const worker = new EmbeddingWorker(store!, p);
    const before = buildEmbedTasks(store!, repoId).length;
    expect(before).toBe(2);
    const r = await drainRepo(store!, repoId, worker, p);
    expect(r.mode).toBe("bootstrap");
    // a.md's block was written; b.md's old content was not (stale); the doc pass was built AFTER the edit, so b's new input embeds fine.
    expect(r.embedded).toBe(1);
    expect(r.stale).toBe(1);
    expect(r.docStale).toBe(0);
    const oldHash = (store!.db.prepare("SELECT lower(hex(raw_hash)) h FROM blocks WHERE deleted_at IS NOT NULL AND type = 'paragraph'").get() as { h: string } | undefined)?.h;
    if (oldHash) expect(count("SELECT count(*) c FROM embeddings WHERE lower(hex(content_hash)) = ?", oldHash)).toBe(0);
    // The watermark is the head READ AT THE START (2): the edit (seq 3) is caught up next pass.
    expect(readWatermark(store!, repoId)?.processed_seq).toBe(2);
    const next = await drainRepo(store!, repoId, worker, p);
    expect(next.mode).toBe("catch-up");
    expect(next.embedded).toBe(1);
    expect(readWatermark(store!, repoId)?.processed_seq).toBe(3);
  });

  it("a document edited while the provider answers keeps its previous vector until the next pass (the doc guard)", async () => {
    const { repoId } = seed();
    let calls = 0;
    const p = provider("m", 4, (texts) => {
      calls++;
      // The second call is the doc pass: edit a.md underneath it.
      if (calls === 2 && texts.some((t) => t.startsWith("A · a.md"))) {
        ingestFile(store!, repoId, "a.md", `# A\n\n${LONG("alpha changed underneath")}\n`, { ts: "2026-01-03T00:00:00.000Z" });
      }
    });
    const r = await drainRepo(store!, repoId, new EmbeddingWorker(store!, p), p);
    expect(r.docEmbedded).toBe(1);
    expect(r.docStale).toBe(1);
    const docA = (store!.db.prepare("SELECT doc_id FROM docs WHERE path = 'a.md'").get() as { doc_id: string }).doc_id;
    expect(count("SELECT count(*) c FROM doc_embeddings WHERE doc_id = ?", docA)).toBe(0);
  });
});
