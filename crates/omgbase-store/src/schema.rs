//! The schema (`spec/store/README.md` §3): the embedded `schema.sql`, the
//! opener and the migrations of §3.4.

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params};

use crate::core::capabilities::HistoryRecorder;
use crate::core::time::POOL_TTL_MS;
use crate::error::{Error, Result};
use crate::mint::{IdSource, Mint};

/// `spec/store/schema.sql`, verbatim (§3.3). Executed on a fresh database.
pub const SCHEMA_SQL: &str = include_str!("../schema.sql");

/// `spec/store/archive.sql`, verbatim (§3.3, 15.0): the DDL of an archive
/// segment (§7.1), executed on every new segment file `history export` writes.
pub const ARCHIVE_SQL: &str = include_str!("../archive.sql");

/// The `PRAGMA user_version` this crate writes: the spec major.
pub const SCHEMA_VERSION: i64 = 17;

/// Split the DDL into statements at every `;` outside a `--` comment or a
/// string literal, keeping each statement's original text (comments included).
fn statements() -> Vec<&'static str> {
    let sql = SCHEMA_SQL;
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let (mut start, mut i) = (0, 0);
    let (mut in_comment, mut in_string) = (false, false);
    while i < bytes.len() {
        let c = bytes[i];
        if in_comment {
            if c == b'\n' {
                in_comment = false;
            }
        } else if in_string {
            if c == b'\'' {
                in_string = false;
            }
        } else if c == b'-' && bytes.get(i + 1) == Some(&b'-') {
            in_comment = true;
            i += 1;
        } else if c == b'\'' {
            in_string = true;
        } else if c == b';' {
            let stmt = sql[start..i].trim();
            if !without_comments(stmt).trim().is_empty() {
                out.push(stmt);
            }
            start = i + 1;
        }
        i += 1;
    }
    let tail = sql[start..].trim();
    if !without_comments(tail).trim().is_empty() {
        out.push(tail);
    }
    out
}

/// `sql` with every `--` comment removed.
fn without_comments(sql: &str) -> String {
    sql.lines()
        .map(|l| l.find("--").map_or(l, |i| &l[..i]))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The table a statement creates, indexes or inserts into.
fn statement_target(stmt: &str) -> Option<String> {
    let body = without_comments(stmt);
    let words: Vec<&str> = body.split_whitespace().collect();
    let name = |i: usize| {
        words
            .get(i)
            .map(|w| w.split('(').next().unwrap_or(w).to_owned())
    };
    let upper: Vec<String> = words.iter().map(|w| w.to_ascii_uppercase()).collect();
    let u: Vec<&str> = upper.iter().map(String::as_str).collect();
    match u.as_slice() {
        ["CREATE", "TABLE", "IF", "NOT", "EXISTS", ..] => name(5),
        ["CREATE", "VIRTUAL", "TABLE", "IF", "NOT", "EXISTS", ..] => name(6),
        ["CREATE", "INDEX", "IF", "NOT", "EXISTS", ..] => {
            let on = u.iter().position(|w| *w == "ON")?;
            name(on + 1)
        }
        ["INSERT", "OR", "IGNORE", "INTO", ..] => name(4),
        _ => None,
    }
}

/// The statements of `schema.sql` that create (or seed) the named tables and
/// their indexes, joined with `;` — the sub-DDL a migration step executes.
#[must_use]
pub fn ddl_for(tables: &[&str]) -> String {
    let mut out = String::new();
    for stmt in statements() {
        if statement_target(stmt).is_some_and(|t| tables.contains(&t.as_str())) {
            out.push_str(stmt);
            out.push_str(";\n");
        }
    }
    out
}

pub(crate) fn user_version(conn: &Connection) -> Result<i64> {
    Ok(conn.pragma_query_value(None, "user_version", |r| r.get(0))?)
}

fn set_user_version(conn: &Connection, v: i64) -> Result<()> {
    conn.pragma_update(None, "user_version", v)?;
    Ok(())
}

pub(crate) fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

pub(crate) fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", quote_ident(table)))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<Option<bool>> {
    let cols = column_names(conn, table)?;
    if cols.is_empty() {
        return Ok(None);
    }
    Ok(Some(cols.iter().any(|c| c == column)))
}

