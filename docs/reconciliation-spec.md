# omgbase — Parsing, Round-Trip, and Reconciliation Spec

**Status:** normative. This is the correctness-critical component; its eval harness (§9) is a first-class deliverable with release gates.
**Depends on:** `architecture.md` §3.2, §5, §7; `data-model.md`.

---

## 1. Parser

- **Stack:** unified/remark — `remark-parse` + `remark-gfm` + `remark-frontmatter` + a wiki-link micromark extension + an inline-field (Dataview `key:: value`) extraction pass. (ADR-001.) The mapping from source to `BlockTree` is specified language-neutrally in `spec/format/README.md` with generated fixtures under `spec/format/cases`; the Rust crate `crates/omgbase-format` implements the same contract over the `markdown` crate (a micromark port) and passes the same fixtures.
- The parser layer's ONLY job is to produce a `BlockTree` with **spans**. Nothing downstream may touch mdast directly.
- As-built (see `packages/core/src/core/parse/types.ts`), the parser works in **string space**, not bytes: spans are half-open `[start, end)` offsets into the decoded source string and `raw`/`trivia` are string slices. Byte-identical round-trip follows from deterministic UTF-8 re-encoding of equal strings; hashing (02 §5) encodes UTF-8 at hash time.

```ts
interface RawBlock {
  type: BlockKind;              // format-qualified string (architecture §3.3)
  span: { start: number; end: number };   // half-open offsets into the source string
  raw: string;                  // exact source slice (excludes trailing trivia)
  text: string;                 // normalized visible text (data-model §5.2)
  attrs: Record<string, unknown>;         // checked, lang, level, info, …
  children: RawBlock[];         // parser nesting only (lists, quotes, tables)
  trivia: string;               // trailing inter-block trivia attached to this block (§2.3)
  dirty?: boolean;              // set by ops: serialize (§2.2) rather than splice verbatim
  anchors: string[];            // authored ^block-refs found on this block
  outLinks: ExtractedLink[];    // for edge extraction (graph-and-query §2)
}
```

- mdast nodes that don't map to a known block type become `type: "opaque"` with the raw slice preserved. Opaque blocks MUST round-trip byte-perfectly and MUST refuse typed edits.
- Frontmatter (when present) is one `frontmatter` block: first child, raw YAML including fences.

## 2. Round-trip law (Stage 0 exit gate)

### 2.1 Invariants

1. `render(parse(file)) == file` — byte-identical, for every file in the corpus (§2.4).
2. Every byte of the file is owned by exactly one block's `raw` or `trivia`. No gaps, no overlaps. (Assert in debug builds.)
3. `parse(render(tree)) ≡ tree` — structurally identical (same types, same text, same nesting) for any tree produced by ops.

### 2.2 Splice renderer

```
render(tree):
  out = []
  for block in document order:
    if block.dirty:  out += serialize_new(block)   # from op-supplied markdown
    else:            out += block.raw              # verbatim retained bytes
    out += block.trivia                            # verbatim
  return concat(out)
```

- `serialize_new` applies **minimal normalization only**: ensure exactly one blank line separates sibling top-level blocks unless the op supplied explicit trivia; indent fenced code to its container; nothing else. The agent/author's own formatting inside supplied markdown is preserved.
- After rendering a changed block, its new `raw` slice is recorded from the rendered output, so subsequent renders splice it verbatim.

### 2.3 Trivia attachment policy

Inter-block bytes (blank lines, HTML comments between blocks, stray whitespace) attach to the **preceding** block's `trivia` (trailing-attach). Bytes before the first block attach as document-leading trivia on the document record. Rationale: deleting a block takes its following separator with it, which matches human expectation; inserting after a block inherits a sane separator.

### 2.4 Round-trip corpus

`packages/core/corpus/roundtrip/`: the CommonMark spec examples, GFM spec examples, plus ≥ 50 real-world files (Obsidian vault exports, READMEs, worknotes-style notes with frontmatter/wikilinks/inline fields/tasks, files with conflict markers, CRLF files, files with trailing no-newline). CI gate: 100% byte-identity.

