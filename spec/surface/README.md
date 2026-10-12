# The omgbase surface specification

The surface is what a client sees: the OQX **query binding** that exposes the
store's docs, blocks, nodes and links (its open `edges` rows) to the `@omgbase/oqx` engine, the
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
path a query, a tool or the CLI RETURNS is `/`-rooted — `path` on every
target and `dst_path` on links, the `path` of every hit and of a row rendered as
a value (§1.4), `docs_list`/`docs_tree` rows and the tree's `prefix` (`/` for
the root), `docs_read`/`docs_read_at`/`docs_read_many`, every
history, link-health, search, document-operation, `apply`, `observe` and
`changes_since` path (the digest's `revisions`, deletions and moves, the
`summary` included) — and every path they ACCEPT tolerates both forms: a
missing leading `/` is added, an extra one is stripped (`docs_read` of
`/a.md`, `a.md` or `//a.md` is one document; a `path_glob`, a `docs_tree`
prefix, `roots`, `docs[]`, `refs(x)`, `within(…)` likewise). In a query, a
**string literal** compared with `path`/`dst_path` by `==` or `!=`, or
passed to their `.startsWith(…)`, is rooted before evaluation, so `path ==
"a.md"` and `path == "/a.md"` both match and `path.startsWith("dir/")`
keeps working — the read may be bare (`path`, `^path`) or through a ROW
handle (`doc.path`, `block.path`, `$it.path`); nothing else is rewritten — a
property's value is the author's (`where customer == ^path` compares the
authored reference directly, `where ^path in list(after)` is the reverse of
`refs(after)`, `where data.path == "/x.md"` reads the author's `path:` key as
written — a literal against a source handle is never rooted, 3.0), a regex
(`matches("^/texts/")`), `contains`, `endsWith` and a binding read the
string as it is. Storage is unchanged: `docs.path` stays repo-relative, no
migration, and the pushed SQL and the store-index probes de-root the literal
(or root the column) so planned and in-memory agree (`query-docs::path-*`,
`query-links::dst-path-*`, `query-refs::reverse-reference-by-path-membership`,
`reads::alchemy`).

Both implementations run the same tier-3 planner (the pushable top-level
`&&`-conjuncts of a bare root scan become one SQL statement; the residual
finishes in memory over the produced rows). Both also answer a **nested
block's equality probe over a root scan** from the store's indexes
(implementation note, 2026-10-08: `oqx-js/store-index.ts`,
`omgbase-surface::store_index`): a root (`^<target>` from a row, a bare target
at the root scope) is handed to the engine lazily and a block whose top-level
conjunct is `local == outer` — `^docs collect { where customer == ^path
}`, `^links exists { where dst_id == ^id }`, `^docs single { where
type == "x" }` — is served by one indexed statement per probe (docs `id`,
`path`, `title`, any property key by typed value; blocks `id`, `doc_id`,
`type`, `path`; nodes `id`, `doc_id`, `kind`, `name`, `path`; links
`id`, `doc_id`, `dst_id`, `path`, `dst_path`) under the root scan's guards and
order, so the root is never read whole; an absent probe or an unindexed path
reads it once. A `path`/`dst_path` probe de-roots a rooted value before the
statement and answers no row for a bare one (the intrinsic is the reference
form, 2.0), as the translator renders the column `'/' || d.path` and takes
the indexed `d.path IS ?` fast path only for a rooted constant. Results are unchanged — the §6 fixtures and the conformance
lists are the gate — only the work is. Invisibility is kept by
**declining** rather than by cleverness; since the 1.1 patch of 2026-09-26
(§9) the planner declines, in both translators:

