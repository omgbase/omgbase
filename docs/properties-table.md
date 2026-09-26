# omgbase — Properties Table (as-built)

**Status:** as-built / normative. The `properties` table shipped (schema migration 8;
current `SCHEMA_VERSION = 13`) and supersedes the removed `docs.metadata` JSON blob for
property-shaped data. This document keeps its original "today → after" design framing;
"today" below is the pre-migration state, and the `compile.ts` / CEL references describe
the former in-tree CEL compiler (`search/cel/compile.ts`), which ADR-013 has since
retired — property reads now go through the OQX `DataContext`
(`packages/core/src/oqx-js/context.ts`, `docProp` / `docPropEntries` / `docPropObject`)
and the pushdown translator (`oqx-js/sql/translate.ts`, the single-valued `properties`
seek).

> **The language-neutral contract is `spec/properties/README.md`** (row shape, value typing, the three sources, the YAML contract, the read shapes) with executable fixtures under `spec/properties/cases` that both the reference (`packages/core/corpus/properties/spec.test.ts`) and the Rust `omgbase-properties` crate run. This document is the design rationale; when the two disagree, the spec's fixtures win.

> **As-built / normative — verified against code (2026-09-23).** This design is fully implemented: schema migration 8 added the `properties` table (current `SCHEMA_VERSION = 13` — the "Schema v8" in §7 is the migration that introduced it, not the current version); `docs.metadata` was dropped; and `docs_read` returns properties grouped by source (`{ frontmatter, inline, computed }`) exactly as §4 describes — confirmed in `packages/core/src/core/read/document.ts` and `store/properties.ts`. (Caveat: the MCP `docs_read` **tool description string** still mentions `metadata`, but the returned shape is the grouped one.) See `AGENTS.md` for the docs trust index.

---

## 1. The problem

An agent wants to filter, project, and sort documents by three sources of
document-level properties, uniformly and index-fast:

1. **Frontmatter** — the parsed YAML fence (`layer: canon`, `tags: [a, b]`).
2. **Inline properties** — dataview-style `key:: value` fields in body text.
3. **Computed properties** — derived facts the engine synthesizes (e.g. a
   title from the first H1, a task rollup, word count).

Today these live in **two stores with opposite performance**, and one of them
doesn't exist yet as a query surface:

| Source | Where it lives now | Indexed? | Queryable? |
|---|---|---|---|
| Frontmatter | `docs.metadata` (JSON TEXT column) | **No** — full scan + `json_extract` per row | Yes (bare keys in the query filter — then CEL, now OQX) |
| Inline props | `nodes` table (`kind='md:inline_field'`) | Yes (`idx_nodes_kind/name`) | Only via `from:"nodes"` |
| Computed | nowhere durable | — | No |

So `layer == "canon"` is a table scan (`json_extract(d.metadata, '$.layer')` with
no index — the former `search/cel/compile.ts`; as-built the read is
`docProp` in `oqx-js/context.ts` seeking the `properties` table), while the
inline-field surface is indexed but lives
on a different target with a different shape. The assumption that "the JSON
column makes querying fast" is **false**: it makes compilation *simple* (one
expression) but every docs-target frontmatter filter scans the table.

## 2. What `docs.metadata` actually does today

Traced across the codebase, the JSON column is the **sole query+projection
surface for frontmatter**, used by:

- Query filters + `doc.<key>` reach-through (then the CEL `compile.ts`; as-built
  `oqx-js/context.ts` `docProp` + `owningDoc`, pushed down by
  `oqx-js/sql/translate.ts`) — the only path frontmatter filtering exists on.
- `query` select projection (`query.ts`), semantic-path projection.
- RRF hydration (`rrf.ts:50`), task docTitle (`tasks.ts:89`),
  `findDoc`/`docs_read`/`show` (`reader.ts:103`).

