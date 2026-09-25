# OQX semantics

The evaluation rules of OQX, as built in the reference implementation
(`packages/oqx/src/semantics.ts`, `engine.ts`, `context.ts`). Each section
states its rule and names the fixture file under `cases/` that pins it. Where
this prose and a fixture disagree, the fixture wins.

Portability rules — the places a second implementation would diverge from
JavaScript by accident — are marked **(portability)**. The appendix lists the
spots where the reference itself currently deviates from such a rule; those are
not pinned by fixtures.

## 1. Values

OQX evaluates over plain data: **absent**, booleans, numbers, strings, arrays,
objects, plus two engine-internal value kinds (ranges, entries).

- **Numbers are IEEE-754 doubles** (portability). There is no integer type;
  `1 == 1.0`, `0 == -0`. Integer-valued doubles render without a fraction
  (`"n" + 2.0` is `"n2"`). Number literals: `1`, `2.5`, `1e3`, `25e-1`.
  [`arithmetic`, `scalar-equality`]
- **Strings are sequences of Unicode code points** (portability): they order by
  code point and `.size()` counts code points. Literals may use either quote and
  the escapes in GRAMMAR §1. [`strings`, `scalar-ordering`]
- **Objects keep insertion order** (portability), observed by `entries()` and
  by projection. Property lookup is by exact key on the object's **own**
  properties. [`entries`]
- **Absent** is one value with two host spellings (`null` and JavaScript
  `undefined`). Every rule below treats them identically; results canonicalize
  them per the README (a property is dropped; an element or a top-level result
  is `null`). [`projection`, `values`]
- **Ranges** (`lo..hi`) and **entries** (from `entries(x)`) are values that
  exist during evaluation. A range must not appear in a result; an entry appears
  as a `{ key, value }` record when used as a plain value. [`ranges`, `entries`]

## 2. Scopes and names

Evaluation proceeds in a chain of **scopes**. The **root scope** has no row; its
names are the named roots. Every row under evaluation gets a child scope whose
parent is the scope that produced it (the root for top-level rows; the enclosing
row's scope for a nested block's rows).

A **bare identifier** resolves against exactly **one** scope — the current one —
and never climbs:

1. `$value` — the scope's row itself (absent at the root).
2. `$key` — the property key, in an entry scope only (§21).
3. `$depth`, `$stop`, `$leaf`, `$frontier`, `$ordinal` — the recursion
   intrinsics, on a `follow` occurrence only (§20).
4. a value **lifted** into this scope by a `^name:` item (§19).
5. at the root scope: the named root; elsewhere: the row's own property.

A name the scope lacks is **absent**. Present-but-falsy values are ordinary
values. `^name` reads from exactly one scope out per caret; past the root it is
absent. `.name` navigates the value to its left; navigating from absent yields
absent, never an error (`a.b.c` on `{}` is absent). `^$value` is the enclosing
row; `^people` from a top-level row is the named root `people`.
[`outer-refs`, `projection`]

## 3. Collections and coercion

Wherever rows are needed — a source, a directive receiver, a `follow` relation,
a `from` re-projection — a value is coerced to rows:

- absent → no rows; an array → its elements; any other value (an object, a
  string, a number) → **one row**, that value. A plain object never iterates;
  `entries(obj)` is the explicit bridge (§21). An unknown root is absent and
  therefore empty. [`consumers`, `entries`]

(The reference also materializes host iterables such as `Set`/`Map`; that is a
host concern and not part of the spec.)

## 4. Truthiness

`where <scalar>`, `!x`, and the operands of `&&`/`||` use truthiness: **absent,
`false`, `0`, `-0`, and `""` are falsy; everything else is truthy** — including
an empty array and an empty object. [`where`, `builtins`]

## 5. Equality (`==`, `!=`)

Equality is **typed and strict**: no cross-type coercion (`5 == "5"`,
`0 == false`, `"" == false` are all false). Numbers compare as doubles, strings
by code point (case-sensitive), booleans by value. **Two absent values are
equal** (`nope == null` is true), and absent equals nothing else. `!=` is the
exact negation, so `nope != 5` is true and `nope != null` is false.
Equality between two arrays or two objects is **not specified** (the reference
uses host reference identity; fixtures do not rely on it). [`scalar-equality`]

## 6. Ordering comparisons (`<`, `<=`, `>`, `>=`)

- If either operand is absent the result is **false**, for every operator and
  both operand positions (so `!(age > 0)` keeps rows lacking `age`).
- Two numbers order numerically; two strings order by code point (portability):
  `"B" < "a"`, `"ab" < "abc"`, `"10" < "9"`. ISO-8601 date strings therefore
  order chronologically.
- Any other pairing (number with string, booleans, arrays, objects) does **not
  order**: false. [`scalar-ordering`]

