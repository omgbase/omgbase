# The omgbase reconciliation specification

Reconciliation is how omgbase keeps **block identity** across edits. Given the
last persisted block tree of a document (every block carrying its `b_` id) and
the freshly parsed tree of the new file bytes (no ids), the matcher decides,
for every new block, whether it **carries** an existing id or is **minted**, and
records a **disposition** per decision (kind, confidence, reason, detail). The
store, the mutation kernel and the sync layer all rest on these decisions, so
two implementations must reach the same ones from the same inputs. This
directory specifies the matcher so they can. It is owned by neither
implementation.

| Implementation | Where | Role |
| --- | --- | --- |
| `@omgbase/core` (TypeScript, npm) | `packages/core/src/reconcile` | **Reference.** Matcher decisions land here first. |
| `omgbase-reconcile` (Rust, crates.io) | `crates/omgbase-reconcile` | Conformance-first port. Passes the same fixtures. |

The spec is two artifacts, versioned together by `VERSION`:

- this `README.md` — inputs and outputs, the hard rules, the similarity
  measure, every phase as an exact rule, the thresholds, the fixture contract;
- `cases/*.json` — the executable fixtures. **When prose and fixtures
  disagree, the fixtures win**, and the prose gets fixed.

The design rationale (why phases, why asymmetric loss, the eval harness and its
release gates) is `docs/reconciliation-spec.md`; this document is the as-built
contract that the rationale describes.

## Versioning: the matcher version

Every disposition is stamped with a **matcher version** so a database can say
which matcher made a decision, and a newer matcher never rewrites committed
dispositions (R6 below). That version is the spec version: `VERSION` holds it
as `major.minor` (`2.1`), the stamp is `"m" + VERSION` (`m2.1`), and the
`omgbase-reconcile` crate is versioned `<major>.<minor>.<patch>` with the
patch digit free for bug fixes and packaging, exactly as `oqx` and
`omgbase-format` track their specs. The reference lives inside
`@omgbase/core`, which has its own version line; its `DEFAULT_CONFIG.matcherV`
equals `"m" + VERSION`.

- **Threshold, weight and rule refinements within a phase** bump the minor
  (`m2.0 → m2.1`).
- **Phase changes** (a phase added, removed or reordered, or a new kind of
  evidence a phase reads) bump the major.
- A fixture added or changed that alters an expected decision is one of the
  two. A fixture that pins existing behavior is neither.

History: `m1.0` phases 1–7 as first shipped; `m2.0` phase 4b (children vouch
for their parent) and the phase 4/4b fixed point (2026-09-25); `m2.1` the
four fixes of §10 (phase 5 keeps walking past a sub-threshold candidate,
`position_prior` over sibling count, every split and merge per run, split
tombstones listed in `deleted`) (2026-09-25).

## The rule for changing the matcher

**Fixture first, TypeScript (reference) second, Rust third.** A behavior
change without a fixture is not done. Fixture *inputs* are authored by hand
in `cases/*.json`; the `expect` of every case is *generated* by the reference
(§9) and reviewed as code — a changed `expect` is the statement of the change.
A divergence found by the port is adjudicated by the prose here: when the
prose is silent, write the rule, and fix whichever implementation disagrees
with it (§10 records the reference oddities the port has surfaced and the
decisions taken on them).

## 1. Inputs

### 1.1 Block trees

The matcher consumes two trees of the shape `spec/format` §1 produces, with
only the fields it needs:

```text
InputBlock
  id        old side only: the block's persisted id (any non-empty string)
  type      a spec/format §3 kind name (`paragraph`, `list`, `table_row`, …)
  raw       the block's source bytes (§1 inv. 4: no trailing line ending)
  anchors   authored ^block-ref anchors on this block; default []
  children  nested InputBlocks (parser nesting only)
```

Frontmatter is never reconciled: the engine handles the `frontmatter` block
separately, and a tree given to the matcher does not contain one.

### 1.2 Flattening

Both trees are flattened to lists of **match blocks** in **pre-order** (a block,
then its children, then its next sibling — document order):

```text
MatchBlock
  id          old side only
  type        as input
  raw_hash    sha256(raw), hex (spec/format §4.2)
  text        the block's visible text, spec/format §4.1, computed in tree
              context (containers compose from children; nested raws lose up
              to <blockquote depth> `> ` prefixes)
  norm_hash   sha256(text), hex
  anchors     as input
  parent_key  the parent's positional key, or null at the top level
  index       ordinal among its siblings, from 0
  key         positional key: (parent_key ?? "") + "/" + index
              (`/0`, `/1/2`, `/1/2/0`)
```

