<!-- recital include: ../_fragments/attached-alchemy.md -->

# OQX tutorial · 8. Sugar — brackets, `!`, where-first blocks, `is` — and `refs()`

The previous pages already leaned on one shorthand — a filter that leads the
body needs no `where`. OQX 0.17 added it, and the rest of the shorthand for the
shapes you write most often. Each form **desugars in the
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

A bare name still **projects** (`_nodes { _name }` is `_nodes collect { _name }`),
so to filter on a bare boolean field lead with `is`:

```console
$ omg query 'docs count { is verified }'
15
```

Projection and filter together keep the keyword — names first, then `where`
(`{ _name where … }`; `{ age >= 18, name }` is an error that points you here):

```console
$ omg query 'docs { select outline: _nodes { _name where _kind == "md:section" } where _path == "/processes/magnum-opus.md" }' --jsonl
{"_id":"d_m67jwv8","_path":"/processes/magnum-opus.md","outline":[{"_name":"The magnum opus"},{"_name":"The four stages"},{"_name":"Why colour"},{"_name":"Operations"},{"_name":"Open questions"}]}
```

The lab notes' open tasks from [correlated-subqueries.md](./correlated-subqueries.md),
in the short form:

```console
$ omg query 'docs { select _path, open: _nodes { _value where _kind == "md:task" and not checked } where type == "lab-note" }' --jsonl
{"_id":"d_b089t54","_path":"/lab/2026-01-notes.md","open":[{"_value":"Repeat the series with copper"},{"_value":"Plot mass gain against heating time"},{"_value":"Tabulate the metal sulphides by colour"}]}
{"_id":"d_w18c2st","_path":"/lab/2026-02-notes.md","open":[{"_value":"Assay cycle 1 and cycle 4 crops for iron"},{"_value":"Write the plateau result up for the coagulation note"}]}
```

The sugar reaches everywhere a value stands (OQX 0.20): a call argument
(`size(_nodes { is checked })`), and a `follow` destination — `follow _children {
depth 2 }` is that destination's block, with `depth`/`frontier` as its own
clauses after `where` (the citation walk's block, `follow _out_links { from _dst
depth 2 }`, carries them the same way; there is no second brace). `x distinct {
… }` is `x collect distinct { … }`. The clause form (`select … from docs …`,
still read) is unchanged: there `type == "substance" from docs` is still the
clause-order error, because `where` follows `from`.

## Brackets: `x[p]`, `x[p]!`, `x[n]`

`x[p]` is `x first { where p }` — the first match, or absent. The 1:1 lookup
from [joins-and-lifts.md](./joins-and-lifts.md), navigated straight to a field:

```console
$ omg query 'docs { select subject, process: ^docs[slug == ^subject]._path where type == "lab-note" }' --jsonl
{"_id":"d_b089t54","_path":"/lab/2026-01-notes.md","subject":"calcination","process":"/processes/calcination.md"}
{"_id":"d_w18c2st","_path":"/lab/2026-02-notes.md","subject":"coagulation","process":"/processes/coagulation.md"}
```

`x[p]!` is `x single { where p }` **required**: exactly one match, or an error —
a lookup that doubles as an assertion. The one practitioner after 1600:

```console
$ omg query 'docs { select who: ^docs[type == "practitioner" and era > 1600]!._title where _path == "/index.md" }' --jsonl
{"_id":"d_sz1e8z0","_path":"/index.md","who":"Isaac Newton"}
```

Drop the era bound and four practitioners match — `single` refuses:

```console
$ omg query 'docs { select who: ^docs[type == "practitioner"]!._title where _path == "/index.md" }'
error[filter_invalid]: single { … } for 'receiver' matched 4 rows
  {
    "reason": "single { … } for 'receiver' matched 4 rows",
    "hint": "OQX"
  }
```

`x[n]` with an integer is **positional** — `x first { offset n }`; out of range
is absent, not an error. (`refs()` is explained below.)

```console
$ omg query 'docs { select first_before: refs(before)[0]._path where type == "milestone" }' --jsonl
{"_id":"d_q3f4m8t","_path":"/timeline/kickoff.md"}
{"_id":"d_3n5zn8a","_path":"/timeline/review.md","first_before":"/timeline/kickoff.md"}
```

## Postfix `!` — required

`x!` is `x`, or an error when `x` is absent. It is never a filter and never a
coercion (`0!` and `""!` are values): use it to insist that a field is present
before you rely on it. Both texts carry an `era`:

```console
$ omg query 'docs { select era! where type == "text" }' --jsonl
{"_id":"d_wc1napn","_path":"/texts/emerald-tablet.md","era":800}
{"_id":"d_f7w5k26","_path":"/texts/mutus-liber.md","era":1677}
```

The substances do not — the error names the expression and the row:

```console
$ omg query 'docs { select era! where type == "substance" }'
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
$ omg query 'docs { type == "text" and era is not null }'
d_wc1napn  /texts/emerald-tablet.md
d_f7w5k26  /texts/mutus-liber.md
$ omg query 'docs { type == "practitioner" and era is null }'
  no hits
