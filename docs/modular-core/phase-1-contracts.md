# Modular core — Phase 1: the contracts, as paste-ready spec text

Phase 1 of the modular-core program ("pin contracts"). This document is the
proposal of `README.md` §5 written out as the spec sections it becomes: every
rule, error shape and DDL below is phrased in the voice of the existing
`spec/*/README.md`s so that the Phase 3/4 implementer edits the specs by
moving these sections in. **Phase 1 changes no on-disk behaviour**; nothing
under `spec/`, `packages/` or `crates/` is touched by this document. Each
section names the decision (D1–D11) and mechanism (M1–M7) of `README.md`
§3–§4 it realises; `path:line` citations are into `inventory-ts.md` /
`inventory-rust.md`. Where a decision left a choice open, the choice taken
here is marked **(decided here)** and listed again in §7; where it could not
be taken, it is an **open point** (§7) and the text says so where it bites.

Organisation: §1 `spec/store` (the store major, 17.0), §2 `spec/surface`,
§3 `spec/mutate`, §4 `spec/sync`, §5 `spec/graph`, §6 the fixture plan, §7
the open points. The spec versions these land as: store **17.0** (DDL), surface
**6.0** (a result key changes meaning — `rev`; `changes_since`'s cursor gains
a member), mutate **4.1** (vocabulary restated, no shape change), sync **4.0**
(`checkpoints` leaves; the feed cursor gains `epoch`), graph **3.0**
(`edges` loses two columns the fixtures project).

---

## 1. spec/store — the core bundle (store 17.0)

### 1.0 What moves in the preamble

Replace the first paragraph's "owns **identity, history and the current
state**" with:

> The store is the embedded SQLite database that owns the **current state
> and the identity** of a repository of authored files, and — through two
> optional **capabilities**, each a bundle of tables with its own owner —
> its **history** (the recorder: an append-only capture of every accepted
> transition) and its **semantic index** (the embedding caches). Files stay
> the source of truth for *content*; the core adds stable block ids, the
> current bytes of every document, a bounded change feed, and the derived
> indexes the query surfaces read. At quiescence `sha256(file) ==
> docs.file_hash`. The core never reads a capability's tables; a capability
> reads the core's through the read API and is written **inside the core's
> transaction** by a recorder the core calls (§5.4 step 15).

`schema.sql` becomes three files, each embedded verbatim by both engines
(§3.3 rule unchanged, applied to each): **`schema.sql`** (the core bundle),
**`schema-history.sql`** (the history bundle) and **`schema-semantic.sql`**
(the semantic bundle); `archive.sql` stays. The opener executes the core file
on a fresh database and a capability's file **when that capability is
enabled for any repository or is being enabled** (§1.1 below); `user_version`
is the core major (`17`). The schema fingerprint fixture (`cases/schema.json`)
gains two cases, `history` and `semantic`, each the fingerprint of a fresh
database with that one bundle added; `fresh` is the core alone.

### 1.1 Placement and connection — additions

After step 4 of "Opening a database":

5. Read the `capabilities` table (§3.1). For every row with `state =
   'enabled'` whose bundle's tables are absent (a database copied without
   them, or a fresh enable) execute that bundle's DDL. For every row with
   `writer_requires = 1` whose module this build does not carry, the
   connection is **read-only for that repository**: every write path fails
   `capability_unavailable { capability, state: "unavailable", retriable:
   true }` before it mints anything (§2.1). A build without the semantic
   module registers no `cosine` function; the function moves to the semantic
   bundle's registration (`README.md` §6).

### 1.2 Ids — §2.1 "Uniqueness at mint" rewritten over `id_claims` (M3, D5)

Replace the paragraph from "The store therefore never lets a production mint
return an id that is **in use**" to its end with:

> The store therefore never lets a production mint return an id that is
> **in use**: one it has already issued in this process, or one that names
> an **`id_claims`** row (§3.1). **Every mint writes a claim** `(repo_id,
> prefix, id, minted_at = the transaction's ts, holders)` in the same
> transaction that uses the id, before the row that carries it; a mint whose
> transaction rolls back leaves no claim (the id is simply never used — the
> counter does not roll back, §5.3). `holders` is a bitmask: bit 0 (`1`) the
> **core** — set by every core mint (`d`, `b`, `c`, `r`, `x`, `e`, `rp`,
> `src`, `ep`); bit 1 (`2`) the **recorder** — set when the history
> capability first writes a row naming the id (its `revisions`, `commits`,
> `dispositions`, `block_changes`, `edge_transitions`, `archives` rows; a
> recorder mint, `s`, sets bit 1 alone). A claim is **released** per holder,
> never deleted while any holder remains: the core releases its hold by the
> **claims prune** (§7), the recorder by `history purge` (§7.3) and never by
> the squash. An id whose row is gone stays in use as long as a holder keeps
> the claim — this is what replaces the squash's earliest-`block_changes`-row
> rule (15.0) and the `blocks ∪ block_changes ∪ resurrection_pool` probe. The
> probe is **one statement** for every prefix: `SELECT 1 FROM id_claims WHERE
> id = ?`. A redraw is unobservable except through `"minter": "repeat"`
> (§9.4). `col` and `v` have no table and no check; `cp` is retired (D4:
> `checkpoints` is gone, nothing mints it). `ep` (17.0) is the repository
> **epoch** (§3.1 `repos`).

Prefix table: add `ep` epoch; strike `cp` checkpoint and `col` collection
(`collections` is dropped, D9; `col` stays reserved-with-no-table). The
sentence "A block id's `block_changes` row is what keeps it known…" is
struck.

### 1.3 Time — §2.4 additions

