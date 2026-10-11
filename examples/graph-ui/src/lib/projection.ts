// Projection reflection — which fields a result row carries, and which of them
// a node card shows by default. Read off the parsed query's `select` (the query
// is the contract: adding a field to `select` adds it to the panel), or, for an
// empty projection ("the row itself"), off the rows that came back.
//
// Rules:
//   1. `select` items, in source order, keyed by the item's `name` (the alias, or
//      the navigation's last segment — the key the row carries):
//        - a `field` item whose expression is a bare `$`-intrinsic (`$path`,
//          `$title`, `$id`, `$updated_at`, …, aliased or not) → kind `intrinsic`;
//        - any other `field` item (a frontmatter field, a navigation, an
//          arithmetic alias) → kind `field`;
//        - a `collect` item (a `collect` / `first` / `single` block — the only
//          consumers the parser admits in select position) → kind `nested`;
//        - a lift (`^name: …`) binds a value one scope out and is not a key of
//          the row, so it is skipped (the parser only admits lifts inside a
//          where-position `collect { … }`, so a top-level select has none).
//      Duplicate names are a parse error, so the list is already a set.
//      Under `values` the projection is a single unnamed value: one field of
//      kind `values` (the item's name when it has one, else `value`).
//   2. An empty projection, or no parsable query: the union of the keys the
//      rows carry, in first-seen order — `$`-prefixed keys are `intrinsic`,
//      arrays and records `nested`, everything else `field`.
//   3. Defaults: the LABEL (the card's title line) is the first of `$title`,
//      `title`, `name` that is projected, else null (= the de-rooted document
//      path, which is always available); SHOWN is the label alone, so cards
//      stay small until a field is asked for.

import type { Expr, Query, SelectItem, Span } from "@omgbase/oqx";
import type { Row } from "./candidates.ts";
import { HIT_ENVELOPE_KEYS } from "./paths.ts";

export type ProjectedKind = "intrinsic" | "field" | "nested" | "values";

export interface ProjectedField {
  /** The key the row carries (the select item's name). */
  name: string;
  kind: ProjectedKind;
  /** Source span (code points) of the select item, for the editor to highlight; null for a field read off the rows. */
  span: Span | null;
  /** Where it was found: the query's `select`, or the returned rows (empty projection). */
  source: "select" | "row";
}

/** What a card shows: the field whose value is the title line (null = the
 * document path), and the fields listed under it, in projection order. */
export interface ProjectionChoice {
  label: string | null;
  shown: string[];
}

export interface Projection {
  fields: ProjectedField[];
  defaults: ProjectionChoice;
}

/** The names tried, in order, for the default label. */
export const LABEL_PREFERENCE = ["$title", "title", "name"];

export const EMPTY_PROJECTION: Projection = { fields: [], defaults: { label: null, shown: [] } };

/** The pure reflection. `query` may be null (unparsable source) — the rows alone still describe themselves. */
export function projectionOf(query: Query | null, rows: readonly Row[] = []): Projection {
  const fields = query && query.select.length > 0 ? selectFields(query) : rowFields(rows);
  return { fields, defaults: defaultChoice(fields) };
}

export function defaultChoice(fields: readonly ProjectedField[]): ProjectionChoice {
  const label = LABEL_PREFERENCE.find((n) => fields.some((f) => f.name === n)) ?? null;
  return { label, shown: label === null ? [] : [label] };
}

function selectFields(query: Query): ProjectedField[] {
  if (query.values) {
    const item = query.select[0]!;
    return [{ name: item.name || "value", kind: "values", span: item.span, source: "select" }];
  }
  const out: ProjectedField[] = [];
  for (const item of query.select) {
    const kind = selectKind(item);
    if (kind === null || item.name === "") continue;
    out.push({ name: item.name, kind, span: item.span, source: "select" });
  }
  return out;
}

/** The kind of one select item, or null when it adds no key to the row (a lift). */
export function selectKind(item: SelectItem): ProjectedKind | null {
  if (item.kind === "collect") return "nested";
  if (item.lift > 0) return null;
  return isIntrinsic(item.expr) ? "intrinsic" : "field";
}

/** A bare `$name` read (`$path`, `$title`, …) — not `$it.title` (a navigation). */
export function isIntrinsic(expr: Expr): boolean {
  return expr.kind === "ident" && expr.name.startsWith("$") && expr.name !== "$it";
}

/** The keys the rows carry, in first-seen order, kinded by their values — minus
 * the hit envelope (`$id`/`$path` since surface 3.0, `id`/`path` before): the
 * row's identity is not a projected field, whichever server spelled it. */
export function rowFields(rows: readonly Row[]): ProjectedField[] {
  const byName = new Map<string, ProjectedField>();
  for (const row of rows) {
    for (const [name, value] of Object.entries(row)) {
      if (HIT_ENVELOPE_KEYS.has(name)) continue;
      const existing = byName.get(name);
      const kind = valueKind(name, value);
      if (!existing) byName.set(name, { name, kind: kind ?? "field", span: null, source: "row" });
      // A key seen first with a null value takes its kind from the first non-null one.
      else if (kind !== null && existing.kind === "field" && kind !== "field") existing.kind = kind;
    }
  }
  return [...byName.values()];
}

function valueKind(name: string, value: unknown): ProjectedKind | null {
  if (name.startsWith("$")) return "intrinsic";
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) || typeof value === "object") return "nested";
  return "field";
}