/// Double-quote an identifier.
pub(crate) fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Open per §1: `0` → `schema.sql`; equal → done; greater → refuse; less →
/// migrate step by step, each in its own transaction. `history` is the
/// recorder the store opens with: step 17 resolves every live head's
/// frontmatter through it once (`frontmatter_at_revision`), never through
/// the delta module directly.
pub(crate) fn migrate(
    conn: &Connection,
    ids: &mut IdSource,
    history: Option<&dyn HistoryRecorder>,
) -> Result<()> {
    let current = user_version(conn)?;
    if current == 0 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(SCHEMA_SQL)?;
        set_user_version(&tx, SCHEMA_VERSION)?;
        tx.commit()?;
        return Ok(());
    }
    if current == SCHEMA_VERSION {
        // 17.0 is unreleased and grew in slices (modular-core Phase 3a → 3b
        // → 3c → 3d): a database a 3a build already moved to 17 has `docs`
        // but no `id_claims` and the pool's `deleted_commit`; a 3a/3b build's
        // still has `pending_materializations.rev_id`; a 3a–3c build's has no
        // `feed`, a `checkpoints` table and `commits.checkpoint_id`. Each part
        // of the step is idempotent, so finish it here rather than spend a
        // schema version on a dev-only state. (A 17 database with no `docs`
        // table — the `already-current-is-untouched` fixture — is left exactly
        // as it is.)
        if table_exists(conn, "docs")? {
            migrate_v17_claims(conn)?;
            migrate_v17_pending(conn)?;
            migrate_v17_feed(conn, ids)?;
        }
        return Ok(());
    }
    if current > SCHEMA_VERSION {
        return Err(Error::SchemaTooNew {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }
    for v in current + 1..=SCHEMA_VERSION {
        if v == 15 {
            // Brackets its own transaction: `PRAGMA foreign_keys` is a no-op
            // inside one, and the rebuild needs it off (§3.4 step 15).
            migrate_v15(conn)?;
            continue;
        }
        if v == 17 {
            // Likewise: three rebuilds under `foreign_keys = OFF` (§3.4 step
            // 17), then the identity half (3b): the pool's `deleted_at` and
            // the `id_claims` backfill, then the recovery half (3c): the
            // self-contained `pending_materializations` row, then the feed
            // half (3d): the epoch, the feed backfill, the recorder's
            // `commits` row, the status row, `checkpoints` dropped.
            migrate_v17(conn, history)?;
            migrate_v17_claims(conn)?;
            migrate_v17_pending(conn)?;
            migrate_v17_feed(conn, ids)?;
            continue;
        }
        let tx = conn.unchecked_transaction()?;
        // The oracle is bound after the migration (the reference registers
        // it after `migrate()`): a step's mint is checked against the issued
        // set alone, and a pre-17 database has no `id_claims` to probe.
        migrate_step(&tx, v, &mut ids.at_unchecked(&tx))?;
        tx.commit()?;
    }
    set_user_version(conn, SCHEMA_VERSION)?;
    Ok(())
}

/// One step of §3.4, idempotent.
fn migrate_step(conn: &Connection, to: i64, minter: &mut Mint<'_>) -> Result<()> {
    match to {
        2 => conn.execute_batch(&ddl_for(&["file_stats"]))?,
        3 => {
            if has_column(conn, "documents", "format")? == Some(false) {
                conn.execute_batch(
                    "ALTER TABLE documents ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown'",
                )?;
            }
        }
        4 => {
            let cols = column_names(conn, "documents")?;
            if !cols.is_empty()
                && cols.iter().any(|c| c == "frontmatter")
                && !cols.iter().any(|c| c == "metadata")
            {
                conn.execute_batch("ALTER TABLE documents RENAME COLUMN frontmatter TO metadata")?;
            }
        }
        5 => conn.execute_batch(&ddl_for(&["nodes", "nodes_fts"]))?,
        6 => {
            if has_column(conn, "documents", "leading_trivia")? == Some(false) {
                conn.execute_batch(
                    "ALTER TABLE documents ADD COLUMN leading_trivia TEXT NOT NULL DEFAULT ''",
                )?;
            }
            if has_column(conn, "blocks", "trivia_hash")? == Some(false) {
                conn.execute_batch("ALTER TABLE blocks ADD COLUMN trivia_hash BLOB")?;
            }
        }
        7 => {
            if has_column(conn, "documents", "frontmatter_trivia")? == Some(false) {
                conn.execute_batch("ALTER TABLE documents ADD COLUMN frontmatter_trivia TEXT")?;
            }
        }
        8 => conn.execute_batch(&ddl_for(&["properties"]))?,
        9 => conn.execute_batch(&ddl_for(&[
            "adapters",
            "sources",
            "attachments",
            "sync_state",
        ]))?,
        10 => conn.execute_batch(&ddl_for(&["workspace_settings"]))?,
        11 => {
            if !table_exists(conn, "docs")? && table_exists(conn, "documents")? {
                conn.execute_batch("ALTER TABLE documents RENAME TO docs")?;
            }
        }
        12 => conn.execute_batch(&ddl_for(&["doc_embeddings"]))?,
        13 => migrate_v13(conn, minter)?,
        14 => conn.execute_batch(&ddl_for(&["pending_materializations"]))?,
        // v16 (§3.4 step 16, §4.1 "Delta nodes"): no DDL and no data pass. A
        // 15.x store holds only full (`[`-form) nodes and raw frontmatter
        // blobs, which ARE the 16.0 checkpoint forms, so every existing
        // revision is a checkpoint; deltas appear with the next commit. The
        // major exists because a 15.x engine cannot read a `{`-form node (§1
        // step 3 keeps it out). The opener moves `user_version` after the loop.
        16 => {}
        other => return Err(Error::Other(format!("no migration to schema v{other}"))),
    }
    Ok(())
}

/// v15 (§3.4 step 15, §7.1 "Retention"): `revisions.root_tree` and
/// `frontmatter_blob` become nullable and lose their foreign keys (an
/// archived revision keeps its row and loses its bodies), `revisions` gains
/// `archive`, and `archives` is created. SQLite cannot relax a NOT NULL or
/// drop a FK in place, so the table is rebuilt the documented way: foreign
/// keys off for the duration — `pending_materializations.rev_id` references
/// `revisions`, and the DROP would otherwise be an implicit DELETE under the
/// FK — create the new table, copy every row with `archive = NULL`, drop the
/// old, rename, `foreign_key_check`. Idempotent: a `revisions` table that
/// already carries `archive` is left alone; `archives` is `CREATE … IF NOT
/// EXISTS`. The opener runs each step in its own transaction and `PRAGMA
/// foreign_keys` is a no-op inside one, so this step brackets its own.
fn migrate_v15(conn: &Connection) -> Result<()> {
    if has_column(conn, "revisions", "archive")? == Some(false) {
        conn.pragma_update(None, "foreign_keys", "OFF")?;
        let rebuilt = (|| -> Result<()> {
            let tx = conn.unchecked_transaction()?;
            tx.execute_batch(
                "CREATE TABLE revisions_v15 (
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
INSERT INTO revisions_v15 (rev_id, doc_id, seq, root_tree, frontmatter_blob, rendered_hash, path, commit_id, archive)
  SELECT rev_id, doc_id, seq, root_tree, frontmatter_blob, rendered_hash, path, commit_id, NULL FROM revisions;
DROP TABLE revisions;
ALTER TABLE revisions_v15 RENAME TO revisions;",
            )?;
            let violations: i64 = {
                let mut stmt = tx.prepare("PRAGMA foreign_key_check")?;
                let rows = stmt.query_map([], |_| Ok(()))?;
                i64::try_from(rows.count()).unwrap_or(i64::MAX)
            };
            if violations > 0 {
                return Err(Error::Other(format!(
                    "migration v15: {violations} foreign key violation(s) after rebuilding revisions"
                )));
            }
            tx.commit()?;
            Ok(())
        })();
        conn.pragma_update(None, "foreign_keys", "ON")?;
        rebuilt?;
    }
    conn.execute_batch(&ddl_for(&["archives"]))?;
    Ok(())
}

/// v17 (§3.4 step 17; modular-core Phase 3a — M1, M2, D10, D6): the head and
/// its bytes live on the current rows. `docs` gains `head` (`current_rev`
/// renamed), `frontmatter_raw`, `created_at`, `updated_at`, `deleted_at`
/// (`deleted_commit` gone); `blocks` gains `raw`, `trivia`, `created_at`,
/// `updated_at`, `deleted_at` (`created_commit`/`deleted_commit` gone);
/// `resurrection_pool` gains `created_at` and (3b) `deleted_at` in place of
/// `deleted_commit`. SQLite cannot rename a column a
/// partial index names or add a NOT NULL column without a default, so the
/// three tables are rebuilt the documented way (as v15 did), with
/// `foreign_keys = OFF` for the duration and `PRAGMA foreign_key_check` empty
/// at the end. The backfill reads the 16.x history tables ONCE: the
/// frontmatter raw by resolving every live head through the recorder
/// (`frontmatter_at_revision` — the 16.x delta chain, §6.1 "Resolving"), the
/// block bytes from `blobs` by hash (a hash with no blob aborts the migration
/// — I5 made it impossible), the timestamps from the `revisions`/`commits`
/// and `block_changes`/`commits` joins the 16.x readers computed on every
/// read, `deleted_at` from the tombstone commit's `ts`. `blocks` keeps its
/// `rowid`s — `blocks_fts` is an external-content index keyed by them.
/// Idempotent: a `docs` table that already carries `head` is left alone. The
/// identity half of the step — the pool's `deleted_at` and the `id_claims`
/// backfill (3b) — is [`migrate_v17_claims`], idempotent on its own so a 3a
/// database at 17 can finish the step on open.
fn migrate_v17(conn: &Connection, history: Option<&dyn HistoryRecorder>) -> Result<()> {
    if has_column(conn, "docs", "head")? != Some(false) {
        return Ok(());
    }
    let clock = crate::core::time::now_ts();
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    let rebuilt = (|| -> Result<()> {
        let tx = conn.unchecked_transaction()?;
        migrate_v17_in(&tx, history, &clock)?;
        let violations: i64 = {
            let mut stmt = tx.prepare("PRAGMA foreign_key_check")?;
            let rows = stmt.query_map([], |_| Ok(()))?;
            i64::try_from(rows.count()).unwrap_or(i64::MAX)
        };
        if violations > 0 {
            return Err(Error::Other(format!(
                "migration v17: {violations} foreign key violation(s) after rebuilding docs, blocks and resurrection_pool"
            )));
        }
        tx.commit()?;
        Ok(())
    })();
    conn.pragma_update(None, "foreign_keys", "ON")?;
    rebuilt
}

/// The three rebuilds of step 17 inside the open transaction.
fn migrate_v17_in(
    db: &Connection,
    history: Option<&dyn HistoryRecorder>,
    clock: &str,
) -> Result<()> {
    let history = history.ok_or_else(|| {
        Error::Other(
            "migration v17: the history recorder is needed to resolve the 16.x frontmatter deltas"
                .to_owned(),
        )
    })?;
    let mut ts_of_commit = db.prepare("SELECT ts FROM commits WHERE commit_id = ?1")?;
    let mut commit_ts = |id: Option<&str>| -> Result<Option<String>> {
        match id {
            None => Ok(None),
            Some(id) => Ok(ts_of_commit
                .query_row(params![id], |r| r.get::<_, String>(0))
                .optional()?),
        }
    };

    // ---- docs ----
    db.execute_batch(
        "CREATE TABLE docs_v17 (
  doc_id             TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL REFERENCES repos(repo_id),
  path               TEXT NOT NULL,
  format             TEXT NOT NULL DEFAULT 'markdown',
  head               TEXT,
  file_hash          BLOB,
  conflicted         INTEGER NOT NULL DEFAULT 0,
  leading_trivia     TEXT NOT NULL DEFAULT '',
  frontmatter_raw    TEXT,
  frontmatter_trivia TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT,
  UNIQUE (repo_id, path)
);",
    )?;
    // The columns copied through are read as SQL values: a 16.x fixture may
    // hold a BLOB where the DDL says TEXT, and the reference copies them as-is.
    struct DocRow {
        rowid: i64,
        doc_id: String,
        repo_id: SqlValue,
        path: SqlValue,
        format: SqlValue,
        current_rev: Option<String>,
        file_hash: SqlValue,
        conflicted: SqlValue,
        leading_trivia: SqlValue,
        frontmatter_trivia: SqlValue,
        deleted_commit: Option<String>,
    }
    let docs: Vec<DocRow> = {
        let mut stmt = db.prepare(
            "SELECT rowid, doc_id, repo_id, path, format, current_rev, file_hash, conflicted, leading_trivia, frontmatter_trivia, deleted_commit FROM docs ORDER BY rowid",
        )?;
        let it = stmt.query_map([], |r| {
            Ok(DocRow {
                rowid: r.get(0)?,
                doc_id: r.get(1)?,
                repo_id: r.get(2)?,
                path: r.get(3)?,
                format: r.get(4)?,
                current_rev: r.get(5)?,
                file_hash: r.get(6)?,
                conflicted: r.get(7)?,
                leading_trivia: r.get(8)?,
                frontmatter_trivia: r.get(9)?,
                deleted_commit: r.get(10)?,
            })
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    {
        let mut rev_of = db.prepare(
            "SELECT frontmatter_blob IS NOT NULL, commit_id FROM revisions WHERE rev_id = ?1",
        )?;
        let mut first_rev =
            db.prepare("SELECT commit_id FROM revisions WHERE doc_id = ?1 AND seq = 1")?;
        let mut ins = db.prepare(
            "INSERT INTO docs_v17 (rowid, doc_id, repo_id, path, format, head, file_hash, conflicted, leading_trivia, frontmatter_raw, frontmatter_trivia, created_at, updated_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        )?;
        for d in &docs {
            let rev: Option<(bool, String)> = match &d.current_rev {
                Some(rev) => rev_of
                    .query_row(params![rev], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()?,
                None => None,
            };
            let frontmatter_raw = match (&rev, &d.current_rev) {
                (Some((true, _)), Some(rev)) => history.frontmatter_at_revision(db, rev)?,
                _ => None,
            };
            let first: Option<String> = first_rev
                .query_row(params![d.doc_id], |r| r.get(0))
                .optional()?;
            let created_at = commit_ts(first.as_deref())?.unwrap_or_else(|| clock.to_owned());
            let updated_at = commit_ts(rev.as_ref().map(|(_, c)| c.as_str()))?
                .unwrap_or_else(|| created_at.clone());
            let deleted_at = commit_ts(d.deleted_commit.as_deref())?;
            ins.execute(params![
                d.rowid,
                d.doc_id,
                d.repo_id,
                d.path,
                d.format,
                d.current_rev,
                d.file_hash,
                d.conflicted,
                d.leading_trivia,
                frontmatter_raw,
                d.frontmatter_trivia,
                created_at,
                updated_at,
                deleted_at,
            ])?;
        }
    }
    db.execute_batch("DROP TABLE docs; ALTER TABLE docs_v17 RENAME TO docs;")?;

    // ---- blocks ----
    db.execute_batch(
        "CREATE TABLE blocks_v17 (
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
  raw            TEXT NOT NULL,
  raw_hash       BLOB NOT NULL,
  norm_hash      BLOB NOT NULL,
  trivia         TEXT,
  trivia_hash    BLOB,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);",
    )?;
    let mut blob_of = db.prepare("SELECT bytes FROM blobs WHERE hash = ?1")?;
    let mut bytes_of = |hash: Option<&[u8]>, what: &str| -> Result<Option<String>> {
        let Some(hash) = hash else {
            return Ok(None);
        };
        let b: Option<Vec<u8>> = blob_of.query_row(params![hash], |r| r.get(0)).optional()?;
        match b {
            Some(b) => Ok(Some(String::from_utf8_lossy(&b).into_owned())),
            None => Err(Error::Other(format!(
                "migration v17: {what} {} has no blobs row",
                omgbase_format::hash::hex(hash)
            ))),
        }
    };
    let mut span = db.prepare(
        "SELECT MIN(c.ts), MAX(c.ts) FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE bc.block_id = ?1",
    )?;
    struct BlockRow {
        rowid: i64,
        block_id: String,
        repo_id: SqlValue,
        doc_id: SqlValue,
        parent_block: SqlValue,
        order_key: SqlValue,
        ordinal: SqlValue,
        depth: SqlValue,
        ancestor_path: SqlValue,
        kind: SqlValue,
        attrs: SqlValue,
        text: SqlValue,
        raw_hash: Vec<u8>,
        norm_hash: SqlValue,
        trivia_hash: Option<Vec<u8>>,
        created_commit: String,
        deleted_commit: Option<String>,
    }
    let blocks: Vec<BlockRow> = {
        let mut stmt = db.prepare(
            "SELECT rowid, block_id, repo_id, doc_id, parent_block, order_key, ordinal, depth, ancestor_path, type, attrs, text, raw_hash, norm_hash, trivia_hash, created_commit, deleted_commit FROM blocks ORDER BY rowid",
        )?;
        let it = stmt.query_map([], |r| {
            Ok(BlockRow {
                rowid: r.get(0)?,
                block_id: r.get(1)?,
                repo_id: r.get(2)?,
                doc_id: r.get(3)?,
                parent_block: r.get(4)?,
                order_key: r.get(5)?,
                ordinal: r.get(6)?,
                depth: r.get(7)?,
                ancestor_path: r.get(8)?,
                kind: r.get(9)?,
                attrs: r.get(10)?,
                text: r.get(11)?,
                raw_hash: r.get(12)?,
                norm_hash: r.get(13)?,
                trivia_hash: r.get(14)?,
                created_commit: r.get(15)?,
                deleted_commit: r.get(16)?,
            })
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    {
        let mut ins = db.prepare(
            "INSERT INTO blocks_v17 (rowid, block_id, repo_id, doc_id, parent_block, order_key, ordinal, depth, ancestor_path, type, attrs, text, raw, raw_hash, norm_hash, trivia, trivia_hash, created_at, updated_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        )?;
        for b in &blocks {
            let (lo, hi): (Option<String>, Option<String>) =
                span.query_row(params![b.block_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            let fallback = commit_ts(Some(&b.created_commit))?.unwrap_or_else(|| clock.to_owned());
            let raw = bytes_of(Some(&b.raw_hash), &format!("block {} raw_hash", b.block_id))?
                .unwrap_or_default();
            let trivia = bytes_of(
                b.trivia_hash.as_deref(),
                &format!("block {} trivia_hash", b.block_id),
            )?;
            ins.execute(params![
                b.rowid,
                b.block_id,
                b.repo_id,
                b.doc_id,
                b.parent_block,
                b.order_key,
                b.ordinal,
                b.depth,
                b.ancestor_path,
                b.kind,
                b.attrs,
                b.text,
                raw,
                b.raw_hash,
                b.norm_hash,
                trivia,
                b.trivia_hash,
                lo.unwrap_or_else(|| fallback.clone()),
                hi.unwrap_or_else(|| fallback.clone()),
                commit_ts(b.deleted_commit.as_deref())?,
            ])?;
        }
    }
    db.execute_batch(
        "DROP TABLE blocks;
ALTER TABLE blocks_v17 RENAME TO blocks;
CREATE INDEX IF NOT EXISTS idx_blocks_doc      ON blocks(doc_id, parent_block, order_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_type     ON blocks(repo_id, type)                   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_rawhash  ON blocks(raw_hash);
CREATE INDEX IF NOT EXISTS idx_blocks_ancestor ON blocks(doc_id, ancestor_path);",
    )?;

    // ---- resurrection_pool ----
    rebuild_pool_v17(db, clock)?;
    Ok(())
}

/// The pool rebuild of step 17 (§3.4 step 17 (3); runs inside
/// [`migrate_v17`]'s transaction, or alone for a 3a database): `created_at` =
/// MIN(commits.ts) over the block's `block_changes`, else `deleted_at`;
/// `deleted_at` = the `ts` of `deleted_commit`'s commit, else `expires_ts −
/// 30 days` (I6 made the two equal, so the fallback is exact);
/// `deleted_commit` dropped; `rowid`s kept. Idempotent: a pool that already
/// has `deleted_at` is left alone. A pre-state may lack `created_at` (a 16.x
/// pool) or carry it (a 3a pool): the column is copied when present.
fn rebuild_pool_v17(db: &Connection, clock: &str) -> Result<()> {
    let cols = column_names(db, "resurrection_pool")?;
    if cols.is_empty() || cols.iter().any(|c| c == "deleted_at") {
        return Ok(());
    }
    let had_created_at = cols.iter().any(|c| c == "created_at");
    let mut ts_of_commit = db.prepare("SELECT ts FROM commits WHERE commit_id = ?1")?;
    let mut span = db.prepare(
        "SELECT MIN(c.ts) FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE bc.block_id = ?1",
    )?;
    db.execute_batch(
        "CREATE TABLE resurrection_pool_v17 (
  block_id       TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  doc_id         TEXT NOT NULL,
  raw_hash       BLOB NOT NULL,
  norm_hash      BLOB NOT NULL,
  type           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  deleted_at     TEXT NOT NULL,
  expires_ts     TEXT NOT NULL
);",
    )?;
    struct PoolRow {
        rowid: i64,
        block_id: String,
        repo_id: SqlValue,
        doc_id: SqlValue,
        raw_hash: SqlValue,
        norm_hash: SqlValue,
        kind: SqlValue,
        created_at: Option<String>,
        deleted_commit: String,
        expires_ts: String,
    }
    let pool: Vec<PoolRow> = {
        let created = if had_created_at {
            "created_at"
        } else {
            "NULL AS created_at"
        };
        let mut stmt = db.prepare(&format!(
            "SELECT rowid, block_id, repo_id, doc_id, raw_hash, norm_hash, type, {created}, deleted_commit, expires_ts FROM resurrection_pool ORDER BY rowid"
        ))?;
        let it = stmt.query_map([], |r| {
            Ok(PoolRow {
                rowid: r.get(0)?,
                block_id: r.get(1)?,
                repo_id: r.get(2)?,
                doc_id: r.get(3)?,
                raw_hash: r.get(4)?,
                norm_hash: r.get(5)?,
                kind: r.get(6)?,
                created_at: r.get(7)?,
                deleted_commit: r.get(8)?,
                expires_ts: r.get(9)?,
            })
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    {
        let mut ins = db.prepare(
            "INSERT INTO resurrection_pool_v17 (rowid, block_id, repo_id, doc_id, raw_hash, norm_hash, type, created_at, deleted_at, expires_ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;
        for p in &pool {
            let deleted_at = match ts_of_commit
                .query_row(params![p.deleted_commit], |r| r.get::<_, String>(0))
                .optional()?
            {
                Some(ts) => ts,
                None => crate::core::time::plus_ms(&p.expires_ts, -POOL_TTL_MS)
                    .unwrap_or_else(|_| clock.to_owned()),
            };
            let lo: Option<String> = span.query_row(params![p.block_id], |r| r.get(0))?;
            let created_at = p
                .created_at
                .clone()
                .or(lo)
                .unwrap_or_else(|| deleted_at.clone());
            ins.execute(params![
                p.rowid,
                p.block_id,
                p.repo_id,
                p.doc_id,
                p.raw_hash,
                p.norm_hash,
                p.kind,
                created_at,
                deleted_at,
                p.expires_ts,
            ])?;
        }
    }
    db.execute_batch(
        "DROP TABLE resurrection_pool; ALTER TABLE resurrection_pool_v17 RENAME TO resurrection_pool;",
    )?;
    Ok(())
}

/// The recovery half of step 17 (§3.4 step 17 (5); modular-core Phase 3c —
/// M4): `pending_materializations` rebuilt self-contained — `head` = the
/// row's `rev_id` (the same `r_` token: the head IS the revision id the core
/// mints), `prior_hash` = the `rendered_hash` of the revision before it
/// (`seq − 1` of the same document, resolved ONCE from the 16.x history;
/// `NULL` for a first revision, a `remove` row or an unknown revision),
/// `created_at` = the recording commit's `ts` (the migration's clock when the
/// commit is gone); the two foreign keys (`revisions`, `commits`) dropped;
/// `rowid`s kept (a materializer replays in insertion order). Runs after
/// [`migrate_v17`] and [`migrate_v17_claims`] in step 17, or alone for a
/// 3a/3b database at 17 (a short transaction of its own; the table it
/// rebuilds has no incoming foreign key). Idempotent: a table that already
/// carries `head` is left alone, as is a pre-state without the table.
fn migrate_v17_pending(conn: &Connection) -> Result<()> {
    if has_column(conn, "pending_materializations", "head")? != Some(false) {
        return Ok(());
    }
    let clock = crate::core::time::now_ts();
    let has_revisions = table_exists(conn, "revisions")?;
    let has_commits = table_exists(conn, "commits")?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "CREATE TABLE pending_materializations_v17 (
  repo_id       TEXT NOT NULL REFERENCES repos(repo_id),
  path          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('write','rename','remove')),
  from_path     TEXT,
  doc_id        TEXT NOT NULL REFERENCES docs(doc_id),
  head          TEXT,
  rendered_hash BLOB NOT NULL,
  prior_hash    BLOB,
  commit_id     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (repo_id, path)
);",
    )?;
    let prior = if has_revisions {
        "(SELECT q.rendered_hash FROM revisions r JOIN revisions q ON q.doc_id = r.doc_id AND q.seq = r.seq - 1 WHERE r.rev_id = p.rev_id)"
    } else {
        "NULL"
    };
    let created_at = if has_commits {
        "COALESCE((SELECT c.ts FROM commits c WHERE c.commit_id = p.commit_id), ?1)"
    } else {
        "?1"
    };
    tx.execute(
        &format!(
            "INSERT INTO pending_materializations_v17 (rowid, repo_id, path, kind, from_path, doc_id, head, rendered_hash, prior_hash, commit_id, created_at)
             SELECT p.rowid, p.repo_id, p.path, p.kind, p.from_path, p.doc_id, p.rev_id, p.rendered_hash,
                    CASE WHEN p.kind = 'remove' THEN NULL ELSE {prior} END, p.commit_id, {created_at}
               FROM pending_materializations p ORDER BY p.rowid"
        ),
        params![clock],
    )?;
    tx.execute_batch(
        "DROP TABLE pending_materializations; ALTER TABLE pending_materializations_v17 RENAME TO pending_materializations;",
    )?;
    tx.commit()?;
    Ok(())
}

/// The identity half of step 17 (§3.4 step 17 (3)–(4); modular-core Phase
/// 3b — M3/D5): the pool's `deleted_at` ([`rebuild_pool_v17`]) and the
/// `id_claims` table (§2.1) created and BACKFILLED with one row per id the
/// current rows and the history still name — `d` from `docs` (`minted_at =
/// created_at`), `b` from `blocks`, `resurrection_pool` (their `created_at`)
/// and every `block_changes`/`dispositions` row (MIN of its commits' `ts`),
/// `r` from `docs.head` (`updated_at`) and `revisions` (the commit's `ts`),
/// `x` from `external_nodes` (the earliest edge's commit), `e` from `edges`
/// (its `from_commit`), `rp` from `repos` (the repo's first commit), `src`
/// from `sources` (the clock; workspace-scoped, `repo_id` NULL). `holders` =
/// bit 0 when a core row names the id, plus bit 1 when a history row does —
/// so a long-deleted block's `b` is `2`, a live block's `3`, an old
/// revision's `r` `2`, a repo's `rp` `1`. The recorder's `c` and `s` get no
/// claim (their own rows are their claims), nor does `cp`. Every statement
/// upserts, ORing the holders in and keeping the earliest `minted_at`, in the
/// reference's statement order (the table's `rowid` order is the fixture's
/// row order). Idempotent: an existing `id_claims` table is left alone.
fn migrate_v17_claims(conn: &Connection) -> Result<()> {
    let clock = crate::core::time::now_ts();
    let has_claims = table_exists(conn, "id_claims")?;
    let pool_cols = column_names(conn, "resurrection_pool")?;
    let pool_done = pool_cols.is_empty() || pool_cols.iter().any(|c| c == "deleted_at");
    if has_claims && pool_done {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    if !pool_done {
        rebuild_pool_v17(&tx, &clock)?;
    }
    if !has_claims {
        tx.execute_batch(&ddl_for(&["id_claims"]))?;
        // `WHERE true` disambiguates the upsert clause from a join constraint
        // (sqlite.org/lang_upsert), as the reference spells it.
        const UPSERT: &str = "ON CONFLICT(id) DO UPDATE SET holders = holders | excluded.holders, minted_at = min(minted_at, excluded.minted_at)";
        // A migration fixture's pre-state is a PARTIAL old schema (§3.4: the
        // tables the step touches), so every source is read only when its
        // tables exist; a real database has them all.
        let has = |tables: &[&str]| -> Result<bool> {
            for t in tables {
                if !table_exists(&tx, t)? {
                    return Ok(false);
                }
            }
            Ok(true)
        };
        let has_commits = has(&["commits"])?;
        let has_repos = has(&["repos"])?;
        let commit_ts = if has_commits { "c.ts" } else { "NULL" };
        let commit_repo = if has_commits { "c.repo_id" } else { "NULL" };
        let commit_join = |on: &str| -> String {
            if has_commits {
                format!("LEFT JOIN commits c ON c.commit_id = {on}")
            } else {
                String::new()
            }
        };
        let any_repo = if has_repos {
            "(SELECT repo_id FROM repos ORDER BY rowid LIMIT 1)"
        } else {
            "NULL"
        };
        let ins = |tables: &[&str], select: &str| -> Result<()> {
            if !has(tables)? {
                return Ok(());
            }
            let sql = format!(
                "INSERT INTO id_claims (id, repo_id, prefix, minted_at, holders) {select} {UPSERT}"
            );
            if select.contains(":clock") {
                tx.execute(&sql, rusqlite::named_params! { ":clock": clock })?;
            } else {
                tx.execute(&sql, [])?;
            }
            Ok(())
        };
        // d
        ins(
            &["docs"],
            "SELECT doc_id, repo_id, 'd', created_at, 1 FROM docs WHERE true",
        )?;
        ins(
            &["docs", "revisions"],
            "SELECT DISTINCT r.doc_id, d.repo_id, 'd', d.created_at, 2 FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE true",
        )?;
        // b
        ins(
            &["blocks"],
            "SELECT block_id, repo_id, 'b', created_at, 1 FROM blocks WHERE true",
        )?;
        ins(
            &["resurrection_pool"],
            "SELECT block_id, repo_id, 'b', created_at, 1 FROM resurrection_pool WHERE true",
        )?;
        ins(
            &["block_changes"],
            &format!(
                "SELECT bc.block_id, COALESCE({commit_repo}, {any_repo}), 'b', COALESCE(MIN({commit_ts}), :clock), 2 FROM block_changes bc {} WHERE true GROUP BY bc.block_id",
                commit_join("bc.commit_id")
            ),
        )?;
        ins(
            &["dispositions"],
            &format!(
                "SELECT x.block_id, COALESCE({commit_repo}, {any_repo}), 'b', COALESCE(MIN({commit_ts}), :clock), 2 FROM dispositions x {} WHERE x.block_id != 'DOC' GROUP BY x.block_id",
                commit_join("x.commit_id")
            ),
        )?;
        // r
        ins(
            &["docs"],
            "SELECT head, repo_id, 'r', updated_at, 1 FROM docs WHERE head IS NOT NULL",
        )?;
        ins(
            &["docs", "revisions"],
            &format!(
                "SELECT r.rev_id, d.repo_id, 'r', COALESCE({commit_ts}, :clock), 2 FROM revisions r JOIN docs d ON d.doc_id = r.doc_id {} WHERE true",
                commit_join("r.commit_id")
            ),
        )?;
        // x, e
        ins(
            &["external_nodes", "edges"],
            &format!(
                "SELECT n.node_id, n.repo_id, 'x', COALESCE(MIN({commit_ts}), :clock), 1 FROM external_nodes n LEFT JOIN edges e ON e.dst_node = n.node_id {} WHERE true GROUP BY n.node_id",
                commit_join("e.from_commit")
            ),
        )?;
        ins(
            &["edges"],
            &format!(
                "SELECT e.edge_id, e.repo_id, 'e', COALESCE({commit_ts}, :clock), 1 FROM edges e {} WHERE true",
                commit_join("e.from_commit")
            ),
        )?;
        // rp, src
        let first_commit = if has_commits {
            "(SELECT MIN(ts) FROM commits WHERE repo_id = r.repo_id)"
        } else {
            "NULL"
        };
        ins(
            &["repos"],
            &format!(
                "SELECT r.repo_id, r.repo_id, 'rp', COALESCE({first_commit}, :clock), 1 FROM repos r WHERE true"
            ),
        )?;
        ins(
            &["sources"],
            "SELECT source_id, NULL, 'src', :clock, 1 FROM sources WHERE true",
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// `move <from> -> <to>` (a 16.x `docs_move` commit's reason) → `(from, to)`
/// — the reference's `/^move (.+) -> (.+)$/`: the greedy first group splits
/// at the LAST ` -> `, both sides non-empty, no line terminator in either
/// (JavaScript's `.`).
fn parse_move_reason(reason: &str) -> Option<(&str, &str)> {
    let rest = reason.strip_prefix("move ")?;
    let (from, to) = rest.rsplit_once(" -> ")?;
    let line = |s: &str| !s.is_empty() && !s.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    (line(from) && line(to)).then_some((from, to))
}

/// The feed half of step 17 (§3.4 step 17 (6)–(9); modular-core Phase 3d —
/// D7/M5, D4): the repository EPOCH, the `feed`/`feed_entries` tables
/// backfilled from the 16.x `commits`/`revisions`, the recorder's `commits`
/// row rebuilt with `epoch`/`batch_id` and without `checkpoint_id`, the
/// `sync_state` status row from the latest `checkpoints` row, and
/// `checkpoints` dropped. One transaction, `foreign_keys = OFF` for its
/// duration (`repos` and `commits` are rebuilt; both are referenced),
/// `PRAGMA foreign_key_check` empty at its end. Idempotent on each part:
/// `repos` with `epoch` is left alone, an existing `feed` is not backfilled
/// again, `commits` without `checkpoint_id` is left alone, `sync_state` with
/// the status columns is left alone, a missing `checkpoints` is nothing to
/// drop. Runs after the identity and recovery halves (the claims table must
/// exist for the `c`/`ep` claims). A pre-state without `repos` has no
/// repository to give an epoch and is left alone (the migration fixtures'
/// partial pre-states; a real database always has it). The `ep` ids are
/// drawn from the store's minter (the fixture minter: `ep_0`, …) without the
/// oracle, like v13's `src` — a pre-17 database has no `id_claims` to probe.
fn migrate_v17_feed(conn: &Connection, ids: &mut IdSource) -> Result<()> {
    if !table_exists(conn, "repos")? {
        return Ok(());
    }
    let needs_epoch = has_column(conn, "repos", "epoch")? == Some(false);
    let needs_feed = !table_exists(conn, "feed")?;
    let needs_commits = has_column(conn, "commits", "checkpoint_id")? == Some(true);
    let needs_status = has_column(conn, "sync_state", "last_batch_ts")? == Some(false);
    let has_checkpoints = table_exists(conn, "checkpoints")?;
    if !needs_epoch && !needs_feed && !needs_commits && !needs_status && !has_checkpoints {
        return Ok(());
    }
    let clock = crate::core::time::now_ts();
    let has_commits = table_exists(conn, "commits")?;
    let has_claims = table_exists(conn, "id_claims")?;
    conn.pragma_update(None, "foreign_keys", "OFF")?;
    let rebuilt = (|| -> Result<()> {
        let tx = conn.unchecked_transaction()?;
        // (6) repos: the epoch — one `ep` per repository in rowid order, the
        // claim minted at the repo's first commit's ts (the epoch is as old as
        // the feed it scopes), else the clock. A rebuild: SQLite cannot add a
        // NOT NULL column without a default.
        if needs_epoch {
            tx.execute_batch(
                "CREATE TABLE repos_v17 (
  repo_id   TEXT PRIMARY KEY,
  slug      TEXT NOT NULL UNIQUE,
  settings  TEXT NOT NULL DEFAULT '{}',
  epoch     TEXT NOT NULL
);",
            )?;
            let repos: Vec<(i64, String, SqlValue, Option<String>)> = {
                let mut stmt =
                    tx.prepare("SELECT rowid, repo_id, slug, settings FROM repos ORDER BY rowid")?;
                let it =
                    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
                it.collect::<std::result::Result<Vec<_>, _>>()?
            };
            let mut mint = ids.at_unchecked(&tx);
            for (rowid, repo_id, slug, settings) in &repos {
                let epoch = mint.mint("ep")?;
                tx.execute(
                    "INSERT INTO repos_v17 (rowid, repo_id, slug, settings, epoch) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![rowid, repo_id, slug, settings.as_deref().unwrap_or("{}"), epoch],
                )?;
                if has_claims {
                    let first_ts: Option<String> = if has_commits {
                        tx.query_row(
                            "SELECT MIN(ts) FROM commits WHERE repo_id = ?1",
                            params![repo_id],
                            |r| r.get(0),
                        )?
                    } else {
                        None
                    };
                    tx.execute(
                        "INSERT INTO id_claims (id, repo_id, prefix, minted_at, holders) VALUES (?1, ?2, 'ep', ?3, 1)
                         ON CONFLICT(id) DO UPDATE SET holders = holders | 1",
                        params![epoch, repo_id, first_ts.as_deref().unwrap_or(&clock)],
                    )?;
                }
            }
            tx.execute_batch("DROP TABLE repos; ALTER TABLE repos_v17 RENAME TO repos;")?;
        }

        // (7) feed + feed_entries, backfilled from the 16.x `commits`/`revisions`:
        // one row per commit (`epoch` the new one, `seq = commits.seq`,
        // `batch_id = commit_id` — no checkpoint grouped them; `plan_id` NULL);
        // entries `created`/`changed` from `revisions` (seq 1 ⇒ created),
        // `deleted` from the tombstones whose `deleted_at` is the commit's ts,
        // `moved` only where a commit with no entry of its own records
        // `move <from> -> <to>` in its reason (resolution 12: what the rows
        // say, no path reconstruction) — the doc now at `<to>`, its current
        // head and hash. Then the prune under the defaults.
        if needs_feed {
            tx.execute_batch(&ddl_for(&["feed", "feed_entries"]))?;
            if has_commits {
                let has_revisions = table_exists(&tx, "revisions")?;
                let has_docs = has_column(&tx, "docs", "deleted_at")? == Some(true);
                type CommitRow = (
                    String,
                    String,
                    i64,
                    String,
                    String,
                    Option<String>,
                    Option<String>,
                );
                let commits: Vec<CommitRow> = {
                    let mut stmt = tx.prepare(
                        "SELECT commit_id, repo_id, seq, ts, origin, actor, reason FROM commits ORDER BY repo_id, seq",
                    )?;
                    let it = stmt.query_map([], |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                        ))
                    })?;
                    it.collect::<std::result::Result<Vec<_>, _>>()?
                };
                let mut epoch_of = tx.prepare("SELECT epoch FROM repos WHERE repo_id = ?1")?;
                let mut ins_row = tx.prepare(
                    "INSERT OR IGNORE INTO feed (repo_id, epoch, seq, commit_id, ts, origin, actor, reason, batch_id, plan_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
                )?;
                let mut ins_entry = tx.prepare(
                    "INSERT OR IGNORE INTO feed_entries (repo_id, epoch, seq, doc_id, path, head, hash, kind, from_path) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                )?;
                let mut revs = if has_revisions {
                    Some(tx.prepare(
                        "SELECT doc_id, seq, rev_id, rendered_hash, path FROM revisions WHERE commit_id = ?1 ORDER BY rowid",
                    )?)
                } else {
                    None
                };
                let mut gone = if has_docs {
                    Some(tx.prepare(
                        "SELECT doc_id, path FROM docs WHERE repo_id = ?1 AND deleted_at = ?2 ORDER BY path",
                    )?)
                } else {
                    None
                };
                let mut at = if has_docs {
                    Some(tx.prepare(
                        "SELECT doc_id, head, file_hash FROM docs WHERE repo_id = ?1 AND path = ?2",
                    )?)
                } else {
                    None
                };
                for (commit_id, repo_id, seq, ts, origin, actor, reason) in &commits {
                    let epoch: Option<String> = epoch_of
                        .query_row(params![repo_id], |r| r.get(0))
                        .optional()?;
                    let Some(epoch) = epoch else {
                        continue;
                    };
                    ins_row.execute(params![
                        repo_id, epoch, seq, commit_id, ts, origin, actor, reason, commit_id
                    ])?;
                    let mut entries = 0usize;
                    if let Some(revs) = revs.as_mut() {
                        type RevRow = (String, i64, String, Vec<u8>, String);
                        let rows: Vec<RevRow> = revs
                            .query_map(params![commit_id], |r| {
                                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                            })?
                            .collect::<std::result::Result<_, _>>()?;
                        for (doc_id, rev_seq, rev_id, rendered_hash, path) in rows {
                            let kind = if rev_seq == 1 { "created" } else { "changed" };
                            ins_entry.execute(params![
                                repo_id,
                                epoch,
                                seq,
                                doc_id,
                                path,
                                rev_id,
                                rendered_hash,
                                kind,
                                Option::<String>::None
                            ])?;
                            entries += 1;
                        }
                    }
                    if let Some(gone) = gone.as_mut() {
                        let rows: Vec<(String, String)> = gone
                            .query_map(params![repo_id, ts], |r| Ok((r.get(0)?, r.get(1)?)))?
                            .collect::<std::result::Result<_, _>>()?;
                        for (doc_id, path) in rows {
                            ins_entry.execute(params![
                                repo_id,
                                epoch,
                                seq,
                                doc_id,
                                path,
                                Option::<String>::None,
                                Option::<Vec<u8>>::None,
                                "deleted",
                                Option::<String>::None
                            ])?;
                            entries += 1;
                        }
                    }
                    if entries == 0
                        && let (Some(reason), Some(at)) = (reason.as_deref(), at.as_mut())
                        && let Some((from, to)) = parse_move_reason(reason)
                    {
                        let doc: Option<(String, Option<String>, Option<Vec<u8>>)> = at
                            .query_row(params![repo_id, to], |r| {
                                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                            })
                            .optional()?;
                        if let Some((doc_id, head, file_hash)) = doc {
                            ins_entry.execute(params![
                                repo_id, epoch, seq, doc_id, to, head, file_hash, "moved", from
                            ])?;
                        }
                    }
                }
            }
            // The prune under the defaults (§7.4) — the settings layers exist
            // on every real database; a partial fixture pre-state may lack them.
            if table_exists(&tx, "workspace_settings")? {
                crate::core::feed::prune_feed(&tx, &clock)?;
            }
            // The `c` claims (§2.1, 3d: the core mints `c` and claims it):
            // bit 0 for every commit the feed holds, bit 1 for every `commits`
            // row.
            if has_claims && has_commits {
                tx.execute(
                    "INSERT INTO id_claims (id, repo_id, prefix, minted_at, holders) SELECT commit_id, repo_id, 'c', ts, 1 FROM feed WHERE true
                     ON CONFLICT(id) DO UPDATE SET holders = holders | 1, minted_at = min(minted_at, excluded.minted_at)",
                    [],
                )?;
                tx.execute(
                    "INSERT INTO id_claims (id, repo_id, prefix, minted_at, holders) SELECT commit_id, repo_id, 'c', ts, 2 FROM commits WHERE true
                     ON CONFLICT(id) DO UPDATE SET holders = holders | 2, minted_at = min(minted_at, excluded.minted_at)",
                    [],
                )?;
            }
        }

        // (8) commits: the recorder's row — `epoch` (the repo's), `batch_id =
        // commit_id`, `checkpoint_id` dropped, `rowid`s kept.
        if needs_commits {
            tx.execute_batch(
                "CREATE TABLE commits_v17 (
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
INSERT INTO commits_v17 (rowid, commit_id, repo_id, epoch, seq, ts, origin, actor, reason, batch_id, ops)
  SELECT c.rowid, c.commit_id, c.repo_id, COALESCE((SELECT epoch FROM repos r WHERE r.repo_id = c.repo_id), ''), c.seq, c.ts, c.origin, c.actor, c.reason, c.commit_id, c.ops FROM commits c ORDER BY c.rowid;
DROP TABLE commits;
ALTER TABLE commits_v17 RENAME TO commits;",
            )?;
        }

        // (9) sync_state: the three status columns; per repository the
        // reserved row from the latest `checkpoints` row by ts (`last_batch_id`
        // NULL — the batch id is unknowable, `files` the array's length); then
        // drop `checkpoints`.
        if needs_status {
            tx.execute_batch(
                "ALTER TABLE sync_state ADD COLUMN last_batch_ts TEXT;
ALTER TABLE sync_state ADD COLUMN last_batch_id TEXT;
ALTER TABLE sync_state ADD COLUMN last_batch_files INTEGER;",
            )?;
        }
        if has_checkpoints && table_exists(&tx, "sync_state")? {
            tx.execute(
                "INSERT OR IGNORE INTO sync_state (repo_id, source_id, path, revision, cursor, last_batch_ts, last_batch_id, last_batch_files)
                 SELECT cp.repo_id, '', '', NULL, NULL, cp.ts, NULL, json_array_length(cp.files)
                   FROM checkpoints cp WHERE cp.rowid = (SELECT c2.rowid FROM checkpoints c2 WHERE c2.repo_id = cp.repo_id ORDER BY c2.ts DESC, c2.rowid DESC LIMIT 1)",
                [],
            )?;
        }
        if has_checkpoints {
            tx.execute_batch("DROP TABLE checkpoints")?;
        }

        let violations: i64 = {
            let mut stmt = tx.prepare("PRAGMA foreign_key_check")?;
            let rows = stmt.query_map([], |_| Ok(()))?;
            i64::try_from(rows.count()).unwrap_or(i64::MAX)
        };
        if violations > 0 {
            return Err(Error::Other(format!(
                "migration v17: {violations} foreign key violation(s) after the feed step"
            )));
        }
        tx.commit()?;
        Ok(())
    })();
    conn.pragma_update(None, "foreign_keys", "ON")?;
    rebuilt
}

/// v13 (ADR-014): `repos.root_path` becomes an `fs` source + attachment.
fn migrate_v13(conn: &Connection, minter: &mut Mint<'_>) -> Result<()> {
    if has_column(conn, "repos", "root_path")? != Some(true) {
        return Ok(());
    }
    conn.execute_batch(
        "INSERT OR IGNORE INTO adapters (name, command, args) VALUES ('fs', 'omgbase-fs-adapter', '[]')",
    )?;
    let repos: Vec<(String, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT repo_id, slug, root_path FROM repos WHERE root_path IS NOT NULL AND root_path != ''",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for (repo_id, slug, root) in repos {
        let name = format!("{slug}-fs");
        let existing: Option<String> = conn
            .query_row(
                "SELECT source_id FROM sources WHERE name = ?1",
                params![name],
                |r| r.get(0),
            )
            .optional()?;
        let source_id = match existing {
            Some(id) => id,
            None => {
                let id = minter.mint("src")?;
                let config = serde_json::json!({ "root": root }).to_string();
                conn.execute(
                    "INSERT INTO sources (source_id, name, adapter, config, env) VALUES (?1, ?2, 'fs', ?3, '{}')",
                    params![id, name, config],
                )?;
                id
            }
        };
        conn.execute(
            "INSERT OR IGNORE INTO attachments (repo_id, source_id) VALUES (?1, ?2)",
            params![repo_id, source_id],
        )?;
    }
    conn.execute_batch("ALTER TABLE repos DROP COLUMN root_path")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_statement_has_a_target() {
        let mut targets = Vec::new();
        for s in statements() {
            let t = statement_target(s).unwrap_or_else(|| panic!("no target for {s:?}"));
            targets.push(t);
        }
        assert!(targets.iter().any(|t| t == "repos"));
        assert!(targets.iter().any(|t| t == "blocks_fts"));
        assert!(targets.iter().any(|t| t == "workspace_settings"));
        assert!(targets.iter().any(|t| t == "pending_materializations"));
        assert!(targets.iter().any(|t| t == "archives"));
        assert!(targets.iter().any(|t| t == "feed"));
        assert_eq!(
            targets.iter().filter(|t| *t == "feed").count(),
            2,
            "table + idx_feed_ts"
        );
        assert_eq!(
            targets.iter().filter(|t| *t == "blocks").count(),
            5,
            "table + 4 indexes"
        );
        // Every statement of the file is accounted for: joining them back
        // executes cleanly on a fresh database.
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        for s in statements() {
            conn.execute_batch(s).unwrap();
        }
        assert!(table_exists(&conn, "workspace_settings").unwrap());
        assert!(table_exists(&conn, "pending_materializations").unwrap());
    }

    #[test]
    fn ddl_for_selects_a_table_with_its_indexes_and_seed_rows() {
        let props = ddl_for(&["properties"]);
        assert!(props.contains("CREATE TABLE IF NOT EXISTS properties"));
        assert_eq!(props.matches("CREATE INDEX").count(), 4);
        assert!(!props.contains("CREATE TABLE IF NOT EXISTS docs"));
        let ws = ddl_for(&["workspace_settings"]);
        assert!(ws.contains("INSERT OR IGNORE INTO workspace_settings"));
        let nodes = ddl_for(&["nodes", "nodes_fts"]);
        assert!(nodes.contains("CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts"));
        assert_eq!(nodes.matches("CREATE INDEX").count(), 3);
        let pending = ddl_for(&["pending_materializations"]);
        assert!(pending.contains("CREATE TABLE IF NOT EXISTS pending_materializations"));
        assert!(pending.contains("PRIMARY KEY (repo_id, path)"));
        let archives = ddl_for(&["archives"]);
        assert!(archives.contains("CREATE TABLE IF NOT EXISTS archives"));
        assert!(archives.contains("segment_id     TEXT PRIMARY KEY"));
        let feed = ddl_for(&["feed", "feed_entries"]);
        assert!(feed.contains("CREATE TABLE IF NOT EXISTS feed ("));
        assert!(feed.contains("CREATE INDEX IF NOT EXISTS idx_feed_ts"));
        assert!(feed.contains("CREATE TABLE IF NOT EXISTS feed_entries"));
        assert!(ddl_for(&["nope"]).is_empty());
    }

    /// §3.3 (15.0): the embedded segment DDL creates the manifest and the six
    /// mirrored tables on a fresh database, idempotently.
    #[test]
    fn archive_sql_creates_a_segment() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(ARCHIVE_SQL).unwrap();
        conn.execute_batch(ARCHIVE_SQL).unwrap();
        for t in [
            "manifest",
            "revisions",
            "commits",
            "blobs",
            "tree_nodes",
            "dispositions",
            "block_changes",
        ] {
            assert!(table_exists(&conn, t).unwrap(), "{t}");
        }
        assert!(!table_exists(&conn, "docs").unwrap());
        let cols = column_names(&conn, "revisions").unwrap();
        assert_eq!(cols.len(), 8, "a segment's revisions carry no `archive`");
        let cols = column_names(&conn, "commits").unwrap();
        assert_eq!(
            cols,
            [
                "commit_id",
                "repo_id",
                "epoch",
                "seq",
                "ts",
                "origin",
                "actor",
                "reason",
                "batch_id",
                "ops"
            ],
            "a segment's commits are the recorder's 17.0 row"
        );
    }

    /// The backfill's move rule (§3.4 step 17 (7)): the reference's regex,
    /// greedy on the first group.
    #[test]
    fn move_reasons_parse_like_the_reference() {
        assert_eq!(
            parse_move_reason("move a.md -> b.md"),
            Some(("a.md", "b.md"))
        );
        assert_eq!(
            parse_move_reason("move a -> b -> c.md"),
            Some(("a -> b", "c.md")),
            "the first group is greedy"
        );
        assert_eq!(parse_move_reason("observed deletion"), None);
        assert_eq!(parse_move_reason("move  -> b.md"), None);
        assert_eq!(parse_move_reason("move a.md -> "), None);
        assert_eq!(parse_move_reason("move a.md -> b\n.md"), None);
    }
}
