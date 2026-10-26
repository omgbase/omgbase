import {
  type Store,
  type ObserveResult,
  type ObserveDeleteResult,
  type CommitDigest,
  observeMany,
  observeDelete,
  changesSince,
  ExpiredCursor,
  docsRead,
  storagePath,
  referencePath,
} from "@omgbase/core";

// EngineClient (ADR-014 §7): the coordinator's view of "the omgbase side" of a
// sync. Everything the reconcile loop needs from the engine, and nothing else,
// behind one interface so the SAME coordinator runs against a local in-process
// Store (InProcessEngineClient — local `omg sync`/`watch` + tests) or a remote
// server over MCP (McpEngineClient — see mcp-engine-client.ts). Reconciliation
// and identity threading stay engine-owned (ADR-003); the client only moves
// whole-file bytes across and reads the change feed.

export interface ChangesPage {
  digests: CommitDigest[];
  cursor: number;
  truncated: boolean;
  /** the feed's epoch (spec/store 17.0, D7): a cursor is the pair `(epoch, seq)` — a consumer stores and sends both */
  epoch?: string;
  /** the oldest `seq` the feed still holds (0 when empty); a gap between a consumer's cursor and `oldest − 1` is a rescan */
  oldest?: number;
  /** the repo's current max seq — `cursor == head` means nothing new */
  head?: number;
}

/** A live document as the rescan lists it (spec/sync §6, 4.0): `query docs { select _id, _path, _hash }`. */
export interface DocListing {
  _id: string;
  /** reference form (`/a.md`) */
  _path: string;
  _hash: string | null;
}

/**
 * `expired_cursor` (spec/surface §3, 6.0; spec/sync §6, 4.0): the feed no
 * longer serves the consumer's `(epoch, cursor)` — the repository's current
 * position is `{ epoch, oldest, head }` and the consumer runs the rescan
 * procedure, then resumes from `head` under `epoch`. Raised by both engine
 * clients alike (the in-process one from the core's `ExpiredCursor`, the MCP
 * one from the error envelope), so the coordinator sees one shape.
 */
export class FeedExpired extends Error {
  constructor(
    public readonly epoch: string,
    public readonly oldest: number,
    public readonly head: number,
    message?: string,
  ) {
    super(message ?? `expired_cursor — the feed now begins at (${epoch}, ${oldest}); rescan and resume from head ${head}`);
    this.name = "FeedExpired";
  }
}

export interface ChangesSinceOpts {
  /** the cursor's epoch (default: the repository's current one) */
  epoch?: string;
  origin?: "api" | "observed" | "import";
  limit?: number;
}

export interface DocBytes {
  content: string;
  /** hex of the doc's current rendered/file hash (matches a changes_since revision's `_hash`). */
  contentHash: string;
}

export interface EngineClient {
  /** Push whole-file bytes in as observed commits (echo-suppressed engine-side). */
  observeMany(files: { path: string; content: string }[]): Promise<ObserveResult[]>;
  /** Mirror a source-side deletion: tombstone the doc (observed). */
  observeDelete(path: string): Promise<ObserveDeleteResult>;
  /** The repo-wide change feed after a cursor (for the export direction); throws `FeedExpired` when the feed no longer serves the cursor. */
  changesSince(cursor?: number, opts?: ChangesSinceOpts): Promise<ChangesPage>;
  /** Every live document of the repo as `{ _id, _path, _hash }` (the rescan's step 2, spec/sync §6). */
  listDocs(): Promise<DocListing[]>;
  /** Current whole-file bytes + content hash for a path, or null if absent. */
  readDoc(path: string): Promise<DocBytes | null>;
  close(): Promise<void>;
}

/** In-process EngineClient: calls @omgbase/core directly against an open Store.
 *  Used by the local watcher/sync (no self-MCP-loop) and by tests. */
export class InProcessEngineClient implements EngineClient {
  constructor(
    private readonly store: Store,
    private readonly repoId: string,
  ) {}

  observeMany(files: { path: string; content: string }[]): Promise<ObserveResult[]> {
    return Promise.resolve(observeMany(this.store, this.repoId, files));
  }

  observeDelete(path: string): Promise<ObserveDeleteResult> {
    return Promise.resolve(observeDelete(this.store, this.repoId, path));
  }

  changesSince(cursor?: number, opts?: ChangesSinceOpts): Promise<ChangesPage> {
    try {
      return Promise.resolve(
        changesSince(this.store, this.repoId, {
          ...(cursor !== undefined ? { cursor } : {}),
          ...(opts?.epoch !== undefined ? { epoch: opts.epoch } : {}),
          ...(opts?.origin ? { origin: opts.origin } : {}),
          ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
        }),
      );
    } catch (e) {
      if (e instanceof ExpiredCursor) return Promise.reject(new FeedExpired(e.epoch, e.oldest, e.head, e.message));
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  listDocs(): Promise<DocListing[]> {
    const rows = this.store.db
      .prepare("SELECT doc_id, path, file_hash FROM docs WHERE repo_id = ? AND deleted_at IS NULL ORDER BY path")
      .all(this.repoId) as { doc_id: string; path: string; file_hash: Buffer | null }[];
    return Promise.resolve(rows.map((r) => ({ _id: r.doc_id, _path: referencePath(r.path), _hash: r.file_hash ? r.file_hash.toString("hex") : null })));
  }

  readDoc(path: string): Promise<DocBytes | null> {
    const row = this.store.db
      .prepare("SELECT doc_id, file_hash FROM docs WHERE repo_id = ? AND path = ? AND deleted_at IS NULL")
      .get(this.repoId, storagePath(path)) as { doc_id: string; file_hash: Buffer | null } | undefined;
    if (!row) return Promise.resolve(null);
    const res = docsRead(this.store, row.doc_id);
    if (!res) return Promise.resolve(null);
    return Promise.resolve({ content: res._raw, contentHash: row.file_hash?.toString("hex") ?? "" });
  }

  close(): Promise<void> {
    // The store's lifetime is owned by the caller (it may serve other work).
    return Promise.resolve();
  }
}
