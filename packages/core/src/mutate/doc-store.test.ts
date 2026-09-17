import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { findDoc } from "../core/read/reader.js";
import { docsRead } from "../core/read/document.js";
import { apply } from "./apply.js";
import { docsCreate, docsSetMeta, docsMove, docsDelete } from "./docs.js";
import { NullDocStore } from "./doc-store.js";

// The DocStore seam (ADR-014 §5): a headless, DB-canonical repo has no working
// tree. With a NullDocStore the mutation write path commits to the DB and the
// file write is a no-op — no rootPath, no node:fs, no disk. This proves the
// engine's write-through kernel works with the filesystem abstracted away.

let store: Store;
let repoId: string;

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", null); // sourceless repo (root_path NULL)
});
afterEach(() => store.close());

describe("mutation write path with a headless NullDocStore", () => {
  it("applies block ops with no working tree (DB is the artifact)", () => {
    // Seed a doc directly in the DB (as observe/an ingest would).
    const ing = ingestFile(store, repoId, "a.md", "# Title\n\nAlpha.\n");

    const res = apply(store, {
      repoId,
      docStore: new NullDocStore(),
      ops: [{ op: "insert", doc: ing.docId, to: { parent: { doc: true }, at: "end" }, markdown: "New tail paragraph." }],
      origin: { actor: "test" },
    });
    expect(res.committed).toBe(true);

    // The change is in the DB and reconstructs byte-for-byte from it — no file.
    const read = docsRead(store, ing.docId);
    expect(read!.content).toContain("New tail paragraph.");
  });

  it("docsCreate / setMeta / move / delete all work headless", () => {
    const ctx = { repoId, docStore: new NullDocStore() };

    const created = docsCreate(store, ctx, "notes/x.md", "# X\n\nBody.\n", { layer: "draft" });
    expect(created.committed).toBe(true);
    expect(findDoc(store, { repoId, path: "notes/x.md" })).toBeTruthy();

    const meta = docsSetMeta(store, ctx, "notes/x.md", { set: { layer: "working" } });
    expect(meta.committed).toBe(true);
    const afterMeta = docsRead(store, meta.docId);
    expect(afterMeta!.content).toContain("layer: working");

    const moved = docsMove(store, ctx, "notes/x.md", "notes/y.md");
    expect(moved.path).toBe("notes/y.md");
    expect(findDoc(store, { repoId, path: "notes/x.md" })).toBeNull();
    expect(findDoc(store, { repoId, path: "notes/y.md" })).toBeTruthy();

    const deleted = docsDelete(store, ctx, "notes/y.md");
    expect(deleted.committed).toBe(true);
    expect(findDoc(store, { repoId, path: "notes/y.md" })).toBeNull();
  });
});
