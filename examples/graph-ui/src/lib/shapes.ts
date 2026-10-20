// Tool-result shapes — the sibling of lib/paths.ts for everything that is NOT
// a query hit. Surface 5.0 (spec/surface §1.2, §2–§4, "underscore = engine")
// made one rule of every result: an engine-provided key is `_`-prefixed — a
// row's identity is `_id`/`_path`, its bytes `_raw`, its hash `_hash`, its
// time `_updated_at`, a link row's `_doc_id`, `_block_id`, `_dst_id`,
// `_dst_path`, `_uri`, `_field` — and a bare key names a role (`rev`,
// `properties`, `committed`, `degree`, `frontier`) or the user's authored
// data. A 3.x/4.x server spells the engine keys bare (`id`, `path`, `raw`,
// `doc_id`, `dst_path`, …). The link rows are the `links` collection (§1.1:
// `from links`, `^links`, `_out_links`/`_in_links`) and the `graph` tool's
// array of them is `links[]`. Every reader here takes EITHER spelling and
// normalises to ONE internal shape with rooted paths; nothing else in the demo
// spells a wire key.

import { HIT_ENVELOPE_KEYS, rooted } from "./paths.ts";

type Wire = Record<string, unknown>;
/** The first value among the keys (the 5.0 spelling first, then the 4.x one). */
const pick = (w: Wire, ...keys: string[]): unknown => { for (const k of keys) if (w[k] !== undefined) return w[k]; return undefined; };
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

// ---- the `graph` tool ----------------------------------------------------------------

/** The `graph` result's link rows (`links[]`); anything else is no row. */
export function graphEdgeRows(result: Wire): Wire[] {
  const rows = result.links;
  return Array.isArray(rows) ? rows.filter((r): r is Wire => r !== null && typeof r === "object") : [];
}

/** A `graph` edge (one `links[]` row), normalised: `{ _id, _doc_id, _block_id,
 * _via_id, _dst_id, _dst_path, _uri, _dst_kind, _predicate, _provenance,
 * _anchor, _field }` (bare on 4.x) with the destination path rooted. */
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

export function edgeOf(e: Wire): GraphToolEdge | null {
  const id = str(pick(e, "_id", "id"));
  const docId = str(pick(e, "_doc_id", "doc_id"));
  const dstId = str(pick(e, "_dst_id", "dst_id"));
  if (id === null || docId === null || dstId === null) return null;
  const dstPath = str(pick(e, "_dst_path", "dst_path"));
  return {
    id, docId, dstId,
    blockId: str(pick(e, "_block_id", "block_id")),
    viaId: str(pick(e, "_via_id", "via_id")),
    dstPath: dstPath === null ? null : rooted(dstPath),
    uri: str(pick(e, "_uri", "uri")),
    dstKind: str(pick(e, "_dst_kind", "dst_kind")),
    predicate: str(pick(e, "_predicate", "predicate")),
    provenance: str(pick(e, "_provenance", "provenance")),
    anchor: str(pick(e, "_anchor", "anchor")),
    field: str(pick(e, "_field", "field")),
  };
}

/** A `graph` document (or frontier entry): `{ _id, _path, degree, frontier,
 * …select }`. The extra projections are kept under their own keys (an
 * `_id`/`_path` selection collapses onto the envelope; any other name is a
 * plain column). */
export interface GraphToolDoc {
  id: string;
  /** `/`-rooted. */
  path: string;
  degree: number | null;
  frontier: boolean;
  fields: Record<string, unknown>;
}

export function docOf(d: Wire): GraphToolDoc | null {
  const id = str(pick(d, "_id", "id"));
  const path = str(pick(d, "_path", "path"));
  if (id === null || path === null) return null;
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (!HIT_ENVELOPE_KEYS.has(k) && k !== "degree" && k !== "frontier") fields[k] = v;
  return { id, path: rooted(path), degree: num(d.degree), frontier: d.frontier === true, fields };
}

// ---- docs_read / docs_set_meta -------------------------------------------------------

/** `docs_read`: `{ _id, _path, rev, properties, _raw }` (4.x: `{ id, path, rev, properties, raw }`). */
export interface DocRead {
  id: string | null;
  path: string | null;
  rev: string | null;
  raw: string | null;
  frontmatter: Record<string, unknown>;
}

export function docReadOf(r: Wire): DocRead {
  const path = str(pick(r, "_path", "path"));
  const props = (r.properties as { frontmatter?: Record<string, unknown> } | undefined)?.frontmatter;
  return {
    id: str(pick(r, "_id", "id")),
    path: path === null ? null : rooted(path),
    rev: str(r.rev),
    raw: str(pick(r, "_raw", "raw")),
    frontmatter: props && typeof props === "object" ? props : {},
  };
}

/** A document operation's result (`docs_set_meta`, `docs_create`, …): `{ _id, _path, committed }` (4.x: `{ id, path, committed }`). */
export interface DocOpResult {
  id: string | null;
  path: string | null;
  committed: boolean;
}

export function docOpOf(r: Wire): DocOpResult {
  const path = str(pick(r, "_path", "path"));
  return { id: str(pick(r, "_id", "id")), path: path === null ? null : rooted(path), committed: r.committed === true };
}
