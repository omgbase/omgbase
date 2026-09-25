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
//   • Ordering (< <= > >=): only number/number and string/string order — numbers
//     numerically, strings by Unicode code point. Every other pairing (an absent
//     operand, mixed types, booleans, containers) is false; nothing throws.
//   • Arithmetic: an absent operand makes the result absent (`+` included, even
//     when the other side is a string). `+` with a string side concatenates the
//     operands' string forms.
//   • Truthiness: absent, false, 0, -0, and "" are falsy; everything else truthy.
//   • `in`: membership in an array (by ==), substring in a string, OWN key of an
//     object, or coverage by a range (lo..hi / lo...hi / open-ended).
//   • Identity / structural keys: `canonicalKey` — a type-tagged serialization,
//     so `1` and `"1"` differ and object key order is ignored. Never `String()`.

import { OqxError } from "./errors.ts";

/** Equality with absence-normalization (undefined ≡ null) and strict typing. */
export function equals(a: unknown, b: unknown): boolean {
  const x = a === undefined ? null : a;
  const y = b === undefined ? null : b;
  return x === y;
}

/** Compare two strings by Unicode code point (not UTF-16 code unit): -1, 0, 1. */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!, cb = b.codePointAt(j)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}

/** The ordering of two values, or `undefined` when they do not order: only two
 * numbers (numerically) or two strings (by code point) order. Absent operands,
 * mixed types, booleans, arrays, and objects never order. */
export function compare(a: unknown, b: unknown): number | undefined {
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return compareStrings(a, b);
  return undefined;
}

/** The six relational operators. Pairs that do not order (see `compare`) yield false. */
export function relate(op: string, a: unknown, b: unknown): boolean {
  if (op === "==") return equals(a, b);
  if (op === "!=") return !equals(a, b);
  const c = compare(a, b);
  if (c === undefined) return false;
  switch (op) {
    case "<": return c < 0;
    case "<=": return c <= 0;
    case ">": return c > 0;
    case ">=": return c >= 0;
    default: throw new Error(`not a relational operator: ${op}`);
  }
}

/** The string form of a scalar (the text `+` concatenates and `.lower()` maps):
 * a string is itself; a number renders as a double with no fraction when
 * integer-valued (`-0` is `"0"`); booleans are the words. Absent has no string
 * form (`undefined`), so the operation using it yields absent. */
export function stringForm(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  return String(v);
}

/** Arithmetic. An absent operand makes the result absent; `+` concatenates the
 * string forms when either side is a string. */
export function arith(op: string, a: unknown, b: unknown): unknown {
  if (a == null || b == null) return undefined;
  if (op === "+" && (typeof a === "string" || typeof b === "string")) return stringForm(a)! + stringForm(b)!;
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
  if (typeof haystack === "string") { const s = stringForm(needle); return s !== undefined && haystack.includes(s); }
  if (typeof haystack === "object") { const s = stringForm(needle); return s !== undefined && Object.hasOwn(haystack, s); }
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
 * `x <= hi` (inclusive) or `x < hi` (exclusive end) (when hi is present). Only a
 * number or a string can be covered — an absent `x` is covered by no range, not
 * even a fully open one — and bound checks go through `relate`, so an `x` that
 * doesn't order against a bound (mixed types) is simply not covered (never
 * throws). ISO-8601 strings therefore make date ranges work. */
export function rangeCovers(range: OqxRange, x: unknown): boolean {
  if (typeof x !== "number" && typeof x !== "string") return false;
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

/** `size(x)`: a string's code-point count, an array's length, an object's own
 * key count; absent and other scalars are 0. */
export function sizeOf(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string") return codePointCount(v);
  if (Array.isArray(v)) return v.length;
  if (typeof v === "object") return Object.keys(v).length;
  return 0;
}

function codePointCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n++;
    if (s.codePointAt(i)! > 0xffff) i++;
  }
  return n;
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

/** Order for `order by`: absent values sort last; present values order by
 * `compare` (numbers numerically, strings by code point); a pair that does not
 * order (mixed types, booleans) is left where it is (compares equal). */
export function compareForSort(a: unknown, b: unknown): number {
  const an = a == null, bn = b == null;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return compare(a, b) ?? 0;
}

// ---- structural identity ----------------------------------------------------

/** A canonical, type-tagged serialization of a value, used wherever OQX needs a
 * value's IDENTITY as a key (`follow` cycle detection and dedup, `distinct`):
 * two values get the same key iff they are structurally equal — absent ≡ null,
 * numbers as doubles (`-0` ≡ `0`), object key order ignored. The type tags keep
 * `1`, `"1"`, and `true` apart, and `{}`/`[]` apart from every scalar. */
export function canonicalKey(v: unknown): string {
  if (v == null) return "n";
  switch (typeof v) {
    case "boolean": return v ? "t" : "f";
    case "number": return `d${v === 0 ? 0 : v}`;
    case "string": return `s${JSON.stringify(v)}`;
    case "object": {
      if (Array.isArray(v)) return `[${v.map(canonicalKey).join(",")}]`;
      if (isEntry(v)) return canonicalKey(v.value);
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalKey(o[k])}`).join(",")}}`;
    }
    default: return `?${String(v)}`;
  }
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