The timestamp columns are `docs.created_at`/`updated_at`/`deleted_at`,
`blocks.created_at`/`updated_at`/`deleted_at`, `resurrection_pool.deleted_at`/
`expires_ts`, `id_claims.minted_at`, `feed.ts`, `pending_materializations.
created_at`, `sync_state.last_batch_ts`, `capabilities.updated_at` and the
history bundle's `commits.ts`. The store derives `expires_ts = deleted_at +
30 days` (unchanged arithmetic; the anchor moves from `commits.ts` to the
row's own column — M3).

### 1.4 Schema — §3.1 "Durable tables" restated per bundle

Every table names its **bundle** (core / history / semantic) and its **GC
roots** (M7: what keeps its rows; "none" = never collected; "own" = its own
retention rule, §7). A runner compares a bundle's tables only when the
composition under test includes it (§6).

#### 1.4.1 Core bundle (`schema.sql`)

| Table | Bundle | One row per | Meaning | GC roots |
| --- | --- | --- | --- | --- |
| `repos` | core | repository | `repo_id`, unique `slug`, `settings`, **`epoch`** (17.0, D7: a minted `ep_` id — minted at `ensure_repo`, re-minted by a **restore** or a **rebuild-from-files** (§7.4); the feed's `seq` is dense **within an epoch**; a cursor from another epoch is expired, §5.8) | none |
| `docs` | core | path ever seen in a repo | `doc_id`; `path`; `format`; **`head`** (D1, M1: the head token — an `r_` id the core mints on every head change, §5.4 step 6; NULL only before the first commit of a new row — never for a live doc; equal to the recorder's `revisions.rev_id` when history is enabled); `file_hash` (of the bytes the head renders to); `conflicted`; `leading_trivia`; `frontmatter_trivia`; **`frontmatter_raw`** (D10, M1: the frontmatter block's raw including its fences, NULL when none — the current value, never a delta); **`created_at`** (D6, M2: the identity's birth — the first commit's `ts`; survives tombstone and revival); **`updated_at`** (the `ts` of the commit that last minted the head — content, structure, path or liveness, D11); **`deleted_at`** (the tombstone; NULL = live — replaces `deleted_commit`). A path keeps its `doc_id` across deletion and re-creation (§5.6) | none (a tombstone row stays forever: it is the identity) |
| `blocks` | core | live or (through Phase 3) tombstoned block of the **current** head | `block_id`, `doc_id`, `parent_block`, `order_key`, `ordinal`, `depth`, `ancestor_path`, `type`, `attrs`, `text`, **`raw`** (D10: the block's raw source, UTF-8), `raw_hash` (= `sha256(raw)`, the CAS and dedup key), `norm_hash`, **`trivia`** (NULL = none), `trivia_hash` (= `sha256(trivia)` or NULL), **`created_at`** (D6: carried — from the previous live row, the pool row or the evicted foreign row; the commit's `ts` for an `inserted` id), **`updated_at`** (the block's own last change: set to the commit's `ts` iff the block's verdict is not `same` — 14.2's rule), **`deleted_at`** (D2 step 1: a tombstoned document's rows keep their shape with `deleted_at` set; Phase 4 stops writing them, §5.6). `created_commit` and `deleted_commit` are gone (M2) | none (rebuilt wholesale per commit; tombstoned rows leave with Phase 4) |
| `id_claims` | core | id ever minted | §2.1: `repo_id`, `prefix`, `id`, `minted_at`, `holders` | own: the claims prune (§7.2) releases the core's hold; a row leaves when `holders = 0` |
| `resurrection_pool` | core | block deleted in an earlier commit | `block_id`, `doc_id` it left, `raw_hash`, `norm_hash`, `type`, **`created_at`** (D6: carried from the deleted row so a resurrection restores it), **`deleted_at`** (the deleting commit's `ts`; replaces `deleted_commit`), `expires_ts = deleted_at + 30 days`. Feeds `spec/reconcile` phase 6b; rows leave when consumed, evicted or swept | own: the sweep (§5.5) |
| `pending_materializations` | core | file the `api` path still owes the disk | `repo_id`, `path`, `kind ∈ {write, rename, remove}`, `from_path`, `doc_id`, **`head`** (the token whose bytes the row renders; informational, no FK — a row always names the document's current head, §5.7), `rendered_hash` (the bytes expected at `path`; `remove`: the bytes it is safe to unlink), **`prior_hash`** (M4: the hash the commit validated the file against — `write`: the file at `path` before the commit, NULL when absent; `rename`: the file at `from_path`; `remove`: NULL — the materializer's "prior bytes"), `commit_id` (the feed row's `c_` id, no FK), **`created_at`**. No `rev_id`, no FK to any history table (the 14.0 FK is gone; `migrateV15`'s `foreign_keys = OFF` dance with it) | none (deleted per file by the materializer) |
| `feed` | core | commit to the repo, within retention | **(17.0, D7, M5)** `repo_id`, `epoch`, `seq` (dense from 1 per `(repo, epoch)`), `commit_id` (the minted `c_`; the recorder's `commits.commit_id` is the same id), `ts`, `origin ∈ {api, observed, import, projection}`, `actor`, `reason`, `batch_id` (D4: the `commit_id` of the **first committing member of the same observed batch**, so a batch of one and every `api` commit have `batch_id = commit_id` — **decided here**, §7). The name **`feed`**, not `commit_log` (**decided here**): the row is the *delivery* record `changes_since` pages and `feed.*` settings bound (D7 already names the settings `feed.retain_days` …); `commits` keeps its name in the history bundle, where "log" belongs ("the feed is catch-up, a rescan is recovery, the log is history") | own: feed retention (§7.1) |
| `feed_entries` | core | document touched by a feed row | `repo_id`, `epoch`, `seq`, `doc_id`, `path` (as of the commit), `head` (the token minted, NULL for `deleted`), `hash` (`file_hash` after the commit; NULL for `deleted`), `kind ∈ {created, changed, deleted, moved}` (`created`: the doc row was inserted or revived; `moved`: the path changed — with or without content change, D11; `changed`: everything else that minted a head), `from_path` (`moved` only). PK `(repo_id, epoch, seq, doc_id)` | with its feed row |
| `edges` | core | **open** link relation | `edge_id`, `repo_id`, `src_doc`, `src_block`, `src_field`, `predicate`, `dst_kind ∈ {document, block, external}` (`collection` struck with `collections`, D9), `dst_node`, `anchor`, `provenance`, `via_node`. **Open rows only** (M6): closing an edge **deletes** the row; `from_commit`, `to_commit` and `idx_edges_temporal` are gone; `idx_edges_src`/`dst` lose their `WHERE`. `has_anchor` needs no filter (D8) | none |
| `external_nodes`, `properties`, `nodes`, `sections`, `doc_edges`, `blocks_fts`, `nodes_fts` | core | — | as 16.0, except `properties` loses **`created_commit` and `deleted_commit`** (D9, M2: never read non-NULL; the four partial indexes lose their `WHERE`) | none / derived |
| `capabilities` | core | (repository, capability) | **(17.0)** the manifest, §1.5 | none |
| `adapters`, `sources`, `attachments`, `sync_state`, `workspace_settings`, `file_stats` | core | — | the sync registry, as 16.0; `sync_state` gains the status columns of D4 (§1.6) | none |

**Dropped objects (D9):** `checkpoints` (D4), `collections`, `inferred_edges`,
`idx_edges_temporal`, `commits.checkpoint_id`, `properties.created_commit`,
`properties.deleted_commit`, `blocks.created_commit`, `blocks.deleted_commit`
→ `deleted_at`, `docs.current_rev` → `head`, `docs.deleted_commit` →
`deleted_at`, `resurrection_pool.deleted_commit` → `deleted_at`,
`pending_materializations.rev_id`, `edges.from_commit`/`to_commit`. TS
`search/cel/compile.ts` is deleted (code only, no spec text).

#### 1.4.2 History bundle (`schema-history.sql`) — the recorder's

| Table | One row per | Meaning | GC roots |
| --- | --- | --- | --- |
| `commits` | captured transition | `commit_id` (= the feed row's), `repo_id`, `epoch`, `seq` (= the feed's), `ts`, `origin`, `actor`, `reason`, `batch_id`, `ops` (the ADR-003 intent record of an `api` commit, M5). `UNIQUE (repo_id, epoch, seq)`; no `checkpoint_id` | none (never deleted; `history purge` empties the bundle) |
| `revisions` | (document, captured commit) | `rev_id` (= the head token the core minted, D1), `doc_id`, per-document `seq` from 1 (continues across a disable/enable gap), `root_tree`, `frontmatter_blob`, `rendered_hash`, `path` (**immutable** — D11: a move captures a new revision), `commit_id`, `archive`. As 16.0 otherwise | none |
| `tree_nodes`, `blobs` | distinct node / byte string | as 16.0. **Entirely the recorder's** (D10): the core reads no blob; `raw`/`trivia`/`frontmatter_raw` live inline on the core rows | the explicit mark from live revisions (§7.3) |
| `dispositions`, `block_changes` | (commit, block, kind) | as 16.0; `block_changes` is derived from `dispositions`, and the squash may **empty** a wholly archived commit's rows (the earliest-row rule is retired, M3) | rebuild |
| `edge_transitions` | edge interval | **(17.0, M6)** `edge_id`, `repo_id`, `src_doc`, `src_block`, `src_field`, `predicate`, `dst_kind`, `dst_node`, `anchor`, `provenance`, `via_node`, `from_commit`, `to_commit` — 16.0's `edges` row verbatim, written when the core opens an edge (`to_commit = NULL`) and closed when it deletes one | none |
| `archives` | archive segment | as 16.0 | none |

#### 1.4.3 Semantic bundle (`schema-semantic.sql`)

| Table | One row per | Meaning | GC roots |
| --- | --- | --- | --- |
| `embeddings` | (content_hash, ctx_hash, model) | as 16.0; `content_hash = blocks.raw_hash` | own: the drain's prune |
| `doc_embeddings` | (doc_id, model) | as 16.0 | own |

The `cosine(a, b)` SQL function is registered by this bundle's module
(`README.md` §6).

### 1.5 The capability manifest — `capabilities` (plan §5)

A **table, not `workspace_settings` keys (decided here)**: settings are the
user's layer — deep-merged workspace → repo (`spec/sync` §3), rewritten
wholesale by `omg config set` — whereas the manifest is engine-written state
that must survive a settings rewrite, be typed, be projected by a fixture
row for row, be read by `doctor` without resolving settings, and be
compared by the schema fingerprint. One row per `(repo_id, capability)`:

```sql
CREATE TABLE IF NOT EXISTS capabilities (
  repo_id          TEXT NOT NULL REFERENCES repos(repo_id),
  capability       TEXT NOT NULL CHECK (capability IN ('history','semantic')),
  state            TEXT NOT NULL CHECK (state IN ('enabled','disabled')),
  interface_v      INTEGER NOT NULL,          -- the capability interface the writer implements (history 1, semantic 1)
  data_v           INTEGER NOT NULL,          -- the bundle's own schema version (history 1 = 16.0's tables + edge_transitions; semantic 1)
  config           TEXT NOT NULL DEFAULT '{}',-- the configuration the data was produced under (semantic: { model, dim }; history: {})
  config_hash      BLOB NOT NULL,             -- sha256(canonical JSON of config) — the fingerprint
  coverage         TEXT NOT NULL DEFAULT '[]',-- JSON [{ "from": ts, "to": ts | null }, …]: the intervals capture was on
  writer_requires  INTEGER NOT NULL DEFAULT 0,-- 1: a writer without this module must refuse writes (§1.1 step 5)
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (repo_id, capability)
);
```

Rules: (1) a repository with no row for a capability is `disabled` with
`coverage = []`; (2) `coverage` is a list of half-open intervals in the
store's time format, the last one open (`to: null`) iff `state = 'enabled'`;
(3) `coverage_from` (what `version` reports, §2.3) is the first interval's
`from`, null when none; (4) `config_hash` changing while `state = 'enabled'`
is a **rebuild** of the capability's data (semantic: a model switch — the
drain's prune, `spec/search`; history: no config, never); (5) the row is
written only by `history enable|disable|purge` and `embed enable|disable`
(the CLI verbs, `spec/cli`) and by the migration (§3.4 step 17).

### 1.6 `sync_state` gains the sync status (D4)

`checkpoints` collapses to **one reserved row per repository** of
`sync_state`: `(repo_id, source_id = '', path = '')` (**decided here** — D4
says "on the sync state"; the reserved `source_id = ''` row exists so a
**sourceless** repository — every `checkpoint.json` fixture — has one too),
with three new nullable columns on the table: `last_batch_ts` (the batch
`ts`), `last_batch_id` (the batch's `batch_id`, §1.4.1 `feed` — NULL for a
batch that committed nothing), `last_batch_files` (the member count). Written
by every observed batch, in the batch's last transaction (or its own, when
nothing committed), together with the pool sweep — the 2.1 "row and sweep in
one transaction" rule kept. `files` and `git_head` are gone (D9).

### 1.7 The DDL — `schema.sql` (core), verbatim

```sql
-- ---- core bundle: durable tables (spec/store 17.0 §3.1) ---------------------
CREATE TABLE IF NOT EXISTS repos (
  repo_id   TEXT PRIMARY KEY,
  slug      TEXT NOT NULL UNIQUE,
  settings  TEXT NOT NULL DEFAULT '{}',
  epoch     TEXT NOT NULL                     -- a minted ep_ id; re-minted by restore / rebuild-from-files (§7.4)
);

CREATE TABLE IF NOT EXISTS docs (
  doc_id             TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL REFERENCES repos(repo_id),
  path               TEXT NOT NULL,
  format             TEXT NOT NULL DEFAULT 'markdown',
  head               TEXT,                    -- the head token (an r_ id); equals revisions.rev_id when history is enabled
  file_hash          BLOB,
  conflicted         INTEGER NOT NULL DEFAULT 0,
  leading_trivia     TEXT NOT NULL DEFAULT '',
  frontmatter_raw    TEXT,                    -- the frontmatter block's raw, fences included (NULL = no frontmatter)
  frontmatter_trivia TEXT,                    -- separator between frontmatter and first body block (NULL = no frontmatter)
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS id_claims (
  id        TEXT PRIMARY KEY,
  repo_id   TEXT NOT NULL,
  prefix    TEXT NOT NULL,
  minted_at TEXT NOT NULL,
  holders   INTEGER NOT NULL                  -- bit 0 core, bit 1 recorder (§2.1)
);
CREATE INDEX IF NOT EXISTS idx_claims_repo_prefix ON id_claims(repo_id, prefix, minted_at);

CREATE TABLE IF NOT EXISTS resurrection_pool (
  block_id   TEXT PRIMARY KEY,
  repo_id    TEXT NOT NULL,
  doc_id     TEXT NOT NULL,
  raw_hash   BLOB NOT NULL,
  norm_hash  BLOB NOT NULL,
  type       TEXT NOT NULL,
  created_at TEXT NOT NULL,                   -- carried from the deleted row (D6)
  deleted_at TEXT NOT NULL,
  expires_ts TEXT NOT NULL                    -- deleted_at + 30 days
);

CREATE TABLE IF NOT EXISTS pending_materializations (
  repo_id       TEXT NOT NULL REFERENCES repos(repo_id),
  path          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('write','rename','remove')),
  from_path     TEXT,
  doc_id        TEXT NOT NULL REFERENCES docs(doc_id),
  head          TEXT,                         -- the token whose bytes the row renders (NULL for remove); no FK
  rendered_hash BLOB NOT NULL,
  prior_hash    BLOB,                         -- the file hash the commit validated against (M4)
  commit_id     TEXT NOT NULL,                -- the feed row's c_ id; no FK
  created_at    TEXT NOT NULL,
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
  batch_id  TEXT NOT NULL,
  PRIMARY KEY (repo_id, epoch, seq)
);
CREATE INDEX IF NOT EXISTS idx_feed_ts ON feed(repo_id, ts);