The positional key is stable within one tree and lets the phases compare
parents and sibling order across the two trees. **It is not an identity**:
`/1` in the old tree and `/1` in the new tree are simply the second top-level
blocks of each. Where a rule below compares an old `parent_key` with a new
`parent_key`, it compares the strings.

## 2. Outputs

```text
Result
  assignment      new key → id: a carried old id, a resurrected pool id, or a
                  freshly minted id. Every new key is assigned exactly once.
  dispositions    one per decision (below)
  deleted         every old id whose disposition kind is `deleted` (phase 7
                  tombstones and phase 6a non-dominant splits), in old
                  document order
  consumed_pool   the resurrection-pool ids consumed by phase 6b, in the
                  order they were consumed

Disposition
  block_id     the old id (carries, deletions, merges), the pool id
               (resurrections), the minted id (mints), or the literal "DOC"
               for the document-scoped bulk_rewrite
  kind         same | edited | moved | edited_moved | inserted | deleted |
               split_from | merged_into | copied_from | resurrected |
               bulk_rewrite
  confidence   a number in (0, 1], or null when the decision is not a carry
  reason       exact_hash | normalized_hash | anchor | context_unique |
               context_children | scored | tombstone, or null (the reference's
               type also names `api`, stamped by the mutation kernel, never by
               the matcher)
  matcher_v    the matcher version (config `matcher_v`), on every disposition
  detail       a JSON object; `{}` when there is nothing to record
```

Every old id appears in exactly one disposition, and every minted id in
exactly one. A carried block's disposition carries the *old* id (the id
survives; that is the point).

**Classifying a carry.** When a phase pairs old block *o* with new block *n*
and does not fix the kind itself:

```text
moved         = o.parent_key != n.parent_key  or  o.index != n.index
content_equal = o.raw_hash == n.raw_hash
kind = same          if content_equal and not moved
       moved         if content_equal and moved
       edited_moved  if not content_equal and moved
       edited        otherwise
```

Content equality is byte identity; a block that matched only on `norm_hash`
is `edited`.

## 3. Hard rules

- **R1** An old id is carried to at most one new block.
- **R2** A carry never changes `type` (a paragraph never becomes a heading).
- **R3** Within one parent, pairs accepted by scoring (phase 5) do not cross in
  sibling order; carries classified `moved`/`edited_moved` by the other
  phases may.
- **R4 — asymmetric loss.** Thresholds are set so that ambiguity mints. False
  continuity is worse than lost continuity; ties never carry.
- **R5** Every carry records `confidence`, `reason` and `matcher_v`. Phase 5
  records the near misses (score within 0.1 below the threshold) of each
  accepted pair.
- **R6** Dispositions are immutable once committed; a newer matcher never
  rewrites them.
- **Determinism.** The same (old tree, new tree, config, pool) gives the same
  assignment, dispositions, `deleted` and `consumed_pool`, up to the values of
  the minted ids. No randomness or clock enters a decision.

## 4. Similarity

All text measures run over `text` (§1.2).

- **tokenize(text)**: lowercase with Unicode default case mapping (no locale;
  final sigma becomes `ς`), split on runs of the JavaScript `\s` set — the
  Unicode `White_Space` characters **except U+0085**, plus U+FEFF (§10
  "Whitespace") — and drop empty tokens.
- **token_count(text)** = `|tokenize(text)|`.
- **shingles(text)**: the set of token 3-grams, each the three tokens joined
  by one space. No tokens → the empty set. One or two tokens → a single
  shingle, the tokens joined by one space (so short texts still have one).
- **dice(A, B)** = `2|A ∩ B| / (|A| + |B|)`; both empty → 1; exactly one
  empty → 0.
- **text_sim(a, b)** = 1 when the strings are identical, else
  `dice(shingles(a), shingles(b))`.

Consequences: texts under three tokens share a shingle only when they are
identical after tokenization, so a one-word edit to a two-word item has
`text_sim = 0`; two empty texts (two thematic breaks) have `text_sim = 1`.

## 5. The pipeline

Phases run in this order. A block matched by an earlier phase is invisible to
later ones ("unmatched" below always means "not yet paired in this run").
Unless a phase says otherwise, it visits blocks in document order (the
flattened order of §1.2). `carry(o, n, kind, confidence, reason, detail)`
records `assignment[n.key] = o.id`, marks both used, and appends a
disposition with `o.id`.

