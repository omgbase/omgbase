import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { docsOutline } from "../core/read/outline.js";
import { nodesGetMany } from "../core/read/nodes.js";
import { oqxRun } from "../oqx/run.js";
import { textSearch } from "../search/text.js";
import { docsList, docsTree } from "../core/read/reader.js";
import { CursorInvalid } from "../core/cursor.js";

// Budget + cursor audit (07 task 6.1). Every hydrating / list-shaped result must
// carry an honest truncated flag (and cursor where paginated).

let store: Store;
let repoId: string;

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", "/tmp");
});
afterEach(() => store.close());

function bigDoc(): string {
  const paras = Array.from({ length: 40 }, (_, i) => `paragraph number ${i} with a fair amount of words to consume budget space`);
  ingestFile(store, repoId, "big.md", "# Big\n\n" + paras.join("\n\n") + "\n");
  return (store.db.prepare("SELECT doc_id FROM docs WHERE path='big.md'").get() as { doc_id: string }).doc_id;
}

describe("budget_tokens + cursor audit", () => {
  it("docs_outline truncates under a token budget and flags it", () => {
    const docId = bigDoc();
    const full = docsOutline(store, docId);
    expect(full.truncated).toBe(false);
    const tight = docsOutline(store, docId, { budgetTokens: 10 });
    expect(tight.truncated).toBe(true);
  });

  it("nodes_get_many truncates under a token budget", () => {
    const docId = bigDoc();
    const ids = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id=? AND type='paragraph'").all(docId) as { block_id: string }[]).map((r) => r.block_id);
    const res = nodesGetMany(store, docId, ids, { resolution: "text", budgetTokens: 20 });
    expect(res.truncated).toBe(true);
    expect(res.nodes.length).toBeLessThan(ids.length);
  });

  it("query carries truncated + a resumable cursor", () => {
    bigDoc();
    const page = oqxRun(store, repoId, "from blocks", { limit: 5 });
    expect(page.truncated).toBe(true);
    expect(page.cursor).not.toBeNull();
    const next = oqxRun(store, repoId, "from blocks", { limit: 5, cursor: page.cursor });
    // no overlap between pages
    const firstIds = new Set(page.hits.map((h) => h.id));
    expect(next.hits.some((h) => firstIds.has(h.id))).toBe(false);
  });

  it("every paged surface rejects a foreign cursor with the same CursorInvalid", () => {
    bigDoc();
    ingestFile(store, repoId, "second.md", "# Second\n");
    const listCursor = docsList(store, repoId, { limit: 1 }).cursor;
    expect(listCursor).not.toBeNull();
    // A docs_list cursor ([path]) is not a query cursor ([path, id]) — arity mismatch, loud.
    expect(() => oqxRun(store, repoId, "from blocks", { limit: 5, cursor: listCursor })).toThrow(CursorInvalid);
    expect(() => oqxRun(store, repoId, "from blocks", { limit: 5, cursor: "garbage" })).toThrow(CursorInvalid);
    expect(() => docsList(store, repoId, { cursor: "garbage" })).toThrow(CursorInvalid);
    expect(() => docsTree(store, repoId, { cursor: "garbage" })).toThrow(CursorInvalid);
  });

  it("text_search carries truncated at the limit boundary", () => {
    bigDoc();
    const res = textSearch(store, repoId, "paragraph", { limit: 3 });
    expect(res.truncated).toBe(true);
    expect(res.hits.length).toBe(3);
  });

  it("docs_list carries truncated + a resumable cursor and honors a token budget", () => {
    for (let i = 0; i < 6; i++) ingestFile(store, repoId, `d/${i}.md`, `# ${i}\n`);
    const page = docsList(store, repoId, { limit: 4 });
    expect(page.truncated).toBe(true);
    expect(page.cursor).not.toBeNull();
    const next = docsList(store, repoId, { limit: 4, cursor: page.cursor });
    const first = new Set(page.items.map((r) => r.path));
    expect(next.items.some((r) => first.has(r.path))).toBe(false);
    expect(next.truncated).toBe(false);
    const tight = docsList(store, repoId, { budgetTokens: 5 });
    expect(tight.truncated).toBe(true);
    expect(tight.items.length).toBeGreaterThanOrEqual(1);
  });

  it("docs_tree carries truncated + a resumable cursor and honors a token budget", () => {
    for (let i = 0; i < 6; i++) ingestFile(store, repoId, `d${i}/x.md`, `# ${i}\n`);
    const page = docsTree(store, repoId, { limit: 4 });
    expect(page.truncated).toBe(true);
    expect(page.cursor).not.toBeNull();
    expect(page.total.docs).toBe(6);
    const next = docsTree(store, repoId, { limit: 4, cursor: page.cursor });
    expect(next.entries.map((e) => e.path)).toEqual(["d4/", "d5/"]);
    expect(next.truncated).toBe(false);
    const tight = docsTree(store, repoId, { budgetTokens: 5 });
    expect(tight.truncated).toBe(true);
    expect(tight.entries.length).toBeGreaterThanOrEqual(1);
  });
});
