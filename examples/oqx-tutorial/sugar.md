<!-- recital include: ../_fragments/attached-alchemy.md -->

# OQX tutorial · 8. Sugar — brackets, `!`, where-first blocks, `is` — and `refs()`

Every query on the previous pages was written in the explicit form. OQX 0.17
adds shorthand for the shapes you write most often. Each form **desugars in the
parser** to a directive you already know, so nothing here carries new semantics
except the postfix `!` and the infix `is`; the explicit form is always still
accepted.

## A block without a consumer is `collect`; a leading predicate is `where`

`docs { … }` is `docs collect { … }`, and a block whose *leading* expression is
syntactically a predicate — a comparison, a call, `in`, `is`/`not`, a consumer
test, a literal, a parenthesized expression — drops its `where`:

```console
$ omg query 'docs { type == "substance" }'
d_0vsapzt  /substances/mercury.md
d_1rren8z  /substances/philosophers-stone.md
d_prj3j7a  /substances/prima-materia.md
d_h73rhv8  /substances/salt.md
d_5zmf9f7  /substances/sulphur.md
```

A bare name still **projects** (`nodes { name }` is `nodes collect { name }`),
so to filter on a bare boolean field lead with `is`:

```console
$ omg query 'docs count { is verified }'
15
```

Projection and filter together keep the keyword — names first, then `where`
(`{ name where … }`; `{ age >= 18, name }` is an error that points you here):

```console
$ omg query 'select outline: nodes { name where kind == "md:section" } from docs where $path == "/processes/magnum-opus.md"' --jsonl
{"id":"d_m67jwv8","path":"/processes/magnum-opus.md","outline":[{"name":"The magnum opus"},{"name":"The four stages"},{"name":"Why colour"},{"name":"Operations"},{"name":"Open questions"}]}
```

The lab notes' open tasks from [correlated-subqueries.md](./correlated-subqueries.md),
in the short form:

```console
$ omg query 'select $path, open: nodes { value where kind == "md:task" and not checked } from docs where type == "lab-note"' --jsonl
{"id":"d_b089t54","path":"/lab/2026-01-notes.md","$path":"/lab/2026-01-notes.md","open":[{"value":"Repeat the series with copper"},{"value":"Plot mass gain against heating time"},{"value":"Tabulate the metal sulphides by colour"}]}
{"id":"d_w18c2st","path":"/lab/2026-02-notes.md","$path":"/lab/2026-02-notes.md","open":[{"value":"Assay cycle 1 and cycle 4 crops for iron"},{"value":"Write the plateau result up for the coagulation note"}]}
```

One carve-out: after a `follow` destination a brace is still the **options**
block — `follow doc.out { depth 2 }` bounds the walk, it does not collect. The
top level is unchanged too: `type == "substance" from docs` is still the
clause-order error, because `where` follows `from`.

## Brackets: `x[p]`, `x[p]!`, `x[n]`

`x[p]` is `x first { where p }` — the first match, or absent. The 1:1 lookup
from [joins-and-lifts.md](./joins-and-lifts.md), navigated straight to a field:

```console
$ omg query 'select subject, process: ^docs[slug == ^subject].$path from docs where type == "lab-note"' --jsonl
{"id":"d_b089t54","path":"/lab/2026-01-notes.md","subject":"calcination","process":"/processes/calcination.md"}
{"id":"d_w18c2st","path":"/lab/2026-02-notes.md","subject":"coagulation","process":"/processes/coagulation.md"}
```

`x[p]!` is `x single { where p }` **required**: exactly one match, or an error —
a lookup that doubles as an assertion. The one practitioner after 1600:

```console
$ omg query 'select who: ^docs[type == "practitioner" and era > 1600]!.$title from docs where $path == "/index.md"' --jsonl
{"id":"d_sz1e8z0","path":"/index.md","who":"Isaac Newton"}
```

Drop the era bound and four practitioners match — `single` refuses:

```console
$ omg query 'select who: ^docs[type == "practitioner"]!.$title from docs where $path == "/index.md"'
error[filter_invalid]: single { … } for 'receiver' matched 4 rows
  {
    "reason": "single { … } for 'receiver' matched 4 rows",
    "hint": "OQX"
  }
```

`x[n]` with an integer is **positional** — `x first { offset n }`; out of range
is absent, not an error. (`refs()` is explained below.)

```console
$ omg query 'select first_before: refs(before)[0].$path from docs where type == "milestone"' --jsonl
{"id":"d_q3f4m8t","path":"/timeline/kickoff.md"}
{"id":"d_3n5zn8a","path":"/timeline/review.md","first_before":"/timeline/kickoff.md"}
```

## Postfix `!` — required

`x!` is `x`, or an error when `x` is absent. It is never a filter and never a
coercion (`0!` and `""!` are values): use it to insist that a field is present
before you rely on it. Both texts carry an `era`:

```console
$ omg query 'select era! from docs where type == "text"' --jsonl
{"id":"d_wc1napn","path":"/texts/emerald-tablet.md","era":800}
{"id":"d_f7w5k26","path":"/texts/mutus-liber.md","era":1677}
```

The substances do not — the error names the expression and the row:

```console
$ omg query 'select era! from docs where type == "substance"'
error[filter_invalid]: `era!` is absent on "d_0vsapzt"
  {
    "reason": "`era!` is absent on \"d_0vsapzt\"",
    "hint": "OQX"
  }
```

