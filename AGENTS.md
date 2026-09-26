# Agent guide for omgbase

omgbase ("Open Markdown Graph Base") is a versioned, addressable **graph layer over authored Markdown/YAML/JSON files**. Files stay the human source of truth for *content*; an embedded SQLite database owns *identity, history, and derived indexes*. At quiescence `sha256(file) == the current revision's rendered hash`. The engine is exposed three ways: a library (`@omgbase/core`), a CLI (`omg`), and an MCP server (`omg mcp`).

## The one rule that governs everything else

**Code and tests are ground truth.** The `docs/` folder is maintained as an as-built description of the implementation, but when a doc and the code disagree, the code wins.

If you change behavior, update the relevant doc in the same change. If you find a doc claim that no longer matches the code, fix the doc (or flag it) rather than coding to the doc.

## Reaching Brendan (`lmk`)

When you hit a stopping point — work is done, or you're blocked and need input — ping Brendan's phone: `lmk 'short message'` (a `~/bin/lmk` shim that posts to an ntfy.sh topic). Use it for genuine handoffs (a review is ready, a long build finished, you need a decision), not routine progress. Keep the message one line and specific.

## Orientation

- **Monorepo** (pnpm workspace, Node ≥ 22, pnpm 12). Packages:
  - `packages/core` — the engine. Everything of substance lives here (`packages/core/src/`): `format/` (parsers/renderers), `reconcile/`, `mutate/`, `oqx-js/` (binds `@omgbase/oqx`; `oqx/` is a thin re-export) + `search/`, `graph/`, `core/store/` (SQLite schema), `sync/`, `mcp/`, `cli/`.
  - `packages/oqx` — `@omgbase/oqx`: the OQX query language + engine (parser, in-memory engine, `DataContext`/`QueryPlanner` seams, `node:sqlite` adapter). In-tree since ADR-019 but **standalone**: zero runtime dependencies, its own semver line, published on its own, never imports anything from omgbase. Any change here must keep it free of omgbase imports and must bump its `version` + `CHANGELOG.md`.
  - `packages/cli` — the `omg` / `omgbase` binary (a thin second client over `core`; no business logic).
  - `packages/sync` — `@omgbase/sync`: the store-to-store synchronizer (ADR-014) — `Coordinator`, `EngineClient` seam (in-process or MCP), the `omgbase-sync` bin; backs `omg sync --server`.
  - `packages/embedder` — transformers.js / `Xenova/gte-base` (768-dim) embeddings, served as the `omgbase-embedder` stdio binary.
  - `packages/fs-adapter` — chokidar-based filesystem sync adapter (stdio).
  - `packages/client` — thin remote MCP client (placeholder).
