// The Stream: focus episodes with durations, RECONSTRUCTED READ-ONLY from the
// pointer's revisions — nothing is logged on a switch; the sequence of pointer
// states IS the episode history, and the open episode's start is the current
// `since`. With what omgbase already has:
//
//   select rev, seq, ts from revisions where path == "/attn/focus.md" order by seq
//   docs_read { path: "/attn/focus.md", at: <rev> }      per revision → raw → focused_intent / since / return_stack
//
// (`docs_read { at }` carries no `properties`, so the frontmatter is read from
// `raw` by model.ts's small grammar.) Revisions are immutable, so every state
// is cached by its rev and only new revisions are read. Each state's `since`
// is when the switch happened (the client clock at the switch); the next
// state's `since` ends the episode; the kind of a transition is inferred from
// the stack: grown → interrupt, shrunk → back, focus null → stop, else switch.
// This is reconstruction, not a stream of transition rows: a switch made and
// unmade between two reads leaves no trace, and precise time tracking would
// record transitions separately (the design note's position).

import { repoArg, type Caller, type Wire } from "./mcp-client.ts";
import { POINTER_PATH, dayEnd, dayOf, frontmatterOf, secondsBetween, str, type TransitionKind } from "./model.ts";
import { pointerStateOf, type PointerState } from "./pointer.ts";
import { queryAll } from "./query.ts";

export interface PointerRevision {
  rev: string;
  seq: number;
  /** The commit's time (ISO). */
  ts: string;
}

export interface PointerSnapshot extends PointerRevision, PointerState {}

/** The pointer's revisions, oldest first. */
export const REVISIONS_QUERY = `select rev, seq, ts from revisions where path == ${JSON.stringify(POINTER_PATH)} order by seq`;

export async function fetchPointerRevisions(caller: Caller, repo: string | null): Promise<PointerRevision[]> {
  const hits = await queryAll(caller, REVISIONS_QUERY, repo);
  return hits
    .map((h) => ({ rev: str(h.rev) || str(h.id), seq: typeof h.seq === "number" ? h.seq : Number(h.seq), ts: str(h.ts) }))
    .filter((r) => r.rev)
    .sort((a, b) => a.seq - b.seq);
}

/** `docs_read { path, at: rev }` → the pointer's state as of that revision (its raw frontmatter, read by model.ts). */
export async function readPointerAt(caller: Caller, revision: PointerRevision, repo: string | null): Promise<PointerSnapshot> {
  const doc = await caller.call<Wire>("docs_read", { path: POINTER_PATH, at: revision.rev, ...repoArg(repo) });
  return { ...revision, ...pointerStateOf(frontmatterOf(str(doc.raw))) };
}

/** The cache: rev → snapshot. Revisions are immutable, so an entry never goes stale. */
export type HistoryCache = Map<string, PointerSnapshot>;

/** The whole history: one `query` for the revisions, one `docs_read { at }` per revision not yet cached. */
export async function fetchPointerHistory(caller: Caller, repo: string | null, cache: HistoryCache = new Map()): Promise<PointerSnapshot[]> {
  const revisions = await fetchPointerRevisions(caller, repo);
  const fresh = await Promise.all(revisions.filter((r) => !cache.has(r.rev)).map((r) => readPointerAt(caller, r, repo)));
  for (const s of fresh) cache.set(s.rev, s);
  return revisions.map((r) => cache.get(r.rev)!);
}

// ---- states → transitions → episodes -------------------------------------------------------------

export interface Transition {
  /** When it happened (ISO): the state's `since`, else the commit's `ts`. */
  at: string;
  /** The intent that took focus, null for a stop. */
  target: string | null;
  kind: TransitionKind;
  rev: string;
}

/** The kind of the step from one pointer state to the next, by what changed (the first state is a switch: nothing displaced it). */
export function kindOf(prev: PointerState | null, next: PointerState): TransitionKind {
  if (!next.focused) return "stop";
  if (!prev) return "switch";
  const before = prev.returnStack.length;
  if (next.returnStack.length > before) return "interrupt";
  if (next.returnStack.length < before) return "back";
  return "switch";
}

