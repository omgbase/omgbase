# omgbase — Mutation Algebra, Concurrency, and the Write Protocol

**Status:** normative.
**As-built (verified 2026-09-26).**
**Depends on:** `architecture.md` §2, §10; `data-model.md`; `reconciliation-spec.md` §2.

> **The language-neutral specification is [`spec/mutate/README.md`](../spec/mutate/README.md)** (the working tree, the six ops as exact rules, the splice renderer's dirty rules, changesets and the commit protocol, macros, document operations, the whole-document planner) with its executable fixtures under `spec/mutate/cases/` — run by `packages/core/corpus/mutate/spec.test.ts` (`MUTATE_SPEC_UPDATE=1` regenerates) and by the Rust `omgbase-mutate` crate. When this document and the spec disagree, the spec's fixtures win. This document keeps the rationale and the operational picture.

---

## 1. The kernel: six operations

All mutation flows through `apply(changeset)`. The kernel ops:

| Op | Input | Changes | Default preconditions |
|---|---|---|---|
| `insert` | `{ doc?, to, markdown, expect? }` | Adds blocks. `markdown` may parse to several sibling blocks; minted IDs returned in order. Subtrees allowed (a list inserts whole). | target parent exists · anchor block exists · optional `expect.parent_children_hash` of the **destination** parent |
| `update` | `{ block, markdown? , attrs?, expect }` | Content and/or typed attrs of one block. Placement untouched. Supplying `markdown` on a container replaces its subtree (children re-minted unless supplied markdown is a pure text edit of a leaf). | `expect.content_hash` **required** |
| `move` | `{ blocks[], to, expect? }` | Placement only; content untouched. `blocks` MUST be a contiguous sibling run (length ≥ 1). May cross documents. | all blocks exist · target parent exists · target not inside the moved subtree (`cycle_move`) · optional `expect.parent_children_hash` of the **destination** parent (checked once for the run) |
| `remove` | `{ blocks[], expect? }` | Deletes subtree(s); deleted blocks enter the resurrection pool. A set naming both a container and its descendants (or duplicates) collapses to its top-most blocks — every id is validated and CAS-checked first, while still in place — and `removed` lists every block that left. | blocks exist · optional `expect.content_hash` per block |
| `split` | `{ block, at: [byte_offsets…], expect }` | One block becomes N (same type where syntactically valid, else paragraphs). `at` are **UTF-8 byte offsets** into the block's raw bytes — the same unit as every persisted span (`spec/mutate` §2.5; the reference converts them to string indices before slicing, and an offset inside a multi-byte character rounds down to that character's start). Since spec/mutate 3.5 the pieces are **trimmed at the cut edges** (`ops.ts` `trimCutEdges`: every piece but the last loses its trailing whitespace, every piece but the first its leading whitespace — the format's trim set; the raw's own start and end stay as authored), so an offset before, after or inside a run of whitespace yields the same pieces and no piece ends in a stray space. Whitespace-only pieces are dropped. First fragment carries the ID (authored intent — unlike inferred splits, no dominance test); the new fragments get `\n\n` trailing trivia. | `expect.content_hash` required |
| `merge` | `{ blocks[], separator? , expect? }` | Contiguous same-type siblings become one. First block carries the ID; others recorded `merged_into`. | contiguous · same type |

### 1.1 Placement addressing

