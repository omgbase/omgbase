import type { Statement } from "better-sqlite3";
import type { IdPrefix } from "../ids.js";
import type { Store } from "../store/store.js";
import type { IdentityClaims } from "./types.js";
import { effectiveSettings, parseSettingsJson } from "../store/settings.js";

// Identity claims (spec/store §2.1 "Uniqueness at mint", 17.0 — modular-core
// M3/D5). `id_claims(id, repo_id, prefix, minted_at, holders)` holds one row
// per id the core has minted, written in the transaction that writes the row
// the id lands in (§5.4: `d` with the doc row, `r` with the head, `b` with the
// block rows, `x`/`e` with the graph rows, `rp`/`src` with the registry rows)
// — AFTER the minter yielded, so the fixture minter's ids never move. The
// probe is one statement over the table; a claim outlives every row that
// carried the id, which is what replaced the `blocks ∪ block_changes ∪
// resurrection_pool` union and the squash's earliest-`block_changes`-row rule.
//
// `holders` is a bitmask: bit 0 the CORE (set at mint, released by the claims
// prune, §7.3), bit 1 the RECORDER (set when the capture first names the id —
// a `revisions`/`block_changes` row; `history purge` releases it, 3e). A row
// leaves only when no holder remains, so with history on a pruned id can
// never be re-minted; with history off it can, once nothing names it and the
// installation's `identity.claims_retain_days` has passed — the documented
// consequence (D5): a reused id can only misdirect an unguarded read by name.

/** bit 0: the core's hold on a claim. */
export const HOLDER_CORE = 1;
/** bit 1: the recorder's hold on a claim. */
export const HOLDER_RECORDER = 2;

/** The prefixes the core mints and claims in `id_claims` (spec/store §2.1): `c` and `ep` since 3d (the feed row and the repository epoch are the core's). */
export const CLAIMED_PREFIXES: readonly IdPrefix[] = ["d", "b", "c", "r", "x", "e", "rp", "src", "ep"];

/**
 * The prefixes whose claim is still the row the id lands in (spec/store §2.1,
 * 17.0): `s` is minted by the recorder's export — its `archives` row is the
 * recorder's own claim evidence. `cp` is retired (D4: `checkpoints` is gone,
 * nothing mints it); `col` and `v` have no table and no check.
 */
export const ID_TABLES: Partial<Record<IdPrefix, readonly (readonly [table: string, column: string])[]>> = {
  s: [["archives", "segment_id"]],
};

/** The settings key of the claims prune (spec/store §7.3): `identity.claims_retain_days`, default null = never. */
export const CLAIMS_RETAIN_SETTINGS_KEY = "identity";
export const CLAIMS_RETAIN_DAYS_KEY = "claims_retain_days";

const DAY_MS = 86_400_000;

/**
 * `identity.claims_retain_days` out of a settings blob: `null` when unset
 * (never prune); a non-negative integer otherwise. Anything else is a
 * malformed policy and refused — a prune that silently did nothing would be
 * worse than one that complains.
 */
export function claimsRetainDays(settings: Record<string, unknown>): number | null {
  const identity = settings[CLAIMS_RETAIN_SETTINGS_KEY];
  const v = identity !== null && typeof identity === "object" && !Array.isArray(identity) ? (identity as Record<string, unknown>)[CLAIMS_RETAIN_DAYS_KEY] : undefined;
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new Error(`identity.claims_retain_days must be a non-negative integer or null (got ${JSON.stringify(v)})`);
  }
  return v;
}

// The core rows an id may still name (spec/store §7.3): a claim is prunable
// only when none of them does. `docs` keeps a tombstone forever, so a `d` is
// never released; a `b` once its row, its pool entry and its tombstone are
// gone; an `r` once it is no head and no pending row renders it; `x`/`e` once
// the node or edge row is gone; `rp`/`src` while the registry rows exist.
const NAMES_NO_CORE_ROW_SQL = `
  NOT EXISTS (SELECT 1 FROM docs WHERE doc_id = id_claims.id OR head = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM blocks WHERE block_id = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM resurrection_pool WHERE block_id = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM pending_materializations WHERE head = id_claims.id OR commit_id = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM feed WHERE commit_id = id_claims.id OR batch_id = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM feed_entries WHERE head = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM external_nodes WHERE node_id = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM edges WHERE edge_id = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM repos WHERE repo_id = id_claims.id OR epoch = id_claims.id)
  AND NOT EXISTS (SELECT 1 FROM sources WHERE source_id = id_claims.id)`;

