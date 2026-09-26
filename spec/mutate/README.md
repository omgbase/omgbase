# The omgbase mutation specification

Mutation is how the store is *written to on purpose*: six kernel operations
over a document's block tree (insert, update, move, remove, split, merge),
applied as an atomic changeset, rendered back to bytes by splice, written to
the file, and committed as an `api`-origin revision whose block identities
are the ones the operations chose — never re-derived from the bytes. On top
of the kernel sit deterministic macros, the document-level operations
(create, move, delete, set-meta) and the whole-document update planner that
turns a proposed complete document into an inspectable opset. This directory
specifies all of that so that two engines, given the same database and the
same changeset, produce the same bytes, the same rows and the same errors.
It is owned by neither implementation.

| Implementation | Where | Role |
| --- | --- | --- |
| `@omgbase/core` (TypeScript, npm) | `packages/core/src/mutate/{tree,ops,apply,load,known-ids,macros,docs,doc-store,plan-update,lower,opset}.ts` | **Reference.** Mutation decisions land here first. |
| `omgbase-mutate` (Rust, crates.io) | `crates/omgbase-mutate` | Conformance-first port: the working tree, the six ops, the splice renderer, the lowering and the opset (pure); `omgbase-store` loads, commits, plans and runs the macros and document operations. |

The spec is two artifacts, versioned together by `VERSION`: this `README.md`
and `cases/*.json`. **When prose and fixtures disagree, the fixtures win**,
and the prose gets fixed. Rationale: `docs/mutation-and-concurrency.md`,
`docs/update-opsets.md`.

## Versioning

`VERSION` is `<major>.<minor>`; the `omgbase-mutate` crate is
`<major>.<minor>.<patch>`. A change to what an op does, what it renders, or
which error it raises bumps the minor; a change to the request/response or
opset shapes bumps the major.

## The rule for changing mutation

**Fixture first, TypeScript (reference) second, Rust third.** §10 records the
reference oddities surfaced and the decisions taken.

## 1. The working tree

A document is loaded from the store (`spec/store`) into a mutable tree:

```text
MutDoc
  doc_id, path, format
  leading_trivia     docs.leading_trivia
  frontmatter_raw    the current revision's frontmatter blob bytes + docs.frontmatter_trivia,
                     or null when the document has no frontmatter
  children           top-level MutBlocks

MutBlock
  id                 the block id
  type, attrs        as stored
  raw                the raw blob's bytes
  trivia             the trivia blob's bytes, or "" when trivia_hash is NULL
  children           by parent_block, in ordinal order
  dirty              render flag (§3): false when loaded
```

Only live blocks load, `ORDER BY parent_block, ordinal`; a row whose parent
is not loaded is a root. A missing doc (unknown or tombstoned) is
`doc_missing`.

### 1.1 Placement

```text
To   { parent: <block id> | { doc: true } | { heading: <block id>, scope: "section" },
       at: "start" | "end" | { before: <block id> } | { after: <block id> } }
```

- `parent: <id>` → the block's `children`; unknown → `parent_missing`.
- `parent: { doc: true }` → the document's top level.
- `parent: { heading, scope: "section" }` → the top level, with the section
  range of the heading (its top-level index *h*, level *L* from `attrs.level`
  or 1; the range ends before the next top-level heading of level ≤ *L*, or
  at the end): `at: "start"` inserts at *h* + 1, `at: "end"` at the range
  end, an anchor resolves against the top level. An unknown heading is
  caught earlier, when the changeset infers the document from it:
  `parent_missing` with no data (§4 step 1); inside a loaded document it
  would be `target_missing`.
- `at: { before | after: <id> }` → the anchor's index (+ 1 for `after`) in
  the resolved sibling list; unknown → `target_missing`.

### 1.2 Expectations

```text
Expect { content_hash?: hex(raw_hash), parent_children_hash?: hex(sha256(child ids joined by ",")) }
```

`check_content_hash(block, expect)`: a **missing** `content_hash` and a
mismatched one both raise `stale_expectation` with `{ op_index, block,
expected_content_hash?, current: { content_hash, markdown: raw }, retriable:
true }` — the caller can retry from the error without a read.
`parent_children_hash` mismatch raises `stale_expectation` with `current: {
parent_children_hash }` — defined, but no op consults it (§10).

## 2. The six operations

