// The live feed: `changes_since` polled with a cursor, as live-tail does (the
// cursor and digest helpers are copied from examples/live-tail/src/lib/feed.ts
// and lib/shapes.ts). The tool (spec/sync §6 3.0, spec/surface §3 5.0): `{
// digests: [{ commit, seq, ts, origin, actor, summary, revisions: [{ _id,
// _path, _hash }] }], cursor, truncated, head }` — a revision's keys are row
// attributes, so `_`-prefixed; a digest describes a commit, so its keys are
// bare roles; a digest without revisions is a deletion or a move, its `summary`
// the only statement of what happened.

import { repoArg, type Caller, type Wire } from "./mcp-client.ts";
import { rooted } from "./paths.ts";

export interface Revision { id: string; path: string; hash: string }
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

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export function digestOf(d: Wire): Digest {
  const revisions = Array.isArray(d.revisions) ? (d.revisions as Wire[]).map((r) => ({ id: str(r._id), path: rooted(str(r._path)), hash: str(r._hash) })) : [];
  return { commit: str(d.commit), seq: num(d.seq), ts: str(d.ts), origin: str(d.origin), actor: strOrNull(d.actor), summary: str(d.summary), revisions };
}

export function changesOf(page: Wire): ChangesSince {
  const digests = Array.isArray(page.digests) ? (page.digests as Wire[]).map(digestOf) : [];
  return { digests, cursor: num(page.cursor), truncated: page.truncated === true, head: num(page.head) };
}

/** `changes_since { cursor?, limit }`. */
export function changesArgs(repo: string | null, cursor: number | null, limit: number): Record<string, unknown> {
  return { limit, ...(cursor !== null ? { cursor } : {}), ...repoArg(repo) };
}

export async function fetchChanges(caller: Caller, repo: string | null, cursor: number | null, limit = 50): Promise<ChangesSince> {
  return changesOf(await caller.call<Wire>("changes_since", changesArgs(repo, cursor, limit)));
}

/** Where the live feed starts: the repo's `head` (what happened before the page opened is history's business). */
export function startCursor(r: Pick<ChangesSince, "head">): number {
  return r.head;
}

/** The cursor after a poll. A cursor beyond `head` belongs to another repo or
 * server (the tool's own contract): start over from `head` and say so. */
export function advanceCursor(r: Pick<ChangesSince, "cursor" | "head">): { cursor: number; reset: boolean } {
  return r.cursor > r.head ? { cursor: r.head, reset: true } : { cursor: r.cursor, reset: false };
}

export interface FeedEntry {
  /** The commit id (unique per repo); the strip is deduped by it. */
  key: string;
  seq: number;
  ts: string;
  origin: string;
  actor: string | null;
  summary: string;
  /** The documents touched (rooted paths, with ids). */
  docs: { id: string; path: string }[];
}

export function entryFromDigest(d: Digest): FeedEntry {
  return { key: d.commit, seq: d.seq, ts: d.ts, origin: d.origin, actor: d.actor, summary: d.summary, docs: d.revisions.map((r) => ({ id: r.id, path: r.path })) };
}

/** How many entries the strip keeps. */
export const FEED_CAP = 50;

/** A page of digests (ascending `seq`) put in front of the entries shown
 * (newest first), without repeating a commit already there; capped. */
export function prependDigests(entries: readonly FeedEntry[], digests: readonly Digest[], cap = FEED_CAP): FeedEntry[] {
  const seen = new Set(entries.map((e) => e.key));
  const fresh: FeedEntry[] = [];
  for (const d of digests) {
    if (seen.has(d.commit)) continue;
    seen.add(d.commit);
    fresh.push(entryFromDigest(d));
  }
  fresh.sort((a, b) => b.seq - a.seq);
  return [...fresh, ...entries].slice(0, cap);
}

/** Who made the change, once: `origin · actor`; the origin alone when there is
 * no actor, the actor alone when it already carries the origin. */
export function byline(e: Pick<FeedEntry, "origin" | "actor">): string {
  if (!e.actor) return e.origin;
  if (e.actor === e.origin || e.actor.startsWith(`${e.origin}:`)) return e.actor;
  return `${e.origin} · ${e.actor}`;
}

/** A timestamp for the strip: `HH:MM:SS` when it is today (by `now`), else `YYYY-MM-DD HH:MM`; the input when unparsable. */
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
export function pollMs(input: string | number | null | undefined, fallback = 3000): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n) || n < 1 || n > 3600) return fallback;
  return Math.round(n) * 1000;
}

/** The documents a page of digests touched (rooted, deduped) — what the page refreshes when one of them is open. */
export function touchedPaths(digests: readonly Digest[]): string[] {
  return [...new Set(digests.flatMap((d) => d.revisions.map((r) => r.path)))];
}
