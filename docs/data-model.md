# omgbase — Data Model & Storage Schema

**Status:** normative. SQLite dialect (v1). Column types use SQLite affinities; a future Postgres dialect maps 1:1 (ADR-001).
**Depends on:** `architecture.md` §3–4, §12.

> **As-built (verified 2026-09-26).** This DDL mirrors `packages/core/src/core/store/schema.ts` (`SCHEMA_VERSION = 13`; v13 dropped `repos.root_path` — a repo's filesystem binding is now an attached `fs` source), which remains the authoritative schema and is kept byte-identical to `spec/store/schema.sql`. The store is specified language-neutrally in `spec/store/README.md` (table meanings, canonical encodings, the observe/commit procedure as an exact rule, the invariants, the fixture contract, and the reference oddities the Rust port surfaced) with fixtures under `spec/store/cases`; the Rust crate `crates/omgbase-store` opens the same database and passes the same fixtures. Where this document and the spec differ in detail, the spec (and its fixtures) win.

---

## 1. Identifier and hash conventions

| Kind | Prefix | Format | Example |
|---|---|---|---|
| Document | `d_` | prefix + 7 chars lowercase Crockford base32 (CSPRNG) | `d_7f31k2m` |
| Block | `b_` | same | `b_k7z2p9q` |
| Commit | `c_` | same | `c_812acfd` |
| Revision | `r_` | same | `r_90ttx4e` |
| External node | `x_` | same | `x_3fq0d8n` |
| Collection | `col_` | same | `col_9a2mmvc` |
| Checkpoint | `cp_` | same | `cp_207bb1e` |
| Edge | `e_` | same | `e_5m1q0zt` |
| Repo | `rp_` | same | `rp_a30f9kd` |
| Projection (reserved) | `v_` | same | `v_1c8bb0p` |

- IDs are repo-scoped, never reused, never re-assigned. As built, minting is not collision-checked (the 32⁷ space and the primary keys are relied on — `spec/store` §10); the store exposes a minter seam so conformance runners can install a sequential one.
- Content hashes are **sha256** stored as 32-byte BLOBs; displayed truncated to 16 hex chars. Two hash flavors per block:
  - `raw_hash` — sha256 of exact raw source bytes (blob key, splice identity).
  - `norm_hash` — sha256 of the block's visible text (`text`: block-level syntax stripped, whitespace collapsed — §5.2, `spec/format` §4.1) used by reconciliation phase 2. Stored on `blocks`, not on blobs.
- Tree-node hashes: sha256 over the canonical serialization of entries (see §3.4).

## 2. Database placement

One SQLite database per workspace at `<workspace>/.omgbase/omgbase.db` (WAL mode, `synchronous=NORMAL`, foreign keys ON). `.omgbase/` MUST be listed in the repo's `.gitignore` (`omg init` offers to append it to the closest `.gitignore` when the workspace is inside a git tree — `cli/src/cmd/bootstrap.ts`; never edits git config silently).

All writes go through a single serialized writer (one connection; short transactions — one transaction per commit). Readers use separate connections (WAL snapshots).

## 3. DDL — durable tables

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE repos (
  repo_id      TEXT PRIMARY KEY,          -- 'rp_' + base32
  slug         TEXT NOT NULL UNIQUE,
  settings     TEXT NOT NULL DEFAULT '{}' -- JSON: sync.quiescence_ms, matcher thresholds, embedding config…
);
-- A repo owns identity + history, NOT a filesystem (ADR-014). Where its bytes
-- come from is an attached `fs` source (sources.config.root via attachments); the
-- former root_path column was dropped in schema v13, and RepoRow.rootPath is now
-- DERIVED from that source (null = sourceless/headless).

CREATE TABLE docs (
  doc_id        TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(repo_id),
  path          TEXT NOT NULL,             -- repo-relative, canonical (no leading slash)
  format        TEXT NOT NULL DEFAULT 'markdown', -- adapter format: 'markdown', 'yaml', 'json', …
  current_rev   TEXT,                      -- REFERENCES revisions(rev_id) (nullable during create)
  file_hash     BLOB,                      -- sha256 of file bytes at last sync (convergence check)
  conflicted    INTEGER NOT NULL DEFAULT 0,-- git conflict markers present; mutations refused
  leading_trivia TEXT NOT NULL DEFAULT '', -- bytes before the first block (document-leading trivia; 03 §2.3)
  frontmatter_trivia TEXT,                 -- separator between frontmatter and first body block (NULL = no frontmatter)
  deleted_commit TEXT,                     -- tombstone; NULL = live
  UNIQUE (repo_id, path)
);
-- Adapter-extracted properties (frontmatter, inline key:: value, computed $title/$tags)
-- live in the separate `properties` table below, superseding the former docs.metadata JSON blob.

-- Current-state block table (the hot table; fully rebuildable from current revisions,
-- but maintained transactionally for query speed).
CREATE TABLE blocks (
  block_id      TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(repo_id),
  doc_id        TEXT NOT NULL REFERENCES docs(doc_id),
  parent_block  TEXT,                      -- NULL = top-level child of document
  order_key     TEXT NOT NULL,             -- fractional key; sorts lexicographically among siblings
  ordinal       INTEGER NOT NULL,          -- materialized position among siblings (rebuilt per commit)
  depth         INTEGER NOT NULL,
  ancestor_path TEXT NOT NULL,             -- '/b_a1/b_b2/' — containment ancestors, for subtree queries
  type          TEXT NOT NULL,             -- format-qualified block kind: 'heading', 'yaml:mapping_entry', 'json:property', …
  attrs         TEXT NOT NULL DEFAULT '{}',-- JSON typed attrs: checked, lang, level, info, alt…
  text          TEXT NOT NULL,             -- normalized visible text (query/FTS source)
  raw_hash      BLOB NOT NULL,             -- REFERENCES blobs(hash)
  norm_hash     BLOB NOT NULL,
  trivia_hash   BLOB,                      -- trailing-trivia blob hash (NULL = no trivia)
  created_commit TEXT NOT NULL,            -- the commit that last WROTE this row (rows are rebuilt per commit; a carried block does not keep its birth commit — spec/store §10)
  deleted_commit TEXT                      -- tombstone; NULL = live
);
CREATE INDEX idx_blocks_doc      ON blocks(doc_id, parent_block, order_key) WHERE deleted_commit IS NULL;
CREATE INDEX idx_blocks_type     ON blocks(repo_id, type)                   WHERE deleted_commit IS NULL;
CREATE INDEX idx_blocks_rawhash  ON blocks(raw_hash);
CREATE INDEX idx_blocks_ancestor ON blocks(doc_id, ancestor_path);

CREATE TABLE blobs (
  hash   BLOB PRIMARY KEY,                 -- sha256(raw bytes)
  bytes  BLOB NOT NULL,
  size   INTEGER NOT NULL
);

-- Merkle tree nodes. entries: canonical JSON array of
--   [block_id, raw_hash_hex, child_tree_hash_hex|null, type, attrs_json, trivia_ref|null]
CREATE TABLE tree_nodes (
  hash    BLOB PRIMARY KEY,                -- sha256(canonical entries serialization)
  entries TEXT NOT NULL
);

CREATE TABLE revisions (
  rev_id           TEXT PRIMARY KEY,
  doc_id           TEXT NOT NULL REFERENCES docs(doc_id),
  seq              INTEGER NOT NULL,       -- per-document, monotonically increasing
  root_tree        BLOB NOT NULL REFERENCES tree_nodes(hash),
  frontmatter_blob BLOB REFERENCES blobs(hash),  -- raw YAML text incl. fences; NULL if none
  rendered_hash    BLOB NOT NULL,          -- sha256 of the full rendered file bytes
  path             TEXT NOT NULL,          -- path at this revision (doc moves tracked here)
  commit_id        TEXT NOT NULL REFERENCES commits(commit_id),
  UNIQUE (doc_id, seq)
);

CREATE TABLE commits (
  commit_id     TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(repo_id),
  seq           INTEGER NOT NULL,          -- per-repo total order; the change feed cursor
  ts            TEXT NOT NULL,             -- ISO-8601 UTC
  origin        TEXT NOT NULL CHECK (origin IN ('api','observed','import','projection')),
                                             -- 'projection' reserved for projected queries (09-…); unused in v1
  actor         TEXT,                      -- 'agent:…' | 'human:…' | NULL for observed
  reason        TEXT,                      -- api commits: caller-supplied intent string
  checkpoint_id TEXT,                      -- observed commits: REFERENCES checkpoints(id)
  ops           TEXT,                      -- api commits: JSON array of kernel ops as applied
  UNIQUE (repo_id, seq)
);

CREATE TABLE dispositions (
  commit_id  TEXT NOT NULL REFERENCES commits(commit_id),
  block_id   TEXT NOT NULL,                -- not FK'd: may reference deleted blocks
  kind       TEXT NOT NULL CHECK (kind IN
             ('same','edited','moved','edited_moved','inserted','deleted',
              'split_from','merged_into','copied_from','resurrected','bulk_rewrite')),
  confidence REAL,                         -- NULL for api-origin certainty
  reason     TEXT,                         -- 'exact_hash'|'normalized_hash'|'context_unique'|'context_children'|'scored'|'anchor'|'tombstone'|'api'
  matcher_v  TEXT,                         -- e.g. 'm1.3'; NULL for api
  detail     TEXT NOT NULL DEFAULT '{}',   -- JSON: counterpart ids (split/merge/copy), scores, near-misses
  PRIMARY KEY (commit_id, block_id, kind)
);

-- Authored edges. Append-only; a row is "closed" by setting to_commit.
CREATE TABLE edges (
  edge_id     TEXT PRIMARY KEY,            -- 'e_' + base32
  repo_id     TEXT NOT NULL,
  src_doc     TEXT NOT NULL,
  src_block   TEXT,                        -- NULL ⇒ frontmatter-origin
  src_field   TEXT,                        -- frontmatter key or inline-field key; NULL for plain links
  predicate   TEXT NOT NULL,               -- 'references' | any authored predicate
  dst_kind    TEXT NOT NULL CHECK (dst_kind IN ('document','block','external','collection')),
  dst_node    TEXT NOT NULL,               -- node id; external nodes minted per normalized URI
  anchor      TEXT,                        -- link anchor/fragment text if present
  provenance  TEXT NOT NULL CHECK (provenance IN ('link','frontmatter','inline_field','projected',
               'yaml_ref','yaml_schema','yaml_extends','json_ref','json_schema')),
                                           -- 'projected' reserved for projected queries (09-…); unused in v1
  via_node    TEXT,                        -- NULL for authored edges; query block id for projected (reserved, v1-unused)
  from_commit TEXT NOT NULL,
  to_commit   TEXT                         -- NULL = currently asserted
);
CREATE INDEX idx_edges_src ON edges(src_doc, predicate) WHERE to_commit IS NULL;
CREATE INDEX idx_edges_dst ON edges(dst_node, predicate) WHERE to_commit IS NULL;
CREATE INDEX idx_edges_temporal ON edges(from_commit, to_commit);

CREATE TABLE external_nodes (
  node_id   TEXT PRIMARY KEY,              -- 'x_' + base32
  repo_id   TEXT NOT NULL,
  uri       TEXT NOT NULL,                 -- normalized (lowercase scheme/host, no default port, no fragment)
  title     TEXT,
  UNIQUE (repo_id, uri)
);

CREATE TABLE collections (
  node_id  TEXT PRIMARY KEY,               -- 'col_' + base32
  repo_id  TEXT NOT NULL,
  name     TEXT NOT NULL,
  spec     TEXT NOT NULL DEFAULT '{}'      -- JSON: explicit member list and/or a stored query
);

CREATE TABLE checkpoints (
  id        TEXT PRIMARY KEY,              -- 'cp_' + base32
  repo_id   TEXT NOT NULL,
  ts        TEXT NOT NULL,
  files     TEXT NOT NULL,                 -- JSON [(path, old_hash|null, new_hash|null)]
  git_head  TEXT                           -- commit sha if the tree is a git repo
);

CREATE TABLE resurrection_pool (
  block_id       TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  doc_id         TEXT NOT NULL,            -- document it was deleted from
  raw_hash       BLOB NOT NULL,
  norm_hash      BLOB NOT NULL,
  type           TEXT NOT NULL,
  deleted_commit TEXT NOT NULL,
  expires_ts     TEXT NOT NULL             -- default now + 30 days (config)
);

-- Property index (properties-table). One row per property value; the unified
-- query surface for frontmatter, inline (key:: value), and computed ($title/$tags)
-- document properties, superseding the former docs.metadata blob. Current-state,
-- maintained transactionally at ingest alongside blocks (repopulated by re-ingest,
-- NOT by rebuild-index — see docs/properties-table.md §6), hence durable rather than derived.
CREATE TABLE properties (
  prop_id        TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  doc_id         TEXT NOT NULL,
  block_id       TEXT,                     -- NULL = document-scoped (frontmatter, computed)
  source         TEXT NOT NULL CHECK (source IN ('frontmatter','inline','computed')),
  key            TEXT NOT NULL,            -- dotted, flattened: 'layer','meta.owner'; computed carry '$title'
  card           TEXT NOT NULL CHECK (card IN ('scalar','list')), -- authored shape (scalar ==/</> vs list())
  ord            INTEGER NOT NULL DEFAULT 0,
  val_text       TEXT,
  val_num        REAL,
  val_bool       INTEGER,
  val_json       TEXT,
  type           TEXT NOT NULL CHECK (type IN ('string','number','bool','null','json')),
  created_commit TEXT NOT NULL,
  deleted_commit TEXT
);
CREATE INDEX idx_props_doc      ON properties(doc_id)                 WHERE deleted_commit IS NULL;
CREATE INDEX idx_props_key_text ON properties(repo_id, key, val_text) WHERE deleted_commit IS NULL;
CREATE INDEX idx_props_key_num  ON properties(repo_id, key, val_num)  WHERE deleted_commit IS NULL;
CREATE INDEX idx_props_src_key  ON properties(repo_id, source, key)   WHERE deleted_commit IS NULL;

-- Sync adapters/sources/attachments (sync-plugins §2). Workspace-level registry:
-- adapters map a name → external command; sources name an adapter + config; attachments
-- join repo ⇄ source (m:n). sync_state holds engine-owned per-attachment change tracking.
CREATE TABLE adapters (
  name    TEXT PRIMARY KEY,                -- workspace-unique adapter name (e.g. 'fs')
  command TEXT NOT NULL,                   -- argv[0] to spawn (e.g. 'omgbase-fs-adapter')
  args    TEXT NOT NULL DEFAULT '[]'       -- fixed leading args (JSON string[])
);

CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,          -- workspace-unique source name
  adapter   TEXT NOT NULL REFERENCES adapters(name),
  config    TEXT NOT NULL DEFAULT '{}',    -- JSON object → rendered to flags (13 §3.1)
  env       TEXT NOT NULL DEFAULT '{}'     -- JSON object → spawn env (secrets; 13 §3.2)
);