- a comparison whose operand kinds are not **provably comparable the same
  way** in SQLite and in memory. Operand kinds: *text* (a string literal or
  binding, a text column or intrinsic, `lower()`/`upper()` output), *int*
  (an integer column: a block's `ordinal`, `depth`), *num*, *bool* and *null*
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
  handle, whole source handle or the `attrs` bag** of the target (§1.2:
  `blocks`, `nodes`, `out`, `in`, `out_links`, `in_links`, `data`,
  `frontmatter`, `inline`, `doc`, `children`, `section`, `block`,
  `subsections`, `attrs`, …) — it is not a property read. A **key read
  through a source handle** IS pushed (3.0, batch 3): `data.<k>` translates
  exactly as the bare property `<k>` (the same single-scalar-row subquery —
  identical semantics by definition), `frontmatter.<k>` / `inline.<k>` as the
  same subquery with `p.source = '<source>'` added to both its row condition
  and its row count, on `docs` and through `doc.` on the other targets
  (`query-docs::source-handle-pushdown-*`, `query-blocks::planned-doc-handle-read`);
  `entries(<handle>)`, a deeper member chain (`data.meta.owner`) and a
  whole-handle reference stay residual;
- the **whole query**, when any residual conjunct could raise an OQX eval
  error the pushed conjuncts might hide by emptying the scan: a residual
  that contains any function or method call, a nested block with the
  `single` consumer or a `^`-escaped name sends the query to the in-memory
  engine unplanned (before batch 3 of 3.0 a bare docs `id`/`path`/… was a
  loud error and counted here; it is now the attribute, a plain read). Only a residual made of
  comparisons, logical operators, `in`, `!`, literals, bindings and plain
  reads keeps the pushed conjuncts.

**Foreign-key elimination (3.0).** A reach-through read that names the
owner's identity — `doc.id` and `doc.path` on a block, a node or a link,
`block.id` / `block.path` on a node — is answered from the row's own
foreign-key column or the scan's already-joined document column, never by
loading the owner: in SQL `doc.id` on blocks is `b.doc_id` (nodes `n.doc_id`,
links `e.src_doc`), `doc.path` is the joined `d.path` the scan carries, and
`block.id` on nodes is `n.block_id`; in memory the reach-through hands out a
lazy owner row whose `id`/`path` come from the child row, so `doc.id` and
`doc_id` cost the same statement (none) and plan to the same SQL. Any other
read through the owner (`doc.layer`, `block.text`) still reaches it. A link's
`dst.<k>` (3.0 follow-up, §1.2) pushes down like `doc.<k>`: a property read
scopes `properties` by the row's own `e.dst_node`, and `dst.id` / `dst.path`
/ `dst.hash` / `dst.updated_at` / `dst.format` are a primary-key probe of the
destination (`(SELECT … FROM docs dd WHERE dd.doc_id = e.dst_node)`) — NULL
wherever `dst` is absent in memory; `dst.raw` / `dst.title` / `dst.tags` and
the relations stay residual, as `doc.*`'s do. `dst` is a row handle for the
path rule (§1 "Paths"): a literal compared with `dst.path` is rooted like one
compared with `dst_path` (`query-links::dst-identity-reads-the-foreign-key`,
`::dst-filter-pushes-down`, `::dst-path-literal-rooted`).

The differential (every corpus-backed query case run planned and in-memory)
proves each decline: `query-errors::planned-*` and the `planned-*` cases of
`query-blocks.json` / `query-docs.json` pin the shapes above.

### 1.1 Roots and rows

`from docs | blocks | nodes | links` — and, from inside a row, `^docs | ^blocks
| ^nodes | ^links` (the root row, below) — scan the repo's **live** rows in a
fixed order:

| root | rows | order |
| --- | --- | --- |
| `docs` | `docs` with `deleted_commit IS NULL` | `(path, doc_id)` |
| `blocks` | live blocks of live docs | `(doc path, block_id)` |
| `nodes` | `nodes` of live docs | `(doc path, node_id)` |
| `links` | open `edges` rows (`to_commit IS NULL`) of live source docs — the link RELATIONS, §1.2 | `(source doc path, edge_id)` |

**The repository is the root row** (2.0, with `spec/oqx` 0.18 §2). The root
scope's names are the four scans above and **`id`**, the repository id; the
root scope's **row** (`DataContext.rootObject` / `root_object`) is the root
object, whose entries are exactly the four collections in that order (`id`
is an intrinsic of it, not an entry). So from a top-level row `^docs` is the
documents scan and `^id` the repository id; from a block's rows one caret
deeper (`^^docs`), or the absolute `0^docs` / `0^id` from any depth; `^$it`
is the root object, `^$it.docs` the same handle as `^docs` (a receiver, a
value, a probe), `entries(^$it)` yields `docs`, `blocks`, `nodes`, `links`
(`query-root.json`). At the root scope a bare target name is the scan — the
receiver of a top-level directive (`docs count { … }`), `from docs`,
`entries(docs)` — because a bare name there is `root(name)`.

Two spellings are **refused** as `filter_invalid`, before any row is read, so
the error is the same whether or not a row would have reached them and the
planned and in-memory paths agree trivially (`query-root::repo-removed-*`,
`bare-target-*`):

- **`$repo`** (an intrinsic of every scope before 2.0) anywhere — bare, as a
  member head (`$repo.docs`, `$repo.id`), `^$repo`, `0^$repo` — with the
  message `` `$repo` was removed in surface 2.0 — reach the repository's
  collections through the root row: `^docs` from a top-level row (one caret
  per enclosing block, or the absolute `0^docs`), and the repository id as
  `^id` / `0^id` ``.
- **A bare target name inside a block** — at scope depth ≥ 1 (a top-level
  row's clauses, a block's body, a `from E` re-projection, a `follow`
  destination), where a bare name reads a property of the current row, which
  has none — with the message `` `docs` inside a block reads a property of the
  current row, which has none — did you mean `^docs` (the repository's
  documents)? `` (the carets count the depth: `^^docs` from depth two).
  `docs` and `links` are no row's relation, so they are refused statically.
  `blocks` and `nodes` ARE relations of some rows (`docs.blocks`,
  `docs.nodes`, `blocks.nodes`, `section.blocks`, §1.2) and stay those; on a
  row that lacks the relation (`blocks` on a block or link row, `nodes` on a
  node or link row, `block.blocks`) the context raises the same error when
  the name is read, the hint spelling the rule (`one caret per enclosing
  block, or the absolute 0^blocks`). Consequence: a frontmatter key named
  `docs`, `blocks`, `nodes` or `links` is unreachable by bare name — read it
  as `frontmatter.<k>`. The planner declines a bare target name as a property
  read and treats one that could raise as a residual that may raise (§1), so
  a pushed conjunct cannot hide the error.
- **A `^<target>` with more carets than enclosing scopes** — `^docs count { }`
  at the top level, `^^links` from a top-level row — which `spec/oqx` §2
  reads as absent (so the count would be a silent 0), with the message
  `` `^docs` reaches past the root — there is no enclosing row at this depth;
  at the top level the repository's documents are the bare `docs` (`docs count
  { … }`, `from docs`, `entries(docs)`) `` (statically, by the same walk;
  `query-root::root-caret-past-the-root*`). Only the four target names: any
  other outer reference past the root keeps the language's absent.
- **A top-level `from <name>` that is no collection** (3.0 name pass) —
  `from edges`, `from nope` — would scan an absent root and come back empty;
  refused with `` `edges` is not a target — the repository's collections are
  `docs`, `blocks`, `nodes`, `links` (`edges` was renamed `links` in surface
  3.0) `` (the parenthesis only for `edges`;
  `query-errors::edges-is-not-a-target`, `::unknown-target-is-loud`).

A row's **identity** — `$key` (spec/oqx §16; `distinct`, `follow` cycles, `is`)
— is its id column. A
relation returns rows of its successor target; a scalar reach-through
(`doc`, `block`) returns one row.

### 1.2 Fields, intrinsics, reach-through, relations

**The name rule (3.0, normative).** `$` belongs to OQX: `$it`, `$key`,
`$depth`, `$stop`, `$leaf`, `$frontier`, `$ordinal` are values the LANGUAGE
injects into a scope (`spec/oqx` §2), and omgbase adds **no `$` names** — a
`$id` or `$path` in a query is an unknown OQX identifier, absent
(`query-errors::dollar-names-are-not-omgbase-names`). **Every engine attribute
is bare, snake_case, and wins on collision** — the convention the relations
(`children`, `blocks`, `out_links`, `doc`, `frontmatter`, …) always followed:
a bare name that is an engine attribute reads the engine's value, never the
author's. **User data is bare too; where it collides, it is reached through a
handle.** A document has three *source handles*, all bare engine names:
`data` (the merged authored view — frontmatter + inline by the property rule
below, i.e. exactly the read a bare non-colliding key performs),
`frontmatter` and `inline` (one source each). `data.path` is the author's
`path:` key, `data.data` the author's `data:`, `data.title`/`data.tags` the
authored title and tag list; `entries(data)` lists every authored top-level
key (frontmatter ∪ inline, keys deduped, `key` order). There is **no
loud-error set**: a bare `id`, `path`, `updated_at`, `hash` or `raw` is simply
the engine's attribute (before batch 3 of 3.0 the attributes were `$`-prefixed
and the bare spelling was "did you mean `$path`?", §9). **Same value, same
name, everywhere**: language, results, arguments and errors spell an attribute
alike — a hit is `{ id, path, …projection }` (§1.4), `docs_read` is `{ id,
path, rev, properties, raw }`, `blocks_read { id }` takes the `id` a hit
carries, `doc_missing` says `no document with id or path "…"`; a key naming a
*role* in a result (`rev`, `from`/`to`, `before`/`after`, `locator`, `cursor`,
`expected_content_hash`, `baseRevision`) keeps its own name (§2–§4). Inputs
follow §4 "Arguments": a tool's prefix names the row kind it addresses and
`id` / `path` in its arguments are that kind's attributes; the kernel-op
grammar (`block`, `blocks`, `to`, `at`, `expect.content_hash`, `op`) is
spec/mutate's and is unchanged.

**Reserved bare names per kind** (an authored key with any of these names is
reached as `data.<k>` — or `frontmatter.<k>` / `inline.<k>` by source; on a
block or node as `attrs.<k>`):

| kind | attributes | handles | self | relations |
| --- | --- | --- | --- | --- |
| docs | `id` `path` `raw` `hash` `updated_at` `title` `tags` `format` | `data` `frontmatter` `inline` | `doc` | `blocks` `nodes` `out_links` `in_links` |
| blocks | `id` `path` `doc_id` `raw` `hash` `updated_at` `type` `text` `attrs` `depth` `ordinal` | — | `block` (+ `doc`) | `children` `nodes` `out_links` `section` |
| nodes | `id` `path` `doc_id` `block_id` `kind` `name` `value` `attrs` | — | `section` (+ `doc`, `block`) | `blocks` `subsections` `children` |
| links | `id` `path` `doc_id` `block_id` `via_id` `dst_id` `dst_path` `uri` `field` `dst_kind` `predicate` `provenance` `anchor` | — | — (`doc` reaches the source, `dst` the destination document) | `doc` `dst` |
| root | `id` | — | — | the four collections (§1.1) |

Language words that can never be a bare field: `select from where is not and
or`, the literals `true false null`. Contextual words (`limit order offset
follow collect count first distinct desc by in`) parse as fields in
expression position (`select o: order, l: limit from docs`;
`query-docs::contextual-words-are-fields-in-expression-position`,
`reads::bare-attributes`).

`raw` is the exact source bytes of the thing and `hash` is their SHA-256
as 64 lowercase hex: a document's `raw` is the reconstructed file
(`spec/store` §6.1, frontmatter included) and its `hash` the `file_hash`
(null when none); a block's `raw` is its raw source — the `blobs` row its
`raw_hash` names, a container's raw holding its children verbatim
(`spec/format`) — and its `hash` the hex `raw_hash`. `text` (the
normalized text) is a plain field of blocks; there is no `body` and no
`content` attribute (both are ordinary property reads,
`query-errors::bare-body-is-an-absent-property`). `path` on every kind is the
path of the document the row lives in (blocks and nodes: the owner; links:
the source document), the reference form (§1 Paths). `title` on docs is the
**computed** title — the `$title` row `spec/properties` §3.3 stores (the
first H1's text; null when none); `tags` is **the union of the authored tags
and the body `#hashtags`**: the authored `tags` key read by the property rule
(a scalar is one element) followed by the computed `$tags` row (hashtags in
document order), deduplicated by value with the first occurrence kept, null
when both are absent (`reads::bare-attributes`: `tags: [alpha, beta]` +
`#beta #gamma` → `["alpha", "beta", "gamma"]`). The stored computed rows keep
their `$` keys (`spec/properties` is unchanged); the surface renders them
bare — in the language as `title`/`tags` and in `docs_read`'s
`properties.computed` as `{ title, tags }` (§2).

**docs.** Attributes: `id` (doc id), `path` (the reference form, `/a/b.md`
— §1 Paths), `hash` (hex of `file_hash`, null when none), `updated_at`
(the current revision's commit `ts`, null when none), `raw` (the
reconstructed file, `spec/store` §6.1), `title`/`tags` (above), `format`
(the format column). `data` / `frontmatter` / `inline` are **source
handles**: `frontmatter.<k>` reads the key from that source only, `data.<k>`
from both authored sources by the property rule below (so `data.layer` ≡
`layer`, and `data.path`/`data.title`/`data.tags`/`data.format` reach the
authored keys the attributes shadow); `entries(<handle>)` yields one entry
per **top-level** key in `key` order (bytewise; `data` dedups the keys of
both sources), dotted keys folded back into nested objects, each valued by
the property rule. The handles are lazy (a marker; one indexed `properties`
lookup per key read, nothing materialized until `entries`). Any other bare
identifier is a **property** (`spec/properties`): the rows of that key
across authored sources (frontmatter + inline, `ord` order) — exactly one
row with `card = scalar` → the decoded scalar; otherwise the array of
decoded values; no row → the nested object rebuilt from keys under `<k>.`
(undefined when none). `doc` is the row itself. Relations: `nodes` (the doc's nodes in **document
order**: block-less nodes first, then by the owning block's pre-order rank,
then `span_start`, then `node_id` — §9), `blocks` (live, **document order**:
pre-order over the tree — §9), `out_links` / `in_links` (open edges, `(predicate,
edge_id)` order). There is **no `out` / `in` relation** (3.0 follow-up, §9):
the documents a doc links TO are its link rows' destinations, `out_links
collect distinct { from dst }`, and the documents linking to it their
sources, `in_links collect distinct { from doc }` (`from` over an absent
`dst` — an external link, a dangling `[[wikilink]]` — contributes no row);
the citation walk is `follow out_links collect { from dst }` /
`follow in_links collect { from doc }`, with `depth`/`frontier` as clauses of
the block (oqx 0.20: `… collect { from dst depth 2 }`) and a body-level
`frontier <pred>` before `follow` applying to the seeds
(`query-follow::body-frontier-keeps-seeds-unexpanded`). A bare `out`
or `in` on a doc reads an authored property like any other unknown name
(`query-docs::linked-docs-through-out-links`,
`::linking-docs-through-in-links`, `::out-and-in-are-plain-properties`).

**blocks.** Attributes: `id`, `path` (owning doc's path), `raw` (the
block's raw source bytes), `hash` (hex `raw_hash`), `updated_at` (the
latest commit `ts` among the block's `block_changes`, null when none),
`doc_id` (the owning document's id), `type`, `text`, `attrs`
(parsed), `ordinal` (the block's 0-based ordinal among its siblings — the
`ordinal` column), `depth` (its nesting depth, 0 at the top level — the
`depth` column); any other bare identifier reads `attrs.<k>` (undefined when
absent; the attributes win on collision — an `attrs.path` key is reached as
`attrs.path`). The recursion intrinsics of
a `follow` (`spec/oqx` §2: `$depth`, `$ordinal`, `$stop`, …) are metadata of
a walk occurrence only and never name a block column — inside a `follow`
`$depth` is always the walk's, and a block's own nesting is `depth`
everywhere (before 3.0 the two shared a name and the walk's shadowed the
block's, §9). `block` is the row; `doc` the owning doc. Relations:
`children` (live, `(ordinal, block_id)`), `nodes` (nodes anchored to the
block, `(span_start, node_id)` order), `out_links` (open edges from the
block, `(predicate, edge_id)`), `section` (the `md:section` nodes whose
`[first_ordinal, last_ordinal]` contains the block's **top-level ancestor's
ordinal**, by `(first_ordinal, node_id)`).

**nodes.** Attributes: `id` (the node id), `path`, `doc_id`,
`block_id` (null for a block-less node), `kind`, `name`, `value`, `attrs`;
other bare identifiers read `attrs.<k>`. `section` is the row; `doc` and
`block` reach through (`block` undefined when the node has none). Section
relations (a node read as a section; empty when it has no `first_ordinal`):
`blocks` (live blocks whose top-level ancestor's ordinal lies in the range,
in document order), `subsections` (`md:section` nodes contained in the range
with a greater `level`, by `(first_ordinal, node_id)`), `children`
(contained deeper sections with **no** intervening section of a level
strictly between, same order).

**links** (`edges` before the 3.0 name pass, §9)**.** One row per link RELATION — the
open `edges` row the graph layer keeps (`spec/graph`): the `md:link` /
`md:wikilink` NODE is a link's syntactic occurrence in the text (a `nodes`
row), the `links` row is the relation it establishes, `via_id` points from the
row at that node, and a frontmatter or inline-field link has a row and no
node. Attributes: `id`, `path` (the source doc's path),
`doc_id` (the source document), `block_id` (the source block, null for a
frontmatter edge), `via_id` (the `via_node`, null unless the edge was
derived through another node), `dst_id` (the destination node id: a doc id,
an external node id or `phantom:<path>`), `dst_path` (the target doc's path,
null when not a doc; the reference form), `uri` (the external node's URI,
null otherwise), `predicate`, `provenance`, `dst_kind`, `anchor`, `field`
(the frontmatter key or inline field the edge was authored in, null for a
link). Two reach-throughs: `doc` is the SOURCE document (the row `doc_id`
names), and `dst` (3.0 follow-up) is the DESTINATION document — the docs row
`dst_id` names when `dst_kind == "document"` and that document exists
(`dst_path` already names it; resolved by `dst_id` exactly as `dst_path` is),
absent (`undefined`) for a `block` or `external` destination and for a phantom
(the kind with no row). `dst` never reaches into a block. So `dst.title` is
the destination's computed title, `dst { title }` a one-element list (or
empty), `dst values` the row as `{ id, path }` (or null), `out_links exists {
where dst.layer == "draft" }` a doc-level filter on what is linked to, and
`dst.id` / `dst.path` read `dst_id` / `dst_path` wherever `dst` exists
(`query-links::dst-reach-through`, `::dst-block-sugar`,
`::dst-identity-reads-the-foreign-key`, `::dst-filter-pushes-down`,
`::dst-path-literal-rooted`; `reads::dst-on-links` for an external link).
The creating commit
(`from_commit`) is not a field: a query sees open edges only and the commit
is history (`blocks_history`, `changes_since`), §9.

### 1.3 Functions

Free: the `spec/oqx` builtins, plus `entries(<source handle>)` (§1.2: `data`, `frontmatter`, `inline`),
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
a directive receiver (`refs(see_also) collect { path }`, `refs(before) exists
{ where path == "x" }`), a `follow` destination (`follow refs(before),
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
  nodes → the node's FTS row matches; links → `filter_invalid`.
- `semantic("phrase")`: docs/blocks only (else `filter_invalid`); the phrase
  must have been embedded for this query (`provider_unavailable` when no
  provider, §4); the score is `cosine` over the row's stored vector for the
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
- otherwise **every hit is `{ id, path, ...projection }`** (3.0): the
  row's identity under the *same* bare names the expression language reads,
  injected first, then whatever `select` projected. The envelope keys are
  the attributes, so a key copied from a hit is valid in the next `where`
  with no translation — `select id from docs where id == "d_14"` returns
  `{ id: "d_14", path: "/substances/salt.md" }` (`query-docs::hit-envelope-round-trip`,
  `reads::hit-envelope-round-trip`, §7 `read-query`). **Projections may not
  overwrite the envelope**: `select id, path` is simply the envelope (the
  attribute collapses onto its own key, never a duplicate column —
  `query-docs::select-id-path-is-the-envelope`; an alias of the attribute
  onto its own name, `id: id` / `path: path`, likewise —
  `::aliases-onto-the-envelope-of-the-attribute-itself-collapse`), and any
  OTHER projection whose output key would be `id` or `path` — `select
  data.path` (the author's key), `select path: doc.layer`, `select path:
  doc.path` on a block — is a loud `filter_invalid` asking for an alias:
  "projection `path` collides with the hit envelope — alias it (`p:
  data.path`)" / "projection `id` collides with the hit envelope — alias it
  (`i: data.id`)" (`query-errors::envelope-collision-*`; checked over the
  resolved select items before the engine runs, the first offending item in
  select order; `values` mode has no envelope and is exempt). Before batch 3
  of 3.0 the envelope was `$id`/`$path` and `id`/`path` were ordinary
  columns; before 3.0 the envelope spelled `id`/`path` while the language
  rejected the bare names and a user column named `id` or `path` overwrote
  it (§9). `first`/`single` return zero or one hit, no cursor.
- **A hit is a store row (1.5).** Every top-level row of a `collect`, `first`
  or `single` query must be a docs, blocks, nodes or links row; a query whose
  rows reach anything else — `follow before` over a frontmatter list of paths
  (the strings), a block re-projected to scalars (`docs collect { select
  $it from tags }`) — fails as `filter_invalid` with the message `` a hit must
  be a document, block, node or link row — the query reached a string
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
  projection (every key but the envelope's `id`/`path`; first wins), the
  query's own `limit`/`offset` (integer literals only, else `filter_invalid`)
  bound the set after that, then the page: with the default order the keyset
  cursor `(path, id)` — the hit's `path`, so the reference form, and its
  `id` — skips rows at or before the cursor, `cap = limit`, `truncated` =
  more remained, `cursor` = the last hit's `(path, id)` when truncated; a
  custom `order by` disables the cursor (the top `cap` is returned,
  `truncated` still honest). The cursor encodes the two *values*, never key
  names, so a 2.x cursor stays valid on 3.0
  (`reads::hit-envelope-round-trip` pages with one).
- `values`: the single projected item is returned as `values: [...]` with
  `hits` empty — no hits, so the envelope does not apply
  (`query-docs::values-mode-is-unchanged-by-the-envelope`).
- **Rows as values (1.2).** Wherever a row surfaces
  as a *value* rather than as a hit — a nested `collect { }` / `first { }` /
  `single { }` with an empty projection (`spec/oqx` §12: "the row itself"),
  or a `values` projection of a row — it is rendered as `{ id, path }`
  (the row's id column and its document's path), never the store row (§9:
  before 1.2 the raw row leaked, `attrs` as a JSON string and the join
  column `__path` included). One notation for "a document, block, node or
  edge reference" everywhere a row shape appears in a query result: the hit
  envelope and a row-as-value spell identity the same way
  (`query-docs::rows-as-values-are-id-path-refs`). Hits are otherwise
  unaffected: `{ id, path, ...projection }` as above.
- **One notation everywhere (3.0).** The envelope is not only the `query`
  tool's: every tool result that renders a document, block, node or link row
  names it the same way — `id`, `path`, and where the result carries the
  row's bytes or hash `raw`/`hash`, its time `updated_at` (§1.2 "same
  value, same name"; §2–§4 list every shape). `docs_list` items are
  `{ id, path, updated_at, blocks }`, `docs_read` is `{ id, path, rev,
  properties, raw, … }`, `graph` documents `{ id, path, degree, … }`,
  `blocks_search` hits `{ id, doc_id, path, … }`, `blocks_resolve` `{ id, locator,
  … }`, a `changes_since` or `apply` revision `{ id, path, hash }`,
  `blocks_read` `{ id, type, … }` (`reads::hit-envelope-round-trip` closes
  with a `docs_list` and a `blocks_read` showing the shared spelling). Before
  3.0 each tool had its own (`path`, `docId`, `blockId`, `contentHash`, …).
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
- **`docs_read(id? | path?, include_ids?)`**: `{ id, path (reference form), rev,
  properties (grouped, spec/properties §5 — with the `computed` group's keys
  spelled as the attributes that read them, `{ title, tags }`, the stored
  `$title`/`$tags` rows re-keyed at this boundary; the authored groups
  verbatim, an authored `$x:` key keeping its sigil), raw (spec/store §6.1 —
  the document's `raw`, §1.2) }` + with ids `ids` (pre-order), `hashes` (a map
  block `id` → block `hash`), `parents` (block `id` → parent `id` or
  null); the two maps keep their id-keyed shape. `docs_read_many(refs, include_ids?, budget_tokens?)`:
  first-seen dedup, cap 100 (`truncated`), a miss → `errors: [{ ref, error:
  "doc_not_found" }]`, the budget (`ceil(JSON length / 4)` per item) stops
  early with `truncated` — but **at least one item is always returned**
  (1.2, the uniform list contract of `docs_list`/`docs_tree`: the budget
  is checked before the second item onward; a first item that alone exceeds
  it is still emitted and the batch is `truncated` if more remained). `docs_read_at(id? | path?, rev)`: `spec/store` §6.2 as
  `{ id, path (the path as of that revision), rev, raw, renderedHashMatch,
  properties (current), propertiesAreCurrent: true }`.
- **`blocks_read(id, resolution = full)`** (`nodes_get`, then `blocks_get`,
  before 3.0 — it always took a block id and returned a block; `nodes` now
  names the extracted-entity rows and `read` is the one verb for "return the
  row", §9): the block subtree projected at a resolution — `skeleton` `{ id, type, label = heading text or type }`,
  `outline` `{ id, type, label = first 12 words… }`, `text` `{ id, type,
  text }`, `raw` `{ id, type, raw, hash }`, `full` (`raw`, `hash`,
  `text`, `attrs`, then the placement flattened onto the row: `ordinal`,
  `depth`, `parent_id` (null at the top level)); `children` recursively. The
  block's `raw`/`hash` are the row attributes of §1.2 (`hash` is the value
  an `update`/`split` op expects as `expect.content_hash`); the owning document
  is inferred from the id (the `doc`/`path` scope arguments are gone, 3.0);
  `id` is a BLOCK id — the `blocks_` kind's attribute (§4 "Names and
  arguments") — so an `n_` node id is `block_missing` "no block with id \"n_…\"
  (an n_ id names a node — nodes_block_read reads its block)" (3.0 follow-up,
  §9; the name pass had dereferenced it here). **`nodes_block_read(id,
  resolution = full)`** (3.0 follow-up): `id` is a NODE id; the result is
  exactly `blocks_read`'s for the block the node was projected from — same
  shape, same resolution ladder and default. An unknown node is
  `block_missing` "no node with id \"…\""; a node naming no live block (a
  block-less node, e.g. one derived from the frontmatter) is `block_missing`
  "node \"n_…\" has no block" (`data: { id, doc_id }`)
  (`reads::resolution-ladders`). `blocks_read_many(ids, resolution =
  text, budget_tokens?)` (`nodes_get_many`, then `blocks_get_many`, before 3.0): cap 100, request order, no children, `unresolved` for ids
  naming no live block, `truncated` on the cap or the budget; at least one
  resolved block is always returned (1.2, as `docs_read_many`).
- **`docs_outline(id? | path?, resolution = outline, depth?, budget_tokens?)`**:
  one line per block, `"  " × depth + id + " " + type label padded to 4 +
  " " + label`, `"  §"` appended for headings, trailing spaces trimmed; type
  labels `h<level>`, `p`, `ul`, `li` (list items and tasks), `bq`, `code`,
  `tbl`, `tr`, `hr`, `html`, `raw`; labels: containers `""`, tasks `☐`/`☑` +
  ten words, others ten words (`…` when cut), `skeleton` none; `depth`
  limits nesting; the budget (`ceil(line length / 4)`) truncates.
- **`docs_list(path_glob?, limit = 200, cursor?, budget_tokens?)`**: live
  docs by path, `path LIKE glob` (`*` → `%`, `%`/`_`/`\` escaped; the glob
  in either form), rows `{ id, path (reference form), updated_at (the
  current revision's commit ts or null), blocks (live count) }`, fetched
  `limit + 1`, keyset cursor `[path]` (values, so unchanged by the 3.0 key
  names), budget as above (at least one row). **`docs_tree(path?, depth = 1,
  …)`**: the prefix normalized (either form accepted; reported rooted — `/`
  for the repo root, else `/<dir>/`); every live doc under it collapsed at
  `depth` segments into `dir` entries (`{ path (rooted, ending `/`), kind:
  "dir", docs, blocks, updated_at (the max under it) }`) or `doc` entries
  (`{ id, path, kind: "doc", docs: 1, blocks, updated_at }`); `total` over
  everything under the prefix; ordered by path and paged the same way.

## 3. History

Result keys in §2–§4 are written as they appear on the wire: a row attribute
is its bare name (`id`, `path`, `hash`, `updated_at`, `raw`, §1.2), a
foreign key its snake_case name (`doc_id`, `parent_id`), and the remaining
role keys keep the reference's **camelCase** (`isCurrent`, `hasSource`,
`currentRev`, `renderedHashMatch`, `propertiesAreCurrent`, `commitId`,
`baseRevision`, …); the fixtures pin the wire verbatim.

- **`blocks_history(id, limit = 100)`** (`history_node` before 3.0): the
  block's `block_changes` joined to commits and dispositions, newest first:
  `{ commitId, seq, ts, origin, kind, confidence, reason }` (a change record,
  not a row: unchanged in 3.0).
- **`docs_diff(id? | path?, from_rev, to_rev)`** (`diff { doc_id? | doc_path? }` before 3.0): both revisions must belong to the doc,
  else `target_missing` (§9: the reference treated an unknown revision as
  empty and reported every block removed); block-grain — the id → raw maps
  of both revisions' Merkle trees (all depths); entries `removed` (in from
  only), `changed` (raw differs), `added` (in to only), in that order, each
  `{ kind, id (the block), before?, after? }`. **`docs_diff_unified(id? | path?, from_rev?, to_rev?)`** (`diff_unified` before 3.0):
  defaults to the previous and current revisions (`target_missing` when
  none); `{ id, path, from, to, diff }` where `diff` is a **unified diff** of the
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
  `summary` unpinned) — each digest's `revisions` are `[{ id, path, hash
  }]` (the document, its path as of the commit, the revision's rendered
  hash — the same three keys an `apply` revision carries, §4), every path in
  a digest, the `summary`'s subject included, in the reference form (2.0).
- **`docs_history(path_glob | id | path, include_deleted?, limit = 50)`**: docs by
  path (glob as `docs_list`; a glob without `*` is an exact path), live only
  unless `include_deleted`, `limit + 1` for `truncated`; each `{ id, path
  (reference form), deleted, currentRev, versions: [{ rev, seq, commit,
  updated_at (the commit's ts), origin, actor, hash (the rendered hash),
  isCurrent }] }` oldest first.

## 4. The MCP tool catalog

Served as MCP over stdio; every result is one text content item holding
JSON; an error result has `isError: true` and the envelope `{ error: <code>,
message, data?, retriable }`. Codes: `spec/mutate` §8 plus `filter_invalid`
(OQX and cursor errors, `data: { reason, hint }`; argument-shape errors,
`data: { reason, hint: "arguments" }`), `budget_exceeded`,
`provider_unavailable` (3.0; `semantic_unavailable` before), `embedder_failed`,
`repo_not_found`, `ambiguous_heading`, `block_not_container` (3.0),
`conflicted_document`, `ambiguous_locator`, `seed_unresolved`. Any other
failure is `repo_not_found` with the message (§9).

**Names and arguments (3.0, normative).** A tool's prefix names the row
kind it addresses — `docs_`, `blocks_`, `nodes_`, `links_` — and `id` /
`path` in its arguments are that kind's attributes: `docs_read { id?, path?
}`, `docs_diff { id?, path? }`, `blocks_read { id }` (a block id — never a
node's), `nodes_set { id }` and `nodes_block_read { id }` (the two tools that
address `nodes` rows; the latter dereferences a node to its block, so each
tool's `id` is unambiguously its namespace's kind — 3.0 follow-up, §9). A handful of repo-level operations
have no kind prefix (`query`, `query_syntax`, `graph`, `changes_since`,
`apply`, `plan`, `execute` (3.1), `observe*`, `repos*`, `sync_status`, `version`). One verb returns
the row: **`read`** (`docs_read`, `docs_read_many`, `docs_read_at`,
`blocks_read`, `blocks_read_many`). No tool refers to a document of another
kind, so no argument is a foreign key; were one added it would say `doc_id`
/ `doc_path`. List and mixed-reference arguments keep role names (`ids`,
`docs`, `roots`, `to`, `blocks`, `at`); the kernel-op grammar
(`block`, `blocks`, `to`, `at.before|after`, `expect.content_hash`, `op`) is
spec/mutate's and is unchanged; `observe { path, content }`,
`observe_many.files[].path`, `observe_delete.path` are FILE events from the
store's layer, not row locators, and `docs_tree.path`, `docs_list.path_glob`,
`links_repair.path_glob` and `docs_create.path` are role arguments. The bare
argument name `doc` no longer exists. The names are bare (not `id`/`path`)
because the attributes themselves are becoming bare — surface 3.0 attribute
flip, follow-up. A `docs_*` locator takes at least one of `id`/`path` (else
`filter_invalid` "pass id or path"); both given must name the same document
(else `filter_invalid` "id "…" and path "…" name different documents"); a
miss is `doc_missing` "no document with id or path "<value>"" with the
arguments as given in `data`; a block the caller named that is not live is
`block_missing` "no block with id "<value>"", a node "no node with id …".
Every call's shape is checked before its handler, in both engines alike: an
unknown argument name is `filter_invalid` naming the nearest valid one —
"unknown argument `q`; did you mean `query`?" (Levenshtein ≤ 2 or a prefix
either way; the names 3.0 retired name their replacement: "`doc` is no
longer an argument — pass `id` or `path`", `block`/`node` → `id`, `heading`
→ `section`, `markdown` → `text`) — a missing one "`query` is required", a
mistyped one "`limit` must be an integer" (`a string`, `a boolean`, `an
object`, `an array of strings|integers|objects`, `one of a, b, c`), each
followed by the tool's shape in bytewise order with `?` on the optional
names: "(docs_read takes id?, include_ids?, path?, repo?)"; a tool with none
"takes no arguments". The unknown-name check runs first (bytewise order of
the names given), then presence and type per declared name (bytewise); the
nested shapes (`apply.ops`, `expect`, `at`) are each engine's own. The
messages above are pinned by the fixtures (§6).

**Repo scoping.** Every repo-scoped tool takes an optional `repo` slug;
omitted → the server's default repo; unknown → `repo_not_found`. A repo's
root is derived (`spec/sync` §1); a mutating tool on a sourceless repo fails
`repo_not_found` ("mutation disabled").

**Ref resolution (server side).** `id` is looked up by id only and `path`
by path (either form, §1 Paths) — never one falling through to the other; a
block-level tool's `id`/`blocks`/`to`/`at` refs go through `resolve_ref` (a
doc ref as `to` means the document's top level). `docs_append.section` is a
heading's TEXT (an ATX-looking text loses its hashes), matched against the
normalized heading text of the named document's live headings: zero →
`parent_missing` "no heading "<text>" in /<path>" (`data: { section, path
}`), several → `ambiguous_heading { section, path, candidates: [{ id,
doc_id }] }` ("pass the heading's id to blocks_append"); it is never an id
lookup — the id form is `blocks_append`. Block-level tools pin
`expect.content_hash` from the live row when the caller omits it.

**Sugar over effects (3.2).** The block-level write tools — `blocks_insert`,
`blocks_update`, `blocks_move`, `blocks_remove`, `blocks_split`,
`blocks_merge`, `blocks_check`, `nodes_set`, `blocks_append`, `docs_append`,
`links_retarget`, `links_repair` — are `apply { effects }` (ADR-021's
migration phase; `spec/mutate` §10): each builds its effects after its own
pre-checks (so its error `data` is unchanged), plans and executes them as
one request with the tool's name as the commit `reason`, and returns the
apply result derived from the plan's preview: `results` with every `$new.n`
realized — the receipt's id when committed; on a dry run one production
mint per `new_ids` entry, in order, so **a dry run still consumes the ids
the real run would take** (§9) — `revisions`, `diffs` (dry run only),
`committed`; a planner error loses its `effect_index`. Two behaviours moved
with it (`spec/mutate` §10, pinned): `blocks_update` with `expect: {}` (or
an order-only guard with `markdown`) proceeds with the content hash pinned
from the live row, and `blocks_check` naming a block twice is one write.
`blocks_update`'s `attrs` bag beyond `checked` stays on the kernel path until
4.0; an empty `blocks`/`ids` list is `filter_invalid` ("`blocks` must name
at least one block", with the tool's shape). `docs_create`, `docs_move`,
`docs_delete`, `docs_set_meta` and `docs_update` are unchanged in 3.2.

| Tool | Args | Result |
| --- | --- | --- |
| `docs_outline` | `id?`, `path?`, `resolution?`, `depth?`, `budget_tokens?` | §2 |
| `docs_read` | `id?`, `path?`, `include_ids?` | §2 |
| `docs_read_many` | `docs[]`, `include_ids?`, `budget_tokens?` | §2 (`docs_get_many` before 3.0) |
| `blocks_read` | `id`, `resolution?` | §2 (the document inferred from the block; `id` is a block id — an `n_` id is `block_missing` naming `nodes_block_read`; `nodes_get { doc?, path?, id }`, then `blocks_get`, before 3.0) |
| `nodes_block_read` | `id`, `resolution?` | §2 (3.0 follow-up): `id` is a node id; the block it was projected from, exactly as `blocks_read` renders it |
| `blocks_read_many` | `ids[]`, `resolution?`, `budget_tokens?` | §2 (`nodes_get_many`, then `blocks_get_many`, before 3.0) |
| `docs_tree` / `docs_list` | §2 args | §2 |
| `query_syntax` | — | `{ syntax }` (reference text, unpinned) |
| `query` | `query`, `limit?`, `cursor?` | §1.4; `semantic(...)` with no provider → `provider_unavailable` (`data: { provider: null }`, the message naming what to configure); a provider whose model has embedded nothing in the repository → `provider_unavailable` too (`data: { provider, model }`), never path-ordered rows with no score (3.0) |
| `graph` | `roots[]`, `degrees? = 1`, `direction? = both`, `predicate?`, `select?[]`, `max_documents? = 200` | `{ roots, degrees, direction, documents: [{ id, path, degree, frontier, ...select }], links: [{ id, doc_id, block_id, via_id, dst_id, dst_path, uri, dst_kind, predicate, provenance, anchor, field }], frontier: [{ id, path, degree }], truncated, queries }` — compiled to `follow distinct out_links collect { from dst }` / `follow distinct in_links collect { from doc }` (the link rows walked to the documents at their other end, §1.2; `follow doc.out`/`doc.in` before the 3.0 follow-up) with `depth = degrees + 1` (≤ 8, so `degrees` clamps to 7 and the result reports the clamped value), roots depth 0; documents ordered bytewise by path (§9); a link row carries the `links` target's fields under their own names (§1.2, 3.0 — `edges[]` until the name pass, and before that a rename table spelled `src`/`dst`/`dst_uri`/`src_field`); an `id`/`path` selection collapses onto the envelope key exactly as a `query` hit's does, any other bare name is its own column (deduped by suffix) and an expression is `sel_<i>` — a `graph` selection can never overwrite the envelope |
| `blocks_search` | `q`, `limit?` | `spec/search` §1.3 (`text_search` before 3.0): `{ hits: [{ id (the block), doc_id, path (reference form), type, text, score }], truncated }` |
| `blocks_resolve` | `query`, `limit?` | `spec/search` §4 (`resolve` before 3.0; vector fused when a provider exists): `[{ id, locator, preview, evidence }]`, the `locator`'s path half in the reference form (`/a.md#paragraph[2]`) |
| `apply` | `ops[]` or `effects[]` (exactly one, else `filter_invalid` "pass exactly one of `ops` or `effects`" with `hint: "arguments"` — 3.1), `reason?`, `dry_run?` | with `ops`: `spec/mutate` §4, `origin.actor = "agent:mcp"`: `{ results, revisions: [{ id, path, hash }], diffs?, committed }` — `revisions[].path` and the `diffs` keys in the reference form, `hash` the document's hash after the commit (the rendered bytes' sha256; the same shape as a `changes_since` revision, §3). Every mutating tool below returns this result. With `effects` (3.1, `spec/mutate` §11.7): `dry_run` → the Plan exactly as `plan` returns it; without → plan + execute under the one tool-call lock and one transaction → the Receipt (below) |
| `plan` | `effects[]` | (3.1) `spec/mutate` §11.6: the Plan `{ version, planner_v, effects, opset, preconditions, new_ids, plan_id, diagnostics, preview }` with `preview` included. **The executable core is returned verbatim in the storage form** — `effects[].target.path`, `preconditions.docs[].path`, `preconditions.absent_paths`, `opset.creates[].path`, `opset.moves[].from/to`, `opset.tombstones[].path` — because `plan_id` digests exactly those bytes and the client hands the object back to `execute` (the one result the path rule of §1 exempts, as `dangling[].target` is); only `preview.revisions[].path` and the `preview.diffs` keys are rooted. A malformed effect is `filter_invalid` (`hint: "arguments"`, the message naming `effects[i]` and the member), a contradiction `conflicting_effects`, a stale guard `stale_expectation` / `stale_plan` — `spec/mutate` §8/§11. Listed with the write tools: it runs under the lock like a dry run |
| `execute` | `plan` (an object) or `plan_id` + `effects[]` (exactly one form, else `filter_invalid` "pass exactly one of `plan` or `plan_id` + `effects`"; half of the digest form → "the digest form needs both `plan_id` and `effects`"), `reason?` | (3.1) `spec/mutate` §11.7: the plan form admits (`unsupported_plan_version { version, supported: [1] }`, `filter_invalid`, `plan_mismatch { expected, actual }`) then commits; the digest form re-plans and commits on digest equality else `plan_mismatch`; the committed plan's preconditions re-validated in the transaction (`stale_plan`, retriable). The Receipt `{ plan_id, commit, revisions: [{ id, path, hash }], new_ids: { "$new.n": id }, committed: true }`, `revisions[].path` rooted; `origin.actor = "agent:mcp"` |
| `blocks_insert` | `to`, `markdown`, `at? = end`, `expect? { parent_children_hash? }`, `dry_run?` | the apply result; `expect` is the destination-parent CAS of `spec/mutate` §1.2 (1.2) |
| `blocks_update` | `id`, `markdown?`, `checked?`, `attrs?`, `expect?`, `dry_run?` | `{ id (the target block), ids, ...apply result }` (`checked` folds into attrs; `block` before 3.0); 3.2: `set markdown` and/or `set attrs.checked` — `expect: {}` or an order-only guard with `markdown` is completed by the planner (`stale_expectation` "expect.content_hash required" before), `markdown` + `checked` is two effects with the result collapsed to the first, `attrs` beyond `checked` the kernel path |
| `blocks_move` | `blocks[]` (non-empty), `to`, `at?`, `expect? { parent_children_hash? }`, `dry_run?` | a doc ref as `to` must be the blocks' own document, else `target_missing`; `expect` is the destination-parent CAS, checked once (1.2) |
| `blocks_remove` | `blocks[]` (non-empty), `dry_run?` | |
| `blocks_split` | `id`, `at[]` (bytes), `dry_run?` | (`block` before 3.0) |
| `blocks_merge` | `blocks[]` (non-empty), `separator?`, `dry_run?` | |
| `blocks_check` | `ids[]` (non-empty), `checked? = true`, `dry_run?` | check (or uncheck with `checked: false`) the given task blocks (`tasks_complete { blocks[] }` before 3.0); 3.2: a block named twice is one write and one result |
| `nodes_set` | `id`, `prop`, `value`, `dry_run?` | an unknown node → `block_missing` "no node with id …" (`node_set { node }` before 3.0) |
| `blocks_append` | `id`, `text`, `dry_run?` | (3.0) append INTO a block by what it is: a heading → the end of its section range (`spec/mutate` §5 `sections_append`), a container (`spec/mutate` §1.1) → the end of its children (an insert `to: { parent: id, at: "end" }`), a leaf → `block_not_container` (`data: { id, type }`, the message pointing at `blocks_insert … at.after`) — the apply result |
| `docs_append` | `id?`, `path?`, `text`, `section?`, `dry_run?` | the apply result; `section` is a heading's text inside the document (above); absent → the document's end (`sections_append { heading, markdown, doc?, path? }` is gone, 3.0: appending is a document-level act or an into-a-block act) |
| `links_retarget` | `from_target`, `to_target`, `path_glob?`, `dry_run? = true` | `{ hits: [{ id (the block), path, oldRaw, newRaw }], pairs, applied, ...apply result }` |
| `links_stale` | `path_glob?`, `limit? = 500`, `summary?` | `spec/graph` §6: `{ stale: [{ doc_id, path (the source), block_id (null for a frontmatter edge), predicate, provenance, dst_kind, target, authored, anchor, reason }], truncated, summary?: { total, byTarget: [{ target, count }], bySource: [{ path, count }] } }` — a link row's fields under the `links` target's names (§1.2), `path`, `target` and `bySource[].path` in the reference form (`authored` stays as written) |
| `links_repair` | `repairs[]` or `from_target`+`to_target`, `path_glob?`, `dry_run? = true` | as retarget; neither given → `target_missing` |
| `docs_create` / `docs_move` / `docs_delete` / `docs_set_meta` | `docs_create { path, markdown, frontmatter? }`; the others `id?`/`path?` + `spec/mutate` §6 args (`to_path`, `retarget_inbound?`, `set?`/`unset?`), `dry_run?` (1.3) | its results — `{ id, path, committed, diffs?, … }`: `docs_move` adds `retargeted` and `dangling: [{ doc_id, path, block_id, target, anchor, field? }]` (the inbound edges left pointing at the old path, each a link row under the `links` target's names), `docs_delete` adds `deleted` — every path (`path`, the `diffs` keys, `dangling[].path`; not `dangling[].target`, which is as authored) in the reference form; with `dry_run` nothing commits and the result carries `committed: false` and `diffs` (`{ <path>: { before, after } }` — create `"" → bytes`, delete `bytes → ""`, move two entries, meta before → after; a move — which retargets the inbound links unless `retarget_inbound: false`, `spec/mutate` 1.3 — also previews the rewritten sources and `retargeted`/`dangling`); a dry-run create still mints its `d_` id (`apply`'s rule) |
| `docs_update` | `id?`, `path?`, `content`, `reason?`, `dry_run?` | `{ opset, plan, result }`; with `dry_run` the PLAN-ONLY call — `result: null`, nothing written, `plan` the rendered one-line-per-op text, the opset's `target: { id, path }` and `precondition: { id, path, baseRevision, hash }` (`spec/mutate` §5) with both paths in the reference form (the removed `docs_plan_update` was exactly this dry run, §9) |
| `observe` / `observe_many` / `observe_delete` | `spec/store` §5 (`path` in either form) | its outcomes (`observe` sweeps the pool) as `{ id, path, rev, commitId, converged, echo, conflicted, dispositions }` (`observe_many`: one per item, `observe_delete`: `{ id, path, deleted }`) — the store's own `{ doc, commit, rev }` outcome of `spec/store` §9 is re-shaped at this boundary, `path` in the reference form |
| `blocks_history` | `id`, `limit?` | §3 (not repo-scoped; `history_node` before 3.0) |
| `docs_diff` / `docs_diff_unified` / `docs_read_at` / `docs_history` / `changes_since` | §3 | §3 (`diff` / `diff_unified` before 3.0) |
| `repos_status` / `sync_status` | `repo?` | `spec/sync` §4.4; `repos_status` names the repository `{ id, slug, … }` (its own identity under the row rule) |
| `repos` | — | `{ repos: [{ slug, has_source }] }` by slug |
| `version` | — | (1.4) which engine and which versions: `{ engine: "typescript" \| "rust", version, components: { <package or crate>: <version>, … }, specs: { oqx, format, reconcile, store, properties, graph, search, mutate, sync, surface, cli }, schema, mcp: { protocol, sdk? }, runtime, commit, built }` — `version` is the serving binary's own (the `omgbase` npm package or crate); `components` every omgbase package the binary is built from with its version (the reference: `omgbase`, `@omgbase/core`, `@omgbase/oqx`, `@omgbase/sync`, `@omgbase/fs-adapter`; the port: `omgbase` and each `omgbase-*` crate and `oqx`), keys sorted bytewise; `specs` the `spec/<x>/VERSION` each was built against (a compile-time constant, not a file read); `schema` the open database's `PRAGMA user_version`; `mcp.protocol` the protocol version served, `mcp.sdk` the SDK's version when one is used; `runtime` `node <version>` or `rustc <version>`; `commit` the build's git revision (short, `null` when unknown — a published crate reads `.cargo_vcs_info.json`, the npm package a `build-info.json` written by `pnpm build`), `built` its RFC 3339 build time or `null`. Values are engine- and release-specific, so §6 pins the **shape**: leaves are recorded as their type. No repo scope, no workspace needed beyond the database for `schema` (`null` without one). |