// ---- entries: the explicit record → collection bridge -----------------------
//
// A plain object is NOT iterable in OQX (`from ${obj}` is one row). `entries(x)`
// converts it explicitly into a collection of ENTRY values, each `{ key, value }`
// tagged (non-enumerably, so JSON/deepEqual see a plain record) so the engine
// can recognize one: when an entry becomes a query scope, the scope's ROW is
// the property's value (`$value`, bare names) and `$key` is scope metadata.
// Arrays yield numeric index keys; a Map yields its entries; null/scalars yield
// nothing. (Arrays never expose an implicit `$key` — `entries(arr)` is how you
// ask for the index.)

const ENTRY: unique symbol = Symbol.for("oqx.entry");

export interface OqxEntry {
  readonly key: unknown;
  readonly value: unknown;
  readonly [ENTRY]: true;
}

/** Construct an entry value (see entriesOf). */
export function makeEntry(key: unknown, value: unknown): OqxEntry {
  const e = { key, value } as { key: unknown; value: unknown; [ENTRY]?: true };
  Object.defineProperty(e, ENTRY, { value: true, enumerable: false });
  return e as OqxEntry;
}

/** Whether a value is an entry produced by `entries()` / `makeEntry`. */
export function isEntry(v: unknown): v is OqxEntry {
  return typeof v === "object" && v !== null && (v as { [ENTRY]?: unknown })[ENTRY] === true;
}

/** The entries of a host value: object → own enumerable (key, value) pairs in
 * insertion order; array → (index, element); Map → its entries; anything else
 * (absent, scalars, ranges) → none. */
export function entriesOf(v: unknown): OqxEntry[] {
  if (v == null || typeof v !== "object" || isRange(v)) return [];
  if (Array.isArray(v)) return v.map((x, i) => makeEntry(i, x));
  if (v instanceof Map) return Array.from(v, ([k, x]) => makeEntry(k, x));
  return Object.entries(v as Record<string, unknown>).map(([k, x]) => makeEntry(k, x));
}

/** Free functions callable as `name(args)`. */
export const BUILTIN_FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  list: (args) => toList(args[0]),
  entries: (args) => entriesOf(args[0]),
  size: (args) => sizeOf(args[0]),
  has: (args) => args[0] != null,
  // Coerce a string to a range value (or pass a range through); anything else,
  // or a non-range string, is absent so `x in range(bad)` is simply false.
  range: (args) => (isRange(args[0]) ? args[0] : typeof args[0] === "string" ? parseRangeString(args[0]) : null),
};

// ---- regex: the portable OQX dialect ----------------------------------------
//
// `matches(pattern)` compiles the pattern as a regular expression in the dialect
// both implementations share: literals, `.`, classes `[…]`, `\d \w \s`, the
// quantifiers `* + ? {m,n}`, alternation, grouping, anchors, escaped
// metacharacters. Lookaround and backreferences are rejected up front (so a
// query is portable to an engine without them), and a pattern the host cannot
// compile is an OQX eval error — never a host exception.

const regexCache = new Map<string, RegExp>();

/** Compile a `matches()` pattern, raising an `OqxError` (stage `eval`) for an
 * invalid pattern or one using a construct outside the OQX dialect. */
export function compileRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;
  const unsupported = findUnsupportedRegexConstruct(pattern);
  if (unsupported) {
    throw new OqxError(`${unsupported} is not supported in OQX regular expressions (pattern ${JSON.stringify(pattern)})`, "eval");
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new OqxError(`invalid regular expression ${JSON.stringify(pattern)}: ${e instanceof Error ? e.message.replace(/^Invalid regular expression: /, "") : String(e)}`, "eval");
  }
  if (regexCache.size >= 256) regexCache.clear();
  regexCache.set(pattern, re);
  return re;
}

// Scan a pattern (outside character classes, honoring escapes) for lookaround
// `(?= (?! (?<= (?<!` and backreferences `\1`..`\9`, `\k<name>`.
function findUnsupportedRegexConstruct(p: string): string | null {
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "\\") {
      const n = p[i + 1];
      if (!inClass && n !== undefined && n >= "1" && n <= "9") return `a backreference (\\${n})`;
      if (!inClass && n === "k" && p[i + 2] === "<") return "a named backreference (\\k<…>)";
      i++;
      continue;
    }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "(" && p[i + 1] === "?") {
      const rest = p.slice(i + 2, i + 4);
      if (rest.startsWith("=") ) return "lookahead (?=…)";
      if (rest.startsWith("!")) return "negative lookahead (?!…)";
      if (rest === "<=") return "lookbehind (?<=…)";
      if (rest === "<!") return "negative lookbehind (?<!…)";
    }
  }
  return null;
}

/** Methods callable as `recv.name(args)`. */
export const BUILTIN_METHODS: Record<string, (recv: unknown, args: unknown[]) => unknown> = {
  contains: (recv, args) => {
    if (typeof recv === "string") { const s = stringForm(args[0]); return s !== undefined && recv.includes(s); }
    if (Array.isArray(recv)) return recv.some((x) => equals(x, args[0]));
    return false;
  },
  startsWith: (recv, args) => { const s = stringForm(args[0]); return typeof recv === "string" && s !== undefined && recv.startsWith(s); },
  endsWith: (recv, args) => { const s = stringForm(args[0]); return typeof recv === "string" && s !== undefined && recv.endsWith(s); },
  matches: (recv, args) => {
    const s = stringForm(recv);
    return s !== undefined && compileRegex(String(args[0])).test(s);
  },
  size: (recv) => sizeOf(recv),
  lower: (recv) => stringForm(recv)?.toLowerCase(),
  upper: (recv) => stringForm(recv)?.toUpperCase(),
};
