# The omgbase surface specification

The surface is what a client sees: the OQX **query binding** that exposes the
store's docs, blocks, nodes and edges to the `@omgbase/oqx` engine, the
**read** operations that hydrate documents and blocks, the **history**
reads, and the **MCP tool catalog** through which agents call all of it (the
`omg` CLI is a second rendering of the same catalog — `docs/surface-map.md`).
Every component beneath it has its own spec; this directory specifies the
layer that turns those components into one addressable engine, so a second
implementation serves the same tools with the same results. It is owned by
neither implementation.

| Implementation | Where | Role |
| --- | --- | --- |
| `@omgbase/core` (TypeScript, npm) | `packages/core/src/oqx-js/{context,run,planner}.ts`, `core/read/{document,reader,outline,nodes,refs}.ts`, `core/cursor.ts`, `graph/history.ts`, `mcp/{server,errors,graph}.ts` | **Reference.** |
| `omgbase` (Rust binary + `omgbase-surface` crate, crates.io) | `crates/omgbase-surface`, `crates/omgbase` | Conformance-first port: the binding over `omgbase-store`, the reads, the tool catalog served over MCP stdio, the CLI. |

The spec is two artifacts, versioned together by `VERSION`: this `README.md`
and `cases/*.json`. **When prose and fixtures disagree, the fixtures win**,
and the prose gets fixed. Rationale: `docs/query-language.md`,
`docs/mcp-api.md`, `docs/surface-map.md`, `docs/graph-and-query.md` §3.

## Versioning

`VERSION` is `<major>.<minor>`; the crates track it. A field, relation,
intrinsic, tool or result key added bumps the minor; one removed or changed
in meaning bumps the major. The OQX *language* is `spec/oqx`'s; this spec
only binds it.

## The rule for changing the surface

**Fixture first, TypeScript (reference) second, Rust third.** §9 records the
reference oddities surfaced and the decisions taken.

## 1. The query binding

OQX (`spec/oqx`) runs on the in-memory engine over a **data context** that
resolves roots, fields, relations and functions against the store. A
pushdown planner may pre-filter in SQL; it must be invisible (planned ==
in-memory, the reference proves it by a differential suite), so this spec
describes the in-memory semantics only.

**Paths (2.0).** omgbase has two path forms. Storage — `docs.path`, the
filesystem adapters, every store/sync spec — uses git's repo-relative form
(`projects/oqx.md`); a reference an author writes — a Markdown link, a
wikilink, a frontmatter relation — is root-absolute (`/projects/oqx.md`, the
graph layer resolves it). **The surface speaks the reference form**: every
path a query, a tool or the CLI RETURNS is `/`-rooted — `$path` and
`$dst_path` on every target, the `path` of every hit and of a row rendered as
a value (§1.4), `docs_list`/`docs_tree` rows and the tree's `prefix` (`/` for
the root), `docs_read`/`docs_read_at`/`docs_get_many`/`read_ref`, every
history, link-health, search, document-operation, `apply`, `observe` and
`changes_since` path (the digest's `revisions`, deletions and moves, the
`summary` included) — and every path they ACCEPT tolerates both forms: a
missing leading `/` is added, an extra one is stripped (`docs_read` of
`/a.md`, `a.md` or `//a.md` is one document; a `path_glob`, a `docs_tree`
prefix, `roots`, `docs[]`, `refs(x)`, `within(…)` likewise). In a query, a
**string literal** compared with `$path`/`$dst_path` by `==` or `!=`, or
passed to their `.startsWith(…)`, is rooted before evaluation, so `$path ==
"a.md"` and `$path == "/a.md"` both match and `$path.startsWith("dir/")`
keeps working; nothing else is rewritten — a property's value is the
author's (`where customer == ^$path` compares the authored reference
directly, `where ^$path in list(after)` is the reverse of `refs(after)`), a
regex (`matches("^/texts/")`), `contains`, `endsWith` and a binding read the
string as it is. Storage is unchanged: `docs.path` stays repo-relative, no
migration, and the pushed SQL and the store-index probes de-root the literal
(or root the column) so planned and in-memory agree (`query-docs::path-*`,
`query-edges::dst-path-*`, `query-refs::reverse-reference-by-path-membership`,
`reads::alchemy`).

Both implementations run the same tier-3 planner (the pushable top-level
`&&`-conjuncts of a bare root scan become one SQL statement; the residual
finishes in memory over the produced rows). Both also answer a **nested
block's equality probe over a root scan** from the store's indexes
(implementation note, 2026-10-08: `oqx-js/store-index.ts`,
`omgbase-surface::store_index`): a root (`^<target>` from a row, a bare target
at the root scope) is handed to the engine lazily and a block whose top-level
conjunct is `local == outer` — `^docs collect { where customer == ^$path
}`, `^edges exists { where $dst == ^$id }`, `^docs single { where
type == "x" }` — is served by one indexed statement per probe (docs `$id`,
`$path`, `$title`, any property key by typed value; blocks `$id`, `$doc`,
`type`, `$path`; nodes `$id`, `$doc_id`, `kind`, `name`, `$path`; edges
`$id`, `$src`, `$dst`, `$path`, `$dst_path`) under the root scan's guards and
order, so the root is never read whole; an absent probe or an unindexed path
reads it once. A `$path`/`$dst_path` probe de-roots a rooted value before the
statement and answers no row for a bare one (the intrinsic is the reference
form, 2.0), as the translator renders the column `'/' || d.path` and takes
the indexed `d.path IS ?` fast path only for a rooted constant. Results are unchanged — the §6 fixtures and the conformance
lists are the gate — only the work is. Invisibility is kept by
**declining** rather than by cleverness; since the 1.1 patch of 2026-09-26
(§9) the planner declines, in both translators:

- a comparison whose operand kinds are not **provably comparable the same
  way** in SQLite and in memory. Operand kinds: *text* (a string literal or
  binding, a text column or intrinsic, `lower()`/`upper()` output), *int*
  (an integer intrinsic: `$ordinal`, `$depth`), *num*, *bool* and *null*
  (literals or bindings; an absent binding is null), *json* (an `attrs`
  path or a bare attribute name on blocks or nodes), *prop* (a document
  property or `doc.<k>`). **Equality** (`==`, `!=`) pushes only when one
  operand is text (SQLite's typed comparison and the in-memory strict
  equality agree that a string equals nothing but an equal string), when one
  operand is null and the other is not a property read (a list-valued or
  nested key has no scalar row, so SQL reads `NULL` where the in-memory value
  is an array or an object), or when both operands are numeric (int or
  num). **Relational** (`<`, `<=`, `>`, `>=`) pushes only when both operands
  are text or both are numeric. **Typed pushes (1.2 patch, 2026-09-26):** a
  bool or num literal/binding against a json or prop read is pushed with the
  stored type tested first, so the SQL cannot conflate: for json, `json_type(x)
  = 'true'` / `'false'` against a boolean, and `json_type(x) IN ('integer',
  'real') AND json_extract(x) <op> ?` against a number; for prop, `p.type =
  'bool' AND p.val_bool = ?` and `p.type = 'number' AND p.val_num <op> ?`
  (`spec/properties` §2.1 type names) over the same single-scalar-row
  subquery; the whole test is wrapped `(…) IS 1` for `==` and the relational
  ops and `(…) IS NOT 1` for `!=`, so an absent or differently typed value
  compares as in memory — unequal, never ordered (`checked == 1` finds
  nothing, `checked != 1` everything, `level >= 2` only numeric levels).
  Every other pair is declined: SQLite would otherwise see JSON `true` and
  `1`, `val_bool` and `val_num` alike (`$ordinal == checked`), orders every
  integer before every text (`$ordinal < "3"`, `level < "x"`), and two JSON
  or property reads carry no type at plan time;- a bare identifier or member head that names a **relation, reach-through
  handle, source handle or the `attrs` bag** of the target (§1.2: `blocks`,
  `nodes`, `out`, `in`, `out_edges`, `in_edges`, `frontmatter`, `inline`,
  `doc`, `children`, `section`, `block`, `subsections`, `attrs`, …) — it is
  not a property read;
- the **whole query**, when any residual conjunct could raise an OQX eval
  error the pushed conjuncts might hide by emptying the scan: a residual
  that contains any function or method call, a nested block with the
  `single` consumer, a `^`-escaped name, or (on `docs`) a bare reserved
  basename (`id`, `path`, `updated_at`, `content_hash`, `body`) sends the
  query to the in-memory engine unplanned. Only a residual made of
  comparisons, logical operators, `in`, `!`, literals, bindings and plain
  reads keeps the pushed conjuncts.

