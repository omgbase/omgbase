//! Derived tables (`spec/store/README.md` §3.2, §4.5, §7): sections, the
//! FTS5 index over block text, rebuild and garbage collection, and the pool
//! sweep.

use std::collections::HashSet;

use omgbase_format::hash::hex;
use rusqlite::{Connection, params};

use crate::error::Result;
use crate::tree::{from_hex, parse_tree_entries};

// ---- sections (§4.5) ------------------------------------------------------------

/// Rebuild `sections` for one document over its top-level live blocks.
pub fn rebuild_sections(conn: &Connection, doc_id: &str) -> Result<()> {
    conn.execute("DELETE FROM sections WHERE doc_id = ?1", params![doc_id])?;
    let tops: Vec<(String, i64, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT block_id, ordinal, type, attrs FROM blocks
             WHERE doc_id = ?1 AND parent_block IS NULL AND deleted_commit IS NULL
             ORDER BY ordinal",
        )?;
        let rows = stmt.query_map(params![doc_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let max_ordinal = tops.last().map_or(-1, |t| t.1);
    let headings: Vec<(&str, i64, i64)> = tops
        .iter()
        .filter(|t| t.2 == "heading")
        .map(|t| {
            let level = serde_json::from_str::<serde_json::Value>(&t.3)
                .ok()
                .and_then(|v| v.get("level").and_then(serde_json::Value::as_i64))
                .unwrap_or(1);
            (t.0.as_str(), t.1, level)
        })
        .collect();
    let mut insert = conn.prepare(
        "INSERT INTO sections (heading_block, doc_id, level, first_ordinal, last_ordinal)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for (i, &(block_id, ordinal, level)) in headings.iter().enumerate() {
        let last = headings[i + 1..]
            .iter()
            .find(|h| h.2 <= level)
            .map_or(max_ordinal, |h| h.1 - 1);
        insert.execute(params![block_id, doc_id, level, ordinal, last])?;
    }
    Ok(())
}

// ---- FTS (external content) ---------------------------------------------------------

/// Remove a document's live block rows from `blocks_fts` (external-content
/// index: a `'delete'` command with the original text, before the rows
/// change). Only live rows are indexed, so only those are deleted.
pub fn fts_delete_doc(conn: &Connection, doc_id: &str) -> Result<()> {
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT rowid, text FROM blocks WHERE doc_id = ?1 AND deleted_commit IS NULL",
        )?;
        let it = stmt.query_map(params![doc_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut del =
        conn.prepare("INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES('delete', ?1, ?2)")?;
    for (rowid, text) in rows {
        del.execute(params![rowid, text])?;
    }
    Ok(())
}

/// Index a document's live block rows.
pub fn fts_index_doc(conn: &Connection, doc_id: &str) -> Result<()> {
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT rowid, text FROM blocks WHERE doc_id = ?1 AND deleted_commit IS NULL",
        )?;
        let it = stmt.query_map(params![doc_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut ins = conn.prepare("INSERT INTO blocks_fts(rowid, text) VALUES(?1, ?2)")?;
    for (rowid, text) in rows {
        ins.execute(params![rowid, text])?;
    }
    Ok(())
}

// ---- rebuild (§7) -------------------------------------------------------------------

/// What [`rebuild_index`] recomputes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RebuildTarget {
    Sections,
    Fts,
    BlockChanges,
    All,
}

/// Recompute derived tables from the durable ones: `sections` per live doc,
/// the FTS index (`'rebuild'`), `block_changes` from `dispositions`.
/// `doc_edges` belongs to the graph component and is not touched.
pub fn rebuild_index(conn: &Connection, target: RebuildTarget) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    if matches!(target, RebuildTarget::Sections | RebuildTarget::All) {
        let doc_ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT doc_id FROM docs WHERE deleted_commit IS NULL")?;
            let it = stmt.query_map([], |r| r.get(0))?;
            it.collect::<std::result::Result<Vec<_>, _>>()?
        };
        for id in &doc_ids {
            rebuild_sections(&tx, id)?;
        }
    }
    if matches!(target, RebuildTarget::Fts | RebuildTarget::All) {
        tx.execute_batch("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')")?;
    }
    if matches!(target, RebuildTarget::BlockChanges | RebuildTarget::All) {
        tx.execute_batch(
            "DELETE FROM block_changes;
             INSERT OR IGNORE INTO block_changes (block_id, commit_id, kind)
               SELECT block_id, commit_id, kind FROM dispositions;",
        )?;
    }
    tx.commit()?;
    Ok(())
}

// ---- garbage (§7) -------------------------------------------------------------------

/// Rows a garbage collection sweeps (or would sweep).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GcResult {
    pub blobs_swept: usize,
    pub tree_nodes_swept: usize,
}

