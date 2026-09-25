# OQX semantics

The evaluation rules of OQX, as built in the reference implementation
(`packages/oqx/src/semantics.ts`, `engine.ts`, `context.ts`). Each section
states its rule and names the fixture file under `cases/` that pins it. Where
this prose and a fixture disagree, the fixture wins.

Portability rules — the places a second implementation would diverge from
JavaScript by accident — are marked **(portability)**. Every rule here is pinned
by a fixture; the reference has no known deviations. The governing principle is
**least surprise**: where the host language would supply a hidden coercion or a
leaked host detail, OQX instead follows the rule a careful user would predict.

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
  properties only (§2). [`entries`, `properties`]
- **Absent** is one value with two host spellings (`null` and JavaScript
  `undefined`). Every rule below treats them identically; results canonicalize
  them per the README (a property is dropped; an element or a top-level result
  is `null`). [`projection`, `values`]
- **Ranges** (`lo..hi`) and **entries** (from `entries(x)`) are values that
  exist during evaluation. A range **never appears in a result**: projecting one
  (as an item, under `values`, or inside a list) is an **eval error** (`a range
  … cannot appear in a result`). An entry appears as a `{ key, value }` record
  when used as a plain value. [`ranges`, `entries`]

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

**Properties are own properties** (portability). Every property read — a bare
identifier, `.field`, `^field`, `has(x)`, `"k" in obj`, `entries(obj)`, a lift
name, a named root, a builtin name — consults only the object's **own
enumerable keys**. A host prototype chain is invisible: `has(toString)` is
false on `{}`, `"constructor" in {}` is false, `x.constructor()` is an unknown
method, `from toString` is an unknown root. A plain object may of course own a
key spelled `toString`, and then it is an ordinary property. An **array's** only
properties are its integer indices (`"0"`, `"1"`, …); `xs.length` is absent —
`size(xs)` measures it. **Primitives** (strings, numbers, booleans) have no
properties at all: `s.length` is absent, `from strs where length == 3` matches
nothing. [`properties`, `builtins`, `membership`]

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
- Two numbers order numerically; two strings order by **Unicode code point**
  (portability, not UTF-16 code unit: `"～" < "😀"` since U+FF5E < U+1F600):
  `"B" < "a"`, `"ab" < "abc"`, `"10" < "9"`. ISO-8601 date strings therefore
  order chronologically.
- **Any other pairing does not order**: false for all four operators. There is
  no cross-type coercion — `1 < "2"`, `1 <= "1"`, `"2" > 1` are false — and
  booleans, arrays, and objects order against nothing (`true < 2`,
  `false < true` are false). [`scalar-ordering`]

## 7. Arithmetic and string forms

`+ - * / %` on two numbers are IEEE double operations; `%` is the truncated
remainder and takes the dividend's sign (`-7 % 3` is `-1`). Unary `-` negates
a number.

**Absent propagates**: any arithmetic operator (`+ - * / %`, unary `-`) with an
absent operand yields **absent** (`null` in a result), on either side, and even
when the other side is a string — `"a" + nope` is absent, not `"aundefined"`.
Absent has no string form. So `nope + 1 == null` is true and `nope + 1 < 5` is
false. [`arithmetic`]

`+` with **either operand a string** (and neither absent) concatenates the two
operands' **string forms**: a string is itself; a number renders as a double
with no fraction when integer-valued (`2.0` → `"2"`, `2.5` → `"2.5"`, `-3` →
`"-3"`, `-0` → `"0"`); `true`/`false` render as those words. Concatenation is
left-associative (`"n:" + 1 + 2` is `"n:12"`).

Arithmetic on other operand kinds (booleans, non-numeric strings, arrays,
objects), division by zero, and the string form of very large or very small
magnitudes are **not specified**; a result that would be NaN or infinite must
not appear in a fixture. [`arithmetic`]

## 8. Logical operators in value position

Outside the `where` tree, `&&` and `||` are value-producing: `a && b` yields
`a` when `a` is falsy, else `b`; `a || b` yields `a` when `a` is truthy, else
`b`. `!x` yields a boolean. Evaluation is **strictly left to right and
short-circuits**: the right operand is never evaluated when the left decides,
so `false && foo()` is `false` even though `foo` is unknown. [`projection`,
`logical`]

## 9. Membership (`in`)

`x in H` depends on the haystack `H`:

- a **range** → coverage (§10);
- an **array** → some element `== x` (strict equality; absent matches a `null`
  element);
- a **string** → substring test against `x`'s string form (§7); the empty
  string is a substring of every string; an absent `x` is never a substring;
- an **object** → `x`'s string form is one of its **own** keys (§2; a key whose
  value is `null` still counts; `"toString" in {}` is false); an absent `x` is
  never a key, not even one spelled `"null"` or `"undefined"`;
