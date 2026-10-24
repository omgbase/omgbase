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
path a query, a tool or the CLI RETURNS is `/`-rooted — `_path` on every
target and `_dst_path` on links, the `_path` of every hit and of a row rendered as
a value (§1.4), `docs_list`/`docs_tree` rows and the tree's `prefix` (`/` for
the root), `docs_read`/`docs_read_at`/`docs_read_many`, every
history, link-health, search, document-operation, `apply`, `observe` and
`changes_since` path (the digest's `revisions`, deletions and moves, the
`summary` included) — and every path they ACCEPT tolerates both forms: a
missing leading `/` is added, an extra one is stripped (`docs_read` of
`/a.md`, `a.md` or `//a.md` is one document; a `path_glob`, a `docs_tree`
prefix, `roots`, `docs[]`, `refs(x)`, `within(…)` likewise). In a query, a
**string literal** compared with `_path`/`_dst_path` by `==` or `!=`, or
passed to their `.startsWith(…)`, is rooted before evaluation, so `_path ==
"a.md"` and `_path == "/a.md"` both match and `_path.startsWith("dir/")`
keeps working — the read may be direct (`_path`, `^_path`) or through a ROW
handle (`_doc._path`, `_block._path`, `_dst._path`, `$it._path`); nothing
else is rewritten — a property's value is the author's (`where customer ==
^_path` compares the authored reference directly, `where ^_path in
list(after)` is the reverse of `refs(after)`, `where path == "/x.md"` — or
`_data.path`, the same read — reads the author's `path:` key as written: a
literal against an authored property, bare or under a source handle, is
never rooted; 5.0 — through 4.11 the bare `path` was the engine's and the
authored key was `data.path`), a regex (`matches("^/texts/")`), `contains`,
`endsWith` and a binding read the string as it is. Storage is unchanged:
`docs.path` stays repo-relative, no migration, and the pushed SQL and the
store-index probes de-root the literal (or root the column) so planned and
in-memory agree (`query-docs::path-*`,
`query-links::dst-path-*`, `query-refs::reverse-reference-by-path-membership`,
`reads::alchemy`).

Both implementations run the same tier-3 planner (the pushable top-level
`&&`-conjuncts of a bare root scan become one SQL statement; the residual
finishes in memory over the produced rows). Both also answer a **nested
block's equality probe over a root scan** from the store's indexes
(implementation note, 2026-10-08: `oqx-js/store-index.ts`,
`omgbase-surface::store_index`): a root (`^<target>` from a row, a bare target
at the root scope) is handed to the engine lazily and a block whose top-level
conjunct is `local == outer` — `^docs { customer == ^_path }`,
`^links exists { _dst_id == ^_id }`, `^docs single {
type == "x" }` — is served by one indexed statement per probe (docs `_id`,
`_path`, `_title`, any property key by typed value; blocks `_id`, `_doc_id`,
`_type`, `_path`; nodes `_id`, `_doc_id`, `_kind`, `_name`, `_path`; links
`_id`, `_doc_id`, `_dst_id`, `_path`, `_dst_path`) under the root scan's guards and
order, so the root is never read whole; an absent probe or an unindexed path
reads it once. A `_path`/`_dst_path` probe de-roots a rooted value before the
statement and answers no row for a bare one (the intrinsic is the reference
form, 2.0), as the translator renders the column `'/' || d.path` and takes
the indexed `d.path IS ?` fast path only for a rooted constant. Results are unchanged — the §6 fixtures and the conformance
lists are the gate — only the work is. Invisibility is kept by
**declining** rather than by cleverness; since the 1.1 patch of 2026-09-26
(§9) the planner declines, in both translators:

- a comparison whose operand kinds are not **provably comparable the same
  way** in SQLite and in memory. Operand kinds: *text* (a string literal or
  binding, a text column or intrinsic, `lower()`/`upper()` output), *int*
  (an integer column: a block's `_ordinal`, `_depth`), *num*, *bool* and *null*
  (literals or bindings; an absent binding is null), *json* (an `_attrs`
  path or a bare attrs key on blocks or nodes), *prop* (a document
  property, bare or `_data.<k>`, or `_doc.<k>`). **Equality** (`==`, `!=`) pushes only when one
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
  `1`, `val_bool` and `val_num` alike (`_ordinal == checked`), orders every
  integer before every text (`_ordinal < "3"`, `level < "x"`), and two JSON
  or property reads carry no type at plan time;
- an identifier or member head that names a **relation, reach-through
  handle, whole source handle or the `_attrs` bag** of the target (§1.2:
  `_blocks`, `_nodes`, `_out_links`, `_in_links`, `_data`, `_frontmatter`,
  `_inline`, `_doc`, `_children`, `_section`, `_block`, `_dst`,
  `_subsections`, `_attrs`, …) — it is not a property read. A **key read
  through a source handle** IS pushed (3.0, batch 3): `_data.<k>` translates
  exactly as the bare property `<k>` (the same single-scalar-row subquery —
  identical semantics by definition), `_frontmatter.<k>` / `_inline.<k>` as the
  same subquery with `p.source = '<source>'` added to both its row condition
  and its row count, on `docs` and through `_doc.` on the other targets
  (`query-docs::source-handle-pushdown-*`, `query-blocks::planned-doc-handle-read`);
  `entries(<handle>)`, a deeper member chain (`_data.meta.owner`) and a
  whole-handle reference stay residual;
- the **whole query**, when any residual conjunct could raise an OQX eval
  error the pushed conjuncts might hide by emptying the scan: a residual
  that contains any function or method call, a nested block with the
  `single` consumer or a `^`-escaped name sends the query to the in-memory
  engine unplanned (before batch 3 of 3.0 a bare docs `id`/`path`/… was a
  loud error and counted here; since then the attribute is a plain read —
  `_id`/`_path` in 5.0 — and a bare `id`/`path` an authored property, a plain
  read too). Only a residual made of
  comparisons, logical operators, `in`, `!`, literals, bindings and plain
  reads keeps the pushed conjuncts.

**Foreign-key elimination (3.0; 5.0 spelling).** A reach-through read that
names the owner's identity — `_doc._id` and `_doc._path` on a block, a node
or a link, `_block._id` / `_block._path` on a node — is answered from the
row's own foreign-key column or the scan's already-joined document column,
never by loading the owner: in SQL `_doc._id` on blocks is `b.doc_id` (nodes
`n.doc_id`, links `e.src_doc`), `_doc._path` is the joined `d.path` the scan
carries, and `_block._id` on nodes is `n.block_id`; in memory the
reach-through hands out a lazy owner row whose `_id`/`_path` come from the
child row, so `_doc._id` and `_doc_id` cost the same statement (none) and
plan to the same SQL. Any other read through the owner (`_doc.layer`,
`_doc._title`, `_block._text`) still reaches it. A link's `_dst.<k>` (3.0
follow-up, §1.2) pushes down like `_doc.<k>`: a property read (`_dst.layer`)
scopes `properties` by the row's own `e.dst_node`, and `_dst._id` /
`_dst._path` / `_dst._hash` / `_dst._updated_at` / `_dst._format` are a
primary-key probe of the destination (`(SELECT … FROM docs dd WHERE
dd.doc_id = e.dst_node)`) — NULL wherever `_dst` is absent in memory;
`_dst._raw` / `_dst._title` / `_dst._tags` and the relations stay residual,
as `_doc.*`'s do. `_dst` is a row handle for the path rule (§1 "Paths"): a
literal compared with `_dst._path` is rooted like one compared with
`_dst_path` (`query-links::dst-identity-reads-the-foreign-key`,
`::dst-filter-pushes-down`, `::dst-path-literal-rooted`).

The differential (every corpus-backed query case run planned and in-memory)
proves each decline: `query-errors::planned-*` and the `planned-*` cases of
`query-blocks.json` / `query-docs.json` pin the shapes above.

### 1.1 Roots and rows

`docs | blocks | nodes | links | revisions { … }` — the collection heading the
body — and, from inside a row, `^docs | ^blocks | ^nodes | ^links | ^revisions`
(the root row, below) — scan
the repo's rows in a fixed order (the four **live** collections, and the
history, 4.7):

| root | rows | order |
| --- | --- | --- |
| `docs` | `docs` with `deleted_commit IS NULL` | `(path, doc_id)` |
| `blocks` | live blocks of live docs | `(doc path, block_id)` |
| `nodes` | `nodes` of live docs | `(doc path, node_id)` |
| `links` | open `edges` rows (`to_commit IS NULL`) of live source docs — the link RELATIONS, §1.2 | `(source doc path, edge_id)` |
| `revisions` | (4.7) every `revisions` row of every document of the repository, joined to its commit — **deleted documents' revisions included** (history is history; the repository guard is the owning `docs` row's `repo_id`, the table carries none) | `(revisions.path, rev_id)` — the keyset order of every target, so the cursor pages it (§1.4); `order by _seq` for a document's chronology |

**The repository is the root row** (2.0, with `spec/oqx` 0.18 §2). The root
scope's names are the five scans above and **`_id`**, the repository id (an
engine field of the root row, so it carries the prefix like every engine
field, 5.0); the root scope's **row** (`DataContext.rootObject` /
`root_object`) is the root object, whose entries are exactly the five
collections in that order (`_id` is an engine field of it, not an entry;
`revisions` the fifth since 4.7). So from a top-level row `^docs` is the
documents scan and `^_id` the repository id; from a block's rows one caret
deeper (`^^docs`), or the absolute `0^docs` / `0^_id` from any depth; `^$it`
is the root object, `^$it.docs` the same handle as `^docs` (a receiver, a
value, a probe), `^$it._id` the repository id, `entries(^$it)` yields `docs`,
`blocks`, `nodes`, `links`, `revisions` — the collections are bare names,
unchanged by 5.0 (`query-root.json`; the 5.0 cases `root-id-is-underscored`
and `entries-of-root-unchanged`). At the root scope a bare target name is the
scan — the receiver of a top-level directive (`docs count { … }`), `from
docs`, `entries(docs)` — because a bare name there is `root(name)`.

Two spellings are **refused** as `filter_invalid`, before any row is read, so
the error is the same whether or not a row would have reached them and the
planned and in-memory paths agree trivially (`query-root::repo-removed-*`,
`bare-target-*`):

- **`$repo`** (an intrinsic of every scope before 2.0) anywhere — bare, as a
  member head (`$repo.docs`, `$repo._id`), `^$repo`, `0^$repo` — with the
  message `` `$repo` was removed in surface 2.0 — reach the repository's
  collections through the root row: `^docs` from a top-level row (one caret
  per enclosing block, or the absolute `0^docs`), and the repository id as
  `^_id` / `0^_id` `` (5.0: `^_id`; `^id` through 4.11).
- **A bare target name inside a block** — at scope depth ≥ 1 (a top-level
  row's clauses, a block's body, a `from E` re-projection, a `follow`
  destination), where a bare name reads a property of the current row, which
  has none — with the message `` `docs` inside a block reads a property of the
  current row, which has none — did you mean `^docs` (the repository's
  documents)? `` (the carets count the depth: `^^docs` from depth two).
  Since 5.0 **all five** root names are refused statically: the relations
  are `_blocks`, `_nodes` and `_revisions` (§1.2), so a bare `blocks`,
  `nodes` or `revisions` inside a block is never a relation of the current
  row — the message is unchanged, the hint spelling the rule (`one caret per
  enclosing block, or the absolute 0^blocks`). Through 4.11 the three were
  relations of some rows and the context raised the same error only on a
  row that lacked the relation. Consequence: a frontmatter key named `docs`,
  `blocks`, `nodes`, `links` or `revisions` is unreachable by bare name
  inside a block — read it as `_data.<k>` or `_frontmatter.<k>`. The planner
  declines a bare target name as a property read and treats one that could
  raise as a residual that may raise (§1), so a pushed conjunct cannot hide
  the error.
- **A `^<target>` with more carets than enclosing scopes** — `^docs count { }`
  at the top level, `^^links` from a top-level row — which `spec/oqx` §2
  reads as absent (so the count would be a silent 0), with the message
  `` `^docs` reaches past the root — there is no enclosing row at this depth;
  at the top level the repository's documents are the bare `docs` (`docs count
  { … }`, `from docs`, `entries(docs)`) `` (statically, by the same walk;
  `query-root::root-caret-past-the-root*`). Only the five target names: any
  other outer reference past the root keeps the language's absent.
- **A top-level `from <name>` that is no collection** (3.0 name pass) —
  `from edges`, `from nope` — would scan an absent root and come back empty;
  refused with `` `edges` is not a target — the repository's collections are
  `docs`, `blocks`, `nodes`, `links`, `revisions` (`edges` was renamed `links`
  in surface 3.0) `` (the parenthesis only for `edges`;
  `query-errors::edges-is-not-a-target`, `::unknown-target-is-loud`).

A row's **identity** — `$key` (spec/oqx §16; `distinct`, `follow` cycles, `is`)
— is its id column (`_id`). A
relation returns rows of its successor target; a scalar reach-through
(`_doc`, `_block`, `_dst`) returns one row.

### 1.2 Fields, intrinsics, reach-through, relations

**The name rule (5.0, normative; Brendan's decision of 2026-10-19).** One
rule, on every record kind: **a BARE name is a user-authored entry, and an
UNDERSCORE-prefixed name is engine-provided, however derived.** The `_`
prefix declares an engine field on a record — `_id`, `_path`, `_title`, a
reach-through `_doc`, a relation `_blocks` — and the bare namespace is the
user's on every record: docs, blocks, nodes, links, revisions and the root row
alike, because any record may carry user data later. **Nothing is reserved**:
an authored `id:`, `path:`, `title:`, `tags:`, `data:`, `doc:` or `format:`
key is read by its bare name like any other (`reads::bare-attributes`; the
5.0 case `doc-on-a-document-is-an-authored-key`). `$` belongs to OQX:
`$it`, `$key`, `$depth`, `$stop`, `$leaf`, `$frontier`, `$ordinal` are values
the LANGUAGE injects into a scope (`spec/oqx` §2), and omgbase adds **no `$`
names** — a `$id` or `$path` in a query is an unknown OQX identifier, absent
(`query-errors::dollar-names-are-not-omgbase-names`), and so is `$self`: the
runner spells a bare row function as a method on `$it` (`text("x")` →
`$it.text("x")`), the language's own name for the scope's row, and keeps no
receiver token of its own (`query-errors::dollar-self-is-not-a-name`, 4.11).
**Collections stay bare** — `docs { … }`, `^docs`, `0^docs`, `docs count { … }`,
`entries(^$it)` yields `docs blocks nodes links revisions` — because the
collection heading a body names a collection, not a row property (§1.1); and so do the **row functions
in call position** (`text("x")`, `semantic(…)`, `under(…)`, `refs(x)`,
`date(x)`, …): a call is never an entry read (§1.3). **The self aliases are
gone**: `doc` on a document, `block` on a block and `section` on a node
(3.0–4.11) are authored keys now; `$it` is the self, and a reach-through to
another row is `_doc`, `_block`, `_dst`.

A document has three *source handles*, all engine names: `_data` (the merged
authored view — frontmatter + inline by the property rule below, i.e. exactly
the read a bare key performs, so **`_data.<k>` ≡ `<k>`**), `_frontmatter` and
`_inline` (one source each). The handles are the one way to an authored key
that itself begins with `_` (`_data._x` reads the author's `_x:` key, which the
bare `_x` would judge as an engine name, §1.5) and the spelling that says
"authored" out loud where a reader might wonder (`_data.title`); `entries(_data)`
lists every authored top-level key (frontmatter ∪ inline, keys deduped, `key`
order). Two engine names shadow nothing but are easy to confuse with the
authored keys of the same stem: **`_title`** is the computed title (the first
H1), the bare `title` the authored `title:` key alone; **`_tags`** is the
authored `tags` ∪ the body `#hashtags`, the bare `tags` the authored list
alone. For a `yaml` or `json` document the "frontmatter" is the document's
whole top-level mapping (`spec/properties` §3.4, 1.2): its keys are bare names
(`focused_intent`), `_data.<k>`/`_frontmatter.<k>` reach them, `_inline` is
empty, `_title` is null (nothing is computed for a mapping) and `_tags` is the
authored list (`reads::yaml-json-documents`). History: before batch 3 of 3.0
the engine attributes were `$`-prefixed and the bare spelling was "did you mean
`$path`?"; from 3.0 through 4.11 they were bare, won on collision, and the
author's colliding key was reached as `data.<k>` (§9, Decisions) — 5.0 moves
the prefix to the engine's side, where the closed set is, and gives the open
namespace back to the author.

**Same value, same name, everywhere**: language, results, arguments and errors
spell an engine field alike — a hit is `{ _id, _path, …projection }` (§1.4),
`docs_read` is `{ _id, _path, rev, properties, _raw }`, `blocks_read { _id }`
takes the `_id` a hit carries, `doc_missing` says `no document with _id or
_path "…"`; a key naming a *role* in a result (`rev`, `from`/`to`,
`before`/`after`, `locator`, `cursor`, `expected_content_hash`, `baseRevision`,
`kind`, `score`, `label`, `parent_id`, `blocks` as a count) keeps its own name
(§2–§4). Inputs follow §4 "Arguments": a tool's prefix names the row kind it
addresses and `_id` / `_path` / `_ids` in its arguments are that kind's
engine fields, spelled exactly — a bare `id`/`path`/`ids` argument is an
argument error with a `fix`, never a tolerated alias; the kernel-op grammar
(`block`, `blocks`, `to`, `at`, `expect.content_hash`, `op`) is spec/mutate's
and is unchanged, and an effect's fields are `_frontmatter.<key>`,
`_attrs.checked`, `content`, `markdown` (`spec/mutate` 4.0 §11).

**Engine names per kind** (the closed set a `_` name is judged against, §1.5;
every other name on the kind is an authored entry — on docs a property, on
blocks and nodes an `_attrs` key, on links and revisions nothing):

| kind | attributes | handles | relations |
| --- | --- | --- | --- |
| docs | `_id` `_path` `_raw` `_hash` `_updated_at` `_created_at` `_title` `_tags` `_format` | source handles `_data` `_frontmatter` `_inline` | `_blocks` `_nodes` `_out_links` `_in_links` `_revisions` |
| blocks | `_id` `_path` `_doc_id` `_raw` `_hash` `_updated_at` `_created_at` `_type` `_text` `_attrs` `_depth` `_ordinal` | `_doc` (the owning document) | `_children` `_nodes` `_out_links` `_section` |
| nodes | `_id` `_path` `_doc_id` `_block_id` `_kind` `_name` `_value` `_attrs` | `_doc`, `_block` (the owning document and block) | `_blocks` `_subsections` `_children` |
| links | `_id` `_path` `_doc_id` `_block_id` `_via_id` `_dst_id` `_dst_path` `_uri` `_field` `_dst_kind` `_predicate` `_provenance` `_anchor` | `_doc` (the source document), `_dst` (the destination document), `_block` (the source block) | — |
| revisions | `_id` `_path` `_rev` `_seq` `_doc_id` `_commit` `_ts` `_origin` `_actor` `_reason` `_hash` `_is_current` `_archived` (4.9: true when the revision's bodies live in an archive segment, `spec/store` §7.1 — the row stays; `docs_read { at }` reads through the segment while it is attached) | `_doc` (the document's current row) | — |
| root | `_id` (`^_id`, `0^_id`, `^$it._id`) | — | the five collections, bare (§1.1) |

Language words that can never be a bare field: `select from where is not and
or`, the literals `true false null`. Contextual words (`limit order offset
follow collect count first distinct desc by in`) parse as fields in
expression position (`docs { select o: order, l: limit }`;
`query-docs::contextual-words-are-fields-in-expression-position`,
`reads::bare-attributes`).