## 3. Reconciliation: problem statement

Given: the last persisted `BlockTree` (with block IDs) for a document, and new file bytes. Produce: a new tree where every node either **carries** an existing `block_id` or is **minted**, plus a disposition list (`data-model.md` dispositions table) describing each carry/mint with kind, confidence, reason.

The matcher is specified language-neutrally in `spec/reconcile/README.md` (every phase as an exact rule, the fixture contract, and the reference oddities the Rust port surfaced) with executable fixtures under `spec/reconcile/cases` whose expectations the reference generates; the Rust crate `crates/omgbase-reconcile` passes the same fixtures. Sections 4–7 here are the rationale and the shape; where they and the spec differ in detail, the spec (and its fixtures) win.

Hard rules:

- R1 — A block_id appears at most once in the output tree.
- R2 — Type equality is a hard gate for any carry (a paragraph never becomes a heading).
- R3 — Order constraint: within one parent, carried matches must not cross (relative order of matched pairs is preserved) unless the pair is classified `moved`.
- R4 — **Asymmetric loss:** the θ thresholds are set so ambiguity mints. False continuity is worse than lost continuity; high-confidence continuity is better than both.
- R5 — Every carry records `confidence ∈ (0,1]`, `reason`, `matcher_v`. Every rejected near-miss (score within 0.1 below θ) is recorded in `dispositions.detail.near_misses`.
- R6 — Dispositions are immutable once committed.

## 4. Matching pipeline

Phases run in order; each phase only sees blocks unmatched by earlier phases.

### Phase 1 — exact lock
Group by `raw_hash`. Pair groups with equal cardinality 1:1 in document order; a hash unique on both sides pairs directly. Reason `exact_hash`, confidence 1.0. (Typical editing sessions lock ≥ 90% here.)

### Phase 2 — normalized lock
Same over `norm_hash`. Reason `normalized_hash`, confidence 0.99.

### Phase 3 — anchor lock
Blocks carrying the same authored `^block-ref` anchor pair directly (unique on both sides). Reason `anchor`, confidence 0.99. A block with several anchors is carried at most once: once an anchor has paired it, its other anchor groups are stale and skipped (R1; the first implementation carried it twice — `spec/reconcile` §10).

### Phase 4 — context propagation
For each parent pair already matched (or both roots): if exactly one unmatched old child remains, pair it with its best-matching unmatched new child of the same type under the new parent if `text_sim ≥ contextSimFloor` (0.35) and the best is unique. Reason `context_unique`, confidence `0.75 + 0.2 × text_sim`. Insertions in the gap lose to the better-matching candidate rather than blocking the carry.

### Phase 4b — children vouch for their parent
The converse of Phase 4: matched children carry their container. A container's visible text is its children's text joined by spaces (`spec/format` §4.1), so a list of short items has little or no shingle evidence of its own — `- one / - two / - three` vs `- one / - two changed / - three` has `text_sim = 0` — while two of its three items lock exactly (Phase 1) inside the new list. That is the evidence this phase reads.

For each unmatched old block O that has children, tally where O's already-carried children landed (the new parent key of each carried child). O pairs with the unmatched new block N when all of:

- `fraction = |children of O carried under N| / |children of O| ≥ children.vouch_frac` (0.5);
- N is the **unique** destination maximum for O's carried children, and O is the **unique** source maximum for N's carried children (mutual best by children; a 2 + 2 scatter or a 3 + 3 merge of two old lists ties and mints — R4);
- `type(O) == type(N)` (R2);
- the containers' own parents do not contradict the pairing: both roots, an already-matched pair, or **both still unmatched** (so nested containers resolve bottom-up); one at root and one nested, or either parent matched elsewhere, rejects.

Text is deliberately not consulted. Reason `context_children`, confidence `0.75 + 0.2 × fraction`; `detail` records `children_carried` and `children_total`. Kind is classified as for any carry (`edited` when the raw differs and position is unchanged, `edited_moved` otherwise).

