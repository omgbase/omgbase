//! The schema (`spec/store/README.md` §3): the embedded `schema.sql`, the
//! opener and the migrations of §3.4.

use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{Error, Result};
use crate::ids::IdMinter;

/// `spec/store/schema.sql`, verbatim (§3.3). Executed on a fresh database.
pub const SCHEMA_SQL: &str = include_str!("../schema.sql");

/// The `PRAGMA user_version` this crate writes: the spec major.
pub const SCHEMA_VERSION: i64 = 13;

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
/// migrate step by step, each in its own transaction.
pub(crate) fn migrate(conn: &Connection, minter: &mut dyn IdMinter) -> Result<()> {
    let current = user_version(conn)?;
    if current == 0 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(SCHEMA_SQL)?;
        set_user_version(&tx, SCHEMA_VERSION)?;
        tx.commit()?;
        return Ok(());
    }
    if current == SCHEMA_VERSION {
        return Ok(());
    }
    if current > SCHEMA_VERSION {
        return Err(Error::SchemaTooNew {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }
    for v in current + 1..=SCHEMA_VERSION {
        let tx = conn.unchecked_transaction()?;
        migrate_step(&tx, v, minter)?;
        tx.commit()?;
    }
    set_user_version(conn, SCHEMA_VERSION)?;
    Ok(())
}

/// One step of §3.4, idempotent.
fn migrate_step(conn: &Connection, to: i64, minter: &mut dyn IdMinter) -> Result<()> {
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
        other => return Err(Error::Other(format!("no migration to schema v{other}"))),
    }
    Ok(())
}

/// v13 (ADR-014): `repos.root_path` becomes an `fs` source + attachment.
fn migrate_v13(conn: &Connection, minter: &mut dyn IdMinter) -> Result<()> {
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
                let id = minter.mint("src");
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
        assert!(ddl_for(&["nope"]).is_empty());
    }
}
