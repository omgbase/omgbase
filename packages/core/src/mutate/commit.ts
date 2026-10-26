import type { Database } from "better-sqlite3";
import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { ingestFile, ingestInto, type IngestResult } from "../core/ingest.js";
import { deletePending, insertPending, materializeRow, readPending, supersede, type PendingRow } from "./materialize.js";
import { requireHistory } from "../core/capabilities/registry.js";
import { mintId } from "../core/ids.js";
import { claimsOf } from "../core/capabilities/registry.js";
import { appendFeedEntry, appendFeedRow } from "../core/store/feed.js";
import type { TreeInputBlock } from "../core/store/writers.js";
import { ftsDeleteDoc } from "../core/store/fts.js";
import { adoptPhantoms, rebuildDocEdges } from "../core/store/edges.js";
import { makeReconcilingResolver } from "../sync/reconciling-ingest.js";
import type { InboundLink } from "../graph/inbound-links.js";
import { makeKnownIdResolver } from "./known-ids.js";
import type { DocStore } from "./doc-store.js";
import { MutationError, type MutDoc } from "./tree.js";

// The commit of a request (spec/mutate §4 step 5, 2.2; spec/store §5.4 "The
// api path", §5.7 "Materialization", 14.0): ONE SQLite transaction, ONE
// `commits` row, one revision per document, all-or-nothing in the database;
// the files follow the commit through recorded intent. Every write tool lowers
// to an ordered list of internal effects — `apply` and its sugar to
// `ingest_known` per touched document, `docs_create`/`docs_set_meta` to
// `ingest_reconciled`, `docs_delete` to `tombstone`, `docs_move` to `move_path`
// followed by the retarget's `ingest_known`s — and `commitChangeset` runs them
// in three phases, DB first:
//
//   A. reads only, outside the transaction: a pending materialization row left
//      at a touched path by an earlier request (a crash, a refused write) is
//      replayed first, so the file is read as the engine left it rather than
//      as a human edit; then the bytes on disk of every document the request
//      loaded (I/O stays out of the transaction — phase C compares these);
//   C. one `BEGIN IMMEDIATE` transaction (`store.writeImmediate`): validate
//      every effect's precondition through the transaction's handle — the row
//      triple `(path, head, file_hash)` each document was planned
//      against must still be the document's, the bytes phase A read must hash
//      to the row's `file_hash`, the document operations' own guards
//      (`path_taken`, `doc_missing`) — THEN `newCommit`, then per effect
//      `ingestInto` under that commit, the path change + edge re-point, the
//      tombstone; finally one `pending_materializations` row per file the
//      request owes the disk (`write` / `rename` / `remove`, spec/store §5.7),
//      each carrying what its replay needs — the head it renders, the bytes
//      expected, and `prior_hash`: the bytes the engine itself last wrote at
//      the path, which is the `file_hash` this transaction validated the file
//      against (17.0, M4 — a replay recognises the engine's own stale file by
//      the row, never by a history read). Validating before the mint means a
//      conflict found here rolls back having minted nothing — no `c`/`d` id is
//      burned — and having touched no file;
//   B'. after COMMIT, in effect order: materialize each effect's row through
//      the DocStore (`mutate/materialize.ts`: write the rendered bytes, rename
//      the moved file, unlink the deleted one — each only over bytes the engine
//      recognises as its own; foreign bytes keep the row and the next
//      observation lets the file win), refresh the stat cache for the files
//      that landed, and delete each row as its file is done (autocommit per
//      file).
//
// A failure or crash between C and B' leaves the feed row (the `changes_since`
// digest), the recorder's commit and revisions durable and the rows pending: the next materializer
// (the freshness sweep's step 0, recovery, the next request touching the path,
// or an observation of the file — spec/store §5.7) finishes the files from the
// recorded intent with the api actor, reason and known ids intact. Through
// 13.7 the files were written BEFORE the transaction, so a failure inside it
// left them ahead of the database and the next observation healed them as
// `observed` commits — the intent lost (spec/mutate §10 "Fixed (2.2)").
//
// This effect set is internal to the engine, not a wire format.

