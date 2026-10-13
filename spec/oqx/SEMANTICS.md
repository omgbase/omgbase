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
  the escapes in GRAMMAR §1; a **template literal** `` `…${e}…` `` is a string
  built by interpolation (§7b, since 0.21). [`strings`, `scalar-ordering`,
  `template-literals`]
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

Evaluation proceeds in a chain of **scopes**. The **root scope**'s row is the
**host's root object** (since 0.18; before, the root had no row) and its bare
names are the named roots. Every row under evaluation gets a child scope whose
parent is the scope that produced it (the root for top-level rows; the enclosing
row's scope for a nested block's rows).

A **bare identifier** resolves against exactly **one** scope — the current one —
and never climbs:

1. `$it` — the scope's row itself (at the root, the host's root object).
   Unconditional: a row property literally named `$it` is unreachable by bare
   name, and so is a named root called `$it`.
2. `$key` — the row's **identity** (§16; since 0.20 on every row): an entry's
   key (§21), a walk occurrence's identity (§20), a projected `$key:` (§16),
   else the host's identity of the row — structural by default. Unconditional
   like `$it`: a row property literally named `$key` is unreachable by bare name.
3. `$depth`, `$stop`, `$leaf`, `$frontier`, `$ordinal` — the recursion
   intrinsics, on a `follow` occurrence (§20).
4. a value **lifted** into this scope by a `^name:` item (§19).
5. at the root scope: the named root; elsewhere: the row's own property.

Step 3 applies only where the scope **carries** that metadata: a walk
occurrence. Anywhere else the name is an ordinary property read (step 5), so a
host whose rows carry a `$depth` or `$ordinal` of their own (omgbase's blocks
do) exposes it outside a `follow`, and a plain-JSON row `{ "$depth": 3 }`
projects `3`. Since 0.13; before, the six names read absent everywhere they
were not metadata, shadowing the row. (`$key` left this rule in 0.20: it is an
identity, never a property.) **`$value` is not an intrinsic** (since 0.15,
when the current item was renamed from `$value` to `$it` with no synonym): it
is an ordinary property read under step 5 everywhere — at the top level, in a
nested block, and in an entry scope (where it is a property of the entry's
*value*) — so `{ "$value": 3 }` projects `3` and a row without it reads absent.
[`intrinsics`]

**The root object** (since 0.18). The root scope is a row like any other: its
row is a value the host defines — `DataContext.rootObject()` in the reference,
`DataContext::root_object()` in the Rust crate — and the reference
`DefaultContext` returns the **roots record** it was constructed with (`{
people, orders }`). So from a top-level row `^$it` is that record,
`entries(^$it)` enumerates the named roots in insertion order, `^$it.people`
is `^people` (a property read through `get`, usable as a receiver too), and
`$it` at the root itself (`from $it`) is the record coerced to one row. Step 5
at the root is unchanged — a bare name there is `root(name)`, **never** a
property of the root object — so a host whose roots are lazy handles is
unaffected by what its root object holds, and a host may answer a root-level
name of its own from `root(name)` (omgbase exposes the repository id as `$id`)
to make it readable as `^$id` from depth one and `^^$id` from depth two. A host
without a root object leaves the root row absent, the pre-0.18 reading. The
root object is host-defined and not portable; the fixtures assume only the
reference's roots record. [`outer-refs`, `absolute-refs`]

A name the scope lacks is **absent**. Present-but-falsy values are ordinary
values. `^name` reads from exactly one scope out per caret; past the root it is
absent. `.name` navigates the value to its left; navigating from absent yields
absent, never an error (`a.b.c` on `{}` is absent). `^$it` is the enclosing
row; `^people` from a top-level row is the named root `people`.
[`outer-refs`, `projection`]

**Absolute scope references** (since 0.18). Scopes have a syntactic **depth**:
the root is 0, a top-level row 1, a block's rows one deeper than the block's
receiver, a `follow` destination block's rows one below the frontier row, a
follow `where` one deeper than the frontier row. `N^name` names the scope at
depth N instead of counting carets: it is the outer reference with `levels =
currentDepth − N`, desugared by the parser (GRAMMAR §4), so `0^docs` from any
depth is the named root `docs`, `0^$it` the root object, `1^$path` the
top-level row's `$path`, and `1^tasks: text` the lift into the top-level row.
`N ≥ currentDepth` is a parse error. [`absolute-refs`]

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

