import type { Store } from "../core/store/store.js";
import { reconcileChanges, type CheckpointResult } from "./driver.js";
import type { SyncSource, SourceWatch } from "./plugin.js";

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

export interface WatcherOptions {
  onCheckpoint?: (result: CheckpointResult) => void;
  /** Surface a reconcile error from a background batch (the watch stays live). */
  onError?: (err: unknown) => void;
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

  private async ingest(paths: string[]): Promise<CheckpointResult | null> {
    if (paths.length === 0) return null;
    const result = await reconcileChanges(this.store, this.repoId, this.source, paths.map((path) => ({ path })));
    this.opts.onCheckpoint?.(result);
    return result;
  }

  async stop(): Promise<void> {
    await this.sub?.stop();
    this.sub = null;
  }
}