It is a **denormalized parse cache**: the authoritative bytes are the
frontmatter blob; `metadata` is pre-parsed JSON so filters don't `parseYaml`
every row. Real purpose — but a *convenience* one (avoid re-parsing), not a
*performance* one (it isn't indexed).

The critical properties it currently provides, which any replacement MUST keep:

- **Typed scalar comparison** — `priority >= 3`, `$updated_at >= "2026-08-01"`
  (numeric/string ordering, not just equality).
- **Nesting** — `meta.owner` via `json_extract(..., '$.meta.owner')`.
- **Scalar-or-array polymorphism** — `"x" in list(tags)` where `tags` may be a
  scalar or a YAML list (`compileMembership`, `json_each` over the value).
- **Absence semantics** — a missing key is NULL ⇒ every comparison false,
  `!bare` true (10 §3.3).

The current `nodes` table (flat `name`/`value` TEXT, no type, no nesting, no
multi-value beyond multiple rows) does **not** provide these — which is exactly
why inline props aren't first-class query citizens today.

## 3. Proposal: one indexed `properties` table

A single durable, indexed, per-document (and optionally per-block) property
store that all three sources write into, tagged by provenance.

```sql
CREATE TABLE properties (
  prop_id    TEXT PRIMARY KEY,          -- deterministic: hash(doc|source|key|ordinal)
  repo_id    TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  block_id   TEXT,                      -- NULL = document-scoped (frontmatter, computed);
                                        -- set = where an inline prop was authored
  source     TEXT NOT NULL CHECK (source IN ('frontmatter','inline','computed')),
  key        TEXT NOT NULL,             -- dotted path, flattened: "layer", "meta.owner"
                                        -- (computed keys carry their $ sigil: "$title")
  card       TEXT NOT NULL CHECK (card IN ('scalar','list')),  -- authored shape:
                                        -- scalar `k: v` vs list `k: [..]`. Governs
                                        -- whether ==/!=/< can match (scalar only);
                                        -- list() ignores card (sees all rows).
  ord        INTEGER NOT NULL DEFAULT 0,-- position within a multi-value key (arrays)
  -- typed value columns: exactly one non-NULL (or all NULL for an explicit null)
  val_text   TEXT,
  val_num    REAL,
  val_bool   INTEGER,                   -- 0/1
  val_json   TEXT,                      -- objects/arrays that resist flattening (escape hatch)
  type       TEXT NOT NULL CHECK (type IN ('string','number','bool','null','json')),
  created_commit TEXT NOT NULL,
  deleted_commit TEXT
);

CREATE INDEX idx_props_doc      ON properties(doc_id)                          WHERE deleted_commit IS NULL;
CREATE INDEX idx_props_key_text ON properties(repo_id, key, val_text)          WHERE deleted_commit IS NULL;
CREATE INDEX idx_props_key_num  ON properties(repo_id, key, val_num)           WHERE deleted_commit IS NULL;
CREATE INDEX idx_props_src_key  ON properties(repo_id, source, key)            WHERE deleted_commit IS NULL;
```

### Modeling decisions

- **Typed columns, not one TEXT `value`.** `priority >= 3` needs numeric
  ordering; `$updated_at >= "..."` needs string ordering. A single TEXT column
  can't index both meaningfully. Splitting `val_text`/`val_num`/`val_bool` lets
  the index serve range predicates. `type` disambiguates.
- **Flattened dotted keys.** `meta.owner` stored as `key = "meta.owner"`, so
  nested access is a direct key lookup, not a JSON walk. Deep/irregular
  structures that don't flatten cleanly fall back to `val_json` (queried with
  `json_extract` only when needed — the rare slow path, not the common one).
- **Multi-value via rows + `ord`, gated by `card`.** `tags: [a, b, c]` becomes
  three `card='list'` rows (`ord=0..2`); `layer: canon` is one `card='scalar'`
  row. `list()` reads all rows for the key; `==`/`!=`/`<` match only
  `card='scalar'` rows — so `tags == "a"` on a YAML list is false (unchanged
  from today), and `"a" in list(tags)` is the indexed `EXISTS`. This is how the
  row model reproduces `json_extract`'s scalar-vs-array distinction.
- **Range-valued strings are autopromoted into cached bounds — for indexing,
  not meaning.** YAML has no range type, so a frontmatter value written as a
  Ruby-style range (`window: 2026-01-01..2026-01-31`, `qty: 1..5`) is a plain
  string. Ingest recognizes the range shape (`detectRange`, strict: both bounds
  numeric, or both ISO-8601 dates) and keeps the row `type='string'` with the
  **verbatim** text in `val_text` — so hydration, display, equality, FTS, and
  round-trip are exactly a string's — while caching the parsed bounds
  `{lo,hi,exclusiveEnd}` in `val_json`. That cache is **semantics-neutral**: a
  bare property is a string everywhere; range behavior is opt-in via the
  `range(prop)` query function (query-language.md §3.5), which reads the string
  as an interval. Because the promotion never changes an answer, it is safe
  regardless of whether the author *meant* a range. The cache exists as the
  substrate for a future tier-3 pushdown of `in range(prop)` onto indexed bounds
  (not yet wired — `range()` currently parses at query time). The same pattern
  generalizes to other string-encoded types (e.g. a future `date(s)`/`time(s)`
  with a cached normalized/epoch form).
