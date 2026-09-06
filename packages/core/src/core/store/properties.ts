import type { Database } from "better-sqlite3";
import { hashHex } from "../hash.js";

// Properties store (12-properties-table). Flattens document properties —
// frontmatter, inline (key:: value), computed ($title/$tags) — into typed,
// indexed rows. `card` records the authored shape so scalar comparisons match
// only scalar-authored rows while list() sees all. Deterministic ordering:
// source rank, then authored order (ord), then key — see docs/12 §9.

export type PropertySource = "frontmatter" | "inline" | "computed";
export type PropertyCard = "scalar" | "list";
export type PropertyType = "string" | "number" | "bool" | "null" | "json";

export interface PropertyRow {
  source: PropertySource;
  blockId: string | null;
  key: string;
  card: PropertyCard;
  ord: number;
  valText: string | null;
  valNum: number | null;
  valBool: number | null;
  valJson: string | null;
  type: PropertyType;
}

// Deterministic id: a property row is identified by its document, source, key,
// and ordinal position within that (source,key). Same bytes ⇒ same id.
function propId(docId: string, source: string, key: string, ord: number): string {
  return "p_" + hashHex(`${docId}|${source}|${key}|${ord}`).slice(0, 12);
}

// Classify a single JSON scalar into a typed column. Objects/arrays are not
// scalars — callers flatten those before reaching here.
function typedValue(v: unknown): Pick<PropertyRow, "valText" | "valNum" | "valBool" | "valJson" | "type"> {
  if (v === null || v === undefined) return { valText: null, valNum: null, valBool: null, valJson: null, type: "null" };
  if (typeof v === "boolean") return { valText: null, valNum: null, valBool: v ? 1 : 0, valJson: null, type: "bool" };
  if (typeof v === "number") return { valText: null, valNum: v, valBool: null, valJson: null, type: "number" };
  if (typeof v === "string") return { valText: v, valNum: null, valBool: null, valJson: null, type: "string" };
  // object / array that resisted flattening: escape hatch.
  return { valText: null, valNum: null, valBool: null, valJson: JSON.stringify(v), type: "json" };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Flatten a parsed frontmatter object into property rows.
//  - nested maps → dotted keys (meta.owner)
//  - arrays → one card='list' row per element, ord 0..n (scalars only; an array
//    of objects goes to a single val_json row rather than exploding structure)
//  - scalars → one card='scalar' row
export function flattenFrontmatter(obj: Record<string, unknown>): Omit<PropertyRow, "source" | "blockId">[] {
  const rows: Omit<PropertyRow, "source" | "blockId">[] = [];
  const walk = (value: unknown, key: string): void => {
    if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}.${k}` : k);
      return;
    }
    if (Array.isArray(value)) {
      const allScalar = value.every((e) => !isPlainObject(e) && !Array.isArray(e));
      if (allScalar) {
        value.forEach((e, ord) => rows.push({ key, card: "list", ord, ...typedValue(e) }));
      } else {
        // array of objects / nested arrays: keep as one json row (escape hatch).
        rows.push({ key, card: "list", ord: 0, ...typedValue(value) });
      }
      return;
    }
    rows.push({ key, card: "scalar", ord: 0, ...typedValue(value) });
  };
  for (const [k, v] of Object.entries(obj)) walk(v, k);
  return rows;
}

// Flatten computed properties (adapter computeProperties output) into rows.
// Keys are already $-prefixed intrinsics ($title, $tags); a value is a scalar
// (one scalar row) or an array of scalars (ord-indexed list rows).
export function flattenComputed(obj: Record<string, unknown>): Omit<PropertyRow, "source" | "blockId">[] {
  const rows: Omit<PropertyRow, "source" | "blockId">[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      value.forEach((e, ord) => rows.push({ key, card: "list", ord, ...typedValue(e) }));
    } else {
      rows.push({ key, card: "scalar", ord: 0, ...typedValue(value) });
    }
  }
  return rows;
}

export function deleteDocProperties(db: Database, docId: string): void {
  db.prepare("DELETE FROM properties WHERE doc_id = ?").run(docId);
}

interface StoredRow {
  source: PropertySource; key: string; card: PropertyCard; ord: number;
  val_text: string | null; val_num: number | null; val_bool: number | null; val_json: string | null; type: PropertyType;
}

function decode(r: StoredRow): unknown {
  switch (r.type) {
    case "string": return r.val_text;
    case "number": return r.val_num;
    case "bool": return r.val_bool === 1;
    case "null": return null;
    case "json": return r.val_json ? JSON.parse(r.val_json) : null;
  }
}

// Collapse a key's rows to the authored shape: a lone scalar row → the scalar;
// anything else (list rows, or multiple values) → an array in (source-rank,
// ord) order. Deterministic — see docs/12 §9.
const SOURCE_RANK: Record<PropertySource, number> = { frontmatter: 0, inline: 1, computed: 2 };

function shapeValues(rows: StoredRow[]): unknown {
  if (rows.length === 1 && rows[0]!.card === "scalar") return decode(rows[0]!);
  const ordered = [...rows].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.ord - b.ord);
  return ordered.map(decode);
}

/**
 * Effective (merged) property bag for a document: each key mapped to its
 * authored-shaped value (scalar or array), unioned across authored sources
 * (frontmatter + inline). Computed `$`-keys are included under their `$` name.
 * This is the projection/hydration view that replaces documents.metadata.
 */
export function docPropertiesMerged(db: Database, docId: string): Record<string, unknown> {
  const rows = db.prepare(
    "SELECT source, key, card, ord, val_text, val_num, val_bool, val_json, type FROM properties WHERE doc_id = ? AND deleted_commit IS NULL",
  ).all(docId) as StoredRow[];
  const byKey = new Map<string, StoredRow[]>();
  for (const r of rows) {
    const g = byKey.get(r.key) ?? [];
    g.push(r);
    byKey.set(r.key, g);
  }
  const out: Record<string, unknown> = {};
  for (const [key, group] of byKey) out[key] = shapeValues(group);
  return out;
}

/** Properties grouped by source (docs_read shape): {frontmatter, inline, computed}. */
export function docPropertiesGrouped(db: Database, docId: string): Record<PropertySource, Record<string, unknown>> {
  const rows = db.prepare(
    "SELECT source, key, card, ord, val_text, val_num, val_bool, val_json, type FROM properties WHERE doc_id = ? AND deleted_commit IS NULL",
  ).all(docId) as StoredRow[];
  const grouped: Record<PropertySource, Map<string, StoredRow[]>> = {
    frontmatter: new Map(), inline: new Map(), computed: new Map(),
  };
  for (const r of rows) {
    const m = grouped[r.source];
    const g = m.get(r.key) ?? [];
    g.push(r);
    m.set(r.key, g);
  }
  const out = { frontmatter: {}, inline: {}, computed: {} } as Record<PropertySource, Record<string, unknown>>;
  for (const src of ["frontmatter", "inline", "computed"] as const) {
    for (const [key, group] of grouped[src]) out[src][key] = shapeValues(group);
  }
  return out;
}

// Replace a document's property rows. Deterministic prop_id per (source,key,ord)
// gives dedup/stable identity; a genuine duplicate (same source+key+ord) is
// collapsed by the primary key (INSERT OR REPLACE).
export function writeDocProperties(
  db: Database,
  repoId: string,
  docId: string,
  createdCommit: string,
  rows: PropertyRow[],
): number {
  deleteDocProperties(db, docId);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO properties
       (prop_id, repo_id, doc_id, block_id, source, key, card, ord,
        val_text, val_num, val_bool, val_json, type, created_commit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    insert.run(
      propId(docId, r.source, r.key, r.ord), repoId, docId, r.blockId, r.source, r.key, r.card, r.ord,
      r.valText, r.valNum, r.valBool, r.valJson, r.type, createdCommit,
    );
  }
  return rows.length;
}
