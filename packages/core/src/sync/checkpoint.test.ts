import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { processCheckpoint } from "./checkpoint.js";
import { readFileSync } from "node:fs";
import { render } from "../core/parse/render.js";
import { parseTree } from "../core/parse/tree.js";
import { textSearch } from "../search/text.js";
import { sha256 } from "../core/hash.js";
import { DEFAULT_CONFIG } from "../reconcile/types.js";

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-sync-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function commitCount(): number {
  return (store.db.prepare("SELECT count(*) c FROM commits").get() as { c: number }).c;
}

describe("processCheckpoint", () => {
  it("ingests a human edit as an observed commit", () => {
    writeFileSync(join(dir, "a.md"), "# Hello\n\nBody.\n");
    const res = processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    expect(res.ingested).toEqual(["a.md"]);
    expect(res.suppressed).toEqual([]);
    const commit = store.db.prepare("SELECT origin FROM commits ORDER BY seq DESC LIMIT 1").get() as { origin: string };
    expect(commit.origin).toBe("observed");
  });

  it("echo-suppresses a write whose bytes already match the stored revision", () => {
    const content = "# Hello\n\nBody.\n";
    writeFileSync(join(dir, "a.md"), content);
    ingestFile(store, repoId, "a.md", content); // engine already knows these bytes
    const before = commitCount();

    // Simulate the watcher seeing the engine's own write (bytes unchanged).
    const res = processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    expect(res.suppressed).toEqual(["a.md"]);
    expect(res.ingested).toEqual([]);
    expect(commitCount()).toBe(before); // no new commit
  });

  it("records a checkpoint row with file entries", () => {
    writeFileSync(join(dir, "a.md"), "# A\n");
    const res = processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    const cp = store.db.prepare("SELECT files FROM checkpoints WHERE id = ?").get(res.checkpointId) as { files: string };
    const files = JSON.parse(cp.files) as [string, string | null, string | null][];
    expect(files[0]![0]).toBe("a.md");
    expect(files[0]![1]).toBeNull(); // no prior hash
    expect(files[0]![2]).not.toBeNull(); // new hash present
  });

  it("detects deletion of a known document", () => {
    writeFileSync(join(dir, "a.md"), "# A\n");
    processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    unlinkSync(join(dir, "a.md"));
    const res = processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    expect(res.deleted).toEqual(["a.md"]);
  });

  it("tombstones a deleted doc: blocks tombstoned, FTS + reads stop serving it, observed commit", () => {
    writeFileSync(join(dir, "ghost.md"), "# Ghost\n\nsearchableghostword lives here\n");
    processCheckpoint(store, repoId, dir, [{ path: "ghost.md" }]);
    const doc = store.db.prepare("SELECT doc_id FROM docs WHERE path='ghost.md'").get() as { doc_id: string };

    // Live + FTS-indexed before deletion.
    expect(textSearch(store, repoId, "searchableghostword").hits.length).toBeGreaterThanOrEqual(1);

    unlinkSync(join(dir, "ghost.md"));
    const res = processCheckpoint(store, repoId, dir, [{ path: "ghost.md" }]);
    expect(res.deleted).toEqual(["ghost.md"]);

    // The doc row is tombstoned and no longer served by the live-docs query.
    const live = store.db.prepare("SELECT doc_id FROM docs WHERE path='ghost.md' AND deleted_commit IS NULL").get();
    expect(live).toBeUndefined();
    const tombstoned = store.db.prepare("SELECT deleted_commit FROM docs WHERE doc_id=?").get(doc.doc_id) as { deleted_commit: string | null };
    expect(tombstoned.deleted_commit).not.toBeNull();

    // Its blocks are tombstoned and FTS no longer returns it.
    const liveBlocks = store.db.prepare("SELECT count(*) c FROM blocks WHERE doc_id=? AND deleted_commit IS NULL").get(doc.doc_id) as { c: number };
    expect(liveBlocks.c).toBe(0);
    expect(textSearch(store, repoId, "searchableghostword").hits.length).toBe(0);

    // The tombstone commit is observed-origin (engine witnessed it, did not author it).
    const commit = store.db.prepare("SELECT origin FROM commits WHERE commit_id=?").get(tombstoned.deleted_commit) as { origin: string };
    expect(commit.origin).toBe("observed");
  });

  it("delete then recreate resurrects a block id via the resurrection pool", () => {
    const content = "# Doc\n\nfirst paragraph stays put across the cycle\n\nsecond paragraph also survives here\n";
    writeFileSync(join(dir, "d.md"), content);
    processCheckpoint(store, repoId, dir, [{ path: "d.md" }]);
    const doc = store.db.prepare("SELECT doc_id FROM docs WHERE path='d.md'").get() as { doc_id: string };
    const before = store.db.prepare("SELECT block_id AS id, text FROM blocks WHERE doc_id=? ORDER BY ordinal").all(doc.doc_id) as { id: string; text: string }[];
    const firstId = before.find((b) => b.text.startsWith("first"))!.id;

    // Observed deletion pools the blocks.
    unlinkSync(join(dir, "d.md"));
    processCheckpoint(store, repoId, dir, [{ path: "d.md" }]);
    const pooled = store.db.prepare("SELECT count(*) c FROM resurrection_pool WHERE block_id=?").get(firstId) as { c: number };
    expect(pooled.c).toBe(1);

    // Recreate the file: the reconciling resolver resurrects the block id.
    writeFileSync(join(dir, "d.md"), content);
    processCheckpoint(store, repoId, dir, [{ path: "d.md" }]);
    const live = store.db.prepare("SELECT block_id AS id FROM blocks WHERE deleted_commit IS NULL AND text LIKE 'first%'").all() as { id: string }[];
    expect(live.some((b) => b.id === firstId)).toBe(true);
  });

  it("re-ingests a genuinely changed file (new revision)", () => {
    writeFileSync(join(dir, "a.md"), "# A\n");
    processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    writeFileSync(join(dir, "a.md"), "# A\n\nNow with a body.\n");
    const res = processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    expect(res.ingested).toEqual(["a.md"]);
    const doc = store.db.prepare("SELECT doc_id FROM docs WHERE path = 'a.md'").get() as { doc_id: string };
    const revs = store.db.prepare("SELECT count(*) c FROM revisions WHERE doc_id = ?").get(doc.doc_id) as { c: number };
    expect(revs.c).toBe(2);
  });

  it("keeps convergence: stored file_hash matches on-disk bytes after ingest", () => {
    const content = "# Conv\n\nBody.\n";
    writeFileSync(join(dir, "conv.md"), content);
    processCheckpoint(store, repoId, dir, [{ path: "conv.md" }]);
    const onDisk = readFileSync(join(dir, "conv.md"), "utf8");
    expect(render(parseTree(onDisk))).toBe(content);
    const doc = store.db.prepare("SELECT file_hash, current_rev FROM docs WHERE path='conv.md'").get() as { file_hash: Buffer; current_rev: string };
    const rev = store.db.prepare("SELECT rendered_hash FROM revisions WHERE rev_id=?").get(doc.current_rev) as { rendered_hash: Buffer };
    expect(doc.file_hash.equals(rev.rendered_hash)).toBe(true);
  });
});

