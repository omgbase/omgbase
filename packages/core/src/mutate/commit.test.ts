import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { sha256 } from "../core/hash.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { observeFile } from "../sync/observe.js";
import { changesSince } from "../graph/history.js";
import { apply } from "./apply.js";
import { docsMove } from "./docs.js";
import { FsDocStore } from "./doc-store.js";
import { listPending, materializePending } from "./materialize.js";
import { MutationError } from "./tree.js";

// One request, one transaction, one commit (spec/mutate §4 step 5, 2.1;
// spec/store §5.4 "The api path"), the files after it (2.2; spec/store §5.7).
// The fixtures pin the projected rows (`changesets::multi-doc-changeset`,
// `commit::conflict-on-third-doc-commits-nothing`, `docs::move-retarget-
// inbound`, the `materialize` suite); these tests pin what the fixtures
// cannot see — the change feed, the real filesystem, and a failure injected
// while the files are being materialized.

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-commit-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function save(path: string, content: string): string {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  processCheckpoint(store, repoId, dir, [{ path }]);
  return (store.db.prepare("SELECT doc_id FROM docs WHERE path = ? AND deleted_commit IS NULL").get(path) as { doc_id: string }).doc_id;
}
function commits(): { commit_id: string; origin: string; reason: string | null }[] {
  return store.db.prepare("SELECT commit_id, origin, reason FROM commits WHERE repo_id = ? ORDER BY seq").all(repoId) as { commit_id: string; origin: string; reason: string | null }[];
}
function revisionsOf(commitId: string): { doc_id: string; path: string }[] {
  return store.db.prepare("SELECT doc_id, path FROM revisions WHERE commit_id = ? ORDER BY path").all(commitId) as { doc_id: string; path: string }[];
}
function fileHash(docId: string): string {
  return (store.db.prepare("SELECT lower(hex(file_hash)) h FROM docs WHERE doc_id = ?").get(docId) as { h: string }).h;
}
const appendOp = (doc: string, markdown: string) => ({ op: "insert" as const, doc, to: { parent: { doc: true as const }, at: "end" as const }, markdown });