- absent or any other value → false. [`membership`]

## 10. Ranges

`lo..hi` is inclusive at both ends; `lo...hi` excludes `hi`; either bound may
be omitted (`..hi`, `lo..`). Coverage of `x` requires `x` to be a **number or a
string**, then `lo <= x` (when `lo` is present) and `x <= hi` or `x < hi` (when
`hi` is present), each through the ordering rules of §6 — so **an absent `x` is
covered by no range**, however open its ends (`nope in ..5`, `nope in 1..` are
false), a boolean is never covered, and a value that does not order against a
bound is not covered (`"3" in 1..5` is false). Bounds may be any expressions
(fields, bindings, arithmetic). Ranges work over numbers and over ISO-8601
strings alike. A range is an evaluation-time value only; see §1 for the result
rule.

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
| `size(x)` | string → **code-point** count (`size("😀")` is 1); array → length; object → own-key count; absent or any scalar → `0` |
| `has(x)` | `true` iff `x` is not absent (`has(0)`, `has("")`, `has(false)` are true; `has(toString)` on `{}` is false, §2) |
| `range(s)` | §10 |
| `entries(x)` | §21 |

Methods:

| Method | Result |
| --- | --- |
| `s.lower()` / `s.upper()` | case-mapped string form of the receiver (a number or boolean receiver is rendered as in §7); an **absent receiver yields absent** |
| `s.contains(v)` | string receiver: substring of `v`'s string form; array receiver: some element `== v`; anything else → false |
| `s.startsWith(v)` / `s.endsWith(v)` | string receiver only; anything else → false |
| `s.matches(re, flags?)` | absent receiver → false; otherwise the receiver's string form is searched (unanchored unless the pattern anchors) with `re`'s string form compiled in the OQX regex baseline below, under the given flags |
| `x.size()` | as `size(x)` |

**Regular expressions** (portability). `matches(pattern, flags?)` compiles
`pattern` in the **OQX regex baseline**: a fixed grammar in which every
construct has one spec-defined meaning, so a pattern that compiles in one
implementation matches the same strings in every other. Regex is an OQX
concern, not the host's: the implementation parses the pattern before any host
engine sees it, and every failure is an **eval error**, never a host exception,
raised when the call is evaluated (an empty source never evaluates it).

The baseline grammar (whitespace is literal, never ignored):

```text
Pattern     ::= Alternative ( "|" Alternative )*
Alternative ::= Term*
Term        ::= Assertion | Atom Quantifier?
Assertion   ::= "^" | "$" | "\b" | "\B"
Quantifier  ::= ( "*" | "+" | "?" | "{" n "}" | "{" n "," "}" | "{" n "," m "}" ) "?"?
Atom        ::= Literal | "." | Escape | ClassEscape | Class | Group
Group       ::= "(" Pattern ")" | "(?:" Pattern ")" | "(?<" Name ">" Pattern ")"
Class       ::= "[" "^"? ClassItem+ "]"
ClassItem   ::= ClassAtom ( "-" ClassAtom )? | ClassEscape
ClassAtom   ::= ClassLiteral | Escape
Escape      ::= "\" MetaChar | "\n" | "\t" | "\r" | "\f" | "\v" | "\u" Hex Hex Hex Hex | "\u{" Hex{1,6} "}"
ClassEscape ::= "\d" | "\D" | "\w" | "\W" | "\s" | "\S"
MetaChar    ::= one of   . * + ? ( ) [ ] { } | ^ $ \ / -
Name        ::= [A-Za-z_] [A-Za-z0-9_]*
n, m        ::= decimal digits, with m ≥ n
Literal     ::= any code point that is not a MetaChar
ClassLiteral ::= any code point other than "\", "[", "]", and a range-forming "-"
```

Inside a class `^` negates only as the first item, `-` is literal first or
last (`[-a]`, `[a-]`), every other metacharacter is literal (`[.+]`), and both
range endpoints must be single code points (`[\d-z]` is invalid). The empty
classes `[]` and `[^]` do not exist: write `\]` for a literal bracket and
`[\s\S]` for any character. `{` `}` `]` are metacharacters everywhere outside a
class and must be escaped when literal. A `Name` is unique within the pattern.

Semantics, fixed by the spec rather than inherited from a host engine:

- Matching is over **code points**: `.` and a class consume one code point
  (`"😀".matches("^.$")`); `[\u{1F600}-\u{1F64F}]` is a code-point range.
- `\d` is `[0-9]`; `\w` is `[A-Za-z0-9_]`; `\D` and `\W` are their
  complements over all code points (`\W` matches `é`; `\d` does not match `٣`).
