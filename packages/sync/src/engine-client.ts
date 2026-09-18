import {
  type Store,
  type ObserveResult,
  type ObserveDeleteResult,
  type CommitDigest,
  observeMany,
  observeDelete,
  changesSince,
  docsRead,
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
}

export interface DocBytes {
  content: string;
  /** hex of the doc's current rendered/file hash (matches changes_since contentHash). */
  contentHash: string;
}

export interface EngineClient {
  /** Push whole-file bytes in as observed commits (echo-suppressed engine-side). */
  observeMany(files: { path: string; content: string }[]): Promise<ObserveResult[]>;
  /** Mirror a source-side deletion: tombstone the doc (observed). */
  observeDelete(path: string): Promise<ObserveDeleteResult>;
  /** The repo-wide commit feed after a cursor (for the export direction). */
  changesSince(cursor?: number, opts?: { origin?: "api" | "observed" | "import"; limit?: number }): Promise<ChangesPage>;
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

  changesSince(cursor?: number, opts?: { origin?: "api" | "observed" | "import"; limit?: number }): Promise<ChangesPage> {
    return Promise.resolve(
      changesSince(this.store, this.repoId, {
        ...(cursor !== undefined ? { cursor } : {}),
        ...(opts?.origin ? { origin: opts.origin } : {}),
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
      }),
    );
  }

  readDoc(path: string): Promise<DocBytes | null> {
    const row = this.store.db
      .prepare("SELECT doc_id, file_hash FROM docs WHERE repo_id = ? AND path = ? AND deleted_commit IS NULL")
      .get(this.repoId, path) as { doc_id: string; file_hash: Buffer | null } | undefined;
    if (!row) return Promise.resolve(null);
    const res = docsRead(this.store, row.doc_id);
    if (!res) return Promise.resolve(null);
    return Promise.resolve({ content: res.content, contentHash: row.file_hash?.toString("hex") ?? "" });
  }

  close(): Promise<void> {
    // The store's lifetime is owned by the caller (it may serve other work).
    return Promise.resolve();
  }
}
