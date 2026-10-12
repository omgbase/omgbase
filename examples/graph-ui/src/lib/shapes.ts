// Tool-result shapes — the sibling of lib/paths.ts for everything that is NOT
// a query hit. Surface 3.0 (spec/surface §1.2, §2–§4) made one rule of every
// result: a row's identity is `id`/`path`, its bytes `raw`, its hash `hash`,
// its time `updated_at`, and every other engine-provided name is a plain
// snake_case field (`doc_id`, `block_id`, `dst_id`, `dst_path`, `uri`,
// `field`). The link rows are the `links` collection (§1.1: `from links`,
// `^links`, `out_links`/`in_links`) and the `graph` tool's array of them is
// `links[]`. Every reader here normalises to ONE internal shape with rooted
// paths; nothing else in the demo spells a wire key.

import { rooted } from "./paths.ts";

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

// ---- the `graph` tool ----------------------------------------------------------------

/** The `graph` result's link rows (`links[]`); anything else is no row. */
export function graphEdgeRows(result: Record<string, unknown>): Record<string, unknown>[] {
  const rows = result.links;
  return Array.isArray(rows) ? rows.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object") : [];
}

/** A `graph` edge (one `links[]` row), normalised: `{ id, doc_id, block_id,
 * via_id, dst_id, dst_path, uri, dst_kind, predicate, provenance, anchor,
 * field }` with the destination path rooted. */
export interface GraphToolEdge {
  id: string;
  docId: string;
  blockId: string | null;
  viaId: string | null;
  dstId: string;
  dstPath: string | null;
  uri: string | null;
  dstKind: string | null;
  predicate: string | null;
  provenance: string | null;
  anchor: string | null;
  field: string | null;
}

export function edgeOf(e: Record<string, unknown>): GraphToolEdge | null {
  const id = str(e.id);
  const docId = str(e.doc_id);
  const dstId = str(e.dst_id);
  if (id === null || docId === null || dstId === null) return null;
  const dstPath = str(e.dst_path);
  return {
    id, docId, dstId,
    blockId: str(e.block_id),
    viaId: str(e.via_id),
    dstPath: dstPath === null ? null : rooted(dstPath),
    uri: str(e.uri),
    dstKind: str(e.dst_kind),
    predicate: str(e.predicate),
    provenance: str(e.provenance),
    anchor: str(e.anchor),
    field: str(e.field),
  };
}

/** A `graph` document (or frontier entry): `{ id, path, degree, frontier,
 * …select }`. The extra projections are kept under their own keys (an
 * `id`/`path` selection collapses onto the envelope; any other bare name is a
 * plain column). */
export interface GraphToolDoc {
  id: string;
  /** `/`-rooted. */
  path: string;
  degree: number | null;
  frontier: boolean;
  fields: Record<string, unknown>;
}

export function docOf(d: Record<string, unknown>): GraphToolDoc | null {
  const id = str(d.id);
  const path = str(d.path);
  if (id === null || path === null) return null;
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (k !== "id" && k !== "path" && k !== "degree" && k !== "frontier") fields[k] = v;
  return { id, path: rooted(path), degree: num(d.degree), frontier: d.frontier === true, fields };
}

// ---- docs_read / docs_set_meta -------------------------------------------------------

/** `docs_read`: `{ id, path, rev, properties, raw }`. */
export interface DocRead {
  id: string | null;
  path: string | null;
  rev: string | null;
  raw: string | null;
  frontmatter: Record<string, unknown>;
}

export function docReadOf(r: Record<string, unknown>): DocRead {
  const path = str(r.path);
  const props = (r.properties as { frontmatter?: Record<string, unknown> } | undefined)?.frontmatter;
  return {
    id: str(r.id),
    path: path === null ? null : rooted(path),
    rev: str(r.rev),
    raw: str(r.raw),
    frontmatter: props && typeof props === "object" ? props : {},
  };
}

/** A document operation's result (`docs_set_meta`, `docs_create`, …): `{ id, path, committed }`. */
export interface DocOpResult {
  id: string | null;
  path: string | null;
  committed: boolean;
}

export function docOpOf(r: Record<string, unknown>): DocOpResult {
  const path = str(r.path);
  return { id: str(r.id), path: path === null ? null : rooted(path), committed: r.committed === true };
}
