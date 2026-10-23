# omgbase — Query Language Spec (OQX)

**As-built (2026-09):** the query language is **OQX** (omgbase Query eXpressions),
the **`@omgbase/oqx`** package (parser + engine + scalar-semantics contract — a
standalone zero-dependency library, in-tree at `packages/oqx` since ADR-019 and
published on its own version line), bound to omgbase's SQLite store by `packages/core/src/oqx-js/`
(a `DataContext` in `context.ts`, the `oqxRun` wrapper in `run.ts`, and a tier-3
pushdown planner in `planner.ts`). See **ADR-013**. This document specs the
language as-built; the **behavioral ground truth** is the corpus
(`packages/core/corpus/oqx/alchemy.test.ts` + `conformance.test.ts`), then the
`query` tool description in `packages/core/src/mcp/server.ts`. Where this doc and
those disagree, they win.

> **Specs.** The language itself is `spec/oqx` (grammar, semantics, the fixture
> corpus both engines run). The *binding* of that language to the store — roots,
> fields, attributes, reach-through, relations, the row functions, the runner's
> paging — is `spec/surface/README.md` §1, pinned by the corpus-backed suites
> `spec/surface/cases/query-*.json` (the 18-document alchemy repository, every
> case run planned and pure in-memory, which must agree). Regenerate with
> `SURFACE_SPEC_UPDATE=1` on `packages/core/corpus/surface/spec.test.ts`.

> **Scalar semantics changed with ADR-013** (there were no active users). This
> replaces the former CEL sublanguage; the notable differences from the retired
> CEL rules are called out inline as **[was CEL: …]**.

---

## 1. OQX — one expression

The `query` MCP tool takes a single OQX **string** plus pagination:

```jsonc
{ "query": "<OQX expression>", "limit": 50, "cursor": null }
```

Every concern folds into the expression: the collection heading the body
(`docs|blocks|nodes|links { … }`, the source), `select <expr>, name: <expr>, …`
(projection), `where <predicate>`,
receiver-constrained nested queries (`_nodes exists { … }`, `_nodes { … }`),
correlation/joins (the `^` sigil, with `^docs`/`^nodes`/`^blocks` reaching the
root row's collections), bounded traversal (`follow`), `order by <expr> [asc|desc]`, and
`limit`/`offset`. Results are lean projected hits (`{ _id, _path, …projections }`
— the envelope keys are the attributes the language reads, so a hit's `_id`
pastes into the next `where _id == "…"` unchanged), a `count`/`exists`/`none`
scalar, or — for a `select <expr> values` projection — the bare projected
values (`values: […]`, §7); never full documents; hydrate by `_id` afterward
(every tool spells a row's identity `_id`/`_path`, §2).

**The collection heads the body (oqx 0.26); clause order is fixed (ADR-020,
oqx ≥ 0.11).** A query is a collection followed by a braced body — `docs { … }`,
`blocks { … }`, `nodes { … }`, `links { … }`, `revisions { … }` (or a row-valued
function such as `refs("/index.md") { … }`). A consumer word may stand between
the collection and the brace (`docs count { … }`, `docs first { … }`,
`docs exists { … }`), and nothing follows the closing brace. Within one body —
the top level or any nested `{ block }` — clauses appear at most once each, in
exactly this order:

```
<collection> [count|exists|none|first|single] {
  [select <projection>] [from <rel>] [where <pred>] [frontier <pred>] [follow <rel> [{…}]]
  [flatten <expr> [{…}] [as <name>]]… [group by <key>, …] [having <pred>]
  [order by …] [limit N] [offset N]
}
```

Every clause is optional. The body's rows come from the collection before the
brace, never from a `from`: a `from` **inside** a body is the re-projection, a
flat-map through a relation of the row (`docs { from _nodes where _kind ==
"md:task" }` yields the task nodes of every document, `follow _out_links { from
_dst }` steps from a link row to its destination). A clause out of order
is a parse error that names the order (`` `select` must come before `from` — OQX
clause order is select, from, where, frontier, follow, flatten, group by, having,
order by, limit, offset ``; `flatten` alone may repeat). **Only
`select` may drop its keyword, and only when it is the first clause written**
(`docs { _path, era where … }`; in a nested block, `_nodes { _value }` projects
`_value`) — this document keeps the keyword wherever it projects. Every other
clause always carries its keyword — with the 0.17 sugar
that a **body** whose leading expression is syntactically a predicate is a
`where`-first body: `docs { layer == "working" }` ≡ `docs { where layer ==
"working" }`, `_nodes exists { _kind == "md:task" }` ≡
`_nodes exists { where _kind == "md:task" }` (§3.6; a bare name still projects, a
predicate after a projection still needs `where`). `from docs count` is an error
rather than a projection of a field called `count` (write `docs count { … }`, or
`docs { select count }`). **The clause form is still accepted:** `select … from
docs where …` — the collection named by a top-level `from` after the projection
— parses to the same tree as `docs { select … where … }`, but it is no longer
written; in that form a top-level predicate always needs `where`, and `era >
1600 from docs` is the clause-order error it was. **`where` (and, since 0.17, a
later `select` item) may reference the same body's `select` aliases** (`docs {
select _path, old: era < 1000 where old }`): the alias's
expression is substituted before evaluation (`resolveAliases`, once, ahead of
the runner's own rewrites — the parsed tree keeps the alias), so the pushdown
planner sees an ordinary predicate; an alias shadows a same-named field inside `where`; a cycle among
aliases is a parse error; each block rewrites only against its own `select`.
`order by` is not rewritten — it reads row fields.

Consumers (oqx ≥ 0.9): `collect` (rows, the default), `exists` (≥ 1 row),
`none` (0 rows — exactly `not … exists { … }`, and the way to say "every":
`_nodes none { _kind == "md:task" and not checked }`), `count`, `first`,
`single`. There is deliberately no `all { … }`: its block would have to mean
something different from every other consumer's.

## 2. Targets and field namespaces

**The name rule (spec/surface §1.2, 5.0 — "underscore = engine").** On every
record kind a **bare** name is a user-authored entry and an
**underscore-prefixed** name is engine-provided, however derived. `$` belongs to
OQX: `$it`, `$key`, `$depth`, `$stop`, `$leaf`, `$frontier`, `$ordinal` are
values the *language* injects into a scope, and omgbase adds **no** `$` names
(a `$id` or `$path` in a query is an unknown OQX identifier — absent — never an
attribute). The `_` prefix declares an engine field on a record — attribute,
handle or relation alike (`_id`, `_path`, `_title`, `_data`, `_blocks`,
`_out_links`, `_doc`, …) — and the bare namespace is the user's on every record
(docs, blocks, nodes, links, revisions and the root row), because any record may
carry user data later. Nothing is reserved: an authored `title:`, `tags:`, `id:`,
`path:`, `doc:` or `format:` key is read by its bare name; the computed title is
`_title`, the authored tags ∪ the body `#hashtags` (deduped, authored first, then
hashtags in document order; `null` when both are absent) is `_tags`, the engine's
`/`-rooted location is `_path`. The **source handles** narrow an authored read
to one provenance: `_data.<k>` is the merged authored view (frontmatter + inline
by the property rule — exactly the read a bare `<k>` performs, so `_data.<k>` ≡
`<k>`), `_frontmatter.<k>` / `_inline.<k>` one source each — and the one way to
an authored key whose own name begins with `_` (a bare `_x` is always read as an
engine name). `entries(_data)` lists every authored top-level key (frontmatter ∪
inline, deduped, key order). Collections stay bare — `docs { … }`, `^docs`,
`0^docs`, `docs count { … }`, `entries(^$it)` names `docs blocks nodes links
revisions` — because the collection heading a body names a collection, not a
row property; and so do
the row functions in call position (`text("x")`, `semantic(…)`, `under(…)`,
`refs(x)`, …): a call is never an entry read. There is no self alias: `$it` is
the row (`doc` on a document, `block` on a block and `section` on a node were
retired in 5.0 — a bare `doc` is an authored key like any other); the
reach-throughs are `_doc` (a block's, node's, link's or revision's document),
`_block` (a node's or link's block) and `_dst` (a link's destination document).
A foreign key is named for what it is (`_doc_id`, `_block_id`, `_via_id`,
`_dst_id`, `_dst_path`, `_uri`), a column is its column (`_type`, `_text`,
`_depth`, `_ordinal`, `_kind`, `_predicate`, `_field`). **Same value, same
name, everywhere:** tool results and arguments spell a row attribute exactly as
the language reads it (`_id`, `_path`, `_raw`, `_hash`, `_updated_at`,
`_doc_id`, …), so a key read from any result pastes into a query and into a
tool's `_id` argument; a key that names a *role* (`rev`, `cursor`, `to`,
`plan_id`, `locator`, …) stays bare, and so does an argument that is not a row
attribute (`docs_create.path`, `docs_tree.path`, `path_glob`). A bare `id` /
`path` / `ids` **argument** is an argument error naming the `_` spelling (no
tolerance). On the `blocks`/`nodes` targets a bare name reads the row's `attrs`
key of that name (`checked` ≡ `_attrs.checked`); on the open `docs` target it is
a document property. **[was, 3.0–4.11: the attributes were bare and won on
collision (`path`, `title`, `tags`, `blocks`, `doc`, …), an authored key that
collided was reached as `data.<k>`, and `doc`/`block`/`section` were self
aliases; before 3.0 the attributes were `$`-prefixed.]**

