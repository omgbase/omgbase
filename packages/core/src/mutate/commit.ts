import type { Database } from "better-sqlite3";
import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { ingestFile, ingestInto, type IngestResult } from "../core/ingest.js";
import { newCommit } from "../core/store/writers.js";
import { ftsDeleteDoc } from "../core/store/fts.js";
import { adoptPhantoms, rebuildDocEdges } from "../core/store/edges.js";
import { makeReconcilingResolver } from "../sync/reconciling-ingest.js";
import type { InboundLink } from "../graph/inbound-links.js";
import { makeKnownIdResolver } from "./known-ids.js";
import type { DocStore } from "./doc-store.js";
import { MutationError, type MutDoc } from "./tree.js";

// The commit of a request (spec/mutate §4 step 5, 2.2; spec/store §5.4 "The
// api path"): ONE SQLite transaction, ONE `commits` row, one revision per
// document, all-or-nothing. Every write tool lowers to an ordered list of
// internal effects — `apply` and its sugar to `ingest_known` per touched
// document, `docs_create`/`docs_set_meta` to `ingest_reconciled`,
// `docs_delete` to `tombstone`, `docs_move` to `move_path` followed by the
// retarget's `ingest_known`s — and `commitChangeset` runs them in three phases:
//
//   A. validate every effect's precondition (reads only): the row triple
//      `(path, current_rev, file_hash)` each document was planned against must
//      still be the document's, and the bytes on disk must still hash to the
//      row's `file_hash`. The first document whose row moved aborts the request
//      with `stale_plan` (or `doc_missing`/`path_taken` for the effect-specific
//      rules below); the first whose on-disk bytes moved aborts it with
//      `sync_conflict` after its bytes are ingested as an `observed` commit of
//      their own. Nothing is written either way;
//   B. the file half of every effect, in order: write the rendered bytes,
//      rename the moved file (atomic writes through the DocStore);
//   C. the database half of every effect, in order, inside one `BEGIN
//      IMMEDIATE` transaction (`store.writeImmediate`): the same validation
//      again through the transaction's handle — the write lock is held, so what
//      it reads is what the effects will write against — THEN `newCommit`, then
//      per effect `ingestInto` under that commit, the path change + edge
//      re-point, the tombstone, the stat-cache refresh. Validating before the
//      mint means a conflict found here rolls back having minted nothing: no
//      `c`/`d` id is burned, no fixture-visible gap.
//
// Files are written BEFORE the transaction (B before C; a DB-first
// materialization is a later store major): a failure inside C rolls back every
// document while the files written in B stay ahead of the database until the
// next observation heals them as `observed` commits (spec/mutate §10). Phase A
// runs the checks once more OUTSIDE the transaction only so that the common
// conflict — a human edit that landed before the request — aborts before any
// file is touched; phase C's run is the authoritative one (an edit that lands
// between A and B is overwritten by B — the window the reorder closes). A
// tombstone's file removal is the one file action that runs AFTER the
// transaction (phase D) — removing first would leave the file BEHIND the
// database on a rollback, the one direction an observation cannot heal.
//
// This effect set is internal to the engine, not a wire format.

/** The row triple a document was planned against (spec/mutate §4 step 5, 2.2):
 *  `docs.path`, `docs.current_rev` and `docs.file_hash` (lower-case hex, `null`
 *  when the row has none) as one `SELECT` read them at plan time. Invariant I3
 *  (spec/store §8) makes `current_rev` the version vector of every live block,
 *  so the commit need not re-read blocks: a block cannot change without a new
 *  revision. The same triple the opset precondition `{ id, path, base_revision,
 *  hash }` freezes. */
export interface DocBase {
  path: string;
  currentRev: string | null;
  fileHash: string | null;
}

/** One `SELECT path, current_rev, file_hash` of a live document: the triple
 *  the plan captures and the commit re-validates. `null` when no live row. */