- **Rust side** (cargo workspace at the root `Cargo.toml` over `crates/*`, independent of the pnpm workspace). The Rust port proceeds component by component, each behind a language-neutral spec under `spec/` that both implementations run: **fixture first, TypeScript (reference) second, Rust third**. A behavior change without a fixture is not done.
  - `crates/oqx` — the Rust implementation of OQX (published, conformant: `tests/spec.rs` runs every case in `spec/oqx/cases`). Keep it focused on the OQX language; it never imports anything from omgbase and is not extended for omgbase's convenience.
  - `crates/omgbase-format` — the Rust format layer: source file → block tree (spans, trivia, normalized text, hashes) and the splice renderer. Port of `packages/core/src/core/parse` + `src/format`; `tests/spec.rs` runs `spec/format/cases`, gated by `tests/spec-passing.txt` while the port runs behind the fixtures.
  - `spec/oqx` — **the OQX specification**, owned by neither implementation: `GRAMMAR.md`, `SEMANTICS.md`, `VERSION`, and the executable fixtures `cases/*.json` that both the TypeScript runner (`packages/oqx/test/spec.test.ts`) and the Rust runner execute. Read `spec/oqx/README.md` for the fixture contract.
  - `crates/omgbase-reconcile` — the Rust block-identity matcher: old tree (with ids) × new tree → assignment + dispositions, the resurrection pool, cross-document moves. Port of `packages/core/src/reconcile`; `tests/spec.rs` runs `spec/reconcile/cases`. The eval harness (`reconcile/eval`) stays in the reference.
  - `spec/format` — **the block-model specification**: `README.md` (block tree, round-trip law, trivia attachment, Markdown kinds/attrs, text normalization, hashing, fixture contract) + `VERSION` + `cases/*.json`. The fixtures are *generated* by the reference from `packages/core/corpus/roundtrip` (`FORMAT_SPEC_UPDATE=1` on `packages/core/corpus/format/spec.test.ts`) and reviewed as code; the Rust runner consumes them.
  - `spec/reconcile` — **the matcher specification**: `README.md` (inputs/flattening, dispositions, R1–R6, shingle similarity, every phase as an exact rule, thresholds, cross-doc, fixture contract, the reference oddities and decisions) + `VERSION` (= the matcher version stamped on dispositions: `2.0` ↔ `m2.0`) + `cases/*.json`. Fixture *inputs* are authored by hand; each case's `expect` is *generated* by the reference (`RECONCILE_SPEC_UPDATE=1` on `packages/core/corpus/reconcile/spec.test.ts`) and reviewed as code.
  - `crates/omgbase-store` — the Rust store: opens the same SQLite database as `@omgbase/core` (`schema.sql`, migrations), runs the observe/commit procedure (echo gate, reconcile against the stored tree, Merkle tree + blobs, revision + commit, resurrection pool, tombstones, cross-document batch), reconstructs bytes, rebuilds derived tables. Port of `core/store` + `core/ingest.ts` + the sync-side observe path; `tests/spec.rs` runs `spec/store/cases`. Writes `properties` rows via `omgbase-properties` (13.1) and the graph tables via `omgbase-graph` (13.2); search is not in it yet.
  - `spec/store` — **the store specification**: `README.md` (what "language-neutral" means for a database, ids/hashes/time, table meanings, `schema.sql` + migrations, canonical encodings — tree entries, order keys, sections — the observe procedure as an exact rule, reconstruct, rebuild/GC, the invariants every runner checks, fixture contract, reference oddities) + `VERSION` (major = the schema `user_version`: `13.0`) + `schema.sql` (the DDL, verbatim; both implementations embed it) + `cases/*.json` (schema fingerprint, migrations on authored pre-states, observation scripts with reference-generated projections; `STORE_SPEC_UPDATE=1` on `packages/core/corpus/store/spec.test.ts`). Ids in fixtures come from a sequential per-prefix minter both runners install.
  - `crates/omgbase-properties` — the Rust properties layer: a document's block tree → the typed `properties` rows (frontmatter flattening over YAML 1.2 core schema, inline `key:: value` fields, computed `$title`/`$tags`) and the grouped/merged read shapes. Pure library; `omgbase-store` calls it in the commit. `tests/spec.rs` runs `spec/properties/cases`.
  - `spec/properties` — **the properties specification**: `README.md` (row shape and `prop_id`, value typing and the range side channel, flattening, the three sources as exact rules, the YAML contract, read shapes, fixture contract, reference oddities) + `VERSION` + `cases/*.json` (sources authored, `expect` generated by `PROPERTIES_SPEC_UPDATE=1` on `packages/core/corpus/properties/spec.test.ts`). 
  - `crates/omgbase-graph` — the Rust graph layer: node projection (`md:link`/`md:wikilink`/`md:task`/`md:anchor`/`md:inline_field`, byte spans) and edge extraction (links, frontmatter and inline relations, URI normalization) as pure functions; `omgbase-store` resolves targets (external nodes, phantoms), maintains edge intervals and the `doc_edges` rollup (store 13.2). Runner runs `spec/graph/cases`.
  - `spec/graph` — **the graph specification**: `README.md` (node kinds and `node_id`, extraction x2 as exact rules, resolution, interval maintenance, rollup, phantom adoption, URI normalization, fixture contract, oddities) + `VERSION` + `cases/*.json` (observation scripts, `GRAPH_SPEC_UPDATE=1` on `packages/core/corpus/graph/spec.test.ts`). Remaining specs in order: search (FTS + embeddings), mutation kernel, sync registry; then MCP/CLI.
- **Data model** is three layers: **Docs → Blocks** (stable `b_` ids; the mutation anchors) **→ Nodes** (semantic projections: links, tasks, sections, anchors…).

## Build / verify

```
pnpm build     # builds packages/oqx first (core resolves its types from oqx's dist), then tsc -b across the workspace
pnpm test      # pnpm -r test (vitest; oqx uses node --test, Node ≥ 22.18); core is the big suite
pnpm lint      # pnpm -r lint
```

Always run `pnpm build && pnpm test` before considering a change done.

Rust (when touching `crates/` or `spec/`):