describe("commitChangeset — one transaction, one commit per request", () => {
  it("a three-document changeset records one api commit with three revisions sharing created_commit", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const b = save("b.md", "# B\n\nBravo.\n");
    const c = save("c.md", "# C\n\nCharlie.\n");
    const before = commits().length;

    const res = apply(store, { repoId, rootPath: dir, ops: [appendOp(a, "A tail."), appendOp(b, "B tail."), appendOp(c, "C tail.")], origin: { actor: "agent:test", reason: "three docs" } });
    expect(res.committed).toBe(true);
    expect(res.revisions.map((r) => r.path)).toEqual(["a.md", "b.md", "c.md"]);

    const all = commits();
    expect(all).toHaveLength(before + 1);
    const commit = all[all.length - 1]!;
    expect(commit).toMatchObject({ origin: "api", reason: "three docs" });
    expect(revisionsOf(commit.commit_id).map((r) => r.path)).toEqual(["a.md", "b.md", "c.md"]);
    // Every live block of the three documents was re-stamped under the one commit.
    const created = store.db.prepare("SELECT DISTINCT created_commit c FROM blocks WHERE doc_id IN (?, ?, ?) AND deleted_commit IS NULL").all(a, b, c) as { c: string }[];
    expect(created.map((r) => r.c)).toEqual([commit.commit_id]);
    // `commits.ops` is threaded, not populated (ADR-003's record waits for the planner).
    expect((store.db.prepare("SELECT ops FROM commits WHERE commit_id = ?").get(commit.commit_id) as { ops: string | null }).ops).toBeNull();
  });

  it("changes_since reports the request as one digest carrying every revision", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const b = save("b.md", "# B\n\nBravo.\n");
    const { head } = changesSince(store, repoId);
    apply(store, { repoId, rootPath: dir, ops: [appendOp(a, "A tail."), appendOp(b, "B tail.")], origin: { actor: "agent:test", reason: "two docs" } });

    const feed = changesSince(store, repoId, { cursor: head });
    expect(feed.digests).toHaveLength(1);
    const d = feed.digests[0]!;
    expect(d.origin).toBe("api");
    expect(d.revisions.map((r) => r.path)).toEqual(["/a.md", "/b.md"]);
    expect(d.revisions.map((r) => r.id)).toEqual([a, b]);
    expect(d.summary).toBe("api(agent:test): /a.md, /b.md — 4 edited, 2 inserted");
  });

  it("a sync_conflict on the third document commits nothing: no file written, no api row, one observed commit for the dirty bytes", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const b = save("b.md", "# B\n\nBravo.\n");
    const c = save("c.md", "# C\n\nCharlie.\n");
    const hashes = [fileHash(a), fileHash(b)];
    const before = commits();
    const human = "# C\n\nCharlie, by a human.\n";
    writeFileSync(join(dir, "c.md"), human);

    let err: unknown;
    try {
      apply(store, { repoId, rootPath: dir, ops: [appendOp(a, "A tail."), appendOp(b, "B tail."), appendOp(c, "C tail.")], origin: { actor: "agent:test", reason: "three docs" } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MutationError);
    expect((err as MutationError).code).toBe("sync_conflict");

    // The in-transaction compare caught the dirty third document; nothing was written.
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# A\n\nAlpha.\n");
    expect(readFileSync(join(dir, "b.md"), "utf8")).toBe("# B\n\nBravo.\n");
    expect([fileHash(a), fileHash(b)]).toEqual(hashes);
    const after = commits();
    expect(after).toHaveLength(before.length + 1);
    expect(after[after.length - 1]).toMatchObject({ origin: "observed", reason: null });
    expect(after.filter((x) => x.reason === "three docs")).toEqual([]);
    expect(fileHash(c)).toBe(sha256(human).toString("hex"));
  });

  it("a failure while materializing leaves the commit durable and the remaining rows pending; materializePending finishes the files (store 14.0)", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const b = save("b.md", "# B\n\nBravo.\n");
    const before = commits();
    const liveBefore = store.db.prepare("SELECT block_id FROM blocks WHERE deleted_commit IS NULL ORDER BY block_id").all().map((r) => (r as { block_id: string }).block_id);

    // The injected store dies on its SECOND file write: a.md lands, b.md does not.
    class Failing extends FsDocStore {
      writes = 0;
      override write(path: string, bytes: string): void {
        if (++this.writes === 2) throw new Error("injected: disk full");
        super.write(path, bytes);
      }
    }
    const failing = new Failing(dir);
    expect(() => apply(store, { repoId, docStore: failing, ops: [appendOp(a, "A tail."), appendOp(b, "B tail.")], origin: { actor: "agent:test", reason: "two docs" } })).toThrow(/injected/);

    // Committed: one api commit, both revisions, the rows rewritten.
    const after = commits();
    expect(after).toHaveLength(before.length + 1);
    expect(after[after.length - 1]).toMatchObject({ origin: "api", reason: "two docs" });
    expect(fileHash(a)).toBe(sha256("# A\n\nAlpha.\n\nA tail.\n").toString("hex"));
    expect(fileHash(b)).toBe(sha256("# B\n\nBravo.\n\nB tail.\n").toString("hex"));
    // a.md landed and its row went; b.md is behind the database with its row pending.
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# A\n\nAlpha.\n\nA tail.\n");
    expect(readFileSync(join(dir, "b.md"), "utf8")).toBe("# B\n\nBravo.\n");
    expect(listPending(store.db, repoId).map((r) => ({ path: r.path, kind: r.kind, docId: r.docId }))).toEqual([{ path: "b.md", kind: "write", docId: b }]);

    // The materializer finishes from the recorded intent: no new commit, the
    // file current, the row gone, the known ids intact.
    expect(materializePending(store, repoId, new FsDocStore(dir))).toEqual(["b.md"]);
    expect(readFileSync(join(dir, "b.md"), "utf8")).toBe("# B\n\nBravo.\n\nB tail.\n");
    expect(listPending(store.db, repoId)).toEqual([]);
    expect(commits()).toEqual(after);
    for (const path of ["a.md", "b.md"]) expect(observeFile(store, repoId, path, readFileSync(join(dir, path), "utf8"))).toMatchObject({ echo: true });
    const liveAfter = store.db.prepare("SELECT block_id FROM blocks WHERE deleted_commit IS NULL ORDER BY block_id").all().map((r) => (r as { block_id: string }).block_id);
    for (const id of liveBefore) expect(liveAfter).toContain(id);
  });
});