**Fixed point.** Phases 4 and 4b feed each other — a list paired by its children unlocks Phase 4 for the one edited item under it; an inner list paired by its items unlocks the item that contains it, which unlocks the outer list. The reconciler therefore runs `4 → 4b` repeatedly until neither adds a pair (each round consumes ≥ 1 old block, so it terminates). Phase 4 runs first in each round, so a container that *does* have text evidence still carries as `context_unique`.

Note that a one- or two-token edited item (`two` → `two changed`) is **not** carried afterwards: it is the lone unmatched old child of the now-matched list, but texts under three tokens shingle to a single whole-text shingle, so `text_sim` is 0 unless identical, and Phase 5 prunes the pair for the same reason. Its id resets (small-block policy, §6; `update-opsets.md` "Small-block matcher policy"). The kernel promise "updates a list as a unit" is about the list's identity, not the edited item's.

### Phase 5 — scored assignment
For remaining candidates (same type, candidate pruning below):

```
score(o, n) =
    0.55 × text_sim(o, n)          # token 3-gram shingle Dice coefficient over normalized text
  + 0.15 × neighbor_ctx(o, n)      # fraction of {prev, next} siblings that are matched pairs
  + 0.10 × parent_match(o, n)      # 1 if parents are a matched pair (or both roots)
  + 0.10 × position_prior(o, n)    # 1 − |rel(o) − rel(n)|, rel(b) = b.index / (siblings − 1)
  + 0.10 × anchor_evidence(o, n)   # 1 when o and n share an authored anchor
```

`position_prior` compares each block's position among its **own siblings** (`siblings` = the blocks in its tree under the same parent, itself included; `rel = 0` when it is alone). Before m2.1 the denominator was the size of the whole flattened list, which compressed the prior for nested blocks and for documents with containers — `spec/reconcile` §10, fixed in m2.1.

Solve greedy-by-score with R3 order constraints: sort every candidate by score (descending; ties by old key, then new key), walk the list, and accept a candidate whose blocks are both still free, whose `score ≥ θ` (`θ_small` when the new block has fewer than 8 tokens, else `θ_accept`), and which does not cross an already-accepted same-parent pair (R3). A candidate below its θ is **skipped, not a stopping point**: the thresholds differ per candidate, so a tiny block's 0.75 sorted first must not end the walk for a regular candidate at 0.68 behind it (m2.0 broke out of the walk there — `spec/reconcile` §10, fixed in m2.1). Reason `scored`, confidence = score; `detail.near_misses` records the other candidates for that new block within 0.1 below θ.

Candidate pruning: only pairs with |token_count difference| ≤ 3× and a shared 3-gram (inverted shingle index); cap candidates per block at 12 by shingle overlap. If the unmatched set exceeds `matcher.max_scored_blocks` (default 2000), skip Phase 5 entirely (bulk path, §6).

### Phase 6 — compound classification
Over the still-unmatched, three passes in this order — splits, merges, copies. Each pass walks its side in document order and resolves **every** split (merge) it finds, moving on to the next still-unmatched block after each hit (m2.0 returned after the first split and the first merge, so a document with two split paragraphs resolved one per checkpoint — `spec/reconcile` §10, fixed in m2.1).

- **Split:** old block O and a run of ≥2 adjacent new blocks N₁..Nₖ (same parent, same type) where `coverage(concat(N), O) ≥ 0.80` and leftover < 0.2. If the **first** fragment holds ≥ `split.dominant_share` (default 0.70) of O's tokens: it **carries** O's id (kind `edited`, confidence 0.8×coverage, detail records the split); the others are minted with `split_from: O`. Otherwise O is tombstoned (`deleted`, reason `tombstone`, detail `splitInto`) and every fragment is minted with `split_from: O`. (ADR: dominant-fragment inheritance, tunable; set `split.dominant_share = 1.01` to disable inheritance entirely.)
- **Merge:** mirror image; the merged result carries the first contributor's id when it holds ≥ `split.dominant_share` of the new block's tokens, the others `merged_into` it; otherwise every contributor is `merged_into` the minted result.
- **Copy:** unmatched new block with `text_sim ≥ 0.95` to a **matched** (still-present) old block ⇒ mint with `copied_from` lineage. Copies never steal identity.
- **Cross-document move (same checkpoint):** pool the checkpoint's unmatched-deleted (all docs) × unmatched-inserted sets and greedily accept same-type, different-document pairs by `text_sim ≥ θ_xdoc` (default 0.80; token ratio ≤ 3×). Kind `moved`/`edited_moved`. As built: `crossdoc.ts` implements it, `spec/reconcile` §7 pins it, and the checkpoint runs it between reconciling every member of a batch and committing any of them (§8).
- **Resurrection (cross-checkpoint):** match unmatched-inserted against `resurrection_pool` by raw_hash or norm_hash only (exact-class evidence). Kind `resurrected`, and the pool row is consumed. Scored resurrection is experimental (flag `matcher.scored_resurrection`, default off).

