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
| `@omgbase/core` (TypeScript, npm) | `packages/core/src/mutate/{tree,ops,apply,commit,materialize,load,known-ids,macros,docs,doc-store,plan-update,lower,opset,effects,plan}.ts` | **Reference.** Mutation decisions land here first. |
| `omgbase-mutate` (Rust, crates.io) | `crates/omgbase-mutate` | Conformance-first port: the working tree, the six ops, the splice renderer, the lowering and the opset, the effect vocabulary with its conflict rules, lowering and canonical JSON (pure); `omgbase-store` loads, commits, plans and runs the macros, the document operations and the effect planner's `plan`/`execute`. |

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
Result   { results: [{ ids, removed?, merged_into? }], revisions: [{ id, path, hash }], diffs?: { path: { before, after } }, committed }
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
     document commits first (§10); finally one **pending row** per file the
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

All are `api` commits with a generated `reason`.

- **`docs_create { path, markdown, frontmatter? }`**: canonicalize the path
  (strip leading `/`, `\` → `/`); a live doc there → `path_taken`; compose
  the file (body with a trailing `\n` ensured; when `frontmatter` is a
  non-empty object: `"---\n" + yaml + "\n---\n" + ("\n" unless the body
  starts with one) + body`, `yaml` being the mapping serialized by the
  reference's YAML emitter — §10); a file already on disk → `path_taken`;
  ingest with the **reconciling** resolver (`reason: "create <path>"`)
  under §4 step 5's commit, recording a `write` row; the file is written in
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
  create), ingest with the reconciling resolver
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

1. Load the doc (`doc_missing`); `precondition.hash = sha256(render(doc))`
   (the document's current `hash`), `base_revision = current_rev` (2.0:
   `target`/`precondition` spelled `doc`/`path`/`base_content_hash` before).
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
`stale_plan` (retriable, `{ doc, expected_revision, current: { revision,
hash } }`) when `base_revision` (if non-null) differs from `current_rev` or
the doc's `file_hash` differs from `precondition.hash`; else `apply` with the
plan's kernel ops and `set_frontmatter`.

## 8. Errors

Codes: `stale_expectation`, `block_missing`, `target_missing`,
`parent_missing`, `doc_missing`, `cycle_move`, `not_contiguous`,
`type_mismatch`, `path_taken`, `node_not_editable`, `stale_plan`,
`plan_not_convergent`, `sync_conflict`, and (2.3, §11) `conflicting_effects`
(`{ effects: [i, j], focus: { kind, target, field? }, retriable: false }`),
`unsupported_plan_version` (`{ version, supported: [1] }`), `plan_mismatch`
(`{ expected, actual }`, two plan ids). A malformed effect or plan object is
the surface's argument-shape error `filter_invalid { reason, hint:
"arguments" }` (`spec/surface` §4), thrown by the planner. Fixtures compare
the code and the listed data fields (`op_index`, `block`, `current`,
`retriable`, and since 2.3 `effect_index` — the index of the effect a
planner error arose from, added to every error the planner or its kernel
ops raise — `effects`, `focus`, `symbol`, `version`, `supported`,
`expected`, `actual`); messages are not pinned.

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
{ "materialize": {} }                                                                // replay every pending row (spec/store §5.7) → { materialized: [path…] }
{ "plan_effects": { "effects": [...] } }                                             // §11.6 `plan` → { plan } (minus preview) or the error
{ "execute": { "ts": "…", "plan_step": 1 | "plan": {...} | "plan_id": "…", "effects": [...],
               "origin": {...}, "crash_after_commit"?: true } }                     // §11.7 → { receipt } or the error
{ "apply_effects": { "ts": "…", "effects": [...], "origin": {...}, "dry_run"?: true } } // §11.7 → { plan } (dry run) | { receipt } | the error
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
`plan` → `{ opset, before_apply?, apply? }`; `disk` → `{}`; `materialize` →
`{ materialized: [path…] }` (the rows cleared, in insertion order; a row kept
for a foreign file is not listed); `plan_effects` → `{ plan }` or the error;
`execute` → `{ receipt }` or the error; `apply_effects` → `{ plan }` /
`{ receipt }` / the error; `canonical` → `{ json, digest }`. After the last step: `files` (path → bytes
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
vectors).

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
  fixtures.
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
  first block (§11.4); the kernel request's `set_frontmatter` is unchanged.
- **Pinned (2.3, with surface 3.2) — the block-level sugar tools lower
  through the planner.** `blocks_insert`, `blocks_update`, `blocks_move`,
  `blocks_remove`, `blocks_split`, `blocks_merge`, `blocks_check`,
  `nodes_set`, `blocks_append`, `docs_append`, `links_retarget` and
  `links_repair` are `apply { effects }` sugar (ADR-021's migration phase):
  each tool builds its effects (`insert` / `set markdown` / `set
  attrs.checked` / `move` / `remove` / `split` / `merge` / `set` on a node /
  `retarget`, with the tool's name as `origin.reason`), plans and executes
  them as one §4 request, and renders the §4 apply result from the plan's
  `preview` — `results` with every `$new.n` replaced by the receipt's id
  (committed) or, on a dry run, by one production mint per `new_ids` entry
  in order (the realize-symbols shim: the symbolic minter is the kernel's
  own mint sequence, so a dry run consumes exactly the ids the legacy path
  burned — `spec/surface` §9, `spec/cli` §3.6), `revisions` the receipt's or
  the preview's, `diffs` on a dry run only; a planner error loses its
  `effect_index` (the tool built the effects) and keeps the kernel's data.
  Their commits carry the intent record in `commits.ops`; the library paths
  (`apply`, the macros, the document operations) keep NULL. Five visible
  consequences, pinned: (1) **`blocks_update`'s `expect` is a guard the
  planner completes** — `expect: {}` or an order-only `{
  parent_children_hash }` with `markdown` pins the content hash from the
  live row and proceeds (through surface 3.1 the kernel saw the caller's
  bag as given and failed `stale_expectation` "expect.content_hash
  required"); a given `content_hash` is checked as given. (2)
  **`blocks_check` naming one block twice is one write** — the planner drops
  the identical duplicate (§11.3) and the result holds one entry per
  distinct block (through 3.1 the second op failed `stale_expectation`
  against the pre-check hash). (3) `blocks_update` with `markdown` and
  `checked` together is two effects — the caller's `expect` guards the
  first, the planner pins the second to the block as the first left it —
  two kernel ops and two results, collapsed to the first (the one-op shape;
  the intent record shows both). (4) `blocks_remove` / `blocks_merge` now
  pin `expect[id].content_hash` per block (invisible in results and bytes).
  (5) `blocks_update`'s `attrs` bag beyond `checked` — another key, a
  non-boolean `checked`, or a bag that sets nothing (a no-op revision) —
  stays on the legacy kernel path until 4.0. An empty `blocks`/`ids` list
  is the surface's argument error (`spec/surface` §4), no longer a
  malformed kernel op.

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
separate entry and commit origin, never an effect.

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

Any `id` — a target's, an anchor's, a `targets[]` member's — may be
**`$new.<n>`**, an identity an earlier effect of the same request creates
(§11.4). A symbol no earlier effect created (or one of the other kind: a
document symbol where a block is wanted) is `target_missing { symbol }`.
`move`/`remove` are distinguished by `target` (a document) vs `targets`
(blocks). The shape is checked before anything is resolved — an unknown
key, a missing or mistyped member, a target kind the op does not take, a
`field` not in §11.2 — and a failure is `filter_invalid { reason, hint:
"arguments" }` naming `effects[i]` and the member; an empty `effects` is one
too.

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
| `create` | `opset.creates[] = { path, source }`, `source = composeFile(markdown, frontmatter)` (§6 `docs_create`) with every later `set`/`unset frontmatter.<key>` on its `$new.n` **folded into `frontmatter` before composing**; a live document at `path`, a path an earlier effect of the plan already creates or moves to, or a file on disk → `path_taken`; `preconditions.absent_paths += path`; the symbol is allocated here (kind `document`). At commit: `ingest_reconciled { precondition: null }` (§4 step 5 (b): `path_taken` re-checked) |
| `insert into document` | kernel `insert { doc, to: { parent: { doc: true }, at }, markdown, expect? }` |
| `insert into section` | `insert { to: { parent: { heading: heading_id, scope: "section" }, at }, markdown, expect? }` (§1.1; an unknown heading is `parent_missing`) |
| `insert into block` | `insert { to: { parent: id, at }, markdown, expect? }` (the container rule → `type_mismatch`) |
| `set`/`unset frontmatter.<key>` on a document | the file is re-composed as `docs_set_meta` composes it (§6): `split(render(doc))` → `(frontmatter, body)`, the key set or deleted, `after = composeFile(body, merged)`; the document's **head** — `after` minus the rendered body blocks — becomes `opset.set_frontmatter[] = { doc, raw }` (one entry per document, the last patch wins). The head replaces the leading trivia and the frontmatter together (§10), so the body blocks keep their ids and bytes (a file without a trailing newline gains one on its last block's trivia); byte parity with `set_meta` is pinned by `effects::set-fm-matches-set-meta-bytes` |
| `set content` on a document | §7 `plan_update(doc, value)`: `converges: false` → `plan_not_convergent { doc, diagnostics }`; its `frontmatter` → the head `leading_trivia + raw`; its kernel ops appended with every `$k.ids[i]` placeholder shifted by the ops already planned. The planner's own dry runs mint under a throwaway symbol table (nothing of theirs reaches the plan) |
| `set markdown` on a block | `update { block, markdown, expect: { content_hash (pinned), parent_children_hash? } }` |
| `set attrs.checked` on a block | `update { block, attrs: { checked }, expect }` |
| `set <prop>` on a node | §5 `node_set(node, prop, value)` → its one `update`, the pin as above (`node_not_editable` / `block_missing` as there) |
| `move` a document | `opset.moves[] = { id, from, to }` (`doc_missing`; `path_taken` for a live document, an earlier create/move of the plan, or a file at `to`; `absent_paths += to`; the document's triple → `preconditions.docs`) and, unless `retarget_inbound` is `false`, the inbound rewrite of §6 `docs_move` as kernel `update`s (pinned). At commit: `move_path` then the sources' revisions, the moved document's own revision (when it is a source) at the NEW path — §6, one commit |
| `move` blocks | `move { blocks, to, expect? }` |
| `remove` a document | `opset.tombstones[] = { id, path }` (`doc_missing`; the triple → `preconditions.docs`); at commit the tombstone of §6 `docs_delete` (nothing pooled) |
| `remove` blocks | `remove { blocks, expect: { <id>: { content_hash (pinned), … } } }` |
| `split` | `split { block, at, expect }` |
| `merge` | `merge { blocks, separator, expect: { <id>: … } }` |
| `retarget` | §5 `links_repair(repairs, path_glob)` → its `update` per top-most block (pinned); no hit → no op |

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
  planner_v: "p1",               // the lowering + conflict rules above (the matcher_v precedent)
  effects: [ResolvedEffect],     // in order, duplicates dropped: document targets as { kind: "document", id, path }
                                 // (path in the storage form; a $new.n document keeps its symbol with the create's path),
                                 // defaults made explicit (insert/move `at: "end"`, move `retarget_inbound: true`,
                                 // merge `separator: " "`), a `create` path canonicalized; optional keys absent when absent
  opset: { creates: [{ path, source }], moves: [{ id, from, to }], tombstones: [{ id, path }],
           set_frontmatter: [{ doc, raw }], ops: [Op] },     // every key present ([] when empty); ops in the fixture spelling
                                                             // (`child_ids`), new structure named by kernel placeholders "$k.ids[i]"
  preconditions: { docs: [{ id, path, base_revision, hash }],      // §4 step 5's triple of every touched document: the loaded ones
                                                                   // in load order, then moved/removed documents in effect order
                   blocks: [{ id, content_hash }],                 // every pin, first-pin order ($new.n blocks excluded)
                   parents: [{ doc, parent: <block id> | null, parent_children_hash }],   // the caller's destination-parent pins
                   absent_paths: [path] },                         // create paths and move destinations, in effect order
  new_ids: [{ symbol: "$new.n", kind: "block" | "document" }],      // in allocation order (below)
  plan_id: "<64 hex>",           // §11.5
  diagnostics: [string],         // the dropped duplicates
  preview?: { results: [{ ids }], revisions: [{ id, path, hash }], diffs: { path: { before, after } } }   // not digested; omittable
}
```

**Symbolic identities.** The planner lowers under the **symbolic minter**:
every `b` the kernel mints while the ops are planned returns the next
`$new.n` (`n` counting from 0 across the plan), and a `create` allocates the
next `$new.n` of kind `document` when it is lowered. So a plan mints no
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
of the plan (`plan_id`, `diagnostics`, `preview` excluded). `canonical(v)`
is the JSON text of `v` under these rules, each exact:

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
core `{ version: 1, planner_v: "p1", effects: [], opset: { every key [] },
preconditions: { every key [] }, new_ids: [] }` digests to
`a20097a9c319b59a1313c83e1fd494bbb3cf4895040fbbddd2866e56b16cddd3`.

### 11.6 `plan`

`plan(effects)` → Plan. Validate the shape (§11.1), then under the symbolic
minter lower each effect in order (§11.3: resolve, classify — dropping or
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
executable whatever planned it. Then, under the writer lock when a
workspace is given: pre-check every `preconditions.docs` triple against the
rows (`doc_missing`; a difference → `stale_plan { doc, expected_revision,
current: { revision, hash }, retriable }`) and every `absent_paths` entry
(`path_taken`) — so a stale plan fails before a `b` is minted; **replay the
opset** under the production minter: `set_frontmatter` heads first, then
`ops` in order through §4 steps 1–4 (the `b` ids are minted here, before
the transaction, as every request's are — a failure after this point burns
them, in both engines alike); build the request's internal effects in this
order — per create `ingest_reconciled { precondition: null }`, per move
`move_path` (the inbound edges read now), the rendered documents'
`ingest_known`s (a moved document's at its new path), per tombstone
`tombstone { pool: false }` — and commit them as §4 step 5 with `ops` = the
intent record `canonical({ v: 1, plan_id, effects })` (the plan's resolved
effects, symbols kept). The transaction re-validates every triple
authoritatively; a document that moved meanwhile is `stale_plan` with
nothing minted of `c`/`d`/`r`. Replaying an executed plan fails the same
way (`effects::execute-replay-fails-stale-plan`): the preconditions decide,
no server-held handle, no idempotent replay.

**Receipt** `{ plan_id, commit, revisions: [{ id, path, hash }], new_ids:
{ "$new.n": <id> }, committed: true }`: `commit` the one `commits` row
(`null` when the plan had nothing to commit); `revisions` one per ingest in
effect order (a create's `id` is the document minted); `new_ids` maps the
plan's symbols to the ids the replay minted — the `i`-th block symbol to
the `i`-th `b` minted during the replay, the `i`-th document symbol to the
`i`-th `d` minted inside the transaction (the creates, in order; the
reconciling ingest's `b` mints for a created document's blocks follow the
replay's and are not symbols).

**`execute { plan_id, effects }`** (the digest form): plan the effects as
§11.6 (under the lock); the new plan's `plan_id` ≠ the given one →
`plan_mismatch { expected, actual }` — the effects differ, or the documents
they target moved (§10: the digest form cannot tell which); equal → commit
it as above.

**`apply { effects, dry_run? }`**: `dry_run` → the Plan (§11.6, preview
included); otherwise plan + commit under one writer lock and one
transaction → the Receipt. The one-shot and `plan` → `execute` produce the
identical store projection (`effects::set-fm-and-insert-section-*`).

## Decisions

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
