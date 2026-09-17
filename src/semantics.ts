// Normative scalar semantics — the single source of truth for how OQX values
// compare, combine, and coerce. Both the in-memory engine AND any pushdown
// adapter (SQL, remote, …) MUST produce results consistent with these rules; the
// conformance suite (test/conformance.test.ts) is what verifies a backend obeys
// them. When a backend cannot reproduce a rule in its native query language, it
// must leave that fragment as an in-memory RESIDUAL rather than approximate it.
//
// The rules (deliberately CEL-flavored, since OQX descends from omgbase's CEL
// layer):
//   • Absence: `undefined` and `null` are the same absent value.
//   • Equality (== / !=): typed and strict — no cross-type coercion, so
//     `5 == "5"` is false. Two absent values are equal.
//   • Ordering (< <= > >=): a comparison with an absent operand is false (never
//     throws, never orders). Numbers and strings order naturally; mixed types do
//     not order (false).
//   • Truthiness: JavaScript truthiness of the value.
//   • `in`: membership in an array (by ==), substring in a string, key in an
//     object, or coverage by a range (lo..hi / lo...hi / open-ended).

/** Equality with absence-normalization (undefined ≡ null) and strict typing. */
export function equals(a: unknown, b: unknown): boolean {
  const x = a === undefined ? null : a;
  const y = b === undefined ? null : b;
  return x === y;
}

/** The six relational operators. Absent operands (for ordering ops) yield false. */
export function relate(op: string, a: unknown, b: unknown): boolean {
  if (op === "==") return equals(a, b);
  if (op === "!=") return !equals(a, b);
  if (a == null || b == null) return false;
  switch (op) {
    case "<": return (a as never) < (b as never);
    case "<=": return (a as never) <= (b as never);
    case ">": return (a as never) > (b as never);
    case ">=": return (a as never) >= (b as never);
    default: throw new Error(`not a relational operator: ${op}`);
  }
}

/** Arithmetic. `+` concatenates when either side is a string. */
export function arith(op: string, a: unknown, b: unknown): unknown {
  if (op === "+" && (typeof a === "string" || typeof b === "string")) return String(a) + String(b);
  const x = toNumber(a);
  const y = toNumber(b);
  switch (op) {
    case "+": return x + y;
    case "-": return x - y;
    case "*": return x * y;
    case "/": return x / y;
    case "%": return x % y;
    default: throw new Error(`not an arithmetic operator: ${op}`);
  }
}

export function membership(needle: unknown, haystack: unknown): boolean {
  if (haystack == null) return false;
  if (isRange(haystack)) return rangeCovers(haystack, needle);
  if (Array.isArray(haystack)) return haystack.some((x) => equals(x, needle));
  if (typeof haystack === "string") return haystack.includes(String(needle));
  if (typeof haystack === "object") return String(needle) in (haystack as object);
  return false;
}

/** A Ruby-style range value produced by a `lo..hi` / `lo...hi` expression. A
 * null bound is an open end (`..hi` / `lo..`). `exclusiveEnd` marks the `...`
 * form (hi is excluded). Tagged so `membership`/`in` can recognize it among
 * plain objects. */
export interface OqxRange {
  readonly __oqxRange: true;
  readonly lo: unknown;
  readonly hi: unknown;
  readonly exclusiveEnd: boolean;
}

/** Construct a range value (absent bounds normalized to null → open end). */
export function makeRange(lo: unknown, hi: unknown, exclusiveEnd: boolean): OqxRange {
  return { __oqxRange: true, lo: lo ?? null, hi: hi ?? null, exclusiveEnd };
}

/** Whether a value is a range produced by `makeRange`. */
export function isRange(v: unknown): v is OqxRange {
  return typeof v === "object" && v !== null && (v as { __oqxRange?: unknown }).__oqxRange === true;
}

/** Whether `x` falls within `range`: `lo <= x` (when lo is present) and either
 * `x <= hi` (inclusive) or `x < hi` (exclusive end) (when hi is present). Bound
 * checks go through `relate`, so an absent `x` — or one that doesn't order
 * against a bound (mixed types) — is simply not covered (never throws). This
 * also makes date/time ranges work over ISO-8601 strings or `Date` values,
 * whose natural ordering `relate` already honors. */