```
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

## Where the authoritative truth lives for each surface

Prefer these over prose docs — they cannot drift because they *are* the implementation:

- **MCP tool surface** (names, params, behavior): the registrations and inline tool descriptions in `packages/core/src/mcp/server.ts`. This is the definitive list of tools, not `docs/mcp-api.md`.
- **Query language (OQX)**: OQX is the **`@omgbase/oqx`** package (parser + engine + semantics; in-tree at `packages/oqx` since ADR-019, still a standalone zero-dependency library published on its own version line — omgbase code must never be imported from it); omgbase binds it to the store via `packages/core/src/oqx-js/` (a `DataContext` in `context.ts` + the `oqxRun` wrapper in `run.ts`; `packages/core/src/oqx/run.ts` is a thin re-export kept for import stability). The former in-tree compiler was removed (ADR-013). Authoritative surface: the `query` tool description in `packages/core/src/mcp/server.ts`, the runnable examples in `packages/core/corpus/oqx/README.md`, and the behavioral gate `corpus/oqx/alchemy.test.ts` (+ `corpus/oqx/conformance.test.ts`, which proves the tier-3 pushdown planner equals pure in-memory). OQX is the single query + traversal surface (`from … where … select … collect/exists/count … follow … order by`). **Scalar semantics follow `@omgbase/oqx`, not the old CEL layer** — `docs/query-language.md` is rewritten to as-built (ADR-013 behavior changes: `!=`/negation over absent matches, case-sensitive string ops + `.lower()`/regex `matches()`, absent sorts last, arithmetic supported, `select/collect/count distinct`). `packages/core/src/search/cel/` remains only as a helper the store-context reuses (FTS sanitizer, `FilterInvalid`, vec types).
- **SQLite schema**: `packages/core/src/core/store/schema.ts` (`SCHEMA_VERSION` + migrations), which must equal `spec/store/schema.sql` byte for byte (a test enforces it). Definitive over `docs/data-model.md`; the observe/commit semantics over that schema are `spec/store/README.md` §5.
- **Mutation kernel** (the six ops + macros + whole-doc reconciliation): `packages/core/src/mutate/`.

## docs/ index

Every doc here is maintained as an **as-built** description of the code (last verified 2026-09-23). They are references, not scripture: if a doc ever disagrees with the code, the code wins — fix the doc (or flag it) rather than coding to the doc. If you change behavior, update the relevant doc in the same change.

| File | Covers |
| --- | --- |
| `docs/README.md` | docs index, CI-enforced invariants, glossary |
| `docs/architecture.md` | system shape, kernel concepts, identity/canonicality rules |
| `docs/object-model.md` | **orientation**: the docs/blocks/nodes/edges mental model and which layer each verb touches (conceptual; specs are authoritative) |
| `docs/data-model.md` | SQLite DDL, ID/hash conventions, rebuild/GC rules (authoritative schema is `core/store/schema.ts`) |
| `docs/reconciliation-spec.md` | parser contract, round-trip law, matcher phases/thresholds |
| `docs/mutation-and-concurrency.md` | six-op kernel, changesets, CAS, conflict objects, write protocol |
| `docs/graph-and-query.md` | edge extraction, OQX traversal, RRF retrieval, embeddings |
| `docs/mcp-api.md` | MCP tool surface, resources, error codes (`mcp/server.ts` is the ultimate source) |
| `docs/decisions.md` | the ADR log ("why"); all remain `Status: proposed` |
| `docs/query-language.md` | OQX query language as-built: targets/fields, `@omgbase/oqx` scalar semantics, scoping (`^`/`$repo`), consumers, `values`/`none`/`limit`/`entries()`, `follow`, execution model |
| `docs/cli.md` | the `omg` CLI: commands, concurrency/freshness model, output contract |
| `docs/properties-table.md` | the properties table + unified property query surface |
| `docs/sync-plugins.md` | external-source stdio adapter protocol + `@omgbase/fs-adapter`; the adapters/sources/attachments registry (wired — `omg source`), sourceless repos |
| `docs/sync-service-design.md` | ADR-014 design rationale + stage record (**implemented**, all six stages): `@omgbase/sync` as a standalone MCP-client service, `DocStore` seam, `observe*` tools, `attach`-as-sugar, `root_path` removal (schema v13) |
| `docs/surface-map.md` | the **Rosetta stone**: one operation catalog across library / `omg` CLI / MCP tool, the exception set, and the gap list that makes `--server` (remote-over-MCP) feel local |
| `docs/update-opsets.md` | whole-document update planner (`docs_update`/`docs_plan_update`, `omg update`) |
