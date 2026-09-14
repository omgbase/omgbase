# omgbase — Query Language Spec

**As-built (2026-09):** the shipped query language is **OQX** (omgbase Query eXpressions). This document is normative for the **CEL scalar-predicate sublanguage** OQX embeds (§3–§8 — grammar, absence semantics, `list()`, structural functions, targets), compiled by `packages/core/src/search/cel/compile.ts`. For the OQX **surface syntax** (`from … where … select … order by … follow …`, nested queries, correlation, traversal) the live reference is the `query` tool description and its `query_syntax` companion in `packages/core/src/mcp/server.ts`, with runnable, corpus-backed examples in `packages/core/corpus/oqx/README.md`. Where this spec and those sources disagree, the sources win.

**Status:** normative for the predicate sublanguage; the sketches in `05-graph-and-query.md` §4 defer to it.
**Compatibility:** on the `docs` target the CEL subset, absence rule, and `list()` polymorphism follow mrplex's documented query language (its `query_syntax` reference, 2026-09). omgbase adds the `blocks`, `nodes`, and `edges` targets, structural functions, block-grain and node-grain intrinsics, and owning-entity reach-through (`doc.*`, `block.*`). mrplex's flat JSON query envelope and its link-graph *predicates* (`$in`/`$has`/`$links()`/`$backlinks()`) are **not** carried over — omgbase folds those concerns into the OQX expression (§1) and does link traversal via OQX `follow` (§6).

---

## 1. OQX — one expression

The `query` MCP tool takes a single OQX **string** plus pagination — nothing else. Its input schema is exactly:

```jsonc
{
  "query": "<OQX expression>",   // required
  "limit": 50,                   // optional
  "cursor": null                 // optional; opaque, same-query only
}
```

There is **no** flat `{from, filter, text, semantic, select, order, resolution, include_projected}` envelope (an earlier design; never built). Every one of those concerns folds into the OQX expression itself:

| Earlier envelope key | OQX form |
|---|---|
| `from` | `from docs\|blocks\|nodes\|edges` (top-level source projection) |
| `filter` | `where <predicate>` |
| `text` | `text("terms")` — an FTS pruning predicate inside `where` |
| `semantic` | `semantic("phrase")` — a cosine score, compared (`> 0.6`) or projected |
| `select` | `select <expr>, name: <expr>, …` |
| `order` | `order by <expr> [asc\|desc], …` |
| `limit` / `cursor` | the tool's `limit` / `cursor` arguments (unchanged) |
| `resolution` / `include_projected` | not part of OQX (see §9) |

The smallest query is `from docs where layer == "working"`. Beyond that OQX adds receiver-constrained nested queries (`nodes exists { … }`, `collect { … }`), correlation and joins (the `^` sigil with `repo.docs`/`repo.nodes`/`repo.blocks` roots), and bounded recursive traversal (`follow`). Those constructs are specified in the `query` tool description (`packages/core/src/mcp/server.ts`) and demonstrated in `packages/core/corpus/oqx/README.md`; this document covers the scalar predicates OQX embeds in each `where`/`select` scope (§3 onward).

