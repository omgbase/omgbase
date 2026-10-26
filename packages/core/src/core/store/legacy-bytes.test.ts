import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { ensureRepo } from "../attach.js";
import { freshnessSweep } from "../../sync/freshness.js";
import { prepareReconcile } from "../../sync/reconciling-ingest.js";
import { ftsDeleteDoc, ftsIndexedRowCount, liveLeafCount } from "./fts.js";
import { listActiveAlerts } from "./alerts.js";
import { LEGACY_BYTES_ALERT, legacyBytesMessage, legacyBytesSuspected, refreshLegacyBytesAlert, unreproducibleDocs } from "./legacy-bytes.js";
import { repairLegacyBytes } from "../../sync/legacy-bytes.js";
import { reconstructContent } from "../read/document.js";
import { sha256 } from "../hash.js";

// Legacy bytes and the 17.x finish steps on a real database file (spec/store
// §3.4 step 17 (15)–(16), §5.11; store 17.4 — the two findings of the Phase 5
// qualification on copies of real 16.x workspaces): F1, rows that do not
// reproduce their `file_hash` are named by the `legacy_bytes` alert on open
// and repaired from the files by the sweep; F2, a 17.0–17.2 database's
// tombstoned `blocks` rows leave on open WITH their FTS entries.

let dir: string;
let root: string;
let dbPath: string;
let store: Store;
let repoId: string;

const A = "# A\n\nAlpha paragraph about apples.\n\n- one\n- two\n";
const B = "# B\n\nBeta paragraph about bees.\n";
const C = "# C\n\nGamma paragraph about goats.\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-legacy-"));
  root = join(dir, "tree");
  mkdirSync(root);
  dbPath = join(dir, ".omgbase", "omgbase.db");
  store = new Store({ path: dbPath });
  repoId = ensureRepo(store, "t", root);
  writeFileSync(join(root, "a.md"), A);
  writeFileSync(join(root, "b.md"), B);
  writeFileSync(join(root, "c.md"), C);
  freshnessSweep(store, repoId, root, { ts: "2026-10-26T10:00:00.000Z" });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function reopen(): void {
  store.close();
  store = new Store({ path: dbPath });
}

function docOf(path: string): { doc_id: string; head: string; file_hash: Buffer; updated_at: string } {
  return store.db.prepare("SELECT doc_id, head, file_hash, updated_at FROM docs WHERE path = ? AND deleted_at IS NULL").get(path) as { doc_id: string; head: string; file_hash: Buffer; updated_at: string };
}

/** The pre-v6 rows: every block of the document loses its separator (what a 16 → 17 migration of such rows produces). */
function eraseSeparators(docId: string): void {
  store.db.prepare("UPDATE blocks SET trivia = NULL, trivia_hash = NULL WHERE doc_id = ?").run(docId);
}

