import { describe, it, expect, afterEach } from "vitest";
import { Store } from "./store.js";
import { assignIds, writeBlockTree, putBlob, putTreeNode, newCommit, writeRevision } from "./writers.js";
import { parseTree } from "../parse/tree.js";
import { sha256 } from "../hash.js";
import type { TreeInputBlock } from "./writers.js";

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

function fresh(): Store {
  const s = new Store({ path: ":memory:" });
  s.db.prepare("INSERT INTO repos (repo_id, slug, root_path) VALUES ('rp_1','s','/tmp')").run();
  return s;
}

describe("content-addressed writers", () => {
  it("dedups identical blobs and tree nodes", () => {
    store = fresh();
    const h1 = putBlob(store.db, "same text");
    const h2 = putBlob(store.db, "same text");
    expect(h1).toBe(h2);
    expect((store.db.prepare("SELECT count(*) c FROM blobs").get() as { c: number }).c).toBe(1);

    const e = [{ blockId: "b_a", rawHashHex: h1, childTreeHashHex: null, type: "paragraph", attrs: {}, triviaHashHex: null }];
    expect(putTreeNode(store.db, e)).toBe(putTreeNode(store.db, e));
    expect((store.db.prepare("SELECT count(*) c FROM tree_nodes").get() as { c: number }).c).toBe(1);
  });

  it("structural sharing: editing one block in a 500-block flat doc adds <= depth+2 tree rows", () => {
    store = fresh();
    const blocks: TreeInputBlock[] = Array.from({ length: 500 }, (_, i) => ({
      blockId: `b_${i.toString(36).padStart(5, "0")}`,
      type: "paragraph",
      raw: `Paragraph number ${i}.`,
      trivia: "\n\n",
      attrs: {},
      children: [],
    }));

    writeBlockTree(store.db, blocks);
    const treesAfter1 = (store.db.prepare("SELECT count(*) c FROM tree_nodes").get() as { c: number }).c;
    const blobsAfter1 = (store.db.prepare("SELECT count(*) c FROM blobs").get() as { c: number }).c;

    // Edit exactly one block's content.
    blocks[250]!.raw = "Paragraph number 250 — EDITED.";
    writeBlockTree(store.db, blocks);

    const treesAfter2 = (store.db.prepare("SELECT count(*) c FROM tree_nodes").get() as { c: number }).c;
    const blobsAfter2 = (store.db.prepare("SELECT count(*) c FROM blobs").get() as { c: number }).c;

    // Flat doc: depth 1. New rows: 1 new root tree node + 1 new blob.
    const depth = 1;
    expect(treesAfter2 - treesAfter1).toBeLessThanOrEqual(depth + 2);
    expect(treesAfter2 - treesAfter1).toBe(1); // only the root node changes
    expect(blobsAfter2 - blobsAfter1).toBe(1); // only the edited paragraph's blob
  });

  it("re-writing an unchanged tree adds zero rows", () => {
    store = fresh();
    const tree = parseTree("# A\n\nB\n\nC\n");
    const blocks = assignIds(tree.children);
    const root1 = writeBlockTree(store.db, blocks);
    const trees1 = (store.db.prepare("SELECT count(*) c FROM tree_nodes").get() as { c: number }).c;
    const root2 = writeBlockTree(store.db, blocks);
    const trees2 = (store.db.prepare("SELECT count(*) c FROM tree_nodes").get() as { c: number }).c;
    expect(root1).toBe(root2);
    expect(trees2).toBe(trees1);
  });
});

describe("commit & revision sequencing", () => {
  it("assigns per-repo commit seq and per-doc revision seq", () => {
    store = fresh();
    store.db.prepare("INSERT INTO documents (doc_id, repo_id, path) VALUES ('d_1','rp_1','a.md')").run();

    store.write((db) => {
      const c1 = newCommit(db, { repoId: "rp_1", ts: "t1", origin: "observed" });
      expect(c1.seq).toBe(1);
      const root = writeBlockTree(db, assignIds(parseTree("# A\n").children));
      const r1 = writeRevision(db, { docId: "d_1", rootTreeHex: root, frontmatterBlobHex: null, renderedHash: sha256("# A\n"), path: "a.md", commitId: c1.commitId });
      expect(r1.seq).toBe(1);

      const c2 = newCommit(db, { repoId: "rp_1", ts: "t2", origin: "observed" });
      expect(c2.seq).toBe(2);
      const r2 = writeRevision(db, { docId: "d_1", rootTreeHex: root, frontmatterBlobHex: null, renderedHash: sha256("# A\n"), path: "a.md", commitId: c2.commitId });
      expect(r2.seq).toBe(2);
    });
  });
});
