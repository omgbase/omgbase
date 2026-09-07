import type { Store } from "../core/store/store.js";
import { reconcileChanges, type CheckpointResult } from "./driver.js";
import { FilesystemSource } from "./filesystem-source.js";
import type { SyncSource, SourceWatch } from "./plugin.js";

// Sync watcher (01 §6, 07 task 1.5). Subscribes to a SyncSource's change feed
// and reconciles each debounced batch into a checkpoint. As of 13-sync-plugins
// the debounce/transport lives in the source's watch(); this class binds it to
// the reconciliation driver. Defaults to a FilesystemSource so the existing
// (store, repoId, rootPath) constructor keeps working; pass a `source` option to
// watch any other source.

export interface WatcherOptions {
  quiescenceMs?: number;
  onCheckpoint?: (result: CheckpointResult) => void;
  /** Override the source (default: FilesystemSource over rootPath). */
  source?: SyncSource;
}

export class Watcher {
  private sub: SourceWatch | null = null;
  private readonly quiescenceMs: number;
  private readonly source: SyncSource;

  constructor(
    private store: Store,
    private repoId: string,
    private rootPath: string,
    private opts: WatcherOptions = {},
  ) {
    this.quiescenceMs = opts.quiescenceMs ?? 750;
    this.source = opts.source ?? new FilesystemSource(rootPath);
  }

  start(): void {
    if (!this.source.watch) throw new Error("source does not support watch()");
    this.sub = this.source.watch({
      debounceMs: this.quiescenceMs,
      onBatch: (paths) => this.ingest(paths),
    });
  }

  private ingest(paths: string[]): CheckpointResult | null {
    if (paths.length === 0) return null;
    const result = reconcileChanges(this.store, this.repoId, this.source, paths.map((path) => ({ path })));
    this.opts.onCheckpoint?.(result);
    return result;
  }

  /** Force a checkpoint now (sync_flush). Returns null if nothing pending. */
  flush(): CheckpointResult | null {
    const paths = this.sub?.flush() ?? [];
    return this.ingest(paths);
  }

  async stop(): Promise<void> {
    await this.sub?.stop();
    this.sub = null;
  }
}