### Phase 1 — exact lock (`exact_hash`, 1.0)

Group the unmatched old blocks by `(type, raw_hash)` and the unmatched new
blocks the same way. For each old group, in order of first appearance, if a new
group with the same key exists **and has the same size**, pair the *i*-th old
with the *i*-th new for every *i*, kind classified (§2). Groups of unequal
size pair nothing here.

### Phase 2 — normalized lock (`normalized_hash`, 0.99)

Phase 1 over `(type, norm_hash)`.

### Bulk-rewrite check

After phase 2: if the new tree has at least `bulk_min_blocks` blocks (counted
over the flattened list) and the unmatched fraction
`(|new| − |matched new|) / |new|` **exceeds** `bulk_unmatched_frac`, give up
on block continuity: the result is

- one disposition `{ block_id: "DOC", kind: bulk_rewrite, confidence: null,
  reason: null, detail: { unmatchedFrac } }`;
- every new block minted with an `inserted` disposition, in document order
  (the phase 1–2 pairs are discarded);
- every old block `deleted` (reason `tombstone`), in document order, all of
  them listed in `deleted`;
- `consumed_pool` empty.

Nothing else runs.

### Phase 3 — anchor lock (`anchor`, 0.99)

Group the unmatched old blocks by each anchor they carry (a block with two
anchors is in two groups), in order of first appearance; the same for new.
For each anchor whose old group and new group both have exactly one member of
the same type, carry that pair (kind classified). **A block already carried by
an earlier anchor of this phase is skipped** — a group is stale once its
member is used (R1).

### Phase 4 — context propagation and children vouching, to a fixed point

Repeat `{ phase 4a; phase 4b }` until a round adds no pair. Each round consumes
at least one old block, so this terminates. Phase 4a runs first in each round,
so a container that has text evidence of its own carries as `context_unique`.

#### Phase 4a — context (`context_unique`, `0.75 + 0.2 × text_sim`)

The **parent pairs** are `(root, root)` followed by, for each pair in the
assignment in the order the pairs were made, `(o.key, n.key)` — every matched
pair is a potential parent pair (leaves simply have no children). The list is
fixed when the pass starts: a pair made during this pass becomes a parent pair
in the next round. For each parent pair `(P, Q)`:

1. Let the unmatched old blocks with `parent_key = P` be the candidates'
   targets. If there is not **exactly one**, skip this parent pair. Call it *o*.
2. Candidates: the unmatched new blocks with `parent_key = Q` and
   `type = o.type`. None → skip.
3. `best` is the candidate with the strictly greatest `text_sim(o.text,
   n.text)`. If another candidate ties the greatest value, there is no best.
4. If there is a best and `text_sim ≥ context_sim_floor`, carry (kind
   classified) with confidence `0.75 + 0.2 × text_sim`.

Insertions in the gap lose to the better-matching candidate rather than
blocking the carry; that is how an inserted paragraph never steals an edited
paragraph's identity.

#### Phase 4b — children vouch for their parent (`context_children`, `0.75 + 0.2 × fraction`)

Computed once at the start of the phase, from the assignment so far, over
every pair (*o*, *n*) whose parents are both real blocks (neither at root):

- `landed[o.parent_key][n.parent_key] += 1`
- `sourced[n.parent_key][o.parent_key] += 1`
- `total[P]` = the number of children of old block *P* (all of them, matched
  or not).

Then, for each unmatched **old** block *O* in document order that has children
and has an entry in `landed`:

1. `dest` = the new parent key with the strictly greatest `landed[O.key]`
   count. A tie → skip (R4).
2. `fraction = landed[O.key][dest] / total[O.key]`; require
   `fraction ≥ children_vouch_frac`.
3. *N* = the new block with key `dest`; require it unmatched and
   `N.type = O.type` (R2).
4. `source` = the old parent key with the strictly greatest
   `sourced[N.key]` count; require it unique and equal to `O.key` (mutual
   best; a 3 + 3 merge of two old lists ties and mints).
5. The parents must not contradict the pairing: both *O* and *N* at root; or
   *O*'s parent already carried **to** *N*'s parent; or *O*'s parent still
   unmatched **and** *N*'s parent still unmatched. One at root and one nested,
   or either parent matched elsewhere, rejects.