- **`source` is the provenance delineation.** `frontmatter` / `inline` /
  `computed` as a filterable column — no `$frontmatter`/`$inline` reserved keys
  in content-space. Bare keys span the *authored* sources; computed values are
  `$`-intrinsics, not bare keys (see §4), so engine-derived facts never shadow a
  user's `title:`/`tags:`.
- **Block scope retained.** Inline props keep their authoring `block_id`, so
  "which paragraph asserted `owner:: alice`" is still answerable, and computed
  props can be doc- or block-scoped.

## 4. Query surface

The authored query syntax and its semantics were **unchanged by this migration** —
bare keys, `==`, `!=`, `list()`, membership, `size()` all kept the meaning they had
against `docs.metadata`. (The later ADR-013 move to `@omgbase/oqx` did change scalar
semantics — `!=` over absent, case-sensitive strings, arithmetic — see
`query-language.md` §3; the property *store* below is unaffected.) Only the compile target changes (indexed
`properties` rows instead of `json_extract` scans), plus two additive powers:
source-scoped accessors and computed `$`-intrinsics.

### Scalar semantics preserved (no behavior change)

Values *may* be scalars or lists — same as any YAML value today. `==`/`!=`
compare the scalar; `list()` is the explicit multi-value accessor. We do **not**
make bare comparison existential.

```
from: docs  filter: layer == "canon"          # scalar equality (unchanged)
from: docs  filter: priority >= 3             # scalar range (unchanged)
from: docs  filter: "pricing" in list(tags)   # list membership (unchanged)
from: docs  filter: size(list(tags)) > 2      # list length (unchanged)
```

The load-bearing rule to preserve: **`tags == "a"` where `tags` is a YAML list
is FALSE** — a list is not scalar-equal to a scalar; you must use
`"a" in list(tags)`. This matches `json_extract` behavior today and the row
model must reproduce it (see "How the row model preserves scalar `==`" below).

### `list()` and the row model

A key's rows for a given scope (a `(doc, key)`, optionally narrowed by `source`)
are its value set. `list(k)` is those rows; membership/`size`/`.exists`/`.all`
operate over them — an indexed `EXISTS`/`COUNT`, not a `json_each` scan:

```
"a" in list(tags)   →  EXISTS (SELECT 1 FROM properties
                                WHERE doc_id=d.doc_id AND key='tags'
                                  AND val_text=? AND deleted_commit IS NULL)
size(list(tags))    →  (SELECT COUNT(*) FROM properties WHERE … key='tags' …)
```

**How the row model preserves scalar `==`.** A single YAML scalar `layer: canon`
stores one row with a flag marking it scalar-authored; a YAML list `tags: [a,b]`
stores rows marked list-authored. The flag is a small `card` column
(`scalar` | `list`) on `properties`, set at ingest from the YAML/JSON shape (and,
for inline fields, from occurrence count — see §6). `list()` ignores `card` (sees
all rows).

`layer == "canon"` compiles to "the key is **single-valued in the queried scope**
and its one row is **scalar-authored** and equal to the literal." Two independent
gates, both required:

1. **Single-value in scope.** `COUNT(*)` of the key's rows in the scope
   (a `(doc, key)`, narrowed by `source` for `frontmatter.`/`inline.`) must be 1.
   A list of two elements, a repeated inline field, or a **bare key that collides
   across frontmatter + inline** all have ≥2 rows, so scalar `==` cannot match —
   you use `list()`. This is what makes a frontmatter/inline collision behave as a
   list without needing a merged-shape rewrite at ingest.
2. **Scalar-authored.** That single row must be `card='scalar'`. A one-element
   YAML list `tags: [a]` is a single row but list-authored, so `tags == "a"` stays
   false (reproducing `tags == "a"` ⇒ false).

A lone inline `element:: fire` is one scalar-authored row in scope ⇒ `element ==
"fire"` matches; a second `element:: …` in the same doc makes it list-authored
*and* multi-valued, so scalar `==` falls back to `list()`.