Wherever rows are needed — a source, a directive receiver, a `follow`
destination, a `from` re-projection — a value is coerced to rows, and the value
decides the **cardinality** of what the rows become (since 0.20):

- **absent** → no rows: a collection with none (`[]` from a `collect`). An
  unknown root is absent and therefore empty.
- an **array** → its elements: a collection. A `collect` over it is a list.
- an **object** → **one row**, that object, and the receiver is **single**: a
  `collect` over it is **one record** (the projection, or the object itself
  with no projection) — or **absent** when the row fails the `where` or the
  bound excludes it — never a one-element list; `values` is the one value;
  `first`/`single` are that object as always; `exists`/`none`/`count` are
  unchanged. So `doc { title }` is a record, `doc { status == "active" }` is the
  object or absent (a conditional reach-through), `docs { title }` a list. A
  plain object never iterates; `entries(obj)` is the explicit bridge (§21),
  `list(obj)` the explicit one-element collection.
- a **scalar** (a string, a number, a boolean) or a range → an **eval error**
  (`` `s` is a string ("abc"), not a collection or an object — rows come from
  a collection (a list) or one object (a record) ``). Before 0.20 a scalar was a
  one-row collection; `list(s)` says that explicitly.

A `from` re-projection fans a single receiver out — `doc { from tags }` is a
list — and so does a `follow`. The two spellings of a body are one tree (AST.md
§2), so `title from doc` is the record `doc collect { title }` is; `from $it` at
the root is the root object as one record.

**Host relations are statically single or plural; data decides at run time.**
A host may say which of the objects it hands out are collections rather than
rows (the reference's `DataContext.isSingle`, the Rust `is_single` — a lazy
table handle is an object but a collection); without that, every non-array
object is one row and every array a collection (the reference also treats host
iterables such as `Set`/`Map` as collections). A host that knows an absent
relation is single may mark it so and get **absent** from a block over it
instead of `[]`; the in-memory context cannot tell and yields `[]`. The fixtures
assume the reference's rule. [`cardinality`, `consumers`, `entries`]

## 3b. Tuples

`(e1, e2, …)` — two or more expressions in parentheses (GRAMMAR §4) — evaluates
its elements in source order and **concatenates them with one level of
flattening**: an element that is a collection contributes its items; a row,
object or scalar contributes itself; an **absent** element (a missing property,
JavaScript `undefined`, Rust `Undefined`) contributes nothing; a `null` element
(the literal, or a property holding `null`) contributes `null`; duplicates are
kept. This is the one place the two spellings of absent (§1) are told apart. A
nested tuple is a collection and flattens one level like any other
(`(a, (b, c))` is `[a, b…, c…]` with the inner already flat). The result is a
collection: a tuple is a value (`size((a, b))`, `"x" in (tags, aliases)`) and a
receiver (`(mom, dad, siblings) { name values }`, `follow (before, after) { depth
2 }` — one destination over the union, §20). [`tuples`]

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
uses host reference identity; fixtures do not rely on it) — compare them with
`is` (§5b). [`scalar-equality`]

### 5b. Identity comparison (`is`, `is not`) and the required value (`x!`)

(since 0.17) `x is y` is true iff the two operands have the **same identity**
as §16 defines it — the notion `distinct` and `follow` already use: each side
is taken through the **host's** identity (`DataContext.identityOf` /
`identity`; the value itself when the host names none) and the two identities
compare **structurally** (absent ≡ `null`; numbers as doubles; strings by code
point; arrays element-wise; objects by own keys, order ignored; types never
conflated). `x is not y` is the exact negation. Consequences: for scalars `is`
and `==` coincide (`1 is 1`, `"a" is "a"`, `1 is "1"` is false, `nope is null`
is true and `nope is not null` false); two rows a host knows by one id are the
same whatever else they hold; under the structural default rows are the same iff
structurally equal, in both implementations (so `$it is ^$it` compares rows,
which `==` leaves unspecified). A projected `$key` (§16) does not change `is`:
it names rows for a walk, `is` compares values. `is` is at comparison precedence and does not chain. The prefix
forms are sugar: `is x` ≡ `!!x` (truthiness, §4), `not x` ≡ `!x`. Whether `in`
over rows should compare identities is **deferred** — it still uses `==` (§9).
[`sugar`]

