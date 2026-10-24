// The command palette's pure side (Quicksilver-style, keyboard-first): what
// the typed text means (`parseInput`), the one `query` that finds documents by
// path or title (`findQuery`), the ranking of its hits (`rankDocs`), the fuzzy
// match over the page's actions (`filterActions`), the "create <path>"
// suggestion and the path it would create (`newDocumentPath`), the ordered
// item list per mode (`itemsFor`) and the wrap-around cursor (`stepIndex`).
// Nothing here touches the DOM or the client; the element renders what this
// module decides and the page runs the query.
//
// Three modes, by the input's first characters:
//   find     `calc`, `proc calc`   documents whose path or title matches every term
//   action   `> undo`              the page's actions, fuzzily
//   create   `+ notes/x`, `new x`  a new document at that path
//
// The find query is regex over `_path` and `_title` (`~*`, case-insensitive;
// spec/oqx SEMANTICS §11): `text(...)`/FTS may not be indexed on a minimal
// server, and a regex `and` of the terms is what a path-completing palette
// wants. OQX's regex baseline rejects an identity escape of a non-metacharacter
// (`\q` is an error), so `escapeRegex` escapes exactly the baseline's MetaChar
// set — which, unlike JavaScript's, includes `/` and `-` (both are
// metacharacters there and must be escaped when literal).

import { dirOf, rooted } from "./paths.ts";

// ---- the input ----------------------------------------------------------------

export type PaletteInput = { kind: "find"; text: string } | { kind: "action"; text: string } | { kind: "create"; path: string };

/** `> …` is an action search, `+ …` / `new …` a create, anything else a find; every part trimmed. */
export function parseInput(raw: string): PaletteInput {
  const text = raw.trim();
  if (text.startsWith(">")) return { kind: "action", text: text.slice(1).trim() };
  if (text.startsWith("+")) return { kind: "create", path: text.slice(1).trim() };
  if (/^new\s/i.test(text)) return { kind: "create", path: text.slice(3).trim() };
  return { kind: "find", text };
}

// ---- the find query -----------------------------------------------------------

/** The OQX regex baseline's metacharacters (SEMANTICS §11): the only characters a `\` may escape. */
const OQX_REGEX_META = /[.*+?()[\]{}|^$\\/-]/g;

/** `s` as a literal in an OQX regex: every baseline metacharacter escaped, nothing else (`\q` would be rejected). */
export function escapeRegex(s: string): string {
  return s.replace(OQX_REGEX_META, "\\$&");
}

/** The whitespace-separated terms of a find. */
export function termsOf(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

/** The `query` that finds documents by path or title: every term must match
 * either (`and` of `(_path ~* t or _title ~* t)`), path order, `limit`. Empty
 * text lists the first `limit` documents by path. */
export function findQuery(text: string, limit: number): string {
  const terms = termsOf(text);
  const where = terms.map((t) => {
    const lit = JSON.stringify(escapeRegex(t));
    return `(_path ~* ${lit} or _title ~* ${lit})`;
  });
  const clause = where.length > 0 ? ` where ${where.join(" and ")}` : "";
  return `docs { select _id, _path, _title${clause} order by _path limit ${limit} }`;
}

// ---- items ----------------------------------------------------------------------

export interface DocItem {
  kind: "doc";
  id: string;
  /** Rooted. */
  path: string;
  /** `_title`, else the file name without `.md`. */
  title: string;
}

export interface ActionItem {
  kind: "action";
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
}

export interface CreateItem {
  kind: "create";
  /** Rooted, `.md`-suffixed. */
  path: string;
}

export type PaletteItem = DocItem | ActionItem | CreateItem;

/** An action the page offers the palette (`>` mode); `keywords` widen the fuzzy match beyond the label. */
export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  keywords?: string[];
}

/** A file extension: a dot then a letter-led run (`.md`, `.markdown`; not `.2` — `v1.2` is a name). */
const EXTENSION = /\.[a-z][a-z0-9]*$/i;

