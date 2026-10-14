// The attn storage model's fixed points — where things live under one folder
// of an ordinary omgbase workspace — and the pure text rules: the declaration
// line (`#tags` become tags), slugs and dated paths, the clock, and the tiny
// frontmatter reader the history needs (`docs_read { at }` returns a past
// revision's raw bytes and no properties).
//
//   /attn/focus.md                                type: /terms/types/attn-state.md — the Focus pointer:
//                                                 focused_intent (an intent path | null), since (ISO), return_stack
//   /attn/intents/YYYY/MM/YYYY-MM-DD-<slug>.md    type: /terms/types/intent.md — one Intent, named for its
//                                                 declaration date (editing never renames): status active | released,
//                                                 title, tags?, project?, cues? (a list of cue value objects)
//
// Cues are NOT documents: a cue is one entry of its intent's `cues` list
// (lib/cues.ts). Focus history is NOT a document either: it is reconstructed
// from the pointer's revisions (lib/history.ts).

export const ATTN_ROOT = "/attn";
export const POINTER_PATH = `${ATTN_ROOT}/focus.md`;
export const INTENTS_DIR = `${ATTN_ROOT}/intents/`;
/** The type paths the documents carry (the notes repository's convention: a type is a path to its definition). */
export const INTENT_TYPE = "/terms/types/intent.md";
export const STATE_TYPE = "/terms/types/attn-state.md";

export type IntentStatus = "active" | "released";
/** A cue's `on` variant: when its intent should resurface. */
export type CueOn = "focus" | "time" | "query-enter" | "query-exit";
export const CUE_ONS: readonly CueOn[] = ["focus", "time", "query-enter", "query-exit"];
/** How a focus transition came about — inferred from two consecutive pointer states (lib/history.ts). */
export type TransitionKind = "switch" | "interrupt" | "back" | "stop";

/** The clock the app injects — OQX has no `now()`, and ISO strings compare lexically. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

/** The UTC day of an ISO timestamp: `2026-10-13T15:02:00.000Z` → `2026-10-13`. */
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
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

/** The intent document a title gets when declared at `now`: `/attn/intents/YYYY/MM/YYYY-MM-DD-<slug>.md`
 * (the declaration date, UTC), avoiding the paths `taken` (`-2`, `-3`, …). */
export function intentPath(title: string, now: string, taken: ReadonlySet<string> | readonly string[] = []): string {
  const set = taken instanceof Set ? taken : new Set(taken);
  const day = dayOf(now);
  const dir = `${INTENTS_DIR}${day.slice(0, 4)}/${day.slice(5, 7)}/`;
  const slug = slugify(title);
  let path = `${dir}${day}-${slug}.md`;
  for (let n = 2; set.has(path); n++) path = `${dir}${day}-${slug}-${n}.md`;
  return path;
}

/** A cue's intent-local id from a label: `When the fire is lit` → `when-the-fire-is-lit`, unique among `taken`. */
export function cueId(label: string, taken: readonly string[] = []): string {
  const base = slugify(label).replace(/^intent$/, "cue");
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
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

/** The body without its leading H1 (the title is shown separately), trimmed. */
export function proseOf(raw: string): string {
  return bodyOf(raw).replace(/^\s*# .*\n?/, "").trim();
}

// ---- the pointer's frontmatter, from raw bytes ------------------------------------------------

/** One YAML scalar as the pointer writes them: quoted strings, `null`/`~`, booleans, numbers, else the text. */
export function yamlScalar(text: string): unknown {
  const t = text.trim();
  if (t === "" || t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    return t.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return t;
}

/** The frontmatter of a document's raw bytes, read by the small grammar the
 * pointer uses — top-level `key: scalar`, `key: [a, b]`, and `key:` over a block
 * list of `- item` scalars. Enough for `focused_intent`, `since` and `return_stack`
 * at a past revision (`docs_read { at }` carries no `properties`); anything the
 * grammar does not know is skipped, never an error. Not a YAML parser. */
export function frontmatterOf(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = raw.split("\n");
  if (lines[0] !== "---") return out;
  let key: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "---" || line === "...") break;
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && key) {
      const list = Array.isArray(out[key]) ? (out[key] as unknown[]) : [];
      list.push(yamlScalar(item[1]!));
      out[key] = list;
      continue;
    }
    const kv = /^([A-Za-z_$][\w$-]*):(?:\s+(.*))?$/.exec(line);
    if (!kv) continue;
    key = kv[1]!;
    const value = kv[2];
    if (value === undefined || value.trim() === "") { out[key] = []; continue; }
    const v = value.trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      const inner = v.slice(1, -1).trim();
      out[key] = inner === "" ? [] : inner.split(",").map(yamlScalar);
    } else {
      out[key] = yamlScalar(v);
    }
  }
  return out;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" && v ? [v] : []);
const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export { str, strOrNull, strList, record };