Dry runs never trigger the host's post-mutation hook (the embed drain);
successful writes do.

**Error data (3.0).** `spec/mutate` §8's data fields follow the same rule
where they carry a row attribute: `stale_expectation` reports `current: {
hash, markdown }` (the block's current hash and raw; `expected_content_hash`
echoes the caller's argument and keeps its name), `stale_plan` `current: {
revision, hash }`; `ambiguous_heading` lists `candidates: [{ id, doc_id }]`
(each heading block and its document); `doc_missing`, `target_missing`,
`op_index`, `block` (the op's locator) are unchanged.

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
  `query-links.json`, `query-follow.json`, `query-functions.json`,
  `query-refs.json`, `query-errors.json` (incl. the 3.0 envelope-collision
  and `$`-name cases), `query-root.json` (the root row, 2.0: `^docs` /
  `0^docs` / `^id` / `^$it`, the `$repo` and bare-target errors).
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
  result, or `{ error, retriable, message?, data? }` for an error result
  (`data` dropped for `filter_invalid`; `changes_since` digests lose
  `summary`; `message` kept only for the surface's OWN errors — those whose
  `data` names the argument they could not honor (`id`, `path`, `section`,
  `provider`) or that carry `hint: "arguments"`,
  the §4 "Arguments" wording both engines spell alike — and dropped for a
  kernel's or store's). A case with `workspace: true` gives the default repo a
  temporary directory as its `fs` source and server root, seeded from the
  `observe` steps, so writing tools work (file-CAS included) and `repos`
  reports `hasSource: true`; without it the repo is sourceless and every
  writing tool fails `repo_not_found`. `reads::bare-attributes` (3.0, batch 3) is the name rule's
  script: a document authoring every reserved name, read bare and through
  `data`/`frontmatter`/`inline`. `ts` pins the clock for the call
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

- **`tool-descriptions.json`** (§4, 3.0): the catalog's tool names in
  registration order with their `description` strings — one source for both
  engines. Written by the reference from its registrations under
  `SURFACE_SPEC_UPDATE=1`; `scripts/gen-tool-descriptions.mjs` turns it into
  the Rust catalog's `descriptions.rs` (generated, checked in); the surface
  crate's `tests/spec.rs` and the reference's `spec.test.ts` each fail when
  their catalog drifts from it, so every description is byte-identical across
  engines.

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
   file in order, `id` `d_<i>`, `echo: false`. Each write's result is
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
`changes_since`, `docs_diff`; a `docs_move` then `docs_tree`, `links_stale`; a
`docs_create` then `graph`; …). The effect layer (3.1) has three cases —
`write-effects-plan-execute` (a `plan` whose `plan_id` the expectation
pins, so the Rust planner must digest the identical core; `execute` in the
digest form; a one-shot `apply { effects }` with a `create`), `write-effects-
dry-run` (the Plan, and that it burns no id), `write-effects-stale-plan`
(the plan form with the reference's full Plan authored into the call,
refused `stale_plan` after a `blocks_update`; `plan_mismatch`,
`unsupported_plan_version`, the argument-shape errors). The migration (3.2)
adds `write-sugar-over-effects`: the two pinned behaviour changes
(`blocks_update { expect: {} }` succeeds, `blocks_check` with a repeated id
is one write), the empty-list argument errors, and a dry-run `blocks_insert`
followed by a committed one — the committed ids prove the dry run burned
its ids (§9) through the sugar's realize shim. `apply`'s file-CAS holds in the writing
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
  columns are reachable (`query-blocks::intrinsics`, now `intrinsics-and-fields`,
  `query-blocks::root-order-is-path-then-block-id`,
  `query-docs::relation-blocks-in-document-order`,
  `query-nodes::section-blocks-includes-nested`); inside a `follow` the
  walk's metadata still won. **Superseded (3.0):** the block columns are the
  plain fields `ordinal`/`depth` (§1.2) — they never contended with user
  names, only with the walk's intrinsics — so there is no shadowing rule any
  more: `$depth` inside a follow is always the walk's, a block's nesting is
  `depth` everywhere.
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
  The runner injected `id`/`path` into every projection and `String()`-ed
  the results, so a `follow` over a property holding a list of paths (the
  strings, per `spec/oqx` §3) produced one junk hit per string with no hint of
  what happened. §1.4 now makes a hit a store row and fails the query
  otherwise, naming the value reached and `refs(<field>)` as the remedy
  (`query-errors::hit-not-a-row-follow-property`).
- **Pinned — `semantic()` without a provider is `filter_invalid` at the
  runner** ("needs an embedding provider"); only the `query` tool pre-checks
  and reports `provider_unavailable` (`semantic_unavailable` before 3.0).
- **Pinned — wikilinks resolve by path**, so a `[[slug]]` whose slug is not a
  path is a phantom edge (`spec/graph` §3.2); in the alchemy corpus
  `out_links collect distinct { from dst }` never reaches a document through
  a wikilink (a phantom's `dst` is absent).
- **Pinned — the cursor decoder is lenient** (standard-alphabet base64 and
  `=` padding are accepted).
- **Pinned — dry runs consume minted ids** (a dry-run insert advances the
  `b` counter).
- **Fixed (3.0) — `nodes_get` with an unknown block id was `doc_missing`** (the
  doc was inferred first), and a block outside its explicit `doc` scope was
  `block_missing` without data. `blocks_get` has no scope; an unknown id is
  `block_missing` "no block with id \"…\"" with `data: { id }`.
- **Pinned — the stored computed `$tags` row is body hashtags only**
  (`spec/properties` §3.3, unchanged); the surface's `tags` attribute is the
  union with the authored list (3.0, batch 3 — §1.2), so a corpus without
  `#tags` in prose reads `tags` as the authored `tags:` key and `data.tags`
  as the same list.
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
  (`Result`), so the port raises any store
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
  path == "nope.md"` was `[]` planned, `filter_invalid` in memory). A
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
- **Fixed (2.0) — the surface reported paths in the storage form.** `path`,
  every hit, every tool answered `projects/oqx.md` while every reference an
  author writes is `/projects/oqx.md`, so correlating a document with the
  references that name it needed `"/" + ^path` glue and a `links_stale`
  `target` could not be pasted where an `authored` destination could. §1
  "Paths" now makes the reference form the surface's one form, both forms
  accepted on input, literals compared with `path` rooted for the author
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
- **Pinned (3.0, the name pass) — `blocks_read` takes a block REF**: its `id`
  goes through `resolve_ref` like every block-level tool's, so an `n_` node id
  dereferences to the block it was projected from and a `path#type[n]` locator
  names a block; a ref naming nothing live is `block_missing` "no block with id
  …" (`reads::resolution-ladders` — the cases the removed `read_ref` carried;
  it had defaulted to `raw`, so the ladder now shows `blocks_read`'s `full`,
  and its miss was `doc_missing` "no document or block …"). **Superseded (3.0
  follow-up, 2026-10-11):** `blocks_read`'s `id` is a block id only; the `n_`
  dereference is `nodes_block_read { id, resolution? }` (the same result), and
  `blocks_read` with an `n_` id is `block_missing` "no block with id …" naming
  that tool — each tool's `id` is unambiguously its namespace's kind (the
  Decisions entry below; `reads::resolution-ladders` carries both).
