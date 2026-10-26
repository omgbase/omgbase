import type { Database } from "better-sqlite3";
import type { Store } from "./store.js";
import { mintId } from "../ids.js";
import { capabilitiesOf, claimsOf } from "../capabilities/registry.js";
import { referencePath } from "../paths.js";
import { effectiveSettingsOf } from "./settings.js";

// The change feed (spec/store §3.1 `feed`/`feed_entries`, §5.4 step 5, §7.4;
// spec/surface §3 `changes_since`; modular-core Phase 3d — D7/M5, D4). The
// core's own record of every commit to a repository: one slim row per commit
// (`epoch`, `seq`, `commit_id`, `ts`, `origin`, `actor`, `reason`, `batch_id`,
// `plan_id`) and one entry per document the commit touched (`path` as of the
// commit, the `head` token minted, the `hash` the head renders to, `kind ∈
// created | changed | deleted | moved`, `from_path` on a move). It is what
// `changes_since` pages and what the sync base rests on; it depends on no
// history table — the recorder's `commits` row shares the id, epoch and seq
// (`HistoryRecorder.recordCommit`) and keeps the log. Retention is the core's
// (§7.4): floors `feed.retain_days` / `feed.retain_entries`, cap
// `feed.max_entries`; "the feed is catch-up, a rescan is recovery, the log is
// history". A cursor is `(epoch, seq)`: the repository's EPOCH (`repos.epoch`,
// an `ep_` id minted with the repo) scopes every `seq`, and a cursor from
// another epoch, past the head or behind the oldest retained row is
// `expired_cursor` — the consumer rescans (spec/sync §6).

export type FeedOrigin = "api" | "observed" | "import" | "projection";
export type FeedEntryKind = "created" | "changed" | "deleted" | "moved";

/** The repository's current epoch (`repos.epoch`). */
export function repoEpoch(db: Database, repoId: string): string {
  const row = db.prepare("SELECT epoch FROM repos WHERE repo_id = ?").get(repoId) as { epoch: string } | undefined;
  if (!row) throw new Error(`no repository ${repoId}`);
  return row.epoch;
}

/** Mint the repository's epoch (an `ep_` id, claimed at `mintedAt`); the caller writes it on the `repos` row. */
export function mintEpoch(db: Database, repoId: string, mintedAt: string): string {
  const epoch = mintId("ep");
  claimsOf(db).claim("ep", epoch, repoId, mintedAt);
  return epoch;
}

/**
 * spec/store §7.5 (17.0): the epoch re-mint of a restore or a rebuild-from-
 * files. Mint and claim a new `ep` at `ts`, write it on the `repos` row, and
 * delete the repository's `feed`/`feed_entries` rows of EVERY epoch — the old
 * epoch is unreachable by any cursor (an `expired_cursor` by construction) and
 * the feed starts over at `seq = 1` with the next commit. The recorder's
 * `commits` keep their old `epoch`. Runs in the caller's transaction.
 */
export function remintEpoch(db: Database, repoId: string, ts: string): string {
  repoEpoch(db, repoId); // throws for an unknown repository
  const epoch = mintEpoch(db, repoId, ts);
  db.prepare("DELETE FROM feed_entries WHERE repo_id = ?").run(repoId);
  db.prepare("DELETE FROM feed WHERE repo_id = ?").run(repoId);
  db.prepare("UPDATE repos SET epoch = ? WHERE repo_id = ?").run(epoch, repoId);
  return epoch;
}

export interface NewFeedRowInput {
  repoId: string;
  ts: string;
  origin: FeedOrigin;
  actor?: string | null;
  reason?: string | null;
  /** The batch this commit belongs to (D4): the first committing member's commit id; absent/null ⇒ this commit is its own batch (`batch_id = commit_id`). */
  batchId?: string | null;
  /** The admitted plan's digest for an effect-driven api commit (resolution 3); NULL otherwise. */
  planId?: string | null;
  /** The ADR-003 intent record, handed to the recorder (`commits.ops`); never a feed column. */
  ops?: string | null;
}

