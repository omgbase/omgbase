import type { Database } from "better-sqlite3";
import { MATERIALIZATION_FAILED_ALERT, clearAlert, materializationFailedMessage, raiseAlert, refreshBacklogAlert } from "../core/store/alerts.js";
import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { reconstructContent } from "../core/read/document.js";
import type { DocStore } from "./doc-store.js";
import { faultPoint } from "../core/fault.js";

// Materialization (spec/store §5.7, store 14.0; the self-contained row 17.0 —
// modular-core Phase 3c, M4). The api path commits DB-first: the transaction
// records what each file must become as a `pending_materializations` row —
// `write` the document's bytes at `path`, `rename` the file at `from_path` to
// `path`, `remove` the file at `path` — and the file half runs AFTER COMMIT,
// one row at a time, deleting each row once its file is as recorded
// (autocommit per file, so partial progress is durable). A row that survives a
// crash, a refused write or a lost process is the recorded intent: any
// materializer — the commit's own B' phase, the freshness sweep's step 0,
// recovery — replays it from the document's CURRENT state (`reconstruct`,
// spec/store §6.1 — a row always names its document's current head, §5.7)
// with the api commit, its revision and the `changes_since` digest already in
// place. The row carries everything that replay needs and touches no history
// table: `head` (the token whose bytes it renders; no foreign key),
// `rendered_hash` (the bytes expected at `path`), `prior_hash` (the bytes the
// engine itself last wrote at `path` — captured at commit time from the
// `file_hash` the transaction validated the file against, or inherited from
// the row it supersedes; NULL when the engine never wrote there), `commit_id`
// (no foreign key) and `created_at`.
//
// Files stay the human's (ADR-004): a materializer never overwrites bytes it
// does not recognise. At `path` it expects either nothing, the bytes the row
// names (`rendered_hash`: already materialized, or confirmed by a human who
// wrote the same), or the engine's OWN previous bytes — `prior_hash`, which is
// what a file holds when the process died between COMMIT and the write.
// Anything else is foreign — a human edit that landed meanwhile — and the row
// is KEPT: the next observation of that path applies "file wins" (spec/store
// §5.7 gate rule: observed ingest, row deleted), so the api intent is
// superseded by a later edit, never reverted silently and never overwritten.
//
// One row per path (spec/store §5.7 "Supersession"): a later `write` to a path
// that still owes a file replaces the row's TARGET (`head`, `rendered_hash`,
// `commit_id`, `created_at`) and keeps the EARLIEST `prior_hash` — the bytes
// that can still be on the disk are the ones the engine wrote before the first
// unfinished commit, never the superseded row's own target (over a `remove`
// row the inherited prior is the bytes it owed an unlink); a `write` over a
// `rename` keeps the rename and its `from_path` obligation and replaces its
// target; a `rename` supersedes a `write`/`rename` at `from_path` by carrying
// its `prior_hash` (the commit deletes that row); a `remove` drops whatever
// the path owed. Unresolved recovery work is never discarded for a storage
// limit: there is none — a row lives until a materializer or an observation
// settles its path.

export type PendingKind = "write" | "rename" | "remove";

/** One `pending_materializations` row (spec/store §3.1), hashes as the 32 raw bytes. */
export interface PendingRow {
  path: string;
  kind: PendingKind;
  fromPath: string | null;
  docId: string;
  /** `write`/`rename`: the document's head token whose bytes the row renders; `null` for `remove`. */
  head: string | null;
  renderedHash: Buffer;
  /** The bytes the engine itself last wrote at `path` (what a crash leaves on the disk); `null` when it never did. */
  priorHash: Buffer | null;
  commitId: string;
  /** The recording commit's `ts` (spec/store §2.4). */
  createdAt: string;
}

const COLUMNS = "path, kind, from_path, doc_id, head, rendered_hash, prior_hash, commit_id, created_at";

interface RawRow {
  path: string;
  kind: PendingKind;
  from_path: string | null;
  doc_id: string;
  head: string | null;
  rendered_hash: Buffer;
  prior_hash: Buffer | null;
  commit_id: string;
  created_at: string;
}

