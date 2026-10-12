import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { sha256 } from "../core/hash.js";
import { setIdMinter, sequentialMinter } from "../core/ids.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { observeFile } from "../sync/observe.js";
import { apply, planChangeset } from "./apply.js";
import { commitChangeset, readDocBase, type Effect } from "./commit.js";
import { listPending } from "./materialize.js";
import { docsMove, docsSetMeta } from "./doc-ops.test.helpers.js";
import { FsDocStore } from "./doc-store.js";
import { MutationError } from "./tree.js";

// spec/mutate §4 step 5 (2.2): every precondition a request was planned
// against — per document the row triple `(path, current_rev, file_hash)` and
// the bytes on disk — is validated INSIDE the commit's `BEGIN IMMEDIATE`
// transaction before the commit row is minted, so a plan the world moved from
// under rolls back having minted nothing and having touched no file (the files
// are materialized after COMMIT, step 5). The fixtures cannot see this (plan
// and commit are one step there); these tests open the seam between
// `planChangeset` and `commitChangeset`, or inject a second connection.

let dir: string;
let store: Store;
let repoId: string;
const dbPath = (): string => join(dir, ".omgbase", "omgbase.db");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-commit-cas-"));
  mkdirSync(join(dir, ".omgbase"));
  // A file database: a second connection can reach it.
  store = new Store({ path: dbPath() });
  // Sequential ids from here on so a burned id would show as a gap.
  setIdMinter(sequentialMinter());
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  setIdMinter(null);
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
function row(docId: string): { path: string; current_rev: string | null; hash: string | null } {
  return store.db.prepare("SELECT path, current_rev, lower(hex(file_hash)) hash FROM docs WHERE doc_id = ?").get(docId) as { path: string; current_rev: string | null; hash: string | null };
}
const appendOp = (doc: string, markdown: string) => ({ op: "insert" as const, doc, to: { parent: { doc: true as const }, at: "end" as const }, markdown });
const head = { origin: "api" as const, actor: "agent:test", reason: "tail" };
const fail = (fn: () => unknown): MutationError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MutationError);
    return e as MutationError;
  }
  throw new Error("expected a MutationError");
};
/** Under the sequential minter every commit so far is `c_0 … c_{n-1}`; the next
 *  successful commit must be `c_n` — a `c` minted inside a rolled-back
 *  transaction would stay in the issued set and leave a gap. */
function expectNoBurnedCommitId(): void {
  const n = commits().length;
  const a = save("fresh.md", "# Fresh\n");
  expect(commits()).toHaveLength(n + 1);
  const res = apply(store, { repoId, rootPath: dir, ops: [appendOp(a, "tail")], origin: { actor: "agent:test" } });
  expect(res.committed).toBe(true);
  expect(commits()[n + 1]!.commit_id).toBe(`c_${n + 1}`);
}

