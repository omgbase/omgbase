import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { observeFile, observeMany } from "./observe.js";
import { changesSince } from "../graph/history.js";

let store: Store;
let repoId: string;

beforeEach(() => {
  // No filesystem: observe is the file→DB direction and needs no working tree.
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", null);
});
afterEach(() => store.close());

function commitCount(): number {
  return (store.db.prepare("SELECT count(*) c FROM commits").get() as { c: number }).c;
}

describe("observeFile", () => {
  it("ingests fresh bytes as an observed commit (no working tree needed)", () => {
    const res = observeFile(store, repoId, "a.md", "# Hello\n\nBody.\n");
    expect(res.echo).toBe(false);
    expect(res.rev).not.toBeNull();
    expect(res.converged).toBe(true);
    const commit = store.db.prepare("SELECT origin FROM commits WHERE commit_id = ?").get(res.commitId) as { origin: string };
    expect(commit.origin).toBe("observed");
  });

  it("echo-suppresses identical re-observation (no new commit)", () => {
    const content = "# Hello\n\nBody.\n";
    observeFile(store, repoId, "a.md", content);
    const before = commitCount();

    const echo = observeFile(store, repoId, "a.md", content);
    expect(echo.echo).toBe(true);
    expect(echo.rev).toBeNull();
    expect(echo.commitId).toBeNull();
    expect(echo.converged).toBe(true);
    expect(commitCount()).toBe(before);
  });

  it("threads block identity across an edit (not a full re-mint)", () => {
    const first = observeFile(store, repoId, "a.md", "# Title\n\nAlpha.\n\nBeta.\n");
    const blockIdsBefore = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL").all(first.docId) as { block_id: string }[]).map((r) => r.block_id).sort();

    // Edit only the second paragraph; the heading + first paragraph should keep ids.
    const second = observeFile(store, repoId, "a.md", "# Title\n\nAlpha.\n\nBeta edited.\n");
    expect(second.echo).toBe(false);
    const blockIdsAfter = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL").all(second.docId) as { block_id: string }[]).map((r) => r.block_id);

    // The unchanged blocks are carried, so their ids survive the re-ingest.
    const survived = blockIdsBefore.filter((id) => blockIdsAfter.includes(id));
    expect(survived.length).toBeGreaterThan(0);
    // Dispositions reflect reconciliation, not "everything inserted".
    const kinds = second.dispositions.map((d) => d.kind);
    expect(kinds.some((k) => k === "same" || k === "edited")).toBe(true);
  });

  it("flags a doc carrying git conflict markers", () => {
    const conflict = "# X\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n";
    const res = observeFile(store, repoId, "a.md", conflict);
    expect(res.conflicted).toBe(true);
    const doc = store.db.prepare("SELECT conflicted FROM docs WHERE doc_id = ?").get(res.docId) as { conflicted: number };
    expect(doc.conflicted).toBe(1);
  });
});

describe("observeMany (batch)", () => {
  it("cross-document move inside one batch keeps the block id (moved), in either order", () => {
    const P = "the quick brown fox jumps over the lazy dog while the cat watches from the warm kitchen window sill";
    observeMany(store, repoId, [
      { path: "a.md", content: `# A\n\nalpha intro about apples\n\n${P}\n` },
      { path: "b.md", content: "# B\n\nbeta intro about boats\n" },
    ]);
    const id = (store.db.prepare("SELECT block_id id FROM blocks WHERE text LIKE 'the quick brown fox%'").get() as { id: string }).id;
    const res = observeMany(store, repoId, [
      { path: "b.md", content: `# B\n\nbeta intro about boats\n\n${P}\n` },
      { path: "a.md", content: "# A\n\nalpha intro about apples\n" },
    ]);
    expect(res.map((r) => r.echo)).toEqual([false, false]);
    expect(res.every((r) => r.converged)).toBe(true);
    expect(res[0]!.dispositions.find((d) => d.kind === "moved")?.count).toBe(1);
    expect(res[0]!.dispositions.find((d) => d.kind === "inserted")).toBeUndefined();
    expect(res[1]!.dispositions.find((d) => d.kind === "deleted")).toBeUndefined();
    const after = store.db.prepare("SELECT b.block_id id, d.path FROM blocks b JOIN docs d ON d.doc_id=b.doc_id WHERE b.text LIKE 'the quick brown fox%'").all();
    expect(after).toEqual([{ id, path: "b.md" }]);
    expect(store.db.prepare("SELECT count(*) c FROM resurrection_pool WHERE block_id=?").get(id)).toEqual({ c: 0 });
  });

  it("observes several files in one call, echo-gating each", () => {
    const results = observeMany(store, repoId, [
      { path: "a.md", content: "# A\n" },
      { path: "b.md", content: "# B\n" },
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.echo && r.rev !== null)).toBe(true);
    expect((store.db.prepare("SELECT count(*) c FROM docs WHERE deleted_commit IS NULL").get() as { c: number }).c).toBe(2);

    // Re-observing an unchanged file in the batch is an echo; a changed one commits.
    const second = observeMany(store, repoId, [
      { path: "a.md", content: "# A\n" }, // unchanged
      { path: "b.md", content: "# B edited\n" }, // changed
    ]);
    expect(second[0]!.echo).toBe(true);
    expect(second[1]!.echo).toBe(false);
  });
});

describe("changesSince contentHash enrichment", () => {
  it("carries the revision's rendered hash in each digest's revisions[]", () => {
    const res = observeFile(store, repoId, "a.md", "# Hello\n");
    const feed = changesSince(store, repoId, {});
    const digest = feed.digests.find((d) => d.commit === res.commitId);
    expect(digest).toBeDefined();
    const rev = digest!.revisions.find((r) => r.path === "a.md");
    expect(rev).toBeDefined();
    expect(rev!.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // It equals the doc's stored file_hash (bytes converged), so a puller can
    // compare it against what it last wrote to detect an echo.
    const doc = store.db.prepare("SELECT file_hash FROM docs WHERE doc_id = ?").get(res.docId) as { file_hash: Buffer };
    expect(rev!.contentHash).toBe(doc.file_hash.toString("hex"));
  });
});