Every op runs against the in-memory tree; `op_index` is its position in the
changeset. Content supplied to an op is parsed per `spec/format` after
ensuring a trailing `\n`; a parsed block's trivia defaults to the format's
separator when empty (`\n\n` for Markdown); a `frontmatter` block in
op-supplied content is dropped; every parsed block gets a **freshly minted
`b` id**, pre-order, at parse time (§10 on mint order).

### 2.1 `insert { doc?, to, markdown }` → `{ ids }`

Resolve `to` (§1.1). If the owning container is a `list` (Markdown): each
parsed `list` contributes its items, any other parsed block is wrapped as a
`list_item` with raw `"- " + raw` (fresh id, `dirty`); splice the items at
the index; mark the list dirty; `ids` = the items' ids. Otherwise: when the
target is the **top level**, heal the seams — if `index > 0` and the
preceding block's trivia does not separate blocks (`\n\n` absent, for
Markdown), set it to the separator; if the run lands before an existing
block and the run's last trivia does not separate, set it to the separator;
splice; a nested target marks its owner dirty. `ids` = the parsed blocks'
ids in order. An empty parse inserts nothing (`ids: []`).

### 2.2 `update { block, markdown?, attrs?, expect?, trivia?, child_ids? }` → `{ ids }`

Unknown block → `block_missing`. Content CAS (§1.2) is required when
`markdown` is given, and honored whenever `expect.content_hash` is given.

- **Markdown, the block is a `list_item`**: the content must parse to
  exactly one block, else `type_mismatch`. A `list` → the first item's raw
  and children replace the target's (the id stays), further items become
  new siblings after it; a non-list → raw becomes `"- " + raw`, children
  cleared. Mark the item and its list dirty.