6. Carry (kind classified), confidence `0.75 + 0.2 × fraction`, detail
   `{ children_carried: <count>, children_total: <total> }`.

The pass reads the tallies computed at its start but checks "unmatched" and
the parent condition against the live state, so a container paired earlier in
the same pass affects its descendants' step 5. Text is deliberately not
consulted.

### Phase 5 — scored assignment (`scored`, confidence = score)

Skip the phase when either side has no unmatched blocks, or when
`|unmatched old| + |unmatched new| > 2 × max_scored_blocks`.

**Candidates.** For each unmatched new *n* in document order: for each
unmatched old *o* in document order with `o.type = n.type`,

- let `r = max(tc(o), tc(n)) / max(1, min(tc(o), tc(n)))` over token counts;
  skip when `r > 3`;
- skip when `shingles(o)` and `shingles(n)` are both non-empty and disjoint
  (a pair where either side has no shingles is kept);

sort *n*'s surviving candidates by `dice(shingles(o), shingles(n))`
descending, **stably** (ties keep old document order), and keep the first 12.

**Score.** With `|old|` and `|new|` the sizes of the two flattened lists:

```text
score(o, n) = 0.55 × dice(shingles(o.text), shingles(n.text))   # = text_sim: identical
                                                                # texts have equal shingle sets
            + 0.15 × neighbor_ctx(o, n)
            + 0.10 × parent_match(o, n)
            + 0.10 × position_prior(o, n)
            + 0.10 × anchor_evidence(o, n)

neighbor_ctx     over d ∈ {−1, +1}: os = old sibling of o at index o.index + d
                 (same parent_key), ns = new sibling of n at n.index + d. If
                 either exists, count 1 toward the total and 1 toward matched
                 when both exist and assignment[ns.key] = os.id. The value is
                 matched / total, or 0 when total is 0.
parent_match     1 when both at root, or o's parent is carried to n's parent;
                 else 0.
position_prior   1 − |rel(o) − rel(n)| with rel(b) = b.index / (siblings − 1),
                 siblings being the number of blocks in b's tree with
                 b.parent_key (b included), and rel = 0 when siblings ≤ 1.
anchor_evidence  1 when o and n share an anchor string; else 0.
```

Evaluate the sum left to right in IEEE double arithmetic, in exactly this
term order.

**Assignment.** Sort all candidates by score descending, then by old key
ascending, then by new key ascending (keys compare bytewise, so `/10` sorts
before `/2`). Walk them:

1. Skip a candidate whose old or new block is already used.
2. `θ = theta_small` when `tc(n) < small_block_tokens`, else `theta_accept`.
   If `score < θ`, skip the candidate and keep walking (a tiny block's
   higher threshold must not end the walk for the regular candidates
   sorted below it).
3. R3: when `o.parent_key = n.parent_key` (as strings), reject the candidate
   if any pair (*o′*, *n′*) already accepted in this phase under the same new
   parent has `(o′.index − o.index) × (n′.index − n.index) < 0`.
4. Near misses (R5): the other candidates for this *n* (different old id)
   whose score is `< θ` and `≥ θ − 0.1`, as
   `{ blockId, score }` with the score rounded to three decimals
   (`round(score × 1000) / 1000`; the reference rounds half toward +∞,
   which is the same thing for non-negative scores).
5. Accept: kind `edited_moved` when `o.parent_key != n.parent_key` or
   `o.index != n.index`, else `edited` (never `same`/`moved`: byte-equal pairs
   lock in phase 1 unless their groups differed in size), confidence = score,
   detail `{ near_misses: [...] }` when there are any, else `{}`.

### Phase 6a — compound classification (`scored`)

Three passes over the still-unmatched, in this order. `coverage(X, Y)` =
`|shingles(Y) ∩ shingles(X)| / |shingles(Y)|`, 0 when *Y* has no shingles;
`shared_fraction(part, whole)` = the number of tokens of `whole` (with
repeats) that occur in the token *set* of `part`, divided by
`max(1, tc(whole))`; a **run** is a slice of same-parent, same-type blocks
sorted by index whose indices are consecutive; the concatenation of a run is
its texts joined by one space.

**Splits.** For each old *O* that was unmatched when the pass began and is
still unmatched when reached, in document order (the candidate side is the
live unmatched set, so earlier splits in the pass are visible), over the unmatched new blocks with `parent_key = O.parent_key`
and `type = O.type` sorted by index: try every window `[start, end)` of
length ≥ 2, longest first for each start (`start` ascending, `end`
descending), skipping non-consecutive windows. The first window with
`coverage(concat, O.text) ≥ split_coverage` and
`1 − coverage(O.text, concat) < 0.2` is the split:

- if `shared_fraction(first.text, O.text) ≥ split_dominant_share` for the
  run's **first** block: carry *O* → first, kind `edited`, confidence
  `0.8 × coverage`, detail `{ split: [run keys], dominant: first.key }`; every
  other run block is minted with lineage `split_from` (below);
- otherwise *O* gets `{ kind: deleted, confidence: null, reason: tombstone,
  detail: { splitInto: [run keys] } }` (listed in `deleted` like any
  tombstone), and every run block is minted with lineage `split_from`.

Then continue with the next unmatched *O*.

**Merges.** Mirror image: for each new *N* that was unmatched when the pass
began and is still unmatched when reached, in document order (the candidate
side is the live unmatched set), over the unmatched old blocks with the
same parent key and type sorted by index, the first window (same order) with
`coverage(N.text, concat) ≥ split_coverage` (no leftover test) is the merge:

- if `shared_fraction(first.text, N.text) ≥ split_dominant_share` for the
  run's first block: carry first → *N*, kind `edited`, confidence
  `0.8 × coverage`, detail `{ merge: [run ids], dominant: first.id }`; every
  other run block gets `{ kind: merged_into, confidence: 0.8 × coverage,
  reason: scored, detail: { into: first.id } }`;
- otherwise every run block gets `{ kind: merged_into, confidence: null,
  reason: scored, detail: { mergedKey: N.key } }` and *N* is minted with
  lineage `merged_into` whose counterpart is the first run block.

Then continue with the next unmatched *N*.

**Copies.** For each unmatched new *n* in document order: the first old block
in document order that is carried (by any phase so far), has `n`'s type and
`dice(shingles(o), shingles(n)) ≥ copy_sim` makes *n* a copy: lineage
`copied_from` with counterpart `o.id`. Copies never steal identity.

**Lineage mint.** "Minted with lineage *kind*, counterpart *c*" marks the new
block used and records `{ block_id: <the id minted for it in phase 7>, kind,
confidence: null, reason: scored, detail: { counterpart: c, newKey: n.key } }`.

### Phase 6b — resurrection (`resurrected`, 0.99, reason `exact_hash`)

Only when a pool is supplied and non-empty. A pool entry is
`{ id, type, raw_hash, norm_hash }` (a block deleted in an earlier
checkpoint). Index the pool by `(type, raw_hash)` and by `(type, norm_hash)`;
when two entries share a key the **later** one wins. For each unmatched new
*n* in document order: the hit is the raw-hash entry for `(n.type,
n.raw_hash)` if there is one, **else** the norm-hash entry; if there is a hit
and its id is not yet consumed this run, consume it, assign `n.key → hit.id`
and record `{ block_id: hit.id, kind: resurrected, confidence: 0.99, reason:
exact_hash, detail: {} }` (reason `exact_hash` even for a norm-hash hit). A
raw-hash hit that is already consumed does **not** fall back to the norm-hash
entry.

### Phase 7 — defaults

1. Lineage dispositions (phase 6a) receive their block's minted id: for each,
   in the order recorded, the id already assigned to `detail.newKey` if there
   is one, else a fresh mint, becomes both the assignment and the
   disposition's `block_id`. `detail.newKey` stays.
2. Every new block without an assignment, in document order, is minted with
   `{ kind: inserted, confidence: null, reason: null, detail: {} }`.
3. Every old block not carried and not otherwise disposed, in document order,
   gets `{ kind: deleted, confidence: null, reason: tombstone, detail: {} }`.
4. `deleted` is every old id whose disposition kind is `deleted`, in old
   document order.

## 6. Configuration

