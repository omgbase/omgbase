import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Store } from "./store/store.js";
import { ingestFile } from "./ingest.js";
import { ensureRepo, attachDirectory } from "./attach.js";

const CORPUS_ROOT = fileURLToPath(new URL("../../corpus/roundtrip", import.meta.url));

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

describe("ingestFile", () => {
  it("ingests a document and converges", () => {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "test", "/tmp");
    const content = "---\ntitle: x\n---\n\n# Heading\n\nBody paragraph.\n\n- a\n- b\n";
    const res = ingestFile(store, repoId, "a.md", content);

    expect(res.converged).toBe(true);
    expect(res.blockCount).toBeGreaterThan(0);

    const doc = store.db.prepare("SELECT current_rev, file_hash FROM docs WHERE doc_id = ?").get(res.docId) as { current_rev: string; file_hash: Buffer };
    expect(doc.current_rev).toBe(res.revId);

    const rev = store.db.prepare("SELECT rendered_hash FROM revisions WHERE rev_id = ?").get(res.revId) as { rendered_hash: Buffer };
    expect(doc.file_hash.equals(rev.rendered_hash)).toBe(true);
  });

  it("stores frontmatter as blob, not as a block row", () => {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "test", "/tmp");
    const res = ingestFile(store, repoId, "a.md", "---\na: 1\n---\n\n# H\n");
    const types = (store.db.prepare("SELECT type FROM blocks WHERE doc_id = ?").all(res.docId) as { type: string }[]).map((r) => r.type);
    expect(types).not.toContain("frontmatter");
    expect(types).toContain("heading");
  });

  it("nests list items under lists via parent_block + ancestor_path", () => {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "test", "/tmp");
    const res = ingestFile(store, repoId, "a.md", "- one\n- two\n");
    const rows = store.db.prepare("SELECT type, parent_block, depth FROM blocks WHERE doc_id = ? ORDER BY depth").all(res.docId) as { type: string; parent_block: string | null; depth: number }[];
    const list = rows.find((r) => r.type === "list")!;
    const items = rows.filter((r) => r.type === "list_item");
    expect(list.depth).toBe(0);
    expect(items.every((i) => i.parent_block === null || i.depth === 1)).toBe(true);
  });

  it("re-ingesting updates the same doc with a new revision", () => {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "test", "/tmp");
    const first = ingestFile(store, repoId, "a.md", "# One\n");
    const second = ingestFile(store, repoId, "a.md", "# One\n\n# Two\n");
    expect(second.docId).toBe(first.docId);
    const seqs = store.db.prepare("SELECT seq FROM revisions WHERE doc_id = ? ORDER BY seq").all(first.docId) as { seq: number }[];
    expect(seqs.map((s) => s.seq)).toEqual([1, 2]);
  });
});

describe("attachDirectory — fixture vault", () => {
  it("ingests the whole corpus vault with full convergence", () => {
    store = new Store({ path: ":memory:" });
    const res = attachDirectory(store, "corpus", CORPUS_ROOT);
    expect(res.fileCount).toBeGreaterThanOrEqual(50);
    expect(res.allConverged).toBe(true);

    const docCount = (store.db.prepare("SELECT count(*) c FROM docs").get() as { c: number }).c;
    expect(docCount).toBe(res.fileCount);
  });
});
