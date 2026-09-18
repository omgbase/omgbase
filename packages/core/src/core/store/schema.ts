// Full DDL — data-model §3 (durable) + §4 (derived). SQLite dialect.
// Kept as one string so migrations and rebuild-index can apply it verbatim.
// No dialect-specific SQL leaks above the store module (02 §8).

export const SCHEMA_VERSION = 13;

// file_stats (02 §4; derived, rebuildable by a full re-stat) backs the CLI
// freshness sweep (11 §3.3): (mtime_ns, size) cheap-change detection so a
// one-shot command re-ingests only files that changed on disk since last ingest.
export const FILE_STATS_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS file_stats (
  repo_id  TEXT NOT NULL,
  path     TEXT NOT NULL,
  mtime_ns INTEGER NOT NULL,
  size     INTEGER NOT NULL,
  hash     BLOB NOT NULL,
  PRIMARY KEY (repo_id, path)
);
`;

// properties (properties-table). One indexed row per property value: the
// unified query surface for frontmatter, inline (key:: value), and computed
// ($title/$tags) document properties, superseding the docs.metadata JSON
// blob. `card` records the authored shape (scalar vs list) so scalar ==/!=/<
// match only scalar-authored rows while list() sees all — reproducing the
// json_extract scalar-vs-array distinction. Current-state, maintained
// transactionally at ingest alongside blocks (repopulated by re-ingest, not by
// rebuild-index — see docs/properties-table.md §6).
export const PROPERTIES_DDL = /* sql */ `
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
  type           TEXT NOT NULL CHECK (type IN ('string','number','bool','null','json')),
  created_commit TEXT NOT NULL,
  deleted_commit TEXT
);
CREATE INDEX IF NOT EXISTS idx_props_doc      ON properties(doc_id)                 WHERE deleted_commit IS NULL;
CREATE INDEX IF NOT EXISTS idx_props_key_text ON properties(repo_id, key, val_text) WHERE deleted_commit IS NULL;
CREATE INDEX IF NOT EXISTS idx_props_key_num  ON properties(repo_id, key, val_num)  WHERE deleted_commit IS NULL;
CREATE INDEX IF NOT EXISTS idx_props_src_key  ON properties(repo_id, source, key)   WHERE deleted_commit IS NULL;
`;

// Sync adapters/sources/attachments (sync-plugins §2). A workspace-level
// registry: adapters map a name → external command; sources name an adapter +
// config (rendered to flags at spawn); attachments join repo ⇄ source (m:n).
// sync_state holds engine-owned per-attachment change-tracking (revision per
// path, cursor) so a stateless adapter can be spawned fresh each run (§6).
export const SYNC_DDL = /* sql */ `
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
  repo_id   TEXT NOT NULL,
  source_id TEXT NOT NULL,
  path      TEXT NOT NULL,          -- '' reserved for the attachment-level cursor row
  revision  TEXT,                   -- last-observed source revision for this path
  cursor    TEXT,                   -- last poll/webhook cursor (attachment-level row)
  PRIMARY KEY (repo_id, source_id, path)
);
`;

// Workspace-default settings (config-scope). A singleton row (id = 0) holding a
// JSON blob with the SAME shape as repos.settings. It is the default layer: a
// repo's own settings deep-merge on top (repo overrides workspace at the leaf).
// There is no separate "global config" namespace — top-level concepts are the
// tables (repos/adapters/sources); omg config speaks only this settings shape,
// at the workspace (default) layer or a specific repo layer.
export const WORKSPACE_SETTINGS_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS workspace_settings (
  id       INTEGER PRIMARY KEY CHECK (id = 0),
  settings TEXT NOT NULL DEFAULT '{}'
);
INSERT OR IGNORE INTO workspace_settings (id, settings) VALUES (0, '{}');
`;

export const NODES_DDL = /* sql */ `
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
`;

