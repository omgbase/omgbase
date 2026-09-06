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

export function deleteDocProperties(db: Database, docId: string): void {
  db.prepare("DELETE FROM properties WHERE doc_id = ?").run(docId);
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