- **Fixed (3.0, the name pass) — `from <unknown>` was a silent empty result.**
  A top-level source that is no collection read an absent root and returned
  zero hits — which is exactly what `from edges` would have done after the
  rename. §1.1 refuses it, naming the collections and, for `edges`, the new
  name (`query-errors::edges-is-not-a-target`, `::unknown-target-is-loud`).
- **Pinned — `blocks_history` (`history_node` before 3.0) is not repo-scoped**; block ids are global.
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
  hash rather than `block_missing`. **Superseded (3.2):** the planner pins
  the live row's hash (the block resolved, so it is live); unreachable
  either way.
- **Fixed (3.2) — `blocks_update` passed the caller's `expect` bag to the
  kernel as given**, so `expect: {}` — or `{ parent_children_hash }` alone
  with `markdown` — reached the content CAS with no hash and failed
  `stale_expectation` "expect.content_hash required", although the
  description promised the hash is "pinned to the block's current bytes
  server-side when omitted". The effect planner completes the guard (§4
  "Sugar over effects"; `spec/mutate` §10): omitted keys are pinned, given
  ones checked (`interop::write-sugar-over-effects`).
- **Fixed (3.2) — `blocks_check` naming a block twice failed.** Both ops
  carried the pre-check hash; the first flipped the checkbox and the second
  failed `stale_expectation`. The planner drops the identical duplicate
  (`spec/mutate` §11.3) — one write, one result per distinct block.
