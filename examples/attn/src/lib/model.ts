// The attn storage model's fixed points — where things live under one folder
// of an ordinary omgbase workspace — and the pure text rules: the declaration
// line (`#tags` become tags), slugs, the clock (ISO strings; the day and the
// `HH:MM:SSZ` a stream line carries). Everything is UTC: the stream's days are
// UTC days, so two devices in two time zones write into the same file.
//
//   /attn/intents/<slug>.md      type: intent, status: active | released, tags?, project?
//   /attn/cues/<slug>.md         type: cue, intent, trigger: focus | time | query, status: active | dismissed
//   /attn/current.md             type: attn-state, focused, since, return_stack   (the Focus pointer)
//   /attn/stream/YYYY-MM-DD.md   type: attn-stream — one list item per transition (the Stream)

export const ATTN_ROOT = "/attn";
export const POINTER_PATH = `${ATTN_ROOT}/current.md`;
export const INTENTS_DIR = `${ATTN_ROOT}/intents/`;
export const CUES_DIR = `${ATTN_ROOT}/cues/`;
export const STREAM_DIR = `${ATTN_ROOT}/stream/`;

export type IntentStatus = "active" | "released";
export type CueTrigger = "focus" | "time" | "query";
export type CueStatus = "active" | "dismissed";
/** How a focus transition came about (the word in parentheses on a stream line). */
export type TransitionKind = "switch" | "interrupt" | "back" | "stop";

/** The clock the app injects — OQX has no `now()`, and ISO strings compare lexically. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

/** The UTC day of an ISO timestamp: `2026-10-13T15:02:00.000Z` → `2026-10-13`. */
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** The stream document of an ISO timestamp's day. */
export function streamPath(iso: string): string {
  return `${STREAM_DIR}${dayOf(iso)}.md`;
}

/** The day a stream path names (`/attn/stream/2026-10-13.md` → `2026-10-13`), null for anything else. */
export function streamDay(path: string): string | null {
  const m = /^\/attn\/stream\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path);
  return m ? m[1]! : null;
}

/** The clock a stream line carries: `2026-10-13T15:02:00.000Z` → `15:02:00Z` (whole seconds). */
export function clockOf(iso: string): string {
  return `${iso.slice(11, 19)}Z`;
}

/** The ISO timestamp of a stream line's clock on its day: (`2026-10-13`, `15:02:00Z`) → `2026-10-13T15:02:00.000Z`. */
export function isoOf(day: string, clock: string): string {
  return `${day}T${clock.replace(/Z$/, "")}.000Z`;
}

/** The end of a UTC day, as the first instant of the next one. */
export function dayEnd(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/** Seconds between two ISO timestamps (never negative). */
export function secondsBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
}

/** `1h 05m`, `12m`, `40s` — the durations the focus bar and the stream show. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// ---- the declaration line -------------------------------------------------------------------

export interface Declaration {
  /** The text with its `#tags` removed and whitespace collapsed. */
  title: string;
  /** The `#tags` in the text, in order, deduped, lower-cased, without the `#`. */
  tags: string[];
}

/** What a person typed into the focus bar: `Talk with Natalie #people #garden` → the title and the tags. */
export function parseDeclaration(text: string): Declaration {
  const tags: string[] = [];
  const title = text
    .replace(/(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu, (_m, lead: string, tag: string) => {
      const t = tag.toLowerCase();
      if (!tags.includes(t)) tags.push(t);
      return lead;
    })
    .replace(/\s+/g, " ")
    .trim();
  return { title, tags };
}

/** A kebab-case slug for a file name: `Read the Mutus Liber, plate IV` → `read-the-mutus-liber-plate-iv`. */
export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "intent";
}

/** The intent document a title gets, avoiding the paths `taken` (`-2`, `-3`, …). */
export function intentPath(title: string, taken: ReadonlySet<string> | readonly string[] = []): string {
  const set = taken instanceof Set ? taken : new Set(taken);
  const slug = slugify(title);
  let path = `${INTENTS_DIR}${slug}.md`;
  for (let n = 2; set.has(path); n++) path = `${INTENTS_DIR}${slug}-${n}.md`;
  return path;
}

/** The cue document a title gets, likewise. */
export function cuePath(title: string, taken: ReadonlySet<string> | readonly string[] = []): string {
  const set = taken instanceof Set ? taken : new Set(taken);
  const slug = slugify(title);
  let path = `${CUES_DIR}${slug}.md`;
  for (let n = 2; set.has(path); n++) path = `${CUES_DIR}${slug}-${n}.md`;
  return path;
}

/** The body of a Markdown document: everything after the frontmatter fence. */
export function bodyOf(raw: string): string {
  const lines = raw.split("\n");
  if (lines[0] !== "---") return raw;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "...") return lines.slice(i + 1).join("\n");
  }
  return raw;
}

/** The body without its leading H1 (the title is shown separately) and without fenced code blocks, trimmed. */
export function proseOf(raw: string): string {
  return bodyOf(raw)
    .replace(/^\s*# .*\n?/, "")
    .replace(/```[\s\S]*?```\n?/g, "")
    .trim();
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" && v ? [v] : []);
export { str, strOrNull, strList };
