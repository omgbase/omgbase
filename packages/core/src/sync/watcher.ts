import type { Store } from "../core/store/store.js";
import { reconcileChanges, type BatchResult } from "./driver.js";
import type { SyncSource, SourceWatch } from "./plugin.js";
import { withWriterLockAsync } from "./writer-lock.js";

// Sync watcher (01 §6, 07 task 1.5). Subscribes to a SyncSource's change feed
// (13 §4.3) and reconciles each debounced batch into a checkpoint. Debounce/
// batching lives adapter-side (in the external process); this class just wires
// the batch callback to the reconciliation driver. A source must advertise
// `watch` capability. Async throughout (13 §9): batches trigger a fire-and-report
// reconcile; onCheckpoint fires when a batch produced changes.
//
// Readiness (spec/sync §5, 1.2): `start()` resolves once the source acknowledged
// the subscription; `ready()` is the source's `ready` promise, which a host awaits
// (bounded — `awaitReady`) BEFORE its priming freshness sweep, so an edit landing
// before the feed is primed is caught by the sweep and one after it by the feed.
//
// Locking (spec/sync §7): a checkpoint is a write, so with `omgbaseDir` each
// batch's reconcile — fetch through the adapter, echo gate, commit — runs
// under the workspace writer lock, as the Rust watcher's does; a verb or MCP
// call in another process waits for it rather than racing its file-CAS.

export interface WatcherOptions {
  onCheckpoint?: (result: BatchResult) => void;
  /** Surface a reconcile error from a background batch (the watch stays live). */
  onError?: (err: unknown) => void;
  /** The workspace `.omgbase/` dir: when set, every checkpoint runs under the writer lock. */
  omgbaseDir?: string;
}

export class Watcher {
  private sub: SourceWatch | null = null;

  constructor(
    private store: Store,
    private repoId: string,
    private source: SyncSource,
    private opts: WatcherOptions = {},
  ) {}

  async start(): Promise<void> {
    if (!this.source.watch) throw new Error("source does not support watch()");
    this.sub = await this.source.watch((ev) => {
      if (ev.event !== "batch") return; // `ready` is surfaced through ready()
      // A batch arrives from the adapter's stream; reconcile it off the callback.
      void this.ingest(ev.paths).catch((err) => this.opts.onError?.(err));
    });
  }

  /** The live subscription's `ready` (spec/sync §5); throws before `start()`. */
  ready(): Promise<void> {
    if (!this.sub) throw new Error("watcher not started");
    return this.sub.ready;
  }

  private async ingest(paths: string[]): Promise<BatchResult | null> {
    if (paths.length === 0) return null;
    const reconcile = (): Promise<BatchResult> => reconcileChanges(this.store, this.repoId, this.source, paths.map((path) => ({ path })));
    const dir = this.opts.omgbaseDir;
    const result = dir !== undefined ? await withWriterLockAsync(dir, reconcile) : await reconcile();
    this.opts.onCheckpoint?.(result);
    return result;
  }

  async stop(): Promise<void> {
    await this.sub?.stop();
    this.sub = null;
  }
}