- **Pinned (3.2) — an empty `blocks`/`ids` list is an argument error**
  (`filter_invalid` "`blocks` must name at least one block (…takes…)") on
  `blocks_move`, `blocks_remove`, `blocks_merge` and `blocks_check`. Through
  3.1 the first three reached the kernel as a malformed op (`block_missing`
  "block undefined not found") and `blocks_check` committed nothing and
  reported success.
- **Pinned (3.2) — the sugar tools' dry runs still burn ids.** The effect
  planner's own dry run (`plan`, `apply { effects, dry_run }`) burns none;
  the sugar realizes its plan's `new_ids` with one production mint each so
  the 3.1 contract above ("dry runs consume minted ids") and `spec/cli` §3.6
  hold unchanged. Retired with the sugar's `dry_run` at 4.0.

## Decisions

- 2026-10-12, surface 3.2: ADR-021's migration phase, batch 1 — the twelve
  block-level write tools (§4 "Sugar over effects") are `apply { effects }`
  sugar, behaviour-preservingly: every 3.1 fixture of theirs is unchanged
  (the four interop pairings pass against the committed expectations), the
  reference's `migration.test.ts` proves result, projection, files and mint
  sequence equal to the legacy handlers over the alchemy corpus, committed
  and dry. Two edge behaviours moved and are pinned as fixes (§9:
  `blocks_update { expect: {} }`, repeated `blocks_check` ids), the
  empty-list argument error is new, and migrated commits record their intent
  (`commits.ops`; no read tool surfaces it). No tool, argument or result key
  added or removed; the catalog's descriptions are unchanged — a minor for
  the two result changes. `docs_create` / `docs_move` / `docs_delete` /
  `docs_set_meta` (batch 2) and the CLI verbs follow; `docs_update` stays
  legacy by design (its result needs the opset).
