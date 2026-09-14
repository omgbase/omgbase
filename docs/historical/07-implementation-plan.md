# omgbase — Implementation Plan

> **HISTORICAL — archived.** This is the original pre-build staged plan. All stages shipped; the repo layout, CLI catalog, and query-surface sections here are superseded by the as-built code and by OQX (which this doc predates and never mentions). Kept for provenance only — do not treat as current. See `AGENTS.md` for the authoritative orientation and the `docs/` trust index.

**Status:** working plan. Stages are sequential; tasks within a stage parallelize where dependencies allow. Each task is sized for one focused agent session and has acceptance criteria ("AC"). Do not start a stage before the previous stage's **exit gate** is green.

**Stack (ADR-001):** TypeScript 5.x · Node 22 LTS · better-sqlite3 · unified/remark (+gfm, +frontmatter, wiki-link & inline-field extensions) · sqlite-vec · @modelcontextprotocol/sdk · chokidar · vitest (+fast-check for property tests).

## 0. Repository layout

```
omgbase/
  src/
    core/        # parse, blocks, splice, hashing, ids, store (SQLite), revisions, commits
    reconcile/   # matcher phases, scoring, dispositions
    sync/        # watcher, checkpoints, ingest, echo suppression, git heuristics
    mutate/      # kernel ops, changesets, expectations, render-write protocol, macros
    graph/       # extraction, edges, intervals, traversal, projections
    search/      # cel compiler, fts, embeddings worker, rrf, resolve
    mcp/         # server, tools, resources, error mapping
    cli/         # omg init|attach|status|query|outline|eval-matcher|rebuild-index|serve
  corpus/
    roundtrip/   # 03-… §2.4
    matcher/     # 03-… §9 (incl. fixtures/brief-example/)
    vault/       # fixture vault for integration + trace tests
  docs/          # these documents
```