/** The file name without its extension (`/a/b.md` → `b`). */
export function fileStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(EXTENSION, "");
}

/** A document's display title: `_title` when it is a non-empty string, else the file stem. */
export function docTitle(path: string, title: unknown): string {
  return typeof title === "string" && title.trim().length > 0 ? title : fileStem(path);
}

/** A `docs` hit (`{ _id, _path, _title? }`, spec/surface §1.4) as a palette item; null for a row without the envelope. */
export function docItemOf(hit: Record<string, unknown>): DocItem | null {
  if (typeof hit._id !== "string" || typeof hit._path !== "string") return null;
  const path = rooted(hit._path);
  return { kind: "doc", id: hit._id, path, title: docTitle(path, hit._title) };
}

type DocLike = DocItem | Record<string, unknown>;

function asDocItem(d: DocLike): DocItem | null {
  if ("kind" in d && d.kind === "doc" && typeof d.path === "string") return d as DocItem;
  return docItemOf(d as Record<string, unknown>);
}

/** The path's segments (directories and the file stem), lowercased. */
function segmentsOf(path: string): string[] {
  return path.toLowerCase().split("/").filter((s) => s.length > 0).map((s, i, all) => (i === all.length - 1 ? s.replace(EXTENSION, "") : s));
}

/** The ranking tier of a document for `text` (lower is better): 0 title starts
 * with it, 1 title contains it, 2 a path segment starts with it, 3 the path
 * contains it, 4 none (a multi-term match the regex found, say). */
export function docTier(doc: DocItem, text: string): number {
  const q = text.trim().toLowerCase();
  if (q.length === 0) return 4;
  const title = doc.title.toLowerCase();
  if (title.startsWith(q)) return 0;
  if (title.includes(q)) return 1;
  if (segmentsOf(doc.path).some((s) => s.startsWith(q))) return 2;
  if (doc.path.toLowerCase().includes(q)) return 3;
  return 4;
}

/** The hits (or items) ordered for display: by tier, then by path; a row without `_id`/`_path` is dropped. */
export function rankDocs(hits: readonly DocLike[], text: string): DocItem[] {
  const items = hits.map(asDocItem).filter((d): d is DocItem => d !== null);
  return items
    .map((doc, i) => ({ doc, tier: docTier(doc, text), i }))
    .sort((a, b) => a.tier - b.tier || (a.doc.path < b.doc.path ? -1 : a.doc.path > b.doc.path ? 1 : a.i - b.i))
    .map((r) => r.doc);
}

// ---- actions ------------------------------------------------------------------

/** Does `needle` occur in `hay` as a subsequence (every character in order, gaps allowed)? */
export function isSubsequence(needle: string, hay: string): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
  return j === needle.length;
}

/** How well `q` matches one candidate string: 0 prefix, 1 contiguous, 2 subsequence, null none. */
export function matchTier(q: string, candidate: string): number | null {
  const c = candidate.toLowerCase();
  if (c.startsWith(q)) return 0;
  if (c.includes(q)) return 1;
  if (isSubsequence(q, c)) return 2;
  return null;
}

/** The actions matching `text` (fuzzy, over label then keywords), best first; a
 * label match outranks a keyword match within a tier; the page's order breaks
 * ties. Empty text keeps every action in the page's order. */
export function filterActions(actions: readonly PaletteAction[], text: string): ActionItem[] {
  const q = text.trim().toLowerCase().replace(/\s+/g, " ");
  const toItem = (a: PaletteAction): ActionItem => ({ kind: "action", id: a.id, label: a.label, ...(a.hint !== undefined ? { hint: a.hint } : {}), ...(a.shortcut !== undefined ? { shortcut: a.shortcut } : {}) });
  if (q.length === 0) return actions.map(toItem);
  const scored: { a: PaletteAction; score: number; i: number }[] = [];
  actions.forEach((a, i) => {
    const label = matchTier(q, a.label);
    const keyword = (a.keywords ?? []).map((k) => matchTier(q, k)).filter((t): t is number => t !== null).sort((x, y) => x - y)[0];
    // A label match at tier t scores 2t, a keyword match 2t + 1; the best of the two counts.
    const candidates = [...(label !== null ? [label * 2] : []), ...(keyword !== undefined ? [keyword * 2 + 1] : [])];
    if (candidates.length > 0) scored.push({ a, score: Math.min(...candidates), i });
  });
  return scored.sort((x, y) => x.score - y.score || x.i - y.i).map((s) => toItem(s.a));
}

