// Intents as rows: one `query` over `docs` whose `type` is the intent type,
// most recently edited first, each row carrying its `cues` list and the
// VIRTUAL `#focus` — no intent is ever tagged as focused; the focused one is
// found by a correlated join against the pointer document:
//
//   focus: ^docs first { select since where _path == "/attn/focus.md" and focused_intent == ^_path }
//
// reads, for each intent row, the pointer's `since` when the pointer's
// `focused_intent` names this row's path (`^_path` is the enclosing intent's
// path), and null otherwise. Names follow surface 5.0 ("underscore = engine"):
// `_path`, `_id`, `_updated_at` are the engine's; `title`, `tags`, `status`,
// `project`, `cues`, `focused_intent`, `since` are attn's own frontmatter keys
// and stay bare (an intent always carries an authored `title`, so the bare key
// — not the computed `_title` — is the one meant). The where-form of the same join — the one row in
// focus — is `VIRTUAL_FOCUS_QUERY`. Also here: the feed's sections (the Cued
// lift, recent, released), the chooser's ranking, and the intent edits
// (status, content).

import { cuesOf, type Cue } from "./cues.ts";
import type { Caller, Wire } from "./mcp-client.ts";
import { INTENTS_DIR, INTENT_TYPE, POINTER_PATH, record, str, strList, strOrNull, type IntentStatus } from "./model.ts";
import { runQuery } from "./query.ts";
import type { Effect } from "./writes.ts";

export interface Intent {
  id: string;
  path: string;
  title: string;
  status: IntentStatus;
  tags: string[];
  project: string | null;
  /** The pointer's `since` when this intent is in focus (the virtual #focus), else null. */
  focusSince: string | null;
  updatedAt: string | null;
  /** The intent's embedded cues (its `cues` frontmatter list). */
  cues: Cue[];
}

/** Every intent (active and released), most recently edited first, with its cues and the virtual `#focus` column. */
export const INTENTS_QUERY = `select _path, title, status, tags, project, _updated_at, cues, focus: ^docs first { select since where _path == ${JSON.stringify(POINTER_PATH)} and focused_intent == ^_path } from docs where type == ${JSON.stringify(INTENT_TYPE)} and _path.startsWith(${JSON.stringify(INTENTS_DIR)}) order by _updated_at desc`;

/** The intent in focus, as a semi-join — the README's one-row form of the virtual `#focus`. */
export const VIRTUAL_FOCUS_QUERY = `select _path, title, status, tags from docs where type == ${JSON.stringify(INTENT_TYPE)} and status == "active" and ^docs exists { where _path == ${JSON.stringify(POINTER_PATH)} and focused_intent == ^_path }`;

export function intentOf(hit: Record<string, unknown>): Intent {
  const focus = record(hit.focus);
  const path = str(hit._path);
  return {
    id: str(hit._id),
    path,
    title: str(hit.title) || path.replace(/^.*\//, "").replace(/\.md$/, ""),
    status: hit.status === "released" ? "released" : "active",
    tags: strList(hit.tags),
    project: strOrNull(hit.project),
    focusSince: strOrNull(focus.since),
    updatedAt: strOrNull(hit._updated_at),
    cues: cuesOf(path, hit.cues),
  };
}

/** Most recently edited first (the feed's order), ties by title. */
export function sortByEdited(intents: readonly Intent[]): Intent[] {
  return [...intents].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.title.localeCompare(b.title));
}

export async function fetchIntents(caller: Caller, repo: string | null): Promise<Intent[]> {
  const page = await runQuery(caller, INTENTS_QUERY, { repo, limit: 500 });
  return sortByEdited(page.hits.map(intentOf));
}

/** Every cue of the ACTIVE intents (a released intent's cues do not fire). */
export function activeCues(intents: readonly Intent[]): Cue[] {
  return intents.filter((i) => i.status === "active").flatMap((i) => i.cues);
}

// ---- the feed ---------------------------------------------------------------------------------

export interface CuedIntent { intent: Intent; why: string[] }

export interface Feed {
  /** Active intents a cue lifted, deduped by intent, most recently edited first; never the focused one. */
  cued: CuedIntent[];
  /** The rest of the active intents, most recently edited first; never the focused one. */
  recent: Intent[];
  /** Hidden behind the toggle. */
  released: Intent[];
}

/** The feed's sections: the focused intent is shown in the bar, never sorted in; cued intents are lifted out of recent. */
export function feedOf(intents: readonly Intent[], focused: string | null, cued: ReadonlyMap<string, string[]>): Feed {
  const ordered = sortByEdited(intents);
  const feed: Feed = { cued: [], recent: [], released: [] };
  for (const i of ordered) {
    if (i.status === "released") { feed.released.push(i); continue; }
    if (i.path === focused) continue;
    const why = cued.get(i.path);
    if (why && why.length) feed.cued.push({ intent: i, why });
    else feed.recent.push(i);
  }
  return feed;
}

// ---- the edits ----------------------------------------------------------------------------------

/** `set _frontmatter.status = released | active` on an intent — a bare rooted path is the document target. */
export function setStatusEffect(path: string, status: IntentStatus): Effect {
  return { op: "set", target: path, field: "_frontmatter.status", value: status };
}

/** `set content` — the whole document's bytes (frontmatter and body); the one edit that legitimately moves `_updated_at`. */
export function setContentEffect(path: string, content: string): Effect {
  return { op: "set", target: path, field: "content", value: content };
}

// ---- the chooser -----------------------------------------------------------------------------

/** A subsequence match score: higher is better, 0 is no match. Word-start hits
 * and contiguous runs count more; an empty query matches everything at 1. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (q === "") return 1;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return 0;
    const wordStart = at === 0 || /[\s\-_/.,]/.test(t[at - 1]!);
    run = at === ti ? run + 1 : 1;
    score += 1 + (wordStart ? 2 : 0) + run;
    ti = at + 1;
  }
  return score + Math.max(0, 20 - t.length) / 20;
}

export interface ChooserRow {
  intent: Intent;
  /** When it last had focus (from the history), or null. */
  lastFocused: string | null;
}

/** The chooser's rows: active intents that match the query, most recently
 * focused first (the history supplies `recent`: intent path → last ISO), then by score. */
export function rankIntents(intents: readonly Intent[], recent: ReadonlyMap<string, string>, query: string, limit = 8): ChooserRow[] {
  return intents
    .filter((i) => i.status === "active")
    .map((i) => ({ intent: i, score: fuzzyScore(query, `${i.title} ${i.tags.map((t) => `#${t}`).join(" ")}`), lastFocused: recent.get(i.path) ?? null }))
    .filter((r) => r.score > 0)
    .sort((a, b) => {
      if (query.trim() !== "" && a.score !== b.score) return b.score - a.score;
      if ((a.lastFocused ?? "") !== (b.lastFocused ?? "")) return (b.lastFocused ?? "").localeCompare(a.lastFocused ?? "");
      return a.intent.title.localeCompare(b.intent.title);
    })
    .slice(0, limit)
    .map(({ intent, lastFocused }) => ({ intent, lastFocused }));
}

/** An intent whose title equals the text (case-insensitively, tags aside), so Enter resumes it instead of declaring a twin. */
export function findByTitle(intents: readonly Intent[], title: string): Intent | null {
  const t = title.trim().toLowerCase();
  return intents.find((i) => i.title.trim().toLowerCase() === t) ?? null;
}

/** The result as the wire spells it, for tests and the scripted server. */
export function intentsPage(hits: Wire[]): Wire {
  return { hits, truncated: false, cursor: null, consumer: "collect" };
}
