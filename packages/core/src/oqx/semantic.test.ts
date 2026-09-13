import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { EmbeddingWorker, type EmbeddingProvider } from "../search/embeddings.js";
import { buildEmbedTasks, buildDocEmbedTasks } from "../search/tasks.js";
import { sha256 } from "../core/hash.js";
import { oqxRun, oqxRunAsync, collectSemanticPhrases, type EmbedQuery } from "./run.js";

// End-to-end tests for OQX's `semantic("phrase")` scalar score — a cosine
// similarity computed by the `cosine` SQLite UDF against pre-embedded block/doc
// vectors. A bag-of-words provider makes cosine reflect lexical overlap, so a
// topically-matching row scores > 0 and an unrelated row scores 0 (no shared
// words), which is enough to assert threshold pruning and projection.

let store: Store;
let repoId: string;
let worker: EmbeddingWorker;

// L2-normalized per-word hashed histogram: unrelated texts share no words ⇒
// cosine ≈ 0; overlapping texts ⇒ cosine > 0. dim=512 keeps hash collisions
// negligible so disjoint-vocabulary docs score ~0 against each other.
function bowProvider(dim = 512): EmbeddingProvider {
  return {
    model: "bow-oqx",
    dim,
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

const embed: EmbedQuery = async (t) => ({ model: "bow-oqx", vec: await worker.embedQuery(t) });

beforeEach(async () => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", "/tmp");
  // Two topically distinct documents with disjoint vocabulary. Each body
  // paragraph is ≥24 words so shouldEmbed() keeps it (block-grain embedding).
  ingestFile(store, repoId, "consensus.md",
    "# Consensus\n\ndistributed consensus protocols require careful handling of network partitions leader election quorum " +
    "replication logs commit index heartbeat timeout term voting majority acknowledgement failover recovery snapshot durability latency throughput\n");
  ingestFile(store, repoId, "cats.md",
    "# Cats\n\nkittens cats enjoy sitting soft woolen blankets beside crackling hearth indoors during long lazy winter " +
    "afternoons purring gently whiskers twitching chasing yarn dozing sunbeams grooming velvet paws contented drowsy\n");
  worker = new EmbeddingWorker(store, bowProvider());
  await worker.process(buildEmbedTasks(store, repoId));
  await worker.processDocs(buildDocEmbedTasks(store, repoId));
});
afterEach(() => store.close());

describe("OQX semantic() — blocks target", () => {
  it("projects a cosine score; the on-topic block scores highest", async () => {
    const { hits } = await oqxRunAsync(
      store, repoId, 'from blocks where type == "paragraph" select s: semantic("kittens purring beside crackling hearth")', {}, embed,
    );
    const scored = hits
      .map((h) => ({ path: h.path, s: h.s as number | null }))
      .filter((h) => typeof h.s === "number");
    const best = scored.slice().sort((a, b) => (b.s as number) - (a.s as number))[0]!;
    expect(best.path).toBe("cats.md");
    expect(best.s as number).toBeGreaterThan(0);
  });

  it("threshold pruning keeps the topical block, drops the unrelated one", async () => {
    const { hits } = await oqxRunAsync(
      store, repoId, 'from blocks where semantic("kittens purring beside crackling hearth") > 0.1', {}, embed,
    );
    expect(hits.map((h) => h.path)).toEqual(["cats.md"]); // consensus block shares no words ⇒ cosine ≈ 0
  });

  it("composes with a structural predicate (AND)", async () => {
    const both = await oqxRunAsync(
      store, repoId, 'from blocks where semantic("network partitions quorum replication") > 0.1 && $path == "consensus.md"', {}, embed,
    );
    expect(both.hits.map((h) => h.path)).toEqual(["consensus.md"]);
  });
});

describe("OQX semantic() — docs target", () => {
  it("scores whole-document vectors and prunes by threshold", async () => {
    const { hits } = await oqxRunAsync(
      store, repoId, 'from docs where semantic("leader election quorum replication") > 0.1', {}, embed,
    );
    expect(hits.map((h) => h.path)).toEqual(["consensus.md"]);
  });
});

describe("OQX semantic() — provider wiring", () => {
  it("collectSemanticPhrases finds the distinct phrases a query embeds", () => {
    const phrases = collectSemanticPhrases(
      'from blocks where semantic("alpha") > 0.5 select a: semantic("alpha"), b: semantic("beta")',
    );
    expect(phrases.slice().sort()).toEqual(["alpha", "beta"]); // "alpha" deduped
  });

  it("a query with no semantic() runs on the sync core (embedQuery never needed)", async () => {
    const { hits } = await oqxRunAsync(store, repoId, 'from docs where $path == "cats.md"'); // no embedder passed
    expect(hits.map((h) => h.path)).toEqual(["cats.md"]);
  });

  it("semantic() with no embedding provider is a loud error", async () => {
    await expect(oqxRunAsync(store, repoId, 'from blocks where semantic("x") > 0.5')).rejects.toThrow(
      /needs an embedding provider/,
    );
  });

  it("the sync core rejects semantic() when no vectors are pre-resolved", () => {
    expect(() => oqxRun(store, repoId, 'from blocks where semantic("x") > 0.5')).toThrow(/embedding provider/);
  });
});

describe("OQX semantic() — loud misuse", () => {
  it("bare semantic() in where (no comparison) is rejected", async () => {
    await expect(oqxRunAsync(store, repoId, 'from blocks where semantic("x")', {}, embed)).rejects.toThrow(
      /returns a score; compare it/,
    );
  });

  it("semantic() on the nodes target is rejected (nodes have no embeddings)", async () => {
    await expect(oqxRunAsync(store, repoId, 'from nodes where semantic("x") > 0.5', {}, embed)).rejects.toThrow(
      /docs and blocks/,
    );
  });
});

describe("OQX semantic() — ranking via order by", () => {
  it("order by semantic(...) desc ranks the topical block first", async () => {
    const { hits } = await oqxRunAsync(
      store, repoId,
      'from blocks where type == "paragraph" order by semantic("kittens purring beside crackling hearth") desc',
      {}, embed,
    );
    expect(hits[0]!.path).toBe("cats.md");
  });

  it("repo.first + order by semantic returns the single most similar row", async () => {
    const { hits } = await oqxRunAsync(
      store, repoId,
      'repo.blocks first { where type == "paragraph" order by semantic("network partitions quorum replication") desc }',
      {}, embed,
    );
    expect(hits.map((h) => h.path)).toEqual(["consensus.md"]);
  });
});