function fromRaw(r: RawRow): PendingRow {
  return { path: r.path, kind: r.kind, fromPath: r.from_path, docId: r.doc_id, head: r.head, renderedHash: r.rendered_hash, priorHash: r.prior_hash, commitId: r.commit_id, createdAt: r.created_at };
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

/**
 * The row that results when `incoming` is recorded at a path `existing` still
 * owes (spec/store §5.7 "Supersession"; `null` existing → `incoming` as is). A
 * `write` replaces the target and inherits the earliest prior: over a `write`
 * its `prior_hash`, over a `remove` the bytes that row owed an unlink
 * (`rendered_hash`), over a `rename` the rename itself stays — `from_path` and
 * `prior_hash` kept, `head`/`rendered_hash`/`commit_id`/`created_at` the
 * write's (the self-linking source of a `docs_move`, whose retarget renders new
 * bytes at the new path). A `rename` or a `remove` replaces whatever is there
 * (a rename's carry of the row at `from_path` is the commit's, which knows
 * both paths — `mutate/commit.ts`).
 */
export function supersede(existing: PendingRow | null, incoming: PendingRow): PendingRow {
  if (existing === null || incoming.kind !== "write") return incoming;
  if (existing.kind === "rename") return { ...existing, head: incoming.head, renderedHash: incoming.renderedHash, commitId: incoming.commitId, createdAt: incoming.createdAt };
  return { ...incoming, priorHash: existing.kind === "remove" ? existing.renderedHash : existing.priorHash };
}

/** Record an intent: one row per path — a later request for the same path supersedes the earlier (`supersede`, then `INSERT OR REPLACE`). */
export function insertPending(db: Database, repoId: string, row: PendingRow): void {
  const r = supersede(readPending(db, repoId, row.path), row);
  db.prepare(
    `INSERT OR REPLACE INTO pending_materializations (repo_id, ${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(repoId, r.path, r.kind, r.fromPath, r.docId, r.head, r.renderedHash, r.priorHash, r.commitId, r.createdAt);
}

/** Drop the intent at `(repo, path)`: the file is as recorded, or a later observation superseded it. */
export function deletePending(db: Database, repoId: string, path: string): void {
  db.prepare("DELETE FROM pending_materializations WHERE repo_id = ? AND path = ?").run(repoId, path);
}

// The bytes a `write`/`rename` row materializes: spec/store §6.1 reconstruct
// of the document's CURRENT state (17.0, §5.7: a row always names its
// document's current head, because a later commit to the same path replaces
// the row, and §6.1 is byte-exact for the head), which must hash to
// `rendered_hash`. Null when nothing can be rendered (the head moved under the
// row — impossible while the replace rule holds, checked anyway) — the row is
// then left for a later materializer rather than guessed. Through 16.x this
// was `reconstruct at rev_id` through the Merkle tree, and the prior bytes a
// `revisions` self-join on `seq − 1`; no history table is read here now (M4).
function renderedBytes(store: Store, row: PendingRow): string | null {
  if (row.head === null) return null;
  const raw = reconstructContent(store.db, row.docId);
  if (raw === null || !sha256(raw).equals(row.renderedHash)) return null;
  return raw;
}

/**
 * Materialize one row through `docStore` and, when the file is as recorded,
 * delete the row. Returns true when the row was cleared, false when it was kept
 * (the path holds foreign bytes — the next observation decides — or the bytes
 * could not be rendered). Never throws for a foreign file; a doc store write
 * failure propagates with the row intact.
 */
export function materializeRow(store: Store, repoId: string, row: PendingRow, docStore: DocStore): boolean {
  const db = store.db;
  // OMGBASE_FAULT (Phase 5a): a fault before any write leaves the row and the
  // disk as they were; one after the write leaves the file in place and the row
  // owed — the next replay finds the bytes as recorded and clears it.
  faultPoint("materialize.before-write");
  const own = (bytes: string): boolean => {
    const h = sha256(bytes);
    return h.equals(row.renderedHash) || (row.priorHash !== null && h.equals(row.priorHash));
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
          // the renamed file holds the prior bytes, so it is rewritten.
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
      // Unlink only the bytes the deleted document rendered (`docs.file_hash`
      // before the tombstone); a file a human rewrote meanwhile stays (untracked
      // now — the next sweep re-creates it).
      const at = docStore.read(row.path);
      if (at !== null && sha256(at).equals(row.renderedHash)) docStore.remove(row.path);
      done = true;
      break;
    }
  }
  if (done) faultPoint("materialize.after-write");
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
export function materializePending(store: Store, repoId: string, docStore: DocStore, now: string = new Date().toISOString()): string[] {
  const out: string[] = [];
  try {
    for (const row of listPending(store.db, repoId)) {
      let done: boolean;
      try {
        done = materializeRow(store, repoId, row, docStore);
      } catch (e) {
        // spec/store §5.8 (17.0, 3e-ii — resolution 18): a replay that threw keeps
        // its row and is retried by the next sweep; the stall is reported through
        // the alert channel, not swallowed — the error still propagates.
        raiseAlert(store.db, repoId, {
          code: MATERIALIZATION_FAILED_ALERT,
          severity: "error",
          message: materializationFailedMessage(`/${row.path}`, e instanceof Error ? e.message : String(e)),
          detail: { path: `/${row.path}`, kind: row.kind, reason: e instanceof Error ? e.message : String(e) },
        }, now);
        throw e;
      }
      if (done) out.push(row.path);
    }
    // A full pass with no failure ends the failure condition (the backlog is re-derived below).
    clearAlert(store.db, repoId, MATERIALIZATION_FAILED_ALERT, now);
  } finally {
    refreshBacklogAlert(store.db, repoId, now);
  }
  return out;
}
