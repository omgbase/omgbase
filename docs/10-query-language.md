# omgbase — Query Language Spec

**Status:** normative. This document defines the filter/query syntax completely; the sketches in `05-graph-and-query.md` §4 defer to it. Task 1.7 implements this spec.
**Compatibility:** on the `documents` target, omgbase is a superset of mrplex's documented query language (its `query_syntax` reference, 2026-09): same modes, same CEL subset, same absence rule, same `list()` polymorphism, same link-graph predicates including the `_static` variants. Deltas: the `blocks` target, structural functions, an `order` key, block-grain intrinsics, and the fenced-query form.

---

## 1. The query envelope

One envelope everywhere — the `query` tool, the `seed` stage of `pipeline`, and (as YAML) the ```` ```omg ```` fence:

```jsonc
{
  "from": "blocks",                  // "documents" | "blocks"; required
  "filter": "<CEL boolean>",         // optional
  "text": "term \"a phrase\"",       // optional; FTS
  "semantic": "natural language",    // optional; embeddings (semantic_unavailable if no hook)
  "select": ["$id", "$locator"],     // optional; projection fields
  "order": ["$path", "-$updated_at"],// optional; see §7
  "limit": 50, "cursor": null,       // pagination
  "resolution": "text",              // hydration tier for hits (06-mcp-api §1)
  "include_projected": false         // reserved; see §9
}
```

Modes **intersect** (AND). Only current state is searched (history via `history_node` / `as_of` traversal). Results are lean projected hits, never full documents — hydrate by id afterward (mrplex's projection-then-hydrate pattern, kept).

## 2. Targets and field namespaces

The sigil rule (mrplex, kept): anything kernel-owned carries `$`; bare identifiers are content territory, so user data can never collide with system fields.

### `documents`
- **Bare identifiers** = keys in the document's **metadata** — the structured property bag each format adapter produces (the `documents.metadata` column). What fills it is format-dependent: for **markdown** it is the parsed frontmatter (and, as adapters grow, may merge inline dataview-style fields and extracted intrinsics such as an h1-derived title); for **YAML/JSON** it is the parsed object the file represents; other adapters extract per their format. Nested maps with dots (`meta.owner`). "frontmatter key" is just the markdown reading of "metadata key."
- **Intrinsics:** `$id`, `$path`, `$repo`, `$updated_at` (ISO-8601 UTC string; compares lexicographically = chronologically), `$body`, `$content_hash`.
- **Link-graph predicates:** §6.

### `blocks`
- **Bare fields:** `type` (block type enum), `text` (normalized text), `attrs.<key>` (typed attrs: `attrs.checked`, `attrs.lang`, `attrs.level`, …).
- **Intrinsics:** `$id`, `$doc` (containing doc id), `$path` (containing doc's path), `$locator`, `$ordinal`, `$depth`, `$updated_at` (timestamp of the last commit that touched this block, from `block_changes`).
- **Doc reach-through:** `doc.<key>` reads the containing document's metadata (`doc.layer == "canon"`); `doc.$path` etc. mirror the intrinsics (`$path` is the shortcut).
- **Structural functions:** §5.

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
| `matches` | `x.matches("^re$")` | RE2 regular expression |
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

Absence never errors and never propagates as an error. Type mismatches (comparing a string field to an int literal) behave as absence: false, not error.

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
| `within(target)` | containing doc matches: doc id, exact path, path glob, or collection id | `documents` / collection membership |
| `has_edge(pred [, target])` | an open authored edge with predicate `pred` originates from this block (optionally to `target` id/path) | `edges` |
| `has_anchor()` | block carries an authored `^ref` | `blocks` |
| `parent_type()` | the parent block's type, as a string (`parent_type() == "blockquote"`) | self-join |
| `child_count()` | number of direct children | aggregate |

On the `documents` target, `has_edge(pred[, target])` is also available and means "any block or metadata edge from this doc" (in markdown, metadata edges come from frontmatter fields).

## 6. Link-graph predicates (`documents` target; mrplex-compatible)

- `$in(glob [, field])` — some doc matching the gitignore-style glob links TO this doc (optionally via that metadata field — a frontmatter field in markdown — or `"$body"`).
- `$has(glob [, field])` — this doc links to a target matching the glob (dangling targets count).
- `$links()` / `$backlinks()` — collections; usable only with `.size()`, `.exists(d, pred)`, `.all(d, pred)`; inside, `d.<key>` reads the other doc's metadata and `d.$path`/`d.$updated_at`/`d.$body` its intrinsics.
- **`_static` variants** (`$in_static`, `$has_static`, `$links_static()`, `$backlinks_static()`): authored links only, now and forever. The bare forms are identical in v1 and **transparently widen to include projected membership edges when projected queries ship** (ADR-011) — this carries forward mrplex's own reserved widening semantics, so queries written today keep meaning what they say. `_dyn` forms remain reserved and rejected.

`$degrees` exists only inside `graph_traverse`'s `node_filter` (visibility semantics, per 05 §3); in `query` it is `filter_invalid`.

## 7. `order`, `select`, pagination

- **`order`:** array of field references, `-` prefix for descending: `["$path", "$ordinal"]`, `["-$updated_at"]`. Orderable: intrinsics, bare scalar fields, `doc.<key>`. Default when absent: `$semantic_score` desc if semantic, else text rank, else `$updated_at` desc. Ties always break by `$id` ascending — total order is required for stable cursors.
- **`select` defaults:** documents ⇒ `["$path"]` (mrplex); blocks ⇒ `["$id", "$locator"]`. `$semantic_score` and `$evidence` (RRF/boost breakdown, 05 §5) available when relevant. Bodies/text travel only when selected or via `resolution`.
- **`cursor`:** opaque; valid for the same envelope only; results carry `truncated` + `cursor` per the API rules.

## 8. Compilation contract

- MUST compile to indexed SQL: comparisons and boolean combinations over metadata (JSON1 extraction on `documents.metadata`), `type`, `attrs.*`, all intrinsics; `startsWith` on `$path`; `under`/`under_heading`/`within`/`has_edge`; `text` (FTS5); `semantic` (vec).
- MAY post-filter over the SQL candidate set: `matches`, `.exists`/`.all` bodies, `list()` membership on unindexed keys. Post-filtering is bounded by `query.max_candidates` (default 10,000) — beyond it the query fails `filter_invalid` with hint "add an indexed predicate."
- Statement timeout `query.timeout_ms` (default 2,000).
- Evaluation is deterministic: same corpus revision + same envelope ⇒ same results and order (no clock functions; §3.1).
- Errors: `filter_invalid` with `data.reason` (what failed to parse/compile) and `data.hint` (what to consult). Stable codes, prose free to improve.

## 9. Reserved: `include_projected`

Accepted-but-inert in v1 (`false` only). When projected queries ship: `false` = base + novel derived facts via the bare graph predicates' widening (§6); `true` = ref/copy projections also become hits. See `09-projected-queries.md` §6 for the default rationale (hub pages must not double-count the corpus).

## 10. The fenced form

The ```` ```omg ```` fence body is this same envelope as YAML (one language everywhere; the fence is just another client), plus the projection-only keys from 09 (`project`, `reads`, `materialize`, `on_human_edit`, `backs`). `filter` — not `where` — is the key, matching the API.

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

