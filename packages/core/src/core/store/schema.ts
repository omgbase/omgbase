// Full DDL — data-model §3 (durable) + §4 (derived). SQLite dialect.
// Kept as one string so migrations and rebuild-index can apply it verbatim.
// No dialect-specific SQL leaks above the store module (02 §8).

export const SCHEMA_VERSION = 17;

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
// rebuild-index — see docs/properties-table.md §6). Since 17.0 (D9) the rows
// carry no commit column: a property is live exactly while its document's
// rows are — the commit deletes and rewrites them per document — so the
// `created_commit` stamp (never read) and `deleted_commit` (never written
// non-NULL; four partial indexes and every read filtered on it) are gone.
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
  type           TEXT NOT NULL CHECK (type IN ('string','number','bool','null','json'))
);
CREATE INDEX IF NOT EXISTS idx_props_doc      ON properties(doc_id);
CREATE INDEX IF NOT EXISTS idx_props_key_text ON properties(repo_id, key, val_text);
CREATE INDEX IF NOT EXISTS idx_props_key_num  ON properties(repo_id, key, val_num);
CREATE INDEX IF NOT EXISTS idx_props_src_key  ON properties(repo_id, source, key);
`;

// Sync adapters/sources/attachments (sync-plugins §2). A workspace-level
// registry: adapters map a name → external command; sources name an adapter +
// config (rendered to flags at spawn); attachments join repo ⇄ source (m:n).
// sync_state holds engine-owned per-attachment change-tracking (revision per
// path, cursor) so a stateless adapter can be spawned fresh each run (§6), and
// — since 17.0 (D4, the `checkpoints` table collapsed into it) — one reserved
// row per repository, `(repo_id, '', '')`, carrying the sync status: the last
// observed batch's ts, batch_id and member count (spec/sync §4.1).
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

// pending_materializations (spec/store §5.7, store 14.0; self-contained since
// 17.0 — modular-core Phase 3c, M4). The recorded intent of the api path's file
// half: the commit transaction inserts one row per file the request must leave
// on disk — `write` the document's bytes at `path`, `rename` the file from
// `from_path` to `path`, `remove` the file at `path` — and the materializer
// deletes each row once the file is there (after COMMIT, per file, autocommit).
// A row that survives a crash is replayed by the next materializer (B', the
// freshness sweep's step 0, recovery) from the document's CURRENT rows
// (`reconstruct`, §6.1): `head` is the token whose bytes it renders (no foreign
// key — the recorder's `revisions` is not consulted), `rendered_hash` the bytes
// expected at `path` (for `remove`: the bytes it is safe to unlink),
// `prior_hash` the bytes the engine itself last wrote at `path` — the
// `file_hash` the commit validated the file against, captured at commit time,
// or inherited from the row it superseded; NULL when the engine never wrote
// there — which is what a replay may overwrite, `commit_id` the recording
// commit (no foreign key: `commits` is the recorder's), `created_at` its `ts`.
// No bytes column: the current rows hold them. One row per path: a later
// request for the same path supersedes the earlier intent (§5.7
// "Supersession"; `mutate/materialize.ts`).
export const PENDING_MATERIALIZATIONS_DDL = /* sql */ `
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
`;

// archives (spec/store §7 "Retention", store 15.0). The registry of archive
// segments — the one-file-per-export SQLite databases `omg history export`
// writes (`spec/store/archive.sql`) that hold the bodies of the revisions the
// retention policy squashed: `segment_id` (a minted `s_` id, the manifest's),
// `path` (the file as recorded; `attach` re-records it), `seq_lo`/`seq_hi`
// (the `commits.seq` span of the archived commits), `created_at`,
// `revision_count`, `bytes` (the file's size when recorded). A revision's
// `archive` column names its segment whether or not the row is here: `detach`
// deletes the row, the pointer stays, and a read of such a revision is
// `revision_archived`. Rows are written by the squash transaction and by
// `attach`; never by a commit.
export const ARCHIVES_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS archives (
  segment_id     TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repos(repo_id),
  path           TEXT NOT NULL,
  seq_lo         INTEGER NOT NULL,
  seq_hi         INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  revision_count INTEGER NOT NULL,
  bytes          INTEGER NOT NULL
);
`;

