import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { Store } from "./store/store.js";
import { ingestFile } from "./ingest.js";
import { ensureRepo } from "./attach.js";
import { ingestDirectory } from "../sync/attach.js";
import { observeBatch } from "../sync/observe.js";

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

  it("stores node spans as UTF-8 byte offsets into the block raw (spec/graph §2.3)", () => {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "test", "/tmp");
    const raw = "Café 🚀 [a](/x.md) ^ref";
    const res = ingestFile(store, repoId, "a.md", raw + "\n");
    const rows = store.db
      .prepare("SELECT kind, span_start, span_end FROM nodes WHERE doc_id = ? AND span_start IS NOT NULL ORDER BY span_start")
      .all(res.docId) as { kind: string; span_start: number; span_end: number }[];
    const bytes = Buffer.from(raw, "utf8");
    expect(rows.map((r) => [r.kind, bytes.subarray(r.span_start, r.span_end).toString("utf8")])).toEqual([
      ["md:link", "[a](/x.md)"],
      ["md:anchor", "^ref"],
    ]);
    // Code units would say 8; bytes say 11 (é is 2 bytes, 🚀 is 4).
    expect(rows[0]!.span_start).toBe(11);
    expect(raw.indexOf("[a]")).toBe(8);
  });

  it("a revived document adopts the phantom edges minted at its path while it was tombstoned (spec/graph §3.5)", () => {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "test", "/tmp");
    const b = ingestFile(store, repoId, "b.md", "Target.\n");
    observeBatch(store, repoId, [{ path: "b.md", content: null }], "2026-09-26T10:01:00.000Z");
    const a = observeBatch(store, repoId, [{ path: "a.md", content: "See [b](/b.md) for the full discussion.\n" }], "2026-09-26T10:02:00.000Z")[0]!;
    const aDoc = a.kind === "deleted" ? null : a.docId;
    const edge = (): { dst_node: string; edge_id: string; from_commit: string } =>
      store!.db.prepare("SELECT dst_node, edge_id, from_commit FROM edges WHERE src_doc = ? AND to_commit IS NULL").get(aDoc) as { dst_node: string; edge_id: string; from_commit: string };
    const rollup = (): { dst_node: string; count: number }[] => store!.db.prepare("SELECT dst_node, count FROM doc_edges WHERE src_doc = ?").all(aDoc) as { dst_node: string; count: number }[];
    const before = edge();
    expect(before.dst_node).toBe("phantom:b.md");
    expect(rollup()).toEqual([{ dst_node: "phantom:b.md", count: 1 }]);

    observeBatch(store, repoId, [{ path: "b.md", content: "Target again.\n" }], "2026-09-26T10:03:00.000Z");
    const after = edge();
    expect(after).toEqual({ ...before, dst_node: b.docId });
    expect(rollup()).toEqual([{ dst_node: b.docId, count: 1 }]);
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

describe("ingestDirectory — fixture vault", () => {
  it("ingests the whole corpus vault with full convergence", () => {
    store = new Store({ path: ":memory:" });
    const res = ingestDirectory(store, "corpus", CORPUS_ROOT);
    expect(res.fileCount).toBeGreaterThanOrEqual(50);
    expect(res.allConverged).toBe(true);

    const docCount = (store.db.prepare("SELECT count(*) c FROM docs").get() as { c: number }).c;
    expect(docCount).toBe(res.fileCount);
  });
});
