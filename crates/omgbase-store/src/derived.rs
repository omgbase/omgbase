//! Derived tables (`spec/store/README.md` §3.2, §4.5, §7): sections, the
//! FTS5 index over block text, rebuild and garbage collection, and the pool
//! sweep.

use std::collections::HashSet;

use omgbase_format::hash::hex;
use rusqlite::{Connection, OptionalExtension, params};

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

// ---- FTS (external content, spec/search §1.1) -----------------------------------------

/// SQL predicate: the `blocks` row aliased `b` is a live **leaf** — no live
/// row of the same document names it as `parent_block` (search 1.2: a
/// container's text is its children's text joined, so only leaves are
/// indexed). `c.doc_id = b.doc_id` lets the subquery use `idx_blocks_doc`.
pub const LIVE_LEAF_SQL: &str = "b.deleted_commit IS NULL AND NOT EXISTS (SELECT 1 FROM blocks c WHERE c.doc_id = b.doc_id AND c.parent_block = b.block_id AND c.deleted_commit IS NULL)";

fn live_leaf_rows(conn: &Connection, doc_id: &str) -> Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT b.rowid, b.text FROM blocks b WHERE b.doc_id = ?1 AND {LIVE_LEAF_SQL}"
    ))?;
    let it = stmt.query_map(params![doc_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(it.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Remove a document's live leaf rows from `blocks_fts` (external-content
/// index: a `'delete'` command with the original text, before the rows
/// change). Only live leaves are indexed, so only those are deleted — a
/// `'delete'` for an unindexed row skews the index statistics.
pub fn fts_delete_doc(conn: &Connection, doc_id: &str) -> Result<()> {
    let mut del =
        conn.prepare("INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES('delete', ?1, ?2)")?;
    for (rowid, text) in live_leaf_rows(conn, doc_id)? {
        del.execute(params![rowid, text])?;
    }
    Ok(())
}

/// Index a document's live leaf rows.
pub fn fts_index_doc(conn: &Connection, doc_id: &str) -> Result<()> {
    let mut ins = conn.prepare("INSERT INTO blocks_fts(rowid, text) VALUES(?1, ?2)")?;
    for (rowid, text) in live_leaf_rows(conn, doc_id)? {
        ins.execute(params![rowid, text])?;
    }
    Ok(())
}

/// Rebuild the whole index: `'delete-all'`, then every live leaf of every
/// live document (FTS5's own `'rebuild'` reads the content table wholesale,
/// containers included, and is not used).
pub fn fts_rebuild(conn: &Connection) -> Result<()> {
    conn.execute_batch("INSERT INTO blocks_fts(blocks_fts) VALUES('delete-all')")?;
    let doc_ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT doc_id FROM docs WHERE deleted_commit IS NULL")?;
        let it = stmt.query_map([], |r| r.get(0))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for id in &doc_ids {
        fts_index_doc(conn, id)?;
    }
    Ok(())
}

/// A `blocks` row about to be evicted out of another document's row set
/// (spec/store §5.4 step 8).
pub(crate) struct EvictRow {
    pub rowid: i64,
    pub block_id: String,
    pub doc_id: String,
    pub parent_block: Option<String>,
    pub text: String,
    pub live: bool,
}

/// Keep the index equal to the table's live leaves across the deletion of
/// `rows` (the caller deletes them right after). Leaf-ness is decided over
/// the table **before** any row goes, so a list moving with its items is
/// order-independent (the items lose their entries; the list never had one),
/// and a live parent that keeps its row but loses its last live child becomes
/// a leaf and gains an entry.
pub(crate) fn fts_before_evict_rows(conn: &Connection, rows: &[EvictRow]) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let evicted: HashSet<&str> = rows.iter().map(|r| r.block_id.as_str()).collect();
    let mut has_live_child = conn.prepare_cached(
        "SELECT 1 FROM blocks c WHERE c.doc_id = ?1 AND c.parent_block = ?2 AND c.deleted_commit IS NULL LIMIT 1",
    )?;
    let mut leaves = Vec::new();
    for r in rows.iter().filter(|r| r.live) {
        let child: Option<i64> = has_live_child
            .query_row(params![r.doc_id, r.block_id], |row| row.get(0))
            .optional()?;
        if child.is_none() {
            leaves.push(r);
        }
    }
    let mut del =
        conn.prepare("INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES('delete', ?1, ?2)")?;
    for r in &leaves {
        del.execute(params![r.rowid, r.text])?;
    }
    // Parents that stay live but are left childless are leaves from now on.
    let mut parent_row = conn.prepare(
        "SELECT b.rowid, b.text FROM blocks b WHERE b.block_id = ?1 AND b.doc_id = ?2 AND b.deleted_commit IS NULL
           AND NOT EXISTS (SELECT 1 FROM blocks c WHERE c.doc_id = b.doc_id AND c.parent_block = b.block_id
                           AND c.deleted_commit IS NULL AND c.block_id NOT IN (SELECT value FROM json_each(?3)))",
    )?;
    let evicted_json = serde_json::to_string(&rows.iter().map(|r| &r.block_id).collect::<Vec<_>>())
        .expect("ids serialize");
    let mut ins = conn.prepare("INSERT INTO blocks_fts(rowid, text) VALUES(?1, ?2)")?;
    let mut seen: HashSet<&str> = HashSet::new();
    for r in rows.iter().filter(|r| r.live) {
        let Some(parent) = r.parent_block.as_deref() else {
            continue;
        };
        if evicted.contains(parent) || !seen.insert(parent) {
            continue;
        }
        let p: Option<(i64, String)> = parent_row
            .query_row(params![parent, r.doc_id, evicted_json], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
        if let Some((rowid, text)) = p {
            ins.execute(params![rowid, text])?;
        }
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
/// the FTS index (`'delete-all'` + every live leaf, `spec/search` §1.1),
/// `block_changes` from `dispositions`.
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
        fts_rebuild(&tx)?;
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