// The change feed (spec/store §3.1 `feed`/`feed_entries`, 17.0 — D7/M5): one
// slim row per commit to the repository within retention — the delivery record
// `changes_since` pages, bounded by the `feed.*` settings (§7.4) — plus one
// entry per document the commit touched. `seq` is dense from 1 per (repo,
// epoch); a cursor is (epoch, seq). The recorder's `commits` row shares the
// commit_id, epoch and seq; the feed is the core's and depends on no history
// table. `plan_id` (resolution 3) correlates an api commit with its Receipt
// when history is off. Migration 17 executes this text on a 16.x database.
export const FEED_DDL = /* sql */ `
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
`;

// edge_transitions (spec/graph §3.3, 17.0 — M6; the history bundle's): 16.x's
// `edges` row verbatim — the interval record — written when the core opens an
// edge (`to_commit` NULL) and closed (`to_commit` = the commit) when it deletes
// one; `dst_node` follows the open edge's in-place rewrites (phantom adoption,
// a move's re-phantoming) so the row reads as 16.x's did. Migration 17
// executes this text on a 16.x database and backfills it from the old columns.
export const EDGE_TRANSITIONS_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS edge_transitions (
  edge_id     TEXT PRIMARY KEY,
  repo_id     TEXT NOT NULL,
  src_doc     TEXT NOT NULL,
  src_block   TEXT,
  src_field   TEXT,
  predicate   TEXT NOT NULL,
  dst_kind    TEXT NOT NULL,
  dst_node    TEXT NOT NULL,
  anchor      TEXT,
  provenance  TEXT NOT NULL,
  via_node    TEXT,
  from_commit TEXT NOT NULL,
  to_commit   TEXT
);
CREATE INDEX IF NOT EXISTS idx_edge_transitions_temporal ON edge_transitions(from_commit, to_commit);
`;

// capabilities (spec/store §3.1 "capabilities", 17.0 — modular-core Phase 3e-ii;
// phase-1-contracts §1.5): the per-repository CAPABILITY MANIFEST — one row per
// (repository, capability) saying whether the history recorder / the semantic
// provider is on for it, which interface and data version the bundle's rows
// were produced under, the configuration they were produced under (semantic:
// { model, dim }; history: {}) and its sha256 fingerprint, the COVERAGE
// intervals capture was on (JSON [{ "from": ts, "to": ts | null }, …], the last
// open iff enabled) and `writer_requires` (1: a writer without the module must
// refuse writes on this repository — resolution 17). A table, not settings
// keys: engine-written state that survives a settings rewrite, typed, projected
// row for row, read by `doctor` without resolving settings. Written at
// `ensure_repo`, by migration 17 and (Phase 4) by the `history`/`embed` verbs;
// through 3e-ii the semantic row follows `embedding.provider` on every settings
// write. A repository with no row for a capability is `disabled` with no coverage.
export const CAPABILITIES_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS capabilities (
  repo_id          TEXT NOT NULL REFERENCES repos(repo_id),
  capability       TEXT NOT NULL CHECK (capability IN ('history','semantic')),
  state            TEXT NOT NULL CHECK (state IN ('enabled','disabled')),
  interface_v      INTEGER NOT NULL,            -- the capability interface the writer implements (history 1, semantic 1)
  data_v           INTEGER NOT NULL,            -- the bundle's own schema version (history 1 = 16.0's tables + edge_transitions; semantic 1)
  config           TEXT NOT NULL DEFAULT '{}',  -- the configuration the data was produced under (semantic: { model, dim }; history: {})
  config_hash      BLOB NOT NULL,               -- sha256(canonical JSON of config) — the fingerprint; a change while enabled is a rebuild
  coverage         TEXT NOT NULL DEFAULT '[]',  -- JSON [{ "from": ts, "to": ts | null }, …]: the intervals capture was on; the last open iff enabled
  writer_requires  INTEGER NOT NULL DEFAULT 0,  -- 1: a writer without this module must refuse writes (resolution 17; history enable defaults to 1)
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (repo_id, capability)
);
`;