The differential (every corpus-backed query case run planned and in-memory)
proves each decline: `query-errors::planned-*` and the `planned-*` cases of
`query-blocks.json` / `query-docs.json` pin the shapes above.

### 1.1 Roots and rows

`from docs | blocks | nodes | edges` — and, from inside a row, `^docs | ^blocks
| ^nodes | ^edges` (the root row, below) — scan the repo's **live** rows in a
fixed order:

| root | rows | order |
| --- | --- | --- |
| `docs` | `docs` with `deleted_commit IS NULL` | `(path, doc_id)` |
| `blocks` | live blocks of live docs | `(doc path, block_id)` |
| `nodes` | `nodes` of live docs | `(doc path, node_id)` |
| `edges` | open edges (`to_commit IS NULL`) of live source docs | `(source doc path, edge_id)` |

**The repository is the root row** (2.0, with `spec/oqx` 0.18 §2). The root
scope's names are the four scans above and **`$id`**, the repository id; the
root scope's **row** (`DataContext.rootObject` / `root_object`) is the root
object, whose entries are exactly the four collections in that order (`$id`
is an intrinsic of it, not an entry). So from a top-level row `^docs` is the
documents scan and `^$id` the repository id; from a block's rows one caret
deeper (`^^docs`), or the absolute `0^docs` / `0^$id` from any depth; `^$it`
is the root object, `^$it.docs` the same handle as `^docs` (a receiver, a
value, a probe), `entries(^$it)` yields `docs`, `blocks`, `nodes`, `edges`
(`query-root.json`). At the root scope a bare target name is the scan — the
receiver of a top-level directive (`docs count { … }`), `from docs`,
`entries(docs)` — because a bare name there is `root(name)`.

Two spellings are **refused** as `filter_invalid`, before any row is read, so
the error is the same whether or not a row would have reached them and the
planned and in-memory paths agree trivially (`query-root::repo-removed-*`,
`bare-target-*`):

- **`$repo`** (an intrinsic of every scope before 2.0) anywhere — bare, as a
  member head (`$repo.docs`, `$repo.$id`), `^$repo`, `0^$repo` — with the
  message `` `$repo` was removed in surface 2.0 — reach the repository's
  collections through the root row: `^docs` from a top-level row (one caret
  per enclosing block, or the absolute `0^docs`), and the repository id as
  `^$id` / `0^$id` ``.
- **A bare target name inside a block** — at scope depth ≥ 1 (a top-level
  row's clauses, a block's body, a `from E` re-projection, a `follow`
  destination), where a bare name reads a property of the current row, which
  has none — with the message `` `docs` inside a block reads a property of the
  current row, which has none — did you mean `^docs` (the repository's
  documents)? `` (the carets count the depth: `^^docs` from depth two).
  `docs` and `edges` are no row's relation, so they are refused statically.
  `blocks` and `nodes` ARE relations of some rows (`docs.blocks`,
  `docs.nodes`, `blocks.nodes`, `section.blocks`, §1.2) and stay those; on a
  row that lacks the relation (`blocks` on a block or edge row, `nodes` on a
  node or edge row, `block.blocks`) the context raises the same error when
  the name is read, the hint spelling the rule (`one caret per enclosing
  block, or the absolute 0^blocks`). Consequence: a frontmatter key named
  `docs`, `blocks`, `nodes` or `edges` is unreachable by bare name — read it
  as `frontmatter.<k>`. The planner declines a bare target name as a property
  read and treats one that could raise as a residual that may raise (§1), so
  a pushed conjunct cannot hide the error.
