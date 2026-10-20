# Changelog

All notable changes to `@omgbase/oqx-syntax` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).

## [0.8.0] - 2026-10-20

### Minor
- **Surface 5.0 / mutate 4.0 / sync 3.0 / search 3.0 / graph 2.0 / CLI 5.0 — "underscore = engine": on every record kind a BARE name is a user-authored entry and an UNDERSCORE-prefixed name is engine-provided, however derived.** The `_` prefix declares an engine field on a record; the bare namespace is the user's on every record — docs, blocks, nodes, links, revisions and the root row alike, because any record may carry user data later. `$` stays OQX's (`$it $key $depth $stop $leaf $frontier $ordinal`); omgbase adds no `$` names. Collections stay bare (`from docs`, `^docs`, `0^docs`, `docs count { … }`, `entries(^$it)` yields `docs blocks nodes links revisions`) — `from` names a collection, not a row property — and so do the row functions in call position (`text("x")`, `semantic(…)`, `under(…)`, `refs(x)`, …): a call is never an entry read. The self aliases are gone (`doc` on a document, `block` on a block, `section` on a node): `$it` is the self; a bare `doc` is now an authored key like any other. **Arguments and effect targets that address an engine field spell it with the underscore, and there is no tolerance**: a bare `id`/`path`/`ids` argument is an argument error whose message names the `_` spelling and whose `data.fix` is the corrected call. The Rust twin (`omgbase-surface`, `omgbase-mutate`, `omgbase-sync`, `omgbase-search`, `omgbase-graph`, the `omgbase` binary) follows in a separate round: until it lands the Rust spec runners and the cross-engine interop suite (`spec/surface` §7, `interop.json`) are red by design.

  **The language (spec/surface §1.2).** Row names, 4.11 → 5.0:

  | kind | engine names (attributes · handles · relations), 5.0 | bare names |
  | --- | --- | --- |
  | docs | `_id _path _raw _hash _updated_at _created_at _title _tags _format` · `_data _frontmatter _inline` · `_blocks _nodes _out_links _in_links _revisions` | every authored property (frontmatter + inline by the property rule): `title`, `tags`, `id`, `path`, `data`, `doc`, `format` included — nothing is reserved |
  | blocks | `_id _path _doc_id _raw _hash _updated_at _created_at _type _text _attrs _depth _ordinal` · `_doc` · `_children _nodes _out_links _section` | an `attrs` key (`checked`, `level`, `lang`; `_attrs.<k>` ≡ `<k>`) |
  | nodes | `_id _path _doc_id _block_id _kind _name _value _attrs` · `_doc _block` · `_blocks _subsections _children` | an `attrs` key (`checked`, `first_ordinal`, …) |
  | links | `_id _path _doc_id _block_id _via_id _dst_id _dst_path _uri _field _dst_kind _predicate _provenance _anchor` · `_doc _dst _block` · — | none (closed) |
  | revisions | `_id _path _rev _seq _doc_id _commit _ts _origin _actor _reason _hash _is_current _archived` · `_doc` · — | none (closed) |
  | root | `_id` (`^_id`, `0^_id`) · — · the five collections | — |

  `_data.<k>` ≡ `<k>` (the merged authored view; `entries(_data)`), `_frontmatter.<k>` / `_inline.<k>` one source each — and the one way to an authored key that itself begins with `_`. `_tags` = authored `tags` ∪ body `#hashtags`; bare `tags` = the authored key alone. `_title` = the computed title; bare `title` = the authored key. Inside `follow` `$depth`/`$ordinal`/`$stop` are OQX's; a block's own nesting is `_depth`, its sibling position `_ordinal`. The hit envelope is `{ _id, _path, …projection }` (`bare: true` drops it, as today); a row rendered as a value is `{ _id, _path }`; `select _id, _path` collapses onto the envelope and an alias `_id:`/`_path:` on anything else is refused. **Unknown names (§1.5)** are one tier: a bare name no object of the kind carries is a property read that yields absent — `hints` on a read ("no document in this repository carries a property `x`; did you mean `_title`?" — the nearest match drawn from the authored keys and the engine names, so a bare `title`/`id`/`path`/`tags`/`format` is pointed at its `_` spelling), a refusal in a write selector; a bare name on `links` or `revisions` (closed: no authored data reaches them) is `filter_invalid`; a `_x` that is no engine name of the kind is `filter_invalid` naming the kind's engine names (the closed set — the one place a loud error is right). The `data.<k>` suggestions and the engine-attribute confusion tiers are gone.

  **Migration — the language.**

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

  **Tool results (spec/surface §2–§4; spec/mutate §11, spec/sync §6, spec/search §1.3/§4, spec/graph).** Every result key that carries a row attribute is spelled as that attribute; a key naming a role keeps its name.

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

  **Tool arguments (spec/surface §4 "Arguments").** An argument that addresses a row attribute is spelled as the attribute: `docs_outline docs_read docs_append docs_move docs_delete docs_set_meta docs_update docs_diff docs_diff_unified docs_read_at docs_history` take `_id?` / `_path?` (at least one); `blocks_read blocks_update blocks_split blocks_append blocks_history nodes_block_read nodes_set` take `_id`; `blocks_read_many blocks_check` take `_ids`. Role arguments keep their names: `docs` (a list of refs), `blocks` (an op's operand list), `to`, `at`, `roots`, `select`, `expect`, `effects`, `plan`, `plan_id`, `reason`, `diffs`, `markdown`, `text`, `content`, `frontmatter`, `set`, `unset`, `section`, `checked`, `separator`, `prop`, `value`, `resolution`, `depth`, `limit`, `cursor`, `budget_tokens`, `include_ids`, `include_deleted`, `at` (a revision), `rev`, `from_rev`, `to_rev`, `path_glob`, `docs_tree.path` (a prefix), `docs_create.path` and `to_path` (where to create / move — no row carries the path yet), `observe*.path` / `files[].path` (a file event's path), `from_target`, `to_target`, `repairs`, `q`, `query`, `bare`, `origin`, `degrees`, `direction`, `predicate`, `max_documents`, `summary`, `repo`. **No tolerance**: `{ id }`, `{ path }`, `{ ids }` are `filter_invalid { hint: "arguments", fix }` — "`id` is not an argument — the document's id is `_id` (an engine field: the bare namespace is the user's)", the `fix` the same call respelled; `doc`/`block`/`node` keep their retired-name messages, now pointing at `_id`/`_path`.

  **Effects (spec/mutate 4.0, §11).** Targets `{ kind: "document", _id? | _path? }`, `{ kind: "block", _id }`, `{ kind: "node", _id }` (`{ kind: "section", heading_id }` and the bare forms — a path, a `b_`/`d_`/`n_` id, `$new.n` — are unchanged); fields `_frontmatter.<key>` (set/unset) and `_attrs.checked` (a block's checkbox) beside the role names `content` and `markdown`; a node's field stays its editor's property name (`value`, `name`, `checked`); `expect.content_hash` / `parent_children_hash` / `revision` are roles. A selector's `row` origin and a `-> ` expression's row ref are `{ _id, _path }`. The sugar builders, the fixtures and every `fix` follow.

  **CLI 5.0.** Every verb's `--json`/`--jsonl` carries the tool result verbatim, so the shapes above are the CLI's; the human hit table's envelope columns are `_id` and `_path`; the shell's row ref reads `_id` (label `_path`) and `.field` reads any projected key (`@1._id`, `@t[1]._path`); the `$id`/`id`/`$path`/`path` tolerance of `REF_KEYS` is gone. **Dataview** (`@omgbase/dataview`, major): `file.path` → `_path`, `file.mtime` → `_updated_at`, `file.tags`/`etags` → `_tags`, `file.size` → `size(_raw)`, `file.inlinks`/`outlinks` → `_in_links collect { from _doc }` / `_out_links collect { from _dst }`, `file.tasks`/`lists` → `_blocks collect { where _type == … }`, task `text` → `_text`, `blockId` → `_id`, the page through a task `_doc.<k>`; `checked` and every authored key stay bare. **`@omgbase/oqx-syntax`** lists the 5.0 host vocabulary (roots bare, engine names `_`-prefixed). `@omgbase/sync`'s coordinator reads `_id`/`_path`/`_hash` off a `changes_since` revision.

  **Specs.** `spec/surface` 5.0 (README §1.2 rewritten around the rule, §1.4, §1.5, §2–§4, the Decisions entry of 2026-10-20; every fixture respelled and regenerated — 579 cases, planned ≡ in-memory, no allowlist), `spec/mutate` 4.0, `spec/sync` 3.0, `spec/search` 3.0, `spec/graph` 2.0, `spec/cli` 5.0; `spec/store`, `spec/properties`, `spec/format`, `spec/reconcile`, `spec/oqx` untouched (their rows are not surface rows — the properties table's computed `$title`/`$tags` keys are stored keys, unchanged). `scripts/rename-engine-names.mjs` rewrites a 4.x query to the 5.0 spelling (span-exact, formatting kept) — the tool the fixtures were migrated with, and the one a 4.x user migrates saved queries with.

  **Decisions taken while applying the rule (not settled by the decision text; each follows "a key that carries a row attribute takes the prefix, a role keeps its name").** `blocks_read`'s nested `children` is the relation `_children`; `properties.computed` is `{ _title, _tags }` (the authored groups stay bare); `docs_history` versions are `revisions` rows (`_ts`, `_is_current` — not `updated_at`/`isCurrent`); `repos_status.id` is the root row's `_id`; the `omg links`/`show` rows (`docLinks`, CLI-only) are `{ _predicate, _doc_id, kind, count, samples? | _block_id }`; the effect `field` `attrs.checked` is `_attrs.checked` beside `_frontmatter.<key>` (a block's `markdown`, a document's `content`, a node's `value`/`name`/`checked` are the editor's own words); the internal `$new.n` object form is `{ kind: "symbol", _id }`; the yaml/json frontmatter refusal's data is `{ doc?, _path, _format, field }`; a document move's conflict focus names the field `_path`; `docs_create.path`, `to_path`, `docs_tree.path`, `observe*.path` and the `create` effect's `path` stay bare (no row carries the path yet — a destination is a role); bare names on `links`/`revisions` stay a loud `filter_invalid` (a closed row shape has no authored data to read, and 4.6's silent-column trap is what §1.5 exists for); the nearest-match rule is prefix-blind (`commited` → `_commit`, `titel` → `title` over `_title` by the shorter-candidate tie) with an exact-twin fast path (`id` → `_id`, `_layer` → `layer`). The lower-spec crates (`omgbase-surface`, `-mutate`, `-sync`, `-search`, `-graph`) are listed above ONLY because `pnpm release check` enforces spec tracking both ways (a spec that moved needs a note bumping its crate); their code is unchanged in this round — the Rust twin must land before the release is cut, and `crates/omgbase-surface/src/descriptions.rs` is regenerated then (`scripts/gen-tool-descriptions.mjs`). Not literally "every `plan_id` moves": a plan whose effects name no document target and no `_frontmatter`/`_attrs` field (a pure `insert` into a block) digests as before. **The Rust twin** (the follow-up commit on this branch) respells the six crates and the `omgbase` binary file by file after the TS; `omgbase-store` (patch — spec/store 16.0 is unchanged: the JSON its effect targets, inbound-link rows, plan preconditions and error data render — `{ kind, _id | _path }`, `{ _doc_id, _path, _block_id, _anchor, _field }`, `{ _id?, _path?, _format, field }` — moves to the `_` spelling) and the `omgbase` crate (minor: CLI 5.0 — hit table `_id  _path`, `REF_KEYS` without the `$id`/`id`/`$path`/`path` tolerance, every verb's `_id`/`_path` calls and reads, the help text) join the note's crate list for `release check`. One admission-order fix rides along in `omgbase-mutate`: `Plan::admit` now digests the plan's core AS GIVEN before the entry-level parse, as the reference's `admitPlan` does, so a plan edited after planning (a stray or misspelled key inside `preconditions.docs[]`) is `plan_mismatch`, not `filter_invalid`; and the store's `find_doc_by_ref` reads a path in either form, as the reference's `findDoc` does through `storagePath`.

## [0.7.0] - 2026-10-17

### Minor
- OQX 0.25 (`spec/oqx` 0.24 → 0.25): **`flatten`** — the last language gap for
  Dataview parity (`FLATTEN`), as useful as `group by`. `flatten <expr> [{ … }]
  [as <name>]` sits after `follow` and before `group by` in the fixed clause
  order (`select from where frontier follow flatten group by having order by
  limit offset`) and is the one clause that may repeat: each splits one value
  into rows — an array one row per element (an empty one yields none), an object
  one row, a missing field one row with the name absent (never dropped), a scalar
  one row — and every output row is the **parent row** with the name bound beside
  its fields at the same depth (`flatten tags` rebinds `tags`, `flatten tags as t`
  keeps the list). A written block is the ordinary receiver block over the
  elements, applied first; flattens chain and later clauses read the bound names;
  a flattened row's `$key` is the pair `[parent, element]`. New suite
  `spec/oqx/cases/flatten.json` (74 cases; 1547 fixtures); every `expect.ast`
  body gains `flatten: []`.

  - `@omgbase/oqx` 0.25.0 is bumped by hand with its CHANGELOG, per the
    standalone convention (`none` here so the release does not bump it again);
    the `oqx` crate follows by the Rust twin (`none` here), after which
    `omgbase-surface` and `omgbase` move their pin to `oqx = "0.25.0"`.
  - `@omgbase/oqx-syntax`: `LANGUAGE_VERSION` 0.25; `flatten` as a clause word,
    `as` as its name binder; both contextual; assets regenerated.
  - `@omgbase/core`: a flattened query yields the parent rows — the `id`/`path`
    envelope is injected as usual and repeats per element; paging is positional
    with a `null` cursor (the `group by` precedent: the keyset cannot land inside
    a document's elements); `flatten … as id` / `as path` is refused; the tier-3
    planner declines a flattened query whole; the unknown-names pass judges the
    expression on the rows and a block's names against the element kind, never
    the bound name; the write selector fans out per flattened row with
    `expect.max` over the flattened count (two `effects.json` fixtures); the
    `query_syntax` reference states the clause order and gains a `flatten`
    section; the alchemy corpus gains tags-per-process and open-tasks-per-document
    flattened queries; the conformance suite runs three flattened queries.
  - `omgbase` (npm): the `omg query` surface inherits the flattened result shape.
  - `omgbase-surface`: `reference.rs` twin regenerated byte for byte;
    `spec/surface/cases/examples.json` regenerated (the `query_syntax` text).
  - `omgbase-mutate`: `spec/mutate/cases/effects.json` gains the two selector
    fixtures (a Decisions line; no shape moved).
  - `omgbase` (crate): the Rust twin implements the language round from the
    report and the spec (open until it lands).

## [0.6.0] - 2026-10-15

### Minor
- OQX 0.24 (`spec/oqx` 0.23 → 0.24): **`group by` with aggregates** — the one
  language gap for Dataview parity, and the end of "a census needs a full-repo row
  dump". `group by <key>, …` and `having <pred>` sit after `follow` and before
  `order by` in the fixed clause order; the rows a body yields become one row per
  distinct key tuple (identities: absent ≡ null; first-appearance order); the
  body's select, `having` and `order by` then read the **group** — a key, an
  aggregate (`count()`, `count(e)`, `sum`, `avg`, `min`, `max`, `collect`,
  `first`, `last`, `any`, `all`, with `count(distinct e)` / `collect(distinct
  e)`), or `rows` (the group's rows, a value and a receiver: `rows count { where
  checked }`, `rows collect { select title }`) — and any other bare name is a
  parse error naming it. Value aggregates see present values only (`sum` of none
  is `0`, `avg`/`min`/`max`/`first`/`last` of none absent); `any`/`all` test
  truthiness. Without a `select` the projection is the keys plus `count`.
  `count { … }` is a value wherever a value stands. New suite
  `spec/oqx/cases/group-by.json` (94 cases; 1473 fixtures); every `expect.ast`
  fixture gains `groupBy: null` / `having: null` on its bodies.

  - `@omgbase/oqx` 0.24.0 is bumped by hand with its CHANGELOG, per the
    standalone convention (`none` here so the release does not bump it again);
    the `oqx` crate follows by the Rust twin (`none` here), after which
    `omgbase-surface` and `omgbase` move their pin to `oqx = "0.24.0"`.
  - `@omgbase/oqx-syntax`: `LANGUAGE_VERSION` 0.24; `group by`/`having` as
    clauses, the aggregates as builtin functions before `(`, `rows` as an
    intrinsic; `group`/`having` contextual; assets regenerated.
  - `@omgbase/core`: a grouped query yields groups, not store rows — the runner
    injects no `id`/`path` envelope (a hit is the projection as written, as
    `bare` yields; `bare` is accepted and changes nothing), pages by position
    with a null cursor, keeps `values`; the tier-3 planner declines a grouped
    query whole (decline (c) extended to the post-group clauses; SQL `GROUP BY`
    pushdown is a later round); the unknown-names pass judges keys and aggregate
    arguments on the rows and a `rows … { }` block's names on the grouped rows'
    kind (a `groupBy` step of `references`); the `query_syntax` reference states
    the new clause order and shows a grouped example; `spec-versions` oqx 0.24;
    the alchemy corpus gains a documents-per-layer census and a tasks-per-document
    checked/unchecked grouping; the conformance suite runs six grouped queries.
  - `omgbase` (npm): the `omg query` surface inherits the grouped result shape.
  - `omgbase-surface`: `reference.rs` twin updated byte for byte;
    `spec/surface/cases/examples.json` regenerated (the `query_syntax` text).
  - `omgbase` (crate): the Rust twin implements the language round from the
    report and the spec (open until it lands).

## [0.5.0] - 2026-10-13

### Minor
- OQX 0.22 (`spec/oqx` 0.21 → 0.22): **infix regex operators**, sugar over
  `matches` at comparison precedence — `a ~ b` ≡ `a.matches(b)`, `a ~* b` ≡
  `a.matches(b, "i")`, `a !~ b` ≡ `!a.matches(b)`, `a !~* b` ≡ `!a.matches(b,
  "i")` (the PostgreSQL spellings; `uri ~ "newton"` is no longer `unexpected
  character "~"`). Same unanchored search, same regex baseline, same string forms,
  same absent rule (an absent receiver is false under `~`, hence **true** under
  `!~` — OQX's absent, not SQL's NULL); non-associative; `!`/`not` bind tighter
  (`not a ~ b` is `(!a) ~ b`). The AST keeps the operator as written (`binary.op`
  `"~"` `"~*"` `"!~"` `"!~*"`), so `print` round-trips it. New suite
  `spec/oqx/cases/regex-operators.json` (40 cases; 1350 fixtures).

  - `@omgbase/oqx` 0.22.0 and the `oqx` crate 0.22.0 are bumped by hand with
    their CHANGELOGs, per the standalone convention (`none` here so the release
    does not bump them again); `omgbase-surface` and `omgbase` move their pin to
    `oqx = "0.22.0"`.
  - `@omgbase/oqx-syntax`: `LANGUAGE_VERSION` 0.22; `OPERATORS.regex` (`!~*` `!~`
    `~*` `~`) highlighted as operators in every grammar (TextMate, Monarch,
    CodeMirror, Prism); `~` left `ILLEGAL_CHARACTERS`; assets regenerated.
  - `@omgbase/core`: the `query_syntax` reference names the infix spellings under
    `strings`; the tier-3 planner treats a regex operator as it treats a
    `matches` call (never pushed, may raise, so the pushdown declines).
  - `omgbase-surface`: `reference.rs` twin updated byte for byte; `translate.rs`
    leaves the four operators residual; `planner.rs` counts them as may-raise.
    `spec/surface/cases/examples.json` regenerated (the `query_syntax` text).

### Patch
- History is queryable (spec/surface 4.7). A `revisions` target in OQX — one row
  per stored revision of every document of the repository, deleted documents
  included: `id`/`rev`, `path` (as of the revision), `seq`, `doc_id`, `commit`,
  `ts`, `origin`, `actor`, `reason`, `hash`, `is_current`, with `doc` reaching the
  document's current row (absent for a deleted one) and `revisions` a relation of
  every document (`from docs where revisions count { where origin == "api" } > 0`);
  `^revisions` from a row, `entries(^$it)` names five collections. `docs_read`
  takes `at: <rev>` — the document as of that revision (`raw` reconstructed,
  `path` as of the revision, `renderedHashMatch`; no `properties`, `include_ids`
  refused) — and `docs_read_at` is now its sugar with the identical result (the
  current property bag flagged `propertiesAreCurrent` is gone from it). The
  minimal tools profile reaches history through `query` and `docs_read` alone;
  `docs_history`/`docs_read_at`/`docs_diff_unified` stay as sugar.

  The unknown-names pass (§1.5) knows the kind: `revisions` is a closed row shape
  (`` `commited` is not a field of revisions (fields: id, path, rev, seq, doc_id,
  commit, ts, origin, actor, reason, hash, is_current); did you mean `commit`? ``),
  `revisions` is a relation of docs and `doc` a handle of a revision row; a write
  selector over `revisions` is refused like one over `links` (`spec/mutate` §11.8,
  `select-revisions-refused`). `@omgbase/oqx-syntax` lists the fifth root.
- **Unknown names** (`spec/surface` 4.5 → 4.6, §1.5; `spec/oqx` 0.22 → 0.23,
  AST.md §5b). A query that read a name no row of its kind can carry — `select
  path, target from links` (links have `dst_path`), `select type, value from
  blocks`, `where preview != ""` — used to run silently, returning absent columns
  or matching every row. Now every name a query reads is judged **statically**,
  before any row is read, against the vocabulary of the row kind it is read from:
  tier 1, an engine attribute, handle or relation; tier 2, an authored property at
  least one live object of the kind in the repository carries (a frontmatter or
  inline key on docs — `stage` on three processes is enough; an `attrs` key on
  blocks and nodes); tier 3, a name no object carries — the complaint. On `links`
  (a closed row shape) a tier-3 name is `filter_invalid` listing the fields with
  a nearest match (`` `dst_pth` is not a field of links (fields: id, path, …); did
  you mean `dst_path`? ``); on docs, blocks and nodes a read returns its rows and
  gains **`hints: [string…]`**, the last member of the `query` result, one line per
  name in first-reference order (`` `titel` is not a field of docs and no document
  in this repository carries a property by that name; did you mean `title`? ``;
  under a source handle: `` no document in this repository carries a property
  `path` (`data.path`) ``), absent when there is nothing to say; a **write
  selector** (`plan`/`apply`/`execute` with `select`) is refused through the
  runner's AST entry (`unknownNames: "refuse"`, its default; the source entry
  every read uses hints), since `where target != "x"` would select every row. The
  verdict never depends on the query's filter; a repository with no object of a
  kind skips the check for that kind. The refusal wears the admission's `select: ` prefix and `hint: "selection"`
  (`spec/mutate` §11.8, fixture `select-unknown-name-refused`). The nearest match
  is case-insensitive Damerau–Levenshtein ≤ 2 or a substring of ≥ 3 characters; one
  typo wins first, then a substring outranks a distance-2 match (`via` →
  `via_id`, not `id`), then the lowest distance; a name under three characters gets no suggestion (`x`, `in`). The vocabulary is cached per repository on its head
  commit.

  - `@omgbase/oqx` 0.23.0 (hand-bumped with its CHANGELOG, per the standalone
    convention — `none` here): the **`references(query)`** static pass — every name
    a query reads from a row, with its clause and the row chain of its scope, for
    a host to judge against its data model; new fixture kind `expect.references`
    and suite `spec/oqx/cases/references.json` (29). The `oqx` crate's twin
    follows (`none` here; hand-bumped to 0.23.0 by the Rust change).
  - `@omgbase/oqx-syntax`: `LANGUAGE_VERSION` 0.23 (no lexical change).
  - `@omgbase/core`: `oqx-js/names.ts` (the vocabulary, the kind of a scope, the
    judgement, the messages, the nearest match), `oqxRun`/`oqxRunQuery` with
    `OqxOptions.unknownNames` and `OqxResult.hints`; `query_syntax` names the
    rule; `spec-versions.ts` surface 4.6.
  - `omgbase` (CLI): `omg query` prints each hint as a dim `  hint: …` line on
    stderr after its rows (`--json` carries the member); four `spec/cli` cases.
  - `oqx` (crate) 0.23.0 (hand-bumped, `none` here): `references::references(&Query)`
    over borrowed nodes (`Reference`, `ReferenceScope`, `ReferenceStep`, `StepExpr`);
    to carry those borrows `walk::Visitor` gains the tree's lifetime — `Visitor<'a>`,
    an implementor that keeps nothing writes `impl Visitor<'_> for V` (pre-1.0 minor).
    `omgbase-surface`: `names` (the judgement, `VocabularyCache` held by the `Surface`
    and passed through `QueryOptions.vocabulary`; `QueryOptions.unknown_names`,
    `OqxResult.hints`), the selector's `select: ` refusal in `select::expand`.
  - `omgbase-surface` / `omgbase` (crates): `reference.rs` synced byte for byte;
    the Rust judgement, `hints` and the `references` twin are the Rust change
    that follows this one (the new `query-unknown.json` and `references.json`
    suites wait on it).

## [0.4.0] - 2026-10-13

### Minor
- OQX 0.21: template literals. A backtick string with `${expr}` interpolations — `` `${title} (${era})` `` — is a primary expression whose value is the concatenation of its text and each interpolation's string form (the `+` rule): an absent interpolation makes the whole literal absent, a list, record or range is an evaluation error (`cannot interpolate …`), every interpolation is evaluated before the result is decided. Text decodes with the same escapes as a string literal (`` \` `` a backtick, `\$` a dollar that does not open an interpolation, `\\` a backslash), newlines are kept verbatim, an interpolation holds one full expression including nested literals and `{ … }` blocks. The canonical printer round-trips the form. Fifty fixtures in `spec/oqx/cases/template-literals.json`; the syntax package highlights the new token in every target grammar. Templates are never pushed down to SQL. Groundwork for the `-> expr` sugar in effect templates, where a string such as `-> `## ${title}`` reads the hit's row. (`@omgbase/oqx` and the `oqx` crate are bumped to 0.21.0 by hand with their own CHANGELOG entries, per the standalone-package convention, so this note records them as `none`.)

### Notes
- Regenerated `vscode/package.json` (its `version` is generated from the package's and had stayed at 0.2.5 after the 0.3.0 release, failing `test/assets.test.ts`'s "is current" check). No behaviour change.

## [0.3.0] - 2026-10-11

### Minor
- OQX 0.20 (`spec/oqx` 0.19 → 0.20; 1188 → 1258 fixtures, three new suites `tuples`, `identity`, `cardinality`):

  - **`follow` loses its options block.** A brace after *any* destination opens that destination's block (`follow children { depth 2 }`, `follow a, children { id != "root" }`, `follow entries(kids) { where … }`), with the 0.17 body rules. Two clauses belong to a destination block alone, after `where` in the fixed order: `depth <1..8>` (this destination expands a frontier row only while its `$depth < n`) and `frontier <expr>` (an occurrence reached through this destination for which it holds is a frontier; read with `^` the walk's enclosing scope; seeds are never frontiers). The former `where` option is the block's `where`; `by` is gone. When several destinations reach a row in one step the first governs the occurrence. **The body that carries the `follow` may carry `frontier <expr>` too** (Brendan, 2026-10-11): it applies to the SEEDS — a seed for which it holds (read in the seed's own scope, `^` the enclosing scope, like `where`) is `$stop == "frontier"` and is not expanded, while it stays in the result — so every block that feeds rows into the walk says which of its rows are frontiers, and the frontier relevant to the current `$it` is defined separately from each destination's. The clause order of every body is `select from where frontier follow order by limit offset` (a destination block's adds `depth` after `frontier`); a body-level `frontier` without a `follow` is the parse error `` `frontier` needs a `follow` ``, a body-level `depth` an error naming the destination block; inside a destination block `frontier` is always the destination's. AST: `follow` keeps only `destinations`/`distinct`; `subquery` gains `frontier`/`depth`, `query` gains `frontier`; `print` writes `follow x collect { where … depth 2 }` and a body's `frontier` between `where` and `follow`.
  - **Tuples.** `(e1, e2, …)` with two or more elements is a value and a receiver: the elements concatenated with one level of flattening (a collection contributes its items, a row itself; an absent element nothing, a `null` is kept; duplicates kept). `size((a, b))`, `"x" in (tags, aliases)`, `(mom, dad, siblings) { name values }`, `follow (before, after) { depth 2 }` (one destination over the union). New AST node `tuple { items }`.
  - **Identity is `$key`.** One meaning — the key a row is known by — for `follow` cycle detection, the per-step union, `follow distinct`, `distinct` over unprojected rows, `is`, and reading `$key` on any row. The default is the host's identity through a new `DataContext` seam (TS: optional `identityOf(row)`, replacing the required `identity`, which stays as a deprecated alias for one minor; Rust: `identity` now has a structural default), else the row's structural value; an entry's identity is its key. The language never names an `id` property: the "`id` if present" rule is removed, and the in-memory `DefaultContext` names no identity. A block may project `$key: <expr>` to give the rows it yields that identity (`select name, $key: email from people follow next { $key: email }`); in a destination block `$key:` is not a column. Caveat: identities compare as values across the whole walk, so destinations that can reach the same rows should project the same `$key`.
  - **Result shape by receiver cardinality.** In row position an array is a collection and a non-array object is one row: a `collect` over it — `doc { title }`, `title from doc`, a nested `d: dst { title }` — yields the one record (or absent when filtered out; `doc { status == "active" }` is a conditional reach-through), not a one-element list; `values` the one value; `first`/`single` that object. A scalar in row position is an eval error (`` `s` is a string ("abc"), not a collection or an object ``) instead of a one-row collection — `list(s)` says it explicitly. A `from` re-projection or a `follow` makes the result plural. Hosts say which of their objects are collections through the new optional `DataContext.isSingle` (TS; default: a non-iterable object is one row) / `is_single` (Rust; default `true`). TS `OqxResult` for `collect` gains `single: boolean` (`unwrap` yields the record or `null`); Rust gains `OqxResult::Record(Option<Value>)`.
  - **Sugar closures.** `x { … }` ≡ `x collect { … }` wherever a value is accepted, function arguments included (`size(children { is checked })`); `x distinct { … }` ≡ `x collect distinct { … }`.

  omgbase binding (surface stays 3.0; the dialect follows the language):

  - `DataContext.identityOf` (TS) / `identity` (Rust) answers a store row's id for every kind (`doc_id`, `block_id`, `node_id`, `edge_id`), so `$key` on any hit is its id and walks dedup by it as before; the binding no longer relies on the removed `id`-property rule.
  - The statically single relations `doc`, `block` and `dst` hand out an absent-single marker when they have no row, so `dst { title }` on a link row is one record and, on an external or dangling link, absent — not `[]`; as a value the marker is absent (`dst == null`, `has(dst)`, `dst.title` unchanged). The Rust context's `is_single` marks the lazy root scans as collections.
  - The `graph` tool compiles to `follow distinct <dir>_links collect { from <dst|doc> depth <n> }`; `query_syntax`, the `query` tool description, both help cards, `docs/query-language.md`, `docs/graph-and-query.md`, `docs/mcp-api.md` and the OQX tutorial describe the 0.20 forms (body-level `frontier` included); the planners treat a destination block's `frontier`/`depth` as its own, never push a tuple down, and a body with `frontier` plans like one with a `follow` — in memory (pinned on both sides). `spec/surface` `query-follow::body-frontier-keeps-seeds-unexpanded` walks the processes with the unverified one kept but not expanded.
  - `spec/surface` fixtures using the old options block are rewritten to the destination-block forms (`… collect { from dst depth 2 }`; `by type` → `{ $key: type from dst }`) and regenerated; `spec/cli` and `interop.json` regenerated with them.
  - `@omgbase/oqx-syntax`: `LANGUAGE_VERSION` 0.20; `FOLLOW_OPTIONS` → `DESTINATION_CLAUSES` (`frontier`, `depth`; `by` is no longer a word of the language), assets regenerated.

### Patch
- **Surface 3.0 / CLI 3.0 — one name for every value: engine attributes are bare and win on collision, `$` belongs to OQX, user data that collides is reached through a handle, and every tool result spells a row the way the language does.** The rule (`spec/surface` §1.2, normative): `$it $key $depth $stop $leaf $frontier $ordinal` are values the LANGUAGE injects into a scope and omgbase adds **no `$` names** — a `$id` or `$path` in a query is now an unknown OQX identifier (absent). Every engine attribute is a bare snake_case name that **wins on collision**, the convention the relations (`children`, `blocks`, `out_links`, `doc`, `frontmatter`) always followed: docs `id path raw hash updated_at title tags format`, blocks `id path raw hash updated_at doc_id type text attrs depth ordinal`, nodes `id path doc_id block_id kind name value attrs`, links `id path doc_id block_id via_id dst_id dst_path uri field dst_kind predicate provenance anchor`, the root row `^id` (the repository). User data is bare too; where an authored key collides with an engine name it is reached through a **source handle** — `data` (NEW: the merged authored view, frontmatter + inline by the property rule, exactly the read a bare non-colliding key performs), `frontmatter`, `inline` — so `data.path` is the author's `path:` key, `data.tags` the authored list, `data.title` the authored title, and `entries(data)` lists every authored top-level key (frontmatter ∪ inline, key order). The loud-error set is **gone**: a bare `id`/`path`/`updated_at`/`hash`/`raw` is simply the attribute (2.x refused it with "did you mean `$path`?"). `title` is the computed title (the first H1, `spec/properties` §3.3); **`tags` is the union of the authored tags and the body `#hashtags`** (deduped, authored first, then hashtags in document order; null when both are absent) — the stored computed `$tags` row is unchanged, the surface changes the attribute, so `spec/properties` did not move. Handle reads **push down**: `data.<k>` is the bare property's SQL, `frontmatter.<k>`/`inline.<k>` the same single-scalar-row subquery scoped by `p.source` (before, every handle member fell back to in-memory evaluation while the bare key was pushed); `entries(<handle>)` and a whole-handle reference stay residual. Contextual words (`limit order offset follow collect count first distinct desc by in`) parse as fields in expression position; `select from where is not and or true false null` never do.

  **Results — same value, same name, everywhere.** A query hit is `{ id, path, …projection }` (the 2.x spelling) and a row surfacing as a value `{ id, path }`; **a projection may not overwrite the envelope** — `select id, path` is simply the envelope (no duplicate columns), and any other projection whose output key would be `id` or `path` (`select data.path`, `select path: doc.layer`) is `filter_invalid` "projection `path` collides with the hit envelope — alias it (`p: data.path`)" (`values` mode has no envelope and is exempt). Every tool result that renders a document, block, node or edge row names it the same way (`spec/surface` §2–§4): `docs_read`/`docs_read_at`/`docs_read_many.items[]` `{ id, path, rev, properties, raw, ids?, hashes?, parents? }` with `properties.computed` keyed `title`/`tags`; `blocks_read`/`blocks_read_many` `{ id, type, text, raw, hash, attrs, label, ordinal, depth, parent_id, children }`; `graph.documents[]`/`frontier[]` `{ id, path, degree, frontier, …select }` (an `id`/`path` selection collapses onto the envelope, any other bare name is its own column, an expression is `sel_<i>`), `graph.links[]` `{ id, doc_id, block_id, via_id, dst_id, dst_path, uri, dst_kind, predicate, provenance, anchor, field }`; `blocks_search.hits[]` `{ id, doc_id, path, type, text, score }`; `blocks_resolve[]` `{ id, locator, preview, evidence }`; `docs_list.items[]` and `docs_tree` doc entries `{ id, path, updated_at, blocks }` (dir entries `{ path, kind, docs, blocks, updated_at }`); every `revisions[]` (`apply`, the mutating tools, `changes_since` digests) `{ id, path, hash }`; `docs_history` `{ id, path, deleted, currentRev, versions: [{ rev, seq, commit, updated_at, origin, actor, hash, isCurrent }] }`; `docs_create`/`docs_move`/`docs_delete`/`docs_set_meta`/`observe`/`observe_many[]`/`observe_delete` `{ id, path, … }`; `docs_move.dangling[]` and `links_stale.stale[]` as link rows `{ doc_id, path, block_id, … }` (`links_stale.summary.bySource[].path`); `docs_diff[]` `{ kind, id, before?, after? }`; `docs_diff_unified` `{ id, path, from, to, diff }`; `links_retarget`/`links_repair` `hits[]` `{ id, path, oldRaw, newRaw }`; `blocks_update` `{ id, ids, … }`; `docs_update` opset `target: { id, path }`, `precondition: { id, path, baseRevision, hash }`; `repos_status` `{ id, slug, … }`; error data `stale_expectation.current { hash, markdown }`, `stale_plan.current { revision, hash }`, `ambiguous_heading.candidates[{ id, doc_id }]`. Role keys keep their names (`rev`, `from`/`to`, `before`/`after`, `locator`, `baseRevision`, `cursor`, `expected_content_hash`). Unchanged: `blocks_history[]`, `results[].ids/removed/mergedInto`, `graph.roots[]`, `blocks_read_many.unresolved[]`, `docs_read_many.errors[].ref`, `retargeted{}`, the `diffs{}` keys, every cursor (the keyset carries values, so a 2.x cursor stays valid), `version`, `repos`, `sync_status`, and `spec/store`'s own observe outcome `{ doc, commit, rev }`.

  **Language renames from 2.x (both engines, byte-identical):** `$id`→`id`, `$path`→`path`, `$updated_at`→`updated_at`, `$title`→`title` (computed; `data.title` for the authored key), `$tags`→`tags` (now authored ∪ hashtags; `data.tags` for the authored list), `^$id`→`^id`; `$body` → `raw` (a block's `raw` is its raw source bytes, not its text — `text` stays a field), `$content_hash` → `hash`; blocks `$doc` → `doc_id`, `$ordinal`/`$depth` → `ordinal`/`depth` (they collided with the `follow` recursion intrinsics; inside a `follow` `$depth` is always the walk's); nodes `$doc_id`/`$block_id` → `doc_id`/`block_id`, the `$node_id` synonym dropped; links (the `edges` target, renamed below) `$src` → `doc_id`, `$src_block` → `block_id`, `$via` → `via_id`, `$dst` → `dst_id`, `$dst_path` → `dst_path`, `$dst_uri` → `uri`, `src_field` → `field`, `$from_commit` removed (a query sees open links only; the commit is history). **Foreign-key elimination** in both planners: `doc.id`/`doc.path` on a block, node or link and `block.id`/`block.path`/`block.doc_id` on a node read the row's own FK column (or the scan's joined column) with no owner lookup — in SQL `b.doc_id`/`e.src_doc`/`n.block_id` — so `doc.id` and `doc_id` cost the same statement. The `query_syntax` text, both attribute switches and both translators carry the rule as a comment.

  **Arguments (`spec/surface` §4 "Arguments", normative) and the catalog:** a tool's prefix names the row kind it addresses and `id` / `path` in its arguments are that kind's attributes — every `docs_*` tool that took `doc` (id-or-path) and/or `path` takes `id?` / `path?` (at least one; both must name the same document, else `filter_invalid` "id "…" and path "…" name different documents"); `blocks_update.block`, `blocks_split.block`, `node_set.node` → `id`; list and role arguments keep their names (`ids`, `docs`, `roots`, `to`, `blocks`, `at`, `docs_tree.path`, `*.path_glob`, `docs_create.path`, the `observe*` file paths); no tool refers to a document of another kind (the name pass below made `diff`/`diff_unified` `docs_*` tools); the kernel-op grammar (`apply.ops[].block/blocks/to/at/expect`) is spec/mutate's and is unchanged; the bare argument name `doc` no longer exists. Every call is shape-checked ahead of its handler, in both engines alike: an unknown name gets the nearest valid one ("unknown argument `q`; did you mean `query`?"; the retired names name their replacement — "`doc` is no longer an argument — pass `id` or `path`", `block`/`node` → `id`, `heading` → `section`, `markdown` → `text`), a missing one "`query` is required", a mistyped one "`limit` must be an integer", each followed by the tool's shape; `data: { reason, hint: "arguments" }`. Errors spell the attribute: `doc_missing` "no document with id or path "<value>"", `block_missing` "no block with id "…"", a node "no node with id …"; a `docs_*` call with neither locator is `filter_invalid` "pass id or path". **Fossil renames** (blocks used to be called nodes in the read tools): `nodes_get { doc?, path?, id, resolution? }` → `blocks_read { id, resolution? }`, `nodes_get_many { doc?, path?, ids, … }` → `blocks_read_many { ids, … }` (the document scope arguments are dropped — a block id is global), `history_node { id, limit? }` → `blocks_history { id, limit? }`. **The append fold:** `sections_append` is removed — `docs_append { id? | path?, text, section?, dry_run? }` appends at the document's end or, with `section` (a heading's TEXT, resolved inside the named document; none → `parent_missing`, several → `ambiguous_heading` with `candidates[{ id, doc_id }]`), at the end of that section; the new `blocks_append { id, text, dry_run? }` appends INTO a block by what it is — a heading → the end of its section, a container → the end of its children, a leaf → `block_not_container` (`data: { id, type }`). `omg append <block>` renders `blocks_append`. **Loud `semantic()`:** `semantic_unavailable` is `provider_unavailable` at the surface and in `omg query`/`run`; a configured provider whose model has embedded nothing in the repository is `provider_unavailable` too (`data: { provider, model }`) instead of path-ordered rows with no score. **Description parity:** `spec/surface/tool-descriptions.json` is the one source of the 45 tool descriptions; `scripts/gen-tool-descriptions.mjs` generates `crates/omgbase-surface/src/descriptions.rs` from it and both spec runners pin it.

  **The tool-name pass (`spec/surface` §4 "Names and arguments", normative; §9 Decisions).** A tool's prefix names the row kind it addresses — `docs_`, `blocks_`, `nodes_`, `links_` — and `id`/`path` in its arguments are that kind's attributes; the repo-level operations carry no prefix (`query`, `query_syntax`, `graph`, `changes_since`, `apply`, `observe*`, `repos*`, `sync_status`, `version`); one verb returns the row: **`read`**. **The row kind `edges` is `links`** at the surface: `from links` (`from edges` is refused, naming the new spelling — and any other unknown top-level source is now a loud error instead of an empty result), the doc and block relations `out_links`/`in_links`, the root collection `^links`, `entries(^$it)` → `docs blocks nodes links`, the `graph` result's `links[]`; the attributes on the kind are unchanged, and the `md:link` NODE (a link's occurrence in the text, `via_id` points at it) is kept apart from the `links` ROW (the relation; a frontmatter link has a row and no node). The storage table and `spec/graph`/`spec/store` still say `edges` (`omg rebuild-index --edges` names the table). **Renamed tools** (46 → 44): `diff` → `docs_diff { id?, path?, from_rev, to_rev }`, `diff_unified` → `docs_diff_unified { id?, path?, from_rev?, to_rev? }` (the `doc_id`/`doc_path` foreign keys of batch 2 are gone — a diff is a document operation), `blocks_get` → `blocks_read` (its `id` is a BLOCK id — an `n_` node id is `block_missing` naming `nodes_block_read`, below), `blocks_get_many` → `blocks_read_many`, `docs_get_many` → `docs_read_many`, `node_set` → `nodes_set`, `text_search` → `blocks_search`, `resolve` → `blocks_resolve`, `tasks_complete { blocks }` → `blocks_check { ids }`. **Removed**: `read_ref` (ids carry their kind and a path is a document — call `docs_read { id | path }`, `blocks_read { id }` or, for an `n_` id, `nodes_block_read { id }`; `omg cat`/`show` dispatch client-side on the ref's shape, `show --json` still prints `{ kind: "document", ...docs_read }`) and `docs_plan_update` (`docs_update { dry_run: true }` is the plan-only call, `{ opset, plan, result: null }`). The final catalog (45 tools), in registration order: `docs_outline docs_read docs_read_many blocks_read nodes_block_read blocks_read_many docs_tree docs_list query_syntax query graph blocks_search blocks_resolve apply blocks_insert blocks_update blocks_move blocks_remove blocks_split blocks_merge blocks_check nodes_set blocks_append docs_append links_retarget links_stale links_repair docs_create docs_move docs_delete docs_set_meta docs_update observe observe_many observe_delete blocks_history docs_diff docs_diff_unified docs_read_at docs_history changes_since repos_status sync_status repos version`. The `query_syntax` text, both CLIs' help cards and verb→tool mappings (`cat`/`show`/`diff`/`find`/`done`/`node set`/`update --dry-run`), `@omgbase/oqx-syntax`'s host vocabulary (`links`, `out_links`, `in_links`), the docs, the OQX tutorial and both demos (which switch the names by the server's surface version) follow; `spec/surface/cases/query-edges.json` is `query-links.json`.

  **CLI 3.0:** every verb's `--json`/`--jsonl` carries the tool result verbatim, so the shapes above are the CLI's; `ls --ids` prints the ids (was the paths), `find -1`/`--ids` read `id`; the shell's row ref for `ls` is the `id` (label `path`), for `links` the far node's `doc_id`; the `show` card's link section is labelled `out links` (`links` out/in rows `{ predicate, doc_id, kind, count, samples? | block_id }`); `.field` reads any projected key. Human renderings are unchanged.

  **Lower specs that own a renamed shape take a major:** `spec/search` 2.0 (`text_search`/`resolve` hits — the layer's operation names; the tools are `blocks_search`/`blocks_resolve`), `spec/mutate` 2.0 (`revisions: [{ id, path, hash }]`, the opset `target`/`precondition`, `stale_expectation`/`stale_plan` `current.hash`), `spec/sync` 2.0 (the change-feed revision `{ id, path, hash }`; `@omgbase/sync` and `omgbase-sync`'s `McpEngineClient` read the new keys). `spec/store`, `spec/graph` and `spec/properties` are unchanged (the graph fixtures pin the `edges` table — `src_field` stays the column; the properties table keeps its computed `$title`/`$tags` rows, re-keyed only at the surface). `omgbase-store` is patched for the shapes it renders for the mutate and search layers. `@omgbase/oqx-syntax`'s omgbase host vocabulary lists the roots (`docs blocks nodes links`), the relations and the bare attributes per kind (for completion providers; its `$`-highlighting is OQX's own `$it`/`$key`/… only).

  **The follow-up to the name pass (`spec/surface` §1.2, §2, §4, §9 Decisions 2026-10-11; Brendan's three decisions).** **(1) `nodes_block_read { id, resolution? }`** (44 → 45 tools): `id` is a NODE id (`n_…`); it dereferences to the node's owning block and returns exactly what `blocks_read` returns for that block (same shape, same `resolution` default `full`). `blocks_read`'s `id` is a block id only — an `n_` id is `block_missing` "no block with id … (an n_ id names a node — nodes_block_read reads its block)"; an unknown node is `block_missing` "no node with id …", a block-less node "node … has no block". Each tool's `id` is unambiguously its namespace's kind; `omg cat`/`show` send an `n_` ref to `nodes_block_read`. **(2) The doc relations `out` and `in` are dropped** (the distinct linked / linking documents): docs relations are `blocks nodes out_links in_links`, and `out`/`in` on a doc reads an undefined property like any other unknown name. `in`/`out` were non-descript, `in` doubles as the contextual `in` keyword, and the link rows express both with `distinct`: the linked documents are `out_links collect distinct { from dst }`, the backlinks `in_links collect distinct { from doc }`, the citation walk `follow out_links collect { from dst }` / `follow in_links collect { from doc }` with the options in a second brace (`… { from dst } { depth 2 }`) and a predicate restriction inside the block (`follow out_links collect { from dst where predicate == "depends_on" }`); `from` over an absent `dst` (an external link, a dangling `[[wikilink]]`) contributes no successor. The `graph` tool compiles to those destination blocks; every `query-follow` fixture respelled with byte-identical expectations. **(3) `dst` on link rows**: a reach-through to the destination DOCUMENT row when `dst_kind == "document"` and the document exists (resolved by `dst_id`, which `dst_path` already names), absent for a `block` or `external` destination and for a phantom — it never reaches into a block; `doc` on a link row (the source) is unchanged. `dst.title`, `dst { title }` (a one-element list or empty), `dst values` (`{ id, path }` or null), `where out_links exists { where dst.layer == "draft" }`; `dst.<k>` pushes down like `doc.<k>` in both translators (the destination's properties by the row's own `dst_node`; `dst.id`/`dst.path`/`dst.hash`/`dst.updated_at`/`dst.format` a primary-key probe of the destination, NULL wherever `dst` is absent), and a literal compared with `dst.path` is rooted like one compared with `dst_path`. `query_syntax`, the §1.2 table (links relations `doc`, `dst`), `@omgbase/oqx-syntax`'s vocabulary (`dst` in, `out`/`in` out), the docs, the OQX tutorial and the graph-ui demo follow.

  **Migration from 2.x.**

  | 2.x | 3.0 |
  | --- | --- |
  | `$id`, `$path`, `$updated_at` in a query | `id`, `path`, `updated_at` |
  | `$title`, `$tags` | `title` (computed), `tags` (authored ∪ hashtags); the authored keys alone: `data.title`, `data.tags` |
  | `$body` (docs) / `$body` (blocks, the text) / `$content_hash` | `raw` / `text` / `hash` |
  | `$doc`, `$ordinal`, `$depth` on blocks | `doc_id`, `ordinal`, `depth` |
  | `$doc_id`, `$block_id`, `$node_id` on nodes | `doc_id`, `block_id`, `id` |
  | `from edges`, `out_edges`/`in_edges`, `^edges`, `entries(^$it)` → `edges`, `graph.edges[]` | `from links`, `out_links`/`in_links`, `^links`, `links`, `graph.links[]` (`from edges` is an error naming the new spelling; the storage table is still `edges`) |
  | `$src`, `$src_block`, `$via`, `$dst`, `$dst_path`, `$dst_uri`, `src_field`, `$from_commit` on edges | `doc_id`, `block_id`, `via_id`, `dst_id`, `dst_path`, `uri`, `field`, — (removed) — on `links` |
  | `^$id` / `0^$id` | `^id` / `0^id` |
  | a bare `id`/`path` was "did you mean `$path`?" | the attribute; the author's key is `data.path` |
  | `frontmatter.path` to force an authored key | still works; `data.path` is the merged read; all three handles now push down |
  | `select $path` (duplicate `path` column) / `select id: …` overwriting the envelope | `select path` is the envelope; `select path: …`/`select data.path` must be aliased (`p: …`) |
  | result readers: `docId`/`doc`/`blockId`/`repoId` → … | `id`; `path`/`srcPath` → `path`; `content`/`raw` → `raw`; `contentHash`/`content_hash`/`baseContentHash` → `hash`; `ts` on a doc row or version → `updated_at`; `placement.{parent,ordinal,depth}` → `parent_id`/`ordinal`/`depth`; `srcDoc`/`src` → `doc_id`, `srcBlock`/`block` → `block_id`, `dst` → `dst_id`, `dst_uri` → `uri`, `src_field` → `field`, `node` (CLI `links`) → `doc_id`; `properties.computed.$title/$tags` → `title`/`tags` |
  | inputs: `doc: <ref>` on `docs_*`, `diff`, `diff_unified` | `id: <d_ id>` or `path: <path>`; `block`/`node` → `id` on `blocks_update`/`blocks_split`/`nodes_set` |
  | `nodes_get` / `nodes_get_many` / `history_node` | `blocks_read` / `blocks_read_many` / `blocks_history` (drop the `doc`/`path` scope) |
  | `docs_get_many` | `docs_read_many` |
  | `diff { doc, from_rev, to_rev }` / `diff_unified { doc, … }` | `docs_diff { id \| path, … }` / `docs_diff_unified { id \| path, … }` |
  | `text_search { q }` / `resolve { query }` | `blocks_search { q }` / `blocks_resolve { query }` (same hits) |
  | `tasks_complete { blocks }` / `node_set { node }` | `blocks_check { ids }` / `nodes_set { id }` |
  | `read_ref { ref }` | `docs_read { id \| path }` for a `d_` id or a path, `blocks_read { id }` for a `b_` id, `nodes_block_read { id }` for an `n_` id (the node's block, in `blocks_read`'s shape; no result has a `kind`) |
  | `doc.out` / `doc.in` (the linked / linking documents) | `out_links collect distinct { from dst }` / `in_links collect distinct { from doc }` (no `out`/`in` relation: a bare `out`/`in` on a doc is an absent property) |
  | `follow doc.out` / `follow doc.in` (`{ depth n }` after the relation) | `follow out_links collect { from dst }` / `follow in_links collect { from doc }` (the options in a second brace: `… { from dst } { depth n }`) |
  | a link row's destination document (a second query by `dst_id`) | `dst` on the row — `dst.title`, `dst { title }`, `dst values`; absent for external/block destinations and dangling targets |
  | `docs_plan_update { id \| path, content }` | `docs_update { id \| path, content, dry_run: true }` → `{ opset, plan, result: null }` |
  | `sections_append { heading: <id>, markdown }` / `{ heading: <text>, doc\|path, markdown }` | `blocks_append { id, text }` / `docs_append { id\|path, section: <text>, text }` |
  | `semantic_unavailable` | `provider_unavailable` |
  | `ls --ids` consumers that wanted paths | `--jsonl` and read `path` |
  | cursors | nothing |

  The graph-ui and live-tail demos read both generations and send both argument spellings and tool names (`from links`/`from edges`, `docs_diff_unified`/`diff_unified`, `graph.links[]`/`edges[]`) by the server's `specs.surface`.

## [0.2.5] - 2026-10-10

### Patch
- OQX language 0.19 — outer-reference `follow` destinations take the implicit `collect`. A `follow` destination whose receiver is headed by an outer reference (`^docs`, `^^root.rel`, `0^docs`, `^$it.docs`, with any member chain) can never be a plain destination (plain destinations are relations of the current row), so a `{` right after it now opens a **destination block** with the implicit `collect`: `follow refs(before), ^docs { where ^$path in list(after) }` walks `before` references forward and, backward, every document whose `after` names the frontier row — exactly `^docs collect { … }` with the 0.17 body rules (where-first, projections). Until 0.18 that query failed with the outer-reference error, because the 0.17 carve-out reserved a brace after the last destination for the options block. Any other receiver (a bare relation, a call like `refs(before)` or `entries(kids)`, a binding) keeps that reading: a brace after it is the options block when it is the last destination (`follow children { depth 2 }`, `follow a, children { depth 2 }`) and the "a destination block needs its consumer" error when the brace holds a predicate. An options block may still follow a trailing destination block (`follow ^docs { where … } { depth 2 }`). A plain `follow ^children` (no brace, no consumer) is still an error; its message now names both block spellings: `` `follow` takes a relation of the current row (`follow <relation>`); an outer reference walks a root collection only as a destination block — `follow ^docs { where … }` or `follow ^docs collect { … }` ``. Fixtures: 25 new cases across `follow`, `sugar`, `errors-parse` and `ast` (1188 total); the 0.17 sugar case "an outer-reference destination with a brace is the outer-reference error" is replaced by its positive form. `LANGUAGE_VERSION` is 0.19 in both engines and in `@omgbase/oqx-syntax`; the `query_syntax` reference (`@omgbase/core`, `omgbase-surface`) describes the new rule.

## [0.2.4] - 2026-10-10

### Patch
- **OQX 0.17 — join syntax sugar** (`spec/oqx` 0.16 → 0.17; `cases/sugar.json`, 134 new cases, 1131 in all; GRAMMAR §2/§4, SEMANTICS §5b/§14, AST.md). Everything that is pure sugar desugars **in the parser** to existing nodes, so the optimizer, the pushdown planners and `print` see the explicit form; two shapes are new.

  - **A receiver block without a consumer is `collect`**: `x { … }` ≡ `x collect { … }` in select position, where position and as a whole query (`docs { age > 15 }`). Carve-out: after the last `follow` destination a brace is still the options block (`follow children { depth 2 }`); a destination block keeps its consumer.
  - **Where-first bodies**: a block whose leading expression is *syntactically* a predicate (a comparison, `in`, `&&`/`||`, a prefix `!`/`is`/`not`, an infix `is`, a call, a literal, a binding, a parenthesized expression, a postfix `!` or bracket chain, a consumer test — anything that is not a bare name, a dotted navigation or a lift) drops `where`: `people exists { age > 50 }`, `jobs collect { pay > 2 }`. Bare names stay projections (`docs { is active }` is the bare-field filter); `{ name where age >= 18 }` keeps the keyword; `{ age >= 18, name }` is an error suggesting that form. The top level is unchanged: `age > 15 from people` is still the parse error (where would precede from).
  - **Brackets**: `x[p]` → `x first { where p }`; `x[p]!` → `x single { where p }` under a `required` (zero matches is the required error, many the `single` error); `x[n]` / `x[${i}]` → `x first { offset n }` (out of range is absent; a non-integer binding is the `offset` eval error); `x[n]!` → required positional. Chains compose (`refs(company)[0].name`, `jobs[pay > 2][0]`); a negative or fractional literal index is a parse error; `[`/`]` are tokens.
  - **Postfix `!` = required** — new node `{ kind: "required", expr }` / `Expr::Required`: the value, or the eval error `` `<expr>!` is absent `` (`on <id>` when the row has a scalar identity). Never a filter or a coercion (`0!`, `""!` are values); tightest precedence (`refs(c)[0]!.name` vs `refs(c)[0].name!`); a `!` right after a complete operand is postfix, a `!` at operand start is the negation (`!=` stays one token: write `a! == b` with the space).
  - **`is` / `not` / `and` / `or`** become keywords (reserved: `from where select is not and or` + the literal words). Prefix `is x` ≡ `!!x`, `not x` ≡ `!x`. Infix `x is y` / `x is not y` — new `binary` ops `"is"` / `"is not"` (`BinaryOp::Is` / `IsNot`) — compare **identity** per SEMANTICS §16 (a row's `id` when present, else structural), so `$it is ^$it` compares rows and for scalars `is` ≡ `==`; comparison precedence, non-chainable. `and` / `or` are exact synonyms of `&&` / `||` (same nodes, precedence, short-circuit and value semantics; `print` still writes the symbols). `in` over rows is unchanged (deferred).
  - **Alias reuse in `select`**: an item may reference the items to its left (`boss: ^people[id == ^manager], bossName: boss.name`), inlined by `resolveAliases` / `resolve_aliases` like a `where` alias; a reference to an item to the right is a parse error (a cycle when it refers back). **Behavior change:** `a: b, b: a` is now the cycle error (it was a field swap), and `senior: age > 50, s: senior` projects the alias (it was the row field `senior`).
  - **A directive may stand in value position** (`jobs first { }.pay`): this is how `print` writes a bracket chain back; `op` joins the `Expr` family by position (`isExpr` stays false for it; `transform` rebuilds it without handing it to the mapping). AST.md §8 records the additions (minor; nothing renamed or removed).
  - Existing fixtures that turned from error into meaning: `people exists { age > 50 }`-style blocks (`where` ×4, `errors-parse` consumer-after-projection re-queried as `{ name, jobs exists { } }`, `projection` call-in-block re-queried as `{ name, has(budget) }`), the `[` lex-error case (now a token).
  - **omgbase binding**: the pushdown planners decline `is` / `is not` (identity is the engine's structural notion, not SQL's `IS`), `required` and value-position directives (they may raise), so they stay residual; `query_syntax` gains a "Sugar" block; `docs/query-language.md` §3.6. The surface fixture `implicit-where-in-block` re-queried as `{ kind == "md:task", name }` (still the loud error pointing at `where`).
  - `@omgbase/oqx-syntax`: `[`/`]` are bracket punctuation (no longer lex errors), `is`/`not`/`and`/`or` are keywords highlighted as word operators, `LANGUAGE_VERSION` 0.17; assets regenerated.
- **OQX 0.18 — the root scope is a row, absolute scope references, canonical `and`/`or`** (`spec/oqx` 0.17 → 0.18; `cases/absolute-refs.json` new (24), `outer-refs` +6 (the `$it is absent at the root scope` case re-queried as the root-object cases), `limit-offset` +2: 1163 cases in all; GRAMMAR §1/§3/§4/§5/§6, SEMANTICS §2/§8/§18/§19, AST.md §1/§3/§6/§8, README).

  - **The root scope is a row: the host's root object.** SEMANTICS §2 step 1 no longer reads "absent at the root": `$it` at the root scope is the host's root object, so from a top-level row `^$it` is that object, `entries(^$it)` enumerates the named roots in insertion order, `^$it.people` ≡ `^people` (and works as a receiver), `^^$it` from depth two is the same object, and `$it values from $it` is the object as one row. The seam gained **`DataContext.rootObject?(): unknown`** (TypeScript, optional — absent keeps the root row absent) / **`fn root_object(&self) -> Value`** (Rust, provided method defaulting to `Value::Undefined`); `DefaultContext` returns the roots record it was constructed with. Step 5 at the root still reads `ctx.root(name)` — a bare name is never a property of the root object — so hosts with lazy roots are unaffected, and a host-provided root-level name (omgbase will expose the repository id as `$id`, cashing in `$repo.$id` → `^$id` from depth one, `^^$id` from depth two) is readable through `root(name)`. A top-level `limit`/`offset` is evaluated in the root scope *without* its row (SEMANTICS §18): `^$it` reached through a bracket inside the bound is absent, pinned.
  - **`N^name` — absolute scope references.** An unsigned integer literal immediately followed by `^` (no whitespace) names a scope by its syntactic depth (root 0, top-level rows 1, +1 per block body, a destination block's rows one below the frontier row, a follow `where` one deeper than the frontier row — the `visit` depth): `0^docs`, `0^$it`, `1^$path`, `0^$id`, and as a lift target `1^tasks: text`. It **desugars in the parser** to the existing `outer` node (or lift) with `levels = currentDepth − N`; no new AST shape, `print` writes the carets. `N ≥ currentDepth` is the parse error `scope N does not enclose this block (the current scope is depth D)`; `1 ^x` (a space) and `1.0^x` stay the stray-`^` error. Composes with brackets, calls and receivers (`0^docs[0]`, `x[p == 0^flag]`, `entries(0^$it)`, `0^$it.docs collect { … }`, `follow 0^people collect { where manager == 1^id }`, `follow next { where prev == 1^id && 0^k == 2 }`, `limit 1^n`). Both parsers now track the scope depth of every position.
  - **Canonical `print` writes `and` / `or`** for the `where` tree's `and`/`or` nodes and for `logical` expressions (both engines); `!` stays `!`, `is`/`is not` were already words, the JSON `logical.op` stays `"&&"`/`"||"`. Consequence: every query text omgbase's `graph` macro prints flips from `||` to `or` — the pinned `graph` query strings in `spec/surface` (`reads.json`, and the `omgbase-surface` unit test for the multi-root seed) are regenerated; nothing else in the surface fixtures changes.
  - **omgbase binding** (`@omgbase/core` `oqx-js/context.ts`, `omgbase-surface` `context.rs`): the root object is the repository root (`$repo`), so `^$it` from a top-level row is `$repo` and `^$it.docs` the docs scan. The `^docs`/`$repo` redesign and the `$id` root name are a separate change.
  - `@omgbase/oqx-syntax`: the `N^` lexeme highlights as one outer-reference token (`lift`), `LANGUAGE_VERSION` 0.18; assets regenerated.

### Notes
- `vscode/package.json` regenerated (`pnpm --filter @omgbase/oqx-syntax build`): the 0.2.3 release bumped `package.json` without regenerating the derived VS Code manifest, so `assets.test.ts` failed on drift.

## [0.2.3] - 2026-10-09

### Patch
- **OQX 0.16 — the AST is a first-class contract** (`spec/oqx/AST.md`, fixtures `cases/ast.json` + `cases/ast-spans.json`, 70 new cases; 959 in all). Both engines now produce one normalized tree a tool can reflect on without re-parsing:

  - **Spans on every node**: `span: [start, end)` in Unicode code points over the raw source (a template's `rawSource`, where a binding occupies its `${n}` marker). The TypeScript lexer counted UTF-16 units; it now counts code points like the Rust one, so the `(at offset N)` of a lex/parse error is the same number in both engines. `toUtf16(span, source)` converts for editors.
  - **Normalized shape**: `kind` on every node (`query`, `subquery`, `follow`, `order` added), optionals materialized (`where`/`limit`/`offset`/`countCmp: null`, `distinct`/`values: false`), operators and consumers serialized as their source words, the never-produced `Expr.index` variant removed. `toJSON(query)` / `ast_to_json(&query)` emit `{ "oqx": "0.16", "kind": "query", … }`; the Rust crate derives serde under the `json` feature (`query_from_json` reads it back).
  - **`where` keeps its surface form**: the parser no longer inlines `select` aliases into `where` (it only validates them — every `errors-parse` fixture is unchanged); the substitution is the exported pure `resolveAliases` / `resolve_aliases`, applied exactly once by the run entry points (`oqx`, `run`, `execute`, `runQuery`; `run_query`, `execute`). **An `Engine.run` now evaluates the query it is given** — code that drives `InMemoryEngine`/`PlannedEngine` directly with a query whose `where` uses aliases must resolve first (resolution is not idempotent: `name: name.upper() … where name`).
  - **Traversal**: `visit(root, { enter, leave })` with `{ path, clause, depth }` (scope depth, 0 = root) and `transform(root, f)`, both driven by one child-key table (`CHILDREN`; Rust `walk::visit`/`transform` with a `Visitor` trait, `Node`, `Clause`); `stripSpans` / `strip_spans`; builders `build.*` / `oqx::build::*` for hand-made nodes (empty span `[0, 0]`).
  - **Canonical printer**: `print(node)` / `print_query` — single spaces, `select` written at the top level, every item aliased, double-quoted strings, minimal parentheses from the precedence table; `printTemplate` → `{ strings, count, indices }` for a tree with bindings (`print` throws, new error stage `print`). Law, enforced by both spec runners over every fixture query: `strip(parse(print(parse(q)))) ≡ strip(parse(q))`.
  - **Migration** for anyone constructing AST literals (after 0.14's `receiver` → `destinations`): add `kind` to `Query`/`Subquery`/`Follow`/`OrderSpec`, `span` to every node, write the materialized fields (`limit: null`, `countCmp: null`, `distinct: false`, `values: false`), drop `index`; or use `build.*`. Rust: struct variants gained `span` (match with `..`), `Expr::Lit(v)` is `Expr::Lit { value, span }`, `Token` gained `end`.
  - **omgbase** (`@omgbase/core`, `omgbase-surface`): the runner's `$self` row-function rewrite is a `transform`, the `semantic("…")` scan a `visit`, aliases are resolved once before the runner's own rewrites; the `graph` macro builds its `follow` walk with the builders and `print`s it instead of splicing strings — the generated query text and every `spec/surface` result are unchanged. `@omgbase/oqx-syntax`'s `LANGUAGE_VERSION` moves to `0.16` (assets regenerated).

## [0.2.2] - 2026-10-09

### Patch
- OQX language **0.15**: the intrinsic naming the current item is **`$it`**; `$value` is no longer an intrinsic and has no synonym. `$it` is the scope's row itself — the top-level row, a nested block's inner item, each element of a scalar collection, the entry's value inside `entries(x)` — absent at the root, with `^$it` the enclosing row, `$it.field` navigation, `$it values`, `$it` as a `follow … { by $it }` identity. A row property literally named `$it` is shadowed by the intrinsic. `$value` is now an ordinary property name under SEMANTICS §2 step 5, exactly like the non-metadata `$` names since 0.13: `{ "$value": 3 }` projects `3`, a row without one reads absent, over scalars it is absent, and inside an `entries()` scope it is a property of the entry's *value*. Why: "self" implies a fixed referent while the row changes per scope; "it" is the pronoun for whatever is being handled; keeping `$value` as a synonym would spell one concept two ways. `$key` is unchanged, and the `{ key, value }` record of `entries(x)` used as a plain value is unchanged (that is a value shape, not the intrinsic). **Migration:** replace `$value` with `$it` in every query (`s/\$value/\$it/g`); nothing else moves. New `intrinsics` fixtures pin the rule; every other fixture query was rewritten with its expectation untouched. omgbase's query surface (`query`, `query_syntax`, the CLI help, `docs/query-language.md`, the tutorial, `spec/surface` fixture queries) follows: a `$value` in an omgbase query now reads a frontmatter/attrs key so named.

## [0.2.1] - 2026-10-06

### Patch
- OQX language **0.14** (`spec/oqx/VERSION`): `follow` gains correlated successor
  predicates and destination lists.

  - **`^` in the follow `where` is the frontier row.** `follow R { where P }` now
    reads `P` in the candidate's scope whose parent is the row being expanded, so
    `follow doc.in { where before.contains(^$path) }` steps only into rows that
    name the row they were reached from; `^^name` is the walk's enclosing scope.
    Before, `^` skipped the frontier row and read the enclosing scope (the root
    for a top-level walk), so a correlated predicate silently never held.
    `frontier` and `by` are unchanged (`^` there is the enclosing scope).
  - **Destination lists.** `follow a, b, …` walks the union of several
    destinations; each is a relation of the current row or a **destination
    block** — a select-position `collect`/`first`/`single` block re-evaluated per
    frontier row with `^` bound to it (`follow ^people collect { where manager ==
    ^id }`, `follow before, ^docs collect { where after.contains(^$path) }`).
    Within one expansion step the successors are unioned by identity — the
    walk's identity, so `by E` governs it: a relation holding a node twice now
    yields one successor, and under `by type` same-type siblings reached in one
    step are one node (the surface case `query-follow::by-rekeys-identity` goes
    from 8 to 5 hits). `frontier`, `depth`, `where`
    and `by` apply to the whole walk; `$ordinal` stays `(depth, path)`.
  - AST: `Follow.receiver` becomes `Follow.destinations` (TypeScript
    `(Expr | OpNode)[]`; Rust `Vec<FollowDestination>` with `Relation(Expr)` /
    `Block(OpNode)`). omgbase's query rewriters and planners read the new shape;
    `@omgbase/oqx-syntax` pins `LANGUAGE_VERSION` to `0.14`.
  - 27 new fixtures in `spec/oqx/cases/follow.json` (877 cases in 29 files).

## [0.2.0] - 2026-09-28

### Minor
- New package **`@omgbase/oqx-syntax`**: syntax highlighting assets for OQX, generated from one lexical vocabulary so no editor grammar can drift from another. It ships the TextMate grammar (`source.oqx`, `syntax/oqx.tmLanguage.json`), a Monaco Monarch grammar (`syntax/oqx.monarch.json`), a CodeMirror 6 stream parser (`oqxStreamParser(tags)`, plus `oqxLegacyMode()` in CodeMirror 5's shape for Obsidian), a Prism grammar (`oqxPrismGrammar`, `registerOqxPrism`), the editor language configuration, language metadata (`LANGUAGE`, `LANGUAGE_VERSION`), the vocabulary itself (keywords, contextual words, consumers, builtins, intrinsics, the omgbase host names), and adapters for Shiki (`oqxShikiLanguage`), Monaco (`registerOqx`) and a VS Code extension under `vscode/` that also highlights ```` ```oqx ```` Markdown fences. Highlighting is lexical: contextual words are colored only in position (`count {`, `limit 10`, `order by`, `in <value>`), malformed numbers and lex-error characters are marked `invalid`, and every `$name` is an intrinsic. Tests tokenize with the real TextMate engine (golden corpus), prove that the Monarch, CodeMirror and Prism grammars tokenize every `spec/oqx` fixture exactly as TextMate does, check that lexically valid fixtures never show an error token, pin the vocabulary to the spec prose and to `@omgbase/oqx`'s `LANGUAGE_VERSION`, and load the grammar into Shiki.