### Provenance-scoped access (the new differentiation)

A source-qualified accessor narrows to one provenance; same operators, same
scalar/list rules, just filtered by `source`:

```
from: docs  filter: frontmatter.layer == "canon"    # only the fence
from: docs  filter: inline.job == "janitor"         # only key:: fields
from: docs  filter: "farmer" in list(job)           # any authored source
```

Bare `<k>` spans authored sources (`frontmatter` + `inline`); `frontmatter.<k>`
/ `inline.<k>` narrow to one. (Computed props are NOT bare keys — see next.)

### Computed properties are `$`-intrinsics, not bare keys

Engine-derived properties live in the `$`-namespace, alongside `$path`/`$id`,
and do **not** claim the bare `title`/`tags` keys — those remain 100% author
content (frontmatter/inline). This keeps the sigil rule exact: `$` = engine,
bare = authored.

```
$title                # derived from the first H1 (NOT the frontmatter `title`)
$tags                 # derived from body #hashtags (NOT frontmatter `tags`)
```

So `title == "x"` matches the *authored* frontmatter/inline `title`; `$title`
matches the *computed* H1-derived one. They never collide, and a user's
`title:`/`tags:` frontmatter is never shadowed by a computed value. Computed
`$`-intrinsics are stored as `source='computed'` rows and surfaced by name
through the intrinsic table in the compiler (like `$path`), not via bare-key
resolution.

### `docs_read` and projection

`docs_read` returns properties grouped by source, so one hydrate shows authored
vs. computed provenance:

```jsonc
{
  "path": "...", "docId": "...", "rev": "...",
  "content": "...",                     // byte-exact file (unchanged)
  "properties": {
    "frontmatter": { "layer": "canon", "tags": ["a","b"] },   // scalar stays scalar
    "inline":      { "job": ["janitor","salesman"] },
    "computed":    { "$title": "Q3 Plan", "$tags": ["urgent"] }
  }
}
```

There is no `metadata` field — the JSON column is gone (§5). Scalar-authored keys
render as scalars, list-authored as arrays (honest to `card`). `query` select
gains `frontmatter.<k>` / `inline.<k>` / bare `<k>` / the computed `$`-intrinsics
/ `$properties`.

## 5. `docs.metadata` is removed (decided)

The JSON column is **dropped, not demoted.** It was a mis-named
(`metadata` conflated "frontmatter" with "everything"), unindexed, redundant
parse cache; `properties` supersedes it as the query surface, and the
authoritative bytes already live in the frontmatter blob. There is no "merged
view" column and no precedence order to define — union semantics (§4) mean the
merged view is just "all rows for the key," computed on demand from the index.

Every current reader of `docs.metadata` is repointed at `properties`:

| Site | Today | After |
|---|---|---|
| Query filter / `doc.<k>` (then CEL `compile.ts`; now `oqx-js/context.ts` + `oqx-js/sql/translate.ts`) | `json_extract(d.metadata,…)` | `properties` seek (§4) |
| `query` select (`query.ts`) | parse `metadata` JSON | `properties` projection |
| RRF hydrate (`rrf.ts`), task title (`tasks.ts`) | parse `metadata` | `properties` lookup / `computed.title` |
| `findDoc`/`docs_read`/`show` (`reader.ts`) | `metadata` object | `properties` grouped-by-source |

`findDoc`'s `DocInfo.metadata` field is removed; callers that need properties
ask for them explicitly (grouped by source), which is more honest than a bare
object that hid provenance. `show`/`docs_read` render the grouped shape.

