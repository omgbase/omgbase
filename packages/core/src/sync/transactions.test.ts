import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { observeFile, observeDelete } from "./observe.js";
import { processCheckpoint, finishCheckpoint } from "./checkpoint.js";
import { tombstoneObservedDeletion } from "./tombstone.js";

// Transaction hygiene in the observe path. Three groups of statements that
// belong together run as one transaction: the observed-deletion tombstone
// (commit row + pool snapshot + FTS deletes + tombstone UPDATEs, spec/store
// §5.6), the `conflicted` flag with the revision pointers inside the ingest
// commit (spec/store §5.4 step 14), and the checkpoint row with its pool sweep
// (spec/sync §4.1). Each is checked two ways: `db.inTransaction` recorded at the
// moment the statement runs, and a failure injected into one statement proving
// nothing partial lands.

let store: Store;
let repoId: string;
let dir: string;

/** Every `run` of every prepared statement, with the transaction state at that moment. */
interface Ran { sql: string; inTransaction: boolean }
let ran: Ran[];
/** Statements (by SQL fragment) whose `run` should throw. */
let failOn: string[];

/**
 * Spy on `store.db.prepare`: the Statement's `run` records the SQL and
 * `db.inTransaction`, and throws when the SQL matches an injected failure.
 * `store.write` hands the same `db` object to its callback, so every statement
 * in the engine passes through here.
 */
function spyPrepare(): void {
  const db = store.db;
  const orig = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const st = orig(sql);
    const run = st.run.bind(st);
    (st as unknown as { run: unknown }).run = (...args: unknown[]) => {
      ran.push({ sql, inTransaction: db.inTransaction });
      if (failOn.some((f) => sql.includes(f))) throw new Error(`injected failure: ${sql.slice(0, 40)}`);
      return run(...(args as []));
    };
    return st;
  };
}
const ranMatching = (fragment: string): Ran[] => ran.filter((r) => r.sql.includes(fragment));
const count = (sql: string, ...params: unknown[]): number => (store.db.prepare(sql).get(...params) as { c: number }).c;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omg-tx-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
  ran = [];
  failOn = [];
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the observed-deletion tombstone is one transaction (spec/store §5.6)", () => {
  it("every statement runs inside the transaction, in pool → FTS → blocks → doc order", () => {
    const { docId } = observeFile(store, repoId, "a.md", "# A\n\nbody\n");
    spyPrepare();
    observeDelete(store, repoId, "a.md");
    const steps = ran.filter((r) => /INSERT INTO commits|INSERT OR REPLACE INTO resurrection_pool|blocks_fts\(blocks_fts, rowid, text\) VALUES\('delete'|UPDATE blocks SET deleted_at|UPDATE docs SET deleted_at/.test(r.sql));
    expect(steps.length).toBeGreaterThanOrEqual(5);
    for (const s of steps) expect(s, s.sql).toMatchObject({ inTransaction: true });
    const order = steps.map((s) => s.sql.match(/INSERT INTO commits|resurrection_pool|blocks_fts|UPDATE blocks|UPDATE docs/)![0]);
    expect([...new Set(order)]).toEqual(["INSERT INTO commits", "resurrection_pool", "blocks_fts", "UPDATE blocks", "UPDATE docs"]);
    // The sweep that follows is its own statement, outside the tombstone's transaction.
    const sweep = ranMatching("DELETE FROM resurrection_pool WHERE expires_ts");
    expect(sweep).toHaveLength(1);
    expect(sweep[0]!.inTransaction).toBe(false);
    expect(count("SELECT count(*) c FROM docs WHERE doc_id = ? AND deleted_at IS NOT NULL", docId)).toBe(1);
  });

  it("a failure in the FTS delete rolls everything back: the doc stays live, no commit, no pool rows", () => {
    const { docId } = observeFile(store, repoId, "a.md", "# A\n\nbody\n");
    const commits = count("SELECT count(*) c FROM commits");
    spyPrepare();
    failOn = ["blocks_fts(blocks_fts, rowid, text) VALUES('delete'"];
    expect(() => tombstoneObservedDeletion(store, repoId, docId, new Date().toISOString())).toThrow(/injected failure/);
    expect(store.db.inTransaction).toBe(false);
    expect(count("SELECT count(*) c FROM commits")).toBe(commits); // the minted commit row rolled back
    expect(count("SELECT count(*) c FROM docs WHERE doc_id = ? AND deleted_at IS NULL", docId)).toBe(1);
    expect(count("SELECT count(*) c FROM blocks WHERE doc_id = ? AND deleted_at IS NOT NULL", docId)).toBe(0);
    expect(count("SELECT count(*) c FROM resurrection_pool WHERE doc_id = ?", docId)).toBe(0);
    expect(count("SELECT count(*) c FROM blocks_fts WHERE blocks_fts MATCH 'body'")).toBe(1); // still indexed
    // And the same through observeDelete: the sweep after it never runs.
    expect(() => observeDelete(store, repoId, "a.md")).toThrow(/injected failure/);
    expect(count("SELECT count(*) c FROM docs WHERE doc_id = ? AND deleted_at IS NULL", docId)).toBe(1);
  });
});