// Cross-document moves (reconciliation-spec §8, spec/reconcile §7): a block cut
// from one file and pasted into another in the SAME checkpoint keeps its id,
// regardless of which file the batch lists first.
describe("processCheckpoint: cross-document moves", () => {
  const P = "the quick brown fox jumps over the lazy dog while the cat watches from the warm kitchen window sill";
  const A0 = `# A\n\nalpha intro paragraph about apples and orchards\n\n${P}\n\nalpha closing remarks on cider pressing\n`;
  const A1 = `# A\n\nalpha intro paragraph about apples and orchards\n\nalpha closing remarks on cider pressing\n`;
  const B0 = `# B\n\nbeta intro paragraph about boats and harbours\n`;
  const B1 = (p: string) => `# B\n\nbeta intro paragraph about boats and harbours\n\n${p}\n`;

  function write(path: string, content: string): void {
    writeFileSync(join(dir, path), content);
  }
  function blockId(path: string, textPrefix: string): string {
    const row = store.db
      .prepare("SELECT b.block_id id FROM blocks b JOIN docs d ON d.doc_id=b.doc_id WHERE d.path=? AND b.deleted_commit IS NULL AND b.text LIKE ?")
      .get(path, `${textPrefix}%`) as { id: string } | undefined;
    if (!row) throw new Error(`no live block in ${path} starting ${textPrefix}`);
    return row.id;
  }
  function dispositionsFor(id: string): { kind: string; matcher_v: string | null; detail: string; commit_id: string }[] {
    return store.db.prepare("SELECT kind, matcher_v, detail, commit_id FROM dispositions WHERE block_id=? ORDER BY rowid").all(id) as never;
  }
  function docId(path: string): string {
    return (store.db.prepare("SELECT doc_id FROM docs WHERE path=?").get(path) as { doc_id: string }).doc_id;
  }
  function pooled(id: string): number {
    return (store.db.prepare("SELECT count(*) c FROM resurrection_pool WHERE block_id=?").get(id) as { c: number }).c;
  }
  /** convergence invariant for every live doc: docs.file_hash == current revision's rendered hash == sha256(disk). */
  function expectAllConverged(): void {
    const docs = store.db
      .prepare("SELECT d.path, d.file_hash, r.rendered_hash FROM docs d JOIN revisions r ON r.rev_id=d.current_rev WHERE d.deleted_commit IS NULL")
      .all() as { path: string; file_hash: Buffer; rendered_hash: Buffer }[];
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) {
      expect(d.file_hash.equals(d.rendered_hash), `rendered hash for ${d.path}`).toBe(true);
      expect(d.file_hash.toString("hex"), `disk hash for ${d.path}`).toBe(sha256(readFileSync(join(dir, d.path), "utf8")).toString("hex"));
    }
  }
  function seed(): string {
    write("a.md", A0);
    write("b.md", B0);
    processCheckpoint(store, repoId, dir, [{ path: "a.md" }, { path: "b.md" }]);
    return blockId("a.md", "the quick brown fox");
  }
  function expectMoved(id: string, kind: "moved" | "edited_moved", res: ReturnType<typeof processCheckpoint>): void {
    // The id now lives in b.md, exactly once, and a.md no longer has it.
    const rows = store.db.prepare("SELECT doc_id FROM blocks WHERE block_id=?").all(id) as { doc_id: string }[];
    expect(rows.map((r) => r.doc_id)).toEqual([docId("b.md")]);
    // Source: no `deleted`; destination: one moved/edited_moved with fromDoc, stamped with the config's matcher version.
    const disp = dispositionsFor(id).filter((d) => res.ingested.length > 0 && d.kind !== "inserted");
    expect(disp.map((d) => d.kind)).toEqual([kind]);
    expect(disp[0]!.matcher_v).toBe(DEFAULT_CONFIG.matcherV);
    expect(JSON.parse(disp[0]!.detail)).toEqual({ fromDoc: docId("a.md") });
    // Not pooled, and nothing in b.md's commit was inserted or resurrected for it.
    expect(pooled(id)).toBe(0);
    const bCommit = store.db.prepare("SELECT c.commit_id FROM revisions r JOIN commits c ON c.commit_id=r.commit_id WHERE r.doc_id=? ORDER BY c.seq DESC LIMIT 1").get(docId("b.md")) as { commit_id: string };
    const bKinds = (store.db.prepare("SELECT kind FROM dispositions WHERE commit_id=?").all(bCommit.commit_id) as { kind: string }[]).map((d) => d.kind);
    expect(bKinds).not.toContain("resurrected");
    expect(bKinds.filter((k) => k === "inserted")).toEqual([]);
    expectAllConverged();
  }

  it("cut from A, pasted into B, A listed first → moved", () => {
    const id = seed();
    write("a.md", A1);
    write("b.md", B1(P));
    const res = processCheckpoint(store, repoId, dir, [{ path: "a.md" }, { path: "b.md" }]);
    expect(res.ingested).toEqual(["a.md", "b.md"]);
    expectMoved(id, "moved", res);
  });

  it("cut from A, pasted into B, B listed first → moved (order-independent)", () => {
    const id = seed();
    write("a.md", A1);
    write("b.md", B1(P));
    const res = processCheckpoint(store, repoId, dir, [{ path: "b.md" }, { path: "a.md" }]);
    expect(res.ingested).toEqual(["b.md", "a.md"]);
    expectMoved(id, "moved", res);
  });

  it("cut, lightly edited, pasted → edited_moved with a text_sim confidence", () => {
    const id = seed();
    const edited = P.replace(/sill$/, "ledge");
    write("a.md", A1);
    write("b.md", B1(edited));
    const res = processCheckpoint(store, repoId, dir, [{ path: "b.md" }, { path: "a.md" }]);
    expectMoved(id, "edited_moved", res);
    const conf = store.db.prepare("SELECT confidence FROM dispositions WHERE block_id=? AND kind='edited_moved'").get(id) as { confidence: number };
    expect(conf.confidence).toBeGreaterThanOrEqual(DEFAULT_CONFIG.thetaXdoc);
    expect(conf.confidence).toBeLessThan(1);
    expect(blockId("b.md", "the quick brown fox")).toBe(id);
  });

  it("a move plus an unrelated edit in the same two files", () => {
    const id = seed();
    const aClosing = blockId("a.md", "alpha closing");
    const bIntro = blockId("b.md", "beta intro");
    write("a.md", A1.replace("cider pressing", "cider pressing and storage"));
    write("b.md", B1(P).replace("boats and harbours", "boats, harbours and tides"));
    const res = processCheckpoint(store, repoId, dir, [{ path: "a.md" }, { path: "b.md" }]);
    expectMoved(id, "moved", res);
    // The unrelated edits carried their own ids as plain edits.
    expect(blockId("a.md", "alpha closing")).toBe(aClosing);
    expect(blockId("b.md", "beta intro")).toBe(bIntro);
    // (a.md's closing paragraph also shifted up a slot, so intra-doc it is an
    // edited_moved; either way it is an intra-doc edit with no fromDoc.)
    const edits = store.db
      .prepare("SELECT kind, detail FROM dispositions WHERE block_id IN (?, ?) AND kind != 'inserted' ORDER BY rowid")
      .all(aClosing, bIntro) as { kind: string; detail: string }[];
    expect(edits).toHaveLength(2);
    for (const e of edits) {
      expect(["edited", "edited_moved"]).toContain(e.kind);
      expect(JSON.parse(e.detail)).not.toHaveProperty("fromDoc");
    }
  });

  it("a paragraph deleted in A and a different one inserted in B stay deleted + inserted (pool row present)", () => {
    const id = seed();
    write("a.md", A1);
    write("b.md", B1("an entirely unrelated paragraph about gardening in early spring frost"));
    processCheckpoint(store, repoId, dir, [{ path: "a.md" }, { path: "b.md" }]);
    expect(dispositionsFor(id).map((d) => d.kind)).toEqual(["inserted", "deleted"]);
    expect(pooled(id)).toBe(1);
    const newId = blockId("b.md", "an entirely unrelated");
    expect(newId).not.toBe(id);
    expect(dispositionsFor(newId).map((d) => d.kind)).toEqual(["inserted"]);
    // No cross-document move anywhere (intra-doc `moved` for the shifted closing paragraph is fine).
    expect(store.db.prepare("SELECT count(*) c FROM dispositions WHERE kind IN ('moved','edited_moved') AND detail LIKE '%fromDoc%'").get()).toEqual({ c: 0 });
    expectAllConverged();
  });

  it("pasted into a brand-new file (no prior doc) → moved", () => {
    write("a.md", A0);
    processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    const id = blockId("a.md", "the quick brown fox");
    write("a.md", A1);
    write("c.md", `# C\n\n${P}\n`);
    const res = processCheckpoint(store, repoId, dir, [{ path: "c.md" }, { path: "a.md" }]);
    expect(res.ingested).toEqual(["c.md", "a.md"]);
    expect(blockId("c.md", "the quick brown fox")).toBe(id);
    const kinds = dispositionsFor(id).map((d) => d.kind);
    expect(kinds).toEqual(["inserted", "moved"]);
    expect(pooled(id)).toBe(0);
    expectAllConverged();
  });

  it("A deleted from disk and its paragraph pasted into B in one checkpoint → moved, not pooled", () => {
    const id = seed();
    const aIntro = blockId("a.md", "alpha intro");
    unlinkSync(join(dir, "a.md"));
    write("b.md", B1(P));
    const res = processCheckpoint(store, repoId, dir, [{ path: "a.md" }, { path: "b.md" }]);
    expect(res.deleted).toEqual(["a.md"]);
    expect(res.ingested).toEqual(["b.md"]);
    expect(blockId("b.md", "the quick brown fox")).toBe(id);
    expect(dispositionsFor(id).map((d) => d.kind)).toEqual(["inserted", "moved"]);
    expect(pooled(id)).toBe(0);
    // The rest of the tombstoned doc is pooled as usual.
    expect(pooled(aIntro)).toBe(1);
    expectAllConverged();
  });

  it("A deleted from disk and its paragraph pasted into B, B listed first → same outcome", () => {
    const id = seed();
    unlinkSync(join(dir, "a.md"));
    write("b.md", B1(P));
    const res = processCheckpoint(store, repoId, dir, [{ path: "b.md" }, { path: "a.md" }]);
    expect(res.deleted).toEqual(["a.md"]);
    expect(blockId("b.md", "the quick brown fox")).toBe(id);
    expect(dispositionsFor(id).map((d) => d.kind)).toEqual(["inserted", "moved"]);
    expect(pooled(id)).toBe(0);
    expect((store.db.prepare("SELECT count(*) c FROM blocks WHERE block_id=?").get(id) as { c: number }).c).toBe(1);
    expectAllConverged();
  });

  it("across checkpoints the pool still does the job: delete A, later paste into B → resurrected (from a tombstoned doc)", () => {
    const id = seed();
    unlinkSync(join(dir, "a.md"));
    processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    expect(pooled(id)).toBe(1);
    write("b.md", B1(P));
    processCheckpoint(store, repoId, dir, [{ path: "b.md" }]);
    expect(blockId("b.md", "the quick brown fox")).toBe(id);
    expect(dispositionsFor(id).map((d) => d.kind)).toEqual(["inserted", "resurrected"]);
    expect(pooled(id)).toBe(0);
    expect((store.db.prepare("SELECT count(*) c FROM blocks WHERE block_id=?").get(id) as { c: number }).c).toBe(1);
    expectAllConverged();
  });

  it("two docs in one checkpoint cannot both resurrect the same pooled id", () => {
    write("a.md", A0);
    processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    const id = blockId("a.md", "the quick brown fox");
    write("a.md", A1);
    processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    expect(pooled(id)).toBe(1);
    write("b.md", B0);
    write("c.md", "# C\n\ngamma intro paragraph about canyons\n");
    processCheckpoint(store, repoId, dir, [{ path: "b.md" }, { path: "c.md" }]);
    write("b.md", B1(P));
    write("c.md", `# C\n\ngamma intro paragraph about canyons\n\n${P}\n`);
    processCheckpoint(store, repoId, dir, [{ path: "b.md" }, { path: "c.md" }]);
    const rows = store.db.prepare("SELECT count(*) c FROM blocks WHERE block_id=?").get(id) as { c: number };
    expect(rows.c).toBe(1);
    expect(pooled(id)).toBe(0);
    const ids = [blockId("b.md", "the quick brown fox"), blockId("c.md", "the quick brown fox")];
    expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(2);
    expectAllConverged();
  });
});
