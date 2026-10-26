import { describe, it, expect, afterEach, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Store } from "../core/store/store.js";
import { SCHEMA_VERSION } from "../core/store/schema.js";
import { ensureRepo } from "../core/attach.js";
import { sha256 } from "../core/hash.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { observeFile, observeDelete } from "../sync/observe.js";
import { freshnessSweep } from "../sync/freshness.js";
import { recoverRepo } from "../sync/recovery.js";
import { changesSince } from "../core/store/feed.js";
import { apply, planChangeset } from "./apply.js";
import { commitChangeset } from "./commit.js";
import { docsCreate, docsDelete, docsMove } from "./doc-ops.test.helpers.js";
import { FsDocStore } from "./doc-store.js";
import { insertPending, listPending, materializePending, readPending, supersede, type PendingRow } from "./materialize.js";
import { MutationError } from "./tree.js";

// DB-first materialization (spec/store 14.0 §5.7; spec/mutate §4 step 5 (c)).
// The `materialize` fixture suite pins the rows and files over the in-memory
// doc store; these tests pin what the fixtures cannot see — the real
// filesystem (an fsynced temp file + rename, a rename that fails), the change
// feed, the freshness sweep and recovery as materializers, and the refusal an
// older engine gives this schema.

let dir: string;
let store: Store;
let repoId: string;
const dbPath = (): string => join(dir, ".omgbase", "omgbase.db");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-materialize-"));
  mkdirSync(join(dir, ".omgbase"));
  store = new Store({ path: dbPath() });
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
  return (store.db.prepare("SELECT doc_id FROM docs WHERE path = ? AND deleted_at IS NULL").get(path) as { doc_id: string }).doc_id;
}
function commits(): { commit_id: string; origin: string; reason: string | null }[] {
  return store.db.prepare("SELECT commit_id, origin, reason FROM commits WHERE repo_id = ? ORDER BY seq").all(repoId) as { commit_id: string; origin: string; reason: string | null }[];
}
function pending(): { path: string; kind: string; from: string | null }[] {
  return listPending(store.db, repoId).map((r) => ({ path: r.path, kind: r.kind, from: r.fromPath }));
}
const appendOp = (doc: string, markdown: string) => ({ op: "insert" as const, doc, to: { parent: { doc: true as const }, at: "end" as const }, markdown });
const fail = (fn: () => unknown): MutationError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MutationError);
    return e as MutationError;
  }
  throw new Error("expected a MutationError");
};

/** A doc store whose file operations die after COMMIT (the process crashed before the file half). */
class Crashing extends FsDocStore {
  armed = true;
  private crash(): void {
    if (this.armed) throw new Error("injected: crashed after commit");
  }
  override write(path: string, bytes: string): void {
    this.crash();
    super.write(path, bytes);
  }
  override rename(from: string, to: string): void {
    this.crash();
    super.rename(from, to);
  }
  override remove(path: string): void {
    this.crash();
    super.remove(path);
  }
}

describe("the transaction touches no file", () => {
  it("a stale revision found inside the transaction rolls back: no file written, no row, no pending row", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const b = save("b.md", "# B\n\nBravo.\n");
    const before = commits();
    const plan = planChangeset(store, { repoId, rootPath: dir, ops: [appendOp(a, "A tail."), appendOp(b, "B tail.")], origin: { actor: "agent:test" } });
    const other = new Database(dbPath());
    other.prepare("UPDATE docs SET head = 'r_elsewhere' WHERE doc_id = ?").run(b);
    other.close();
    const err = fail(() => commitChangeset(store, repoId, { origin: "api", actor: "agent:test", reason: "two" }, plan.effects, new Date().toISOString(), { docStore: new FsDocStore(dir) }));
    expect(err.code).toBe("stale_plan");
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# A\n\nAlpha.\n");
    expect(readFileSync(join(dir, "b.md"), "utf8")).toBe("# B\n\nBravo.\n");
    expect(commits()).toEqual(before);
    expect(pending()).toEqual([]);
  });

  it("a disk edit before the request → sync_conflict: no file written, the observed commit lands, no pending row", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const human = "# A\n\nAlpha, by a human.\n";
    writeFileSync(join(dir, "a.md"), human);
    const err = fail(() => apply(store, { repoId, rootPath: dir, ops: [appendOp(a, "A tail.")], origin: { actor: "agent:test" } }));
    expect(err.code).toBe("sync_conflict");
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe(human);
    expect(commits()[commits().length - 1]).toMatchObject({ origin: "observed" });
    expect(pending()).toEqual([]);
  });
});