`x!` — the **required** value — is `x` when `x` is present, and an **eval
error** when `x` is absent (`null` or missing), whose message is
`` `<x>!` is absent `` with `<x>` the canonical print of the expression
(AST.md §6) and, when the current scope's row has a **scalar `$key`** (§16: a
host identity, an entry's key, a projected `$key:` once the row is kept), the
suffix `` on <identity> `` (`on 7`, `on "d_1"`); under the structural default a
plain object has none. It is never a
filter and never a coercion: `0!`, `""!` and `false!` are the values. It binds
tightest (`-a!` is `-(a!)`, `!a!` is `!(a!)`, `a!.b` requires `a`, `a.b!`
requires `a.b`). Over a bracket lookup, `x[n]!` requires the positional row and
`x[p]!` requires exactly one match (GRAMMAR §4): zero is this error over the
`single` directive, many is the `single` error. [`sugar`, `errors-eval`]

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

### 7b. Template literals (since 0.21)

`` `text ${e1} text ${e2} …` `` (GRAMMAR §4) evaluates to a **string**: the text
parts verbatim (already decoded, newlines included) and, in place of each
interpolation, the **string form** of its value as §7 defines it — a string is
itself, a number renders as a double with no fraction when integer-valued (`-0`
is `"0"`, `2.0` is `"2"`, `25e-1` is `"2.5"`), `true`/`false` are the words —
concatenated in source order. A literal with no interpolation is its text; the
empty literal `` `` `` is `""`.

- **Absent propagates**, as in `+`: when any interpolated value is absent the
  whole literal is **absent** (never `"undefined"`, `"null"` or the text around
  it), so `` `${nope} x` `` is absent, `` `${nope}` == null `` is true, and an
  absent literal is a dropped property in a record.
- **A list, a record or a range cannot be interpolated**: it is an **eval
  error** whose message includes `cannot interpolate` and names the kind (`it is
  a list` / `a record` / `a range`). The language does not stringify a
  collection silently — where `+` leaves such operands unspecified (§7), a
  template literal refuses them. An entry value (§21) is a record here.
- **Every interpolation is evaluated**, left to right, before the result is
  decided: an error in a later interpolation is raised even when an earlier one
  was absent (`` `${nope}${tags}` `` with `tags` a list is the error, not
  absent), and an unknown function in any interpolation is its usual error.