```ts
type To = {
  parent: BlockId | { doc: true } | { heading: BlockId, scope: "section" },
  at: "start" | "end" | { before: BlockId } | { after: BlockId }
}
```
- `parent: <BlockId>` means that block's `children` — and the block must be a **container** (spec/mutate §1.1, since 1.2): for Markdown the kinds whose children the parser produces, `list`, `list_item`, `task`, `blockquote`, `table` (`packages/core/src/format/index.ts` `isContainerBlock`, backed by `MARKDOWN_CONTAINER_KINDS`); for other formats any block that has children. A leaf (`heading`, `paragraph`, `code_fence`, `table_row`, `thematic_break`, `html_block`, `opaque`) is `type_mismatch` with `{ op_index, block, type }` and the message `<id> is a <type>, not a container; place relative to it with at.before/at.after or append to its section`. Before 1.2 the kernel put the block into the leaf's empty `children`, marked the leaf dirty and re-rendered it from those children — the heading's own line vanished from the file. `insert` and `move` resolve `to` through the same function, so a move into a leaf is the same error, raised before anything is extracted. To place next to a leaf use `at: { before | after: <id> }`; to add to a heading's section use `{ heading, scope: "section" }` (`sections_append`).
- `parent: { doc: true }` means top level of the document.
- `scope:"section"` resolves against the derived section range: `at:"end"` = before the next peer/higher heading.
- Ordering uses fractional keys internally (`data-model.md` §5.3); the API never exposes keys, only ordinals.

### 1.2 Expectations (CAS vocabulary)

```ts
type Expect = {
  content_hash?: Hex,          // block's current raw_hash (update/remove/split/merge)
  parent_children_hash?: Hex,  // sha256 of a parent's ordered child ids joined by "," — opt-in order CAS
}
```
Defaults are deliberately permissive where semantics allow (appends need no order CAS) and strict where they don't (update always needs content CAS). An op MAY tighten, never loosen, its table-default preconditions.

`parent_children_hash` is checked on every op that carries it (spec/mutate §1.2, since 1.1 — before that the reference defined the hash and checked it nowhere). Which parent: `update`, `split`, and each block of `remove`/`merge` (via their per-block `expect[id]`) check the block's **current** parent; `insert` and `move` carry an op-level `expect` and check the **destination** parent — `to.parent` resolved exactly as the op resolves it, so `{ doc: true }`, a section scope, or a sibling anchor all name the top level of the anchored document, and a block id names that block's children. The order CAS runs **after** the content CAS and **before** the op mutates anything; a `move` of several blocks checks the destination once; a cross-document move checks the destination document's parent. A mismatch is `stale_expectation { op_index, current: { parent_children_hash }, retriable: true }` carrying the live hash (no `block`). Read the live hash as sha256 of the ordered live child ids (`docs_read` with `include_ids`); the top level is the document's top-level block ids.

## 2. Changesets

```jsonc
// apply request
{
  "repo": "worknotes",
  "dry_run": false,
  "ops": [
    { "op": "move",   "blocks": ["b_q4aaaaa"],
      "to": { "parent": { "heading": "b_decs01", "scope": "section" }, "at": "end" } },
    { "op": "update", "block": "b_q4aaaaa",
      "markdown": "**Decided:** stable IDs are engine-local.",
      "expect": { "content_hash": "9f2c…" } }
  ],
  "origin": { "actor": "agent:claude", "reason": "promote decision from open questions" }
}
```

Semantics:

- **Atomic across documents.** All ops apply or none. One commit row; one revision per touched doc; each touched file rendered and written once; the database commit is **one transaction** over every touched document (`spec/mutate` 2.1 — through 2.0 the commit phase was per document, so a `sync_conflict` on the n-th document left the earlier ones committed). A `changes_since` digest for the request is one entry with N revisions.
- Ops apply **in order** within the changeset; later ops see earlier ops' effects (the update above targets the moved block).
- Minted IDs from earlier ops are referenceable by later ops via `"$0.ids[1]"`-style placeholders (op index + result path).
- **`dry_run: true`** runs full validation + render and returns per-file `{ before, after }` diffs and the would-be results, committing nothing.
- Response: `{ results: [per-op: {ids}], revisions: [{ id, path, hash }], diffs?: {path → {before, after}}, committed }` (`ApplyResult` in `apply.ts`; `hash` is the document's rendered hash after the write — the same revision shape `changes_since` carries, `spec/mutate` 2.0); `diffs` is populated on a dry run.

## 2b. Effects and plans (the planner tier — spec/mutate 2.3 §11, ADR-021)

Above the changeset sits the public intentional-write vocabulary: nine effects (`create insert set unset move remove split merge retarget`) over document/block/node/section targets, each lowering deterministically to kernel ops, `set_frontmatter` or a document operation (`mutate/effects.ts` `lowerEffect`; Rust `omgbase-mutate/src/effects.rs`). Since spec/mutate 3.6 a `set`/`unset frontmatter.<k>` is a **per-entry** head edit: `effects.ts` `patchFrontmatterKey` cuts the document's head into frontmatter parts by the lexical line rule of spec/mutate §11.3 "Frontmatter entries" (`mutate/frontmatter-parts.ts` — fences, one part per column-0 `key:` entry with its continuation lines and the comment lines that lead it, trailing comments), replaces exactly the key's part (its leading comment kept, the entry re-rendered as `stringify({ k: value })`), inserts a new key after the last entry or removes an unset key's part, and leaves every other part byte-identical — a flow list, a quoted string or a comment on another key survives; a document without frontmatter still composes a fence as `docs_create` does. Storage is unchanged: a revision's frontmatter is still one blob (spec/store 15.0); the parts are the planner's view of the bytes. `planEffects` runs the lowering under a symbolic minter (new ids are `$new.n`, nothing issued) and freezes `{ version, planner_v, effects, opset, preconditions, new_ids, plan_id }` + a `preview`; `plan_id` = sha256 of the canonical JSON of the core (§11.5 rules; digest vectors in `effects::digest-vectors`). `executePlan` admits the plan (version, recomputed digest), replays the opset under the production minter zipping real mints onto `$new.n` per kind, asserts the re-rendered hashes equal the plan's, then runs §6's commit with the plan's preconditions re-validated in the transaction and `commits.ops = { v, plan_id, effects }`. `applyEffects` is plan + execute in one lock scope. Conflicts are the planner's: a scalar focus admits one write per plan (identical values dedupe), positional effects sequence, identity effects fence what follows (`conflicting_effects { effects: [i, j], focus }`). Since spec/mutate 3.1 a request may carry a `select` (OQX over docs/blocks/nodes) with effect templates: `mutate/select.ts` rewrites the query's AST to project one reserved alias per `{ oqx }` slot, runs it once, binds each hit to concrete effects (targetless → the hit; expression targets resolve to exactly one identity), and feeds the same lowering loop; the plan's digested `selection` freezes the hit identities so `execute` never re-queries. OQX itself has no write syntax. Since spec/mutate 3.3 the plan's `preview.summary` says each effect in words and a correctable error carries `data.fix`, a literal corrected call in canonical JSON (`mutate/canonical.ts`); since 3.4 the shape check itself spells four of them (`effects.ts` `validateEffect` under a `ShapeFixContext` the compile in `select.ts` supplies — the bare `"after"` anchor fix reads the block's live row for its parent, the plural-`expect` inversion, the effect-level `expect.max` move and the block `field: "text"` → `markdown` rewrite are pure). Fixtures: `spec/mutate/cases/effects.json`.

## 3. Macros (conveniences, not primitives)

Macros expand server-side into kernel ops **within the same changeset**, and results are reported in kernel vocabulary (the expansion is visible in the response). Test for macro-hood: expansion must be deterministic — no policy judgment. If it needs judgment, it belongs in the agent.

| Macro | Expansion |
|---|---|
| `blocks_check { blocks[] }` | `update(attrs: {checked:true})` per block |
| `sections_append { heading, markdown }` | `insert(to: {parent:{heading,scope:"section"}, at:"end"})` |
| `sections_rename { heading, title, expect }` | `update(heading block markdown)` |
| `sections_move { heading, to }` | `move(range resolved from section)` |
| `lists_insert_item { list|item, at, markdown }` | `insert` with list-item typing |
| `links_retarget { from, to, path_glob?, dry_run }` | query edge sources → one `update` per top-most affected block, rewriting only whole link destinations (never prose, inline code, or code fences). The dry run plans through the kernel, so it fails exactly where the apply would; run it first by convention. |

## 4. Conflict objects

Every conflict is a typed error **carrying current truth** so the caller can retry without a read round-trip:

```jsonc
{
  "error": "stale_expectation",
  "op_index": 1,
  "block": "b_q4aaaaa",
  "expected_content_hash": "9f2c…",
  "current": {
    "hash": "b71e…",
    "markdown": "the block's live markdown"
  },
  "retriable": true
}
```

The `current` payload is op-specific: `checkContentHash` throws `{ hash, markdown }` (the block's current hash under the row rule of `spec/surface` §1.2; the caller's argument is still echoed as `expected_content_hash`); a `parent_children_hash` mismatch carries `{ parent_children_hash }`; the whole-document planner's `stale_plan` carries `{ revision, hash }` (`ops.ts`, `plan-update.ts`). A **missing** `expect.content_hash` (not just a mismatched one) throws `stale_expectation` with the same `{ hash, markdown }` `current` payload and `retriable: true`, so an op that omitted the CAS token is retriable straight from the error — no separate hydration read. (Better still, ask for it up front: `docs_read`/`docs_read_many` with `include_ids:true` return a `hashes` map giving every block's current content hash alongside its id.)

Error codes actually thrown by the write path (codes are stable per `mcp/errors.ts`): `stale_expectation`, `block_missing`, `target_missing` (anchor/placeholder not found), `parent_missing`, `doc_missing`, `cycle_move`, `not_contiguous`, `type_mismatch`, `path_taken` (`docs_create`/`docs_rename`), `ambiguous_heading` (a `{heading}` locator matching >1 heading), `node_not_editable` (a macro targeting a node with no editable block), `stale_plan` (the doc changed since the plan was computed), and `sync_conflict` (file changed on disk — retriable).

## 5. Concurrency model

The engine is the single serialization point (ADR-008): commits are applied under a per-repo writer lock (short transactions). There are no diverging replicas, hence no CRDT/OT — only **stale readers**, handled by OCC.

Required behaviors (torture-test suite, Stage 3 exit gate):

| Scenario | Required outcome |
|---|---|
| Two agents `insert at:"end"` in one section | Both succeed; deterministic order by arrival; fractional keys, no renumber |
| Agent A `move` block; agent B `update` same block | Both succeed (content CAS unaffected by placement change) |
| Agent A `remove` section; agent B `insert` into it | B fails `parent_missing` |
| Human saves file while agent changeset in flight | File-CAS mismatch → the on-disk file is ingested (observed) → a retriable `sync_conflict` is thrown; the caller re-plans/re-applies against the new revision |
| Two agents reorder same siblings | Last writer wins unless `parent_children_hash` supplied → `stale_expectation` |
| Agent updates block deleted by human's save | `block_missing` (`{op_index, block}`; the deleted block is snapshotted into the resurrection pool for reconciliation, but the error carries no pool hint) |

## 6. The file write protocol (API path)

```
apply(changeset):
 1. load every touched doc; resolve references and apply ops IN MEMORY in order,
    validating preconditions as each op runs — any failure throws before a byte
    is written (atomic: all ops apply or none)
 2. render each touched doc's mutated tree to bytes                # splice (03-… §2.2)
 3. dry_run:true stops here, returning per-file { before, after } diffs
 --- commit phase (under the cross-process writer lock when a workspace
     .omgbase/ dir is supplied — every host does: the CLI verb, the MCP tool
     call and the watcher take it once at their boundary and this inner
     acquisition is a re-entrant no-op; a bare library caller without a
     workspace dir gets the Store's in-process serialization only) ---
 4. phase A — read, outside any transaction: for every touched doc the stored
      (path, current_rev, file_hash) triple the plan loaded, and the on-disk
      bytes' hash; nothing is written
 5. phase C — ONE transaction (spec/mutate 2.1), opened BEGIN IMMEDIATE (2.2):
    FIRST re-validate — re-read every touched doc's triple through the
    transaction and compare with the plan's; a doc that moved on → ROLLBACK
    before anything is minted, retriable `stale_plan` with current truth; a
    stored file_hash that no longer matches the on-disk hash from phase A →
    ROLLBACK, `sync_conflict` (the bytes are then ingested as an observed
    commit in their own transaction); the doc ops re-check `path_taken` /
    `doc_missing` the same way (`docs_set_meta` included). Only then mint one
    commit row with origin:"api" (carrying the caller's actor and reason),
    then per touched doc re-ingest the rendered bytes under that commit with a
    KNOWN-ID resolver: the mutated tree already carries deterministic ids (ops
    keep/mint them), so identity threads onto the re-parsed tree and intent
    dispositions are recorded at confidence 1.0 — never re-derived from the
    bytes by the probabilistic matcher. Each carried block is classified
    against its live row the way `spec/reconcile` §2 classifies a carry
    (`mutate/known-ids.ts` `classifyCarries`: raw hash, parent, sibling index →
    `same` / `edited` / `moved` / `edited_moved`), and `same` is not persisted
    (`spec/store` §5.4 step 10, 14.2) — a one-paragraph edit writes one
    disposition row and moves one block's `updated_at`, not its siblings'
    (through store 14.1 every carried block was stamped `edited`). Prior live ids no longer present are
    pooled; ids new to the document (a cross-document move's arrivals) evict
    the source document's row. This ingest persists blobs, tree_nodes, the
    revision + commit, edge extraction and index maintenance — and, last, one
    `pending_materializations` row per file effect (write / rename / remove,
    with the hash the file must have; store 14.0) — self-contained since
    store 17.0 (M4): the row carries the `head` it renders, `rendered_hash`,
    `prior_hash` (the `file_hash` this transaction validated the file
    against — the bytes the engine last wrote there, which a replay may
    overwrite; NULL for a created document) and `created_at`, with no foreign
    key into the recorder's tables; a row already owed at the path is
    superseded (`spec/store` §5.7: a write replaces the target and keeps the
    earliest `prior_hash`, a rename carries the obligation of a write at
    `from_path`, a remove drops the write). The commit timestamp
    defaults to now; callers may pin it (`ApplyRequest.ts`, `DocOpContext.ts`,
    `ApplyOpsetRequest.ts`) — the spec fixtures do, so `commits.ts` compares
    across engines. A failure anywhere in here rolls back every document and
    touches no file.
 6. phase B' — materialize, after COMMIT, in effect order: write each rendered
    file (temp file, fsync, rename), rename a moved doc (if the destination
    appeared meanwhile with foreign bytes the row stays and the sweep applies
    "file wins"), unlink a deleted doc's file only if its bytes still hash to
    the recorded hash; delete each row as its file lands. A crash here leaves
    rows behind: the next write's materializer, the freshness sweep's step 0 or
    `recoverRepo` replays them with the api intent, commit and change-feed
    digest intact — rendering the document's CURRENT rows (`reconstruct`) and
    recognising the engine's own stale file by the row's `prior_hash`, never
    by a history read; an observation of a pending path meanwhile treats bytes that
    hash to the recorded hash as an echo, a missing file as "not yet written"
    (no tombstone), and anything else as a human edit that wins (ADR-004).
 7. refresh the freshness stat cache (recordFileStat) so a later sweep won't
    re-hash the engine's own write; the watcher's content-hash echo gate
    suppresses re-ingesting it
 8. return results
```

Crash safety: the commit is recorded (step 5) before the file is written (step 6, DB-first since store 14.0); on startup / the next freshness sweep the engine first replays the pending rows (step 0) and then reconciles any file whose content hash ≠ its stored `file_hash` (the normal ingest path heals a human edit that landed meanwhile — the file wins and the row goes with it).

## 7. Deletion semantics

- `remove` tombstones blocks (`deleted_at`) and inserts into `resurrection_pool` (`deleted_at`, TTL 30d from it).
- Document delete = `docs_delete` (doc-level op): file is deleted on disk, document tombstoned, blocks pooled.
- Observed file deletion: same, via checkpoint.
- Nothing is hard-deleted by the engine in v1 except expired pool rows; GC of unreachable objects ships dark (data-model §7).