The frontmatter object as authored is still fully recoverable — it's the
`source='frontmatter'` rows (or, byte-exact, the frontmatter blob via
`docs_read`'s `content`). Nothing is lost; the redundant, misleading store is.

## 6. Ingest changes

`ingestFile` today parses frontmatter → `metadata` JSON and projects nodes
(inline fields among them) → `nodes`. The `metadata` write is **deleted**;
in its place:

1. **Flatten frontmatter → property rows** (`source='frontmatter'`): walk the
   parsed object, emit typed rows, arrays as `ord`-indexed rows, deep objects to
   `val_json`. (Within one fence, YAML duplicate-key resolution has already
   happened in the parser — we store the parsed result.) For Markdown the
   parsed object comes from the **`frontmatter` block of the block tree and
   nothing else** (spec/properties §3.1): a document whose first block is not
   `frontmatter` has no frontmatter rows, whatever its bytes resemble. (The
   Markdown adapter's former regex `extractMetadata` over the raw source was
   removed for this — it matched `---\nfoo: 1\n---bar\n`, which has no
   frontmatter block, and cut a fence short at any line starting with `---`.)
   The YAML and JSON adapters still supply whole-document metadata via
   `extractMetadata`.
2. **Route inline fields → property rows** (`source='inline'`): the adapter
   emits `md:inline_field` ProjectedNodes with name/value + block_id; these
   become `properties` rows. `card` reflects the authored shape within the inline
   source: a key that occurs **once** in the document is `scalar` (so a lone
   `element:: fire` is scalar-comparable); a key that **repeats** is `list`, its
   occurrences accumulating as `ord`-indexed rows in document order
   (`job:: janitor` + `job:: salesman` = two `list` rows). The union semantics
   fall straight out of the row model, and cross-source multiplicity (a bare key
   that also has a frontmatter row) is handled at query time by the single-value
   gate (§4), not by rewriting `card` here. Inline fields move fully out of
   `nodes`. The adapter captures an inline value to end of line (dataview line
   form `key:: multi word value`) or to the closer for the bracketed in-prose
   form (`[key:: value]` / `(key:: value)`) — not just the first whitespace-
   delimited token.
3. **Computed props hook** (`source='computed'`): an adapter capability
   (`computeProperties(blocks, frontmatter)`) returning derived rows — title
   from first H1, task counts, etc. New capability; markdown implements title.

No `metadata` recompute step — the column is gone. All within the existing
ingest transaction.

**`properties` is current-state, peer to `blocks` — not a `rebuild-index`
target.** The §4 derived tables `rebuild-index` rebuilds (`sections`, `edges`,
`fts`, `block_changes`) are pure rollups of the `blocks` table. `properties`
derives from the *same inputs `blocks` itself is built from* (block text +
frontmatter blob + adapter), so it is maintained transactionally at ingest
alongside `blocks` and repopulated the same way `blocks` is — by re-ingest
(`ingestDirectory` / `freshnessSweep`), not by an in-db rollup rebuild. Adding a
`rebuild-index --properties` target would miscategorize it (and require fragile
block-id remapping). If a bulk recompute is ever needed, it is a re-ingest pass,
not an index rebuild.

## 7. Migration

- Schema v8: add `properties` table + indexes; add `computeProperties` adapter
  capability (optional).
- Compiler: route docs-target bare keys and the new `source.<k>` accessors
  to `properties`; keep `json_extract` only as the `val_json` escape hatch.
- Keep `nodes`/`nodes_fts` for non-property projections (links, anchors,
  wikilinks, tasks-as-nodes); inline *fields* migrate to `properties`.
- **Drop the `docs.metadata` column** (schema v8 rewrites the table).
  Since nothing is deployed there is no data to preserve — the column simply
  ceases to exist; `DocInfo.metadata` and every read of it are removed in the
  same change.

## 8. Analysis / trade-offs

**Wins**
- All three property sources uniformly **index-fast** (seeks, not scans) on one
  target.
- Provenance delineation (`frontmatter`/`inline`/`computed`) as a filterable
  column — no `$`-key pollution of content-space, sigil rule intact.
- Range predicates and membership become indexed instead of scans.
- Computed properties get a durable home for the first time.
- The mis-named, unindexed, redundant `metadata` JSON column is **gone** — one
  store, one model, honest naming.
- **Query semantics are unchanged by this design** — `==`/`!=`/`list()`/`size()`
  keep their meaning; the `card` flag reproduces the scalar-vs-array distinction. No
  authored query changes behavior. Multi-source additivity applies only to the
  *authored union* (frontmatter + inline) a bare key already spans.
- Computed props as `$`-intrinsics keep the sigil rule exact and never shadow
  user `title:`/`tags:` keys.

**Costs / risks**
- **Compiler rework is the bulk of the work.** `list()`, membership, `size()`,
  `.exists`/`.all`, comparisons, and absence all move from `json_extract` to
  typed-row predicates (mostly `EXISTS (SELECT 1 FROM properties WHERE …)`),
  with the `card` gate on scalar comparisons. The semantics are unchanged, so
  the existing query test suite (as-built: the OQX corpus, `corpus/oqx/`) is a
  strong equivalence oracle — port it and it must stay green, plus new cases for
  `card` and multi-source union.
- **Read-site churn.** ~6 sites read `docs.metadata` today; all repoint to
  `properties` and `DocInfo.metadata` is removed (§5). Bounded and enumerated.
- **More rows.** N frontmatter keys + M array elements + K inline fields = N+M+K
  rows vs. one blob. Negligible at Zettelkasten scale; soak-test it.
- **Type coercion at ingest.** YAML/JSON values sorted into text/num/bool/json
  columns; edge cases (dates-as-strings, mixed-type arrays) need rules. `type` +
  `val_json` escape hatch cover them.
- **`val_json` escape hatch is still a scan** for deep/irregular structures —
  rare; the common flat case is a seek.

**Non-goals / deferred**
- Historical/temporal property queries (`as_of`) — properties carry
  `created_commit`/`deleted_commit` for future temporal support, unused in v1.
- Per-block property *filtering* on the blocks target — v1 is document-grain;
  `block_id` is stored for provenance but blocks-target property filtering is later.

## 9. Resolved decisions + remaining open questions

**Decided (Brendan):**
- **Kill `docs.metadata`.** Not demoted — removed. Wrong name, redundant,
  unindexed. (§5)
- **Query semantics unchanged (by this design); `list()` stays the explicit multi-value tool.**
  Values may be scalar or list (as YAML always allows); `==`/`!=` are scalar,
  `"x" in list(k)` for membership. A `card` flag on each row reproduces the
  scalar-vs-array distinction so `tags == "a"` on a list stays false. (§4)
- **Bare key = the authored union (frontmatter + inline).** Inline repeats and
  cross-source authored collisions accumulate into the key's value set (queried
  via `list()`). **Scalar `==` matches only when the key is single-valued in the
  queried scope** — one row, scalar-authored (§4). So a lone inline `element::
  fire` is scalar-comparable, but a repeat or a frontmatter/inline collision on a
  bare key becomes a list and must be read with `list()`. (This refines the
  earlier "scalar `==` matches any scalar-authored row" wording: multiplicity in
  scope, not just authored shape, gates scalar comparison.) YAML duplicate-key
  rules apply within a fence before storage.