| Fixture name | Default | Meaning |
| --- | --- | --- |
| `matcher_v` | `"m2.1"` | stamped on every disposition (`"m" + VERSION`) |
| `theta_accept` | 0.62 | phase 5 acceptance |
| `theta_small` | 0.80 | phase 5 acceptance when the new block has fewer than `small_block_tokens` tokens |
| `small_block_tokens` | 8 | the tiny-block boundary |
| `context_sim_floor` | 0.35 | phase 4a `text_sim` floor |
| `children_vouch_frac` | 0.50 | phase 4b: fraction of an old container's children that must have carried into one new container |
| `split_coverage` | 0.80 | phase 6a split/merge coverage |
| `split_dominant_share` | 0.70 | phase 6a dominant-fragment inheritance; `1.01` disables it |
| `copy_sim` | 0.95 | phase 6a copy detection |
| `bulk_unmatched_frac` | 0.45 | bulk-rewrite trigger (strictly exceeded) |
| `bulk_min_blocks` | 100 | bulk-rewrite minimum document size |
| `max_scored_blocks` | 2000 | phase 5 skips when the unmatched total exceeds twice this |
| `theta_xdoc` | 0.80 | cross-document acceptance (§7) |

The reference's `ReconcileConfig` uses the camelCase spellings of these names.

## 7. Cross-document moves (checkpoint scope)

After every changed document of a checkpoint has been reconciled on its own,
pool the checkpoint's leftovers: **deleted** = for each document, the old
blocks whose ids are in its `deleted` list, in that order; **inserted** = for
each document, the new blocks whose disposition is `inserted`, with the id
minted for each, in disposition order. Documents contribute in the order
given.

Pairs: every (deleted *o*, inserted *n*) with `o.type = n.type`, from
**different** documents, token ratio `≤ 3` (as in phase 5) and
`text_sim(o.text, n.text) ≥ theta_xdoc`. Sort by `text_sim` descending, then
by the deleted block's position in the pool, then the inserted block's.
Greedily accept pairs whose blocks are both unused. Each accepted pair is a
move `{ from_doc, to_doc, carried_id: o.id, replaced_minted_id, new_key:
n.key, kind: moved if o.raw_hash = n.raw_hash else edited_moved, confidence:
text_sim }`.

Applying a move: in the destination document, `assignment[new_key] =
carried_id`, the `inserted` disposition of the replaced minted id is removed,
and `{ block_id: carried_id, kind, confidence, reason: scored, detail: {
fromDoc: from_doc } }` is appended; in the source document, the `deleted`
disposition of `carried_id` is removed and the id leaves `deleted`.

The reference checkpoint calls this between reconciling every document of a
batch and committing any of them (`packages/core/src/sync/observe.ts`,
`observeBatch`); a document deleted in the checkpoint contributes its whole
live tree as *deleted*. The fixtures pin the function.

## 8. Portability

- **Numbers.** Confidences and scores are IEEE doubles computed in the term
  order written here. Fixtures carry them at full precision; a runner
  compares with an absolute tolerance of 1e-9.
- **Hashes** are lowercase hex SHA-256 over UTF-8 bytes.
- **Text** is spec/format §4.1 visible text, so every consequence there
  (NFC, the trim set, U+00A0 surviving inside a line) reaches the tokenizer.