| Intent | Envelope |
|---|---|
| Working-layer docs | `from: documents · filter: layer == "working"` |
| Guides, recently touched | `filter: $path.startsWith("guides/") && $updated_at >= "2026-08-01"` |
| Docs tagged pricing (scalar or list) | `filter: "pricing" in list(tags)` |
| Leaf docs (no outgoing links) | `filter: $links().size() == 0` |
| Orphans | `filter: !$in("**")` |
| Everything a MOC references, minus one | `filter: $in("moc/**") && !$in("moc/contractors.md")` |
| Unchecked tasks under Launch in working docs | `from: blocks · filter: type == "task" && !attrs.checked && under_heading("Launch") && doc.layer == "working"` |
| Paragraphs citing a specific doc | `from: blocks · filter: type == "paragraph" && has_edge("references", "d_92aaaaa")` |
| Blocks about a concept (semantic) | `from: blocks · semantic: "identity preservation across edits"` |
| Code fences in TypeScript under Examples | `from: blocks · filter: type == "code_fence" && attrs.lang == "ts" && under_heading("Examples")` |
| Anchored blocks in one doc | `from: blocks · filter: within("projects/foo.md") && has_anchor()` |

The brief's compound sketch — *paragraphs, traverse `references`, keep targets where `layer == "canon"`* — is deliberately **not** a filter: traversal composes in `pipeline` (`seed` these blocks → `expand` via `references` with `node_filter: "layer == 'canon'"`), keeping the filter language closed and compilable.
