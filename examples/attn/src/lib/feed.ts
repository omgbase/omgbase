// Staying live: `changes_since` polled with a cursor (the subset of
// repo-explorer's lib/feed.ts this app needs). A digest that touched anything
// under `/attn/` makes the page reload the pointer, the intents, the cues and
// today's stream, so two windows (or the CLI) agree within one poll. The tool
// (spec/surface §3): `{ digests: [{ commit, seq, ts, origin, actor, summary,
// revisions: [{ id, path, hash }] }], cursor, truncated, head }`.

import { repoArg, type Caller, type Wire } from "./mcp-client.ts";
import { ATTN_ROOT } from "./model.ts";

export interface Revision { id: string; path: string; hash: string }
export interface Digest { commit: string; seq: number; ts: string; summary: string; revisions: Revision[] }
export interface ChangesSince { digests: Digest[]; cursor: number; truncated: boolean; head: number }

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export function changesOf(page: Wire): ChangesSince {
  const digests = Array.isArray(page.digests) ? (page.digests as Wire[]).map((d) => ({
    commit: str(d.commit),
    seq: num(d.seq),
    ts: str(d.ts),
    summary: str(d.summary),
    revisions: Array.isArray(d.revisions) ? (d.revisions as Wire[]).map((r) => ({ id: str(r.id), path: str(r.path), hash: str(r.hash) })) : [],
  })) : [];
  return { digests, cursor: num(page.cursor), truncated: page.truncated === true, head: num(page.head) };
}

/** `changes_since { cursor?, limit }`. */
export function changesArgs(repo: string | null, cursor: number | null, limit: number): Record<string, unknown> {
  return { limit, ...(cursor !== null ? { cursor } : {}), ...repoArg(repo) };
}

export async function fetchChanges(caller: Caller, repo: string | null, cursor: number | null, limit = 50): Promise<ChangesSince> {
  return changesOf(await caller.call<Wire>("changes_since", changesArgs(repo, cursor, limit)));
}

/** Where the feed starts: the repo's `head`. */
export function startCursor(r: Pick<ChangesSince, "head">): number {
  return r.head;
}

/** The cursor after a poll; one beyond `head` belongs to another repo or server — start over from `head`. */
export function advanceCursor(r: Pick<ChangesSince, "cursor" | "head">): { cursor: number; reset: boolean } {
  return r.cursor > r.head ? { cursor: r.head, reset: true } : { cursor: r.cursor, reset: false };
}

/** The documents a page of digests touched (deduped). */
export function touchedPaths(digests: readonly Digest[]): string[] {
  return [...new Set(digests.flatMap((d) => d.revisions.map((r) => r.path)))];
}

/** Did a page of digests touch the attn folder (or delete/move something — a digest without revisions)? */
export function touchesAttn(digests: readonly Digest[]): boolean {
  return digests.some((d) => d.revisions.length === 0 || d.revisions.some((r) => r.path.startsWith(`${ATTN_ROOT}/`)));
}

/** The poll interval the user typed, in milliseconds: whole seconds, 1..3600, else the fallback. */
export function pollMs(input: string | number | null | undefined, fallback = 3000): number {
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n) || n < 1 || n > 3600) return fallback;
  return Math.round(n) * 1000;
}
