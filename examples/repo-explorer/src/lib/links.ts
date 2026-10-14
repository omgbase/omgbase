// Backlinks and outlinks: the `links` target (spec/surface §1.2) through the
// `query` tool. A link row is one open authored link; `path` is the SOURCE
// document, `dst_path` the destination document (null when the link is
// external or dangling — a `[[wikilink]]` that names no document, say), `uri`
// the external URL, `dst_id` a doc id, an external node id or `phantom:<path>`.
//
//   inbound   select path, block_id, provenance, field, anchor from links where dst_path == "<path>"
//   outbound  select dst_path, dst_id, dst_kind, uri, provenance, field, anchor from links where path == "<path>"
//   by name   select path, block_id, provenance, field, anchor from links where dst_id == "phantom:<stem>"
//
// The third: a `[[wikilink]]` naming a document by its bare name (`[[salt]]`
// for /substances/salt.md) is not resolved by the graph layer — its row has
// `dst_path: null` and `dst_id: "phantom:salt"` — so the `dst_path` query
// cannot see it. The phantom id is the name, so a client can still list the
// documents that mention this one by name (shown as "wikilinks naming …").

import { repoArg, type Caller, type Wire } from "./mcp-client.ts";
import { hitId, hitPath, rooted } from "./paths.ts";
import { queryAll } from "./query.ts";

export interface LinkRow {
  id: string;
  /** The source document (rooted). */
  path: string;
  blockId: string | null;
  dstPath: string | null;
  dstId: string | null;
  dstKind: string | null;
  uri: string | null;
  provenance: string | null;
  field: string | null;
  anchor: string | null;
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function inboundQuery(path: string): string {
  return `select path, block_id, provenance, field, anchor from links where dst_path == ${JSON.stringify(rooted(path))}`;
}

export function outboundQuery(path: string): string {
  return `select dst_path, dst_id, dst_kind, uri, provenance, field, anchor from links where path == ${JSON.stringify(rooted(path))}`;
}

/** The bare name a wikilink would use for a document: its file name without the extension (`/substances/salt.md` → `salt`). */
export function wikiStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.[a-z0-9]+$/i, "");
}

/** The unresolved wikilinks that name this document: `dst_id == "phantom:<stem>"`. */
export function byNameQuery(path: string): string {
  return `select path, block_id, provenance, field, anchor from links where dst_id == ${JSON.stringify(`phantom:${wikiStem(path)}`)}`;
}

export function linkRowOf(hit: Record<string, unknown>): LinkRow | null {
  const id = hitId(hit);
  const path = hitPath(hit);
  if (id === null || path === null) return null;
  const dst = strOrNull(hit.dst_path);
  return {
    id,
    path: rooted(path),
    blockId: strOrNull(hit.block_id),
    dstPath: dst === null ? null : rooted(dst),
    dstId: strOrNull(hit.dst_id),
    dstKind: strOrNull(hit.dst_kind),
    uri: strOrNull(hit.uri),
    provenance: strOrNull(hit.provenance),
    field: strOrNull(hit.field),
    anchor: strOrNull(hit.anchor),
  };
}

export function linkRowsOf(hits: readonly Record<string, unknown>[]): LinkRow[] {
  return hits.map(linkRowOf).filter((r): r is LinkRow => r !== null);
}

/** What an outbound row points at, for display: the document path, else the URL,
 * else the phantom's path (a dangling reference), else "(unresolved)". */
export function linkTarget(row: LinkRow): { text: string; doc: string | null; href: string | null; dangling: boolean } {
  if (row.dstPath) return { text: row.dstPath, doc: row.dstPath, href: null, dangling: false };
  if (row.uri) return { text: row.uri, doc: null, href: row.uri, dangling: false };
  if (row.dstId?.startsWith("phantom:")) return { text: `${row.dstId.slice("phantom:".length)} (dangling)`, doc: null, href: null, dangling: true };
  return { text: "(unresolved)", doc: null, href: null, dangling: true };
}

/** Where a link was authored: `link` (the body), `frontmatter · <field>`, `inline_field · <field>`, … */
export function linkProvenance(row: LinkRow): string {
  const p = row.provenance ?? "link";
  return row.field ? `${p} · ${row.field}` : p;
}

export interface DocLinks {
  inbound: LinkRow[];
  outbound: LinkRow[];
  /** Wikilinks naming this document by its bare name, unresolved by the engine. */
  byName: LinkRow[];
}

/** Both directions for one document plus the by-name mentions, every page followed. */
export async function fetchLinks(caller: Caller, path: string, repo: string | null): Promise<DocLinks> {
  const [inbound, outbound, byName] = await Promise.all([
    queryAll(caller, inboundQuery(path), repo),
    queryAll(caller, outboundQuery(path), repo),
    queryAll(caller, byNameQuery(path), repo),
  ]);
  return { inbound: linkRowsOf(inbound), outbound: linkRowsOf(outbound), byName: linkRowsOf(byName) };
}

/** Resolve a `[[wikilink]]`'s name to a document: the live documents whose path ends in `/<name>.md` (or is exactly it). */
export function wikilinkQuery(name: string): string {
  const file = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`;
  return `select path from docs where path.endsWith(${JSON.stringify(`/${file}`)})`;
}

export async function resolveWikilink(caller: Caller, name: string, repo: string | null): Promise<string[]> {
  const r = await caller.call<Wire>("query", { query: wikilinkQuery(name), limit: 10, ...repoArg(repo) });
  const hits = Array.isArray(r.hits) ? (r.hits as Record<string, unknown>[]) : [];
  return hits.map(hitPath).filter((p): p is string => p !== null).map(rooted);
}