export function readDocBase(db: Database, docId: string): DocBase | null {
  const row = db.prepare("SELECT path, current_rev, lower(hex(file_hash)) hash FROM docs WHERE doc_id = ? AND deleted_commit IS NULL").get(docId) as
    | { path: string; current_rev: string | null; hash: string | null }
    | undefined;
  return row ? { path: row.path, currentRev: row.current_rev, fileHash: row.hash } : null;
}

export type Effect =
  /** The api ingest of a mutated working tree: `rendered` is `renderDoc(mutDoc)`,
   *  the known-id resolver threads `mutDoc`'s ids onto the re-parse and labels
   *  dispositions against `priorIds`. `path` is where the bytes are written and
   *  the path the revision carries — the moved document of a `docs_move` is
   *  loaded under its OLD path and overridden to the new one; `base.path` is
   *  the path it was loaded under (where its bytes are on disk at phase A).
   *  `base` is the triple the document was planned against. */
  | { kind: "ingest_known"; docId: string; path: string; rendered: string; mutDoc: MutDoc; priorIds: Set<string>; base: DocBase }
  /** A whole-file ingest through the probabilistic reconciler: identity is
   *  re-derived from the bytes. `precondition` is `null` for `docs_create` (no
   *  live document may exist at `path`, else `path_taken`) and, for
   *  `docs_set_meta`, the patched document's triple plus `original` — the bytes
   *  the patch was computed from, which must still be what the row's
   *  `file_hash` names (2.2 closes the unchecked gap: a human edit under a
   *  `set_meta` is a `sync_conflict`, not an api commit of their bytes);
   *  `original: null` when the doc store had no bytes (headless: no disk check). */
  | { kind: "ingest_reconciled"; path: string; source: string; precondition: { docId: string; base: DocBase; original: string | null } | null }
  /** `docs_move`'s row half: `docs.path` and the current revision's `path`,
   *  the open inbound edges re-pointed at `phantom:<from>`, phantoms at `to`
   *  adopted. The file half renames `from` → `to` (or writes `bytes` at `to`
   *  when the source file is absent). Precondition: the document is live at
   *  `from` with `currentRev` (else `stale_plan`; gone → `doc_missing`) and no
   *  live document is at `to` (else `path_taken`). */
  | { kind: "move_path"; docId: string; from: string; to: string; currentRev: string | null; inbound: InboundLink[]; bytes: string }
  /** Tombstone the document and its live blocks under the commit. `pool: false`
   *  is `docs_delete` (an intentional removal pools nothing, spec/mutate §10);
   *  `pool: true` is the observed deletion's snapshot (spec/store §5.6 — the
   *  observe path still commits through `sync/tombstone.ts`; the flag is here
   *  for the day `observe_many` runs through this executor). The file at
   *  `path` is removed after the transaction. Precondition: the document is
   *  live at `path` with `currentRev` (`doc_missing` / `stale_plan`). */
  | { kind: "tombstone"; docId: string; path: string; currentRev: string | null; pool: boolean }
  /** Freshness stat cache (spec/sync §4.3): refresh the row for `path` after
   *  `bytes` were written there / drop it. Added only when the request named a
   *  workspace (`omgbaseDir`), as before. */
  | { kind: "record_stat"; path: string; bytes: string }
  | { kind: "clear_stat"; path: string };

/** The one `commits` row a request records. `ops` is threaded, never populated
 *  yet (ADR-003's intent record waits for the planner step). */
export interface CommitHead {
  origin: "api";
  actor: string | null;
  reason: string | null;
  checkpointId?: string | null;
  ops?: string | null;
}

/** What a committed request returns: the shared commit id (`null` when the
 *  request had no effect at all — a changeset that touched no document records
 *  nothing, as before) and, in effect order, one `IngestResult` per
 *  `ingest_known`/`ingest_reconciled` effect. */
export interface CommitOutcome {
  commitId: string | null;
  ingests: IngestResult[];
}

/** Validation's finding: the document whose on-disk bytes moved from under the request. */
export interface FileConflict {
  docId: string;
  path: string;
  bytes: string;
}

export type CommitPhasesResult = { committed: CommitOutcome } | { conflict: FileConflict };

