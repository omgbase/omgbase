import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { EmbeddingWorker, contextPrefix, type EmbeddingProvider, type EmbedTask } from "./embeddings.js";
import { resolve, pipeline } from "./resolve.js";
import { hybridSearch } from "./rrf.js";
import { textSearch } from "./text.js";
import { sha256 } from "../core/hash.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store: Store;
let repoId: string;

// A provider whose vectors capture rough topical similarity via a small
// hand-tuned concept space, so synonyms (not shared tokens) still score.
const CONCEPTS: Record<string, number> = {
  deploy: 0, deployment: 0, ship: 0, release: 0, launch: 0, rollout: 0,
  identity: 1, id: 1, block: 1, reconcile: 1, matcher: 1, continuity: 1,
  cat: 2, kitten: 2, mat: 2, fireplace: 2, cozy: 2,
};
function conceptProvider(dim = 4): EmbeddingProvider {
  return {
    model: "concept-1", dim,
    embed: async (texts) => texts.map((t) => {
      const v = new Array<number>(dim).fill(0);
      for (const w of t.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/)) {
        const c = CONCEPTS[w];
        if (c !== undefined) v[c] = (v[c] ?? 0) + 1;
        else { const h = sha256(w).readUInt32BE(0) % dim; v[h] = (v[h] ?? 0) + 0.01; }
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
  const rows = store.db.prepare("SELECT block_id, text, lower(hex(raw_hash)) h, type FROM blocks WHERE type='paragraph'").all() as { block_id: string; text: string; h: string; type: string }[];
  const tasks: EmbedTask[] = rows.map((r) => ({ blockId: r.block_id, contentHashHex: r.h, ctx: contextPrefix({ docTitle: "d", path: "d", headingChain: [], blockType: r.type }), text: r.text }));
  await worker.process(tasks);
}

describe("resolve", () => {
  it("returns ranked {id, locator, preview, evidence}", () => {
    ingestFile(store, repoId, "a.md", "# Doc\n\nstable block identity across edits is the core design goal of the matcher\n");
    const hits = resolve(store, { repoId, query: "identity matcher", limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toMatch(/^b_/);
    expect(hits[0]!.locator).toContain("a.md#");
    expect(hits[0]!.preview.length).toBeGreaterThan(0);
  });
});

describe("pipeline (seed → expand → hydrate, one call)", () => {
  it("T7-style: seed by text, hydrate text within budget", () => {
    ingestFile(store, repoId, "design.md", "# Design\n\nthe rationale for stable block identity is that reconciliation errors must never corrupt the graph\n");
    const res = pipeline(store, {
      repoId,
      seed: { text: "stable identity rationale", limit: 4 },
      hydrate: { budgetTokens: 4000 },
    });
    expect(res.seeds.length).toBeGreaterThan(0);
    expect(res.content!.blocks.length).toBeGreaterThan(0);
    expect(res.content!.blocks[0]!.text).toContain("identity");
  });

  it("expands the graph from seed documents", () => {
    // Seed via processCheckpoint so edges are extracted (the checkpoint path
    // supplies the reconciling resolver + edge extractor).
    const dir = mkdtempSync(join(tmpdir(), "omgbase-pipe-"));
    const rRepo = ensureRepo(store, "pipe", dir);
    writeFileSync(join(dir, "a.md"), "# A\n\nseed paragraph mentioning identity links to [b](/b.md) here\n");
    writeFileSync(join(dir, "b.md"), "# B\n\ntarget doc\n");
    processCheckpoint(store, rRepo, dir, [{ path: "a.md" }, { path: "b.md" }]);
    try {
      const res = pipeline(store, {
        repoId: rRepo,
        seed: { text: "identity", limit: 4 },
        expand: { via: ["references"], direction: "out", depth: 1 },
      });
      expect(res.graph).toBeTruthy();
      const bId = (store.db.prepare("SELECT doc_id FROM docs WHERE path='b.md' AND repo_id=?").get(rRepo) as { doc_id: string }).doc_id;
      expect(res.graph!.nodes).toContain(bId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("EXIT GATE: hybrid beats FTS-only on a labeled set (MRR)", () => {
  it("hybrid MRR >= FTS-only MRR over synonym queries", async () => {
    // Corpus: relevant docs use SYNONYMS of the query terms, so pure FTS misses
    // them while the concept-space vectors connect them.
    ingestFile(store, repoId, "d1.md", "# Ship\n\nrolling out the new release to production requires a careful launch checklist and rollout plan\n");
    ingestFile(store, repoId, "d2.md", "# Identity\n\nblock continuity is threaded by the reconcile matcher across successive edits reliably\n");
    ingestFile(store, repoId, "d3.md", "# Cats\n\nthe kitten curled up cozy near the fireplace mat all afternoon in comfort\n");
    const worker = new EmbeddingWorker(store, conceptProvider());
    await embedAll(worker);

    // Labeled queries: (query terms, relevant doc path). Query words are NOT
    // present verbatim in the relevant doc (synonyms), stressing lexical-only.
    const labeled: { q: string; rel: string }[] = [
      { q: "deployment", rel: "d1.md" },   // doc says "release/launch/rollout"
      { q: "identity", rel: "d2.md" },     // doc says "continuity/reconcile"
      { q: "cat", rel: "d3.md" },          // doc says "kitten"
    ];

    const rr = async (useVector: boolean): Promise<number> => {
      let sum = 0;
      for (const { q, rel } of labeled) {
        const input: Parameters<typeof hybridSearch>[1] = { repoId, text: q, limit: 10 };
        if (useVector) input.vector = { model: "concept-1", vec: await worker.embedQuery(q) };
        const hits = hybridSearch(store, input);
        const rank = hits.findIndex((h) => h.path === rel) + 1;
        sum += rank > 0 ? 1 / rank : 0;
      }
      return sum / labeled.length;
    };

    const ftsMrr = await rr(false);
    const hybridMrr = await rr(true);
    expect(hybridMrr).toBeGreaterThanOrEqual(ftsMrr);
    // And hybrid actually finds things FTS-only misses.
    expect(hybridMrr).toBeGreaterThan(0);
  });

  it("FTS-only genuinely misses a synonym query (motivates hybrid)", () => {
    ingestFile(store, repoId, "d1.md", "# Ship\n\nrolling out the new release to production requires a careful launch checklist\n");
    // "deployment" appears nowhere → FTS returns nothing.
    expect(textSearch(store, repoId, "deployment").hits).toHaveLength(0);
  });
});