Modes **intersect** (AND). Only current state is searched (history via `history_node` / `as_of` traversal). Results are lean projected hits (`{id, path, …projections}`, or a `count`/`exists` scalar for those consumers), never full documents — hydrate by id afterward (mrplex's projection-then-hydrate pattern, kept).

## 2. Targets and field namespaces

The sigil rule (mrplex, kept): anything kernel-owned carries `$`; bare identifiers are content territory. On the closed-namespace `blocks`/`nodes` targets an unknown bare field is `filter_invalid`. On the open-namespace `docs` target (and the `doc.<key>` reach-through), a bare key is normally free content — but a bare first segment that collides with an intrinsic **base name** (`id`, `path`, `repo`, `updated_at`, `content_hash`, `body`) is `filter_invalid` with a *"did you mean `$X`?"* hint, because it almost always is a typo for the intrinsic and would otherwise silently read an absent frontmatter key and match nothing. Force the property with the source-scoped `frontmatter.<k>` form. The exceptions are `title`/`tags` (see Computed intrinsics below): their `$`-forms are computed and do not shadow authored frontmatter, so bare `title`/`tags` stay property access.

### `docs`
- **Bare identifiers** = a document **property** key, resolved against the indexed `properties` table (12-properties-table). A bare key spans the **authored** sources — frontmatter and inline (dataview-style `key:: value`) — unioned. For **markdown** a bare key is usually a frontmatter key; **YAML/JSON** docs expose the parsed object's keys the same way. Nested maps flatten to dotted keys (`meta.owner`). Values may be scalar or list — `==`/`!=`/`<` compare the value only when the key is **single-valued in scope** (one scalar-authored value), `list()` is the multi-value accessor (§4); a scalar comparison against a list-authored key, a repeated key, or a bare key that collides across frontmatter and inline is false (use `list()`). A lone inline `key:: value` is scalar-comparable.
- **Source-scoped:** `frontmatter.<k>` / `inline.<k>` narrow a bare key to one authored source (e.g. `inline.owner == "alice"`).
- **Computed intrinsics:** `$title` (first H1 text), `$tags` (body `#hashtags`) — engine-derived, in the `$`-namespace. They do **not** shadow authored `title`/`tags`: `$title` is the H1, bare `title` is the frontmatter value.
- **Intrinsics:** `$id`, `$path`, `$repo`, `$updated_at` (ISO-8601 UTC string; compares lexicographically = chronologically), `$body`, `$content_hash`.
- **Link graph:** traversed via OQX `follow doc.out` / `follow doc.in` and inspected via the `edges` target — see §6.

### `blocks`
- **Bare fields:** `type` (block type enum), `text` (normalized text), `attrs.<key>` (typed attrs: `attrs.checked`, `attrs.lang`, `attrs.level`, …).
- **Intrinsics:** `$id`, `$doc` (containing doc id), `$path` (containing doc's path), `$locator`, `$ordinal`, `$depth`, `$updated_at` (timestamp of the last commit that touched this block, from `block_changes`).
- **Doc reach-through:** `doc.<key>` reads the containing document's metadata (`doc.layer == "canon"`); `doc.$path`, `doc.$updated_at`, `doc.format` reach the owning document's intrinsics/format (`$path` is the shortcut for `doc.$path`). Reach-through is **scope, not selection**: `doc.layer == "canon"` constrains which blocks are eligible; it does not copy the doc's metadata onto the block row. The engine resolves it as an indexed correlated subquery against the owning document (the `properties` table for authored keys), preserving normalization.
- **Structural functions:** §5.

### `nodes`
Nodes are the addressable structural/semantic units a format adapter projects from blocks (markdown tasks/links/headings, YAML mapping entries, …). A node query composes a node-grain predicate with owning-Block and owning-Doc predicates in one expression.
- **Bare fields:** `kind` (node kind, adapter-namespaced: `md:task`, `md:link`, `yaml:env_var`, …), `name`, `value`, `attrs.<key>` (node-specific typed attrs: `attrs.checked`, …).
- **Intrinsics:** `$id` (= `$node_id`), `$node_id`, `$doc_id`, `$block_id`, `$path` (owning doc's path).
- **Doc reach-through:** `doc.<key>` reads the owning document's metadata (`doc.layer == "canon"`); `doc.$path`, `doc.$updated_at`, `doc.format` reach its intrinsics/format — same scope-not-selection semantics as the blocks target above.
- **Block reach-through:** `block.type`, `block.text` read the source block the node was projected from.
- Structural functions (§5) are **not** available on `nodes` (they are block-tree operations); compose owning-block/doc predicates via `block.*` / `doc.*` instead.

### `edges`
The authored link graph (05-graph-and-query §1–2) as **first-class rows** — one row per open edge (`to_commit IS NULL`), for direct inspection/filtering the existence tests (`has_edge`, `$links`) cannot express. Inferred edges are excluded (they stay quarantined).
- **Bare fields:** `predicate` (`references`/`embeds` reserved, else freeform snake_case from the field/key), `provenance` (`link`/`frontmatter`/`inline_field`/`projected`/`yaml_*`/`json_*`), `dst_kind` (`document`/`external`/`collection` — v1 resolves block-anchor targets to `document`, preserving the `anchor`), `anchor`, `src_field`.
- **Intrinsics:** `$id` (edge id), `$src` (source doc id), `$dst` (raw target node id), `$dst_path` (the target **document's** path — `null` when the target is external or an unresolved/dangling internal link), `$dst_uri` (the **external** URL — `null` otherwise), `$src_block`, `$via`, `$from_commit`.
- **Source-document reach-through:** `$path` is the **source** document's path; `doc.<key>` / `doc.$path` read the source doc's metadata (the scan joins each edge to its `src_doc`). Same scope-not-selection semantics as blocks/nodes.
- **Relations:** a document's edges are reachable as `doc.out_edges` (outgoing) / `doc.in_edges` (incoming/backlinks) collections; a single block's outgoing edges (body links + inline fields, which carry a populated `src_block`) as `block.out_edges` — frontmatter edges are doc-grain (`src_block` NULL) and appear only under `doc.out_edges`. `text()`/`semantic()` are not available (edges carry no text/embedding). Dangling internal links are `dst_kind == "document"` rows with a `null` `$dst_path`.

## 3. CEL subset

### 3.1 Grammar (EBNF)

```
expr        = or ;
or          = and { "||" and } ;
and         = unary { "&&" unary } ;
unary       = [ "!" ] primary ;
primary     = comparison | membership | call | field | literal | "(" expr ")" ;
comparison  = operand relop operand ;
relop       = "==" | "!=" | "<" | "<=" | ">" | ">=" ;
membership  = literal "in" "list" "(" field ")" ;
call        = ident "(" [ args ] ")"                     (* free-standing *)
            | operand "." ident "(" [ args ] ")" ;       (* method form *)
field       = ident { "." ident } | "$" ident { "." ident } ;
literal     = string | int | double | "true" | "false" | "null" ;
string      = single- or double-quoted, backslash escapes ;
```

**Not supported (rejected with `filter_invalid`):** arithmetic (`+ - * /`), ternary, list/struct literals, `in` without `list()`, `now()` or any clock/random function (determinism is load-bearing — projected queries and `as_of` evaluation depend on it; callers supply literal timestamps).

### 3.2 Functions

| Function | Forms | Meaning |
|---|---|---|
| `contains` | `contains(x, "s")` / `x.contains("s")` | substring |
| `startsWith` / `endsWith` | method or free | prefix/suffix |
| `matches` | `x.matches("^re$")` | RE2 regular expression — **not wired.** The compiler rejects it with `filter_invalid` (`compile.ts` `compileMethod`: *"matches() requires post-filter (not yet wired); use contains/startsWith for indexed queries"*). Use `contains`/`startsWith`/`endsWith` instead. |
| `size` | `size(x)` | string length / list length |
| `has` | `has(field)` | field exists (the explicit absence test) |
| `list` | `list(field)` | scalar-or-list coercion, §4 |
| `.exists` / `.all` | `list(f).exists(v, pred)` | quantifiers over `list()` and graph collections |

### 3.3 Absence semantics (normative truth table)

mrplex's rule — *a missing key never matches; the predicate is false, not an error* — formalized:

| Expression | Field absent ⇒ |
|---|---|
| `f == v`, `f != v`, `f < v`, … (any comparison) | **false** (note: `!=` too — deliberately not classical negation) |
| `f` in boolean position (`f`, `f && …`) | coerces to **false** |
| `!f` in boolean position | **true** (negation of the coercion — so `!attrs.checked` matches tasks whose box is unchecked or attr-absent) |
| `"v" in list(f)` | false (`list(missing)` = `[]`) |
| `size(list(f))` | `0` |
| `f.contains(...)` and other string fns | false |
| `has(f)` | false — use this when you need existence itself |

Absence never errors and never propagates as an error. Type mismatches (comparing a string field to an int literal) behave as absence: false, not error. This table governs *genuinely unknown* keys — a bare `layer` where no such frontmatter key exists still silently yields false. The one exception is a bare key whose first segment collides with an intrinsic base name (`id`/`path`/`repo`/`updated_at`/`content_hash`/`body`; see §2): that is rejected at compile time with a hint, since a silent empty there is far more likely a typo for `$path` than a real absent-key query.

## 4. `list()` — scalar-or-list metadata (mrplex, verbatim)

A metadata key like `tags` may be scalar or list (in markdown, a frontmatter value written either way). `list(field)` coerces both shapes to a list (missing/null ⇒ `[]`) and is legal **only** inside `in`, `size(...)`, `.all`, `.exists`. A bare `list(tags) == "x"` is `filter_invalid`.

```
"pricing" in list(tags)
size(list(tags)) > 2
list(authors).exists(a, a == "alice")
```

## 5. Structural functions (`blocks` target only)

All compile to indexed SQL (§8). This list supersedes the sketch in 05 §4 (`parent()`, `ancestors()` as object-returning functions are dropped — join-shaped accessors are not worth their compiler; `under()` covers the real uses).

| Function | Meaning | Compiled against |
|---|---|---|
| `under(id_or_locator)` | block lies in the containment subtree of the target; when the target is a heading, in its **section range** | `ancestor_path` prefix / `sections` range |
| `under_heading(s)` | some ancestor section's heading text contains `s` (case-insensitive substring) | `sections` join |
| `within(target)` | containing doc matches: doc id, exact path, path glob, or collection id | `docs` / collection membership |
| `has_edge(pred [, target])` | an open authored edge with predicate `pred` originates from this block (optionally to `target` id/path) | `edges` |
| `has_anchor()` | block carries an authored `^ref` | `blocks` |
| `parent_type()` | the parent block's type, as a string (`parent_type() == "blockquote"`) | self-join |
| `child_count()` | number of direct children | aggregate |
| `under_kind(type [, name])` | some ancestor block has the given `type`, optionally with `name` matching its text (substring) or its `attrs.key` | `ancestor_path` join on `blocks` |
| `yaml_path("a.b.c")` | block is the YAML mapping entry at the dotted key path (`type LIKE 'yaml:%'`, matched by `attrs.key`; multi-segment paths walk `parent_block` upward) | `blocks` key-path chain |
| `json_pointer("#/a/b")` | block is the JSON node at the pointer (`type LIKE 'json:%'`; leading `#`/`/` stripped, segments split on `/`; multi-segment walks `parent_block`) | `blocks` key-path chain |

On the `docs` target, `has_edge(pred[, target])` is also available and means "any block or metadata edge from this doc" (in markdown, metadata edges come from frontmatter fields).

## 6. The link graph — `follow` and the `edges` target

The mrplex link-graph *predicates* — `$in`/`$has`/`$links()`/`$backlinks()`, their `_static`/`_dyn` variants, and `$degrees` — are **not implemented** in omgbase. They live only in mrplex's own doc-strings; omgbase's compiler has no case for them and rejects any such call with `filter_invalid` (`unknown function`). The link graph is worked in two OQX ways instead:

- **Traversal — OQX `follow`.** `doc.out` (documents this one links to) and `doc.in` (backlinks) are type-preserving `docs→docs` relations, so a query can recurse over them: `from docs where $path == "index.md" follow doc.out` walks the outgoing citation graph; `follow doc.in` walks backlinks. Each reached row carries walk metadata (`$depth` seeded at 1, categorical `$stop`, `$leaf`/`$frontier`, `$ordinal`); a follow-local `{ via <edge predicate> }` restricts the walk to matching edges. Defined in `packages/core/src/oqx/relations.ts` (`doc.out`/`doc.in`); see the `query` tool description and `corpus/oqx/README.md` for the full traversal surface.

- **Existence / correlation — nested queries.** A receiver-constrained nested query over `doc.in`/`doc.out` (or the `doc.out_edges`/`doc.in_edges` edge relations) expresses the old predicates as ordinary OQX: "some `moc/**` page links here" is `doc.in exists { where $path.startsWith("moc/") }`; "no outgoing links" (a leaf) is `doc.out_edges count { } == 0`; "no backlinks" (an orphan) is `doc.in_edges count { } == 0`.

- **Inspection — the `edges` target.** `from edges …` scans the authored link graph as first-class rows (§2 `edges`) for direct filtering the existence tests cannot express.

There is no projected-membership widening and no `_static`/`_dyn` distinction to preserve — omgbase never shipped those semantics.

## 7. `order by`, `select`, pagination

- **`order by`:** a comma-separated list of expressions, each optionally `asc`/`desc` (`order by $path, $ordinal`; `order by $updated_at desc`; `order by semantic("…") desc` for a score top-K). Orderable: intrinsics, bare scalar fields, `doc.<key>`, and score expressions. Default when absent: text/semantic rank when a `text(…)`/`semantic(…)` predicate is present, else `$updated_at` desc. Ties always break by `(path, id)` — a total order is required for stable cursors; a custom `order by` disables the keyset cursor (you still get the top `limit` with `truncated`).
- **`select` defaults:** docs ⇒ `$path`; blocks ⇒ `$id` + `$locator`; nodes ⇒ `id` + `path` + `kind` and any present `name`/`value`. `$semantic_score` and `$evidence` (RRF/boost breakdown, 05 §5) available when relevant. Bodies/text travel only when explicitly selected.
- **`cursor`:** opaque; valid for the same query only; results carry `truncated` + `cursor` per the API rules.

## 8. Compilation contract

- MUST compile to indexed SQL: comparisons and boolean combinations over metadata (JSON1 extraction on `docs.metadata`), `type`, `attrs.*`, all intrinsics; `startsWith` on `$path`; `under`/`under_heading`/`within`/`has_edge`; `text` (FTS5); `semantic` (vec).
- MAY post-filter over the SQL candidate set: `.exists`/`.all` bodies, `list()` membership on unindexed keys. (`matches` is the reserved post-filter case, but its post-filter path is **not yet wired** — it is rejected at compile time today; §3.2.) Post-filtering is bounded by `query.max_candidates` (default 10,000) — beyond it the query fails `filter_invalid` with hint "add an indexed predicate."
- Statement timeout `query.timeout_ms` (default 2,000).
- Evaluation is deterministic: same corpus revision + same query ⇒ same results and order (no clock functions; §3.1).
- Errors: `filter_invalid` with `data.reason` (what failed to parse/compile) and `data.hint` (what to consult). Stable codes, prose free to improve.

## 9. `include_projected` — never built

The `query` tool has no `include_projected` argument (nor a `resolution` argument); neither appears anywhere in the OQX code. The idea was: when projected queries ship, `include_projected: true` would let ref/copy projections become hits, while `false` kept base + novel derived facts. That widening was never implemented — there are no projected-query semantics to opt into today (see also §6). The rationale is retained in `09-projected-queries.md` §6 for whenever projected queries are designed; this document reserves the name only.

## 10. The fenced form (proposed; not as-built)

> **Not implemented.** The ```` ```omg ```` fenced projected-query form below is a `09-projected-queries.md` design sketch, not a shipped surface. It predates OQX and shows the old flat YAML envelope (`filter`/`order` keys); it does **not** describe the `query` tool, which takes an OQX string (§1). When/if the fence ships it is expected to carry an OQX expression, not this envelope. Kept for the projection-only keys it introduces.

The ```` ```omg ```` fence body was sketched as the envelope as YAML (one language everywhere; the fence is just another client), plus the projection-only keys from 09 (`project`, `reads`, `materialize`, `on_human_edit`, `backs`).

```markdown
​```omg
from: blocks
filter: type == "task" && !attrs.checked && under_heading("Launch")
order: ["$path", "$ordinal"]
limit: 200
project: list(ref)
```
```

## 11. Canonical examples

| Intent | OQX |
|---|---|
| Working-layer docs | `from docs where layer == "working"` |
| Guides, recently touched | `from docs where $path.startsWith("guides/") && $updated_at >= "2026-08-01"` |
| Docs tagged pricing (scalar or list) | `from docs where "pricing" in list(tags)` |
| Leaf docs (no outgoing links) | `from docs where doc.out_edges count { } == 0` |
| Orphans (no backlinks) | `from docs where doc.in_edges count { } == 0` |
| Everything a MOC references, minus one | `from docs where doc.in exists { where $path.startsWith("moc/") } && !doc.in exists { where $path == "moc/contractors.md" }` |
| Unchecked tasks under Launch in working docs | `from blocks where type == "task" && !attrs.checked && under_heading("Launch") && doc.layer == "working"` |
| Task nodes only from canon docs in one namespace | `from nodes where kind == "md:task" && !attrs.checked && doc.layer == "canon" && doc.$path.startsWith("canon/")` |
| Paragraphs citing a specific doc | `from blocks where type == "paragraph" && has_edge("references", "d_92aaaaa")` |
| Blocks about a concept (semantic top-K) | `from blocks order by semantic("identity preservation across edits") desc` |
| Code fences in TypeScript under Examples | `from blocks where type == "code_fence" && attrs.lang == "ts" && under_heading("Examples")` |
| Anchored blocks in one doc | `from blocks where within("projects/foo.md") && has_anchor()` |
| Every `depends_on` edge, both endpoints | `from edges where predicate == "depends_on" select $src, $dst_path` |
| External links (URLs) in the vault | `from edges where dst_kind == "external" select $dst_uri` |
| Dangling internal links | `from edges where dst_kind == "document" select $path, $dst` (dangling ⇒ `$dst_path` is null) |
| Edges authored in frontmatter (not body links) | `from edges where provenance == "frontmatter"` |
| Docs and everything they transitively cite | `from docs where $path == "index.md" follow doc.out` |

The brief's compound sketch — *paragraphs, traverse `references`, keep targets where `layer == "canon"`* — composes as a recursive OQX query: seed with a `where`, expand with `follow doc.out { via predicate == "references" }`, and constrain the reached rows with a post-walk `where layer == "canon"`. Traversal is a first-class OQX construct (`follow`), not a separate pipeline stage.