/** The row triple a document was planned against (spec/mutate §4 step 5, 2.2):
 *  `docs.path`, `docs.head` and `docs.file_hash` (lower-case hex, `null`
 *  when the row has none) as one `SELECT` read them at plan time. The head
 *  token (store 17.0, D1) is minted on every change to the document — content,
 *  structure, path or liveness — so the commit need not re-read blocks: a block
 *  cannot change without a new head. The same triple the opset precondition
 *  `{ _id, _path, base_revision, _hash }` freezes. */
export interface DocBase {
  path: string;
  /** The head token (`docs.head`). */
  currentRev: string | null;
  fileHash: string | null;
}

/** One `SELECT path, head, file_hash` of a live document: the triple
 *  the plan captures and the commit re-validates. `null` when no live row. */
export function readDocBase(db: Database, docId: string): DocBase | null {
  const row = db.prepare("SELECT path, head, lower(hex(file_hash)) hash FROM docs WHERE doc_id = ? AND deleted_at IS NULL").get(docId) as
    | { path: string; head: string | null; hash: string | null }
    | undefined;
  return row ? { path: row.path, currentRev: row.head, fileHash: row.hash } : null;
}

export type Effect =
  /** The api ingest of a mutated working tree: `rendered` is `renderDoc(mutDoc)`,
   *  the known-id resolver threads `mutDoc`'s ids onto the re-parse and labels
   *  dispositions against `priorIds`. `path` is where the bytes are written and
   *  the path the revision carries — the moved document of a `docs_move` is
   *  loaded under its OLD path and overridden to the new one; `base.path` is
   *  the path it was loaded under (where its bytes are on disk at phase A).
   *  `base` is the triple the document was planned against — or `null` for a
   *  document the request CREATES (spec/mutate §11.3, 3.0: the planner adopted
   *  its parsed tree, so its blocks commit with known ids and `inserted / api`
   *  dispositions); the guard is then `path_taken` — no live document at `path`
   *  when the transaction validates — and `docId` is the plan's symbol, the
   *  ingest minting the real `d`. */
  | { kind: "ingest_known"; docId: string; path: string; rendered: string; mutDoc: MutDoc; priorIds: Set<string>; base: DocBase | null }
  /** A whole-file ingest through the probabilistic reconciler: identity is
   *  re-derived from the bytes. `precondition` is `null` for `docs_create` (no
   *  live document may exist at `path`, else `path_taken`) and, for
   *  `docs_set_meta`, the patched document's triple plus `original` — the bytes
   *  the patch was computed from, which must still be what the row's
   *  `file_hash` names (2.2 closes the unchecked gap: a human edit under a
   *  `set_meta` is a `sync_conflict`, not an api commit of their bytes);
   *  `original: null` when the doc store had no bytes (headless: no disk check). */
  | { kind: "ingest_reconciled"; path: string; source: string; precondition: { docId: string; base: DocBase; original: string | null } | null }
  /** `docs_move`'s row half: `docs.path`, a NEW head (store 17.0, D11: a move
   *  is a transition — the recorder captures a revision of the unchanged tree
   *  at the new path), the open inbound edges re-pointed at `phantom:<from>`,
   *  phantoms at `to` adopted. When the moved document is itself a retarget
   *  source of the same request (it links to itself by path) its `ingest_known`
   *  below mints the head and carries the path instead — one revision, not two.
   *  The file half (a `rename` row, spec/store §5.7) renames `from` → `to`, or
   *  writes the document's bytes at `to` when the source file is absent; `bytes`
   *  is the source file as read at plan time (the hash the row falls back to
   *  for a document with no revision). Precondition: the document is live at
   *  `from` with `currentRev` (else `stale_plan`; gone → `doc_missing`) and no
   *  live document is at `to` (else `path_taken`). */
  | { kind: "move_path"; docId: string; from: string; to: string; currentRev: string | null; inbound: InboundLink[]; bytes: string }
  /** Tombstone the document and its live blocks under the commit. `pool: false`
   *  is `docs_delete` (an intentional removal pools nothing, spec/mutate §10);
   *  `pool: true` is the observed deletion's snapshot (spec/store §5.6 — the
   *  observe path still commits through `sync/tombstone.ts`; the flag is here
   *  for the day `observe_many` runs through this executor). The file at
   *  `path` is unlinked by B' iff it still holds the deleted revision's bytes
   *  (a `remove` row, spec/store §5.7). Precondition: the document is
   *  live at `path` with `currentRev` (`doc_missing` / `stale_plan`). */
  | { kind: "tombstone"; docId: string; path: string; currentRev: string | null; pool: boolean }
  /** Freshness stat cache (spec/sync §4.3): refresh the row for `path` after
   *  `bytes` were written there / drop it. Added only when the request named a
   *  workspace (`omgbaseDir`), as before. */
  | { kind: "record_stat"; path: string; bytes: string }
  | { kind: "clear_stat"; path: string };