describe("a crash after COMMIT", () => {
  it("leaves the rows pending and the files old with the change feed intact; materializePending writes them; the next observation echoes", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const b = save("b.md", "# B\n\nBravo.\n");
    const { head } = changesSince(store, repoId);
    const crashing = new Crashing(dir);
    expect(() => apply(store, { repoId, docStore: crashing, ops: [appendOp(a, "A tail."), appendOp(b, "B tail.")], origin: { actor: "agent:test", reason: "two" } })).toThrow(/injected/);

    expect(pending()).toEqual([{ path: "a.md", kind: "write", from: null }, { path: "b.md", kind: "write", from: null }]);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# A\n\nAlpha.\n");
    expect(readFileSync(join(dir, "b.md"), "utf8")).toBe("# B\n\nBravo.\n");
    const feed = changesSince(store, repoId, { cursor: head });
    expect(feed.digests).toHaveLength(1);
    expect(feed.digests[0]!.revisions.map((r) => r._path)).toEqual(["/a.md", "/b.md"]);
    // store 14.2: untouched blocks are `same` and not persisted ("4 edited, 2 inserted" through 14.1).
    expect(feed.digests[0]!.summary).toBe("api(agent:test): /a.md — changed; /b.md — changed — 2 inserted");
    const rowA = readPending(store.db, repoId, "a.md")!;
    expect(rowA.docId).toBe(a);
    expect(rowA.renderedHash.equals(sha256("# A\n\nAlpha.\n\nA tail.\n"))).toBe(true);
    expect(rowA.commitId).toBe(feed.digests[0]!.commit);

    expect(materializePending(store, repoId, new FsDocStore(dir))).toEqual(["a.md", "b.md"]);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# A\n\nAlpha.\n\nA tail.\n");
    expect(readFileSync(join(dir, "b.md"), "utf8")).toBe("# B\n\nBravo.\n\nB tail.\n");
    expect(pending()).toEqual([]);
    // No temp files linger and the feed did not move.
    expect(readdirSync(dir).filter((f) => f.endsWith(".omgtmp"))).toEqual([]);
    expect(changesSince(store, repoId, { cursor: head }).digests).toHaveLength(1);
    for (const path of ["a.md", "b.md"]) expect(observeFile(store, repoId, path, readFileSync(join(dir, path), "utf8"))).toMatchObject({ echo: true });
  });

  it("the freshness sweep replays the rows first (step 0) and then echo-suppresses the materialized files", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    freshnessSweep(store, repoId, dir); // warm the stat cache
    expect(() => apply(store, { repoId, docStore: new Crashing(dir), omgbaseDir: join(dir, ".omgbase"), ops: [appendOp(a, "A tail.")], origin: { actor: "agent:test" } })).toThrow(/injected/);
    expect(pending()).toHaveLength(1);
    const before = commits();
    const swept = freshnessSweep(store, repoId, dir);
    expect(swept.materialized).toEqual(["a.md"]);
    expect(swept.ingested).toEqual([]);
    expect(swept.suppressed).toEqual(["a.md"]);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# A\n\nAlpha.\n\nA tail.\n");
    expect(pending()).toEqual([]);
    expect(commits()).toEqual(before);
  });

  it("a sweep during the window finding foreign bytes ingests them as observed and clears the row (file wins)", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    expect(() => apply(store, { repoId, docStore: new Crashing(dir), ops: [appendOp(a, "A tail.")], origin: { actor: "agent:test" } })).toThrow(/injected/);
    const human = "# A\n\nAlpha, by a human.\n";
    writeFileSync(join(dir, "a.md"), human);
    const swept = freshnessSweep(store, repoId, dir);
    expect(swept.materialized).toEqual([]);
    expect(swept.ingested).toEqual(["a.md"]);
    expect(pending()).toEqual([]);
    expect(commits()[commits().length - 1]).toMatchObject({ origin: "observed" });
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe(human);
    expect((store.db.prepare("SELECT lower(hex(file_hash)) h FROM docs WHERE doc_id = ?").get(a) as { h: string }).h).toBe(sha256(human).toString("hex"));
  });

  it("recoverRepo replays the rows (step 0) and heals nothing else", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    expect(() => apply(store, { repoId, docStore: new Crashing(dir), ops: [appendOp(a, "A tail.")], origin: { actor: "agent:test" } })).toThrow(/injected/);
    const before = commits();
    expect(recoverRepo(store, repoId, dir)).toEqual({ materialized: ["a.md"], healed: [], missing: [] });
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# A\n\nAlpha.\n\nA tail.\n");
    expect(commits()).toEqual(before);
  });

  it("a gone member with a pending write row is not tombstoned by observe_delete", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    expect(() => apply(store, { repoId, docStore: new Crashing(dir), ops: [appendOp(a, "A tail.")], origin: { actor: "agent:test" } })).toThrow(/injected/);
    rmSync(join(dir, "a.md"));
    expect(observeDelete(store, repoId, "a.md")).toEqual({ docId: null, path: "a.md", deleted: false });
    expect((store.db.prepare("SELECT deleted_at FROM docs WHERE doc_id = ?").get(a) as { deleted_at: string | null }).deleted_at).toBeNull();
    expect(pending()).toHaveLength(1);
    expect(materializePending(store, repoId, new FsDocStore(dir))).toEqual(["a.md"]);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# A\n\nAlpha.\n\nA tail.\n");
  });
});

