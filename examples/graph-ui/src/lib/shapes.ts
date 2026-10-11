// Tool-result shapes across surface versions — the sibling of lib/paths.ts
// for everything that is NOT a query hit. Surface 3.0 (spec/surface §1.2,
// §2–§4) made one rule of every result: a row's identity is `id`/`path`, its
// bytes `raw`, its hash `hash`, its time `updated_at`, and every other
// engine-provided name is a plain snake_case field (`doc_id`, `block_id`,
// `dst_id`, `dst_path`, `uri`, `field`). Before 3.0 each tool had its own
// spelling (`docId`/`path`, `content`, `src`/`dst`/`dst_uri`/`src_field`, …)
// and the link rows' intrinsics were `$path`/`$dst_path`/`$src`/`$dst`/
// `$dst_uri` with the field `src_field`. 3.0 also renamed the ROW KIND the
// link relations scan (spec/surface §1.1): `from links` / `^links` /
// `out_links` / `in_links` where every earlier server said `edges` (`from
// edges` is an unknown target on 3.0), and the `graph` tool's array of them
// is `links[]` (`edges[]` before). Brendan's remote may lag the local build,
// so every reader here is keyed on the connected server's surface
// (`surfaceMajor`, lib/paths.ts) and normalises to ONE internal shape; nothing
// else in the demo spells a wire key. An unknown version (`null`) reads as 2.x
// — what a server without the `version` tool is.

import { rooted, surfaceMajor } from "./paths.ts";

/** Does the server spell rows the 3.0 way (`id`/`path`/`raw`/`hash` on every
 * tool, plain foreign keys)? An unknown version is taken as 2.x. */