Conventions for implementation agents:
- Read `README.md` + the doc owning your module before coding. The invariants in `README.md` are non-negotiable; if a task seems to require violating one, stop and flag instead.
- Every module boundary above is a real import boundary (no reaching into another module's internals; `core` has no imports from elsewhere).
- No `remark-stringify` anywhere in the dependency graph (lint rule). Rendering is splice only.
- Determinism: no `Date.now()`/RNG inside `reconcile/` (inject a clock/config).
- Tests colocated (`*.test.ts`); corpus-driven tests read from `corpus/`.

---

## Stage 0 — Round-trip fidelity spike

Goal: prove the foundation invariant before anything else exists.

| Task | Description | AC |
|---|---|---|
| 0.1 | Scaffold: package, tsconfig strict, vitest, lint (incl. no-remark-stringify rule), CI | `pnpm test` green in CI |
| 0.2 | `core/parse`: remark pipeline → `RawBlock` tree with byte spans (03-… §1); block-type mapping incl. tasks, opaque fallback, frontmatter block | Spec-example fixtures parse to expected trees (snapshot tests) |
| 0.3 | Trivia attachment (03-… §2.3) + full-coverage assertion (every byte owned once) | Property test over corpus: coverage holds |
| 0.4 | Splice renderer (03-… §2.2) incl. `serialize_new` minimal normalization | Unit tests for insert/update splicing |
| 0.5 | Round-trip harness over `corpus/roundtrip/` (populate: CommonMark + GFM spec examples, ≥50 real files, CRLF/no-trailing-newline/conflict-marker cases) | **Exit gate:** 100% byte-identity `render(parse(f)) == f` |

## Stage 1 — Core store & read-only product

Goal: a usable read-side engine — already a better mrplex for agents. No identity threading yet (every ingest re-mints; explicitly temporary).

| Task | Description | AC |
|---|---|---|
| 1.1 | `core/ids` (mint, base32), `core/hash` (raw/norm/tree canonical serialization per 02-… §5) | Golden-vector tests |
| 1.2 | SQLite store: full DDL (02-…), migrations, writer-lock discipline | Schema tests; WAL config asserted |
| 1.3 | Blob/tree/revision/commit writers with structural sharing | Editing 1 block in a 500-block doc creates ≤ depth+2 tree rows (test) |
| 1.4 | Ingest path (parse → mint → commit) + `omg attach` walking a directory | Fixture vault ingests; convergence check green |
| 1.5 | Watcher + checkpoints + echo-suppression scaffolding (no reconcile yet: re-mint) | Save events → observed commits; engine writes produce no-op checkpoints |
| 1.6 | `docs_outline`, `nodes_get(_many)`, resolution ladder, outline wire format (06-… §6) | Outline snapshot tests; token-estimate truncation |
| 1.7 | CEL subset compiler → SQL + post-filter fallback; `query` over documents & blocks with structural functions — implements `10-query-language.md` in full (grammar, absence truth table, `list()`, link-graph predicates incl. `_static`, order/cursor stability, compilation contract) | 10-…'s §11 examples all pass as a test matrix; absence truth-table property tests; `filter_invalid` hints |
| 1.8 | FTS5 maintenance + `text` mode | Search tests |
| 1.9 | MCP server skeleton: resources, error mapping, `truncated`/cursor conventions | MCP integration test via SDK client |

**Exit gate:** against the fixture vault — outline/get/query/text all correct; convergence invariant holds through 100 random edit/save cycles (re-mint mode).

## Stage 2 — Identity & reconciliation

| Task | Description | AC |
|---|---|---|
| 2.1 | Matcher phases 1–4 (exact/normalized/anchor/context) | Unit tests per phase |
| 2.2 | Shingle index + candidate pruning + scored assignment with order constraints (phase 5) | Property test: R1–R3 never violated (fast-check over random edit scripts) |
| 2.3 | Compound classification: split/merge/copy (phase 6a) | Fixture tests incl. dominance rule + disable flag |
| 2.4 | Cross-doc same-checkpoint matching + resurrection pool (phase 6b) | Cut-paste-across-files fixture carries identity |
| 2.5 | Dispositions + near-miss recording + matcher_v stamping; bulk-rewrite give-up | brief-example fixture (03-… §10) exact output |
| 2.6 | Synthetic edit-script generator + git-history replayer + metrics (03-… §9) | `omg eval-matcher` produces the metrics report |
| 2.7 | Threshold tuning run; commit tuned config with harness run ID | **Exit gate:** precision ≥ 0.995 overall / ≥ 0.98 per class; recall ≥ 0.95 (edit/move/reorder); split/merge recall ≥ 0.75 |

## Stage 3 — Mutation & concurrency

| Task | Description | AC |
|---|---|---|
| 3.1 | Kernel ops on trees (insert/update/move/remove/split/merge, contiguous runs, placement resolution incl. `scope:"section"`) | Op unit tests; cycle_move & contiguity errors |
| 3.2 | Expectations/CAS vocabulary + typed conflict objects carrying current truth | Conflict shape tests |
| 3.3 | Changesets: cross-doc atomicity, in-order application, `$n.ids[i]` placeholders, dry_run diffs | Multi-doc move fixture atomic under injected failure |
| 3.4 | File write protocol (04-… §6): file-CAS, ingest-and-replay (once), atomic write, crash-recovery on startup | Kill-between-write-and-commit test heals via ingest |
| 3.5 | Macros (tasks/sections/lists/links_retarget) with visible expansion; retarget dry-run | Expansion golden tests |
| 3.6 | Concurrency torture suite (04-… §5 table) with a real second writer (human-save simulator) | **Exit gate:** all six scenarios behave as specified, 1000-iteration soak |

## Stage 4 — Graph

| Task | Description | AC |
|---|---|---|
| 4.1 | Extraction x1 (links, wikilinks, frontmatter fields, inline fields, URLs, images; phantom targets) | Extraction fixture matrix |
| 4.2 | Interval maintenance + doc_edges rollup in commit txn | Edit-removes-link closes row (test); rollup equivalence vs full rebuild |
| 4.3 | `graph_traverse` (frontier expansion, budgets, as_of), `graph_path` (BFS k-paths), `graph_subgraph` | Depth/budget/truncation tests; temporal as_of test |
| | _Update: this structured traversal API was later removed; traversal is now the OQX `follow` operator (see 05 §3, 10)._ | |
| 4.4 | `history_node`, `diff` (block-grain + unified), `changes_since` digests | Digest golden tests incl. origin/confidence rendering |

**Exit gate:** block-grain backlinks, temporal edge query, and T4/T5 traces (06-… §7) pass.

## Stage 5 — Retrieval

| Task | Description | AC |
|---|---|---|
| 5.1 | Embedding worker: queue, context prefix, content-keyed cache, staleness flags, provider hook + egress config | Rename-invalidates-subtree test; no-provider ⇒ semantic_unavailable |
| 5.2 | sqlite-vec integration + `semantic` mode | Recall smoke test on fixture vault |
| 5.3 | RRF fusion + boosts + evidence payloads | Deterministic ranking tests with fixed vectors |
| 5.4 | `resolve` + `pipeline` | T7 trace passes in 2 turns |

**Exit gate:** hybrid beats FTS-only on a 30-query labeled set over the fixture vault (MRR).

## Stage 6 — Agent ergonomics & traces

| Task | Description | AC |
|---|---|---|
| 6.1 | budget_tokens truncation everywhere; cursor pagination audit | Truncation flags verified per tool |
| 6.2 | `sync_flush`, `sync_status`, `repos_status` | Read-your-own-writes test |
| 6.3 | Executable trace suite T1–T9 (scripted agent against fixture vault) | **Exit gate:** every trace within its turn budget |
| 6.4 | MCP tool descriptions per 06-… §4; docs pass | Description lint (IDs-stable, dry-run conventions present) |

## Stage 7 — Hardening & migration

| Task | Description | AC |
|---|---|---|
| 7.1 | Git heuristics: HEAD-change checkpointing, conflict-marker flagging, rename hints, index.lock pause | Branch-switch storm test: no identity carnage, one checkpoint |
| 7.2 | GC mark-and-sweep behind flag; pool expiry sweep | Rebuild-equivalence after GC |
| 7.3 | `omg rebuild-index --all` + drop-and-rebuild CI check | Byte/semantic equivalence per 02-… §6 |
| 7.4 | mrplex importer: docs → minted ids, optional doc-version history import, **no** retro-inferred block history | worknotes import dry-run report |
| 7.5 | Perf pass at envelope scale (10⁶ blocks synthetic): ingest, query, traverse budgets | p95 targets: outline < 50ms, query < 100ms, traverse < 150ms, checkpoint ingest < 500ms/file |
| 7.6 | Postgres dialect spike (do not ship) | Report only |

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Matcher quality below gates on real edits | Gates are Stage-2 exit; thresholds tunable without schema change; bulk-rewrite give-up bounds the damage; identity is non-load-bearing by design |
| remark span fidelity edge cases | Stage 0 corpus is the tripwire; opaque-block fallback absorbs unknowns |
| Watcher platform quirks (macOS FSEvents coalescing, case-insensitive FS, symlinks) | chokidar + checkpoint model absorbs coalescing; canonicalize paths; symlinks out of scope v1 (documented) |
| sqlite-vec scale ceiling | Envelope is 10⁵–10⁶ vectors; brute force fine to ~10⁵; document the ceiling; PG/pgvector is the pressure valve |
| Scope creep into cut list | `08-decisions.md` cut list is authoritative; PRs adding cut items are rejected by review checklist |

## Deferred feature reservations

**Projected queries** (`09-projected-queries.md`) is a post-v1 feature (realistically Stage 8, after Stage 5 is stable) — but its §8 reservations are v1 work, folded into existing tasks: ```` ```omg ```` fence → inert `type:"query"` blocks (task 0.2), schema enum/column reservations (task 1.2 — already in the DDL), fact-source seam in the query planner (task 1.7), `v_` id prefix + `attrs.generated` matcher guard (tasks 1.1 / 2.5). Building any evaluation, strata, or refresh machinery in v1 is a cut-list violation.

## Definition of done (v1.0)

All exit gates green · invariants suite green in CI · a month of daily-driver use on worknotes without manual repair · docs in `docs/` updated to as-built.
