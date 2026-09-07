// Sync source contract (13-sync-plugins). A SyncSource abstracts an external
// source scope (filesystem, git, GitHub, Linear, …) behind enumerate/fetch/watch
// keyed on a cheap `revision` change-token. The engine owns everything below the
// bytes — content-hash echo suppression, reconciliation, commits, convergence —
// so a source only reports changes and transports bytes; it can never write a
// commit, mint identity, or bypass the convergence check.

/** How a source's identity relates to omgbase block/doc identity (13 §4). */
export type SourceIdentity =
  /** Anonymous bytes; block continuity must be inferred by the reconciler. */
  | "inferred"
  /** Stable per-member ids from upstream; the matcher is skipped (v1: unused). */
  | "borne";

export interface SourceCapabilities {
  identity: SourceIdentity;
  /** Can engine-authored mutations be pushed back to the source? */
  writeThrough: boolean;
  /** Resource kinds a multi-resource source exposes (future; fs omits). */
  resources?: string[];
}

/** A member of the source scope: its storage key + cheap change-token (13 §3). */
export interface SourceEntry {
  /** Storage key — repo-relative canonical path (documents.path). */
  path: string;
  /** The source's cheap change-token; equal ⇒ unchanged ⇒ engine no-op. */
  revision: string;
  /** Source locator when it differs from `path`. Defaults to `path` (13 §6). */
  sourceId?: string;
}

/** A hydrated member: its entry plus the bytes handed to ingestFile. */
export interface SourceItem extends SourceEntry {
  /** The engine hashes this itself for the authoritative echo/convergence gate. */
  content: string;
}

/** A live subscription created by SyncSource.watch. */
export interface SourceWatch {
  /** Stop delivering batches and release resources. */
  stop(): Promise<void> | void;
  /** Force any pending (debounced) batch to flush now. Returns paths flushed. */
  flush(): string[];
}

export interface WatchOptions {
  /** Coalesce a burst of events into one batch at this silence (ms). */
  debounceMs?: number;
  /** Deliver a batch of changed storage-keys (paths) at quiescence. */
  onBatch: (paths: string[]) => void;
}

/**
 * A pluggable source scope the engine reconciles a repo against. Only
 * `capabilities`, `enumerate`, and `fetch` are required; a poll-only source
 * omits `watch` (the caller polls enumerate) and a read-only source omits
 * `write`/`remove` (writeThrough:false).
 */
export interface SyncSource {
  capabilities(): SourceCapabilities;

  /** The full current scope as (path, revision) pairs. */
  enumerate(): Iterable<SourceEntry>;

  /** Current state of one member, or null if it left the scope (a delete). */
  fetch(path: string): SourceItem | null;

  /** Subscribe to change batches (push sources). Returns a stopper/flusher. */
  watch?(opts: WatchOptions): SourceWatch;

  /** Persist engine-authored bytes back to the source (writeThrough only). */
  write?(path: string, content: string): void;

  /** Remove a member from the source (writeThrough only). */
  remove?(path: string): void;
}
