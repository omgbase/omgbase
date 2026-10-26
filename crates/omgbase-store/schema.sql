
-- ---- core bundle: durable tables (spec/store 17.0 §3.1) ---------------------
CREATE TABLE IF NOT EXISTS repos (
  repo_id   TEXT PRIMARY KEY,
  slug      TEXT NOT NULL UNIQUE,
  settings  TEXT NOT NULL DEFAULT '{}',
  epoch     TEXT NOT NULL                     -- the feed's epoch: a minted ep_ id (17.0, D7); re-minted by a restore / rebuild-from-files (§7.5)
);
-- A repo owns identity + history, NOT a filesystem (ADR-014). Where its bytes
-- come from is a sources row (adapter=fs, config.root) joined via attachments;
-- the former repos.root_path column was removed in schema v13.

CREATE TABLE IF NOT EXISTS docs (
  doc_id             TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL REFERENCES repos(repo_id),
  path               TEXT NOT NULL,
  format             TEXT NOT NULL DEFAULT 'markdown',
  head               TEXT,                    -- the head token (an r_ id the core mints on every head change); equals revisions.rev_id while history is captured
  file_hash          BLOB,
  conflicted         INTEGER NOT NULL DEFAULT 0,
  leading_trivia     TEXT NOT NULL DEFAULT '',
  frontmatter_raw    TEXT,                    -- the frontmatter block's raw, fences included (NULL = no frontmatter)
  frontmatter_trivia TEXT,                    -- separator between frontmatter and first body block (NULL = no frontmatter)
  created_at         TEXT NOT NULL,           -- the identity's birth: the first commit's ts; survives tombstone and revival
  updated_at         TEXT NOT NULL,           -- the ts of the commit that last minted the head (content, structure, path or liveness)
  deleted_at         TEXT,                    -- tombstone (NULL = live)
  UNIQUE (repo_id, path)
);

