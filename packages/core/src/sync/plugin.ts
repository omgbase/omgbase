// Sync source contract (13-sync-plugins). A SyncSource abstracts an external
// source scope (filesystem, git, GitHub, Linear, …) behind enumerate/fetch/watch
// keyed on a cheap `revision` change-token. Sources are EXTERNAL PROCESSES spoken
// to over stdio (see external-source.ts); this interface is the in-engine view of
// one. Because every call crosses a pipe, the contract is async.
//
// The engine owns everything below the bytes — content-hash echo suppression,
// reconciliation, commits, convergence, and durable revision/cursor state — so a
// source only reports membership and transports bytes; it can never write a
// commit, mint identity, or bypass the convergence check.

/** How a source's identity relates to omgbase block/doc identity (13 §5.2). */
export type SourceIdentity =
  /** Anonymous bytes; block continuity must be inferred by the reconciler. */
  | "inferred"
  /** Stable per-member ids from upstream; the matcher is skipped (v1: unused). */
  | "borne";

export interface SourceCapabilities {
  identity: SourceIdentity;
  /** Can engine-authored mutations be pushed back to the source? */
  writeThrough: boolean;
  /** Can the source stream a change feed, or is it poll-only (engine re-enumerates)? */
  watch: boolean;
}

/** A member of the source scope: its storage key + cheap change-token (13 §4.2). */
export interface SourceEntry {
  /** Storage key — repo-relative canonical path (documents.path). */
  path: string;
  /** The source's cheap change-token; equal ⇒ unchanged ⇒ engine no-op. */
  revision: string;
  /** Source locator when it differs from `path`. Defaults to `path` (13 §5.2). */
  sourceId?: string;
}

/** A hydrated member: its entry plus the bytes handed to ingestFile. */
export interface SourceItem extends SourceEntry {
  /** The engine hashes this itself for the authoritative echo/convergence gate. */
  content: string;
}

/** A batch of changed storage-keys delivered by a live watch (13 §4.3). */
export type WatchListener = (paths: string[]) => void;

/** A live subscription created by SyncSource.watch. */
export interface SourceWatch {
  /** Stop delivering batches and release resources. */
  stop(): Promise<void>;
}

/**
 * The in-engine handle to an external source process. Only capabilities/
 * enumerate/fetch are always meaningful; watch exists when capabilities().watch,
 * write/remove when capabilities().writeThrough. close() terminates the process.
 */
export interface SyncSource {
  capabilities(): SourceCapabilities;

  /** The full current scope as (path, revision) pairs. */
  enumerate(): Promise<SourceEntry[]>;

  /** Current state of one member, or null if it left the scope (a delete). */
  fetch(path: string): Promise<SourceItem | null>;

  /** Subscribe to debounced change batches (push sources). */
  watch?(onBatch: WatchListener): Promise<SourceWatch>;

  /** Persist engine-authored bytes back to the source (writeThrough only). */
  write?(path: string, content: string): Promise<void>;

  /** Remove a member from the source (writeThrough only). */
  remove?(path: string): Promise<void>;

  /** Terminate the underlying process / release resources. */
  close(): Promise<void>;
}
