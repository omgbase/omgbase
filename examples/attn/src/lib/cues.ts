// Cues: something to come back to mind under relevant circumstances. A cue is
// NOT a document — it is one entry of its intent's `cues` frontmatter list, a
// value object with an intent-local stable `id`, an `on` variant and its
// definition:
//
//   on: focus         `query` — a whole OQX query over docs; the cue matches when the
//                     NEWLY FOCUSED intent is a member of its result set (the query is run
//                     as given and the focused intent's path / id looked for among the hits)
//   on: time          `at` ≤ now (the client clock; OQX has no now())
//   on: query-enter   `query` — ids ENTERING its membership set since the last checkpoint
//   on: query-exit    `query` — ids LEAVING it (checkpoint key = intent path + cue id, in
//                     localStorage; the first evaluation baselines silently)
//
// A matching cue makes its intent eligible for the Cued section; it never
// changes focus and never writes anything. Delivery state (fired, snoozed,
// checkpoints) is app-local, in `Delivery`; a firing is deduplicated per
// (intent, cue id, focus episode). Editing the cue DEFINITIONS is the one
// write: `set frontmatter.cues` with the whole list (lib/writes.ts uses it).

import { OmgError, type Caller } from "./mcp-client.ts";
import { CUE_ONS, record, str, strOrNull, type CueOn } from "./model.ts";
import { queryAll } from "./query.ts";
import type { Effect } from "./writes.ts";

export interface Cue {
  /** The owning intent's path. */
  intent: string;
  /** Intent-local, stable. */
  id: string;
  on: CueOn;
  /** `on: focus | query-enter | query-exit` — the OQX as authored (a `query: |` block keeps its newlines). */
  query: string | null;
  /** `on: time` — the ISO timestamp as authored. */
  at: string | null;
}

/** The identity delivery state keys on: the intent path + the cue id. */
export function cueKey(cue: Pick<Cue, "intent" | "id">): string {
  return `${cue.intent}#${cue.id}`;
}

/** A `cues` value as a `query` hit carries it → the cues. A frontmatter list
 * of maps projects as a one-element list wrapping the list (`[[{…}, {…}]]`),
 * where a list of scalars (`tags`) projects flat — both shapes are read.
 * Entries without an `id` or with an unknown `on` are skipped. */
export function cuesOf(intent: string, value: unknown): Cue[] {
  let list: unknown[] = Array.isArray(value) ? value : [];
  if (list.length === 1 && Array.isArray(list[0])) list = list[0] as unknown[];
  const out: Cue[] = [];
  for (const entry of list) {
    const r = record(entry);
    const id = str(r.id);
    const on = str(r.on) as CueOn;
    if (!id || !CUE_ONS.includes(on)) continue;
    out.push({ intent, id, on, query: strOrNull(r.query), at: strOrNull(r.at) });
  }
  return out;
}

/** A cue as the frontmatter spells it: `{ id, on, query | at }`. A query gets a
 * trailing newline so the engine composes it as a `query: |` block scalar. */
export function wireCue(cue: Pick<Cue, "id" | "on" | "query" | "at">): Record<string, unknown> {
  const out: Record<string, unknown> = { id: cue.id, on: cue.on };
  if (cue.on === "time") { if (cue.at) out.at = cue.at; }
  else if (cue.query) out.query = cue.query.replace(/\s+$/, "") + "\n";
  return out;
}

/** The one cue write: the intent's WHOLE `cues` list (`set frontmatter.cues`), or `unset` when none remain. */
export function setCuesEffect(intent: string, cues: readonly Pick<Cue, "id" | "on" | "query" | "at">[]): Effect {
  if (cues.length === 0) return { op: "unset", target: intent, field: "frontmatter.cues" };
  return { op: "set", target: intent, field: "frontmatter.cues", value: cues.map(wireCue) };
}

// ---- evaluation ------------------------------------------------------------------------------

export interface CueError {
  code: string;
  message: string;
  /** The engine's `data.hint` (`OQX` for a query that does not parse). */
  hint: string | null;
}