CREATE TABLE attachments (
  repo_id   TEXT NOT NULL REFERENCES repos(repo_id),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  PRIMARY KEY (repo_id, source_id)
);

CREATE TABLE sync_state (
  repo_id   TEXT NOT NULL,
  source_id TEXT NOT NULL,
  path      TEXT NOT NULL,                 -- '' reserved for the attachment-level cursor row
  revision  TEXT,                          -- last-observed source revision for this path
  cursor    TEXT,                          -- last poll/webhook cursor (attachment-level row)
  PRIMARY KEY (repo_id, source_id, path)
);

-- Workspace-default settings (config scope). Singleton row (id = 0) holding a JSON
-- blob with the SAME shape as repos.settings; a repo's own settings deep-merge on top.
CREATE TABLE workspace_settings (
  id       INTEGER PRIMARY KEY CHECK (id = 0),
  settings TEXT NOT NULL DEFAULT '{}'
);
```

## 4. DDL — derived tables (rebuildable; dropping them loses nothing)

```sql
-- Section ranges, rebuilt per affected document at each commit.
CREATE TABLE sections (
  heading_block TEXT NOT NULL,
  doc_id        TEXT NOT NULL,
  level         INTEGER NOT NULL,          -- heading level 1..6
  first_ordinal INTEGER NOT NULL,          -- first top-level ordinal covered (heading itself)
  last_ordinal  INTEGER NOT NULL,          -- last ordinal before next peer/higher heading
  PRIMARY KEY (doc_id, heading_block)
);

