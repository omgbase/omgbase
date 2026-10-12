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

// The commit of a request (spec/mutate §4 step 5, 2.1; spec/store §5.4 "The
// api path"): ONE SQLite transaction, ONE `commits` row, one revision per
// document, all-or-nothing. Every write tool lowers to an ordered list of
// internal effects — `apply` and its sugar to `ingest_known` per touched
// document, `docs_create`/`docs_set_meta` to `ingest_reconciled`,
// `docs_delete` to `tombstone`, `docs_move` to `move_path` followed by the
// retarget's `ingest_known`s — and `commitChangeset` runs them in three phases:
//
//   A. file-CAS every `ingest_known` document (reads only): the first document
//      whose on-disk bytes no longer hash to `docs.file_hash` aborts the
//      request before anything is written — its bytes are ingested as an
//      `observed` commit of their own and `sync_conflict` is raised;
//   B. the file half of every effect, in order: write the rendered bytes,
//      rename the moved file (atomic writes through the DocStore);
//   C. the database half of every effect, in order, inside one `store.write`:
//      `newCommit` once, then per effect `ingestInto` under that commit, the
//      path change + edge re-point, the tombstone, the stat-cache refresh.
//
// Files are written BEFORE the transaction (B before C; a DB-first
// materialization is a later store major): a failure inside C rolls back every
// document while the files written in B stay ahead of the database until the
// next observation heals them as `observed` commits (spec/mutate §10). A
// tombstone's file removal is the one file action that runs AFTER the
// transaction (phase D) — removing first would leave the file BEHIND the
// database on a rollback, the one direction an observation cannot heal.
//
// Step 4 of the foundation plan moves phase A inside phase C (`BEGIN
// IMMEDIATE`); `runPhases` already *returns* the conflict instead of throwing
// so the observed ingest can run after the rollback.
//
// This effect set is internal to the engine, not a wire format.

export type Effect =
  /** The api ingest of a mutated working tree: `rendered` is `renderDoc(mutDoc)`,
   *  the known-id resolver threads `mutDoc`'s ids onto the re-parse and labels
   *  dispositions against `priorIds`. `path` is where the bytes are written and
   *  the path the revision carries — the moved document of a `docs_move` is
   *  loaded under its OLD path and overridden to the new one. */
  | { kind: "ingest_known"; docId: string; path: string; rendered: string; mutDoc: MutDoc; priorIds: Set<string> }
  /** A whole-file ingest through the probabilistic reconciler (`docs_create`,
   *  `docs_set_meta`): identity is re-derived from the bytes. */
  | { kind: "ingest_reconciled"; path: string; source: string }
  /** `docs_move`'s row half: `docs.path` and the current revision's `path`,
   *  the open inbound edges re-pointed at `phantom:<from>`, phantoms at `to`
   *  adopted. The file half renames `from` → `to` (or writes `bytes` at `to`
   *  when the source file is absent). */
  | { kind: "move_path"; docId: string; from: string; to: string; currentRev: string | null; inbound: InboundLink[]; bytes: string }
  /** Tombstone the document and its live blocks under the commit. `pool: false`
   *  is `docs_delete` (an intentional removal pools nothing, spec/mutate §10);
   *  `pool: true` is the observed deletion's snapshot (spec/store §5.6 — the
   *  observe path still commits through `sync/tombstone.ts`; the flag is here
   *  for the day `observe_many` runs through this executor). The file at
   *  `path` is removed after the transaction. */
  | { kind: "tombstone"; docId: string; path: string; pool: boolean }
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

/** Phase A's finding: the document whose on-disk bytes moved from under the request. */
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
 * (retriable) when phase A finds a document changed on disk — after ingesting
 * those bytes as an `observed` commit so a retry sees them — and otherwise
 * returns the shared commit id with the ingest results. The caller holds the
 * writer lock when it has a workspace.
 */
export function commitChangeset(store: Store, repoId: string, head: CommitHead, effects: Effect[], ts: string, targets: CommitTargets): CommitOutcome {
  const result = runPhases(store, repoId, head, effects, ts, targets.docStore);
  if ("conflict" in result) {
    const { path, bytes } = result.conflict;
    // A human edit landed first: ingest it (its own observed commit), then the
    // caller must retry against the new revision.
    ingestFile(store, repoId, path, bytes, { ts, resolveIds: makeReconcilingResolver(store, repoId, { ts, path }) });
    if (targets.omgbaseDir) targets.docStore.recordStat(store, repoId, path, bytes);
    throw new MutationError("sync_conflict", `file ${path} changed on disk; re-ingested — retry`, { retriable: true });
  }
  return result.committed;
}

/** Phases A–D over the effects; a phase-A conflict is returned, not thrown. */
export function runPhases(store: Store, repoId: string, head: CommitHead, effects: Effect[], ts: string, docStore: DocStore): CommitPhasesResult {
  // A request with nothing to do (a macro whose plan found no block, a
  // `links_repair` with no hit) writes no file and mints no commit row — an
  // `api` commit with no revision would read as a move or a deletion in the
  // change feed. `macros::links-repair-path-glob-no-hits` pins it.
  if (effects.length === 0) return { committed: { commitId: null, ingests: [] } };

  // Phase A — file-CAS, reads only. The bytes on disk must still be the
  // revision the ops were computed against. Keyed by the document's CURRENT
  // stored path (the moved document of a `docs_move` is still at `from` here).
  const current = store.db.prepare("SELECT path, file_hash FROM docs WHERE doc_id = ?");
  for (const e of effects) {
    if (e.kind !== "ingest_known") continue;
    const row = current.get(e.docId) as { path: string; file_hash: Buffer | null } | undefined;
    if (!row?.file_hash) continue;
    const onDisk = docStore.read(row.path);
    if (onDisk === null) continue;
    if (!sha256(onDisk).equals(row.file_hash)) return { conflict: { docId: e.docId, path: row.path, bytes: onDisk } };
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

  // Phase C — one transaction, one commit row, the database half of every
  // effect in order. Mint order: one `c`, then per document `r`, `x`, `e`
  // (and `d` for a created document).
  const committed = store.write((db): CommitOutcome => {
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

  // Phase D — a deleted document's file goes once the tombstone is durable.
  for (const e of effects) if (e.kind === "tombstone") docStore.remove(e.path);

  return { committed };
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
