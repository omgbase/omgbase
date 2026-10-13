# The omgbase mutation specification

Mutation is how the store is *written to on purpose*: six kernel operations
over a document's block tree (insert, update, move, remove, split, merge),
applied as an atomic changeset, rendered back to bytes by splice, committed
as an `api`-origin revision whose block identities are the ones the
operations chose — never re-derived from the bytes — and then written to
the file from the recorded intent. On top
of the kernel sit deterministic macros, the document-level operations
(create, move, delete, set-meta) and the whole-document update planner that
turns a proposed complete document into an inspectable opset. This directory
specifies all of that so that two engines, given the same database and the
same changeset, produce the same bytes, the same rows and the same errors.
It is owned by neither implementation.

| Implementation | Where | Role |
| --- | --- | --- |
| `@omgbase/core` (TypeScript, npm) | `packages/core/src/mutate/{tree,ops,apply,commit,materialize,load,known-ids,macros,docs,doc-store,plan-update,lower,opset,effects,plan,select}.ts` | **Reference.** Mutation decisions land here first. |
| `omgbase-mutate` (Rust, crates.io) | `crates/omgbase-mutate` | Conformance-first port: the working tree, the six ops, the splice renderer, the lowering and the opset, the effect vocabulary with its conflict rules, lowering and canonical JSON (pure); `omgbase-store` loads, commits, plans and runs the macros, the document operations and the effect planner's `plan`/`execute`; `omgbase-surface` compiles a selector (§11.8) over its OQX binding. |

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

- `parent: <id>` → the block's `children`; unknown → `parent_missing`. The
  block must be a **container** — a kind whose children the parser produces
  (Markdown: `list`, `list_item`, `task`, `blockquote`, `table`; other
  formats: any block with children); a leaf kind (`heading`, `paragraph`,
  `code_fence`, `table_row`, `thematic_break`, `html_block`, `opaque`,
  `frontmatter`) is `type_mismatch` with `{ op_index, block, type }` and
  the message `<id> is a <type>, not a container; place relative to it with
  at.before/at.after or append to its section` — since 1.2 (§10: before it
  the insert landed in the leaf's empty `children`, the dirty leaf then
  re-rendered from its children, and the heading's own text was **lost**).
  The same resolution serves `move`, so a move into a leaf is the same
  error.
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
expected_content_hash?, current: { hash, markdown: raw }, retriable:
true }` — the caller can retry from the error without a read (`current.hash`
is the block's current hash under the row rule of `spec/surface` §1.2, 2.0;
`expected_content_hash` echoes the caller's argument and keeps its name).
`check_parent_children_hash(parent, expect)`: when `expect.parent_children_hash`
is given, the parent's **live direct children** (ids in order, joined by
`,`, sha256, hex; the document top level when `parent` is null) must hash to
it, else `stale_expectation` with `{ op_index, current: {
parent_children_hash }, retriable: true }`. Which parent: `update`, `split`
and each block of `remove`/`merge` (their per-block `expect[id]`) check the
block's **current** parent; `insert` and `move` carry an op-level `expect`
and check the **destination** parent (`to.parent`, resolved as the op does,
so a sibling anchor names its parent) — a way to say "insert here unless the
siblings changed under me". Checked after `content_hash`, before the op
mutates the tree; a `move` with several blocks checks the destination once.
Since 1.1 (§10: the reference defined the hash and checked it nowhere).

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

### 2.3 `move { blocks, to, doc? }` → `{ ids: blocks }`

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
merged into it). `doc` (3.0) names the destination document of a top-level
`start`/`end` placement (`to.parent = { doc: true }`), which otherwise means
the SOURCE document's top level (§4 step 1; §10 "Fixed (3.0)"); an anchored
`at` infers the destination from the anchor and `doc` is not consulted. Like
`insert.doc`, it accepts a document symbol of the request (§11.4).

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
Request  { repo, ops, origin: { actor, reason? }, dry_run? }
Result   { results: [{ ids, removed?, merged_into? }], revisions: [{ id, path, hash }], diffs?: { path: { before, after } }, committed }
```

