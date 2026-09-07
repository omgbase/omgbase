# omgbase — Properties Table (design proposal)

**Status:** proposal / RFC. Not yet normative. Supersedes the ad-hoc split between
`documents.metadata` (JSON blob) and the `nodes` table for property-shaped data.

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
| Frontmatter | `documents.metadata` (JSON TEXT column) | **No** — full scan + `json_extract` per row | Yes (bare keys → CEL) |
| Inline props | `nodes` table (`kind='md:inline_field'`) | Yes (`idx_nodes_kind/name`) | Only via `from:"nodes"` |
| Computed | nowhere durable | — | No |

So `layer == "canon"` is a table scan (`json_extract(d.metadata, '$.layer')` with
no index — compile.ts:69), while the inline-field surface is indexed but lives
on a different target with a different shape. The assumption that "the JSON
column makes querying fast" is **false**: it makes compilation *simple* (one
expression) but every documents-target frontmatter filter scans the table.

## 2. What `documents.metadata` actually does today

Traced across the codebase, the JSON column is the **sole query+projection
surface for frontmatter**, used by:

- CEL filters + `doc.<key>` reach-through (`compile.ts:69/85/108`) — the only
  path frontmatter filtering exists on.
- `query` select projection (`query.ts`), semantic-path projection.
- `graph_traverse` nodeInfo (`traverse.ts:202`), RRF hydration (`rrf.ts:50`),
  task docTitle (`tasks.ts:89`), `findDoc`/`docs_read`/`show` (`reader.ts:103`).

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
- **`source` is the provenance delineation.** `frontmatter` / `inline` /
  `computed` as a filterable column — no `$frontmatter`/`$inline` reserved keys
  in content-space. Bare keys span the *authored* sources; computed values are
  `$`-intrinsics, not bare keys (see §4), so engine-derived facts never shadow a
  user's `title:`/`tags:`.
- **Block scope retained.** Inline props keep their authoring `block_id`, so
  "which paragraph asserted `owner:: alice`" is still answerable, and computed
  props can be doc- or block-scoped.

## 4. Query surface

The authored CEL syntax and its semantics are **unchanged** — bare keys, `==`,
`!=`, `list()`, membership, `size()` all keep the exact meaning they have today
against `documents.metadata`. Only the compile target changes (indexed
`properties` rows instead of `json_extract` scans), plus two additive powers:
source-scoped accessors and computed `$`-intrinsics.

### Scalar semantics preserved (no behavior change)

Values *may* be scalars or lists — same as any YAML value today. `==`/`!=`
compare the scalar; `list()` is the explicit multi-value accessor. We do **not**
make bare comparison existential.

```
from: documents  filter: layer == "canon"          # scalar equality (unchanged)
from: documents  filter: priority >= 3             # scalar range (unchanged)
from: documents  filter: "pricing" in list(tags)   # list membership (unchanged)
from: documents  filter: size(list(tags)) > 2      # list length (unchanged)
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
stores rows marked list-authored. `layer == "canon"` compiles to "the key has a
**scalar-authored** row equal to the literal"; a list-authored key therefore
never satisfies scalar `==` (reproducing today's `tags == "a"` ⇒ false). The
flag is a small `card` column (`scalar` | `list`) on `properties`, set at ingest
from the YAML/JSON shape. `list()` ignores `card` (sees all rows); `==`/`!=`/`<`
require `card='scalar'`.

### Provenance-scoped access (the new differentiation)

A source-qualified accessor narrows to one provenance; same operators, same
scalar/list rules, just filtered by `source`:

```
from: documents  filter: frontmatter.layer == "canon"    # only the fence
from: documents  filter: inline.job == "janitor"         # only key:: fields
from: documents  filter: "farmer" in list(job)           # any authored source
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

## 5. `documents.metadata` is removed (decided)