// doc_embeddings (doc-grain semantic retrieval). One vector per (doc_id, model)
// so `from=docs semantic` ranks whole documents by topical relevance rather than
// re-labelling block hits. `input_hash` is the freshness key: the sha256 of the
// exact bytes that produced the vector (whole-doc embed input, or the pooled
// fallback's composite of block hashes) — a stored row whose input_hash no
// longer matches the current document's is stale and re-embedded. `method`
// records which strategy produced it ('whole' = whole-document embedding;
// 'pooled' = token-weighted mean of block vectors, used only when the doc's
// embed input exceeds the provider's max input length). Derived/rebuildable
// like the block `embeddings` cache; keyed by doc_id (not content_hash) because
// a document has no single stable content hash across block edits.
export const DOC_EMBEDDINGS_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS doc_embeddings (
  doc_id     TEXT NOT NULL,
  model      TEXT NOT NULL,
  input_hash BLOB NOT NULL,
  method     TEXT NOT NULL CHECK (method IN ('whole','pooled')),
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  PRIMARY KEY (doc_id, model)
);
`;

// Additive migrations keyed by the version they upgrade TO. Each runs inside a
// transaction. Only forward, idempotent DDL (CREATE ... IF NOT EXISTS) — no
// destructive changes. store.ts applies these in order for an older db.
// Migrations 3, 4, 6, 7, 9, 11 are programmatic — see store.ts.
export const MIGRATIONS: Record<number, string> = {
  2: FILE_STATS_DDL,
  3: "",  // handled programmatically in store.ts
  4: "",  // handled programmatically in store.ts
  5: NODES_DDL,
  6: "",  // handled programmatically in store.ts
  7: "",  // handled programmatically in store.ts
  8: PROPERTIES_DDL,
  9: "",  // SYNC_DDL + repos.root_path→nullable, handled programmatically in store.ts
  10: WORKSPACE_SETTINGS_DDL,
  11: "",  // ALTER TABLE documents RENAME TO docs, handled programmatically in store.ts
  12: DOC_EMBEDDINGS_DDL,  // doc-grain semantic vectors
  13: "",  // drop repos.root_path (migrate → fs sources), handled programmatically in store.ts
};

export const DDL = /* sql */ `
-- ---- durable tables (02 §3) --------------------------------------------------
CREATE TABLE IF NOT EXISTS repos (
  repo_id   TEXT PRIMARY KEY,
  slug      TEXT NOT NULL UNIQUE,
  settings  TEXT NOT NULL DEFAULT '{}'
);
-- A repo owns identity + history, NOT a filesystem (ADR-014). Where its bytes
-- come from is a sources row (adapter=fs, config.root) joined via attachments;
-- the former repos.root_path column was removed in schema v13.

CREATE TABLE IF NOT EXISTS docs (
  doc_id         TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repos(repo_id),
  path           TEXT NOT NULL,
  format         TEXT NOT NULL DEFAULT 'markdown',
  current_rev    TEXT,
  file_hash      BLOB,
  conflicted     INTEGER NOT NULL DEFAULT 0,
  leading_trivia TEXT NOT NULL DEFAULT '',
  frontmatter_trivia TEXT,                  -- separator between frontmatter and first body block (NULL = no frontmatter)
  deleted_commit TEXT,
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
  raw_hash       BLOB NOT NULL,
  norm_hash      BLOB NOT NULL,
  trivia_hash    BLOB,                     -- trailing trivia blob hash (NULL = no trivia)
  created_commit TEXT NOT NULL,
  deleted_commit TEXT
);
CREATE INDEX IF NOT EXISTS idx_blocks_doc      ON blocks(doc_id, parent_block, order_key) WHERE deleted_commit IS NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_type     ON blocks(repo_id, type)                   WHERE deleted_commit IS NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_rawhash  ON blocks(raw_hash);
CREATE INDEX IF NOT EXISTS idx_blocks_ancestor ON blocks(doc_id, ancestor_path);