/** The one feed row a request records (spec/store §5.4 "The api path"; the
 *  recorder's `commits` row is its twin): `planId` is the admitted plan's
 *  digest (resolution 3 — carried on the feed row so a Receipt correlates with
 *  the documents it touched when history is off), `ops` the ADR-003 intent
 *  record the recorder alone keeps. Both null for a request that is not
 *  effect-driven. */
export interface CommitHead {
  origin: "api";
  actor: string | null;
  reason: string | null;
  planId?: string | null;
  ops?: string | null;
}

/** What a `move_path` effect minted (store 17.0, D11): the moved document's
 *  new head and the hash of its (unchanged) bytes — `head: null` when the
 *  document is itself a retarget source of the request, whose `ingest_known`
 *  carries the move. */
export interface MoveOutcome {
  docId: string;
  head: string | null;
  fileHashHex: string | null;
}

/** What a committed request returns: the shared commit id (`null` when the
 *  request had no effect at all — a changeset that touched no document records
 *  nothing, as before) and, in effect order, one `IngestResult` per
 *  `ingest_known`/`ingest_reconciled` effect and one `MoveOutcome` per
 *  `move_path` effect. */
export interface CommitOutcome {
  commitId: string | null;
  ingests: IngestResult[];
  moves: MoveOutcome[];
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
 * expected_revision, current: { revision, _hash } }`) when a document's row
 * moved since the plan, `doc_missing` / `path_taken` per effect, and otherwise
 * returns the shared commit id with the ingest results. The caller holds the
 * writer lock when it has a workspace.
 */
export function commitChangeset(store: Store, repoId: string, head: CommitHead, effects: Effect[], ts: string, targets: CommitTargets): CommitOutcome {
  const result = runPhases(store, repoId, head, effects, ts, targets.docStore);
  if ("conflict" in result) {
    const { path, bytes } = result.conflict;
    // A human edit landed first: ingest it (its own observed commit, after the
    // rollback), then the caller must retry against the new revision. The file
    // won, so an intent still pending at the path is superseded (spec/store
    // §5.7) — dropped in the same transaction as the observed commit.
    store.write((db) => {
      ingestFile(store, repoId, path, bytes, { ts, resolveIds: makeReconcilingResolver(store, repoId, { ts, path }) });
      deletePending(db, repoId, path);
    });
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

/** Phases A → C → B' over the effects; a disk conflict is returned, not thrown. */
export function runPhases(store: Store, repoId: string, head: CommitHead, effects: Effect[], ts: string, docStore: DocStore): CommitPhasesResult {
  // A request with nothing to do (a macro whose plan found no block, a
  // `links_repair` with no hit) writes no file and mints no commit row — an
  // `api` commit with no revision would read as a move or a deletion in the
  // change feed. `macros::links-repair-path-glob-no-hits` pins it.
  if (effects.length === 0) return { committed: { commitId: null, ingests: [], moves: [] } };

  // Phase A — reads only. First the intent an earlier request may have left
  // at a path this one touches (its file is behind the database until some
  // materializer runs; this is one): replayed through the DocStore so the
  // bytes read next are the engine's, not a stale file mistaken for a human
  // edit (a foreign file keeps its row and is read as it is). Then the bytes
  // on disk of every `ingest_known` document (at the path it was loaded under
  // — the moved document of a `docs_move` is still at `from` here); a
  // `docs_set_meta` carries the bytes it patched. A path with no file (a
  // headless NullDocStore, a deleted file) has no disk check. The I/O stays
  // outside the transaction; phase C compares these hashes.
  for (const path of touchedPaths(effects)) {
    const row = readPending(store.db, repoId, path);
    if (row) materializeRow(store, repoId, row, docStore);
  }
  const onDisk = new Map<string, string>();
  for (const e of effects) {
    if (e.kind === "ingest_known" && e.base) {
      const bytes = docStore.read(e.base.path);
      if (bytes !== null) onDisk.set(e.docId, bytes);
    } else if (e.kind === "ingest_reconciled" && e.precondition?.original !== null && e.precondition?.original !== undefined) {
      onDisk.set(e.precondition.docId, e.precondition.original);
    }
  }

  // Phase C — one IMMEDIATE transaction: validate under the write lock, THEN
  // one feed row (the core's; the recorder's `commits` row under the same id),
  // then the database half of every effect in order — each writing its feed
  // entry — then the file intent. Mint order: one `c`, then per document `r`,
  // `x`, `e` (and `d` for a created document; a `move_path` mints its `r`
  // first, 17.0 D11) — nothing before validation passes.
  let committed: CommitOutcome;
  try {
    committed = store.writeImmediate((db): CommitOutcome => {
      validate(db, repoId, effects, onDisk);
      const commit = appendFeedRow(db, {
        repoId,
        ts,
        origin: head.origin,
        actor: head.actor,
        reason: head.reason,
        planId: head.planId ?? null,
        ops: head.ops ?? null,
      });
      const commitId = commit.commitId;
      const ingests: IngestResult[] = [];
      const moves: MoveOutcome[] = [];
      // A moved document that the SAME request also rewrites (a self-linking
      // retarget source): its `ingest_known` mints the head at the new path.
      const rewrittenLater = new Set(effects.filter((e) => e.kind === "ingest_known").map((e) => e.docId));
      // The rows this request will materialize, keyed by the path the file
      // must end up at (spec/store §5.7): one per path, in effect order.
      const pending = new Map<string, PendingRow>();
      for (const e of effects) {
        switch (e.kind) {
          case "ingest_known": {
            // INTENT path: persist the ops' tree with its KNOWN block ids — never
            // re-derive identity from the rendered bytes (node-editability). A
            // document loaded under another path (the moved document of a
            // `docs_move` that this request also rewrites) gets a `moved` entry.
            const res = ingestInto(db, repoId, e.path, e.rendered, {
              ts,
              commitId,
              resolveIds: makeKnownIdResolver(store, repoId, e.mutDoc, e.priorIds, { path: e.path }),
              ...(e.base && e.base.path !== e.path ? { movedFrom: e.base.path } : {}),
            });
            ingests.push(res);
            recordWrite(pending, e.path, res, sha256(e.rendered), e.base ? fromHex(e.base.fileHash) : null, commitId, ts);
            break;
          }
          case "ingest_reconciled": {
            const res = ingestInto(db, repoId, e.path, e.source, {
              ts,
              commitId,
              resolveIds: makeReconcilingResolver(store, repoId, { ts, path: e.path }),
            });
            ingests.push(res);
            recordWrite(pending, e.path, res, sha256(e.source), e.precondition ? fromHex(e.precondition.base.fileHash) : null, commitId, ts);
            break;
          }
          case "move_path": {
            // A `write`/`rename` row still owed at `from` (an earlier request's
            // unfinished file half) is superseded by this rename, which carries
            // its obligation: the bytes the engine must still recognise at `from`
            // are that row's `prior_hash`, and the row goes (spec/store §5.7
            // "Supersession"). Read before the move rewrites the document's row.
            const owedAtFrom = pending.get(e.from) ?? readPending(db, repoId, e.from);
            const moved = movePath(db, repoId, e, ts, commit, !rewrittenLater.has(e.docId));
            moves.push(moved);
            // The bytes expected at `to`: the moved document's current bytes —
            // `docs.file_hash` (I1) — under its new head (a self-linking source's
            // retarget below replaces both with its own). The prior at `from` is
            // the same hash — what the engine last wrote there — unless a pending
            // row says the disk never caught up with it.
            const current = moved.fileHashHex === null ? sha256(e.bytes) : Buffer.from(moved.fileHashHex, "hex");
            let prior: Buffer | null = current;
            if (owedAtFrom && owedAtFrom.kind !== "remove") {
              prior = owedAtFrom.priorHash;
              pending.delete(e.from);
              deletePending(db, repoId, e.from);
            }
            pending.set(e.to, { path: e.to, kind: "rename", fromPath: e.from, docId: e.docId, head: moved.head ?? e.currentRev, renderedHash: current, priorHash: prior, commitId, createdAt: ts });
            break;
          }
          case "tombstone": {
            // The bytes it is safe to unlink: the document's current bytes
            // (`docs.file_hash` — what its head renders to, I1; the last
            // observed bytes when it never had a head).
            const row = db.prepare("SELECT file_hash FROM docs WHERE doc_id = ?").get(e.docId) as { file_hash: Buffer | null } | undefined;
            tombstone(db, repoId, commit, ts, e);
            // A remove drops whatever the path owed (spec/store §5.7 "Supersession"): no prior, no head.
            pending.set(e.path, { path: e.path, kind: "remove", fromPath: null, docId: e.docId, head: null, renderedHash: row?.file_hash ?? sha256(""), priorHash: null, commitId, createdAt: ts });
            break;
          }
          default:
            // record_stat / clear_stat: the stat cache reads the real file,
            // which does not exist in its new form yet — phase B'.
            break;
        }
      }
      for (const row of pending.values()) insertPending(db, repoId, row);
      return { commitId, ingests, moves };
    });
  } catch (err) {
    if (err instanceof ConflictSignal) return { conflict: err.conflict };
    throw err;
  }

  // Phase B' — the file half, in effect order, each row deleted as its file
  // lands; the row itself says which bytes may be overwritten (`prior_hash`).
  // The stat cache follows only a file that landed: a path whose row was kept
  // (foreign bytes) must stay a candidate for the next sweep, which is what
  // lets the human's edit win.
  const landed = new Set<string>();
  const land = (path: string): void => {
    const row = readPending(store.db, repoId, path);
    if (!row) return;
    if (materializeRow(store, repoId, row, docStore)) landed.add(path);
  };
  for (const e of effects) {
    switch (e.kind) {
      case "ingest_known":
        land(e.path);
        break;
      case "ingest_reconciled":
        land(e.path);
        break;
      case "move_path":
        land(e.to);
        break;
      case "tombstone":
        land(e.path);
        break;
      case "record_stat":
        if (landed.has(e.path)) docStore.recordStat(store, repoId, e.path, e.bytes);
        break;
      case "clear_stat":
        docStore.clearStat(store, repoId, e.path);
        break;
    }
  }

  return { committed };
}

// The row the file at `path` must become after an ingest: a `write` of the
// document's bytes under its new head, with `prior_hash` = the `file_hash`
// the transaction validated the file against (`null` for a created document:
// the engine never wrote there) — unless a `rename` already lands the moved
// document there (the self-linking source of a `docs_move`), which then
// renders THESE bytes (`supersede`: the rename and its prior stay, the target
// is replaced). The same rule is applied again against the database's row at
// the path when the transaction inserts (`insertPending`).
function recordWrite(pending: Map<string, PendingRow>, path: string, res: IngestResult, renderedHash: Buffer, priorHash: Buffer | null, commitId: string, ts: string): void {
  pending.set(path, supersede(pending.get(path) ?? null, { path, kind: "write", fromPath: null, docId: res.docId, head: res.revId, renderedHash, priorHash, commitId, createdAt: ts }));
}

// Every path whose file an effect reads or leaves: where a pending row of an
// earlier request would stand between the request and the disk.
function touchedPaths(effects: Effect[]): string[] {
  const out = new Set<string>();
  for (const e of effects) {
    switch (e.kind) {
      case "ingest_known":
        if (e.base) out.add(e.base.path);
        out.add(e.path);
        break;
      case "ingest_reconciled":
        out.add(e.path);
        break;
      case "move_path":
        out.add(e.from);
        out.add(e.to);
        break;
      case "tombstone":
        out.add(e.path);
        break;
      default:
        break;
    }
  }
  return [...out];
}

function fromHex(hex: string | null): Buffer | null {
  return hex === null ? null : Buffer.from(hex, "hex");
}

// Every effect's precondition against the rows `db` sees now (spec/mutate §4
// step 5, 2.2), inside the transaction. Row first — a document whose row moved
// is `stale_plan` whatever its bytes — then the disk: `file_hash` (when the
// row has one) must name the bytes phase A read.
function validate(db: Database, repoId: string, effects: Effect[], onDisk: Map<string, string>): void {
  const liveAt = db.prepare("SELECT doc_id FROM docs WHERE repo_id = ? AND path = ? AND deleted_at IS NULL");
  const pathTaken = (path: string): boolean => liveAt.get(repoId, path) !== undefined;

  const checkRow = (docId: string, expected: { path: string; currentRev: string | null; fileHash?: string | null }): DocBase => {
    const row = readDocBase(db, docId);
    if (!row) throw new MutationError("doc_missing", `doc ${docId} no longer exists`, { doc: docId });
    const moved = row.path !== expected.path || row.currentRev !== expected.currentRev || (expected.fileHash !== undefined && row.fileHash !== expected.fileHash);
    if (moved) {
      throw new MutationError("stale_plan", `document ${docId} changed since the request was planned; re-plan`, {
        doc: docId,
        expected_revision: expected.currentRev,
        current: { revision: row.currentRev, _hash: row.fileHash },
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
        // A created document (`base: null`, the `Absent` guard): no live document
        // may be at the path — the planner's check re-run through the transaction.
        if (e.base) checkDisk(e.docId, checkRow(e.docId, e.base));
        else if (pathTaken(e.path)) throw new MutationError("path_taken", `document already exists at ${e.path}`, { path: e.path });
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

// `docs_move`'s rows (spec/mutate §6; store 17.0 §5.4 step 6, D11): the
// document row's path, and — a move is a TRANSITION — a new head token with
// `updated_at = ts`, handed to the recorder as a revision of the unchanged
// tree at the new path (`revisions.path` is immutable from 17.0; through 16.x
// the current revision's path was rewritten in place). `mintsHead` is false
// for a self-linking source whose own `ingest_known` follows in the request:
// that ingest mints the head and carries the new path, so the document gets
// one revision, not two. Then the edge index: every open edge from ANOTHER doc
// into this one resolved via the old path, so it dangles now → re-point it at
// the old path's phantom (in place, mirroring adoptPhantoms). A self-doc edge
// dangles only when the link names the path (`[x](/old.md#H)`); a pure
// fragment (`#H`) resolves to the doc regardless of path and is left alone —
// the inbound scan distinguishes them from the raw. Runs BEFORE the retarget's
// ingests so each rewritten source's `maintainEdges` resolves `[x](new)` to the
// document (adopted here), not to a phantom.
function movePath(db: Database, repoId: string, e: Extract<Effect, { kind: "move_path" }>, ts: string, commit: { commitId: string; epoch: string; seq: number }, mintsHead: boolean): MoveOutcome {
  const doc = db.prepare("SELECT repo_id, file_hash, frontmatter_raw FROM docs WHERE doc_id = ?").get(e.docId) as { repo_id: string; file_hash: Buffer | null; frontmatter_raw: string | null } | undefined;
  const fileHashHex = doc?.file_hash ? doc.file_hash.toString("hex") : null;
  let head: string | null = null;
  if (mintsHead && doc?.file_hash) {
    head = mintId("r");
    claimsOf(db).claim("r", head, doc.repo_id, ts);
    db.prepare("UPDATE docs SET path = ?, head = ?, updated_at = ? WHERE doc_id = ?").run(e.to, head, ts, e.docId);
    // The feed entry (spec/store §5.4 step 5; D11): `moved`, `from_path` the
    // old path, the new head, the unchanged bytes.
    appendFeedEntry(db, { repoId, epoch: commit.epoch, seq: commit.seq, docId: e.docId, path: e.to, head, hash: doc.file_hash, kind: "moved", fromPath: e.from });
    requireHistory(db).captureRevision({
      docId: e.docId,
      head,
      path: e.to,
      commitId: commit.commitId,
      blocks: currentTreeInput(db, e.docId),
      frontmatterRaw: doc.frontmatter_raw,
      renderedHash: doc.file_hash,
    });
  } else {
    db.prepare("UPDATE docs SET path = ? WHERE doc_id = ?").run(e.to, e.docId);
  }

  const phantom = `phantom:${e.from}`;
  const affected = new Set<string>();
  const others = db.prepare("SELECT DISTINCT src_doc FROM edges WHERE dst_node = ? AND to_commit IS NULL AND src_doc != ?").all(e.docId, e.docId) as { src_doc: string }[];
  for (const r of others) affected.add(r.src_doc);
  db.prepare("UPDATE edges SET dst_node = ? WHERE dst_node = ? AND to_commit IS NULL AND src_doc != ?").run(phantom, e.docId, e.docId);
  const selfEdge = db.prepare("UPDATE edges SET dst_node = ? WHERE dst_node = ? AND to_commit IS NULL AND src_doc = ? AND src_block = ? AND anchor IS ?");
  for (const l of e.inbound) {
    if (l._doc_id !== e.docId || l._block_id === null) continue;
    selfEdge.run(phantom, e.docId, e.docId, l._block_id, l._anchor);
    affected.add(e.docId);
  }
  for (const d of affected) rebuildDocEdges(db, d);
  // Links already written against the NEW path resolve to this doc now.
  adoptPhantoms(db, e.to, e.docId);
  return { docId: e.docId, head, fileHashHex };
}

/** The document's live body tree as the recorder's input (`TreeInputBlock[]`,
 *  pre-order by `parent_block` + `ordinal`), read from the current rows — the
 *  unchanged tree a `docs_move` hands the recorder (store 17.0, D11). */
export function currentTreeInput(db: Database, docId: string): TreeInputBlock[] {
  const rows = db
    .prepare("SELECT block_id, parent_block, ordinal, type, attrs, raw, trivia FROM blocks WHERE doc_id = ? AND deleted_at IS NULL ORDER BY ordinal, block_id")
    .all(docId) as { block_id: string; parent_block: string | null; ordinal: number; type: string; attrs: string; raw: string; trivia: string | null }[];
  const ids = new Set(rows.map((r) => r.block_id));
  const byParent = new Map<string | null, typeof rows>();
  for (const r of rows) {
    const parent = r.parent_block !== null && ids.has(r.parent_block) ? r.parent_block : null;
    let list = byParent.get(parent);
    if (!list) byParent.set(parent, (list = []));
    list.push(r);
  }
  const build = (parent: string | null): TreeInputBlock[] =>
    (byParent.get(parent) ?? []).map((r) => ({
      blockId: r.block_id,
      type: r.type,
      raw: r.raw,
      trivia: r.trivia ?? "",
      attrs: JSON.parse(r.attrs) as Record<string, unknown>,
      children: build(r.block_id),
    }));
  return build(null);
}

// Tombstone the document and its live blocks (spec/store §5.6, 17.0: `deleted_at
// = ts` on the blocks and the doc, `updated_at = ts` on the doc — liveness is
// a change of the document's own; the head is KEPT and no new one is minted,
// D11); FTS rows drop with the blocks. `pool` snapshots the live blocks first,
// each carrying its `created_at` (D6). The feed entry is `deleted` (no head,
// no hash; spec/mutate §6 `docs_delete`).
function tombstone(db: Database, repoId: string, commit: { epoch: string; seq: number }, ts: string, e: Extract<Effect, { kind: "tombstone" }>): void {
  appendFeedEntry(db, { repoId, epoch: commit.epoch, seq: commit.seq, docId: e.docId, path: e.path, head: null, hash: null, kind: "deleted" });
  if (e.pool) {
    const expires = new Date(Date.parse(ts) + 30 * 24 * 3600 * 1000).toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO resurrection_pool (block_id, repo_id, doc_id, raw_hash, norm_hash, type, created_at, deleted_at, expires_ts)
       SELECT block_id, repo_id, doc_id, raw_hash, norm_hash, type, created_at, ?, ?
         FROM blocks WHERE doc_id = ? AND deleted_at IS NULL`,
    ).run(ts, expires, e.docId);
  }
  ftsDeleteDoc(db, e.docId);
  db.prepare("UPDATE blocks SET deleted_at = ? WHERE doc_id = ? AND deleted_at IS NULL").run(ts, e.docId);
  db.prepare("UPDATE docs SET deleted_at = ?, updated_at = ? WHERE doc_id = ?").run(ts, ts, e.docId);
}