## 7. Arithmetic and string forms

`+ - * / %` on two numbers are IEEE double operations; `%` is the truncated
remainder and takes the dividend's sign (`-7 % 3` is `-1`). Unary `-` negates
a number.

`+` with **either operand a string** concatenates the two operands' **string
forms**: a string is itself; a number renders as a double with no fraction when
integer-valued (`2.0` → `"2"`, `2.5` → `"2.5"`, `-3` → `"-3"`, `-0` → `"0"`);
`true`/`false` render as those words. Concatenation is left-associative
(`"n:" + 1 + 2` is `"n:12"`).

Arithmetic on any other operand kinds (absent, booleans, non-numeric strings,
arrays, objects), division by zero, and the string form of very large or very
small magnitudes are **not specified**; a result that would be NaN or infinite
must not appear in a fixture. [`arithmetic`]

## 8. Logical operators in value position

Outside the `where` tree, `&&` and `||` are value-producing: `a && b` yields
`a` when `a` is falsy, else `b`; `a || b` yields `a` when `a` is truthy, else
`b`. `!x` yields a boolean. Evaluation short-circuits. [`projection`]

## 9. Membership (`in`)

`x in H` depends on the haystack `H`:

- a **range** → coverage (§10);
- an **array** → some element `== x` (strict equality; absent matches a `null`
  element);
- a **string** → substring test against `x`'s string form (§7); the empty
  string is a substring of every string;
- an **object** → `x`'s string form is one of its own keys (a key whose value is
  `null` still counts);
- absent or any other value → false. [`membership`]

## 10. Ranges

`lo..hi` is inclusive at both ends; `lo...hi` excludes `hi`; either bound may
be omitted (`..hi`, `lo..`). Coverage of `x` is `lo <= x` (when `lo` is
present) and `x <= hi` or `x < hi` (when `hi` is present), each through the
ordering rules of §6 — so an absent `x`, or one that does not order against a
bound, is not covered. Bounds may be any expressions (fields, bindings,
arithmetic). Ranges work over numbers and over ISO-8601 strings alike.

`range(s)` reads a string as a range: `lo`, a maximal run of 2 or 3 dots, `hi`;
the present bounds must be **all numeric** (`-?\d+(\.\d+)?([eE][+-]?\d+)?`) or
**all ISO-8601** (`YYYY-MM-DD`, optionally `[T ]hh:mm[:ss[.fff]][Z|±hh:mm]`).
Anything else (`"hello"`, `"a..z"`, mixed domains, a non-maximal dot run such as
`"../foo"`, a non-string argument) yields absent, so `x in range(bad)` is false.
A range passed to `range()` is returned unchanged. [`ranges`]

## 11. Built-in functions and methods

Free functions:

| Function | Result |
| --- | --- |
| `list(x)` | absent → `[]`; an array → itself; anything else → `[x]` (an object is one element, not iterated) |
| `size(x)` | string → code-point count; array → length; object → own-key count; absent or any scalar → `0` |
| `has(x)` | `true` iff `x` is not absent (`has(0)`, `has("")`, `has(false)` are true) |
| `range(s)` | §10 |
| `entries(x)` | §21 |

Methods:

| Method | Result |
| --- | --- |
| `s.lower()` / `s.upper()` | case-mapped string form of the receiver (a number or boolean receiver is rendered as in §7) |
| `s.contains(v)` | string receiver: substring of `v`'s string form; array receiver: some element `== v`; anything else → false |
| `s.startsWith(v)` / `s.endsWith(v)` | string receiver only; anything else → false |
| `s.matches(re)` | absent receiver → false; otherwise the receiver's string form is searched (unanchored unless the pattern anchors) with the pattern compiled as a regex |
| `x.size()` | as `size(x)` |

**Regex dialect** (portability): the intersection both implementations support —
literals, `.`, character classes `[…]`, `\d \w \s`, the quantifiers `* + ? {m,n}`,
alternation `|`, grouping `( )`, anchors `^ $`, escaped metacharacters. No
lookaround, no backreferences, no flags; matching is case-sensitive. A fixture
using anything outside the intersection is a spec bug.

Calling a name not in these tables is an **eval error** (`unknown function
'f(…)'` / `unknown method '.m(…)'`), raised when the call is evaluated (an empty
source never evaluates it). A free-function call may be a source or a receiver.
[`builtins`, `strings`]

## 12. Projection and records

Each kept row projects to:

- with **no** projection: the row itself;
- in **`values`** mode: the single item's value;
- otherwise: a record with one property per item, in item order (insertion
  order), keyed by the alias or the navigation's last segment.

An item whose value is absent produces an absent property — dropped in canonical
form. A nested `collect` item yields an array; `first`/`single` a record (or
its `values` value) or `null`. [`projection`, `values`, `consumers`]