export interface CommitTargets {
  docStore: DocStore;
  /** Set when the request runs in a workspace: the conflict path refreshes the
   *  stat cache for the re-ingested file (the effects carry their own). */
  omgbaseDir?: string;
}

/**
 * Commit `effects` as one request under `head` at `ts`. Throws `sync_conflict`
 * (retriable) when a document changed on disk — after ingesting those bytes as
 * an `observed` commit so a retry sees them — `stale_plan` (retriable, `{ doc,
 * expected_revision, current: { revision, hash } }`) when a document's row
 * moved since the plan, `doc_missing` / `path_taken` per effect, and otherwise
 * returns the shared commit id with the ingest results. The caller holds the
 * writer lock when it has a workspace.
 */
export function commitChangeset(store: Store, repoId: string, head: CommitHead, effects: Effect[], ts: string, targets: CommitTargets): CommitOutcome {
  const result = runPhases(store, repoId, head, effects, ts, targets.docStore);
  if ("conflict" in result) {
    const { path, bytes } = result.conflict;
    // A human edit landed first: ingest it (its own observed commit, after the
    // rollback), then the caller must retry against the new revision.
    ingestFile(store, repoId, path, bytes, { ts, resolveIds: makeReconcilingResolver(store, repoId, { ts, path }) });
    if (targets.omgbaseDir) targets.docStore.recordStat(store, repoId, path, bytes);
    throw new MutationError("sync_conflict", `file ${path} changed on disk; re-ingested — retry`, { retriable: true });
  }
  return result.committed;
}

// The disk half of a failed validation travels as this private signal — thrown
// inside the transaction it rolls the transaction back (nothing minted), and
// `runPhases` turns it into the `{ conflict }` return so the observed ingest
// can run in a transaction of its own. The row-side findings (`stale_plan`,
// `doc_missing`, `path_taken`) are thrown as `MutationError`s directly: they
// need no ingest, and a throw out of the transaction is its rollback.
class ConflictSignal {
  constructor(readonly conflict: FileConflict) {}
}

