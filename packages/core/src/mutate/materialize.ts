import type { Database } from "better-sqlite3";
import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { readDocumentAtRevision } from "../core/read/document.js";
import type { DocStore } from "./doc-store.js";

// Materialization (spec/store §5.7, store 14.0). The api path commits DB-first:
// the transaction records what each file must become as a `pending_
// materializations` row — `write` the revision's bytes at `path`, `rename` the
// file at `from_path` to `path`, `remove` the file at `path` — and the file
// half runs AFTER COMMIT, one row at a time, deleting each row once its file is
// as recorded (autocommit per file, so partial progress is durable). A row that
// survives a crash, a refused write or a lost process is the recorded intent:
// any materializer — the commit's own B' phase, the freshness sweep's step 0,
// recovery — replays it from `reconstruct at rev_id` (spec/store §6.2) with the
// api commit, its revision and the `changes_since` digest already in place.
//
// Files stay the human's (ADR-004): a materializer never overwrites bytes it
// does not recognise. At `path` it expects either nothing, the bytes the row
// names (`rendered_hash`: already materialized, or confirmed by a human who
// wrote the same), or the engine's OWN previous bytes — the revision before
// `rev_id`, which is what a file holds when the process died between COMMIT
// and the write (the `prior` hash; the commit phase passes the hash it
// validated the file against, a replay derives it from the revision history).
// Anything else is foreign — a human edit that landed meanwhile — and the row
// is KEPT: the next observation of that path applies "file wins" (spec/store
// §5.7 gate rule: observed ingest, row deleted), so the api intent is
// superseded by a later edit, never reverted silently and never overwritten.

export type PendingKind = "write" | "rename" | "remove";

/** One `pending_materializations` row (spec/store §3.1), hash as the 32 raw bytes. */
export interface PendingRow {
  path: string;
  kind: PendingKind;
  fromPath: string | null;
  docId: string;
  revId: string | null;
  renderedHash: Buffer;
  commitId: string;
}

const COLUMNS = "path, kind, from_path, doc_id, rev_id, rendered_hash, commit_id";

interface RawRow {
  path: string;
  kind: PendingKind;
  from_path: string | null;
  doc_id: string;
  rev_id: string | null;
  rendered_hash: Buffer;
  commit_id: string;
}

function fromRaw(r: RawRow): PendingRow {
  return { path: r.path, kind: r.kind, fromPath: r.from_path, docId: r.doc_id, revId: r.rev_id, renderedHash: r.rendered_hash, commitId: r.commit_id };
}

/** The pending row at `(repo, path)`, or null. */
export function readPending(db: Database, repoId: string, path: string): PendingRow | null {
  const r = db.prepare(`SELECT ${COLUMNS} FROM pending_materializations WHERE repo_id = ? AND path = ?`).get(repoId, path) as RawRow | undefined;
  return r ? fromRaw(r) : null;
}

/** Every pending row of a repo, in insertion order (a replaced row moves to the end). */
export function listPending(db: Database, repoId: string): PendingRow[] {
  return (db.prepare(`SELECT ${COLUMNS} FROM pending_materializations WHERE repo_id = ? ORDER BY rowid`).all(repoId) as RawRow[]).map(fromRaw);
}