- 2026-10-12, surface 3.1: the effect layer's verbs (`spec/mutate` §11,
  ADR-021) — `plan { effects }`, `execute { plan | plan_id + effects }`, and
  `apply` gains `effects` as an alternative to `ops` (exactly one; the `ops`
  path is byte-identical to 3.0). Two tools and one argument added: a
  minor. 45 → 47 tools; `plan` and `execute` are write tools (the lock, the
  pre-verb sweep). The Plan's executable core is returned in the storage
  form (§4): it is a digest-covered artifact the client echoes back, not a
  rendering of rows. Fixtures: the three §7 interop cases above;
  `tool-descriptions.json` carries the 47 descriptions. The 21 write tools
  are unchanged in this release (the migration onto `apply { effects }` is
  the next phase).
- 2026-10-11, surface 3.0 (the follow-up to the tool-name pass; Brendan's
  three decisions): **(1) `nodes_block_read { id, resolution? }`** — a new
  tool in the `nodes_*` namespace whose `id` is a NODE id (`n_…`); it
  dereferences to the node's owning block and returns exactly what
  `blocks_read` returns for that block (same shape, same `resolution`
  default). `blocks_read` loses the `n_` dereference the name pass had given
  it: its `id` is a block id only, and an `n_` id is `block_missing` "no block
  with id …" whose message adds "an n_ id names a node — nodes_block_read
  reads its block". Rationale: **each tool's `id` is unambiguously its
  namespace's kind** — the name pass made `nodes_set { id }` a node id and
  `blocks_read { id }` a block id, then let the latter also accept a node's,
  the one place the rule bent. 44 → 45 tools; `omg cat`/`show` dispatch an
  `n_` ref to `nodes_block_read` client-side. **(2) The doc relations `in` and
  `out` are dropped** (the distinct linked / linking documents): docs relations
  are `blocks nodes out_links in_links`, and `out`/`in` on a doc reads an
  undefined property like any other unknown name
  (`query-docs::out-and-in-are-plain-properties`). Rationale: **`in`/`out`
  were non-descript, `in` doubles as the contextual `in` keyword, and the
  link rows express both with `distinct`** — `out_links collect distinct {
  from dst }` / `in_links collect distinct { from doc }`, and the walk `follow
  out_links collect { from dst }` / `follow in_links collect { from doc }`
  (every `query-follow` case respelled, expectations byte-identical; `graph`
  compiles to the same destination blocks, `reads::alchemy`). **(3) `dst` on
  link rows** — a reach-through to the destination DOCUMENT row when `dst_kind
  == "document"` (resolved by `dst_id`, the row `dst_path` already names),
  absent for a `block` or `external` destination and for a phantom; it never
  reaches into a block (kept simple, §1.2). `doc` on a link row (the source)
  is unchanged. `dst.<k>` pushes down like `doc.<k>` (the destination's
  properties by the row's own `dst_node`; `dst.id`/`dst.path` a primary-key
  probe — the FK-elimination paragraph of §1), and `dst` is a row handle for
  the path rule. Fixtures: `query-links::dst-*`, `query-docs::linked-docs-*`,
  `::dst-values-absent-is-null`, `::exists-through-dst`, `reads::dst-on-links`
  (an external link whose `dst` is absent). `query_syntax`, the §1.2 table,
  `@omgbase/oqx-syntax`'s vocabulary (`dst` in, `out`/`in` out), the docs, the
  tutorial and the graph-ui demo follow; `tool-descriptions.json` carries the
  45 descriptions. Both engines byte-identical.