describe("commit preconditions — the row triple, re-validated inside the transaction", () => {
  it("the plan carries each loaded document's (path, current_rev, file_hash) and every ingest_known effect its base", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const b = save("b.md", "# B\n\nBravo.\n");
    const plan = planChangeset(store, { repoId, rootPath: dir, ops: [appendOp(a, "A tail."), appendOp(b, "B tail.")], origin: { actor: "agent:test" } });
    const ra = row(a);
    const rb = row(b);
    expect(plan.preconditions).toEqual([
      { id: a, path: "a.md", currentRev: ra.current_rev, fileHash: ra.hash },
      { id: b, path: "b.md", currentRev: rb.current_rev, fileHash: rb.hash },
    ]);
    expect(ra.hash).toBe(sha256("# A\n\nAlpha.\n").toString("hex"));
    const known = plan.effects.filter((e) => e.kind === "ingest_known");
    expect(known.map((e) => e.base)).toEqual([readDocBase(store.db, a), readDocBase(store.db, b)]);
  });

  it("a second connection bumping docs.current_rev between plan and commit → stale_plan: no file written, no commit row, no id burned", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const b = save("b.md", "# B\n\nBravo.\n");
    const before = commits();
    const plan = planChangeset(store, { repoId, rootPath: dir, ops: [appendOp(a, "A tail."), appendOp(b, "B tail.")], origin: { actor: "agent:test" } });
    const expectedRev = row(b).current_rev;

    // Another process advanced the second document's revision (no FK on the
    // column; the other engine's revision row lives in its own history).
    const other = new Database(dbPath());
    other.prepare("UPDATE docs SET current_rev = 'r_elsewhere' WHERE doc_id = ?").run(b);
    other.close();

    const err = fail(() => commitChangeset(store, repoId, head, plan.effects, new Date().toISOString(), { docStore: new FsDocStore(dir) }));
    expect(err.code).toBe("stale_plan");
    expect(err.data).toEqual({
      doc: b,
      expected_revision: expectedRev,
      current: { revision: "r_elsewhere", hash: row(b).hash },
      retriable: true,
    });
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# A\n\nAlpha.\n");
    expect(readFileSync(join(dir, "b.md"), "utf8")).toBe("# B\n\nBravo.\n");
    expect(commits()).toEqual(before);
    expectNoBurnedCommitId();
  });

  it("a concurrent docs_move changing docs.path (current_rev unchanged) between plan and commit → stale_plan", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const plan = planChangeset(store, { repoId, rootPath: dir, ops: [appendOp(a, "A tail.")], origin: { actor: "agent:test" } });
    const rev = row(a).current_rev;
    docsMove(store, { repoId, rootPath: dir, actor: "agent:other" }, "a.md", "moved/a.md");
    expect(row(a)).toMatchObject({ path: "moved/a.md", current_rev: rev });
    const before = commits();

    const err = fail(() => commitChangeset(store, repoId, head, plan.effects, new Date().toISOString(), { docStore: new FsDocStore(dir) }));
    expect(err.code).toBe("stale_plan");
    // A move advances no revision: the path alone made the plan stale.
    expect(err.data).toMatchObject({ doc: a, expected_revision: rev, current: { revision: rev } });
    expect(existsSync(join(dir, "a.md"))).toBe(false);
    expect(readFileSync(join(dir, "moved/a.md"), "utf8")).toBe("# A\n\nAlpha.\n");
    expect(commits()).toEqual(before);
  });

  it("a concurrent observed commit of a human edit between plan and commit → stale_plan (the row moved; the disk check never runs)", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const plan = planChangeset(store, { repoId, rootPath: dir, ops: [appendOp(a, "A tail.")], origin: { actor: "agent:test" } });
    const human = "# A\n\nAlpha, by a human.\n";
    writeFileSync(join(dir, "a.md"), human);
    observeFile(store, repoId, "a.md", human);
    const before = commits();

    const err = fail(() => commitChangeset(store, repoId, head, plan.effects, new Date().toISOString(), { docStore: new FsDocStore(dir) }));
    expect(err.code).toBe("stale_plan");
    expect(err.data).toMatchObject({ doc: a, current: { revision: row(a).current_rev, hash: sha256(human).toString("hex") } });
    expect(commits()).toEqual(before);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe(human);
  });

  it("a disk edit that landed before the request → sync_conflict with one observed commit, nothing written, no id burned", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const b = save("b.md", "# B\n\nBravo.\n");
    const before = commits();
    const human = "# B\n\nBravo, by a human.\n";
    writeFileSync(join(dir, "b.md"), human);

    const err = fail(() => apply(store, { repoId, rootPath: dir, ops: [appendOp(a, "A tail."), appendOp(b, "B tail.")], origin: { actor: "agent:test", reason: "two" } }));
    expect(err.code).toBe("sync_conflict");
    expect(err.data).toEqual({ retriable: true });
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# A\n\nAlpha.\n");
    const after = commits();
    expect(after).toHaveLength(before.length + 1);
    expect(after[after.length - 1]).toMatchObject({ origin: "observed" });
    expect(row(b).hash).toBe(sha256(human).toString("hex"));
    // The observed commit took `c_n`; the api request burned nothing before it.
    expect(after[after.length - 1]!.commit_id).toBe(`c_${before.length}`);
    expectNoBurnedCommitId();
  });

  it("a disk edit landing after phase A is never overwritten: B' refuses the foreign file, the row stays, and the next observation lets the human's bytes win (step 5 flipped the file-first window)", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const before = commits();
    const human = "# A\n\nAlpha, by a human.\n";
    // The human's write lands after the request read the file (phase A) and
    // before the materializer looks at it again (B', after COMMIT): the DocStore's
    // second read of the path is that moment.
    class Raced extends FsDocStore {
      reads = 0;
      override read(path: string): string | null {
        if (path === "a.md" && ++this.reads === 2) writeFileSync(join(dir, "a.md"), human);
        return super.read(path);
      }
    }
    const res = apply(store, { repoId, docStore: new Raced(dir), ops: [appendOp(a, "A tail.")], origin: { actor: "agent:test", reason: "tail" } });
    expect(res.committed).toBe(true);
    // The commit is durable; the materializer found bytes it did not recognise
    // (neither the prior file_hash it validated nor the rendered bytes) and kept
    // the pending row instead of writing over the human.
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe(human);
    const after = commits();
    expect(after).toHaveLength(before.length + 1);
    expect(after[after.length - 1]).toMatchObject({ origin: "api", reason: "tail" });
    expect(listPending(store.db, repoId).map((r) => ({ path: r.path, kind: r.kind }))).toEqual([{ path: "a.md", kind: "write" }]);
    // The observation applies "file wins": observed commit, row gone.
    const obs = observeFile(store, repoId, "a.md", human);
    expect(obs).toMatchObject({ echo: false, converged: true });
    expect(listPending(store.db, repoId)).toEqual([]);
    expect(row(a).hash).toBe(sha256(human).toString("hex"));
  });

  it("docs_set_meta on a dirty file → sync_conflict with one observed commit of the human's bytes; the file is untouched (2.2 closes the unchecked gap)", () => {
    const a = save("a.md", "---\nlayer: draft\n---\n\n# A\n\nAlpha.\n");
    const before = commits();
    const human = "---\nlayer: draft\n---\n\n# A\n\nAlpha, by a human.\n";
    writeFileSync(join(dir, "a.md"), human);

    const err = fail(() => docsSetMeta(store, { repoId, rootPath: dir, actor: "agent:test" }, "a.md", { set: { layer: "working" } }));
    expect(err.code).toBe("sync_conflict");
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe(human);
    const after = commits();
    expect(after).toHaveLength(before.length + 1);
    expect(after[after.length - 1]).toMatchObject({ origin: "observed" });
    expect(after.some((c) => c.reason === "set_meta a.md")).toBe(false);
    expect(row(a).hash).toBe(sha256(human).toString("hex"));
    // A retry against the observed revision goes through.
    const ok = docsSetMeta(store, { repoId, rootPath: dir, actor: "agent:test" }, "a.md", { set: { layer: "working" } });
    expect(ok.committed).toBe(true);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("---\nlayer: working\n---\n\n# A\n\nAlpha, by a human.\n");
  });

  it("the effect-specific rules: create → path_taken, move_path → stale_plan / path_taken / doc_missing, tombstone → stale_plan / doc_missing", () => {
    const a = save("a.md", "# A\n");
    const b = save("b.md", "# B\n");
    const before = commits();
    const ts = new Date().toISOString();
    const targets = { docStore: new FsDocStore(dir) };
    const run = (effects: Effect[]): MutationError => fail(() => commitChangeset(store, repoId, head, effects, ts, targets));
    const base = readDocBase(store.db, a)!;

    expect(run([{ kind: "ingest_reconciled", path: "b.md", source: "# New\n", precondition: null }]).code).toBe("path_taken");
    expect(run([{ kind: "move_path", docId: a, from: "a.md", to: "b.md", currentRev: base.currentRev, inbound: [], bytes: "" }]).code).toBe("path_taken");
    expect(run([{ kind: "move_path", docId: a, from: "a.md", to: "c.md", currentRev: "r_stale", inbound: [], bytes: "" }]).code).toBe("stale_plan");
    expect(run([{ kind: "move_path", docId: "d_nobody", from: "a.md", to: "c.md", currentRev: null, inbound: [], bytes: "" }]).code).toBe("doc_missing");
    expect(run([{ kind: "tombstone", docId: b, path: "b.md", currentRev: "r_stale", pool: false }]).code).toBe("stale_plan");
    expect(run([{ kind: "tombstone", docId: "d_nobody", path: "b.md", currentRev: null, pool: false }]).code).toBe("doc_missing");
    // A stale ingest_known whose document was deleted meanwhile is doc_missing, not stale_plan.
    const plan = planChangeset(store, { repoId, rootPath: dir, ops: [appendOp(b, "tail")], origin: { actor: "agent:test" } });
    store.db.prepare("UPDATE docs SET deleted_commit = ? WHERE doc_id = ?").run(before[0]!.commit_id, b);
    expect(run(plan.effects).code).toBe("doc_missing");
    store.db.prepare("UPDATE docs SET deleted_commit = NULL WHERE doc_id = ?").run(b);

    // Every failure rolled back before minting: the files and rows are as they
    // were and the next commit id has no gap.
    expect(existsSync(join(dir, "a.md"))).toBe(true);
    expect(existsSync(join(dir, "c.md"))).toBe(false);
    expect(readFileSync(join(dir, "b.md"), "utf8")).toBe("# B\n");
    expect(commits()).toEqual(before);
    expectNoBurnedCommitId();
  });
});