describe("docs_delete and docs_move materialize", () => {
  it("a docs_delete crash leaves a remove row; replay unlinks the file only when it still holds the deleted revision", () => {
    save("a.md", "# A\n\nAlpha.\n");
    save("b.md", "# B\n\nBravo.\n");
    const crashing = new Crashing(dir);
    expect(() => docsDelete(store, { repoId, docStore: crashing, actor: "agent:test" }, "a.md")).toThrow(/injected/);
    expect(() => docsDelete(store, { repoId, docStore: crashing, actor: "agent:test" }, "b.md")).toThrow(/injected/);
    expect(pending()).toEqual([{ path: "a.md", kind: "remove", from: null }, { path: "b.md", kind: "remove", from: null }]);
    writeFileSync(join(dir, "b.md"), "# B\n\nKept by a human.\n");
    expect(materializePending(store, repoId, new FsDocStore(dir))).toEqual(["a.md", "b.md"]);
    expect(existsSync(join(dir, "a.md"))).toBe(false);
    expect(readFileSync(join(dir, "b.md"), "utf8")).toBe("# B\n\nKept by a human.\n");
    expect(pending()).toEqual([]);
  });

  it("a docs_move whose rename fails falls back to writing the revision's bytes at the destination", () => {
    save("a.md", "# A\n\nAlpha.\n");
    class NoRename extends FsDocStore {
      override rename(): void {
        throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      }
    }
    const res = docsMove(store, { repoId, docStore: new NoRename(dir), actor: "agent:test" }, "a.md", "moved/a.md");
    expect(res.committed).toBe(true);
    expect(readFileSync(join(dir, "moved/a.md"), "utf8")).toBe("# A\n\nAlpha.\n");
    // The old file held the engine's own bytes: removed, not left as an untracked twin.
    expect(existsSync(join(dir, "a.md"))).toBe(false);
    expect(pending()).toEqual([]);
  });

  it("a docs_move crash leaves a rename row; replay renames, and a destination that gained foreign bytes keeps the row", () => {
    save("a.md", "# A\n\nAlpha.\n");
    save("c.md", "# C\n\nCharlie.\n");
    const crashing = new Crashing(dir);
    expect(() => docsMove(store, { repoId, docStore: crashing, actor: "agent:test" }, "a.md", "moved/a.md")).toThrow(/injected/);
    expect(() => docsMove(store, { repoId, docStore: crashing, actor: "agent:test" }, "c.md", "moved/c.md")).toThrow(/injected/);
    expect(pending()).toEqual([{ path: "moved/a.md", kind: "rename", from: "a.md" }, { path: "moved/c.md", kind: "rename", from: "c.md" }]);
    mkdirSync(join(dir, "moved"));
    writeFileSync(join(dir, "moved/c.md"), "# C\n\nSomeone else's file.\n");
    expect(materializePending(store, repoId, new FsDocStore(dir))).toEqual(["moved/a.md"]);
    expect(readFileSync(join(dir, "moved/a.md"), "utf8")).toBe("# A\n\nAlpha.\n");
    expect(existsSync(join(dir, "a.md"))).toBe(false);
    expect(pending()).toEqual([{ path: "moved/c.md", kind: "rename", from: "c.md" }]);
    expect(existsSync(join(dir, "c.md"))).toBe(true);
  });

  it("docs_create writes only where the path is still absent; a file that appeared meanwhile keeps the row", () => {
    // The stray file appears between the pre-check and the materializer's read.
    class Raced extends FsDocStore {
      planted = false;
      override read(path: string): string | null {
        if (path === "new.md" && !this.planted) {
          this.planted = true;
          writeFileSync(join(dir, path), "a stray file\n");
        }
        return super.read(path);
      }
    }
    const res = docsCreate(store, { repoId, docStore: new Raced(dir), actor: "agent:test" }, "new.md", "# New\n");
    expect(res.committed).toBe(true);
    expect(readFileSync(join(dir, "new.md"), "utf8")).toBe("a stray file\n");
    expect(pending()).toEqual([{ path: "new.md", kind: "write", from: null }]);
  });
});