`!` binds tightest: `refs(c)[0]!.name` requires the lookup, `refs(c)[0].name!`
the name.

## `is`, `is not`, and the word operators

`and` / `or` / `not` are the canonical connectives you have seen throughout
(`&&` / `||` / `!` are accepted synonyms). `is x` is truthiness (`!!x`), and the
infix `x is y` / `x is not y` compares **identity** — a row's id when it has one,
else the value itself. `x is null` is the idiomatic absence test:

```console
$ omg query 'from docs where type == "text" and era is not null'
d_wc1napn  /texts/emerald-tablet.md
d_f7w5k26  /texts/mutus-liber.md
$ omg query 'from docs where type == "practitioner" and era is null'
  no hits
```

(`is` sits at comparison precedence and does not chain; for scalars `is` and
`==` agree — the difference shows when the operands are rows, which `==` does
not compare.)

## A `select` item may use the items to its left

An alias is usable by the items after it (inlined before evaluation, as a
`where` alias is). Look a row up once, then navigate it twice:

```console
$ omg query 'select hub: ^docs[type == "hub"], hub_path: hub.$path from docs where type == "lab-note"' --jsonl
{"id":"d_b089t54","path":"/lab/2026-01-notes.md","hub":{"id":"d_sz1e8z0","path":"/index.md"},"hub_path":"/index.md"}
{"id":"d_w18c2st","path":"/lab/2026-02-notes.md","hub":{"id":"d_sz1e8z0","path":"/index.md"},"hub_path":"/index.md"}
```

(A row projected as a value renders as `{ id, path }`.)

## `refs()` — document references held in a property

The two timeline milestones chain to each other through frontmatter: `before:`
and `after:` hold paths — the `/`-rooted reference form, a bare repo-relative
path, and a reference to a note that does not exist (yet):

```console
$ omg query 'select $path, before, after from docs where type == "milestone"' --jsonl
{"id":"d_q3f4m8t","path":"/timeline/kickoff.md","$path":"/timeline/kickoff.md","after":"/timeline/review.md"}
{"id":"d_3n5zn8a","path":"/timeline/review.md","$path":"/timeline/review.md","before":["/timeline/kickoff.md","processes/dissolution.md","/timeline/lost-notes.md"],"after":"/timeline/next-season.md"}
```

Those are strings. `refs(field)` resolves them to the **live documents** they
name — either path form, or a `d_…` id — and drops what resolves to nothing
(the dangling `lost-notes.md`), so it yields document rows wherever rows go: as
a receiver …

```console
$ omg query 'select $path, prior: refs(before) collect { $path, when } from docs where type == "milestone"' --jsonl
{"id":"d_q3f4m8t","path":"/timeline/kickoff.md","$path":"/timeline/kickoff.md","prior":[]}
{"id":"d_3n5zn8a","path":"/timeline/review.md","$path":"/timeline/review.md","prior":[{"$path":"/timeline/kickoff.md","when":"2026-01-05"},{"$path":"/processes/dissolution.md"}]}
```

… or as a `follow` destination, walking the timeline both ways from the review
(the kickoff's `after` leads back to the review, admitted once as a cycle; the
`order by` makes the two depth-2 rows print in path order):

```console
$ omg query 'select $path, $depth from docs where $path == "/timeline/review.md" follow refs(before), refs(after) order by $depth asc, $path asc' --jsonl
{"id":"d_3n5zn8a","path":"/timeline/review.md","$path":"/timeline/review.md","$depth":1}
{"id":"d_91vsvhk","path":"/processes/dissolution.md","$path":"/processes/dissolution.md","$depth":2}
{"id":"d_q3f4m8t","path":"/timeline/kickoff.md","$path":"/timeline/kickoff.md","$depth":2}
{"id":"d_3n5zn8a","path":"/timeline/review.md","$path":"/timeline/review.md","$depth":3}
```

The reverse direction needs no function: because `$path` *is* the reference
form, "the documents whose `before` names me" is a membership test against the
outer row's path — here in the short block form:

```console
$ omg query 'select $path, next: ^docs { ^$path in list(before) } from docs where type == "milestone"' --jsonl
{"id":"d_q3f4m8t","path":"/timeline/kickoff.md","$path":"/timeline/kickoff.md","next":[{"id":"d_3n5zn8a","path":"/timeline/review.md"}]}
{"id":"d_3n5zn8a","path":"/timeline/review.md","$path":"/timeline/review.md","next":[]}
```

And the mistake `refs()` exists to catch: `follow before` reaches the strings
themselves, and a hit must be a store row —

```console
$ omg query 'from docs where $path == "/timeline/review.md" follow before'
error[filter_invalid]: a hit must be a document, block, node or edge row — the query reached a string ("/timeline/kickoff.md"); to follow document references held in a property use refs(<field>)
  {
    "reason": "a hit must be a document, block, node or edge row — the query reached a string (\"/timeline/kickoff.md\"); to follow document references held in a property use refs(<field>)",
    "hint": "OQX"
  }
```

---

That's the language end to end — filtering, targets, shaping, correlated
subqueries, joins & lifts and the root row, aggregates, full-text, traversal,
and the sugar. Back to the [tutorial index](./README.md).
