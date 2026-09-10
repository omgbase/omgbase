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
