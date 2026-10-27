import type { GitCadence } from "./config.js";

// The debounce timer and the mutation hook (spec/store §5.12 "Cadence", 17.6 —
// modular-core Phase 6b). The MCP host's `onMutation` hook fires after every
// successful write tool; the host hands it to a scheduler built here: under
// cadence `every` the checkpoint runs SYNCHRONOUSLY inside the hook (one
// commit per write — the git history is complete without `omg sync`); under
// `{ debounce_ms }` the hook (re)arms one timer so the checkpoint runs
// `debounce_ms` after the LAST mutation, coalescing a burst into one commit.
// `flush()` runs a pending debounced checkpoint now (the host's shutdown);
// `close()` cancels it. The timer functions are a seam so a test can drive it
// with fake clocks; errors go to `onError` and never reach the hook's caller.

export interface SchedulerOptions {
  cadence: GitCadence;
  /** run the worker once (the host wraps it in the writer lock when the hook fires outside one) */
  run: () => void;
  onError?: (err: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface CheckpointScheduler {
  /** the mutation hook */
  notify(): void;
  /** run a pending debounced checkpoint now */
  flush(): void;
  /** cancel a pending timer */
  close(): void;
  /** is a debounced run pending? */
  pending(): boolean;
}

export function createCheckpointScheduler(opts: SchedulerOptions): CheckpointScheduler {
  const set = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = opts.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  let handle: unknown = null;
  const run = (): void => {
    try {
      opts.run();
    } catch (e) {
      opts.onError?.(e);
    }
  };
  const cancel = (): void => {
    if (handle !== null) clear(handle);
    handle = null;
  };
  return {
    notify() {
      if (opts.cadence === "every") { run(); return; }
      cancel();
      handle = set(() => { handle = null; run(); }, opts.cadence.debounce_ms);
    },
    flush() {
      if (handle === null) return;
      cancel();
      run();
    },
    close: cancel,
    pending: () => handle !== null,
  };
}
