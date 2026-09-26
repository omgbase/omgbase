# omgbase — Whole-Document Update Opsets

**Status:** normative (as-built, 2026-09-26).
**Depends on:** `reconciliation-spec.md` (matcher), `mutation-and-concurrency.md` (kernel, CAS, write protocol), `architecture.md` §2 (convergence, identity).

> **The language-neutral specification is [`spec/mutate/README.md`](../spec/mutate/README.md) §7** (the opset shape, the top-level lowering as an exact rule — removes, updates with `child_ids`, LCS placement, retile — verification, the replace fallback, `apply_opset` preconditions), with executable fixtures in `spec/mutate/cases/plan.json` (`packages/core/corpus/mutate/spec.test.ts`, `MUTATE_SPEC_UPDATE=1`). When this document and the spec disagree, the spec's fixtures win.

---

## 1. Purpose

A caller submits the **complete proposed representation** of a document and relies on omgbase to preserve stable identities for blocks that are still recognizably the same things. Rather than hiding the inferred structural changes inside an opaque `docs.update`, whole-document reconciliation produces an explicit, serializable **operation set (opset)**:

```
proposed content
      ↓  reconcile / plan
    opset            ← inspect · edit · validate · serialize
      ↓  apply(opset)
    commit
```

Three concerns stay separate:

1. **representation** — the format adapter parses/renders complete documents;
2. **planning** — reconciliation determines the identity-preserving structural operations;
3. **execution** — the existing `apply` kernel atomically validates and commits the ops.

This keeps the reconciliation observable and testable instead of magical, while the atomic changeset kernel (04 §1) remains the single write path.

## 2. The opset

An opset is a plan whose mutations are the existing six kernel ops (insert/update/move/remove/split/merge), each annotated with the identity consequence the planner attributes to it. Reconciliation-specific information (disposition, confidence, reason) is **planning metadata**; it does not change kernel op semantics.

```ts
interface Opset {
  version: 1;
  kind: "doc_update";
  target: { doc: DocId; path: string };
  precondition: {
    doc: DocId;
    path: string;
    baseRevision: RevId | null;   // current_rev at plan time
    baseContentHash: Hex;         // sha256 of the current rendered bytes (docs.file_hash)
  };
  matcherV: string;               // matcher version that produced the decisions
  ops: PlanOp[];                  // executable kernel ops + identity annotations
  frontmatter?: { raw: string | null };  // document-level frontmatter change, if any
  summary: { preserved; updated; moved; created; removed; split; merged; ambiguous };
  converges: boolean;             // verified: replaying ops reproduces the proposed bytes exactly
  diagnostics: string[];
}

interface PlanOp {
  op: Op;                         // the kernel op (04 §1)
  disposition: DispositionKind | "retiled";
  blocks: BlockId[];              // subject ids (carried); empty for a fresh insert
  confidence: number | null;
  reason: string | null;
  detail?: Record<string, unknown>;
}
```

The opset is JSON-serializable (`serializeOpset`/`parseOpset`) and renders to a human-/agent-readable plan (`renderOpsetPlan`), e.g.:

```
UPDATE b_x2xezr6 edited ~0.88 [context_unique]
INSERT (new)     inserted
MOVE   b_456     moved

preserved: 37  updated: 4  moved: 2  created: 3  removed: 1  split: 0  merged: 0  ambiguous: 0
```

## 3. Planning (`planUpdate`)

`planUpdate(store, repoId, rootPath, docRef, content) → Opset` (also `docs_plan_update` MCP tool, and the read half of `docs update`/`docs_update`):

1. Resolve `docRef` (id or path) to the existing document; load its current tree (`MutDoc`). A missing document is `doc_missing` — creation is `docs_create`'s job.
2. Record the precondition: `baseRevision` (current_rev) and `baseContentHash` (sha256 of current rendered bytes).
3. Parse the proposed `content` with the document's format adapter; split off frontmatter.
4. **Reconcile** the proposed body against the current tree via the same `reconcileDocument` matcher the observation path uses (`03`), yielding a per-block assignment (carried or minted id) plus dispositions. No resurrection pool is consulted (see §6).
5. **Lower** the assignment to kernel ops (§4).
6. **Verify** by simulation and assemble the opset (§5).

