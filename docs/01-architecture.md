# omgbase — Architecture

**Status:** normative design. Deviations require an ADR (see `08-decisions.md`).
**Audience:** implementation agents and reviewers. Read `README.md` first for the doc map and glossary.

omgbase (Open Markdown Graph Base) is a versioned, addressable graph of authored Markdown structure. Ordinary Markdown files remain the human representation and interchange format; the engine adds stable identity, block-level history, a typed knowledge graph, hybrid retrieval, and a safe structural mutation API for agents.

The key words MUST, MUST NOT, SHOULD, and MAY are used in the RFC-2119 sense.

---

## 1. System shape

omgbase is a **single-writer engine process** that sits beside one or more Markdown working trees ("repos"). It:

- watches the filesystem and ingests human edits (observation path),
- applies structural mutations from agents/API clients (intent path),
- serializes **all** state changes through one append-only commit log per repo,
- maintains derived indexes (lexical, vector, graph, sections, projections),
- serves an MCP/API surface.

```
                    ┌──────────────────────┐
   editor / git ──▶ │   repo/*.md files    │ ◀── render (splice, atomic, hash-CAS)
                    └─────────┬────────────┘                        ▲
                              │ save events                         │
                              ▼                                     │
                    ┌──────────────┐   old tree + new bytes   ┌─────┴──────────┐
                    │   watcher    │ ───────────────────────▶ │ mutation kernel │ ◀── apply(changeset)
                    │ (checkpoints)│                          │  (CAS + 6 ops)  │      from MCP clients
                    └──────┬───────┘                          └─────┬───────────┘
                           ▼                                        │
                    ┌──────────────┐  dispositions (observed)       │ operations (intent)
                    │  reconciler  │ ───────────────┐   ┌───────────┘
                    └──────────────┘                ▼   ▼
                                            ┌───────────────────┐
                                            │  commit log       │  append-only, repo-ordered
                                            │  → revisions      │
                                            │  → dispositions   │
                                            │  → edges/indexes  │
                                            └───────────────────┘
```

There are **no engine replicas** in v1. Git is the humans' distributed layer; the engine is the agents' collaboration point. Multi-engine identity agreement is an explicit non-goal (ADR-010).

## 2. Canonicality (the consistency model)

Three categories of fact, each with exactly one owner:

| Category | Owner | On disagreement |
|---|---|---|
| Content bytes (what documents say now) | **The files** | File wins, always. Engine ingests and records a new revision. |
| Identity, history, lineage, provenance of transitions | **The engine database** | No conflict possible — files cannot express these facts. |
| Derived data (FTS, vectors, edges, sections, projections) | Nobody — pure functions | Rebuild from content + identity. |

Invariants (testable; the full list is in `README.md` §Invariants):

- **Convergence:** at quiescence, `sha256(file) == current_revision.rendered_hash` for every tracked document.
- **Round-trip totality:** `render(parse(file)) == file` byte-identical when no ops are applied.

API mutations are writes **to the file through the engine** (apply ops → render → atomic write → record revision as synced). Human edits are writes **around the engine** (observe → parse → reconcile → record revision). One commit log; two ingestion paths; one definition of current state.

### 2.1 The write-write race

Before writing a file, the engine MUST verify the file's current hash equals the rendered hash of the revision the mutation was computed against. On mismatch: abort, ingest the human edit (new revision), **replay** the block ops against the new revision (block preconditions re-checked), and only then write. One automatic replay attempt; after that, return a typed conflict to the caller. Protocol details: `04-mutation-and-concurrency.md` §6.

## 3. Kernel concepts

Seven concepts. Five durable, two derived. Concepts are not tables — see `02-data-model.md` for physical schema.

