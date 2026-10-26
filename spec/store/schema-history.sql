
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