### Phase 7 — defaults
Remaining new blocks → `inserted` (minted). Remaining old blocks → `deleted` (reason `tombstone`). The result's `deleted` list — what enters the resurrection pool — is **every** old id whose disposition kind is `deleted`, in old document order: the Phase 7 tombstones and the Phase 6 non-dominant split tombstones alike (m2.0 listed only the former, so a split-away block never reached the pool — `spec/reconcile` §10, fixed in m2.1).

## 5. Thresholds (config, tuned by the harness)

| Name | Default | Meaning |
|---|---|---|
| `θ_accept` | 0.62 | Phase-5 acceptance |
| `θ_small` | 0.62 | Acceptance for blocks with < 8 tokens (0.80 until m2.1; lowered in m2.2 after the structured eval suite showed precision 1.000 at both and multi-edit lists recovering their items) |
| `context.sim_floor` | 0.35 | Phase-4 `text_sim` floor (`contextSimFloor`) |
| `children.vouch_frac` | 0.50 | Phase-4b: fraction of an old container's children that must have carried into the one new container (`childrenVouchFrac`) |
| `θ_xdoc` | 0.80 | Cross-document acceptance |
| `split.coverage` | 0.80 | Split/merge concat coverage |
| `split.dominant_share` | 0.70 | Dominant-fragment inheritance |
| `copy.sim` | 0.95 | Copy detection |
| `bulk.unmatched_frac` | 0.45 | Bulk-rewrite trigger (with `bulk.min_blocks` = 100) |

## 6. Deliberate give-ups

- **Bulk rewrite:** if after Phase 2 more than `bulk.unmatched_frac` of a ≥`bulk.min_blocks` document (counted over the flattened block list) is unmatched: skip Phases 3–6, mint everything — the Phase 1–2 pairs included — and emit one `bulk_rewrite` disposition (doc-scoped) plus `deleted` for all old blocks. Document-level continuity survives; block continuity is honestly surrendered. (An earlier draft also required a mean best-candidate `text_sim < 0.35`; the implementation never had that clause.)
- **Tiny blocks:** a new block with < 8 tokens uses `θ_small` in Phase 5; a tiny block's candidate falling short of `θ_small` is skipped and costs the other candidates nothing. Nothing operational may depend on tiny-block identity (guaranteed by the load-path rule). (An earlier draft capped tiny-block confidence at 0.8; not implemented — a Phase 5 carry's confidence is its score, and an exact lock on a tiny block is 1.0.)
- **Many-to-many ambiguity:** overlapping split/merge candidate sets ⇒ take none; mint; record near-misses.

## 7. Determinism & versioning

- The matcher MUST be deterministic for a given (old tree, new bytes, config). No RNG, no wall-clock influence.
- `matcher_v` (semver-ish string) is stamped on every disposition. Threshold/weight changes bump the minor; phase changes bump the major. The constant is `DEFAULT_CONFIG.matcherV` in `packages/core/src/reconcile/types.ts`; it equals `"m" + spec/reconcile/VERSION`, and the Rust crate `omgbase-reconcile` is versioned `<major>.<minor>.<patch>` against the same number.
  - `m1.0` — phases 1–7 as first shipped.
  - `m2.2` — `θ_small` 0.80 → 0.62 (2026-09-26, eval-harness driven).
  - `m2.0` — Phase 4b (children vouch for their parent, reason `context_children`) and the Phase 4/4b fixed point (2026-09-25, alongside the "visible text" rule for container `text`).
  - `m2.1` — the four `spec/reconcile` §10 fixes, rule refinements within phases 5–7 (2026-09-25): Phase 5 skips a sub-threshold candidate instead of ending the walk; `position_prior` over the block's sibling count; every split and merge resolved per run; non-dominant split tombstones listed in `deleted`.
