# omgbase — Decision Log (ADRs)

Format: one ADR per decision; status is `proposed` until Brendan ratifies (`accepted`), after which changes require a superseding ADR. Implementation agents MUST treat `proposed` ADRs as binding defaults and MUST NOT silently deviate.

> All 13 ADRs remain `Status: proposed` — unratified binding defaults, not `accepted`. See `AGENTS.md` for the docs trust index.

---

## ADR-001 — TypeScript + SQLite embedded engine
**Status:** proposed
**Context:** Single-writer engine beside a working tree; target scale ≤10⁶ blocks/repo; implementation by coding agents; MCP-first surface.
**Decision:** TypeScript/Node 22, better-sqlite3 (WAL), unified/remark parse layer, sqlite-vec, FTS5, MCP TypeScript SDK. One SQLite DB per workspace under `.omgbase/`. PostgreSQL is a deferred dialect (same logical schema) adopted only when a real multi-user server exists.
**Consequences:** zero-ops local-first deployment; agent-friendly ecosystem; a documented vector-scale ceiling (~10⁵–10⁶) with pgvector as the pressure valve. Rust/comrak remains a possible future core behind the same `BlockTree` interface if parse fidelity or perf demands it.

## ADR-002 — External identity; no ID write-back into Markdown
**Status:** proposed
**Context:** Embedded IDs make matching exact until copy-paste forges them, tools strip them, and every file is polluted; heuristic reconciliation is needed regardless (foreign repos).
**Decision:** IDs are minted, opaque, repo-scoped, engine-local. The engine never injects markers. Authored anchors (`^ref`) are consumed as evidence and locators, never required.
**Consequences:** files stay pristine; identity is heuristic under out-of-band edits (mitigated by ADR-003); block IDs are not portable across engines (ADR-010).

## ADR-003 — Identity carries continuity, never truth; sync records dispositions, not operations
**Status:** proposed
**Context:** If edges/search/CAS hang off heuristic identity, matcher errors corrupt data. A file diff cannot testify to operations, only to states.
**Decision:** All operational data (edges, indexes, embeddings, rendering, CAS) derives from current parsed content. Identity threads only history/lineage. API commits record operations (intent); observed commits record dispositions (kind, confidence, reason, matcher_v). Snapshot chain is the source of truth; the commit log is the change feed (no event sourcing).
**Consequences:** matcher fallibility degrades biographies, never truth; history is honest about inference; replay/audit still possible via ops on api commits.

## ADR-004 — Canonicality split
**Status:** proposed
**Decision:** Files own content bytes; the database owns identity/history/lineage; everything else is derived and rebuildable. On any content disagreement the file wins and is ingested. Convergence invariant: at quiescence `sha256(file) == current_revision.rendered_hash`.
**Consequences:** `git pull` can never corrupt the engine; the engine can never surprise the human's files except through explicit API writes; "dual-write" reduces to two ingestion paths into one commit log.

## ADR-005 — Flat containment tree; sections are derived ranges
**Status:** proposed
**Decision:** Persist the flat CommonMark structure (headings are leaves). Sections are a per-revision derived index keyed by heading block; addressed as `{heading, scope:"section"}`. Table rows are blocks; cells are not.
**Consequences:** no section identity problem; parser-aligned storage; `under()`/section ops compile to range checks.

## ADR-006 — Relational graph; no graph database; no graph query language
**Status:** proposed
**Decision:** Edges live in interval-valid relational tables; traversal = frontier expansion/recursive CTE with budgets (depth cap 8). There is no separate graph query language (no Cypher/Gremlin): the traversal surface is the OQX `follow` operator on the one `query` surface (see 05 §3, 10). Inferred edges quarantined in a separate table, opt-in at query time.
**Consequences:** one store for graph+content+FTS+vectors; no Cypher injection/unbounded-query surface. (The originally-specified `graph_subgraph` analytics export was dropped with no replacement.)
**Update (provenance — superseded pre-OQX API):** the original Decision specified structured JSON traversal specs (`graph_traverse`/`graph_path`/`graph_subgraph`) as the public API. These were removed in favor of OQX `follow` (now folded into the Decision above), and `graph_subgraph` was dropped with no replacement. The "no graph query language / bounded traversal" principle is unchanged; only the surface moved.

## ADR-007 — Splice rendering; block-level raw retention; no CST engine
**Status:** proposed
**Decision:** Blocks retain exact raw bytes; rendering splices retained bytes for untouched blocks and op-supplied text for changed ones; trivia trailing-attaches; unknown syntax is opaque and byte-preserved. No remark-stringify for existing content; no tree-sitter/rowan machinery.
**Consequences:** byte-stable round trips at save granularity; minimal-diff renders; typed edits refused on opaque blocks (raw replace allowed).

## ADR-008 — Single-writer engine; OCC; no CRDT/OT
**Status:** proposed
**Decision:** The engine serializes all commits per repo. Concurrency is optimistic: content-hash CAS on updates, existence checks, opt-in order CAS; typed conflicts carry current truth; file-level hash CAS + ingest-and-replay handles the human/agent race.
**Consequences:** radical simplicity; correct behavior for all six torture scenarios; real-time co-editing is out of scope (Git remains the human sync layer).