describe("the conflicted flag lands inside the ingest transaction (spec/store §5.4 step 14)", () => {
  it("is written in the same statement as the revision pointers, inside the transaction, on every observed commit", () => {
    spyPrepare();
    const clean = observeFile(store, repoId, "a.md", "# A\n\nbody\n");
    expect(clean.conflicted).toBe(false);
    const dirty = observeFile(store, repoId, "a.md", "# A\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n");
    expect(dirty.conflicted).toBe(true);
    const pointers = ranMatching("UPDATE docs SET head = ?, file_hash = ?, updated_at = ?, conflicted = ?");
    expect(pointers).toHaveLength(2);
    for (const p of pointers) expect(p.inTransaction).toBe(true);
    // No separate autocommit flag update exists any more.
    expect(ranMatching("UPDATE docs SET conflicted")).toEqual([]);
    expect(count("SELECT conflicted c FROM docs WHERE doc_id = ?", dirty.docId)).toBe(1);
    const back = observeFile(store, repoId, "a.md", "# A\n\nresolved\n");
    expect(back.conflicted).toBe(false);
    expect(count("SELECT conflicted c FROM docs WHERE doc_id = ?", dirty.docId)).toBe(0);
  });

  it("an api write (no `conflicted` option) leaves the column untouched", async () => {
    const { apply } = await import("../mutate/apply.js");
    const dirty = observeFile(store, repoId, "a.md", "# A\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n");
    // Clear it by hand to prove the api path neither sets nor clears it.
    store.db.prepare("UPDATE docs SET conflicted = 0 WHERE doc_id = ?").run(dirty.docId);
    writeFileSync(join(dir, "a.md"), "# A\n\nparagraph\n");
    const clean = observeFile(store, repoId, "a.md", "# A\n\nparagraph\n");
    store.db.prepare("UPDATE docs SET conflicted = 1 WHERE doc_id = ?").run(clean.docId);
    spyPrepare();
    const heading = store.db.prepare("SELECT block_id, raw_hash FROM blocks WHERE doc_id = ? AND type = 'heading' AND deleted_at IS NULL").get(clean.docId) as { block_id: string; raw_hash: Buffer };
    apply(store, { repoId, rootPath: dir, ops: [{ op: "update", block: heading.block_id, markdown: "# A2", expect: { content_hash: heading.raw_hash.toString("hex") } }], origin: { actor: "test" } });
    expect(ranMatching("UPDATE docs SET head = ?, file_hash = ?, updated_at = ? WHERE")).toHaveLength(1);
    expect(ranMatching("conflicted")).toEqual([]);
    expect(count("SELECT conflicted c FROM docs WHERE doc_id = ?", clean.docId)).toBe(1); // untouched
  });

  it("a failure in the pointers+flag statement rolls the whole commit back — no revision without its flag", () => {
    const first = observeFile(store, repoId, "a.md", "# A\n\nbody\n");
    const commits = count("SELECT count(*) c FROM commits");
    const revs = count("SELECT count(*) c FROM revisions WHERE doc_id = ?", first.docId);
    spyPrepare();
    failOn = ["UPDATE docs SET head = ?, file_hash = ?, updated_at = ?, conflicted = ?"];
    expect(() => observeFile(store, repoId, "a.md", "# A\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n")).toThrow(/injected failure/);
    expect(store.db.inTransaction).toBe(false);
    expect(count("SELECT count(*) c FROM commits")).toBe(commits);
    expect(count("SELECT count(*) c FROM revisions WHERE doc_id = ?", first.docId)).toBe(revs);
    const row = store.db.prepare("SELECT head, conflicted FROM docs WHERE doc_id = ?").get(first.docId) as { head: string; conflicted: number };
    expect(row).toEqual({ head: first.rev, conflicted: 0 });
  });
});