```

(`is` sits at comparison precedence and does not chain; for scalars `is` and
`==` agree — the difference shows when the operands are rows, which `==` does
not compare.)

## A `select` item may use the items to its left

An alias is usable by the items after it (inlined before evaluation, as a
`where` alias is). Look a row up once, then navigate it twice:

```console
$ omg query 'docs { select hub: ^docs[type == "hub"], hub_path: hub._path where type == "lab-note" }' --jsonl
{"_id":"d_b089t54","_path":"/lab/2026-01-notes.md","hub":{"_id":"d_sz1e8z0","_path":"/index.md"},"hub_path":"/index.md"}
{"_id":"d_w18c2st","_path":"/lab/2026-02-notes.md","hub":{"_id":"d_sz1e8z0","_path":"/index.md"},"hub_path":"/index.md"}
```

(A row projected as a value renders as `{ _id, _path }` — the same keys a hit leads with.)

## `refs()` — document references held in a property

The two timeline milestones chain to each other through frontmatter: `before:`
and `after:` hold paths — the `/`-rooted reference form, a bare repo-relative
path, and a reference to a note that does not exist (yet):

```console
$ omg query 'docs { select _path, before, after where type == "milestone" }' --jsonl
{"_id":"d_q3f4m8t","_path":"/timeline/kickoff.md","after":"/timeline/review.md"}
{"_id":"d_3n5zn8a","_path":"/timeline/review.md","before":["/timeline/kickoff.md","processes/dissolution.md","/timeline/lost-notes.md"],"after":"/timeline/next-season.md"}
```

Those are strings. `refs(field)` resolves them to the **live documents** they
name — either path form, or a `d_…` id — and drops what resolves to nothing
(the dangling `lost-notes.md`), so it yields document rows wherever rows go: as
a receiver …

```console
$ omg query 'docs { select _path, prior: refs(before) { _path, when } where type == "milestone" }' --jsonl
{"_id":"d_q3f4m8t","_path":"/timeline/kickoff.md","prior":[]}
{"_id":"d_3n5zn8a","_path":"/timeline/review.md","prior":[{"_path":"/timeline/kickoff.md","when":"2026-01-05"},{"_path":"/processes/dissolution.md"}]}
```

… or as a `follow` destination, walking the timeline both ways from the review
(the kickoff's `after` leads back to the review, admitted once as a cycle; the
`order by` makes the two depth-2 rows print in path order):

```console
$ omg query 'docs { select _path, $depth where _path == "/timeline/review.md" follow refs(before), refs(after) order by $depth asc, _path asc }' --jsonl
{"_id":"d_3n5zn8a","_path":"/timeline/review.md","$depth":1}
{"_id":"d_91vsvhk","_path":"/processes/dissolution.md","$depth":2}
{"_id":"d_q3f4m8t","_path":"/timeline/kickoff.md","$depth":2}
{"_id":"d_3n5zn8a","_path":"/timeline/review.md","$depth":3}
```

The reverse direction needs no function: because `_path` *is* the reference
form, "the documents whose `before` names me" is a membership test against the
outer row's path — here in the short block form:

```console
$ omg query 'docs { select _path, next: ^docs { ^_path in list(before) } where type == "milestone" }' --jsonl
{"_id":"d_q3f4m8t","_path":"/timeline/kickoff.md","next":[{"_id":"d_3n5zn8a","_path":"/timeline/review.md"}]}
{"_id":"d_3n5zn8a","_path":"/timeline/review.md","next":[]}
```

And the mistake `refs()` exists to catch: `follow before` reaches the strings
themselves, and a hit must be a store row —

```console
$ omg query 'docs { where _path == "/timeline/review.md" follow before }'
error[filter_invalid]: a hit must be a document, block, node, link or revision row — the query reached a string ("/timeline/kickoff.md"); to follow document references held in a property use refs(<field>)
  {
    "reason": "a hit must be a document, block, node, link or revision row — the query reached a string (\"/timeline/kickoff.md\"); to follow document references held in a property use refs(<field>)",
    "hint": "OQX"
  }
```

---

That's the language end to end — filtering, targets, shaping, correlated
subqueries, joins & lifts and the root row, aggregates, full-text, traversal,
and the sugar. Back to the [tutorial index](./README.md).