- `\s` is exactly U+0009–U+000D, U+0020, U+00A0, U+1680, U+2000–U+200A,
  U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF (JavaScript's WhiteSpace ∪
  LineTerminator — notably **not** U+0085); `\S` is its complement.
- `\b` is a position between a `\w` code point and a non-`\w` code point or
  a string edge, with `\w` as defined above (`é|a` is a boundary); `\B` is
  any other position (including inside `éé` and in the empty string).
- **The line terminator is `\n` alone.** `.` matches any code point except
  `\n` (`\r`, U+2028, U+2029 are ordinary characters); under flag `s` it also
  matches `\n`. `^` and `$` match at the string's start and end; under flag
  `m` they also match immediately after, respectively before, a `\n` — and
  only a `\n` (`"a\r\nb".matches("a$", "m")` is false).
- Quantifiers are greedy; a trailing `?` makes them lazy (unobservable to a
  boolean `matches`, accepted so patterns stay portable).
- An escape denotes exactly one code point: `\uXXXX` takes exactly four hex
  digits (a BMP code point; `\u00411` is `A` then `1`), `\u{X…}` one to six
  (any code point ≤ U+10FFFF). A surrogate code point (U+D800–U+DFFF) is
  invalid — strings are code points, so `😀` is `\u{1F600}`, never a pair.
- **Flags** are the optional second argument: a string of distinct letters from
  `i` (case-insensitive by simple case folding, so `é` matches `É`), `m`, and
  `s`, in any order. Any other character (`"g"`, `"I"`), a repeated letter, or
  a non-string is an eval error whose message includes `unknown regex flag`
  (or `duplicate regex flag`). An absent second argument means no flags. There
  is **no inline flag syntax**: `(?i)` is a rejected construct.

Everything outside the grammar is rejected before matching with an eval error
whose message includes `not supported in OQX regular expressions` and names
the construct: lookahead and lookbehind (`(?=` `(?!` `(?<=` `(?<!`);
backreferences (`\1`…`\9`, `\k<name>`); inline flags and modifier groups
(`(?i)`, `(?i:…)`, `(?-i)`); `\p{…}` / `\P{…}`; `\x..`; `\c.`; octal
escapes (`\0`, and `\1`…`\9` inside a class); identity escapes of
non-metacharacters (`\q`, `\ `); possessive quantifiers (`*+`, `{n,m}+`);
atomic groups `(?>…)`; comment groups `(?#…)`; the `(?P<name>…)` spelling;
`\A \z \Z \G \K \Q \E`; POSIX classes `[[:alpha:]]`; nested classes
`[a[b]]` and class set operations (`&&`, `~~`); the backspace escape `[\b]`.
A pattern that is syntactically invalid within the grammar — unbalanced
parentheses, an unterminated class or group, a reversed range, a quantifier
with nothing to repeat (`*a`, `a**`, `^*`, `\b+`) or with `m < n`, a lone `{`
`}` `]`, a trailing backslash, a malformed or out-of-range `\u`, an invalid
or duplicate group name — is an eval error whose message includes `invalid
regular expression`. The scan honors escapes and classes: `\(\?=` and `[(]\?=`
are literals, not lookahead. An implementation may additionally reject, with
`invalid regular expression`, a pattern whose compiled form exceeds its
engine's size limit; that bound is implementation-defined.

An implementation may let a **host** opt into its engine's **native dialect**
(the reference: `DataContext.regexDialect = "native"`; the Rust crate:
`DataContext::regex_dialect()` returning `Native`). Under it the pattern is
handed to the engine unvalidated with the flags mapped, an invalid pattern is
still an eval error, and nothing else is promised: the native dialect is
implementation-defined and not portable. The fixtures exercise only the
baseline. [`regex`]

Calling a name not in these tables is an **eval error** (`unknown function
'f(…)'` / `unknown method '.m(…)'`), raised when the call is evaluated (an empty
source never evaluates it). A free-function call may be a source or a receiver.
[`builtins`, `strings`, `regex`]

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
`limit`/`offset` (§18) — so `exists { offset 1 }` asks for a second row.

**`&&` and `||` evaluate strictly left to right and short-circuit**, in `where`
exactly as in value position (§8). The engine never reorders conjuncts — not
even to run a cheap scalar before a consumer test — because evaluation order is
observable through errors: `false && foo(1)` is false, `xs none { } && foo(1)`
is false when `xs` has rows, and `true && foo(1)` raises `unknown function`. A
query may therefore guard an operand by position (`has(s) && s.matches(re)`).
[`where`, `logical`, `consumers`, `limit-offset`]

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
| `single` | projected row or `null` | **eval error** when more than one row remains; the message reports the **true** number of rows after bounds (`matched 3 rows`), so `single` always materializes |

