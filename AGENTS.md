# Agent guide for omgbase

omgbase ("Open Markdown Graph Base") is a versioned, addressable **graph layer over authored Markdown/YAML/JSON files**. Files stay the human source of truth for *content*; an embedded SQLite database owns *identity, history, and derived indexes*. At quiescence `sha256(file) == the current revision's rendered hash`. The engine is exposed three ways: a library (`@omgbase/core`), a CLI (`omg`), and an MCP server (`omg mcp`).

## The one rule that governs everything else

**Code and tests are ground truth.** The `docs/` folder is maintained as an as-built description of the implementation, but when a doc and the code disagree, the code wins.

If you change behavior, update the relevant doc in the same change. If you find a doc claim that no longer matches the code, fix the doc (or flag it) rather than coding to the doc.

## Reaching Brendan (`lmk`)

When you hit a stopping point — work is done, or you're blocked and need input — ping Brendan's phone: `lmk 'short message'` (a `~/bin/lmk` shim that posts to an ntfy.sh topic). Use it for genuine handoffs (a review is ready, a long build finished, you need a decision), not routine progress. Keep the message one line and specific.

## Orientation

- **Monorepo** (pnpm workspace, Node ≥ 22, pnpm 12). Packages:
  - `packages/core` — the engine. Everything of substance lives here: `parse/`, `reconcile/`, `mutate/`, `oqx-js/` (binds the external `@omgbase/oqx`) + `search/`, `graph/`, `core/store/` (SQLite schema), `mcp/`.
  - `packages/cli` — the `omg` / `omgbase` binary (a thin second client over `core`; no business logic).
  - `packages/embedder` — transformers.js / all-MiniLM-L6-v2 embeddings.
  - `packages/fs-adapter` — chokidar-based filesystem sync adapter (stdio).
  - `packages/client` — thin remote MCP client (placeholder).
- **Data model** is three layers: **Docs → Blocks** (stable `b_` ids; the mutation anchors) **→ Nodes** (semantic projections: links, tasks, sections, anchors…).

## Build / verify

```
pnpm build     # tsc -b across the workspace
pnpm test      # pnpm -r test (vitest); core is the big suite
pnpm lint      # pnpm -r lint
```

Always run `pnpm build && pnpm test` before considering a change done.

## Where the authoritative truth lives for each surface

Prefer these over prose docs — they cannot drift because they *are* the implementation:

- **MCP tool surface** (names, params, behavior): the registrations and inline tool descriptions in `packages/core/src/mcp/server.ts`. This is the definitive list of tools, not `docs/mcp-api.md`.
- **Query language (OQX)**: OQX is now the external **`@omgbase/oqx`** package (parser + engine + semantics); omgbase binds it to the store via `packages/core/src/oqx-js/` (a `DataContext` in `context.ts` + the `oqxRun` wrapper in `run.ts`; `packages/core/src/oqx/run.ts` is a thin re-export kept for import stability). The former in-tree compiler was removed (ADR-013). Authoritative surface: the `query` tool description in `packages/core/src/mcp/server.ts`, the runnable examples in `packages/core/corpus/oqx/README.md`, and the behavioral gate `corpus/oqx/alchemy.test.ts` (+ `corpus/oqx/conformance.test.ts`, which proves the tier-3 pushdown planner equals pure in-memory). OQX is the single query + traversal surface (`from … where … select … collect/exists/count … follow … order by`). **Scalar semantics follow `@omgbase/oqx`, not the old CEL layer** — `docs/query-language.md` is rewritten to as-built (ADR-013 behavior changes: `!=`/negation over absent matches, case-sensitive string ops + `.lower()`/regex `matches()`, absent sorts last, arithmetic supported, `select/collect/count distinct`). `packages/core/src/search/cel/` remains only as a helper the store-context reuses (FTS sanitizer, `FilterInvalid`, vec types).
- **SQLite schema**: `packages/core/src/core/store/schema.ts` (`SCHEMA_VERSION` + migrations). Definitive over `docs/data-model.md`.
- **Mutation kernel** (the six ops + macros + whole-doc reconciliation): `packages/core/src/mutate/`.

## docs/ index

Every doc here is maintained as an **as-built** description of the code (last verified 2026-09-14). They are references, not scripture: if a doc ever disagrees with the code, the code wins — fix the doc (or flag it) rather than coding to the doc. If you change behavior, update the relevant doc in the same change.

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
| `docs/query-language.md` | OQX query language: the query-string surface + CEL predicate grammar |
| `docs/cli.md` | the `omg` CLI: commands, concurrency/freshness model, output contract |
| `docs/properties-table.md` | the properties table + unified property query surface |
| `docs/sync-plugins.md` | external-source stdio adapter protocol + `@omgbase/fs-adapter` (registry tables reserved, not yet wired) |
| `docs/sync-service-design.md` | **DESIGN, not as-built** (ADR-014): the `@omgbase/sync` migration — sync as a standalone MCP-client service, `DocStore` seam, `observe` tool, `attach`-as-sugar, `root_path` removal |
| `docs/surface-map.md` | the **Rosetta stone**: one operation catalog across library / `omg` CLI / MCP tool, the exception set, and the gap list that makes `--server` (remote-over-MCP) feel local |
| `docs/update-opsets.md` | whole-document update planner (`docs_update`/`docs_plan_update`, `omg update`) |
