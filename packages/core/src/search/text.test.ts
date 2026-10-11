import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { textSearch } from "./text.js";

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

function setup(): string {
  store = new Store({ path: ":memory:" });
  const repoId = ensureRepo(store, "t", "/tmp");
  ingestFile(store, repoId, "a.md", "# Reconciliation\n\nStable block identity is difficult to achieve.\n\nThe matcher uses shingle indexes.\n");
  ingestFile(store, repoId, "b.md", "# Storage\n\nSQLite with WAL mode and structural sharing.\n");
  return repoId;
}

describe("textSearch — FTS5", () => {
  it("finds blocks matching a term, ranked", () => {
    const repoId = setup();
    const { hits } = textSearch(store!, repoId, "identity");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain("identity");
  });

  it("matches across documents and reports the path", () => {
    const repoId = setup();
    const { hits } = textSearch(store!, repoId, "WAL");
    expect(hits[0]!.path).toBe("b.md");
  });

  it("supports FTS phrase queries", () => {
    const repoId = setup();
    const { hits } = textSearch(store!, repoId, '"shingle indexes"');
    expect(hits.length).toBe(1);
    expect(hits[0]!.text).toContain("shingle");
  });

  it("re-ingest updates the index (no stale hits)", () => {
    const repoId = setup();
    ingestFile(store!, repoId, "a.md", "# Reconciliation\n\nCompletely rewritten content about embeddings.\n");
    expect(textSearch(store!, repoId, "shingle").hits).toHaveLength(0);
    expect(textSearch(store!, repoId, "embeddings").hits.length).toBe(1);
  });

  it("honors the limit and flags truncation", () => {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "t", "/tmp");
    ingestFile(store, repoId, "big.md", "# H\n\n" + Array.from({ length: 10 }, (_, i) => `paragraph about widgets number ${i}`).join("\n\n") + "\n");
    const { hits, truncated } = textSearch(store, repoId, "widgets", { limit: 3 });
    expect(hits).toHaveLength(3);
    expect(truncated).toBe(true);
  });
});