export interface FeedRow {
  commitId: string;
  epoch: string;
  seq: number;
  batchId: string;
}

/**
 * spec/store §5.4 step 5: mint `c` (claim it), `seq = 1 + max(seq)` over the
 * repo's feed rows of the current epoch, insert the row with `batch_id` (the
 * given batch's id, else this commit's own), then hand the recorder its
 * `commits` row (`HistoryRecorder.recordCommit` — the same id, epoch and seq;
 * skipped when the store runs without the recorder) and enforce the cap
 * (`feed.max_entries`, §7.4) inside the same transaction. Runs in the caller's
 * transaction on `db`.
 */
export function appendFeedRow(db: Database, input: NewFeedRowInput): FeedRow {
  const epoch = repoEpoch(db, input.repoId);
  const commitId = mintId("c");
  claimsOf(db).claim("c", commitId, input.repoId, input.ts);
  const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM feed WHERE repo_id = ? AND epoch = ?").get(input.repoId, epoch) as { seq: number }).seq;
  const batchId = input.batchId ?? commitId;
  db.prepare(
    `INSERT INTO feed (repo_id, epoch, seq, commit_id, ts, origin, actor, reason, batch_id, plan_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(input.repoId, epoch, seq, commitId, input.ts, input.origin, input.actor ?? null, input.reason ?? null, batchId, input.planId ?? null);
  capabilitiesOf(db).history?.recordCommit({
    commitId,
    repoId: input.repoId,
    epoch,
    seq,
    ts: input.ts,
    origin: input.origin,
    actor: input.actor ?? null,
    reason: input.reason ?? null,
    batchId,
    ops: input.ops ?? null,
  });
  enforceFeedCap(db, input.repoId, epoch);
  return { commitId, epoch, seq, batchId };
}

export interface NewFeedEntryInput {
  repoId: string;
  epoch: string;
  seq: number;
  docId: string;
  /** The path as of the commit (storage form). */
  path: string;
  /** The head token minted (NULL for `deleted`). */
  head: string | null;
  /** `docs.file_hash` after the commit (NULL for `deleted`). */
  hash: Buffer | null;
  kind: FeedEntryKind;
  /** `moved` only: the previous path (storage form). */
  fromPath?: string | null;
}

/** spec/store §5.4 step 5 (the entry), §5.6 step 1: one `feed_entries` row for a document the feed row touched. */
export function appendFeedEntry(db: Database, e: NewFeedEntryInput): void {
  db.prepare(
    `INSERT OR REPLACE INTO feed_entries (repo_id, epoch, seq, doc_id, path, head, hash, kind, from_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.repoId, e.epoch, e.seq, e.docId, e.path, e.head, e.hash, e.kind, e.kind === "moved" ? (e.fromPath ?? null) : null);
}

/** The `(epoch, seq)` of a feed row by its commit id — what a per-document step reads back to write its entry. */
export function feedRowOf(db: Database, commitId: string): { epoch: string; seq: number } {
  const row = db.prepare("SELECT epoch, seq FROM feed WHERE commit_id = ?").get(commitId) as { epoch: string; seq: number } | undefined;
  if (!row) throw new Error(`no feed row for commit ${commitId}`);
  return row;
}

// ---- retention (spec/store §7.4) --------------------------------------------------

export const FEED_SETTINGS_KEY = "feed";
export const FEED_RETAIN_DAYS_DEFAULT = 10;
export const FEED_RETAIN_ENTRIES_DEFAULT = 10_000;
export const FEED_MAX_ENTRIES_DEFAULT = 100_000;

const DAY_MS = 86_400_000;

export interface FeedPolicy {
  /** floor: a row younger than this many days is never pruned by the floors */
  retainDays: number;
  /** floor: the newest N rows are never pruned by the floors */
  retainEntries: number;
  /** cap: a row with more than this many newer rows is pruned regardless */
  maxEntries: number;
}

function nonNegativeInt(v: unknown, key: string, dflt: number): number {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`feed.${key} must be a non-negative integer (got ${JSON.stringify(v)})`);
  return v;
}

