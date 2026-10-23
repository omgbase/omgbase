// Backlinks and outlinks: the `links` target (spec/surface §1.2, the 5.0
// spelling — every link attribute is engine-provided, so `_`-prefixed) through
// the `query` tool. A link row is one open authored link; `_path` is the SOURCE
// document, `_dst_path` the destination document (null when the link is
// external or dangling — a `[[wikilink]]` that names no document, say), `_uri`
// the external URL, `_dst_id` a doc id, an external node id or `phantom:<path>`.
//
//   inbound   links { select _path, _block_id, _provenance, _field, _anchor where _dst_path == "<path>" }
//   outbound  links { select _dst_path, _dst_id, _dst_kind, _uri, _provenance, _field, _anchor where _path == "<path>" }
//   by name   links { select _path, _block_id, _provenance, _field, _anchor where _dst_id == "phantom:<stem>" }
//
// The third: a `[[wikilink]]` naming a document by its bare name (`[[salt]]`
// for /substances/salt.md) is not resolved by the graph layer — its row has
// `_dst_path: null` and `_dst_id: "phantom:salt"` — so the `_dst_path` query
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
  return `links { select _path, _block_id, _provenance, _field, _anchor where _dst_path == ${JSON.stringify(rooted(path))} }`;
}

export function outboundQuery(path: string): string {
  return `links { select _dst_path, _dst_id, _dst_kind, _uri, _provenance, _field, _anchor where _path == ${JSON.stringify(rooted(path))} }`;
}

/** The bare name a wikilink would use for a document: its file name without the extension (`/substances/salt.md` → `salt`). */
export function wikiStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.[a-z0-9]+$/i, "");
}

/** The unresolved wikilinks that name this document: `_dst_id == "phantom:<stem>"`. */
export function byNameQuery(path: string): string {
  return `links { select _path, _block_id, _provenance, _field, _anchor where _dst_id == ${JSON.stringify(`phantom:${wikiStem(path)}`)} }`;
}

export function linkRowOf(hit: Record<string, unknown>): LinkRow | null {
  const id = hitId(hit);
  const path = hitPath(hit);
  if (id === null || path === null) return null;
  const dst = strOrNull(hit._dst_path);
  return {
    id,
    path: rooted(path),
    blockId: strOrNull(hit._block_id),
    dstPath: dst === null ? null : rooted(dst),
    dstId: strOrNull(hit._dst_id),
    dstKind: strOrNull(hit._dst_kind),
    uri: strOrNull(hit._uri),
    provenance: strOrNull(hit._provenance),
    field: strOrNull(hit._field),
    anchor: strOrNull(hit._anchor),
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
  return `docs { select _path where _path.endsWith(${JSON.stringify(`/${file}`)}) }`;
}

export async function resolveWikilink(caller: Caller, name: string, repo: string | null): Promise<string[]> {
  const r = await caller.call<Wire>("query", { query: wikilinkQuery(name), limit: 10, ...repoArg(repo) });
  const hits = Array.isArray(r.hits) ? (r.hits as Record<string, unknown>[]) : [];
  return hits.map(hitPath).filter((p): p is string => p !== null).map(rooted);
}
