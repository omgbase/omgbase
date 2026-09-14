# omgbase — Parsing, Round-Trip, and Reconciliation Spec

**Status:** normative. This is the correctness-critical component; its eval harness (§9) is a first-class deliverable with release gates.
**Depends on:** `architecture.md` §3.2, §5, §7; `data-model.md`.

---

## 1. Parser

- **Stack:** unified/remark — `remark-parse` + `remark-gfm` + `remark-frontmatter` + a wiki-link micromark extension + an inline-field (Dataview `key:: value`) extraction pass. (ADR-001. If the core ever moves to Rust, comrak replaces this layer behind the same `BlockTree` interface.)
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
Blocks carrying the same authored `^block-ref` anchor pair directly (unique on both sides). Reason `anchor`, confidence 0.99.

### Phase 4 — context propagation
For each parent pair already matched: if exactly one unmatched old child and one unmatched new child of the same type remain **between the same matched neighbors**, pair them if `text_sim ≥ 0.35`. Reason `context_unique`, confidence `0.75 + 0.2 × text_sim`.

### Phase 5 — scored assignment
For remaining candidates (same type, candidate pruning below):

```
score(o, n) =
    0.55 × text_sim(o, n)          # token 3-gram shingle Dice coefficient over normalized text
  + 0.15 × neighbor_ctx(o, n)      # fraction of {prev, next} siblings that are matched pairs
  + 0.10 × parent_match(o, n)      # 1 if parents are a matched pair (or both roots)
  + 0.10 × position_prior(o, n)    # 1 − |rel_pos(o) − rel_pos(n)|
  + 0.10 × anchor_evidence(o, n)   # shared outgoing link targets / code-fence info / heading prefix
```

Solve greedy-by-score with R3 order constraints (accept highest score, discard conflicting candidates, repeat). Accept while `score ≥ θ_accept`. Reason `scored`, confidence = score.

Candidate pruning: only pairs with |token_count difference| ≤ 3× and a shared 3-gram (inverted shingle index); cap candidates per block at 12 by shingle overlap. If the unmatched set exceeds `matcher.max_scored_blocks` (default 2000), skip Phase 5 entirely (bulk path, §6).

### Phase 6 — compound classification
Over the still-unmatched:

- **Split:** old block O and a run of ≥2 adjacent new blocks N₁..Nₖ (same parent region) where `coverage(concat(N), O) ≥ 0.80` and leftover < 0.2. If one Nᵢ holds ≥ `split.dominant_share` (default 0.70) of O's tokens **and** is the first fragment: Nᵢ **carries** O's id (kind `edited`, confidence 0.8×coverage, detail records split); others minted with `split_from: O`. Otherwise all minted with `split_from: O`. (ADR: dominant-fragment inheritance, tunable; set `split.dominant_share = 1.01` to disable inheritance entirely.)
- **Merge:** mirror image; merged result carries the dominant contributor's id under the same rule, others `merged_into`.
- **Copy:** unmatched new block with `text_sim ≥ 0.95` to a **matched** (still-present) old block ⇒ mint with `copied_from` lineage. Copies never steal identity.
- **Cross-document move (same checkpoint):** run Phases 1–5 across the pooled unmatched-deleted (all docs in checkpoint) × unmatched-inserted sets, θ raised to `θ_xdoc` (default 0.80). Kind `moved`/`edited_moved`.
- **Resurrection (cross-checkpoint):** match unmatched-inserted against `resurrection_pool` by raw_hash or norm_hash only (exact-class evidence). Kind `resurrected`, and the pool row is consumed. Scored resurrection is experimental (flag `matcher.scored_resurrection`, default off).

### Phase 7 — defaults
Remaining old blocks → `deleted` (into resurrection_pool). Remaining new blocks → `inserted` (minted).

## 5. Thresholds (config, tuned by the harness)

| Name | Default | Meaning |
|---|---|---|
| `θ_accept` | 0.62 | Phase-5 acceptance |
| `θ_small` | 0.80 | Acceptance for blocks with < 8 tokens |
| `θ_xdoc` | 0.80 | Cross-document acceptance |
| `split.coverage` | 0.80 | Split/merge concat coverage |
| `split.dominant_share` | 0.70 | Dominant-fragment inheritance |
| `copy.sim` | 0.95 | Copy detection |
| `bulk.unmatched_frac` | 0.45 | Bulk-rewrite trigger (with `bulk.min_blocks` = 100) |

## 6. Deliberate give-ups

- **Bulk rewrite:** if after Phase 2 more than `bulk.unmatched_frac` of a ≥`bulk.min_blocks` document is unmatched and mean best-candidate `text_sim < 0.35`: skip Phases 4–6, mint everything, emit one `bulk_rewrite` disposition (doc-scoped) plus `deleted` for all old blocks. Document-level continuity survives; block continuity is honestly surrendered.
- **Tiny blocks:** < 8 tokens use `θ_small`; confidence capped at 0.8. Nothing operational may depend on tiny-block identity (guaranteed by the load-path rule).
- **Many-to-many ambiguity:** overlapping split/merge candidate sets ⇒ take none; mint; record near-misses.

## 7. Determinism & versioning

- The matcher MUST be deterministic for a given (old tree, new bytes, config). No RNG, no wall-clock influence.
- `matcher_v` (semver-ish string) is stamped on every disposition. Threshold/weight changes bump the minor; phase changes bump the major.
- Re-running a newer matcher NEVER rewrites committed dispositions (R6).

## 8. Sync pipeline placement

```
checkpoint (debounced saves, per architecture §6)
  → for each changed file:
      parse → BlockTree
      if doc unknown: whole-file raw-hash match against deleted/moved docs → rename else create
      reconcile(old tree, new tree) → carried/minted tree + dispositions
  → cross-doc phase over the checkpoint's pooled unmatched sets
  → one observed commit: revisions + dispositions + edge extraction + index maintenance
  → convergence check: file_hash == rendered_hash (must hold; else log + re-ingest)
```

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