/** Phases A–D over the effects; a disk conflict is returned, not thrown. */
export function runPhases(store: Store, repoId: string, head: CommitHead, effects: Effect[], ts: string, docStore: DocStore): CommitPhasesResult {
  // A request with nothing to do (a macro whose plan found no block, a
  // `links_repair` with no hit) writes no file and mints no commit row — an
  // `api` commit with no revision would read as a move or a deletion in the
  // change feed. `macros::links-repair-path-glob-no-hits` pins it.
  if (effects.length === 0) return { committed: { commitId: null, ingests: [] } };

  // Phase A — reads only. The bytes on disk of every `ingest_known` document
  // (at the path it was loaded under — the moved document of a `docs_move` is
  // still at `from` here); a `docs_set_meta` carries the bytes it patched. A
  // path with no file (a headless NullDocStore, a deleted file) has no disk
  // check. The I/O stays outside the transaction; phase C reuses these hashes.
  const onDisk = new Map<string, string>();
  for (const e of effects) {
    if (e.kind === "ingest_known") {
      const bytes = docStore.read(e.base.path);
      if (bytes !== null) onDisk.set(e.docId, bytes);
    } else if (e.kind === "ingest_reconciled" && e.precondition?.original !== null && e.precondition?.original !== undefined) {
      onDisk.set(e.precondition.docId, e.precondition.original);
    }
  }
  try {
    validate(store.db, repoId, effects, onDisk);
  } catch (err) {
    if (err instanceof ConflictSignal) return { conflict: err.conflict };
    throw err;
  }

  // Phase B — the file half of every effect, in order (a headless NullDocStore
  // does nothing). A move renames before the retarget writes so a self-linking
  // moved document's rewritten bytes land at its new path.
  for (const e of effects) {
    switch (e.kind) {
      case "ingest_known":
        docStore.write(e.path, e.rendered);
        break;
      case "ingest_reconciled":
        docStore.write(e.path, e.source);
        break;
      case "move_path":
        if (docStore.exists(e.from)) docStore.rename(e.from, e.to);
        else docStore.write(e.to, e.bytes);
        break;
      default:
        break;
    }
  }

  // Phase C — one IMMEDIATE transaction: validate again under the write lock,
  // THEN one commit row, then the database half of every effect in order.
  // Mint order: one `c`, then per document `r`, `x`, `e` (and `d` for a
  // created document) — nothing before validation passes.
  let committed: CommitOutcome;
  try {
    committed = store.writeImmediate((db): CommitOutcome => {
      validate(db, repoId, effects, onDisk);
      const commit = newCommit(db, {
        repoId,
        ts,
        origin: head.origin,
        actor: head.actor,
        reason: head.reason,
        checkpointId: head.checkpointId ?? null,
        ops: head.ops ?? null,
      });
      const commitId = commit.commitId;
      const ingests: IngestResult[] = [];
      for (const e of effects) {
        switch (e.kind) {
          case "ingest_known":
            // INTENT path: persist the ops' tree with its KNOWN block ids — never
            // re-derive identity from the rendered bytes (node-editability).
            ingests.push(ingestInto(db, repoId, e.path, e.rendered, {
              ts,
              commitId,
              resolveIds: makeKnownIdResolver(store, repoId, e.mutDoc, e.priorIds, { path: e.path }),
            }));
            break;
          case "ingest_reconciled":
            ingests.push(ingestInto(db, repoId, e.path, e.source, {
              ts,
              commitId,
              resolveIds: makeReconcilingResolver(store, repoId, { ts, path: e.path }),
            }));
            break;
          case "move_path":
            movePath(db, e);
            break;
          case "tombstone":
            tombstone(db, commitId, ts, e);
            break;
          case "record_stat":
            docStore.recordStat(store, repoId, e.path, e.bytes);
            break;
          case "clear_stat":
            docStore.clearStat(store, repoId, e.path);
            break;
        }
      }
      return { commitId, ingests };
    });
  } catch (err) {
    if (err instanceof ConflictSignal) return { conflict: err.conflict };
    throw err;
  }

  // Phase D — a deleted document's file goes once the tombstone is durable.
  for (const e of effects) if (e.kind === "tombstone") docStore.remove(e.path);

  return { committed };
}

// Every effect's precondition against the rows `db` sees now (spec/mutate §4
// step 5, 2.2). Run twice: outside the transaction (phase A, so a conflict
// touches no file) and inside it (phase C, authoritative). Row first — a
// document whose row moved is `stale_plan` whatever its bytes — then the disk:
// `file_hash` (when the row has one) must name the bytes phase A read.
function validate(db: Database, repoId: string, effects: Effect[], onDisk: Map<string, string>): void {
  const liveAt = db.prepare("SELECT doc_id FROM docs WHERE repo_id = ? AND path = ? AND deleted_commit IS NULL");
  const pathTaken = (path: string): boolean => liveAt.get(repoId, path) !== undefined;

  const checkRow = (docId: string, expected: { path: string; currentRev: string | null; fileHash?: string | null }): DocBase => {
    const row = readDocBase(db, docId);
    if (!row) throw new MutationError("doc_missing", `doc ${docId} no longer exists`, { doc: docId });
    const moved = row.path !== expected.path || row.currentRev !== expected.currentRev || (expected.fileHash !== undefined && row.fileHash !== expected.fileHash);
    if (moved) {
      throw new MutationError("stale_plan", `document ${docId} changed since the request was planned; re-plan`, {
        doc: docId,
        expected_revision: expected.currentRev,
        current: { revision: row.currentRev, hash: row.fileHash },
        retriable: true,
      });
    }
    return row;
  };
  const checkDisk = (docId: string, row: DocBase): void => {
    const bytes = onDisk.get(docId);
    if (bytes === undefined || row.fileHash === null) return;
    if (sha256(bytes).toString("hex") !== row.fileHash) throw new ConflictSignal({ docId, path: row.path, bytes });
  };

  for (const e of effects) {
    switch (e.kind) {
      case "ingest_known":
        checkDisk(e.docId, checkRow(e.docId, e.base));
        break;
      case "ingest_reconciled":
        if (e.precondition) checkDisk(e.precondition.docId, checkRow(e.precondition.docId, e.precondition.base));
        else if (pathTaken(e.path)) throw new MutationError("path_taken", `document already exists at ${e.path}`, { path: e.path });
        break;
      case "move_path":
        checkRow(e.docId, { path: e.from, currentRev: e.currentRev });
        if (pathTaken(e.to)) throw new MutationError("path_taken", `a document already exists at ${e.to}`, { path: e.to });
        break;
      case "tombstone":
        checkRow(e.docId, { path: e.path, currentRev: e.currentRev });
        break;
      default:
        break;
    }
  }
}

