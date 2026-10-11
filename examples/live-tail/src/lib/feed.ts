// The pure side of the live tail: the change feed's cursor, a `changes_since`
// digest as the page shows it, which two revisions to diff for a change, the
// recent-documents query and its hits (either envelope), and the diff's lines.
// Nothing here touches the network or the DOM.
//
// Tool shapes (packages/core/src/mcp/server.ts, graph/history.ts):
//   changes_since → { digests: [{ commit, seq, ts, origin, actor, summary, revisions: [{ doc, path, contentHash }] }], cursor, truncated, head }
//   docs_history  → { docs: [{ docId, path, deleted, currentRev, versions: [{ rev, seq, commit, ts, origin, actor, contentHash, isCurrent }] }], truncated }
//   diff_unified  → { doc, path, from, to, diff }
//   docs_read_at  → { path, docId, rev, content, … }

import { hitId, hitPath, rooted } from "./paths.ts";

export interface Revision { doc: string; path: string; contentHash: string }
export interface Digest {
  commit: string;
  seq: number;
  ts: string;
  origin: string;
  actor: string | null;
  summary: string;
  revisions: Revision[];
}
export interface ChangesSince { digests: Digest[]; cursor: number; truncated: boolean; head: number }

export interface DocVersion { rev: string; seq: number; commit: string; ts: string; origin: string; actor: string | null; contentHash: string; isCurrent: boolean }
export interface DocVersions { docId: string; path: string; deleted: boolean; currentRev: string | null; versions: DocVersion[] }

/** The query behind the initial view. `$title`/`$updated_at` are projected under both envelopes. */
export const RECENT_QUERY = "select $path, $title, $updated_at from docs order by $updated_at desc limit 25";
export const RECENT_LIMIT = 25;

// ---- the cursor --------------------------------------------------------------------

/** Where the live feed starts: the repo's `head` (what happened before the page
 * opened is the recent-documents view's business, not a "change"). */
export function startCursor(r: Pick<ChangesSince, "head">): number {
  return r.head;
}

/** The cursor after a poll. A cursor beyond `head` belongs to another repo or
 * server (the tool's own contract): start over from `head` and say so. */
export function advanceCursor(r: Pick<ChangesSince, "cursor" | "head">): { cursor: number; reset: boolean } {
  return r.cursor > r.head ? { cursor: r.head, reset: true } : { cursor: r.cursor, reset: false };
}

// ---- digests → entries -------------------------------------------------------------

/** What is being diffed for one changed document. */
export type DiffPair =
  | { kind: "created"; rev: string }
  | { kind: "changed"; from: string; to: string };

export interface EntryChange {
  doc: string;
  /** `/`-rooted whatever the server returned. */
  path: string;
  contentHash: string;
}

export interface FeedEntry {
  /** The commit id (unique per repo); the list is deduped by it. */
  key: string;
  seq: number;
  ts: string;
  origin: string;
  actor: string | null;
  summary: string;
  changes: EntryChange[];
}

export function entryFromDigest(d: Digest): FeedEntry {
  return {
    key: d.commit,
    seq: d.seq,
    ts: d.ts,
    origin: d.origin,
    actor: d.actor,
    summary: d.summary,
    changes: d.revisions.map((r) => ({ doc: r.doc, path: rooted(r.path), contentHash: r.contentHash })),
  };
}

/** A page of digests (ascending `seq`) put in front of the entries shown
 * (newest first), without repeating a commit already there. */
export function prependDigests(entries: readonly FeedEntry[], digests: readonly Digest[]): FeedEntry[] {
  const seen = new Set(entries.map((e) => e.key));
  const fresh: FeedEntry[] = [];
  for (const d of digests) {
    if (seen.has(d.commit)) continue;
    seen.add(d.commit);
    fresh.push(entryFromDigest(d));
  }
  fresh.sort((a, b) => b.seq - a.seq);
  return [...fresh, ...entries];
}

/** `origin · actor` for the entry's byline (`actor` is often null for observed changes). */
export function byline(e: Pick<FeedEntry, "origin" | "actor">): string {
  return e.actor ? `${e.origin} · ${e.actor}` : e.origin;
}

// ---- which revisions to diff --------------------------------------------------------

/** The pair for a document's LATEST change: its last two versions, or
 * "created" when it has only one. Null without versions. */
export function latestPair(versions: readonly DocVersion[]): DiffPair | null {
  const n = versions.length;
  if (n === 0) return null;
  if (n === 1) return { kind: "created", rev: versions[0]!.rev };
  return { kind: "changed", from: versions[n - 2]!.rev, to: versions[n - 1]!.rev };
}

/** The pair for the revision a given commit produced (a digest's change):
 * that version against its predecessor, "created" when it is the first.
 * Null when the commit wrote no version of this document. */
export function pairForCommit(versions: readonly DocVersion[], commit: string): DiffPair | null {
  const i = versions.findIndex((v) => v.commit === commit);
  if (i < 0) return null;
  if (i === 0) return { kind: "created", rev: versions[0]!.rev };
  return { kind: "changed", from: versions[i - 1]!.rev, to: versions[i]!.rev };
}

// ---- recent documents ---------------------------------------------------------------

export interface RecentDoc {
  id: string | null;
  /** `/`-rooted. */
  path: string;
  title: string | null;
  updatedAt: string | null;
}

/** The recent-documents hits as the page shows them; a hit without a path is skipped. */
export function recentFromHits(hits: readonly Record<string, unknown>[]): RecentDoc[] {
  const out: RecentDoc[] = [];
  for (const hit of hits) {
    const path = hitPath(hit);
    if (path === null) continue;
    const title = hit.$title;
    const updated = hit.$updated_at;
    out.push({
      id: hitId(hit),
      path: rooted(path),
      title: typeof title === "string" && title.trim() ? title : null,
      updatedAt: typeof updated === "string" ? updated : null,
    });
  }
  return out;
}

// ---- rendering helpers -------------------------------------------------------------

export type DiffLineKind = "hunk" | "add" | "del" | "ctx";

/** Classify a unified-diff line by its first character (no file header is
 * ever present: `diff_unified` emits hunks only). */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/** `+n −m` for a unified diff (hunk headers excluded). */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (diff === "") return { added, removed };
  for (const line of diff.split("\n")) {
    const kind = diffLineKind(line);
    if (kind === "add") added++;
    else if (kind === "del") removed++;
  }
  return { added, removed };
}

/** A timestamp for the feed: `HH:MM:SS` when it is today (by `now`), else `YYYY-MM-DD HH:MM`; the input when unparsable. */
export function formatTime(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? `${hm}:${pad(d.getSeconds())}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** The poll interval the user typed, in milliseconds: whole seconds, 1..3600, else the fallback. */
export function pollMs(input: string | number | null | undefined, fallback = 2000): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n) || n < 1 || n > 3600) return fallback;
  return Math.round(n) * 1000;
}
