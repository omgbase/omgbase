import type { Store } from "../core/store/store.js";
import { sha256 } from "../core/hash.js";
import { ingestFile } from "../core/ingest.js";
import { makeReconcilingResolver } from "./reconciling-ingest.js";
import { hasConflictMarkers } from "./git-heuristics.js";
import { sweepResurrectionPool } from "../core/store/gc.js";

// observeFile (ADR-014): ingest whole-file bytes for one path as an OBSERVED
// commit — a write *around* the engine (an external edit the caller is
// mirroring), as opposed to docs_update's api-origin write *through* the engine.
// This is the single-file, bytes-supplied sibling of sync/checkpoint.ts
// processCheckpoint: identical echo gate + reconciling identity threading +
// conflict-marker handling + resurrection sweep, but the bytes are handed in
// (not read from disk) and it writes NO checkpoint row (a checkpoint is a
// filesystem-batch concept; observe is one commit). It never writes a file, so
// it works on a headless/sourceless server with no working tree — that is the
// whole point: it is the file→DB direction exposed over MCP for @omgbase/sync.

export interface ObserveResult {
  docId: string;
  path: string;
  /** null on an echo (bytes already matched the stored revision — no commit). */
  rev: string | null;
  commitId: string | null;
  /** convergence: sha256(bytes) === the committed revision's rendered_hash. */
  converged: boolean;
  /** true when the bytes already matched the stored revision (no new commit). */
  echo: boolean;
  /** true when the bytes carry git conflict markers (doc flagged conflicted). */
  conflicted: boolean;
  /** disposition kind → count for the commit this observation produced. */
  dispositions: { kind: string; count: number }[];
}

/**
 * Ingest `content` as the current authoritative bytes for `path`, as an observed
 * commit. Echo-suppresses when the bytes already equal the stored `file_hash`
 * (no commit). Threads block identity via the reconciling resolver against the
 * prior revision (dispositions, edges). Bytes carrying git conflict markers are
 * still ingested (opaque) but the doc is flagged `conflicted`.
 */
export function observeFile(
  store: Store,
  repoId: string,
  path: string,
  content: string,
  opts: { ts?: string } = {},
): ObserveResult {
  const ts = opts.ts ?? new Date().toISOString();
  const existing = store.db
    .prepare("SELECT doc_id, file_hash FROM docs WHERE repo_id = ? AND path = ? AND deleted_commit IS NULL")
    .get(repoId, path) as { doc_id: string; file_hash: Buffer | null } | undefined;
  const diskHash = sha256(content);

  // Echo: the stored revision already equals these bytes → no commit. This is
  // the loop-breaker the coordinator relies on (ADR-014 §6): re-observing what
  // the engine already holds is a no-op.
  if (existing && existing.file_hash && existing.file_hash.equals(diskHash)) {
    return { docId: existing.doc_id, path, rev: null, commitId: null, converged: true, echo: true, conflicted: false, dispositions: [] };
  }

  const conflicted = hasConflictMarkers(content);
  const resolveIds = makeReconcilingResolver(store, repoId, { ts, path });
  const res = ingestFile(store, repoId, path, content, { ts, origin: "observed", resolveIds });
  store.db.prepare("UPDATE docs SET conflicted = ? WHERE repo_id = ? AND path = ?").run(conflicted ? 1 : 0, repoId, path);
  sweepResurrectionPool(store, ts);

  const rows = store.db
    .prepare("SELECT kind, count(*) n FROM dispositions WHERE commit_id = ? GROUP BY kind ORDER BY kind")
    .all(res.commitId) as { kind: string; n: number }[];

  return {
    docId: res.docId,
    path,
    rev: res.revId,
    commitId: res.commitId,
    converged: res.converged,
    echo: false,
    conflicted,
    dispositions: rows.map((r) => ({ kind: r.kind, count: r.n })),
  };
}
