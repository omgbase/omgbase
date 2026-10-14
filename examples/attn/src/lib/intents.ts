// Intents as rows: one `query` over `docs` whose `type == "intent"`, with the
// VIRTUAL `#focus` — no intent is ever tagged as focused; the focused one is
// found by a correlated join against the pointer document:
//
//   focus: ^docs first { select since where path == "/attn/current.md" and focused == ^path }
//
// reads, for each intent row, the pointer's `since` when the pointer's
// `focused` names this row's path (`^path` is the enclosing intent's path), and
// absent otherwise. The where-form of the same join — the one row in focus —
// is `VIRTUAL_FOCUS_QUERY`. Also here: the fuzzy chooser's ranking and the
// release / reactivate effects.

import type { Caller, Wire } from "./mcp-client.ts";
import { INTENTS_DIR, POINTER_PATH, str, strList, strOrNull, type IntentStatus } from "./model.ts";
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
}

/** Every intent (active and released) with the virtual `#focus` column. */
export const INTENTS_QUERY = `select path, title, status, tags, project, updated_at, focus: ^docs first { select since where path == ${JSON.stringify(POINTER_PATH)} and focused == ^path } from docs where type == "intent" and path.startsWith(${JSON.stringify(INTENTS_DIR)})`;

/** The intent in focus, as a semi-join — the README's one-row form of the virtual `#focus`. */
export const VIRTUAL_FOCUS_QUERY = `select path, title, status, tags from docs where type == "intent" and status == "active" and ^docs exists { where path == ${JSON.stringify(POINTER_PATH)} and focused == ^path }`;

const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function intentOf(hit: Record<string, unknown>): Intent {
  const focus = record(hit.focus);
  return {
    id: str(hit.id),
    path: str(hit.path),
    title: str(hit.title) || str(hit.path).replace(/^.*\//, "").replace(/\.md$/, ""),
    status: hit.status === "released" ? "released" : "active",
    tags: strList(hit.tags),
    project: strOrNull(hit.project),
    focusSince: strOrNull(focus.since),
    updatedAt: strOrNull(hit.updated_at),
  };
}

/** Focused first, then active before released, then by title. */
export function sortIntents(intents: readonly Intent[]): Intent[] {
  return [...intents].sort((a, b) => {
    if ((a.focusSince !== null) !== (b.focusSince !== null)) return a.focusSince !== null ? -1 : 1;
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

export async function fetchIntents(caller: Caller, repo: string | null): Promise<Intent[]> {
  const page = await runQuery(caller, INTENTS_QUERY, { repo, limit: 500 });
  return sortIntents(page.hits.map(intentOf));
}

/** `set frontmatter.status = released | active` on an intent — a bare rooted path is the document target. */
export function setStatusEffect(path: string, status: IntentStatus): Effect {
  return { op: "set", target: path, field: "frontmatter.status", value: status };
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
  /** When it last had focus (from the stream), or null. */
  lastFocused: string | null;
}

/** The chooser's rows: active intents that match the query, most recently
 * focused first (the stream's transitions supply `recent`: intent path → last ISO), then by score. */
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