The planner is deterministic up to minted-id values for a given (repository state, proposed content, adapter version, matcher version): the *decisions* (which id carries where, each disposition, the op shapes) reproduce exactly; only the opaque values of freshly-minted block ids vary (ids are minted from a CSPRNG, `02 §1`).

## 4. Lowering (reconcile → ops)

Lowering operates at **top-level block granularity**:

- **remove** — a current top-level block absent from the proposed tree (disposition `deleted`, content-hash pinned).
- **update** — a carried top-level block whose raw changed (`edited`). A carried container (list/blockquote) whose content changed is updated as a whole unit (its raw carries the children), but the op's `childIds` map threads the reconcile-carried identity of the container's items onto the re-parsed subtree, so a within-container edit/reorder/insert/remove **preserves the identity of every item that was not itself changed** (nested identity). Only genuinely-new items mint.
- **insert** — a proposed top-level block with no carried id (`inserted`), anchored after the preceding proposed block; the doc is named explicitly so a document-start insert resolves.
- **move** — a carried block whose top-level order changed. The longest common subsequence of surviving blocks is left in place; only the rest move (`moved`).
- **update `{ trivia }`** — trailing-trivia tiling (`retiled`) set exactly for inserted/moved blocks, any block whose trivia changed, and the block *anchoring* an insert/move (those ops heal a lone `"\n"` seam to a blank line so hand-authored ops never jam blocks; the proposed content may legitimately want the tight seam, e.g. a blockquote directly under a heading), so the committed bytes equal the proposed content precisely.
- **nested carries** — an id the reconciler carries from the top level *into* a nested position (a paragraph that became a blockquote's child) is still removed at the top level: the container it now lives in is inserted fresh and an insert cannot carry ids, so the identity is honestly lost rather than the bytes duplicated.

If no identity-preserving lowering converges, a guaranteed **replace** lowering (remove all top-level blocks + insert the whole body, `bulk_rewrite`) is used; if even that does not converge, the opset is returned with `converges: false` and is refused at apply.

### 4.1 Kernel extensions (04)

Byte-fidelity and nested-identity concerns are handled at the op layer (op *semantics* unchanged):

- **`move` seam healing.** Trivia is positional tiling, not owned by a block; a block that was last in a sibling list carried a lone `"\n"` that, once interior, would soft-merge with its neighbour (two paragraphs → one). `move` now re-tiles top-level seams (source gap + destination seam) so relocated blocks are never rendered jammed together. This fixes a latent corruption for hand-authored moves too.
- **`update { trivia }`.** An `update` may set a block's trailing trivia. Attr- and trivia-only updates change no block content, so they carry no content-CAS requirement (a supplied `expect.content_hash` is still honoured); a content edit (`markdown`) still requires content CAS (04 §1.2).
- **`update { childIds }`.** A container update may carry a positional-key → block-id map (keys relative to the container's children, `"/0"`, `"/1"`, `"/0/0"`, …). After the container's markdown is re-parsed, those ids are threaded onto the resulting subtree (positions absent from the map mint fresh), and the container is rendered **verbatim from its op-supplied raw** rather than rebuilt from children — the splice renderer's child-rebuild cannot reproduce nested/loose list formatting, so verbatim emission is both exact and identity-preserving. This is how within-container item identity survives a whole-container update; the children exist (clean) only to carry the threaded ids for the commit re-parse.
- **Faithful list-item ops.** Independent of the whole-document planner, the six kernel ops now render list items correctly (they previously corrupted): the mutate renderer reconstructs a dirty list from its items (`renderList`/`renderItem` — item raws are self-contained, ordered lists renumber); `remove`/`move` mark the containing list dirty (and drop an emptied list); `insert` into a list unwraps `- x` into sibling items rather than nesting; and `update` of a `list_item` unwraps to a single item, keeping it a list item and re-marking. So `lists_insert_item`, `node_set` on an item, a task toggle, and hand-authored item ops all round-trip.

Frontmatter is a document-level materialization unit (rendered before the block tree), not one of the six block ops; when the proposed content changes it, the opset carries `frontmatter.raw` and `apply` sets it via `ApplyRequest.setFrontmatter`.

## 5. Verification & convergence

The planner is **self-verifying**: each candidate lowering is simulated (dry-run `apply`) and the rendered result compared byte-for-byte to the proposed content. `converges` is set only when replaying the ops reproduces the proposed bytes exactly. This makes the feature correct-by-measurement rather than by assumption — it degrades **identity, never content**, mirroring the architecture's "false continuity is worse than lost continuity" and "identity carries continuity, never truth" (`01`). An invalid op script (a bad anchor) throws in `apply` and is treated as non-convergent, triggering escalation.

When a lowering diverges, its diagnostic names **where**: the first differing byte offset, the proposed top-level block whose span covers it (index, type, byte range), and a short expected-vs-rendered excerpt — e.g. `first divergence at byte 79 in proposed block #3 (blockquote, bytes 79-88): expected "> shorter\n…", rendered "\n> shorter\n…"`. A `plan_not_convergent` error at apply carries the last such diagnostic in its message (and all of them in `data.diagnostics`), so a caller learns which construct failed to round-trip rather than only that "no lowering converged".

**Fresh raw is authoritative.** Content an op supplies (`insert`'s markdown, `update`'s markdown, the full-replace body) is parsed into clean blocks and rendered verbatim from its raw; the re-parsed children exist only to carry ids. The splice renderer rebuilds a container from its children only when a *nested* op changed a child (the container's own raw is then stale), and that rebuild re-prefixes blockquote lines with `> ` and re-inserts a table's delimiter row (which mdast does not keep as a child). Before this, freshly parsed blocks were marked dirty and blockquotes/tables were rebuilt from children — dropping `> ` markers and the `| --- |` row — so any update that touched a blockquote/table (or any full-replace fallback of a document containing one) failed `plan_not_convergent` on ordinary Markdown.

## 6. Applying an opset (`applyOpset`)

`applyOpset(store, req)` (and `docs.update` = plan + apply):

1. Refuse a non-convergent plan (`plan_not_convergent`) — a plan that cannot reproduce the intended bytes is never applied silently.
2. Validate the **precondition**: the document must still be at `baseRevision` and `baseContentHash`. A drift fails `stale_plan` (retriable), carrying current truth; the caller re-plans against the new state. This is the whole-document analogue of the block-level CAS in 04 §1.2.
3. Replay the opset's kernel ops through `apply` (the single write path: file-CAS, atomic write, known-id identity threading, one commit).

`docs.update(..., dry_run=true)` returns the opset (plan) without executing — identical to `docs_plan_update`.

## 7. CLI

`omg update <target>` is a polymorphic-target command (the `polymorphic-cli-command-targets` north-star): a block id (`b_…`) replaces that block (the low-level op); a document id or path is the whole-document update. `--plan` / `--dry-run` prints the opset (identity effects + summary) and commits nothing.

## 8. Deferred / known limitations

- **Nested identity (resolved).** Within-container changes (a list-item edit, an item reorder, an item inserted/removed) now preserve every unchanged item's id via `update { childIds }` + verbatim container rendering (§4.1); nested sub-lists are covered too. Editing an item's own text may still reset *that* item's id if the matcher declines the carry (small-block policy, §below — since m2.3 a lone changed item under a carried list is carried) — the item is the identity unit for its own content, its siblings are unaffected.
- **Resurrection.** The op path mints new ids for new structure rather than reusing tombstoned ids (an insert cannot carry a chosen id in v1), so cross-checkpoint resurrection is not attempted here. The observation path (`sync/reconciling-ingest`) still resurrects.
- **`split` / `merge` ops.** Reconcile's compound dispositions are realized as update+insert / update+remove and reported as `split_from`/`merged_into` metadata; literal kernel `split`/`merge` emission (when byte-faithful) is a refinement.
- **Leading trivia.** A change to the document's leading trivia (bytes before the first block/frontmatter) is not expressible via the ops; such a doc reports `converges: false`.
- **Small-block matcher policy.** A 1–2 token *top-level* block (a terse paragraph, a short heading) whose text changes is conservatively *not* carried by the reconciler (no text evidence survives) → its id resets. Since matcher m2.3 a short **list item** whose list carried does keep its id when it is the lone changed slot of that list (`spec/reconcile` §5 phase 4a step 5); two changed items in one list still reset. This is matcher policy, surfaced honestly in the plan, not a lowering limitation.