// `docs_move`'s rows (spec/mutate §6): the document row's path + its current
// revision's path pointer; then the edge index. Every open edge from ANOTHER
// doc into this one resolved via the old path, so it dangles now → re-point it
// at the old path's phantom (in place, mirroring adoptPhantoms). A self-doc
// edge dangles only when the link names the path (`[x](/old.md#H)`); a pure
// fragment (`#H`) resolves to the doc regardless of path and is left alone —
// the inbound scan distinguishes them from the raw. Runs BEFORE the retarget's
// ingests so each rewritten source's `maintainEdges` resolves `[x](new)` to the
// document (adopted here), not to a phantom.
function movePath(db: Database, e: Extract<Effect, { kind: "move_path" }>): void {
  db.prepare("UPDATE docs SET path = ? WHERE doc_id = ?").run(e.to, e.docId);
  db.prepare("UPDATE revisions SET path = ? WHERE doc_id = ? AND rev_id = ?").run(e.to, e.docId, e.currentRev);

  const phantom = `phantom:${e.from}`;
  const affected = new Set<string>();
  const others = db.prepare("SELECT DISTINCT src_doc FROM edges WHERE dst_node = ? AND to_commit IS NULL AND src_doc != ?").all(e.docId, e.docId) as { src_doc: string }[];
  for (const r of others) affected.add(r.src_doc);
  db.prepare("UPDATE edges SET dst_node = ? WHERE dst_node = ? AND to_commit IS NULL AND src_doc != ?").run(phantom, e.docId, e.docId);
  const selfEdge = db.prepare("UPDATE edges SET dst_node = ? WHERE dst_node = ? AND to_commit IS NULL AND src_doc = ? AND src_block = ? AND anchor IS ?");
  for (const l of e.inbound) {
    if (l.doc_id !== e.docId || l.block_id === null) continue;
    selfEdge.run(phantom, e.docId, e.docId, l.block_id, l.anchor);
    affected.add(e.docId);
  }
  for (const d of affected) rebuildDocEdges(db, d);
  // Links already written against the NEW path resolve to this doc now.
  adoptPhantoms(db, e.to, e.docId);
}

// Tombstone the document and its live blocks under the commit; FTS rows drop
// with the blocks. `pool` snapshots the live blocks first (spec/store §5.6).
function tombstone(db: Database, commitId: string, ts: string, e: Extract<Effect, { kind: "tombstone" }>): void {
  if (e.pool) {
    const expires = new Date(Date.parse(ts) + 30 * 24 * 3600 * 1000).toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO resurrection_pool (block_id, repo_id, doc_id, raw_hash, norm_hash, type, deleted_commit, expires_ts)
       SELECT block_id, repo_id, doc_id, raw_hash, norm_hash, type, ?, ?
         FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL`,
    ).run(commitId, expires, e.docId);
  }
  ftsDeleteDoc(db, e.docId);
  db.prepare("UPDATE blocks SET deleted_commit = ? WHERE doc_id = ? AND deleted_commit IS NULL").run(commitId, e.docId);
  db.prepare("UPDATE docs SET deleted_commit = ? WHERE doc_id = ?").run(commitId, e.docId);
}
