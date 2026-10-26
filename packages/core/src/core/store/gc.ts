import type { Store } from "./store.js";
import { captureFor } from "./manifest.js";
import { pruneFeed } from "./feed.js";

// Garbage collection (spec/store §7) — the core's half: the feed prune (§7.4),
// the claims prune (§7.3) and the resurrection-pool expiry sweep, plus the
// recorder's own collection reached through the seam (`HistoryRecorder.
// collect`, implemented by `history-gc.ts`: the mark-and-sweep from the live
// revision roots and the 14.2 `same`-row sweep). Nothing here names a history
// table (modular-core Phase 4a). `omg gc` itself still ships behind a flag;
// the pool sweep is the one collection that runs routinely.

export interface GcResult {
  blobsSwept: number;
  treeNodesSwept: number;
  /** spec/store §7 (14.2): `same` rows a 14.1 store wrote into `dispositions`/`block_changes` — history nothing reads. */
  sameDispositionsSwept: number;
  /** spec/store §7.3 (17.0): the core holds released from `id_claims` under `identity.claims_retain_days` (0 while the setting is null). */
  claimsReleased: number;
  /** spec/store §7.4 (17.0): the feed rows pruned under `feed.retain_days` / `feed.retain_entries` (and the cap). */
  feedPruned: number;
}

/**
 * Mark-and-sweep GC (flag-gated; enabled must be true to run — v1.0 ships it
 * off). The recorder's half (`HistoryRecorder.collect`, when the store carries
 * the module and the bundle's tables exist — a store whose every repository
 * runs with history disabled has nothing to collect there) removes blobs/
 * tree_nodes unreachable from any live revision root and a 14.1 store's `same`
 * rows (spec/store §7, 14.2 — a sweep, not a migration: a data-only change
 * needs no `user_version`, and opening a database must never bulk-delete).
 * `dryRun` counts everything and deletes nothing.
 *
 * spec/store §7.3 (17.0): the same run prunes `id_claims` under the
 * installation's `identity.claims_retain_days` (`IdentityClaims.prune` at
 * `now`, the clock), and (§7.4) the feed under `feed.retain_days` /
 * `feed.retain_entries` — the two collections the core owns. The feed is
 * pruned BEFORE the claims so a commit id whose last feed row went this run
 * can be released by the same run once the window has passed.
 */
export function runGc(store: Store, opts: { enabled?: boolean; dryRun?: boolean; now?: string } = {}): GcResult {
  if (!opts.enabled) return { blobsSwept: 0, treeNodesSwept: 0, sameDispositionsSwept: 0, claimsReleased: 0, feedPruned: 0 };
  return store.write((db): GcResult => {
    const dry = Boolean(opts.dryRun);
    const history = captureFor(db, null);
    const collected = history ? history.collect(dry) : { blobsSwept: 0, treeNodesSwept: 0, sameDispositionsSwept: 0 };

    const now = opts.now ?? new Date().toISOString();
    // spec/store §7.4 (17.0): the feed prune under the floors; a dry run prunes
    // nothing and counts nothing.
    const feedPruned = dry ? 0 : pruneFeed(store, now);

    // spec/store §7.3 (17.0): the claims prune — the core's hold released on
    // every claim older than `identity.claims_retain_days` that names no core
    // row; nothing while the setting is null. A dry run releases nothing and
    // counts nothing (the count is the release's own `changes`).
    const claimsReleased = dry ? 0 : store.capabilities.claims.prune(now);

    return { ...collected, claimsReleased, feedPruned };
  });
}

/** Resurrection-pool expiry sweep (02 §7): drop rows past their expires_ts.
 * Runs routinely (lazy, once per observed batch). */
export function sweepResurrectionPool(store: Store, nowIso: string): number {
  const res = store.db.prepare("DELETE FROM resurrection_pool WHERE expires_ts <= ?").run(nowIso);
  return res.changes;
}