-- Doc-level edge rollup, maintained in the commit transaction.
CREATE TABLE doc_edges (
  src_doc   TEXT NOT NULL,
  predicate TEXT NOT NULL,
  dst_node  TEXT NOT NULL,
  dst_kind  TEXT NOT NULL,
  count     INTEGER NOT NULL,
  samples   TEXT NOT NULL,                 -- JSON: up to 3 src_block ids
  PRIMARY KEY (src_doc, predicate, dst_node)
);

-- Per-block history projection (answers history_node cheaply).
CREATE TABLE block_changes (
  block_id  TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  PRIMARY KEY (block_id, commit_id, kind)
);

-- Inferred edges: physically separate from authored edges. Never mixed by default.
CREATE TABLE inferred_edges (
  src_node   TEXT NOT NULL,
  dst_node   TEXT NOT NULL,
  predicate  TEXT NOT NULL,                -- 'similar_to' | 'co_occurs_with' | …
  method     TEXT NOT NULL,
  score      REAL NOT NULL,
  model_v    TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (src_node, dst_node, predicate, method)
);

-- Block-embedding cache, keyed by content so identity errors cannot poison it.
CREATE TABLE embeddings (
  content_hash BLOB NOT NULL,              -- block raw_hash
  ctx_hash     BLOB NOT NULL,              -- sha256 of the context prefix string
  model        TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  vec          BLOB NOT NULL,              -- float32 array
  PRIMARY KEY (content_hash, ctx_hash, model)
);