- An interpolation is any value expression, read in the **same scope** as the
  literal: a bare name is the current row's property, `^name` the enclosing
  row's, `N^name` the scope at depth N, a block its own rows (`` `${jobs single
  { employer values where primary }}` ``), a nested template literal the same.

A template literal is a value everywhere a value stands — a `select` item, a
`where` operand (`` `${title}!` == "Alpha!" ``), an `order by` key, a function
argument or a method receiver (`` `${title}`.size() `` counts code points like
any string), the haystack of `in` — and is never a receiver or a source (it is a
literal: GRAMMAR §4). [`template-literals`, `errors-eval`]

## 8. Logical operators in value position

Outside the `where` tree, `&&` and `||` are value-producing: `a && b` yields
`a` when `a` is falsy, else `b`; `a || b` yields `a` when `a` is truthy, else
`b`. The words `and` / `or` are exact synonyms of the symbols (since 0.17) —
one operator each, so `title or $path` coalesces; the canonical printer writes
the words (AST.md §6, since 0.18). `!x` yields a boolean. Evaluation is **strictly left to right and
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
form. A nested `collect` item yields an array over a collection receiver and a
record (or absent) over one object (§3); `first`/`single` a record (or its
`values` value) or `null`. A `$key: expr` item is projected like any other and
names the rows' identity (§16). [`projection`, `values`, `consumers`,
`cardinality`, `identity`]

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

**`&&` and `||` (`and` / `or`) evaluate strictly left to right and
short-circuit**, in `where` exactly as in value position (§8). The engine never reorders conjuncts — not
even to run a cheap scalar before a consumer test — because evaluation order is
observable through errors: `false && foo(1)` is false, `xs none { } && foo(1)`
is false when `xs` has rows, and `true && foo(1)` raises `unknown function`. A
query may therefore guard an operand by position (`has(s) && s.matches(re)`).
[`where`, `logical`, `consumers`, `limit-offset`]

## 14. Select aliases in `where` and in later `select` items

A bare identifier in a body's `where` that names an alias of the **same body's**
`select` is replaced by that alias's expression before evaluation. Since 0.17
the same holds for a bare identifier in a `select` item that names an item **to
its left** (`boss: ^people[id == ^manager], bossName: boss.name`; a nested
directive alias inlines as a value-position directive): items resolve left to
right, each against the already-resolved items before it; a reference to an
item to its right is a parse error, as is a chain that returns to an item. The parser
keeps the identifier in the tree and only validates the reference (AST.md §2);
the substitution is the pure function `resolveAliases` / `resolve_aliases`,
which the run entry points apply exactly once (it is not idempotent:
`name: name.upper() … where name` resolves to `name.upper()`, whose `name` is
the row field). An engine evaluates the query it is given. Rules:

- an alias shadows a same-named row field inside `where` and in the items after it;
- an unaliased dotted item is an alias for its key (`meta.slug` → `slug`);
- inside an alias's own expression its name is the row field (not recursion);
  a chain of aliases that returns to one being resolved is a parse error, and
  so is a `select` item naming an item to its right;
- an alias whose value is a nested `collect`/`first`/`single` block may stand
  alone as a leaf (meaning "non-empty") but not appear inside an expression;
- nested blocks rewrite only against their own `select`; `^name` is never an
  alias; `order by` is **not** rewritten and reads row fields.
[`aliases`]

## 15. Consumers and result shapes

| Consumer | Result | Notes |
| --- | --- | --- |
| `collect` | array of projected rows — or, over a **single** receiver (one object, §3), the one record or absent | the body form's consumer |
| `exists` | boolean | true iff at least one row |
| `none` | boolean | true iff no rows |
| `count` | number | rows after where/distinct/bounds |
| `first` | projected row or `null` | the first row in result order |
| `single` | projected row or `null` | **eval error** when more than one row remains; the message reports the **true** number of rows after bounds (`matched 3 rows`), so `single` always materializes |

The same six shapes apply to nested directives, except that only
`collect`/`first`/`single` are legal in a projection and only
`exists`/`none`/`count`/`collect`(lifts) in `where`. [`consumers`, `cardinality`]

## 16. `distinct`

`distinct` — spelled `select distinct …`, `<consumer> distinct { … }`, `x
distinct { … }` (≡ `x collect distinct { … }`, since 0.20), or `follow distinct`
(§20) — keeps the **first** row per distinct **projected value**, preserving
order, before bounds are applied. Projections compare structurally with absent ≡
`null`, key order ignored. With an **empty projection** (`count distinct { }`)
rows dedup by **identity** — `$key`, below.

### Identity: `$key` (since 0.20)

Every row is known by one **identity**, `$key`: what `follow` uses for cycle
detection, the per-step union and `follow distinct` (§20), what `distinct` over
unprojected rows dedups by, what `is` compares (§5b), and what reading `$key` on
the row returns (§2). One meaning — "the key by which this item is known". The
language never names an `id` property; a host does, if it has one:

- **Default: the host's identity.** A `DataContext` may name a row's identity
  (the reference's optional `identityOf(row)`, the Rust trait's `identity`, which
  defaults to the row): a store answers its row id. Without one a row's identity
  is its **structural value** (portability): absent ≡ `null`; numbers as
  doubles; strings by code point; arrays element-wise; objects by own keys,
  **order ignored**; types never conflated — `1`, `"1"`, and `true` are three
  identities, `{}` and `[]` two more; `{a:1}` and `{a:2}` differ, so `[{a:1},
  {a:2}] count distinct { }` is 2. Implementations key identities with a
  canonical, type-tagged serialization (the reference's `canonicalKey`); hosts
  with cyclic object graphs supply an identity rather than rely on the
  structural default.
- **An entry's identity is its key** (§21) — the same `$key`.
- **Projection override.** A block — a `follow` destination block or the body's
  own `select` — may project **`$key: <expr>`**; the rows it yields carry that
  identity. `select name, $key: email from people follow next { $key: email }`
  walks `people` knowing every row by its email: the body's item names the
  seeds, the destination block's item its successors. In a body the `$key` item
  is also a column of the record (`{ name, $key }`), is read as the identity by
  `order by $key` and by `^$key` from a nested block, and — like any alias — may
  be named in `where`. In a **destination block** `$key:` names the identity of
  the successors it yields and is **not** a column: the rows keep the shape of
  the block's other items (its raw rows when `$key` is the only item), so `follow
  next { $key: email }` yields the `next` rows themselves, known by email.
- **Caveat.** Identities are compared as values across the whole walk, whichever
  destination produced them: destinations that can reach the same rows should
  project the same `$key`, or a cycle through both may run to the depth cap.

The in-memory `DefaultContext` names no identity, so over plain JSON the
fixtures project `$key: id` wherever a walk must recognise objects by an id.
[`distinct`, `identity`, `follow`]

## 17. `order by`

Rows sort by each key in turn; ties fall through to the next key; the sort is
**stable** (equal rows keep source order). Within a key, present values order
by §6 (numbers numerically, strings by **code point**: `"a"`, `"～"`, `"😀"`)
and `desc` reverses that order of present values only: **absent sorts last in
both directions**. Keys are arbitrary expressions read in the row's scope
(fields, `$it`, intrinsics, `^outer`); they are not rewritten against
aliases. Ordering of mixed-type or boolean keys is not specified. [`order-by`]

## 18. `limit` / `offset`

The bound applies **after** `where`, `order by`, and `distinct` and **before**
the consumer reduces the rows: `count { limit 2 }` ≤ 2, `first { offset 1 }` is
the second row, `exists { offset 2 }` needs a third row, `none { limit 0 }` is
true. The operand is evaluated in a row-less scope inside the block — a literal
or binding is itself, `^n` is the enclosing row's `n` — and must be a
**non-negative integer**, else an eval error (`limit must be a non-negative
integer …`), raised even when the block has no rows. A **top-level** bound is
evaluated in the root scope **without its row** (since 0.18 the root has one,
§2): its bare names are still the named roots, but `$it` there — reachable
only through a bracket inside the bound, `limit ${xs}[^$it == null]` — is
absent, not the root object, because the bound is read "inside the block" like
every other. [`limit-offset`, `errors-eval`]

## 19. Outer references and lifts

`^name` **reads** exactly N scopes out (§2). A `^name: expr` item inside a
`collect { … }` in `where` **binds**: for every matched row the value of `expr`
is appended to a list named `name` in the scope N carets out (`^` = the row the
`where` belongs to; `1^name: expr` names that scope by depth instead, §2),
flatten-appending as intermediate blocks fan out. The bound
name is then read there like a row property (`name, currentEmployers from …`).
A where-position `collect` with no matches is false, so the row is filtered out
rather than receiving an empty list. An unaliased `^name` item lifts the field
`name`. [`lifts`, `outer-refs`]

## 20. `follow`

`follow D` turns a body into a bounded, **per-path**, depth-first walk over one
or more comma-separated **destinations** `D1, …, Dn`. The body's `where` is
split: conjuncts that mention no recursion intrinsic select the **seeds**;
conjuncts that do are applied to the walked occurrences afterwards (seed
predicates never prune the walk). From each seed the destinations are followed,
visiting successors in order.

A row's **successors** are, per destination in source order, the rows that
destination yields (coerced per §3; a row lacking a relation contributes
nothing), concatenated and then **unioned by identity** (§16): an identity that
recurs within one step is kept once, at its first position, and the destination
that reached it first governs the occurrence (its `frontier`, below). A row with
no successors is a leaf.

- A **plain destination** (`children`, `doc.out`, `entries(kids)`, a tuple
  `(before, after)` — one destination over the union of its elements, §3b) is
  read in the row's own scope, like a body-level `from`; its rows are known by
  the host's identity.
- A **destination block** (`children { depth 2 }`, `^people { where manager ==
  ^id }`, `(before, after) { where id != 3 }`, `^people collect { … }`, `kids
  first { … }` — GRAMMAR §`follow`) is evaluated as a select-position directive
  **in the row's scope**: its receiver is read there (so `^people` from a
  top-level walk is the named root), and inside the block `^` reads the
  **frontier row** — the row being expanded — exactly as `^` reads the enclosing
  row in any nested block: `follow next { where prev == ^id }` steps only into
  rows that name the row they were reached from, `^^name` is the walk's
  enclosing scope. Its rows are the block's result: the raw rows under an empty
  projection, projected records otherwise (a projection shapes what gets
  expanded next), bare values under `values`; `first`/`single` yield at most
  one; a block over a single receiver (§3) yields its one record as one
  successor (or none). The block may order, bound and `distinct` its rows like
  any block. Its `$key: expr` item names the successors' identity and is not a
  column (§16).
- Two clauses of a destination block (since 0.20; they were options of the
  whole `follow` before): **`depth n`** — the destination expands a frontier
  row only while that row's `$depth < n` (so its successors have `$depth ≤ n`;
  1–8; a clause of a destination block alone); **`frontier P`** — an occurrence
  reached **through this destination** for which `P` holds is a frontier
  (`$stop == "frontier"`, not expanded). `P` is read in the occurrence's own
  scope with `^` the **walk's enclosing scope** (not the frontier row), as the
  body is read; seeds are reached through no destination and are never
  frontiers by this rule. The hard cap **8** is every destination's ceiling and
  the default.
- **The body's own `frontier P`** (since 0.20): the body that carries the
  `follow` — the top level, or a select-position block — may carry `frontier P`
  too, and it applies to the **seeds**: a seed for which `P` holds is a frontier
  (`$stop == "frontier"`, `$frontier` true, `$leaf` false) and is not expanded,
  while it stays in the result. `P` is read in the seed's own scope with `^` the
  enclosing scope, exactly as the body's `where` is (select aliases are not
  substituted, as in `order by`). Every block that feeds rows into the walk thus
  says which of its rows are frontiers, and the author defines the frontier
  relevant to the current `$it` separately from each destination's: the body's
  `frontier` never applies to an occurrence reached through a destination, a
  destination's never to a seed. Inside a destination block `frontier` is always
  the destination's clause, so a `follow` nested in a destination block has no
  seed frontier.

Each occurrence carries intrinsics:

- `$depth` — 1 for a seed;
- `$stop` — `cycle` > `frontier` > `depth` > `leaf` > `interior` (first that
  applies): the row's identity is already on the current path; the body (for a
  seed) or the destination that reached it (for an occurrence) marks it a
  frontier; the row has no successors and some
  destination **declined** to expand it by its `depth` (or `$depth` is 8); the
  row has no successors and nothing declined; otherwise interior. Only
  `interior` rows expand;
- `$leaf` = `$stop == "leaf"`; `$frontier` = `$stop` is `frontier` or `depth`;
- `$key` — the occurrence's identity (§16);
- `$ordinal` — a 1-based rank over all occurrences ordered by `$depth`, then
  by **path**, the sequence of identities from the seed to the occurrence,
  compared **component-wise as values**: two numbers numerically, two strings
  by code point (so `9` precedes `10`, never `"10" < "9"` as text); a number
  component precedes a string component; any other pairing orders by kind then
  by canonical serialization (the reference's `comparePath`). Which destination
  reached a row plays no part.

**Identity** is `$key` (§16): a seed's is the body's `$key:` item read in the
seed's scope, else the host's identity (structural by default — so over plain
JSON two objects with the same `id` are two nodes unless `$key: id` says
otherwise); a successor's is its destination block's `$key:` item, else the
host's identity of the row yielded. A revisit of an identity on the current path
is admitted **once** as `$stop == "cycle"` and not expanded, so cycles
terminate. A node reached by N distinct paths yields N occurrences; `follow
distinct` keeps the minimal `(depth, path)` occurrence per identity. Intrinsics
belong to the occurrence's scope: inside a nested block `$depth` is the nested
row's own `$depth` property (absent unless the host provides one, §2) and
`^$depth` is the occurrence's. `follow` is legal at the top level and inside a
select-position `collect`; inside a where-position directive it is an eval
error. A walk is always plural (§3). [`follow`, `identity`, `tuples`]

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
the property's **value** (`$it`, bare names, navigation) and `$key` is the
property's key — the entry's **identity** (§16; since 0.20 `$key` is the
identity on every row, so an ordinary row's `$key` is the host's or structural
identity rather than absent). Entries flow through every place a row does:
sources, `from` re-projections, nested receivers, `follow` seeds (which keep
their `$key`). As a plain value, `entries(x)` is an array of `{ key, value }`
records. [`entries`, `identity`]

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
method; `single` with more than one row; a required value that is absent
(§5b); an invalid `limit`/`offset` value (a bracket index is an `offset`);
`follow` in a where-position directive; an invalid or unsupported regex or
regex flag (§11); a scalar in row position (§3); a list, record or range
interpolated into a template literal (§7b);
a range in a result (§1); a binding out of range (§22). Evaluation is otherwise
total: absent navigation, arithmetic over absent, comparisons over absent or
mismatched types, membership in a non-container, and `range()` of a bad string
all yield a value (absent or `false`), never an error.
[`errors-lex`, `errors-parse`, `errors-eval`, `logical`, `regex`, `cardinality`]