// ---- creating -------------------------------------------------------------------

/** The rooted path a typed name would create: a rooted input as written, a
 * bare name under the open document's folder (or `/` when none); `.md` when
 * there is no extension; `\` read as `/`; runs of `/` collapsed. Null for an
 * empty input, a `.`/`..` segment, a blank segment or a trailing slash. */
export function newDocumentPath(input: string, currentDocPath: string | null): string | null {
  const text = input.trim().replace(/\\/g, "/");
  if (text.length === 0) return null;
  const base = text.startsWith("/") ? "/" : currentDocPath ? dirOf(currentDocPath) : "/";
  const joined = `${base}/${text}`.replace(/\/{2,}/g, "/");
  if (joined.endsWith("/")) return null;
  const segments = joined.split("/").slice(1);
  if (segments.some((s) => s.trim().length === 0 || s === "." || s === "..")) return null;
  const last = segments[segments.length - 1]!;
  const file = EXTENSION.test(last) ? last : `${last}.md`;
  return `/${[...segments.slice(0, -1), file].join("/")}`;
}

/** The "create <path>" item for a find: when the text resolves to a path and no
 * listed document already has that path or exactly that title. */
export function createSuggestion(text: string, docs: readonly DocItem[], currentDoc: string | null): CreateItem | null {
  const path = newDocumentPath(text, currentDoc);
  if (path === null) return null;
  const q = text.trim().toLowerCase();
  const taken = docs.some((d) => d.path.toLowerCase() === path.toLowerCase() || d.title.toLowerCase() === q);
  return taken ? null : { kind: "create", path };
}

// ---- the list -------------------------------------------------------------------

export interface ItemsContext {
  /** The find query's hits (ranked here). */
  docs: readonly DocLike[];
  actions: readonly PaletteAction[];
  /** The open document's path (a bare created name lands in its folder). */
  currentDoc: string | null;
}

/** The ordered items for one input: find → ranked documents then the create
 * suggestion; action → the matching actions; create → the one item, or none
 * when the path is invalid. */
export function itemsFor(input: PaletteInput, ctx: ItemsContext): PaletteItem[] {
  switch (input.kind) {
    case "find": {
      const docs = rankDocs(ctx.docs, input.text);
      const create = input.text.length > 0 ? createSuggestion(input.text, docs, ctx.currentDoc) : null;
      return create ? [...docs, create] : docs;
    }
    case "action":
      return filterActions(ctx.actions, input.text);
    case "create": {
      const path = newDocumentPath(input.path, ctx.currentDoc);
      return path === null ? [] : [{ kind: "create", path }];
    }
  }
}

// ---- the cursor -----------------------------------------------------------------

export const STEP_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

export function isStepKey(key: string): boolean {
  return STEP_KEYS.has(key);
}

/** The active index after a navigation key over `count` items: ↑/↓ wrap, Home/End
 * jump, PageUp/PageDown move by `page` and wrap at the ends. -1 for no items;
 * an unknown key leaves the index alone. */
export function stepIndex(index: number, count: number, key: string, page = 10): number {
  if (count <= 0) return -1;
  const last = count - 1;
  const at = index < 0 || index > last ? -1 : index;
  switch (key) {
    case "ArrowDown": return at >= last ? 0 : at + 1;
    case "ArrowUp": return at <= 0 ? last : at - 1;
    case "Home": return 0;
    case "End": return last;
    case "PageDown": return at >= last ? 0 : Math.min(last, at + page);
    case "PageUp": return at <= 0 ? last : Math.max(0, at - page);
    default: return at;
  }
}