`_raw` is the exact source bytes of the thing and `_hash` is their SHA-256
as 64 lowercase hex: a document's `_raw` is the reconstructed file
(`spec/store` §6.1, frontmatter included) and its `_hash` the `file_hash`
(null when none); a block's `_raw` is its raw source — the `blobs` row its
`raw_hash` names, a container's raw holding its children verbatim
(`spec/format`) — and its `_hash` the hex `raw_hash`. `_text` (the
normalized text) is an attribute of blocks; there is no `_body` and no
`_content` (a bare `body` or `content` is an ordinary property read,
`query-errors::bare-body-is-an-absent-property`; the `_` spellings are §1.5's
loud error). `_path` on every kind is the path of the document the row lives
in (blocks and nodes: the owner; links: the source document), the reference
form (§1 Paths). `_title` on docs is the **computed** title — the `$title`
row `spec/properties` §3.3 stores (the first H1's text; null when none);
`_tags` is **the union of the authored tags and the body `#hashtags`**: the
authored `tags` key read by the property rule (a scalar is one element)
followed by the computed `$tags` row (hashtags in document order),
deduplicated by value with the first occurrence kept, null when both are
absent (`reads::bare-attributes`: `tags: [alpha, beta]` + `#beta #gamma` →
`_tags` `["alpha", "beta", "gamma"]`, `tags` `["alpha", "beta"]`). The stored
computed rows keep their `$` keys (`spec/properties` is unchanged); the
surface renders them under the engine names — in the language as
`_title`/`_tags` and in `docs_read`'s `properties.computed` as `{ _title,
_tags }` (§2).

**docs.** Attributes: `_id` (doc id), `_path` (the reference form, `/a/b.md`
— §1 Paths), `_hash` (hex of `file_hash`, null when none), `_updated_at`
(the current revision's commit `ts`, null when none), `_created_at` (4.10:
the commit `ts` of the document's first revision — the `revisions` row with
`seq = 1`, equivalently the minimum `seq`, so it is exactly `_revisions first
{ _ts values }` — an ISO string in `_updated_at`'s form, null when the
document has no revision. **It is the instant omgbase first observed the
document, not a filesystem time**: a file that existed for years before it
was observed is created on the day of its first commit. The retention
squash (`spec/store` §7.1, 15.0) archives bodies but keeps every revision
and commit row, so `_created_at` survives `history_export { prune }`
unchanged; `reads::created-at`), `_raw` (the
reconstructed file, `spec/store` §6.1), `_title`/`_tags` (above), `_format`
(the format column). `_data` / `_frontmatter` / `_inline` are **source
handles**: `_frontmatter.<k>` reads the key from that source only, `_data.<k>`
from both authored sources by the property rule below (so `_data.layer` ≡
`layer`, and `_data.path`/`_data.title`/`_data.tags`/`_data.format` are the
bare `path`/`title`/`tags`/`format` said out loud); `entries(<handle>)` yields
one entry per **top-level** key in `key` order (bytewise; `_data` dedups the
keys of both sources), dotted keys folded back into nested objects, each
valued by the property rule. The handles are lazy (a marker; one indexed
`properties` lookup per key read, nothing materialized until `entries`). Any
bare identifier is a **property** (`spec/properties`): the rows of that key
across authored sources (frontmatter + inline, `ord` order) — exactly one
row with `card = scalar` → the decoded scalar; otherwise the array of
decoded values; no row → the nested object rebuilt from keys under `<k>.`
(undefined when none). The row itself is `$it` (`doc` was its alias through
4.11; it is an authored key now). Relations: `_nodes` (the doc's nodes in
**document order**: block-less nodes first, then by the owning block's
pre-order rank, then `span_start`, then `node_id` — §9), `_blocks` (live,
**document order**: pre-order over the tree — §9), `_out_links` / `_in_links`
(open edges, `(predicate, edge_id)` order). There is **no `_out` / `_in`
relation** (3.0 follow-up, §9): the documents a doc links TO are its link
rows' destinations, `_out_links distinct { from _dst }`, and the
documents linking to it their sources, `_in_links distinct { from
_doc }` (`from` over an absent `_dst` — an external link, a dangling
`[[wikilink]]` — contributes no row); the citation walk is `follow _out_links
{ from _dst }` / `follow _in_links { from _doc }`, with
`depth`/`frontier` as clauses of the block (oqx 0.20: `… { from _dst
depth 2 }`) and a body-level `frontier <pred>` before `follow` applying to
the seeds (`query-follow::body-frontier-keeps-seeds-unexpanded`);
`_revisions` (4.7) — the document's revision rows (below), **oldest first**
(`_seq`), so `_revisions count { _origin == "api" } > 0` is "edited
through the API" and `_revisions { _seq, _ts }` its timeline
(`query-revisions::docs-relation-*`; `_doc._revisions` from a block or link
row reaches the same list). A bare `out`, `in`, `doc` or any other bare name
on a doc reads an authored property — except the five root names, which
inside a block are always §1.1's error, never a relation
(`query-docs::linked-docs-through-out-links`,
`::linking-docs-through-in-links`, `::out-and-in-are-plain-properties`).

**blocks.** Attributes: `_id`, `_path` (owning doc's path), `_raw` (the
block's raw source bytes), `_hash` (hex `raw_hash`), `_updated_at` (the
latest commit `ts` among the block's `block_changes`, null when none —
since store 14.2 those rows are the commits that *changed* the block, so
this is the block's own last change: its insertion, edit, move, split/merge
lineage or resurrection, never a sibling's edit; through 14.1 every commit
to the document wrote a `same` row and the value was the document's —
`reads::sibling-updated-at-does-not-move`),
`_created_at` (4.10: the *earliest* commit `ts` among the block's
`block_changes` — `_updated_at`'s join under `MIN` — the commit that first
wrote the id: its `inserted` row, or the split/merge lineage row that
minted it; null when none. Like the document's it is "first observed by
omgbase", not a filesystem time; store 14.2 keeps that first row and the
15.0 squash keeps each block's earliest row (`spec/store` §7.1), so it
survives archiving — a block whose minting commit is wholly archived keeps
its `_created_at` (`reads::created-at`); a resurrected block keeps its
original creation, since the pool returns the same id),
`_doc_id` (the owning document's id), `_type`, `_text`, `_attrs`
(parsed), `_ordinal` (the block's 0-based ordinal among its siblings — the
`ordinal` column), `_depth` (its nesting depth, 0 at the top level — the
`depth` column); any bare identifier reads `_attrs.<k>` (undefined when
absent; `_attrs.<k>` ≡ `<k>`, so `checked`, `level`, `lang` are the authored
keys of a block — an `_attrs.path` key, were the format layer to write one,
is reached as `_attrs.path` and the bare `path`). The recursion intrinsics of
a `follow` (`spec/oqx` §2: `$depth`, `$ordinal`, `$stop`, …) are metadata of
a walk occurrence only and never name a block column — inside a `follow`
`$depth` is always the walk's, and a block's own nesting is `_depth`
everywhere (before 3.0 the two shared a name and the walk's shadowed the
block's, §9). The row itself is `$it` (`block` was its alias through 4.11);
`_doc` is the owning doc. Relations: `_children` (live, `(ordinal,
block_id)`), `_nodes` (nodes anchored to the block, `(span_start, node_id)`
order), `_out_links` (open edges from the block, `(predicate, edge_id)`),
`_section` (the `md:section` nodes whose `[first_ordinal, last_ordinal]`
contains the block's **top-level ancestor's ordinal**, by `(first_ordinal,
node_id)`).

**nodes.** Attributes: `_id` (the node id), `_path`, `_doc_id`,
`_block_id` (null for a block-less node), `_kind`, `_name`, `_value`,
`_attrs`; any bare identifier reads `_attrs.<k>` (`checked`,
`first_ordinal`, …). The row itself is `$it` (`section` was its alias
through 4.11); `_doc` and `_block` reach through (`_block` undefined when the
node has none). Section relations (a node read as a section; empty when it
has no `first_ordinal`): `_blocks` (live blocks whose top-level ancestor's
ordinal lies in the range, in document order), `_subsections` (`md:section`
nodes contained in the range with a greater `level`, by `(first_ordinal,
node_id)`), `_children` (contained deeper sections with **no** intervening
section of a level strictly between, same order).

**links** (`edges` before the 3.0 name pass, §9)**.** One row per link RELATION — the
open `edges` row the graph layer keeps (`spec/graph`): the `md:link` /
`md:wikilink` NODE is a link's syntactic occurrence in the text (a `nodes`
row), the `links` row is the relation it establishes, `_via_id` points from the
row at that node, and a frontmatter or inline-field link has a row and no
node. Attributes: `_id`, `_path` (the source doc's path),
`_doc_id` (the source document), `_block_id` (the source block, null for a
frontmatter edge), `_via_id` (the `via_node`, null unless the edge was
derived through another node), `_dst_id` (the destination node id: a doc id,
an external node id or `phantom:<path>`), `_dst_path` (the target doc's path,
null when not a doc; the reference form), `_uri` (the external node's URI,
null otherwise), `_predicate`, `_provenance`, `_dst_kind`, `_anchor`, `_field`
(the frontmatter key or inline field the edge was authored in, null for a
link). Three reach-throughs: `_doc` is the SOURCE document (the row `_doc_id`
names); `_block` (4.11) is the SOURCE BLOCK — the blocks row `_block_id`
names, in the source document, exactly as `_doc` reaches the document — so
`_block._text` is the linking block's text, `_block._type` its type, `where
_block._type == "paragraph"` a filter over it, and `_block._doc._path ==
_path` holds for every link that has one; **absent** (the single-with-no-row
marker, as `_dst` below) when the link has none — a frontmatter link
(`_field` set, `_block_id` null): `_block` renders no key, `_block._text` is
absent, `_block == null` is true. `_block._id`, `_block._path` and
`_block._doc_id` read the row's own columns (the foreign-key elimination of
§1); a `where` over `_block.<k>` pushes down as a probe of the block row by
`block_id` — NULL exactly where `_block` is absent —
`_block._raw`/`_hash`/`_updated_at`/`_attrs` and the block's relations stay
residual (`query-links::block-reach-through`, `::block-reach-through-filter`,
`::block-text-filter-residual`, `::block-absent-for-a-frontmatter-link`,
`::block-identity-reads-the-foreign-key`, `::block-doc-is-the-source`). A
handle is not an attribute: the closed-row error of §1.5 lists the thirteen
attributes, then the handles. And `_dst` (3.0 follow-up) is the DESTINATION
document — the docs row `_dst_id` names when `_dst_kind == "document"` and
that document exists (`_dst_path` already names it; resolved by `_dst_id`
exactly as `_dst_path` is), absent (`undefined`) for a `block` or `external`
destination and for a phantom (the kind with no row). `_dst` never reaches
into a block. So `_dst._title` is the destination's computed title, `_dst {
_title }` a one-element list (or empty), `_dst values` the row as `{ _id,
_path }` (or null), `_out_links exists { _dst.layer == "draft" }` a
doc-level filter on what is linked to, and `_dst._id` / `_dst._path` read
`_dst_id` / `_dst_path` wherever `_dst` exists (`query-links::dst-reach-through`,
`::dst-block-sugar`, `::dst-identity-reads-the-foreign-key`,
`::dst-filter-pushes-down`, `::dst-path-literal-rooted`;
`reads::dst-on-links` for an external link). A link carries **no authored
data**, so a bare name on it (`target`, `dst`) is §1.5's closed-kind error
(the 5.0 links case of `query-links.json` reads `_dst_path`). The creating commit
(`from_commit`) is not a field: a query sees open edges only and the commit
is history (`blocks_history`, `changes_since`), §9.

**revisions** (4.7)**.** History as rows: one row per `revisions` row of every
document of the repository (`spec/store` §4 — a revision is minted by every
commit that renders the document; a deletion commits no revision), joined to
its commit, **tombstoned documents' revisions included**. It is `docs_history`'s
list as a target, and `docs_history`'s versions carry its names (§3).
Attributes: `_id` (the revision id, `r_…`), `_path` (`revisions.path` in the
reference form: the path the revision was committed under — except that a
document move (`spec/mutate` §6) re-paths the **current** revision to the
new path and mints none, so after a move the revisions before the current
one keep the old path and the current one reads the new; `reads::revisions`),
`_rev` (= `_id`, for symmetry with `docs_history`), `_seq` (`revisions.seq`,
`1..k` per document — not the commit's), `_doc_id`, `_commit` (the
`commit_id`), `_ts` / `_origin` / `_actor` / `_reason` (the commit's columns;
`_actor`/`_reason` null when none), `_hash` (hex of `rendered_hash` — the
document's `_hash` as of the revision, `docs_history`'s `_hash`),
`_is_current` (boolean: the revision is the document's `current_rev` —
`docs_history`'s `_is_current`; a deleted document's last revision stays its
current one, the tombstone keeps `current_rev`), `_archived` (4.9). No other
name: a revision carries no authored data, so its row shape is **closed**
like `links` (§1.5; the 5.0 revisions case of `query-revisions.json` reads
`_seq` and `_actor`). One
reach-through: `_doc` is the document's **current** live row (`_doc._path`
the path NOW, `_doc._title`, `_doc.layer`, …) and **absent** — the
single-with-no-row marker, as `_dst` on a dangling link — for a tombstoned
document, so `_doc == null` selects the revisions of deleted documents,
`_doc { _title }` yields nothing for them, and `_doc._revisions` is the
document's whole list again. No relations of its own. `text()` and
`semantic()` are `filter_invalid` on revisions (a revision is bytes and a
hash, not an indexed body); the bytes as of a revision are `docs_read { at }`
(§2). The root scan (§1.1) orders `(path, rev_id)` so the keyset cursor
pages it like every target (`query-revisions::page-*`); `order by _seq` is a
document's chronology, `order by _ts desc, _seq desc` the repository's. The
planner never plans a revisions scan (it runs in memory; there is no store
index for it, so a correlated `^revisions` block materializes the scan once
per query). Pinned by `query-revisions.json` (the one-revision corpus: shape,
`_doc`, `_is_current`, ordering, paging, the N/A functions, the relation) and
`reads::revisions` (edits, a move, a deletion; `docs_read { at }` against
the pre-write bytes).

### 1.3 Functions

Free: the `spec/oqx` builtins, plus `entries(<source handle>)` (§1.2: `_data`, `_frontmatter`, `_inline`),
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
whole), so `refs(x)` serves wherever rows do: a source (`refs("/a.md") { … }`),
a directive receiver (`refs(see_also) { _path }`, `refs(before) exists
{ _path == "x" }`), a `follow` destination (`follow refs(before),
refs(after)` walks a timeline both ways), a nested `from` (`from
refs(^before)`), or a value (`size(refs(before))`; as a `values` item its rows
render `{ _id, _path }`, §1.4). It is the remedy for `follow before` over a
list of paths, which reaches the list's strings (§1.4). Row
functions (`text`, `semantic`, `under`, `under_heading`, `within`,
`under_kind`, `yaml_path`, `json_pointer`, `has_edge`, `has_anchor`,
`child_count`, `parent_type`) are written as free calls and evaluated
against the current row — a function name in call position is never an
entry read, so the names stay bare under the 5.0 rule (§1.2):

- `text("terms")`: `spec/search` §1.2 sanitize; empty → false; docs → any
  live block of the doc matches; blocks → the block's FTS row matches;
  nodes → the node's FTS row matches; links and revisions → `filter_invalid`
  (`text(...) is not available on the <kind> target`).
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
  `under_kind(type[, name])` — an ancestor of that `_type` (and text
  containing `name` or `_attrs.key == name`); `yaml_path` / `json_pointer` —
  for `yaml:`/`json:` blocks, `_attrs.key` equals the path or its leaf.
- `has_edge(pred[, dst])` (docs and blocks): an open edge with that
  predicate (and target) from the row; `has_anchor()` (blocks): an edge
  from the block carrying an anchor; `child_count()`, `parent_type()`
  (blocks).

**Dates and durations (4.8).** Two free functions and a set of methods give
the binding Dataview's date arithmetic without a new value kind. A **date is
an ISO-8601 string** — the date-only form `YYYY-MM-DD` or the datetime form
`YYYY-MM-DDThh:mm:ss[.fff](Z|±hh:mm)`, exactly what the store writes for
`_updated_at` and `_ts` and what OQX already orders chronologically (`spec/oqx`
SEMANTICS §6: strings order by code point) — and a **duration is a number of
seconds**. Arithmetic between them is **methods, never operators**: `+` with
a string operand concatenates (SEMANTICS §7), so a date is shifted with
`plus`/`minus` and two dates are subtracted with `until`. Every function and
method is **total**: an argument or receiver that is not what it expects
yields absent (`null`), never an error, so a `where` over documents that
carry a date and documents that do not filters quietly. The one error is a
**wrong arity** — `filter_invalid`, the message `date() takes exactly 1
argument, got 0` / `.plus() takes exactly 1 argument, got 0` /
`.dur_text() takes exactly 0 arguments, got 1` — raised when the call is
evaluated (an empty source never evaluates it, SEMANTICS §11).

- `date(x)` — `x` a string, matched trimmed and case-insensitively against
  the **named points** `now`, `today`, `yesterday`, `tomorrow`, `sow`/`eow`
  (the Monday / the Sunday of the current week), `som`/`eom` (the first /
  last day of the month), `soy`/`eoy` (January 1 / December 31), resolved
  against the **host clock in UTC** (the process clock, which
  `OMGBASE_SPEC_CLOCK` pins, §7.1; a time zone argument is a later round):
  `now` is the instant with milliseconds — `YYYY-MM-DDThh:mm:ss.fffZ`, the
  form the store stamps commits in — and the others are date-only. Any other
  string is parsed as ISO-8601 — `YYYY-MM-DD`, or that followed by `T` (or a
  space) `hh:mm[:ss[.f…]]` and an optional offset `Z` / `±hh:mm` / `±hhmm`, a
  missing offset meaning UTC; a field out of range (month 13, February 30,
  hour 24, second 60) does not parse — and returned **canonical**: a
  date-only input stays date-only; a datetime always has its seconds, keeps a
  fraction as exactly three digits (`.5` → `.500`, `.123456` → `.123`) and
  carries none when the input had none, writes `+00:00` and a missing offset
  as `Z`, and keeps any other offset as written (`2026-10-15T09:00:00+02:00`).
  A canonical string is returned unchanged. A string that is neither, or any
  non-string, is absent.
- `dur(x)` — a number is that many seconds (non-finite is absent); a string is
  parsed as **Dataview's duration grammar**: one or more `<number> <unit>`
  pairs — the number an unsigned or `-`-signed decimal, the unit one of
  `years|year|yrs|yr|y`, `months|month|mos|mo`, `weeks|week|wks|wk|w`,
  `days|day|d`, `hours|hour|hrs|hr|h`, `minutes|minute|mins|min|m`,
  `seconds|second|secs|sec|s`, case-insensitive, optional spaces between the
  number and its unit — each pair separated from the next by spaces, by one
  comma among spaces, or by nothing (`"1h30m"`, `"1 hour 30 minutes"`,
  `"2 days, 3 hours"`; a leading, trailing or doubled comma, a bare number
  with no unit, an unknown unit are malformed); or as an **ISO-8601
  duration** `[-]PnYnMnWnDTnHnMnS` (any component omitted, decimals allowed,
  case-insensitive; a bare `P`/`PT` is malformed). The result is seconds under
  the fixed conventions **a year is 365 days and a month 30 days**
  (`dur("1 month")` is `2592000`); calendar-aware months are `plus` with a
  duration *string*, below. Malformed, or any other type, is absent.

Methods on a date (the receiver is parsed as `date()` parses a non-named
string; a receiver that is not a date — absent, a number, a named point's
*name*, any other string — yields absent):

- `d.plus(x)` / `d.minus(x)` — `x` a **number** of seconds: the instant moves
  by that many seconds (`minus` the negation). `x` a **duration string** (the
  `dur` grammar, ISO included): the whole years and months move the
  **calendar** month field — the year/month fields advance and the day is
  clamped to the new month's length, so `2026-01-31` plus `"1 month"` is
  `2026-02-28` (`2024-02-29` in a leap year) and `2024-02-29` plus `"1 year"`
  is `2025-02-28` — and the rest (weeks, days, hours, minutes, seconds, and
  the fraction of a fractional year/month count at 365/30 days) is added as
  seconds afterwards. A **date-only** receiver stays date-only when the
  seconds part is a whole number of days (`2026-01-31` plus `86400` is
  `2026-02-01`) and otherwise becomes a UTC datetime (`2026-01-31` plus `3600`
  is `2026-01-31T01:00:00Z`); a datetime keeps its written offset and shows a
  fraction when the result has one (`.plus(0.5)` → `.500Z`). A non-duration
  argument (a malformed string, null, a boolean) is absent.
- `a.until(b)` — the seconds from `a` to `b` by instant: negative when `b` is
  earlier, zero when equal, fractional when the datetimes differ by a
  fraction, across offsets (`10:00+02:00` until `10:00Z` is `7200`), a
  date-only side being its midnight UTC. Absent when either side is not a date.
- `d.year()`, `d.month()` (1–12), `d.day()`, `d.weekday()` (**1 = Monday …
  7 = Sunday**), `d.hour()`, `d.minute()`, `d.second()` (the fraction dropped)
  — numbers, read in the **written offset** (`23:30:00-05:00` has `hour()`
  23); a date-only value's time fields are 0. `d.date()` — the date-only part
  as written (`2026-10-15T23:30:00-05:00` → `2026-10-15`), a string.
- `d.format(pattern)` — `pattern` a string scanned left to right taking the
  longest token at each position: `yyyy` the year (four digits), `MM` the
  month, `dd` the day, `HH` the hour, `mm` the minute, `ss` the second (two
  digits each), `MMM` the English month abbreviation (`Jan` … `Dec`), `EEE`
  the English weekday abbreviation (`Mon` … `Sun`); **every other character
  is literal** (`MMMM` is `OctM`, quotes are not escapes). Fields are read in
  the written offset; a date-only value formats its time as `00`. A non-string
  pattern is absent.

Methods on a number (a duration in seconds; any other receiver is absent):

- `n.dur_text()` — `<d>d <h>h <m>m <s>s` with zero parts omitted (`"1h 30m"`,
  `"2d 3h"`, `"45s"`), `"0s"` for zero, a leading `-` for a negative count
  (`"-1m 30s"`), a fractional second kept to the millisecond (`"1.5s"`); a
  month of `dur()` is `"30d"`.
- `n.dur_iso()` — `P[<d>D][T[<h>H][<m>M][<s>S]]` (`"PT1H30M"`, `"P2DT3H"`,
  `"PT45S"`), `"PT0S"` for zero, a leading `-` for a negative count
  (`"-PT1M30S"`). Both round-trip through `dur()`.

**Folding.** A `date(…)`/`dur(…)` whose argument is a literal, and a date
method whose receiver and arguments are literals (`date("today").minus(dur("30
days"))`, folded inside out), is replaced by the literal it evaluates to
before the query is planned — by the same functions, so nothing changes in
meaning, a named point is resolved **once per query**, and `where _updated_at <
date("today")` is a text-against-text comparison the planner pushes down
(§1 decline table: a call is otherwise an unconditional decline). A call with
the wrong arity is left in place (it raises when evaluated). An engine that
does not fold must reach the same results; the fixtures run every case
planned and unplanned (`query-dates.json`).

A datetime is never `<` its own date — `2026-09-27T00:00:00.000Z` sorts
after `2026-09-27`, a longer string with an equal prefix — so "updated
today" is `_updated_at.date() == date("today")` and "before today" is
`_updated_at < date("today")` only for date-only values
(`query-dates::datetime-is-not-less-than-its-own-date`).

### 1.4 The runner

`query(source, limit = 50, cursor?, bare = false)` → `OqxResult { hits,
truncated, cursor, consumer, count?, exists?, none?, values? }`:

- `exists` / `count` / `none` consumers return the scalar and no hits.
- otherwise **every hit is `{ _id, _path, ...projection }`** (3.0; 5.0
  spelling): the row's identity under the *same* engine names the expression
  language reads, injected first, then whatever `select` projected. The
  envelope keys are the attributes, so a key copied from a hit is valid in
  the next `where` with no translation — `docs { select _id where _id ==
  "d_14" }` returns `{ _id: "d_14", _path: "/substances/salt.md" }`
  (`query-docs::hit-envelope-round-trip`, `reads::hit-envelope-round-trip`,
  §7 `read-query`). **Projections may not overwrite the envelope**: `select
  _id, _path` is simply the envelope (the attribute collapses onto its own
  key, never a duplicate column — `query-docs::select-id-path-is-the-envelope`;
  an alias of the attribute onto its own name, `_id: _id` / `_path: _path`,
  likewise — `::aliases-onto-the-envelope-of-the-attribute-itself-collapse`),
  and any OTHER projection whose output key would be `_id` or `_path` —
  `select _path: path` (the author's key under the engine's name), `select
  _path: _doc.layer`, `select _path: _doc._path` on a block — is a loud
  `filter_invalid` asking for an alias: "projection `_path` collides with
  the hit envelope — alias it (`p: …`)" / "projection `_id` collides with the
  hit envelope — alias it (`i: …`)" (`query-errors::envelope-collision-*`;
  checked over the resolved select items before the engine runs, the first
  offending item in select order; `values` mode has no envelope and is
  exempt). A bare `select path` or `select id` collides with nothing in 5.0:
  the author's `path`/`id` key is an ordinary column beside the envelope's
  `_path`/`_id` (through 4.11 `select data.path` was the collision case). A
  projection alias beginning `__oqx_` or `__omg_` is refused before the
  engine runs too (4.1: "projection `__oqx_id` uses the reserved prefix
  `__oqx_` — choose another alias"; the prefixes name the runner's injected
  items and the selector compiler's slots, `spec/mutate` §11.8 — through 4.0
  `select __oqx_id: 1` overwrote the hit's `id`). History: before batch 3 of
  3.0 the envelope was `$id`/`$path` and `id`/`path` were ordinary columns;
  from 3.0 through 4.11 it was `id`/`path` (the bare attributes of that
  rule); before 3.0 the envelope spelled `id`/`path` while the language
  rejected the bare names and a user column named `id` or `path` overwrote
  it (§9). `first`/`single` return zero or one hit, no cursor.
- **A hit is a store row (1.5).** Every top-level row of a `collect`, `first`
  or `single` query must be a docs, blocks, nodes, links or (4.7) revisions
  row; a query whose rows reach anything else — `follow before` over a
  frontmatter list of paths (the strings), a block re-projected to scalars
  (`docs { select $it from tags }`) — fails as `filter_invalid` with
  the message `` a hit must be a document, block, node, link or revision row —
  the query reached a string ("/timeline/kickoff.md"); to follow document
  references held in a property use refs(<field>) `` (`… node or link row …`
  through 4.6) (the value's kind and, for a string, number or boolean,
  its value: `a string ("…")`, `a number (3)`, `a boolean (true)`, `an absent
  value`, `an array`, `an object`, `a range`). Before 1.5 such a row rendered
  as the junk hit `{ id: "undefined", path: "" }` (§9). The rule is about
  hits only: a `values` projection returns no hits, so its rows may be
  scalars (`follow before` with `select $it values` yields the seed as `{ _id,
  _path }` and then the raw strings; `query-refs::values-mode-over-scalar-rows-is-exempt`),
  and a nested block's rows are never hits — rows as values below is unchanged
  (`tags { }` is the tag strings).
- `collect`: a top-level `select distinct` dedups hits by the user
  projection (every key but the envelope's `_id`/`_path`; first wins), the
  query's own `limit`/`offset` (integer literals only, else `filter_invalid`)
  bound the set after that, then the page: with the default order the keyset
  cursor `(path, id)` — the hit's `_path`, so the reference form, and its
  `_id` — skips rows at or before the cursor, `cap = limit`, `truncated` =
  more remained, `cursor` = the last hit's `(_path, _id)` when truncated; a
  custom `order by` disables the cursor (the top `cap` is returned,
  `truncated` still honest). The cursor encodes the two *values*, never key
  names, so a 2.x cursor stays valid on 3.0 and a 4.x one on 5.0
  (`reads::hit-envelope-round-trip` pages with one).
- `values`: the single projected item is returned as `values: [...]` with
  `hits` empty — no hits, so the envelope does not apply
  (`query-docs::values-mode-is-unchanged-by-the-envelope`).
- **`bare` (4.2).** With `bare: true` every hit is its **projection only** —
  no automatic `_id`/`_path` members — so `docs { select _title, era … }`
  yields `{ _title, era }` rows (`query-docs::bare-projection`; `first`/
  `single` return their one hit bare too, `::bare-first-is-the-projection`).
  The rules, checked in this order over the resolved query before the engine
  runs (so the error never depends on the rows): `values` beside it is
  `filter_invalid` "`bare` is redundant with `values` — `values` is already
  the bare-values form; drop one" (`::bare-with-values-refused`); no `select`
  is `filter_invalid` "`bare` needs a `select` — without a projection a hit is
  only its envelope" (`::bare-needs-select`); the scalar consumers `count` /
  `exists` / `none` return no hits, so `bare` has nothing to strip and is not
  an error (`::bare-scalar-consumer-is-unaffected`). A projected `_id`/`_path`
  is the attribute it reads everywhere (the name rule), here an ordinary
  column under the key the query gave it — `select _id` is `{ _id: "d_14" }`
  (`::bare-select-id-is-the-intrinsic`); a bare `id` stays the authored key —
  and with no envelope there is nothing to collide with: the
  envelope-collision rule above is not applied, so `select _path: layer, _id:
  _type` is `{ _path: "canon", _id: "substance" }` where the default mode
  refuses it (`::bare-no-envelope-no-collision`). `distinct` dedups by the
  projection, which under `bare` includes a projected `_id`/`_path` (every
  row distinct — `::bare-distinct-counts-a-projected-id`; the default mode's
  envelope collapses it). **Paging is unchanged**: the runner keeps every
  row's identity internally and strips the envelope LAST — after `distinct`,
  the query's own `limit`/`offset` and the keyset page — so `truncated` and
  `cursor` are exactly the enveloped query's and a cursor continues a bare
  sequence (`::bare-paging-keeps-cursor` issues the same cursor as the
  enveloped `docs { select _title }` with `limit 2`;
  `::bare-paging-continues-from-cursor`). `follow` results and nested
  `collect`/`first`/`single` blocks are values, not hits, and are untouched
  (rows as values below still render `{ _id, _path }`). The default envelope is
  what makes a hit a follow-up handle and a selector's write target
  (`spec/mutate` §11.8); `bare` is for display and export, where identity is
  noise.
- **Rows as values (1.2).** Wherever a row surfaces
  as a *value* rather than as a hit — a nested `collect { }` / `first { }` /
  `single { }` with an empty projection (`spec/oqx` §12: "the row itself"),
  or a `values` projection of a row — it is rendered as `{ _id, _path }`
  (the row's id column and its document's path), never the store row (§9:
  before 1.2 the raw row leaked, `attrs` as a JSON string and the join
  column `__path` included). One notation for "a document, block, node or
  edge reference" everywhere a row shape appears in a query result: the hit
  envelope and a row-as-value spell identity the same way
  (`query-docs::rows-as-values-are-id-path-refs`). Hits are otherwise
  unaffected: `{ _id, _path, ...projection }` as above.
- **One notation everywhere (3.0; 5.0 spelling).** The envelope is not only
  the `query` tool's: every tool result that renders a document, block, node,
  link or revision row names it the same way — `_id`, `_path`, and where the
  result carries the row's bytes or hash `_raw`/`_hash`, its time
  `_updated_at` (§1.2 "same value, same name"; §2–§4 list every shape).
  `docs_list` items are `{ _id, _path, _updated_at, blocks }`, `docs_read` is
  `{ _id, _path, rev, properties, _raw, … }`, `graph` documents `{ _id,
  _path, degree, … }`, `blocks_search` hits `{ _id, _doc_id, _path, _type,
  _text, score }`, `blocks_resolve` `{ _id, locator, … }`, a `changes_since`
  or `apply` revision `{ _id, _path, _hash }`, `blocks_read` `{ _id, _type,
  … }`, a `docs_history` version `{ _rev, _seq, … }` (`reads::hit-envelope-round-trip`
  closes with a `docs_list` and a `blocks_read` showing the shared
  spelling). A key naming a role keeps its name (`rev`, `kind`, `score`,
  `label`, `parent_id`, `blocks` as a count, `commit`, `cursor`). Before 3.0
  each tool had its own (`path`, `docId`, `blockId`, `contentHash`, …); from
  3.0 through 4.11 the shared spelling was bare (`id`, `path`, `raw`, …).
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

### 1.5 Unknown names (4.6; one tier since 5.0)

A query that projects, filters or orders by a name no row of the scope's kind
can carry used to run silently: `links { select _path, target }` (links have
`_dst_path`) returned rows of an absent column; `where target == "x"` matched
nothing, `where target != "x"` and `not has(target)` matched **everything** —
and a write selector aimed by such a name would have selected every row. Since
4.6 every name a query reads is judged **statically**, before any row is read,
against the vocabulary of the row kind it is read from. The verdict never
depends on the query's own filter or on which rows come back: a correct query
never warns because of what it happens to match. Since 5.0 the judgement is
**one rule, read off the name's spelling** (§1.2): an underscore-prefixed name
is an engine name and must be one of the kind's; a bare name is an authored
property and is judged against what the repository's objects carry.

**Which names are judged.** The references of the query per `spec/oqx`
AST.md §5b (`references`): every bare identifier, every dotted navigation
headed by one (`_doc.layer`, `meta.owner`, `_data.x`), every outer reference
(`^stage`, `^_title`), in `select` items, `where`, `order by`, `frontier`, a
`follow` destination (plain or the receiver of a destination block) and inside
every nested block (`_nodes exists { _kind == … }` judges `_kind` against
nodes; `^docs exists { layer == … }` judges `layer` against docs), and
the receiver of a method call (`target.contains("x")` references `target`).
The kind a name is judged against is the kind of the rows of its scope,
resolved along the scope's row chain: the root collection, each `from`, each
block receiver, a `follow` walk (its frontier rows have the seeds' kind when
every destination yields rows of that kind, else no kind), through the handles
and relations of §1.2 (`_doc.x` on a block, link or revision judges `x` against
docs; `_dst.x` on a link likewise; `_children.x` on a block against blocks;
`_revisions.x` on a document against revisions). **Not judged:** `select`
aliases where the language resolves them (every clause of the same body that
reads its rows — `where`, `order by`, `follow`, … — the later items, and
`^alias` from a nested block, OQX 0.27; `resolve` already validates them),
names a nested block lifts onto the
scope (`^open: value`), `$`-names (`$it`, `$key`, `$depth`, …), `${}` bindings,
function and method names (a call is never an entry read), root names (`docs`
heading a body, `^docs`; an unknown one is §1.1's error), the member tail under
an engine attribute (`_attrs.anything`, `_tags.size()`), a scope whose kind
cannot be determined (a `refs(x)`-free value receiver, a walk over mixed
kinds), and the root scope (depth 0).

**The verdict** of a judged name at a scope whose kind is known (5.0; the
three tiers of 4.6 — engine attribute, carried authored property, absent name
— collapse onto the spelling):

1. an **underscore-prefixed name** is an engine name. One of the kind's (the
   §1.2 table: attributes, reach-throughs, the source handles on docs,
   relations) — known, silent. Any other `_x` is **`filter_invalid`** on every
   kind, in a read and in a selector alike — the engine's set is closed, so
   this is the one place a loud error is right (`unknown-engine-name-is-loud`:
   `_nope`). An authored key that begins with `_` is reached as `_data._x`
   (§1.2), never by its bare spelling.
2. a **bare name** is an authored property read. On an **open** kind (`docs`,
   `blocks`, `nodes`) it is known and silent when at least one live object of
   the kind in the repository carries it, however partial (`stage` on three
   processes out of twenty documents is the data model working); a name **no
   object carries** yields absent and is the complaint — `hints` on a read,
   a refusal in a write selector. On a **closed** kind (`links`, `revisions`
   — no authored data reaches a link or revision row) every bare name is
   `filter_invalid`.
3. a name **under a source handle** (`_data.x`, `_frontmatter.x`, `_inline.x`)
   is an authored lookup by construction: judged as 2 against the authored
   keys alone, its hint spelling the handle.

**Severity.**

| the scope's kind | on a read (`query`, and every read that evaluates OQX) | in a write selector (`select` of `plan` / `apply` / `execute`, `spec/mutate` §11.8) |
| --- | --- | --- |
| any kind, a `_x` that is no engine name of the kind | `filter_invalid`, `data.hint` `"OQX"` | the same refusal |
| `links`, `revisions` (4.7), a bare name — a **closed** row shape | `filter_invalid`, `data.hint` `"OQX"` | the same refusal |
| `docs`, `blocks`, `nodes`, a bare name no object carries — **open** | the result gains **`hints`** (below); the rows are still returned | `filter_invalid`: the refusal, before any row is read, no partial write |
| any kind, in `order by` | as `where` | as `where` |
| any open kind with **no live object** in the repository | no authored vocabulary — the bare-name check is skipped for that kind (no hint, no error); the engine-name check still runs | the same |

A bare name no object carries is refused in a selector because a name no row
carries selects every row (`where target != "x"`) or none; the refusal is
raised at the selector's compile step through the runner's AST entry
(`unknownNames: "refuse"`, the default of that entry; the source entry every
read uses defaults to `"hint"`). Only the **selector's own text** is judged:
the expressions of the request's effect templates (`-> parent`, `{ oqx: … }`),
which the compiler appends to the selector's tree as its slot items, are not
the selector — an expression there that reads a property no row carries is
`spec/mutate` §11.8's own outcome (`target_missing`, an absent value), not an
unknown name. `links` are never a selector root (§11.8), so a links error
reaches a selector only through a nested block.

**`hints`.** A member of the `query` result (and of every `OqxResult`): an
array of strings, one per offending bare name of an open kind, in
**first-reference order** — the canonical walk order of `spec/oqx` AST.md §5:
`select`, then the source and `from`, `where`, `frontier`, `follow`, `order
by`, `limit`, `offset`, each nested block's clauses where the block stands —
**deduplicated** by text. It is the **last** member, after
`hits`/`truncated`/`cursor`/`consumer` and the scalar members, and **absent
when empty** (never `[]`). It rides on every result shape: hits, `bare` hits,
`values`, `count`, `exists`, `none`. It is not the error envelope's `data.hint`
(which names a grammar).

**The vocabulary.** Per (repository, kind), read from the store the first time
a judged bare name is not already known:

- `docs`: `SELECT DISTINCT key FROM properties WHERE repo_id = ? AND
  deleted_commit IS NULL AND source IN ('frontmatter', 'inline')` — the
  flattened dotted keys of every live frontmatter or inline property, both
  document-scoped and block-scoped rows, since a document's bare read merges
  them (§1.2). Computed keys (`$title`, `$tags`, source `computed`) are the
  engine names `_title`/`_tags`, never authored vocabulary; an authored
  `$`-prefixed key (`$version:`) is vocabulary (reached as
  `_frontmatter.$version`, `reads::arguments`), and so is an authored
  `_`-prefixed key (reached as `_data._x`; its bare spelling is tier 1's
  error). A dotted name is known when it **equals a key or is a dotted prefix
  of one** (`meta` is known when `meta.owner` exists; `stage.x` is not known
  when `stage` is a scalar key). `_frontmatter.<k>` and `_inline.<k>` are
  judged against the same merged vocabulary (not split by source).
- `blocks`, `nodes`: a bare name on a block or node reads its `_attrs` (§1.2),
  so the vocabulary is `SELECT DISTINCT j.key FROM <the §1.1 scan of the kind>,
  json_each(<alias>.attrs) j` over the live rows — the attrs keys the format
  layer writes (`spec/format`: `level`, `ordered`, `start`, `checked`, `lang`,
  `info`; `key`, `index`, `value` for YAML/JSON documents; `spec/graph`:
  `checked`, `level`, `first_ordinal`, `last_ordinal` on nodes) **as present in
  this repository**: `lang` is known in a repository with a code fence, `checked`
  in one with a task. Block-scoped rows of the `properties` table are NOT a
  block's vocabulary — a block row does not read inline fields by bare name
  (`spec/surface` §1.2); they are the owning document's.
- `links`, `revisions`: none (closed).
- "No live object of the kind" is the §1.1 scan with `LIMIT 1` coming back
  empty.

The engine names need no store read: they are the §1.2 table, a constant per
kind in both engines.

**Caching.** The vocabulary is cached per (store, repository, kind), keyed on
the repository's **head commit** — `MAX(seq)` over `commits` for the
repository — the one value every property or attrs change moves (every write
is a commit); a read on an unchanged repository costs one indexed scalar
query. The Rust port keys its cache the same way.

**Messages** (byte-identical across engines; the nearest-match clause is
present only when there is one). The engine-name list a message carries is
the kind's, in the §1.2 order — attributes, then reach-throughs, then (docs)
the source handles, then relations:

- an unknown engine name, any kind (a read, and a selector reaching it):
  `` `_nope` is not an engine name of docs (engine names: _id, _path, _raw, _hash, _updated_at, _created_at, _title, _tags, _format, _data, _frontmatter, _inline, _blocks, _nodes, _out_links, _in_links, _revisions); did you mean `_title`? ``
  — `<name>` as judged (the path after any handle or relation); blocks list
  `_id, _path, _doc_id, _raw, _hash, _updated_at, _created_at, _type, _text,
  _attrs, _depth, _ordinal, _doc, _children, _nodes, _out_links, _section`,
  nodes `_id, _path, _doc_id, _block_id, _kind, _name, _value, _attrs, _doc,
  _block, _blocks, _subsections, _children`, links `_id, _path, _doc_id,
  _block_id, _via_id, _dst_id, _dst_path, _uri, _field, _dst_kind,
  _predicate, _provenance, _anchor, _doc, _dst, _block`, revisions `_id,
  _path, _rev, _seq, _doc_id, _commit, _ts, _origin, _actor, _reason, _hash,
  _is_current, _archived, _doc`;
- a bare name on a closed kind (`links`, `revisions`), and a selector
  reaching one:
  `` `target` reads an authored property, and a link carries none (engine names: _id, _path, _doc_id, _block_id, _via_id, _dst_id, _dst_path, _uri, _field, _dst_kind, _predicate, _provenance, _anchor, _doc, _dst, _block); did you mean `_dst_path`? ``
  — `a revision carries none` with the revisions list for the other;
- a bare name on an open kind that no object carries, bare or under a
  reach-through or relation (the hint, and the selector's refusal):
  `` no document in this repository carries a property `title`; did you mean `_title`? ``
  — the kind's singular noun (`document` / `block` / `node`); the nearest
  match drawn from the authored keys ∪ the kind's engine names, so a bare
  `title`, `id`, `path`, `tags`, `format`, `text`, `type`, `seq` whose `_`
  form is an engine name is always pointed at it;
- a bare name under a **source handle** (`_data.x`, `_frontmatter.x`,
  `_inline.x`), where the name is an authored lookup by construction:
  `` no document in this repository carries a property `paht` (`_data.paht`); did you mean `path`? ``
  — the nearest match drawn from the authored keys alone;
- a selector: the same text under the `select: ` prefix the selector's other
  refusals carry (`spec/mutate` §11.8; `filter_invalid { hint: "selection" }`).

Through 4.11 the messages were three tiers over a bare vocabulary (`` `x` is
not a field of links (fields: id, path, …) ``, `` `x` is not a field of blocks
and no block in this repository carries a property by that name ``, the
`data.x` form); the engine-attribute confusion tier and the `data.<k>`
suggestions are gone with the rule that made them necessary.

**The nearest match.** Over the candidates a message names — the kind's
engine names (attributes, reach-throughs, the source handles for docs,
relations) and, where the name is authored, the authored keys — compared
**case-insensitively**: a candidate qualifies when its optimal-string-alignment
distance (Levenshtein with adjacent transpositions, every edit 1) to the name is
**≤ 2**, OR when one of the two is a substring of the other and the shorter has
**≥ 3** characters. Ranking (5.0): **a candidate that is exactly the name with
the `_` prefix added or removed wins outright, whatever its length** (`id` →
`_id`, `_layer` → `layer`, `ts` → `_ts` — the one typo the rule itself
invites); otherwise a candidate at distance **1** (one typo) wins first;
otherwise a substring match outranks a distance-2 match; within a class the
lowest distance wins, ties go to the shorter candidate, then the
alphabetically first. A name under **3** characters gets no suggestion apart
from the prefix rule (it is within distance 2 of nearly everything, and too
short for the substring rule). No qualifying candidate, no clause. Pinned by
`query-unknown.json` as respelled for 5.0 (the suite's truths — a
transposition, a prefix at distance 1, a substring over a shorter
distance-2 match, the names too short or too far for a clause — hold under
the new candidate sets, with `_`-spelled targets wherever the nearest is an
engine name: `titel` → `_title`, `dst_pth` → `_dst_path`, `checkd` →
`checked`, `preview` on blocks no clause).

Pinned by `query-unknown.json` (the two spellings of a judged name, each
clause and scope shape, the dedup order, the message forms, the nearest-match
truths, the closed-kind errors, the loud engine-name error, `hints` on every
result shape; the 5.0 case `unknown-engine-name-is-loud`); the moved cases of
4.6 are listed in §9.

## 2. Reads

- **`resolve_ref(ref)`**: an `n_` + 12 hex node id → its block when the block
  is live, else its doc; a `b_` id → its live block; a `d_` id → the live doc;
  anything else → the live doc at that path; null when nothing matches.
- **`docs_read(_id? | _path?, include_ids?, at?)`**: `{ _id, _path (reference form), rev,
  properties (grouped, spec/properties §5 — with the `computed` group's keys
  spelled as the attributes that read them, `{ _title, _tags }`, the stored
  `$title`/`$tags` rows re-keyed at this boundary; the authored groups
  verbatim — bare keys, an authored `$x:` key keeping its sigil, an authored
  `_x:` key keeping its underscore), _raw (spec/store §6.1 — the document's
  `_raw`, §1.2) }` + with ids `ids` (pre-order), `hashes` (a map block `_id`
  → block `_hash`), `parents` (block `_id` → parent `_id` or null); the two
  maps keep their id-keyed shape and their role names (`ids`, `hashes`,
  `parents`). `docs_read_many(docs, include_ids?, budget_tokens?)`:
  first-seen dedup, cap 100 (`truncated`), a miss → `errors: [{ ref, error:
  "doc_not_found" }]`, the budget (`ceil(JSON length / 4)` per item) stops
  early with `truncated` — but **at least one item is always returned**
  (1.2, the uniform list contract of `docs_list`/`docs_tree`: the budget
  is checked before the second item onward; a first item that alone exceeds
  it is still emitted and the batch is `truncated` if more remained).
  **`at` (4.7).** `docs_read { _id | _path, at: <rev> }` is the document **as of
  that revision**: `{ _id, _path (the path AS OF the revision — `revisions.path`,
  reference form), rev (the given one), _raw (`spec/store` §6.2 reconstruct:
  leading trivia, the revision's frontmatter blob, the top-level raws with
  their trivia in order — exactly the bytes a `docs_read` without `at`
  returned when that revision was current), renderedHashMatch (the
  reconstruction hashes to the revision's `rendered_hash`; false only when the
  document-level trivia, stored per document, changed since) }` and nothing
  else: **no `properties`** — the property table is current-state only
  (`spec/properties`) and the authored bag is not yet recomputable from the
  bytes in one call of the format layer, so the read carries nothing it would
  have to guess at (a client wanting the frontmatter as of a revision parses
  `_raw`). `include_ids` together with `at` is `filter_invalid` "`include_ids`
  is not available with `at` (docs_read takes _id?, _path?, at?, include_ids?,
  repo?)" — `data.hint` `"arguments"`, raised after the locator (a missing
  document is `doc_missing` first), since each argument is valid on its own
  (block ids at a past revision are a later question); a `rev` that
  is not a revision of the document — unknown, or another document's — is
  `target_missing` "no revision \"<rev>\" for document <id>" (`data: { doc,
  rev }`); the document itself must be live (`doc_missing` otherwise, as every
  `docs_` locator). **`docs_read_at(_id? | _path?, rev)` is sugar** for `docs_read
  { _id | _path, at: rev }` — the same code path, the identical result (through
  4.6 it also returned the CURRENT property bag flagged `propertiesAreCurrent:
  true`, §9). Revision ids come from the `revisions` target (§1.2: `from
  revisions where _path == "/x.md" order by _seq`), `docs_history`, `changes_since`
  or `docs_diff`. Pinned by `reads::revisions` (the first revision's bytes
  equal the pre-edit source; `docs_read_at` equals `docs_read { at }`), the
  moved cases of `reads::history` and `interop::read-history-admin`.
  **Archived revisions (4.9; `spec/store` §7.1, 15.0).** A revision whose
  bodies the retention squash moved to an archive segment (`_archived: true`
  on the `revisions` target and in `docs_history`) reads exactly as before
  when its segment is attached — the store reconstructs through the segment
  (`spec/store` §6.2), the same bytes, `renderedHashMatch` as for a live
  revision — and when the segment is **not attached** (never recorded, or
  detached) or **not on disk** the read fails `revision_archived` "revision
  \"<rev>\" is archived in segment <id>, which is not attached (omg history
  attach <file>)" / "…, which is not on disk" with `data: { rev, archive,
  path? }` (`path` only when the segment is recorded, naming the missing
  file). The same code covers `docs_read_at`, `docs_diff` and
  `docs_diff_unified` when either revision is archived and unavailable. No
  MCP tool archives, attaches or lists segments: that is the operator's
  `omg history` (`spec/cli` 4.6) — the catalog's whole trace of retention is
  the attribute and the error. Pinned by `reads::archived`.
- **`blocks_read(_id, resolution = full)`** (`nodes_get`, then `blocks_get`,
  before 3.0 — it always took a block id and returned a block; `nodes` now
  names the extracted-entity rows and `read` is the one verb for "return the
  row", §9): the block subtree projected at a resolution — `skeleton` `{ _id,
  _type, label = heading text or type }`, `outline` `{ _id, _type, label =
  first 12 words… }`, `text` `{ _id, _type, _text }`, `raw` `{ _id, _type,
  _raw, _hash }`, `full` (`_raw`, `_hash`, `_text`, `_attrs`, then the
  placement flattened onto the row: `_ordinal`, `_depth`, `parent_id` (null
  at the top level; a role key)); `_children` recursively (the relation's
  name, §1.2; `label` and `parent_id` are roles and stay bare). The block's
  `_raw`/`_hash` are the row attributes of §1.2 (`_hash` is the value an
  `update`/`split` op expects as `expect.content_hash`); the owning document
  is inferred from the id (the `doc`/`path` scope arguments are gone, 3.0);
  `_id` is a BLOCK id — the `blocks_` kind's attribute (§4 "Names and
  arguments") — so an `n_` node id is `block_missing` "no block with _id
  \"n_…\" (an n_ id names a node — nodes_block_read reads its block)" (3.0
  follow-up, §9; the name pass had dereferenced it here).
  **`nodes_block_read(_id, resolution = full)`** (3.0 follow-up): `_id` is a
  NODE id; the result is exactly `blocks_read`'s for the block the node was
  projected from — same shape, same resolution ladder and default. An unknown
  node is `block_missing` "no node with _id \"…\""; a node naming no live
  block (a block-less node, e.g. one derived from the frontmatter) is
  `block_missing` "node \"n_…\" has no block" (`data: { _id, _doc_id }`)
  (`reads::resolution-ladders`). `blocks_read_many(_ids, resolution = text,
  budget_tokens?)` (`nodes_get_many`, then `blocks_get_many`, before 3.0):
  cap 100, request order, no children, `unresolved` for ids naming no live
  block, `truncated` on the cap or the budget; at least one resolved block is
  always returned (1.2, as `docs_read_many`); the items are `nodes[]` (a role
  name kept from before the name pass), each a `blocks_read` row.
- **`docs_outline(_id? | _path?, resolution = outline, depth?, budget_tokens?)`**:
  one line per block, `"  " × depth + id + " " + type label padded to 4 +
  " " + label`, `"  §"` appended for headings, trailing spaces trimmed; type
  labels `h<level>`, `p`, `ul`, `li` (list items and tasks), `bq`, `code`,
  `tbl`, `tr`, `hr`, `html`, `raw`; labels: containers `""`, tasks `☐`/`☑` +
  ten words, others ten words (`…` when cut), `skeleton` none; `depth`
  limits nesting; the budget (`ceil(line length / 4)`) truncates.
- **`docs_list(path_glob?, limit = 200, cursor?, budget_tokens?)`**: live
  docs by path, `path LIKE glob` (`*` → `%`, `%`/`_`/`\` escaped; the glob
  in either form), rows `{ _id, _path (reference form), _updated_at (the
  current revision's commit ts or null), blocks (live count — a role, bare) }`,
  fetched `limit + 1`, keyset cursor `[path]` (values, so unchanged by the
  3.0 or 5.0 key names), budget as above (at least one row).
  **`docs_tree(path?, depth = 1, files = false, updated = false, …)`** (5.1;
  `path` here is a prefix — a role argument, §4): the prefix normalized
  (either form accepted; reported rooted — `/` for the repo root, else
  `/<dir>/`). **The page is a directory rollup**: one entry per directory
  within `depth` segments under the prefix — `{ _path (rooted, ending `/`),
  docs, blocks }`, the totals over everything beneath it, a nested directory
  listed after its parent in path order (`/projects/`, `/projects/aurora/`,
  …) — and the documents directly in the prefix are COUNTED as `files_here`,
  not listed. **`files: true`** lists the documents within `depth` segments
  too, interleaved in path order as `{ _id, _path, blocks }` (no `docs`: a
  document is one; no `kind`: a directory ends in `/`, a document carries an
  `_id`). **`updated: true`** adds `_updated_at` to every entry (a directory's
  the latest last-commit time beneath it). `total: { docs, blocks }` and
  `files_here` cover everything under the prefix whatever the page; `depth`
  below 1 reads as 1; ordered by path and paged the same way (`limit`,
  `cursor` = `[path]`, `budget_tokens`, `truncated`). Through 5.0 every entry
  was `{ _id?, _path, kind: "dir" | "doc", docs, blocks, _updated_at }` and
  the documents were always listed, so `depth: 2` on a flat 348-document
  repository was a 29 kB two-page listing (`files_here` and the nested
  directory rows are new; the 5.0 page is not reproducible exactly — §9,
  Decisions 2026-10-21). Pinned by `reads::tree-rollup`.

## 3. History

Result keys in §2–§4 are written as they appear on the wire: a row attribute
is its engine name (`_id`, `_path`, `_hash`, `_updated_at`, `_raw`, `_doc_id`,
§1.2), a role key that is not a row attribute keeps its own name
(`parent_id`, `rev`, `commit`, `seq` on a digest) and the remaining role keys
keep the reference's **camelCase** (`hasSource`, `currentRev`,
`renderedHashMatch`, `commitId`, `baseRevision`, …; `isCurrent` and
`propertiesAreCurrent` are gone — the former is the revision row's
`_is_current`, the latter left with 4.7); the fixtures pin the wire verbatim.

- **`blocks_history(_id, limit = 100)`** (`history_node` before 3.0): the
  block's `block_changes` joined to commits and dispositions, newest first:
  `{ commitId, seq, ts, origin, kind, confidence, reason }` (a change record,
  not a row: unchanged in 3.0 and in 5.0 — only the argument moved to `_id`).
- **`docs_diff(_id? | _path?, from_rev, to_rev)`** (`diff { doc_id? | doc_path? }` before 3.0): both revisions must belong to the doc,
  else `target_missing` (§9: the reference treated an unknown revision as
  empty and reported every block removed); block-grain — the id → raw maps
  of both revisions' Merkle trees (all depths); entries `removed` (in from
  only), `changed` (raw differs), `added` (in to only), in that order, each
  `{ kind, _id (the block), before?, after? }`. **`docs_diff_unified(_id? | _path?, from_rev?, to_rev?)`** (`diff_unified` before 3.0):
  defaults to the previous and current revisions (`target_missing` when
  none); `{ _id, _path, from, to, diff }` where `diff` is a **unified diff** of the
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
- **`changes_since`**: `spec/sync` §6 (3.0; the digest shape and paging;
  `summary` unpinned) — each digest's `revisions` are `[{ _id, _path, _hash
  }]` (the document, its path as of the commit, the revision's rendered
  hash — the same three keys an `apply` revision carries, §4); the digest's
  own keys (`commit`, `seq`, `ts`, `origin`, `actor`, `summary`, `cursor`,
  `head`, `truncated`) are roles — a digest describes a commit, not a row
  kind — and stay bare; every path in a digest, the `summary`'s subject
  included, in the reference form (2.0).
- **`docs_history(path_glob | _id | _path, include_deleted?, limit = 50)`**: docs by
  path (glob as `docs_list`; a glob without `*` is an exact path), live only
  unless `include_deleted`, `limit + 1` for `truncated`; each `{ _id, _path
  (reference form), deleted, currentRev, versions: [{ _rev, _seq, _commit,
  _ts, _origin, _actor, _hash (the rendered hash), _is_current, _archived
  (4.9) }] }` oldest first. **A version is a `revisions` row** (5.0), under
  the row's names exactly — the same list is the `revisions` query target
  (§1.2, 4.7): `revisions { _path == … order by _seq }`, so a key
  copied from a version is valid in the next query (through 4.11 a version
  spelled `updated_at` for the row's `ts` and `isCurrent` for `is_current`);
  `deleted` and `currentRev` are roles of the document entry. A `select
  _raw`-less client of the minimal profile reads history through `query` +
  `docs_read { at }`.
  Archiving (`spec/store` §7.1) changes none of these shapes: an archived
  revision stays in `docs_history`, the `revisions` target and
  `changes_since` (whose `summary` for a wholly archived commit carries no
  disposition counts — they moved with the segment; the summary is
  unpinned); `blocks_history` lists the live `block_changes` rows only — a
  block's earliest row survives the squash, every later row of a wholly
  archived commit is in the segment and not read back in this round.

## 4. The MCP tool catalog

Served as MCP over stdio; every result is one text content item holding
JSON; an error result has `isError: true` and the envelope `{ error: <code>,
message, data?, retriable }`. Codes: `spec/mutate` §8 plus `filter_invalid`
(OQX and cursor errors, `data: { reason, hint }`; argument-shape errors,
`data: { reason, hint: "arguments" }`; a selector or template the
query-directed admission refuses, `data: { reason, hint: "selection" }`,
4.1), `budget_exceeded`,
`provider_unavailable` (3.0; `semantic_unavailable` before), `embedder_failed`,
`repo_not_found`, `ambiguous_heading`, `block_not_container` (3.0),
`conflicted_document`, `ambiguous_locator`, `seed_unresolved`, `plan_unknown`
(5.1: `execute { plan_id }` alone naming a plan this server does not remember
— `data: { plan_id }`, retriable, the message "this server has no plan <id> —
re-run plan, or pass the plan (or `plan_id` + `effects`) with execute" spelled
alike by both engines and pinned, `reads::plan-memory`). Any other
failure is `repo_not_found` with the message (§9).

**Arguments (3.0, normative; 5.0 spelling).** A tool's prefix names the row
kind it addresses — `docs_`, `blocks_`, `nodes_`, `links_` — and an argument
that addresses one of that kind's **engine fields is spelled as the field**,
underscore included (§1.2 "same value, same name"): `docs_outline`,
`docs_read`, `docs_append`, `docs_move`, `docs_delete`, `docs_set_meta`,
`docs_update`, `docs_diff`, `docs_diff_unified`, `docs_read_at` and
`docs_history` take the **locator `_id?` / `_path?`** (at least one);
`blocks_read`, `blocks_update`, `blocks_split`, `blocks_append`,
`blocks_history`, `nodes_block_read` and `nodes_set` take **`_id`** (a block
id on the `blocks_` tools — never a node's; a node id on the two `nodes_`
tools, the latter dereferencing the node to its block, so each tool's `_id`
is unambiguously its namespace's kind — 3.0 follow-up, §9);
`blocks_read_many` and `blocks_check` take **`_ids`**. A handful of
repo-level operations have no kind prefix (`query`, `query_syntax`, `graph`,
`changes_since`, `apply`, `plan`, `execute` (3.1), `observe*`, `repos*`,
`sync_status`, `version`). One verb returns the row: **`read`** (`docs_read`,
`docs_read_many`, `docs_read_at`, `blocks_read`, `blocks_read_many`). No tool
refers to a document of another kind, so no argument is a foreign key; were
one added it would say `_doc_id` / `_doc_path`. **Role arguments keep their
names**, bare: `docs` (a list of refs), `blocks` (an op's operand list),
`to`, `at`, `roots`, `select`, `expect`, `effects`, `plan`, `plan_id`,
`reason`, `diffs`, `markdown`, `text`, `content`, `frontmatter`, `set`,
`unset`, `section`, `checked`, `separator`, `prop`, `value`, `resolution`,
`depth`, `limit`, `cursor`, `budget_tokens`, `include_ids`,
`include_deleted`, `at` (a revision), `rev`, `from_rev`, `to_rev`,
`path_glob`, `docs_tree.path` (a prefix), `docs_create.path` and `to_path`
(where to create / move — no row carries the path yet), `observe { path,
content }` / `observe_many.files[].path` / `observe_delete.path` (FILE events
from the store's layer, not row locators), `from_target`, `to_target`,
`repairs`, `q`, `query`, `bare`, `origin`, `degrees`, `direction`,
`predicate`, `max_documents`, `summary`, `repo`; the kernel-op grammar
(`block`, `blocks`, `to`, `at.before|after`, `expect.content_hash`, `op`) is
spec/mutate's and is unchanged. **No tolerance (5.0).** A bare `id`, `path`
or `ids` argument is an argument error, never an alias: `filter_invalid {
hint: "arguments", fix }` with the message "`id` is not an argument — the
document's id is `_id` (an engine field: the bare namespace is the user's)"
(`path` → `_path`, `ids` → `_ids`; "the block's id" on a `blocks_` tool, "the
node's id" on a `nodes_` tool) and `data.fix` the same call respelled
(`reads::bare-id-argument-has-fix`); the bare argument name `doc` no longer
exists. Through 4.11 the arguments were bare because the attributes were
(the 3.0 flip); they move with the attributes, for the same reason. A
`docs_*` locator takes at least one of `_id`/`_path` (else `filter_invalid`
"pass _id or _path"); both given must name the same document (else
`filter_invalid` "_id "…" and _path "…" name different documents"); a miss is
`doc_missing` "no document with _id or _path "<value>"" with the arguments
as given in `data` (`{ _id?, _path? }`); a block the caller named that is
not live is `block_missing` "no block with _id "<value>"", a node "no node
with _id …". Every call's shape is checked before its handler, in both
engines alike: an unknown argument name is `filter_invalid` naming the
nearest valid one — "unknown argument `q`; did you mean `query`?"
(Levenshtein ≤ 2 or a prefix either way; the names 3.0 retired name their
replacement, respelled for 5.0: "`doc` is no longer an argument — pass `_id`
or `_path`", `block`/`node` → `_id`, `heading` → `section`, `markdown` →
`text`; and the inputs 4.0 retired theirs: "`ops` is no longer an argument —
`apply` takes `effects` (the kernel ops are a library/fixture contract since
spec/mutate 3.0)", "`dry_run` is no longer an argument — preview with `plan
{ effects: [...] }`", "`attrs` is no longer an argument — pass `checked`") —
a missing one "`query` is required", a mistyped one "`limit` must be an
integer" (`a string`, `a boolean`, `an object`, `an array of
strings|integers|objects`, `one of a, b, c`), each followed by the tool's
shape in bytewise order with `?` on the optional names — `_` sorts before
every letter, so the engine fields lead: "(docs_read takes _id?, _path?,
at?, include_ids?, repo?)"; a tool with none "takes no arguments". The
unknown-name check runs first (bytewise order of the names given), then
presence and type per declared name (bytewise); the nested shapes (`expect`,
`at`, an effect) are each engine's own. The messages above are pinned by the
fixtures (§6). **String lists (4.5).** Every list-of-strings argument —
`docs_read_many.docs`, `blocks_read_many._ids`, `graph.roots` and
`graph.select`, `blocks_move`/`blocks_remove`/`blocks_merge.blocks`,
`blocks_check._ids`, `docs_set_meta.unset` — also takes
ONE bare string as a one-element list (`{ docs: "/a.md" }` is `{ docs:
["/a.md"] }`; the handler sees the list). A comma-joined string is still the
array error — "`docs` must be an array of strings (…)" — but that error
carries `data.fix` (§4 "Error data"): the same call, canonical JSON, with the
string split on `,` (each part trimmed, empty parts dropped):
`{"docs":["a.md","b.md"],"include_ids":true}`. Any other non-list value is
the same message with no `fix`. The `roots` minimum (one root) holds for the
bare form too. **Stringified JSON arrays (4.11).** A string whose trimmed
form starts with `[` is parsed as JSON: a JSON array of strings is accepted
as that array (`{ _ids: "[\"b_1\",\"b_2\"]" }` is `{ _ids: ["b_1", "b_2"] }` —
the intent is unambiguous, the same tolerance class as the bare string; the
`roots` minimum holds for it); anything else — a parse failure, a non-string
member — is the array error above with a `fix` whose list is the parsed array
when the text parsed (`{ _ids: "[1, 2]" }` → `{"_ids":[1,2]}`) and the comma
split otherwise (a malformed `[`). A string that does not open `[` follows
the 4.5 rules unchanged (`reads::arguments`).

**Profiles (4.3, normative).** A server serves one of two catalog
profiles, chosen by the host (`omg mcp --tools <full|minimal>` / `omgbase mcp
--tools …`, default `full`; a workspace may set `mcp.tools`, the flag wins;
any other value is the CLI's usage error). `full` is the whole table below.
`minimal` is the ten tools an agent works a knowledge base with: `query`
(every read it covers), `query_syntax`, `docs_read`, `docs_tree`,
`blocks_resolve`, `changes_since`, `plan`, `execute`, `apply`, `version` —
listed in registration order, so `docs_read, docs_tree, query_syntax, query,
blocks_resolve, apply, plan, execute, changes_since, version`
(`cases/profiles.json` pins both lists; both engines check their listing
against it). **A profile filters listing and calling, never semantics**: a
tool the profile keeps behaves exactly as under `full` (same arguments,
results, errors, locks), `tools/list` shows the profile's tools and nothing
else, and `tools/call` on any other name — hidden by the profile, or never a
tool — is the JSON-RPC error `-32602` with the message `unknown tool
<name>`, byte for byte in both engines (not a tool result, not the
`filter_invalid` envelope). `version` reports the profile served:
`profile: "full" | "minimal"`, a new last key (§6 pins it by shape; `omg
version` itself says `full`). Nothing else about a tool depends on the
profile. The CLI's `--server` verbs ask `tools/list` once per connection and
send `apply { effects }` where a sugar tool is not listed (`spec/cli` §2.3).

**Descriptions (4.3).** A tool's `description` is the same text under every
profile (`tool-descriptions.json`). The descriptions of the ten minimal tools
are **example ladders**: a one-line summary (`<tool> — …`), then one example
call per line, then a last line pointing at `query_syntax`. A **rung** is a
line beginning `{` holding the call's arguments as JSON, then three or more
spaces, then a comment; the JSON ends where the first run of three spaces
begins (so a rung's JSON never holds one); a line beginning `{` that holds an
ellipsis (`…`) or an angle-bracket placeholder (`<…>`) is a schema line, not
a rung. Every rung is a real call over the alchemy corpus: the reference
extracts them mechanically (`packages/core/src/mcp/examples.test.ts`), tool
by tool in registration order and rung by rung, into the step list of
`cases/examples.json` — one case over one workspace, a write tool's steps
under the clock `2026-10-13T00:00:00.000Z` — and the suite runs them like a
`reads.json` case, so an example that stops being true fails the suite and a
rung edited without regenerating the suite fails the extraction test (the
drift gate: extraction(descriptions) equals the suite's steps bytewise). The
ids and paths in the rungs are the fixture's (`d_14` is `substances/salt.md`,
`b_153` the `Tasks` heading of `processes/calcination.md`); the `execute`
rung's `plan_id` is the digest of the `plan` rung over the same effects, so
it re-pins whenever `planner_v` moves — and it moved with 5.0, since every
Plan precondition spells `_id`/`_path` (§4 `plan`). Each ladder stays under 900
characters for client portability (`cases/examples.json`'s own test pins the
budget). Since 4.4 the write rungs are spelled in the `spec/mutate` 3.2 sugar
— a bare path, id or `$new.n` as a target, the `-> expr` leader for an
expression — and each trailing comment teaches one thing; the plans they
produce equal the 4.3 object-form rungs' where the intent is the same
(`mcp/examples.test.ts` pins those digests). Since 4.5 the `query` ladder
carries a `links` rung (`links { select _path, _block_id where _dst_path ==
"/processes/calcination.md" }` — inbound links, `_path` the source) and a
string-method rung (`_title.lower().contains("salt")`, the comment naming
`matches("^Merc")` for a regex), its first rung folding the tag-membership
and paging example into the frontmatter one to stay in budget; `plan`'s
summary line names `diffs: true` — since 4.11 as the opt-in it is (`Need
file bodies? add diffs: true.`; through 4.10 it read `diffs: true for file
bodies.` and every `plan` call of the 2026-10-17 agent-bench run passed it)
and since 5.1 tells the model what comes next: `Commit: execute { plan_id }.`
— the id alone (the 2026-10-21 run echoed every Plan back whole as
`execute`'s input, 5.7 kB mean, 19 kB max of output tokens); the `execute`
ladder's one rung is `{"plan_id":"4cebb67f…"}` — the id of the `plan`
ladder's first rung, which the suite's server remembers — and its prose names
the plan and digest forms. Since 5.1 the `query_syntax` ladder has three rungs
(`{}` the card, `{"section":"follow"}` a chapter, `{"section":"all"}` the
manual) and the `docs_tree` ladder teaches the rollup (`{}`), a directory's
documents (`{"path":"/processes/","files":true}`) and the nested rollup
(`{"depth":2,"updated":true}`).
Since 4.7 the `docs_read` ladder carries
the time-travel rung `{"_path":"/processes/calcination.md","at":"r_7"}` (the
comment pointing at `revisions { _path == … }` for the ids; `r_7` is
the revision the fixture minter gives that document's ingest, so the rung
runs before any write) — 31 steps since 5.1 (29 through 5.0). The ladders are the first of
three teaching surfaces: the second is the error `fix` — every error the
engine can correct carries `data.fix`, a literal corrected call (§9;
`spec/mutate` §8) — and the third the plan's `summary`, one line in words per
effect, repeated by every Receipt (`spec/mutate` §11.9).

**Repo scoping.** Every repo-scoped tool takes an optional `repo` slug;
omitted → the server's default repo; unknown → `repo_not_found`. A repo's
root is derived (`spec/sync` §1); a mutating tool on a sourceless repo fails
`repo_not_found` ("mutation disabled").

**Ref resolution (server side).** `_id` is looked up by id only and `_path`
by path (either form, §1 Paths) — never one falling through to the other; a
block-level tool's `_id`/`blocks`/`to`/`at` refs go through `resolve_ref` (a
doc ref as `to` means the document's top level). `docs_append.section` is a
heading's TEXT (an ATX-looking text loses its hashes), matched against the
normalized heading text of the named document's live headings: zero →
`parent_missing` "no heading "<text>" in /<path>" (`data: { section, _path,
fix }`), several → `ambiguous_heading { section, _path, candidates: [{ _id,
_doc_id }], fix }` ("pass the heading's _id to blocks_append"); it is never an
id lookup — the id form is `blocks_append`. The `fix` (4.4, §9) is the
corrected call: for several, `blocks_append { _id: <the first candidate's
_id>, text }`; for none, `blocks_append { _id, text }` over the one heading
whose text matches up to ASCII case when there is exactly one, else the same
`docs_append` without `section` (the document's end). Block-level tools pin
`expect.content_hash` from the live row when the caller omits it.

**Sugar over effects (3.2; 4.0).** The block-level write tools —
`blocks_insert`, `blocks_update`, `blocks_move`, `blocks_remove`,
`blocks_split`, `blocks_merge`, `blocks_check`, `nodes_set`, `blocks_append`,
`docs_append`, `links_retarget`, `links_repair` — are `apply { effects }`
(ADR-021; `spec/mutate` §10): each builds its effects after its own
pre-checks (so its error `data` is unchanged), plans and executes them as
one request with the tool's name as the commit `reason`, and **returns the
Receipt** (4.0: `{ plan_id, commit, revisions, new_ids, committed: true }`,
`revisions[]` as `{ _id, _path, _hash }` with `_path` rooted; through 3.x the apply result `{ results,
revisions, diffs?, committed }` derived from the plan's preview, its dry run
realizing one production mint per symbol). A planner error loses its
`effect_index`. There is no `dry_run` on any sugar tool: the preview of a
write is `plan { effects: [...] }`, which burns no id (§9: "dry runs consume
minted ids" is closed). Two behaviours moved with the migration
(`spec/mutate` §10, pinned): `blocks_update` with `expect: {}` (or an
order-only guard with `markdown`) proceeds with the content hash pinned from
the live row, and `blocks_check` naming a block twice is one write.
`blocks_update` takes `checked` and nothing else of the attrs (4.0: the
`attrs` bag is retired — no other attribute is editable through effects); an
empty `blocks`/`_ids` list is `filter_invalid` ("`blocks` must name at least
one block", with the tool's shape).

**The document operations (3.3; 4.0)** follow: `docs_create` is one `create
{ path, markdown, frontmatter? }`, `docs_delete` one `remove { target:
document }`, `docs_move` one `move { target: document, to, retarget_inbound
}`, `docs_set_meta` one `set`/`unset _frontmatter.<k>` per key (`spec/mutate`
4.0: the field is spelled as the handle it edits; `unset`
winning a key named in both, as the legacy merge did; an empty patch is
`filter_invalid` "pass `set` and/or `unset`", §9) — under the `spec/mutate`
§6 reasons the library wrote (`create <rel>`, `delete <path>`, `move <from>
-> <to>`, `set_meta <path>`, storage-form paths). Each returns the Receipt
(4.0) with its own extras: `docs_move` adds `retargeted` and `dangling`,
recomputed by the tool from `inbound_links_to` + `plan_inbound_retarget`
over the current blocks before the commit (pure, so equal to what the planner
lowered). The tools keep their pre-checks — `locateDoc`'s `doc_missing`, the
create/move `path_taken` pair with the legacy messages and no `data` — so the
planner's copies never fire. Identity (`spec/mutate` §6, §10): a committed
`docs_set_meta` is a known-id head write (`edited / api`, §9) and a committed
`docs_create` a known-id ingest of the planner's adopted tree (`inserted /
api`, no matcher; 4.0 with `spec/mutate` 3.0). **`docs_update`** (4.0) is
one `set { target: { kind: "document", _id }, field: "content", value: content }` returning
the Receipt — content that already equals the document is a plan with
nothing to do (`commit: null`, no revision, `spec/mutate` §11.7); the
identity consequences the 3.x result carried are the Plan's
`preview.identity[<doc id>]` (`plan` row below), the plan-only call being
`plan { effects: [that set] }`.

| Tool | Args | Result |
| --- | --- | --- |
| `docs_outline` | `_id?`, `_path?`, `resolution?`, `depth?`, `budget_tokens?` | §2 |
| `docs_read` | `_id?`, `_path?`, `include_ids?`, `at?` (4.7) | §2 |
| `docs_read_many` | `docs[]`, `include_ids?`, `budget_tokens?` | §2 (`docs_get_many` before 3.0); `items[]` each a `docs_read` result |
| `blocks_read` | `_id`, `resolution?` | §2 (the document inferred from the block; `_id` is a block id — an `n_` id is `block_missing` naming `nodes_block_read`; `nodes_get { doc?, path?, id }`, then `blocks_get`, before 3.0) |
| `nodes_block_read` | `_id`, `resolution?` | §2 (3.0 follow-up): `_id` is a node id; the block it was projected from, exactly as `blocks_read` renders it |
| `blocks_read_many` | `_ids[]`, `resolution?`, `budget_tokens?` | §2 (`nodes_get_many`, then `blocks_get_many`, before 3.0) |
| `docs_tree` / `docs_list` | §2 args (`docs_tree`: `path?`, `depth?`, `files?`, `updated?`, `limit?`, `cursor?`, `budget_tokens?` — 5.1) | §2 (`docs_tree`: `{ prefix, depth, total, files_here, entries, truncated, cursor }`, 5.1) |
| `query_syntax` | `section?` (5.1) | **(5.1)** without `section` the **card**: `{ syntax, sections }` — `syntax` a ~3.5 kB hand-written card (the grammar skeleton and clause order, the names rule with the engine names per kind, the handles and reach-throughs, scoping, the consumers, `follow` in two lines, search, eleven examples, the `data.fix` sentence, the chapter names) and `sections` the chapter names in order; `{ section: "<name>" }` one chapter, `{ section, syntax }` — the manual's `##` headings slugified, in order: `sugar`, `paths`, `targets`, `scoping`, `scalars`, `predicates`, `nested`, `select`, `flatten`, `order`, `follow`, `semantic`, `examples` — the text from that heading up to the next one (trailing blank lines dropped, one trailing newline); `{ section: "all" }` the whole manual (`{ section: "all", syntax }`, the 38 kB text `{ syntax }` carried through 5.0). An unknown name is `filter_invalid { hint: "arguments", fix }`: "unknown section `<name>`; the sections are sugar, …, examples, all (query_syntax takes section?)", `fix` the call respelled with the nearest name (§4 "Arguments": Levenshtein ≤ 2 or a prefix) or `all`. Both engines serve every text byte for byte (the reference's `mcp/reference.ts` is the source; the Rust twin's tests compare against it); pinned by `reads::query-syntax` and the ladders |
| `query` | `query`, `limit?`, `cursor?`, `bare?` (4.2) | §1.4; `semantic(...)` with no provider → `provider_unavailable` (`data: { provider: null }`, the message naming what to configure); a provider whose model has embedded nothing in the repository → `provider_unavailable` too (`data: { provider, model }`), never path-ordered rows with no score (3.0) |
| `graph` | `roots[]`, `degrees? = 1`, `direction? = both`, `predicate?`, `select?[]`, `max_documents? = 200` | `{ roots, degrees, direction, documents: [{ _id, _path, degree, frontier, ...select }], links: [{ _id, _doc_id, _block_id, _via_id, _dst_id, _dst_path, _uri, _dst_kind, _predicate, _provenance, _anchor, _field }], frontier: [{ _id, _path, degree }], truncated, queries }` (`roots`, `degrees`, `direction`, `degree`, `frontier`, `truncated`, `queries` are roles) — compiled to `follow distinct _out_links { from _dst }` / `follow distinct _in_links { from _doc }` (the link rows walked to the documents at their other end, §1.2; `follow doc.out`/`doc.in` before the 3.0 follow-up) with `depth = degrees + 1` (≤ 8, so `degrees` clamps to 7 and the result reports the clamped value), roots depth 0; documents ordered bytewise by path (§9); a link row carries the `links` target's attributes under their own names (§1.2, 3.0 — `edges[]` until the name pass, and before that a rename table spelled `src`/`dst`/`dst_uri`/`src_field`); an `_id`/`_path` selection collapses onto the envelope key exactly as a `query` hit's does, any other name is its own column (deduped by suffix) and an expression is `sel_<i>` — a `graph` selection can never overwrite the envelope |
| `blocks_search` | `q`, `limit?` | `spec/search` §1.3 (3.0; `text_search` before surface 3.0): `{ hits: [{ _id (the block), _doc_id, _path (reference form), _type, _text, score }], truncated }` |
| `blocks_resolve` | `query`, `limit?` | `spec/search` §4 (3.0; `resolve` before surface 3.0; vector fused when a provider exists): `[{ _id, locator, preview, evidence }]`, the `locator`'s path half in the reference form (`/a.md#paragraph[2]`) |
| `apply` | `effects[]`, `select?`, `expect?`, `reason?` | (4.0) `spec/mutate` §11.7: plan + execute under the one tool-call lock and one transaction → the Receipt `{ plan_id, commit, revisions: [{ _id, _path, _hash }], new_ids: { "$new.n": id }, committed: true, summary: [string] }` — `summary` (4.4) the plan's `preview.summary`, one line in words per effect (`spec/mutate` §11.9); `revisions[]._path` in the reference form, `_hash` the document's hash after the commit (the rendered bytes' sha256; the same shape as a `changes_since` revision, §3), `commit` `null` when the plan had nothing to commit; `origin.actor = "agent:mcp"`. The effects' targets are `{ kind: "document", _id? | _path? }`, `{ kind: "block", _id }`, `{ kind: "node", _id }` (or the bare forms — a path, a `b_`/`d_`/`n_` id, `$new.n`; `{ kind: "section", heading_id }` unchanged) and their fields `_frontmatter.<key>`, `_attrs.checked`, `content`, `markdown` (`spec/mutate` 4.0 §11). **Every mutating tool below returns this Receipt** (its extras noted per row). `effects` missing → `filter_invalid` "`effects` is required"; the 3.x inputs → the retired-name errors above (`ops` — the kernel ops `apply` took through 3.x are a library/fixture contract, `spec/mutate` §4 — and `dry_run`: the preview is `plan`). **Query-directed (4.1, `spec/mutate` §11.8)**: with `select` (an OQX query string) the `effects` are templates bound to the selector's hits exactly as `plan` does below, and `expect: { max }` is **required** — missing → `filter_invalid { hint: "selection" }` ("`expect.max` is required on `apply` with `select`"); more hits than `max` → `selection_too_large`, nothing written; zero hits → the Receipt with `commit: null`. `expect` without `select` is `filter_invalid` too |
| `plan` | `effects[]`, `select?`, `expect?`, `diffs?` | (3.1) `spec/mutate` §11.6: the Plan `{ version, planner_v, effects, opset, preconditions, new_ids, selection?, plan_id, diagnostics, preview }` with `preview` included — `preview.summary` (4.4, `spec/mutate` §11.9) one line in words per effect, the plan as a worked example. **`diffs` (4.5, default `false`)**: `preview.diffs` — the whole before/after bytes of every touched document, 13–19 kB for one `retarget`/`move` and carried through every later turn by a client that then executes by `plan_id` — is returned only when `diffs: true`; otherwise the `preview` omits the `diffs` member and is otherwise identical (`results`, `revisions`, `summary`, `identity?`, `retarget?`). The `preview` is outside the digest, so `plan_id` is the same either way; the `spec/mutate` Plan object is unchanged (a library caller always has the diffs). The CLI's `--server` dry runs pass `diffs: true` because they print them. **The executable core is returned verbatim in the storage form** — `effects[].target._path`, `preconditions.docs[]._path`, `preconditions.absent_paths`, `opset.creates[].path`, `opset.moves[].from/to`, `opset.tombstones[]._path` — because `plan_id` digests exactly those bytes and the client hands the object back to `execute` (the one result the path rule of §1 exempts, as `dangling[].target` is); only `preview.revisions[]._path`, the `preview.diffs` keys and `preview.retarget[].hits[]._path` are rooted. The Plan's row-bearing members spell the row attributes (5.0, `spec/mutate` 4.0): `preconditions.docs[{ _id, _path, base_revision, _hash }]`, `preconditions.blocks[{ _id, content_hash }]`, `opset.moves[{ _id, from, to }]`, `opset.tombstones[{ _id, _path }]`, `preview.revisions[{ _id, _path, _hash }]` — so every pinned `plan_id` moved with 5.0; `effects` (as given), `opset.ops` (the kernel-op grammar), `set_frontmatter[{ doc, raw }]`, `preconditions.parents[{ doc, parent, parent_children_hash }]`, `absent_paths`, `new_ids`, `selection` and the rest of `preview` keep their role names. `preview` (4.0, `spec/mutate` §11.4) also carries `identity` when the plan has a `set content` — per document `{ matcher_v, summary, ops: [{ op_index, disposition, blocks, confidence, reason, detail? }], diagnostics }`, the whole-document planner's annotations (the 3.x `docs_update { dry_run }` result) — and `retarget` when it has a `retarget` effect: `[{ effect_index, hits: [{ _id, _path, oldRaw, newRaw }], pairs: [{ from, to, hits }] }]` (the 3.x `links_*` dry run). A malformed effect is `filter_invalid` (`hint: "arguments"`, the message naming `effects[i]` and the member), a contradiction `conflicting_effects`, a stale guard `stale_expectation` / `stale_plan` — `spec/mutate` §8/§11. Listed with the write tools: it runs under the lock. It is **the** preview: no tool takes `dry_run` (4.0). **Query-directed (4.1, `spec/mutate` §11.8)**: `select` is an OQX query over `docs`, `blocks` or `nodes` whose hits, bound to the `effects` as templates (a template without a target writes to the hit; a target or value member may be `{ "oqx": "<expression>" }` over the hit's row), ARE the planned effects — the Plan's `effects` are the concrete expansion in hit order and `selection: { query, expect?, templates, cardinality, identities }` (the selector and templates as given, the hit ids) joins the digested core, `planner_v` `p3`; `expect: { max }` bounds the selection (`selection_too_large { cardinality, max, implicit? }` beyond it, or beyond 1000 without one); the admission refusals (`offset`, `distinct`, `values`, `follow`, body `from`, `links`, a non-row consumer, a reserved `__omg_`/`__oqx_` alias, a `retarget` template, `{ oqx }` out of a slot) are `filter_invalid { hint: "selection" }`; a target expression yielding nothing is `target_missing { effect_index, template_index, row, expression }` (`row` the hit as `{ _id, _path }`), one yielding a list `ambiguous_target { …, count }`; zero hits is an empty plan (`effects: []`, `selection.cardinality: 0`). `expect` is `{ max: <non-negative integer> }` and nothing else (the argument check: "`expect` must be an object", a nested `max` problem named by path) |
| `execute` | `plan` (an object), or `plan_id` alone (5.1), or `plan_id` + `effects[]` + `select?` + `expect?` (exactly one form, else `filter_invalid` "pass exactly one of `plan`, `plan_id` or `plan_id` + `effects`" (5.1 wording; "pass exactly one of `plan` or `plan_id` + `effects`" through 5.0) — `select`/`expect` count as the digest form, so `plan_id` with `expect` but no `effects`, or `effects` alone, is "the digest form needs both `plan_id` and `effects`"), `reason?` | (3.1) `spec/mutate` §11.7: the plan form admits (`unsupported_plan_version { version, supported: [1] }`, `filter_invalid`, `plan_mismatch { expected, actual }`) then commits — a query-directed plan carries its `selection` and replays without OQX (4.1); the digest form re-plans (with the selector when `select` is given, 4.1: the hits are digested, so a hit that appeared or vanished is `plan_mismatch`) and commits on digest equality else `plan_mismatch`; the committed plan's preconditions re-validated in the transaction (`stale_plan`, retriable — its `data.fix` the `apply` that re-plans and commits in one call, `spec/mutate` §8). **The id alone (5.1, the server's memory).** A server REMEMBERS the plans it produced in this process — every `plan` result (plain or query-directed), keyed by `plan_id`, the most recent 64 (`PLAN_MEMORY`; the least recently produced is evicted first; a re-planned id moves to the front) — and `execute { plan_id }` with nothing else runs the remembered Plan through the FULL plan form: `stale_plan` and `plan_mismatch` are told apart exactly as if the client had echoed the object, a selector plan replays without OQX, the Receipt's `summary` is the plan's, and the client sends 64 hex instead of 5–19 kB. A `plan_id` this server does not remember — another server's, a restart's, an evicted or never-planned one — is `plan_unknown { plan_id }` (retriable, §4 codes). The memory is a layer on `spec/mutate` §11.7, not a change to it: an executed plan stays remembered and its replay fails `stale_plan` by its preconditions (no idempotent replay, no server-held handle beyond the lookup); the memory survives any intervening call; nothing else about `execute` depends on it. Pinned by `reads::plan-memory` (both forms, the unknown id, the half forms, the eviction is a unit test) and the `execute` ladder. The Receipt `{ plan_id, commit, revisions: [{ _id, _path, _hash }], new_ids: { "$new.n": id }, committed: true, summary }`, `revisions[]._path` rooted; `origin.actor = "agent:mcp"` |
| `blocks_insert` | `to`, `markdown`, `at? = end`, `expect? { parent_children_hash? }` | the Receipt; `expect` is the destination-parent CAS of `spec/mutate` §1.2 (1.2) |
| `blocks_update` | `_id`, `markdown?`, `checked?`, `expect?` | the Receipt (4.0; `{ id, ids, ...apply result }` and an `attrs` bag through 3.x — `attrs` is a retired name); 3.2: `set markdown` and/or `set _attrs.checked` (`attrs.checked` through `spec/mutate` 3.x) — `expect: {}` or an order-only guard with `markdown` is completed by the planner (`stale_expectation` "expect.content_hash required" before), `markdown` + `checked` is two effects in one plan |
| `blocks_move` | `blocks[]` (non-empty), `to`, `at?`, `expect? { parent_children_hash? }` | a doc ref as `to` must be the blocks' own document, else `target_missing`; `expect` is the destination-parent CAS, checked once (1.2) |
| `blocks_remove` | `blocks[]` (non-empty) | |
| `blocks_split` | `_id`, `at[]` (bytes) | (`block` before 3.0) |
| `blocks_merge` | `blocks[]` (non-empty), `separator?` | |
| `blocks_check` | `_ids[]` (non-empty), `checked? = true` | check (or uncheck with `checked: false`) the given task blocks (`tasks_complete { blocks[] }` before 3.0); 3.2: a block named twice is one write |
| `nodes_set` | `_id`, `prop`, `value` | an unknown node → `block_missing` "no node with _id …" (`node_set { node }` before 3.0); `prop` is the node editor's property name (`value`, `name`, `checked`), a role |
| `blocks_append` | `_id`, `text` | (3.0) append INTO a block by what it is: a heading → the end of its section range (`spec/mutate` §5 `sections_append`), a container (`spec/mutate` §1.1) → the end of its children (an insert `to: { parent: id, at: "end" }`), a leaf → `block_not_container` (`data: { _id, _type, fix }`, the message pointing at `blocks_insert … at.after`; the `fix` (4.4, §9) IS that call: `blocks_insert { to: <the leaf's parent block id, or the document's rooted path when it is top-level>, at: { after: <id> }, markdown: <text> }`) |
| `docs_append` | `_id?`, `_path?`, `text`, `section?` | `section` is a heading's text inside the document (above); absent → the document's end (`sections_append { heading, markdown, doc?, path? }` is gone, 3.0: appending is a document-level act or an into-a-block act) |
| `links_retarget` | `from_target`, `to_target`, `path_glob?` | (4.0: commits — it was a dry run by default through 3.x, with `applied`) `{ hits: [{ _id (the block), _path, oldRaw, newRaw }], pairs: [{ from, to, hits }], ...the Receipt }`; no hit → the Receipt with `commit: null`. The preview is `plan { effects: [{ op: "retarget", repairs, path_glob? }] }` → `preview.retarget` |
| `links_stale` | `path_glob?`, `limit? = 500`, `summary?` | `spec/graph` §6 (2.0): `{ stale: [{ _doc_id, _path (the source), _block_id (null for a frontmatter edge), _predicate, _provenance, _dst_kind, target, authored, _anchor, reason }], truncated, summary?: { total, byTarget: [{ target, count }], bySource: [{ _path, count }] } }` — a link row's attributes under the `links` target's names (§1.2), `target`, `authored` and `reason` roles (the stale target is not a row attribute: the row has no destination), `_path`, `target` and `bySource[]._path` in the reference form (`authored` stays as written) |
| `links_repair` | `repairs[]` or `from_target`+`to_target`, `path_glob?` | as retarget; neither given → `target_missing` |
| `docs_create` / `docs_move` / `docs_delete` / `docs_set_meta` | `docs_create { path, markdown, frontmatter? }` (`path` a role: no row carries it yet); the others `_id?`/`_path?` + `spec/mutate` §6 args (`to_path`, `retarget_inbound?`, `set?`/`unset?` — at least one key between them, 3.3) | (3.3: `apply { effects }` sugar, above; 4.0: the Receipt) `docs_create`'s `revisions[0]` is the created document (`new_ids["$new.0"]` its id, the rest its blocks); `docs_move` adds `retargeted` and `dangling: [{ _doc_id, _path, _block_id, target, _anchor, _field? }]` (the inbound edges left pointing at the old path, each a link row under the `links` target's names, `target` the old path as a role; a move retargets the inbound links unless `retarget_inbound: false`, `spec/mutate` 1.3) — `dangling[]._path` in the reference form, `dangling[].target` as authored. The preview of each is `plan` over its effect (a create `"" → bytes`, a delete `bytes → ""`, a move two entries + the rewritten sources, a meta patch before → after, in `preview.diffs`); through 3.x `dry_run` (1.3) returned `{ id, path, committed: false, diffs }` and a dry-run create minted its `d` |
| `docs_update` | `_id?`, `_path?`, `content`, `reason?` | (4.0) sugar for `apply { effects: [{ op: "set", target: { kind: "document", _id }, field: "content", value: content }] }` → the Receipt; content equal to the document → `commit: null`, `revisions: []` (`spec/mutate` §11.7). The plan-only call is `plan` over that effect, its `preview.identity[<id>]` the opset's annotations (through 3.x `{ opset, plan, result }` with `dry_run` the plan-only call — the removed `docs_plan_update` was exactly that dry run, §9) |
| `observe` / `observe_many` / `observe_delete` | `spec/store` §5 (`path` — a file event's path, a role — in either form) | its outcomes (`observe` sweeps the pool) as `{ _id, _path, rev, commitId, converged, echo, conflicted, dispositions }` (`observe_many`: one per item, `observe_delete`: `{ _id, _path, deleted }`) — the store's own `{ doc, commit, rev }` outcome of `spec/store` §9 is re-shaped at this boundary, `_path` in the reference form |
| `blocks_history` | `_id`, `limit?` | §3 (not repo-scoped; `history_node` before 3.0) |
| `docs_diff` / `docs_diff_unified` / `docs_read_at` / `docs_history` / `changes_since` | §3 | §3 (`diff` / `diff_unified` before 3.0; `docs_read_at` is `docs_read { at }`'s sugar since 4.7, §2) |
| `repos_status` / `sync_status` | `repo?` | `spec/sync` §4.4 (3.0); `repos_status` names the repository `{ _id, slug, … }` (the root row's `_id`, §1.1; `slug` and the rest roles); `sync_status` unchanged |
| `repos` | — | `{ repos: [{ slug, has_source }] }` by slug |
| `version` | — | (1.4) which engine and which versions: `{ engine: "typescript" \| "rust", version, components: { <package or crate>: <version>, … }, specs: { oqx, format, reconcile, store, properties, graph, search, mutate, sync, surface, cli }, schema, mcp: { protocol, sdk? }, runtime, commit, built }` — `version` is the serving binary's own (the `omgbase` npm package or crate); `components` every omgbase package the binary is built from with its version (the reference: `omgbase`, `@omgbase/core`, `@omgbase/oqx`, `@omgbase/sync`, `@omgbase/fs-adapter`; the port: `omgbase` and each `omgbase-*` crate and `oqx`), keys sorted bytewise; `specs` the `spec/<x>/VERSION` each was built against (a compile-time constant, not a file read); `schema` the open database's `PRAGMA user_version`; `mcp.protocol` the protocol version served, `mcp.sdk` the SDK's version when one is used; `runtime` `node <version>` or `rustc <version>`; `commit` the build's git revision (short, `null` when unknown — a published crate reads `.cargo_vcs_info.json`, the npm package a `build-info.json` written by `pnpm build`), `built` its RFC 3339 build time or `null`; `profile` (4.3, the last key) the catalog profile served, `"full"` or `"minimal"` (§4 "Profiles"). Values are engine- and release-specific, so §6 pins the **shape**: leaves are recorded as their type. No repo scope, no workspace needed beyond the database for `schema` (`null` without one). |

`plan` never triggers the host's post-mutation hook (the embed drain);
successful writes do.

**Error data (3.0; 5.0 spelling).** `spec/mutate` §8's data fields follow
the same rule where they carry a row attribute: `stale_expectation` reports
`current: { _hash, markdown }` (the block's current hash and raw;
`expected_content_hash` echoes the caller's argument and keeps its name),
`stale_plan` `current: { revision, _hash }`; `ambiguous_heading` lists
`candidates: [{ _id, _doc_id }]` (each heading block and its document) beside
`{ section, _path, fix }`, `parent_missing` carries `{ section, _path, fix
}`; `doc_missing` carries the locator as given, `{ _id?, _path? }`,
`block_missing` `{ _id }`; `target_missing`, `op_index`, `block` (the op's
locator), `doc`, `rev`, `reason`, `hint`, `expected_revision`, `retriable`
are roles and unchanged. **`revision_archived`
(4.9)** carries `{ rev, archive, path? }` — the revision, the segment id
its `archive` column names, and the recorded file when there is one (§2).
**`plan_unknown` (5.1)** carries `{ plan_id }` — the id as given (a role);
`plan_id` joins the keys that mark an error as the surface's own, so its
message is recorded by the fixtures (§6).

**`fix` (4.4).** An error the engine can correct carries `data.fix`, a
**literal corrected call**: the arguments as `spec/mutate` §11.5 canonical
JSON, prefixed by a tool's name and one space when the corrected call is to
another tool (`blocks_append {"_id":"b_153","text":"…"}`). The planner's
table is `spec/mutate` §8 (`conflicting_effects`, `ambiguous_target`,
`selection_too_large`, the `expect.max` and selector-source refusals, a
stray `-> `, `stale_plan`, `plan_mismatch`, a `$new.n` before its
`create`, and since 3.4 the four effect-shape mistakes — a bare `"after"`
anchor, a guard-first plural `expect`, an effect-level `expect.max`, a
block `field: "text"`); the surface's own are the three of the append tools
above (`block_not_container`, `parent_missing`, `ambiguous_heading`),
since 4.5 the comma-joined string-list argument (§4 "Arguments": the call
with the list split; since 4.11 a stringified JSON array that is not all
strings, with the parsed array), since 5.0 the **bare engine-field argument**
(`{ id }` / `{ path }` / `{ ids }` → the same call with `_id` / `_path` /
`_ids`, §4 "Arguments"; `reads::bare-id-argument-has-fix`) and, since 4.11,
**the bracket list**: OQX
has no list literal — a tuple is the collection (`spec/oqx` SEMANTICS §3b),
so `_id in ["a", "b"]`, the SQL habit, is the parser's error `unexpected '['
— expected a value (at offset N)`. When the source at `N` opens a bracketed
comma list of **literals** closed by `]` — two or more members, each a string
in either quote, a number, `true`, `false` or `null`, nothing nested — the
message gains `; a list is written as a tuple: (…)` and the error carries
`fix`: the same request (every argument as given — `limit`, `bare`, `repo`
…) with that `[…]` rewritten to `(…)`, the members verbatim. Both `query`
(`query-errors::bracket-list-*`) and a selector (`spec/mutate` §8, the `select:
` prefix; `effects::select-bracket-list-is-a-tuple`) compose it; an identifier
member, a nested bracket, one member (a grouping, not a tuple) or an unclosed
list is the parser's error as it stands. It is built from the call and what
the engine saw —
never a prose template — and both engines compose the same bytes (§6 pins
it as a data field wherever `data` is recorded; since 4.5 a
`filter_invalid`'s `fix` is recorded too, as `data: { fix }`, so the shape
fixes are pinned at the surface where a case reaches them as well as by
`spec/mutate`'s fixtures). The bare-target locator refusal (`spec/mutate`
§11.8 "Sugar") keeps its 3.2 prose `fix`.

## 5. The CLI

`omg` is the same catalog in verb form (`docs/surface-map.md` is the
bijection); this spec pins the catalog, not the terminal rendering (`spec/cli`
does). A Rust `omgbase` binary serves `omgbase mcp` from the same crate and
renders the verbs (`spec/cli` 1.1). **5.0 (`spec/cli` 5.0).** Every verb's
`--json`/`--jsonl` carries the tool result verbatim, so the shapes of §2–§4
are the CLI's; the human hit table's envelope columns are `_id` and `_path`;
the shell's row ref reads `_id` (its label `_path`) and `.field` reads any
projected key (`@1._id`, `@t[1]._path`); the `$id`/`id`/`$path`/`path`
tolerance of the shell's `REF_KEYS` is gone with the rule that made it
necessary.

## 6. Fixtures

- **corpus-backed query cases**: a suite carries `corpus: { "<path>":
  "<source>", … }` (the reference's alchemy repository, 20 documents since
  1.5 — the two `timeline/` milestones carry the `before` / `after` /
  `see_also` document references `refs(x)` resolves — copied
  from `packages/core/corpus/oqx/fixtures/alchemy`; a test keeps the
  embedded copy equal to the files) observed into a fresh repo
  (`spec/store` §9.4 minter, one `observe` batch in bytewise path order at
  `2026-09-27T00:00:00.000Z`, so `d_0` is `index.md`), then `cases: [{ name,
  notes?, query, limit?, cursor?, bare?, expect }]` — `limit`, `cursor` and
  `bare` (4.2) are the `query` tool's arguments — each query run **under the
  corpus clock** (4.8: the process clock is pinned to
  `2026-09-27T00:00:00.000Z`, a Sunday, for the run, so §1.3's named points
  are committed expectations — `date("today")` is `2026-09-27`, `date("sow")`
  `2026-09-21`), with `expect` the `OqxResult`
  as JSON (absent keys for undefined projections; numbers within 1e-9; since
  4.6 `hints: [string…]` as the last key when the query reads a bare name no
  object of an open kind carries, §1.5 — recorded verbatim, so the hint text is pinned; never
  `[]`) or `{ error: "filter_invalid", message_includes, fix? }` — `fix`
  (4.11) the corrected `query` call verbatim when the error carries one
  (§4 "Error data"; the case's `query`/`limit`/`cursor`/`bare` ARE the tool's
  arguments, so the recorded `fix` is the one the tool composes). The reference runs every
  case both planned and in-memory and fails on any difference. Suites:
  `query-docs.json`, `query-blocks.json`, `query-nodes.json`,
  `query-links.json`, `query-follow.json`, `query-functions.json`,
  `query-refs.json`, `query-errors.json` (incl. the 3.0 envelope-collision
  and `$`-name cases; the 5.0 `unknown-engine-name-is-loud` — `_nope` —
  while `bare-id-argument-has-fix` is a tool-argument case and lives in
  `reads.json`), `query-root.json` (the root row, 2.0: `^docs` / `0^docs` /
  `^_id` / `^$it`, the `$repo` and bare-target errors; 5.0:
  `root-id-is-underscored`, `entries-of-root-unchanged`),
  `query-unknown.json` (unknown names, 4.6 §1.5; since 5.0 the two spellings
  of a judged name, `hints`, the closed-kind and engine-name errors, the
  nearest-match truths), `query-revisions.json` (the
  history target, 4.7 §1.2: over the one-revision corpus — row shape, `_doc`,
  `_is_current`, the docs relation, ordering, paging, the N/A functions; the
  multi-revision scripts are `reads::revisions`), `query-dates.json` (dates
  and durations, 4.8 §1.3: every named point under the corpus clock,
  canonical forms, the duration grammar, `plus`/`minus` fixed and calendar,
  `until`, the fields, `format`, `dur_text`/`dur_iso`, the absent cases, the
  four arity errors, and the Dataview idioms over the timeline milestones'
  `when`; the projection-only cases use `bare: true` over `/index.md` so one
  hit carries many values). **The 5.0 cases**, kept short: every fixture query
  respelled by `scripts/rename-engine-names.mjs` and regenerated; new —
  `unknown-engine-name-is-loud`, `doc-on-a-document-is-an-authored-key`,
  `root-id-is-underscored`, `entries-of-root-unchanged`,
  `reads::bare-id-argument-has-fix`, a `query-links.json` case reading
  `_dst_path` and a `query-revisions.json` case reading `_seq`/`_actor`.
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
  (`data` dropped for `filter_invalid` except its `fix`, recorded as `data:
  { fix }` — 4.5; `changes_since` digests lose
  `summary`; `message` kept only for the surface's OWN errors — those whose
  `data` names the argument they could not honor (`_id`, `_path`, `section`,
  `provider`) or that carry `hint: "arguments"`,
  the §4 "Arguments" wording both engines spell alike — and dropped for a
  kernel's or store's). A case with `workspace: true` gives the default repo a
  temporary directory as its `fs` source and server root, seeded from the
  `observe` steps, so writing tools work (file-CAS included) and `repos`
  reports `hasSource: true`; without it the repo is sourceless and every
  writing tool fails `repo_not_found`. `reads::bare-attributes` (3.0, batch
  3; respelled for 5.0) is the name rule's script: a document authoring
  `id`, `path`, `title`, `tags`, `data`, `frontmatter`, `format`, `raw`,
  `hash`, `updated_at`, `order`, `limit` plus a hashtag — every bare name an
  authored key, every `_` name the engine's, `_data.<k>` ≡ `<k>`. `ts` pins
  the clock for the call
  (write tools stamp commits with "now"). Write tools are pinned by
  `spec/mutate`; `read` steps still record their results. A reads script
  may also carry `spec/store` §9.4's retention steps (4.9: `history_export`,
  `history_attach`, `history_detach`, …, run as the store runner runs them,
  the segments in a directory of the case's own) around the reads that show
  `_archived` and `revision_archived` (`reads::archived`).
- **`cursor.json`**: `{ name, parts | (cursor, arity), expect }` encode /
  decode cases (`{ cursor }`, `{ parts }` or `{ error: "filter_invalid" }`).

- **`interop.json`** (§7): the cross-engine suite. The suite carries the
  alchemy `corpus` like a query suite; each case is `{ name, notes?, ts?,
  server_args?, writes?: [call…], reads: [call…], expect: { writes, reads }
  }`, a call `{ tool, args }` or (4.3) the listing `{ method: "tools/list"
  }`; `server_args` (4.3) is extra argv for the reader's server command
  (§7.2). It is run by a different harness from the other suites (both
  engines as separate processes over MCP stdio, every writer × reader
  combination) — `packages/core/corpus/surface/interop.test.ts` and
  `crates/omgbase/tests/interop.rs`; `spec.test.ts` and the surface crate's
  `spec.rs` validate its shape and otherwise leave it to them.

- **`examples.json`** (§4 "Descriptions", 4.3): the example ladders as a
  suite. It carries the alchemy `corpus` like a query suite (the runner
  observes it as one batch at `2026-09-27T00:00:00.000Z` before the steps,
  mirrored into the case's workspace) and one case, `ladders`, shaped as a
  `reads.json` case (`workspace: true`, `read` steps only, outcomes recorded
  the same way): its `steps` are the rungs of the ten minimal tools'
  descriptions in registration order — `docs_read`, `docs_tree`,
  `query_syntax`, `query`, `blocks_resolve` (reads over the pristine corpus),
  `apply` (three commits under `ts: 2026-10-13T00:00:00.000Z`), `plan` (five
  previews over the written state, burning nothing; without `diffs` since
  4.5), `execute` (5.1: the id alone — the suite's server remembers the
  `plan` ladder's first rung; `plan_unknown` would show the rung's `plan_id`
  is stale; the digest form through 5.0), `changes_since`, `version` — 31
  steps since 5.1 (`query_syntax`'s two chapter rungs; 29 since 4.7, the
  `docs_read` ladder's `at` rung; 28 through 4.6, 27 through 4.4). The
  steps are WRITTEN by the extraction test
  (`packages/core/src/mcp/examples.test.ts` under `SURFACE_SPEC_UPDATE=1`,
  run before the spec runner), never by hand; the runner regenerates the
  corpus and `expect`. A port runs the case as it runs `reads.json` and pins
  its own extraction against the same step list.
- **`profiles.json`** (§4 "Profiles", 4.3): `{ suite: "profiles", profiles:
  { full: [names…], minimal: [names…] } }` — each profile's tool names in
  registration order (`full` equals the keys of `tool-descriptions.json`;
  `minimal` ⊆ `full`). Both engines check the listing of a server built for
  each profile against it. Regenerated by the reference like every fixture.
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
key spelled differently on the two transports). **5.0:** every expectation
of `interop.json` spells the engine fields with the underscore — the
`read-query` round trip copies `_id` from a hit into the next `where _id ==
…` — and the Rust twin (`omgbase-surface`, `omgbase-mutate`, `omgbase-sync`,
`omgbase-search`, `omgbase-graph`, the `omgbase` binary) follows in a
separate round, so until it lands the Rust spec runners and the two cross
pairs below are **red by design**; the TypeScript pair is the committed
expectation.

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
   file in order, `_id` `d_<i>`, `echo: false`. Each write's result is
   recorded (§7.3), so `expect.writes` holds one outcome per entry of
   `writes`. The writer is then closed (stdin EOF) and the harness waits for
   it to exit.
3. The **reader** is spawned the same way on `W` — with the case's
   `server_args` appended to its command when given (4.3: `["--tools",
   "minimal"]` serves the minimal profile of §4; the writer is always spawned
   plain, since it seeds through `observe_many`, a tool outside that profile)
   — and each of `reads` is called in order and recorded; then closed.
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
unpinned); a harness may compare whatever it is asked to call. A `version`
call is recorded by shape (§6), which is engine-neutral by construction, so a
case may make one (4.3: it pins `profile`). Two more outcome forms (4.3): the
listing `{ method: "tools/list" }` records `{ tools: [names in the order
served] }`, and a `tools/call` the server answers with a JSON-RPC **error**
rather than a tool result records `{ rpc_error: { code, message } }` — the
message as sent (a client library's "MCP error <code>: " prefix removed);
the one such text pinned is `unknown tool <name>` (`-32602`).

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
is one write), the empty-list argument errors, and a `plan` of a
`blocks_insert` followed by the committed one — the committed ids prove the
plan burned NOTHING (4.0; through 3.x the case ran the sugar's dry run and
the ids proved it burned them, §9). Batch 2 (3.3) adds one read to
`write-docs-set-meta-delete`: `blocks_history` of a block of the patched
document, whose latest disposition is the known-id head write's
`edited`/`api` (§9) — the one observable of the migrated `docs_set_meta`.
The retirement (4.0, `spec/mutate` 3.0) adds `write-effects-create-and-fill`
— one `apply` creates a document and inserts into its section and at its end
and patches its frontmatter, the receipt mapping the document AND its parsed
blocks (`$new.1`…) to the ids the replay minted in the plan's order, the
blocks' biographies `inserted`/`api` — and rewrites `write-docs-update`
(`plan { set content }` pinning `preview.identity`, then two `docs_update`
Receipts, the no-change one `commit: null`); `write-effects-plan-execute`'s
pinned `plan_id` is p2's. With the surface's removals (4.0) `write-apply`
calls `apply { effects }` and previews with `plan { remove }`,
`write-links-retarget-repair` commits both link macros and previews the
third pair with `plan { retarget }` (`preview.retarget`), `write-effects-
stale-plan` pins the retired-name messages (`ops`, `dry_run`, `attrs`) beside
the argument-shape ones, and `write-sugar-over-effects` plans its insert;
`reads.json`'s sugar dry runs are `plan { effects }` calls (the failing ones
stay the tools themselves — a failing write commits nothing) and its
`arguments` case pins the retired names. Query-directed planning (4.1,
`spec/mutate` §11.8) adds `write-select-plan-execute` (a `plan` whose hits
are the two lab notes and whose templates append a line to each note's
subject process — `into` an expression `^docs single { … == ^subject }` —
and mark the note; its `plan_id` digests the `selection`, so the Rust
compiler must bind and digest identically; then `execute` in the digest form
with the same `select`), `write-select-apply-max` (the one-shot `apply` with
`expect.max`, the one without it refused, one with a `max` below the
cardinality refused `selection_too_large`) and `write-select-zero-hits` (an
`apply` over a selector matching nothing → `commit: null`; the `plan` of it
with `cardinality: 0`). The profiles (4.3) add `profile-minimal`: the reader spawned with
`server_args: ["--tools", "minimal"]` lists exactly the ten tools, its
`version` reports `profile: "minimal"` (by shape), a `blocks_insert` is the
`-32602` `unknown tool blocks_insert`, and a `docs_read` answers as under
`full`. `apply`'s file-CAS holds in the writing
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

- **Changed (5.0) — "underscore = engine"** (§1.2; Decisions 2026-10-20):
  every engine field on every record kind is `_`-prefixed and the bare
  namespace is the author's, the self aliases `doc`/`block`/`section` are
  gone, tool results and arguments spell the row attributes with the prefix,
  a bare `id`/`path`/`ids` argument is an error with a `fix`, and §1.5 is one
  tier. Moved: every fixture of every suite that spells an engine name — the
  queries by `scripts/rename-engine-names.mjs`, the expectations regenerated;
  every pinned `plan_id` (the Plan's preconditions spell `_id`/`_path`); the
  `query-unknown` messages (the 4.6 forms are replaced, §1.5); the `$repo`
  message (`^_id`); the envelope-collision messages; `examples::ladders` and
  `tool-descriptions.json` (every rung respelled); `interop.json` (the Rust
  pairs red until the twin lands, §7). New: the 5.0 cases of §6. Not moved:
  `cursor.json` (values, never key names), `profiles.json`, the
  `blocks_history` change record, the `changes_since` digest's own keys,
  `version`.
- **Added (4.11) — four teaching and tolerance changes** from the
  2026-10-17 agent-bench run (Decisions): (1) a string-list argument takes a
  stringified JSON array of strings (§4 "Arguments"), a non-string one or a
  malformed `[` keeping the array error with the parsed array / comma split
  as its `fix`; (2) the `plan` ladder's summary line spells `diffs: true` as
  the opt-in (§4 "Descriptions"); (3) `block` on a link row — the source
  block, absent for a frontmatter link (§1.2; 5.0: `_block`); (4) the bracket-list `fix`
  on a `query` or selector parse error, the message gaining the tuple hint
  (§4 "Error data"; the query-case error shape gains `fix?`, §6). New:
  `reads::arguments` steps 42–46 (a JSON-array string for `docs`, `ids` and
  `roots` accepted; `[1, 2]` → the error with `{"ids":[1,2]}`; a malformed
  `[` → the comma fix), `query-links::block-*` (six), `query-errors::bracket-*`
  (eight: four with a `fix`, four without), `effects::select-bracket-list-is-a-tuple`
  (`spec/mutate`), `tool-descriptions.json`/`examples::ladders` (the `plan`
  summary; no rung moved, the pinned 4.3 digests hold). Moved: nothing else —
  no `query-unknown` message lists a handle (handles are not fields), so the
  links field list is unchanged.
- **Added (4.10) — `created_at`**: an engine attribute on `docs` (the
  first revision's commit `ts`) and on `blocks` (the earliest
  `block_changes` commit `ts`) — bare, winning on collision, an authored
  `created_at:` key reached as `data.created_at` / `attrs.created_at`
  (§1.2; 5.0: the attribute is `_created_at` and the authored key the bare
  `created_at`). The docs form pushes down as `_updated_at` does (a correlated
  subquery over `revisions` at `seq = 1`, also as `_doc._created_at` and
  `_dst._created_at`); the blocks form is residual as the block's
  `_updated_at` is. New: `query-docs::created-at`,
  `::created-at-equals-first-revision`, `::created-at-where-pushdown`,
  `::created-at-where-pushdown-hits`, `::created-at-order-by`,
  `::created-at-wins-on-collision`, `::doc-created-at-reach-through`;
  `query-blocks::created-at`, `::created-at-order-by`, `::created-at-where`,
  `::doc-created-at-reach-through`, `::created-at-wins-on-collision`;
  `reads::created-at` (three days of one document around a `history_export
  { prune }`). Moved, reviewed: `examples::ladders` carries the
  `query_syntax` text's reserved-names table. No `query-unknown` message
  lists docs or blocks fields (only the closed kinds spell theirs), so none
  moved.
- **Added (4.9) — archived history**: `archived` on the `revisions` target
  and in `docs_history` (5.0: `_archived`), and the `revision_archived` error (§1.2, §2, §3;
  `spec/store` 15.0 §7.1). Moved cases, each reviewed: every recorded
  `docs_history` version gained `archived: false` (`reads::history`,
  `reads::errors-and-sourceless-writes`, `reads::workspace-writes`,
  `reads::revisions`), `query-unknown::revisions-is-closed` lists the new
  field, `examples::ladders` carries the `query_syntax` text. New:
  `reads::archived`.
- **Added (4.8) — dates and durations** (§1.3): the free functions `date(x)`
  and `dur(x)`, the date methods `plus`, `minus`, `until`, `year`, `month`,
  `day`, `weekday`, `hour`, `minute`, `second`, `date`, `format`, and the
  number methods `dur_text`, `dur_iso`. New: `query-dates.json` (37 cases).
  Moved cases: `examples::ladders` alone — its `query_syntax` rung records
  the reference text, which gained the `dates` row; no query expectation
  changed. The fixture contract
  (§6) gains one rule: a query case runs under the corpus clock, which no
  earlier case could observe. Two details the code decided: `now` carries
  milliseconds (`…T00:00:00.000Z`, the store's stamp form) while a parsed
  datetime carries a fraction only when written with one — so
  `updated_at <= date("now")` holds at the stamping instant, and
  `date("2026-10-15T09:00:00Z")` is not rewritten with a spurious `.000`; and
  a duration string in `plus`/`minus` is calendar-aware for its *whole*
  years and months only (the fraction of `"1.5 years"` is 182.5 fixed days),
  because a fractional calendar month has no agreed meaning.
- **Added (4.7) — history is queryable**: the `revisions` target (§1.1, §1.2)
  and `docs_read { at }` (§2), `docs_read_at` becoming its sugar. Moved cases,
  each reviewed: every recorded `docs_read_at` result (`reads::history` ×2,
  `reads::diff-unified-list-append` ×2, `interop::read-history-admin` ×2,
  `interop::write-apply` ×1) loses `properties` and `propertiesAreCurrent`;
  `query-root::root-object-entries-names` and `interop::read-query` gain
  `revisions` as the fifth root entry; `query-errors::edges-is-not-a-target`
  names five collections and the three `query-errors::hit-not-a-row-*` the
  five row kinds; the `reads::arguments` ×6 and
  `reads::errors-and-sourceless-writes` steps that print `docs_read`'s shape
  gain `at?`;
  `examples.json` gains the `docs_read` rung (28 → 29 steps). New:
  `query-revisions.json` (35), `reads::revisions`, three reads in
  `interop::read-history-admin` and two in `interop::write-apply`. The default order of the revisions scan is
  `(path, rev_id)` rather than the `(doc_id, seq)` first proposed: the runner's
  keyset cursor is `(path, id)` for every target, and a default order that is
  not the keyset order cannot be paged by it; `order by seq` (5.0: `_seq`) is
  one clause away. The unknown-names pass (§1.5) judges `revisions` rows as a closed kind;
  the reference's pass learns the kind in the follow-up that lands beside this
  one (until then a tier-3 name on a revision row reads absent, as every name
  did before 4.6).
- **Added (4.6) — unknown names** (§1.5): every name a query reads is judged
  statically against the vocabulary of its scope's kind; a tier-3 name on
  `links` is `filter_invalid`, on an open kind a `hints` entry (reads) or the
  selector's refusal (writes). New suite `query-unknown.json` (33). Moved
  cases, each reviewed: `query-docs::source-handles-reach-an-authored-key-of-an-attributes-name`
  (the corpus authors no `path:` key — three handle-form hints),
  `query-docs::contextual-words-are-fields-in-expression-position` (`order`,
  `limit`, `count` are fields no document carries — three hints),
  `query-docs::out-and-in-are-plain-properties` and `reads::dst-on-links`
  (`out` → `out_links`, `in` → `id`), `query-errors::bare-body-is-an-absent-property`
  (`body` — the hint says so), `query-nodes::no-relations-beyond-section`
  (`out_links` on a node), and `query-links::no-relations` — `select x:
  children, y: out_links from links`, which read two absent columns through
  4.5 and is now the links error naming `children` (the case's intent, that
  links have no relations, now spoken). Nothing else moved: every
  `examples.json` rung, every `query-*` case of the other suites and every
  `reads` step read only known names — the sign the rule is quiet on correct
  queries.
- **Added (4.5) — a string-list argument takes one bare string**, and a
  comma-joined one is refused with the split list as its `fix`
  (`docs_read_many {"docs":"a.md, b.md","include_ids":true}` → "`docs` must
  be an array of strings (…)", `fix` `{"docs":["a.md","b.md"],"include_ids":true}`);
  `plan` returns `preview.diffs` only on `diffs: true`. Pinned:
  `reads::arguments` (the seven string-list steps), every recorded `plan`
  preview (`reads.json`, `examples.json`, `interop.json` lose `diffs`), and
  `interop::write-select-apply-max` whose `expect.max` refusal now records
  its `fix` under the 4.5 rule for `filter_invalid` data.
- **Added (4.4) — every correctable error carries a `fix`**, a literal
  corrected call (§4 "Error data"). The surface composes three: a
  `blocks_append` on a leaf → `blocks_insert {"at":{"after":"<id>"},
  "markdown":"<text>","to":"<parent id | /doc path>"}`; a `docs_append`
  whose `section` matches several headings → `blocks_append {"id":"<first
  candidate>","text":"<text>"}` (5.0: `"_id"`); one that matches none → `blocks_append`
  over the single heading equal up to ASCII case when there is one, else
  `docs_append` with the same locator and `text` and no `section`. Canonical
  JSON (`spec/mutate` §11.5), so the keys are in byte order. Pinned:
  `reads::errors-and-sourceless-writes` and the append cases.
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
  `depth` everywhere (5.0: `_depth`, `_ordinal`).
- **Fixed (1.2) — an empty-projection nested `collect { }` yielded the raw
  store row** (store columns, `attrs` as a JSON string, the join column
  `__path`); a port had to reproduce the same keys, blobs came out as a Node
  `Buffer` in one engine and hex in the other. §1.4 now renders a row
  surfacing as a value as `{ id, path }` (5.0: `{ _id, _path }`; least
  surprising: a hit's identity, the same two keys every hit carries;
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
  `_out_links collect distinct { from _dst }` never reaches a document through
  a wikilink (a phantom's `_dst` is absent).
- **Pinned — the cursor decoder is lenient** (standard-alphabet base64 and
  `=` padding are accepted).
- **Closed (4.0) — dry runs consumed minted ids** (a dry-run insert advanced
  the `b` counter, 1.0–3.3). There is no `dry_run` on any tool since 4.0: the
  preview is `plan`, which mints under the symbolic minter (`spec/mutate`
  §11.4) and reports `$new.n`; the ids a committed run takes are exactly the
  ones the plan would have (`write-effects-dry-run`).
- **Fixed (3.0) — `nodes_get` with an unknown block id was `doc_missing`** (the
  doc was inferred first), and a block outside its explicit `doc` scope was
  `block_missing` without data. `blocks_get` has no scope; an unknown id is
  `block_missing` "no block with id \"…\"" with `data: { id }` (5.0: "no
  block with _id …", `data: { _id }`).
- **Pinned — the stored computed `$tags` row is body hashtags only**
  (`spec/properties` §3.3, unchanged); the surface's `_tags` attribute is the
  union with the authored list (3.0, batch 3 — §1.2; `tags` through 4.11),
  so a corpus without `#tags` in prose reads `_tags` as the authored `tags:`
  key and the bare `tags` (≡ `_data.tags`) as the same list.
- **Port notes.** Argument-shape failures (the reference's MCP/zod
  validation) are unpinned; the Rust catalog reports them as `filter_invalid`
  with `reason: "arguments"`. The `_frontmatter`/`_inline` source handles are
  lazy in the reference and materialized eagerly in the port (same values;
  `size(_frontmatter)` would differ — unpinned). Blob columns leaking through an
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
  Decisions entry below; `reads::resolution-ladders` carries both; 5.0: the
  argument and the message spell `_id`).
- **Fixed (3.0, the name pass) — `from <unknown>` was a silent empty result.**
  A top-level source that is no collection read an absent root and returned
  zero hits — which is exactly what `from edges` would have done after the
  rename. §1.1 refuses it, naming the collections and, for `edges`, the new
  name (`query-errors::edges-is-not-a-target`, `::unknown-target-is-loud`).
- **Pinned — `blocks_history` (`history_node` before 3.0) is not repo-scoped**; block ids are global.
- **Pinned — `entries(_frontmatter)` is in key order**, not authored order
  (`ord` positions only within a list-valued key).
- **Fixed (1.1, with search 1.1) — `semantic()` on blocks read the first
  cache row for the block's content hash**, whatever its context; now the
  current-context row only (`spec/search` §8).
- **Pinned (1.3), closed (4.0) — a `docs_move` dry run over a self-linking
  document overwrote the old path's diff entry.** The preview was the two
  rename entries (`old → ""`, `new ← bytes`) with the inbound-retarget
  preview assigned over them; when the moved document linked to its own
  path, the retarget preview carried an entry for the *old* path (the doc
  had not moved yet in a dry run) and replaced the emptied one. Gone with
  the tool's `dry_run`: the preview of a move is `plan { move }`, whose
  `preview.diffs` puts the rewritten bytes at the NEW path (`spec/mutate`
  §11.6).
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
- **Pinned (3.2), closed (4.0) — the sugar tools' dry runs still burned ids.**
  The effect planner's own dry run (`plan`) burns none; through 3.x the sugar
  realized its plan's `new_ids` with one production mint each so the 3.1
  contract above ("dry runs consume minted ids") and `spec/cli` §3.6 held
  unchanged (the document operations alike: a dry-run `docs_create` minted
  its `d`, a dry-run `docs_move` the discarded `b`s of its retarget re-parse,
  `spec/mutate` §10). Retired with the sugar's `dry_run` at 4.0 — the shim
  with it.
- **Changed (4.0) — a committed `docs_create` (and the `create` effect) is a
  known-id ingest of the planner's adopted tree** (`spec/mutate` 3.0 §11.3,
  §10): `inserted / 1 / api / null` dispositions where the reconciling ingest
  wrote `inserted / null / null / m2.3`; the same ids under the fixture minter
  (the `b`s are minted by the replay before the transaction instead of inside
  it), the same bytes, revision and commit — nothing a read of
  `write-docs-create-move` shows moved; `write-effects-create-and-fill` pins
  the biographies.
- **Changed (3.3) — a committed `docs_set_meta` is a known-id head write.**
  The library operation re-ingested the patched file through the reconciling
  resolver, so every block of the document got a matcher disposition
  (`same`, `exact_hash`, `m2.3`); the `set frontmatter.<k>` effect
  (`_frontmatter.<k>` since mutate 4.0) is a file
  head on the loaded tree (`spec/mutate` §11.3) committed by the known-id
  path, so every block gets the api write's `edited`/`api` disposition with
  no matcher — the strictly better identity (no probabilistic matcher on an
  api write). Bytes, rows, revision, commit and mint sequence are identical
  (the reconciler assigned the known ids after its parse without minting; the
  head write parses nothing); `blocks_history` is the one tool that shows the
  difference (`interop::write-docs-set-meta-delete`, 3.3). Accepted, not
  preserved. N keys are N sequential patches, each `compose(parse(previous)
  patched)`; the reference proves over every corpus document that this
  equals the legacy single merged `compose` — `stringify ∘ parse` is the
  identity on what the emitter writes (`spec/mutate` §10, "the YAML emitter").
- **Pinned (3.3) — `docs_set_meta` with an empty patch is an argument
  error** (`filter_invalid` "pass `set` and/or `unset` (docs_set_meta
  takes…)"). Through 3.2 it re-emitted the frontmatter for nothing
  (normalizing its YAML); there is no effect for "touch", and the CLI's
  `meta` already refused it.
- **Pinned (3.3), closed (4.0) — a move's dry-run `diffs` kept the legacy
  key order and the self-link reading.** The tool rebuilt `{ old: bytes →
  "", new: "" → bytes, …sources }` over the plan's preview (which lists the
  rewritten sources first and puts a self-link's rewritten bytes at the new
  path). Retired with `dry_run`: the Plan's own `preview.diffs` is the
  preview. `docs_move` still computes `dangling`/`retargeted` before the
  commit (`moveLinks` over `inbound_links_to` + `plan_inbound_retarget`,
  pure, so equal to what the planner lowered); the Rust port mirrors it.

## Decisions

- 2026-10-21, surface 5.1 (the payload diet; Brendan's decisions, measured in
  the agent-bench run `results/2026-10-21T02-33-11Z` over the 348-document
  timeline corpus, where three payloads — each replayed as cached prefix on
  every later turn — took most of the agents' tokens). **(1) `docs_tree` rolls
  up to directories by default** (§2): the page is one row per directory
  within `depth` segments — `{ _path, docs, blocks }` — plus `files_here`, the
  documents at the prefix itself counted, not listed; `files: true` lists them
  as `{ _id, _path, blocks }` and `updated: true` adds `_updated_at`. Measured
  on the timeline corpus: `docs_tree { depth: 2 }` was 26.9 kB (200 rows,
  `kind: "doc"`, `docs: 1` and an identical `_updated_at` per row, then a
  cursor to a second page — 57 calls across two profiles); the rollup is 0.9 kB
  (15 directory rows, one page). The 5.0 page is NOT reproducible exactly —
  `files: true, updated: true` lists the documents with their timestamps but
  the rows carry no `kind`/`docs: 1`, and the nested directories now appear
  as rows beside the documents they hold (`tree -L 2` prints the directory
  line too) — so this is a result-shape change; payload wins, and a minor,
  because `kind` was a role a reader can derive (a path ending in `/`) and
  the orientation call now does what its name says. **(2) `execute { plan_id
  }` alone** (§4): the server remembers the plans it produced (the last 64, by
  id) and runs the remembered Plan through the full plan form, so `stale_plan`
  and `plan_mismatch` are told apart exactly as when the client echoed the
  object — which the 2026-10-21 run did on every write, 5.7 kB mean and 19 kB
  max of OUTPUT tokens per `execute`. A memory the server never had is
  `plan_unknown` (retriable: re-plan). `spec/mutate` §11.7 is unchanged — the
  memory is a lookup in front of the plan form, the pinned "the digest form
  cannot tell stale from edited" stands, and an executed plan's replay still
  fails by its preconditions. The `plan` ladder's summary line now says what
  comes next (`Commit: execute { plan_id }.`) and the `execute` ladder's rung
  is the id alone. **(3) `query_syntax` serves a card** (§4): `{}` is a ~3.5 kB
  hand-written card plus the chapter names, `{ section }` one chapter of the
  manual (its `##` headings slugified), `{ section: "all" }` the 38 kB text
  5.0 returned for `{}` (fetched twelve times in the run). The card is the
  single most-read text on the surface, so it was written by hand and every
  example on it is parsed by the reference's and the twin's tests; both
  engines serve every text byte for byte. Not done: the `query` error hints
  do not yet name a chapter (`data.section`) — the error classes map to
  chapters loosely and the mapping would have to be mirrored byte for byte.
  Fixtures: `reads::tree-rollup`, `reads::plan-memory`, `reads::query-syntax`
  (new); `reads::orientation`/`budgets`/`alchemy` and `interop::read-listing`,
  `write-docs-create-move`, `write-docs-set-meta-delete`, `clock-seam` moved
  with the tree shape (the paging/budget steps now pass `files: true` so they
  keep pinning the floor and the cursor); `interop::write-effects-stale-plan`
  gained the id-alone form (an unknown id → `plan_unknown`, the writer's own
  plan → `stale_plan`) and its old `{ plan_id: "x" }` half-digest step became
  that form (the half-digest pin is now `effects` alone); `examples::ladders`
  29 → 31 steps (the `query_syntax` chapter rungs; the `execute` rung by id);
  `tool-descriptions.json` for `docs_tree`, `query_syntax`, `plan`, `execute`.
  Two arguments, one result key, one tool argument, one error code added; one
  result shape changed in a way the catalog's own description called out as
  the orientation call: a minor.
- 2026-10-20, surface 5.0 ("underscore = engine"; Brendan's decision of
  2026-10-19; with `spec/mutate` 4.0, `spec/sync` 3.0, `spec/search` 3.0,
  `spec/graph` 2.0 and `spec/cli` 5.0): **on every record kind a BARE name is
  a user-authored entry and an UNDERSCORE-prefixed name is engine-provided,
  however derived** (§1.2, normative). The `_` prefix declares an engine field
  on a record; the bare namespace is the user's on every record — docs,
  blocks, nodes, links, revisions and the root row alike, because any record
  may carry user data later; arguments and effect targets addressing an
  engine field match its name exactly; no tolerance. **Why.** The 3.0 rule
  ("engine attributes are bare and win on collision, the author's colliding
  key is reached through `data.<k>`") put the engine's names in the author's
  namespace and then had to keep a reserved-names table, a `data.<k>` escape
  hatch, a three-tier unknown-names pass with an engine-attribute confusion
  tier, and a hint that pointed a bare `path` at `data.path` — one rule for
  the engine's side and a second for the user's. The engine's set is closed
  and the author's is open, so the mark belongs on the closed set: with the
  prefix on the engine's side nothing is reserved (an authored `id:` or
  `title:` is simply read), a `_x` that is no engine name is a loud error
  (the one place a loud error is right), a bare name is always an authored
  read whose only question is whether anything carries it, and a reader of a
  query or a result tells the two apart at a glance. `$` stays OQX's (`$it
  $key $depth $stop $leaf $frontier $ordinal`; omgbase adds no `$` names).
  **Collections stay bare** (`from docs`, `^docs`, `0^docs`, `docs count { }`,
  `entries(^$it)` → `docs blocks nodes links revisions`): `from` names a
  collection, not a row property. **Row functions stay bare in call
  position** (`text("x")`, `semantic(…)`, `under(…)`, `refs(x)`): a call is
  never an entry read. **The self aliases are removed** (`doc` on docs,
  `block` on blocks, `section` on nodes): `$it` is the self; the
  reach-throughs are `_doc`, `_block`, `_dst`. `_data.<k>` ≡ `<k>` (the
  merged authored view; `entries(_data)`), `_frontmatter.<k>` / `_inline.<k>`
  one source each — and the one way to an authored key that itself begins
  with `_`. `_tags` = authored `tags` ∪ body `#hashtags`, bare `tags` the
  authored key alone; `_title` the computed title, bare `title` the authored
  key. Inside `follow` `$depth`/`$ordinal`/`$stop` are OQX's; a block's own
  nesting is `_depth`, its sibling position `_ordinal`. The hit envelope is
  `{ _id, _path, …projection }` (`bare: true` drops it); a row as a value is
  `{ _id, _path }`; `select _id, _path` collapses onto the envelope and an
  alias `_id:`/`_path:` on anything else is refused ("projection `_path`
  collides with the hit envelope — alias it (`p: …`)"). The `$repo` message
  ends "and the repository id as `^_id` / `0^_id`". The bare-target refusal
  of §1.1 now applies statically to all five root names inside a block (the
  relations are `_blocks`/`_nodes`/`_revisions`, so a bare `blocks` is never
  a relation); its message is unchanged.

  **The language, 4.11 → 5.0** (§1.2):

  | kind | engine names (attributes · handles · relations) | bare names |
  | --- | --- | --- |
  | docs | `_id _path _raw _hash _updated_at _created_at _title _tags _format` · `_data _frontmatter _inline` · `_blocks _nodes _out_links _in_links _revisions` | every authored property (frontmatter + inline by the property rule): `title`, `tags`, `id`, `path`, `data`, `doc`, `format` included — nothing is reserved |
  | blocks | `_id _path _doc_id _raw _hash _updated_at _created_at _type _text _attrs _depth _ordinal` · `_doc` · `_children _nodes _out_links _section` | an `attrs` key (`checked`, `level`, `lang`; `_attrs.<k>` ≡ `<k>`) |
  | nodes | `_id _path _doc_id _block_id _kind _name _value _attrs` · `_doc _block` · `_blocks _subsections _children` | an `attrs` key (`checked`, `first_ordinal`, …) |
  | links | `_id _path _doc_id _block_id _via_id _dst_id _dst_path _uri _field _dst_kind _predicate _provenance _anchor` · `_doc _dst _block` · — | none (closed) |
  | revisions | `_id _path _rev _seq _doc_id _commit _ts _origin _actor _reason _hash _is_current _archived` · `_doc` · — | none (closed) |
  | root | `_id` (`^_id`, `0^_id`) · — · the five collections | — |

  | 4.11 | 5.0 |
  | --- | --- |
  | `id`, `path`, `raw`, `hash`, `updated_at`, `created_at`, `format` (docs) | `_id`, `_path`, `_raw`, `_hash`, `_updated_at`, `_created_at`, `_format` |
  | `title` (computed), `tags` (authored ∪ hashtags) | `_title`, `_tags`; the authored keys alone are the bare `title`, `tags` |
  | `data.<k>`, `frontmatter.<k>`, `inline.<k>`, `entries(data)` | `_data.<k>` (≡ bare `<k>`), `_frontmatter.<k>`, `_inline.<k>`, `entries(_data)` |
  | `data.path`, `data.title`, `data.tags`, `data.id` (the escape hatch) | the bare `path`, `title`, `tags`, `id` — nothing is reserved |
  | `blocks`, `nodes`, `out_links`, `in_links`, `revisions` on a document | `_blocks`, `_nodes`, `_out_links`, `_in_links`, `_revisions` |
  | `doc` on a document (the self), `block` on a block, `section` on a node | `$it` (a bare `doc`/`block`/`section` is an authored key) |
  | `doc.<x>` on a block, node, link or revision; `block.<x>` on a node or link; `dst.<x>` on a link | `_doc.<x>`, `_block.<x>`, `_dst.<x>` (with `<x>` respelled: `_doc._title`, `_doc.layer`, `_dst._path`) |
  | blocks: `doc_id type text attrs depth ordinal`; `children`, `section` | `_doc_id _type _text _attrs _depth _ordinal`; `_children`, `_section` (`attrs.checked` → `_attrs.checked` ≡ `checked`) |
  | nodes: `doc_id block_id kind name value attrs`; `blocks`, `subsections`, `children` | `_`-prefixed |
  | links: `doc_id block_id via_id dst_id dst_path uri field dst_kind predicate provenance anchor` | `_`-prefixed |
  | revisions: `rev seq doc_id commit ts origin actor reason hash is_current archived` | `_`-prefixed |
  | `^id`, `0^id`, `^$it.id` | `^_id`, `0^_id`, `^$it._id` |
  | `follow out_links collect { from dst }`, `follow in_links collect { from doc }` | `follow _out_links collect { from _dst }`, `follow _in_links collect { from _doc }` |
  | `from docs`, `^docs`, `docs count { }`, `entries(^$it)`; `text("x")`, `under(…)`, `refs(x)` | unchanged |
  | a bare `blocks`/`nodes`/`revisions` inside a block (a relation of some rows) | always the loud bare-target error (`^blocks`): the relations are `_blocks`/`_nodes`/`_revisions` |

  **Tool results** (§2–§4; `spec/mutate` §11, `spec/sync` §6, `spec/search`
  §1.3/§4, `spec/graph`): every result key that carries a row attribute is
  spelled as that attribute; a key naming a role keeps its name.

  | result | 4.11 | 5.0 | kept as roles |
  | --- | --- | --- | --- |
  | `query` hits; rows as values | `{ id, path, … }` | `{ _id, _path, … }` | `truncated cursor consumer count exists none values hints` |
  | `docs_read`, `docs_read_at`, `docs_read_many.items[]` | `{ id, path, rev, properties, raw, ids?, hashes?, parents?, renderedHashMatch? }`, `properties.computed { title, tags }` | `{ _id, _path, rev, properties, _raw, … }`, `properties.computed { _title, _tags }` (the computed rows the attributes read; the authored groups stay bare) | `rev ids hashes parents renderedHashMatch properties errors truncated` |
  | `blocks_read`, `nodes_block_read`, `blocks_read_many.nodes[]` | `{ id, type, label?, text?, raw?, hash?, attrs?, ordinal?, depth?, parent_id?, children? }` | `{ _id, _type, label?, _text?, _raw?, _hash?, _attrs?, _ordinal?, _depth?, parent_id?, _children? }` | `label parent_id nodes truncated unresolved` |
  | `docs_list.items[]`; `docs_tree.entries[]` | `{ id, path, updated_at, blocks }`; `{ id?, path, kind, docs, blocks, updated_at }` | `{ _id, _path, _updated_at, blocks }`; `{ _id?, _path, kind, docs, blocks, _updated_at }` | `blocks docs kind prefix depth total truncated cursor` |
  | `graph` | `documents[] { id, path, degree, frontier, … }`, `links[] { id, doc_id, block_id, via_id, dst_id, dst_path, uri, dst_kind, predicate, provenance, anchor, field }`, `frontier[] { id, path, degree }` | `_`-prefixed row keys | `roots degrees direction degree frontier truncated queries sel_<i>` |
  | `blocks_search.hits[]` | `{ id, doc_id, path, type, text, score }` | `{ _id, _doc_id, _path, _type, _text, score }` | `score truncated` |
  | `blocks_resolve[]` | `{ id, locator, preview, evidence }` | `{ _id, locator, preview, evidence }` | `locator preview evidence` |
  | the Receipt (`apply`, `execute`, every sugar tool) | `revisions: [{ id, path, hash }]` | `revisions: [{ _id, _path, _hash }]` | `plan_id commit new_ids committed summary` |
  | the Plan (`plan`, `execute { plan }`) | `preconditions.docs[{ id, path, base_revision, hash }]`, `preconditions.blocks[{ id, content_hash }]`, `opset.moves[{ id, from, to }]`, `opset.tombstones[{ id, path }]`, `preview.revisions[]` | `preconditions.docs[{ _id, _path, base_revision, _hash }]`, `preconditions.blocks[{ _id, content_hash }]`, `opset.moves[{ _id, from, to }]`, `opset.tombstones[{ _id, _path }]`, `preview.revisions[{ _id, _path, _hash }]` (so every `plan_id` moves) | `effects` (as given), `opset.ops` (the kernel-op grammar), `set_frontmatter[{ doc, raw }]`, `preconditions.parents[{ doc, parent, parent_children_hash }]`, `absent_paths`, `new_ids`, `preview.results/diffs/summary/identity/retarget`, `selection` |
  | `docs_move` | `dangling[{ doc_id, path, block_id, target, anchor, field? }]` | `dangling[{ _doc_id, _path, _block_id, target, _anchor, _field? }]` | `retargeted target` |
  | `links_stale` | `stale[{ doc_id, path, block_id, predicate, provenance, dst_kind, target, authored, anchor, reason }]`, `summary.bySource[{ path, count }]` | `stale[{ _doc_id, _path, _block_id, _predicate, _provenance, _dst_kind, target, authored, _anchor, reason }]`, `bySource[{ _path, count }]` | `target authored reason externalCount totalOpenEdges staleCount byTarget` |
  | `links_retarget`, `links_repair` (and `plan.preview.retarget[].hits`) | `hits[{ id, path, oldRaw, newRaw }]` | `hits[{ _id, _path, oldRaw, newRaw }]` | `pairs oldRaw newRaw` |
  | `observe`, `observe_many[]`, `observe_delete` | `{ id, path, rev, commitId, … }` | `{ _id, _path, rev, commitId, converged, echo, conflicted, dispositions }` / `{ _id, _path, deleted }` | everything else |
  | `docs_diff[]`; `docs_diff_unified` | `{ kind, id, before?, after? }`; `{ id, path, from, to, diff }` | `{ kind, _id, before?, after? }`; `{ _id, _path, from, to, diff }` | `kind before after from to diff` |
  | `docs_history` | `docs[{ id, path, deleted, currentRev, versions[{ rev, seq, commit, updated_at, origin, actor, hash, isCurrent, archived }] }]` | `docs[{ _id, _path, deleted, currentRev, versions[{ _rev, _seq, _commit, _ts, _origin, _actor, _hash, _is_current, _archived }] }]` — a version is a `revisions` row, under the row's names | `deleted currentRev truncated` |
  | `changes_since.digests[]` | `revisions: [{ id, path, hash }]` | `revisions: [{ _id, _path, _hash }]` | `commit seq ts origin actor summary cursor head truncated` (a digest describes a commit, not a row kind) |
  | `repos_status` | `{ id, slug, … }` | `{ _id, slug, … }` (the root row's `_id`) | the rest |
  | `blocks_history[]`, `repos`, `sync_status`, `version`, `docs_outline` | — | unchanged | — |
  | error data | `doc_missing { id?, path? }` (the arguments as given), `block_missing { id }`, `ambiguous_heading.candidates[{ id, doc_id }]`, `parent_missing { section, path, fix }`, `stale_expectation.current { hash, markdown }`, `stale_plan.current { revision, hash }` | `{ _id?, _path? }`, `{ _id }`, `[{ _id, _doc_id }]`, `{ section, _path, fix }`, `current { _hash, markdown }`, `current { revision, _hash }` | `doc rev section fix reason hint expected_revision retriable` |

  **Tool arguments** (§4 "Arguments"): an argument that addresses a row
  attribute is spelled as the attribute — `docs_outline docs_read docs_append
  docs_move docs_delete docs_set_meta docs_update docs_diff docs_diff_unified
  docs_read_at docs_history` take `_id?` / `_path?` (at least one);
  `blocks_read blocks_update blocks_split blocks_append blocks_history
  nodes_block_read nodes_set` take `_id`; `blocks_read_many blocks_check` take
  `_ids`. Role arguments keep their names (`docs`, `blocks`, `to`, `at`,
  `roots`, `select`, `expect`, `effects`, `plan`, `plan_id`, `reason`,
  `diffs`, `markdown`, `text`, `content`, `frontmatter`, `set`, `unset`,
  `section`, `checked`, `separator`, `prop`, `value`, `resolution`, `depth`,
  `limit`, `cursor`, `budget_tokens`, `include_ids`, `include_deleted`, `at`
  (a revision), `rev`, `from_rev`, `to_rev`, `path_glob`, `docs_tree.path`,
  `docs_create.path`, `to_path`, `observe*.path` / `files[].path`,
  `from_target`, `to_target`, `repairs`, `q`, `query`, `bare`, `origin`,
  `degrees`, `direction`, `predicate`, `max_documents`, `summary`, `repo`).
  **No tolerance**: `{ id }`, `{ path }`, `{ ids }` are `filter_invalid {
  hint: "arguments", fix }` — "`id` is not an argument — the document's id is
  `_id` (an engine field: the bare namespace is the user's)", the `fix` the
  same call respelled; `doc`/`block`/`node` keep their retired-name messages,
  now pointing at `_id`/`_path`.

  **Effects** (`spec/mutate` 4.0 §11): targets `{ kind: "document", _id? |
  _path? }`, `{ kind: "block", _id }`, `{ kind: "node", _id }` (`{ kind:
  "section", heading_id }` and the bare forms — a path, a `b_`/`d_`/`n_` id,
  `$new.n` — unchanged); fields `_frontmatter.<key>` (set/unset) and
  `_attrs.checked` beside the role names `content` and `markdown`; a node's
  field stays its editor's property name (`value`, `name`, `checked`);
  `expect.content_hash` / `parent_children_hash` / `revision` are roles. A
  selector's `row` origin and a `-> ` expression's row ref are `{ _id, _path
  }`. The sugar builders, the fixtures and every `fix` follow.

  **Unknown names (§1.5), one tier:** a bare name no object of the kind
  carries is a property read that yields absent — `hints` on a read ("no
  document in this repository carries a property `x`; did you mean `_title`?"
  — the nearest match drawn from the authored keys ∪ the engine names, so a
  bare `title`/`id`/`path`/`tags`/`format` is pointed at its `_` spelling; a
  candidate that is exactly the name with the prefix added or removed wins
  outright), a refusal in a write selector; a bare name on `links` or
  `revisions` (closed) is `filter_invalid` ("`target` reads an authored
  property, and a link carries none (engine names: _id, _path, …); did you
  mean `_dst_path`?"); a `_x` that is no engine name of the kind is
  `filter_invalid` naming the kind's engine names in the order attributes,
  reach-throughs, source handles (docs), relations ("`_x` is not an engine
  name of docs (engine names: _id, _path, _raw, _hash, _updated_at,
  _created_at, _title, _tags, _format, _data, _frontmatter, _inline,
  _blocks, _nodes, _out_links, _in_links, _revisions); did you mean `…`?").
  The hint under a source handle reads "no document in this repository
  carries a property `x` (`_data.x`); did you mean `y`?" (authored keys
  alone). The `data.<k>` suggestions and the engine-attribute confusion tier
  are gone.

  **CLI 5.0.** `--json`/`--jsonl` carry the tool result verbatim; the hit
  table's envelope columns are `_id`/`_path`; the shell's row ref reads `_id`
  (label `_path`), `@1._id` / `@t[1]._path`; the `REF_KEYS` tolerance is gone.
  **Lower-spec majors**, each on the shapes it owns: `spec/mutate` 4.0 (the
  Plan, the Receipt, the error data, the effect fields and targets),
  `spec/sync` 3.0 (the change-feed revision), `spec/search` 3.0
  (`blocks_search`/`blocks_resolve` hits), `spec/graph` 2.0 (the `graph`
  result's rows), `spec/cli` 5.0; `spec/store`, `spec/properties`,
  `spec/format`, `spec/reconcile`, `spec/oqx` untouched (their rows are not
  surface rows — the properties table's computed `$title`/`$tags` keys are
  stored keys). Fields, relations, result keys and arguments changed in
  meaning: a major. **Fixtures**: every query respelled by
  `scripts/rename-engine-names.mjs` (span-exact, formatting kept) and every
  expectation regenerated; the new cases of §6. **The Rust twin follows in a
  later round** (`omgbase-surface`, `omgbase-mutate`, `omgbase-sync`,
  `omgbase-search`, `omgbase-graph`, the `omgbase` binary); until it lands
  the Rust spec runners and the cross-engine interop suite (§7) are red by
  design. Migration: `changes/surface-5-underscore-engine-names.md`.
- 2026-10-18, surface 4.11 patch — the row-function rewrite targets `$it`, not a
  private `$self`. Both runners turned a bare `text("x")` into a method call on a
  synthetic `$self` receiver that the store context answered with the row — an
  undocumented `$` name omgbase had in fact added, reachable by typing it
  (`$self.path` read the path). `$it` already is the scope's row in both engines
  (`spec/oqx` SEMANTICS §2), so the rewrite now produces `$it.text("x")`, the
  context's `$self` branch is gone, and a typed `$self` is an unknown identifier
  like `$id` (`query-errors::dollar-self-is-not-a-name`). No fixture moved; no
  version move (the name rule is unchanged — it is now true of the code).
- 2026-10-17 (no version move — no shape changed), with `spec/properties`
  1.2: YAML and JSON documents' top-level mappings are their frontmatter
  (`source = frontmatter`, §1.2 above), so every existing read applies to them
  unchanged and `reads::yaml-json-documents` pins the attn prototype's reads
  — bare keys, `data.<k>`, `entries(frontmatter)`, the pushdown, `docs_read`'s
  `properties`, the virtual-focus join (`^docs exists { where path ==
  "/attn/focus.yaml" and focused_intent == ^path }` in `where` position;
  `count { … }` as a value — `exists` is not a projection), `create` with the
  whole file as `markdown`, `set content`. The frontmatter **effects** stay
  Markdown's until a later round teaches them the formats: `set`/`unset
  frontmatter.<key>` on a `yaml`/`json` document, `docs_set_meta` over one,
  and `create { frontmatter }` (non-empty) at a `.yaml`/`.json` path are
  refused with **`type_mismatch`** — `data { doc?, path, format, field }`,
  message "frontmatter effects apply to markdown documents; `<path>` is a
  `<format>` document — its top-level mapping is edited with `set content`
  (the whole file) until frontmatter effects learn yaml and json" — rather
  than fencing the file with `---` (a second YAML document; invalid JSON).
  `type_mismatch` because the target's kind does not admit the op, the same
  family as inserting into a leaf; no `fix` (the correction is a different
  tool, not a corrected call). An observation script's paths end in `.md`
  (`spec/store` §9.4), so the case's non-Markdown documents arrive by
  `create`; the observe path is `spec/properties/cases/whole-document.json`.
- 2026-10-17, surface 4.11: the evidence is the agent-bench re-run
  `examples/agent-bench/results/2026-10-17T07-45-56Z` (Opus 5 over the two
  profiles, 78/78 passed) — four first-guess frictions remained in its 19
  `filter_invalid`s, and each is answered by a teaching or tolerance change,
  never a language change. (1) Eight of the nineteen were a string that IS a
  JSON array (`ids: "[\"b_189\",\"b_190\"]"`), to which 4.5 answered with the
  comma split — a wrong `fix` the model retried verbatim; a string opening
  `[` is now parsed, and a JSON array of strings accepted, as the bare string
  is: the intent is unambiguous. (2) 73 of 75 `plan` calls passed `diffs:
  true` because the summary line read `diffs: true for file bodies.`; the
  taught form is the default, the opt-in reads as optional. (3) Two calls
  wanted the linking block's text from a links row (`select t: block.text
  from links`); `block` joins `doc` and `dst` as the row's third handle,
  mirroring how `doc` reaches the source document. (4) Three were `id in
  ["a", "b"]` — the last SQL habit; OQX has no list literal by design and the
  tuple IS a collection (`spec/oqx` SEMANTICS §3b), so the surface attaches
  the corrected call as `fix` instead of changing the language. Arguments
  tolerated, a handle added, a description reworded, a `fix` added: a minor.
- 2026-10-16, surface 4.10 (Brendan's decision): `created_at` is an
  **attribute**, not only the `revisions first { ts values }` spelling it
  already had. Creation time is the most common Dataview sort key
  (`file.ctime`), and a sort key must be a bare name: `where created_at <
  …` pushes down and `order by created_at` runs exactly as `order by
  updated_at` does (the docs form is one correlated subquery, exactly
  `updated_at`'s shape at `seq = 1`), while the nested-query spelling never
  can, and a reader of the reserved-names table should see the pair
  `updated_at`/`created_at` where Dataview readers expect
  `mtime`/`ctime`. The semantics are **first observed by omgbase** — the
  first revision's commit `ts`, never a filesystem birth time: the store has
  no other honest instant (filesystem ctimes differ per platform, do not
  survive a copy, and are not in the database), and the value must be the
  same from both engines over the same store. It is **retention-proof** by
  construction: the 15.0 squash keeps every revision/commit row and each
  block's earliest `block_changes` row, so no policy can move it. Blocks
  got it too because the block form is exactly as cheap as the document's:
  `updated_at` on a block is already `MAX(c.ts)` over `block_changes ⋈
  commits`; `created_at` is the same join under `MIN`, read by the same
  index, and store 14.2/15.0 guarantee the earliest row is the one kept.
  An authored `created_at:` key — common in migrated vaults — is reached
  as `data.created_at` by the 3.0 rule; the hints of
  `query-docs::created-at-wins-on-collision` show the bare read is tier 1
  while the handle read is judged against the authored vocabulary.
- 2026-10-15, surface 4.9: archived history (`spec/store` 15.0 §7.1) reaches
  the surface as one attribute and one error, and nothing else. `archived`
  on the `revisions` target and in `docs_history` is the honesty bit a
  client needs before asking for bytes: the row is history and stays, the
  bytes may need a segment. `revision_archived { rev, archive, path? }` is
  its own code rather than `target_missing` because the revision is *not*
  missing — it is listed, it has a hash, it will read again the moment an
  operator attaches a file — and a client that gets it should say so, not
  "no such revision". No MCP tool archives, attaches or lists segments:
  archiving writes files under the workspace, takes the writer lock and is
  driven by a policy and a directory — an operator's act over the host,
  where `omg gc`, `rebuild-index` and `doctor` already live
  (`docs/surface-map.md`'s exception set), so the verbs are `omg history …`
  (`spec/cli` 4.6) and a remote client asks its operator. Archived
  dispositions are not read back through a segment in this round
  (`blocks_history` is the live rows; a wholly archived commit's
  `changes_since` summary loses its counts) — the segment holds them, a
  later round may read them. An attribute and an error added: a minor.
  Fixtures: `reads::archived`; the moved cases of §9.
- 2026-10-16 (oqx 0.25; no surface version move): the language gained
  `flatten`. Four host rules, read off the language rather than pinned by new
  fixtures here: (1) **a flattened row is still a store row** — the runner
  injects the `id`/`path` envelope as usual and it repeats per element
  (Dataview's `TABLE … FLATTEN`), the envelope-collision rule applies, and
  `flatten … as id` / `as path` is refused (the bound name shadows a
  same-named row property, so it would shadow the envelope's own reads);
  (2) **paging is positional with a `null` cursor** — a hit's identity is the
  (row, element) pair, so `(path, id)` no longer names one hit and the keyset
  cursor cannot land inside a document's elements; the `group by` precedent
  (a keyset extended with the flatten ordinal is a later round); (3) the
  tier-3 planner **declines the query whole** (a pushed conjunct that empties
  the scan would hide an eval error a `flatten` expression raises in memory —
  decline (c)); (4) the **unknown-names** pass (§1.5) judges the flatten
  expression on the rows, the names inside a written block against the
  element kind through the block receiver's step (`flatten blocks { where typ
  == … }` is the blocks hint), and never the bound name (an alias-bound name,
  excluded by the language's `references`). Write selectors: `spec/mutate`
  §11.8, Decisions 2026-10-16. `examples.json` moved with the `query_syntax`
  text.
- 2026-10-15 (oqx 0.24; no surface version move): the language gained `group
  by`/`having`, aggregates and `count { … }` as a value. Two consequences at
  the surface, both read off the language rather than pinned by new fixtures
  here: (1) a **grouped query yields groups, not store rows** — the runner
  injects no `id`/`path` envelope (a hit is the projection as written, as
  `bare` yields; `bare` is accepted and changes nothing), the
  envelope-collision rule does not apply, rows that surface as values still
  render `{ id, path }`, paging is by position with a `null` cursor as under
  a custom `order by`, and the tier-3 planner declines the query whole; (2)
  `query-unknown::every-attribute-handle-relation-is-known` meant to show a
  hint-free result but had read `l: out_links count { }` as the pre-0.24
  parse error — it now returns the hits it always intended (the `l` counts),
  so the fixture moved and was reviewed as that. `examples.json` moved with
  the `query_syntax` text.
- 2026-10-15, surface 4.8: dates and durations (§1.3) — the Dataview-parity
  function set, as host functions of the binding. Three choices. **Strings
  and seconds, no new value kinds**: a date is the ISO-8601 string the store
  already writes and OQX already orders (SEMANTICS §6), a duration a number
  of seconds; `date()` canonicalizes and keeps the input's precision (a
  date-only input stays date-only), so a value that went through `date()`
  compares, projects and round-trips exactly like one that did not, and no
  result shape, cursor or wire form learns a new type. **Methods, not
  operators**: `+` with a string operand concatenates (SEMANTICS §7), so
  `due + 86400` is `"2026-01-0586400"` and must stay so — overloading `+` on
  a date-shaped string would make a string operator's meaning depend on the
  string's content; `plus`/`minus`/`until` are explicit, total, and leave the
  operators alone. **UTC**: the named points resolve against the host clock
  in UTC and the fields read the written offset; a time-zone argument (the
  Dataview `date(today)` is the user's local day) is a later round, because
  the one correct answer needs a zone the server does not have, and a wrong
  default would be pinned by fixtures. **Placement**: all of it is this spec,
  not `spec/oqx`. The parsers and arithmetic are pure and host-agnostic and
  could be OQX builtins with a `clock` hook on `DataContext`; they are
  omgbase functions today because (a) the one impure input — the clock — is
  the surface's existing seam (`OMGBASE_SPEC_CLOCK`, §7.1), and a `clock`
  hook on `DataContext` would be the first builtin to read the host at all,
  (b) the conventions (365/30 days, Monday weeks, the `format` token set,
  Dataview's unit spellings) are a product's choices rather than a language's,
  and (c) one spec file and one fixture suite move together with no OQX
  version bump while the set settles; promotion to `spec/oqx` builtins
  (with `date`/`dur` becoming reserved builtin names) is a later round once
  the Dataview translator has exercised them. Folding a literal call before
  planning is an implementation choice both engines may make or not: the
  fixtures run planned and unplanned. Functions and methods added: a minor.
  Fixtures: `query-dates.json`.
- 2026-10-13 (store 14.2; no surface version move): a block's `updated_at`
  is the block's own last change and `blocks_history` lists the commits that
  changed it (§1.2). The surface pinned the mechanism — `MAX(commits.ts)`
  over the block's `block_changes`, newest-first over the same rows — and
  the store changed what the rows are: a `same` verdict is no longer
  persisted, and the api path classifies carries as the matcher does, so a
  commit that left a block byte-identical in place no longer appears in its
  history or moves its timestamp. The wording of §1.2 names the new meaning;
  the shapes are unchanged, which is why the surface version stays. What a
  reader loses — "this block was present and unchanged in commit X" — is
  `docs_diff` over two revisions, and the `blocks_history` description says
  so. Fixtures: `reads::workspace-writes` lost the `edited / api` entries of
  untouched blocks from its `blocks_history` reads, and `interop.json`'s
  write cases their siblings' rows the same way; new
  `reads::sibling-updated-at-does-not-move` pins the four timestamps and two
  histories after a one-block `apply`.
- 2026-10-13, surface 4.7: history is queryable — the `revisions` target and
  `docs_read { at }`. The two web clients over the MCP surface (`graph-ui`,
  `live-tail`) run against the minimal tools profile, where everything they do
  is already OQX or one `apply` effect — except history: `live-tail` needed
  `docs_history`, `docs_read_at` and `docs_diff_unified`, none of them in the
  profile. Rather than widen the profile, history becomes one more thing
  `query` reads: a target over the `revisions` × `commits` join (one row per
  stored revision, deleted documents included, `doc` reaching the current row
  and absent for a tombstone, `revisions` a relation of every document), so a
  document's timeline is `from revisions where path == … order by seq desc`
  and "edited through the API" is a `revisions count { … }` on docs — and
  `docs_read { at }` makes the body as of a revision reachable from the one
  read tool the profile has. The history tools stay as sugar (`docs_read_at`
  literally: the same code path, the identical result); the unified diff is a
  client-side computation over two bodies (two `docs_read { at }` calls), so
  `docs_diff_unified` needs no query form. Two details the code decided: the
  scan's default order is `(path, rev_id)`, the keyset every target pages by,
  not `(doc_id, seq)`; and `docs_read { at }` carries **no `properties`** — the
  table is current-state only and recomputing the bag from the bytes is not a
  one-call affair of the format layer today (the inline fields come out of the
  ingest's node projection), so rather than present current values as
  historical (what `docs_read_at` did, flagged) the read returns the bytes and
  the honesty bit. A target added, an argument added, a result shape narrowed
  on a tool that is now sugar: a minor. Fixtures: `query-revisions.json`,
  `reads::revisions`, the moved cases of §9.

- 2026-10-13, surface 4.6: unknown names (§1.5; with `spec/oqx` 0.23's
  `references` pass). A 78-run agent benchmark showed models projecting and
  filtering on names that do not exist — `select path, target from links`,
  `select type, value from blocks`, `select id, type, preview from blocks` —
  each returning rows of absent columns without complaint, each followed by a
  31 kB `query_syntax` call; in `where` such a name is worse because it is
  invisible (`target != "x"` matches every row), and in a write selector it
  selects every row. The rule is **deterministic and filter-independent**:
  the judgement is static, over the query's references and the repository's
  vocabulary, so a correct query never warns because of its own filter, and
  both engines reach the same verdict from the same store. The row-level
  heuristic — "warn on a name absent in every returned row" — was rejected
  for exactly that reason: it would warn on a correct `where stage == "x"`
  that happens to match no process, go quiet on a typo once a page is empty,
  and differ between the planned and in-memory paths by what a page holds.
  Severity follows the shape: `links` is closed, so an unknown name there is
  an error; docs, blocks and nodes are open — partial presence is the data
  model working — so a read gets a hint and its rows, a write selector a
  refusal. Blocks and nodes are judged by the attrs keys live rows carry
  (their bare-name read), not by the block-scoped `properties` rows a block
  row cannot read; treating nodes as closed (their attrs keys are
  graph-defined) was considered and declined, since `not checked` would then
  be an error on any repository without a task. The nearest-match rule
  (distance ≤ 2, or a substring of ≥ 3 characters; lowest distance, shorter,
  alphabetical) is implemented as decided and its two awkward edges (`x` →
  `id`, `via` → `id` over `via_id`) are pinned as truth for a later decision
  rather than special-cased. `hints` is a result member, not an error: a
  minor. Fixtures: `query-unknown.json` (33), the moved cases listed in §9.

- 2026-10-13, surface 4.5: the second teaching pass (with `spec/mutate`
  3.4), driven by a 78-run agent benchmark against the minimal profile that
  passed every task but guessed first: the effect shapes, `graph { roots:
  "<one path>" }`, `docs_read_many { docs: "/a.md,/b.md" }`, and `query_syntax`
  (31 kB) reached for eleven times for `links` and string methods, while
  every `plan`'s `preview.diffs` (13–19 kB for one `retarget`) rode along
  every later turn unread. Four changes, each additive. (1) The `effects`
  argument's schema description spells `at`, the per-op `expect` shapes,
  the `field` list per target kind and where `expect.max` lives. (2) The
  `query` ladder gains a `links` rung and a string-method rung (its tag and
  paging rung folded into the frontmatter rung; 28 steps); `plan`'s summary
  names `diffs: true`. (3) `plan { diffs?: boolean }`, default `false` —
  `preview.diffs` on request only, `plan_id` untouched (the preview is
  outside the digest); the CLI's `--server` dry runs pass `diffs: true`. (4)
  Every string-list argument takes one bare string as a one-element list
  through one shared schema helper; a comma-joined string stays an error
  with the split list as its `fix`. The fixture rule for `filter_invalid`
  records its `fix` as `data: { fix }` (§6), so the surface's own comma fix
  and `spec/mutate` 3.4's shape fixes are pinned where a case reaches them.
  Arguments added, descriptions reworded, a result member made opt-in: a
  minor. Fixtures: `examples.json` re-extracted (27 → 28 steps; the pinned
  4.3 digests hold — no rung's JSON moved except `query`'s), `reads.json`
  (22 plan previews lose `diffs`; `arguments` 35 → 42 steps), `interop.json`
  (9 previews lose `diffs`; `write-select-apply-max` records the `fix`),
  `tool-descriptions.json` (`query`, `plan`).

- 2026-10-13, surface 4.4: the teaching surfaces (with `spec/mutate` 3.3 and
  `spec/cli` 4.3). Channel 1 — the `plan`, `apply` and `execute` ladders are
  spelled in the 3.2 sugar (bare paths, `$new.0` as a target, `-> ` leaders
  for the row-scoped rung), every ladder under 900 characters, each comment
  teaching one thing; where a rung kept its intent its plan digest is the
  4.3 one (pinned: the three `apply` rungs, `plan`'s first two, `execute`).
  Channel 2 — `data.fix`, a literal corrected call on every
  error the engine can correct (§4 "Error data", §9; the planner's in
  `spec/mutate` §8; the surface's own on `blocks_append` /
  `docs_append`). Channel 3 — `preview.summary` on the Plan and `summary` on
  every Receipt (`spec/mutate` §11.9). Keys added, nothing changed or
  removed: a minor. Fixtures: `examples.json` re-extracted (the same 27
  steps; the third, fourth and fifth `plan` rungs re-pinned — their intent
  shrank to fit the budget, and a `-> ` template is digested as written in
  `selection.templates`), every recorded Receipt gains `summary`,
  the `block_not_container` / `ambiguous_heading` / `parent_missing` reads
  gain `fix`, `tool-descriptions.json` the three ladders.

- 2026-10-13, surface 4.3: catalog **profiles** and example-ladder
  **descriptions** (§4 "Profiles", "Descriptions"). A server serves `full`
  (every tool, the default) or `minimal` (ten tools: `query`, `query_syntax`,
  `docs_read`, `docs_tree`, `blocks_resolve`, `changes_since`, `plan`,
  `execute`, `apply`, `version`), chosen by the host (`--tools`, the
  `mcp.tools` setting); a profile filters listing and calling, never
  semantics; `tools/call` on a name the server does not serve is the JSON-RPC
  `-32602` error `unknown tool <name>` in both engines (the reference said
  "Tool <name> not found" through 4.2 — a protocol-level text no fixture
  pinned); `version` gains `profile` (its last key). The ten minimal tools'
  descriptions become example ladders whose rungs are extracted mechanically
  into `cases/examples.json` (27 steps over the alchemy corpus) and run — the
  drift gate — and `query`'s grammar prose folds into `query_syntax`'s
  reference text (the DOT/WHITESPACE rule, `bare`, the relative `from E`
  inside a block, `$ordinal`/cycle detail); the other 37 descriptions are
  unchanged. A tool-visibility option and a result key added, descriptions
  reworded: a minor. Fixtures: `examples.json` (new), `profiles.json` (new),
  `interop.json` 28 → 29 (`profile-minimal`, with the harness's `server_args`,
  `tools/list` and `rpc_error` forms, §7.2/§7.3), `reads::orientation`
  (`version`'s shape gains `profile`), `tool-descriptions.json` (the ten).
  The selector rungs are written in the `{ "oqx": … }` form and the document
  targets as `{ kind: "document", path }`; both move to the `->` leader and
  bare targets with `spec/mutate` 3.2 (the next release), when the ladders
  shorten.
- 2026-10-13, surface 4.2: `query` gains `bare?: boolean` (§1.4) — each hit
  as its projection only, without the automatic `id`/`path` envelope members,
  for display and export where identity is noise. Rules: needs a `select`
  (`filter_invalid`), refused beside `values` (`filter_invalid`; already the
  bare-values form), ignored by the scalar consumers, no envelope-collision
  check (a projected `id`/`path` is the intrinsic under the key the query
  gave it), `distinct` by the whole projection, paging/`truncated`/`cursor`
  unchanged (identity kept internally, the envelope stripped last). The
  default is byte-identical to 4.1. An argument added: a minor. Fixtures:
  `query-docs.json` 96 → 106 (the `bare-*` cases), `reads::arguments` (the
  `query` argument list names `bare?`), `tool-descriptions.json` (`query`).
  Rendered by `spec/cli` 4.1 as `query --bare`.
- 2026-10-13, surface 4.1: query-directed planning (`spec/mutate` 3.1
  §11.8). `plan`, `apply` and `execute` gain `select?` and `expect?`
  (additive — a call without them is byte-identical to 4.0): the `effects`
  become templates bound to an OQX selector's hits, the Plan gains the
  digested `selection` member, `planner_v` is `p3` (every pinned `plan_id`
  moves: `interop.json` ×7 plans, `reads.json` ×22). `apply` with `select`
  requires `expect.max`. Two codes join the envelope (`ambiguous_target`,
  `selection_too_large`) and `filter_invalid` gains the `hint: "selection"`
  family; the runner refuses a `__omg_`/`__oqx_` projection alias on every
  query (it could overwrite the hit envelope through 4.0 — §9 closes).
  Arguments added: a minor. Fixtures: `interop.json` 25 → 28
  (`write-select-plan-execute`, `write-select-apply-max`,
  `write-select-zero-hits`), `tool-descriptions.json` (`plan`, `apply`,
  `execute`).
- 2026-10-12, surface 4.0: the retirement release of ADR-021 (with
  `spec/mutate` 3.0 and `spec/cli` 4.0; no deprecation period — no client of
  the retired inputs existed). Removed: `apply.ops` (the kernel ops are a
  library/fixture contract), `dry_run` on `apply` and every sugar tool (the
  preview is `plan`; the dry-run id burn of §9 is closed), `blocks_update`'s
  `attrs` bag (`checked` is the one editable attribute), `links_retarget` /
  `links_repair`'s dry-run default and `applied` (they commit; the preview is
  `plan { retarget }` → `preview.retarget`), `docs_update`'s `{ opset, plan,
  result }` and its `dry_run`. Changed: every sugar tool returns the Receipt;
  `docs_update` is `set content` sugar (content equal to the document → a plan
  with nothing to do, `commit: null`); a committed `docs_create` carries `api`
  dispositions (§9). Added: `preview.identity` and `preview.retarget` on the
  Plan; the retired-name messages for `ops`, `dry_run`, `attrs` (§4). Tools
  removed or changed in meaning: a major. Fixtures: `interop.json` 24 → 25
  (`write-effects-create-and-fill`; `write-docs-update` rewritten;
  `write-effects-*` re-digested under `planner_v` p2), `reads.json`'s two
  `docs_update` dry runs → `plan`, `tool-descriptions.json` (`plan`,
  `docs_update`); the remaining dry-run calls of `interop.json` / `reads.json`
  and the descriptions of the sugar tools move with the removals.
- 2026-10-12, surface 3.3: ADR-021's migration phase, batch 2 — the four
  document operations (`docs_create`, `docs_delete`, `docs_move`,
  `docs_set_meta`; §4 "The document operations") are `apply { effects }`
  sugar. Results, error envelopes (the `path_taken` pair without `data`, the
  `doc_missing` locator), reasons, bytes, rows and mint sequences are
  unchanged — the reference's `migration.test.ts` proves it over the alchemy
  corpus, committed and dry, for 26 scenarios — except the accepted identity
  change of a committed `docs_set_meta` (§9: `edited`/`api` dispositions
  instead of the matcher's `same`/`exact_hash`; one new `blocks_history` read
  in the interop case pins it) and the new argument error for an empty patch.
  A result observable through a read tool changed: a minor. `docs_update`
  stays legacy by design. The CLI gains the layer's verbs the same day
  (`spec/cli` 3.2: `apply -f { effects }`, `execute`).
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