1. Resolve placeholders against earlier results (`target_missing` when the
   index is out of range). Find each op's document: `insert.doc` (an id
   passes through, a path resolves, a document symbol of the request's
   created documents is that document — §11.4, 3.0 — else `doc_missing`) or the placement's
   block/heading/anchor (`parent_missing`, no data; a top-level
   `start`/`end` insert with no `doc` → `target_missing`);
   `update`/`remove`/`split`/`merge` by their first block (`block_missing
   { op_index }` — no `block` field at this level; an op-level miss, such
   as `remove`'s second id, carries `block` too); `move` by its first block, the
   destination by `to` unless `to` is `{ doc: true }` with `start`/`end`
   (the document `move.doc` names, else the same document — 3.0). A document
   is loaded once, at first touch, and its pre-mutation render and live id
   set are remembered.
2. (3.0) The request has no frontmatter side channel. A document's **head**
   — everything before its first block: the leading trivia and the
   frontmatter with its fences and separator — is set by the effect planner
   (`set`/`unset frontmatter.<key>`, `set content`, §11.3; the plan's
   `opset.set_frontmatter[]`) and replayed by `execute` before the ops.
   Through 2.x `set_frontmatter: [{ doc, raw | null }]` on the request
   replaced `frontmatter_raw` before any op (§10).
3. Apply the ops in order (§2); any error aborts the whole request with
   nothing written.
4. For every loaded document: `diffs[path] = { before, after: render }`,
   `revisions` gets `{ id, path, hash }` — the document, its path (this
   spec's storage form; the surface roots it) and `hex(sha256(render))`, the
   hash the committed revision will carry (2.0; `{ doc, path }` before).
   `dry_run` returns here with `committed: false`.
5. **Commit**, under the writer lock when a workspace is given (2.1; per
   document before). Database first, files after, nothing written before
   the transaction commits (2.2; files were written before the transaction
   through 2.1 — §10):
   - **(a) reads**, outside the transaction: for every path the request
     touches, a `pending_materializations` row an earlier request left
     there (`spec/store` §5.7 — a crash, a refused write) is replayed
     first, so the file is read as the engine left it and not as a human
     edit; then the bytes on disk of every loaded document are read (a
     headless doc store has none) — read, not compared: the comparison is
     (b)'s;
   - **(b) one transaction**, opened `BEGIN IMMEDIATE` so the writer's lock
     on the database is held from the first statement: **first re-validate**
     — for every loaded document re-read `(path, current_rev, file_hash)`
     through the transaction and compare with the values the plan loaded in
     step 1; a document that moved on → ROLLBACK before anything is minted,
     `stale_plan { doc, expected_revision, current: { revision, hash } }`
     (retriable); a `file_hash` that does not equal the hash of the bytes
     read in (a) → ROLLBACK, `sync_conflict` (retriable; the bytes are then
     ingested as `observed` in their own transaction, with any pending row
     at the path dropped — the file won); the document operations re-check
     their own guards the same way (`path_taken` for a create and for a
     move's destination, `doc_missing` for a move's source and a delete).
     Only then one commit row (`origin = "api"`, `actor`, `reason`,
     `checkpoint_id = NULL`, `ops` = the intent record of an effect-driven
     commit — the canonical JSON (§11.5) of `{ v: 1, plan_id, effects }`,
     the plan's resolved effects — and NULL for every other request, 2.3;
     ADR-003), then per document in load order
     `spec/store` §5.4 steps 1–4 and 6–13 naming that commit (`spec/store`
     §5.4 "The api path") with the **known-id resolver**: the re-parsed body
     gets the tree's ids by positional key (`"/i/j"`; a position with no id
     mints — impossible under the round-trip law), dispositions `{ kind:
     edited if the id was live before else inserted, confidence: 1, reason:
     "api", matcher_v: null, detail: {} }` for every block (there is **no
     `deleted` disposition row** on the api path), `deleted` = the prior
     live ids no longer present (pooled per `spec/store` §5.4 step 7), and
     `cross_doc_ids` = the ids new to this document that were live elsewhere
     (a cross-document move), so step 8 evicts the source's row whichever
     document commits first (§10). A document the request **creates** (3.0:
     the effect planner's adopted tree, §11.3) commits through this same
     known-id ingest with no triple to re-validate — its guard is
     `path_taken`: no live document at the path when the transaction
     validates (the planner's check re-run) — the ingest minting its `d`
     inside the transaction, its blocks carrying the ids the request minted
     before it, every disposition the api rule's `inserted / 1 / api / null`
     (through 2.x a create was a reconciling ingest and its dispositions
     carried a matcher version — §10 "Changed (3.0)"); finally one **pending row** per file the
     request owes the disk (`spec/store` §5.4 "The api path (14.0)": `write`
     per ingested document with its new revision and rendered hash; the
     document operations' `rename`/`remove` rows, §6). COMMIT. Mint order:
     one `c`, then per document `r`, `x`, `e`. A failure anywhere in (b)
     rolls back every document — no commit row, no revision, no block row,
     no pending row, no file touched;
   - **(c) materialize**, after COMMIT, in effect order: each pending row the
     request recorded is materialized through the doc store (`spec/store`
     §5.7 — the rendered bytes written atomically, temp file fsynced then
     renamed; a moved file renamed; a deleted file unlinked if it still
     holds the deleted revision's bytes), the freshness stat cache refreshed
     for each file that landed, and the row deleted as its file is done.
     The bytes the materializer may overwrite are the ones (b) validated the
     file against (the prior `file_hash`); a file a human changed in
     between keeps its row and the next observation lets it win. A crash or
     a failed write here leaves the commit durable and the remaining rows
     pending for the next materializer (the sweep's step 0, recovery, the
     next request touching the path — `spec/store` §5.7).
   `committed: true`.

Atomicity is per request, in the database: one transaction, one `commits`
row, one revision per loaded document (2.1; one transaction and one commit
per document before — `commit::conflict-on-third-doc-commits-nothing`,
`changesets::multi-doc-changeset`). The files are eventually consistent
through the recorded intent (2.2; `materialize::apply-crash-then-materialize-
finishes`): no atomicity across the database and the disk is claimed.

## 5. Macros

Each expands to kernel ops, deterministically, and the expansion is what
runs and what the caller sees. The names below are the macros'; the MCP tools
rendering them (surface 3.0) are `blocks_check { ids }` for `tasks_complete`,
`nodes_set { id }` for `node_set`, and — `sections_append` has no tool of its
own since 3.0 — `docs_append { section }` and `blocks_append { id }` for
`sections_append`:

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

All are `api` commits with a generated `reason`. Since 3.0 the four
operations ARE effects of §11 — `docs_create` one `create`, `docs_move` one
`move` of a document, `docs_delete` one `remove` of a document,
`docs_set_meta` one `set`/`unset frontmatter.<key>` per key (`unset` winning
a key named in both) — planned and committed by the effect planner under the
reasons below (the surface's tools since `spec/surface` 3.3; the library's
functions and the `docs` fixture step at 3.0). Two consequences of the planner
(§11.3): a created document commits with **known ids** (`inserted / api`, no
matcher), and a `set_meta` is a head write (`edited / api` for every block of
the document) — §10. This section states what each operation does and the
rows and files it leaves.

- **`docs_create { path, markdown, frontmatter? }`**: canonicalize the path
  (strip leading `/`, `\` → `/`); a live doc there → `path_taken`; compose
  the file (body with a trailing `\n` ensured; when `frontmatter` is a
  non-empty object: `"---\n" + yaml + "\n---\n" + ("\n" unless the body
  starts with one) + body`, `yaml` being the mapping serialized by the
  reference's YAML emitter — §10); a file already on disk → `path_taken`;
  parse the composed file into the planner's working tree (§11.3 `create`)
  and commit it with the **known-id** ingest (`reason: "create <path>"`;
  3.0 — the reconciling resolver through 2.x) under §4 step 5's commit, the
  `path_taken` guard re-checked in the transaction, recording a `write` row; the file is written in
  (c) only if the path is still absent (or already holds the bytes) — a
  foreign file that appeared keeps the row and the next observation lets it
  win (`spec/store` §5.7).
- **`docs_move { doc, to_path, retarget_inbound? = true }`**: `doc_missing`;
  `path_taken` if a live doc or a file exists at the destination; the
  inbound links that name the old path are read and, unless
  `retarget_inbound` is `false`, the deepest hit block per inbound link is
  rewritten in memory as §4 steps 1–4 (relative forms against the source's
  current directory; the moved document, when it links to itself by path,
  is a source too and renders under the NEW path); then **in one
  transaction with the retarget** (2.1): one `api` commit (`reason: "move
  <from> -> <to>"`), `docs.path` and the current revision's `path` updated,
  every open edge from **another** document into this one re-pointed to
  `phantom:<old path>`, a self-document edge re-pointed only when its link
  names the path (a pure fragment stays), affected rollups rebuilt,
  phantoms at the new path adopted, then each rewritten source's revision
  as §4 step 5(b) under that same commit (so its links resolve to the moved
  document, not a phantom), and the pending rows (2.2): a `rename` row at
  the new path (`from_path` = the old one, `rendered_hash` = the moved
  document's current revision — the retargeted one when it is a source
  itself) plus a `write` row per other rewritten source. (c) renames the
  file (`spec/store` §5.7: a destination that appeared with foreign bytes
  keeps the row and wins; an old file that vanished is replaced by the
  revision's bytes written at the new path; a self-linking source's renamed
  file is rewritten with its new bytes), clears the old path's stat row and
  records the new one's — a move means "same document, new place", so the
  authored links follow it by default (1.3); `retarget_inbound: false` is
  the opt-out for the rarer intent that the old path become unbound (the
  commit then carries no revision). Before 2.1 the retarget was a second
  commit (`reason: "retarget inbound links <from> -> <to>"`); that reason
  no longer appears in history. The result lists the still-dangling inbound
  links (with the default: the frontmatter relations, which are never
  rewritten — `docs_set_meta` them) and, when the rewrite ran, `retargeted
  { blocks, docs }` (empty lists when only frontmatter relations linked in;
  `null` when it was opted out or nothing linked in).
- **`docs_delete { doc }`**: `doc_missing`; one transaction: `api` commit
  (`reason: "delete <path>"`), FTS rows dropped, live blocks and the doc
  tombstoned — **nothing pooled** (an intentional delete, unlike `spec/store`
  §5.6) — and a `remove` row naming the deleted revision's rendered hash
  (2.2); (c) unlinks the file **iff** it still holds those bytes (a file a
  human rewrote meanwhile stays, untracked) and clears its stat row. Through
  2.1 the unlink ran unconditionally after the transaction, and a crash
  between the two left a file no sweep healed.
- **`docs_set_meta { doc, set?, unset? }`**: read the file, split the
  frontmatter with `^---\r?\n([\s\S]*?)\r?\n---\r?\n?` (malformed → `{}` and
  the whole content as body), merge `set`, delete `unset`, compose (as
  create) and commit the composed file's **head** over the document's
  blocks (§11.3 `set`/`unset frontmatter.<key>`: the body blocks keep their
  ids and bytes, each `edited / api`; 3.0 — a reconciling re-ingest of the
  composed file through 2.x)
  (`reason: "set_meta <path>"`) under §4 step 5's commit — a `write` row like
  `apply`'s: the in-transaction re-validation of (b) applies to the bytes
  the patch was computed from (2.2; before, `set_meta` checked nothing and
  could overwrite a concurrent edit). Unsetting every
  key leaves the body's
  leading blank line in place (`leading_trivia` becomes `"\n"`, §10).

## 7. Whole-document update

`plan_update(doc, content)` → `Opset`:

```text
Opset { version: 1, kind: "doc_update", target: { id, path },
        precondition: { id, path, base_revision, hash },
        matcher_v, ops: [PlanOp], frontmatter?: { raw | null },
        summary: { preserved, updated, moved, created, removed, split, merged, ambiguous },
        converges, diagnostics: [string] }
PlanOp { op, disposition, blocks, confidence, reason, detail? }
```

Since 3.0 the opset is the planner's **internal** result: the `set content`
effect (§11.3) runs `plan_update`, splices its kernel ops into the plan and
surfaces its annotations as the plan's `preview.identity[<doc id>]` (§11.4)
— `{ matcher_v, summary, ops: [{ op_index, disposition, blocks, confidence,
reason, detail? }], diagnostics }`, `op_index` the op's index in the plan's
`opset.ops`; `converges: false` is `plan_not_convergent`. No request accepts
or returns an opset (2.x: `apply_opset`, the surface's `docs_update { opset,
plan, result }`). The `plan` fixture step (§9) still records it, so the
lowering stays pinned on its own.

1. Load the doc (`doc_missing`); `precondition.hash = sha256(render(doc))`
   (the document's current `hash`), `base_revision = current_rev` (2.0:
   `target`/`precondition` spelled `doc`/`path`/`base_content_hash` before).
2. Parse `content` per the doc's format; split off the frontmatter block;
   reconcile the body against the doc's stored tree (`spec/reconcile`, the
   configured matcher, **no pool**).
3. `frontmatter` = `fm.raw + fm.trivia` (or null) when it differs from
   `frontmatter_raw`.
4. **Lower** (§7.1) to candidate ops; **verify** by replaying the candidate
   through the in-memory planner of §4 steps 1–4 with the head
   `leading_trivia + frontmatter.raw` set first when the frontmatter changes
   (3.0; a dry-run `apply` with `set_frontmatter` before): the rendered
   result must equal `content` byte for byte. The top-level lowering is tried first; if it does not converge, a
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

### 7.2 Committing (3.0)

The opset is committed only as the `set content` effect's lowering (§11.3):
`plan_not_convergent` when `converges` is false; the ops spliced into the
plan (placeholders shifted), `frontmatter` as the document's head; the
document's triple in `preconditions.docs` — a document that moved on is
`stale_plan` (retriable, `{ doc, expected_revision, current: { revision,
hash } }`) when the plan executes. An opset with no ops and no frontmatter
change loads nothing: the plan has nothing to commit and `execute` records
no commit (§11.7, the zero-effects rule). `apply_opset` (2.x: `doc_missing`
/ `stale_plan` on `base_revision` + `hash`, then `apply` with the ops and
`set_frontmatter`) is gone.

## 8. Errors

Codes: `stale_expectation`, `block_missing`, `target_missing`,
`parent_missing`, `doc_missing`, `cycle_move`, `not_contiguous`,
`type_mismatch`, `path_taken`, `node_not_editable`, `stale_plan`,
`plan_not_convergent`, `sync_conflict`, and (2.3, §11) `conflicting_effects`
(`{ effects: [i, j], focus: { kind, target, field? }, retriable: false }`),
`unsupported_plan_version` (`{ version, supported: [1] }`), `plan_mismatch`
(`{ expected, actual }`, two plan ids), and (3.1, §11.8) `ambiguous_target`
(`{ effect_index, template_index, row: { id, path }, expression, count }` —
a target expression yielded a list), `selection_too_large` (`{ cardinality,
max, implicit? }` — more hits than the bound). A malformed effect or plan
object is the surface's argument-shape error `filter_invalid { reason, hint:
"arguments" }` (`spec/surface` §4), thrown by the planner; a selector or a
template the admission pass of §11.8 refuses, or a slot whose expression
yielded a value of the wrong type, is `filter_invalid { reason, hint:
"selection" }`. Fixtures compare the code and the listed data fields
(`op_index`, `block`, `current`, `retriable`, and since 2.3 `effect_index` —
the index of the effect a planner error arose from, added to every error the
planner or its kernel ops raise — `effects`, `focus`, `symbol`, `version`,
`supported`, `expected`, `actual`, since 3.1 `template_index`, `row`,
`expression`, `count`, `cardinality`, `max`, `implicit`, and since 3.3
`fix`); messages are not pinned.

**`fix` (3.3).** An error the engine can correct mechanically carries
`data.fix`: a **literal corrected call** — the arguments the caller should
send instead, as the canonical JSON of §11.5 (so both engines compose the
same bytes; the members `select`, `effects`, `expect` appear only when the
corrected call has them, in canonical key order), prefixed by a tool's name
and one space when the corrected call is to another tool (`spec/surface`
§9). It is built from the request that failed and from what the engine saw —
never from a prose template with a hole left in it — and is the second of
the three teaching surfaces (the ladders of `spec/surface` §4 are the first,
the `summary` of §11.9 the third). The table; an error not listed, or one
whose correction cannot be computed (a `$new.n` with no later `create`, a
list whose first identity is not a string or a row), carries no `fix`:

| Error | `fix` |
| --- | --- |
| `conflicting_effects` on a plain request | the same `effects` minus the **earlier** of the two (keep the later effect, as written) |
| `conflicting_effects` under a selector, two hits | the request narrowed to the later effect's hit: `select` = `from <root> where id == "<hit id>"` (`<root>` by the id's prefix), the templates as written, `expect: { max: 1 }` |
| `conflicting_effects` under a selector, one hit | the request minus the earlier effect's template |
| `ambiguous_target` | the slot's member spelled as the **first** identity the expression yielded (a row by its `id`); under a selector the `select` is narrowed to the hit as above with `expect: { max: 1 }` |
| `selection_too_large` | the same request with `expect: { max: <count> }`, `<count>` the selection's exact size — the page the engine refused when it was `bound + 1` rows, else a second, unbounded run of the same compiled query |
| `filter_invalid` "`expect.max` is required on `apply` with `select`" | the same request with `expect: { max: <cardinality> }`, the selector compiled (reads only) to count it — a selection the compile refuses reports its own error and fix |
| `filter_invalid` on a refused selector source (§11.8 step 1: `links`, or a source that is not a bare root) | the same request with the source spliced over its span in the written query: `links` → `blocks` (a link lives in a block), anything else → `docs` |
| `filter_invalid` "`-> ` is not allowed here" (§11.8 "Sugar", a leader in a slot that takes no expression) | the literal form: the same request with that member spelled literally — a quoted string literal or an interpolation-free template literal folded to its text (as constant folding folds it), anything else the rest of the string after the leader |
| `stale_plan` at plan time (an `expect.revision` that no longer holds) | the same request with that effect's `expect.revision` set to the document's current revision |
| `stale_plan` at execute; `plan_mismatch` on the plan form | re-plan and commit in one call: `apply` over the plan's selector form `{ select: selection.query, effects: selection.templates, expect: selection.expect or { max: selection.cardinality } }` when it has a `selection`, else `{ effects: <the plan's effects> }` (none when the plan has no effects — `apply` takes at least one) |
| `plan_mismatch` on the digest form | `apply` over the request as given: `{ select?, effects, expect? }` |
| `target_missing { symbol }` for a `$new.n` no earlier effect created, on a plain request with a later `create` | the next `create` moved before the effect that uses the symbol, that symbol renamed to the one the create will then allocate (`$new.<symbols allocated so far>`) |
| `filter_invalid` (3.4) "`at` must be … — "after block X" is into: X's parent …": `at` given as the bare string `"after"` / `"before"` on an `insert` or a block `move` whose `into` is a block | the same request with that effect's `into` replaced by the block's **parent** — `{ kind: "block", id: <parent id> }`, or the document's rooted path (`"/a.md"`) when the block is top-level — and `at: { after: <the block id> }` / `{ before: … }`. The one shape fix that reads the store (the block's live `blocks` row: `parent_block`, its document's path); an `into` that is not a live block (a `$new.n`, an unknown id, a document) gets no `fix` |
| `filter_invalid` (3.4) "a plural-target `expect` is keyed by block id — { <block id>: { content_hash?, parent_children_hash? }, … }": a `remove`/`merge` `expect` whose every key is a guard name (`content_hash` / `parent_children_hash`) and every value a map of strings | the same request with the nesting inverted: `{ <id>: { <guard>: <value> }, … }` (the guards of one id merged into its object) |
| `filter_invalid` (3.4) "`expect.max` bounds a selection — it is the request's top-level `expect`, beside `select`, not an effect's": `max` inside an effect's `expect` (any op) | the same request with `max` dropped from that effect's `expect` (the other guards stay; an emptied `expect` goes) and, when the request has a `select`, `expect.max` set at the top level to that value — unless the request already has a top-level `expect.max`, which is kept as written; without a `select` nothing is added (a top-level `expect` alone would itself be refused) |
| `filter_invalid` (3.4) "a block's `field` is `markdown` or `attrs.checked` (got …)" with `field` one of `text`, `content`, `body`, `raw` on a literal block target | the same request with that effect's `field: "markdown"`; any other block field (a `title`) gets the error and no `fix` |

The four shape fixes (3.4) are built by the shape check itself — the
reference's `effects.ts` `validateEffect` given a `ShapeFixContext { request,
parentOf }` by the planner's compile (`select.ts` `compilePlain`, and
`admitTemplate` for a selector's templates, where `parentOf` finds nothing
because a template's `into` is bound per hit); the port's `omgbase-mutate`
shape check with the store's row lookup supplied the same way. The corrected
effect is spelled from the effect **as written** in the request (`effects[i]`
before desugaring); under a selector `i` is the template's index. The
surface composes three more (`spec/surface` §9: `block_not_container`,
`parent_missing` and `ambiguous_heading` on the append tools) and one of its
own on a comma-joined string-list argument (`spec/surface` §4 "Arguments").
The `fix` is pinned by the fixtures like any data field
(`effects::conflicting-*`, `select-*`, `sugar-*`, `shape-*`, `plan::stale-plan`, …).

## 9. Fixtures

Observation scripts exactly as `spec/store` §9.4, with an in-memory doc
store (a path → bytes map that the runner also seeds from `observe` steps,
so file-CAS and the written bytes are checkable) and these steps:

```jsonc
{ "apply":    { "ts": "…", "ops": [...], "origin": { "actor": "agent:test", "reason": "…" }, "dry_run": false } }   // the kernel (§4); no `set_frontmatter` since 3.0
{ "macro":    { "ts": "…", "name": "tasks_complete", "args": {...}, "origin": {...} } }   // expands, then applies
{ "docs":     { "ts": "…", "actor"?: "…", "create" | "move" | "delete" | "set_meta": {...} } }   // §6: the effect builders (3.0)
{ "plan":     { "ts": "…", "doc": "a.md", "content": "…", "apply": true, "origin"?: {...},
                "before_apply"?: [ <observe|disk steps run between plan and apply> ] } }    // `apply` commits the content as `apply_effects [set content]` (3.0)
{ "disk":     { "path": "a.md", "source": "…" } }                                   // a human edit landed on disk
{ "materialize": {} }                                                                // replay every pending row (spec/store §5.7) → { materialized: [path…] }
{ "plan_effects": { "effects": [...], "select"?: "<OQX>", "expect"?: { "max": n } } }  // §11.6 `plan` → { plan } (minus preview) or the error; `select` makes the effects templates (§11.8)
{ "execute": { "ts": "…", "plan_step": 1 | "plan": {...} | "plan_id": "…", "effects": [...], "select"?: "…", "expect"?: {...},
               "origin": {...}, "crash_after_commit"?: true } }                     // §11.7 → { receipt } or the error (the digest form re-runs the selector)
{ "apply_effects": { "ts": "…", "effects": [...], "select"?: "…", "expect"?: {...}, "origin": {...}, "dry_run"?: true } } // §11.7 → { plan } (dry run) | { receipt } | the error
{ "canonical": { "value": <any JSON> } }                                             // §11.5 → { json: canonical(value), digest: hex(sha256(json)) }
```

The effect steps (2.3): `plan_effects` plans and records the Plan without
its `preview` (so `plan_id`, `opset`, `preconditions`, `new_ids`,
`diagnostics` and the resolved `effects` are pinned); `execute` takes the
plan form — `plan_step` names an earlier `plan_effects` or dry-run
`apply_effects` step whose full plan (preview included) is handed back, or
`plan` is an authored plan object — or the digest form (`plan_id` +
`effects`), and records the Receipt; `apply_effects` records the Plan
(`dry_run`) or the Receipt; `canonical` is the digest vector step. The
`plan_effects`/`canonical` steps have no `ts` (nothing commits);
`execute`/`apply_effects` are committing steps and may `crash_after_commit`.

A committing `apply` / `macro` / `docs` step may carry `"crash_after_commit":
true` (2.2): the process dies after its transaction committed and before the
first file operation — the doc store's next write/rename/remove throws, the
runner records `{ crashed_after_commit: true }` (the caller never saw a
result), and the pending rows and the old files stay for a later step to
observe or `materialize`. A step that errors before committing never reaches
a file operation and records its error as usual.

`ts` (spec/store §2.4 format) is required on every committing step: the
implementations expose a clock seam (`ts` on the apply request, the doc-op
context and the opset request) so commit timestamps are pinned. Ops use the
spec spelling `child_ids`; the opset uses `base_revision`, `hash`,
`matcher_v`; plan ops keep their placeholders;
`diagnostics` strings are pinned verbatim.

`expect.steps` records per step: `apply` → `{ results, revisions, diffs?,
committed }` or `{ error: { code, op_index?, block?, current?, retriable? } }`
(only those data fields; `current.markdown` dropped beyond 200 UTF-8 bytes);
`macro` → `{ ops, hits?, pairs?, ...the apply outcome }`; `docs` → `{ doc,
path, committed }` (+ `dangling`, `retargeted` for a move) or the error;
`plan` → `{ opset, before_apply?, apply?: { receipt } | { error } }` (3.0; the
apply half recorded an apply result through 2.x — a stale plan is now staged
through `plan_effects` → `observe` → `execute`, `plan::stale-plan`); `disk` → `{}`; `materialize` →
`{ materialized: [path…] }` (the rows cleared, in insertion order; a row kept
for a foreign file is not listed); `plan_effects` → `{ plan }` or the error;
`execute` → `{ receipt }` or the error; `apply_effects` → `{ plan }` /
`{ receipt }` / the error (the Receipt whole, its `summary` included — the
one place §11.9's lines are pinned, since a recorded Plan omits its
`preview`); `canonical` → `{ json, digest }`. After the last step: `files` (path → bytes
of the in-memory doc store), and the `spec/store` §9.4 projection of `docs`,
`blocks`, `commits`, `revisions`, `dispositions`, `resurrection_pool`,
`pending_materializations` (14.0; `[]` unless a step crashed). The fixture
minter (`spec/store` §2.2) makes the op-minted `b` ids and the commit ids
comparable.

Suites: `ops.json` (each op, each error), `render.json` (list renumbering,
blockquote rebuild, table delimiter, tight/loose lists, nested items),
`changesets.json` (placeholders, multi-doc, cross-doc move, dry run,
atomicity on error), `commit.json` (api dispositions, known ids, deleted
prior ids pooled, file-CAS `sync_conflict` after a `disk` step),
`macros.json`, `docs.json`, `plan.json` (top-level lowering per case class,
retile, fallback to replace, non-convergent plan refused, stale plan),
`materialize.json` (2.2: a crash after COMMIT and what each later step — a
`materialize`, an observation of the stale, the rendered, new or absent
file, a second request — does with the pending rows, for `apply`, `create`,
`set_meta`, `delete` and `move`), `effects.json` (2.3, §11: every lowering
row once, each conflict rule, `plan` → `execute` vs the one-shot `apply`,
the dry run that burns no id, `stale_plan` after an observation and on
replay, the digest form equal and mismatched, an unsupported plan version,
an edited plan, a crash after COMMIT, `set frontmatter` byte parity with
`set_meta`, `$new.n` references, `create` + `set` on the created document,
`move document` with the default and an explicit `retarget`, and the digest
vectors; 3.0 adds writing INTO a created document — `create-then-insert-
into-new-doc`, `create-then-insert-into-new-section`, `create-then-move-
block-into-new-doc`, `create-then-set-markdown-on-new-block`, `create-then-
remove-new-block` — and `insert-into-symbol-before-create-is-target-missing`;
3.1 adds the selector cases of §11.8, every name prefixed `select-`: the
rollup of two workstreams into one hub through `plan` → `execute`, the
cross-hit scalar collision and its identical twin that dedupes, zero hits,
`expect.max` exceeded, an expression target yielding nothing and one
yielding a list, a `blocks` and a `nodes` selection, a user alias read by a
template, `order by` fixing the insert order, each admission refusal
(`offset`, `values`, `links`, `distinct`, `count`, `follow`, a body `from`, a
`retarget` template, a reserved alias, `{ oqx }` out of a slot), `apply`
without `expect.max`, a `create` per hit, the digest form of `execute`
refusing a plan whose selection gained a hit, and the p3 digest vectors;
the ceiling case is a reference unit test — a thousand-document fixture
would dwarf the suite; 3.2 adds the sugar cases of §11.8 "Sugar", every
name prefixed `sugar-`: the worked example spelled with the leader
(`into: "-> project"`), a template-literal markdown, a typed value
(`-> priority + 1` a number), a literal without the leader left untouched,
a literal that begins with the leader, constant folding to one `plan_id`, a
bare path / id / `$new.n` target, a locator refused, a bad expression, the
leader in a non-expression slot, and the selector-less branch on a
document, on blocks, over two targets (two synthetic queries, `templates`
in the intent record) and refused on a `create`); 3.4 adds the shape-fix
cases of §8, every name prefixed `shape-`: the bare `"after"`/`"before"`
anchor on a nested block (the fix's `into` a block), on a top-level block
(a rooted path), on an unknown block and on a document (no fix), and on a
block `move`; the guard-first plural `expect` inverted (and the fix planned
as given); an effect-level `expect.max` moved beside `select`, kept when
the request already bounds the selection, dropped without a `select`; a
block `field` of `text` and of `content` (`markdown`), an unknown one (no
fix), and a `text` template under a selector (the template rewritten).

**Runner checks**: every committed document satisfies `spec/store` §8 I1–I8
and `files[path] == reconstruct(doc)` — a path a `disk` step rewrote, or one
with a pending row, is compared against the store's own reconstruction
instead; then the projection deep-equals `expect`. **Generation**: `packages/core/corpus/mutate/spec.test.ts`,
`MUTATE_SPEC_UPDATE=1`. **Allowlist (Rust)**:
`crates/omgbase-mutate/tests/spec-passing.txt`, `MUTATE_SPEC_UPDATE=1`.

## 10. Reference oddities surfaced while specifying, and decisions

- **Fixed (1.2) — an insert or move into a leaf block destroyed it.** `to.parent`
  naming a heading (or any leaf) resolved to its empty `children`; the block
  landed there, the leaf was marked dirty and re-rendered from its children,
  and its own text vanished from the file — the CLI spec had even pinned the
  visible result ("a heading target places the block right after the
  heading") without seeing that `## Risks` was gone. §1.1 now requires a
  container parent (`type_mismatch` otherwise: `ops::insert-into-heading-is-
  type-mismatch`, `ops::move-into-paragraph-is-type-mismatch`); the CLI's
  `insert <heading>` surfaces that error with its hint (`spec/cli`
  `mutate::insert-to-heading`).
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
- **Pinned — a per-block `expect[id]` on `remove`/`merge` still needs
  `content_hash`.** Those ops CAS-check any `expect[id]` given, and §1.2
  makes a missing `content_hash` a `stale_expectation`, so an order-only
  expectation there fails on the content hash first; `update` honors an
  order-only `expect` when no `markdown` is given. The sugar tools
  `blocks_insert`/`blocks_move` do not expose `expect` (unpinned; `apply`
  does).
- **Fixed (1.1) — `parent_children_hash` was dead.** The CAS was defined and
  checked by a helper no op called, so a client that sent it was silently
  unprotected. §1.2 now says which parent each op checks; `insert` and
  `move` gained an op-level `expect` for the destination parent.
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
- **Fixed (2.1) — commit-phase atomicity was per document.** A
  `sync_conflict` on the second document of a changeset left the first
  committed, each document minted its own `commits` row, and a `docs_move`
  with retargets was two commits. A changeset is now one transaction, one
  commit, N revisions (`commit::conflict-on-third-doc-commits-nothing`:
  the file-CAS of the third document fails before any file is written, so
  the first two keep their bytes and rows and only the dirty file's
  `observed` commit lands; `changesets::multi-doc-changeset`,
  `docs::move-retarget-inbound`).
- **Fixed (2.2) — every precondition was checked outside the transaction.**
  Block CAS, parent-children CAS and the file-CAS ran on the snapshot step 1
  loaded, on the autocommit connection, before the transaction opened; only
  the writer lock kept another writer out of the gap, and a library caller
  without a workspace (no lock) could commit over a moved document.
  `spec/store` §8 I3 makes a document's `current_rev` the version vector of
  every live block, so (c) re-reads one triple per document — the opset
  precondition's shape — under `BEGIN IMMEDIATE`, before minting. No
  fixture moves: a fixture's conflicts arise from a `disk` step before the
  request, and plan and commit are one step.
- **Fixed (2.2) — a failed commit left every written file ahead of the
  database.** Through 2.1 §4 step 5 wrote the files (b) before the
  transaction (c); a failure inside the transaction rolled the database back
  and the files stayed as rendered, so the next observation of each healed
  it as an `observed` commit through the reconciling resolver — the intent's
  actor, reason and known ids lost for that document — and a conflict found
  inside the transaction had already overwritten a file. The order is now
  database first (§4 step 5): the transaction records a pending row per
  file (`spec/store` §5.7, store 14.0) and the files are materialized after
  COMMIT; a crash leaves the commit and replays the files
  (`materialize::apply-crash-then-materialize-finishes`), a human edit that
  lands in the window keeps its file (`materialize::crash-then-materialize-
  keeps-foreign-file`). One consequence worth knowing: an observation of a
  file still holding the previous revision after a crash reads as a human
  revert and commits it as `observed` (`materialize::crash-then-observe-of-
  stale-file-is-foreign`) — the materializer, which the sweep runs first,
  is the recovery point, not the observation.
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
  fixtures. **Idempotent on its own output (2.3, surface 3.3):** `stringify ∘
  parse` is the identity on what `stringify` wrote, so N sequential
  `set`/`unset frontmatter.<k>` effects — each `compose(parse(previous)
  patched)`, §11.3 — produce the bytes of the one merged `compose` the
  library's `docs_set_meta` produced; the reference proves it over every
  alchemy document with strings, numbers, booleans, `null`, a string list
  and a nested mapping. A port whose emitter is not idempotent would
  diverge from the surface's `docs_set_meta` bytes on multi-key patches.
- **Pinned (surface 3.3) — the surface's `docs_set_meta` is a known-id head
  write, the library's a reconciling re-ingest.** Same bytes, rows,
  revision and mints; the dispositions differ (`edited`/`api` vs
  `same`/`exact_hash`/`m2.3`). Folded at 3.0: the library operation and the
  `docs` fixture step are the same effect (§6), so the dispositions are the
  head write's everywhere; `spec/surface` §9 records the surface's choice.
- **Changed (3.0) — a created document commits with known ids.** Through
  2.x `docs_create` (and the `create` effect) ingested the composed file
  through the reconciling resolver: `inserted / null / null / m2.3`
  dispositions, the `b` ids minted inside the transaction. The planner now
  parses the composed file into its working tree and commits it as every
  other document (§4 step 5 (b), `ingest_known` with no triple, the
  `path_taken` guard): `inserted / 1 / api / null`, the `b` ids minted by the
  request before the transaction (the same ids under the fixture minter —
  nothing else mints between — in a different order), bytes, revision and
  commit unchanged. One path for every api write, and the reason slice 3
  exists: a block of a created document has an id a later effect of the
  same plan can name (`effects::create-then-*`, `spec/surface`
  `write-effects-create-and-fill`).
- **Fixed (3.0) — a `move` of blocks into ANOTHER document's top-level
  `start`/`end` moved them within the source.** `to.parent = { doc: true }`
  with a non-anchor `at` names the source document (§4 step 1), so the
  effect `move { targets, into: <other document>, at: "end" }` lowered to a
  same-document move. The kernel op gains `doc` (§2.3), which the lowering
  sets whenever `into` is a document (`effects::create-then-move-block-into-
  new-doc`, `effects.test.ts`).
- **Pinned — `docs_move` records a commit with no revision of the moved
  document** (2.1: with retargets, one revision per rewritten source under
  the move's reason), so a doc's revision `seq` does not advance on a move
  — unless it is itself a retarget source (it links to itself by path) —
  although `revisions.path` is rewritten in place for the current revision
  only.
- **Pinned (2.3) — discarded mints are symbols too.** The symbolic minter
  (§11.4) names every `b` the kernel mints while a plan is lowered, in mint
  order — including the ids the kernel mints and discards (an `update`'s
  re-parse mints the parsed block before the target's id replaces it; a
  `list` wrapper whose items are spliced). Such a `$new.n` is in `new_ids`
  and the receipt maps it to the `b` the replay minted for it, an id that
  names no row (`effects::new-block-referenced-by-later-effects` — `$new.2`;
  `effects::move-document-default-retarget` — `$new.0`). The complete list
  is what lets `execute` zip mint order onto the symbols; the live ids are
  the ones `preview.results[].ids` name.
- **Pinned (2.3) — the digest form cannot tell a stale plan from an edited
  one.** `execute { plan_id, effects }` holds no plan to compare
  preconditions against, so any divergence is `plan_mismatch`; only the plan
  form distinguishes `stale_plan`. The design note had the digest form
  report `stale_plan` when the preconditions differ — it cannot.
- **Pinned (2.3) — a file head, not a frontmatter raw.** `set frontmatter.<k>`
  must reproduce `docs_set_meta`'s bytes, which `composeFile` builds over
  the whole file; a document without frontmatter whose body starts with a
  blank line would render `leading_trivia + fences` (not frontmatter) under
  the kernel's `set_frontmatter` (which leaves the leading trivia). The
  plan's `set_frontmatter[].raw` therefore replaces everything before the
  first block (§11.4); the kernel request's `set_frontmatter` was unchanged
  through 2.x and is gone at 3.0 (§4).
- **Pinned (2.3, with surface 3.2; 3.0 with surface 4.0) — the sugar tools
  lower through the planner.** `blocks_insert`, `blocks_update`,
  `blocks_move`, `blocks_remove`, `blocks_split`, `blocks_merge`,
  `blocks_check`, `nodes_set`, `blocks_append`, `docs_append`,
  `links_retarget`, `links_repair`, and since 3.0 the document operations of
  §6 (`docs_create`, `docs_move`, `docs_delete`, `docs_set_meta`) and the
  whole-document update (§7), are `apply { effects }` sugar (ADR-021): each
  tool builds its effects through the shared builders (`sugar.ts` in the
  reference — one builder per operation, the same table the `omg` verbs and
  the fixture `docs` step use: `insert` / `set markdown` / `set
  attrs.checked` / `move` / `remove` / `split` / `merge` / `set` on a node /
  `retarget` / `create` / `move document` / `remove document` / `set`+`unset
  frontmatter.<k>` / `set content`, with the tool's name — or the §6 reason —
  as `origin.reason`), plans and executes them as one §11.7 request and
  returns the Receipt; a planner error loses its `effect_index` (the tool
  built the effects) and keeps the kernel's data. Every such commit carries
  the intent record in `commits.ops`; the library kernel `apply` and the
  macros (fixture contracts) keep NULL. Through surface 3.x the tools
  rendered the §4 apply result from the plan's `preview` — `results` with
  every `$new.n` replaced by the receipt's id or, on a dry run, by one
  production mint per `new_ids` entry (the realize-symbols shim, so a dry
  run consumed exactly the ids the legacy path burned) — retired with
  `dry_run` at surface 4.0: the preview is `plan`, which mints nothing. Five
  visible consequences, pinned: (1) **`blocks_update`'s `expect` is a guard
  the planner completes** — `expect: {}` or an order-only `{
  parent_children_hash }` with `markdown` pins the content hash from the
  live row and proceeds (through surface 3.1 the kernel saw the caller's
  bag as given and failed `stale_expectation` "expect.content_hash
  required"); a given `content_hash` is checked as given. (2)
  **`blocks_check` naming one block twice is one write** — the planner drops
  the identical duplicate (§11.3); one effect per distinct block in the
  intent record (through 3.1 the second op failed `stale_expectation`
  against the pre-check hash). (3) `blocks_update` with `markdown` and
  `checked` together is two effects — the caller's `expect` guards the
  first, the planner pins the second to the block as the first left it —
  two kernel ops (both in the intent record). (4) `blocks_remove` /
  `blocks_merge` pin `expect[id].content_hash` per block (invisible in
  bytes). (5) `blocks_update`'s `attrs` bag beyond `checked` — another key,
  a non-boolean `checked`, or a bag that sets nothing (a no-op revision) —
  stayed on the legacy kernel path through 3.x; at 4.0 `attrs` is a retired
  name and a `blocks_update` that sets nothing is the argument error "pass
  `markdown` and/or `checked`". An empty `blocks`/`ids` list is the
  surface's argument error (`spec/surface` §4), no longer a malformed
  kernel op.

## 11. Effects and plans

Since 2.3 (ADR-021). Nine **effects** are the intentional-write vocabulary:
an ordered list of them is lowered by a **planner** to the kernel ops of §2,
the macros of §5, the whole-document planner of §7 and the document
operations of §6, and committed as ONE request of §4 step 5 — one
transaction, one `commits` row (whose `ops` records the effects), one
revision per touched document. Nothing is added to the kernel. Three verbs:
`plan` (the frozen Plan, nothing written), `execute` (commit exactly that
plan, its preconditions re-validated in the transaction), `apply { effects }`
(plan + execute under one writer lock and one transaction). The kernel
`Request` of §4 and the `Opset` of §7 are unchanged; the observe path is a
separate entry and commit origin, never an effect. Since 3.0 the effects are
the **only public write request**: the kernel ops are the library and fixture
contract (§4), the opset the planner's internal result (§7), the document
operations the effect builders (§6); a `create` is a document the planner
adopts, so a plan may write into the document it creates (`$new.k` names its
blocks too), and the plan's `preview` carries `identity` and `retarget`
(§11.4). Since 3.1 a request may be **query-directed** (§11.8): an OQX
`select` whose hits, bound to the `effects` as templates, are the effects
planned, frozen with the plan as its `selection`. Since 3.2 the `-> expr`
**leader** is the written form of an expression, a bare string is a target,
and a plain request's expressions evaluate in their own target's row
(§11.8 "Sugar"). Since 3.3 the preview carries a **`summary`** — one line in
words per effect, the plan as a worked example of itself (§11.9), repeated by
the Receipt — and a correctable error a **`fix`**, a literal corrected call
(§8). `planner_v` is `"p3"`.

### 11.1 Vocabulary

```text
Target  { kind: "document", id? | path? }        at least one; a path in either form (spec/surface §1)
        { kind: "block", id } | { kind: "node", id }
        { kind: "section", heading_id }           the heading's section range (§1.1), never a stored id
At      "start" | "end" | { before: <block id> } | { after: <block id> }
Expect  { content_hash?, parent_children_hash?, revision? }   revision = the document's current_rev

Effect  { op: "create",   path, markdown, frontmatter? }
        { op: "insert",   into: Target(document|section|block), at? = "end", markdown, expect? }
        { op: "set",      target: Target(document|block|node), field, value, expect? }
        { op: "unset",    target: Target(document), field: "frontmatter.<key>", expect? }
        { op: "move",     target: Target(document), to, retarget_inbound? = true }
        { op: "move",     targets: [Target(block)…], into: Target(document|section|block), at? = "end", expect? }
        { op: "remove",   target: Target(document) }
        { op: "remove",   targets: [Target(block)…], expect?: { <block id>: Expect } }
        { op: "split",    target: Target(block), at: [byte…], expect? }
        { op: "merge",    targets: [Target(block)…], separator? = " ", expect?: { <block id>: Expect } }
        { op: "retarget", repairs: [{ from, to }], path_glob? }
```

Any `id` — a target's, an anchor's, a `targets[]` member's, a section's
`heading_id` — may be **`$new.<n>`**, an identity an earlier effect of the
same request creates (§11.4): a created document, each block of its parsed
tree (3.0, pre-order), the blocks an `insert`/`split`/`update` mints. A
symbol no earlier effect created (or one of the other kind: a document
symbol where a block is wanted) is `target_missing { symbol }`.
`move`/`remove` are distinguished by `target` (a document) vs `targets`
(blocks). Where a target object is expected a **bare string** is one too
(3.2, §11.8 "Sugar"): a path, an id or a `$new.n`. The shape is checked
before anything is resolved — an unknown key, a missing or mistyped member,
a target kind the op does not take, a `field` not in §11.2 — and a failure
is `filter_invalid { reason, hint: "arguments" }` naming `effects[i]` and
the member; an empty `effects` is one too. Four shape mistakes carry a `fix`
(3.4, §8): `at` as the bare string `"after"`/`"before"` (the fix anchors on
the block from its parent), a plural `expect` nested guard-first (inverted),
`expect.max` inside an effect (moved beside `select`, or dropped), and a
block `field` of `text`/`content`/`body`/`raw` (`markdown`).

### 11.2 Fields

| Target | `field` | `value` |
| --- | --- | --- |
| document | `frontmatter.<key>` (`<key>` is everything after the dot; one flat key) | any JSON (`unset` takes none) |
| document | `content` (`set` only) | the complete proposed document, a string |
| block | `markdown` | a string |
| block | `attrs.checked` | a boolean |
| node | an editable property of the node's kind (`value`, `name`, `checked` — §5 `node_set`) | a string, else its canonical JSON (§11.5) |

`expect.content_hash` and `expect.parent_children_hash` go to the lowered
op (§1.2); a mismatch at plan time is the kernel's `stale_expectation`
(`effects::plan-rejects-stale-expect`). A `content_hash` the caller omits
is **pinned from the live row** for every block an effect targets (`set`,
`split`, each block of `remove`/`merge`; the sugar tools' rule) and the
pins are the plan's `preconditions.blocks`. `expect.revision` is compared
with the target document's `current_rev` when the effect is planned; a
difference is `stale_plan { doc, expected_revision, current: { revision,
hash }, retriable }` (`effects::plan-rejects-stale-revision`).

### 11.3 Lowering and conflicts

Effects are lowered **in order**; later effects see earlier ones (an anchor
may be a block an earlier insert created; a second frontmatter key patches
the first's result). Resolution: a document target → its `{ id, path }`
(`doc_missing { doc }`; `filter_invalid` when `id` and `path` disagree); a
`$new.n` document → the create's path. Each effect lowers per this table —
the TypeScript reference's `mutate/effects.ts`, the port's
`omgbase-mutate::effects`:

| Effect | Lowers to |
| --- | --- |
| `create` | a live document at `path`, a path an earlier effect of the plan already creates or moves to, or a file on disk → `path_taken`; the document symbol is allocated (kind `document`), then `source = composeFile(markdown, frontmatter)` (§6 `docs_create`) is **parsed into the planner's working tree** per the path's format — the frontmatter block as the head, each body block minted in pre-order (the next `$new.k`, kind `block`) with its exact trivia — and **adopted** as a loaded document with no row behind it (3.0): no triple, an empty `before`, no prior ids. `opset.creates[] = { symbol, path, source, before_op }`, `before_op` the number of kernel ops planned so far (where `execute` re-adopts it, §11.7); `preconditions.absent_paths += path`. Every later effect addresses the document (`into`/`target` `{ kind: "document", id: "$new.n" }` — its `doc` in the kernel op) and its blocks (`$new.k`, kept literally in the ops) like any other; `set`/`unset frontmatter.<key>` on it is a head (the row below), `set content` on it is `target_missing { symbol }` (its content is the create's markdown), `move`/`remove` of the document itself are `target_missing` too. At commit: `ingest_known` with no triple — the `path_taken` guard re-checked, §4 step 5 (b) — so every block is `inserted / api`. Through 2.x the create was a reconciling ingest at commit and a later frontmatter patch was folded into its composition (§10 "Changed (3.0)") |
| `insert into document` | kernel `insert { doc, to: { parent: { doc: true }, at }, markdown, expect? }` |
| `insert into section` | `insert { to: { parent: { heading: heading_id, scope: "section" }, at }, markdown, expect? }` (§1.1; an unknown heading is `parent_missing`) |
| `insert into block` | `insert { to: { parent: id, at }, markdown, expect? }` (the container rule → `type_mismatch`) |
| `set`/`unset frontmatter.<key>` on a document | the file is re-composed as `docs_set_meta` composes it (§6): `split(render(doc))` → `(frontmatter, body)`, the key set or deleted, `after = composeFile(body, merged)`; the document's **head** — `after` minus the rendered body blocks — becomes `opset.set_frontmatter[] = { doc, raw }` (one entry per document, the last patch wins; `doc` a created document's symbol when it is one, 3.0 — `effects::create-then-set-on-new-doc`). The head replaces the leading trivia and the frontmatter together (§10), so the body blocks keep their ids and bytes (a file without a trailing newline gains one on its last block's trivia); byte parity with `set_meta` is pinned by `effects::set-fm-matches-set-meta-bytes` |
| `set content` on a document | §7 `plan_update(doc, value)`: `converges: false` → `plan_not_convergent { doc, diagnostics }`; its annotations → `preview.identity[doc]` (3.0; §7); its `frontmatter` → the head `leading_trivia + raw`; its kernel ops appended with every `$k.ids[i]` placeholder shifted by the ops already planned. **No ops and no frontmatter change** (the content IS the document): nothing is loaded — the document's triple still goes to `preconditions.docs`, nothing commits (§11.7). The planner's own verifies mint under a throwaway symbol table (nothing of theirs reaches the plan) |
| `set markdown` on a block | `update { block, markdown, expect: { content_hash (pinned), parent_children_hash? } }` |
| `set attrs.checked` on a block | `update { block, attrs: { checked }, expect }` |
| `set <prop>` on a node | §5 `node_set(node, prop, value)` → its one `update`, the pin as above (`node_not_editable` / `block_missing` as there) |
| `move` a document | `opset.moves[] = { id, from, to }` (`doc_missing`; `path_taken` for a live document, an earlier create/move of the plan, or a file at `to`; `absent_paths += to`; the document's triple → `preconditions.docs`) and, unless `retarget_inbound` is `false`, the inbound rewrite of §6 `docs_move` as kernel `update`s (pinned). At commit: `move_path` then the sources' revisions, the moved document's own revision (when it is a source) at the NEW path — §6, one commit |
| `move` blocks | `move { blocks, to, doc?, expect? }` — `doc` the destination document's id (or symbol) when `into` is a document (§2.3, 3.0) |
| `remove` a document | `opset.tombstones[] = { id, path }` (`doc_missing`; the triple → `preconditions.docs`); at commit the tombstone of §6 `docs_delete` (nothing pooled) |
| `remove` blocks | `remove { blocks, expect: { <id>: { content_hash (pinned), … } } }` |
| `split` | `split { block, at, expect }` |
| `merge` | `merge { blocks, separator, expect: { <id>: … } }` |
| `retarget` | §5 `links_repair(repairs, path_glob)` → its `update` per top-most block (pinned); no hit → no op; its hits and pair counts → `preview.retarget[] = { effect_index, hits, pairs }` (3.0) |

A kernel error raised while an effect's ops are planned keeps its own data
and gains `effect_index` (§8).

**Focus and conflicts.** Before an effect lowers, the planner classifies
what it writes and what it addresses, against what earlier effects did:

| Focus | Key | Rule |
| --- | --- | --- |
| scalar | `(document, frontmatter.<key>)`, `(document, content)`, `(document, path)` — a `move`, `(block, markdown)`, `(block, attrs.checked)`, `(node, <prop>)`; a `retarget` is one `(block, markdown)` per hit | a second write to a key an earlier effect wrote: **identical** (same op; for `set`, equal canonical JSON of `value`) → the later effect is **dropped** and `diagnostics` gains `effect <j> (<describe>) duplicates effect <i>; dropped` (`describe`: `set <field> on document <id>`, `set <field> on block <id>`, …); otherwise — a different value, `set` then `unset`, `unset` then `set` — `conflicting_effects { effects: [i, j], focus: { kind: "scalar", target: { kind, id }, field } }` |
| positional | `insert`, `move` blocks, `split`, `merge` | any number, sequential; an anchor must exist when reached (the kernel's `target_missing`) |
| identity | retired by: `remove` a document (the document and every block), `remove` blocks (each block and its descendants), `merge` (the non-first blocks and their descendants), `set markdown` on a block (its descendants — the re-parse re-mints them, §2.2), `set content` (every block of the document; the document counts as wholly rewritten), `move` a document (its OLD path) | a later effect that **addresses** a retired document, block (a target, an `into`, a `heading_id`, an anchor, a node's block) or path (a `create` there, a `move` to it) → `conflicting_effects { effects: [i, j], focus: { kind: "identity", target: { kind: "document" \| "block" \| "path", id? \| path? } } }`; `set content` on a document any earlier effect touched → the same, naming the document and that effect |

The dropped duplicate is not in the plan's `effects`. `conflicting_effects`
is not retriable. `execute` does no analysis.

### 11.4 The Plan

```text
Plan {
  version: 1,                    // the plan schema
  planner_v: "p3",               // the lowering + conflict rules above (the matcher_v precedent; "p1" through 2.3, "p2" through 3.0)
  effects: [ResolvedEffect],     // in order, duplicates dropped: document targets as { kind: "document", id, path }
                                 // (path in the storage form; a $new.n document keeps its symbol with the create's path),
                                 // defaults made explicit (insert/move `at: "end"`, move `retarget_inbound: true`,
                                 // merge `separator: " "`), a `create` path canonicalized; optional keys absent when absent
  opset: { creates: [{ symbol, path, source, before_op }], moves: [{ id, from, to }], tombstones: [{ id, path }],
           set_frontmatter: [{ doc, raw }], ops: [Op] },     // every key present ([] when empty); ops in the fixture spelling
                                                             // (`child_ids`); new structure an op minted is named by kernel placeholders "$k.ids[i]",
                                                             // a created document and its blocks by their "$new.n" (3.0)
  preconditions: { docs: [{ id, path, base_revision, hash }],      // §4 step 5's triple of every touched document: the loaded ones
                                                                   // in load order, then moved/removed documents in effect order
                   blocks: [{ id, content_hash }],                 // every pin, first-pin order ($new.n blocks excluded)
                   parents: [{ doc, parent: <block id> | null, parent_children_hash }],   // the caller's destination-parent pins
                   absent_paths: [path] },                         // create paths and move destinations, in effect order
  new_ids: [{ symbol: "$new.n", kind: "block" | "document" }],      // in allocation order (below)
  selection?: { query, expect?: { max }, templates: [Template], cardinality, identities: [id] },   // (3.1, §11.8) only for a
                                                                   // query-directed plan: the selector and templates AS GIVEN, the hits
  plan_id: "<64 hex>",           // §11.5
  diagnostics: [string],         // the dropped duplicates
  templates?: [Effect as written],   // (3.2, §11.8 "Sugar") a plain request's effects AS WRITTEN when one carried an
                                     // expression; not digested (the core holds the concrete effects); the intent record's
  preview?: { results: [{ ids }], revisions: [{ id, path, hash }], diffs: { path: { before, after } },
              summary: [string],   // (3.3, §11.9) one line in words per resolved effect, in order; [] for a zero-hit selection
              identity?: { <doc id>: { matcher_v, summary, ops: [{ op_index, disposition, blocks, confidence, reason, detail? }], diagnostics } },
              retarget?: [{ effect_index, hits: [{ id, path, oldRaw, newRaw }], pairs: [{ from, to, hits }] }] }   // not digested; omittable
}
```

`preview.identity` (3.0) is present when the plan has a `set content`: per
document, the whole-document planner's annotations (§7) — what the 3.x
`docs_update` result carried. `preview.retarget` is present when the plan
has a `retarget`: per effect, `links_repair`'s hits and pair counts (§5),
what the `links_retarget`/`links_repair` tools report beside the receipt.

**Symbolic identities.** The planner lowers under the **symbolic minter**:
every `b` the kernel mints while the ops are planned returns the next
`$new.n` (`n` counting from 0 across the plan), and a `create` allocates the
next `$new.n` of kind `document` when it is lowered, immediately followed by
its parsed blocks' symbols in pre-order (3.0). So a plan mints no
real id (a dry run burns nothing — `effects::apply-effects-dry-run-plan-only`),
the kernel — id-agnostic for rendering — renders exact bytes and hashes, and
the `preview` is exact. The ids an op reported (`results[k].ids`) are what
a later effect's `$new.n` resolves to: the kernel placeholder `$k.ids[i]`
of the op that minted it. `new_ids` lists every symbol in allocation order
(§10: a discarded mint is a symbol too).

The `preview`: the kernel results (`ids` may be symbols), the revisions
the commit would record — the loaded documents' `{ id, path, hash }` with a
moved document at its new path, plus `{ id: "$new.n", path, hash }` per
create — and the per-file diffs: the kernel's, a create `"" → source`, a
move two entries (`from → ""`, `to` filled with the moved document's bytes
— its rewritten bytes when it is a retarget source), a removal `bytes → ""`.

### 11.5 Canonical JSON and the digest

`plan_id = hex(sha256(utf8(canonical(core))))` over the **core** — exactly the
six members `{ version, planner_v, effects, opset, preconditions, new_ids }`
of the plan, plus `selection` when the plan is query-directed (3.1, §11.8:
present ⇒ digested, absent ⇒ absent — never `null`); `plan_id`,
`diagnostics`, `preview` excluded. `canonical(v)` is the JSON text of `v`
under these rules, each exact:

1. No whitespace anywhere.
2. **Objects**: members sorted by the **UTF-8 bytes** of their keys
   (bytewise, unsigned — `"z"` before `"é"`); a member whose value is
   absent (`undefined`) is omitted; a member whose value is JSON `null` is
   written `null`. Optional keys of the plan and of resolved effects are
   therefore absent, never `null`, when they are not given — and a `null`
   that IS a value (`base_revision: null`, `hash: null`, a frontmatter
   `value: null`) stays.
3. **Arrays**: elements in order, comma-separated.
4. **Strings** (values and keys): `"` → `\"`, `\` → `\\`, U+0008 → `\b`,
   U+000C → `\f`, U+000A → `\n`, U+000D → `\r`, U+0009 → `\t`, every other
   U+0000–U+001F → `\u00xx` with **lower-case** hex; everything else —
   `/`, U+007F, U+2028/2029, every non-ASCII character — literal UTF-8. A
   string that is not well-formed Unicode (a lone surrogate) cannot be
   digested: `filter_invalid`.
5. **Numbers**: NaN and the infinities cannot be digested (`filter_invalid`).
   A value that is **integral with |v| < 2^53** is written as a plain decimal
   integer — no fraction, no exponent, `-0` as `0` (so `1.0` and `1` are one
   value: JSON distinguishes them, the digest does not). Any other finite
   value is written by **ECMAScript `Number::toString(10)`**: the shortest
   digit string that round-trips (`d₁…dₖ`, decimal exponent `n` with the
   value `0.d₁…dₖ × 10ⁿ`), laid out as: `k ≤ n ≤ 21` → the digits followed
   by `n − k` zeros; `0 < n ≤ 21` → the digits with a `.` after the `n`-th;
   `−6 < n ≤ 0` → `0.` then `−n` zeros then the digits; otherwise
   `d₁[.d₂…dₖ]e±(n−1)` — `1.5`, `0.30000000000000004`, `1e+21`, `1e-7`,
   `9007199254740992`, `123456789012345680000`, `1.7976931348623157e+308`
   (`effects::digest-vectors` pins each). Integers beyond 2^53 are not
   portable between the engines' number models and appear in no fixture.
6. `true`, `false`, `null`.

The `canonical` fixture step (§9) pins the text and its digest; the empty
core `{ version: 1, planner_v: "p3", effects: [], opset: { every key [] },
preconditions: { every key [] }, new_ids: [] }` digests to
`5051e40051314fa855721d1943b42a9acb867c79a7b49eb4db0fd811559289ff` (the
3.0 core, `planner_v: "p2"`, to
`6f43b302fdcd58ca4fd182b21a5bdab6fee3787ddc074f5e7c5c23b2cc368bf9`, the 2.3
core, `planner_v: "p1"`, to
`a20097a9c319b59a1313c83e1fd494bbb3cf4895040fbbddd2866e56b16cddd3`), and the
empty core with the selection `{ query: "from docs where type == \"nope\"",
templates: [{ op: "set", field: "frontmatter.x", value: 1 }], cardinality:
0, identities: [] }` — a zero-hit plan — to
`73ca03407ddf05fb522c4118bd5ef1e88887f8430acbaba7428378a0b1e342c9` (all four
are `effects::digest-vectors`; `select-zero-hits-commit-null`'s plan carries
the last one as its `plan_id`).

### 11.6 `plan`

`plan(effects, select?, expect?)` → Plan. Validate the shape (§11.1) — or,
with `select`, compile the selection into the concrete effects (§11.8) —
then under the symbolic minter lower each effect in order (§11.3: resolve, classify — dropping or
refusing — then lower), render every loaded document (§4 steps 1–4),
compose the creates, freeze the preconditions, digest the core. Reads only;
no id minted; no lock needed beyond the host's (the triples are re-checked
at commit). A plan has no expiry.

### 11.7 `execute` and `apply`

**`execute { plan }`** (the plan form). Admission, in this order: `version`
≠ 1 → `unsupported_plan_version { version, supported: [1] }` (before any
other member is read — a plan from a newer schema fails here, whatever
else it carries); a missing or mistyped core member → `filter_invalid`;
the recomputed digest of the core ≠ `plan_id` → `plan_mismatch { expected:
plan_id, actual }` (an edited plan, or another planner's digest — the
parity gate: `effects::execute-plan-edited-is-plan-mismatch` pins `actual`
for the empty core). `planner_v` is digested, not checked: the opset is
executable whatever planned it. A `templates` member must be an array when
present (3.2); like `diagnostics` it is outside the digest and only recorded. Then, under the writer lock when a
workspace is given: pre-check every `preconditions.docs` triple against the
rows (`doc_missing`; a difference → `stale_plan { doc, expected_revision,
current: { revision, hash }, retriable }`) and every `absent_paths` entry
(`path_taken`) — so a stale plan fails before a `b` is minted; **replay the
opset** under the production minter: the `set_frontmatter` heads of
existing documents first, then `ops` in order through §4 steps 1–4, each
`creates[]` entry re-adopted (its `source` parsed, §11.3) right before the
op its `before_op` names — after the last op when `before_op = ops.length`
— with its own head applied as it is adopted (3.0). The `b` ids are minted
here, before the transaction, as every request's are (a failure after this
point burns them, in both engines alike), and in the plan's order, so the
**i-th `b` minted IS the i-th block symbol**: the replay aliases each as it
is minted and the ops' `$new.k` resolve through the aliases (a kernel
placeholder `$k.ids[i]` resolves as before). Build the request's internal
effects in this order — per move `move_path` (the inbound edges read now),
the rendered documents' `ingest_known`s in load order (a created document's
with no triple, a moved document's at its new path), per tombstone
`tombstone { pool: false }` — and commit them as §4 step 5 with `ops` = the
intent record `canonical({ v: 1, plan_id, effects, selection?, templates? })`
(the plan's resolved effects, symbols kept; the plan's `selection` when it
has one, 3.1; a plain request's effects as written when one carried an
expression — the plan's `templates`, 3.2). The transaction re-validates every triple
authoritatively and the created paths' absence (the `Absent` guard:
`path_taken`); a document that moved meanwhile is `stale_plan` with nothing
minted of `c`/`d`/`r`. Replaying an executed plan fails the same way
(`effects::execute-replay-fails-stale-plan`; a create-only plan `path_taken`):
the preconditions decide, no server-held handle, no idempotent replay. A plan
with nothing to commit — every effect lowered to no op, no head, no document
operation (a `set content` whose value is the document) — records no commit
and touches no file: the **zero-effects rule** (`spec/surface`
`write-docs-update`).

**Receipt** `{ plan_id, commit, revisions: [{ id, path, hash }], new_ids:
{ "$new.n": <id> }, committed: true, summary: [string] }`: `commit` the one
`commits` row (`null` when the plan had nothing to commit); `revisions` one
per ingest in effect order (a created document's `id` is the `d` its ingest
minted); `summary` (3.3) the plan's `preview.summary` verbatim — what was
committed, in words (§11.9; `[]` when the plan form was handed back without
its `preview`);
`new_ids` maps the plan's symbols to the ids the replay minted — the `i`-th
block symbol to the `i`-th `b` minted during the replay (a created
document's blocks included, 3.0 — every `b` of the request is a symbol), the
`i`-th document symbol to the `i`-th `d` minted inside the transaction (the
created documents' ingests, in load order = effect order).

**`execute { plan_id, effects, select?, expect? }`** (the digest form): plan
the effects as §11.6 (under the lock; with the selector when one is given,
3.1 — the selection runs again and its `identities` are digested, so a hit
that appeared or vanished is a mismatch, `effects::execute-digest-form-with-
select-new-hit-mismatch`); the new plan's `plan_id` ≠ the given one →
`plan_mismatch { expected, actual }` — the effects differ, or the documents
they target moved (§10: the digest form cannot tell which); equal → commit
it as above.

**`apply { effects, select?, expect? }`**: plan + commit under one writer
lock and one transaction → the Receipt; the preview is `plan`'s (2.3's
`dry_run` on `apply` returned the Plan; retired with `spec/surface` 4.0 — a
dry run is a `plan`). With `select`, `expect.max` is **required** (§11.8:
the one-shot never saw the hits; missing → `filter_invalid { hint:
"selection" }`, `effects::select-apply-requires-max`). The one-shot and
`plan` → `execute` produce the identical store projection
(`effects::set-fm-and-insert-section-*`).

### 11.8 Selectors (query-directed planning, 3.1)

A request may name its targets by a **selector** instead of listing them:

```text
Request  { select: "<OQX>", expect?: { max }, effects: [Template] }
Template an Effect of §11.1 (not `retarget`) whose target may be ABSENT and whose target or value
         members may be the directive { "oqx": "<expression>" } — evaluated per hit, in the hit's row scope
```

The selector is a producer of effects, never a second write engine: the
hits, bound to the templates, ARE the effects, and the plan that comes out
is the Plan of §11.4 — fully concrete, executable without OQX — plus the
frozen `selection`. Both engines compile it the same way (the reference's
`mutate/select.ts`, the port's `omgbase-surface::select`):

**1. Static admission** (before anything is read; every refusal
`filter_invalid { reason, hint: "selection" }`). `select` is a non-empty
string that parses; `expect` is absent or `{ max: <non-negative integer> }`
and nothing else; `effects` is a non-empty array of templates. The
selector's consumer is `collect`, `first` or `single` (`count` / `exists` /
`none` yield no rows); no `values`; its source is a bare root ∈ `docs`,
`blocks`, `nodes` (`links` rows have no effect target; any other source is
refused); no `follow`, no body `from` (a hit must be a row of the root),
no `offset` (a selection is a set, not a page), no `distinct` (first
release); `limit N` and `order by` are allowed — the order of the hits is
the order of the effects. A user alias beginning `__omg_` or `__oqx_` is
refused (the prefixes are the engines'; the runner refuses them on every
query since 3.1 — `select __oqx_id: 1` overwrote the hit's `id` before). Each
template: `op` ∈ `create insert set unset move remove split merge`
(`retarget` is not row-shaped); the directive `{ oqx }` is legal only in the
**slots** — the primary target (`target` of set/unset/split and of a
document `move`/`remove`; `into` of insert; `targets[k]` of a block
`move`/`remove`/`merge`) as `{ kind, id: { oqx } }` or `{ kind: "document",
path: { oqx } }` (one of the two), the secondary target `into` of a block
`move`, `at.before` / `at.after`, the strings `markdown`, `to`, `path`,
`separator`, the JSON `value`, and each top-level value of a `create`'s
`frontmatter`; anywhere else (`expect`, `field`, a nested value of a target,
…) it is refused. A `move` is the block form when it has `into`, else the
document form; a `remove` with neither `target` nor `targets` is the
document form over `docs` and the block form otherwise; `merge` must name
`targets`. The template's shape is then checked as §11.1 with a probe value
in every slot (the absent primary target as the hit's kind), so an unknown
key, a bad `field` or a target kind the op does not take is the ordinary
`filter_invalid { hint: "arguments" }` naming `effects[i]` — `insert into`
over `nodes`, a block-form `remove` over `docs`, fail here. Each expression
is parsed through the wrapper `select __omg_x: <e> from docs` (OQX has no
expression entry point) and must be exactly one select item over an
otherwise empty query — a top-level item is scope depth 1, the hit's, so `^`
and `N^` validate as they will evaluate; a parse error's offset is shifted
back by the wrapper's 16 code points.

**2. The rewrite.** One projection item per slot, named
`__omg_sel_<t>_<slot>` (`t` the template index; `slot` ∈ `target`, `into`,
`targets_<k>`, `at`, `markdown`, `to`, `path`, `separator`, `value`,
`fm_<j>`), is appended **after the user's items** on the RAW parsed tree —
nothing is spliced as text — so the runner's alias resolution inlines a user
alias a template reads (`select hub: project …` with `{ oqx: "hub" }` reads
`project`). The worked example — template 0 `insert into { document, path:
{ oqx: "project" } } at end, markdown: { oqx: "\"- completed: [\" + title +
\"](\" + path + \")\"" }`, template 1 `set frontmatter.rolled_up = true` on
the hit (all literal, no slot) — over `from docs where type == "workstream"
and status == "completed"` prints as

```text
select __omg_sel_0_into: project, __omg_sel_0_markdown: "- completed: [" + title + "](" + path + ")" from docs where type == "workstream" and status == "completed"
```

The runner injects `id` / `path` as for any query; every hit carries both
for all three roots (`path` in the reference form). The query runs ONCE,
over one snapshot, with the page bound `max + 1` (`SELECTION_CEILING + 1 =
1001` without `expect`): more hits than the bound → `selection_too_large {
cardinality: ">" + bound | n, max: bound, implicit?: true }` (`">" + bound`
when the page was truncated, the exact count when it was `bound + 1`;
`implicit` present only under the ceiling) — the engine never plans a
partial set. An OQX error from the run is the runner's `filter_invalid`.

**3. Row → effects.** Hits in result order × templates in order: the
expanded effect `k = h·T + t` for hit `h` of `H` and template `t` of `T`
(`H` = `cardinality`). Per template, a copy with every slot filled:

| Template member | Binding |
| --- | --- |
| primary target absent | the hit by root: `{ kind: "document", id }` / `{ kind: "block", id }` / `{ kind: "node", id }` (`targets` → the one-element list); the op's kind table still applies |
| `{ kind, id: { oqx } }` / `{ kind: "document", path: { oqx } }` / `targets[k].id: { oqx }` | the value: a **string** → that `id` / `path` as written; a **row** (the runner renders a row value as `{ id, path }`, spec/surface §1.4 — `^docs single { … }`) → `{ kind, id: <its id> }` whichever member held the expression; absent (`null`, no value) or `[]` → `target_missing { effect_index: k, template_index: t, row: { id, path }, expression }`; a list of one or more → `ambiguous_target { …, count }` (a one-element list is still a list: strictness over guessing); anything else → `filter_invalid { hint: "selection" }`. Then the resolution of §11.3 as for a literal target (`doc_missing`, `block_missing`, `parent_missing`) |
| `at.before` / `at.after`, `markdown`, `to`, `path`, `separator` | must be a string; absent or another type → `filter_invalid { hint: "selection" }` |
| `value`, `frontmatter.<k>` | any JSON as the runner rendered it (a row value lands as the record `{ id, path }`, a list as a list, a number by OQX's own arithmetic — nothing is re-formatted); absent → `filter_invalid { hint: "selection" }` ("use `unset`" for a `value`) |

The expanded list is validated (§11.1, `effects[k]`) and lowered by the
loop of §11.3 **unchanged** — the conflict rules give the cross-hit
semantics for free: two hits writing one scalar with equal canonical values
dedupe with a diagnostic (`effect <k> … duplicates effect <j>; dropped`),
with different values → `conflicting_effects`; inserts into one shared
document are positional and sequential in hit order. Every error raised
from an expanded effect — binding, resolution, kernel, conflict — carries
`effect_index: k` plus `template_index: t` and `row: { id, path }` (the hit's
identity as the envelope spells it; `conflicting_effects` names the later
effect's). Zero hits → an empty expansion: a plan with `effects: []`, an
empty opset, no preconditions, `selection.cardinality: 0` (the non-empty
rule of §11.1 is the templates'); `execute` / `apply` of it commit nothing
(`commit: null`, the zero-effects rule of §11.7).

**4. The `selection`.** `{ query: "<select as given>", expect?: { max },
templates: [<as given>], cardinality: H, identities: [<hit ids, result
order>] }` — the seventh digested member of the core (§11.5), recorded **as
given** (the intent; no printing-parity requirement across engines), `expect`
present only when given. `admitPlan` (§11.7) accepts the member with that
shape; `execute { plan }` replays the opset without OQX; the digest form
re-runs the selector (above). The intent record gains it (§11.7).

**Deferred** (first release): `distinct`; provenance analysis of a template
that writes through a computed value (caught by the typing and resolution
above).

#### Sugar (3.2)

Three conveniences, each a rewrite of the request **before** the admission
above — the plan that comes out is the plan the spelled-out request gives
(`planner_v` stays `"p3"`; no existing digest moves), and both engines
rewrite identically (the reference's `select.ts` `desugarEffect` /
`compilePlain`, `effects.ts` `bareTarget`):

**The leader.** In every slot the table of step 1 admits an expression —
`markdown`, `to`, `path`, `separator`, `at.before` / `at.after`, `value`,
each top-level `create.frontmatter` value, a target's `id` / `path`, and a
whole target (below) — a JSON string beginning exactly **`-> `** (dash,
greater-than, space) is an OQX expression: the rest of the string. It
desugars to `{ oqx: rest }` before the compile, so typing follows the value
exactly as `{ oqx }` does (an identity for a target, a number for `value`,
a string for `markdown`). A string NOT beginning `-> ` is literal data,
always — no escaping, no `${` scanning (`->x`, ` -> x`, `-->`, a mid-string
`-> ` and `${HOME}` land verbatim; `effects::sugar-literal-without-leader-
untouched`). A literal that must begin `-> ` is spelled `-> "-> …"`
(`sugar-literal-that-begins-with-leader`). OQX 0.21 template literals are the
string-building form: `"-> `## ${title}`"`. A string nested inside a `value`
or a frontmatter value is data (the slot is the top-level value, as for
`{ oqx }`).

**Constant folding.** A `-> ` expression that is a bare string literal or a
template literal with no interpolation folds to the plain literal before
planning — it never emits `{ oqx }`, needs no row and no query — so `-> "x"`,
`` -> `x` `` and `"x"` digest identically
(`effects::sugar-constant-fold-equal-plan-id`:
`dd0f05613d10645355cfb33139767424d9f1ade0c36d04bce363df06e66477c3` three
times).

**Bare targets.** Where a target object is expected (`target`, `into`, each
`targets[k]`; with or without a selector) a bare string is sugar, normalized
by the shape check before resolution: a **path-looking** string — contains
`/` or ends `.md`, either path form — is `{ kind: "document", path }`; a
`b_` / `d_` id (`spec/store` §2.2) or an `n_` id (`n_` + 12 hex) is the
matching kind; `"$new.n"` is the kind the symbol table recorded when the
effect is resolved (a document → `{ kind: "document", id }`, a block →
`{ kind: "block", id }`; a symbol nothing created → `target_missing
{ symbol }`; the slot's kind table and the §11.2 `field` rule then apply to
the recorded kind — `effects::sugar-bare-new-symbol-target`); `"-> expr"` is
a whole-target expression — the identity the value names: a row → its kind
by its id's prefix, a path string → a document, an id string → its kind,
anything else `filter_invalid { hint: "selection" }`, absent / a list as in
step 3; a string containing `#` is a **locator**, refused `filter_invalid
{ hint: "arguments", fix }` (the `fix` names `blocks_resolve` and a
`query`); any other string is no target (`filter_invalid`, hint
`arguments`). The op's kind table still applies to the normalized kind
(`split` of `"d_0"` is `kind must be one of block (got "document")`). The
plan's `effects[]` record the resolved objects, so the digest equals the
object form's (`sugar-bare-path-target` plans both; `sugar-bare-id-target`).

**Without a selector.** On a plain effect (no `select`) a `-> ` slot (or
`{ oqx }`) evaluates in its own **primary target's row** — `target` of
set/unset/split and of a document move/remove, `into` of insert, the first
of `targets` for the block forms (a section's row is its heading block's, a
node's its own): the effects are grouped by that row's identity, one
synthetic query per identity runs — `from <docs|blocks|nodes> where id ==
"<id>"` with the slot items appended exactly as step 2's rewrite, named
`__omg_sel_<effectIndex>_<slot>` — and the row binds the slots as step 3
binds a hit; the concrete effects then lower unchanged. There is no
`selection` member (there is no selector); instead the plan gains
**`templates`** — the effects AS WRITTEN — outside the digest (the core
already holds the concrete effects; `plan_id` equals the literal plan's),
present only when at least one slot was an expression (a plain request
without one, or with only folded leaders, produces no `templates`), and the
intent record (§11.7) gains the same key. Refused, each `filter_invalid
{ hint: "selection" }`: a `create` with an expression — it has no row ("an
expression on a create needs a selector"; a folded leader on a create is a
literal and fine); an expression as the primary target itself ("an
expression target needs a selector — without `select` there is no row to
read it from"); a `$new.n` primary target ("has no row yet"). A literal
primary target that names no row is the lowering's own error (`doc_missing`,
`block_missing`, `parent_missing` for an `into`). A binding error carries
`effect_index`, `row` and `expression` — no `template_index`.
`effects::sugar-leader-without-select-on-doc`, `-on-block`, `-two-targets`
(two synthetic queries), `-on-create-refused`.

**Errors.** A `-> ` expression that does not parse is `filter_invalid
{ hint: "selection" }` naming the slot, the OQX offset counted from the
start of the written string (the wrapper's shift plus the leader's 3;
`sugar-leader-bad-expression`); a query smuggled into the leader fails as for
`{ oqx }`. `-> ` in a slot that takes no expression — `expect`, `field`,
`op`, a section's `heading_id`, `split.at`, a `retarget`'s members, a
whole `at`, a target member beside `id` / `path` — is `filter_invalid { hint:
"selection" }` (`sugar-leader-in-non-expression-slot`), never literal data.

### 11.9 The summary (3.3)

`preview.summary` is **one line per resolved effect**, in plan order — the
dropped duplicates of §11.3 produce none, a zero-hit selection gives `[]` —
each a sentence in words a reader (or the agent that wrote the request) can
check against its intent: the plan as a worked example of itself, which the
Receipt repeats as `summary` and the CLI prints under its commit
confirmation (`spec/cli` §4). Not digested. Both engines spell every line
byte for byte by this table; the vocabulary:

- **a document**: its `/`-rooted path (`spec/surface` §1 Paths); a created
  document by its `create`'s path.
- **a block**: a heading by its text, `heading "Risks"` (the visible text of
  `spec/format` §4.1, as the live row's `text`; a block the plan creates —
  a `$new.k` of a created document, a block an earlier insert minted — from
  the planner's tree); any other block by its type and id, `paragraph b_12`,
  `task b_9`, `list b_3`; a block whose row and tree are both unknown
  `block <id>`. A block already in the store is named from its live row even
  when an earlier effect of the plan rewrote it.
- **a section**: `section "Risks"` (its heading's text).
- **a value**: the canonical JSON of §11.5 (`false`, `"salt"`, `[1,2]`).
- **counts**: `<n> <noun>` with an `s` on every noun but one — `1 block`,
  `2 blocks`, `1 link`, `3 documents`, `2 pairs`, `offset` / `offsets`.
- **a placement** (`insert` / `move` blocks): `at|to the end of <container>`
  or `at|to the start of <container>` — `at` for an insert, `to` for a move;
  the container a document (its path, nothing after it), a section
  (`section "Risks" in <path>`) or a block (`<block name> in <path>`) — or
  `before|after <block name> in <path>` for an anchored `at`.

| Effect | Line |
| --- | --- |
| `create` | `create <path> (<n> blocks)` — `<n>` the top-level blocks of the parsed body (`create /lab/2026-03-notes.md (3 blocks)`) |
| `insert` | `insert <n> blocks <placement>` — `<n>` the top-level blocks the markdown parsed to (the kernel result's `ids`): `insert 2 blocks at the end of section "Risks" in /x.md`, `insert 1 block after paragraph b_7 in /x.md`, `insert 1 block at the end of /x.md` |
| `set frontmatter.<k>` | `set frontmatter.<k> = <value> in <path>` (`set frontmatter.verified = false in /substances/salt.md`) |
| `unset frontmatter.<k>` | `unset frontmatter.<k> in <path>` |
| `set content` | `set content of <path>` |
| `set markdown` | `set markdown of <block> in <path>` (`set markdown of paragraph b_12 in /x.md`) |
| `set attrs.checked` | `check <block> in <path>` for `true`, `uncheck <block> in <path>` for `false` (`check task b_9 in /x.md`) |
| `set <prop>` on a node | `set <prop> = <value> on node <id> in <path>` |
| `move` a document | `move <from> → <to>` (U+2192), plus ` (retarget <n> links in <m> documents)` when the inbound rewrite lowered — `<n>` the inbound links rewritten (the links that were not left dangling), `<m>` the source documents |
| `move` blocks | `move <block> <placement>` for one block, `move <n> blocks <placement>` for several (`move paragraph b_12 after task b_7 in /x.md`, `move 3 blocks to the end of /b.md`) |
| `remove` a document | `remove <path>` |
| `remove` blocks | `remove <block> from <path>` for one, `remove <n> blocks from <path>` for several (`<path>` the first block's document — a kernel `remove` names blocks of one document) |
| `split` | `split <block> at offset <a> in <path>`; several offsets `at offsets <a>, <b>` (`split paragraph b_12 at offset 40 in /x.md`) |
| `merge` | `merge <n> blocks into <first block> in <path>` (`merge 2 blocks into paragraph b_12 in /x.md`) |
| `retarget` | `retarget <n> links <from> → <to> in <m> documents` for one repair pair (as written), `retarget <n> links over <k> pairs in <m> documents` for several — `<n>` the hits, `<m>` the distinct documents they fall in (`retarget 3 links /a.md → /b.md in 2 documents`; `retarget 0 links /a.md → /b.md in 0 documents` for no hit) |

A selector-expanded plan prefixes nothing: the lines are those of its
concrete effects, so the counts are real. The lines are the reference's
`effects.ts` (`ctx.summary`) and the port's `omgbase-mutate::effects`; the
Receipt pins them in every committing fixture step (§9).

## Decisions

- 2026-10-13, mutate 3.4: the shape errors learn to teach (with
  `spec/surface` 4.5). A 78-run agent benchmark against the minimal profile
  passed every task but guessed four effect shapes wrong first — `at:
  "after"` as a bare string with the anchor block as `into`, a plural
  `expect` nested guard-first, `expect.max` inside an effect, a block
  `field: "text"` — and the shape check answered with a rule each time. Now
  each carries a `fix` (§8, four rows): the corrected call spelled from the
  effect as written, the anchor fix reading the block's live row for its
  parent (the one shape fix that touches the store; no live block → no
  fix), the others pure rewrites; the messages of the first three name the
  right shape. The shape check takes an optional `ShapeFixContext` from the
  planner's compile; a library call without it gets the same errors with no
  `fix`. Additive — no `plan_id`, intent record or `planner_v` moves, every
  well-formed request is byte-identical to 3.3: a minor. Fixtures:
  `effects.json` 79 → 92 (the `shape-*` cases of §9); nothing else moves.

- 2026-10-13, mutate 3.3: the teaching surfaces — the plan's `summary`
  (§11.9) and the error `fix` (§8), both additive. A `summary` is one line
  per resolved effect in a fixed vocabulary (documents by rooted path,
  headings by text, other blocks by type and id, values in canonical JSON,
  counts with plural `s`), outside the digest and repeated by the Receipt so
  a committed write reads back in words; a `fix` is a literal corrected call
  in canonical JSON (a tool name prefixed when it is another tool's), built
  from the failed request — keep the later of two conflicting effects, the
  first identity of an ambiguous list, the exact count of an oversized
  selection, the literal form of a stray leader, the plan's effects as an
  `apply` for a stale or mismatched plan, a `create` moved before the symbol
  that needs it. No `plan_id` or intent record moves (`planner_v` stays
  `"p3"`); the fixture `error` outcome gains `fix`, the recorded Receipt
  `summary`: a minor. Fixtures: every committing step's receipt gains
  `summary`; `effects::conflicting-effects-*`, `select-scalar-collision-
  across-hits`, `select-expression-target-ambiguous`,
  `select-expect-max-exceeded`, `select-apply-requires-max`,
  `select-links-refused`, `sugar-leader-in-non-expression-slot`,
  `insert-into-symbol-before-create-is-target-missing`, `plan-rejects-stale-
  revision`, the stale/mismatch cases and `plan::stale-plan` gain `fix` (a
  `plan_mismatch` over the authored empty core gains none — `apply` takes at
  least one effect); nothing else moves.

- 2026-10-13, mutate 3.2: the `-> expr` sugar (§11.8 "Sugar"; the
  minimal-tools-profile design §3/§8 as revised). The leader rule is exact
  (`-> ` and nothing else opens an expression; everything else is literal,
  no escaping); a folded literal is the literal (constant folding, so the
  sugar and the spelled form digest alike); bare strings are targets (path /
  id / `$new.n`, a locator refused with a `fix`); and — the recommended
  branch, implemented — a plain request's expressions evaluate in their own
  target's row through one synthetic query per target, recorded as the
  plan's and the intent record's `templates`, with a `create` refused for
  want of a row. Additive: `planner_v` stays `"p3"`, no existing `plan_id`
  or intent record moves, a request without `-> `, bare targets or `{ oqx }`
  is byte-identical to 3.1 — a minor. The `symbol` target kind exists only
  between the shape check and resolution (a bare `$new.n`), never in a
  resolved effect. Fixtures: `effects.json` 63 → 79 (the `sugar-*` cases of
  §9); nothing else moved.

- 2026-10-13, mutate 3.1: query-directed planning (§11.8; ADR-021's
  follow-on, Brendan's decisions of 2026-10-13): `plan` / `apply` / `execute`
  take `select` + `expect` and the `effects` become templates; a template
  without a target writes to the hit, a target or value may be an
  expression over the row resolving to exactly one identity (`{ oqx }`);
  the selector compiles into one OQX projection by an AST rewrite (one
  snapshot, one evaluation; OQX stays pure, `spec/oqx` unchanged) and the
  concrete expansion feeds the existing lowering loop, so cross-hit
  collisions are the conflict rules' (`conflicting_effects`); `expect.max`
  bounds the selection and is required on the one-shot `apply`; a
  truncated selection refuses (`selection_too_large`); `selection` is the
  seventh digested member and `planner_v` is `"p3"` (every `plan_id`
  changes). Two codes (§8), the three effect steps gain `select` / `expect`
  (§9). Additive — a request without `select` is unchanged — so a minor.
  Decided against the design brief in one place: a `path: { oqx }` whose
  expression yields a row binds the row's `id` (a rendered row's `path` is
  the reference form; the id is the identity). Fixtures: `effects.json` 39 →
  63 (the `select-*` cases and the p3 vectors); every plan-bearing case of
  `effects.json` / `plan.json` and every intent record of `changesets.json`
  / `docs.json` / `materialize.json` re-digested under p3 (the design's
  estimate missed the `docs` and `materialize` suites' intent records);
  nothing else moved.
- 2026-10-12, mutate 3.0: the effects are the only public write request
  (ADR-021's retirement release, with `spec/surface` 4.0 and `spec/cli` 4.0;
  no deprecation period — no client of the retired inputs existed). Removed:
  the kernel request's `set_frontmatter` (§4; a head is the planner's,
  §11.3), `apply_opset` and the `{ opset, plan, result }` result of a
  whole-document update (§7 — the opset is the planner's internal result,
  surfaced as `preview.identity`), the reconciling create. Added: a `create`
  is a parsed tree the planner ADOPTS (slice 3, §11.3/§11.4): its blocks are
  `$new.k` symbols, every later effect may write into it, `opset.creates[]`
  carries `{ symbol, path, source, before_op }` so `execute` re-adopts it in
  the plan's order and aliases the replay's mints to the symbols; its commit
  is a known-id `ingest_known` with no triple under the `path_taken` guard
  (§4 step 5 (b)) — so a created document's dispositions are the api rule's
  (§10 "Changed"); the kernel `move` gains `doc` (§2.3; §10 "Fixed");
  `preview.identity` / `preview.retarget` (§11.4); the zero-effects rule
  (§11.7); `planner_v` `"p2"` (every `plan_id` changes). The document
  operations of §6 are the effect builders. Request shapes changed: a major.
  Fixtures: `effects.json` 33 → 39 (slice 3 ×5, the symbol-before-create
  error, the p2 digest vector) and every plan-bearing case re-digested;
  `create-then-set-on-new-doc` re-pinned (`api` dispositions, a head
  instead of the fold); `plan.json` `apply` halves → receipts,
  `stale-plan` staged through `plan_effects` → `execute`,
  `non-convergent-plan-refused` the planner's error; `docs.json` /
  `materialize.json` / `changesets.json` move when the `docs` step and the
  `apply` step's `set_frontmatter` follow (the builders).
- 2026-10-12, mutate 2.3: the public Effect layer (§11; ADR-021). Nine
  effects, a planner tier over the six-op kernel — nothing added to the
  kernel — and the verbs `plan` / `execute` / `apply { effects }`; a plan's
  identity is the sha256 of the canonical JSON of its executable core
  (§11.5), its new identities symbolic `$new.n` minted at execute and
  mapped in the receipt; contradictions rejected by focus kind at plan time
  (§11.3); `commits.ops` populated for effect-driven commits (§4 step 5
  (b)). Additive — the kernel `Request`/`Opset` are unchanged — so a minor.
  Three codes (§8), four fixture steps and the `effects.json` suite (33
  cases, §9); no existing case moved. Decided against the design brief in
  three places (§10): the digest form reports only `plan_mismatch`; the
  plan's lowered form carries the document operations (`creates`, `moves`,
  `tombstones`) so `execute` replays without re-lowering; `set_frontmatter`
  entries are file heads.

- 2026-10-12, mutate 2.2: the commit transaction opens `BEGIN IMMEDIATE`
  and re-validates every loaded document's `(path, current_rev, file_hash)`
  and the document operations' guards before minting anything (§4 step 5
  (b)); `docs_set_meta` is under the same CAS. Foundation step 4 of the
  effect planner: the triple is what a frozen plan's preconditions will
  carry, so `execute` can check them at commit. Procedure change, no
  fixture movement; a minor. Same line, foundation step 5: the commit is
  database first — files are materialized after COMMIT from the pending
  rows the transaction records (§4 step 5 (c), `spec/store` 14.0 §5.7), so a
  conflict inside the transaction touches no file and a crash after it
  loses no intent; `docs_delete` unlinks only the deleted revision's bytes;
  `docs_move` renames through a `rename` row with the fallbacks §6 lists.
  Fixtures: every `expect` gains `pending_materializations: []`; the new
  `materialize.json` suite (16 cases) pins the crash window through the
  `crash_after_commit` modifier and the `materialize` step; nothing else
  moved.
- 2026-10-12, mutate 2.1: a request commits in one transaction with one
  `commits` row and one revision per loaded document (§4 step 5), the
  file-CAS of every document runs before any file is written, and
  `docs_move` commits its path change and the inbound retarget as one
  commit under `move <from> -> <to>` (§6). Foundation step 3 of the effect
  planner (after the writer-lock and transaction-hygiene steps): a
  changeset that is half committed has no honest `changes_since` digest,
  and the planner needs one commit to hang a plan on. What an op does
  changed (atomicity, commit shape in history), the request/response shapes
  did not: a minor. Fixtures: `commit::conflict-on-third-doc-keeps-first-two`
  renamed `conflict-on-third-doc-commits-nothing` (nothing of the request
  lands); the multi-document `changesets` cases and `docs::move-retarget-
  inbound`/`move-default-retargets` re-point their second document's rows
  at the shared commit and renumber later `c_` ids; nothing else.
- 2026-10-11, mutate 2.0 (surface 3.0 batch 3): the renamed keys are bare —
  `revisions: [{ id, path, hash }]`, the opset `target: { id, path }` and
  `precondition: { id, path, base_revision, hash }`, `stale_expectation`/
  `stale_plan` `current.hash` — because `spec/surface` §1.2's final rule gives
  omgbase no `$` names (`$` is OQX's); the entry below described the `$id`/
  `$path`/`$hash` interim spelling of the same unshipped 2.0 line. Fixtures:
  the same expectations re-keyed again, nothing else.
- 2026-10-11, mutate 2.0: the request/response shapes follow the surface's
  row rule (`spec/surface` §1.2, 3.0: `$` marks exactly the engine-provided
  names that contend with user names — a row's `$id`, `$path`, `$hash`,
  `$raw`, `$updated_at` — and a result key carrying a row attribute is
  spelled as that attribute; everything else is a plain field, role keys
  and inputs keep their names). A changeset's `revisions` are `[{ $id, $path,
  $hash }]` (`{ doc, path }` before — the hash is new, so a mutating tool's
  revision and a `changes_since` revision are one shape); an opset's `target`
  is `{ $id, $path }` and its `precondition` `{ $id, $path, base_revision,
  $hash }` (`base_content_hash` was the document's hash); `stale_expectation`
  and `stale_plan` report `current.$hash` (`current.content_hash`). Inputs —
  `doc`, `block`, `blocks`, `expect.content_hash`, `set_frontmatter[].doc` —
  and the document operations' own results (`{ doc, path, committed }`, which
  the surface re-shapes) are unchanged. Response shapes changed: a major.
  Fixtures: every `revisions`, `precondition`/`target` and `current`
  expectation re-keyed (and `revisions` gain `$hash`), nothing else.
- 2026-09-28, mutate 1.3: `docs_move` retargets the inbound links by
  default (`retarget_inbound` defaults to `true`; `false` opts out). A move
  that leaves the graph broken until a second call was the common accident
  the MCP surface produced; the operation's own result already knew the
  links. What an op does changed: a minor. Fixtures: `docs::move-default-
  retargets` (no argument), `move-retarget-inbound` (`true`),
  `move-leave-inbound` (`false`, the former default pinned as the opt-out).
- 2026-09-27, mutate 1.2: the destination parent of `insert`/`move` must be
  a container; a leaf is `type_mismatch` (least surprising: an error over
  silent data loss; `at.before`/`at.after` and `sections_append` already
  express "next to" and "into the section").
- 2026-09-26, mutation 1.0 specified as built (one fix: byte offsets in
  `split`). The crate is pure (tree, ops, render, lowering, opset); the store
  owns loading, the commit protocol, macros and document operations because
  they read and write the database and the doc store.
- 2026-09-26, mutate 1.1: `parent_children_hash` is a live CAS on every op
  (least surprising: a documented expectation that is sent must be checked).