-- Doc-grain embedding cache (one vector per document, for `from=docs semantic`).
-- input_hash is the freshness key: sha256 of the exact bytes that produced the
-- vector; a row whose input_hash no longer matches the current doc is re-embedded.
-- method: 'whole' = whole-document embed; 'pooled' = token-weighted mean of block
-- vectors, used only when the embed input exceeds the provider's max input length.
CREATE TABLE doc_embeddings (
  doc_id     TEXT NOT NULL,
  model      TEXT NOT NULL,
  input_hash BLOB NOT NULL,
  method     TEXT NOT NULL CHECK (method IN ('whole','pooled')),
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,                -- float32 array
  PRIMARY KEY (doc_id, model)
);

-- FTS5 external-content index over current block text.
CREATE VIRTUAL TABLE blocks_fts USING fts5(
  text, content='blocks', content_rowid='rowid', tokenize='porter unicode61'
);
-- Maintained by triggers or explicit sync in the commit transaction.

-- Projected semantic nodes from format adapters. Derived from block content
-- at ingest time; deterministic hash-based identity. Queryable via from:"nodes".
CREATE TABLE nodes (
  node_id    TEXT PRIMARY KEY,             -- deterministic: hash(doc_id, block_id, kind, ordinal)
  repo_id    TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  block_id   TEXT,                         -- anchor block (NULL for doc-level nodes)
  kind       TEXT NOT NULL,                -- format-qualified: 'md:link', 'yaml:ref', 'json:schema'
  name       TEXT,                         -- identifier/key name
  value      TEXT,                         -- scalar value or target
  span_start INTEGER,                      -- UTF-8 byte offset within the block raw (spec/graph §2.3)
  span_end   INTEGER,
  attrs      TEXT NOT NULL DEFAULT '{}'    -- JSON format-specific properties
);
CREATE INDEX idx_nodes_doc  ON nodes(doc_id);
CREATE INDEX idx_nodes_kind ON nodes(kind);
CREATE INDEX idx_nodes_name ON nodes(name) WHERE name IS NOT NULL;

