// A minimal `effect` over the TC39 signals polyfill (re-exported by
// @lit-labs/signals), which ships Watcher but no effect helper. Runs `fn` now
// and again (on a microtask) whenever a signal it read changes. Returns dispose.

import { Signal } from "@lit-labs/signals";

export function effect(fn: () => void | (() => void)): () => void {
  let cleanup: void | (() => void);
  let scheduled = false;
  const computed = new Signal.Computed(() => {
    cleanup?.();
    cleanup = fn();
  });
  const watcher = new Signal.subtle.Watcher(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      for (const c of watcher.getPending()) c.get();
      watcher.watch();
    });
  });
  watcher.watch(computed);
  computed.get();
  return () => {
    watcher.unwatch(computed);
    cleanup?.();
  };
}