The JSON column is **dropped, not demoted.** It was a mis-named
(`metadata` conflated "frontmatter" with "everything"), unindexed, redundant
parse cache; `properties` supersedes it as the query surface, and the
authoritative bytes already live in the frontmatter blob. There is no "merged
view" column and no precedence order to define — union semantics (§4) mean the
merged view is just "all rows for the key," computed on demand from the index.

Every current reader of `documents.metadata` is repointed at `properties`:

| Site | Today | After |
|---|---|---|
| CEL filter / `doc.<k>` (`compile.ts`) | `json_extract(d.metadata,…)` | `properties` seek (§4) |
| `query` select (`query.ts`) | parse `metadata` JSON | `properties` projection |
| `graph_traverse` nodeInfo (`traverse.ts`) | parse `metadata` | batched `properties` join |
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
   happened in the parser — we store the parsed result.)
2. **Route inline fields → property rows** (`source='inline'`): the adapter
   emits `md:inline_field` ProjectedNodes with name/value + block_id; these
   become `properties` rows. Repeats accumulate as multiple rows (the union
   semantics fall straight out of the row model — `job:: janitor` +
   `job:: salesman` = two rows). Inline fields move fully out of `nodes`.
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
(`attachDirectory` / `freshnessSweep`), not by an in-db rollup rebuild. Adding a
`rebuild-index --properties` target would miscategorize it (and require fragile
block-id remapping). If a bulk recompute is ever needed, it is a re-ingest pass,
not an index rebuild.

## 7. Migration

- Schema v8: add `properties` table + indexes; add `computeProperties` adapter
  capability (optional).
- Compiler: route documents-target bare keys and the new `source.<k>` accessors
  to `properties`; keep `json_extract` only as the `val_json` escape hatch.
- Keep `nodes`/`nodes_fts` for non-property projections (links, anchors,
  wikilinks, tasks-as-nodes); inline *fields* migrate to `properties`.
- **Drop the `documents.metadata` column** (schema v8 rewrites the table).
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
- **CEL semantics are unchanged** — `==`/`!=`/`list()`/`size()` keep today's
  meaning; the `card` flag reproduces the scalar-vs-array distinction. No
  authored query changes behavior. Multi-source additivity applies only to the
  *authored union* (frontmatter + inline) a bare key already spans.
- Computed props as `$`-intrinsics keep the sigil rule exact and never shadow
  user `title:`/`tags:` keys.

**Costs / risks**
- **Compiler rework is the bulk of the work.** `list()`, membership, `size()`,
  `.exists`/`.all`, comparisons, and absence all move from `json_extract` to
  typed-row predicates (mostly `EXISTS (SELECT 1 FROM properties WHERE …)`),
  with the `card` gate on scalar comparisons. The semantics are unchanged, so
  the existing CEL test suite is a strong equivalence oracle — port it and it
  must stay green, plus new cases for `card` and multi-source union.
- **Read-site churn.** ~6 sites read `documents.metadata` today; all repoint to
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
  `block_id` is stored for provenance but blocks-target property CEL is later.

## 9. Resolved decisions + remaining open questions

**Decided (Brendan):**
- **Kill `documents.metadata`.** Not demoted — removed. Wrong name, redundant,
  unindexed. (§5)
- **CEL semantics unchanged; `list()` stays the explicit multi-value tool.**
  Values may be scalar or list (as YAML always allows); `==`/`!=` are scalar,
  `"x" in list(k)` for membership. A `card` flag on each row reproduces the
  scalar-vs-array distinction so `tags == "a"` on a list stays false. (§4)
- **Bare key = the authored union (frontmatter + inline).** Inline repeats and
  cross-source authored collisions accumulate into the key's value set (queried
  via `list()`); scalar `==` still matches any scalar-authored row. YAML
  duplicate-key rules apply within a fence before storage.
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
- [ ] Array-of-objects in frontmatter: element-per-row with what `key` shape, or
  straight to `val_json`?
