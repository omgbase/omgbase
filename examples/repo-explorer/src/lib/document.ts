// One document: `docs_read { id | path, include_ids: true }` (spec/surface §2)
// — `{ id, path, rev, properties: { frontmatter, inline, computed }, raw, ids
// (pre-order), hashes (block id → sha256 of its raw), parents (block id →
// parent id | null) }` — and the same document as of a revision, `docs_read {
// id | path, at }` (4.7) — `{ id, path (as of the revision), rev, raw,
// renderedHashMatch }` and nothing else (no properties at a past revision; a
// client parses `raw`). The pure side: wire → shapes, the property table's
// rows, the frontmatter/body split the renderer needs.

import { repoArg, type Caller, type Wire } from "./mcp-client.ts";
import { rooted } from "./paths.ts";

export interface BlockIds {
  /** Every live block id in pre-order (document order). */
  ids: string[];
  /** Block id → its parent block id, null at the top level. */
  parents: Record<string, string | null>;
  /** Block id → sha256 (hex) of the block's raw source. */
  hashes: Record<string, string>;
}

export interface DocProperties {
  frontmatter: Record<string, unknown>;
  inline: Record<string, unknown>;
  computed: Record<string, unknown>;
}

export interface DocRead {
  id: string;
  path: string;
  rev: string;
  properties: DocProperties;
  raw: string;
  /** Present when the read asked for `include_ids`. */
  blockIds: BlockIds | null;
}

export interface DocAt {
  id: string;
  path: string;
  rev: string;
  raw: string;
  renderedHashMatch: boolean;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function blockIdsOf(wire: Wire): BlockIds | null {
  if (!Array.isArray(wire.ids)) return null;
  const ids = (wire.ids as unknown[]).filter((x): x is string => typeof x === "string");
  const parents: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(record(wire.parents))) parents[k] = typeof v === "string" ? v : null;
  const hashes: Record<string, string> = {};
  for (const [k, v] of Object.entries(record(wire.hashes))) if (typeof v === "string") hashes[k] = v;
  return { ids, parents, hashes };
}

export function docReadOf(wire: Wire): DocRead {
  const p = record(wire.properties);
  return {
    id: str(wire.id),
    path: rooted(str(wire.path)),
    rev: str(wire.rev),
    properties: { frontmatter: record(p.frontmatter), inline: record(p.inline), computed: record(p.computed) },
    raw: str(wire.raw),
    blockIds: blockIdsOf(wire),
  };
}

export function docAtOf(wire: Wire): DocAt {
  return { id: str(wire.id), path: rooted(str(wire.path)), rev: str(wire.rev), raw: str(wire.raw), renderedHashMatch: wire.renderedHashMatch === true };
}

/** `docs_read { id | path, include_ids: true }` — the whole document with its block ids. */
export async function fetchDocument(caller: Caller, locator: Record<string, string>, repo: string | null): Promise<DocRead> {
  return docReadOf(await caller.call<Wire>("docs_read", { ...locator, include_ids: true, ...repoArg(repo) }));
}

/** `docs_read { id | path, at: <rev> }` — the document's bytes as of a revision (4.7). */
export async function fetchDocumentAt(caller: Caller, locator: Record<string, string>, rev: string, repo: string | null): Promise<DocAt> {
  return docAtOf(await caller.call<Wire>("docs_read", { ...locator, at: rev, ...repoArg(repo) }));
}

// ---- the property table -----------------------------------------------------------------

export type PropertySource = "frontmatter" | "inline" | "computed";

export interface PropertyRow {
  source: PropertySource;
  key: string;
  value: unknown;
  /** The value as shown: a string as it is, anything else as JSON. */
  text: string;
}

/** A value as the table shows it. */
export function valueText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  return JSON.stringify(v);
}

/** Frontmatter keys first (authored order), then inline fields, then the computed ones. */
export function propertyRows(p: DocProperties): PropertyRow[] {
  const rows: PropertyRow[] = [];
  for (const source of ["frontmatter", "inline", "computed"] as const) {
    for (const [key, value] of Object.entries(p[source])) rows.push({ source, key, value, text: valueText(value) });
  }
  return rows;
}

// ---- frontmatter / body ------------------------------------------------------------------

export interface SplitDoc {
  /** The YAML between the fences (without them), or null when the file has no frontmatter. */
  frontmatter: string | null;
  /** The body: everything after the closing fence (the whole file without frontmatter). */
  body: string;
  /** The 0-based line of the file where `body` starts. */
  bodyLine: number;
}

/** YAML frontmatter as the format layer reads it: a first line `---`, then up
 * to the next line that is exactly `---` (or `...`); no closing fence → no frontmatter. */
export function splitFrontmatter(raw: string): SplitDoc {
  const lines = raw.split("\n");
  if (lines[0] !== "---") return { frontmatter: null, body: raw, bodyLine: 0 };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "...") {
      return { frontmatter: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n"), bodyLine: i + 1 };
    }
  }
  return { frontmatter: null, body: raw, bodyLine: 0 };
}

/** The document's title for a tab or header: the computed title, else the path's base name. */
export function docTitle(doc: Pick<DocRead, "properties" | "path">): string {
  const t = doc.properties.computed.title;
  return typeof t === "string" && t.trim() ? t : doc.path.slice(doc.path.lastIndexOf("/") + 1);
}
