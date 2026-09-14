# omgbase — Design & Planning Documents

**omgbase** (Open Markdown Graph Base) is the successor to mrplex: a versioned, addressable graph of authored Markdown structure. Ordinary Markdown files stay the human representation — usable by editors, Obsidian, Git, and shell tools — while the engine adds stable block identity, block-grain history, a typed knowledge graph, hybrid retrieval, and a safe structural mutation API built for autonomous agents.

These documents are maintained as **as-built** references to the implementation (last verified 2026-09-14). They descend from the architecture review of 2026-09-02 (Claude artifact: *omgbase Architecture Review*), but where a doc and the code disagree, the code is authoritative — fix the doc. See the repo-root `AGENTS.md` for orientation and where authoritative truth lives per surface.

## Doc map (read in this order)

| Doc | Contents | You need it when… |
|---|---|---|
| `architecture.md` | System shape, canonicality, kernel concepts, identity rules, all subsystem summaries | always — read first |
| `data-model.md` | ID/hash conventions, full SQLite DDL, canonical serializations, rebuild & GC rules | touching `core/` or any storage |
| `reconciliation-spec.md` | Parser contract, round-trip law, trivia policy, matcher phases/thresholds, eval harness, sync pipeline | touching `core/parse`, `reconcile/`, `sync/` |
| `mutation-and-concurrency.md` | Six-op kernel, changesets, CAS vocabulary, conflict objects, write protocol, deletion | touching `mutate/` |
| `graph-and-query.md` | Edge extraction rules, intervals, traversal specs, CEL query surface, RRF retrieval, embeddings | touching `graph/`, `search/` |
| `mcp-api.md` | Tool surface, resources/URIs, resolution ladder, error codes, outline format, acceptance traces | touching `mcp/` |
| `decisions.md` | ADRs (binding), the authoritative cut list, experiments, open questions | before proposing any deviation |
| `query-language.md` | OQX query language: the query-string surface, targets/fields, the CEL predicate subset (grammar, absence truth table, structural functions), ordering, compilation contract | touching `oqx/` or `search/` (the CEL compiler), or writing any filter in tests/fixtures |
| `cli.md` | The `omg` CLI: invocation model, embedded/daemonless process & concurrency model (writer flock, watch lease, freshness sweep), output contract, command catalog with MCP correspondence, acceptance traces | building or scripting the `omg` binary |
| `properties-table.md` | The properties table: one indexed row per property value; unified query surface for frontmatter/inline/computed document properties | touching `search/` property projection or the properties store |
| `sync-plugins.md` | External-source reconciliation: the stdio adapter protocol (handshake + enumerate/fetch/watch/write), identity inferred\|borne, `@omgbase/fs-adapter`, the `sha256`-vs-`file_hash` freshness gate. The adapter/source/attachment registry tables are reserved but not yet wired | touching `sync/`, the adapter protocol, or writing an adapter |
| `update-opsets.md` | Whole-document update: reconcile a proposed complete document into an explicit, serializable, self-verifying opset (kernel ops + identity dispositions + preconditions); `planUpdate`/`applyOpset`/`docsUpdate`, `docs_plan_update`/`docs_update`, `omg update` | touching whole-document update, the `mutate/` planner, or the move/trivia kernel extensions |

## Rules for implementation agents

1. **Invariants below are non-negotiable.** If a task appears to require violating one, stop and flag it — do not improvise.
2. **The cut list in `decisions.md` is authoritative.** Do not add cut items "while you're in there."
3. Rendering is **splice only** — `remark-stringify` (or any canonicalizing serializer) must never touch existing content. A lint rule enforces this; don't disable it.
4. `reconcile/` is deterministic: no clock, no RNG; every disposition stamps `matcher_v`.
5. New frontmatter conventions, predicates, or tool parameters require an ADR entry, not just code.
6. When these docs and code disagree, **the code wins** — update the doc to as-built (do not code to a stale doc).

## Invariants (testable; CI-enforced)

1. **Round-trip totality:** `render(parse(file)) == file` byte-identical; every byte owned by exactly one block's raw/trivia.
2. **Convergence:** at quiescence, `sha256(file) == current_revision.rendered_hash` for every tracked document.
3. **Identity:** minted once, never reused, never reassigned except by a recorded disposition (confidence, reason, matcher_v); a block_id appears at most once in the repo forest at any revision.
4. **Immutability:** blobs, tree nodes, revisions, commits, dispositions are append-only.
5. **Edges are content:** authored edges are a pure function of (revision content, extraction_version); inferred edges never share their table; provenance is mandatory.
6. **CAS honesty:** no update applies against a stale expected hash; every conflict response carries current truth.
7. **History honesty:** observed transitions are labeled inferred with confidence; only API commits carry intent.
8. **Rebuildability:** every derived store can be dropped and rebuilt from durable tables with zero information loss.

## Glossary

| Term | Meaning |
|---|---|
| **Node** | Any durable addressable thing: repository, document, block, collection, external entity |
| **Block** | A structural unit of a document (paragraph, heading, list item, …) with a minted `b_` ID |
| **Blob** | Content-addressed immutable bytes (a block's raw source) |
| **Revision** | One document's committed state: Merkle root + frontmatter + rendered hash (`r_`) |
| **Commit** | Atomic transaction across ≥1 documents; per-repo ordered; the change feed (`c_`) |
| **Placement** | A block's parent + fractional order key + document |
| **Disposition** | The engine's recorded belief about one block across an observed transition (kind, confidence, reason) |
| **Checkpoint** | One debounced batch of filesystem changes (`cp_`) |
| **Section** | Derived range from a heading block to its next peer — never a stored entity |
| **Locator** | Human-readable address (`path#Heading/p[2]`) — accepted as input, never authoritative |
| **Opaque block** | Unrecognized syntax preserved byte-perfectly; refuses typed edits |
| **Splice rendering** | Emitting untouched blocks' retained bytes verbatim; only changed blocks serialize anew |
| **Resurrection pool** | Recently deleted blocks kept for cross-checkpoint move detection |
| **RRF** | Reciprocal-rank fusion of lexical + vector rankings |

## Provenance

Authored 2026-09-02 from the omgbase architecture review session (see the review artifact for full rationale, alternatives considered, and prior art). Decision authority: Brendan Baldwin. ADR statuses start `proposed`; ratification flips them to `accepted`.