/**
 * The feed policy out of a settings blob (spec/store §7.4): `feed.retain_days`
 * (default 10), `feed.retain_entries` (default 10 000), `feed.max_entries`
 * (default 100 000) — each a non-negative integer. A `max_entries` below
 * `retain_entries` is a malformed policy and refused, as is any other value.
 */
export function feedPolicy(settings: Record<string, unknown>): FeedPolicy {
  const feed = settings[FEED_SETTINGS_KEY];
  const o = feed !== null && typeof feed === "object" && !Array.isArray(feed) ? (feed as Record<string, unknown>) : {};
  const policy: FeedPolicy = {
    retainDays: nonNegativeInt(o.retain_days, "retain_days", FEED_RETAIN_DAYS_DEFAULT),
    retainEntries: nonNegativeInt(o.retain_entries, "retain_entries", FEED_RETAIN_ENTRIES_DEFAULT),
    maxEntries: nonNegativeInt(o.max_entries, "max_entries", FEED_MAX_ENTRIES_DEFAULT),
  };
  if (policy.maxEntries < policy.retainEntries) throw new Error(`feed.max_entries (${policy.maxEntries}) must not be below feed.retain_entries (${policy.retainEntries})`);
  return policy;
}

/** The repo's effective feed policy (the workspace layer with the repo's own over it). */
export function repoFeedPolicy(db: Database, repoId: string): FeedPolicy {
  return feedPolicy(effectiveSettingsOf(db, repoId));
}

/**
 * Delete every feed row of `(repo, epoch)` with more than `keep` newer rows
 * (so `keep + 1` rows survive at most — a row with exactly `keep` newer rows
 * is not "more than"), optionally only those with `ts < olderThan`, oldest
 * first, together with their entries. Never the row with the greatest `seq`
 * (it has no newer row). Returns the rows deleted.
 */
function pruneBeyond(db: Database, repoId: string, epoch: string, keep: number, olderThan: string | null): number {
  const victims = db
    .prepare(
      `SELECT seq FROM feed WHERE repo_id = ? AND epoch = ? ${olderThan === null ? "" : "AND ts < ?"}
       AND seq IN (SELECT seq FROM feed WHERE repo_id = ? AND epoch = ? ORDER BY seq DESC LIMIT -1 OFFSET ?)
       ORDER BY seq`,
    )
    .all(...(olderThan === null ? [repoId, epoch, repoId, epoch, keep + 1] : [repoId, epoch, olderThan, repoId, epoch, keep + 1])) as { seq: number }[];
  if (victims.length === 0) return 0;
  const delEntries = db.prepare("DELETE FROM feed_entries WHERE repo_id = ? AND epoch = ? AND seq = ?");
  const delRow = db.prepare("DELETE FROM feed WHERE repo_id = ? AND epoch = ? AND seq = ?");
  for (const v of victims) {
    delEntries.run(repoId, epoch, v.seq);
    delRow.run(repoId, epoch, v.seq);
  }
  return victims.length;
}

/** The cap (§7.4): enforced in the transaction that appended a row — a feed never exceeds `max_entries + 1` rows. */
function enforceFeedCap(db: Database, repoId: string, epoch: string): void {
  pruneBeyond(db, repoId, epoch, repoFeedPolicy(db, repoId).maxEntries, null);
}

/**
 * The feed prune `gc` runs (spec/store §7.4): for every repository, the rows
 * of its current epoch older than `retain_days` (by `ts` against `now`) AND
 * with more than `retain_entries` newer rows, then the cap. Returns the feed
 * rows pruned. Runs in the caller's transaction.
 */
