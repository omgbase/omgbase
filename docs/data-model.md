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

- IDs are repo-scoped, never reused, never re-assigned. Minting is collision-checked at the seam (`core/ids.ts` `mintId`, `spec/store` §2.1, 13.5): a candidate is redrawn while it is in use — already issued in this process, or **claimed** per an oracle every open `Store` registers. Since schema v17 (`spec/store` 17.0, modular-core 3b — M3/D5) the claim is a row of **`id_claims`** `(id, repo_id, prefix, minted_at, holders)`, written by the core's writers in the transaction that lands the id (`d` with the doc row, `r` with the head, `b` with the block rows, `x`/`e` with the graph rows, `rp`/`src` with the registry rows — after the minter yielded, so the fixture minter's sequence is untouched) and probed with one statement for all of them; `c` (commits) and `s` (archives) are the recorder's own mints, claimed by their rows, and `cp` probes `checkpoints` until D4 retires it; `col`/`v` unchecked. `holders` is a bitmask — bit 0 the core (released only by the claims prune, `identity.claims_retain_days`, default never), bit 1 the recorder (set when its capture first names the id, released by `history purge` on what no history row names — kept on the live set while capture is on) — and a row leaves only when no holder remains, so an id whose rows are gone stays in use as long as anyone holds it; this replaced the `blocks ∪ block_changes ∪ resurrection_pool` union and the squash's keep-the-earliest-`block_changes`-row rule (`block_changes` is a pure projection again). The birthday bound made this real: a 3,000-document ingest collided at 360,338 blocks (`spec/store` §10). The same seam lets conformance runners install a sequential minter (and the repeating one that pins the redraw).
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
  settings     TEXT NOT NULL DEFAULT '{}',-- JSON: sync.quiescence_ms, matcher thresholds, embedding config, feed.* retention…
  epoch        TEXT NOT NULL              -- v17 (D7): the change feed's epoch, an 'ep_' id minted with the repo; a cursor is (epoch, seq)
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
  head          TEXT,                      -- the head token (schema v17, D1): an r_ id the core mints on every change — content,
                                           -- structure, path or liveness; equals revisions.rev_id while history is captured;
                                           -- the CAS token (`rev`/`_rev`/`expect.revision`); `current_rev` through v16
  file_hash     BLOB,                      -- sha256 of the bytes the head renders to (convergence check)
  conflicted    INTEGER NOT NULL DEFAULT 0,-- git conflict markers present; mutations refused
  leading_trivia TEXT NOT NULL DEFAULT '', -- bytes before the first block (document-leading trivia; 03 §2.3)
  frontmatter_raw TEXT,                    -- the frontmatter block's raw, fences included (v17, D10: the current value — never a delta; NULL = none)
  frontmatter_trivia TEXT,                 -- separator between frontmatter and first body block (NULL = no frontmatter)
  created_at    TEXT NOT NULL,             -- the identity's birth: the first commit's ts; survives tombstone and revival (v17, D6)
  updated_at    TEXT NOT NULL,             -- the ts of the commit that last minted the head (a move and a tombstone count)
  deleted_at    TEXT,                      -- tombstone; NULL = live (`deleted_commit` through v16)
  UNIQUE (repo_id, path)
);
-- Adapter-extracted properties (frontmatter, inline key:: value, computed _title/_tags)
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
  raw           TEXT NOT NULL,             -- the block's raw source, inline (v17, D10; through v16 only `blobs` held it)
  raw_hash      BLOB NOT NULL,             -- sha256(raw): the CAS and dedup key (and the recorder's blobs key)
  norm_hash     BLOB NOT NULL,
  trivia        TEXT,                      -- trailing trivia, inline (NULL = none)
  trivia_hash   BLOB,                      -- sha256(trivia) (NULL = no trivia)
  created_at    TEXT NOT NULL,             -- the identity's birth, CARRIED across edits, resurrection (the pool row keeps it) and cross-doc moves (v17, D6)
  updated_at    TEXT NOT NULL,             -- the block's own last change: the commit's ts unless its verdict was `same` (14.2's rule)
  deleted_at    TEXT                       -- always NULL since store 17.3: a tombstone DELETES the doc's rows (D2 step two); the column stays for the partial indexes
);
CREATE INDEX idx_blocks_doc      ON blocks(doc_id, parent_block, order_key) WHERE deleted_at IS NULL;
CREATE INDEX idx_blocks_type     ON blocks(repo_id, type)                   WHERE deleted_at IS NULL;
CREATE INDEX idx_blocks_rawhash  ON blocks(raw_hash);
CREATE INDEX idx_blocks_ancestor ON blocks(doc_id, ancestor_path);

-- The recorder's (v17, D10): written only by the history capture, read only by
-- the history reads (docs_read { at }, docs_diff*); no current read touches it.
-- With legacy capture on (every repository through Phase 3) the head's bytes
-- therefore exist twice — on the rows above and here.
CREATE TABLE blobs (
  hash   BLOB PRIMARY KEY,                 -- sha256(raw bytes)
  bytes  BLOB NOT NULL,
  size   INTEGER NOT NULL
);

-- Merkle tree nodes. entries: canonical JSON array of
--   [block_id, raw_hash_hex, child_tree_hash_hex|null, type, attrs_json, trivia_ref|null]
-- or, since schema v16, a DELTA over the same list of the document's previous
-- revision: {"d":[["=",n],["~",<entry>],["+",<entry>],["-"]]} (spec/store §4.1).
CREATE TABLE tree_nodes (
  hash    BLOB PRIMARY KEY,                -- sha256(canonical entries serialization)
  entries TEXT NOT NULL
);

CREATE TABLE revisions (
  rev_id           TEXT PRIMARY KEY,
  doc_id           TEXT NOT NULL REFERENCES docs(doc_id),
  seq              INTEGER NOT NULL,       -- per-document, dense from 1 (never deleted, even when archived)
  root_tree        BLOB,                   -- a tree_nodes.hash (a full or, since v16, a delta node); NULL once archived (schema v15, spec/store §7.1)
  frontmatter_blob BLOB,                   -- raw YAML text incl. fences, or (v16) a {"f":…} line delta over the previous revision's; NULL if none, or archived
  rendered_hash    BLOB NOT NULL,          -- sha256 of the full rendered file bytes
  path             TEXT NOT NULL,          -- path at this revision (doc moves tracked here)
  commit_id        TEXT NOT NULL REFERENCES commits(commit_id),
  archive          TEXT,                   -- the archive segment holding the bodies; NULL = live (v15)
  UNIQUE (doc_id, seq)
);

-- The archive-segment registry (schema v15, spec/store §7.1): one row per
-- segment file `omg history export --prune` recorded or `omg history attach`
-- registered. A revision's `archive` may name a segment this table no longer
-- carries (detached): reading its bytes is then `revision_archived`.
CREATE TABLE archives (
  segment_id     TEXT PRIMARY KEY,         -- a minted `s_` id, the segment's manifest id
  repo_id        TEXT NOT NULL REFERENCES repos(repo_id),
  path           TEXT NOT NULL,            -- the file as recorded
  seq_lo         INTEGER NOT NULL,         -- commits.seq span of the archived commits
  seq_hi         INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  revision_count INTEGER NOT NULL,
  bytes          INTEGER NOT NULL          -- the file's size when recorded
);

-- The recorder's commit row (v17, D7/M5): the log's copy of the core's `feed`
-- row below — the same commit_id, epoch and seq — plus `ops`, the ADR-003
-- intent record only the recorder keeps. Never pruned (the log is history).
CREATE TABLE commits (
  commit_id     TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(repo_id),
  epoch         TEXT NOT NULL,             -- the feed row's epoch
  seq           INTEGER NOT NULL,          -- = the feed row's seq
  ts            TEXT NOT NULL,             -- ISO-8601 UTC
  origin        TEXT NOT NULL CHECK (origin IN ('api','observed','import','projection')),
                                             -- 'projection' reserved for projected queries (09-…); unused in v1
  actor         TEXT,                      -- 'agent:…' | 'human:…' | NULL for observed
  reason        TEXT,                      -- api commits: caller-supplied intent string
  batch_id      TEXT NOT NULL,             -- the feed row's batch_id (D4); `checkpoint_id` through v16
  ops           TEXT,                      -- api commits: the intent record of the admitted plan (canonical JSON)
  UNIQUE (repo_id, epoch, seq)
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

-- Authored edges — the OPEN relations only (v17, M6 — spec/graph 3.0 §3.3):
-- closing an edge deletes its row; the interval record (from_commit / to_commit,
-- v16's columns) is the history bundle's edge_transitions below.
CREATE TABLE edges (
  edge_id     TEXT PRIMARY KEY,            -- 'e_' + base32
  repo_id     TEXT NOT NULL,
  src_doc     TEXT NOT NULL,
  src_block   TEXT,                        -- NULL ⇒ frontmatter-origin
  src_field   TEXT,                        -- frontmatter key or inline-field key; NULL for plain links
  predicate   TEXT NOT NULL,               -- 'references' | any authored predicate
  dst_kind    TEXT NOT NULL CHECK (dst_kind IN ('document','block','external')),
  dst_node    TEXT NOT NULL,               -- node id; external nodes minted per normalized URI
  anchor      TEXT,                        -- link anchor/fragment text if present
  provenance  TEXT NOT NULL CHECK (provenance IN ('link','frontmatter','inline_field','projected',
               'yaml_ref','yaml_schema','yaml_extends','json_ref','json_schema')),
                                           -- 'projected' reserved for projected queries (09-…); unused in v1
  via_node    TEXT                         -- NULL for authored edges; query block id for projected (reserved, v1-unused)
);
CREATE INDEX idx_edges_src ON edges(src_doc, predicate);
CREATE INDEX idx_edges_dst ON edges(dst_node, predicate);

-- Edge intervals (v17, the history bundle's — spec/store §3.1): v16's edges row
-- verbatim, written when the core opens an edge (to_commit NULL) and closed when
-- it deletes one; dst_node follows the open edge's in-place rewrites (adoption).
CREATE TABLE edge_transitions (
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
  to_commit   TEXT                         -- NULL = still open
);
CREATE INDEX idx_edge_transitions_temporal ON edge_transitions(from_commit, to_commit);

CREATE TABLE external_nodes (
  node_id   TEXT PRIMARY KEY,              -- 'x_' + base32
  repo_id   TEXT NOT NULL,
  uri       TEXT NOT NULL,                 -- normalized (lowercase scheme/host, no default port, no fragment)
  title     TEXT,
  UNIQUE (repo_id, uri)
);

-- (`collections` — created and never written through v16 — was dropped in v17, D9;
-- `col_` stays a reserved prefix with no table.)

-- The change feed (v17, D7/M5 — spec/store §3.1, §5.4 step 5, §7.4): the CORE's
-- record of every commit within retention — what `changes_since` pages and the
-- sync base rests on; it depends on no history table. One slim row per commit,
-- one entry per touched document. `seq` is dense from 1 per (repo, epoch); a
-- cursor is (epoch, seq); a cursor from another epoch, past the head or behind
-- the oldest retained row is `expired_cursor` and the consumer rescans
-- (spec/sync §6). Retention: floors feed.retain_days (10) / feed.retain_entries
-- (10000) pruned by gc, cap feed.max_entries (100000) enforced at write time —
-- "the feed is catch-up, a rescan is recovery, the log is history".
CREATE TABLE feed (
  repo_id   TEXT NOT NULL REFERENCES repos(repo_id),
  epoch     TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  commit_id TEXT NOT NULL UNIQUE,          -- the minted c_ id; the recorder's commits.commit_id is the same
  ts        TEXT NOT NULL,
  origin    TEXT NOT NULL CHECK (origin IN ('api','observed','import','projection')),
  actor     TEXT,
  reason    TEXT,
  batch_id  TEXT NOT NULL,                 -- D4: the first committing member of the same observed batch (= commit_id for a batch of one and every api commit)
  plan_id   TEXT,                          -- resolution 3: the admitted plan's digest for an effect-driven api commit
  PRIMARY KEY (repo_id, epoch, seq)
);
CREATE INDEX idx_feed_ts ON feed(repo_id, ts);

CREATE TABLE feed_entries (
  repo_id   TEXT NOT NULL,
  epoch     TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  doc_id    TEXT NOT NULL,
  path      TEXT NOT NULL,                 -- as of the commit
  head      TEXT,                          -- the token minted (NULL for deleted)
  hash      BLOB,                          -- file_hash after the commit (NULL for deleted)
  kind      TEXT NOT NULL CHECK (kind IN ('created','changed','deleted','moved')),
  from_path TEXT,                          -- moved only
  PRIMARY KEY (repo_id, epoch, seq, doc_id)
);
-- (The v16 `checkpoints` table — one row per observed batch — is gone, D4: the
-- batch's identity is the feed's batch_id and its record the repository's
-- sync_state status row below.)

-- Recorded intent of an api commit's working-tree effect (store 14.0): the row
-- is inserted in the commit's transaction and deleted after the file is
-- written/renamed/removed, so a crash between the two is replayable with the
-- intent intact (spec/store §5.7). Self-contained since v17 (M4): the replay
-- renders from the current rows and recognises the engine's own stale file by
-- `prior_hash`; no history table is read. One row per path; PK (repo_id, path).
CREATE TABLE pending_materializations (
  repo_id       TEXT NOT NULL REFERENCES repos(repo_id),
  path          TEXT NOT NULL,              -- where the file must end up
  kind          TEXT NOT NULL CHECK (kind IN ('write','rename','remove')),
  from_path     TEXT,                       -- rename: the old path
  doc_id        TEXT NOT NULL REFERENCES docs(doc_id),
  head          TEXT,                       -- write/rename: the head token whose bytes the row renders; NULL for remove (v17: no FK)
  rendered_hash BLOB NOT NULL,              -- the bytes expected at path (remove: the bytes it is safe to unlink)
  prior_hash    BLOB,                       -- v17: the bytes the engine itself last wrote at path (what a crash leaves); NULL when none
  commit_id     TEXT NOT NULL,              -- the api commit that recorded it (v17: no FK — commits is the recorder's)
  created_at    TEXT NOT NULL,              -- v17: that commit's ts
  PRIMARY KEY (repo_id, path)
);

-- Identity claims (spec/store §2.1, v17): one row per id the core has minted; holders bit 0 = core, bit 1 = recorder.
CREATE TABLE id_claims (
  id        TEXT PRIMARY KEY,
  repo_id   TEXT,                           -- NULL for a workspace-scoped id (a source)
  prefix    TEXT NOT NULL,
  minted_at TEXT NOT NULL,
  holders   INTEGER NOT NULL
);
-- no secondary index: the claims prune (gc-time) and the size line (on demand) scan; the index was half the bytes of every minted id (2026-10-26)

-- The capability manifest (spec/store §3.1, v17 slice 3e-ii): one row per (repository, capability).
CREATE TABLE capabilities (
  repo_id          TEXT NOT NULL REFERENCES repos(repo_id),
  capability       TEXT NOT NULL CHECK (capability IN ('history','semantic')),
  state            TEXT NOT NULL CHECK (state IN ('enabled','disabled')),
  interface_v      INTEGER NOT NULL,            -- history 1, semantic 1
  data_v           INTEGER NOT NULL,            -- the bundle's schema version (1)
  config           TEXT NOT NULL DEFAULT '{}',  -- canonical JSON: semantic { model?, dim? }, history {}
  config_hash      BLOB NOT NULL,               -- sha256(config)
  coverage         TEXT NOT NULL DEFAULT '[]',  -- [{ "from": ts, "to": ts | null }, …], the last open iff enabled
  writer_requires  INTEGER NOT NULL DEFAULT 0,  -- 1: a writer without the module refuses (resolution 17)
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (repo_id, capability)
);

-- The alert channel (spec/store §3.1, §5.8, v17 slice 3e-ii): a condition that needs a human, kept while it stands.
CREATE TABLE alerts (
  repo_id    TEXT NOT NULL REFERENCES repos(repo_id),
  code       TEXT NOT NULL,                      -- materialization_backlog | materialization_failed | writer_refused
  severity   TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
  message    TEXT NOT NULL,
  since      TEXT NOT NULL,                      -- first raised; kept across re-raises
  detail     TEXT NOT NULL DEFAULT '{}',         -- canonical JSON
  cleared_at TEXT,                               -- NULL = active
  PRIMARY KEY (repo_id, code)
);

CREATE TABLE resurrection_pool (
  block_id       TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  doc_id         TEXT NOT NULL,            -- document it was deleted from
  raw_hash       BLOB NOT NULL,
  norm_hash      BLOB NOT NULL,
  type           TEXT NOT NULL,
  created_at     TEXT NOT NULL,            -- carried from the deleted row; a resurrection restores it (v17, D6)
  deleted_at     TEXT NOT NULL,            -- the deleting commit's ts (v17; deleted_commit through v16)
  expires_ts     TEXT NOT NULL             -- default now + 30 days (config)
);

-- Property index (properties-table). One row per property value; the unified
-- query surface for frontmatter, inline (key:: value), and computed (_title/_tags)
-- document properties, superseding the former docs.metadata blob. Current-state,
-- maintained transactionally at ingest alongside blocks (repopulated by re-ingest,
-- NOT by rebuild-index — see docs/properties-table.md §6), hence durable rather than derived.
CREATE TABLE properties (
  prop_id        TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  doc_id         TEXT NOT NULL,
  block_id       TEXT,                     -- NULL = document-scoped (frontmatter, computed)
  source         TEXT NOT NULL CHECK (source IN ('frontmatter','inline','computed')),
  key            TEXT NOT NULL,            -- dotted, flattened: 'layer','meta.owner'; computed carry '_title'
  card           TEXT NOT NULL CHECK (card IN ('scalar','list')), -- authored shape (scalar ==/</> vs list())
  ord            INTEGER NOT NULL DEFAULT 0,
  val_text       TEXT,
  val_num        REAL,
  val_bool       INTEGER,
  val_json       TEXT,
  type           TEXT NOT NULL CHECK (type IN ('string','number','bool','null','json'))
  -- v17 (D9): no created_commit/deleted_commit — a property row is live exactly while its
  -- document's rows are (the commit deletes and rewrites them per document).
);
CREATE INDEX idx_props_doc      ON properties(doc_id);
CREATE INDEX idx_props_key_text ON properties(repo_id, key, val_text);
CREATE INDEX idx_props_key_num  ON properties(repo_id, key, val_num);
CREATE INDEX idx_props_src_key  ON properties(repo_id, source, key);

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
  repo_id          TEXT NOT NULL,
  source_id        TEXT NOT NULL,          -- '' reserved for the repository's own status row (v17, D4)
  path             TEXT NOT NULL,          -- '' reserved for the attachment-level cursor row
  revision         TEXT,                   -- last-observed source revision for this path
  cursor           TEXT,                   -- last poll/webhook cursor (attachment-level row)
  last_batch_ts    TEXT,                   -- the status row only (spec/sync §4.1): the last observed batch's ts
  last_batch_id    TEXT,                   -- its batch_id (NULL when nothing committed)
  last_batch_files INTEGER,                -- its member count
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

-- Per-block history projection (answers blocks_history cheaply).
CREATE TABLE block_changes (
  block_id  TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  PRIMARY KEY (block_id, commit_id, kind)
);

-- (`inferred_edges` — a stub no writer or reader ever reached — was dropped in v17, D9.
-- Inferred relations, when they come, get their own table in a later schema.)

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

**Delta nodes (schema v16, `spec/store` §4.1 "Delta nodes", §4.4 "Checkpoints").** A sibling list (the root, a container's children) may instead be stored as `{"d":[ops]}` and a revision's frontmatter as a blob `{"f":[ops]}` — a delta over the *same* list / frontmatter of the document's previous revision (`seq − 1`; the base is implicit, no base hash is stored), the ops Myers' shortest edit script grouped into `["=",n]` keep, `["~",x]` replace, `["+",x]` insert, `["-"]` drop (`x` a six-element entry, or a frontmatter line with its ending). The first byte tells the forms apart (`[`/`-` full, `{` delta). A revision is a **checkpoint** — every list full and self-contained, the frontmatter raw — at `(seq − 1) % 16 == 0`, when it has no live predecessor, and per list whenever the delta would not be strictly smaller; so a reader walks back at most 15 revisions. A delta node is content-addressed like any node but meaningful only in its revision's context, so a revision reuses its predecessor's node only when that node is self-contained (an unchanged list over a delta base writes the identity delta `{"d":[["=",n]]}`, one shared row). Why: a Merkle list costs ~170 B per entry per revision (~77 B per part for a frontmatter decomposed into parts — the measured dead end of branch `2f7b286`), so a journal logline rewrote a 6.8 KB root; as deltas, 379 B. The migration from v15 is empty — every v15 node already is a checkpoint form — and the major exists only to keep a v15 reader out. The hot `docs_read` path reads `blocks` and resolves only the frontmatter; `docs_read_at`, `docs_diff` and the materializer resolve the tree.

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

## 6a. The git history provider (store 17.5, modular-core Phase 6a)

A repository's history is kept by one provider — the recorder's tables above, or (`spec/store` §5.12) a **bare Git
repository at `<workspace>/.omgbase/git`** outside the database. The `capabilities` row says which: `config.provider`
absent is the native recorder, `{ provider: "git", git_dir, branch, cadence, ids_ref, remote }` the git provider. A
git-provider repository writes **no history table** (its commits write `feed`/`feed_entries` alone; `anyHistoryEnabled`
— the opener's rule for the history bundle's DDL — counts native rows only) and keeps one reserved `sync_state` row,
`(repo_id, '$git', '')` — `revision` the branch tip's sha, `cursor` `{ epoch, seq }` — as the cache of the checkpoint
worker's position (the truth is the tip commit's `omgbase-seq` trailer). The bare repository's objects are the
provider's bytes: `git count-objects -v` beside `doctor --size` is the honest comparison (`docs/modular-core/baseline.md`
§3). Nothing in the schema changed for it; the provider's data model is Git's — blobs of the documents' accepted bytes at
their paths, one commit per feed row (or per fold) carrying the trailers of `spec/store` §5.12.

## 7. Retention & GC

- Default retention: keep every revision and commit row forever; bodies older than the policy below move to archive segments on demand (nothing moves until `omg history export --prune` is run). The measurement that motivated it: a 131 MB database over 5 MB of Markdown held 57 MB of history — a whole Merkle root per revision (no sharing across revisions; schema v16's delta nodes, §5.1, are the answer to that half), uncompressed blobs.
- `dispositions` / `block_changes` hold one row per verdict that **changed** a block (`spec/store` §5.4 step 10, 14.2): `inserted`, `edited`, `moved`, `edited_moved`, `deleted`, the split/merge/copy lineage, `resurrected`, `bulk_rewrite`. A `same` verdict — the block's raw bytes, parent and sibling index unchanged — is produced by the matcher (and, since 14.2, by the api path's known-id resolver, which classifies carries the same way instead of stamping every carried block `edited`) and counted in the observe outcome, but never persisted. Consequences: a block's `_updated_at` (the surface attribute: `MAX(commits.ts)` over its `block_changes`) is the block's own last change, not its siblings'; `blocks_history` lists the commits that changed it; through v16 the first revision's `inserted` row was what kept a block id out of the mint oracle's reuse set after its row was gone (v17: the `id_claims` row does, with the recorder's bit set by that very row). Through 14.1 every verdict was persisted — about 18.5 rows per revision on a real repository, nine in ten `same`, 11 MB of `dispositions` plus 5–7 MB of `block_changes` nothing read. "Present and unchanged in commit X" is `docs_diff` over two revisions now.
- `omg gc`'s default sweep (`spec/store` §7, 14.2) deletes a pre-14.2 database's `same` rows from both tables and reports `sameDispositionsSwept`; `--dry-run` counts them; `doctor --size` carries `same_dispositions` and advises the sweep past 25 % of the table. Deliberately a sweep, not a migration: no `user_version` for a data-only change, and opening a database never bulk-deletes.
- **History retention (schema v15, `spec/store` §7.1, as built).** History is never lost, but old bodies need not stay hot: `omg history export --prune` moves the *bodies* (blobs, tree nodes) of the revisions a **retention policy** selects into an **archive segment** — one new SQLite file per run under `.omgbase/archives/` (`<repo_id>-<seq_lo>-<seq_hi>-<segment_id>.omgarchive.db`, DDL `spec/store/archive.sql`: the same table subset plus a `manifest` row with the segment id, repo, clock, policy, commit range, revision count, the previous segment of the chain and the schema version) — then **squashes** the store in one transaction: the archived revisions keep their `revisions` and `commits` rows (the `revisions` OQX target, `docs_history` and `changes_since` keep listing them; `revisions.seq` stays dense) and lose `root_tree`/`frontmatter_blob`, gaining `archive = <segment_id>`; the wholly archived commits' `dispositions` and `block_changes` go — every row since v17 (through v16 each block's earliest `block_changes` row stayed because the mint oracle read that table; the recorder's hold on the id's `id_claims` row keeps an archived block's id known now); the GC mark-and-sweep (now "from every live revision root") reclaims the bodies; the segment is recorded in `archives` and as the repo's `history.last_segment` setting. Two phases on purpose: the segment is complete (written to `.partial`, fsynced, chmod 0444, renamed) before a row moves, and a complete unrecorded segment whose revisions are still live is finished by the next run (the crash rule; an export without `--prune` leaves exactly that state).
- **The policy** (`history.retention` in the effective settings; `--policy` overrides per run): `keep_days` (younger revisions kept), a `ladder` of `{ after_days, keep: "one per day|week|month|year" }` rungs (beyond `keep_days`, the newest revision of each period per rung is kept; a revision below the first rung's age is kept), `per_doc_max` (the newest N of a document kept), `keep_origins` (a commit with that origin and a non-empty reason is kept), `overrides` (`{ glob, … }` per path). Never prunable: a document's current revision (a tombstoned document's last revision is its current one); v17 retired the pin on a revision a `pending_materializations` row named — the row renders from the current rows (spec/store §5.7). The first revision of a document is *not* protected: the earliest-row rule above protects every minted id instead. `omg history plan` prints the evaluation with the bytes only the archived revisions reach.
- **Reading archived history.** `docs_read { at }`, `docs_read_at`, `docs_diff` and `docs_diff_unified` on an archived revision `ATTACH` its segment on demand (read-only; alias `arc_<segment_id>`) and reconstruct through it, byte for byte; when the segment is not recorded (`omg history detach`) or not on disk the read fails `revision_archived { rev, archive, path? }` until `omg history attach <file|dir>` records it again. `omg history list` shows every segment's commit range, revisions, bytes and state (`attached`, `missing`, `pending`, `detached`, `stale`). Archived dispositions are not read back through a segment (yet): `blocks_history` lists the live rows. Compression is at rest (`zstd` the file); a compressed segment is not attachable.
- **Delta nodes and retention (schema v16, `spec/store` §4.4 "Base liveness", §7, §7.1).** The GC mark is *explicit*: a node marks the objects its own text names (every entry of a full node, the `+`/`~` entries of a delta) and never resolves a delta; what a delta keeps "as the base" is the previous revision's to mark, and the previous revision of a live delta revision is always live — the squash maintains that by re-writing a kept revision in checkpoint form (every list full, the frontmatter raw; `squashed.checkpointed` counts them) before archiving its predecessor. Archive segments hold checkpoint forms only (computed from the resolved trees at export), so a segment never walks back into the store; `archive.sql` is unchanged.
- `omg gc` (flag-gated, off by default) is the same mark-and-sweep from the live revision roots; after a squash it finds nothing, since the squash swept inside its own transaction. `omg doctor --size` reports `archived { revisions, segments, bytes }` and advises `omg history export --prune` when the policy would archive more than a tenth of the history pages.
- `resurrection_pool` rows expire by `expires_ts` (= `deleted_at` + 30 days — v17 anchors the expiry on the row's own timestamp, not on a commit's) via lazy sweep at checkpoint time; a row carries the deleted block's `created_at` (v17) so a resurrected block keeps its birth; a pooled or swept id keeps its `id_claims` row.
- **Store 17.1, Phase 4a (`spec/store` §3.1 "Which bundles a database holds", §5.4 steps 0 and 15, §5.9; `phase-1-contracts.md` §1.14, §1.15, §7 resolutions 17 and 18) — capture is optional.** No DDL change. A fresh database executes the core bundle alone plus the semantic bundle when the engine carries the semantic module (its reads probe the tables unguarded); the history bundle's DDL runs when a repository's `history` row becomes `enabled` (`ensureRepo` with the recorder, `omg history enable`) and by the opener when any repository is enabled — one database holds every repository, the tables are harmless when unused. A commit hands the recorder its rows only while the repository's row is `enabled` (`captureFor(db, repoId)` in `core/store/manifest.ts`); with capture off the head is minted, the feed row and entry written, claims get bit 0 alone, and no history row appears. `omg history enable` writes the baseline (an `import` feed row + `commits` row, a checkpoint revision per live head the recorder does not hold, the holds, the edge intervals reconciled) and opens a coverage interval; `omg history disable` closes it and leaves the rows (`history purge` is 4b). `omg source add --no-history` and a core-only build create repositories with capture off. A writer without the history module on an enabled repository with `writer_requires` is refused outside the transaction (`capability_unavailable { history, unavailable }` + `writer_refused`). A recorder that throws inside a commit rolls the member back (`CaptureFailed` → the `capture_failed` alert and envelope, the next sweep retries; `BatchResult.failed`). The recorder's writers and collection live in `core/store/history-writers.ts` and `history-gc.ts`; no SQL outside `graph/history.ts`, `core/store/{archive,retention,delta,history-writers,history-gc}.ts`, `core/capabilities/history.ts`, the DDL and the migration names a history table (`dependency-direction.test.ts`). `OMGBASE_CAPABILITIES=core` is a test-only override that runs the engine as a core-only build (no recorder, no semantic module).
- **Store 17.2, Phase 4b (`spec/store` §5.10, §7.6, §5.8 `feed_capped`; `spec/surface` §3's decision table; `phase-1-contracts.md` §1.14, §2.1, §2.2, §7 resolution 11) — purge, the semantic lifecycle, the read states.** No DDL change. `omg history purge [--before <ts>]` removes the recorder's rows per commit (`purgeHistoryRows` in `core/store/history-gc.ts`, reached through `HistoryRecorder.purge`): while capture is on a live head's revision and its commit stay, the first retained revision after a cut is re-checkpointed (the squash's `checkpointDependents`), closed-before-the-cut edge intervals go and open ones are re-anchored at the earliest retained commit, segments nothing names are detached, the bodies swept, the recorder's hold (bit 1) released on every claim no history row names (kept on the live set while capture is on), and the bundle's tables dropped when no repository is enabled and every history table is empty — the manifest's `state`/`coverage` are untouched (coverage records when capture was on; it is what tells `pruned` from `outside_coverage`). The history reads (`docs_read { at }`, `docs_read_at`, `docs_diff*`, CLI `diff`) answer a token the recorder lacks by `historyReadRefusal` (`core/store/manifest.ts`): no module → `unavailable`; the recorder holds it for another document, or nobody minted it on an enabled repository → `target_missing`; disabled repository and the claim after the last interval (or no claim) → `disabled`; `id_claims.minted_at` in no interval → `outside_coverage` (with `coverage_from`); inside an interval with no row → `pruned`. `docs_history` always lists the current head (`retained: false` with the feed row's commit when the recorder has no row) and carries `coverage`. `omg embed enable [--provider] | disable` flip the semantic manifest row (`enableSemantic`/`disableSemantic`); a settings write re-derives it only when the effective `embedding.provider` changed (`sync/settings.ts`), so a `disable` survives unrelated writes; `ensureRepo` no longer re-derives an existing row. The write-time feed cap raises `feed_capped` (`core/store/feed.ts`), a gc whose cap pass prunes nothing clears it; `doctor --size` prints the feed-cap advice from the alert.
- **Store 17.4, Phase 5a-ii (`spec/store` §3.4 step 17 (2), (15), (16), §5.8 `legacy_bytes`, §5.11, §8 C9; `spec/sync` §4.3 step 5; `spec/cli` §6 `doctor`) — legacy bytes, the FTS index through the migration.** No DDL change. The 16 → 17 migration rebuilds the FTS index over the new rows, the 17.x finish step purges the index entries of the tombstoned rows it deletes (only those `blocks_fts_docsize` holds), and step 17 (16) runs the fidelity check — per live document `sha256(reconstruct) == file_hash` (`core/store/legacy-bytes.ts`: `unreproducibleDocs`; in full at the 16 → 17 entry point, behind `legacyBytesSuspected`'s cheap signature of legacy rows at the on-open one) — raising the `legacy_bytes` alert with `{ docs, sample }`. `doctor`'s `bytes reproducible` re-derives it in full; the freshness sweep's step 5 (`sync/freshness.ts` → `sync/legacy-bytes.ts` `repairLegacyBytes`), while the alert is active, rewrites the separator columns (`blocks.trivia`/`trivia_hash`, `docs.leading_trivia`/`frontmatter_trivia`) of every named document whose file is present and hashes to `file_hash`, from the file's parse, positionally — no commit, no head, no `updated_at`; the recorder's capture stays the 16.x one — and reports `repaired`. Found by the Phase 5 qualification on a copy of a real 16.x workspace whose blocks predate schema v6's `trivia_hash`.
- **Schema v17, slice 3e-ii (`spec/store` 17.0 — the last Phase 3 slice; `phase-1-contracts.md` §1.5, §7 resolutions 1, 17, 18 and the alert channel).** Two core tables. `capabilities` is the per-repository **manifest** (one row per capability: state, interface/data version, the config and its sha256, the coverage intervals capture was on, `writer_requires`), written by `ensureRepo` — `history` enabled from the repository's birth with `writer_requires = 1`, `semantic` enabled iff `embedding.provider` resolves (vectors never consulted) — and by migration 17 for every existing repository (the history interval from its first commit); until Phase 4's `history`/`embed` verbs, every settings write re-derives the `semantic` row. `version.capabilities`, `capability_unavailable`'s state, `doctor --size`'s `capabilities` member (and its `history  enabled since <ts>` / `semantic  enabled (<model>)` lines) read it; every write entry point runs the `writer_requires` check first (`requireWriter` — trivially true on every 17.0 composition; the refusal is `capability_unavailable { history, unavailable }` plus a `writer_refused` alert). `alerts` is the **alert channel**: `raiseAlert` (idempotent, `since` kept), `clearAlert`, `activeAlerts` (which re-derives the derivable condition — the materialization backlog, pending rows older than `recovery.alert_after_minutes`, default 10); a replay that throws raises `materialization_failed`. Every MCP tool result that is a JSON object carries the active alerts as a trailing `alerts` member when there are any; the CLI prints `alert[<severity>] <code>: <message>` to stderr after a verb; `doctor` has an `alerts` check. Both tables file under `sync` in the size report; the claims-share advice line joins it. The recorder-only store suites (`garbage`, `delta`, `retention`) live under `spec/store/cases/history/`.
- **Schema v17, slice 3e-i (`spec/store` 17.0 — M6, D9; `spec/graph` 3.0).** The DDL is three files — `spec/store/schema.sql` (the core bundle), `schema-history.sql` (the recorder's), `schema-semantic.sql` — all three executed on every fresh database through Phase 3 (`DDL`, `HISTORY_DDL`, `SEMANTIC_DDL` in `schema.ts`). `edges` holds the open relations alone: closing an edge deletes its row, and the recorder keeps the interval record in `edge_transitions` (written from the transition's edge list the core hands it inside the commit; `dst_node` follows adoption); no edges reader filters an interval any more. Dropped: `properties.created_commit`/`deleted_commit` and the partial predicates, `collections` (and `edges.dst_kind`'s `'collection'`), `inferred_edges`, `idx_edges_temporal`. `doctor --size` has six categories — `content`, `identity` (`id_claims`, `resurrection_pool`), `recovery` (`pending_materializations`), `history`, `search`, `sync` — and a `feed { epoch, oldest, head, entries, retain_days, retain_entries, max_entries }` member. The epoch re-mint of a restore / rebuild-from-files is `spec/store` §7.5 (`Store.remintEpoch`: a new `ep`, the feed emptied, the next commit `seq = 1`; no production path takes it yet). Migration 17 extended in place (edges copied into `edge_transitions`, rebuilt open-only; properties rebuilt; the two tables dropped).
- **Schema v17, slice 3b (`spec/store` 17.0 — M3/D5).** `id_claims` as above; the claims prune: `omg gc` under a repository's (or the workspace's) `identity.claims_retain_days` clears the core's bit on every claim older than the window that names no core row (`docs`/`docs.head`, `blocks`, `resurrection_pool`, `pending_materializations.head`, `external_nodes`, `edges`, `repos`, `sources`) and deletes the rows left with no holder — so with history on nothing is ever re-mintable, and with history off (or after `history purge`) an old deleted block's id may come back, which only an unguarded read by name can notice (every guarded write fails `stale_expectation`/`target_missing`). `GcResult.claimsReleased`; `doctor --size` reports `id_claims` (the identity's growth — one row per id ever minted, filed under `history` until Phase 3e's six categories). Migration 17 backfills the table from every id the current rows and the history still name, with bit 1 where a history row names it.
- **Schema v17 (`spec/store` 17.0, modular-core Phase 3a).** The current state is self-contained: `docs.head` (the head token the core mints on every change — content, structure, path or liveness; a `docs_move` mints one and is captured as a revision of the unchanged tree at the new path, a delete mints none), `docs.frontmatter_raw`, `blocks.raw`/`trivia` inline, `created_at`/`updated_at`/`deleted_at` on docs and blocks. No current read touches `blobs`, `revisions`, `tree_nodes`, `commits`, `block_changes` or the delta resolver; those tables are the recorder's capture, written on every commit while legacy capture is on and checked to AGREE with the head (`spec/store` §8 H1/H3). The core owns no byte GC: the mark-and-sweep above is the recorder's over its own revisions, and nothing a `blocks` row holds can be swept. Migration 17 rebuilds `docs`/`blocks`/`resurrection_pool` from the v16 history tables (`spec/store` §3.4).
- `pending_materializations` rows live only between an api commit and its file write; the materializer (phase B' of the write, the freshness sweep's step 0, `recoverRepo`) or the next observation of the path deletes them. A long-lived row means a crashed write nobody has swept yet; it is never garbage, and there is no cap: unresolved recovery work is never discarded for a storage limit (v17, spec/store §5.7). **Schema v17, slice 3c (M4).** The row is self-contained: `head` (the token whose bytes it renders; replaces `rev_id`, no FK), `prior_hash` (the bytes the engine last wrote at the path, captured at commit from the `file_hash` the transaction validated against), `created_at`; `commit_id` without its FK. The materializer renders from the current rows (`reconstruct`), `recoverRepo` compares the disk to `docs.file_hash`, retention pins nothing for a pending row, and a later request to the same path supersedes the row — a write replaces the target and keeps the earliest `prior_hash`, a rename carries the obligation of a write at `from_path`, a remove drops the write.

## 8. Postgres dialect notes (deferred; do not build in v1)

BLOB→bytea, TEXT JSON→jsonb, FTS5→tsvector+GIN, brute-force Float32 vectors→pgvector(HNSW), fractional keys unchanged, recursive CTEs unchanged. The repository layer isolates dialect; nothing above the storage module may contain dialect-specific SQL.