export function cueErrorOf(e: unknown): CueError {
  if (e instanceof OmgError) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    return { code: e.code, message: e.message, hint: typeof data.hint === "string" ? data.hint : null };
  }
  return { code: "error", message: e instanceof Error ? e.message : String(e), hint: null };
}

export interface FocusedRef { path: string; id: string | null }

/** Is the focused intent a member of a cue query's result set? By path, or by id when the row carries no path. */
export function isMember(hits: readonly Record<string, unknown>[], focused: FocusedRef): boolean {
  return hits.some((h) => str(h.path) === focused.path || (focused.id !== null && str(h.id) === focused.id));
}

export interface FocusEvaluation {
  cue: Cue;
  matched: boolean;
  /** The engine's error for this cue's query (a `filter_invalid`, typically), or null. */
  error: CueError | null;
}

/** Every `on: focus` cue of the given intents against the newly focused intent — one
 * `query` per cue, run as authored; the cue matches when the focused intent is among the hits. */
export async function evaluateFocusCues(caller: Caller, cues: readonly Cue[], focused: FocusedRef, repo: string | null): Promise<FocusEvaluation[]> {
  const out: FocusEvaluation[] = [];
  for (const cue of cues) {
    if (cue.on !== "focus") continue;
    if (!cue.query) { out.push({ cue, matched: false, error: { code: "no_query", message: "the cue has no `query`", hint: null } }); continue; }
    try {
      const hits = await queryAll(caller, cue.query, repo);
      out.push({ cue, matched: isMember(hits, focused), error: null });
    } catch (e) {
      out.push({ cue, matched: false, error: cueErrorOf(e) });
    }
  }
  return out;
}

/** The `on: time` cues whose `at` is at or before the clock. An `at` that is not a date never fires. */
export function dueTimeCues(cues: readonly Cue[], now: string): Cue[] {
  const t = Date.parse(now);
  return cues.filter((c) => {
    if (c.on !== "time" || !c.at) return false;
    const at = Date.parse(c.at);
    return Number.isFinite(at) && at <= t;
  });
}

export interface QueryDelta {
  cue: Cue;
  /** The membership set now (hit ids, sorted). */
  ids: string[];
  /** Ids not in the checkpoint; empty on the first run (the checkpoint is taken, nothing fires). */
  entered: string[];
  /** Ids in the checkpoint that are gone. */
  exited: string[];
  /** The ids the cue's variant watches (`entered` for query-enter, `exited` for query-exit), with the path when known. */
  fires: { id: string; path: string | null }[];
  error: CueError | null;
}

/** Run a `query-enter` / `query-exit` cue's OQX and diff the ids against the checkpoint (null = never run). */
export async function queryTransitionDelta(caller: Caller, cue: Cue, checkpoint: readonly string[] | null, repo: string | null): Promise<QueryDelta> {
  const kept = checkpoint ? [...checkpoint] : [];
  if (!cue.query) return { cue, ids: kept, entered: [], exited: [], fires: [], error: { code: "no_query", message: "the cue has no `query`", hint: null } };
  try {
    const hits = await queryAll(caller, cue.query, repo);
    const paths = new Map(hits.map((h) => [str(h.id), strOrNull(h.path)]));
    const ids = [...new Set(hits.map((h) => str(h.id)).filter(Boolean))].sort();
    if (checkpoint === null) return { cue, ids, entered: [], exited: [], fires: [], error: null };
    const before = new Set(checkpoint);
    const now = new Set(ids);
    const entered = ids.filter((id) => !before.has(id));
    const exited = [...checkpoint].filter((id) => !now.has(id)).sort();
    const watched = cue.on === "query-exit" ? exited : entered;
    return { cue, ids, entered, exited, fires: watched.map((id) => ({ id, path: paths.get(id) ?? null })), error: null };
  } catch (e) {
    return { cue, ids: kept, entered: [], exited: [], fires: [], error: cueErrorOf(e) };
  }
}

// ---- delivery state (app-local) ---------------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** An in-memory stand-in for localStorage (tests, SSR). */
export class MemoryStorage implements StorageLike {
  private m = new Map<string, string>();
  getItem(key: string): string | null { return this.m.get(key) ?? null; }
  setItem(key: string, value: string): void { this.m.set(key, value); }
}