describe("docsMove — one commit with the retarget", () => {
  it("records one api commit under `move <from> -> <to>` carrying the rewritten sources' revisions, and the digest says so", () => {
    save("old.md", "# Old\n\n## Top\n\ntext\n");
    const b = save("b.md", "# B\n\nSee [old](/old.md#Top) here.\n");
    const c = save("c.md", "# C\n\n- item [[old.md]]\n");
    const { head } = changesSince(store, repoId);
    const before = commits().length;

    const res = docsMove(store, { repoId, rootPath: dir, actor: "agent:test" }, "old.md", "moved/new.md");
    expect(res.retargeted?.docs.sort()).toEqual([b, c].sort());

    const all = commits();
    expect(all).toHaveLength(before + 1);
    const commit = all[all.length - 1]!;
    expect(commit).toMatchObject({ origin: "api", reason: "move old.md -> moved/new.md" });
    expect(all.some((x) => x.reason?.startsWith("retarget inbound links"))).toBe(false);
    // The moved document's own revision did not advance (it is not a source);
    // each rewritten source has one under the move's commit.
    expect(revisionsOf(commit.commit_id).map((r) => r.path)).toEqual(["b.md", "c.md"]);
    expect((store.db.prepare("SELECT count(*) n FROM revisions WHERE doc_id = ?").get(res.docId) as { n: number }).n).toBe(1);

    const feed = changesSince(store, repoId, { cursor: head });
    expect(feed.digests).toHaveLength(1);
    expect(feed.digests[0]!.summary).toBe("api(agent:test): moved /old.md → /moved/new.md; /b.md, /c.md — 5 edited");
    expect(feed.digests[0]!.revisions.map((r) => r.path)).toEqual(["/b.md", "/c.md"]);
    expect(readFileSync(join(dir, "b.md"), "utf8")).toBe("# B\n\nSee [old](/moved/new.md#Top) here.\n");
    expect(existsSync(join(dir, "old.md"))).toBe(false);
  });

  it("a self-linking moved document is a retarget source: its revision lands under the new path in the same commit", () => {
    const old = save("old.md", "# Old\n\n## Top\n\nSee [self](/old.md#Top).\n");
    const before = commits().length;

    const res = docsMove(store, { repoId, rootPath: dir, actor: "agent:test" }, "old.md", "moved/new.md");
    expect(res.retargeted).toEqual({ blocks: expect.any(Array), docs: [old] });

    const all = commits();
    expect(all).toHaveLength(before + 1);
    const commit = all[all.length - 1]!;
    expect(commit.reason).toBe("move old.md -> moved/new.md");
    // The revision carries the NEW path although the document was loaded under the old one.
    expect(revisionsOf(commit.commit_id)).toEqual([{ doc_id: old, path: "moved/new.md" }]);
    expect((store.db.prepare("SELECT path FROM docs WHERE doc_id = ?").get(old) as { path: string }).path).toBe("moved/new.md");
    const rendered = "# Old\n\n## Top\n\nSee [self](/moved/new.md#Top).\n";
    expect(readFileSync(join(dir, "moved/new.md"), "utf8")).toBe(rendered);
    expect(fileHash(old)).toBe(sha256(rendered).toString("hex"));
    // A re-observation of the new file echoes: file and database agree.
    expect(observeFile(store, repoId, "moved/new.md", rendered)).toMatchObject({ echo: true });
  });

  it("a dirty retarget source aborts the whole move: file still at the old path, no api commit", () => {
    save("old.md", "# Old\n\n## Top\n\ntext\n");
    const b = save("b.md", "# B\n\nSee [old](/old.md#Top) here.\n");
    const before = commits().length;
    writeFileSync(join(dir, "b.md"), "# B\n\nSee [old](/old.md#Top) here, edited by a human.\n");

    expect(() => docsMove(store, { repoId, rootPath: dir, actor: "agent:test" }, "old.md", "moved/new.md")).toThrow(/changed on disk/);
    expect(existsSync(join(dir, "old.md"))).toBe(true);
    expect(existsSync(join(dir, "moved/new.md"))).toBe(false);
    expect((store.db.prepare("SELECT path FROM docs WHERE path = 'old.md'").get() as { path: string } | undefined)?.path).toBe("old.md");
    const all = commits();
    expect(all).toHaveLength(before + 1);
    expect(all[all.length - 1]).toMatchObject({ origin: "observed" });
    expect(fileHash(b)).toBe(sha256("# B\n\nSee [old](/old.md#Top) here, edited by a human.\n").toString("hex"));
  });
});
