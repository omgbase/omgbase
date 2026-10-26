
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
