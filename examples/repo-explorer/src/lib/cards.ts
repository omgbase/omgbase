// The graph's card settings: one default card template, an optional card
// EXPRESSION, and optionally a VARIATION by a field of the user's choosing —
// `by.field` names the row field whose value picks a template from
// `by.templates` (Brendan's repos use `type`; another repository may use
// `kind`, `layer`, nothing). Nothing here assumes a vocabulary: the field is
// the user's, the element sees only rows and a hook.
//
// The convention the page follows: the row key `card` — a BARE name, the
// user's namespace (a `_`-name the engine does not know is a hard error, a
// `$`-name is the language's) — authored in a document's frontmatter or
// computed by the projection alias the expression setting adds
// (`card: _title + " · " + status`, OQX); the default template `{card|_title}`
// reads it with the title as the fallback, so a query that yields `card` shapes
// the cards with no template at all. Persisted as JSON in localStorage
// (`omgbase-repo-explorer.cards`); `templateFor` is what the page hands
// `<omg-graph>`'s `renderCard` hook (the string-return case: a template per
// node), `allCardFields` the union of placeholders every template needs plus
// the discriminator — the fields `fetchFields` projects, `computedFields` the
// alias the expression computes. The template language is @omgbase/elements's
// (`renderCard`): `{field}`, `{a|b}` first present, dotted paths, literal text.

import { cardFields, readField } from "@omgbase/elements/graph";

export const CARDS_KEY = "omgbase-repo-explorer.cards";

/** The row key a card reads first, by convention; the expression setting computes it. */
export const CARD_KEY = "card";
/** This page's default template: the `card` key, else the title. */
export const DEFAULT_CARD = `{${CARD_KEY}|_title}`;

export interface CardVariation {
  /** The row field whose value picks the template. */
  field: string;
  /** Value → template; an empty template inherits the default. */
  templates: Record<string, string>;
}

export interface CardSettings {
  default: string;
  /** An OQX expression computing the `card` key for every row (`_title + " · " + status`); "" = none (an authored `card` is read as is). */
  expression: string;
  /** null: every card uses the default. */
  by: CardVariation | null;
}

export const DEFAULT_CARD_SETTINGS: CardSettings = { default: DEFAULT_CARD, expression: "", by: null };

function templatesOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, t] of Object.entries(v as Record<string, unknown>)) if (typeof t === "string" && t.trim() !== "") out[k] = t;
  }
  return out;
}

/** The stored JSON read back; anything malformed falls back to the defaults (a bare string is a default
 * template). The earlier `{ byType }` shape migrates to `{ by: { field: "type", templates } }`. */
export function parseCardSettings(json: string | null | undefined): CardSettings {
  if (!json) return { ...DEFAULT_CARD_SETTINGS };
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v === "string") return { default: v.trim() || DEFAULT_CARD, expression: "", by: null };
    if (v === null || typeof v !== "object" || Array.isArray(v)) return { ...DEFAULT_CARD_SETTINGS };
    const o = v as Record<string, unknown>;
    // A default saved before the `card` convention (the `_display` days) is the current default.
    const def = typeof o.default === "string" && o.default.trim() !== "" && o.default.trim() !== "{_display|_title}" ? o.default : DEFAULT_CARD;
    const expression = typeof o.expression === "string" ? o.expression.trim() : "";
    let by: CardVariation | null = null;
    if (o.by !== null && typeof o.by === "object" && !Array.isArray(o.by)) {
      const b = o.by as Record<string, unknown>;
      const field = typeof b.field === "string" ? b.field.trim() : "";
      if (field !== "") by = { field, templates: templatesOf(b.templates) };
    } else if (o.byType !== undefined) {
      const templates = templatesOf(o.byType);
      by = Object.keys(templates).length > 0 ? { field: "type", templates } : null;
    }
    return { default: def, expression, by };
  } catch {
    return { ...DEFAULT_CARD_SETTINGS };
  }
}

export function serializeCardSettings(s: CardSettings): string {
  const by = s.by && s.by.field.trim() !== "" ? { field: s.by.field.trim(), templates: templatesOf(s.by.templates) } : null;
  return JSON.stringify({ default: s.default.trim() || DEFAULT_CARD, expression: s.expression.trim(), by });
}

/** The projection aliases the settings compute: `{ card: <expression> }`, or nothing. */
export function computedFields(s: CardSettings): Record<string, string> {
  return s.expression.trim() ? { [CARD_KEY]: s.expression.trim() } : {};
}

/** A row value as a template key: a string as is, a list's first entry, another scalar stringified, else null. */
export function valueKey(v: unknown): string | null {
  const x = Array.isArray(v) ? v[0] : v;
  if (x === null || x === undefined || x === "") return null;
  if (typeof x === "string") return x;
  if (typeof x === "number" || typeof x === "boolean" || typeof x === "bigint") return String(x);
  return null;
}

/** The template for a row: the variation's template for `row[by.field]` when set and non-empty, else the default. */
export function templateFor(s: CardSettings, row: Record<string, unknown>): string {
  if (!s.by || s.by.field.trim() === "") return s.default;
  const key = valueKey(readField(row, s.by.field));
  const t = key === null ? undefined : s.by.templates[key];
  return t && t.trim() !== "" ? t : s.default;
}

/** Every placeholder any template reads plus the discriminator field, deduplicated, the default's first. */
export function allCardFields(s: CardSettings): string[] {
  const out = cardFields(s.default);
  if (s.by && s.by.field.trim() !== "") {
    if (!out.includes(s.by.field)) out.push(s.by.field);
    for (const t of Object.values(s.by.templates)) for (const f of cardFields(t)) if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** The distinct values of `field` among rows (lists spread), sorted, for the variation editor. */
export function valuesPresent(rows: Iterable<Record<string, unknown>>, field: string): string[] {
  const out = new Set<string>();
  if (field.trim() === "") return [];
  for (const r of rows) {
    const v = readField(r, field);
    for (const x of Array.isArray(v) ? v : [v]) { const k = valueKey(x); if (k !== null) out.add(k); }
  }
  return [...out].sort();
}
