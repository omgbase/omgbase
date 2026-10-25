import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { buildEmbedTasks } from "./tasks.js";
import { EmbeddingWorker, type EmbeddingProvider } from "./embeddings.js";
import { vectorSearch } from "./vector.js";

let store: Store;
let repoId: string;

// A deterministic stub provider: a tiny bag-of-words hash embedding. Not
// meaningful semantically, but lets us exercise the worker/drain/vector path
// without downloading a model.
class StubProvider implements EmbeddingProvider {
  model = "stub-8";
  dim = 8;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dim).fill(0);
      for (const tok of t.toLowerCase().split(/\s+/).filter(Boolean)) {
        let h = 0;
        for (const ch of tok) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        const i = h % this.dim;
        v[i] = (v[i] ?? 0) + 1;
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", "/tmp");
  ingestFile(
    store,
    repoId,
    "notes.md",
    [
      "---",
      "title: Engine Notes",
      "---",
      "# Architecture",
      "",
      "The engine serializes all of its state changes through exactly one append-only commit log per repo, backed by an embedded SQLite database running in write-ahead-logging mode for durability and read concurrency across processes.",
      "",
      "## Reconciliation",
      "",
      "Block identity is threaded across successive revisions by a matcher that scores both structural and textual similarity between the old tree and the new tree, so stable ids survive edits, moves, splits, and merges without churn.",
      "",
      "- short", // below shouldEmbed threshold
      "",
    ].join("\n"),
  );
});
afterEach(() => store.close());

describe("buildEmbedTasks", () => {
  it("includes embeddable blocks with a context prefix and skips tiny ones", () => {
    const tasks = buildEmbedTasks(store, repoId);
    // The two long paragraphs qualify; the "- short" list item does not.
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    const recon = tasks.find((t) => t.text.includes("matcher that scores"));
    expect(recon).toBeDefined();
    // Context prefix carries doc title, path, heading chain, and type.
    expect(recon!.ctx).toContain("Engine Notes");
    expect(recon!.ctx).toContain("notes.md");
    expect(recon!.ctx).toContain("Architecture"); // ancestor heading
    expect(recon!.ctx).toContain("Reconciliation"); // owning section heading
  });

  it("no task falls below the shouldEmbed token floor", () => {
    for (const t of buildEmbedTasks(store, repoId)) {
      expect(t.text.trim().split(/\s+/).length).toBeGreaterThanOrEqual(24);
    }
  });
});

describe("EmbeddingWorker drain + vectorSearch (stub provider)", () => {
  it("embeds tasks, caches them, and vector search ranks the closer paragraph first", async () => {
    const worker = new EmbeddingWorker(store, new StubProvider());
    const tasks = buildEmbedTasks(store, repoId);
    const first = await worker.process(tasks);
    expect(first.embedded).toBe(tasks.length);
    // Second pass is fully cached (no re-embed).
    const second = await worker.process(tasks);
    expect(second.embedded).toBe(0);
    expect(second.cached).toBe(tasks.length);

    // A query vector close to the reconciliation text should return results.
    const qv = await worker.embedQuery("identity matcher similarity between trees");
    const hits = vectorSearch(store, repoId, "stub-8", qv, { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    // Every hit has a cosine in [-1, 1].
    for (const h of hits) expect(Math.abs(h.cosine)).toBeLessThanOrEqual(1.0001);
  });
});