/// The mark phase: tree nodes reachable from every `revisions.root_tree`
/// (walking `child_tree_hash_hex`) and the blobs they name (raw, trivia)
/// plus every `frontmatter_blob`. Hex sets.
pub fn mark_reachable(conn: &Connection) -> Result<(HashSet<String>, HashSet<String>)> {
    let mut trees = HashSet::new();
    let mut blobs = HashSet::new();
    {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT frontmatter_blob FROM revisions WHERE frontmatter_blob IS NOT NULL",
        )?;
        for row in stmt.query_map([], |r| r.get::<_, Vec<u8>>(0))? {
            blobs.insert(hex(&row?));
        }
    }
    let roots: Vec<Vec<u8>> = {
        let mut stmt = conn.prepare("SELECT DISTINCT root_tree FROM revisions")?;
        let it = stmt.query_map([], |r| r.get(0))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut node = conn.prepare("SELECT entries FROM tree_nodes WHERE hash = ?1")?;
    let mut stack: Vec<String> = roots.iter().map(|h| hex(h)).collect();
    while let Some(h) = stack.pop() {
        if !trees.insert(h.clone()) {
            continue;
        }
        let entries: Option<String> = {
            use rusqlite::OptionalExtension;
            node.query_row(params![from_hex(&h)?], |r| r.get(0))
                .optional()?
        };
        let Some(text) = entries else {
            continue;
        };
        for e in parse_tree_entries(&text)? {
            blobs.insert(e.raw_hash_hex);
            if let Some(t) = e.trivia_hash_hex {
                blobs.insert(t);
            }
            if let Some(c) = e.child_tree_hash_hex {
                stack.push(c);
            }
        }
    }
    Ok((trees, blobs))
}

/// `(tree node hashes, blob hashes)` that no revision reaches.
type Unreachable = (Vec<Vec<u8>>, Vec<Vec<u8>>);

fn unreachable_rows(conn: &Connection) -> Result<Unreachable> {
    let (trees, blobs) = mark_reachable(conn)?;
    let all_trees: Vec<Vec<u8>> = {
        let mut stmt = conn.prepare("SELECT hash FROM tree_nodes")?;
        let it = stmt.query_map([], |r| r.get(0))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let all_blobs: Vec<Vec<u8>> = {
        let mut stmt = conn.prepare("SELECT hash FROM blobs")?;
        let it = stmt.query_map([], |r| r.get(0))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    Ok((
        all_trees
            .into_iter()
            .filter(|h| !trees.contains(&hex(h)))
            .collect(),
        all_blobs
            .into_iter()
            .filter(|h| !blobs.contains(&hex(h)))
            .collect(),
    ))
}

/// What a collection would sweep, without deleting anything (§8 I5).
pub fn gc_dry_run(conn: &Connection) -> Result<GcResult> {
    let (trees, blobs) = unreachable_rows(conn)?;
    Ok(GcResult {
        blobs_swept: blobs.len(),
        tree_nodes_swept: trees.len(),
    })
}

/// Mark-and-sweep, flag-gated (`enabled = false` is a no-op). Because
/// revisions are never pruned, nothing is unreachable in practice.
pub fn run_gc(conn: &Connection, enabled: bool) -> Result<GcResult> {
    if !enabled {
        return Ok(GcResult::default());
    }
    let tx = conn.unchecked_transaction()?;
    let (trees, blobs) = unreachable_rows(&tx)?;
    for h in &trees {
        tx.execute("DELETE FROM tree_nodes WHERE hash = ?1", params![h])?;
    }
    for h in &blobs {
        tx.execute("DELETE FROM blobs WHERE hash = ?1", params![h])?;
    }
    tx.commit()?;
    Ok(GcResult {
        blobs_swept: blobs.len(),
        tree_nodes_swept: trees.len(),
    })
}

/// §5.5: `DELETE FROM resurrection_pool WHERE expires_ts <= ts`; rows deleted.
pub fn sweep_pool(conn: &Connection, ts: &str) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM resurrection_pool WHERE expires_ts <= ?1",
        params![ts],
    )?)
}