CREATE TABLE IF NOT EXISTS blobs (
  hash  BLOB PRIMARY KEY,
  bytes BLOB NOT NULL,
  size  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tree_nodes (
  hash    BLOB PRIMARY KEY,
  entries TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  rev_id           TEXT PRIMARY KEY,
  doc_id           TEXT NOT NULL REFERENCES docs(doc_id),
  seq              INTEGER NOT NULL,
  root_tree        BLOB NOT NULL REFERENCES tree_nodes(hash),
  frontmatter_blob BLOB REFERENCES blobs(hash),
  rendered_hash    BLOB NOT NULL,
  path             TEXT NOT NULL,
  commit_id        TEXT NOT NULL REFERENCES commits(commit_id),
  UNIQUE (doc_id, seq)
);

CREATE TABLE IF NOT EXISTS commits (
  commit_id     TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(repo_id),
  seq           INTEGER NOT NULL,
  ts            TEXT NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('api','observed','import','projection')),
  actor         TEXT,
  reason        TEXT,
  checkpoint_id TEXT,
  ops           TEXT,
  UNIQUE (repo_id, seq)
);

CREATE TABLE IF NOT EXISTS dispositions (
  commit_id  TEXT NOT NULL REFERENCES commits(commit_id),
  block_id   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN
             ('same','edited','moved','edited_moved','inserted','deleted',
              'split_from','merged_into','copied_from','resurrected','bulk_rewrite')),
  confidence REAL,
  reason     TEXT,
  matcher_v  TEXT,
  detail     TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (commit_id, block_id, kind)
);

CREATE TABLE IF NOT EXISTS edges (
  edge_id     TEXT PRIMARY KEY,
  repo_id     TEXT NOT NULL,
  src_doc     TEXT NOT NULL,
  src_block   TEXT,
  src_field   TEXT,
  predicate   TEXT NOT NULL,
  dst_kind    TEXT NOT NULL CHECK (dst_kind IN ('document','block','external','collection')),
  dst_node    TEXT NOT NULL,
  anchor      TEXT,
  provenance  TEXT NOT NULL CHECK (provenance IN ('link','frontmatter','inline_field','projected',
               'yaml_ref','yaml_schema','yaml_extends','json_ref','json_schema')),
  via_node    TEXT,
  from_commit TEXT NOT NULL,
  to_commit   TEXT
);
CREATE INDEX IF NOT EXISTS idx_edges_src      ON edges(src_doc, predicate) WHERE to_commit IS NULL;
CREATE INDEX IF NOT EXISTS idx_edges_dst      ON edges(dst_node, predicate) WHERE to_commit IS NULL;
CREATE INDEX IF NOT EXISTS idx_edges_temporal ON edges(from_commit, to_commit);

CREATE TABLE IF NOT EXISTS external_nodes (
  node_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  uri     TEXT NOT NULL,
  title   TEXT,
  UNIQUE (repo_id, uri)
);

CREATE TABLE IF NOT EXISTS collections (
  node_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  spec    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id       TEXT PRIMARY KEY,
  repo_id  TEXT NOT NULL,
  ts       TEXT NOT NULL,
  files    TEXT NOT NULL,
  git_head TEXT
);

CREATE TABLE IF NOT EXISTS resurrection_pool (
  block_id       TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  doc_id         TEXT NOT NULL,
  raw_hash       BLOB NOT NULL,
  norm_hash      BLOB NOT NULL,
  type           TEXT NOT NULL,
  deleted_commit TEXT NOT NULL,
  expires_ts     TEXT NOT NULL
);

-- ---- derived tables (02 §4; rebuildable) ------------------------------------
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

CREATE TABLE IF NOT EXISTS block_changes (
  block_id  TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  PRIMARY KEY (block_id, commit_id, kind)
);

CREATE TABLE IF NOT EXISTS inferred_edges (
  src_node    TEXT NOT NULL,
  dst_node    TEXT NOT NULL,
  predicate   TEXT NOT NULL,
  method      TEXT NOT NULL,
  score       REAL NOT NULL,
  model_v     TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (src_node, dst_node, predicate, method)
);

CREATE TABLE IF NOT EXISTS embeddings (
  content_hash BLOB NOT NULL,
  ctx_hash     BLOB NOT NULL,
  model        TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  vec          BLOB NOT NULL,
  PRIMARY KEY (content_hash, ctx_hash, model)
);

${DOC_EMBEDDINGS_DDL}

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

${FILE_STATS_DDL}
${PROPERTIES_DDL}
${SYNC_DDL}
${WORKSPACE_SETTINGS_DDL}
`;