**Unknown names (spec/surface §1.5, 5.0).** Every name a query reads is judged
*statically*, before any row is read, against the vocabulary of the row kind
its scope holds — the kind's engine names (a closed `_` set), plus every
authored property at least one live object of that kind in the repository
carries (a frontmatter/inline key on docs; an `attrs` key on blocks and nodes).
There is one tier: a **bare** name no object of the kind carries is a property
read that yields absent — on `docs`, `blocks` and `nodes` the read still
returns its rows and gains `hints: [string…]` (one line per name, with the
nearest match drawn from the authored keys *and* the engine names — `` `titel`
is not a field of docs and no document in this repository carries a property
by that name; did you mean `_title`? `` — so a bare `title`/`id`/`path`/`tags`/
`format` in a repository that authors none is pointed at its `_` spelling),
while a write selector (`plan`/`apply`/`execute` with `select`) is refused,
since `where target != "x"` would select every row; on `links` and `revisions`
(closed: no authored data reaches them) a bare name is `filter_invalid`. A
**`_x` that is no engine name of the kind** is `filter_invalid` naming the
kind's engine names — the one place a loud error is right. The verdict never
depends on the query's filter: a property some documents carry (`stage` on the
processes alone) is known, and a repository with no object of a kind has no
vocabulary to judge by. The judged names are the ones `@omgbase/oqx`'s
`references` pass lists (spec/oqx AST.md §5b): bare identifiers, dotted
navigations, outer references, method receivers, every nested block —
not aliases, `$`-names, bindings or function names.

