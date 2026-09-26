# omgbase-reconcile

**The omgbase reconciliation matcher — Rust implementation.**

Reconciliation is how omgbase keeps **block identity** across edits. Given the
last persisted block tree of a document (every block carrying its `b_` id) and
the freshly parsed tree of the new file bytes (no ids), the matcher decides,
for every new block, whether it **carries** an existing id or is **minted**,
and records a **disposition** per decision (kind, confidence, reason, detail):

```rust
use omgbase_format::parse_markdown;
use omgbase_reconcile::{Config, FlatSource, Options, SequentialMinter, flatten, reconcile_document};

let old = parse_markdown("## Risks\n\nStable block identity is difficult.\n");
let new = parse_markdown("## Risks\n\nAn inserted paragraph.\n\nStable block identity is quite difficult.\n");

let mut ids = SequentialMinter::new("b");                 // a store brings its persisted ids
let old = flatten(&FlatSource::from_tree(&old, Some(&mut ids)));
let new = flatten(&FlatSource::from_tree(&new, None));

let mut minter = SequentialMinter::new("n");              // a store brings its CSPRNG minter
let result = reconcile_document(&old, &new, Options { config: &Config::default(), pool: &[], minter: &mut minter });
assert_eq!(result.assignment["/0"], "b_0");               // the heading locks exactly
assert_eq!(result.assignment["/2"], "b_1");               // the edited paragraph carries
assert_eq!(result.assignment["/1"], "n_0");               // the insertion is minted
```

This crate is the second implementation of the matcher. The reference is the
TypeScript engine
[`@omgbase/core`](https://github.com/omgbase/omgbase/tree/main/packages/core)
(`src/reconcile`). Both conform to the language-neutral specification and
fixtures at
[`spec/reconcile`](https://github.com/omgbase/omgbase/tree/main/spec/reconcile)
in the same repository; `omgbase_reconcile::SPEC_VERSION` reports the matcher
version this crate implements (`MATCHER_V` is the `m<VERSION>` stamp every
disposition carries) and the crate version tracks it as
`<major>.<minor>.<patch>`.

## Status

Conformance-first: `tests/spec.rs` runs every fixture in `spec/reconcile/cases`
(95 cases in 10 files at matcher version 2.1, crate 2.1.0) and all of them
pass, so `cargo test -p omgbase-reconcile` requires every case to pass.
Matcher 2.1 is the four §10 fixes over 2.0: phase 5 keeps walking past a
sub-threshold candidate, `position_prior` is over the sibling count, every
split and merge resolves in one run, and split tombstones are listed in
`deleted`. The
reference's unit tests are ported alongside the modules they exercise.
Published on crates.io; the fixtures do not ship in the crate (the runner
skips with a note outside the monorepo).

Not included: the evaluation harness (labelled corpora, the release gates of
`docs/reconciliation-spec.md`) stays with the reference in
`packages/core/src/reconcile/eval`; and the store integration — persisting
dispositions, the resurrection pool, anchors — is the store's, which arrives
with the next port.

The runner keeps an allowlist mechanism for the periods when the spec runs
ahead of the port (from `spec/reconcile/README.md` §9): if
`tests/spec-passing.txt` exists, it names the case ids (`<file-stem>::<name>`,
one per line) that must pass; a listed case that fails fails the build, an
unlisted case that passes fails the build with a message asking for it to be
added, and a listed id that no longer exists is an error too. When the file is
absent — the current state — every case must pass. The runner prints `spec: N
passed, M failed, K listed` on stderr and, on failure, the offending case ids
grouped by fixture file with a one-line reason each (the path of the first
differing value, with both values).

To (re)generate the allowlist from the currently passing set — for example
after new fixtures land in `spec/reconcile/cases` before the port catches up —
run:

```sh
RECONCILE_SPEC_UPDATE=1 cargo test -p omgbase-reconcile --test spec
```

This writes the list (and prints any listed case that now fails, so nothing is
blessed silently), or deletes the file once every case passes.

## Layering

Mirrors the spec so the two can be read side by side:

- `types` — `MatchBlock` (§1.2), `Disposition`/`DispositionKind`/`Reason`
  (§2), `Detail`/`DetailValue` (a tiny JSON-like value; the core crate needs
  no serde), `Config` with the §6 defaults under the fixtures' snake_case
  names, `PoolEntry`, `ReconcileResult`.
- `similarity` — `tokenize`, `token_count`, `shingles`, `dice`, `text_sim`
  (§4). Tokenizing splits on the JavaScript `\s` set
  (`omgbase_format::text::is_js_whitespace`) and lowercases with Unicode
  default case mapping.
- `flatten` — `FlatSource` (the §1.1 input block) and `flatten` to pre-order
  `MatchBlock`s with `text` per spec/format §4.1 in tree context and both
  hashes; `FlatSource::from_tree` adapts a parsed `omgbase_format::BlockTree`
  (frontmatter dropped, optional pre-order ids).
- `phases` — `PhaseState` and phases 1–4 (exact lock, normalized lock, anchor
  lock, context propagation + children vouching to a fixed point), with
  `classify_kind` (§2) and the §10 phase-3 rule.
- `phase5` — the scored assignment: pruning, the five-term score summed in
  the spec's order (`position_prior` over per-tree sibling counts), the
  greedy walk that skips sub-threshold candidates, with R3 and near misses.
- `phase6a` — splits, merges, copies (lineage mints); the split and merge
  passes continue through the document after each hit.
- `reconcile` — `reconcile_document` + `Options`: the pipeline, the
  bulk-rewrite check, phase 6b (resurrection) and phase 7 (defaults, minting).
- `crossdoc` — `cross_doc_match` / `apply_cross_doc_matches` (§7).
- `mint` — the `Minter` trait and `SequentialMinter`. The matcher never
  chooses an id's spelling; a store implements `Minter` over its CSPRNG.

Confidences are IEEE doubles computed in the reference's term order, so they
are bit-identical to the reference's (the fixtures compare within 1e-9).

## Features

- `json` — `Disposition::to_json`, `ReconcileResult::to_json`,
  `detail_to_json` and `From<&DetailValue> for serde_json::Value`: the shape a
  store persists for `detail` and the shape the conformance runner compares
  before canonicalizing minted ids. The runner does not need it and
  cross-checks it when it is on.

## License

MIT
