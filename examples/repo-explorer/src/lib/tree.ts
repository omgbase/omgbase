// The repository tree: `docs_tree { path, depth: 1, files: true }` per
// directory (`path` is a prefix — a role, so bare), loaded lazily as folders
// open (spec/surface §2, 5.1: by default the page is a directory rollup —
// `{ _path (rooted, ending "/"), docs, blocks }` rows and `files_here`, the
// documents directly in the prefix counted, not listed; `files: true` lists
// them too as `{ _id, _path, blocks }`; `_updated_at` rides only with
// `updated: true`, which this pane does not ask for — ordered by path and paged
// by a `[path]` keyset cursor; `total` covers everything under the prefix). A
// row is a directory when its `_path` ends in `/`, a document when it carries
// an `_id`. The pure side: wire → entries, the level table, and the names.

import { repoArg, type Caller, type Wire } from "./mcp-client.ts";
import { ancestorsOf, baseName, rooted } from "./paths.ts";

export interface TreeDir { kind: "dir"; path: string; docs: number; blocks: number; updatedAt: string | null }
export interface TreeDoc { kind: "doc"; id: string; path: string; blocks: number; updatedAt: string | null }
export type TreeEntry = TreeDir | TreeDoc;

export interface TreeLevel {
  prefix: string;
  entries: TreeEntry[];
  total: { docs: number; blocks: number };
  /** The documents directly in `prefix` (5.1), whether or not they are listed. */
  filesHere: number;
  truncated: boolean;
  cursor: string | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export function entryOf(e: Wire): TreeEntry | null {
  const path = str(e._path);
  if (!path) return null;
  if (path.endsWith("/")) return { kind: "dir", path: rooted(path), docs: num(e.docs), blocks: num(e.blocks), updatedAt: strOrNull(e._updated_at) };
  if (typeof e._id === "string") return { kind: "doc", id: e._id, path: rooted(path), blocks: num(e.blocks), updatedAt: strOrNull(e._updated_at) };
  return null;
}

/** A `docs_tree` page. */
export function levelOf(page: Wire): TreeLevel {
  const total = (page.total ?? {}) as Wire;
  const entries = Array.isArray(page.entries) ? (page.entries as Wire[]).map(entryOf).filter((e): e is TreeEntry => e !== null) : [];
  return {
    prefix: str(page.prefix) || "/",
    entries,
    total: { docs: num(total.docs), blocks: num(total.blocks) },
    filesHere: num(page.files_here),
    truncated: page.truncated === true,
    cursor: strOrNull(page.cursor),
  };
}

/** The entries a `dir` entry's children are loaded with: `docs_tree { path, depth: 1, files: true }` (the pane lists documents, so it asks for them — 5.1). */
export function treeArgs(prefix: string, repo: string | null, cursor: string | null = null): Record<string, unknown> {
  return { ...(prefix === "/" ? {} : { path: prefix }), depth: 1, files: true, ...(cursor ? { cursor } : {}), ...repoArg(repo) };
}

/** How many pages one level follows before giving up (a directory of thousands is still shown truncated). */
export const MAX_LEVEL_PAGES = 20;

/** One directory's entries, following the cursor while the page is truncated
 * (bounded by `MAX_LEVEL_PAGES`; the last page's `truncated` is kept). */
export async function fetchLevel(caller: Caller, prefix: string, repo: string | null): Promise<TreeLevel> {
  let level = levelOf(await caller.call<Wire>("docs_tree", treeArgs(prefix, repo)));
  let pages = 1;
  while (level.truncated && level.cursor && pages < MAX_LEVEL_PAGES) {
    const next = levelOf(await caller.call<Wire>("docs_tree", treeArgs(prefix, repo, level.cursor)));
    level = { ...next, entries: [...level.entries, ...next.entries] };
    pages++;
  }
  return level;
}

/** The label of an entry: the last path segment (`/a/b/` → `b`, `/a/x.md` → `x.md`). */
export function entryLabel(entry: Pick<TreeEntry, "path">): string {
  return baseName(entry.path);
}

/** The prefixes that must be open for `path` to be visible (its ancestors, root first). */
export function prefixesToOpen(path: string): string[] {
  return ancestorsOf(path);
}

/** A level table (prefix → its loaded entries) plus the open set, as the element renders it. */
export type LevelState = { status: "loading" } | { status: "ready"; level: TreeLevel } | { status: "error"; message: string };

/** The badge for a `dir` entry: `12 docs` / `1 doc`. */
export function dirBadge(dir: TreeDir): string {
  return `${dir.docs} doc${dir.docs === 1 ? "" : "s"}`;
}