/** Consecutive pointer states → the transitions between them. A state whose
 * focus and `since` equal the previous one's (a revision that changed something
 * else, or nothing) is not a transition. */
export function transitionsOf(states: readonly PointerSnapshot[]): Transition[] {
  const out: Transition[] = [];
  let prev: PointerSnapshot | null = null;
  for (const s of states) {
    if (prev && prev.focused === s.focused && prev.since === s.since) { prev = s; continue; }
    if (!prev && !s.focused && !s.since) { prev = s; continue; } // a fresh pointer with nothing in focus is not a stop
    out.push({ at: s.since ?? s.ts, target: s.focused, kind: kindOf(prev, s), rev: s.rev });
    prev = s;
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
  /** What ended it: the next transition, the clock (still in focus), or the day's end (the view is clipped to a day). */
  endedBy: "transition" | "now" | "day-end";
  /** The episode began before the day shown. */
  carried: boolean;
}

/** Every episode over the whole history: each ends at the next transition, the last at the clock. */
export function episodesOf(transitions: readonly Transition[], now: string): Episode[] {
  const out: Episode[] = [];
  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i]!;
    if (!t.target) continue;
    const next = transitions[i + 1];
    const end = next ? next.at : now;
    out.push({ intent: t.target, start: t.at, end: end < t.at ? t.at : end, seconds: secondsBetween(t.at, end), kind: t.kind, endedBy: next ? "transition" : "now", carried: false });
  }
  return out;
}

/** One UTC day's view: the episodes clipped to the day (a focus that began the day before is `carried`). */
export function episodesOn(episodes: readonly Episode[], day: string): Episode[] {
  const start = `${day}T00:00:00.000Z`;
  const end = dayEnd(day);
  const out: Episode[] = [];
  for (const e of episodes) {
    if (e.end <= start || e.start >= end) continue;
    const s = e.start < start ? start : e.start;
    const clipped = e.end > end;
    const f = clipped ? end : e.end;
    out.push({ ...e, start: s, end: f, seconds: secondsBetween(s, f), endedBy: clipped ? "day-end" : e.endedBy, carried: e.start < start });
  }
  return out;
}

/** The UTC days the history covers (every day from the first transition to `now`), newest first. */
export function daysOf(transitions: readonly Transition[], now: string): string[] {
  if (transitions.length === 0) return [dayOf(now)];
  const first = dayOf(transitions[0]!.at);
  const last = dayOf(now);
  const out: string[] = [];
  for (let d = first; d <= last && out.length < 400; d = dayOf(dayEnd(d))) out.push(d);
  if (!out.includes(last)) out.push(last);
  return out.reverse();
}

/** Seconds per tag over episodes; `tagsOf` maps an intent path to its tags (an intent with none counts under `untagged`). */
export function tagTotals(episodes: readonly Episode[], tagsOf: (intent: string) => readonly string[]): { tag: string; seconds: number }[] {
  const totals = new Map<string, number>();
  for (const e of episodes) {
    const tags = tagsOf(e.intent);
    for (const tag of tags.length ? tags : ["untagged"]) totals.set(tag, (totals.get(tag) ?? 0) + e.seconds);
  }
  return [...totals].map(([tag, seconds]) => ({ tag, seconds })).sort((a, b) => b.seconds - a.seconds || a.tag.localeCompare(b.tag));
}

/** Seconds per intent over episodes, most first. */
export function intentTotals(episodes: readonly Episode[]): { intent: string; seconds: number }[] {
  const totals = new Map<string, number>();
  for (const e of episodes) totals.set(e.intent, (totals.get(e.intent) ?? 0) + e.seconds);
  return [...totals].map(([intent, seconds]) => ({ intent, seconds })).sort((a, b) => b.seconds - a.seconds || a.intent.localeCompare(b.intent));
}

/** Intent path → the last moment it took focus (the chooser's recency). */
export function lastFocused(transitions: readonly Transition[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of transitions) if (t.target && (out.get(t.target) ?? "") < t.at) out.set(t.target, t.at);
  return out;
}