export function pruneFeed(store: Store, now: string): number {
  const db = store.db;
  let pruned = 0;
  for (const r of db.prepare("SELECT repo_id, epoch FROM repos ORDER BY rowid").all() as { repo_id: string; epoch: string }[]) {
    const policy = repoFeedPolicy(db, r.repo_id);
    const cutoff = new Date(Date.parse(now) - policy.retainDays * DAY_MS).toISOString();
    pruned += pruneBeyond(db, r.repo_id, r.epoch, policy.retainEntries, cutoff);
    pruned += pruneBeyond(db, r.repo_id, r.epoch, policy.maxEntries, null);
  }
  return pruned;
}

// ---- status and the change feed (spec/surface §3 `changes_since`) --------------------

export interface FeedStatus {
  epoch: string;
  /** the smallest `seq` the feed still holds (0 when empty) */
  oldest: number;
  /** the greatest `seq` (0 when empty) */
  head: number;
}

/** `{ epoch, oldest, head }` of the repository's feed in its current epoch. */
export function feedStatus(db: Database, repoId: string): FeedStatus {
  const epoch = repoEpoch(db, repoId);
  const row = db.prepare("SELECT COALESCE(MIN(seq), 0) AS oldest, COALESCE(MAX(seq), 0) AS head FROM feed WHERE repo_id = ? AND epoch = ?").get(repoId, epoch) as { oldest: number; head: number };
  return { epoch, oldest: row.oldest, head: row.head };
}

/**
 * `expired_cursor` (spec/surface §3, 6.0; `retriable: false`): the cursor's
 * epoch is not the repository's, or the cursor is past the head, or behind
 * the oldest retained row. `data` is `{ epoch, oldest, head }` — the
 * repository's current position, which the rescan (spec/sync §6) resumes from.
 */
export class ExpiredCursor extends Error {
  constructor(
    public readonly cursor: number,
    public readonly given: string,
    public readonly epoch: string,
    public readonly oldest: number,
    public readonly head: number,
  ) {
    super(`cursor ${cursor} of epoch ${given} has expired — the feed now begins at (${epoch}, ${oldest}); rescan the repository and resume from head ${head}`);
    this.name = "ExpiredCursor";
  }
  data(): { epoch: string; oldest: number; head: number } {
    return { epoch: this.epoch, oldest: this.oldest, head: this.head };
  }
}

/** One document of a digest: the row's engine names, the entry's kind, `from_path` on a move; `_hash` null for a deletion. */
export interface DigestRevision {
  _id: string;
  _path: string;
  _hash: string | null;
  kind: FeedEntryKind;
  from_path?: string;
}

export interface CommitDigest {
  commit: string;
  seq: number;
  ts: string;
  origin: string;
  actor: string | null;
  batch_id: string;
  plan_id?: string;
  /** A human line composed from the entries (unpinned); the disposition counts follow only when the recorder holds the commit. */
  summary: string;
  revisions: DigestRevision[];
}

export interface ChangesPage {
  digests: CommitDigest[];
  /** the last digest's `seq` (the input cursor when the page is empty) */
  cursor: number;
  epoch: string;
  oldest: number;
  head: number;
  truncated: boolean;
}

export interface ChangesSinceOptions {
  cursor?: number;
  epoch?: string;
  limit?: number;
  origin?: string;
}

/**
 * `changes_since` (spec/surface §3, 6.0 — contracts §2.4): the feed rows with
 * `seq > cursor` of the repository's epoch (optionally of one origin), in
 * `seq` order, `limit + 1` fetched to set `truncated`; the given `epoch`
 * defaults to the repository's. Fails `ExpiredCursor` when the given epoch is
 * not the repository's, or `cursor > head`, or `0 < cursor < oldest − 1`
 * (every entry after the cursor is present exactly when `cursor ≥ oldest − 1`;
 * cursor 0 is always valid — a consumer starting from nothing reads `oldest`
 * to see where the feed begins). Reads `feed`/`feed_entries` only; the
 * disposition counts of the summary come from the recorder when it holds the
 * commit.
 */