- **Computed props are `$`-intrinsics, not bare keys.** `$title` (first H1),
  `$tags` (body hashtags) live in the `$`-namespace and do NOT claim/shadow the
  authored `title`/`tags` keys. (§4)
- **Inline fields move fully to `properties`** (clean move, nothing deployed).

### Deterministic ordering (decided)

Systems principle: **everything is unsurprisingly deterministic.** The order of
values in a `list(k)` result is a fixed total ordering, never storage-dependent,
fully determined by the document bytes:

1. **Source precedence:** `frontmatter` → `inline` → `computed`.
2. **Within a source:** authored order — a YAML list's element order (`ord`
   0,1,2…); inline occurrences in document order (block ordinal, then in-block
   position); frontmatter keys in fence order.
3. **Ties:** never — the above is total. (`ord` + source rank + block ordinal
   uniquely position every value.)

Every query that emits values (`list()`, `docs_read` projection, `select`)
applies this ordering, so identical bytes always yield identical output. This is
the concrete meaning of the `ord` column: a stored position index feeding a
deterministic sort, not a hint.

### Future wishlist (not v1): list-comparison sugar

An operator that folds the `list()` conversion into the comparison, for
readability where membership-style intent is clearer than `in list(...)`:

- `left ==* right`  ≡  `left in list(right)` — left equals *any* element of right.
- `left !=* right`  ≡  `!(left in list(right))` — left equals *no* element.
- possibly mirror forms `*==` / `*!=` (any element of left matches right).

Pure syntactic sugar over the existing `list()` semantics — no new storage or
evaluation model, just parser + compiler desugaring. Deferred; noted so the
grammar leaves room (the `*` suffix/prefix on relops is currently unused).

**Still open:**
- [ ] Which computed `$`-intrinsics ship first — `$title` (first H1) and
  `$tags` (body #hashtags) are the named two; `$word_count`/`$task_count`
  candidates.
- [x] Array-of-objects in frontmatter: straight to `val_json` — one
  `card='list'` row (`ord` 0, `type='json'`) carrying the whole array
  (spec/properties §2.3; note the read shape then wraps it in another array,
  `shapes::json-escape-hatch-reads-as-nested-array`).