// alerts (spec/store §3.1 "alerts", 17.0 — Phase 3e-ii; phase-1-contracts §7
// "the alert channel"): one row per (repository, condition) the engine raised
// because a human is needed — a materialization backlog, a replay that failed,
// a writer refused by `writer_requires`, … — with its severity, message, the
// instant it was first raised (`since`, kept across re-raises), a JSON `detail`
// and `cleared_at` once the condition ended (NULL = active). Every MCP tool
// response carries the active alerts in a top-level `alerts` member when there
// are any, the CLI prints them to stderr, `doctor` lists them (spec/surface §4,
// spec/cli §3.1). Raising is idempotent (message/detail refreshed, `since`
// kept); a cleared row is re-raised in place with a new `since`.
export const ALERTS_DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS alerts (
  repo_id    TEXT NOT NULL REFERENCES repos(repo_id),
  code       TEXT NOT NULL,                      -- the condition: materialization_backlog, materialization_failed, writer_refused, …
  severity   TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
  message    TEXT NOT NULL,                      -- one line for a human, both engines byte for byte
  since      TEXT NOT NULL,                      -- first raised (kept while the condition stands)
  detail     TEXT NOT NULL DEFAULT '{}',         -- JSON: what the condition is about (counts, paths, timestamps)
  cleared_at TEXT,                               -- NULL = active
  PRIMARY KEY (repo_id, code)
);
`;

// Additive migrations keyed by the version they upgrade TO. Each runs inside a
// transaction. Only forward, idempotent DDL (CREATE ... IF NOT EXISTS) — no
// destructive changes. store.ts applies these in order for an older db.
// Migrations 3, 4, 6, 7, 9, 11, 13, 15, 17 are programmatic — see store.ts.
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
  14: PENDING_MATERIALIZATIONS_DDL,  // the api path's recorded file intent (spec/store §5.7)
  15: "",  // revisions.root_tree/frontmatter_blob nullable + `archive`, create `archives` (spec/store §7 "Retention"), handled programmatically in store.ts
  16: "",  // no DDL: delta tree nodes (spec/store §4.1 "Delta nodes", §3.4 step 16) — every 15.x node is already a valid checkpoint, so the step only moves user_version; handled in store.ts
  17: "",  // the head (`docs.head`, `frontmatter_raw`), the inline block bytes (`blocks.raw`/`trivia`), the time columns (`created_at`/`updated_at`/`deleted_at`; `created_commit`/`deleted_commit` gone), `resurrection_pool.created_at`/`deleted_at`, the `id_claims` table backfilled from every id the current rows and the history still name, the self-contained `pending_materializations` row (`head`, `prior_hash`, `created_at`; the two foreign keys gone), (3d) the repository epoch, the `feed`/`feed_entries` tables backfilled from the 16.x `commits`/`revisions`, the recorder's `commits` row (`epoch`, `batch_id`; `checkpoint_id` gone), the `sync_state` status row and the dropped `checkpoints`, and (3e-i) the open-only `edges` (the closed rows and the interval columns moved to the history bundle's `edge_transitions`, `idx_edges_temporal` gone), `properties` without `created_commit`/`deleted_commit`, the dropped `collections`/`inferred_edges`, and (3e-ii) the `capabilities` manifest (a `history` row `enabled` with coverage from the repo's first commit, a `semantic` row `enabled` iff a provider is configured) and the empty `alerts` table — table rebuilds backfilled from the 16.x history tables (spec/store §3.4 step 17), handled programmatically in store.ts
};

// The CORE bundle (spec/store §3.1, 17.0 — `schema.sql`): the current state
// and the identity of a repository, the change feed, the derived indexes the
// query surfaces read, and the sync registry. Every table here is read and
// written by the core and depends on no history or semantic table. Executed on
// every fresh database — alone, since Phase 4a: the history bundle follows
// when a repository's manifest says `enabled` (`core/store/manifest.ts`
// `applyHistoryBundle`), the semantic bundle with the semantic module
// (`Store.applyBundles`).
export const DDL = /* sql */ `
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
  deleted_at     TEXT                         -- always NULL since 17.3: a tombstone DELETES the rows (D2 step two); the column stays for the 17.x partial indexes
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
${PENDING_MATERIALIZATIONS_DDL}${FEED_DDL}
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
${CAPABILITIES_DDL}${ALERTS_DDL}
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
${NODES_DDL}${FILE_STATS_DDL}${PROPERTIES_DDL}
-- ---- core bundle: the sync registry (spec/sync) --------------------------------
${SYNC_DDL}${WORKSPACE_SETTINGS_DDL}`;

// The HISTORY bundle (spec/store §3.1, 17.0 — `schema-history.sql`): the
// recorder's capture. Written only by the recorder inside the commit
// transaction (spec/store §5.4 step 15), read only by the history reads and
// the invariants that check the capture agrees with the head; the core reads
// none of these tables. `edge_transitions` (M6) is 16.x's `edges` row verbatim
// — the interval record the core table lost when it became open-only.
export const HISTORY_DDL = /* sql */ `
-- ---- history bundle (spec/store 17.0 §3.1, the recorder's) -------------------
CREATE TABLE IF NOT EXISTS commits (
  commit_id TEXT PRIMARY KEY,
  repo_id   TEXT NOT NULL REFERENCES repos(repo_id),
  epoch     TEXT NOT NULL,                    -- the feed row's epoch (17.0, D7)
  seq       INTEGER NOT NULL,                 -- = the feed row's seq
  ts        TEXT NOT NULL,
  origin    TEXT NOT NULL CHECK (origin IN ('api','observed','import','projection')),
  actor     TEXT,
  reason    TEXT,
  batch_id  TEXT NOT NULL,                    -- the feed row's batch_id (D4)
  ops       TEXT,                             -- the ADR-003 intent record of an api commit (M5)
  UNIQUE (repo_id, epoch, seq)
);

CREATE TABLE IF NOT EXISTS revisions (
  rev_id           TEXT PRIMARY KEY,
  doc_id           TEXT NOT NULL REFERENCES docs(doc_id),
  seq              INTEGER NOT NULL,
  root_tree        BLOB,                   -- a tree_nodes.hash; NULL once archived (spec/store §7 "Retention", 15.0)
  frontmatter_blob BLOB,                   -- a blobs.hash, or NULL (no frontmatter, or archived)
  rendered_hash    BLOB NOT NULL,
  path             TEXT NOT NULL,
  commit_id        TEXT NOT NULL REFERENCES commits(commit_id),
  archive          TEXT,                   -- the archive segment holding the bodies; NULL = live (15.0)
  UNIQUE (doc_id, seq)
);

CREATE TABLE IF NOT EXISTS blobs (
  hash  BLOB PRIMARY KEY,
  bytes BLOB NOT NULL,
  size  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tree_nodes (
  hash    BLOB PRIMARY KEY,
  entries TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS block_changes (
  block_id  TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  PRIMARY KEY (block_id, commit_id, kind)
);

${EDGE_TRANSITIONS_DDL}${ARCHIVES_DDL}`;

// The SEMANTIC bundle (spec/store §3.1, 17.0 — `schema-semantic.sql`; spec/
// search): the embedding caches, reached only through `SemanticProvider`.
export const SEMANTIC_DDL = /* sql */ `
-- ---- semantic bundle (spec/store 17.0 §3.1; spec/search) -----------------------
CREATE TABLE IF NOT EXISTS embeddings (
  content_hash BLOB NOT NULL,
  ctx_hash     BLOB NOT NULL,
  model        TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  vec          BLOB NOT NULL,
  PRIMARY KEY (content_hash, ctx_hash, model)
);
${DOC_EMBEDDINGS_DDL}`;

/** The three bundles concatenated — what a database with every capability on holds (the partition test; through Phase 3 what every fresh database executed. Since Phase 4a the opener executes `DDL` alone and the bundles follow the manifest/composition). */
export const ALL_DDL = `${DDL}${HISTORY_DDL}${SEMANTIC_DDL}`;
