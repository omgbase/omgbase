// Session references (11 shell). The shell stores typed command results and
// dereferences them; it does NOT filter/map/traverse — that stays OQX's job.
//
// Three reference roots, all written with `@` (OQX already owns `$…`):
//   @N        row N (1-based) of the most recent displayed collection frame
//   @_        the previous command's typed result
//   @name     a named binding (`@name = …`)
// Each may carry a shallow tail: an optional `[i]` (1-based collection index)
// then an optional `.field`. That is the whole grammar — deeper access is a
// signal to use OQX instead.

export class RefError extends Error {}

/** A selectable item within a displayed collection or a bound collection. */
export interface Row {
  /** The argv string this row substitutes to (an id, locator, path, or scalar). */
  ref: string;
  /** Human label for `bindings` / frame listings. */
  label: string;
  /** The underlying typed value (for `.field` access). */
  value: unknown;
}

/** A captured command result: the whole typed value plus any selectable rows. */
export interface Captured {
  value: unknown;
  /** Non-null ⇒ this result is a selectable collection (replaces the frame). */
  rows: Row[] | null;
}

const REF_RE = /^@(\d+|_|[A-Za-z][\w-]*)(?:\[(\d+)\])?(?:\.([A-Za-z_]\w*))?$/;

export interface ParsedRef {
  base: string; // "1", "_", or a name
  index?: number; // 1-based, if [i] present
  field?: string;
}

/** Parse a whole-token reference; null if the token isn't a reference. */
export function parseRef(token: string): ParsedRef | null {
  if (!token.startsWith("@")) return null;
  const m = REF_RE.exec(token);
  if (!m) throw new RefError(`bad reference '${token}' (use @N, @_, @name, optional [i] and .field)`);
  const out: ParsedRef = { base: m[1]! };
  if (m[2] !== undefined) out.index = Number(m[2]);
  if (m[3] !== undefined) out.field = m[3];
  return out;
}

/**
 * Derive the selectable rows of a captured value. Returns null when the value
 * is a card / scalar / text (no collection) — the caller then leaves the
 * numbered frame intact (the note's "showing one thing shouldn't destroy the
 * frame"). Returns an array (possibly empty) when the value IS a collection.
 */
export function deriveRows(value: unknown): Row[] | null {
  if (Array.isArray(value)) return value.map(rowOf);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (Array.isArray(o.hits)) return o.hits.map(rowOf); // query/oqx
    if (Array.isArray(o.digests)) return o.digests.map(rowOf); // log
    if (Array.isArray(o.results) && Array.isArray(o.revisions)) {
      // ApplyResult: the minted/affected ids, flattened (one row per id).
      const ids: string[] = [];
      for (const r of o.results as { ids?: unknown }[]) {
        if (Array.isArray(r.ids)) for (const id of r.ids) if (typeof id === "string") ids.push(id);
      }
      return ids.map((id) => ({ ref: id, label: id, value: id }));
    }
    if (Array.isArray(o.in) || Array.isArray(o.out)) {
      // links: both directions, each edge's far node is the selectable ref.
      const edges = [...((o.out as unknown[]) ?? []), ...((o.in as unknown[]) ?? [])];
      return edges.map(rowOf);
    }
  }
  return null;
}

function rowOf(el: unknown): Row {
  if (typeof el === "string") return { ref: el, label: el, value: el };
  if (el && typeof el === "object") {
    const o = el as Record<string, unknown>;
    const ref = firstString(o, ["id", "node", "block", "locator", "path"]);
    const label = firstString(o, ["path", "locator", "name", "id", "node"]) ?? ref ?? preview(o);
    return { ref: ref ?? label ?? "", label: label ?? "", value: el };
  }
  const s = String(el);
  return { ref: s, label: s, value: el };
}

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) if (typeof o[k] === "string") return o[k] as string;
  return undefined;
}

function preview(o: Record<string, unknown>): string {
  const s = JSON.stringify(o);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

/**
 * Coerce a resolved value to a single argv string. Entities collapse to their
 * id/locator; scalars stringify; a bare collection is an error (the caller must
 * pick a row with `[i]`) — the shell never flattens a collection into one arg.
 */
export function coerce(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) throw new RefError("reference is empty");
  if (Array.isArray(value)) {
    throw new RefError(`reference is a collection of ${value.length}; select one with [i]`);
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const ref = firstString(o, ["id", "node", "block", "locator", "path"]);
    if (ref) return ref;
    // A collection-shaped result object (e.g. {hits:[…]}) can't be one arg.
    if (deriveRows(value)) throw new RefError("reference is a collection; select one with [i]");
    throw new RefError("reference has no id/locator to use as an argument");
  }
  throw new RefError("reference is not usable as an argument");
}
