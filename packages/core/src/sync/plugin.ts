// Sync source contract (sync-plugins). A SyncSource abstracts an external
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
  /** Storage key — repo-relative canonical path (docs.path). */
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

/**
 * An unsolicited event of a live watch (spec/sync §5): `ready` once — the feed
 * is primed and every change from now on will be reported — then `batch` lines
 * of changed storage keys. An adapter built before sync 1.2 never sends `ready`.
 */
export type WatchEvent = { event: "ready" } | { event: "batch"; paths: string[] };

/** Receives every event of a live watch, in wire order. */
export type WatchListener = (event: WatchEvent) => void;

/** A live subscription created by SyncSource.watch. */
export interface SourceWatch {
  /**
   * Resolves when the source reported `ready` (spec/sync §5). An in-process
   * source resolves it at once; an adapter that never reports leaves it pending,
   * so a host bounds the wait (`awaitReady`).
   */
  ready: Promise<void>;
  /** Stop delivering events and release resources. */
  stop(): Promise<void>;
}

/** How long a host waits for `ready` before proceeding as if ready (spec/sync §5: unpinned; 30 s). */
export const WATCH_READY_PATIENCE_MS = 30_000;

/**
 * Wait for a watch's `ready` with bounded patience: `true` when it resolved in
 * time, `false` on timeout (the host proceeds as if ready, with a warning — an
 * adapter without `ready` still works, with the old window).
 */
export function awaitReady(ready: Promise<void>, patienceMs: number = WATCH_READY_PATIENCE_MS): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), patienceMs);
    ready.then(
      () => { clearTimeout(timer); resolve(true); },
      () => { clearTimeout(timer); resolve(false); },
    );
  });
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

  /** Subscribe to the change feed (push sources): `ready` once, then debounced `batch` events. */
  watch?(listener: WatchListener): Promise<SourceWatch>;

  /** Persist engine-authored bytes back to the source (writeThrough only). */
  write?(path: string, content: string): Promise<void>;

  /** Remove a member from the source (writeThrough only). */
  remove?(path: string): Promise<void>;

  /** Terminate the underlying process / release resources. */
  close(): Promise<void>;
}