describe("the commit transaction is BEGIN IMMEDIATE", () => {
  it("Store.writeImmediate holds the write lock from BEGIN: a second connection's BEGIN IMMEDIATE is SQLITE_BUSY (database is locked) even before the body writes", () => {
    const probe = new Database(dbPath(), { timeout: 50 });
    // Deferred, with no write in the body, would not block the probe.
    store.write((db) => {
      expect(db.inTransaction).toBe(true);
      probe.exec("BEGIN IMMEDIATE");
      probe.exec("ROLLBACK");
    });
    store.writeImmediate((db) => {
      expect(db.inTransaction).toBe(true);
      expect(() => probe.exec("BEGIN IMMEDIATE")).toThrow(/database is locked/);
    });
    expect(store.db.inTransaction).toBe(false);
    probe.exec("BEGIN IMMEDIATE");
    probe.exec("ROLLBACK");
    // Nested inside an open transaction it is a savepoint, like `write`.
    store.write(() => {
      store.writeImmediate((db) => expect(db.inTransaction).toBe(true));
    });
    probe.close();
  });

  it("phase C runs under writeImmediate and the stat cache is refreshed only AFTER it: inside the transaction a probe cannot BEGIN IMMEDIATE; recordStat runs with the transaction closed", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const probe = new Database(dbPath(), { timeout: 50 });
    const original = store.writeImmediate.bind(store);
    let probed = 0;
    const immediate = vi.spyOn(store, "writeImmediate").mockImplementation((fn) =>
      original((db) => {
        // Inside phase C: the write lock is held from BEGIN.
        expect(db.inTransaction).toBe(true);
        expect(() => probe.exec("BEGIN IMMEDIATE")).toThrow(/database is locked/);
        probed++;
        return fn(db);
      }),
    );
    const plain = vi.spyOn(store, "write");
    let stats = 0;
    class Probing extends FsDocStore {
      override recordStat(s: Store, r: string, path: string, bytes: string): void {
        // Phase B': the file exists and the transaction is over (the stat cache
        // reads the real file, which did not exist in its new form during C).
        expect(s.db.inTransaction).toBe(false);
        expect(readFileSync(join(dir, path), "utf8")).toBe(bytes);
        stats++;
        super.recordStat(s, r, path, bytes);
      }
    }
    const res = apply(store, { repoId, docStore: new Probing(dir), omgbaseDir: join(dir, ".omgbase"), ops: [appendOp(a, "A tail.")], origin: { actor: "agent:test" } });
    expect(res.committed).toBe(true);
    expect(probed).toBe(1);
    expect(stats).toBe(1);
    expect(immediate).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();
    expect(store.db.inTransaction).toBe(false);
    probe.exec("BEGIN IMMEDIATE");
    probe.exec("ROLLBACK");
    probe.close();
  });
});
