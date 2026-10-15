-- ---- an archive segment (spec/store §7 "Retention", 15.0) --------------------
-- One file per `history export`, never appended: the bodies of the revisions
-- the retention policy squashed, self-contained (every blob and tree node
-- reachable from them), plus copies of their revision, commit, disposition and
-- block-change rows, and one manifest row. The same DDL subset as schema.sql
-- minus the foreign keys (a segment holds no repos or docs rows).
CREATE TABLE IF NOT EXISTS manifest (
  segment_id          TEXT PRIMARY KEY,
  repo_id             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  policy              TEXT NOT NULL,
  seq_lo              INTEGER NOT NULL,
  seq_hi              INTEGER NOT NULL,
  revision_count      INTEGER NOT NULL,
  previous_segment    TEXT,
  schema_user_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  rev_id           TEXT PRIMARY KEY,
  doc_id           TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  root_tree        BLOB NOT NULL,
  frontmatter_blob BLOB,
  rendered_hash    BLOB NOT NULL,
  path             TEXT NOT NULL,
  commit_id        TEXT NOT NULL,
  UNIQUE (doc_id, seq)
);

CREATE TABLE IF NOT EXISTS commits (
  commit_id     TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  ts            TEXT NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('api','observed','import','projection')),
  actor         TEXT,
  reason        TEXT,
  checkpoint_id TEXT,
  ops           TEXT
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
  commit_id  TEXT NOT NULL,
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