- **Whitespace for tokenizing** is the JavaScript `\s` set: Unicode
  `White_Space` minus U+0085, plus U+FEFF. It differs from Rust's
  `char::is_whitespace` in exactly those two code points. (The same set is
  the trim set of spec/format §4.1 step 4; its prose said "White_Space plus
  U+FEFF" and is corrected alongside this document.)
- **Lowercasing** is Unicode default case mapping without locale: `İ` becomes
  `i̇` (two code points), `ΟΔΥΣΣΕΥΣ` becomes `οδυσσευς`. Both hosts agree.
- **Sorting** ties are broken by keys compared bytewise and by document order,
  never by hash-map iteration order.
- **Minted ids** are opaque; the reference draws them from a CSPRNG. A fixture
  never contains one (§9).

## 9. Fixtures

`cases/<suite>.json`:

```jsonc
{
  "suite": "phases",              // = file stem
  "cases": [
    {
      "name": "brief-example",    // unique within the file; the id is `<suite>::<name>`
      "notes": "optional prose for the reader",
      "config": { "theta_accept": 0.62 },   // optional overrides (§6 names)
      "old": { "source": "## Risks\n\nStable block identity is difficult.\n" },
      "new": { "blocks": [ { "type": "heading", "raw": "## Risks", "children": [] }, … ] },
      "pool": [ { "id": "b_pool", "type": "paragraph", "raw": "…" } ],  // optional
      "expect": {                 // GENERATED by the reference
        "assignment": { "/0": "b_0", "/1": null, "/2": "b_1" },
        "dispositions": [
          { "block": "b_0", "kind": "same", "confidence": 1, "reason": "exact_hash", "detail": {} },
          { "block": "new:/1", "kind": "inserted", "confidence": null, "reason": null, "detail": {} },
          …
        ],
        "deleted": [],
        "consumed_pool": []
      }
    }
  ]
}
```

**Inputs** (authored):

- `old` and `new` are each either `{ "source": "<markdown>" }` or
  `{ "blocks": [InputBlock…] }`.
  - `source` is parsed per `spec/format` (the two implementations agree on
    the tree; the fixtures there prove it), the `frontmatter` block if any is
    dropped, and — on the old side — ids are assigned in pre-order as
    `b_0`, `b_1`, …. Blocks from `source` carry no anchors (spec/format does
    not define anchor extraction); use `blocks` to test anchors.
  - `blocks` gives the tree explicitly: `type`, `raw`, `children` (required,
    `[]` for a leaf), optional `anchors`, and on the old side a required `id`. `type` is a spec/format
    §3 kind name. Nested `raw` is a source slice as spec/format §3 requires
    (a paragraph inside a blockquote keeps its `> ` continuation prefixes).
- `pool` entries are `{ id, type, raw, text? }`; `raw_hash` is
  `sha256(raw)` and `norm_hash` is `sha256(text)`, with `text` defaulting to
  the spec/format §4.1 leaf rule over `raw` at blockquote depth 0.
- `config` overrides any subset of §6.

**Expect** (generated):

- `assignment` maps every new key to the carried or resurrected id, or `null`
  for a minted block.
- `dispositions` is the full list with `block_id` **canonicalized**: a minted
  id is replaced by `new:<key>`, the key it was assigned to (a minted id is
  assigned to exactly one key). Old ids, pool ids and `"DOC"` stay. The list
  is sorted by canonical `block`, then `kind`; `matcher_v` is omitted (the
  runner checks every disposition carries the configured value). `detail`
  objects keep the reference's key names (§10).
- `deleted` and `consumed_pool` as §2.

**Checkpoint cases** (§7) replace `old`/`new` with `docs`:

```jsonc
{
  "name": "cut-paste-across-files",
  "docs": [ { "id": "A", "old": {…}, "new": {…} }, { "id": "B", "old": {…}, "new": {…} } ],
  "expect": {
    "moves": [ { "from_doc": "A", "to_doc": "B", "carried_id": "b_1", "new_key": "/1", "kind": "moved", "confidence": 1 } ],
    "docs": { "A": { "assignment": …, "dispositions": …, "deleted": …, "consumed_pool": [] }, "B": { … } }
  }
}
```

Every document is reconciled with the case `config` (no pool), the moves are
computed and applied, and `expect.docs` holds each document's canonicalized
result afterwards (`replaced_minted_id` is omitted from `moves`: it is a
minted id). Old ids must be unique across the checkpoint's documents — a
carried id names one block — so the old side of more than one document is
given as `blocks` with distinct ids.

**Runner checks, per case**: the invariants of §2 and §3 on the
implementation's result (every new key assigned once; carried ids unique —
R1; carried pairs same type — R2; every old id in exactly one disposition,
every minted id in exactly one; `matcher_v` everywhere); then `assignment`,
`dispositions` (as JSON, object key order ignored, numbers within 1e-9),
`deleted` and `consumed_pool` deep-equal the fixture.

**Generation.** `packages/core/corpus/reconcile/spec.test.ts` asserts the
reference reproduces every committed `expect` and, with
`RECONCILE_SPEC_UPDATE=1`, rewrites each case's `expect` in place from its
inputs (inputs, `notes` and case order untouched); the diff is reviewed like
code.

**Allowlist (Rust).** `crates/omgbase-reconcile/tests/spec-passing.txt`
names the case ids that must pass while the port runs behind the fixtures
(a listed case failing, an unlisted case passing, or a stale id all fail the
build); `RECONCILE_SPEC_UPDATE=1 cargo test -p omgbase-reconcile --test spec`
rewrites it from the passing set and deletes it once everything passes. When
the file is absent, every case must pass. Same mechanism as `spec/oqx` and
`spec/format`.

## 10. Reference oddities surfaced by the port, and decisions

Behaviors of the reference that a careful second implementation would not
have guessed. Each is either **pinned** (a fixture asserts it; changing it is
a matcher change under "Versioning") or **fixed** (the prose rule above is
the fix and the reference was brought to it).

- **Fixed — phase 3 double carry.** An old block with two anchors matching two
  different new blocks was carried twice (an R1 violation). The rule now
  skips a block already used in the phase. `anchors::two-anchors-one-block`
  pins it.