- **A `^<target>` with more carets than enclosing scopes** — `^docs count { }`
  at the top level, `^^edges` from a top-level row — which `spec/oqx` §2
  reads as absent (so the count would be a silent 0), with the message
  `` `^docs` reaches past the root — there is no enclosing row at this depth;
  at the top level the repository's documents are the bare `docs` (`docs count
  { … }`, `from docs`, `entries(docs)`) `` (statically, by the same walk;
  `query-root::root-caret-past-the-root*`). Only the four target names: any
  other outer reference past the root keeps the language's absent.

A row's **identity** (for `distinct`, `follow` cycles) is its id column. A
relation returns rows of its successor target; a scalar reach-through
(`doc`, `block`) returns one row.

### 1.2 Fields, intrinsics, reach-through, relations

**docs.** Intrinsics: `$id` (doc id), `$path` (the reference form, `/a/b.md`
— §1 Paths), `$content_hash` (hex of
`file_hash`, null when none), `$updated_at` (the current revision's commit
`ts`, null when none), `$body` (the reconstructed file, `spec/store` §6.1),
`$title`/`$tags` (the computed properties, null when absent). `format` is
the format column. `frontmatter` / `inline` are **source handles**:
`frontmatter.<k>` reads the key from that source only; `entries(frontmatter)`
yields one entry per **top-level** key in `key` order (bytewise), dotted
keys folded back into nested objects, each valued by the property rule
below. Any other bare identifier is a **property** (`spec/properties`):
the rows of that key across authored sources (frontmatter + inline, `ord`
order) — exactly one row with `card = scalar` → the decoded scalar;
otherwise the array of decoded values; no row → the nested object rebuilt
from keys under `<k>.` (undefined when none). A bare `id`, `path`,
`updated_at`, `content_hash` or `body` is a **loud error** (`filter_invalid`:
"did you mean the intrinsic") — use `frontmatter.<k>` to force the property.
`doc` is the row itself. Relations: `nodes` (the doc's nodes in **document
order**: block-less nodes first, then by the owning block's pre-order rank,
then `span_start`, then `node_id` — §9), `blocks` (live, **document order**:
pre-order over the tree — §9), `out` / `in` (distinct docs linked to / linking from, by open edges,
`(path, doc_id)` order), `out_edges` / `in_edges` (open edges, `(predicate,
edge_id)` order).

**blocks.** Intrinsics: `$id`, `$doc`, `$path` (owning doc's path),
`$ordinal` (the block's 0-based ordinal among its siblings — the `ordinal`
column), `$depth` (its nesting depth, 0 at the top level — the `depth`
column), `$body` (= `text`), `$content_hash` (hex `raw_hash`), `$updated_at`
(the latest commit `ts` among the block's `block_changes`, null when none).
Inside a `follow` the walk's own `$ordinal`/`$depth` win over the block's
(`spec/oqx` 0.14 §2: the recursion intrinsics are metadata only on a walk
occurrence; anywhere else the names are ordinary reads of the row, §9).
Fields: `type`, `text`, `attrs` (parsed); any other bare
identifier reads `attrs.<k>` (undefined when absent). `block` is the row;
`doc` the owning doc. Relations: `children` (live, `(ordinal, block_id)`),
`nodes` (nodes anchored to the block, `(span_start, node_id)` order),
`out_edges` (open
edges from the block, `(predicate, edge_id)`), `section` (the `md:section`
nodes whose `[first_ordinal, last_ordinal]` contains the block's **top-level
ancestor's ordinal**, by `(first_ordinal, node_id)`).

**nodes.** Intrinsics: `$id` = `$node_id`, `$doc_id`, `$block_id`, `$path`.
Fields: `kind`, `name`, `value`, `attrs`; other bare identifiers read
`attrs.<k>`. `section` is the row; `doc` and `block` reach through (`block`
undefined when the node has none). Section relations (a node read as a
section; empty when it has no `first_ordinal`): `blocks` (live blocks whose
top-level ancestor's ordinal lies in the range, in document order),
`subsections` (`md:section` nodes contained in the range with a greater
`level`, by `(first_ordinal, node_id)`), `children` (contained deeper
sections with **no** intervening section of a level strictly between, same
order).

**edges.** Intrinsics: `$id`, `$src`, `$dst`, `$src_block`, `$via`,
`$from_commit`, `$path` (the source doc's path), `$dst_path` (the target
doc's path, null when not a doc; both the reference form), `$dst_uri` (the
external node's URI, null otherwise). Fields: `predicate`, `provenance`, `dst_kind`, `anchor`,
`src_field`. `doc` reaches the source doc. No relations.

### 1.3 Functions

Free: the `spec/oqx` builtins, plus `entries(<source handle>)` (§1.2),
`range(x)` — a range passes through, a string is parsed per
`spec/properties` §2.2 into a range value, anything else is null — and
**`refs(x)`** (1.5): the live documents the **document references** held in
a property name. `x` is a string, a list, or absent (anything else is an
empty list); each **string** element resolves to the live document of the
current repo at that path in either form (§1 Paths: `/a/b.md` or `a/b.md`)
— or, when no path matches and the element begins with `d_`, the
live document with that id; an element that resolves to nothing (a dangling
reference, a non-string element) is **dropped** — no phantom row, no error.
Order is preserved and duplicates are kept (a `follow` step's union dedups
them anyway). The rows are docs rows exactly as the root scan constructs them,
each found by one indexed lookup under the scan's guards (`docs` is never read
whole), so `refs(x)` serves wherever rows do: a source (`from refs("/a.md")`),
a directive receiver (`refs(see_also) collect { $path }`, `refs(before) exists
{ where $path == "x" }`), a `follow` destination (`follow refs(before),
refs(after)` walks a timeline both ways), a nested `from` (`from
refs(^before)`), or a value (`size(refs(before))`; as a `values` item its rows
render `{ id, path }`, §1.4). It is the remedy for `follow before` over a
list of paths, which reaches the list's strings (§1.4). Row
functions (`text`, `semantic`, `under`, `under_heading`, `within`,
`under_kind`, `yaml_path`, `json_pointer`, `has_edge`, `has_anchor`,
`child_count`, `parent_type`) are written as free calls and evaluated
against the current row:

- `text("terms")`: `spec/search` §1.2 sanitize; empty → false; docs → any
  live block of the doc matches; blocks → the block's FTS row matches;
  nodes → the node's FTS row matches; edges → `filter_invalid`.
- `semantic("phrase")`: docs/blocks only (else `filter_invalid`); the phrase
  must have been embedded for this query (`semantic_unavailable` when no
  provider); the score is `cosine` over the row's stored vector for the
  provider's model (docs: `doc_embeddings`; blocks: the `embeddings` row for
  the block's current `(raw_hash, ctx_hash)`, `spec/search` §3 — since 1.1;
  before, the first row for the `raw_hash` whatever its context) or null
  when none.
- blocks only (`filter_invalid` elsewhere): `under(id)` — `ancestor_path`
  contains `/id/` or the block is `id`; `under_heading(s)` — some section
  containing the block's top ordinal has a heading whose text contains `s`
  case-insensitively; `within(t)` — `t` a doc id → same doc, `t` with `*` →
  path `LIKE` (`*` → `%`, `%`/`_` escaped), else path equality;
  `under_kind(type[, name])` — an ancestor of that `type` (and text
  containing `name` or `attrs.key == name`); `yaml_path` / `json_pointer` —
  for `yaml:`/`json:` blocks, `attrs.key` equals the path or its leaf.
- `has_edge(pred[, dst])` (docs and blocks): an open edge with that
  predicate (and target) from the row; `has_anchor()` (blocks): an edge
  from the block carrying an anchor; `child_count()`, `parent_type()`
  (blocks).

### 1.4 The runner

`query(source, limit = 50, cursor?)` → `OqxResult { hits, truncated,
cursor, consumer, count?, exists?, none?, values? }`:

- `exists` / `count` / `none` consumers return the scalar and no hits.
- otherwise every hit is `{ id, path, ...projection }` (`$id`/`$path`
  injected); `first`/`single` return zero or one hit, no cursor.
- **A hit is a store row (1.5).** Every top-level row of a `collect`, `first`
  or `single` query must be a docs, blocks, nodes or edges row; a query whose
  rows reach anything else — `follow before` over a frontmatter list of paths
  (the strings), a block re-projected to scalars (`docs collect { select
  $it from tags }`) — fails as `filter_invalid` with the message `` a hit must
  be a document, block, node or edge row — the query reached a string
  ("/timeline/kickoff.md"); to follow document references held in a property
  use refs(<field>) `` (the value's kind and, for a string, number or boolean,
  its value: `a string ("…")`, `a number (3)`, `a boolean (true)`, `an absent
  value`, `an array`, `an object`, `a range`). Before 1.5 such a row rendered
  as the junk hit `{ id: "undefined", path: "" }` (§9). The rule is about
  hits only: a `values` projection returns no hits, so its rows may be
  scalars (`follow before` with `select $it values` yields the seed as `{ id,
  path }` and then the raw strings; `query-refs::values-mode-over-scalar-rows-is-exempt`),
  and a nested block's rows are never hits — rows as values below is unchanged
  (`tags collect { }` is the tag strings).
- `collect`: a top-level `select distinct` dedups hits by the user
  projection (first wins), the query's own `limit`/`offset` (integer
  literals only, else `filter_invalid`) bound the set after that, then the
  page: with the default order the keyset cursor `(path, id)` — the hit's
  path, so the reference form — skips rows at or before the cursor, `cap =
  limit`, `truncated` = more remained, `cursor` = the last hit's `(path, id)`
  when truncated; a custom `order by` disables the cursor (the top `cap` is
  returned, `truncated` still honest).
- `values`: the single projected item is returned as `values: [...]` with
  `hits` empty.
- **Rows as values (1.2).** Wherever a row surfaces as a *value* rather
  than as a hit — a nested `collect { }` / `first { }` / `single { }` with an
  empty projection (`spec/oqx` §12: "the row itself"), or a `values`
  projection of a row — it is rendered as `{ id, path }` (the row's id
  column and its document's path), never the store row (§9: before 1.2 the
  raw row leaked, `attrs` as a JSON string and the join column `__path`
  included). Hits are unaffected: `{ id, path, ...projection }` as above.
- Errors: an OQX error is `filter_invalid` with the engine's message; a
  malformed cursor is `filter_invalid` naming the surface.

Cursors are `base64url(JSON [parts...])`: `[path, id]` for `query`,
`[path]` for `docs_list`/`docs_tree`, the path in the reference form. **A
cursor from a 1.x surface is not honoured** (2.0): its path is bare, so its
keyset would sort before every rooted row and silently replay the first page;
a decoded first part that does not begin with `/` is `filter_invalid` with the
message `invalid cursor: cursor was issued before surface 2.0 (its path "…" is
not /-rooted); start the page sequence again without a cursor` (and the same
text as `data.reason`; `query-errors::cursor-from-1x-rejected`, `reads::alchemy`).
The generic decoder (`cursor.json`) is unchanged.

## 2. Reads

- **`resolve_ref(ref)`**: an `n_` + 12 hex node id → its block when the block
  is live, else its doc; a `b_` id → its live block; a `d_` id → the live doc;
  anything else → the live doc at that path; null when nothing matches.
- **`docs_read(doc, include_ids?)`**: `{ path (reference form), doc_id, rev,
  properties (grouped, spec/properties §5), content (spec/store §6.1) }` + with ids
  `ids` (pre-order), `hashes` (id → hex `raw_hash`), `parents` (id → parent
  id or null). `docs_read_many(refs, include_ids?, budget_tokens?)`:
  first-seen dedup, cap 100 (`truncated`), a miss → `errors: [{ ref, error:
  "doc_not_found" }]`, the budget (`ceil(JSON length / 4)` per item) stops
  early with `truncated` — but **at least one item is always returned**
  (1.2, the uniform list contract of `docs_list`/`docs_tree`: the budget
  is checked before the second item onward; a first item that alone exceeds
  it is still emitted and the batch is `truncated` if more remained). `docs_read_at(doc, rev)`: `spec/store` §6.2 plus
  `properties` (current) and `properties_are_current: true`.
- **`nodes_get(doc?, id, resolution = full)`**: the block subtree projected
  at a resolution — `skeleton` `{ id, type, label = heading text or type }`,
  `outline` `{ id, type, label = first 12 words… }`, `text` `{ id, type,
  text }`, `raw` `{ id, type, raw, content_hash }`, `full` (`raw`,
  `content_hash`, `text`, `attrs`, `placement { parent, ordinal, depth }`);
  `children` recursively. `nodes_get_many(doc?, ids, resolution = text,
  budget_tokens?)`: cap 100, request order, no children, `unresolved` for
  ids naming no live block (or one outside the scoping doc), `truncated`
  on the cap or the budget; at least one resolved node is always returned
  (1.2, as `docs_read_many`).
- **`docs_outline(doc, resolution = outline, depth?, budget_tokens?)`**:
  one line per block, `"  " × depth + id + " " + type label padded to 4 +
  " " + label`, `"  §"` appended for headings, trailing spaces trimmed; type
  labels `h<level>`, `p`, `ul`, `li` (list items and tasks), `bq`, `code`,
  `tbl`, `tr`, `hr`, `html`, `raw`; labels: containers `""`, tasks `☐`/`☑` +
  ten words, others ten words (`…` when cut), `skeleton` none; `depth`
  limits nesting; the budget (`ceil(line length / 4)`) truncates.
- **`docs_list(path_glob?, limit = 200, cursor?, budget_tokens?)`**: live
  docs by path, `path LIKE glob` (`*` → `%`, `%`/`_`/`\` escaped; the glob
  in either form), rows `{ path (reference form), blocks (live count), ts
  (current revision's commit ts or null) }`, fetched `limit + 1`, keyset
  cursor `[path]`, budget as above (at least one row). **`docs_tree(path?,
  depth = 1, …)`**: the prefix normalized (either form accepted; reported
  rooted — `/` for the repo root, else `/<dir>/`); every live doc under it
  collapsed at `depth` segments into `dir` entries (a rooted `path` ending
  `/`, summed `docs` and `blocks`, max `ts`) or `doc` entries; `total` over
  everything under the prefix; ordered by path and paged the same way.

## 3. History

Result keys in §2–§4 are written in the reference's **camelCase** on the
wire (`docId`, `contentHash`, `isCurrent`, `hasSource`, `blockId`,
`renderedHashMatch`, `propertiesAreCurrent`, …); the fixtures pin the wire
verbatim, and this prose uses snake_case only as a naming convention.

- **`history_node(id, limit = 100)`**: the block's `block_changes` joined to
  commits and dispositions, newest first: `{ commitId, seq, ts, origin,
  kind, confidence, reason }`.
- **`diff(doc, from_rev, to_rev)`**: both revisions must belong to the doc,
  else `target_missing` (§9: the reference treated an unknown revision as
  empty and reported every block removed); block-grain — the id → raw maps
  of both revisions' Merkle trees (all depths); entries `removed` (in from
  only), `changed` (raw differs), `added` (in to only), in that order,
  `before`/`after` as applicable. **`diff_unified(doc, from_rev?, to_rev?)`**:
  defaults to the previous and current revisions (`target_missing` when
  none); `{ doc, path, from, to, diff }` where `diff` is a **unified diff** of the
  two revisions' **reconstructed file texts** — for each revision exactly the
  bytes `docs_read_at` returns (§2: leading trivia, frontmatter, the top-level
  raws with their trivia in order; a container's raw already holds its
  children, so nothing appears twice and hunk line numbers are file lines;
  since the 1.4 patch of 2026-09-30, §9 — until then the text was the
  Merkle-tree walk, every live raw at every depth joined by `\n`), split on
  `\n` exactly, no trimming; an empty text has **no** lines (since 1.1, §9):
  the shortest edit script by Myers' O(ND) algorithm with the canonical
  tie rule (at each step take the diagonal from `k+1` — an insertion from
  the new side — when `k == -d` or `k != d` and `V[k-1] < V[k+1]`, else from
  `k-1` — a deletion from the old side — so on a tie the script prefers the
  deletion and both engines pick the same script), grouped into hunks with 3 lines of context (two changes
  whose contexts touch or overlap share a hunk), each hunk `@@ -a,b +c,d @@`
  (1-based start and length; a length of 1 is written as the start alone,
  `0` lines as `a,0` with `a` the line before the insertion point) followed
  by its lines prefixed `-`, `+` or a space (no space after the sign), hunks
  joined by `\n`, no file header; identical texts yield `""`. Lines are
  compared as exact strings.
- **`changes_since`**: `spec/sync` §6 (the digest shape and paging;
  `summary` unpinned) — every path in a digest, the `summary`'s subject
  included, in the reference form (2.0).
- **`docs_history(path_glob | doc, include_deleted?, limit = 50)`**: docs by
  path (glob as `docs_list`; a glob without `*` is an exact path), live only
  unless `include_deleted`, `limit + 1` for `truncated`; each `{ doc_id,
  path (reference form), deleted, current_rev, versions: [{ rev, seq, commit,
  ts, origin, actor, content_hash, is_current }] }` oldest first.

## 4. The MCP tool catalog

Served as MCP over stdio; every result is one text content item holding
JSON; an error result has `isError: true` and the envelope `{ error: <code>,
message, data?, retriable }`. Codes: `spec/mutate` §8 plus `filter_invalid`
(OQX and cursor errors, `data: { reason, hint }`), `budget_exceeded`,
`semantic_unavailable`, `embedder_failed`, `repo_not_found`,
`ambiguous_heading`, `conflicted_document`, `ambiguous_locator`,
`seed_unresolved`. Any other failure is `repo_not_found` with the message
(§9).

**Repo scoping.** Every repo-scoped tool takes an optional `repo` slug;
omitted → the server's default repo; unknown → `repo_not_found`. A repo's
root is derived (`spec/sync` §1); a mutating tool on a sourceless repo fails
`repo_not_found` ("mutation disabled").

**Ref resolution (server side).** `doc` fields accept an id or a path;
`path` fields a path (every path argument in either form, §1 Paths); a block-level tool's `block`/`blocks`/`to`/`at` refs go
through `resolve_ref` (a doc ref as `to` means the document's top level);
`heading` accepts a heading block id or heading text (an ATX-looking text
loses its hashes; matched against the normalized heading text repo-wide or
within `doc`/`path`; zero → `parent_missing`, several →
`ambiguous_heading { heading, candidates }`). Block-level tools pin
`expect.content_hash` from the live row when the caller omits it.

| Tool | Args | Result |
| --- | --- | --- |
| `docs_outline` | `doc?`, `path?`, `resolution?`, `depth?`, `budget_tokens?` | §2 |
| `docs_read` | `doc?`, `path?`, `include_ids?` | §2 |
| `docs_get_many` | `docs[]`, `include_ids?`, `budget_tokens?` | §2 |
| `nodes_get` | `doc?`, `path?`, `id`, `resolution?` | §2 (doc inferred from the block) |
| `nodes_get_many` | `doc?`, `path?`, `ids[]`, `resolution?`, `budget_tokens?` | §2 |
| `read_ref` | `ref`, `resolution? = raw` | `{ kind: "document", ...docs_read }` or `{ kind: "block", ...nodes_get }` |
| `docs_tree` / `docs_list` | §2 args | §2 |
| `query_syntax` | — | `{ syntax }` (reference text, unpinned) |
| `query` | `query`, `limit?`, `cursor?` | §1.4; `semantic(...)` with no provider → `semantic_unavailable` |
| `graph` | `roots[]`, `degrees? = 1`, `direction? = both`, `predicate?`, `select?[]`, `max_documents? = 200` | `{ documents: [{ id, path, degree, frontier, ...select }], edges: [{ id, src, dst, dst_path, dst_uri, predicate, provenance, dst_kind, anchor, src_field }], frontier, truncated, queries, degrees }` — compiled to `follow doc.out`/`doc.in` with `depth = degrees + 1` (≤ 8, so `degrees` clamps to 7 and the result reports the clamped value), roots depth 0; documents ordered bytewise by path (§9); a `$path` projection collapses onto the existing `path` key |
| `text_search` | `q`, `limit?` | `spec/search` §1.3, hit `path` in the reference form |
| `resolve` | `query`, `limit?` | `spec/search` §4 (vector fused when a provider exists), the `locator`'s path half in the reference form (`/a.md#paragraph[2]`) |
| `apply` | `ops[]`, `reason?`, `dry_run?` | `spec/mutate` §4, `origin.actor = "agent:mcp"`; `revisions[].path` and the `diffs` keys in the reference form |
| `blocks_insert` | `to`, `markdown`, `at? = end`, `expect? { parent_children_hash? }`, `dry_run?` | the apply result; `expect` is the destination-parent CAS of `spec/mutate` §1.2 (1.2) |
| `blocks_update` | `block`, `markdown?`, `checked?`, `attrs?`, `expect?`, `dry_run?` | `{ id, ids, ...apply result }` (`checked` folds into attrs) |
| `blocks_move` | `blocks[]`, `to`, `at?`, `expect? { parent_children_hash? }`, `dry_run?` | a doc ref as `to` must be the blocks' own document, else `target_missing`; `expect` is the destination-parent CAS, checked once (1.2) |
| `blocks_remove` | `blocks[]`, `dry_run?` | |
| `blocks_split` | `block`, `at[]` (bytes), `dry_run?` | |
| `blocks_merge` | `blocks[]`, `separator?`, `dry_run?` | |
| `tasks_complete` | `blocks[]`, `checked? = true`, `dry_run?` | |
| `node_set` | `node`, `prop`, `value`, `dry_run?` | |
| `sections_append` | `heading`, `markdown`, `doc?`, `path?`, `dry_run?` | |
| `docs_append` | `doc?`, `path?`, `text` | (no dry run) |
| `links_retarget` | `from_target`, `to_target`, `path_glob?`, `dry_run? = true` | `{ hits, pairs, applied, ...apply result }` |
| `links_stale` | `path_glob?`, `limit? = 500`, `summary?` | `spec/graph` §6 shapes; `srcPath`, `target`, `bySource[].srcPath`, `byTarget[].target` in the reference form (`authored` stays as written) |
| `links_repair` | `repairs[]` or `from_target`+`to_target`, `path_glob?`, `dry_run? = true` | as retarget; neither given → `target_missing` |
| `docs_create` / `docs_move` / `docs_delete` / `docs_set_meta` | `spec/mutate` §6 args, `dry_run?` (1.3) | its results, every path (`path`, the `diffs` keys, `dangling[].path`; not `dangling[].target`, which is as authored) in the reference form; with `dry_run` nothing commits and the result carries `committed: false` and `diffs` (`{ <path>: { before, after } }` — create `"" → bytes`, delete `bytes → ""`, move two entries, meta before → after; a move — which retargets the inbound links unless `retarget_inbound: false`, `spec/mutate` 1.3 — also previews the rewritten sources and `retargeted`/`dangling`); a dry-run create still mints its `d_` id (`apply`'s rule) |
| `docs_plan_update` | `doc`, `content` | `{ opset, plan }` (`plan` = the rendered one-line-per-op text; the opset's `target.path` and `precondition.path` in the reference form) |
| `docs_update` | `doc`, `content`, `reason?`, `dry_run?` | `{ opset, plan, result }` |
| `observe` / `observe_many` / `observe_delete` | `spec/store` §5 (`path` in either form) | its outcomes (`observe` sweeps the pool), `path` in the reference form |
| `history_node` | `id`, `limit?` | §3 (not repo-scoped) |
| `diff` / `diff_unified` / `docs_read_at` / `docs_history` / `changes_since` | §3 | §3 |
| `repos_status` / `sync_status` | `repo?` | `spec/sync` §4.4 |
| `repos` | — | `{ repos: [{ slug, has_source }] }` by slug |
| `version` | — | (1.4) which engine and which versions: `{ engine: "typescript" \| "rust", version, components: { <package or crate>: <version>, … }, specs: { oqx, format, reconcile, store, properties, graph, search, mutate, sync, surface, cli }, schema, mcp: { protocol, sdk? }, runtime, commit, built }` — `version` is the serving binary's own (the `omgbase` npm package or crate); `components` every omgbase package the binary is built from with its version (the reference: `omgbase`, `@omgbase/core`, `@omgbase/oqx`, `@omgbase/sync`, `@omgbase/fs-adapter`; the port: `omgbase` and each `omgbase-*` crate and `oqx`), keys sorted bytewise; `specs` the `spec/<x>/VERSION` each was built against (a compile-time constant, not a file read); `schema` the open database's `PRAGMA user_version`; `mcp.protocol` the protocol version served, `mcp.sdk` the SDK's version when one is used; `runtime` `node <version>` or `rustc <version>`; `commit` the build's git revision (short, `null` when unknown — a published crate reads `.cargo_vcs_info.json`, the npm package a `build-info.json` written by `pnpm build`), `built` its RFC 3339 build time or `null`. Values are engine- and release-specific, so §6 pins the **shape**: leaves are recorded as their type. No repo scope, no workspace needed beyond the database for `schema` (`null` without one). |

Dry runs never trigger the host's post-mutation hook (the embed drain);
successful writes do.

## 5. The CLI

`omg` is the same catalog in verb form (`docs/surface-map.md` is the
bijection); this spec pins the catalog, not the terminal rendering. A Rust
`omgbase` binary serves `omgbase mcp` from the same crate and may render the
verbs later.

## 6. Fixtures

- **corpus-backed query cases**: a suite carries `corpus: { "<path>":
  "<source>", … }` (the reference's alchemy repository, 20 documents since
  1.5 — the two `timeline/` milestones carry the `before` / `after` /
  `see_also` document references `refs(x)` resolves — copied
  from `packages/core/corpus/oqx/fixtures/alchemy`; a test keeps the
  embedded copy equal to the files) observed into a fresh repo
  (`spec/store` §9.4 minter, one `observe` batch in bytewise path order at
  `2026-09-27T00:00:00.000Z`, so `d_0` is `index.md`), then `cases: [{ name,
  notes?, query, limit?, cursor?, expect }]` with `expect` the `OqxResult`
  as JSON (absent keys for undefined projections; numbers within 1e-9) or
  `{ error: "filter_invalid", message_includes }`. The reference runs every
  case both planned and in-memory and fails on any difference. Suites:
  `query-docs.json`, `query-blocks.json`, `query-nodes.json`,
  `query-edges.json`, `query-follow.json`, `query-functions.json`,
  `query-refs.json`, `query-errors.json`, `query-root.json` (the root row,
  2.0: `^docs` / `0^docs` / `^$id` / `^$it`, the `$repo` and bare-target
  errors).
- **`reads.json`**: observation scripts (`spec/store` §9.4) with `read`
  steps (a `version` read is recorded with every leaf value replaced by its
  type name — `"<string>"`, `"<number>"`, `"<null>"`, `"<boolean>"` — since the
  values name the engine and the release; objects keep their keys and arrays
  their length, except the two engine-specific parts: `components`, keyed by
  the engine's own packages, is recorded as `"<object>"`, and the optional
  `mcp.sdk` is dropped; `commit` and `built`, null or not by build
  environment, are recorded as `"<string|null>"`; `interop.json` never calls
  it) — `{ "read": { "tool": "<name>", "args": {...}, "ts"? } }` — invoked
  through the MCP server itself (the reference connects an SDK client over an
  in-memory transport and calls the tool); the outcome is the tool's JSON
  result, or `{ error, retriable, data? }` for an error result (`message`
  dropped; `data` dropped for `filter_invalid`; `changes_since` digests lose
  `summary`). A case with `workspace: true` gives the default repo a
  temporary directory as its `fs` source and server root, seeded from the
  `observe` steps, so writing tools work (file-CAS included) and `repos`
  reports `hasSource: true`; without it the repo is sourceless and every
  writing tool fails `repo_not_found`. `ts` pins the clock for the call
  (write tools stamp commits with "now"). Write tools are pinned by
  `spec/mutate`; `read` steps still record their results.
- **`cursor.json`**: `{ name, parts | (cursor, arity), expect }` encode /
  decode cases (`{ cursor }`, `{ parts }` or `{ error: "filter_invalid" }`).

- **`interop.json`** (§7): the cross-engine suite. The suite carries the
  alchemy `corpus` like a query suite; each case is `{ name, notes?, ts?,
  writes?: [{ tool, args }], reads: [{ tool, args }], expect: { writes,
  reads } }`. It is run by a different harness from the other suites (both
  engines as separate processes over MCP stdio, every writer × reader
  combination) — `packages/core/corpus/surface/interop.test.ts` and
  `crates/omgbase/tests/interop.rs`; `spec.test.ts` and the surface crate's
  `spec.rs` validate its shape and otherwise leave it to them.

**Generation.** `packages/core/corpus/surface/spec.test.ts`,
`SURFACE_SPEC_UPDATE=1`; `interop.json` is regenerated by `interop.test.ts`
under the same variable (TypeScript writing and reading), so
`SURFACE_SPEC_UPDATE=1 vitest run corpus/surface` does both. The TypeScript
harness has no override for its own peer. **Allowlist (Rust).**
`crates/omgbase-surface/tests/spec-passing.txt`, `SURFACE_SPEC_UPDATE=1`.

## 7. Cross-engine interop

Everything above is specified so that two engines can serve **one
database**. §7 pins the payoff no single-engine fixture reaches: a workspace
built by either engine is served by the other with identical results, for
every read tool, and a workspace written *through* either engine's tools
reads identically from both. An engine that passes every other suite but
fails here has a divergence the fixtures' in-process runners could not see
(random ids, wall-clock stamps, a table only one engine maintains, a wire
key spelled differently on the two transports).

### 7.1 The test seams

Both binaries honor two environment variables, **for conformance runs
only** (never set in production; an engine may refuse them outside a test
build but must honor them when it accepts them):

- `OMGBASE_SPEC_MINTER=sequential` — install the fixture minter of
  `spec/store` §2.2 for the process (`d_0, d_1, …`, each prefix counting from
  0 independently, counters fresh at process start).
- `OMGBASE_SPEC_CLOCK=<RFC 3339>` — "now" for the process is that instant,
  stored in the canonical form (`YYYY-MM-DDTHH:MM:SS.fffZ`, UTC, so a value
  with an offset is converted): every commit stamped by a tool call, every
  `ts` a tool reports as current. A reader never needs it; a writer always
  runs under it.

The reference reads them in `omg mcp` (`packages/cli/src/cmd/mcp.ts`), the
port in `omgbase mcp` (`crates/omgbase/src/main.rs`).

### 7.2 The workspace

A case runs in a fresh temporary directory `W`:

1. The harness writes the suite's `corpus` into `W` as files, bytes
   verbatim (`W/<path>`), and bootstraps the database `W/.omgbase/omgbase.db`
   with **its own engine** under the fixture minter: `ensure_repo("fixture",
   W)` of `spec/sync` §2 — repo `rp_0` (slug `fixture`) attached to the `fs`
   source `fixture-fs` (`src_0`) rooted at `W`; **no documents**. The two
   engines' `ensure_repo` write the same rows (the sync fixtures pin them), so
   the bootstrap is not part of what interop compares, and no `d`/`b`/`c`/`r`
   prefix has been minted when the writer starts.
2. The **writer** is spawned as an MCP server over stdio on `W` with the §7.1
   seams (`OMGBASE_SPEC_CLOCK` = the case's `ts`, default
   `2026-09-27T00:00:00.000Z`) and without a watcher (`omg mcp -C W
   --no-watch`; `omgbase mcp --workspace W --no-watch` — both binaries watch
   by default, and a priming sweep would ingest the corpus before the seed). The harness calls
   `observe_many` once with every corpus file in bytewise path order (so
   `d_0` is `index.md`, as in the query suites), then each of `writes` in
   order. The seed's outcome is **checked, not recorded**: one outcome per
   file in order, `docId` `d_<i>`, `echo: false`. Each write's result is
   recorded (§7.3), so `expect.writes` holds one outcome per entry of
   `writes`. The writer is then closed (stdin EOF) and the harness waits for
   it to exit.
3. The **reader** is spawned the same way on `W` and each of `reads` is
   called in order and recorded; then closed.
4. The recorded `writes` and `reads` must equal the case's `expect`.

Every case runs for every `(writer, reader)` in `{typescript, rust}²`: the
two same-engine pairs prove each engine is consistent with the committed
expectation over stdio; the two cross pairs are the interop gate. `expect`
is generated by the reference pair (TypeScript writing and reading). A
harness cleans `W` up afterwards.

### 7.3 What is compared

Outcomes are recorded as `reads.json` records them (§6: the parsed JSON
result, or `{ error, retriable, data? }` with `data` dropped for
`filter_invalid`; `changes_since` digests lose `summary`), with one more
normalization: every string equal to `W`, or beginning with `W` followed by
`/`, has that prefix replaced by `<workspace>` (the temporary directory
differs per run; a tool that reports absolute paths still compares).
Numbers compare within 1e-9. No case calls `query_syntax` (its text is
unpinned); a harness may compare whatever it is asked to call.

The suite's cases call **every read tool** of §4 at least once over the
corpus, and every writing tool at least once followed by reads that show
its effect (a `blocks_update` then `docs_read`, `docs_history`,
`changes_since`, `diff`; a `docs_move` then `docs_tree`, `links_stale`; a
`docs_create` then `graph`; …). `apply`'s file-CAS holds in the writing
engine's working tree, so a write through one engine and a later read of
`repos_status`/`sync_status` through the other exercises the sync tables
(`file_stats`, checkpoints) both engines must maintain alike.

### 7.4 Peers

The TypeScript harness finds the port at `$OMGBASE_RUST_BIN`, else
`<repo>/target/debug/omgbase`, else `<repo>/target/release/omgbase`; the
Rust harness finds the reference at `$OMGBASE_TS_MCP` (a command line whose
argv the harness extends with `mcp -C W --no-watch`), else `node
<repo>/packages/cli/dist/src/main.js`. A missing peer **fails** the cross
pairs with the build command in the message (`cargo build -p omgbase`;
`pnpm build`); `OMGBASE_INTEROP=skip` turns that into a skip (for a host
without the other toolchain). `pnpm interop` at the repository root builds
both and runs both harnesses.

## 9. Reference oddities surfaced while specifying, and decisions

- **Fixed — `docs.nodes` and `blocks.nodes` had no order**, and `blocks`
  relations ordered by sibling ordinal across depths (nested children before
  later top-level blocks). Now document order for both: nodes by their
  owning block's pre-order rank, then `span_start`, then `node_id` (an id
  order would reshuffle on every fresh ingest, since `node_id` hashes the
  random doc id); blocks in pre-order (`query-functions::nested-collect-distinct`,
  `query-docs::relation-blocks-in-document-order`).
- **Fixed — `diff` with an unknown revision reported every block removed.**
  Now `target_missing`.
- **Fixed — `graph` ordered documents with `localeCompare`.** Bytewise now.
- **Fixed (1.1, with oqx 0.13) — `$ordinal`/`$depth` on blocks were
  shadowed** by the engine's recursion intrinsics outside a `follow` (they
  read undefined). `spec/oqx` 0.13 §2 makes the intrinsic names ordinary
  property reads wherever the scope carries no such metadata, so the block
  columns are reachable (`query-blocks::intrinsics`,
  `query-blocks::root-order-is-path-then-block-id`,
  `query-docs::relation-blocks-in-document-order`,
  `query-nodes::section-blocks-includes-nested`); inside a `follow` the
  walk's metadata still wins.
- **Fixed (1.2) — an empty-projection nested `collect { }` yielded the raw
  store row** (store columns, `attrs` as a JSON string, the join column
  `__path`); a port had to reproduce the same keys, blobs came out as a Node
  `Buffer` in one engine and hex in the other. §1.4 now renders a row
  surfacing as a value as `{ id, path }` (least surprising: a hit's
  identity, the same two keys every hit carries;
  `query-functions::nested-collect-empty-projection`).
- **Fixed (1.2) — budgets were asymmetric.** `docs_get_many`/`nodes_get_many`
  returned zero items when the first exceeded `budget_tokens`, while
  `docs_list`/`docs_tree` always returned one row. One contract now (§2):
  at least one item, always (`reads::budgets`).
- **Fixed (1.2) — `blocks_insert`/`blocks_move` had no `expect`.** Mutate 1.1
  made `parent_children_hash` a live destination-parent CAS on `insert` and
  `move`, but the two macros gave a caller no way to send it. Both take
  `expect { parent_children_hash? }` now (§4; `reads::workspace-writes` sends a
  matching and a stale one — the stale one is `stale_expectation` with the
  current hash).
- **Fixed (1.5) — a non-row hit rendered as `{ id: "undefined", path: "" }`.**
  The runner injected `$id`/`$path` into every projection and `String()`-ed
  the results, so a `follow` over a property holding a list of paths (the
  strings, per `spec/oqx` §3) produced one junk hit per string with no hint of
  what happened. §1.4 now makes a hit a store row and fails the query
  otherwise, naming the value reached and `refs(<field>)` as the remedy
  (`query-errors::hit-not-a-row-follow-property`).
- **Pinned — `semantic()` without a provider is `filter_invalid` at the
  runner** ("needs an embedding provider"); only the `query` tool pre-checks
  and reports `semantic_unavailable`.
- **Pinned — wikilinks resolve by path**, so a `[[slug]]` whose slug is not a
  path is a phantom edge (`spec/graph` §3.2); the alchemy corpus's `out`/`in`
  never reach documents through wikilinks.
- **Pinned — the cursor decoder is lenient** (standard-alphabet base64 and
  `=` padding are accepted).
- **Pinned — dry runs consume minted ids** (a dry-run insert advances the
  `b` counter).
- **Pinned — `nodes_get` with an unknown block id is `doc_missing`** (the doc
  is inferred first); a block outside an explicit `doc` scope is
  `block_missing` without data.
- **Pinned — `$tags` is body hashtags only** (`spec/properties` §3.3); a
  corpus without `#tags` in prose has `$tags` null everywhere.
- **Port notes.** Argument-shape failures (the reference's MCP/zod
  validation) are unpinned; the Rust catalog reports them as `filter_invalid`
  with `reason: "arguments"`. The `frontmatter`/`inline` source handles are
  lazy in the reference and materialized eagerly in the port (same values;
  `size(frontmatter)` would differ — unpinned). Blob columns leaking through an
  empty-projection collect are hex in the port and a Node `Buffer` object in
  the reference (unexercised). The Rust port runs the same tier-3 pushdown
  planner as the reference (`omgbase-surface::planner`/`translate`: the
  pushable top-level conjuncts of a bare root scan become one SQL statement,
  the residual finishes in memory over the produced rows) and proves it
  invisible the same way — every corpus-backed query case and the
  conformance list run planned and in-memory and must agree; the spec still
  describes in-memory semantics only. Its binary serves a hand-rolled JSON-RPC 2.0 stdio transport, honors the
  §7.1 seams, and — like `omg mcp` — runs an in-process filesystem watcher
  by default (watch lease, priming freshness sweep, the repo's registered
  `fs` adapter spawned as `omgbase-fs-adapter` from `PATH` or
  `$OMGBASE_FS_ADAPTER`, `reconcile_changes` per batch under the writer
  lock; `--no-watch` or a live lease elsewhere turns it off, a missing
  adapter degrades to serving without one) and a background embed drain
  (500 ms debounce, single-flight, flushed at shutdown) on its own store
  connection and provider instance; every committing tool runs under the
  writer lock. Since `oqx` 0.13 `DataContext::get` has an error channel
  (`Result`), so the port raises the reserved-basename guard and any store
  failure inside a read or row function where it happens, aborting the run
  like the reference's throw; the runner maps that eval error to
  `filter_invalid` with the same message (a store failure is thus
  `filter_invalid` with the sqlite message, where the reference's raw
  exception reaches the catch-all). Only `root` still has no channel: a
  failed root scan is served empty and reported after the run.
- **Fixed (1.1 patch, 2026-09-26) — the planned path was not quite
  invisible** in three shapes no fixture exercised, and both implementations
  mirrored them: a pushed comparison conflated booleans and numbers
  (`checked == 1` found checked tasks in SQL, none in memory); a relation or
  bag name in a pushed comparison read as a property key (`nodes == null`
  was `NULL IS NULL`, every row); and a residual conjunct's error was
  suppressed when a later pushed conjunct emptied the scan (`path == "x" &&
  $path == "nope.md"` was `[]` planned, `filter_invalid` in memory). A
  fourth surfaced while fixing: `null` against a property read (`tags !=
  null` on a list-valued key was `NULL IS NOT NULL`, no row, where in memory
  the array is not null), then a relational comparison across text and
  numeric kinds (`$ordinal < "3"` was every row in SQL, none in memory), an
  integer intrinsic against a JSON read (`$ordinal == checked`), and the
  bare `attrs` bag reading as `attrs.attrs` — at which point the rule was
  restated positively (§1: push only pairs provably comparable the same
  way) instead of growing a list of declined cells. Each is a query-suite
  fixture proven by the differential. Declining cost the push on
  `checked == false`-style queries: measured at ~180 ms over 60,000 blocks
  in both engines against ~25 ms when another conjunct narrowed the scan,
  so the same day the bool/num-against-json/prop cells came back as
  **typed pushes** (§1) — the stored type is tested in SQL before the value
  — with the same `planned-*` fixtures proving fidelity and
  `query-blocks::planned-typed-*` pinning the positive hits.
- **Fixed (1.1) — `diff_unified` was positional.** It compared the two
  revisions' raws line by line at equal indices, so one inserted line made
  every following line a `-`/`+` pair, and the text was not a unified diff
  at all (`- old`/`+ new` with a space, no hunks). §3 now pins a real unified
  diff with a deterministic Myers script (least surprising: the tool is
  named after the format).
- **Fixed (1.4.x) — `diff_unified` diffed the tree walk, not the file.** Each
  revision was rendered as every live raw at every depth of its Merkle tree
  joined by `\n` — but a container's raw already holds its children's text,
  so every list item, quote line and table row appeared twice: inside the
  container's raw and again as a block of its own. Appending one bullet to a
  `## Log` list produced a `+` line at the end of the container's raw —
  immediately before the first child's raw, so it read as an insertion
  *before* the list's first item — and the same `+` line again in a later
  hunk, where the new child sat at the end of the children. The bytes were
  never wrong (`docs_read_at` was right all along); only the text being
  diffed was. §3 now diffs each revision's reconstructed file text — exactly
  what `docs_read_at` returns — so hunk line numbers are real file lines and
  the frontmatter shows up as context (`reads::diff-unified-list-append`
  pins a loose list, a tight pair of appended bullets, then one more). The
  block-grain `diff` keeps the all-depths id → raw map: it compares blocks
  by id, where a container and its children are distinct entries. No field,
  tool or result key changed: a patch.
- **Fixed (2.0) — the surface reported paths in the storage form.** `$path`,
  every hit, every tool answered `projects/oqx.md` while every reference an
  author writes is `/projects/oqx.md`, so correlating a document with the
  references that name it needed `"/" + ^$path` glue and a `links_stale`
  `target` could not be pasted where an `authored` destination could. §1
  "Paths" now makes the reference form the surface's one form, both forms
  accepted on input, literals compared with `$path` rooted for the author
  (`query-docs::path-literal-bare`), and refuses a 1.x cursor. The storage
  layer and every lower spec are untouched; the other-spec result shapes
  (`spec/mutate`, `spec/store`, `spec/search`) are re-shaped at the surface
  boundary — one function per shape in both engines (`surface-paths.ts`,
  `omgbase_surface::paths`). The one place the two engines compose a path
  differently: the Rust store renders a change digest's `summary` in the
  storage form and the catalog re-roots its subject (`root_summary`), where
  the reference composes it from rooted paths.
- **Pinned — the catch-all error is `repo_not_found`.** An unexpected
  exception in a tool is reported under that code with its message.
- **Pinned — `history_node` is not repo-scoped**; block ids are global.
- **Pinned — `entries(frontmatter)` is in key order**, not authored order
  (`ord` positions only within a list-valued key).
- **Fixed (1.1, with search 1.1) — `semantic()` on blocks read the first
  cache row for the block's content hash**, whatever its context; now the
  current-context row only (`spec/search` §8).
- **Pinned — a `docs_move` dry run over a self-linking document overwrites
  the old path's diff entry.** The preview is the two rename entries
  (`old → ""`, `new ← bytes`) with the inbound-retarget preview assigned over
  them; when the moved document links to its own path, the retarget preview
  carries an entry for the *old* path (the doc has not moved yet in a dry
  run) and replaces the emptied one. Both engines mirror it (1.3).
- **Pinned — `blocks_split` sends an empty `content_hash`** when the block
  has no live row, so the kernel raises `stale_expectation` with the current
  hash rather than `block_missing`.

## Decisions

- 2026-10-10, surface 2.0 also: **the repository is the root row; `$repo` is
  removed** (Brendan's decision of 2026-10-09/10, §1.1). `spec/oqx` 0.18 made
  the root scope a row — the host's root object — so the repository no longer
  needs an intrinsic of every scope to be reachable: from a top-level row
  `^docs` / `^blocks` / `^nodes` / `^edges` are the collections (one caret per
  enclosing block, or the absolute `0^docs`), `^$id` / `0^$id` the repository
  id (the root scope's `$id`), `^$it` the root object (its entries exactly the
  four collections; `^$it.docs` ≡ `^docs`). Reading `$repo` anywhere — bare,
  `$repo.docs`, `$repo.$id`, `^$repo`, `0^$repo` — is `filter_invalid` with a
  message naming the replacement, detected statically over the parsed tree so
  it does not depend on which rows the data holds; and a bare target name
  inside a block — a property read of a row that has none, until now a silent
  empty read — is `filter_invalid` with "did you mean `^docs`" (`docs`/`edges`
  statically; `blocks`/`nodes`, which are relations of some rows, by the
  context when a row lacks the relation). Every fixture query that spelled
  `$repo.<target>` was rewritten: a top-level receiver to the bare target
  (`docs count { … }`), a read inside a row to `^<target>`, `$repo.$id` to
  `^$id`; every expectation is unchanged except two cases that pinned the
  silent read of a target name on an edge/node row (`query-edges::no-relations`,
  `query-nodes::no-relations-beyond-section`), re-queried with a non-target
  name and pinned as errors in `query-root.json` (31 cases); §7 gained a
  `^docs` / `^$id` / `entries(^$it)` read and a `0^docs` read. **Migration:**
  `$repo.docs collect { … }` inside a row → `^docs collect { … }` (depth 1) or
  `0^docs collect { … }` (anywhere); a top-level `$repo.docs count { … }` →
  `docs count { … }`; `$repo.$id` → `^$id` / `0^$id`; a bare `docs` inside a
  block → `^docs`; a frontmatter key named after a target → `frontmatter.<k>`.
  An intrinsic removed and a silent read made an error: part of the 2.0 major.
- 2026-10-10, surface 2.0: **paths on the surface are `/`-rooted** (Brendan's
  decision, §1 "Paths"). Every path a query, a tool or the CLI returns is the
  reference form; every path they accept tolerates both forms; a string
  literal compared with `$path`/`$dst_path` by `==`/`!=` or passed to their
  `startsWith` is rooted first; the keyset cursor carries the rooted path and
  a 1.x cursor is refused. Storage is unchanged — `docs.path`, `spec/store`,
  `spec/sync`, the adapters and the store/sync crates keep the repo-relative
  form; no migration. Every path-bearing expectation of every suite changed
  spelling and nothing else (the `+`/`~` report of the regeneration is
  paths-only: the 1.x cursor inputs were re-encoded, `query-docs::string-methods`
  anchors its regex at `^/texts/`). **Migration:** add the slash — `$path ==
  "x.md"` still matches but `"/x.md"` is the spelling; `$path.startsWith("projects/")`
  → `"/projects/"`; `$path.matches("^texts/")` → `"^/texts/"`; `"/" + ^$path`
  → `^$path`; a `links_stale` `target` is now paste-ready as a `from`; a
  client that parsed `docs_tree`'s `prefix` as a bare directory reads `/` for
  the root; discard stored cursors. A result key changed in meaning: a major.
- 2026-10-09, surface 1.5: **a hit is a store row, and `refs(x)` resolves
  document references held in properties** (§1.3, §1.4). The Lit graph demo
  surfaced it: a timeline note's `before: [/timeline/kickoff.md]` is a list of
  strings, so `… follow before` walked the strings (OQX coerces them to scalar
  rows, correctly) and the runner — which injects `$id`/`$path` reads every
  hit — rendered each as `{ id: "undefined", path: "" }`: silent junk in place
  of a document. Two changes. A top-level row that is not a docs/blocks/nodes/
  edges row now fails the query (`filter_invalid`, the message names the
  value and the remedy; `query-errors::hit-not-a-row-*`); only queries whose
  rows can be anything but store rows — a `follow`, a `from` re-projection, a
  source that is not a bare root scan — carry the check (both runners project
  the row itself alongside `$id`/`$path` for those, so a plain scan pays
  nothing), `values` mode is exempt (no hits), nested rows are unaffected
  (§1.4 rows as values). And a free function `refs(x)` resolves a string or
  list of document references — `/`-rooted paths, bare paths, `d_` ids — to
  live docs rows by indexed lookup, dropping what resolves to nothing, usable
  wherever rows are (`follow refs(before), refs(after)`; `query-refs.json`,
  17 cases; one §7 read). The alchemy corpus grew by two `timeline/`
  documents (after `texts/` bytewise, so every existing id is unchanged);
  21 existing aggregate cases, the §7 expectations (minted ids shift by the
  two documents' revisions, blocks and edges) and `spec/cli`'s alchemy
  workspace changed accordingly. Migration: `follow before` → `follow
  refs(before)`. A function added and a junk result made an error: a minor.
- 2026-10-09, surface 1.4 patch: the query binding follows `spec/oqx` 0.15 —
  the current item is **`$it`** and `$value` is no longer an intrinsic (no
  synonym). `$key` and the recursion intrinsics are unchanged, as is the
  `{ key, value }` record of `entries(x)` used as a plain value. Every fixture
  query was rewritten `$value` → `$it` with its expectation untouched; a
  `$value` in a query now reads a property literally so named (a frontmatter
  key `$value` would surface; none in the alchemy corpus does), absent
  otherwise. No field, tool or result key changed: a patch.
- 2026-10-06, surface 1.4 patch: the query binding follows `spec/oqx` 0.14 —
  `follow` takes a comma-separated destination list (unioned by identity
  within one step) and destination blocks (`follow $repo.docs collect { … }`,
  re-evaluated per frontier row), and `^` inside the follow-local `where`
  reads the frontier row (`^^` the walk's enclosing scope). Three cases
  (`correlated-follow-where-same-type`, `two-destinations-union`,
  `destination-block-equals-doc-in`) pin the new forms. The within-step
  union is keyed by the walk's identity, so under `by <expr>` successors
  sharing a key collapse to the first (`by-rekeys-identity`: magnum-opus's
  three process citations become one `cycle` row). No field, tool or result
  key changed, so `VERSION` stays 1.4 and the crates take a patch.
- 2026-09-30, surface 1.4 patch: `diff_unified` diffs the two revisions'
  reconstructed file texts (what `docs_read_at` returns) instead of the
  Merkle-tree walk (§3, §9). The `diff` string of existing fixtures changed
  — the old text repeated every nested block — but no field, tool or result
  key did, so `VERSION` stays 1.4 and the crates take a patch.
- 2026-09-28, surface 1.4 patch: `docs_move` follows `spec/mutate` 1.3 —
  `retarget_inbound` defaults to `true`, so a bare move rewrites the inbound
  links; §7's `write-docs-create-move` now moves without the argument and
  both engines must produce the rewrite (its expectation is unchanged). No
  field, tool or result key changed (the argument and both result keys
  existed), so `VERSION` stays 1.4 and the crates take a patch.
- 2026-09-27, surface 1.0 specified as built. Last spec of the series: with
  it, a Rust `omgbase` binary can be conformance-tested end to end.
- 2026-09-26, surface 1.1: §7 cross-engine interop — one database, two
  engines, every read tool compared over MCP stdio in both directions — and
  the two test seams (`OMGBASE_SPEC_MINTER`, `OMGBASE_SPEC_CLOCK`) that make
  a committed expectation possible across processes. No field, tool or
  result key changed.
- 2026-09-26, surface 1.1 also: block `$ordinal`/`$depth` reachable (oqx
  0.13), `semantic()` reads the current-context row (search 1.1), and
  `diff_unified` is a Myers unified diff.
- 2026-10-08, implementation note (no spec change): nested blocks over a root
  scan probe SQLite indexes instead of materializing the root (§1). Both
  engines hand the root scan (`^<target>` from a row, a bare target at the
  root scope; `$repo.<target>` before 2.0) to the
  OQX engine as a lazy handle — the reference a `Proxy` over an array, the Rust
  port a marker value (a `Value` has no identity or laziness) that the engine
  resolves through `DataContext::materialize` (oqx 0.14 patch) before it
  observes the value as an operand, argument, key or projected item; in row
  position (a receiver, a `from`, a source, a `follow` destination) the handle
  reaches `to_rows` / `index_for` as handed out, so a probe never runs the
  scan. The handle as a VALUE is pinned by the `lazy-root-*` cases of
  `query-functions.json` (2026-10-09; respelled for 2.0): one array per
  target per run, so `^docs == ^docs` is true and `^docs == ^blocks` false;
  `in` tests the rows (a string is never a member); truthy as a `where`
  scalar; `size(…)`, `.size()` and `entries(…)` see the rows (in row position
  `entries(docs)` yields `(index, row)` entries); `select distinct
  all: ^docs` collapses to one hit whose rows render `{ id, path }`; as an
  `order by` key it is one constant. Both engines produce these results.
- 2026-09-26, surface 1.1 patch: the planner declines the four shapes where
  planned differed from in-memory (§1, §9); no field, tool or result key
  changed, so `VERSION` stays 1.1 and the crates take a patch.
- 2026-09-27, surface 1.4: a `version` tool — which engine, its own version,
  every component's version, the spec versions it was built against, the
  database schema version, the MCP protocol, runtime, commit and build time.
  Pinned by shape (leaf types), since the values are what tell the two
  engines apart. A tool added: a minor.
- 2026-09-27, surface 1.3: `docs_create`/`docs_move`/`docs_delete`/
  `docs_set_meta` take `dry_run` (the CLI's `--dry-run` on `new`/`mv`/
  `rm --doc`/`meta` needed it — `spec/cli` §9); an argument added, a minor.
- 2026-09-26, surface 1.2: rows surfacing as values render `{ id, path }`;
  `docs_get_many`/`nodes_get_many` always return at least one item;
  `blocks_insert`/`blocks_move` take `expect { parent_children_hash }`. Two
  tools gained an argument and one result shape changed from an unpinned
  leak to a defined record: a minor.