- 2026-10-11, surface 3.0 (the tool-name pass; Brendan's decisions): **a
  tool's prefix names the row kind it addresses (`docs_`, `blocks_`, `nodes_`,
  `links_`), `id`/`path` in its arguments are that kind's attributes, the
  repo-level operations carry no prefix (`query`, `query_syntax`, `graph`,
  `changes_since`, `apply`, `observe*`, `repos*`, `sync_status`, `version`),
  and one verb returns the row: `read`** (§4 "Names and arguments",
  normative). The catalog had grown by accretion and the rule exposed the
  fossils: the block reads were named when blocks were still called nodes
  (`nodes_get` — batch 2 fixed that one to `blocks_get`, leaving `get`
  beside `docs_read`), two tools were a bare verb with no kind (`diff`,
  `resolve`), two carried their kind in another vocabulary (`text_search`
  searches blocks, `tasks_complete` checks task blocks), one kind was spelled
  two ways (`node_set` beside `nodes_*`), and two were polymorphic
  conveniences (`read_ref`, `docs_plan_update`). **The renames** (46 → 44
  tools): `diff` → `docs_diff { id?, path? }` and `diff_unified` →
  `docs_diff_unified { id?, path? }` (their `doc_id`/`doc_path` were the
  only foreign-key arguments, and a diff IS a document operation — no tool
  now refers to a document of another kind); `blocks_get` → `blocks_read`,
  `blocks_get_many` → `blocks_read_many`, `docs_get_many` →
  `docs_read_many`; `node_set` → `nodes_set`; `text_search` →
  `blocks_search`; `resolve` → `blocks_resolve`; `tasks_complete { blocks }`
  → `blocks_check { ids }`. **Why `read`**: it is what `docs_read` already
  said; `get` said nothing `read` does not, and `get`/`get_many` beside
  `read`/`read_at` made two verbs for one act. **Why `links` for the row
  kind** (`edges` before): "edge" is graph-theory vocabulary, meaningful only
  beside "node" — and here `nodes` already names the extracted-entity rows
  (`md:link`, `md:task`, `md:section`, …), so `edges`/`nodes` read as one
  graph when they are two layers; "link" is what authors, Obsidian and
  Dataview call the thing the row records (the authored relation), and the
  tools that act on them were already `links_*`. §1.2 keeps the two kinds
  apart in one sentence: the `md:link` NODE is a link's occurrence in the
  text, the `links` ROW the relation it establishes (`via_id` points at the
  node; a frontmatter link has a row and no node). So `from links`,
  `out_links`/`in_links`, `^links`, `entries(^$it)` → `links`, the `graph`
  result's `links[]`; `from edges` is refused with the new name spelled out
  (§1.1 — an unknown top-level source used to return an empty result, fixed
  in passing). The storage table stays `edges` (`spec/graph`, `spec/store`
  and `omg rebuild-index --edges` name the table). **Why `read_ref` is gone**:
  ids carry their kind (`d_`/`b_`/`n_`) and a path is a document, so the
  classification it did server-side costs a caller one `startsWith`; its one
  real service — an `n_` id dereferenced to its block — is now `blocks_read`'s
  the way every block-level tool resolves its ref (§9 above); `omg cat`/`show`
  dispatch client-side and `show --json` keeps `kind: "document"`, composed
  by the CLI (`spec/cli`). **Why `docs_plan_update` is gone**: by its own
  description it was `docs_update { dry_run: true }`; one tool with the dry
  run every other mutating tool has, and the plan guidance moved into
  `docs_update`'s text. **Fixtures**: `query-edges.json` → `query-links.json`,
  every fixture query respelled by hand, the error messages that name the
  kind rewritten, `reads.json` regenerated — the expectations changed only by
  the renames plus the two `read_ref` → `blocks_read` consequences pinned
  above; `interop.json` and `spec/cli` regenerated (the help cards and the
  `show` card's `out links` label). Both engines byte-identical;
  `tool-descriptions.json` carries the 44 descriptions, each renamed tool's
  text naming its pre-3.0 name once. The migration table is in
  `changes/surface-3.0-hit-envelope.md`.

- 2026-10-11, surface 3.0 (batch 3 — the attributes drop the `$`; Brendan's
  final decision): **`$` belongs to OQX, engine attributes are bare and win on
  collision, user data is reached through a handle where it collides** (§1.2,
  normative). The two earlier 3.0 batches had answered "why `$`?" with "the
  names that contend with user names" — and that answer put the sigil on
  exactly the names an agent types most (`$id`, `$path`, `$title`), made the
  language's `$it`/`$key`/`$depth` and omgbase's `$path` look like one
  namespace when they are two, and needed a loud-error set to keep the bare
  spellings from silently reading an absent key. The rule now: `$it $key
  $depth $stop $leaf $frontier $ordinal` are the language's and omgbase adds
  no `$` names (`$id` is an unknown identifier, absent — pinned); every
  engine attribute is bare snake_case and wins on collision, which is the
  convention `children`/`blocks`/`out`/`doc`/`frontmatter` always followed;
  the author's colliding keys are reached through the source handles `data`
  (new: frontmatter ∪ inline by the property rule — the read a bare
  non-colliding key performs), `frontmatter`, `inline` (`data.path`,
  `data.tags`, `entries(data)`), and the loud-error set is deleted. **Same
  value, same name, everywhere**: a hit is `{ id, path, …projection }` again
  (the 2.x spelling), a row-as-value `{ id, path }`, every tool result's
  `$id/$path/$raw/$hash/$updated_at` becomes `id/path/raw/hash/updated_at`,
  `properties.computed` is `{ title, tags }`, the root row's id is `^id`, and
  the arguments batch 2 made bare (`id`/`path`, `doc_id`/`doc_path`) now
  match the attributes they name. **Projections may not overwrite the
  envelope** (§1.4): `select id, path` is the envelope; an unaliased
  projection whose output key would be `id`/`path` (`select data.path`) is
  `filter_invalid` asking for an alias — this replaces batch 1's "a `$path`
  projection collapses onto the envelope key". **`tags` is a union**: the
  authored list ∪ the body hashtags (deduped, authored first), `data.tags`
  the authored list alone; the stored computed `$tags` row (`spec/properties`
  §3.3) is unchanged — the surface changes the attribute, not the property
  layer, so no lower spec moved for it. **Handle reads push down** (§1):
  `data.<k>` is the bare property's SQL, `frontmatter.<k>`/`inline.<k>` the
  same subquery scoped by `p.source` — before, every handle member was
  evaluated in memory while the bare key was pushed. **Regeneration**: every
  expectation changed by the key renames alone, plus the value changes the
  rule predicts — `tags` projections that were null (no hashtags in the
  corpus) now carry the authored list, the four loud-error cases became
  attribute reads or envelope-collision errors, and `^$id` → `^id` in the
  `$repo` message; every fixture query spelling a `$` attribute was rewritten
  by hand; new cases `query-docs::bare-path-is-the-attribute`,
  `::bare-updated-at-hash-raw-are-the-attributes`,
  `::data-handle-is-the-merged-authored-view`, `::entries-data-unions-the-sources`,
  `::contextual-words-are-fields-in-expression-position`,
  `::select-id-path-is-the-envelope`,
  `::aliases-onto-the-envelope-of-the-attribute-itself-collapse`,
  `::source-handles-reach-an-authored-key-of-an-attributes-name`,
  `::source-handle-pushdown-*`, `query-blocks::planned-doc-handle-read`,
  `query-errors::envelope-collision-needs-an-alias`,
  `::envelope-collision-id-needs-an-alias`,
  `::envelope-collision-through-a-row-handle`,
  `::dollar-names-are-not-omgbase-names`, `::bare-body-is-an-absent-property`,
  and `reads::bare-attributes` (a document authoring `id`, `path`, `title`,
  `tags`, `data`, `frontmatter`, `format`, `raw`, `hash`, `updated_at`,
  `order`, `limit` plus a hashtag: the engine values win, `data.<k>` reaches
  every authored one, `entries(data)`, a literal against `data.path` is not
  rooted while one against `doc.path` is, `^id`, `$id`/`$path` absent, the
  block attributes, both collision errors, `values` exempt, `docs_read`'s
  re-keyed `properties.computed`). `spec/search`, `spec/mutate` and
  `spec/sync` (2.0, unreleased) regenerate for the bare keys on the shapes
  they own; `spec/cli` 3.0 likewise. The `query_syntax` text, both engines'
  attribute switches and the translators carry the rule as a comment.
  **Migration from 2.x** is in `changes/surface-3.0-hit-envelope.md`.

- 2026-10-11, surface 3.0 (batch 2 — locators, fossils, the append fold,
  loud `semantic()`, description parity; Brendan's decisions): **a tool's
  arguments name the row kind its prefix names** (§4 "Arguments"): `id` /
  `path` on the `docs_*` tools (the bare `doc` id-or-path argument is gone,
  with `path` no longer a second spelling of the same thing), `id` on the
  block tools, `doc_id`/`doc_path` where a document is a foreign reference
  (`diff`, `diff_unified`); role names (`ids`, `docs`, `roots`, `ref`, `to`,
  `blocks`) and the kernel-op grammar unchanged. The names are **bare** —
  not `$id`/`$path` — because omgbase's object attributes are losing the `$`
  prefix in the follow-up batch (surface 3.0 attribute flip): `$` will mark
  OQX's scope-injected values only, and a colliding user key is reached
  through a `data.<k>` handle; this batch does not touch result keys or the
  intrinsic switch, so fixtures regenerated here show bare argument names
  beside `$`-keyed results — expected, transient on an unreleased main.
  Every error that refers to a row's identity or path spells the attribute
  (`no document with id or path "…"`, `pass id or path`, `no block with id
  "…"`), never the kernel's "block undefined". **Fossil renames:** blocks
  used to be called nodes in the read tools, and `nodes` is now the
  extracted-entity row kind, so `nodes_get` → `blocks_get { id, resolution }`
  and `nodes_get_many` → `blocks_get_many { ids, … }` (the `doc`/`path`
  SCOPE arguments dropped: a block id is global and names its document; the
  fixtures that scoped a read to another document now simply hydrate the
  block), `history_node` → `blocks_history { id, limit }` (it always took a
  block id and returned the block's changes); `node_set { id }` keeps its
  name as the one tool that addresses `nodes` rows. **Appending is a
  document-level act (`docs_append`) or an into-a-block act
  (`blocks_append`)** — Brendan; `sections_append` is gone: `docs_append {
  id? | path?, text, section?, dry_run? }` takes a heading's TEXT resolved
  inside the named document (an unknown heading → `parent_missing`, a
  heading spelled twice → `ambiguous_heading` with the candidates — pass the
  heading's id to `blocks_append`), and `blocks_append { id, text, dry_run?
  }` appends INTO a block by what it is (heading → its section's end,
  container → its children's end, leaf → `block_not_container`, the hint
  being `blocks_insert … at.after`). The id-vs-text union argument was
  rejected so no argument needs inference; the repo-wide heading-text
  lookup (and its cross-document `ambiguous_heading`) went with it — the
  interop case that pinned it now pins `parent_missing`. **Argument-shape
  errors are the engine's own** (§4): the reference replaces the SDK's
  `tools/call` handler so a wrong name is `filter_invalid` with the nearest
  valid one and the tool's shape, byte-identical to the Rust catalog's
  (`arguments.ts` / `arguments.rs`); `q` has one spelling (no alias).
  **`semantic()` is loud when it cannot rank:** no provider →
  `provider_unavailable` (the code `semantic_unavailable` is retired at the
  surface and in the CLI; `spec/search`'s own `semantic_unavailable` — the
  embedding layer's "no provider" for `omg embed` — is a lower-layer code
  and stays), and a provider whose model has embedded nothing in the
  repository (the drain never ran) → `provider_unavailable` naming the
  provider/model and `omg embed drain`, instead of every row scoring null
  and the result coming back path-ordered with no score. **`frontmatter.$x`
  reaches an authored `$`-prefixed key** — the complaint's premise (ingest
  drops `$` keys) did not reproduce in either engine at HEAD: `spec/properties`
  stores keys as given, both bindings read them through the source handle
  and `entries(frontmatter)` lists them, the bare `$version` is the engine's
  namespace (nothing); pinned by `reads::arguments`, no engine or
  `spec/properties` change. **Tool descriptions are one text:**
  `tool-descriptions.json` (§6) generated from the reference, the Rust
  `descriptions.rs` generated from it, parity tested on both sides (before,
  only `query` and eight re-keyed descriptions matched). **Pinned messages**
  (§6): a surface-composed error keeps its `message` in the fixtures; a
  kernel's or store's does not — the discriminator is the `data` the surface
  attaches (the argument it could not honor, or `hint: "arguments"`).
  `dry_run?` is added to `docs_append` (it had none) and `blocks_append` so
  `omg append --dry-run` still previews remotely. The brief spelled
  `blocks_get { id, view }`; the argument stays `resolution`, the name every
  other read (`read_ref`, `docs_outline`) uses.
- 2026-10-11, surface 3.0 (the rest of it; **superseded** by batch 3 above — the `$` vocabulary it fixed is now bare, the loud-error set is deleted; the renames, the FK elimination and the lower-spec majors stand): **`$` marks exactly the
  engine-provided names that contend with user names; everything else the
  engine adds is a plain field; every tool result spells a row the way the
  language does** (Brendan's decision, §1.2). The hit-envelope half of 3.0
  (below) had made `$id`/`$path` the one spelling for a hit's identity and
  left every other tool's envelope alone; it also left the question of WHY
  `$` exists unanswered, and the intrinsic vocabulary had grown by accretion
  — `$doc` on blocks but `$doc_id` on nodes, `$src`/`$dst`/`$via`/`$src_block`
  on edges, `$node_id` as a synonym of `$id`, `$body` (the file on docs, the
  normalized text on blocks), `$content_hash`, `$from_commit` (a commit no
  open-edge query can use), and `$ordinal`/`$depth` on blocks colliding with
  the `follow` recursion intrinsics of the same names. The rule now: a
  `$`-prefixed name is one the engine adds to a namespace shared with
  user-generated content (frontmatter keys, inline properties, block attrs),
  prefixed to give the author's field names priority and prevent collisions;
  a name that cannot collide is a plain snake_case field. So the `$`
  vocabulary is exactly `$id $path $raw $hash $updated_at $title $tags`
  (the table in §1.2), and: `$body` → `$raw` (a block's `$raw` is now its raw
  source, not its text — `text` stays a field), `$content_hash` → `$hash`;
  blocks `$doc` → `doc_id`, `$ordinal`/`$depth` → `ordinal`/`depth` (the
  follow-shadowing rule is deleted); nodes `$doc_id`/`$block_id` →
  `doc_id`/`block_id`, the `$node_id` synonym dropped; edges `$src` →
  `doc_id`, `$src_block` → `block_id`, `$via` → `via_id`, `$dst` → `dst_id`,
  `$dst_path` → `dst_path`, `$dst_uri` → `uri`, `src_field` → `field`,
  `$from_commit` removed; the loud-error set is `id path updated_at hash
  raw`. **Same value, same name** carries the rule into every tool result: a
  key holding what a row attribute yields is spelled as that attribute
  (`docId`/`doc` → `$id`, `path` → `$path`, `content`/`raw` → `$raw`,
  `contentHash`/`content_hash` → `$hash`, `ts` → `$updated_at`, foreign keys
  `doc_id`/`block_id`/`parent_id`), role keys keep their names (`rev`,
  `from`/`to`, `before`/`after`, `locator`, `baseRevision`, `cursor`,
  `expected_content_hash`), inputs are untouched (§2–§4 list every shape;
  the migration table is `changes/surface-3.0-hit-envelope.md`). The planner
  gains foreign-key elimination in both engines (§1: `doc.$id` reads the FK
  column, no join). `spec/search` 2.0, `spec/mutate` 2.0 and `spec/sync` 2.0
  take the renames on the shapes they own (`text_search`/`resolve` hits,
  the apply result and opset precondition and error data, the change-feed
  revision); `spec/store` (the observe outcome, re-shaped at the boundary)
  and `spec/graph` (whose fixtures pin the `edges` table — the `src_field`
  column stays the column) are unchanged. Regeneration: every expectation
  changed by exactly the key renames above, plus the two value changes the
  rule predicts — a block's `$raw` is its raw bytes where `$body` was its
  text, and `graph` edges gain `block_id`/`via_id`; every fixture query that
  spelled a dropped name was rewritten by hand. The `query_syntax` text,
  both engines' intrinsic switches and loud-error checks carry the rationale
  as a comment, so the next reader finds the reason beside the rule.
- 2026-10-10, surface 3.0 (**superseded** by batch 3 above: the envelope is `{ id, path }` again and a projection may not overwrite it): **the query hit envelope renders identity as
  `$id`/`$path`** (Brendan's decision, §1.4). The lean hit was
  `{ id, path, ...projection }`; the expression language has no bare `id` or
  `path` — a reserved basename is rejected with "did you mean `$id`?" — so
  the envelope taught agents a name the next `where` clause refused: an agent
  copying a key from a result into its query walked straight into the
  rejection. Projections already kept their `$` (`$title`); only the envelope
  stripped it. Now every hit is `{ $id, $path, ...projection }` and a row
  surfacing as a value is `{ $id, $path }` — result keys live in the same
  `$`-prefixed intrinsic namespace as the language, and the round trip holds
  with no translation: copy a hit's `$id` into `where $id == "…"`. A `$id` /
  `$path` projection collapses onto the envelope key (before, a `select
  $path` produced `path` *and* `$path`), `id`/`path` become ordinary
  projected names, and `values` mode is untouched (no hits). The keyset
  cursor carries the two values, not key names: 2.x cursors stay valid. Both
  engines render the envelope byte-identically; §7 `read-query` pins the
  round trip across them. **Not in scope:** every other tool's envelope —
  `docs_list` `{ path }`, `docs_read.path`, `graph` `documents[].id/path`,
  `text_search`, `resolve`, `changes_since`, `nodes_get.id` — is a tool
  result, not a hit, and keeps its names. Regeneration: every hit-bearing
  expectation of every suite changed by the two key renames, every `$path`
  projection lost its duplicate `path`, and exactly one expectation changed
  beyond that — `query-root::root-object-collection-is-the-root-name`, whose
  `id: ^$it.$id` projection used to *overwrite* the envelope's `id` (the hit
  reported `rp_0`, the repository, as its own identity); it is now the
  column `id: "rp_0"` after `$id: "d_0"`. New cases:
  `query-docs::hit-envelope-is-the-intrinsics`, `::hit-envelope-round-trip`,
  `::path-projection-collapses-onto-the-envelope`,
  `::user-columns-named-id-and-path-are-projections`,
  `::rows-as-values-are-id-path-refs`, `::values-mode-is-unchanged-by-the-envelope`,
  `reads::hit-envelope-round-trip` (the script form: observe, copy `d_0` from
  the first hit into `where $id == …`, page with a 2.x-shaped cursor, a block
  row as a value, `values`, then `docs_list`/`nodes_get` for the contrast).
  **Migration:** `hit.id → hit.$id`, `hit.path → hit.$path` in every hit
  parser (`omg query --json`/`--jsonl`, MCP `query` results, a nested
  `collect { }` of rows); a `select $path, …` consumer that read `path` reads
  `$path`; a projection you aliased `id:`/`path:` to dodge the collision no
  longer needs the alias but keeps working; tool envelopes unchanged; stored
  cursors unchanged. A result key changed in meaning: a major (`spec/cli`
  3.0 follows for the `omg query`/`run` table and `--json`).
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
