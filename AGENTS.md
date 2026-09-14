# Agent guide for omgbase

omgbase ("Open Markdown Graph Base") is a versioned, addressable **graph layer over authored Markdown/YAML/JSON files**. Files stay the human source of truth for *content*; an embedded SQLite database owns *identity, history, and derived indexes*. At quiescence `sha256(file) == the current revision's rendered hash`. The engine is exposed three ways: a library (`@omgbase/core`), a CLI (`omg`), and an MCP server (`omg mcp`).

## The one rule that governs everything else

**Code and tests are ground truth. The `docs/` folder describes intent and design, and parts of it have drifted from the implementation.** When a doc and the code disagree, the code wins — and you should trust `docs/` only as far as the trust index below says. Do not treat a `docs/` claim as authoritative without confirming it against the code or a test.

If you change behavior, update the relevant canon doc in the same change. If you find a doc claim that no longer matches the code, fix the doc (or flag it) rather than coding to the doc.

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

- **MCP tool surface** (names, params, behavior): the registrations and inline tool descriptions in `packages/core/src/mcp/server.ts`. This is the definitive list of tools, not `docs/06`.
- **Query language (OQX)**: the `query` tool's description in `packages/core/src/mcp/server.ts`, the engine in `packages/core/src/oqx/`, and the runnable examples in `packages/core/corpus/oqx/README.md`. OQX is the single query + traversal surface (`from … where … select … collect/exists/count … follow … order by`); the old structured `graph_traverse/path/subgraph` tools were removed. `docs/10-query-language.md` specs the language (reconciled to as-built).
- **SQLite schema**: `packages/core/src/core/store/schema.ts` (`SCHEMA_VERSION` + migrations). Definitive over `docs/02`.
- **Mutation kernel** (the six ops + macros + whole-doc reconciliation): `packages/core/src/mutate/`.

## docs/ trust index

Each file is labeled by how much you can trust it as-is. **canon** = matches the code, safe to rely on. **partially-drifted** = mostly right, with specific stale sections — verify against code before relying. **historical** = describes plans/features that changed or were never built; read for background only, never as current.

| File | Trust | Notes |
| --- | --- | --- |
| `docs/README.md` | canon | docs index, invariants, glossary |
| `docs/01-architecture.md` | canon | conceptual overview; sqlite-vec is aspirational (vectors are brute-force BLOBs) |
| `docs/02-data-model.md` | partially-drifted | schema is mostly right, but the `docs`/`blocks` table listings are stale and several tables are missing — trust `store/schema.ts` |
| `docs/03-reconciliation-spec.md` | canon | matcher pipeline + thresholds verified as-built |
| `docs/04-mutation-and-concurrency.md` | partially-drifted | six-op algebra is canon; conflict-object fields, `Expect.doc_revision`, and "auto-replay" retry are unbuilt |
| `docs/05-graph-and-query.md` | partially-drifted | §1–3, §5–6 canon; §4 shows the pre-OQX query envelope; §7 `pipeline` and §8 `collections`/`member_of` were never built |
| `docs/06-mcp-api.md` | canon | rewritten 2026-09-14 to match `mcp/server.ts` (31 tools); `server.ts` remains the ultimate source if they ever diverge |
| `docs/historical/07-implementation-plan.md` | historical | the original staged plan; all stages shipped, layout/CLI/query sections superseded |
| `docs/08-decisions.md` | canon-rationale | the ADR log ("why"); all 12 are still `Status: proposed`. ADR-006's body predates the OQX-follow pivot (its own "Update" corrects it); ADR-011 overstates which projected-query seams shipped |
| `docs/09-projected-queries.md` | historical (design) | deferred feature, self-labeled "DO NOT BUILD in v1" — accurate as forward-looking design; only schema enum/`v_`-prefix reservations landed |
| `docs/10-query-language.md` | canon | reconciled 2026-09-14 to as-built OQX (single query-string surface; the never-wired link predicates removed). The OQX sources above remain the live reference |
| `docs/11-cli.md` | partially-drifted | overwhelmingly as-built; a few stale items (no `graph` command, `find` flags, `--budget-tokens`, flock is really an O_EXCL pidfile). Trust `packages/cli/src/cmd/` |
| `docs/12-properties-table.md` | canon | fully implemented despite the "RFC / not yet normative" header; `SCHEMA_VERSION` is 12, not v8 |
| `docs/13-sync-plugins.md` | partially-drifted | the stdio protocol + fs-adapter + async driver are shipped/canon; the adapter/source/attachment registry tables and the `adapter`/`source`/`repo` CLI verbs are not built |
| `docs/14-update-opsets.md` | canon | as-built spec for the whole-document reconciliation planner (`docs_update`/`docs_plan_update`) |

When you rely on a `partially-drifted` doc, confirm the specific claim against the code path it names before acting on it.
