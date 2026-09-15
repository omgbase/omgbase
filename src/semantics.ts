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
//   • `in`: membership in an array (by ==), substring in a string, or key in an
//     object.

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
  if (Array.isArray(haystack)) return haystack.some((x) => equals(x, needle));
  if (typeof haystack === "string") return haystack.includes(String(needle));
  if (typeof haystack === "object") return String(needle) in (haystack as object);
  return false;
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

/** Free functions callable as `name(args)`. */
export const BUILTIN_FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  list: (args) => toList(args[0]),
  size: (args) => sizeOf(args[0]),
  has: (args) => args[0] != null,
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
