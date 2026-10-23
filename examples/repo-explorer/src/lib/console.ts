// The query console's pure side: the result table's columns and cells (an
// `_id`/`_path` cell is a link into the explorer), the scalar consumers'
// one-line answers, paging, the engine's errors with their `data.fix`, and the
// keyboard shortcut. The `query` tool is the only call; `query_syntax` feeds
// the drawer once.

import { OmgError, type Caller, type Wire } from "./mcp-client.ts";
import { idKind } from "./paths.ts";
import { runQuery, type QueryOptions, type QueryResult } from "./query.ts";

export const DEFAULT_LIMIT = 50;

/** `_title` is the computed title (an engine attribute); `layer` and `tags` the authored keys (spec/surface §1.2, 5.0). */
export const STARTER_QUERY = "docs { select _title, layer, tags order by _path }";

/** The table's columns: `_id` and `_path` first (the envelope, spec/surface §1.4), then every other key in first-seen order. */
export function columnsOf(hits: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const rest: string[] = [];
  let hasId = false;
  let hasPath = false;
  for (const hit of hits) {
    for (const k of Object.keys(hit)) {
      if (k === "_id") { hasId = true; continue; }
      if (k === "_path") { hasPath = true; continue; }
      if (!seen.has(k)) { seen.add(k); rest.push(k); }
    }
  }
  return [...(hasId ? ["_id"] : []), ...(hasPath ? ["_path"] : []), ...rest];
}

export type CellLink =
  | { kind: "doc"; path: string }
  | { kind: "id"; id: string; of: "doc" | "block" | "node" | "link" | "revision" | "commit" };

export interface Cell {
  text: string;
  link: CellLink | null;
}

/** A cell's text and, for a `/`-rooted path or an omgbase id, where it leads. */
export function cellOf(value: unknown): Cell {
  if (value === null || value === undefined) return { text: value === null ? "null" : "", link: null };
  if (typeof value === "string") {
    if (/^\/[^\s"]*\.[a-z0-9]+$/i.test(value)) return { text: value, link: { kind: "doc", path: value } };
    const of = idKind(value);
    if (of) return { text: value, link: { kind: "id", id: value, of } };
    return { text: value, link: null };
  }
  if (typeof value === "object") {
    // A row as a value is `{ _id, _path }` (spec/surface §1.4): link it as its path.
    const o = value as Record<string, unknown>;
    if (!Array.isArray(value) && typeof o._path === "string" && typeof o._id === "string" && Object.keys(o).length === 2) {
      return { text: o._path, link: { kind: "doc", path: o._path } };
    }
    return { text: JSON.stringify(value), link: null };
  }
  return { text: String(value), link: null };
}

/** The one line a scalar or values consumer answers with; null for a hits result. */
export function scalarLine(r: QueryResult): string | null {
  if (r.consumer === "count" && typeof r.count === "number") return `count: ${r.count}`;
  if (r.consumer === "exists" && typeof r.exists === "boolean") return `exists: ${r.exists}`;
  if (r.consumer === "none" && typeof r.none === "boolean") return `none: ${r.none}`;
  if (r.values) return `${r.values.length} value${r.values.length === 1 ? "" : "s"}`;
  return null;
}

/** The footer: `12 rows` / `50 rows · more` / `50 rows · truncated (order by disables the cursor — page with limit/offset in the query)`. */
export function footerText(r: QueryResult, shown: number): string {
  const rows = `${shown} row${shown === 1 ? "" : "s"}`;
  if (!r.truncated) return rows;
  if (r.cursor) return `${rows} · more`;
  return `${rows} · truncated (a custom order by disables the cursor — page with limit/offset in the query)`;
}

/** The next page's options: the same query, the page's cursor; null when there is no next page. */
export function nextPage(r: QueryResult, opts: QueryOptions): QueryOptions | null {
  if (!r.truncated || !r.cursor) return null;
  return { ...opts, cursor: r.cursor };
}

export interface ToolErrorInfo {
  code: string;
  message: string;
  /** `data.fix`: a literal corrected call (canonical JSON, maybe prefixed by a tool name), when the engine offers one. */
  fix: string | null;
  /** `data.hint`: which grammar the message is about (`OQX`, `arguments`, `selection`). */
  hint: string | null;
  retriable: boolean;
}

/** The engine's error envelope as the console shows it; any other failure is `error` with its message. */
export function describeToolError(e: unknown): ToolErrorInfo {
  if (e instanceof OmgError) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    return {
      code: e.code,
      message: e.message,
      fix: typeof data.fix === "string" ? data.fix : null,
      hint: typeof data.hint === "string" ? data.hint : null,
      retriable: e.retriable,
    };
  }
  return { code: "error", message: e instanceof Error ? e.message : String(e), fix: null, hint: null, retriable: false };
}

/** Cmd+Enter (macOS) or Ctrl+Enter runs the query. */
export function isRunShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey);
}

/** One console run: the `query` tool with the console's limit. */
export async function runConsole(caller: Caller, query: string, opts: QueryOptions = {}): Promise<QueryResult> {
  return runQuery(caller, query, { limit: DEFAULT_LIMIT, ...opts });
}

/** `query_syntax {}` → the reference text (fetched once, kept by the page). */
export async function fetchSyntax(caller: Caller): Promise<string> {
  const r = await caller.call<Wire>("query_syntax", {});
  return typeof r.syntax === "string" ? r.syntax : "";
}

/** The query that finds where an id lives, so a clicked id cell can open its
 * document: a block's or node's `_path`, a revision's `_path` + `_doc_id`; a doc
 * id needs no query (docs_read takes it); a link's source `_path`. */
export function locatorQuery(id: string): string | null {
  switch (idKind(id)) {
    case "block": return `blocks { select _path where _id == ${JSON.stringify(id)} }`;
    case "node": return `nodes { select _path where _id == ${JSON.stringify(id)} }`;
    case "link": return `links { select _path where _id == ${JSON.stringify(id)} }`;
    case "revision": return `revisions { select _path, _doc_id where _rev == ${JSON.stringify(id)} }`;
    default: return null;
  }
}
