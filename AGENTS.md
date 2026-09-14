# Agent guide for omgbase

omgbase ("Open Markdown Graph Base") is a versioned, addressable **graph layer over authored Markdown/YAML/JSON files**. Files stay the human source of truth for *content*; an embedded SQLite database owns *identity, history, and derived indexes*. At quiescence `sha256(file) == the current revision's rendered hash`. The engine is exposed three ways: a library (`@omgbase/core`), a CLI (`omg`), and an MCP server (`omg mcp`).

## The one rule that governs everything else

**Code and tests are ground truth.** The `docs/` folder is maintained as an as-built description of the implementation, but when a doc and the code disagree, the code wins.

If you change behavior, update the relevant doc in the same change. If you find a doc claim that no longer matches the code, fix the doc (or flag it) rather than coding to the doc.

## Orientation

- **Monorepo** (pnpm workspace, Node ≥ 22, pnpm 12). Packages:
  - `packages/core` — the engine. Everything of substance lives here: `parse/`, `reconcile/`, `mutate/`, `oqx/` + `search/`, `graph/`, `core/store/` (SQLite schema), `mcp/`.
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
- **Query language (OQX)**: the `query` tool's description in `packages/core/src/mcp/server.ts`, the engine in `packages/core/src/oqx/`, and the runnable examples in `packages/core/corpus/oqx/README.md`. OQX is the single query + traversal surface (`from … where … select … collect/exists/count … follow … order by`); the old structured `graph_traverse/path/subgraph` tools were removed. `docs/query-language.md` specs the language (reconciled to as-built).
- **SQLite schema**: `packages/core/src/core/store/schema.ts` (`SCHEMA_VERSION` + migrations). Definitive over `docs/data-model.md`.
- **Mutation kernel** (the six ops + macros + whole-doc reconciliation): `packages/core/src/mutate/`.

## docs/ index

Every doc here is maintained as an **as-built** description of the code (last verified 2026-09-14). They are references, not scripture: if a doc ever disagrees with the code, the code wins — fix the doc (or flag it) rather than coding to the doc. If you change behavior, update the relevant doc in the same change.

| File | Covers |
| --- | --- |
| `docs/README.md` | docs index, CI-enforced invariants, glossary |
| `docs/architecture.md` | system shape, kernel concepts, identity/canonicality rules |
| `docs/data-model.md` | SQLite DDL, ID/hash conventions, rebuild/GC rules (authoritative schema is `core/store/schema.ts`) |
| `docs/reconciliation-spec.md` | parser contract, round-trip law, matcher phases/thresholds |
| `docs/mutation-and-concurrency.md` | six-op kernel, changesets, CAS, conflict objects, write protocol |
| `docs/graph-and-query.md` | edge extraction, OQX traversal, RRF retrieval, embeddings |
| `docs/mcp-api.md` | MCP tool surface, resources, error codes (`mcp/server.ts` is the ultimate source) |
| `docs/decisions.md` | the ADR log ("why"); all 12 remain `Status: proposed` |
| `docs/query-language.md` | OQX query language: the query-string surface + CEL predicate grammar |
| `docs/cli.md` | the `omg` CLI: commands, concurrency/freshness model, output contract |
| `docs/properties-table.md` | the properties table + unified property query surface |
| `docs/sync-plugins.md` | external-source stdio adapter protocol + `@omgbase/fs-adapter` (registry tables reserved, not yet wired) |
| `docs/update-opsets.md` | whole-document update planner (`docs_update`/`docs_plan_update`, `omg update`) |