The same six shapes apply to nested directives, except that only
`collect`/`first`/`single` are legal in a projection and only
`exists`/`none`/`count`/`collect`(lifts) in `where`. [`consumers`]

## 16. `distinct`

`distinct` — spelled `select distinct …`, `<consumer> distinct { … }`, or
`follow distinct` (§20) — keeps the **first** row per distinct **projected
value**, preserving order, before bounds are applied. Projections compare
structurally with absent ≡ `null`, key order ignored. With an **empty
projection** (`count distinct { }`) rows dedup by **identity** (§20): the row's
`id` property when the row is an object with one, else the row's structural
value.

**Identity is structural** (portability). Two values have the same identity iff
they are structurally equal: absent ≡ `null`; numbers as doubles; strings by
code point; arrays element-wise; objects by own keys, **order ignored**; and
types are never conflated — `1`, `"1"`, and `true` are three identities, `{}`
and `[]` two more. Never a host string form: `{a:1}` and `{a:2}` are different,
`[{a:1},{a:2}] count distinct { }` is 2. Implementations key identities with a
canonical, type-tagged serialization (the reference's `canonicalKey`). An
entry's identity is its value's. [`distinct`, `follow`]

## 17. `order by`

Rows sort by each key in turn; ties fall through to the next key; the sort is
**stable** (equal rows keep source order). Within a key, present values order
by §6 (numbers numerically, strings by **code point**: `"a"`, `"～"`, `"😀"`)
and `desc` reverses that order of present values only: **absent sorts last in
both directions**. Keys are arbitrary expressions read in the row's scope
(fields, `$value`, intrinsics, `^outer`); they are not rewritten against
aliases. Ordering of mixed-type or boolean keys is not specified. [`order-by`]

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
  by **path**, the sequence of identities from the seed to the occurrence,
  compared **component-wise as values**: two numbers numerically, two strings
  by code point (so `9` precedes `10`, never `"10" < "9"` as text); a number
  component precedes a string component; any other pairing orders by kind then
  by canonical serialization (the reference's `comparePath`).

Options: `where P` keeps only successors satisfying `P` (read in the successor's
scope); `frontier P` marks a row a frontier (not expanded); `depth n` caps
`$depth` at `n` (1–8; the default and hard cap is 8); `by E` gives the identity
expression. **Identity** (portability) defaults to the row's `id` property, else
its structural value, compared as §16 describes — id-less nodes with different
contents are different nodes (not cycles of one another), and an `id` of `1`
is not an `id` of `"1"`. A revisit of an identity on the current path is admitted
**once** as `$stop == "cycle"` and not expanded, so cycles terminate. A node
reached by N distinct paths yields N occurrences; `follow distinct` keeps the
minimal `(depth, path)` occurrence per identity. Intrinsics belong to the
occurrence's scope: inside a nested block `$depth` is absent and `^$depth` is
the occurrence's. `follow` is legal at the top level and inside a
select-position `collect`; inside a where-position directive it is an eval
error. [`follow`]

## 21. `entries()` and `$key`

`entries(x)` converts an object into a collection of its **own** entries in
insertion order (portability), an array into `(index, element)` entries, and
absent or any scalar into nothing.

**Integer-like keys** (host data model). The reference runs on JavaScript,
whose objects enumerate integer-like keys (`"0"`, `"42"`) first, in numeric
order, before the other keys in insertion order; other hosts keep pure insertion
order. This is a fact about the data a host hands OQX, not about OQX, and no
implementation undoes it. Fixtures therefore **must not depend on the relative
order of integer-like and non-integer-like keys** in one object (`{ "b":1,
"2":2, "a":3 }` yields `["2","b","a"]` in the reference and `["b","2","a"]`
elsewhere); an object with only one kind of key is safe. When an entry becomes a scope's row, the scope's row is
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
Running a query with **fewer values than it references** is an **eval error**
(`binding … out of range`), never a silent absent; the template form checks
arity at parse time, so this is reachable only through a host `run` API and is
pinned by the reference's own tests. [`bindings`]

## 23. Errors

Every failure is an `OqxError` whose `stage` is `lex`, `parse`, or `eval`
(GRAMMAR §6); a host exception never escapes. Eval errors: unknown function or
method; `single` with more than one row; an invalid `limit`/`offset` value;
`follow` in a where-position directive; an invalid or unsupported regex or
regex flag (§11);
a range in a result (§1); a binding out of range (§22). Evaluation is otherwise
total: absent navigation, arithmetic over absent, comparisons over absent or
mismatched types, membership in a non-container, and `range()` of a bad string
all yield a value (absent or `false`), never an error.
[`errors-lex`, `errors-parse`, `errors-eval`, `logical`, `regex`]