- Re-running a newer matcher NEVER rewrites committed dispositions (R6).

## 8. Sync pipeline placement

```
checkpoint (debounced saves, per architecture §6)
  → pass 1, for each changed file (no commits):
      echo gate: sha256(bytes) == docs.file_hash → suppressed
      parse → BlockTree
      if doc unknown: whole-file raw-hash match against deleted/moved docs → rename else create
      reconcile(old tree, new tree, pool snapshot) → per-doc assignment + dispositions + deleted
      (a file gone from the source contributes its whole live tree as deleted)
  → cross-doc phase over the checkpoint's pooled leftovers (spec/reconcile §7):
      deleted × inserted across documents at θ_xdoc → moved / edited_moved (detail.fromDoc);
      the source's deleted disposition and pool entry for that id vanish
  → pass 2, for each file in batch order, one transaction each:
      observed commit: revisions + dispositions + edge extraction + index maintenance,
      or the observed-deletion tombstone
  → convergence check: file_hash == rendered_hash (must hold; else log + re-ingest)
```

All three batch entry points — `processCheckpoint` (freshness sweep, one-shot, recovery), the external-source driver `reconcileChanges` (live watcher), and the `observe_many` MCP tool — share this pipeline (`sync/observe.ts::observeBatch`; a single `observe` is a batch of one, so it has no cross-doc phase). Every member of a batch reconciles against one resurrection-pool snapshot with a shared consumed-set, so a pooled id resurrects at most once per checkpoint. A block that moves between files inside one checkpoint is therefore never `deleted`+`inserted`, never pooled, and never `resurrected`; a carried-in id evicts the row its source document may still hold (`blocks.block_id` is a primary key), so the order of files in the batch does not matter. Across checkpoints the resurrection pool remains the mechanism (phase 6b, exact/normalized hash only): a cut and a paste that arrive in separate watcher batches come out as `deleted` then `resurrected`, and an edited move across batches as `deleted` + `inserted`.

Engine-authored writes are echo-suppressed by expected-hash match at the watcher (no checkpoint, no commit).

## 9. Eval harness (deliverable, Stage 2 exit gate)

`packages/core/corpus/matcher/` + `omg eval-matcher` (runs `runEval` in `reconcile/eval/`):

- **Synthetic suite:** a generator applies scripted edit sequences (edit / insert / delete / move / reorder / split / merge / copy / cross-doc move / bulk rewrite, parameterized by intensity) to corpus documents. Ground truth is exact by construction. This is the only suite built in v1.
- **Metrics per edit class:** identity precision (carried pairs that are true pairs), identity recall (true pairs carried), split/merge F1, mean confidence calibration error.
- **Release gates (v1):** precision ≥ 0.995 overall and ≥ 0.98 per class; recall ≥ 0.95 for edit/move/reorder classes; recall for split/merge ≥ 0.75. Precision is the non-negotiable side (R4).
- Harness output feeds threshold tuning; tuned defaults are committed to config with the harness run ID in the commit message.

## 10. Worked example (canonical test fixture)

Old:
```markdown
## Risks

Stable block identity is difficult.

Another paragraph.
```
New:
```markdown
## Risks

A newly inserted paragraph.

Stable block identity is quite difficult.

Another paragraph.
```
Required output: heading and "Another paragraph." carry via `exact_hash`; "Stable block identity is quite difficult." carries the old paragraph's id via Phase 4/5 (`confidence ≥ 0.9`); "A newly inserted paragraph." is minted `inserted`. The insertion MUST NOT capture the edited paragraph's identity (order constraint + first-match). This exact case is `packages/core/corpus/matcher/fixtures/brief-example/` and runs in CI.