const blockIds = (docId: string): string[] => (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? ORDER BY ordinal, parent_block").all(docId) as { block_id: string }[]).map((r) => r.block_id);
const feedRows = (): number => (store.db.prepare("SELECT count(*) c FROM feed").get() as { c: number }).c;
const active = (): { code: string; detail?: Record<string, unknown> }[] => listActiveAlerts(store.db, repoId);

describe("legacy bytes (F1): the alert on open and the repair by the sweep", () => {
  it("the message is pinned byte for byte", () => {
    expect(legacyBytesMessage(115)).toBe("115 document(s) carry bytes the engine cannot reproduce from its rows (imported before block trivia was stored); omg sync repairs them from the files");
  });

  it("a healthy database: no signature, nothing unreproducible, no alert after a reopen", () => {
    expect(legacyBytesSuspected(store.db, repoId)).toBe(false);
    expect(unreproducibleDocs(store.db, repoId)).toEqual([]);
    reopen();
    expect(active()).toEqual([]);
  });

  it("rows without their separators do not reproduce the file; the on-open finish step names them", () => {
    const a = docOf("a.md");
    eraseSeparators(a.doc_id);
    expect(reconstructContent(store.db, a.doc_id)).not.toBe(A);
    expect(legacyBytesSuspected(store.db, repoId)).toBe(true);
    expect(unreproducibleDocs(store.db, repoId)).toEqual([{ docId: a.doc_id, path: "a.md" }]);
    reopen();
    const alerts = active();
    expect(alerts.map((x) => x.code)).toEqual([LEGACY_BYTES_ALERT]);
    expect(alerts[0]!.detail).toEqual({ docs: 1, sample: [a.doc_id] });
    // Idempotent: another open refreshes the same row.
    reopen();
    expect(active().length).toBe(1);
  });

  it("the sweep repairs the rows from the file: ids, head, updated_at and the feed unchanged, the alert cleared", () => {
    const a = docOf("a.md");
    const ids = blockIds(a.doc_id);
    const feed = feedRows();
    eraseSeparators(a.doc_id);
    reopen();
    expect(active().length).toBe(1);
    const r = freshnessSweep(store, repoId, root, { ts: "2026-10-26T10:05:00.000Z" });
    expect(r.repaired).toEqual(["a.md"]);
    expect(r.ingested).toEqual([]);
    expect(r.changed).toBe(true);
    expect(reconstructContent(store.db, a.doc_id)).toBe(A);
    const after = docOf("a.md");
    expect(after.head).toBe(a.head);
    expect(after.updated_at).toBe(a.updated_at);
    expect(after.file_hash.equals(a.file_hash)).toBe(true);
    expect(blockIds(a.doc_id)).toEqual(ids);
    expect(feedRows()).toBe(feed);
    expect(active()).toEqual([]);
    // C2 holds again: trivia_hash == sha256(trivia), both NULL or neither.
    for (const b of store.db.prepare("SELECT trivia, trivia_hash FROM blocks WHERE doc_id = ?").all(a.doc_id) as { trivia: string | null; trivia_hash: Buffer | null }[]) {
      if (b.trivia === null) expect(b.trivia_hash).toBeNull();
      else expect(b.trivia_hash!.equals(sha256(b.trivia))).toBe(true);
    }
    // A later sweep has nothing to do and the alert stays cleared.
    const again = freshnessSweep(store, repoId, root, { ts: "2026-10-26T10:06:00.000Z" });
    expect(again.repaired).toEqual([]);
    expect(again.changed).toBe(false);
  });

  it("a document whose file is gone stays listed; one whose file diverged is re-ingested, not repaired", () => {
    const a = docOf("a.md");
    const b = docOf("b.md");
    eraseSeparators(a.doc_id);
    eraseSeparators(b.doc_id);
    // b's file left without the cache noticing (no deletion to observe), a's file moved on.
    store.db.prepare("DELETE FROM file_stats WHERE path = 'b.md'").run();
    rmSync(join(root, "b.md"));
    writeFileSync(join(root, "a.md"), A.replace("apples", "pears"));
    reopen();
    expect(active()[0]!.detail).toEqual({ docs: 2, sample: [a.doc_id, b.doc_id] });
    const r = freshnessSweep(store, repoId, root, { ts: "2026-10-26T10:05:00.000Z" });
    expect(r.ingested).toEqual(["a.md"]);
    expect(r.repaired).toEqual([]);
    expect(docOf("a.md").head).not.toBe(a.head);
    expect(active()[0]!.detail).toEqual({ docs: 1, sample: [b.doc_id] });
  });

  it("the identity matcher agrees with the positional repair: identical texts map to the same ids, every verdict `same`", () => {
    const a = docOf("a.md");
    const ids = blockIds(a.doc_id);
    eraseSeparators(a.doc_id);
    // What a reconciling re-ingest of the file would do to the ids — the rows'
    // raws are the file's, so phase 1 of spec/reconcile matches every block in
    // place; the repair takes the same mapping positionally, without the matcher.
    const prepared = prepareReconcile(store, repoId, "a.md", A, { ts: "2026-10-26T10:05:00.000Z" });
    expect(prepared.result.dispositions.length).toBe(ids.length);
    expect(prepared.result.dispositions.every((d) => d.kind === "same")).toBe(true);
    expect(new Set(prepared.result.assignment.values())).toEqual(new Set(ids));
    expect(prepared.result.deleted).toEqual([]);
  });

  it("the repair refuses a parse whose structure differs from the rows and changes nothing", () => {
    const a = docOf("a.md");
    eraseSeparators(a.doc_id);
    const before = store.db.prepare("SELECT block_id, trivia FROM blocks WHERE doc_id = ? ORDER BY block_id").all(a.doc_id);
    expect(repairLegacyBytes(store, a.doc_id, "a.md", A.replace("apples", "pears"))).toBe("structure_differs");
    expect(repairLegacyBytes(store, a.doc_id, "a.md", `---\nk: v\n---\n${A}`)).toBe("structure_differs");
    expect(store.db.prepare("SELECT block_id, trivia FROM blocks WHERE doc_id = ? ORDER BY block_id").all(a.doc_id)).toEqual(before);
    expect(repairLegacyBytes(store, a.doc_id, "a.md", A)).toBe("repaired");
    expect(reconstructContent(store.db, a.doc_id)).toBe(A);
  });

  it("a one-block document with a lost trailing newline carries no signature: the open does not name it, doctor's full check does", () => {
    const c = docOf("c.md");
    // Only the LAST top-level block loses its separator: nothing distinguishes the rows from a file without a trailing newline.
    store.db.prepare("UPDATE blocks SET trivia = NULL, trivia_hash = NULL WHERE doc_id = ? AND ordinal = (SELECT max(ordinal) FROM blocks WHERE doc_id = ? AND parent_block IS NULL)").run(c.doc_id, c.doc_id);
    expect(legacyBytesSuspected(store.db, repoId)).toBe(false);
    reopen();
    expect(active()).toEqual([]);
    expect(refreshLegacyBytesAlert(store.db, repoId, "2026-10-26T10:05:00.000Z")).toEqual([{ docId: c.doc_id, path: "c.md" }]);
    expect(active()[0]!.detail).toEqual({ docs: 1, sample: [c.doc_id] });
    expect(freshnessSweep(store, repoId, root, { ts: "2026-10-26T10:06:00.000Z" }).repaired).toEqual(["c.md"]);
    expect(active()).toEqual([]);
  });
});

describe("tombstoned rows (F2): the 17.x finish step purges the FTS entries the index holds before deleting the rows", () => {
  it("a 17.0-style database — tombstoned rows still indexed and some already purged — comes out with the index equal to the live leaves and intact", () => {
    const b = docOf("b.md");
    const c = docOf("c.md");
    const ts = "2026-10-26T10:05:00.000Z";
    // b: tombstoned in place WITH its index entries left behind (the orphan state).
    store.db.prepare("UPDATE blocks SET deleted_at = ? WHERE doc_id = ?").run(ts, b.doc_id);
    store.db.prepare("UPDATE docs SET deleted_at = ?, updated_at = ? WHERE doc_id = ?").run(ts, ts, b.doc_id);
    // c: tombstoned the way 17.0–17.2 did it — the live leaves purged first.
    store.db.transaction(() => {
      ftsDeleteDoc(store.db, c.doc_id);
      store.db.prepare("UPDATE blocks SET deleted_at = ? WHERE doc_id = ?").run(ts, c.doc_id);
      store.db.prepare("UPDATE docs SET deleted_at = ?, updated_at = ? WHERE doc_id = ?").run(ts, ts, c.doc_id);
    })();
    const leavesBefore = liveLeafCount(store.db);
    expect(ftsIndexedRowCount(store.db)).toBeGreaterThan(leavesBefore);
    reopen();
    expect((store.db.prepare("SELECT count(*) c FROM blocks WHERE deleted_at IS NOT NULL").get() as { c: number }).c).toBe(0);
    expect(ftsIndexedRowCount(store.db)).toBe(liveLeafCount(store.db));
    expect(liveLeafCount(store.db)).toBe(leavesBefore);
    // FTS5's own integrity check compares the index against the content table: an orphan or a double delete would fail it.
    expect(() => store.db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('integrity-check')")).not.toThrow();
    expect(active()).toEqual([]);
  });
});