- **Markdown, other**: parse; zero blocks → `type_mismatch`; more than one
  block with `child_ids` → `type_mismatch`. The first parsed block's
  `raw`/`type`/`attrs`/`children` replace the target's (id kept); when
  `child_ids` is given, its positional keys (`"/0"`, `"/1/2"`, relative to
  the block's children) override the minted ids of the re-parsed children.
  The subtree is marked clean (the raw is authoritative); the owning
  container is marked dirty. Further parsed blocks become new siblings.
- **Other formats**: raw replaced verbatim, children cleared, block dirty.
- `attrs` merge over the current attrs. When `checked` is among them and the
  block is a `task` or `list_item`, the first `[ ]`/`[x]`/`[X]` in the raw
  is rewritten to `[x]`/`[ ]`, the type becomes `task`, the block is dirty.
- `trivia`, when given, replaces the block's trivia verbatim (no dirty).
- Extra siblings: the target's trivia moves to the last extra block; at the
  top level every seam inside the run that does not separate is set to the
  separator; the owner is marked dirty. `ids` = `[block, ...extra ids]`.

### 2.3 `move { blocks, to }` → `{ ids: blocks }`

An empty list fails before the op runs: the changeset infers the document
from `blocks[0]` and raises `block_missing { op_index }` (§4 step 1); the
op itself would say `not_contiguous`. Every block located (`block_missing`); all must
share a sibling list with consecutive indices → else `not_contiguous`. If
`to.parent` is an id inside the moved subtrees → `cycle_move`. Remove the
blocks (order kept), resolve `to` on the post-removal tree, splice. Mark
source and destination owners dirty. At the top level, **heal every seam**:
each non-last top-level block whose trivia does not separate gets the
separator (the last block's trivia is never touched).

**Cross-document** (the destination resolves in another loaded document):
extract from the source lists, insert at the destination's resolved target
(`parent_missing`/`target_missing` as above), mark both owners dirty, and
heal the top-level seams of **both** documents as above (§10: the reference
healed neither, so a block landing after the destination's last paragraph
merged into it).

### 2.4 `remove { blocks, expect? }` → `{ ids: blocks, removed }`

Pass 1, every id in order (duplicates skipped): locate (`block_missing`,
with a hint), check its `expect[id]` if given; keep it as a *top* unless an
ancestor is also in the set. Pass 2, for each top in order: collect its
subtree ids into `removed` (pre-order), splice it out, then if the owning
container is now empty remove the container too (recursively), else mark
the owner dirty.

### 2.5 `split { block, at, expect }` → `{ ids }`

Locate (`block_missing`); CAS required. Cut the raw at the sorted **byte
offsets** `at` plus 0 and the length (§10: the reference cut at UTF-16
indices), drop pieces that are whitespace-only; fewer than two →
`type_mismatch`. The first piece stays in the block (dirty); each further
piece becomes a new sibling right after, same `type`, a copy of `attrs`,
dirty. **Seams**: the block's trailing trivia moves to the last piece; every
earlier piece (the first included) gets the format separator (`\n\n`)
unless its trivia already separates blocks — so splitting a document's last
block never jams the pieces into one (§10: the reference left the first
piece's lone `\n`). `ids` = `[block, ...new]`.

### 2.6 `merge { blocks, separator = " ", expect? }` → `{ ids: [first], merged_into }`

Fewer than two → `not_contiguous`. Locate all (`block_missing`); same
sibling list and same `type` (`type_mismatch`), each `expect[id]` checked,
consecutive indices (`not_contiguous`). The lowest-index block's raw becomes
the raws joined by `separator` (dirty); the others are removed;
`merged_into` = their ids.

## 3. Rendering

`render(doc) = leading_trivia + (frontmatter_raw ?? "") + Σ(render_block(b) + b.trivia)` over the top-level blocks.

`render_block(b, depth)`: a leaf, or a block with no dirty descendant, emits
its `raw` verbatim. Otherwise, by type:

- **`list`**: items joined by `\n\n` if the list's raw contains `\n\n`, else
  `\n`; each item rendered by `render_item` with the marker `"- "` for an
  unordered list or `"<start + i>. "` for an ordered one (`start` from
  attrs, default 1) — ordered lists renumber.
- **`blockquote`**: children rendered (depth + 1) and joined by `\n\n`, then
  every line prefixed `"> "` (a blank line becomes `">"`).
- **`table`**: rows rendered; if the raw's second line is a delimiter row
  (`^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$`) it is re-inserted after the
  first row; joined by `\n`.
- **anything else** (a `list_item` outside a list): children rendered and
  joined by `\n`, each indented by two spaces per depth.

`render_item(item, marker)`: if a child has a dirty descendant, the body is
the children rendered (`list` children via the list rule) joined by `\n`;
else the body is the item's raw with its leading marker stripped
(`^(\s*)([-*+]|\d+[.)])(\s+)` on the first line; continuation lines lose the
same width when it is blank). Then the marker is applied: first line
prefixed, every non-empty later line indented by the marker's width.

A block whose raw an op supplied is *clean* (its raw is exact); what goes
dirty is the container whose children changed. This is why an update of a
nested paragraph re-renders its blockquote by rule, while an updated list
keeps its exact bytes.

## 4. Changesets

```text
Op   insert | update | move | remove | split | merge   (fields as §2; string
     fields `block`, `blocks[]`, `to.parent`, `to.at.before/after` may be
     placeholders "$<n>.ids[<i>]" naming an earlier op's result)
Request  { repo, ops, origin: { actor, reason? }, dry_run?, set_frontmatter?: [{ doc, raw | null }] }
Result   { results: [{ ids, removed?, merged_into? }], revisions: [{ doc, path }], diffs?: { path: { before, after } }, committed }
```

1. Resolve placeholders against earlier results (`target_missing` when the
   index is out of range). Find each op's document: `insert.doc` (an id
   passes through, a path resolves, else `doc_missing`) or the placement's
   block/heading/anchor (`parent_missing`, no data; a top-level
   `start`/`end` insert with no `doc` → `target_missing`);
   `update`/`remove`/`split`/`merge` by their first block (`block_missing
   { op_index }` — no `block` field at this level; an op-level miss, such
   as `remove`'s second id, carries `block` too); `move` by its first block, the
   destination by `to` unless `to` is `{ doc: true }` with `start`/`end`
   (same document). A document is loaded once, at first touch, and its
   pre-mutation render and live id set are remembered.
2. `set_frontmatter` entries load their documents and replace
   `frontmatter_raw` before any op.
3. Apply the ops in order (§2); any error aborts the whole request with
   nothing written.
4. For every loaded document: `diffs[path] = { before, after: render }`,
   `revisions` gets `{ doc, path }`. `dry_run` returns here with
   `committed: false`.
5. **Commit**, per loaded document in load order, under the writer lock when
   a workspace is given:
   - **file-CAS**: if the doc store has bytes at the path and the doc has a
     `file_hash`, they must match; else the on-disk bytes are ingested as an
     `observed` commit through the reconciling path (`spec/store` §5) and
     `sync_conflict` (retriable) is raised.
   - write the rendered bytes (atomic: temp file + rename; a headless doc
     store does nothing);
   - **ingest** the rendered bytes as `spec/store` §5.4 with `origin =
     "api"`, `actor`, `reason`, and the **known-id resolver**: the re-parsed
     body gets the tree's ids by positional key (`"/i/j"`; a position with
     no id mints — impossible under the round-trip law), dispositions
     `{ kind: edited if the id was live before else inserted, confidence: 1,
     reason: "api", matcher_v: null, detail: {} }` for every block (there is
     **no `deleted` disposition row** on the api path), `deleted` = the
     prior live ids no longer present (pooled per `spec/store` §5.4 step 7),
     and `cross_doc_ids` = the ids new to this document that were live
     elsewhere (a cross-document move), so step 8 evicts the source's row
     whichever document commits first (§10);
   - refresh the freshness stat cache.
   `committed: true`.

Atomicity is per request up to the commit phase; a `sync_conflict` in the
commit of the *n*-th document leaves the earlier documents committed (§10).

## 5. Macros

Each expands to kernel ops, deterministically, and the expansion is what
runs and what the caller sees:

| Macro | Expansion |
| --- | --- |
| `tasks_complete { blocks }` | one `update { block, attrs: { checked: true }, expect: { content_hash } }` per block (the CAS from the live row; omitted when the block is unknown) |
| `sections_append { heading, markdown }` | `insert { to: { parent: { heading, scope: "section" }, at: "end" }, markdown }` |
| `docs_append { doc, markdown }` | `insert { doc, to: { parent: { doc: true }, at: "end" }, markdown }` |
| `sections_rename { heading, title }` | `update { block: heading, markdown: "#"×level + " " + title, expect }` — level from the live raw's leading `#` run (1 when none) |
| `sections_move { heading, to }` | `move { blocks: the heading's section run (top-level ids from the heading to before the next heading of level ≤ its own), to }`; `[]` when the heading is unknown |
| `lists_insert_item { anchor, at, markdown }` | `insert { to: { parent: anchor, at }, markdown: markdown if it starts with "- " after trimming else "- " + markdown }` |
| `node_set { node, prop, value }` | the adapter's editor for `(kind, prop)` applied to the block's raw and the node's span (byte span → the host's indices) → one `update` (markdown or attrs) with the CAS; unknown node → `block_missing`; no block / no editor → `node_not_editable` (`{ kind, prop, editable }`). Editors: `md:link.name` (retype the text), `md:link.value` (retarget), `md:task.checked` (attrs) |
| `links_repair { repairs: [{ from, to }], path_glob? }` | for every live non-`code_fence` block of the repo whose raw contains a slash-less `from`, visited in `(path, depth, ordinal, block_id)` order, rewrite each **whole link destination** (Markdown link/image, wikilink, bare-path inline field; a trailing `#…`/`^…` fragment re-appended; leading `/` ignored in matching; first matching pair wins; never inside code spans) → one `update { markdown, expect }` per changed **top-most** block (a hit whose ancestor also hit is dropped); returns `{ ops, hits: [{ block, path, old_raw, new_raw }], pairs: [{ from, to, hits }] }`. `links_retarget { from, to }` is the one-pair form |

## 6. Document operations

All are `api` commits with a generated `reason`.

- **`docs_create { path, markdown, frontmatter? }`**: canonicalize the path
  (strip leading `/`, `\` → `/`); a live doc there → `path_taken`; compose
  the file (body with a trailing `\n` ensured; when `frontmatter` is a
  non-empty object: `"---\n" + yaml + "\n---\n" + ("\n" unless the body
  starts with one) + body`, `yaml` being the mapping serialized by the
  reference's YAML emitter — §10); a file already on disk → `path_taken`;
  write; ingest with the **reconciling** resolver (`reason: "create <path>"`).
- **`docs_move { doc, to_path, retarget_inbound? }`**: `doc_missing`;
  `path_taken` if a live doc or a file exists at the destination; rename the
  file (or write the bytes when the source file is absent); in one
  transaction: an `api` commit (`reason: "move <from> -> <to>"`, no revision),
  `docs.path` and the current revision's `path` updated, every open edge
  from **another** document into this one re-pointed to `phantom:<old
  path>`, a self-document edge re-pointed only when its link names the path
  (a pure fragment stays), affected rollups rebuilt, phantoms at the new
  path adopted. Result lists the still-dangling inbound links; with
  `retarget_inbound`, the deepest hit block per inbound link is rewritten
  (relative forms against the source's current directory) as one follow-up
  changeset (`reason: "retarget inbound links <from> -> <to>"`).
- **`docs_delete { doc }`**: `doc_missing`; one transaction: `api` commit
  (`reason: "delete <path>"`), FTS rows dropped, live blocks and the doc
  tombstoned — **nothing pooled** (an intentional delete, unlike `spec/store`
  §5.6); then the file removed and its stat row cleared.
- **`docs_set_meta { doc, set?, unset? }`**: read the file, split the
  frontmatter with `^---\r?\n([\s\S]*?)\r?\n---\r?\n?` (malformed → `{}` and
  the whole content as body), merge `set`, delete `unset`, compose (as
  create), write, ingest with the reconciling resolver
  (`reason: "set_meta <path>"`). Unsetting every key leaves the body's
  leading blank line in place (`leading_trivia` becomes `"\n"`, §10).

## 7. Whole-document update

`plan_update(doc, content)` → `Opset`:

```text
Opset { version: 1, kind: "doc_update", target: { doc, path },
        precondition: { doc, path, base_revision, base_content_hash },
        matcher_v, ops: [PlanOp], frontmatter?: { raw | null },
        summary: { preserved, updated, moved, created, removed, split, merged, ambiguous },
        converges, diagnostics: [string] }
PlanOp { op, disposition, blocks, confidence, reason, detail? }
```

1. Load the doc (`doc_missing`); `base_content_hash = sha256(render(doc))`,
   `base_revision = current_rev`.
2. Parse `content` per the doc's format; split off the frontmatter block;
   reconcile the body against the doc's stored tree (`spec/reconcile`, the
   configured matcher, **no pool**).
3. `frontmatter` = `fm.raw + fm.trivia` (or null) when it differs from
   `frontmatter_raw`.
4. **Lower** (§7.1) to candidate ops; **verify** by a dry-run apply with the
   same `set_frontmatter`: the rendered result must equal `content` byte for
   byte. The top-level lowering is tried first; if it does not converge, a
   diagnostic names the first differing byte and the proposed block covering
   it, and the **replace** lowering (remove every top-level block with its
   CAS, insert the whole body — the frontmatter stripped by
   `^---\r?\n[\s\S]*?\r?\n---\r?\n?` and a leading blank line — at the end)
   is tried; if that converges too the diagnostics say identity was not
   preserved; if neither converges the top-level plan is returned with
   `converges: false`.
5. `summary` counts dispositions: `edited` → updated, `moved` → moved,
   `edited_moved` → both, `inserted`/`copied_from`/`resurrected` → created,
   `deleted` → removed, `split_from` → split, `merged_into` → merged;
   `preserved` and `ambiguous` (dispositions carrying `near_misses`) from the
   lowering.

### 7.1 Top-level lowering

With `target` = the proposed top-level blocks annotated by the assignment
(`carried` when the id existed anywhere in the old tree):

1. **Removes**: each old top-level block whose id is not a proposed
   top-level id → `remove { blocks: [id], expect: { [id]: { content_hash } } }`,
   disposition `deleted`, reason `tombstone`.
2. **Updates**: each carried proposed block that existed in the old tree and
   whose raw hash differs → `update { block, markdown: raw, expect: {
   content_hash: old }, child_ids? }` where `child_ids` maps the positional
   keys of its carried descendants; disposition `edited` with the matcher's
   confidence/reason/detail.
3. **Placement**: `kept` = proposed blocks carried from the old top level;
   `stable` = the longest common subsequence of `kept` in old order vs
   proposed order (standard DP, ties preferring to advance the old side).
   Walk the proposed blocks with `prev` (null at the start): a block not
   carried from the old top level → `insert { doc, to: { parent: { doc:
   true }, at: prev ? { after: prev } : "start" }, markdown: raw }` and
   `prev` becomes the placeholder `$<op index>.ids[0]` (disposition
   `copied_from`/`resurrected`/`split_from` when the matcher said so, else
   `inserted`); a kept block not in `stable` → `move { blocks: [id], to }`
   with the same anchor (disposition `moved`); `prev` = its id.
4. **Retile**: for each proposed block that was inserted, moved, anchors a
   following insert/move, or whose trivia differs from its old trivia →
   `update { block: <its id or placeholder>, trivia }`, disposition
   `retiled`.

`preserved` = carried old top-level blocks with unchanged raw in `stable`.

### 7.2 `apply_opset`

`plan_not_convergent` when `converges` is false; `doc_missing`;
`stale_plan` (retriable, with the current revision and hash) when
`base_revision` (if non-null) differs from `current_rev` or the doc's
`file_hash` differs from `base_content_hash`; else `apply` with the plan's
kernel ops and `set_frontmatter`.

## 8. Errors

Codes: `stale_expectation`, `block_missing`, `target_missing`,
`parent_missing`, `doc_missing`, `cycle_move`, `not_contiguous`,
`type_mismatch`, `path_taken`, `node_not_editable`, `stale_plan`,
`plan_not_convergent`, `sync_conflict`. Fixtures compare the code and the
listed data fields (`op_index`, `block`, `current`, `retriable`); messages
are not pinned.

## 9. Fixtures

Observation scripts exactly as `spec/store` §9.4, with an in-memory doc
store (a path → bytes map that the runner also seeds from `observe` steps,
so file-CAS and the written bytes are checkable) and these steps:

```jsonc
{ "apply":    { "ts": "…", "ops": [...], "origin": { "actor": "agent:test", "reason": "…" }, "dry_run": false, "set_frontmatter": [...] } }
{ "macro":    { "ts": "…", "name": "tasks_complete", "args": {...}, "origin": {...} } }   // expands, then applies
{ "docs":     { "ts": "…", "actor"?: "…", "create" | "move" | "delete" | "set_meta": {...} } }
{ "plan":     { "ts": "…", "doc": "a.md", "content": "…", "apply": true, "origin"?: {...},
                "before_apply"?: [ <observe|disk steps run between plan and apply> ] } }    // stages stale_plan
{ "disk":     { "path": "a.md", "source": "…" } }                                   // a human edit landed on disk
```

`ts` (spec/store §2.4 format) is required on every committing step: the
implementations expose a clock seam (`ts` on the apply request, the doc-op
context and the opset request) so commit timestamps are pinned. Ops use the
spec spelling `child_ids`; the opset uses `base_revision`,
`base_content_hash`, `matcher_v`; plan ops keep their placeholders;
`diagnostics` strings are pinned verbatim.

`expect.steps` records per step: `apply` → `{ results, revisions, diffs?,
committed }` or `{ error: { code, op_index?, block?, current?, retriable? } }`
(only those data fields; `current.markdown` dropped beyond 200 UTF-8 bytes);
`macro` → `{ ops, hits?, pairs?, ...the apply outcome }`; `docs` → `{ doc,
path, committed }` (+ `dangling`, `retargeted` for a move) or the error;
`plan` → `{ opset, before_apply?, apply? }`; `disk` → `{}`. After the last step: `files` (path → bytes of the in-memory doc
store), and the `spec/store` §9.4 projection of `docs`, `blocks`,
`commits`, `revisions`, `dispositions`, `resurrection_pool`. The fixture
minter (`spec/store` §2.2) makes the op-minted `b` ids and the commit ids
comparable.

Suites: `ops.json` (each op, each error), `render.json` (list renumbering,
blockquote rebuild, table delimiter, tight/loose lists, nested items),
`changesets.json` (placeholders, multi-doc, cross-doc move, dry run,
atomicity on error), `commit.json` (api dispositions, known ids, deleted
prior ids pooled, file-CAS `sync_conflict` after a `disk` step),
`macros.json`, `docs.json`, `plan.json` (top-level lowering per case class,
retile, fallback to replace, non-convergent plan refused, stale plan).

**Runner checks**: every committed document satisfies `spec/store` §8 I1–I8
and `files[path] == reconstruct(doc)`; then the projection deep-equals
`expect`. **Generation**: `packages/core/corpus/mutate/spec.test.ts`,
`MUTATE_SPEC_UPDATE=1`. **Allowlist (Rust)**:
`crates/omgbase-mutate/tests/spec-passing.txt`, `MUTATE_SPEC_UPDATE=1`.

## 10. Reference oddities surfaced while specifying, and decisions

- **Fixed — `split.at` were UTF-16 indices.** The op said "byte offsets"
  (`docs/mutation-and-concurrency.md`) and sliced a JavaScript string. §2.5
  picks bytes; the reference converts.
- **Fixed — splitting a document's last block jammed the pieces.** The first
  piece kept its lone `\n`, the pieces rendered as one paragraph, and the
  minted id never landed (`ops::split-last-block-heals-seams`). §2.5 heals
  the seams like `update`'s extra siblings.
- **Fixed — a cross-document move could jam into the destination.** No seam
  healing ran on either document
  (`changesets::cross-doc-move-heals-seams`).
- **Fixed — a cross-document move left the block pooled.** The known-id
  resolver reported no `cross_doc_ids`, so the moved block stayed in the
  resurrection pool while live in its destination (the runner's I6 caught
  it) and the destination-first order collided on the block primary key.
- **Pinned — `parent_children_hash` is dead.** The CAS is defined and checked
  by a helper no op calls.
- **Pinned — error codes as thrown at the changeset level** differ from the
  op-level ones for the same fault (an unknown section heading is
  `parent_missing`, an empty `move` is `block_missing`, a changeset-level
  `block_missing` carries no `block`; an insert's document-inference errors
  carry no `op_index`; `split` with fewer than two pieces and `merge` with
  fewer than two blocks carry no data at all).
- **Pinned — planner diagnostics name a UTF-16 offset** in the reference
  (`first divergence at byte N` counts code units); a port counts bytes.
  Identical for ASCII, which is all the fixtures pin.
- **Port note — the freshness stat cache.** §4 step 5's "refresh the
  freshness stat cache" is the filesystem sync layer's concern
  (`spec/sync` §4.3); the Rust `DocStore` has no stat hooks until that
  layer is ported. Link-destination rewriting (`links_repair`, `docs_move`
  retargeting) lives in the store crate for now and is pure enough to move
  to `omgbase-graph`.
- **Pinned — trivia after `merge`/`remove`.** A merge keeps the survivor's
  trivia and drops the others'; a remove never touches the last remaining
  block's trivia; both can leave a trailing blank line.
- **Pinned — no-op changesets still commit.** An empty insert, or `checked`
  on a `list_item` with no checkbox, writes an identical revision.
- **Pinned — `isValidId` accepts 1–7 suffix characters** so a fixture-minted
  `d_0` dispatches as an id; production ids always have seven.
- **Pinned — mint order.** Op-supplied content mints every parsed block at
  parse time in pre-order, including blocks that are then unwrapped or
  discarded (a `list` wrapper whose items are spliced into a list keeps its
  minted id unused; a `list_item` wrapped from a bare block mints a second
  id). The fixture minter shows the gaps.
- **Pinned — commit-phase atomicity is per document.** A `sync_conflict` on
  the second document of a changeset leaves the first committed.
- **Pinned — a container update re-mints its children** unless `child_ids`
  is supplied; the planner supplies it, hand-authored changesets rarely do.
- **Pinned — `checked` on a `list_item` retypes it to `task`** even when the
  raw had no checkbox to rewrite.
- **Pinned — `docs_delete` pools nothing**, `spec/store` §5.6 pools
  everything: intentional vs observed deletion.
- **Pinned — the YAML emitter.** `docs_create`/`docs_set_meta` serialize
  frontmatter with the `yaml` npm package's `stringify` defaults (two-space
  indent, block sequences, plain scalars where legal, `null` as `null`).
  Fixtures pin flat mappings of strings, numbers, booleans and string lists
  only; anything a port's emitter formats differently is out of the
  fixtures.
- **Pinned — `docs_move` records a commit with no revision**, so a doc's
  revision `seq` does not advance on a move although `revisions.path` is
  rewritten in place for the current revision only.

## Decisions

- 2026-09-26, mutation 1.0 specified as built (one fix: byte offsets in
  `split`). The crate is pure (tree, ops, render, lowering, opset); the store
  owns loading, the commit protocol, macros and document operations because
  they read and write the database and the doc store.
