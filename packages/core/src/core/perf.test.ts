import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Store } from "./store/store.js";
import { ensureRepo } from "./attach.js";
import { ingestFile } from "./ingest.js";
import { docsOutline } from "./read/outline.js";
import { query } from "../search/query.js";

// Perf pass (07 task 7.5). The envelope is 10^6 blocks; a full-scale run is too
// slow for CI, so we validate the query paths stay indexed at a reduced but
// non-trivial scale (a few thousand blocks across hundreds of docs) and assert
// generous p95 latency ceilings. The point is to catch accidental full-scans,
// not to benchmark absolute throughput.

let store: Store;
let repoId: string;

const DOCS = 300;
const PARAS_PER_DOC = 8;

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "perf", "/tmp");
  for (let d = 0; d < DOCS; d++) {
    const layer = ["draft", "proposed", "working", "canon"][d % 4];
    const paras = Array.from({ length: PARAS_PER_DOC }, (_, i) => `paragraph ${i} of document ${d} discussing topic ${d % 20} with assorted words`);
    ingestFile(store, repoId, `d${d}.md`, `---\nlayer: ${layer}\n---\n\n# Document ${d}\n\n## Section A\n\n${paras.join("\n\n")}\n`);
  }
});
afterEach(() => store.close());

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1]!;
}
function bench(n: number, fn: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return p95(times);
}

describe("perf at reduced envelope scale", () => {
  it("ingested the synthetic corpus", () => {
    const blocks = store.db.prepare("SELECT count(*) c FROM blocks WHERE deleted_commit IS NULL").get() as { c: number };
    expect(blocks.c).toBeGreaterThan(DOCS * PARAS_PER_DOC);
  });

  it("docs_outline p95 < 50ms", () => {
    const docIds = (store.db.prepare("SELECT doc_id FROM docs LIMIT 50").all() as { doc_id: string }[]).map((r) => r.doc_id);
    let i = 0;
    const p = bench(50, () => { docsOutline(store, docIds[i++ % docIds.length]!); });
    expect(p).toBeLessThan(50);
  });

  it("query (blocks filter) p95 < 100ms", () => {
    const p = bench(50, () => {
      query(store, repoId, { from: "blocks", filter: 'type == "paragraph" && under_heading("Section A")', limit: 20 });
    });
    expect(p).toBeLessThan(100);
  });

  it("query (docs frontmatter) p95 < 100ms", () => {
    const p = bench(50, () => {
      query(store, repoId, { from: "docs", filter: 'layer == "canon"', limit: 20 });
    });
    expect(p).toBeLessThan(100);
  });

  it("text query p95 < 100ms", () => {
    const p = bench(50, () => {
      query(store, repoId, { from: "blocks", text: "topic", limit: 20 });
    });
    expect(p).toBeLessThan(100);
  });
});
