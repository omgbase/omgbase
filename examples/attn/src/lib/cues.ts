// Cues: something to come back to mind under relevant circumstances — a
// trigger plus a payload. A cue never steals focus; it is OFFERED, and
// "what should resurface" is computed, not stored:
//
//   trigger: focus   the cue's `when` is an OQX predicate over the newly focused
//                    intent's row, evaluated as ONE query per cue wrapped around
//                    that row — `docs exists { where path == "<focused>" and (<when>) }`
//                    — so user text that does not parse is the engine's
//                    `filter_invalid`, reported per cue, never a crash;
//   trigger: time    `at` ≤ the client clock (OQX has no now(); the app injects it);
//   trigger: query   the ```oqx fence in the body is run after each changes_since
//                    poll and its ids diffed against a checkpoint kept in
//                    localStorage — ids ENTERING the set fire the cue.
//
// Delivery state (fired, snoozed, checkpoints) is app-local, in `Delivery`,
// never in the repository; a cue fires once per (cue, focus episode).

import { OmgError, type Caller, type Wire } from "./mcp-client.ts";
import { CUES_DIR, proseOf, str, strOrNull, type CueStatus, type CueTrigger } from "./model.ts";
import { queryAll, runQuery } from "./query.ts";
import type { Effect } from "./writes.ts";

export interface Cue {
  id: string;
  path: string;
  title: string;
  /** The intent the cue belongs to (its path). */
  intent: string;
  trigger: CueTrigger;
  status: CueStatus;
  /** `trigger: focus` — the predicate as authored. */
  when: string | null;
  /** `trigger: time` — the ISO timestamp as authored. */
  at: string | null;
  /** `trigger: query` — the OQX from the body's ```oqx fence. */
  query: string | null;
  /** The cue's text (the body without its title and fences). */
  text: string;
}

export const CUES_QUERY = `select path, title, intent, trigger, status, when, at, raw from docs where type == "cue" and path.startsWith(${JSON.stringify(CUES_DIR)})`;

/** The OQX inside the first ```oqx fence of a document, or null. */
export function extractOqxFence(raw: string): string | null {
  const m = /```oqx[ \t]*\n([\s\S]*?)\n```/.exec(raw);
  return m ? m[1]!.trim() : null;
}

export function cueOf(hit: Record<string, unknown>): Cue {
  const raw = str(hit.raw);
  const trigger = hit.trigger === "time" || hit.trigger === "query" ? hit.trigger : "focus";
  return {
    id: str(hit.id),
    path: str(hit.path),
    title: str(hit.title) || str(hit.path).replace(/^.*\//, "").replace(/\.md$/, ""),
    intent: str(hit.intent),
    trigger,
    status: hit.status === "dismissed" ? "dismissed" : "active",
    when: strOrNull(hit.when),
    at: strOrNull(hit.at),
    query: extractOqxFence(raw),
    text: proseOf(raw),
  };
}

export async function fetchCues(caller: Caller, repo: string | null): Promise<Cue[]> {
  const page = await runQuery(caller, CUES_QUERY, { repo, limit: 500 });
  return page.hits.map(cueOf).sort((a, b) => a.title.localeCompare(b.title));
}

/** `set frontmatter.status = dismissed` on a cue. */
export function dismissCueEffect(path: string): Effect {
  return { op: "set", target: path, field: "frontmatter.status", value: "dismissed" };
}

// ---- evaluation ------------------------------------------------------------------------------

/** The focus-cue query: the predicate wrapped around the focused intent's row, as an `exists` scalar. */
export function focusCueQuery(focused: string, when: string): string {
  return `docs exists { where path == ${JSON.stringify(focused)} and (${when}) }`;
}

export interface CueError {
  code: string;
  message: string;
  /** The engine's `data.hint` (`OQX` for a predicate that does not parse). */
  hint: string | null;
}

export interface FocusEvaluation {
  cue: Cue;
  fired: boolean;
  /** The engine's error for this cue's predicate (a `filter_invalid`, typically), or null. */
  error: CueError | null;
}

export function cueErrorOf(e: unknown): CueError {
  if (e instanceof OmgError) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    return { code: e.code, message: e.message, hint: typeof data.hint === "string" ? data.hint : null };
  }
  return { code: "error", message: e instanceof Error ? e.message : String(e), hint: null };
}

/** Evaluate every active `trigger: focus` cue against the newly focused intent — one `query` per cue. */
export async function evaluateFocusCues(caller: Caller, cues: readonly Cue[], focused: string, repo: string | null): Promise<FocusEvaluation[]> {
  const out: FocusEvaluation[] = [];
  for (const cue of cues) {
    if (cue.trigger !== "focus" || cue.status !== "active" || !cue.when) continue;
    try {
      const r = await runQuery(caller, focusCueQuery(focused, cue.when), { repo });
      out.push({ cue, fired: r.exists === true, error: null });
    } catch (e) {
      out.push({ cue, fired: false, error: cueErrorOf(e) });
    }
  }
  return out;
}