export const DELIVERY_KEY = "omgbase-attn.delivery";

interface DeliveryState {
  /** `<cue key>|<scope>` → when it fired (ISO). The scope is the focus episode for focus cues, `time:<at>` for time cues, `id:<x>` for enter/exit cues. */
  fired: Record<string, string>;
  /** `<cue key>` → the episode key during which it was snoozed (quiet until the episode changes). */
  snoozed: Record<string, string>;
  /** `<cue key>` → the ids last seen by an enter/exit cue (the checkpoint). */
  checkpoints: Record<string, string[]>;
}

/** The scope a firing is deduped on. */
export function firingScope(cue: Cue, episode: string | null, id?: string): string {
  if (cue.on === "time") return `time:${cue.at ?? ""}`;
  if (cue.on === "query-enter" || cue.on === "query-exit") return `${cue.on === "query-exit" ? "exit" : "enter"}:${id ?? ""}`;
  return `episode:${episode ?? "none"}`;
}

export class Delivery {
  private state: DeliveryState;
  private readonly storage: StorageLike;
  private readonly key: string;

  constructor(storage: StorageLike = new MemoryStorage(), key = DELIVERY_KEY) {
    this.storage = storage;
    this.key = key;
    this.state = Delivery.load(storage, key);
  }

  private static load(storage: StorageLike, key: string): DeliveryState {
    const empty: DeliveryState = { fired: {}, snoozed: {}, checkpoints: {} };
    try {
      const raw = storage.getItem(key);
      if (!raw) return empty;
      const parsed = JSON.parse(raw) as Partial<DeliveryState>;
      return { fired: parsed.fired ?? {}, snoozed: parsed.snoozed ?? {}, checkpoints: parsed.checkpoints ?? {} };
    } catch {
      return empty;
    }
  }

  private save(): void {
    this.storage.setItem(this.key, JSON.stringify(this.state));
  }

  hasFired(cue: Cue, scope: string): boolean {
    return `${cueKey(cue)}|${scope}` in this.state.fired;
  }

  markFired(cue: Cue, scope: string, now: string): void {
    this.state.fired[`${cueKey(cue)}|${scope}`] = now;
    this.save();
  }

  /** Quiet until the next focus boundary: snoozed during this episode (the key), offered again when it changes. */
  snooze(cue: Cue, episode: string | null): void {
    this.state.snoozed[cueKey(cue)] = episode ?? "none";
    this.save();
  }

  isSnoozed(cue: Cue, episode: string | null): boolean {
    return this.state.snoozed[cueKey(cue)] === (episode ?? "none");
  }

  checkpoint(cue: Cue): string[] | null {
    return this.state.checkpoints[cueKey(cue)] ?? null;
  }

  setCheckpoint(cue: Cue, ids: readonly string[]): void {
    this.state.checkpoints[cueKey(cue)] = [...ids];
    this.save();
  }

  /** Should a firing in this scope be offered now? Not when it already fired there, nor while snoozed in this episode. */
  shouldOffer(cue: Cue, scope: string, episode: string | null): boolean {
    return !this.hasFired(cue, scope) && !this.isSnoozed(cue, episode);
  }
}

export interface FiredCue {
  cue: Cue;
  /** Why now, in words (the cue id and kind). */
  reason: string;
  scope: string;
  firedAt: string;
}

/** The Cued lift: intent path → its "why now" lines, one intent once however many cues matched. */
export function cuedByIntent(fired: readonly FiredCue[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of fired) {
    const list = out.get(f.cue.intent) ?? [];
    if (!list.includes(f.reason)) list.push(f.reason);
    out.set(f.cue.intent, list);
  }
  return out;
}

/** The one-line "why now" of a firing. */
export function whyNow(cue: Cue, detail?: string): string {
  switch (cue.on) {
    case "focus": return `${cue.id} — the focused intent matches its query`;
    case "time": return `${cue.id} — due ${cue.at ?? ""}`.trimEnd();
    case "query-enter": return `${cue.id} — ${detail ?? "a row"} entered its query`;
    case "query-exit": return `${cue.id} — ${detail ?? "a row"} left its query`;
  }
}