describe("the self-contained row (store 17.0, M4)", () => {
  const row = (over: Partial<PendingRow>): PendingRow => ({ path: "a.md", kind: "write", fromPath: null, docId: "d_x", head: "r_1", renderedHash: sha256("one"), priorHash: sha256("zero"), commitId: "c_1", createdAt: "2026-01-01T00:00:00.000Z", ...over });

  it("supersede: a write replaces the target and keeps the earliest prior; a rename stays a rename; a remove drops everything", () => {
    const first = row({});
    const second = row({ head: "r_2", renderedHash: sha256("two"), priorHash: sha256("one"), commitId: "c_2", createdAt: "2026-01-02T00:00:00.000Z" });
    expect(supersede(null, second)).toEqual(second);
    // write over write: the target is the second's, the prior the first's
    expect(supersede(first, second)).toEqual({ ...second, priorHash: sha256("zero") });
    // a first write whose prior was null (a create) stays null: the engine never wrote there
    expect(supersede(row({ priorHash: null }), second).priorHash).toBeNull();
    // write over remove: the prior is the bytes the remove owed an unlink
    const remove = row({ kind: "remove", head: null, priorHash: null, renderedHash: sha256("old doc") });
    expect(supersede(remove, second)).toEqual({ ...second, priorHash: sha256("old doc") });
    // write over rename: the rename, its from_path and its prior stay; the target is the write's
    const rename = row({ kind: "rename", fromPath: "from.md", head: "r_m", renderedHash: sha256("moved"), priorHash: sha256("moved") });
    expect(supersede(rename, second)).toEqual({ ...rename, head: "r_2", renderedHash: sha256("two"), commitId: "c_2", createdAt: "2026-01-02T00:00:00.000Z" });
    // a rename or a remove over anything replaces it
    expect(supersede(first, rename)).toEqual(rename);
    expect(supersede(rename, remove)).toEqual(remove);
  });

  it("insertPending applies the rule against the database's row at the path", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    insertPending(store.db, repoId, row({ docId: a, priorHash: sha256("disk zero") }));
    insertPending(store.db, repoId, row({ docId: a, head: "r_2", renderedHash: sha256("two"), priorHash: sha256("one"), commitId: "c_2" }));
    const got = readPending(store.db, repoId, "a.md")!;
    expect(got.head).toBe("r_2");
    expect(got.renderedHash.equals(sha256("two"))).toBe(true);
    expect(got.priorHash!.equals(sha256("disk zero"))).toBe(true);
    expect(got.commitId).toBe("c_2");
    expect(listPending(store.db, repoId)).toHaveLength(1);
  });

  it("a committed write row carries the head, the validated file_hash as prior_hash and the commit's ts", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const ts = "2026-09-26T10:01:00.000Z";
    expect(() => apply(store, { repoId, docStore: new Crashing(dir), ops: [appendOp(a, "A tail.")], origin: { actor: "agent:test" }, ts })).toThrow(/injected/);
    const r = readPending(store.db, repoId, "a.md")!;
    const doc = store.db.prepare("SELECT head, file_hash FROM docs WHERE doc_id = ?").get(a) as { head: string; file_hash: Buffer };
    expect(r.head).toBe(doc.head);
    expect(r.renderedHash.equals(doc.file_hash)).toBe(true);
    expect(r.priorHash!.equals(sha256("# A\n\nAlpha.\n"))).toBe(true);
    expect(r.createdAt).toBe(ts);
    expect(r.commitId).toBe(commits()[commits().length - 1]!.commit_id);
    // No revision pinned, no FK: the recorder's rows are not what the row depends on.
    expect(store.db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'pending_materializations'").pluck().get()).not.toMatch(/REFERENCES (revisions|commits)/);
  });

  it("recovery: prior_hash recognises the engine's own stale file and leaves a foreign edit alone (the heal then drops its row)", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    const b = save("b.md", "# B\n\nBravo.\n");
    expect(() => apply(store, { repoId, docStore: new Crashing(dir), ops: [appendOp(a, "A tail."), appendOp(b, "B tail.")], origin: { actor: "agent:test" } })).toThrow(/injected/);
    // Reopen: another process recovers with nothing but the database and the disk.
    store.close();
    store = new Store({ path: dbPath() });
    const human = "# B\n\nBravo, by a human.\n";
    writeFileSync(join(dir, "b.md"), human);
    const before = commits().length;
    const res = recoverRepo(store, repoId, dir);
    // a.md still held the prior bytes → recognised as the engine's own → written; b.md foreign → kept by the replay, then healed as observed and its row dropped.
    expect(res).toEqual({ materialized: ["a.md"], healed: ["b.md"], missing: [] });
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# A\n\nAlpha.\n\nA tail.\n");
    expect(readFileSync(join(dir, "b.md"), "utf8")).toBe(human);
    expect(pending()).toEqual([]);
    expect(commits()).toHaveLength(before + 1);
    expect(commits()[commits().length - 1]).toMatchObject({ origin: "observed" });
    expect((store.db.prepare("SELECT lower(hex(file_hash)) h FROM docs WHERE doc_id = ?").get(b) as { h: string }).h).toBe(sha256(human).toString("hex"));
  });

  it("a stale file that is neither the prior nor the rendered bytes is foreign to the replay", () => {
    const a = save("a.md", "# A\n\nAlpha.\n");
    apply(store, { repoId, docStore: new FsDocStore(dir), ops: [appendOp(a, "A tail.")], origin: { actor: "agent:test" } });
    expect(() => apply(store, { repoId, docStore: new Crashing(dir), ops: [appendOp(a, "A second tail.")], origin: { actor: "agent:test" } })).toThrow(/injected/);
    // The row's prior is the first apply's bytes; a revert to the ORIGINAL bytes is two revisions back — foreign.
    writeFileSync(join(dir, "a.md"), "# A\n\nAlpha.\n");
    expect(materializePending(store, repoId, new FsDocStore(dir))).toEqual([]);
    expect(pending()).toHaveLength(1);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# A\n\nAlpha.\n");
  });
});

describe("the schema", () => {
  it("an older engine refuses a newer database with the exact message (simulated by a user_version one past this build's)", () => {
    store.close();
    const raw = new Database(dbPath());
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => new Store({ path: dbPath() })).toThrow(`database schema (v${SCHEMA_VERSION + 1}) is newer than this build (v${SCHEMA_VERSION}); upgrade omgbase`);
    // Reopen so afterEach can close something.
    const again = new Database(dbPath());
    again.pragma(`user_version = ${SCHEMA_VERSION}`);
    again.close();
    store = new Store({ path: dbPath() });
  });

  it("FsDocStore.write leaves no temp file behind and the bytes are exact", () => {
    const ds = new FsDocStore(dir);
    ds.write("deep/x.md", "# X\n");
    expect(readFileSync(join(dir, "deep/x.md"), "utf8")).toBe("# X\n");
    expect(readdirSync(join(dir, "deep"))).toEqual(["x.md"]);
  });
});