describe("the checkpoint row and the pool sweep are one transaction (spec/sync §4.1)", () => {
  it("both statements run inside the transaction; the member commits stay one transaction each", () => {
    writeFileSync(join(dir, "a.md"), "# A\n\nbody\n");
    writeFileSync(join(dir, "b.md"), "# B\n\nbody\n");
    spyPrepare();
    const r = processCheckpoint(store, repoId, dir, [{ path: "a.md" }, { path: "b.md" }]);
    expect(r.ingested.sort()).toEqual(["a.md", "b.md"]);
    const insert = ranMatching("INSERT INTO checkpoints");
    const sweep = ranMatching("DELETE FROM resurrection_pool WHERE expires_ts");
    expect(insert).toHaveLength(1);
    expect(sweep).toHaveLength(1);
    expect(insert[0]!.inTransaction).toBe(true);
    expect(sweep[0]!.inTransaction).toBe(true);
    expect(ran.indexOf(insert[0]!)).toBeLessThan(ran.indexOf(sweep[0]!));
    // Two member commits, each its own transaction, both before the checkpoint row.
    const commits = ranMatching("INSERT INTO commits");
    expect(commits).toHaveLength(2);
    for (const c of commits) {
      expect(c.inTransaction).toBe(true);
      expect(ran.indexOf(c)).toBeLessThan(ran.indexOf(insert[0]!));
    }
    expect(store.db.inTransaction).toBe(false);
  });

  it("a failing sweep leaves no checkpoint row (the members' commits, already their own transactions, stay)", () => {
    writeFileSync(join(dir, "a.md"), "# A\n\nbody\n");
    spyPrepare();
    failOn = ["DELETE FROM resurrection_pool WHERE expires_ts"];
    expect(() => processCheckpoint(store, repoId, dir, [{ path: "a.md" }])).toThrow(/injected failure/);
    expect(store.db.inTransaction).toBe(false);
    expect(count("SELECT count(*) c FROM checkpoints")).toBe(0);
    expect(count("SELECT count(*) c FROM docs WHERE path = 'a.md' AND deleted_at IS NULL")).toBe(1); // the member commit stands
    // The same through finishCheckpoint directly, with the row the failing half.
    failOn = ["INSERT INTO checkpoints"];
    expect(() => finishCheckpoint(store, repoId, [], { ts: new Date().toISOString(), gitHead: null })).toThrow(/injected failure/);
    expect(count("SELECT count(*) c FROM checkpoints")).toBe(0);
    // A deletion in the same batch as a failing sweep: the tombstone (its own
    // transaction) stands, the checkpoint does not.
    failOn = ["DELETE FROM resurrection_pool WHERE expires_ts"];
    unlinkSync(join(dir, "a.md"));
    expect(() => processCheckpoint(store, repoId, dir, [{ path: "a.md" }])).toThrow(/injected failure/);
    expect(count("SELECT count(*) c FROM docs WHERE path = 'a.md' AND deleted_at IS NOT NULL")).toBe(1);
    expect(count("SELECT count(*) c FROM checkpoints")).toBe(0);
  });
});