- **Fixed — whitespace set.** The trim/tokenize set is JavaScript's, which
  excludes U+0085 and includes U+FEFF; `omgbase-format`'s helper included
  U+0085 by using `char::is_whitespace`. Corrected there (crate patch) and in
  spec/format §4.1's prose.
- **Fixed in m2.1 — phase 5 stopped at the first sub-threshold candidate.**
  Candidates are sorted by score, but tiny new blocks use `theta_small`
  (0.80) where others use `theta_accept` (0.62): a tiny-block candidate
  scoring 0.70 ended the walk although later regular candidates scoring 0.65
  qualified. The walk now skips the candidate and continues
  (`scored::small-block-does-not-stop-the-walk`).
- **Fixed in m2.1 — `position_prior` mixed sibling index with list size.**
  `rel(b) = b.index / (|list| − 1)` used the block's ordinal among its
  siblings over the size of the whole flattened list, so nested blocks and
  documents with containers got compressed priors. It is now over the sibling
  count (`scored::position-prior-nested`).
- **Fixed in m2.1 — one split and one merge per run.** Phase 6a returned
  after the first split it found and after the first merge, so a document
  with two split paragraphs resolved one per checkpoint. Both passes now
  continue through the document (`compound::two-splits-both-resolve`).
- **Fixed in m2.1 — non-dominant split tombstone was not in `deleted`.** The
  old block got a `deleted` disposition (with `splitInto`) but phase 7 did
  not list it, so it never entered the resurrection pool. `deleted` is now
  every `deleted` disposition (`compound::split-disabled-tombstone-in-deleted`).
- **Pinned — resurrection reason.** A norm-hash resurrection records reason
  `exact_hash`, and a consumed raw-hash hit does not fall back to the
  norm-hash entry.
- **Pinned — `detail` key spelling.** `children_carried`, `children_total`
  and `near_misses` are snake_case; `splitInto`, `mergedKey`, `newKey`,
  `fromDoc`, `unmatchedFrac` are camelCase. They are stored as-is in
  databases, so they stay.
- **Pinned — `moved` compares positional keys.** A block is `moved` when its
  parent's positional key or its sibling index differs between the trees;
  after an insertion above it, every following sibling is `moved` (or
  `edited_moved`) even though its parent is the same block.
- **Observed — mid-item edits on short items lose identity.** A five-word
  list item with two words changed mid-item shares one of its three shingles
  (`text_sim` 0.333, under the 0.35 floor) and scores about 0.53 in phase 5
  (under 0.62), so it is deleted and re-minted while its siblings and the
  list carry (`structure::edit-one-item-in-long-list`; the same edit on the
  last word carries, `structure::edit-one-item-last-word`). Likewise a
  three-word item that gains a nested list
  (`structure::add-nested-list-under-item`). Not a reference bug — the
  thresholds behaving as tuned — but the small-block policy's cost on real
  lists, recorded for the threshold decision it invites.
- **Observed — byte-equal blocks whose groups differ in size carry as
  `edited`.** One `---` in old and two in new skip phase 1 (1 ≠ 2), tie in
  phase 4a (both `text_sim` 1) and reach phase 5, where the survivor carries
  with kind `edited` and score 0.875 although its bytes never changed, and
  the second becomes a `copied_from` of it because `dice(∅, ∅) = 1`
  (`compound::duplicated-thematic-break`,
  `phases::unequal-hash-groups-pair-nothing-in-phase-1`).
- **Doc drift fixed in `docs/reconciliation-spec.md`.** The bulk-rewrite
  condition there mentioned a mean `text_sim` clause the code never had, and
  §6 promised a 0.8 confidence cap for tiny blocks that is not implemented;
  the doc now describes the code.

## Decisions

- 2026-09-25, matcher 2.0 specified as built (fixtures pin the reference,
  oddities listed above rather than silently changed). `VERSION` equals the
  matcher version already stamped in databases, so the Rust crate's first
  release is on the 2.x line. Brendan kept that over restarting at 0.x.
- 2026-09-25, matcher 2.1: Brendan chose to fix the four pinned oddities
  (phase 5 walk, `position_prior`, all splits/merges, split tombstones in
  `deleted`) as one minor bump, to wire cross-document matching into the
  checkpoint, and to leave the short-item threshold question to the eval
  harness (extend it with list-item edit classes, measure, then decide).
