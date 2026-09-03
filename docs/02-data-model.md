# omgbase — Data Model & Storage Schema

**Status:** normative. SQLite dialect (v1). Column types use SQLite affinities; a future Postgres dialect maps 1:1 (ADR-001).
**Depends on:** `01-architecture.md` §3–4, §12.

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

- Mint with retry on unique-constraint violation. IDs are repo-scoped, never reused, never re-assigned.
- Content hashes are **sha256** stored as 32-byte BLOBs; displayed truncated to 16 hex chars. Two hash flavors per block:
  - `raw_hash` — sha256 of exact raw source bytes (blob key, splice identity).
  - `norm_hash` — sha256 of normalized text (whitespace collapsed, trivia stripped) used by reconciliation phase 2. Stored on `blocks`, not on blobs.
- Tree-node hashes: sha256 over the canonical serialization of entries (see §3.4).

## 2. Database placement

One SQLite database per workspace at `<workspace>/.omgbase/omgbase.db` (WAL mode, `synchronous=NORMAL`, foreign keys ON). `.omgbase/` MUST be listed in the repo's `.gitignore` (the engine offers to append it at `repo attach` time; never edits git config silently).

All writes go through a single serialized writer (one connection; short transactions — one transaction per commit). Readers use separate connections (WAL snapshots).

## 3. DDL — durable tables

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE repos (
  repo_id      TEXT PRIMARY KEY,          -- 'rp_' + base32
  slug         TEXT NOT NULL UNIQUE,
  root_path    TEXT NOT NULL,             -- absolute path of the working tree
  settings     TEXT NOT NULL DEFAULT '{}' -- JSON: sync.quiescence_ms, matcher thresholds, embedding config…
);

CREATE TABLE documents (
  doc_id        TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(repo_id),
  path          TEXT NOT NULL,             -- repo-relative, canonical (no leading slash)
  frontmatter   TEXT NOT NULL DEFAULT '{}',-- JSON, parsed view of current frontmatter
  current_rev   TEXT,                      -- REFERENCES revisions(rev_id) (nullable during create)
  file_hash     BLOB,                      -- sha256 of file bytes at last sync (convergence check)
  conflicted    INTEGER NOT NULL DEFAULT 0,-- git conflict markers present; mutations refused
  deleted_commit TEXT,                     -- tombstone; NULL = live
  UNIQUE (repo_id, path)
);

-- Current-state block table (the hot table; fully rebuildable from current revisions,
-- but maintained transactionally for query speed).
CREATE TABLE blocks (
  block_id      TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(repo_id),
  doc_id        TEXT NOT NULL REFERENCES documents(doc_id),
  parent_block  TEXT,                      -- NULL = top-level child of document
  order_key     TEXT NOT NULL,             -- fractional key; sorts lexicographically among siblings
  ordinal       INTEGER NOT NULL,          -- materialized position among siblings (rebuilt per commit)
  depth         INTEGER NOT NULL,
  ancestor_path TEXT NOT NULL,             -- '/b_a1/b_b2/' — containment ancestors, for subtree queries
  type          TEXT NOT NULL,             -- block type enum (01-architecture §3.3)
  attrs         TEXT NOT NULL DEFAULT '{}',-- JSON typed attrs: checked, lang, level, info, alt…
  text          TEXT NOT NULL,             -- normalized visible text (query/FTS source)
  raw_hash      BLOB NOT NULL,             -- REFERENCES blobs(hash)
  norm_hash     BLOB NOT NULL,
  created_commit TEXT NOT NULL,
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
  doc_id           TEXT NOT NULL REFERENCES documents(doc_id),
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
  reason     TEXT,                         -- 'exact_hash'|'normalized_hash'|'context_unique'|'scored'|'anchor'|'tombstone'|'api'
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
  provenance  TEXT NOT NULL CHECK (provenance IN ('link','frontmatter','inline_field','projected')),
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

-- Embedding cache, keyed by content so identity errors cannot poison it.
CREATE TABLE embeddings (
  content_hash BLOB NOT NULL,              -- block raw_hash
  ctx_hash     BLOB NOT NULL,              -- sha256 of the context prefix string
  model        TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  vec          BLOB NOT NULL,              -- float32 array
  PRIMARY KEY (content_hash, ctx_hash, model)
);

-- FTS5 external-content index over current block text.
CREATE VIRTUAL TABLE blocks_fts USING fts5(
  text, content='blocks', content_rowid='rowid', tokenize='porter unicode61'
);
-- Maintained by triggers or explicit sync in the commit transaction.

-- sqlite-vec index (loaded as extension) for current block vectors:
-- CREATE VIRTUAL TABLE block_vec USING vec0(block_id TEXT PRIMARY KEY, embedding float[<dim>]);
-- Rebuilt/updated async by the embedding worker; brute-force acceptable to ~10^5 vectors.
```

## 5. Canonical serializations

### 5.1 Tree-node entries

Canonical JSON: array of arrays, UTF-8, no whitespace, keys in the fixed positional order `[block_id, raw_hash_hex, child_tree_hash_hex|null, type, attrs_canonical_json, trivia_hash_hex|null]`, attrs objects with lexicographically sorted keys. `hash = sha256(bytes)`. Any two structurally identical subtrees MUST produce identical hashes (structural sharing depends on it).

`trivia_hash_hex` references a blob holding the inter-block trivia attached to this block (trailing blank lines / comments), so splicing is fully reconstructable from the tree alone.

### 5.2 Normalized text (`norm_hash` input)

- Strip leading/trailing whitespace per line; collapse internal runs of spaces/tabs to one space.
- Drop blank lines.
- For list items/tasks: strip the marker (`- `, `1. `, `- [ ] `) but record `attrs.checked` separately.
- Preserve inline Markdown characters as-is (emphasis markers count as content).
- NFC Unicode normalization.

### 5.3 Fractional order keys

Base-62 fractional indexing (Figma-style). `key_between(a, b)` MUST return a key strictly between its arguments with amortized O(1) growth; appends use `key_between(last, null)`. Keys are never exposed via the API — ordinals are.

## 6. Rebuild rules (what "derived" means operationally)

`omg rebuild-index [--sections|--edges|--fts|--vec|--projections|--all]` MUST reconstruct every table in §4 from tables in §3 only, byte-identically for deterministic tables (sections, doc_edges, block_changes) and semantically for FTS/vec. CI runs a drop-and-rebuild equivalence check on the fixture vault.

## 7. Retention & GC

- Default retention: keep all revisions/commits forever (it's text; Merkle sharing keeps it small).
- Optional pruning (config, off by default): squash observed commits older than N months into checkpoint revisions. GC then removes unreachable blobs/tree_nodes by mark-and-sweep from live revision roots. GC MUST NOT run in v1.0 (ship the flag off; implement in hardening stage).
- `resurrection_pool` rows expire by `expires_ts` (default 30 days) via lazy sweep at checkpoint time.

## 8. Postgres dialect notes (deferred; do not build in v1)

BLOB→bytea, TEXT JSON→jsonb, FTS5→tsvector+GIN, sqlite-vec→pgvector(HNSW), fractional keys unchanged, recursive CTEs unchanged. The repository layer isolates dialect; nothing above the storage module may contain dialect-specific SQL.
