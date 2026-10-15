// The Dataview function table (Dataview docs: "Functions" — Constructors,
// Numeric Operations, Objects/Arrays/Strings, String Operations, Utility
// Functions). Every function Dataview documents has a row: how it translates
// (`oqx`) or why it cannot (`reason`). The handlers live in expressions.ts;
// this table is the contract the README and the tests read — a call to a name
// not in it is `unsupported` too ("unknown Dataview function").

export type FunctionStatus =
  | { status: "supported"; oqx: string }
  /** Translates only as an aggregate after GROUP BY (`sum(rows.x)` → `sum(x)`). */
  | { status: "group"; oqx: string }
  | { status: "unsupported"; reason: string };

export const FUNCTIONS: Readonly<Record<string, FunctionStatus>> = {
  // Constructors
  object: { status: "unsupported", reason: "OQX has no object literal" },
  list: { status: "unsupported", reason: "OQX has no list literal; a two-or-more element list is a tuple `(a, b)`, one element `list(a)`" },
  array: { status: "unsupported", reason: "OQX has no list literal; a two-or-more element list is a tuple `(a, b)`, one element `list(a)`" },
  date: { status: "supported", oqx: 'date(x) — `date(today)` → `date("today")`, `date(2026-10-15)` → `date("2026-10-15")`, `date(field)` → `date(field)`; the two-argument form `date(text, format)` is unsupported' },
  dur: { status: "supported", oqx: 'dur(x) — `dur(1 hour 30 minutes)` → `dur("1 hour 30 minutes")`; `dur(field)` stays a call' },
  number: { status: "unsupported", reason: "OQX has no string-to-number conversion" },
  string: { status: "supported", oqx: "`${x}` (a template literal: the value's string form)" },
  link: { status: "unsupported", reason: "a link value is rendered by the client from `path`; OQX has no link type" },
  elink: { status: "unsupported", reason: "OQX has no link type" },
  embed: { status: "unsupported", reason: "OQX has no link type" },
  typeof: { status: "unsupported", reason: "OQX has no type-name function" },
  // Numeric
  round: { status: "unsupported", reason: "OQX has no rounding functions" },
  trunc: { status: "unsupported", reason: "OQX has no rounding functions" },
  floor: { status: "unsupported", reason: "OQX has no rounding functions" },
  ceil: { status: "unsupported", reason: "OQX has no rounding functions" },
  min: { status: "group", oqx: "min(x) over rows.x after GROUP BY; outside a group OQX has no min over a list" },
  max: { status: "group", oqx: "max(x) over rows.x after GROUP BY; outside a group OQX has no max over a list" },
  sum: { status: "group", oqx: "sum(x) over rows.x after GROUP BY; outside a group OQX has no sum over a list" },
  product: { status: "unsupported", reason: "no product aggregate in OQX" },
  reduce: { status: "unsupported", reason: "lambdas are not translatable" },
  average: { status: "group", oqx: "avg(x) over rows.x after GROUP BY" },
  minby: { status: "unsupported", reason: "lambdas are not translatable" },
  maxby: { status: "unsupported", reason: "lambdas are not translatable" },
  // Objects, arrays, strings
  contains: { status: "supported", oqx: "y in x (string: substring; list: element; object: key); contains(file.tags, \"#t\") → the tag test with nested-tag prefixes; contains(file.inlinks|outlinks, [[n]]) → in_links/out_links exists { … }" },
  icontains: { status: "supported", oqx: "x.lower().contains(y.lower()) — strings only" },
  econtains: { status: "supported", oqx: "y in x (exact element membership)" },
  containsword: { status: "supported", oqx: 'x ~ "\\bword\\b" — the word must be a literal' },
  extract: { status: "unsupported", reason: "OQX has no object construction" },
  sort: { status: "unsupported", reason: "OQX sorts rows (order by), not list values" },
  reverse: { status: "unsupported", reason: "OQX has no list reversal" },
  length: { status: "supported", oqx: "size(x); length(rows) → count() after GROUP BY; length(file.inlinks|outlinks) → size(in_links|out_links)" },
  nonnull: { status: "unsupported", reason: "OQX has no list filter" },
  all: { status: "group", oqx: "all(p) over rows after GROUP BY; the lambda form is unsupported" },
  any: { status: "group", oqx: "any(p) over rows after GROUP BY; the lambda form is unsupported" },
  none: { status: "group", oqx: "!any(p) over rows after GROUP BY" },
  join: { status: "unsupported", reason: "OQX has no list join" },
  filter: { status: "unsupported", reason: "lambdas are not translatable" },
  map: { status: "unsupported", reason: "lambdas are not translatable" },
  flat: { status: "unsupported", reason: "OQX has no list flattening in value position" },
  slice: { status: "unsupported", reason: "OQX has no list slicing" },
  unique: { status: "unsupported", reason: "OQX dedups rows (distinct), not list values" },
  // String operations
  regextest: { status: "supported", oqx: "s ~ pattern" },
  regexmatch: { status: "supported", oqx: "s ~ pattern (Dataview matches the whole string; OQX anchors only when the pattern does — the translator anchors a literal pattern with ^…$)" },
  regexreplace: { status: "unsupported", reason: "OQX has no string replacement" },
  replace: { status: "unsupported", reason: "OQX has no string replacement" },
  lower: { status: "supported", oqx: "x.lower()" },
  upper: { status: "supported", oqx: "x.upper()" },
  split: { status: "unsupported", reason: "OQX has no split" },
  startswith: { status: "supported", oqx: "x.startsWith(y)" },
  endswith: { status: "supported", oqx: "x.endsWith(y)" },
  padleft: { status: "unsupported", reason: "OQX has no padding" },
  padright: { status: "unsupported", reason: "OQX has no padding" },
  substring: { status: "unsupported", reason: "OQX has no substring" },
  truncate: { status: "unsupported", reason: "OQX has no truncation" },
  // Utility
  default: { status: "supported", oqx: "x or d — `or` yields the first truthy operand, so 0, \"\" and false also fall through to d (Dataview falls through on null only)" },
  ldefault: { status: "unsupported", reason: "OQX has no per-element default" },
  choice: { status: "unsupported", reason: "OQX has no conditional expression" },
  hash: { status: "unsupported", reason: "no hashing in OQX" },
  striptime: { status: "supported", oqx: "d.date()" },
  dateformat: { status: "supported", oqx: "d.format(pattern)" },
  durationformat: { status: "unsupported", reason: "the duration contract has dur_text()/dur_iso() but no pattern formatter" },
  localtime: { status: "unsupported", reason: "the date contract has no zone conversion" },
  meta: { status: "unsupported", reason: "OQX has no link type" },
  currencyformat: { status: "unsupported", reason: "no number formatting in OQX" },
};