CREATE VIRTUAL TABLE nodes_fts USING fts5(
  name, value, content='nodes', content_rowid='rowid', tokenize='porter unicode61'
);

-- Filesystem stat cache backing the CLI freshness sweep (11 §3.3). Lets a
-- one-shot command detect out-of-band edits cheaply: compare (mtime_ns, size)
-- per file and only hash/ingest the candidates that changed. Rebuildable by a
-- full re-stat; the durable convergence signal remains docs.file_hash.
CREATE TABLE file_stats (
  repo_id  TEXT NOT NULL,
  path     TEXT NOT NULL,
  mtime_ns INTEGER NOT NULL,                -- fs.stat bigint mtimeNs
  size     INTEGER NOT NULL,
  hash     BLOB NOT NULL,                   -- sha256 of file bytes at last ingest/engine write
  PRIMARY KEY (repo_id, path)
);

-- Vector search (v1) is brute-force cosine over the `embeddings`/`doc_embeddings`
-- caches (Float32 BLOBs) joined to current blocks/docs — see search/vector.ts.
-- Acceptable to ~10^5 vectors; there is NO vec0/sqlite-vec virtual table (that
-- extension, or pgvector, is the future pressure valve, not built in v1).
```

## 5. Canonical serializations

### 5.1 Tree-node entries

Canonical JSON: array of arrays, UTF-8, no whitespace, keys in the fixed positional order `[block_id, raw_hash_hex, child_tree_hash_hex|null, type, attrs_canonical_json, trivia_hash_hex|null]`, attrs objects with lexicographically sorted keys. `hash = sha256(bytes)`. Any two structurally identical subtrees MUST produce identical hashes (structural sharing depends on it).

`trivia_hash_hex` references a blob holding the inter-block trivia attached to this block (trailing blank lines / comments), so splicing is fully reconstructable from the tree alone.

### 5.2 Normalized text (`norm_hash` input)

`text` is the block's **visible text**: every piece of block-level Markdown syntax removed, inline syntax kept, whitespace normalized. The authoritative rule is `spec/format/README.md` §4.1 (block model 0.2); in outline:

- Leaf blocks strip their kind's syntax from `raw`: ATX hashes or the setext underline; frontmatter and code fences; list marker + checkbox (`attrs.checked` records the state); table pipes; a thematic break has no text. Up to *q* blockquote `>` markers come off continuation lines, *q* = blockquote ancestors.
- Container blocks (list, blockquote, table, list item with children) have `text` = their children's `text` joined by one space.
- Then per line: trim (JS trim set), collapse `[ \t]+` to one space; drop blank lines; join with one space; NFC.
- Inline Markdown characters stay (emphasis markers count as content).

Every code path that recomputes `text` from stored blocks (ingest, reconcile flatten, reconciling ingest) uses the shared helper in `core/hash.ts` with the same tree context.

### 5.3 Fractional order keys

Base-62 fractional indexing (Figma-style). `key_between(a, b)` MUST return a key strictly between its arguments with amortized O(1) growth; appends use `key_between(last, null)`. Keys are never exposed via the API — ordinals are.

## 6. Rebuild rules (what "derived" means operationally)

`omg rebuild-index [--sections|--edges|--fts|--vec|--projections|--all]` MUST reconstruct every table in §4 from tables in §3 only, byte-identically for deterministic tables (sections, doc_edges, block_changes) and semantically for FTS/vec. CI runs a drop-and-rebuild equivalence check on the fixture vault. `file_stats` is the one exception: it caches filesystem state, not engine state, so it is rebuilt by re-statting the working tree (any missing/empty `file_stats` simply forces the next freshness sweep to hash every file — correct, just not free), never from §3.

## 7. Retention & GC

- Default retention: keep all revisions/commits forever (it's text; Merkle sharing keeps it small).
- Optional pruning (config, off by default): squash observed commits older than N months into checkpoint revisions. GC then removes unreachable blobs/tree_nodes by mark-and-sweep from live revision roots. GC MUST NOT run in v1.0 (ship the flag off; implement in hardening stage).
- `resurrection_pool` rows expire by `expires_ts` (default 30 days) via lazy sweep at checkpoint time.

## 8. Postgres dialect notes (deferred; do not build in v1)

BLOB→bytea, TEXT JSON→jsonb, FTS5→tsvector+GIN, brute-force Float32 vectors→pgvector(HNSW), fractional keys unchanged, recursive CTEs unchanged. The repository layer isolates dialect; nothing above the storage module may contain dialect-specific SQL.