export function changesSince(store: Store, repoId: string, opts: ChangesSinceOptions = {}): ChangesPage {
  const db = store.db;
  const cursor = opts.cursor ?? 0;
  const status = feedStatus(db, repoId);
  const given = opts.epoch ?? status.epoch;
  if (given !== status.epoch || cursor > status.head || (cursor > 0 && cursor < status.oldest - 1)) {
    throw new ExpiredCursor(cursor, given, status.epoch, status.oldest, status.head);
  }
  const limit = opts.limit ?? 50;
  const originClause = opts.origin ? "AND origin = ?" : "";
  const params: unknown[] = [repoId, status.epoch, cursor];
  if (opts.origin) params.push(opts.origin);
  params.push(limit + 1);
  const rows = db
    .prepare(`SELECT seq, commit_id, ts, origin, actor, reason, batch_id, plan_id FROM feed WHERE repo_id = ? AND epoch = ? AND seq > ? ${originClause} ORDER BY seq LIMIT ?`)
    .all(...params) as { seq: number; commit_id: string; ts: string; origin: string; actor: string | null; reason: string | null; batch_id: string; plan_id: string | null }[];
  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);
  const entriesOf = db.prepare("SELECT doc_id, path, head, hash, kind, from_path FROM feed_entries WHERE repo_id = ? AND epoch = ? AND seq = ? ORDER BY rowid");
  const history = capabilitiesOf(db).history;
  const digests: CommitDigest[] = page.map((r) => {
    const entries = entriesOf.all(repoId, status.epoch, r.seq) as { doc_id: string; path: string; head: string | null; hash: Buffer | null; kind: FeedEntryKind; from_path: string | null }[];
    // Every path in a digest — the entries' and the summary's — is the reference form (spec/surface §1 "Paths").
    const revisions: DigestRevision[] = entries.map((e) => ({
      _id: e.doc_id,
      _path: referencePath(e.path),
      _hash: e.hash ? e.hash.toString("hex") : null,
      kind: e.kind,
      ...(e.kind === "moved" && e.from_path !== null ? { from_path: referencePath(e.from_path) } : {}),
    }));
    const counts = history?.dispositionCounts(r.commit_id) ?? null;
    return {
      commit: r.commit_id,
      seq: r.seq,
      ts: r.ts,
      origin: r.origin,
      actor: r.actor,
      batch_id: r.batch_id,
      ...(r.plan_id !== null ? { plan_id: r.plan_id } : {}),
      summary: renderSummary(r.origin, r.actor, revisions, counts),
      revisions,
    };
  });
  const nextCursor = page.length > 0 ? page[page.length - 1]!.seq : cursor;
  return { digests, cursor: nextCursor, epoch: status.epoch, oldest: status.oldest, head: status.head, truncated };
}

/**
 * The digest's human line (spec/surface §3, unpinned): `<origin>: ` for an
 * observation, `<origin>(<actor>): ` otherwise; then the entries joined by
 * `; ` — `/a.md — changed` (`created`), `deleted /b.md`, `moved /a.md → /c.md`
 * — and, when the recorder holds the commit, the 16.0 disposition counts
 * (` — 12 edited, 1 inserted`, `same` excluded).
 */
export function renderSummary(origin: string, actor: string | null, revisions: readonly DigestRevision[], counts: readonly { kind: string; n: number }[] | null): string {
  const prefix = origin === "observed" ? "observed: " : `${origin}(${actor ?? "?"}): `;
  const parts = revisions.map((r) => {
    if (r.kind === "deleted") return `deleted ${r._path}`;
    if (r.kind === "moved") return `moved ${r.from_path ?? "?"} → ${r._path}`;
    return `${r._path} — ${r.kind}`;
  });
  const detail = counts ? counts.filter((c) => c.kind !== "same").map((c) => `${c.n} ${c.kind}`) : [];
  return `${prefix}${parts.length > 0 ? parts.join("; ") : "(no documents)"}${detail.length > 0 ? ` — ${detail.join(", ")}` : ""}`;
}