## ADR-009 — RRF hybrid retrieval; content-keyed block embeddings; no learned ranker
**Status:** proposed
**Decision:** Rank fusion (RRF) over FTS5 + vectors, explainable boosts (title/heading/path/layer/recency), evidence returned per hit. Embeddings at block grain with context prefix, keyed `(content_hash, ctx_hash, model)`, async worker, explicit egress config.
**Consequences:** no score-calibration coupling; cache immune to identity errors; ranking debuggable by inspection.

## ADR-010 — Multi-engine identity is a non-goal
**Status:** proposed
**Decision:** One engine per repo is the supported topology. Two engines watching Git-synced clones will mint different block IDs; this is documented, not "fixed". If cross-engine identity is ever required, solve it then (identity-exchange protocol or `.omgbase/` sidecar manifest) with real requirements in hand.
**Consequences:** no premature distributed-identity machinery; the promise "block IDs are portable" is explicitly not made.

## ADR-011 — Projected queries: deferred, stratified, virtual-first; v1 reserves the seams
**Status:** proposed
**Context:** Embedded queries in fenced blocks whose results act as materialized data (queryable by other queries, traversals, agents) — Dataview ergonomics with dbt/materialized-view semantics. High value (dynamic set membership, self-building hubs, live rollups); classic risks (cycles, geometric explosion, autonomous file writes).
**Decision:** Defer the feature past Stage 5 (the full design is preserved in git history — the former `09-projected-queries.md`): provenance class `projected` (distinct from `inferred` — deterministic given sources); deterministic derived IDs (`v_`, no minting, no matcher); non-recursive stratified composition (reads only strictly-lower strata; conservative dependency over-approximation; cycles refused with `circular_projection`; `max_stratum` default 2); mandatory limits + per-repo fact budget with explicit truncation; async stratum-ordered refresh with staleness flags; additive-only (never mutates authored facts); no LLM calls in query blocks (determinism is load-bearing); virtual-first, file materialization a later opt-in via origin `projection` commits with matcher-skipped `attrs.generated` regions and `on_human_edit: detach`. **As-built, v1 has landed only the schema-enum reservations that keep the seams open:** `commits.origin` admits `'projection'` and `edges.provenance` admits `'projected'` (`core/store/schema.ts`), and the `v` id prefix is reserved in the minter's `IdPrefix` union (`core/ids.ts`). Authored ` ```omg ` fence blocks round-trip inert and are previewable read-only via `omg run` (`cli/src/cmd/run.ts`), which evaluates the fence as an OQX source and prints results without projecting or writing anything. Everything else the design names — the `attrs.generated` matcher-skip guard, an evaluator fact-source seam, the `projections.*` config namespace, and all materialization/refresh machinery — is **not** built.
**Consequences:** files authored with query blocks are valid and round-trip from v1 day one; no v1 architecture forecloses the feature; the explosive/recursive variants are refused by construction, not by vigilance; stored-query collections (05-… §8) later unify onto the same evaluator.

## ADR-012 — CLI: embedded second client, daemonless by default
**Status:** proposed
**Context:** All engine stages are complete but the surface is library + MCP only; humans, scripts, and shell-first agents need a terminal client. The docs already reserve the `omg` binary name (`data-model.md` §6). The tempting alternative — a mandatory daemon with an IPC protocol — buys nothing at the scale envelope and adds a lifecycle and a protocol.
**Decision:** Ship an `omg` CLI as the engine's **second client**: every command opens the embedded store directly and exits; no business logic in the CLI (design: `cli.md`). Long-lived processes are explicit (`omg watch`, `omg mcp` on stdio, with `mcp` running an in-process watcher by default). The in-process writer lock generalizes to an advisory flock (`.omgbase/writer.lock`); watcher liveness is a flock probe (`.omgbase/watch.lock`). Reads are fresh by default via a stat-prefiltered sweep backed by a new derived `file_stats` table; `--stale` opts out. Output contract: stdout is data (human columns / `--json` = library shapes verbatim / `--jsonl` / `--ids`), diagnostics and loud truncation footers on stderr, typed errors with current truth. Mutation sugar expands to `apply` changesets; multi-doc rewrites (`retarget`, `import`) are plan-by-default. No new runtime dependencies (`node:util` parseArgs).
**Consequences:** zero-ops CLI consistent with the local-first stance; correct concurrency with a running watcher/MCP session via flock + hash-based echo suppression; the library grows any behavior a command needs (keeping the MCP surface honest too); a future server mode (`omg serve`) is additive and deferred to the multi-user trigger in ADR-001.

