// The Stream: the ordered history of focus episodes, RECONSTRUCTED from the
// daily logs — one list item per transition, `- HH:MM:SSZ → <intent path |
// none> (switch|interrupt|back|stop)`. Each line's time is the previous
// episode's end, so durations fall out; the last episode of today runs to the
// clock, of a past day to the day's end. Lines the grammar does not know (a
// future `- correct …`) are skipped, never an error. Read-only in v1 beyond
// the appends of lib/writes.ts: v1 has no corrections.
//
// Days come from `docs_tree { path: "/attn/stream/", depth: 1 }`, a day's lines
// from `docs_read { path }`.

import { OmgError, repoArg, type Caller, type Wire } from "./mcp-client.ts";
import { STREAM_DIR, bodyOf, dayEnd, isoOf, secondsBetween, streamDay, type TransitionKind } from "./model.ts";
import type { FocusState } from "./pointer.ts";

export interface Transition {
  /** When it happened (ISO, UTC). */
  at: string;
  /** The intent that took focus, null for a stop. */
  target: string | null;
  kind: TransitionKind;
}

const LINE = /^- (\d{2}:\d{2}:\d{2}Z) → (\S+) \((switch|interrupt|back|stop)\)\s*$/;

/** A stream document's raw bytes → its transitions, in file order. */
export function parseStream(raw: string, day: string): Transition[] {
  const out: Transition[] = [];
  for (const line of bodyOf(raw).split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    out.push({ at: isoOf(day, m[1]!), target: m[2] === "none" ? null : m[2]!, kind: m[3] as TransitionKind });
  }
  return out;
}

export interface Episode {
  intent: string;
  start: string;
  end: string;
  seconds: number;
  /** How the episode began. */
  kind: TransitionKind;
  /** What ended it: the next transition, the clock (still in focus), or the day's end (a past day, nothing stopped it). */
  endedBy: "transition" | "now" | "day-end";
  /** The episode began before this day (the pointer's `since` is on an earlier day and the day has no earlier line). */
  carried: boolean;
}

export interface EpisodeOptions {
  /** The clock (ISO). */
  now: string;
  /** The pointer, to carry a focus that began on an earlier day into this one. */
  pointer?: Pick<FocusState, "focused" | "since"> | null;
}

/** A day's episodes from its transitions. */
export function episodesOf(transitions: readonly Transition[], day: string, opts: EpisodeOptions): Episode[] {
  const start = `${day}T00:00:00.000Z`;
  const end = dayEnd(day);
  const today = opts.now >= start && opts.now < end;
  const list: (Transition & { carried?: boolean })[] = [...transitions];
  const p = opts.pointer;
  if (p?.focused && p.since && p.since < start && (list.length === 0 || list[0]!.at > start)) {
    list.unshift({ at: start, target: p.focused, kind: "switch", carried: true });
  }
  const out: Episode[] = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i]!;
    if (!t.target) continue;
    const next = list[i + 1];
    let endAt: string;
    let endedBy: Episode["endedBy"];
    if (next) { endAt = next.at; endedBy = "transition"; }
    else if (today) { endAt = opts.now; endedBy = "now"; }
    else { endAt = end; endedBy = "day-end"; }
    out.push({ intent: t.target, start: t.at, end: endAt, seconds: secondsBetween(t.at, endAt), kind: t.kind, endedBy, carried: t.carried === true });
  }
  return out;
}

/** Seconds per tag over a day's episodes; `tagsOf` maps an intent path to its tags (an intent with none counts under `untagged`). */
export function tagTotals(episodes: readonly Episode[], tagsOf: (intent: string) => readonly string[]): { tag: string; seconds: number }[] {
  const totals = new Map<string, number>();
  for (const e of episodes) {
    const tags = tagsOf(e.intent);
    for (const tag of tags.length ? tags : ["untagged"]) totals.set(tag, (totals.get(tag) ?? 0) + e.seconds);
  }
  return [...totals].map(([tag, seconds]) => ({ tag, seconds })).sort((a, b) => b.seconds - a.seconds || a.tag.localeCompare(b.tag));
}

/** Seconds per intent over a day's episodes, most first. */
export function intentTotals(episodes: readonly Episode[]): { intent: string; seconds: number }[] {
  const totals = new Map<string, number>();
  for (const e of episodes) totals.set(e.intent, (totals.get(e.intent) ?? 0) + e.seconds);
  return [...totals].map(([intent, seconds]) => ({ intent, seconds })).sort((a, b) => b.seconds - a.seconds || a.intent.localeCompare(b.intent));
}

/** Intent path → the last moment it took focus, over any transitions (the chooser's recency). */
export function lastFocused(transitions: readonly Transition[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of transitions) if (t.target && (out.get(t.target) ?? "") < t.at) out.set(t.target, t.at);
  return out;
}

// ---- the calls -------------------------------------------------------------------------------

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The `docs_tree` arguments for the stream folder. */
export function streamTreeArgs(repo: string | null, cursor: string | null = null): Record<string, unknown> {
  return { path: STREAM_DIR, depth: 1, ...(cursor ? { cursor } : {}), ...repoArg(repo) };
}

/** The days that have a stream document, newest first (following the cursor; a missing folder is no days). */
export async function fetchStreamDays(caller: Caller, repo: string | null): Promise<string[]> {
  const days: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: Wire = await caller.call<Wire>("docs_tree", streamTreeArgs(repo, cursor));
    const entries = Array.isArray(page.entries) ? (page.entries as Wire[]) : [];
    for (const e of entries) {
      const day = streamDay(str(e.path));
      if (e.kind === "doc" && day) days.push(day);
    }
    cursor = page.truncated === true && typeof page.cursor === "string" ? page.cursor : null;
  } while (cursor && ++pages < 20);
  return days.sort().reverse();
}

/** One day's transitions; a day without a document has none. */
export async function fetchStreamDay(caller: Caller, day: string, repo: string | null): Promise<Transition[]> {
  try {
    const doc = await caller.call<Wire>("docs_read", { path: `${STREAM_DIR}${day}.md`, ...repoArg(repo) });
    return parseStream(str(doc.raw), day);
  } catch (e) {
    if (e instanceof OmgError && e.code === "doc_missing") return [];
    throw e;
  }
}