/**
 * The `IdentityClaims` over `id_claims` (spec/store §2.1, 17.0): `claim`
 * inserts the core's row (idempotent — a second claim of the same id adds
 * nothing but the core bit), `hold` sets the recorder's bit, `isClaimed` is
 * one probe for every core-minted prefix and the legacy table probe for the
 * recorder's own (`c`, `s`) and `cp`, `prune` is §7.3's release under
 * `identity.claims_retain_days`.
 */
export class IdClaims implements IdentityClaims {
  private readonly stmts = new Map<IdPrefix, Statement[]>();
  private claimStmt: Statement | null = null;
  private holdStmt: Statement | null = null;
  private probeStmt: Statement | null = null;

  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.db;
  }

  claim(prefix: IdPrefix, id: string, repoId: string | null, mintedAt: string): void {
    this.claimStmt ??= this.db.prepare(
      `INSERT INTO id_claims (id, repo_id, prefix, minted_at, holders) VALUES (?, ?, ?, ?, ${HOLDER_CORE})
       ON CONFLICT(id) DO UPDATE SET holders = holders | ${HOLDER_CORE}`,
    );
    this.claimStmt.run(id, repoId, prefix, mintedAt);
  }

  hold(ids: Iterable<string>): void {
    this.holdStmt ??= this.db.prepare(`UPDATE id_claims SET holders = holders | ${HOLDER_RECORDER} WHERE id = ? AND (holders & ${HOLDER_RECORDER}) = 0`);
    for (const id of ids) this.holdStmt.run(id);
  }

  isClaimed(prefix: IdPrefix, id: string): boolean {
    if (!this.db.open) return false;
    if (CLAIMED_PREFIXES.includes(prefix)) {
      this.probeStmt ??= this.db.prepare("SELECT 1 FROM id_claims WHERE id = ? LIMIT 1");
      return this.probeStmt.get(id) !== undefined;
    }
    let stmts = this.stmts.get(prefix);
    if (!stmts) {
      stmts = (ID_TABLES[prefix] ?? []).map(([table, column]) => this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`));
      this.stmts.set(prefix, stmts);
    }
    for (const stmt of stmts) if (stmt.get(id) !== undefined) return true;
    return false;
  }

  /**
   * The claims prune (spec/store §7.3): for every repository whose effective
   * `identity.claims_retain_days` is set, release the core's hold on each of
   * its claims minted before `now − days` that names no core row; then delete
   * every claim with no holder left. A workspace-scoped claim (`repo_id`
   * NULL — a `src`) is judged by the workspace layer alone. Returns the number
   * of holds released. Runs in the caller's transaction (`runGc`).
   */
  prune(now: string): number {
    const db = this.db;
    const release = db.prepare(
      `UPDATE id_claims SET holders = holders & ~${HOLDER_CORE}
       WHERE repo_id IS ? AND (holders & ${HOLDER_CORE}) != 0 AND minted_at < ? AND ${NAMES_NO_CORE_ROW_SQL}`,
    );
    let released = 0;
    const scopes: { repoId: string | null; settings: Record<string, unknown> }[] = (db.prepare("SELECT repo_id FROM repos ORDER BY repo_id").all() as { repo_id: string }[]).map((r) => ({
      repoId: r.repo_id,
      settings: effectiveSettings(this.store, r.repo_id),
    }));
    scopes.push({ repoId: null, settings: parseSettingsJson((db.prepare("SELECT settings FROM workspace_settings WHERE id = 0").get() as { settings: string } | undefined)?.settings) });
    for (const { repoId, settings } of scopes) {
      const days = claimsRetainDays(settings);
      if (days === null) continue;
      const cutoff = new Date(Date.parse(now) - days * DAY_MS).toISOString();
      released += release.run(repoId, cutoff).changes;
    }
    if (released > 0) db.prepare("DELETE FROM id_claims WHERE holders = 0").run();
    return released;
  }

  /** `count(*)` of `id_claims` — the size report's line (spec/store §7.2). */
  count(): number {
    return (this.db.prepare("SELECT count(*) AS c FROM id_claims").get() as { c: number }).c;
  }
}
