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
| `insert` | `{ doc?, to, markdown }` | Adds blocks. `markdown` may parse to several sibling blocks; minted IDs returned in order. Subtrees allowed (a list inserts whole). | target parent exists · anchor block exists |
| `update` | `{ block, markdown? , attrs?, expect }` | Content and/or typed attrs of one block. Placement untouched. Supplying `markdown` on a container replaces its subtree (children re-minted unless supplied markdown is a pure text edit of a leaf). | `expect.content_hash` **required** |
| `move` | `{ blocks[], to }` | Placement only; content untouched. `blocks` MUST be a contiguous sibling run (length ≥ 1). May cross documents. | all blocks exist · target parent exists · target not inside the moved subtree (`cycle_move`) |
| `remove` | `{ blocks[], expect? }` | Deletes subtree(s); deleted blocks enter the resurrection pool. A set naming both a container and its descendants (or duplicates) collapses to its top-most blocks — every id is validated and CAS-checked first, while still in place — and `removed` lists every block that left. | blocks exist · optional `expect.content_hash` per block |
| `split` | `{ block, at: [byte_offsets…], expect }` | One block becomes N (same type where syntactically valid, else paragraphs). `at` are **UTF-8 byte offsets** into the block's raw bytes — the same unit as every persisted span (`spec/mutate` §2.5; the reference converts them to string indices before slicing, and an offset inside a multi-byte character rounds down to that character's start). Whitespace-only pieces are dropped. First fragment carries the ID (authored intent — unlike inferred splits, no dominance test); the new fragments get `\n\n` trailing trivia. | `expect.content_hash` required |
| `merge` | `{ blocks[], separator? , expect? }` | Contiguous same-type siblings become one. First block carries the ID; others recorded `merged_into`. | contiguous · same type |

### 1.1 Placement addressing

```ts
type To = {
  parent: BlockId | { doc: true } | { heading: BlockId, scope: "section" },
  at: "start" | "end" | { before: BlockId } | { after: BlockId }
}
```
- `parent: { doc: true }` means top level of the document.
- `scope:"section"` resolves against the derived section range: `at:"end"` = before the next peer/higher heading.
- Ordering uses fractional keys internally (`data-model.md` §5.3); the API never exposes keys, only ordinals.

### 1.2 Expectations (CAS vocabulary)

```ts
type Expect = {
  content_hash?: Hex,          // block's current raw_hash (update/remove/split/merge)
  parent_children_hash?: Hex,  // hash over ordered child ids of a parent — opt-in order CAS
}
```
Defaults are deliberately permissive where semantics allow (appends need no order CAS) and strict where they don't (update always needs content CAS). An op MAY tighten, never loosen, its table-default preconditions.

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

- **Atomic across documents.** All ops apply or none. One commit; one revision per touched doc; each touched file rendered and written once.
- Ops apply **in order** within the changeset; later ops see earlier ops' effects (the update above targets the moved block).
- Minted IDs from earlier ops are referenceable by later ops via `"$0.ids[1]"`-style placeholders (op index + result path).
- **`dry_run: true`** runs full validation + render and returns per-file `{ before, after }` diffs and the would-be results, committing nothing.
- Response: `{ results: [per-op: {ids}], revisions: [{doc, path}], diffs?: {path → {before, after}}, committed }` (`ApplyResult` in `apply.ts`); `diffs` is populated on a dry run.

## 3. Macros (conveniences, not primitives)

Macros expand server-side into kernel ops **within the same changeset**, and results are reported in kernel vocabulary (the expansion is visible in the response). Test for macro-hood: expansion must be deterministic — no policy judgment. If it needs judgment, it belongs in the agent.

| Macro | Expansion |
|---|---|
| `tasks_complete { blocks[] }` | `update(attrs: {checked:true})` per block |
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
    "content_hash": "b71e…",
    "markdown": "the block's live markdown"
  },
  "retriable": true
}
```

The `current` payload is op-specific: `checkContentHash` throws `{ content_hash, markdown }`; a `parent_children_hash` mismatch carries `{ parent_children_hash }`; the whole-document planner's `stale_plan` carries `{ revision, content_hash }` (`ops.ts`, `plan-update.ts`). A **missing** `expect.content_hash` (not just a mismatched one) throws `stale_expectation` with the same `{ content_hash, markdown }` `current` payload and `retriable: true`, so an op that omitted the CAS token is retriable straight from the error — no separate hydration read. (Better still, ask for it up front: `docs_read`/`docs_get_many` with `include_ids:true` return a `hashes` map giving every block's current content hash alongside its id.)

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
 --- commit phase, per touched file (under the cross-process writer lock when a
     workspace .omgbase/ dir is supplied; else the Store's in-process serialization) ---
 4. file-CAS: assert sha256(file_on_disk) == the doc's stored file_hash
      on mismatch → a human edit landed first: ingest the on-disk file
        (reconciling resolver, observed commit), refresh the stat cache, and
        throw a RETRIABLE `sync_conflict` — the caller re-plans/re-applies
 5. atomic write: temp file → rename
 6. re-ingest the rendered bytes as a commit with origin:"api" (carrying the caller's actor and reason) and a KNOWN-ID
    resolver: the mutated tree already carries deterministic ids (ops keep/mint
    them), so identity threads onto the re-parsed tree and intent dispositions
    are recorded at confidence 1.0 — never re-derived from the bytes by the
    probabilistic matcher. Prior live ids no longer present are pooled; ids
    new to the document (a cross-document move's arrivals) evict the source
    document's row and any pool row, whichever document commits first. This
    ingest persists blobs, tree_nodes, the revision + commit, edge extraction,
    and index maintenance. The commit timestamp defaults to now; callers may
    pin it (`ApplyRequest.ts`, `DocOpContext.ts`, `ApplyOpsetRequest.ts`) —
    the spec fixtures do, so `commits.ts` compares across engines.
 7. refresh the freshness stat cache (recordFileStat) so a later sweep won't
    re-hash the engine's own write; the watcher's content-hash echo gate
    suppresses re-ingesting it
 8. return results
```

Crash safety: the file is written (step 5) before the commit is recorded (step 6); on startup / the next freshness sweep the engine reconciles any file whose content hash ≠ its stored `file_hash` (the normal ingest path heals a crash between the write and the commit — the write is simply observed).

## 7. Deletion semantics

- `remove` tombstones blocks (`deleted_commit`) and inserts into `resurrection_pool` (TTL 30d).
- Document delete = `docs_delete` (doc-level op): file is deleted on disk, document tombstoned, blocks pooled.
- Observed file deletion: same, via checkpoint.
- Nothing is hard-deleted by the engine in v1 except expired pool rows; GC of unreachable objects ships dark (data-model §7).