/** The active `trigger: time` cues whose `at` is at or before the clock. An `at` that is not a date never fires. */
export function dueTimeCues(cues: readonly Cue[], now: string): Cue[] {
  const t = Date.parse(now);
  return cues.filter((c) => {
    if (c.trigger !== "time" || c.status !== "active" || !c.at) return false;
    const at = Date.parse(c.at);
    return Number.isFinite(at) && at <= t;
  });
}

export interface QueryDelta {
  cue: Cue;
  /** The membership set now (hit ids, sorted). */
  ids: string[];
  /** Ids that were not in the checkpoint; empty on the first run (the checkpoint is taken, nothing fires). */
  entered: string[];
  /** `{ id, path }` of the entered hits, for the message. */
  enteredHits: { id: string; path: string }[];
  error: CueError | null;
}

/** Run a `trigger: query` cue's OQX and diff the ids against the checkpoint (null = never run). */
export async function queryCueDelta(caller: Caller, cue: Cue, checkpoint: readonly string[] | null, repo: string | null): Promise<QueryDelta> {
  if (!cue.query) return { cue, ids: checkpoint ? [...checkpoint] : [], entered: [], enteredHits: [], error: { code: "no_query", message: "the cue has no ```oqx fence", hint: null } };
  try {
    const hits = await queryAll(caller, cue.query, repo);
    const ids = [...new Set(hits.map((h) => str(h.id)).filter(Boolean))].sort();
    if (checkpoint === null) return { cue, ids, entered: [], enteredHits: [], error: null };
    const seen = new Set(checkpoint);
    const entered = ids.filter((id) => !seen.has(id));
    const enteredHits = hits.filter((h) => entered.includes(str(h.id))).map((h) => ({ id: str(h.id), path: str(h.path) }));
    return { cue, ids, entered, enteredHits, error: null };
  } catch (e) {
    return { cue, ids: checkpoint ? [...checkpoint] : [], entered: [], enteredHits: [], error: cueErrorOf(e) };
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
  /** `<cue path>|<scope>` → when it fired (ISO). The scope is the focus episode for focus cues, `time:<at>` for time cues, `id:<entered id>` for query cues. */
  fired: Record<string, string>;
  /** `<cue path>` → the episode key during which it was snoozed (it stays quiet until the episode changes). */
  snoozed: Record<string, string>;
  /** `<cue path>` → the ids last seen by a query cue. */
  checkpoints: Record<string, string[]>;
}

/** The scope a firing is deduped on. */
export function firingScope(cue: Cue, episode: string | null, enteredId?: string): string {
  if (cue.trigger === "time") return `time:${cue.at ?? ""}`;
  if (cue.trigger === "query") return `id:${enteredId ?? ""}`;
  return `episode:${episode ?? "none"}`;
}

export class Delivery {
  private state: DeliveryState;

  constructor(private readonly storage: StorageLike = new MemoryStorage(), private readonly key = DELIVERY_KEY) {
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

  /** Has this cue already fired in this scope? */
  hasFired(cue: Cue, scope: string): boolean {
    return `${cue.path}|${scope}` in this.state.fired;
  }

  markFired(cue: Cue, scope: string, now: string): void {
    this.state.fired[`${cue.path}|${scope}`] = now;
    this.save();
  }

  /** Quiet until the next focus boundary: snoozed during this episode (the key), offered again when it changes. */
  snooze(cue: Cue, episode: string | null): void {
    this.state.snoozed[cue.path] = episode ?? "none";
    this.save();
  }

  isSnoozed(cue: Cue, episode: string | null): boolean {
    return this.state.snoozed[cue.path] === (episode ?? "none");
  }

  checkpoint(cue: Cue): string[] | null {
    return this.state.checkpoints[cue.path] ?? null;
  }

  setCheckpoint(cue: Cue, ids: readonly string[]): void {
    this.state.checkpoints[cue.path] = [...ids];
    this.save();
  }

  /** Should a firing in this scope be offered now? Not when it already fired there, nor while snoozed in this episode. */
  shouldOffer(cue: Cue, scope: string, episode: string | null): boolean {
    return cue.status === "active" && !this.hasFired(cue, scope) && !this.isSnoozed(cue, episode);
  }
}

export interface FiredCue {
  cue: Cue;
  /** Why it fired, in words. */
  reason: string;
  scope: string;
  firedAt: string;
}

/** A `query` result page as the server spells it (tests). */
export function cuesPage(hits: Wire[]): Wire {
  return { hits, truncated: false, cursor: null, consumer: "collect" };
}