| kind | engine attributes | engine handles / relations | bare names |
| --- | --- | --- | --- |
| docs | `_id` `_path` `_raw` `_hash` `_updated_at` `_created_at` `_title` `_tags` `_format` | `_data` `_frontmatter` `_inline`; `_blocks` `_nodes` `_out_links` `_in_links` `_revisions` | every authored property (frontmatter + inline) — `title`, `tags`, `id`, `path`, `doc`, `format` included |
| blocks | `_id` `_path` `_doc_id` `_raw` `_hash` `_updated_at` `_created_at` `_type` `_text` `_attrs` `_depth` `_ordinal` | `_doc`; `_children` `_nodes` `_out_links` `_section` | an `attrs` key (`checked`, `level`, `lang`; `_attrs.<k>` ≡ `<k>`) |
| nodes | `_id` `_path` `_doc_id` `_block_id` `_kind` `_name` `_value` `_attrs` | `_doc` `_block`; `_blocks` `_subsections` `_children` | an `attrs` key (`checked`, `first_ordinal`, …) |
| links | `_id` `_path` `_doc_id` `_block_id` `_via_id` `_dst_id` `_dst_path` `_uri` `_field` `_dst_kind` `_predicate` `_provenance` `_anchor` | `_doc` `_dst` `_block` | none (closed) |
| revisions | `_id` `_path` `_rev` `_seq` `_doc_id` `_commit` `_ts` `_origin` `_actor` `_reason` `_hash` `_is_current` `_archived` | `_doc` (the document's current row) | none (closed) |
| root | `_id` (`^_id`, `0^_id`) | the five collections `docs` `blocks` `nodes` `links` `revisions` | — |

Language words that can never be a bare field: `select from where is not and
or`, the literals `true false null`. The contextual words (`limit order offset
follow collect count first distinct desc by in`) parse as fields in expression
position (`docs { select o: order }`). A user key with any reserved name is
`_data.<k>` (or `_frontmatter.<k>` / `_inline.<k>` by source; `_attrs.<k>` on a
block or node).

**[was, before 3.0: the attributes were `$`-prefixed (`$id`, `$path`, …) with
`$body`/`$content_hash`; blocks `$doc`, `$ordinal`/`$depth` (colliding with the
`follow` recursion intrinsics, which shadowed them inside a walk); nodes
`$doc_id`/`$block_id`/`$node_id`; the `links` target was `edges` (its relations
`out_edges`/`in_edges`, its root collection `^edges`) with `$src`/`$dst`/`$src_block`/`$via`/
`$dst_path`/`$dst_uri`/`$from_commit` and the field `src_field`. `$from_commit`
is gone outright — a query sees open edges only.]**

**Paths (spec/surface 2.0).** omgbase stores a document's path repo-relative
(`projects/oqx.md`), but every reference an author writes is root-absolute
(`[x](/projects/oqx.md)`, `before: [/timeline/kickoff.md]`). The surface
speaks the reference form: `_path` on every target, `_dst_path` on links, the
`_path` of every hit and of a row rendered as `{ _id, _path }` are `/`-rooted.
Every path the surface accepts tolerates both forms — tool arguments, `refs(x)`,
`within(…)`, and a **string literal** compared with `_path`/`_dst_path` by
`==`/`!=` or passed to their `.startsWith(…)`, which is rooted before
evaluation (`_path == "a.md"` and `_path == "/a.md"` both match; write the
rooted form). Nothing else is rewritten: a property's value is the author's
(`where customer == ^_path`, `where ^_path in list(after)` — no `"/" + ^_path`
glue), and `matches`/`contains`/`endsWith` read the string as it is
(`matches("^/texts/")`). The planner de-roots the literal (or roots the
column) so pushed SQL and the in-memory engine agree.

### `docs`
- **Bare identifiers** = a document **property** (frontmatter + inline `key:: value`,
  unioned), resolved against the indexed `properties` table. Nested maps flatten
  to dotted keys (`meta.owner`), and a bare `logging` reconstructs the nested
  object so `logging.level` navigates it. A value is scalar-comparable only when
  the key is **single-valued and scalar-authored** in scope; a list/repeated/
  collided key compares unequal — use `list()` (§4). Nothing is reserved
  (5.0): an authored `title:`, `path:`, `id:`, `tags:`, `doc:` or `format:` is
  read by its bare name.
- **Source handles:** `_data.<k>` (the merged authored view, frontmatter +
  inline — the read a bare `<k>` performs; `_data.<k>` ≡ `<k>`),
  `_frontmatter.<k>` / `_inline.<k>` (one source — and the way to an authored
  key whose own name begins with `_`). The whole bag as a collection:
  `entries(_data)` / `entries(_frontmatter)` / `entries(_inline)` (oqx ≥ 0.10) —
  one entry per top-level key, **in key order** (authored position is not
  indexed), valued by the same scalar-vs-list rule as a bare read, dotted keys
  folded back into a nested value; inside the block `$key` is the key and `$it`
  the value.
- **Attributes:** `_id`, `_path` (the **reference form**, `/`-rooted — see "Paths"
  above), `_updated_at` (ISO-8601 UTC, compares lexicographically =
  chronologically), `_created_at` (surface 4.10: the first revision's commit
  `_ts`, the same form — when omgbase first observed the document, not a
  filesystem time; equal to `_revisions first { _ts values }`; survives the
  retention squash; the Dataview `file.ctime` sort key — `where`/`order by`
  over it behave exactly as over `_updated_at`), `_raw` (the whole file, frontmatter included), `_hash` (its
  sha256, 64 hex), `_title` (the computed title — the first H1 — `null` when
  none; the authored `title:` is the bare `title`), `_tags` (the authored tags ∪ the
  body `#hashtags`, deduped, authored first; the authored list alone is the bare
  `tags`), `_format` (`"markdown"`/`"yaml"`/`"json"`).
- **The root row** (spec/oqx 0.18, surface 2.0): the repository is the root
  scope's row. From a top-level row `^docs` / `^blocks` / `^nodes` / `^links` are
  the explicit root scans (§3.4; one caret per enclosing block, or the absolute
  `0^docs` from any depth), `^_id` / `0^_id` the repository id, and `^$it` the
  root object itself — `^$it.docs` ≡ `^docs`, `entries(^$it)` names the five
  collections (`_id` is an attribute, not an entry). **[was: `$repo.<target>` /
  `$repo.id`, an intrinsic of every scope — removed in surface 2.0; reading
  `$repo` anywhere is `filter_invalid` naming the replacement. A bare target
  name inside a block (`docs { … }` at depth ≥ 1) is `filter_invalid`
  too — "did you mean `^docs`" — not an empty property read, and so is a
  `^docs` with more carets than enclosing scopes (`^docs count { }` at the top
  level — write the bare `docs`); a frontmatter key named
  `docs`/`blocks`/`nodes`/`links`/`revisions` is reachable only as
  `_data.<k>` / `_frontmatter.<k>`.]**
- **`$it`** (every scope, oqx ≥ 0.8): the current item **itself** — the row
  when scanning a target, or the scalar element when a block's receiver is a
  list-valued property (`tags exists { $it == "pricing" }`,
  `tags { $it values }`). Inside a block `^$it` is the enclosing
  row. It is engine-owned (never a stored field) and never pushed to SQL. It is
  also the only self (5.0): the `doc` alias a document once carried is gone, so
  `$it.layer` or the bare `layer` reads a property, and a bare `doc` is an
  authored key.
- **Relations:** `_nodes`, `_blocks`, `_out_links`/`_in_links` (a doc's
  links as rows), `_revisions`. There is no `out`/`in` relation (3.0): the documents at the
  other end of the links are `_out_links distinct { from _dst }` (linked
  to) and `_in_links distinct { from _doc }` (linking in) — `_dst` is a
  link row's destination document, `_doc` its source (see `links`).

### `blocks`
- **Engine fields:** `_doc_id` (the owning document), `_type`, `_text` (the
  normalized text), `_ordinal` (0-based among its siblings), `_depth` (nesting
  depth, 0 at the top level), `_attrs` (the bag). Every `attrs` key is
  FLATTENED onto the row as a **bare** name: `checked` reads `_attrs.checked`
  (`_attrs.<key>` ≡ `<key>`); an absent key is silently false in
  a predicate, exactly like a missing frontmatter key on a doc. Inside a
  `follow`, `$depth`/`$ordinal` are always the walk's metadata (§6); a block's
  own nesting is `_depth`/`_ordinal` everywhere.
- **Attributes:** `_id`, `_path` (the owning doc's path), `_raw` (the block's raw
  source bytes — a container's raw holds its children verbatim), `_hash` (its
  sha256; the value `update`/`split` expect as `expect.content_hash`),
  `_updated_at` (the latest commit that changed the block), `_created_at`
  (surface 4.10: the earliest — the commit that first wrote the id; kept by
  the retention squash).
- **Doc reach-through:** `_doc.<key>` / `_doc._path` / `_doc._id` / `_doc._format`
  constrain by the owning document (scope, not selection; `_doc.layer` is the
  owner's authored `layer`, `_doc._title` its computed title). `_doc._id` and
  `_doc._path` are **foreign-key eliminated** (spec/surface §1, 3.0): they read
  the row's own `_doc_id` / joined path — no owner lookup in memory, the FK
  column in SQL — so `_doc._id == "d_1"` and `_doc_id == "d_1"` plan to the same
  statement.
- **Relations:** `_children`, `_nodes`, `_out_links`, `_section`
  (enclosing `md:section` node(s)). The `block` self alias is gone (5.0): `$it`
  is the row. **Structural functions:** §5.

### `nodes`
- **Engine fields:** `_kind` (`md:task`/`md:link`/`yaml:…`), `_name`, `_value`,
  `_attrs`, and every `attrs` key FLATTENED onto the row as a bare name
  (`checked` on a task, `level` on a section ≡ `_attrs.checked` / `_attrs.level`).
  An absent key is silently false.
- **Engine fields (foreign keys):** `_doc_id`, `_block_id` (null for a block-less
  node).
- **Attributes:** `_id`, `_path`.
- **Reach-through:** `_doc.<key>` / `_doc._id` / `_doc._path`, `_block._type` /
  `_block._text` / `_block._id` / `_block._path` / `_block._doc_id` (the identity
  reads are FK-eliminated: the node's own columns).
- **Section relations:** `_blocks` (content under an `md:section` node's
  heading), `_children` (immediate child sections), `_subsections`
  (all contained sections). The `section` self alias is gone (5.0): `$it` is
  the row.

### `links`
The authored link graph as first-class rows — one row per link RELATION (the
open `edges` rows of the storage table, `to_commit IS NULL`; the target was named
`edges` before the 3.0 name pass). Distinct from the `md:link`/`md:wikilink`
NODE, which is a link's syntactic occurrence in the text: the `links` row is the
relation it establishes, `_via_id` points at that node, and a frontmatter or
inline-field link has a row and no node. The kind is **closed**: no authored
data reaches a link, so every field is an engine name and a bare name here is
`filter_invalid` (§1.5).
- **Engine fields:** `_doc_id` (the **source** document), `_block_id` (the source
  block; null for a frontmatter edge), `_via_id` (null unless derived through
  another node), `_dst_id` (the destination node id: a doc id, an external node
  id or `phantom:<path>`), `_dst_path` (target doc's path, `/`-rooted; null when
  external/dangling), `_uri` (external URL; null otherwise), `_predicate`,
  `_provenance`, `_dst_kind`, `_anchor`, `_field` (the frontmatter key / inline
  field the edge was authored in; null for a link).
- **Attributes:** `_id`, `_path` (the **source** document's path). There is no
  `from_commit`: a query sees open edges only; the creating commit is history
  (`blocks_history`, `changes_since`).
- Reach-throughs (handles, not fields): `_doc.<key>` / `_doc._id` / `_doc._path`
  is the **source document**; `_dst.<key>` / `_dst._title` the **destination
  document** (absent for an external or dangling link); `_block._text` /
  `_block._type` / `_block._id` (surface 4.11) the **source block** the link was
  written in — absent for a frontmatter link (`_block == null`). `_block._id`,
  `_block._path`, `_block._doc_id` read the row's own columns; a `where` over
  `_block.<k>` pushes down as a probe by `_block_id`.
  `text()`/`semantic()` are unavailable (links carry no text/embedding).
- There is no list literal: a membership test over several values is a tuple,
  `_id in ("b_1", "b_2")`. The SQL spelling `_id in ["b_1", "b_2"]` is a parse
  error whose message ends `; a list is written as a tuple: (…)` and whose
  `data.fix` is the same call with `[…]` rewritten to `(…)` (surface 4.11).

### `revisions`
History as rows (spec/surface 4.7) — one row per stored revision of every
document of the repository, the `revisions` × `commits` join of the store;
**deleted documents' revisions are rows too** (history is history). It is what
`docs_history` lists, as a query target: `revisions { select _seq, _origin, _ts
where _path == "/x.md" order by _seq desc }` is a document's timeline, and the body
as of a revision is `docs_read { _path, at: "<rev>" }`. The kind is closed, like
`links`: every field is an engine name.
- **Engine fields:** `_rev` (= `_id`), `_seq` (1, 2, … per document — the
  revision's own sequence, not the commit's), `_doc_id`, `_commit` (the commit
  id), `_ts` (the commit's time; sorts chronologically), `_origin`
  (`observed`/`api`/`import`/`projection`), `_actor`, `_reason`, `_hash` (the
  rendered file's sha256 hex — `docs_history`'s `_hash`), `_is_current` (true for
  the document's current revision; for a deleted document its last one),
  `_archived` (true once the retention squash has moved its body into an
  archive segment).
- **Attributes:** `_id` (the revision id, `r_…`), `_path` (`revisions.path`,
  `/`-rooted: the path the revision was committed under — a document move
  re-paths the *current* revision to the new path and mints none, so the
  revisions before it keep the old path).
- **Reach-through:** `_doc.<key>` is the document's **current** row (`_doc._path`
  the current path); **absent for a deleted document**, so `revisions { _doc
  == null }` lists the revisions of deleted documents and `_doc { _title }` is
  empty for them.
- **On docs:** `_revisions` is a relation of every document (its revisions,
  oldest first): `docs { _revisions count { _origin == "api" } > 0 }`,
  `docs { select r: _revisions { _seq, _ts } where _path == "/x.md" }`;
  `_doc._revisions` from a block or link row reaches the same list.
- Default order `(_path, _id)` like every target (so the keyset cursor pages it);
  `order by _seq` for chronology. `text()`/`semantic()` are unavailable (a
  revision is bytes and a hash, not an indexed body). Revisions are never a
  write selector's root.

## 3. Scalar semantics (`@omgbase/oqx` contract)

Everything inside `where`/`select`/`order by` that isn't structural navigation is
a scalar expression evaluated by `@omgbase/oqx`'s `semantics.ts`.

### 3.1 Grammar
Comparisons (`== != < <= > >=`), identity (`is`, `is not`; §3.6), boolean
`and or not` + grouping (the canonical spelling, and what `print` writes since
0.18; `&& || !` are accepted synonyms; prefix `is x` ≡ `!!x`, `not x` ≡ `!x`),
`in`, arithmetic (`+ - * / %`), Ruby-style range literals
(`lo..hi`, `lo...hi`, `..hi`, `lo..`; §3.5), method calls (`x.contains("s")`),
free functions (`list(x)`, `size(x)`, `has(x)` + omgbase's domain functions §5),
field/intrinsic access with `.` navigation, bracket lookups (`refs(x)[0]`,
`^docs[_path == ^company]`; §3.6), the postfix required operator (`_title!`;
§3.6), and outer references (`^name`, `^^name`). Reserved words (never a bare
field name): `from where select is not and or`, `true false null`.
**[was CEL: arithmetic, ternary, and `in` without `list()` were rejected — now
arithmetic and general `in` are supported.]**

### 3.2 Equality, comparison, absence — the normative rules
- **`==` / `!=` are strict, typed, and absence-normalized.** No cross-type
  coercion (`5 == "5"` is false). `null` and a missing field are the same
  "absent" value, and two absent values are **equal**. Therefore **`absent != v`
  is true.** **[was CEL: a missing key made *every* comparison false, including
  `!=` — that "absence collapses `!=`" rule is gone.]**
- **Relational `< <= > >=`:** if either operand is absent, the result is **false**
  (never orders, never throws). Present operands compare with native ordering
  (numbers numerically, strings lexicographically).
- **Truthiness (`where <expr>`, `!x`):** JavaScript truthiness — falsy is
  `false`, `0`, `""`, `null`, `undefined`, `NaN`; everything else (including `[]`,
  `{}`, and the non-empty string `"false"`) is truthy. **[was CEL: the string
  `"false"` was falsy.]**
- **Arithmetic:** `+` concatenates when either side is a string, else numeric;
  other operators coerce via `Number()`.

### 3.3 Strings and `in`
- `contains` / `startsWith` / `endsWith` / `matches` / `size` / `lower` / `upper`
  as methods; `matches` is a real **regexp**. **All string ops are
  CASE-SENSITIVE** — use `.lower()`/`.upper()` to fold. **[was CEL: `LIKE`-based
  ops were case-insensitive and `matches` was unimplemented.]**
- **Infix regex operators** (OQX 0.22; `spec/oqx` SEMANTICS §11): pure sugar
  over `matches`, at comparison precedence, non-associative —
  `x ~ "re"` is `x.matches("re")`, `x ~* "re"` is `x.matches("re", "i")`
  (case-insensitive), `x !~ "re"` and `x !~* "re"` are their negations. Both
  sides are expressions (`path ~ dst_path` compares two fields); the pattern is
  the OQX regex baseline, unanchored unless it anchors (`path ~ "^/texts/"`).
  **Absent follows OQX, not SQL**: `absent ~ "x"` is false, so `absent !~ "x"`
  is **true** (a row without the field passes `!~`; Postgres would drop it as
  NULL). `!`/`not` bind tighter than `~`, as than `==`: `not a ~ b` is
  `(!a) ~ b`; write `a !~ b` or `not (a ~ b)`. The planner treats them as it
  treats `matches` — never pushed to SQL (no `regexp` UDF), evaluated in memory
  as a residual, and a predicate holding one declines the pushdown of its
  siblings because an invalid pattern must raise.
- `x in y`: array → typed membership (`"5" in [5]` is false); string → substring;
  object → key existence; **range → interval coverage** (§3.5).

### 3.5 Ranges
A Ruby-style range is a value, used most often as the right side of `in`:
- `lo..hi` includes both bounds; `lo...hi` excludes the high bound; `..hi` and
  `lo..` are open-ended (a missing bound is unbounded on that side).
- `x in lo..hi` is coverage: `lo <= x` (if `lo` present) and `x <= hi` / `x < hi`
  (if `hi` present), using the same ordering as `<`/`<=`. An absent `x`, or one
  that doesn't order against a bound, is not covered (never throws). So ranges
  work over numbers **and ISO-8601 date/time strings** (lexical = chronological).
- **A frontmatter value can hold a range**, but it is stored as a **plain
  string** — `window: 2026-01-01..2026-01-31` compares, projects, and displays as
  text like any string. Wrap it in **`range(s)`** to read it as an interval:
  `where "2026-02-01" in range(window)` selects docs whose window covers that
  date. `range(...)` is the explicit opt-in — a value that merely looks rangey
  (`version: "1..4"`) is never silently reinterpreted, and `version == "1..4"`
  works normally. A non-range string yields an absent range, so
  `x in range(bad)` is false. Range-vs-range containment/overlap is not yet a
  surface.
  - The store still **autopromotes** a recognized range string into cached
    bounds (`detectRange` → `val_json`; see properties-table.md) — but purely as
    an index substrate for a future pushdown of `in range(prop)`, never changing
    an answer. So the promotion is safe: meaning is set by `range(...)`, not by
    what the value happens to look like.

### 3.6 Sugar (OQX 0.17)
Every form below is shorthand for an explicit directive and **desugars in the
parser** (the AST, `print`, the planner and the optimizer see the explicit form):

| Written | Means |
| --- | --- |
| `_nodes { _kind == "md:task" }` | `_nodes collect { where _kind == "md:task" }` — a receiver block without a consumer is `collect`; a block whose *leading* expression is syntactically a predicate (a comparison, `in`, `&&`/`||`, a prefix `!`/`is`/`not`, an infix `is`, a call, a literal, a binding, a parenthesized expression, a consumer test, a bracket chain or `x!` — anything but a bare name, a dotted path or a `^`-lift) is `where`-first. `_nodes { _name }` still projects; `_nodes { is checked }` is the bare-field filter; `{ _name where _kind == "md:task" }` keeps the keyword. Wherever a value stands (spec/oqx 0.20), call arguments included (`size(_children { is checked })`), and after any `follow` destination: `follow _children { depth 2 }` and `follow refs(before) { depth 2 }` are that destination's block. `x distinct { … }` is `x collect distinct { … }`. |
| `(a, b)` | a tuple (spec/oqx 0.20): two or more expressions, concatenated one level flat — a value (`size((tags, aliases))`, `"x" in (tags, aliases)`) and a receiver (`(mom, dad) { _title }`, `follow (before, after) { depth 2 }`); one parenthesized expression is grouping. |
| `refs(x)[0]`, `refs(x)[${i}]` | `refs(x) first { offset 0 }` — positional (an integer literal or a binding; out of range ⇒ absent); `refs(x)[0]._title` navigates the row |
| `^docs[_path == ^company]` | `^docs first { where _path == ^company }` — the first match or absent |
| `^docs[_path == ^company]!` | `^docs single { where _path == ^company }!` — exactly one match; zero or many is `filter_invalid` |
| `_title!` | required: `_title`, or `filter_invalid` naming the expression (`` `_title!` is absent on "d_…" ``). Never a filter, never a coercion (`0!`, `""!` are values); tightest precedence (`refs(c)[0]!._name` vs `refs(c)[0]._name!`). `docs { select _id!, status }` insists on identity before a write. |
| `is x`, `not x` | `!!x`, `!x` (truthiness) |
| `x is y`, `x is not y` | identity (`$key`, spec/oqx §16): a store row's id, a plain value structurally — so `$it is ^$it` compares rows (which `==` leaves unspecified); `owner is null` is absent; for scalars `is` ≡ `==`. Comparison precedence, no chaining. Never pushed down (residual). |
| `a and b`, `a or b` | the connectives — exactly `a && b`, `a || b` (precedence, short-circuit, value: `_title or _path` coalesces); the words are canonical |
| `boss: ^docs[_path == ^manager], bossName: boss._title` | a `select` item may use the items to its left (inlined like a `where` alias; a reference to an item to its right is a parse error) |

The top-level body is a block like any other, so `docs { type == "x" }` is the
`where`-first filter; in the clause form `type == "x" from docs` stays the parse
error it was (`where` would precede `from`). There is no `expand`/`unnest` and no
automatic dereference of a path-valued field: the body-level `from` chain
flat-maps (`docs { from _nodes … }`) and `refs(x)[0]._title` is the
dereference.

### 3.4 Correlation (`^`) and lifts
- **Bare names are local.** A bare identifier resolves against the **current row
  only**; an absent field is absent — it never falls through to an enclosing row
  or to the repository root, so adding a same-named field to an inner row cannot
  change what an outer reference means. Reach outward explicitly: `^name` for
  the enclosing row, `^docs` / `^nodes` / … for a root scan — the repository is
  the root row (spec/oqx 0.18), one caret per enclosing block, or the absolute
  `0^docs` from any depth. A bare target name inside a block is `filter_invalid`
  ("did you mean `^docs`"), never an empty read. **[was (surface < 2.0):
  `$repo.<target>` reached the root from any scope — refused now, with the
  replacement named; (oqx < 0.7): an absent local name climbed enclosing scopes,
  and a bare `repo` reached the root that way.]**
- **`^name` reads a name `N` scopes outward** (`^` = one scope, `^^` = two) — it
  resolves against the enclosing **row's fields/attributes/lifts**, not the outer
  query's select aliases. To reference the outer row's path write `^_path` (not a
  `me: _path` alias). **[was CEL/omgbase: `^name` read a bound select value; that
  binding indirection is gone — read the field directly.]**
- **`^name:` in a select** *lifts* the value `N` scopes out (flatten-append),
  binding it into the enclosing scope while the collect filters (§ lifts).

## 4. `list()` / `size()` / `has()` / `entries()`
`list(f)` coerces scalar-or-list to an array (absent → `[]`); legal anywhere,
canonically inside `in`/`size`. `size(x)` = string/array length or object key
count. `has(f)` = the field is present (not null). A list-authored key is not
scalar-comparable (`tags == "x"` is false); use `"x" in list(tags)`.

## 5. Domain functions (omgbase extensions)
omgbase registers these on the `DataContext` (they are not part of the generic
`@omgbase/oqx` builtins); they compose like any predicate, including inside
nested/correlated scopes:
- `text("terms")` — FTS5 pruning predicate (docs match via their blocks; nodes via
  the node index). Prunes; ranking is separate (`order by`).
- `semantic("phrase")` — embedding cosine **score** (docs/blocks), for a threshold
  (`semantic("x") > 0.6`) or projection; needs an embedding provider.
- **blocks-target structural functions:** `under(id_or_heading)`,
  `under_heading("s")` (case-insensitive), `within(doc|path|glob)`,
  `under_kind(type[, name])`, `yaml_path("a.b")`, `json_pointer("#/a/b")`,
  `has_edge(pred[, target])`, `has_anchor()`, `parent_type()`, `child_count()`.
- **`refs(x)`** (surface 1.5) — the live documents named by the **document
  references** a property holds: `x` is a string, a list, or absent; each
  string element that is a path in either form (`/timeline/kickoff.md`,
  `timeline/kickoff.md`) or a doc id (`d_…`) resolves to that document's row
  (an id is tried when no path matches); anything that resolves to
  nothing is dropped — no phantom, no error. Order preserved, duplicates kept.
  Index-backed (one lookup per element, never a scan). It yields docs rows, so
  it works wherever rows do: `follow refs(before), refs(after)` walks a
  timeline both ways; `select prior: refs(before) { _path }` projects
  the referenced documents; `where refs(see_also) exists { type == "x" }`
  filters on them; `refs("/index.md") { … }` is a source. The reverse direction
  needs no function: `_path` is already the reference form, so
  `^docs { ^_path in list(after) }` is "the documents whose
  `after` names me".
- **A hit is a store row.** Every top-level row of a `collect`/`first`/`single`
  query must be a document, block, node or link; `follow before` over a list of
  paths reaches the list's *strings* and fails loud — `filter_invalid: a hit
  must be a document, block, node or link row — the query reached a string
  ("/timeline/kickoff.md"); to follow document references held in a property
  use refs(<field>)`. Write `follow refs(before)`. A `values` projection
  returns no hits and is exempt; nested blocks are unaffected (their rows are
  values, see §7).

### 5.1 Dates and durations (surface 4.8)
The Dataview-parity set, as host functions (spec/surface §1.3 is normative).
**A date is an ISO-8601 string** — `YYYY-MM-DD` or
`YYYY-MM-DDThh:mm:ss[.fff](Z|±hh:mm)`, what `_updated_at`/`_ts` already are and
what `<`/`>` already order chronologically — and **a duration is a number of
seconds**. There are no new value kinds, and arithmetic between them is
**methods, never `+`/`-`**: `+` with a string operand concatenates
(`due + 86400` is `"2026-01-0586400"`).

- `date(x)` — a **named point** against the host clock in **UTC**: `"now"`
  (the instant with milliseconds, as commits are stamped), `"today"`,
  `"yesterday"`, `"tomorrow"`, `"sow"`/`"eow"` (Monday/Sunday of this week),
  `"som"`/`"eom"`, `"soy"`/`"eoy"` (date-only); otherwise an ISO string returned
  **canonical** (a date-only input stays date-only; seconds always present,
  a fraction kept as three digits, `+00:00` or no offset → `Z`, other offsets
  kept as written). Anything else — `15/10/2026`, month 13, a number, absent
  — is absent.
- `dur(x)` — a number is seconds; a string is Dataview's grammar (`"1h30m"`,
  `"1 hour 30 minutes"`, `"2 days, 3 hours"`, units `y|yr|yrs|year|years`,
  `mo|mos|month|months`, `w|wk|wks|week|weeks`, `d|day|days`,
  `h|hr|hrs|hour|hours`, `m|min|mins|minute|minutes`,
  `s|sec|secs|second|seconds`, case-insensitive) or an ISO duration
  (`"PT1H30M"`, `"P2W"`) → seconds, with **a year = 365 days and a month =
  30 days**. Malformed → absent.
- On a date string: `d.plus(x)` / `d.minus(x)` — `x` a number of seconds, or
  a duration *string* whose months/years are **calendar-aware** (the month
  field moves, the day clamps: `date("2026-01-31").plus("1 month")` is
  `2026-02-28`; `.plus(dur("1 month"))` is 30 fixed days). A date-only receiver
  shifted by whole days stays date-only, else becomes a UTC datetime; a
  datetime keeps its offset. `a.until(b)` — signed seconds from `a` to `b`.
  `d.year()` `d.month()` `d.day()` `d.weekday()` (**1 = Monday … 7 = Sunday**)
  `d.hour()` `d.minute()` `d.second()` in the written offset; `d.date()` the
  date part; `d.format(p)` with tokens `yyyy MM dd HH mm ss MMM EEE`, every
  other character literal (`"EEE dd MMM yyyy"` → `Thu 15 Oct 2026`).
- On a number: `n.dur_text()` → `"1h 30m"` / `"2d 3h"` / `"45s"` / `"0s"`;
  `n.dur_iso()` → `"PT1H30M"` / `"PT0S"`.
- **Total.** A receiver or argument of the wrong kind is absent, never an
  error, so `where date(due) < date("today").minus(dur("30 days"))` over
  documents with and without `due` filters quietly. The one error is a wrong
  arity (`filter_invalid`).
- **Folding and pushdown.** `date("…")`, `dur("…")` and a date method over
  literals are folded to the literal before planning, so
  `where _updated_at < date("today")` is a plain string comparison the planner
  pushes down, and a named point is read once per query. Anything over a
  field (`date(when) < …`) runs in memory.
- **The prefix trap.** `2026-09-27T00:00:00.000Z` is *not* `< "2026-09-27"`
  (a longer string with an equal prefix sorts after it): "updated today" is
  `_updated_at.date() == date("today")`; "before today" over a datetime is
  `_updated_at < date("today")` only when the field is date-only — use
  `date("tomorrow")` or `.date()`.

## 6. `follow`, the edge graph, and `distinct`
- **Traversal:** `follow <dest>, …` recurses over one or more type-preserving
  destinations; a plain destination is a relation of the current row
  (a block's `_children`, a section node's `_children`/`_subsections`) or a destination
  block over the link rows — the citation graph is `follow _out_links { from
  _dst }` (outgoing) / `follow _in_links { from _doc }` (backlinks),
  the knobs as clauses of the block (`… { from _dst depth 2 }`, spec/oqx
  0.20); an external or dangling link has no `_dst` and contributes no successor.
  Per-path: a node reached by N paths yields N occurrences; `follow distinct`
  keeps one per identity (`$key` — a store row's id; a block may project `$key:
  <expr>` to rekey the rows it yields). Each occurrence carries `$depth` (seed =
  1), `$stop` (`interior|leaf|frontier|depth|cycle`) with `$leaf`/`$frontier`
  sugar, `$ordinal` (deterministic 1..N over the walk) and `$key`. A destination
  block's `where` shapes participating successors, its `frontier <pred>` cuts
  (occurrences this destination reached), its `depth <n>` bounds the walk
  through it (1..8). A revisited identity on the path is admitted once as `$stop
  == "cycle"` and never re-expanded. Recursion intrinsics are result metadata
  (valid in `select`/`order by` and the top-level post-walk `where`), not
  metadata of the candidate rows a destination block's `where` reads.
- **Destination lists** (`spec/oqx` 0.14): `follow _out_links { from _dst },
  _in_links { from _doc }` walks the union of the destinations — within one step the successors are concatenated
  in source order and deduplicated by identity, so a document both cited by and
  citing the current row is stepped into once; the destination that reached a
  row first governs it (its `frontier`/`depth`). A tuple is one destination over
  the union of its elements: `follow (before, after) { depth 2 }`.
- **Destination blocks:** a destination may be a select-position block
  re-evaluated per frontier row — `follow ^docs { _out_links
  exists { _dst_path == ^^_path } }` computes backlinks as a block over
  the root's documents (the same rows as `follow _in_links { from _doc }`).
  Inside the block `^` is the frontier row (the
  destination is read in that row's scope, so `^docs` there is the root's
  documents); `first`/`single` yield at
  most one successor; `exists`/`none`/`count` are not destinations. Since
  spec/oqx 0.20 **a brace after any destination opens that destination's
  block** with the implicit `collect` (there is no options block any more):
  `follow _children { depth 2 }`, `follow refs(before), ^docs { ^_path in
  list(after) }` — the latter walks `before` references forward and, backward,
  every document whose `after` names the frontier row. Two clauses sit after a
  destination block's `where`: `frontier <pred>` and `depth <n>` (`follow
  _out_links { from _dst where layer == "canon" depth 2 }`); `depth` is a
  destination block's alone. **The body that carries the `follow` may write
  `frontier <pred>` too**, after its `where` and before `follow`, and it applies
  to the **seeds** — read in the seed's scope like the body's `where`: `docs {
  type == "process" frontier !verified follow _out_links { from _dst } }`
  keeps the unverified process in the result (`$stop == "frontier"`) without
  expanding it, while the destination's `frontier` governs the occurrences it
  reaches; neither applies to the other's rows. Without a `follow`, a body-level
  `frontier` is a parse error.
  The former `by <expr>` option is gone: identity is `$key` (a store row's id),
  and a block may project `$key: <expr>` to rekey the rows it yields (`follow
  _out_links { $key: type from _dst }`; in a destination block `$key:` is
  not a column). A bare `follow ^docs` (no brace, no consumer) is a parse error
  naming both block spellings.
- **Correlated successor `where`:** inside a destination block's `where`, a bare
  name is the candidate's own property, `^name` is the **frontier row** being
  expanded, and `^^name` the walk's enclosing scope — `follow _out_links { from
  _dst where _out_links exists { _dst_path == ^^_path } }` keeps
  only mutual citations
  (before 0.14 `^` skipped the frontier row and such predicates matched nothing).
- **Links as rows:** `links { … }`, or a doc's `_out_links`/`_in_links`.
  A link row reaches both ends: `_doc` is its source document and `_dst` (3.0;
  `_`-prefixed since 5.0) its destination document — present when `_dst_kind ==
  "document"` and the document exists, absent for an external or block
  destination and for a dangling (phantom) target; `_dst._title`, `_dst { _title }`
  (one record — `_dst` is one object, so the block is a record or, when `_dst` is
  absent, absent; spec/oqx 0.20 §3), `where _out_links exists { _dst.layer
  == "draft" }`; `_dst.<k>` pushes down like `_doc.<k>`.
- **`distinct`** on any consumer dedups the rows it reduces by their **projected
  value**: `select distinct type`, `_nodes distinct { select _kind }`,
  `_nodes count distinct { select _kind } == 3`. Empty projection → dedup by
  identity.

## 7. `order by`, `select`, pagination
- **`order by <expr> [asc|desc], …`:** orders by attributes, bare fields,
  `_doc.<key>`, or a `semantic(…)` score. **Absent values sort last** (ascending).
  Ties break by `(_path, _id)` for a stable keyset cursor; a custom `order by`
  disables the cursor (you get the top `limit` with `truncated`). **[was CEL/
  SQLite: NULLs sorted first ascending.]**
- **`select`:** default hit is `{ _id, _path }`; add `name: <expr>` fields and
  nested `collect { … }` / `first { … }` / `single { … }`. `select _id, _path` is
  simply the envelope (the attribute collapses onto its own key — never a
  duplicate column); any **other** projection whose output key would be `_id` or
  `_path` — `select _path: layer`, `select _id: _doc_id` on blocks — is
  `filter_invalid` ("projection `_path` collides with the hit envelope — alias
  it (`p: layer`)"), so the envelope is never overwritten. An authored `path:`
  or `id:` key projects under its bare name and collides with nothing (5.0). An item that is not a
  plain navigation (a call, arithmetic) needs an alias — `n: size(tags)` —
  unless the projection is in `values` mode (which returns no hits, so the
  envelope rule does not apply there).
  **Rows as values** (surface 1.2; keys renamed in 3.0): wherever a store row
  surfaces as a *value* rather than a hit — a nested `collect { }` / `first { }`
  / `single { }` with an **empty** projection ("the row itself", oqx §12), a
  `values` projection of `$it`, a field bound to a row — it is rendered as
  `{ _id, _path }` (the row's id and its document's path), never the raw store
  row (before 1.2 the columns leaked, `attrs` as a JSON string and the `__path`
  join column included). `tasks: _nodes { _kind == "md:task" }` is
  therefore a list of `{ _id, _path }` node refs — the same shape a hit leads
  with.
- **`values`** (oqx ≥ 0.8): `select <expr> values` — exactly **one** item — makes
  each row's result the bare value rather than a `{ name: value }` record. At the
  top level the result carries `values: […]` in place of `hits` (empty), paged
  and `distinct`-deduped exactly like hits (`docs { select distinct type values }`
  → the type strings). Inside a `collect`/`first`/`single` block it yields a plain
  array / scalar (`tags: tags { $it values }`, `latest: _nodes first
  { _value values order by … }`). The runner implements the top-level form by
  projecting the single item under a reserved key alongside the injected
  `_id`/`_path`, then peeling the values off the final page — so the keyset
  cursor still works (`values` carries no hits, so the envelope rule does not
  touch it).
- **`limit N` / `offset N`** (oqx ≥ 0.9): bound the row set **after** `where` /
  `order by` / `distinct` and **before** the consumer reduces it, so they mean
  the same thing under every consumer (`_nodes count { … limit 5 } <= 5`,
  `_nodes exists { offset 1 }` = at least two, `first { … offset 1 }` = the
  second). At the top level they define the result **set**; the tool's
  `limit`/`cursor` options then page *within* it (so `order by era desc limit 3`
  with a page `limit` of 2 returns two hits, `truncated: true`, and the third on
  the next page). The runner applies a top-level bound after its own
  `distinct` dedup, so `select distinct type limit 3` is three distinct types.
  Top-level bounds must be integer literals; inside a block `^n` reads the
  enclosing row.
- **`cursor`:** opaque, keyset on `(_path, _id)`, valid for the same query only.

## 7b. Grouping and aggregates (oqx 0.24)

`group by <key>, …` after `where`/`follow` and before `order by` turns the rows
a body yields into **one row per distinct key tuple** — the Dataview `GROUP BY`
and the end of "a census needs a full-repo row dump". A key is a bare field or
attribute (`layer`, `_type` or `_path` on blocks, `_kind` on nodes), a dotted
navigation named by its last segment (`_doc.layer` → `layer`), or an expression
with an alias (`decade: (era - era % 10) / 10`); absent and `null` group
together; groups come in first-appearance order (spec/oqx SEMANTICS §24).

After the grouping the body reads the **group**, not a row: a `select` item,
`having` and `order by` may name a key, an **aggregate** over the group's rows,
or `rows` — the group's rows as a collection, usable as a receiver
(`rows { select _title }`, `rows count { not checked }`,
`rows first { _title values order by _updated_at desc }`). Any other name
is a parse error naming it (`` `_title` is not a group key or aggregate — … reference
it through rows ``). The aggregates — reserved free-function names, legal only in a
grouped body's select/having/order by — are `count()` (rows), `count(e)` /
`count(distinct e)` (present / distinct present values), `sum(e)` (`0` of
none; a non-number is an error), `avg(e)`, `min(e)`, `max(e)` (absent of none;
OQX ordering), `collect(e)` / `collect(distinct e)` (the present values in
group order), `first(e)` / `last(e)` (first/last present value), `any(p)` /
`all(p)` (truthiness over the rows). `having <pred>` filters the groups (it may
name a `select` alias: `having n > 1`); `order by count() desc` sorts them
(aliases are not substituted in `order by`, as ever); `limit`/`offset` bound
them; `distinct` with `group by` is an error (redundant). Without a `select`
the projection is the keys plus `count`. `count { … }` is also a **value** now
(`n: _nodes count { _kind == "md:task" }`), inside or outside a group.

```
docs { group by layer }                                               → [{ layer: "canon", count: 13 }, …]
docs { select layer, n: count(), titles: collect(_title) group by layer order by count() desc }
blocks {
  select _path, open: rows count { not checked }, done: rows count { where checked }
  where _type == "task" group by _path having count() > 0 order by _path
}
docs { select type, n: count() where layer == "working" group by type having n > 1 }
docs count { group by layer }                                         → the number of layers
```

**A grouped row is not a store row** (spec/oqx SEMANTICS §24; spec/surface
§1.4): the runner injects no `_id`/`_path` envelope — a hit is the group's
projection exactly as written (`{ layer, n, titles }`, what `bare` yields for a
row query; `bare: true` is accepted and changes nothing), the envelope-collision
rule does not apply, rows that surface as values (`rows { }` with no
projection) still render as `{ _id, _path }` references, `values` returns the bare
per-group values, and paging is by position — the query's `limit`/`offset`
define the set, the tool's `limit` takes the first page, `truncated` says
whether more groups follow, and the cursor is always `null` (as under a custom
`order by`). The planner declines a grouped query whole (it runs in memory; SQL
`GROUP BY` pushdown is a later round), and the unknown-names check judges a
key's expression on the rows, an aggregate's argument on the rows, and the
names inside a `rows …{ }` block on the grouped rows' kind (`rows count { where
chekced }` is still the "not a field of blocks" hint).

## 7c. Flatten (oqx 0.25)

`flatten <expr> [{ … }] [as <name>]` — after `where`/`follow`, before `group
by`; one or more — splits one value into rows: the Dataview `FLATTEN`. Every
hit is still the **parent row** with `<name>` bound beside its fields at the
same depth, so the `_id`/`_path` envelope is injected as usual and **repeats per
element** (Dataview's `TABLE … FLATTEN`): an array → one row per element (an
empty list yields none), a missing field → one row with the name absent (never
dropped), an object or a scalar → one row with the value (spec/oqx SEMANTICS
§25). A plain navigation names itself (`flatten tags` rebinds `tags` to each
element; `flatten tags as t` keeps the list readable); anything else needs
`as`. The block is the ordinary receiver block over the elements (`where`, a
projection, `order by`, `limit`, `distinct`), applied first — a block that
filters every element away yields no row for that parent. Later clauses read
the name: a later `flatten` (`flatten jobs as j flatten j.tags as t`), `group
by` (a bound name is a key), `having`, the projection, `order by`; `where` runs
before the fan-out.

```
docs { select _path, tags where type == "process" flatten tags order by _path, tags }
docs { select _path, t: b._text flatten _blocks { _type == "task" and not checked } as b }
docs { select tags, n: count() flatten tags group by tags order by count() desc }
docs { select _path, e: j.employer, t flatten jobs as j flatten j.tags as t }
```

**Uniqueness is what moves.** A flattened hit's identity is the pair (row,
element) — `$key` is `[<the row's id>, <the element's identity>]` — so
`(_path, _id)` no longer names one hit and the keyset cursor cannot land inside a
document's elements: a flattened query **pages by position** (the query's
`limit`/`offset` define the set, the tool's `limit` takes the first page,
`truncated` says whether more rows follow, the cursor is always `null`, as under
a custom `order by` or a `group by`; a keyset extended with the flatten ordinal
is a later round). `flatten … as _id` / `as _path` is refused — the bound name
would shadow the envelope's own reads. The planner declines a flattened query
whole (it runs in memory); the unknown-names check judges the flatten
expression on the rows, the names inside a block against the element kind
(`flatten _blocks { where typ == … }` is the "not a field of blocks" hint), and
never the bound name. A write selector with `flatten` fans its effects out per
flattened row — the hit is the parent row, templates read the bound name
(`-> tag`), and `expect.max` bounds the flattened count (spec/mutate §11.8).

## 8. Execution model
- OQX parses to the `@omgbase/oqx` AST and runs on the in-memory engine over a
  store-backed `DataContext` (`context.ts`), which resolves fields/attributes/
  relations and the domain functions against SQLite.
- A **tier-3 pushdown planner** (`planner.ts`) translates a query's pushable
  top-level `where` conjuncts into one guarded SQL `SELECT` (via
  `sql/translate.ts`), reducing the scanned row set; everything it declines is a
  **residual** finished in-memory. The translator is **semantics-faithful** — e.g.
  `==`/`!=` → SQLite `IS`/`IS NOT` (null-safe), string ops → case-sensitive
  `substr`/`instr` (never `LIKE`). **[was CEL: the whole query compiled to a
  single SQL statement; now it is pushdown + residual.]** Invisibility is kept
  by declining (spec/surface §1, the 1.1 patch): a comparison is pushed only
  when its operand kinds (text, int, num, bool, null, json = an `attrs` read,
  prop = a document property) are provably compared the same way — plainly
  (`IS`/`IS NOT`, or the bare relational operator) when one side is text, or
  one side is null and the other is not a property, or both are numeric;
  `<`/`<=`/`>`/`>=` plainly only when both are text or both numeric
  (`sql/translate.ts`, `comparable`). A bool or num literal/binding against a
  json or prop read is a **typed push** (spec/surface §1, the 1.2 patch;
  `typedComparison`): the stored type is tested in SQL before the value and the
  whole test is wrapped `(…) IS 1` (`==` and the relational ops) or `(…) IS NOT
  1` (`!=`, the negated equality test), so an absent or differently typed value
  is unequal and never ordered, as in memory —
  `checked == true` → `(json_type(b.attrs, '$.checked') = 'true') IS 1` (no
  bind; `'false'` for false); `level >= 2` → `(json_type(b.attrs, '$.level')
  IN ('integer', 'real') AND json_extract(b.attrs, '$.level') >= ?) IS 1`;
  `verified == true` → `(SELECT p.type = 'bool' AND p.val_bool = ? FROM
  properties p WHERE …single scalar row… LIMIT 1) IS 1` (bound 1/0); `era !=
  800` → `(SELECT p.type = 'number' AND p.val_num = ? … LIMIT 1) IS NOT 1`. A
  constant on the left flips a relational op (`800 < era` ⇔ `era > 800`).
  Everything else — `$ordinal == checked`, `true == 1`, `tags != null`,
  `$ordinal < "3"`, `level < "x"`, `era == stages` — stays residual. A
  `_`-prefixed name — an engine attribute, a relation, a reach-through, a source
  handle or the `_attrs` bag (`_nodes`, `_blocks`, `_out_links`, `_children`,
  `_section`, `_doc`, `_dst`, `_frontmatter`, `_attrs`, …) — is never read as a
  property (5.0: the prefix declares it; before 5.0 a `NON_PROPERTY_NAMES` list did). When a residual conjunct
  could raise an OQX eval error (any function/method call, a `single` block, a
  `^` name, a bare reserved docs basename), the whole query runs unplanned so
  an emptying pushed conjunct cannot hide the error (`planner.ts`,
  `residualMayRaise`).
- **Nested blocks over a root scan are answered from SQLite indexes**
  (`oqx-js/store-index.ts`, Rust `omgbase-surface::store_index`). A root scan
  (`^docs`, `^links`, …, or a bare `docs` at the root scope) is handed
  to the engine as a *lazy* handle — one per target per run — that runs its
  `SELECT` only when something reads it whole (a `Proxy` over an array in
  TypeScript; in Rust a marker the engine resolves through
  `DataContext::materialize` before any operand, argument, key or projected
  item observes it — `spec/surface` `lazy-root-*` pins that both engines see
  the same array). The `@omgbase/oqx` optimizer
  turns a block's top-level `local == outer` conjunct (a `^` reference OR a
  literal: `where customer == ^_path`, `where type == "order"`, `where _dst_id ==
  ^_id`) into a probe and asks the context for an index first
  (`DataContext.indexFor` → `RowIndex.lookupRows`); the store context answers
  with ONE prepared, index-driven statement per probe under the same live-row
  and repo guards as the planner (`sql/scan.ts`), yielding rows built exactly as
  the scan builds them — so the handle is never materialized and every
  attribute/relation works downstream. Indexed paths: docs `_id` (PK), `_path`
  (`UNIQUE (repo_id, path)`), `_title` (the computed row) and any frontmatter/inline **property
  key** (`idx_props_key_text` / `idx_props_key_num`, under the scalar-in-scope
  rule and **typed**: a string probe matches only a `type = 'string'` row by
  `val_text`, a number only `type = 'number'` by `val_num`, a boolean only
  `type = 'bool'`, so `1` never meets `"1"`); blocks `_id`, `_doc_id`, `_type`,
  `_path`; nodes `_id`, `_doc_id`, `_kind`, `_name`, `_path`; links `_id`,
  `_doc_id`, `_dst_id`, `_path`, `_dst_path`. A `_path` probe on a joined
  target drives from `docs (repo_id, path)` into the target's `doc_id` index. An
  **absent** probe (`key == null`, `_name == ^missing`) is an anti-join SQLite has
  no index for: the handle is read once and filtered in memory (same answer).
  Not indexed — the engine's own hash index over the handle, built once per
  run — `_format`, `_raw`, `_hash`, `_updated_at`, `_tags`, edge `_predicate` /
  `_field`, multi-segment paths (`meta.id`), the source handles. With several
  equalities the varying one is probed and the rest stay residual conjuncts in
  their original order. Nothing here changes a result: `corpus/oqx/
  conformance.test.ts` runs the correlated shapes planned vs. in-memory, and
  `oqx-js/store-index.test.ts` proves the root scan statement never runs and
  that the probe statement is prepared once. Measured: 500 raw probes over 5k
  documents ≈ 9 ms of SQLite time; the whole planned query ≈ 160–180 ms wall
  time in the test (engine overhead dominates), vs. a full scan per outer row.
  Probes are per outer row (one statement each, ~20 µs); batching them into
  `IN (…)` lists was measured and is not worth its complexity.
- **Correctness is guaranteed** by the residual fallback and verified by the
  differential conformance suite (`corpus/oqx/conformance.test.ts`): every query
  returns identical results planned vs. pure in-memory.
- Evaluation is deterministic (no clock/random functions).
- Errors surface as `filter_invalid` (the library's `OqxError` is normalized).

## 8b. Reflection: the AST
A parsed query is a first-class tree shared by both engines
(`spec/oqx/AST.md`, language 0.16, extended in 0.17): every node carries `kind` and a code-point
`span`, optionals are materialized, and `where` keeps its surface form (a
`select` alias stays an identifier; `resolveAliases` substitutes it before
evaluation — omgbase's runner does this once, before it injects `_id`/`_path`
and renames a `values` item). `@omgbase/oqx` exports `visit`/`transform` (one
child-key table drives both), `print`/`printTemplate` (canonical source, with
the round-trip law both spec runners enforce), `toJSON` (`{ "oqx": "0.19",
"kind": "query", … }`) and `build.*`; the Rust crate mirrors them (`walk`,
`print`, `build`, serde under `json`). omgbase uses them where it used to
hand-roll walks: the runner's row-function rewrite is a `transform` (a bare
`text("…")` becomes `$it.text("…")`, a method call on the current row — `$it`
is the language's own name for the scope's row, `spec/oqx` SEMANTICS §2; omgbase
adds no receiver token of its own), the `semantic("…")` phrase scan a
`visit`, and the `graph` macro assembles its
`follow` walk with builders and `print`s it (the root ids are literals in the
tree, never spliced text). A tool that wants to show which relationships a
query references reads the tree the same way.

## 9. Not part of the query surface
The `query` tool takes only an OQX string + `limit`/`cursor`. There is no flat
`{from, filter, …}` envelope, no `include_projected`/`resolution`, and no
projected-query fence (ADR-011, deferred).

## 10. Canonical examples
| Intent | OQX |
|---|---|
| Working-layer docs | `docs { layer == "working" }` |
| Guides, recently touched | `docs { _path.startsWith("/guides/") and _updated_at >= "2026-08-01" }` |
| Docs tagged pricing (authored, scalar or list) | `docs { "pricing" in list(tags) }` |
| Docs tagged pricing in frontmatter or by a body `#pricing` | `docs { "pricing" in _tags }` |
| Case-insensitive title match | `docs { _title.lower().contains("aurora") }` |
| Distinct doc types | `docs { select distinct type }` |
| Distinct doc types as bare strings | `docs { select distinct type values }` |
| Docs with no open task (every task done) | `docs { _nodes none { _kind == "md:task" and not checked } }` |
| A doc's frontmatter as key/value rows | `docs { select fm: entries(_frontmatter) { k: $key, v: $it } where _path == "/x.md" }` |
| Docs whose frontmatter has any numeric key over 1600 | `docs { select _path where entries(_frontmatter) exists { $it > 1600 } }` |
| An authored `path:`/`title:` key beside the engine's | `docs { select p: path, t: title, _title where has(path) }` |
| Two most recent practitioners | `docs { type == "practitioner" order by era desc limit 2 }` |
| Each doc's first section heading | `docs { select h: _nodes first { _name values where _kind == "md:section" order by first_ordinal } }` |
| Each substance's tags minus one | `docs { select tags: tags { $it values where $it != "substance" } where type == "substance" }` |
| Docs with ≥2 distinct link predicates | `docs { _out_links count distinct { select _predicate } >= 2 }` |
| Unchecked tasks under a heading (working docs) | `blocks { _type == "task" and not checked and under_heading("Launch") and _doc.layer == "working" }` |
| Blocks about a concept (semantic top-K) | `blocks { order by semantic("identity preservation across edits") desc }` |
| Everything a note transitively cites | `docs { _path == "/index.md" follow _out_links { from _dst } }` |
| The documents a note links to / that link to it | `docs { select out: _out_links distinct { from _dst }, in: _in_links distinct { from _doc } where _path == "/index.md" }` |
| Links into drafts, with the target's title | `links { select t: _dst._title where _dst.layer == "draft" }` |
| The documents whose `after` names this one | `docs { select next: ^docs { _path where ^_path in list(after) } where _path == "/timeline/kickoff.md" }` |
| Every `depends_on` link, both endpoints | `links { select _doc_id, _dst_path where _predicate == "depends_on" }` |
