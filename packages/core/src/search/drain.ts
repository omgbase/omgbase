import type { Store } from "../core/store/store.js";
import { EmbeddingWorker } from "./embeddings.js";
import { buildEmbedTasks } from "./tasks.js";

// Background embed drainer (05 §6). Mutations only ever *queue* embeddable
// blocks; a stale vector degrades semantic search silently until someone runs
// `omg embed drain`. This closes that gap for long-lived hosts (`omg mcp`,
// `omg watch`): on each mutation/checkpoint the host calls schedule(), and a
// debounced, single-flight background drain embeds the misses — WITHOUT blocking
// the mutation's response path. The provider round-trip is genuinely async I/O
// (an external process/endpoint), so awaiting it off the response path keeps the
// event loop responsive; we simply never await it *on* that path.

export interface DrainerOptions {
  /** Coalesce a burst of mutations into one drain (default 500ms). */
  debounceMs?: number;
  /** Fired after a drain that embedded ≥1 block (progress/log hook). */
  onDrain?: (result: { embedded: number; cached: number }) => void;
  /** A drain threw (provider down, etc.). The drainer stays alive. */
  onError?: (err: unknown) => void;
}

export class EmbedDrainer {
  private readonly debounceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private running: Promise<void> | null = null;
  private closed = false;

  constructor(
    private store: Store,
    private repoId: string,
    private worker: EmbeddingWorker,
    private opts: DrainerOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 500;
  }

  /**
   * Mark the repo dirty and (re)arm the debounce timer. Cheap and synchronous —
   * safe to call from a mutation-tool handler or a watcher checkpoint. Bursts
   * within the debounce window collapse into a single drain. Does no DB work and
   * never throws; the actual embedding happens later, off the caller's path.
   */
  schedule(): void {
    if (this.closed || !this.worker.available) return;
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.kick();
    }, this.debounceMs);
    // Don't keep the process alive solely for a pending drain (hosts own their
    // own lifetime via the transport/lease).
    this.timer.unref?.();
  }

  /** Cancel any pending debounce and drain now; resolves when the drain (and any
   *  re-run triggered by mutations arriving mid-drain) completes. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.closed || !this.worker.available) return;
    this.dirty = true;
    await this.kick();
  }

  /** Cancel the timer and await any in-flight drain; no drains start after. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.running;
  }

  // Single-flight: at most one drain runs at a time. If mutations mark the repo
  // dirty again while a drain is in flight, the loop re-runs once more after it,
  // so the last edit is never left unembedded.
  private kick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.loop().finally(() => { this.running = null; });
    return this.running;
  }

  private async loop(): Promise<void> {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      try {
        const tasks = buildEmbedTasks(this.store, this.repoId);
        const result = await this.worker.process(tasks);
        if (result.embedded > 0) this.opts.onDrain?.(result);
      } catch (err) {
        this.opts.onError?.(err);
        // Swallow — a transient provider failure must not crash the host. The
        // next schedule() (or flush at shutdown) retries.
        return;
      }
    }
  }
}