CREATE TABLE IF NOT EXISTS blocks (
  block_id       TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repos(repo_id),
  doc_id         TEXT NOT NULL REFERENCES docs(doc_id),
  parent_block   TEXT,
  order_key      TEXT NOT NULL,
  ordinal        INTEGER NOT NULL,
  depth          INTEGER NOT NULL,
  ancestor_path  TEXT NOT NULL,
  type           TEXT NOT NULL,
  attrs          TEXT NOT NULL DEFAULT '{}',
  text           TEXT NOT NULL,
  raw            TEXT NOT NULL,               -- the block's raw source (D10)
  raw_hash       BLOB NOT NULL,               -- sha256(raw): the CAS and dedup key
  norm_hash      BLOB NOT NULL,
  trivia         TEXT,                        -- trailing trivia (NULL = none)
  trivia_hash    BLOB,                        -- sha256(trivia) (NULL = none)
  created_at     TEXT NOT NULL,               -- the identity's birth, carried (D6)
  updated_at     TEXT NOT NULL,               -- the block's own last change (14.2 rule)
  deleted_at     TEXT                         -- tombstone (NULL = live); Phase 4 stops writing tombstoned rows (D2)
);
CREATE INDEX IF NOT EXISTS idx_blocks_doc      ON blocks(doc_id, parent_block, order_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_type     ON blocks(repo_id, type)                   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_rawhash  ON blocks(raw_hash);
CREATE INDEX IF NOT EXISTS idx_blocks_ancestor ON blocks(doc_id, ancestor_path);

-- Identity claims (spec/store §2.1, 17.0 — M3/D5): one row per id the core
-- has minted. holders is a bitmask — bit 0 the core (set at mint, released by
-- the claims prune, §7.3), bit 1 the recorder (set when the capture first
-- names the id). A row leaves only when no holder remains. repo_id is NULL for
-- a workspace-scoped id (a source).
CREATE TABLE IF NOT EXISTS id_claims (
  id        TEXT PRIMARY KEY,
  repo_id   TEXT,
  prefix    TEXT NOT NULL,
  minted_at TEXT NOT NULL,
  holders   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_repo_prefix ON id_claims(repo_id, prefix, minted_at);

CREATE TABLE IF NOT EXISTS resurrection_pool (
  block_id       TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  doc_id         TEXT NOT NULL,
  raw_hash       BLOB NOT NULL,
  norm_hash      BLOB NOT NULL,
  type           TEXT NOT NULL,
  created_at     TEXT NOT NULL,            -- carried from the deleted row, restored on resurrection (D6)
  deleted_at     TEXT NOT NULL,            -- the deleting commit's ts (17.0; deleted_commit through 16.x)
  expires_ts     TEXT NOT NULL             -- deleted_at + 30 days (I6)
);

CREATE TABLE IF NOT EXISTS pending_materializations (
  repo_id       TEXT NOT NULL REFERENCES repos(repo_id),
  path          TEXT NOT NULL,                 -- where the file must end up
  kind          TEXT NOT NULL CHECK (kind IN ('write','rename','remove')),
  from_path     TEXT,                          -- rename: the old path
  doc_id        TEXT NOT NULL REFERENCES docs(doc_id),
  head          TEXT,                          -- write/rename: the head token whose bytes the row renders (NULL for remove); no FK
  rendered_hash BLOB NOT NULL,                 -- the bytes expected at path (remove: the bytes it is safe to unlink)
  prior_hash    BLOB,                          -- the bytes the engine itself last wrote at path, captured at commit (NULL when none)
  commit_id     TEXT NOT NULL,                 -- the api commit that recorded it; no FK
  created_at    TEXT NOT NULL,                 -- that commit's ts
  PRIMARY KEY (repo_id, path)
);

CREATE TABLE IF NOT EXISTS feed (
  repo_id   TEXT NOT NULL REFERENCES repos(repo_id),
  epoch     TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  commit_id TEXT NOT NULL UNIQUE,
  ts        TEXT NOT NULL,
  origin    TEXT NOT NULL CHECK (origin IN ('api','observed','import','projection')),
  actor     TEXT,
  reason    TEXT,
  batch_id  TEXT NOT NULL,                    -- the first committing member of the same observed batch; = commit_id for a batch of one and every api commit
  plan_id   TEXT,                             -- the admitted plan's digest (64 hex) for an effect-driven api commit; NULL otherwise
  PRIMARY KEY (repo_id, epoch, seq)
);
CREATE INDEX IF NOT EXISTS idx_feed_ts ON feed(repo_id, ts);

CREATE TABLE IF NOT EXISTS feed_entries (
  repo_id   TEXT NOT NULL,
  epoch     TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  doc_id    TEXT NOT NULL,
  path      TEXT NOT NULL,                    -- as of the commit
  head      TEXT,                             -- the token minted (NULL for deleted)
  hash      BLOB,                             -- file_hash after the commit (NULL for deleted)
  kind      TEXT NOT NULL CHECK (kind IN ('created','changed','deleted','moved')),
  from_path TEXT,                             -- moved only
  PRIMARY KEY (repo_id, epoch, seq, doc_id)
);

-- Open edges (spec/graph §3.3, 17.0 — M6): one row per link relation the
-- current heads assert. Closing an edge DELETES its row; the interval record
-- (from_commit / to_commit, 16.x's columns) is the history bundle's
-- edge_transitions. dst_kind 'collection' left with the collections table (D9).
CREATE TABLE IF NOT EXISTS edges (
  edge_id     TEXT PRIMARY KEY,
  repo_id     TEXT NOT NULL,
  src_doc     TEXT NOT NULL,
  src_block   TEXT,
  src_field   TEXT,
  predicate   TEXT NOT NULL,
  dst_kind    TEXT NOT NULL CHECK (dst_kind IN ('document','block','external')),
  dst_node    TEXT NOT NULL,
  anchor      TEXT,
  provenance  TEXT NOT NULL CHECK (provenance IN ('link','frontmatter','inline_field','projected',
               'yaml_ref','yaml_schema','yaml_extends','json_ref','json_schema')),
  via_node    TEXT
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_doc, predicate);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_node, predicate);

CREATE TABLE IF NOT EXISTS external_nodes (
  node_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  uri     TEXT NOT NULL,
  title   TEXT,
  UNIQUE (repo_id, uri)
);

-- ---- core bundle: derived tables (rebuildable) --------------------------------
CREATE TABLE IF NOT EXISTS sections (
  heading_block TEXT NOT NULL,
  doc_id        TEXT NOT NULL,
  level         INTEGER NOT NULL,
  first_ordinal INTEGER NOT NULL,
  last_ordinal  INTEGER NOT NULL,
  PRIMARY KEY (doc_id, heading_block)
);

CREATE TABLE IF NOT EXISTS doc_edges (
  src_doc   TEXT NOT NULL,
  predicate TEXT NOT NULL,
  dst_node  TEXT NOT NULL,
  dst_kind  TEXT NOT NULL,
  count     INTEGER NOT NULL,
  samples   TEXT NOT NULL,
  PRIMARY KEY (src_doc, predicate, dst_node)
);

CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
  text, content='blocks', content_rowid='rowid', tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS nodes (
  node_id    TEXT PRIMARY KEY,
  repo_id    TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  block_id   TEXT,
  kind       TEXT NOT NULL,
  name       TEXT,
  value      TEXT,
  span_start INTEGER,
  span_end   INTEGER,
  attrs      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_nodes_doc  ON nodes(doc_id);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name) WHERE name IS NOT NULL;
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name, value, content='nodes', content_rowid='rowid', tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS file_stats (
  repo_id  TEXT NOT NULL,
  path     TEXT NOT NULL,
  mtime_ns INTEGER NOT NULL,
  size     INTEGER NOT NULL,
  hash     BLOB NOT NULL,
  PRIMARY KEY (repo_id, path)
);

CREATE TABLE IF NOT EXISTS properties (
  prop_id        TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  doc_id         TEXT NOT NULL,
  block_id       TEXT,                    -- NULL = document-scoped (frontmatter, computed)
  source         TEXT NOT NULL CHECK (source IN ('frontmatter','inline','computed')),
  key            TEXT NOT NULL,           -- dotted, flattened: "layer","meta.owner"; computed carry $: "$title"
  card           TEXT NOT NULL CHECK (card IN ('scalar','list')),
  ord            INTEGER NOT NULL DEFAULT 0,
  val_text       TEXT,
  val_num        REAL,
  val_bool       INTEGER,
  val_json       TEXT,
  type           TEXT NOT NULL CHECK (type IN ('string','number','bool','null','json'))
);
CREATE INDEX IF NOT EXISTS idx_props_doc      ON properties(doc_id);
CREATE INDEX IF NOT EXISTS idx_props_key_text ON properties(repo_id, key, val_text);
CREATE INDEX IF NOT EXISTS idx_props_key_num  ON properties(repo_id, key, val_num);
CREATE INDEX IF NOT EXISTS idx_props_src_key  ON properties(repo_id, source, key);

-- ---- core bundle: the sync registry (spec/sync) --------------------------------

CREATE TABLE IF NOT EXISTS adapters (
  name     TEXT PRIMARY KEY,        -- workspace-unique adapter name (e.g. "fs")
  command  TEXT NOT NULL,           -- argv[0] to spawn (e.g. "omgbase-fs-adapter")
  args     TEXT NOT NULL DEFAULT '[]'  -- fixed leading args (JSON string[])
);

CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,   -- workspace-unique source name
  adapter   TEXT NOT NULL REFERENCES adapters(name),
  config    TEXT NOT NULL DEFAULT '{}',  -- JSON object → rendered to flags (13 §3.1)
  env       TEXT NOT NULL DEFAULT '{}'   -- JSON object → spawn env (secrets; 13 §3.2)
);

CREATE TABLE IF NOT EXISTS attachments (
  repo_id   TEXT NOT NULL REFERENCES repos(repo_id),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  PRIMARY KEY (repo_id, source_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  repo_id          TEXT NOT NULL,
  source_id        TEXT NOT NULL,     -- '' reserved for the repository's own status row (17.0, D4)
  path             TEXT NOT NULL,     -- '' reserved for the attachment-level cursor row
  revision         TEXT,              -- last-observed source revision for this path
  cursor           TEXT,              -- last poll/webhook cursor (attachment-level row)
  last_batch_ts    TEXT,              -- the repository row only (spec/sync §4.1): the last observed batch's ts
  last_batch_id    TEXT,              -- its batch_id (NULL when nothing committed)
  last_batch_files INTEGER,           -- its member count
  PRIMARY KEY (repo_id, source_id, path)
);

CREATE TABLE IF NOT EXISTS workspace_settings (
  id       INTEGER PRIMARY KEY CHECK (id = 0),
  settings TEXT NOT NULL DEFAULT '{}'
);
INSERT OR IGNORE INTO workspace_settings (id, settings) VALUES (0, '{}');