| Concept | Definition | Mutability |
|---|---|---|
| **Node** | A durable addressable thing: repository, document, block, collection, external entity. Minted opaque ID + kind. | Identity immutable; current state mutable |
| **Blob** | Content-addressed immutable bytes (a block's raw Markdown source; a frontmatter text). | Immutable |
| **Revision** | One document's state at a point in history: root of a Merkle tree of `(block_id, blob_hash, …)` entries + frontmatter blob + rendered-file hash. Linear chain per document. | Immutable, append-only |
| **Commit** | The atomic transaction: ≥1 revisions across documents + origin (`api` or `observed`) + actor + operations/dispositions. Totally ordered per repo. The commit log **is** the change feed. | Immutable, append-only |
| **Placement** | Where a block sits: parent block, order key, containing document. Versioned implicitly via revisions; current state materialized. | Mutable via commits |
| **Edge** | Typed relationship between nodes, originating from a block (or frontmatter field), with provenance and a commit-time validity interval. | Append-only, interval-closed |
| **Index** | Derived acceleration: FTS, vectors, section ranges, doc-level edge rollups, block-history projection. | Disposable, rebuildable |

### 3.1 Identity

- IDs are **minted, opaque, repo-scoped**: `d_` documents, `b_` blocks, `c_` commits, `r_` revisions, `x_` external nodes, `col_` collections; 7 chars of lowercase Crockford base32 from a CSPRNG; collision-checked at mint (retry). Example: `b_k7z2p9q`.
- Content hashes (sha256) are **version/CAS keys**, never identity.
- Human-readable **locators** (`projects/foo.md#Risks/p[2]`) are display duals and accepted as input anywhere an ID is; they are never authoritative.
- Block identity is scoped to the **repository**, not the document: containment is a versioned property, so cross-document moves preserve identity.
- IDs are NEVER written into Markdown files. Human-authored anchors (Obsidian `^block-ref`, heading anchors) are respected as reconciliation evidence and as public locators when present, but the engine MUST NOT inject markers. (ADR-002.)

**The load-path rule (the most important sentence in this document):** block identity may only answer *"is this the same block over time?"* — it carries history and lineage. Everything operational — edges, search indexes, embeddings, rendered content, CAS safety — MUST be derived from the **current parsed content**, never inherited through identity. A reconciliation error may therefore corrupt a biography, never the graph, never a search result, never a write target. (ADR-003 corollary.)

### 3.2 Tree shape: flat containment, derived sections

- The persistent containment tree is the **flat CommonMark structure**: headings are leaves, siblings of the content that follows them. Lists, list items, blockquotes, and tables nest as the parser nests them.
- **Sections are derived, not persistent** (ADR-005): a per-revision index of `(heading_block, first_ordinal, last_ordinal, depth)`. A section is addressed by its heading block's ID plus `scope: "section"`. A section inherits its heading block's identity — the only identity a human would assert anyway.
- **Table rows are blocks; table cells are not.** Cell identity has no consumer and is out of scope permanently.
- Unrecognized/extension syntax parses as **opaque blocks**: preserved byte-perfectly, addressable, raw-replaceable, but refusing typed structural edits (error `opaque_block`).

### 3.3 Block types

`heading`, `paragraph`, `list`, `list_item`, `task` (a list_item with GFM checkbox; `attrs.checked`), `blockquote`, `code_fence` (`attrs.lang`, `attrs.info`), `table`, `table_row`, `thematic_break`, `html_block`, `frontmatter` (exactly one, first child of document when present), `opaque`. Inline constructs (links, images, emphasis) are NOT blocks; they are content of blocks, surfaced through edge extraction and inline metadata.

## 4. Versions and history

- **BlockVersion is not an entity.** A block's state at a revision is the pair `(block_id → blob_hash, placement)` in that revision's tree. Block history is a derived projection (`block_changes`).
- Revisions use **structural sharing** (git-style): unchanged subtrees and blobs are referenced by hash, not copied. Editing one paragraph costs one blob + one root path of tree nodes + one revision row + one commit row.
- The commit's `origin` determines the legal history claim:
  - `api` commits record **operations** — real intent, with actor and reason. Replayable.
  - `observed` commits record **dispositions** — beliefs about correspondence, each with `kind`, `confidence`, `reason`, and `matcher_version`.
- Dispositions are immutable. A better future matcher MUST NOT rewrite past dispositions.
- Event sourcing is rejected as the storage model (ADR-003): the snapshot chain is the source of truth; the commit log is the change feed — an output of committed state.

Disposition kinds: `same`, `edited`, `moved`, `edited_moved`, `inserted`, `deleted`, `split_from`, `merged_into`, `copied_from`, `resurrected`, plus document-scoped `bulk_rewrite`.

## 5. Reconciliation (summary; full spec in `03-reconciliation-spec.md`)

GumTree-class matching adapted to prose, in phases of strictly decreasing certainty: exact raw-hash lock → normalized-hash lock → context propagation (locked neighbors/parents vouch for strangers) → order-constrained scored assignment → compound classification (split / merge / copy / cross-doc move / resurrection). Asymmetric thresholds: **when in doubt, mint a new ID** and record the near-miss. Every carried identity records `confidence`, `reason`, `matcher_version`. Deliberate give-ups: bulk rewrites, tiny blocks, many-to-many ambiguity.

## 6. Filesystem sync (summary; protocol in `04-…` §6, pipeline in `03-…` §8)

- Watcher batches save events into **checkpoints** at quiescence (default 750ms silence; config `sync.quiescence_ms`). Reconciliation runs old-revision → newest-bytes once per checkpoint.
- Engine writes are **echo-suppressed**: the watcher sees the engine's own write, matches the expected hash, and records a no-op.
- Git operations are planned for: checkouts arrive as one large checkpoint (hash-locking makes them cheap); conflict-marker files parse as opaque and flag the document `conflicted` (structural mutations refused until clean); whole-file hash match ⇒ document rename/move; `git diff --find-renames` MAY be consulted as a hint, never an authority; `.omgbase/` MUST be gitignored.

## 7. Rendering: splice, never stringify

Every block retains its **exact raw source bytes** (and span) from parse time. Rendering a revision = splicing: untouched blocks emit retained bytes verbatim; inserted/updated blocks emit their new text; inter-block trivia (blank lines, HTML comments) attaches to a neighboring block by fixed policy (trailing-attach; spec in `03-…` §2.3) and survives with it. The renderer MUST NOT re-serialize untouched content from the AST. `remark-stringify` (or any canonicalizing serializer) MUST NOT be used for existing content.

## 8. Graph (summary; full spec in `05-graph-and-query.md`)

- Authored edges are **extracted fresh from parsed content at every revision** — a pure function of `(content, extraction_version)`. Identity threads their history (validity intervals), never their existence.
- Edge sources: Markdown links/wikilinks (block-grain `references`), frontmatter relation fields (doc-grain, field recorded), Dataview-style inline fields `key:: [[target]]` (block-grain typed edges), bare URLs (external nodes).
- Structural relations are NOT edges; they live in Placement and are presented as traversable steps by the API.
- Inferred edges (`similar_to`, …) live in a **separate table** with mandatory `method`, `score`, `model_version`; excluded from all queries/traversals unless explicitly requested.
- Edges are interval-valid: `(from_commit, to_commit?)` — temporal graph queries are WHERE clauses.
- Doc-level edges are a materialized rollup: `GROUP BY (src_doc, predicate, dst)` with count + sample source blocks.
- Storage: relational + recursive CTEs. **No graph database. No Cypher/Gremlin.** (ADR-006.)

## 9. Query & retrieval (summary; full spec in `05-graph-and-query.md`)

- CEL filters over two targets: `docs` and `blocks` (block filters may reach doc frontmatter via `doc.`). Structural functions (`under()`, `under_heading()`, `within()`, `has_edge()`, …) compile to indexed lookups.
- Hybrid retrieval: FTS5 + vectors fused by **reciprocal-rank fusion**, then explainable multiplicative boosts (title/heading/path match, epistemic layer, recency). Every hit returns its evidence.
- Embeddings attach to blocks: input = `doc title · path · heading chain · block type` + block text; key = `(content_hash, ctx_hash, model)`; async recompute.
- The `pipeline` call composes seed → expand → hydrate in one round trip.

## 10. Mutation & concurrency (summary; full spec in `04-mutation-and-concurrency.md`)

- Kernel of six ops: `insert`, `update`, `move`, `remove`, `split`, `merge` — over contiguous sibling runs, in atomic cross-document **changesets** with per-op expectations (content-hash CAS on update; existence checks; opt-in order CAS).
- Everything else is a **server-side macro** (`tasks_complete`, `sections_append`, `links_retarget`, …) expanding deterministically to kernel ops, reported in kernel vocabulary.
- Plain OCC; no CRDTs, no OT (ADR-008). Conflicts are typed objects that **carry current truth** (live hash, live markdown, live revision, invalidating commit) so agents retry without a read.
- `dry_run: true` validates and returns rendered diffs without committing.

## 11. MCP surface (summary; full spec in `06-mcp-api.md`)

Small tool set, capability via parameters: `docs_outline`, `nodes_get(_many)`, `resolve`, `query` (OQX — traversal is the `follow` operator), `pipeline`, `changes_since`, `history_node`, `diff`, `apply` + macro tools, `repos_*`, `sync_status/flush`. Uniform `resolution: skeleton|outline|text|raw|full` and `budget_tokens` on every reader. Every list result carries `truncated` + cursor. URIs: `omg://<repo>/doc/<id>[@rev]`, `omg://<repo>/block/<id>[@rev]`, `omg://<repo>/path/<filepath>`.

## 12. Storage (summary; DDL in `02-data-model.md`)

v1 embeds **SQLite** (WAL) under `.omgbase/` — FTS5 lexical, sqlite-vec vectors, recursive CTE traversal. PostgreSQL (+pgvector) is the same logical schema behind a dialect layer, adopted only when a genuinely multi-user server exists (ADR-001). Keep the SQL boring enough that both stay true.

## 13. Scale envelope & non-goals

Design targets: ≤ 10⁴ documents, ≤ 10⁶ blocks, ≤ 10⁷ edges per repo; traversal depth ≤ 6; single engine host. Within this envelope, simplicity wins every tie.

Non-goals (v1, some permanent): multi-engine replication and portable block IDs; real-time collaborative editing; CRDT/OT merge; graph analytics suite; learned rankers; per-cell table identity; contradiction detection in the engine; embedded ID write-back.
