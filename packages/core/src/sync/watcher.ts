import chokidar, { type FSWatcher } from "chokidar";
import { relative, sep } from "node:path";
import type { Store } from "../core/store/store.js";
import { processCheckpoint, type CheckpointResult } from "./checkpoint.js";

// Filesystem watcher (01 §6, 07 task 1.5). Batches save events into checkpoints
// at quiescence (default 750ms silence; config sync.quiescence_ms). The
// debounce/batch logic is what makes git checkouts arrive as one cheap
// checkpoint. Reconciliation is not wired yet (Stage 1 re-mints).

export interface WatcherOptions {
  quiescenceMs?: number;
  onCheckpoint?: (result: CheckpointResult) => void;
}

export class Watcher {
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly quiescenceMs: number;

  constructor(
    private store: Store,
    private repoId: string,
    private rootPath: string,
    private opts: WatcherOptions = {},
  ) {
    this.quiescenceMs = opts.quiescenceMs ?? 750;
  }

  start(): void {
    this.watcher = chokidar.watch(this.rootPath, {
      ignored: (p: string) => /(^|[/\\])(\.omgbase|\.git|node_modules)([/\\]|$)/.test(p),
      ignoreInitial: true,
      persistent: true,
    });
    const onEvent = (abs: string): void => {
      if (!abs.endsWith(".md")) return;
      this.pending.add(relative(this.rootPath, abs).split(sep).join("/"));
      this.schedule();
    };
    this.watcher.on("add", onEvent).on("change", onEvent).on("unlink", onEvent);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.quiescenceMs);
  }

  /** Force a checkpoint now (sync_flush). Returns null if nothing pending. */
  flush(): CheckpointResult | null {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.pending.size === 0) return null;
    const changes = [...this.pending].map((path) => ({ path }));
    this.pending.clear();
    const result = processCheckpoint(this.store, this.repoId, this.rootPath, changes);
    this.opts.onCheckpoint?.(result);
    return result;
  }

  async stop(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.watcher?.close();
    this.watcher = null;
  }
}