## 13. `where`

The where tree evaluates to a boolean: `&&`/`||` short-circuit, `!` negates, a
scalar leaf is truthiness (§4), and a consumer test is:

- `R exists { B }` — B yields at least one row over receiver R;
- `R none { B }` — B yields no rows (exactly `!R exists { B }`);
- `R count { B } <op> n` — the number of rows compared to the integer `n`;
  without a comparison, `R count { B }` is truthy when the count is non-zero;
- `R collect { ^lifts… }` — non-empty, and binds its lifts (§19).

The rows a test sees are the receiver's rows (§3), re-projected by the block's
`from`, filtered by its `where`, ordered, deduped by `distinct`, and bounded by
`limit`/`offset` (§18) — so `exists { offset 1 }` asks for a second row. The
order in which `&&` operands are evaluated is not observable. [`where`,
`consumers`, `limit-offset`]

## 14. Select aliases in `where`

A bare identifier in a body's `where` that names an alias of the **same body's**
`select` is replaced at parse time by that alias's expression:

- an alias shadows a same-named row field inside `where`;
- an unaliased dotted item is an alias for its key (`meta.slug` → `slug`);
- inside an alias's own expression its name is the row field (not recursion);
  a chain of aliases that returns to one being resolved is a parse error;
- an alias whose value is a nested `collect`/`first`/`single` block may stand
  alone as a leaf (meaning "non-empty") but not appear inside an expression;
- nested blocks rewrite only against their own `select`; `^name` is never an
  alias; `order by` is **not** rewritten and reads row fields.
[`aliases`]

## 15. Consumers and result shapes

| Consumer | Result | Notes |
| --- | --- | --- |
| `collect` | array of projected rows | the body form's consumer |
| `exists` | boolean | true iff at least one row |
| `none` | boolean | true iff no rows |
| `count` | number | rows after where/distinct/bounds |
| `first` | projected row or `null` | the first row in result order |
| `single` | projected row or `null` | **eval error** when more than one row remains |

The same six shapes apply to nested directives, except that only
`collect`/`first`/`single` are legal in a projection and only
`exists`/`none`/`count`/`collect`(lifts) in `where`. [`consumers`]

## 16. `distinct`

`distinct` — spelled `select distinct …`, `<consumer> distinct { … }`, or
`follow distinct` (§20) — keeps the **first** row per distinct **projected
value**, preserving order, before bounds are applied. Projections compare
structurally with absent ≡ `null`, key order ignored. With an **empty
projection** (`count distinct { }`) rows dedup by **identity**: the row's `id`
property when the row is an object with one, else the row's structural value
(portability). [`distinct`]

## 17. `order by`

Rows sort by each key in turn; ties fall through to the next key; the sort is
**stable** (equal rows keep source order). Within a key, present values order
by §6 (numbers numerically, strings by code point) and `desc` reverses that
order of present values only: **absent sorts last in both directions**. Keys
are arbitrary expressions read in the row's scope (fields, `$value`, intrinsics,
`^outer`); they are not rewritten against aliases. Ordering of mixed-type or
boolean keys is not specified. [`order-by`]

## 18. `limit` / `offset`

The bound applies **after** `where`, `order by`, and `distinct` and **before**
the consumer reduces the rows: `count { limit 2 }` ≤ 2, `first { offset 1 }` is
the second row, `exists { offset 2 }` needs a third row, `none { limit 0 }` is
true. The operand is evaluated in a row-less scope inside the block — a literal
or binding is itself, `^n` is the enclosing row's `n` — and must be a
**non-negative integer**, else an eval error (`limit must be a non-negative
integer …`), raised even when the block has no rows. [`limit-offset`,
`errors-eval`]

## 19. Outer references and lifts

`^name` **reads** exactly N scopes out (§2). A `^name: expr` item inside a
`collect { … }` in `where` **binds**: for every matched row the value of `expr`
is appended to a list named `name` in the scope N carets out (`^` = the row the
`where` belongs to), flatten-appending as intermediate blocks fan out. The bound
name is then read there like a row property (`name, currentEmployers from …`).
A where-position `collect` with no matches is false, so the row is filtered out
rather than receiving an empty list. An unaliased `^name` item lifts the field
`name`. [`lifts`, `outer-refs`]

## 20. `follow`

`follow R` turns a body into a bounded, **per-path**, depth-first walk. The
body's `where` is split: conjuncts that mention no recursion intrinsic select
the **seeds**; conjuncts that do are applied to the walked occurrences
afterwards (seed predicates never prune the walk). From each seed the relation
`R` (any expression yielding successors, coerced per §3; a row lacking it is a
leaf) is followed, visiting successors in order.

Each occurrence carries intrinsics:

- `$depth` — 1 for a seed;
- `$stop` — `cycle` > `frontier` > `depth` > `leaf` > `interior` (first that
  applies): the row's identity is already on the current path; the `frontier`
  predicate holds; `$depth` reached the cap; no successors; otherwise interior.
  Only `interior` rows expand;
- `$leaf` = `$stop == "leaf"`; `$frontier` = `$stop` is `frontier` or `depth`;
- `$ordinal` — a 1-based rank over all occurrences ordered by `$depth`, then
  by **path**, the identities' string forms joined by `/` and compared as text.

Options: `where P` keeps only successors satisfying `P` (read in the successor's
scope); `frontier P` marks a row a frontier (not expanded); `depth n` caps
`$depth` at `n` (1–8; the default and hard cap is 8); `by E` gives the identity
expression. **Identity** (portability) defaults to the row's `id` property, else
its structural value. A revisit of an identity on the current path is admitted
**once** as `$stop == "cycle"` and not expanded, so cycles terminate. A node
reached by N distinct paths yields N occurrences; `follow distinct` keeps the
minimal `(depth, path)` occurrence per identity. Intrinsics belong to the
occurrence's scope: inside a nested block `$depth` is absent and `^$depth` is
the occurrence's. `follow` is legal at the top level and inside a
select-position `collect`; inside a where-position directive it is an eval
error. [`follow`]

## 21. `entries()` and `$key`

`entries(x)` converts an object into a collection of entries in insertion
order (portability), an array into `(index, element)` entries, and absent or
any scalar into nothing. When an entry becomes a scope's row, the scope's row is
the property's **value** (`$value`, bare names, navigation) and `$key` is the
property's key. `$key` exists only in an entry scope; ordinary rows and array
elements have none. Entries flow through every place a row does: sources,
`from` re-projections, nested receivers, `follow` seeds (which keep their
`$key`). As a plain value, `entries(x)` is an array of `{ key, value }` records.
[`entries`]

## 22. Bindings

A bound value is exactly the value it was given: a collection in `from` or
receiver position is the rows; a scalar in a predicate is compared with the §5/§6
rules; an array is a valid right side of `in`; a number is a valid `limit`; a
`null` binding is absent. A bound string is never source text (GRAMMAR §1).
[`bindings`]

## 23. Errors

Every failure is an `OqxError` whose `stage` is `lex`, `parse`, or `eval`
(GRAMMAR §6). Eval errors: unknown function or method; `single` with more than
one row; an invalid `limit`/`offset` value; `follow` in a where-position
directive. Evaluation is otherwise total: absent navigation, comparisons over
absent or mismatched types, membership in a non-container, and `range()` of a
bad string all yield a value (absent or `false`), never an error.
[`errors-lex`, `errors-parse`, `errors-eval`]

## Appendix — known reference deviations (not pinned)

The reference implementation currently contradicts the rules above in these
places, each an artifact of JavaScript. No fixture depends on them; a port must
follow the rule, not the reference.

| Rule | Reference behavior | Exposing query |
| --- | --- | --- |
| §1/§6 strings order by code point | UTF-16 code-unit order | `r exists { where "～" < "😀" }` → `false` (spec: `true`) |
| §1/§11 `.size()` counts code points | counts UTF-16 units | `x: "😀".size() from r` → `2` (spec: `1`) |
| §6 mixed types do not order | JS coercion orders a numeric string against a number | `r exists { where 1 < "2" }` → `true` (spec: `false`); also affects range coverage: `"3" in 1..5` |
| §2 own-property lookup | inherited properties are visible | `r exists { where has(toString) }` → `true`; `"toString" in o` → `true`; `where length == 3` on string rows |
| §1 insertion order | integer-like keys are enumerated first | `$key values from entries(o)` with `{ "b":1, "2":2, "a":3 }` → `["2","b","a"]` |
| §16/§20 structural identity | identity stringifies to `[object Object]` for objects without `id`, so all such rows collide (`count distinct { }` → 1; every `follow` successor without `id` is a `cycle`); `1` and `"1"` also collide | `xs count distinct { }` with `[{"a":1},{"a":2}]` → `1` (spec: `2`) |
| §7 absent in arithmetic / string form | `null` → `0`/`"null"`, `undefined` → NaN/`"undefined"` | `x: n + 1` vs `x: nope + 1`; `"a" + nope` → `"aundefined"` |
| §11 `.lower()` on absent | `"null"` / `"undefined"` | `x: nope.lower() from r` |
| §11 regex dialect | JavaScript `RegExp`: lookaround works; an invalid pattern throws a host `SyntaxError`, not an `OqxError` | `"ab".matches("a(?=b)")`; `"a".matches("(")` |
| §1 ranges never appear in results | a range projected as a value leaks its internal record | `x: 1..5 from r` |