export function rangeCovers(range: OqxRange, x: unknown): boolean {
  const geLo = range.lo == null || relate(">=", x, range.lo);
  const leHi = range.hi == null || relate(range.exclusiveEnd ? "<" : "<=", x, range.hi);
  return geLo && leHi;
}

export function truthy(v: unknown): boolean {
  return Boolean(v);
}

export function toNumber(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

export function sizeOf(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string" || Array.isArray(v)) return v.length;
  if (typeof v === "object") return Object.keys(v).length;
  return 0;
}

export function toList(v: unknown): unknown[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object" && typeof (v as Iterable<unknown>)[Symbol.iterator] === "function") {
    return Array.from(v as Iterable<unknown>);
  }
  return [v];
}

/** Normalize a host value into a queryable collection: arrays pass through,
 * non-string iterables are materialized, absence is empty, any other single
 * value becomes a one-element collection (a to-one relation). */
export function coerceCollection(v: unknown): unknown[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object" && typeof (v as Iterable<unknown>)[Symbol.iterator] === "function") {
    return Array.from(v as Iterable<unknown>);
  }
  return [v];
}

/** Total order for `order by`, with absent values sorting last. */
export function compareForSort(a: unknown, b: unknown): number {
  const an = a == null, bn = b == null;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if ((a as never) < (b as never)) return -1;
  if ((a as never) > (b as never)) return 1;
  return 0;
}

/** Parse a string as a range value (`1..5`, `1...5`, `..5`, `5..`, or an
 * ISO-8601 date range), or null if it is not a well-formed range. The operator
 * is a maximal run of 2 (`..`) or 3 (`...`) dots; a single dot is a decimal
 * point. Bounds must share a scalar domain — both numeric, or both ISO-8601 —
 * so an ordinary string is never mis-read. This is the runtime counterpart of
 * the `lo..hi` literal, for ranges that arrive as string data. */
export function parseRangeString(s: string): OqxRange | null {
  const m = /^(.*?)(\.\.\.?)(.*)$/.exec(s);
  if (!m) return null;
  const loRaw = m[1]!, dots = m[2]!, hiRaw = m[3]!;
  if (loRaw.endsWith(".") || hiRaw.startsWith(".")) return null; // non-maximal dot run
  const lo = loRaw.length ? loRaw : null;
  const hi = hiRaw.length ? hiRaw : null;
  if (lo === null && hi === null) return null;
  const exclusiveEnd = dots.length === 3;
  const present = [lo, hi].filter((b): b is string => b !== null);
  const NUM = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
  const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
  if (present.every((b) => NUM.test(b))) {
    return makeRange(lo === null ? null : Number(lo), hi === null ? null : Number(hi), exclusiveEnd);
  }
  if (present.every((b) => ISO.test(b))) return makeRange(lo, hi, exclusiveEnd);
  return null;
}

/** Free functions callable as `name(args)`. */
export const BUILTIN_FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  list: (args) => toList(args[0]),
  size: (args) => sizeOf(args[0]),
  has: (args) => args[0] != null,
  // Coerce a string to a range value (or pass a range through); anything else,
  // or a non-range string, is absent so `x in range(bad)` is simply false.
  range: (args) => (isRange(args[0]) ? args[0] : typeof args[0] === "string" ? parseRangeString(args[0]) : null),
};

/** Methods callable as `recv.name(args)`. */
export const BUILTIN_METHODS: Record<string, (recv: unknown, args: unknown[]) => unknown> = {
  contains: (recv, args) => {
    if (typeof recv === "string") return recv.includes(String(args[0]));
    if (Array.isArray(recv)) return recv.some((x) => equals(x, args[0]));
    return false;
  },
  startsWith: (recv, args) => typeof recv === "string" && recv.startsWith(String(args[0])),
  endsWith: (recv, args) => typeof recv === "string" && recv.endsWith(String(args[0])),
  matches: (recv, args) => recv != null && new RegExp(String(args[0])).test(String(recv)),
  size: (recv) => sizeOf(recv),
  lower: (recv) => String(recv).toLowerCase(),
  upper: (recv) => String(recv).toUpperCase(),
};
