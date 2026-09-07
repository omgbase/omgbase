import type { Store } from "../core/store/store.js";
import { FilesystemSource } from "./filesystem-source.js";
import { reconcileChanges, type FileChange, type CheckpointResult } from "./driver.js";

// Filesystem checkpoint (01 §6, 03 §8). A checkpoint is one debounced batch of
// filesystem changes. As of 13-sync-plugins the reconciliation loop is
// source-agnostic (driver.ts); this is the thin filesystem-bound entry point,
// preserved for the CLI and watcher — it wraps the root in a FilesystemSource
// and delegates. Engine echo-suppression, reconcile, commit, and convergence all
// live in the driver.

export type { FileChange, CheckpointResult };

/**
 * Process a batch of changed paths against a filesystem repo as one checkpoint.
 * Bytes are fetched through a FilesystemSource; the driver hashes them and
 * suppresses echoes (on-disk hash == stored file_hash) with no commit.
 */
export function processCheckpoint(
  store: Store,
  repoId: string,
  rootPath: string,
  changes: FileChange[],
  opts: { ts?: string; gitHead?: string | null } = {},
): CheckpointResult {
  return reconcileChanges(store, repoId, new FilesystemSource(rootPath), changes, opts);
}