/** Record an intent (`INSERT OR REPLACE`: one row per path — a later request for the same path supersedes the earlier). */
export function insertPending(db: Database, repoId: string, row: PendingRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO pending_materializations (repo_id, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(repoId, row.path, row.kind, row.fromPath, row.docId, row.revId, row.renderedHash, row.commitId);
}

/** Drop the intent at `(repo, path)`: the file is as recorded, or a later observation superseded it. */
export function deletePending(db: Database, repoId: string, path: string): void {
  db.prepare("DELETE FROM pending_materializations WHERE repo_id = ? AND path = ?").run(repoId, path);
}

/** The rendered hash of the revision BEFORE `revId` of the same document (what
 *  the file held before the commit that recorded the row), or null for a first
 *  revision / an unknown one. */
export function priorRenderedHash(db: Database, revId: string | null): Buffer | null {
  if (revId === null) return null;
  const r = db
    .prepare("SELECT p.rendered_hash FROM revisions r JOIN revisions p ON p.doc_id = r.doc_id AND p.seq = r.seq - 1 WHERE r.rev_id = ?")
    .get(revId) as { rendered_hash: Buffer } | undefined;
  return r?.rendered_hash ?? null;
}

// The bytes a `write`/`rename` row materializes: spec/store §6.2 reconstruct at
// the row's revision, which must hash to `rendered_hash` (it does for the
// current revision; a row always names the document's current revision because
// a later commit to the same path replaces the row). Null when nothing can be
// rendered — the row is then left for a later materializer rather than guessed.
function renderedBytes(store: Store, row: PendingRow): string | null {
  if (row.revId === null) return null;
  const at = readDocumentAtRevision(store, row.docId, row.revId);
  if (!at || !sha256(at.raw).equals(row.renderedHash)) return null;
  return at.raw;
}

export interface MaterializeOptions {
  /** The hash of the bytes the materializer may overwrite at the row's path (the
   *  engine's own previous bytes). Defaults to the rendered hash of the revision
   *  before the row's `rev_id`. `null` = only an absent or already-equal file is
   *  acceptable (a created document has no previous bytes). */
  priorHash?: Buffer | null;
}

/**
 * Materialize one row through `docStore` and, when the file is as recorded,
 * delete the row. Returns true when the row was cleared, false when it was kept
 * (the path holds foreign bytes — the next observation decides — or the bytes
 * could not be rendered). Never throws for a foreign file; a doc store write
 * failure propagates with the row intact.
 */
export function materializeRow(store: Store, repoId: string, row: PendingRow, docStore: DocStore, opts: MaterializeOptions = {}): boolean {
  const db = store.db;
  const prior = opts.priorHash !== undefined ? opts.priorHash : priorRenderedHash(db, row.revId);
  const own = (bytes: string): boolean => {
    const h = sha256(bytes);
    return h.equals(row.renderedHash) || (prior !== null && h.equals(prior));
  };
  let done: boolean;
  switch (row.kind) {
    case "write": {
      const current = docStore.read(row.path);
      if (current !== null && sha256(current).equals(row.renderedHash)) done = true;
      else if (current !== null && !own(current)) done = false;
      else {
        const bytes = renderedBytes(store, row);
        if (bytes === null) done = false;
        else {
          docStore.write(row.path, bytes);
          done = true;
        }
      }
      break;
    }
    case "rename": {
      const at = docStore.read(row.path);
      if (at !== null) {
        // The destination is occupied: by the moved bytes (done — a stale copy of
        // the engine's own bytes left at `from` goes) or by a foreign file (the
        // row stays; the sweep sees `to` win and `from` become untracked).
        if (!sha256(at).equals(row.renderedHash)) done = false;
        else {
          const from = row.fromPath === null ? null : docStore.read(row.fromPath);
          if (from !== null && own(from)) docStore.remove(row.fromPath!);
          done = true;
        }
      } else if (row.fromPath !== null && docStore.exists(row.fromPath)) {
        let renamed = true;
        try {
          docStore.rename(row.fromPath, row.path);
        } catch {
          // EXDEV, a destination that appeared, a vanished source: fall back
          // to writing the revision's bytes at `to` (below) when `to` is still
          // free; a foreign file that appeared keeps the row.
          renamed = false;
        }
        if (renamed) {
          // A self-linking moved document renders new bytes under its new path:
          // the renamed file holds the previous revision, so it is rewritten.
          const moved = docStore.read(row.path);
          if (moved !== null && !sha256(moved).equals(row.renderedHash) && own(moved)) {
            const bytes = renderedBytes(store, row);
            if (bytes !== null) docStore.write(row.path, bytes);
          }
          done = true;
        } else if (docStore.read(row.path) !== null) {
          done = false;
        } else {
          const bytes = renderedBytes(store, row);
          if (bytes === null) done = false;
          else {
            docStore.write(row.path, bytes);
            const from = docStore.read(row.fromPath);
            if (from !== null && own(from)) docStore.remove(row.fromPath);
            done = true;
          }
        }
      } else {
        const bytes = renderedBytes(store, row);
        if (bytes === null) done = false;
        else {
          docStore.write(row.path, bytes);
          done = true;
        }
      }
      break;
    }
    case "remove": {
      // Unlink only the bytes the deleted revision rendered; a file a human
      // rewrote meanwhile stays (untracked now — the next sweep re-creates it).
      const at = docStore.read(row.path);
      if (at !== null && sha256(at).equals(row.renderedHash)) docStore.remove(row.path);
      done = true;
      break;
    }
  }
  if (done) deletePending(db, repoId, row.path);
  return done;
}

/**
 * Replay every pending row of a repo through `docStore`, in insertion order.
 * Returns the paths whose rows were cleared (materialized or confirmed); rows
 * kept for a foreign file are not listed. The recovery point of the freshness
 * sweep (step 0) and of `recoverRepo`; the commit phase materializes its own
 * rows per effect instead, interleaved with the stat-cache refreshes.
 */
export function materializePending(store: Store, repoId: string, docStore: DocStore): string[] {
  const out: string[] = [];
  for (const row of listPending(store.db, repoId)) {
    if (materializeRow(store, repoId, row, docStore)) out.push(row.path);
  }
  return out;
}
