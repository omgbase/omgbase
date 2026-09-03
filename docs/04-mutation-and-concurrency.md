# omgbase — Mutation Algebra, Concurrency, and the Write Protocol

**Status:** normative.
**Depends on:** `01-architecture.md` §2, §10; `02-data-model.md`; `03-reconciliation-spec.md` §2.

---

## 1. The kernel: six operations

All mutation flows through `apply(changeset)`. The kernel ops:

| Op | Input | Changes | Default preconditions |
|---|---|---|---|
| `insert` | `{ doc?, to, markdown }` | Adds blocks. `markdown` may parse to several sibling blocks; minted IDs returned in order. Subtrees allowed (a list inserts whole). | target parent exists · anchor block exists |
| `update` | `{ block, markdown? , attrs?, expect }` | Content and/or typed attrs of one block. Placement untouched. Supplying `markdown` on a container replaces its subtree (children re-minted unless supplied markdown is a pure text edit of a leaf). | `expect.content_hash` **required** |
| `move` | `{ blocks[], to }` | Placement only; content untouched. `blocks` MUST be a contiguous sibling run (length ≥ 1). May cross documents. | all blocks exist · target parent exists · target not inside the moved subtree (`cycle_move`) |
| `remove` | `{ blocks[], expect? }` | Deletes subtree(s); deleted blocks enter the resurrection pool. | blocks exist · optional `expect.content_hash` per block |
| `split` | `{ block, at: [byte_offsets…], expect }` | One block becomes N (same type where syntactically valid, else paragraphs). Authored lineage `split_into` recorded. First fragment carries the ID (authored intent — unlike inferred splits, no dominance test). | `expect.content_hash` required |
| `merge` | `{ blocks[], separator? , expect? }` | Contiguous same-type siblings become one. First block carries the ID; others recorded `merged_into`. | contiguous · same type |

### 1.1 Placement addressing

```ts
type To = {
  parent: BlockId | DocId | { heading: BlockId, scope: "section" },
  at: "start" | "end" | { before: BlockId } | { after: BlockId }
}
```
- `parent: DocId` means top level of the document.
- `scope:"section"` resolves against the derived section range: `at:"end"` = before the next peer/higher heading.
- Ordering uses fractional keys internally (`02-data-model.md` §5.3); the API never exposes keys, only ordinals.

### 1.2 Expectations (CAS vocabulary)

```ts
type Expect = {
  content_hash?: Hex,          // block's current raw_hash (update/remove/split)
  doc_revision?: RevId,        // whole-doc strictness (rarely needed)
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
- **`dry_run: true`** runs full validation + render and returns per-file unified diffs and the would-be results, committing nothing.
- Response: `{ commit, results: [per-op: {ids…}], revisions: [{doc, rev, path}], rendered_diffs? }`.

## 3. Macros (conveniences, not primitives)

Macros expand server-side into kernel ops **within the same changeset**, and results are reported in kernel vocabulary (the expansion is visible in the response). Test for macro-hood: expansion must be deterministic — no policy judgment. If it needs judgment, it belongs in the agent.

| Macro | Expansion |
|---|---|
| `tasks_complete { blocks[] }` | `update(attrs: {checked:true})` per block |
| `sections_append { heading, markdown }` | `insert(to: {parent:{heading,scope:"section"}, at:"end"})` |
| `sections_rename { heading, title, expect }` | `update(heading block markdown)` |
| `sections_move { heading, to }` | `move(range resolved from section)` |
| `lists_insert_item { list|item, at, markdown }` | `insert` with list-item typing |
| `links_retarget { from_target, to_target, scope?, dry_run }` | query edge sources → `update` per affected block, rewriting only the link destination substring. Always run `dry_run` first by convention; the tool description says so. |

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
    "markdown": "the block's live markdown",
    "revision": "r_90ttx4e",
    "changed_by": "c_812acfd"           // the commit that invalidated the expectation
  },
  "retriable": true
}
```

Error codes (shared with `06-mcp-api.md` §5): `stale_expectation`, `parent_missing { deleted_in }`, `target_missing`, `block_missing`, `doc_missing`, `cycle_move`, `opaque_block`, `not_contiguous`, `type_mismatch`, `conflicted_document`, `path_taken`, `ambiguous_locator { candidates[] }`, `filter_invalid`, `budget_exceeded (partial result)`, `semantic_unavailable`, `sync_conflict`.

## 5. Concurrency model

The engine is the single serialization point (ADR-008): commits are applied under a per-repo writer lock (short transactions). There are no diverging replicas, hence no CRDT/OT — only **stale readers**, handled by OCC.

Required behaviors (torture-test suite, Stage 3 exit gate):

| Scenario | Required outcome |
|---|---|
| Two agents `insert at:"end"` in one section | Both succeed; deterministic order by arrival; fractional keys, no renumber |
| Agent A `move` block; agent B `update` same block | Both succeed (content CAS unaffected by placement change) |
| Agent A `remove` section; agent B `insert` into it | B fails `parent_missing { deleted_in: c_A }` |
| Human saves file while agent changeset in flight | File-CAS abort → ingest → auto-replay ops (once) → success if preconditions hold, else typed conflict |
| Two agents reorder same siblings | Last writer wins unless `parent_children_hash` supplied → `stale_expectation` |
| Agent updates block deleted by human's save | `block_missing` with resurrection-pool hint if present |

## 6. The file write protocol (API path)

```
apply(changeset):
 1. acquire repo writer lock
 2. resolve all references; validate all preconditions against current state
 3. for each touched doc:
      a. tree′ = apply ops to current revision tree
      b. bytes = render(tree′)                        # splice (03-… §2.2)
 4. for each touched file:
      assert sha256(file_on_disk) == current_revision.rendered_hash
        on mismatch → release lock, ingest that file (observed commit),
                      re-resolve + re-validate ops against new revision (ONE retry),
                      else return typed conflict
 5. write temp file → fsync → atomic rename → fsync dir
 6. register expected-hash with watcher (echo suppression)
 7. single DB transaction: blobs, tree_nodes, revisions, commit, dispositions(api),
    edge extraction, index maintenance
 8. release lock; return results
```

Crash safety: steps 5 and 7 are ordered file-first; on startup the engine reconciles any file whose hash ≠ its recorded rendered_hash (normal ingest path heals a crash between 5 and 7 — the write is simply observed).

## 7. Deletion semantics

- `remove` tombstones blocks (`deleted_commit`) and inserts into `resurrection_pool` (TTL 30d).
- Document delete = `docs_delete` (doc-level op): file is deleted on disk, document tombstoned, blocks pooled.
- Observed file deletion: same, via checkpoint.
- Nothing is hard-deleted by the engine in v1 except expired pool rows; GC of unreachable objects ships dark (02-data-model §7).