CREATE TABLE IF NOT EXISTS feed_entries (
  repo_id   TEXT NOT NULL,
  epoch     TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  doc_id    TEXT NOT NULL,
  path      TEXT NOT NULL,
  head      TEXT,
  hash      BLOB,
  kind      TEXT NOT NULL CHECK (kind IN ('created','changed','deleted','moved')),
  from_path TEXT,
  PRIMARY KEY (repo_id, epoch, seq, doc_id)
);

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

CREATE TABLE IF NOT EXISTS capabilities (
  repo_id          TEXT NOT NULL REFERENCES repos(repo_id),
  capability       TEXT NOT NULL CHECK (capability IN ('history','semantic')),
  state            TEXT NOT NULL CHECK (state IN ('enabled','disabled')),
  interface_v      INTEGER NOT NULL,
  data_v           INTEGER NOT NULL,
  config           TEXT NOT NULL DEFAULT '{}',
  config_hash      BLOB NOT NULL,
  coverage         TEXT NOT NULL DEFAULT '[]',
  writer_requires  INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (repo_id, capability)
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
  prop_id  TEXT PRIMARY KEY,
  repo_id  TEXT NOT NULL,
  doc_id   TEXT NOT NULL,
  block_id TEXT,
  source   TEXT NOT NULL CHECK (source IN ('frontmatter','inline','computed')),
  key      TEXT NOT NULL,
  card     TEXT NOT NULL CHECK (card IN ('scalar','list')),
  ord      INTEGER NOT NULL DEFAULT 0,
  val_text TEXT,
  val_num  REAL,
  val_bool INTEGER,
  val_json TEXT,
  type     TEXT NOT NULL CHECK (type IN ('string','number','bool','null','json'))
);
CREATE INDEX IF NOT EXISTS idx_props_doc      ON properties(doc_id);
CREATE INDEX IF NOT EXISTS idx_props_key_text ON properties(repo_id, key, val_text);
CREATE INDEX IF NOT EXISTS idx_props_key_num  ON properties(repo_id, key, val_num);
CREATE INDEX IF NOT EXISTS idx_props_src_key  ON properties(repo_id, source, key);