## ADR-013 — OQX is the external `@omgbase/oqx` library; adopt its semantics contract
**Status:** proposed
**Context:** OQX was implemented twice: in-tree (`packages/core/src/oqx/`, a query-string → IR → single-SQLite-statement compiler bound to the docs/blocks/nodes/edges model and the `search/cel` scalar layer) and as the standalone `@omgbase/oqx` (oqx-js) package (a 3-tier evaluator — in-memory engine → `DataContext` seam → `PlannedEngine`/`QueryPlanner` pushdown with a SQLite adapter and in-memory residual fallback — governed by its own `oqx.semantics` contract). The two have diverged in scalar semantics (CEL vs oqx-js) and architecture. Maintaining both fights the goal of one authoritative OQX. There are no active users, so a query-language behavior change is acceptable if it is not ergonomically worse.
**Decision:** omgbase depends on `@omgbase/oqx` as the single OQX implementation (parser + planner + semantics), and **adopts the oqx-js semantics contract** rather than re-implementing CEL's rules. omgbase supplies a Tier-3 **`DataContext` + SQLite adapter** that pushes its schema, structural relations (`doc.nodes`, `section.blocks` range-containment, `doc.out/in` edge graph, `repo.*`), and domain functions (`text()`/`semantic()`/`under_*`/`yaml_path`/…) down to the existing SQLite store. Behavior changes accepted vs the old CEL layer: `!=`/negation over an absent field now matches (classical negation of typed equality); string ops (`contains`/`startsWith`/`endsWith`) are case-sensitive, with `.lower()`/`.upper()` and a real regex `matches()` newly available; comparisons allow field-vs-field; `^` reads arbitrary N scopes; `order by` sorts absent last (ascending). Divergences are pushed **upstream** into oqx-js where they are the library's concern (notably the `sortScopes` `desc` null-ordering fix), keeping the two genuinely in sync rather than forked. The internal `packages/core/src/oqx/` compiler is removed once the corpus passes at parity against the new engine.
**Pushdown reservation:** the SQLite adapter's expression translator is **recursive and semantics-faithful**, not a syntactic predicate matcher — it translates method/function chains (`$path.lower().startsWith("lab/")` → `substr(lower(d.path),1,4) = ?`, **not** `LIKE`, because oqx-js string ops are case-sensitive while SQLite `LIKE` is not) as deep as it can, with a per-subexpression residual boundary for anything untranslatable. Domain functions register through the same hook. A **differential conformance suite** runs each corpus query both fully in-memory and pushed-down and asserts identical results + order; this is the guardrail that keeps SQL optimization from drifting from the semantics contract.
**Consequences:** one OQX, shared semantics with the standalone library; the query language is more capable (regex, case control, field-vs-field, multi-scope `^`) and, where it differs, more correct (case-sensitive paths, `!=`-includes-absent). Costs: `docs/query-language.md` §3.1–§3.3/§7/§8 and the `query`-tool description in `mcp/server.ts` are rewritten off the CEL basis; the OQX compiler unit tests are replaced by engine + adapter tests while the behavioral corpus (`corpus/oqx/`) is retained as the acceptance gate; omgbase now consumes a raw-`.ts`/ESM package (Node ≥22.6 type-stripping) — resolved upstream by publishing a build, or via a local transpile step. Supersedes the in-tree OQX engine; the `follow`/bounded-traversal and "no separate graph query language" principles of ADR-006 are unchanged (only the implementation moves).

---

## Cut list (authoritative — PRs adding these are rejected)

Persistent Section entities · BlockVersion as an entity · one generic edge table across tree/graph/lineage · inferring *operations* from file diffs · high-level ops as kernel primitives (macros only; split/merge excepted) · graph analytics suite · embedded/auto-injected IDs · engine-level contradiction detection · CRDT/OT · Cypher/Gremlin · full CST/incremental parsing core · per-cell table identity · learned rankers (v1) · real-time collaborative cursors.

## Experimental (flags, derived, disposable)

Scored cross-checkpoint resurrection · inferred `similar_to` edges · section/RAPTOR rollup embeddings · graph-aware reranking · Git-hash-anchored time travel · low-confidence review queue in `changes_since`.

## Open questions (need Brendan's call)

- [ ] Ratify ADR-001 stack (TypeScript/SQLite) or redirect (Rust core? align with mrplex's existing implementation language?).
- [ ] `split.dominant_share` default 0.70 with first-fragment inheritance — keep, raise, or disable (mint-always)?
- [ ] Adopt Dataview `key:: value` inline-field syntax as the authored block-grain typed-edge convention — or restrict typed edges to frontmatter in v1?
- [ ] Embedding provider + egress policy for work vaults (which provider may see block text?).
- [ ] Retention: keep-everything default confirmed? Any repos needing history pruning from day one?
- [ ] Naming ratification: kernel term **Node** (vs Entity); product spelling `omgbase` lowercase everywhere (matching mrplex convention)?
- [ ] MCP naming: keep mrplex-style `docs_*`/`nodes_*` snake_case tool names as specced?
- [ ] Projected queries (ADR-011): ratify strata cap default (2), virtual-first sequencing, and the ref-projections-excluded-by-default query semantics.
- [ ] CLI (ADR-012): ratify the embedded/daemonless shape and the `omg` command catalog in `cli.md` (notably: freshness-sweep-by-default, interactive CAS auto-pinning, `mcp` running a watcher by default).