export function surface3(surface: string | null): boolean {
  return (surfaceMajor(surface) ?? 1) >= 3;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

// ---- the link rows (`links` / `edges`) in a query --------------------------------------

/** The row kind the link relations scan, as the connected server names it in
 * OQX (spec/surface §1.1): `links` on ≥ 3.0 (`from links`, `^links`), `edges`
 * before — a 3.0 server refuses `from edges` as an unknown target and a 2.x
 * one knows no `links`. The row's attribute names are `edgeFields`'. */
export function linksTarget(surface: string | null): "links" | "edges" {
  return surface3(surface) ? "links" : "edges";
}

/** The doc relations that yield link rows, per server: `out_links`/`in_links`
 * on ≥ 3.0, `out_edges`/`in_edges` before (`out`/`in` — the documents at the
 * other end — did not change). */
export function linkRelations(surface: string | null): { out: string; in: string } {
  return surface3(surface) ? { out: "out_links", in: "in_links" } : { out: "out_edges", in: "in_edges" };
}

/** The link rows' field spellings on the connected server: the OQX the
 * demo generates (lib/edges.ts) names the destination path and the authored
 * field, which 3.0 renamed. */
export interface EdgeFields {
  /** The source document's path (the edge's own path attribute): `path` (≥ 3.0) / `$path`. */
  path: string;
  /** The destination document's path: `dst_path` (≥ 3.0) / `$dst_path`. */
  dstPath: string;
  /** The frontmatter key / inline field an edge was authored in: `field` / `src_field`. */
  field: string;
  /** The source document: `doc_id` / `$src`. */
  docId: string;
  /** The destination node: `dst_id` / `$dst`. */
  dstId: string;
  /** An external destination's URL: `uri` / `$dst_uri`. */
  uri: string;
}

export function edgeFields(surface: string | null): EdgeFields {
  return surface3(surface)
    ? { path: "path", dstPath: "dst_path", field: "field", docId: "doc_id", dstId: "dst_id", uri: "uri" }
    : { path: "$path", dstPath: "$dst_path", field: "src_field", docId: "$src", dstId: "$dst", uri: "$dst_uri" };
}

// ---- the `graph` tool ----------------------------------------------------------------

/** The `graph` result's link rows, under whichever key the server used:
 * `links[]` on ≥ 3.0, `edges[]` before (the same row shape, `edgeOf`). */
export function graphEdgeRows(surface: string | null, result: Record<string, unknown>): Record<string, unknown>[] {
  const rows = result[linksTarget(surface)];
  return Array.isArray(rows) ? rows.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object") : [];
}

/** A `graph` edge (one `links[]` / `edges[]` row), normalised: `{ id, doc_id,
 * block_id, via_id, dst_id, dst_path, uri, dst_kind, predicate, provenance,
 * anchor, field }` on ≥ 3.0, `{ id, src, dst, dst_path, dst_uri, dst_kind,
 * predicate, provenance, anchor, src_field }` before (no block/via there).
 * Paths are rooted. */
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

export function edgeOf(surface: string | null, e: Record<string, unknown>): GraphToolEdge | null {
  const v3 = surface3(surface);
  const id = str(e.id);
  const docId = str(v3 ? e.doc_id : e.src);
  const dstId = str(v3 ? e.dst_id : e.dst);
  if (id === null || docId === null || dstId === null) return null;
  const dstPath = str(e.dst_path);
  return {
    id, docId, dstId,
    blockId: v3 ? str(e.block_id) : null,
    viaId: v3 ? str(e.via_id) : null,
    dstPath: dstPath === null ? null : rooted(dstPath),
    uri: str(v3 ? e.uri : e.dst_uri),
    dstKind: str(e.dst_kind),
    predicate: str(e.predicate),
    provenance: str(e.provenance),
    anchor: str(e.anchor),
    field: str(v3 ? e.field : e.src_field),
  };
}

/** A `graph` document (or frontier entry): `{ id, path, degree, frontier,
 * …select }` on every version. The extra projections are kept under their own
 * keys (an `id`/`path` selection collapses onto the envelope; any other bare
 * name is a plain column). */
export interface GraphToolDoc {
  id: string;
  /** `/`-rooted. */
  path: string;
  degree: number | null;
  frontier: boolean;
  fields: Record<string, unknown>;
}

export function docOf(_surface: string | null, d: Record<string, unknown>): GraphToolDoc | null {
  const id = str(d.id);
  const path = str(d.path);
  if (id === null || path === null) return null;
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (k !== "id" && k !== "path" && k !== "degree" && k !== "frontier") fields[k] = v;
  return { id, path: rooted(path), degree: num(d.degree), frontier: d.frontier === true, fields };
}

// ---- docs_read / docs_set_meta -------------------------------------------------------

/** `docs_read`: `{ id, path, rev, properties, raw }` on ≥ 3.0, `{ path,
 * docId, rev, properties, content }` before. */
export interface DocRead {
  id: string | null;
  path: string | null;
  rev: string | null;
  raw: string | null;
  frontmatter: Record<string, unknown>;
}

export function docReadOf(surface: string | null, r: Record<string, unknown>): DocRead {
  const v3 = surface3(surface);
  const path = str(r.path);
  const props = (r.properties as { frontmatter?: Record<string, unknown> } | undefined)?.frontmatter;
  return {
    id: str(v3 ? r.id : r.docId),
    path: path === null ? null : rooted(path),
    rev: str(r.rev),
    raw: str(v3 ? r.raw : r.content),
    frontmatter: props && typeof props === "object" ? props : {},
  };
}

/** A document operation's result (`docs_set_meta`, `docs_create`, …): `{ id,
 * path, committed }` on ≥ 3.0, `{ docId, path, committed }` before. */
export interface DocOpResult {
  id: string | null;
  path: string | null;
  committed: boolean;
}

export function docOpOf(surface: string | null, r: Record<string, unknown>): DocOpResult {
  const path = str(r.path);
  return { id: str(surface3(surface) ? r.id : r.docId), path: path === null ? null : rooted(path), committed: r.committed === true };
}