-- ---- core bundle: the sync registry (spec/sync) --------------------------------
CREATE TABLE IF NOT EXISTS adapters (
  name     TEXT PRIMARY KEY,
  command  TEXT NOT NULL,
  args     TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  adapter   TEXT NOT NULL REFERENCES adapters(name),
  config    TEXT NOT NULL DEFAULT '{}',
  env       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS attachments (
  repo_id   TEXT NOT NULL REFERENCES repos(repo_id),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  PRIMARY KEY (repo_id, source_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  repo_id          TEXT NOT NULL,
  source_id        TEXT NOT NULL,            -- '' reserved for the repository's own status row (D4)
  path             TEXT NOT NULL,            -- '' reserved for the attachment-level cursor row
  revision         TEXT,
  cursor           TEXT,
  last_batch_ts    TEXT,                     -- the repository row only (spec/sync §4.1)
  last_batch_id    TEXT,
  last_batch_files INTEGER,
  PRIMARY KEY (repo_id, source_id, path)
);

CREATE TABLE IF NOT EXISTS workspace_settings (
  id       INTEGER PRIMARY KEY CHECK (id = 0),
  settings TEXT NOT NULL DEFAULT '{}'
);
INSERT OR IGNORE INTO workspace_settings (id, settings) VALUES (0, '{}');
```

### 1.8 The DDL — `schema-history.sql`, verbatim

```sql
-- ---- history bundle (spec/store 17.0 §3.1, the recorder's) -------------------
CREATE TABLE IF NOT EXISTS commits (
  commit_id TEXT PRIMARY KEY,
  repo_id   TEXT NOT NULL REFERENCES repos(repo_id),
  epoch     TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  ts        TEXT NOT NULL,
  origin    TEXT NOT NULL CHECK (origin IN ('api','observed','import','projection')),
  actor     TEXT,
  reason    TEXT,
  batch_id  TEXT NOT NULL,
  ops       TEXT,
  UNIQUE (repo_id, epoch, seq)
);

CREATE TABLE IF NOT EXISTS revisions (
  rev_id           TEXT PRIMARY KEY,
  doc_id           TEXT NOT NULL REFERENCES docs(doc_id),
  seq              INTEGER NOT NULL,
  root_tree        BLOB,
  frontmatter_blob BLOB,
  rendered_hash    BLOB NOT NULL,
  path             TEXT NOT NULL,
  commit_id        TEXT NOT NULL REFERENCES commits(commit_id),
  archive          TEXT,
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
```

`archive.sql` is unchanged except `commits` loses `checkpoint_id` and gains
`epoch`/`batch_id` (the copy rule "same columns as the store's" holds).

### 1.9 The DDL — `schema-semantic.sql`, verbatim

```sql
-- ---- semantic bundle (spec/store 17.0 §3.1; spec/search) -----------------------
CREATE TABLE IF NOT EXISTS embeddings (
  content_hash BLOB NOT NULL,
  ctx_hash     BLOB NOT NULL,
  model        TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  vec          BLOB NOT NULL,
  PRIMARY KEY (content_hash, ctx_hash, model)
);

CREATE TABLE IF NOT EXISTS doc_embeddings (
  doc_id     TEXT NOT NULL,
  model      TEXT NOT NULL,
  input_hash BLOB NOT NULL,
  method     TEXT NOT NULL CHECK (method IN ('whole','pooled')),
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  PRIMARY KEY (doc_id, model)
);
```

### 1.10 §4 Canonical encodings — what moves

§4.1 "Tree-node entries", "Delta nodes", §4.2 "Blob bytes" and §4.4
"Checkpoints" move under a new heading **§4′ The recorder's encodings** with
one change of subject: "the writer (§5.4 steps 1 and 4) decides it" becomes
"the recorder (§5.4 step 15) decides it from its own previous captured
revision". §4.3 (order keys, containment), §4.5 (text, attrs) and §4.6
(sections) stay the core's. The core's `blocks.raw`/`trivia` and
`docs.frontmatter_raw` are the UTF-8 strings §4.2 describes, stored inline.

### 1.11 §5 Observation restated (M1, M2, M3, M5)

§5.1–§5.3 are unchanged except: §5.1 step 1 "`deleted_commit IS NULL`" reads
"`deleted_at IS NULL`"; §5.1 "Load the pool" reads rows "with `expires_ts >
ts`" as before (the anchor is `deleted_at`, §2.4). §5.2 "the old tree, from
the store" reads `raw` **from the row** (`blocks.raw`), not from `blobs`.

**§5.4 Pass 2 — commit, in batch order, one transaction per member** becomes:

0. **Nothing to read.** The core numbers and hashes the head without a
   previous revision (M1); step 0 of 16.0 is the recorder's (step 15).
1. **Frontmatter.** `frontmatter_raw` = the frontmatter block's `raw`, or
   NULL without one.
2. **Doc row.** If no `docs` row exists for `(repo, path)`: **mint `d`**
   (claim it), insert `(doc_id, repo_id, path, format, head = NULL,
   leading_trivia, frontmatter_raw, frontmatter_trivia, created_at = ts,
   updated_at = ts, deleted_at = NULL)`; else update `format`,
   `leading_trivia`, `frontmatter_raw`, `frontmatter_trivia`, set
   `deleted_at = NULL` (§5.6 "Re-creation") and leave `created_at` (D6: a
   revival keeps the identity's birth). The entry `kind` for step 5 is
   `created` when the row was inserted or revived, else `changed`.
3. **Assign ids** — unchanged.
4. **(struck — the tree is the recorder's.)**
5. **Feed row.** **Mint `c`** (claim it); `seq = 1 + max(seq)` over the
   repo's `feed` rows of the current `epoch` (0 when none); insert `(repo_id,
   epoch, seq, commit_id, ts, origin = 'observed', actor = NULL, reason =
   NULL, batch_id)` — `batch_id` = this batch's first committing member's
   `commit_id` (this one, when it is the first). Then the entry: `(repo_id,
   epoch, seq, doc_id, path, head = step 6's token, hash = sha256(source),
   kind, from_path = NULL)` — written after step 6 mints the token, inside
   the same transaction.
6. **Head token.** **Mint `r`** (claim it) — the head token for this
   transition (D1). Minted on **every** commit that renders the document:
   content, structure, path (D11) or liveness (a revival). A tombstone
   (§5.6) mints none.
7. **Pool the deleted.** For each id in the result's `deleted`, in order:
   `INSERT OR REPLACE` into `resurrection_pool` the doc's `blocks` row of
   that id (any `deleted_at`) as `(block_id, repo_id, doc_id, raw_hash,
   norm_hash, type, created_at = the row's, deleted_at = ts, expires_ts = ts
   + 30 days)`.
8. **Evict foreign rows** — unchanged in effect; the carried row's
   `created_at` is **remembered** for step 9 (D6).
9. **Refresh the blocks.** Delete every `blocks` row of this doc (FTS first),
   then insert one row per body block in pre-order with `raw`, `raw_hash`,
   `trivia`, `trivia_hash` (NULL/NULL when the trivia is empty), the
   placement columns of §4.3, `created_at` = (a) the previous live row's
   when the block's verdict is a carry (`same`, `edited`, `moved`,
   `edited_moved`), (b) the pool row's when it is `resurrected`, (c) the
   evicted foreign row's for a cross-document move, (d) `ts` for `inserted`
   and the lineage kinds (`split_from`, `merged_into`, `copied_from`,
   `bulk_rewrite`) — a new identity is born now; `updated_at` = the previous
   live row's when the verdict is `same`, else `ts`; `deleted_at = NULL`.
   Then `sections` and the FTS rows as before.
   9b, 9c unchanged, except 9c **deletes** a closed edge and writes nothing
   to any `*_commit` column (M6; `spec/graph` §3.3); `properties` rows carry
   no commit column.
10. **(struck — dispositions are the recorder's.)** The verdict list goes to
    step 15.
11. **Consume the pool** — unchanged.
12. **Pointers.** `UPDATE docs SET head = <step 6>, file_hash =
    sha256(source), updated_at = ts`.
13. **Converged** = `render(tree) == source` **and** `reconstruct(doc) ==
    source` (§6.1; the `file_hash == rendered_hash` clause is gone with the
    column — I1 below).
14. **Conflict flag** — unchanged.
15. **Capture (M5, D1).** If the repository's `history` capability is
    `enabled` and the module is loaded, the core hands the recorder the
    **accepted transition** — an immutable value the recorder may not alter
    — inside the same transaction, after step 14 and before COMMIT:

    ```text
    Transition {
      repo_id, epoch, commit: { commit_id, seq, ts, origin, actor, reason, batch_id, ops | null },
      docs: [ { doc_id, path, from_path | null, head, prev_head | null, kind,
                rendered_hash, leading_trivia, frontmatter_raw | null, frontmatter_trivia | null,
                tree: [ { block_id, parent_block | null, ordinal, type, attrs, raw, trivia } … ]  // pre-order, the new tree
                deleted_ids: [block_id…], verdicts: [ { block_id, kind, confidence, reason, matcher_v, detail } … ] } … ]
    }
    ```

    The recorder writes `commits` (the same `commit_id`, `epoch`, `seq`),
    per document `revisions` (`rev_id = head`, `seq` = 1 + its own greatest
    for the doc, `root_tree`/`frontmatter_blob` per §4′ from **its own**
    previous captured revision, `rendered_hash`, `path`, `commit_id`), the
    blobs and nodes, and every verdict whose kind is not `same` into
    `dispositions`/`block_changes` (14.2's rule, now the recorder's), and
    sets bit 1 on every claim it names. **A failure inside the recorder
    rolls back the whole transaction** (the mutation is refused, the member
    is not committed; an observed batch reports the member's error and the
    next sweep retries) — enabled capture is part of the write. With the
    capability disabled or the module absent, step 15 is skipped; with it
    `writer_requires = 1` and the module absent the write never starts
    (§1.1 step 5).

The outcome and the api path paragraphs are unchanged except that "every
document's step 6 names that commit" reads "every document's feed entry
names that feed row" and the pending row paragraph is §5.7's below. Mint
order per member is **unchanged**: `b` (pass 1), `d`, `c`, `r`, `x`, `e` —
so no fixture id moves.

**§5.5 Sweep** unchanged (`expires_ts <= ts`).

**§5.6 Observed deletion (tombstone), D2 in two steps.** In one transaction:

1. **Mint `c`** (claim it); insert a feed row `(…, origin = 'observed',
   reason = 'observed deletion', batch_id)` and one entry `(doc_id, path,
   head = NULL, hash = NULL, kind = 'deleted')`.
2. `INSERT OR REPLACE` every live block of the doc into `resurrection_pool`
   with `created_at` = the row's, `deleted_at = ts`, `expires_ts = ts + 30
   days`.
3. Delete the doc's FTS rows; **Phase 3 (step one of D2):** `UPDATE blocks
   SET deleted_at = ts WHERE doc_id = ? AND deleted_at IS NULL`; **Phase 4
   (step two):** `DELETE FROM blocks WHERE doc_id = ?` instead — the rows'
   bytes are the recorder's business (its last revision holds them), the ids
   stay claimed (§2.1), the pool holds what phase 6b needs. `UPDATE docs SET
   deleted_at = ts, updated_at = ts` — `head` is **kept** (the token of the
   last rendered state; CAS against it fails on liveness, §3 below).
4. Capture (step 15) receives the transition with `kind = 'deleted'`, an
   empty `tree` and the `deleted_ids`; the recorder writes the commit and
   no revision (D11: a delete mints none).

No head token is minted. **Re-creation** reconciles against an empty old
tree (Phase 3: the tombstoned rows are not live; Phase 4: there are none),
revives the row (`deleted_at = NULL`, `created_at` kept), mints a head and a
`created` entry.

**§5.7 Materialization and pending rows (M4).** The commit records one row
per path it owes the disk: `write` for every ingested document (`head` = its
new token, `rendered_hash = sha256(source)`, `prior_hash` = the hash the
transaction validated the file at `path` against, NULL when the file was
absent), `rename` for a moved document (`from_path`, `head` = the moved
document's new token — D11 — `rendered_hash` its bytes, `prior_hash` = the
validated hash of the file at `from_path`), `remove` for a deleted document
(`head = NULL`, `rendered_hash` = `docs.file_hash` before the tombstone,
`prior_hash = NULL`), `commit_id`, `created_at = ts`. **Bytes are
`reconstruct(doc)` (§6.1) — from current state**: a row always names its
document's current head (a later commit to the path replaces the row), and
§6.1 is byte-exact for the head. The materializer accepts at `path` nothing,
the bytes hashing to `rendered_hash`, or the bytes hashing to **`prior_hash`**
(the engine's own stale file after a crash); anything else is foreign and
the row is kept. The action table of 16.0 holds with "the prior bytes" read
as `prior_hash`. A row whose `reconstruct(doc)` does not hash to
`rendered_hash` (the head moved under it — impossible while the replace
rule holds, checked anyway) is kept for a later materializer. **The gate
rule** is unchanged in every outcome: it compares the observed bytes to
`rendered_hash`, never to any history row.

### 1.12 §6 Reads restated (D10, M1)

**§6.1 Reconstruct (current bytes).** `reconstruct(doc)` for a live doc:
`leading_trivia`, then `frontmatter_raw` followed by `frontmatter_trivia`
when `frontmatter_raw` is not NULL, then for each top-level live block in
`order_key` order its `raw` followed by its `trivia` when not NULL. Every
byte comes from the `docs` and `blocks` rows; **nothing resolves** and no
history table is read. `NULL` for a tombstoned or unknown doc. Equals
`source` by construction (§5.4 step 13).

**§6.2 Reconstruct at a revision** moves whole to the recorder's section
(**§6′**) with the materializer sentence struck ("The materializer (§5.7)
and recovery render … at the row's `rev_id`" is gone); `revision_archived`
is unchanged; `docs_read { at }` on a repository without the capability is
`spec/surface` §2.1's `capability_unavailable`.

### 1.13 §7 Rebuild and garbage restated (M7)

**Rebuild** — `sections`, FTS, `doc_edges` as 16.0; `block_changes` is the
recorder's rebuild (over the commits that are not wholly archived, as 15.0).

**Garbage, per bundle.** The core owns **no byte GC** (D10): there is no
`blobs` row of its own to collect. The core's collections are:

- **§7.1 Feed retention (D7).** Settings (`spec/sync` §3, the workspace
  layer, a repo's over it), every key a non-negative integer:
  `feed.retain_days` (default **10**, floor), `feed.retain_entries` (default
  **10 000**, floor), `feed.max_entries` (default **100 000**, cap). A feed
  row is **prunable** when it is older than `retain_days` (by `ts` against
  the clock) **and** more than `retain_entries` rows of its epoch are newer
  than it; it is **pruned regardless** when more than `max_entries` rows of
  its epoch are newer. Pruning deletes the row and its entries, oldest
  first, and never the row with the greatest `seq`. Rows of a **previous
  epoch** are deleted whole by the epoch mint (§7.4). The prune runs inside
  the transaction that appends a feed row (so a feed never exceeds
  `max_entries + 1` rows) and in `gc`. A `max_entries` below
  `retain_entries` is a malformed policy, refused. The **bootstrap lease**
  (D7) is the floor itself: a consumer that reads `head` at the start of a
  rescan and finishes within both floors is guaranteed `(epoch, head)` is
  still a valid cursor (§5.8); no server-side lease object exists in this
  round (open point 2).
- **§7.2 Claims prune (D5).** Setting `identity.claims_retain_days`
  (default **null** = never). When set, `gc` releases the core's hold (clears
  bit 0) on every claim whose `minted_at` is older than the retention and
  whose id names **no** core row (`docs`, `blocks`, `resurrection_pool`,
  `pending_materializations.head|commit_id`, `feed.commit_id`,
  `feed_entries.head`, `edges`, `external_nodes`, `repos`, `sources`,
  `repos.epoch`); a row whose `holders` reaches 0 is deleted. The result
  reports `claims_released`. Growth is its own size-report line (§7.5).
- **§5.5 Pool sweep** — unchanged.

**§7.3 The recorder's collection** (history bundle): the explicit mark from
every live revision's `root_tree`/`frontmatter_blob` and the sweep of
`blobs`/`tree_nodes`, the `same` sweep, retention plan/export/squash — all
16.0 §7 and §7.1 verbatim, with two changes: the squash's step 2 **deletes
every `block_changes` row of a wholly archived commit** (the earliest-row
exception is gone: the claim holds the id), and the plan's never-prunable
set is rule 1 alone (a pending row names no revision). **An unavailable
recorder never lets `gc` touch its tables**: `gc` on a build without the
history module, or with the capability disabled, reports `history:
"skipped"` and deletes no history row. **`history purge`** (the CLI verb;
`spec/cli`) deletes every history-bundle row of the repository, detaches its
segments (files untouched), clears bit 1 of every claim (deleting those at
0), and sets the manifest `coverage = []`, `state = 'disabled'`; it is never
implied by `disable`.

**§7.4 Epoch mint.** `ensure_repo` mints `ep` and writes `repos.epoch`. A
**restore** (opening a database copied from elsewhere is not detectable;
`omg restore` / `source add --rebuild` are) and a **rebuild-from-files**
(`rebuild-index --from-files`, the recovery that re-ingests every file as a
fresh batch) mint a new `ep`, delete the repository's `feed`/`feed_entries`
rows of every epoch, and append the rebuild's own feed rows under the new
epoch from `seq = 1`. The recorder's `commits` keep their old `epoch`.

**§7.5 Size (D9).** Categories, always the **six**, in this order: **content**
— `docs`, `blocks`, `sections`, `nodes`, `edges`, `doc_edges`,
`external_nodes`, `properties`; **identity** — `id_claims`,
`resurrection_pool`; **recovery** — `pending_materializations`; **history** —
`blobs`, `tree_nodes`, `revisions`, `commits`, `dispositions`,
`block_changes`, `edge_transitions`, `archives`; **search** — `blocks_fts`,
`nodes_fts`, `embeddings`, `doc_embeddings` (FTS is the core's, the vectors
the semantic bundle's — one category, two owners); **sync** — `repos`,
`capabilities`, `feed`, `feed_entries`, `sources`, `adapters`, `attachments`,
`file_stats`, `sync_state`, `workspace_settings`, and anything unnamed. The
report gains `capabilities: { history: { state, coverage_from }, semantic: {
state, model? } }` and `feed: { epoch, oldest, head, entries, retain_days,
retain_entries, max_entries }` beside `archived`; `same_dispositions` stays
(history only; `0` when the bundle is absent). Advice adds `` the feed holds
<n> entries over <d> days (floors <retain_entries> / <retain_days>): raise
feed.max_entries or shorten the sync interval `` when the cap pruned a row
younger than `retain_days` since the last report (a counter the prune
keeps), and `` identity claims are <share> of the database: set
identity.claims_retain_days to release old ids `` when `id_claims` exceeds
10 % of the total. The "history dominates" line is emitted only when the
history bundle is present.

### 1.14 The capture lifecycle (plan §5)

- **`history enable`**: in one transaction — execute the bundle's DDL when
  absent; for every `docs` row (live **and** tombstoned) write a **baseline**:
  one `commits` row `(commit_id = mint c, epoch, seq = the feed's next seq —
  a feed row with `origin = 'import'`, `reason = 'history enabled'` and one
  entry per live doc with `kind = 'changed'` and the **existing** head — is
  appended so the feed and the log agree on `seq`)`, and per live doc a
  `revisions` row `(rev_id = docs.head, seq = 1 + its greatest captured seq,
  checkpoint form from the core rows — root_tree/frontmatter_blob per §4′ with
  no base, rendered_hash = file_hash, path, commit_id)`; a tombstoned doc
  gets no revision. The manifest row: `state = 'enabled'`, `coverage += {
  from: ts, to: null }`, `writer_requires` per the flag given (default 1).
  **The baseline's head tokens are the existing ones** — no head is minted,
  so `docs_read { at: <head> }` works at once and the interop `_rev`s hold.
- **`history disable`**: `coverage[last].to = ts`, `state = 'disabled'`,
  `writer_requires = 0`. Rows stay; reads of what was captured keep working
  (§2.1 `revisions` root); step 15 stops.
- **`history purge`**: §7.3.
- **`embed enable|disable`**: the semantic row likewise (`config = { model,
  dim }` from `embedding.*`); `disable` leaves the vectors; `embed drain
  --prune` is the purge.

### 1.15 §8 Invariants restated

Core (checked by every runner, every composition):

- **C1 Convergence.** For every live doc: `docs.file_hash == sha256(last
  observed source)` and `reconstruct(doc) == source` (§6.1). (On the api path
  the file lags while a pending row exists — §5.7.)
- **C2 Row hashes.** Every `blocks` row: `raw_hash == sha256(raw)`,
  `trivia_hash == sha256(trivia)` or both NULL, `norm_hash == sha256(text)`;
  `attrs` as JSON.
- **C3 Blocks are the head.** For every live doc the live `blocks` rows read
  as a tree are exactly `flatten(parse(source))` with the assigned ids:
  dense `ordinal` per parent agreeing with `order_key`, `depth`/
  `ancestor_path` per §4.3; `render(tree) == source`.
- **C4 Dense feed.** `feed.seq` is a contiguous range `oldest..head` per
  `(repo, epoch)` in `ts`-then-`seq` order, every row's `epoch` equals
  `repos.epoch`, `head ≥ 1` once anything committed, and the prune floors
  hold (no row younger than `retain_days` **and** within the newest
  `retain_entries` is missing unless the cap removed it). Every live doc's
  `head` is non-NULL; every feed entry's `head` (non-NULL) and `doc_id` are
  claims.
- **C5 Claims.** Every id in any core row (every `*_id`, `head`, `parent_block`,
  `src_doc`, `src_block`, `dst_node` that is an id, `via_node`, `commit_id`,
  `batch_id`, `epoch`) names an `id_claims` row with bit 0 set; no claim has
  `holders = 0`.
- **C6 Pool.** Every pool row has `expires_ts == deleted_at + 30 days`, a
  `block_id` with no live `blocks` row, and `created_at ≤ deleted_at`.
- **C7 Timestamps.** `created_at ≤ updated_at` on every doc and block; a
  live doc's `updated_at` equals the `ts` of the feed row whose entry carries
  its `head` **when that row is within retention**; a block's `updated_at`
  is ≤ its document's; `deleted_at` is NULL on a live row and non-NULL on a
  tombstoned one, and no live doc has a tombstoned block.
- **C8 Rebuild equivalence.** `sections`, `doc_edges`, FTS recomputed equal
  the stored rows.
- **C9 Edges are open.** Every `edges` row's `dst_node` is a doc id, an
  `external_nodes` id or `phantom:<path>` with no live doc at that path.
- **C10 Pending rows.** Every pending row's `doc_id` exists, `head` equals
  `docs.head` (or is NULL for `remove`), and `reconstruct(doc)` hashes to
  `rendered_hash` for `write`/`rename`.

History (checked when the composition includes the bundle):

- **H1** For every live doc with `history` enabled and the doc's head minted
  within coverage: a `revisions` row with `rev_id = docs.head`, `rendered_hash
  = file_hash`, `path = docs.path`; reconstruct at it (§6′) `== source`.
- **H2** = 16.0 I2 (hash integrity of blobs and nodes).
- **H3** = 16.0 I3 restated: the live `blocks` rows mirror the **resolved
  tree of the revision `docs.head` names** (ids, types, `raw_hash`es, trivia
  hashes, order) when H1 applies.
- **H4** `commits.seq` per `(repo, epoch)` is a subsequence of the feed's
  `seq` with no duplicates, equal to the feed on every `seq` within coverage
  and retention; `revisions.seq` is `1..k` per doc.
- **H5** = 16.0 I5, I7 (over the commits that are not wholly archived, with
  the earliest-row clause struck), I8, I9 (with "each of its `block_changes`
  rows is its block's earliest" struck — a wholly archived commit has none),
  I10.
- **H6** Every id named by a history row has bit 1 set in `id_claims`;
  every `edge_transitions` row with `to_commit IS NULL` has an `edges` row
  of the same `edge_id` and vice versa.

Semantic: **S1** every `embeddings.content_hash` names a `blocks.raw_hash`
of a live block or is prunable; every `doc_embeddings.doc_id` a live doc.

### 1.16 §3.4 Migration 16 → 17

One step, `17`, in one transaction, `foreign_keys = OFF` for its duration
(the table rebuilds), `PRAGMA foreign_key_check` empty at its end:

1. **`repos`**: add `epoch`; per repo **mint `ep`** (the fixture minter:
   `ep_0`, …; repos in `rowid` order).
2. **`docs` rebuild** (`docs_v17`, copy, drop, rename — SQLite cannot drop
   an indexed/partial-index column in place): `head = current_rev`;
   `frontmatter_raw` = the current revision's **resolved** frontmatter raw
   (§6.1 "Resolving" of 16.0, through the delta chain) or NULL; `created_at`
   = the `ts` of the commit of the doc's `seq = 1` revision; `updated_at` =
   the `ts` of `current_rev`'s commit (a doc with no revision: the
   migration's clock for both); `deleted_at` = the `ts` of `deleted_commit`'s
   commit, else NULL.
3. **`blocks` rebuild**: `raw` = `blobs.bytes` of `raw_hash`, `trivia` =
   `blobs.bytes` of `trivia_hash` (NULL when NULL); `created_at` =
   `MIN(commits.ts)` over the block's `block_changes`, falling back to the
   `ts` of `created_commit`'s commit; `updated_at` = `MAX(commits.ts)` over
   its `block_changes`, same fallback; `deleted_at` = the `ts` of
   `deleted_commit`'s commit, else NULL. A `raw_hash` with no `blobs` row
   (impossible under I5; checked) aborts the migration.
4. **`properties` rebuild** without the two columns; indexes without
   `WHERE`.
5. **`edges`**: copy every row into the history bundle's `edge_transitions`
   (created now, step 9) verbatim; rebuild `edges` with the open rows
   (`to_commit IS NULL`) minus the two columns; drop `idx_edges_temporal`.
6. **`resurrection_pool` rebuild**: `deleted_at` = the `ts` of
   `deleted_commit`'s commit; `created_at` = `MIN(commits.ts)` over the
   block's `block_changes`, else `deleted_at`.
7. **`pending_materializations` rebuild**: `head = rev_id`, `prior_hash` =
   the `rendered_hash` of the revision before `rev_id` (`seq − 1`) for
   `write`/`rename`, NULL otherwise or when none; `created_at` = the `ts` of
   `commit_id`'s commit.
8. **`feed` backfill**: one row per `commits` row `(epoch = the new epoch,
   seq = commits.seq, commit_id, ts, origin, actor, reason, batch_id =
   commit_id)`; entries from `revisions` joined on `commit_id`: `(doc_id,
   path = revisions.path, head = rev_id, hash = rendered_hash, kind =
   'created' when revisions.seq = 1 else 'changed')`; one `deleted` entry per
   `docs` row whose `deleted_commit` is the commit (`path = docs.path`); a
   commit with no revision and no deletion (a `retarget_inbound: false` move)
   gets an entry `kind = 'moved'` only when its `reason` parses as `move <from>
   -> <to>` (`doc_id` = the doc now at `<to>`, `from_path = <from>`). Then
   the feed prune (§7.1) under the defaults — a 1,778-commit real corpus
   keeps every row (`retain_entries` is 10 000).
9. **History bundle**: create its tables (`schema-history.sql`); `commits`
   rebuild adds `epoch` (the new one) and `batch_id = commit_id`, drops
   `checkpoint_id`; `edge_transitions` from step 5.
10. **`id_claims` backfill**: one row per distinct id in `docs.doc_id` (`d`),
    `blocks.block_id` ∪ `block_changes.block_id` ∪ `dispositions.block_id` ∪
    `resurrection_pool.block_id` (`b`), `commits.commit_id` (`c`),
    `revisions.rev_id` (`r`), `external_nodes.node_id` (`x`),
    `edges.edge_id` ∪ `edge_transitions.edge_id` (`e`), `repos.repo_id`
    (`rp`), `sources.source_id` (`src`), `archives.segment_id` (`s`), the new
    epochs (`ep`); `minted_at` = the earliest `commits.ts` naming the id
    (`revisions.commit_id`, `block_changes.commit_id`, `edge_transitions.
    from_commit`, the commit's own `ts`), else the migration's clock;
    `holders` = bit 0 when a core row names it, plus bit 1 when a history row
    names it (so a `b` of a long-deleted block is `2`, a live block `3`, a
    repo `1`, a segment `2`). The `cp` ids of `checkpoints` get no claim
    (the prefix is retired).
11. **Manifest**: `capabilities(history) = (enabled, 1, 1, '{}', sha256('{}'),
    [{ from: <the ts of the repo's seq = 1 commit, or the clock>, to: null
    }], writer_requires = 1, updated_at = clock)` for every repository —
    **existing repositories keep capturing**; `capabilities(semantic)` =
    `enabled` with `config = { model, dim }` from the effective `embedding.*`
    settings when a provider is configured **or** any `embeddings`/
    `doc_embeddings` row exists, else no row (**open point 1**).
12. **`sync_state`**: add the three columns; per repo insert the reserved row
    `('', '')` with `last_batch_ts`/`last_batch_id`/`last_batch_files` from
    the latest `checkpoints` row by `ts` (`last_batch_id = NULL` — the batch
    id is unknowable — `files` = the array's length); drop `checkpoints`,
    `collections`, `inferred_edges`.
13. `user_version = 17`.

**Fidelity note for legacy history.** Migrated `revisions.path` values are
16.0's: `movePath` rewrote the current revision's path in place, so a
document moved before 17.0 has every older revision at the old path and the
current one at the new (as `spec/surface` 5.x documented); from 17.0 a move
captures a new revision and paths are immutable. The backfilled feed has no
`moved` entry for a pre-17.0 move that also rewrote sources (the move's
revision rows read as `changed`), and its `batch_id`s are per commit.
`cases/migrations.json` gains `v16-to-v17-core-split` (a two-document 16.0
pre-state with a tombstone, a pool row, a closed edge, a pending row and two
commits; projects `docs`, `blocks`, `id_claims`, `feed`, `feed_entries`,
`edges`, `edge_transitions`, `capabilities`, `sync_state`).

---

## 2. spec/surface (6.0)

### 2.1 The `capability_unavailable` error (D3)

A new code in §4's list. Envelope:

```jsonc
{ "error": "capability_unavailable",
  "message": "<below>",
  "data": { "capability": "history" | "semantic",
            "state": "disabled" | "unavailable" | "outside_coverage" | "pruned",
            "repo": "<slug>",
            "rev"?: "<r_…>",            // the revision asked for, when one was
            "coverage_from"?: "<ts>",   // outside_coverage: the earliest capture
            "fix"?: "<call>" },
  "retriable": false | true }           // true only for unavailable
```

The four states, decided in this order by every history tool before any row
is read:

| state | when | message (byte-identical in both engines) | `retriable` | `fix` |
| --- | --- | --- | --- | --- |
| `unavailable` | this build does not carry the capability's module | `history is unavailable in this build — run an engine with the history module to read it` | `true` | none |
| `disabled` | the manifest row is absent or `state = 'disabled'` and the target lies **after** the last coverage interval (or there is none) | `history is disabled for this repository — enable it with \`omg history enable\` (reads of what was captured earlier still work)` | `false` | none |
| `outside_coverage` | the revision's mint instant (`id_claims.minted_at`) falls in no coverage interval | `revision "<rev>" was minted outside this repository's history coverage (capture started <coverage_from>)` | `false` | `docs_read {"_id":"<id>"}` — the current document — when the tool was `docs_read { at }` / `docs_read_at`; none otherwise |
| `pruned` | the revision's token is a claim (any holder) within coverage but no `revisions` row exists (`history purge` ran, or a pre-17.0 store lost the row) | `revision "<rev>" was captured but its history has been purged` | `false` | as `outside_coverage` |

A token that is **no claim at all** is `target_missing` "no revision
\"<rev>\" for document <id>" as today; a row that exists but is archived and
unreachable is `revision_archived` as 4.9 (the pruned-with-segment case —
D3 keeps it). **Which tools raise it:** `docs_read { at }`, `docs_read_at`,
`docs_diff`, `docs_diff_unified`, `docs_history`, `blocks_history` — the
dedicated history tools — for `history`; for `semantic`: `query` with
`semantic(…)` and `blocks_resolve` **only** in states `unavailable`/
`disabled` (a loaded, enabled module with no provider or an un-embedded
model stays `provider_unavailable`, 3.0 — the two codes sit side by side:
`capability_unavailable` is "the module is not here", `provider_unavailable`
"the module is here and has nothing to score with"). `blocks_history` on an
enabled repository whose coverage began after the block's birth returns the
rows that exist (no error); on `disabled`/`unavailable` it raises. The CLI
renders the code as `spec/cli` §3.5 renders any envelope (exit 1).

### 2.2 The `revisions` root and `_revisions` relation (D3)

§1.1 table, `revisions` row: "every `revisions` row of every document of the
repository **that the history capability holds** — the rows captured while
it was enabled; **never an error**: a repository whose capability is
`disabled` lists what was captured earlier, one with no bundle lists
nothing, and in both cases the result gains a `hints` line (§1.5)". §1.5
"`hints`" gains a third source beside unknown names: **a capability note**,
emitted once, first, when a query's scope chain reaches `revisions` (the
root, `^revisions`, `_revisions`, `_doc._revisions`) and the repository's
`history` state is not `enabled`:

- `disabled`: `` history is disabled for this repository — `revisions` lists only what was captured while it was enabled; `omg history enable` resumes capture ``
- `unavailable`: `` history is unavailable in this build — `revisions` is empty; run an engine with the history module to read it ``

`_archived`, `_is_current` (= `_rev == _doc.head` — the token comparison
survives tombstones, since `head` is kept), `_path` (immutable per D11; the
legacy fidelity note applies to pre-17.0 rows) are unchanged. `text()` and
`semantic()` stay `filter_invalid` on revisions.

### 2.3 `version`

After `profile`, two new keys (shape-pinned like the rest): `capabilities:
{ history: { state: "enabled" | "disabled" | "unavailable", coverage_from:
"<ts>" | null, writer_requires: boolean }, semantic: { state, model: "<string>"
| null } }` and `epoch: "<ep_…>" | null` (the default repository's; `null`
without a workspace). `version` stays the last key order's `profile` →
`capabilities` → `epoch`. The recorded shape in `reads.json` gains the
keys (every leaf its type name); `interop.json` never calls it.

### 2.4 `changes_since` (D7)

Arguments: `cursor?` (an integer `seq`, default 0), **`epoch?`** (a string;
default the repository's current epoch — a consumer that never stored one
behaves as today, and bears the rescan when the epoch moves), `limit?`,
`origin?`. Result: `{ digests, cursor, epoch, oldest, head, truncated }` —
`epoch` the repository's, `oldest` the smallest `seq` the feed still holds
(`0` when empty), `head` the greatest. **Expiry:** the call fails
`expired_cursor { epoch, oldest, head }` (a new code; `retriable: false`;
message `` cursor <cursor> of epoch <given> has expired — the feed now begins at (<epoch>, <oldest>); rescan the repository and resume from head <head> ``) when the given `epoch` is not the repository's, or `cursor > head`, or `0 <
cursor < oldest − 1` (every entry after the cursor is present exactly when
`cursor ≥ oldest − 1`). Each digest: `{ commit, seq, ts, origin, actor,
batch_id, summary?, revisions: [{ _id, _path, _hash, kind, from_path? }] }`
— `kind ∈ created | changed | deleted | moved` and `from_path` (on `moved`)
from the feed entry; a `deleted` revision has `_hash: null`; `summary`
**optional** — a human line composed from the entries' kinds and paths
(`observed: /a.md — changed`, `api(agent:mcp): deleted /b.md`, `api(…):
moved /a.md → /c.md`; two or more entries joined by `; `), with no
disposition counts unless the history bundle is present and the commit is
within it (then the 16.0 counts follow the kind, `— 12 edited, 1 inserted`),
unpinned as before. The `cursor` of the page is the last digest's `seq`
(string form never used — **decided here**: the integer cursor and a sibling
`epoch` keep the CLI's `--cursor <n>` and the coordinator's integer base).

### 2.5 `rev` and `_rev` wording (D1)

§2 `docs_read`'s `rev`, §1.2 `_rev`, `preconditions.docs[].base_revision`,
`expect.revision` and `stale_plan.current.revision` are **the head token**:
"a version token minted on every change to the document — content,
structure, path or liveness — equal to the recorder's revision id when
history is enabled; **a token does not promise retained content**: `docs_read
{ at: rev }` answers only while the history capability holds that revision
(§2.1)". The card (`mcp/reference.ts`, `descriptions.rs`) gains the sentence
"`rev` is a version token; retained content only when history is enabled."
The `revisions` row's `_rev` is `= _id` as before.

### 2.6 `_updated_at` / `_created_at` re-sourced (D6, M2)

§1.2 docs: `_updated_at` = `docs.updated_at` (the token's mint instant —
renames and revivals count); `_created_at` = `docs.created_at` (the identity's
birth: survives tombstone and revival, is never a filesystem time, and
survives `history purge` — it no longer depends on any revision row).
Blocks: `_updated_at` = `blocks.updated_at` (the block's own last change —
14.2's meaning kept: a `same` carry does not move it; a container's moves
when its raw changes, D6), `_created_at` = `blocks.created_at` (carried
across resurrection and cross-document moves — the pool and the eviction
carry it, D6). Both push down as plain column reads (`d.updated_at`,
`b.created_at`; the `revisions`/`block_changes` correlated subqueries of
`translate.ts:160–167, 354–379` / `translate.rs:282–288, 637–688` and
`liveDocRows`/`live_doc_rows` are gone); `_dst._updated_at`/`_created_at`
and `_doc._created_at` are the destination/owner row's columns. `docs_list`/
`docs_tree`'s `_updated_at` read the column. `reads::created-at` (three days
around an export) and `reads::sibling-updated-at-does-not-move` keep their
values; `query-dates` keeps its values (the corpus clock stamps both
columns).

### 2.7 `doctor` and `doctor --size` (D9)

`doctor`'s `no dangling current_rev` check becomes **`head present`** (every
live doc has a non-NULL `head` that is a claim) and gains **`capture
complete`** when `history` is enabled (every live doc's `head` has a
`revisions` row — H1), `skipped` otherwise. `doctor --size` renders the
**six** categories of `spec/store` §7.5 in order (`content`, `identity`,
`recovery`, `history`, `search`, `sync`), the new `feed` and `capabilities`
lines in the file block (`feed  epoch <ep>, <n> entries, seq <oldest>..<head>`,
`history  enabled since <ts> | disabled | unavailable`, `semantic  enabled
(<model>) | disabled`), and the two advice lines; the JSON gains `feed` and
`capabilities`. `admin::doctor-size*` are re-recorded by shape.

---

## 3. spec/mutate (4.1)

### 3.1 The CAS vocabulary against the head token (D1)

§1.2 and §11.1: `Expect.revision` is "the document's **head token**
(`docs.head`; `rev` of `docs_read`)". §4 step 5(b): the triple is `(path,
head, file_hash)` — "re-read `(path, head, file_hash)` through the
transaction and compare with the values the plan loaded; a document whose
`head` moved → ROLLBACK, `stale_plan { doc, expected_revision, current: {
revision: <head>, _hash }, retriable: true }`". Because a **tombstone keeps
`head`** (`spec/store` §5.6), a plan loaded against a document that was
deleted meanwhile fails the liveness check first — `doc_missing` for a
`move`/`remove`/`set`, as today's re-check of the document operations' own
guards — never a false CAS pass; a document revived meanwhile has a new
`head`, so it is `stale_plan`. `preconditions.docs[].base_revision` is the
head token (the Plan shape is unchanged; every pinned `plan_id` holds since
the fixture minter mints `r` at the same points). §11.2 "compared with the
target document's `current_rev`" reads "`head`". §8's `stale_plan` data is
unchanged: `{ doc, expected_revision, current: { revision, _hash }, retriable,
effect_index?, fix }`.

### 3.2 A move is a new revision (D11)

§6 `docs_move`: "`docs.path` updated **and a new head minted** — the moved
document gets a `moved` feed entry (`from_path` the old path) and, when
history is enabled, a revision with the same content and the new path; a
move with `retarget_inbound: false` therefore still carries one revision
(the moved document's) — through 4.0 it carried none". `revisions.path` is
immutable. The Receipt's `revisions[]` lists the moved document (`_hash`
unchanged, `_id`, the new `_path`) first, then the rewritten sources. The
`rename` pending row carries `head` = the new token and `prior_hash` = the
validated hash of the file at `from_path`.

### 3.3 `docs_delete` under D2

§6 `docs_delete`: one transaction: feed row (`origin = api`, `reason =
"delete <path>"`) with one `deleted` entry; FTS rows dropped; **Phase 3:**
live blocks `deleted_at = ts`; **Phase 4:** the blocks rows deleted; the doc
`deleted_at = ts`, `head` kept, `updated_at = ts`; **nothing pooled** (as
today); a `remove` pending row `(head = NULL, rendered_hash = file_hash,
prior_hash = NULL)`; capture receives `kind = 'deleted'` (no revision,
D11). The Receipt's `revisions` is `[]` for a delete-only plan; `commit` is
the feed row's id.

### 3.4 The pending row and the commit protocol (M4)

§4 step 5(b)'s last clause: "finally one **pending row** per file the request
owes the disk: `write` per ingested document with its new `head`, `rendered_hash`
and **`prior_hash` = the hash of the bytes (a) read for that path** (NULL when
the file was absent — a `create`); the document operations' `rename` (`prior_hash`
= (a)'s hash at `from_path`) and `remove` (`prior_hash = NULL`) rows". Step
5(c): "the bytes the materializer may overwrite are the ones (b) validated the
file against — **the row's `prior_hash`**". §9's projection of
`pending_materializations` is `{ path, kind, from_path, doc_id, head,
rendered_hash, prior_hash, commit_id }`.

### 3.5 Fixtures and the recorder

§9: the `commits`, `revisions`, `dispositions` projections are **recorded only
when the composition includes the history bundle** (§6 below); every mutate
case runs under `core+history` so its expectations keep every row, and under
`core` the runner skips those keys. `spec/mutate` 4.1 is a minor: no
request/response shape changes.

---

## 4. spec/sync (4.0)

### 4.1 §4.1 Checkpoint row → sync status (D4)

Replace §4.1 with: "Every batch observed through the filesystem fast path or
the adapter driver updates the repository's **status row** of `sync_state`
(`source_id = ''`, `path = ''`; `spec/store` §1.6): `last_batch_ts` = the
batch timestamp, `last_batch_id` = the batch's `batch_id` (the first
committing member's commit id; NULL when nothing committed),
`last_batch_files` = the member count — and sweeps the pool at `ts`, the row
and the sweep in one transaction (the batch's last member's, or its own).
The result is `{ batch_id, ingested, suppressed, deleted, conflicted }` in
batch order (`checkpoint_id` is gone — **the `checkpoint.json` step results
move**). No `cp` is minted."

### 4.2 §4.4 Status

`repos_status(repo, root?)`: counts of live docs, live blocks, **feed
entries (`commits` renamed `feed`: `{ epoch, oldest, head }`)**, open edges;
**`unconverged` is dropped (decided here, open point 4)** — I1 made it
identically zero; `disk.changed` is the signal; `sync_status`:
`last_commit_seq` → `head` with `epoch` and `oldest` beside it,
`last_batch: { ts, batch_id, files } | null`, `convergent = checked && no
drift`, and `capabilities` as `version` reports them.

### 4.3 §6 The feed cursor and the rescan (D7)

The coordinator's `changes_since(cursor = 0, epoch?, limit, origin?)` is
`spec/surface` §2.4. **The cursor is `(epoch, seq)`**: a consumer stores both
and sends both. **Expired cursor → rescan.** On `expired_cursor { epoch,
oldest, head }` the consumer runs the **rescan procedure**:

1. Record `S = head` and `E = epoch` from the error (the server's current
   position).
2. Page the server's live documents (`docs_list`, `limit`/`cursor`, with
   `_hash`: `query` `docs { select _id, _path, _hash }` on the minimal
   profile) into a set `L` of `(id, path, hash)`.
3. **Reconcile the id set**: for every `(id, path, hash)` in `L` whose `hash`
   differs from the consumer's copy, pull the bytes (`docs_read`/`read_doc`)
   and apply them at `path`; a consumer-side path whose id is in `L` under
   another path is a move; **absence from `L` is deletion** — every
   consumer-side document whose id is not in `L` is removed.
4. Resume `changes_since(cursor = S, epoch = E)`. The feed's retention floor
   (`spec/store` §7.1: ≥ 10 days and ≥ 10 000 entries) is the **bootstrap
   lease**: a rescan that completes within it resumes without a second
   expiry; one that does not repeats from step 1. No server-side lease
   object exists in this round (open point 2).

`sync_out(cursor, epoch)` pages as before and exports every non-`observed`
digest's revisions by `kind`: `created`/`changed`/`moved` → read the doc by
`_id` and `write` at `_path` (a `moved` also `remove`s `from_path`);
`deleted` → `remove`. The `batch_id` lets a consumer group an observed
batch's commits (what a history strategy needs from batches — D4). A
digest's `summary` is optional and never read by the coordinator.

### 4.4 The sync base

New paragraph in §6: "**The sync base.** A client of the feed keeps its own
base — the `(epoch, seq)` it last applied and the hashes it last saw; the
server promises nothing beyond the feed's retention floor. Optional history
supplies no unlimited common ancestor: a client that falls behind the floor
rescans (§4.3) and, where its own copy diverged meanwhile, surfaces the
divergence as a conflict in its own terms — the server's current state wins
the feed, the client's edits are the client's to re-apply. A server-side
lease (a snapshot pinned for a named client beyond the floor) is a later
addition and is not specified here."

### 4.5 Fixtures

`checkpoint.json` projects `sync_state` (the status row) instead of
`checkpoints`; its history-table projections (`revisions`, `dispositions`,
`commits`, `block_changes`, `tree_nodes`) are recorded under `core+history`
only (§6 below). `protocol.json` coordinator cases' `calls` record
`changes_since { cursor, epoch }` and the digests' `kind`s; `commits [{
commit_id, seq, origin, actor }]` is read from the feed.

---

## 5. spec/graph (3.0)

### 5.1 §3.3 Interval maintenance → open-only `edges` (M6)

"Let *open* be the document's `edges` rows and *wanted* the resolved
descriptors deduplicated on key. For each wanted key not open: **mint `e`**,
insert `(edge_id, repo_id, src_doc, src_block, src_field, predicate,
dst_kind, dst_node, anchor, provenance, via_node = null)`, in wanted order.
Then for each open row in `rowid` order: keep it if its key is wanted and
no earlier open row with the same key was kept; otherwise **delete** it.
Unchanged rows are untouched (they keep their `edge_id`). **The recorder's
half (`spec/store` §5.4 step 15):** when history is enabled the transition's
edge list lets the recorder write `edge_transitions` — one row per opened
edge (`from_commit` = this commit, `to_commit = NULL`) and `to_commit = this
commit` on every row it closed; the core writes neither column." §3.5
phantom adoption and §3.6 deletion are unchanged (an adopted edge keeps its
id; a tombstoned document's edges stay open). §6: `has_anchor` probes
`edges` with no interval filter (D8 made the filter explicit in 5.1; M6
makes it moot — `reads::has-anchor-open-edges` stays as the pin).

### 5.2 Fixtures

§7: `edges` is projected as every column but `repo_id`, sorted by (the
opening commit's `seq` **as recorded by the runner** — the runner remembers
the commit that inserted each `edge_id`, since the row no longer carries it
— then `edge_id` bytewise). **`intervals.json` moves to the recorder suite**
(`spec/store/cases/history/edge-transitions.json`, below): its 21 cases
project `edge_transitions` (every column, `to_commit` as the commit id or
null) in the same order; the core-side truths they also carried — `doc_edges`
rollups, adoption, "deletion leaves edges" — are re-cut into
`spec/graph/cases/open-edges.json` (the same scripts projecting `edges` and
`doc_edges` only). The runner check "every `edges.from_commit`/`to_commit`
exists" moves with the suite.

---

## 6. Fixture plan

**The two invariants of the phase.** (a) **Every existing fixture passes
unchanged at the end of Phase 1**: Phase 1 lands interfaces that wrap current
behaviour (`SemanticProvider`, the recorder seam, the dependency-direction
checks of `README.md` §5) and this document; no `expect` moves. (b) **No
on-disk change ships until both engines carry it**: the store major (17.0)
and every suite below are regenerated once, in the commit that lands Phase
3's TS and Rust together, with `interop.rs` green across the four pairings
(`spec/surface` §7). The allowlist mechanism (`spec-passing.txt`) is the
only tolerated interim.

**Compositions (plan §5 "ship and test four compositions").** Every
observation-script runner (`spec/store`, `spec/mutate`, `spec/sync`,
`spec/graph`, `spec/surface` `reads`, `spec/cli`) gains a case-level or
suite-level key `composition: "core" | "core+history" | "core+semantic" |
"full"` (default `full` — today's behaviour, so an unmarked case is
unchanged) and a runner mode per composition; a case's `expect` projects
only the bundles its composition includes (a history table under `core` is
not projected and not compared; a capability error is). Both engines run all
four; the Rust runner's per-composition allowlists are
`spec-passing.<composition>.txt`.

| Suite | Moves to | Stays | New |
| --- | --- | --- | --- |
| `spec/store/cases/{observe,identity,deletion,pool,structure,frontmatter,batch}.json` | the `revisions`/`tree_nodes`/`blobs`/`dispositions`/`block_changes`/`commits` projections become **history-bundle keys**, recorded under `core+history`; `docs` rows carry `head`, `frontmatter_raw`, `created_at`, `updated_at`, `deleted_at`; `blocks` rows `raw`, `trivia`, `created_at`, `updated_at`, `deleted_at`; pool rows `created_at`, `deleted_at` | `docs`, `blocks`, `resurrection_pool`, `pending_materializations`, `sections`, the step outcomes (`commit`/`rev` ids unchanged) | every case gains `id_claims` (by `prefix`, `id`) and `feed`/`feed_entries` (by `seq`) projections; `identity.json` gains `claims-survive-expiry-and-squash`, `claims-prune-releases-core-hold`, `created-at-carried-through-pool`, `created-at-carried-across-docs`; `observe.json` gains `move-mints-a-head` (a `docs_move`-shaped observe is impossible — the case lives in `spec/mutate`), `tombstone-mints-no-head` |
| `spec/store/cases/garbage.json`, `delta.json`, `retention.json` | **recorder-only**: `spec/store/cases/history/{garbage,delta,retention}.json`, composition `core+history` | — | `history/edge-transitions.json` (from `spec/graph/cases/intervals.json`); `history/capture.json` (enable baseline, disable boundary, re-enable gap and `revisions.seq` continuity, purge releasing claims, capture failure rolling back a member) |
| `spec/store/cases/schema.json` | — | `fresh` (core) | `history`, `semantic` fingerprints |
| `spec/store/cases/migrations.json` | — | all 9 | `v16-to-v17-core-split`; `newer-version-is-refused` pins `v18`/`v17` |
| `spec/store/cases/feed.json` | — | — | **new**: retention floors and cap (`exec` to set `feed.*` settings), `oldest`/`head`, the expired cursor, the epoch mint on rebuild, `batch_id` over a three-member batch with an echo first |
| `spec/mutate/cases/{commit,materialize}.json` | `pending_materializations` rows gain `head`/`prior_hash`, lose `rev_id`; `revisions`/`commits`/`dispositions` under `core+history` | every step outcome, `files`, `docs`, `blocks`, `resurrection_pool` | `materialize.json`: `crash-then-materialize-renders-from-current-state` (history disabled); `docs.json`: `move-mints-a-head-and-a-revision`, `move-no-retarget-still-carries-one-revision`, `delete-keeps-head` |
| `spec/mutate/cases/{plan,effects,changesets,docs,macros,ops,render}.json` | `revisions`/`commits`/`dispositions` keys under `core+history` | everything else; every `plan_id` holds | `effects::stale-plan-after-move` (D11: a move moves the token) |
| `spec/sync/cases/checkpoint.json` | `checkpoints` → `sync_state` status row; `checkpoint_id` → `batch_id` in step results; history tables under `core+history` | `file_stats`, buckets, counters | `status-row-after-empty-sweep` |
| `spec/sync/cases/protocol.json` (coordinator) | `calls` record `changes_since { cursor, epoch }`; `commits` projection read from the feed | adapter cases untouched | `sync-out-expired-cursor-rescans` |
| `spec/graph/cases/intervals.json` | → `spec/store/cases/history/edge-transitions.json` | `links`, `nodes`, `resolve`, `uri` untouched | `open-edges.json` (the 21 scripts projecting `edges`/`doc_edges`) |
| `spec/surface/cases/reads.json` | `history`, `revisions`, `archived`, `created-at`, `diff-unified-list-append` run under `core+history` (their `docs_history`/`docs_read_at`/`docs_diff*`/`blocks_history` steps); `version` shape gains `capabilities`/`epoch`; `changes_since` outcomes gain `epoch`/`oldest`/`kind`; `_rev`/`rev` values unchanged | `orientation`, `arguments`, `budgets`, `workspace-writes`, `alchemy`, `bare-attributes`, `dst-on-links`, `tree-rollup`, `plan-memory`, `query-syntax`, `has-anchor-open-edges`, `sibling-updated-at-does-not-move` (values hold), `yaml-json-documents` | `capability-unavailable` (the four states over one script: disabled → `docs_read { at }`, `docs_history`, `blocks_history`, the `revisions` root's `hints`; enable → baseline reads; disable → `outside_coverage` for a token minted in the gap; purge → `pruned`), `changes-since-epoch-and-expiry`, `move-is-a-revision` |
| `spec/surface/cases/query-revisions.json` | the one-revision corpus runs under `core+history`; `_path` after a move reads the new path on the new row | all 36 (values hold) | `revisions-under-disabled-history-hints` (composition `core`: empty scan + the hint) |
| `spec/surface/cases/query-dates.json`, `query-links.json`, `query-docs.json`, `query-blocks.json` | — | all (values hold: the corpus clock stamps the columns; links read open rows) | `query-docs::updated-at-moves-on-rename`, `query-blocks::created-at-survives-cross-doc-move` |
| `spec/surface/cases/interop.json` | `read-history-admin`, the `docs_history`/`docs_diff`/`blocks_history` reads of the write cases run under `core+history`; `write-docs-create-move`'s `docs_history` shows the move's revision; `changes_since` digests gain `kind`/`epoch`/`oldest` | every other case | `interop::capability-unavailable` (a `core`-composition server pair), `interop::history-enable-baseline` |
| `spec/surface/cases/{examples,profiles,cursor,query-*}.json` | `examples::ladders`: the `docs_read … at: "r_7"` rung holds (the fixture minter mints `r_7` at the same point); the `changes_since` rung's outcome gains the new keys; `version` by shape | — | — |
| `spec/cli/cases/history.json` | `log` lines render `— created|changed|deleted|moved` with counts only under `core+history`; `hist`/`diff`/`history *` cases under `core+history` | `links*` | `log-expired-cursor`, `history-enable`, `history-disable`, `history-purge`, `hist-disabled` (the envelope) |
| `spec/cli/cases/admin.json` | `doctor-size*` re-recorded by shape over six categories; `doctor` gains `head present`/`capture complete`; `gc*` gain `claims_released` and the `history: skipped` line under `core` | `init*`, `source*`, `config*`, `embed*`, `rebuild-index*` | `doctor-size-core-only`, `gc-core-only-skips-history` |
| `spec/reconcile/cases/resurrection.json`, `spec/properties/cases/*`, `spec/search/cases/*`, `spec/oqx/*`, `spec/format/*` | — | unchanged (in-memory; `spec/search` runs under `core+semantic`) | — |

**Dependency-direction gates** (the Phase 1 deliverable beside this
document; `README.md` §5): TS `no-restricted-imports` — `core/**`,
`mutate/**`, `sync/**`, `oqx-js/**` import nothing from `graph/history.ts`,
`core/store/{archive,retention,delta}.ts`, `search/{embeddings,vector,tasks,
drain}.ts`; Rust a test that the `core` module of `omgbase-store` names no
`history::`/`semantic::`/`archive`/`retention`/`delta`/`search` item. Both
land in Phase 1 wrapping today's behaviour.

---

## 7. Open points

Decisions D1–D11 did not settle the following; each is marked where it bites
above. **Decided here** = a choice this document makes that Brendan should
confirm; **open** = not decided.

1. **(open) The semantic manifest's initial state on migration** (§1.16 step
   11): `enabled` when a provider is configured or vectors exist, else no
   row — or always a row with `disabled`? Affects `version.capabilities.
   semantic` on every existing workspace and the `embed` verbs' refusal path.
2. **(open) The bootstrap snapshot lease** (D7 names "a bounded bootstrap
   snapshot lease"; §1.13 §7.1, §4.3): this document makes the retention
   floor the lease and specifies no server-side lease object. If a longer or
   per-client bound is wanted (a consumer that bootstraps a 10 000-document
   repository over a slow link), its shape — a `lease_id`, its TTL, where it
   pins — is undecided.
3. **(open) The ADR-003 intent record with history disabled**: `commits.ops`
   is the recorder's (M5); with the capability off the plan's resolved
   effects are retained nowhere. Carry `plan_id` (64 hex) on the feed row —
   cheap, enough to correlate a Receipt — or accept the loss?
4. **(decided here) `repos_status.unconverged` dropped** rather than redefined
   as the drift count (D9 allows either). `sync_status.convergent` becomes
   `checked && no drift`.
5. **(decided here) The wire form of the `(epoch, seq)` cursor** (§2.4): the
   integer `cursor` kept with a sibling `epoch` argument/result key, the
   epoch defaulting to the current one. The alternative — one opaque string
   `"<epoch>:<seq>"` — would change the CLI's `--cursor <n>` and the
   coordinator's integer base.
6. **(decided here) `batch_id` derivation**: the first committing member's
   `commit_id` (no new prefix; a batch of one and every `api` commit have
   `batch_id = commit_id`). D4/D7 say a batch id exists, not how it is made.
7. **(decided here) Where the sync status lives**: the reserved `sync_state`
   row `(repo_id, '', '')` with three new columns, so a sourceless repository
   (every `checkpoint.json` fixture) has one; the alternative is three
   columns on `repos`. D4 says "on the sync state".
8. **(decided here) `properties.created_commit` dropped**, not replaced by a
   change token (M2 allows either); no reader exists.
9. **(decided here) `edges.dst_kind` loses `'collection'`** from its CHECK
   with `collections` (D9); no row ever carried it.
10. **(decided here) The claims prune policy key** `identity.claims_retain_days`
    (default null = never) and the rule that a pruned claim must name no core
    row (§7.2). D5 says "prunable by installation policy" without naming the
    knob.
11. **(open) `docs_history` for a document with no captured version**
    (coverage began after its last change, or history disabled): list it
    with `versions: []`, or raise `capability_unavailable { state:
    outside_coverage }` per document? §2.1 makes the tool raise only for
    `disabled`/`unavailable`; the per-document case is undecided.
12. **(open) Legacy `revisions.path` and the backfilled feed** (§1.16
    "Fidelity note"): pre-17.0 moves rewrote the current revision's path in
    place and left no record of the move; the feed backfill reads a move's
    revision rows as `changed` and recovers `moved` only from a `move <from>
    -> <to>` reason. Whether to attempt a path reconstruction from
    `revisions.path` transitions per document is undecided.
13. **(decided here) `blocks_resolve` under a missing semantic module**
    raises `capability_unavailable` only in `unavailable`/`disabled`; with
    the module present and no provider it degrades to FTS-only as today.
14. **(decided here) FTS stays in the core bundle** (`text()` needs no
    provider) while the size category `search` keeps both FTS and the
    vectors; the "search" composition of plan §5 is therefore
    `core+semantic`.
15. **(decided here) `docs.current_rev` renamed `head`** rather than kept
    under its old name with the new meaning: the column no longer implies a
    `revisions` row and `doctor`'s check is renamed with it; the cost is one
    key in every `docs` projection, regenerated with the major.
16. **(decided here) The `expired_cursor` result is an error envelope**
    (`retriable: false`, `data { epoch, oldest, head }`), not a result
    member — D7 says "an explicit result"; a result-shaped variant would put
    a second shape on `changes_since`.
17. **(open) `writer_requires` default on `history enable`**: this document
    defaults it to 1 (a writer without the recorder must refuse) so that an
    enabled repository is never silently un-captured by the minimal binary;
    the alternative (0: capture is best-effort) is a product decision.
18. **(open) Capture failure on the watcher path**: §5.4 step 15 rolls the
    member back and the next sweep retries — a persistently failing recorder
    makes a file un-ingestable until fixed. Whether the watcher should flip
    the capability to `disabled` with a boundary after N failures is
    undecided.
