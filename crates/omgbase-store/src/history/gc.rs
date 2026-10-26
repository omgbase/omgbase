//! The recorder's garbage collection (`spec/store/README.md` §7): the
//! revision-rooted mark, the sweep over `tree_nodes` and `blobs`, the 14.2
//! `same` sweep and the `block_changes` projection rebuild. The current-state
//! derived tables (sections, FTS, the pool sweep) are `core::derived`.
//!
//! seam: the mark roots on `revisions` only (Phase 3, M7 — inventory-rust.md
//! §2.3 `derived.rs:265-298 walk_explicit`, `:307-326 mark_reachable`; README
//! §2.3 row 3, D10): once revisions are optional the core's own roots —
//! `blocks.raw_hash`, `trivia_hash`, the heads' frontmatter — join it.

use std::collections::HashSet;

use omgbase_format::hash::hex;
use rusqlite::{Connection, OptionalExtension, params};

pub use crate::core::capabilities::GcResult;
use crate::core::codec::from_hex;
use crate::error::Result;
use crate::history::delta::{explicit_entries, parse_node_text};

/// §7 rebuild: `block_changes` is a pure projection of `dispositions` across
/// commits (17.0) — delete and re-derive it verbatim from the dispositions
/// table (which is durable). A wholly archived commit (§7.1, 15.0: every
/// revision of it carries `archive`) has no dispositions and, since 17.0, no
/// block_changes either — the earliest-row exception the 15.0–16.x rebuild
/// preserved for the mint oracle is gone: the id's `id_claims` row holds it
/// (§2.1). Runs in the caller's transaction.
pub fn rebuild_block_changes(tx: &Connection) -> Result<()> {
    tx.execute_batch(
        "DELETE FROM block_changes;
         INSERT OR IGNORE INTO block_changes (block_id, commit_id, kind)
           SELECT block_id, commit_id, kind FROM dispositions;",
    )?;
    Ok(())
}

/// The commit ids every revision of which is archived (§7.1 "Retention",
/// 15.0): a commit with at least one revision and no live one.
pub const ARCHIVED_COMMITS_SQL: &str = "SELECT c.commit_id FROM commits c WHERE EXISTS (SELECT 1 FROM revisions r WHERE r.commit_id = c.commit_id) AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.commit_id = c.commit_id AND r.archive IS NULL)";

// ---- garbage (§7) -------------------------------------------------------------------

/// The `same` rows a store through 14.1 persisted (§7, 14.2): `count(*)` of
/// `dispositions` with `kind = 'same'`.
pub fn count_same_dispositions(conn: &Connection) -> Result<usize> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM dispositions WHERE kind = 'same'",
        [],
        |r| r.get(0),
    )?;
    Ok(usize::try_from(n).unwrap_or(0))
}

/// The EXPLICIT walk (§7, 16.0) from the nodes on `stack`: a node marks the
/// objects its own text names — every entry of a `[`-node, the `+`/`~`
/// entries of a `{`-node — recursing into the child hashes those entries
/// carry. What a delta keeps "as the base" is the base revision's to mark,
/// and the base-liveness rule (§4.4) keeps that revision live while the
/// delta is. `on_node` sees every node row visited (its hex hash and text).
/// Hex sets.
pub(crate) fn walk_explicit(
    conn: &Connection,
    mut stack: Vec<String>,
    trees: &mut HashSet<String>,
    blobs: &mut HashSet<String>,
    mut on_node: impl FnMut(&str, &str),
) -> Result<()> {
    let mut node = conn.prepare_cached("SELECT entries FROM tree_nodes WHERE hash = ?1")?;
    while let Some(h) = stack.pop() {
        if !trees.insert(h.clone()) {
            continue;
        }
        let entries: Option<String> = node
            .query_row(params![from_hex(&h)?], |r| r.get(0))
            .optional()?;
        let Some(text) = entries else {
            continue;
        };
        on_node(&h, &text);
        let Some(parsed) = parse_node_text(&text) else {
            continue;
        };
        for e in explicit_entries(&parsed) {
            blobs.insert(e.raw_hash_hex);
            if let Some(t) = e.trivia_hash_hex {
                blobs.insert(t);
            }
            if let Some(c) = e.child_tree_hash_hex {
                stack.push(c);
            }
        }
    }
    Ok(())
}

/// The mark phase (§7): tree nodes reachable from every **live** revision's
/// `root_tree` and the blobs they name (raw, trivia) plus every non-NULL
/// `frontmatter_blob` (raw or delta). The mark is **explicit** (16.0): a
/// `{`-node contributes only the entries it carries; the kept ones are the
/// base revision's, which is live whenever the delta is. An archived revision
/// (`root_tree IS NULL`, 15.0) contributes nothing — its bodies live in its
/// segment. Hex sets.
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
    let roots: Vec<String> = {
        let mut stmt =
            conn.prepare("SELECT DISTINCT root_tree FROM revisions WHERE root_tree IS NOT NULL")?;
        let it = stmt.query_map([], |r| Ok(hex(&r.get::<_, Vec<u8>>(0)?)))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    walk_explicit(conn, roots, &mut trees, &mut blobs, |_, _| {})?;
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

/// What a collection would sweep, without deleting anything (§8 I5) — all
/// three counts, the `same` rows included (14.2).
pub fn gc_dry_run(conn: &Connection) -> Result<GcResult> {
    let (trees, blobs) = unreachable_rows(conn)?;
    Ok(GcResult {
        blobs_swept: blobs.len(),
        tree_nodes_swept: trees.len(),
        same_dispositions_swept: count_same_dispositions(conn)?,
        claims_released: 0,
        feed_pruned: 0,
    })
}

/// The sweep (§7): delete every `tree_nodes` and `blobs` row the mark did not
/// reach; `(blobs swept, tree nodes swept)`. Runs in the caller's
/// transaction — [`run_gc`] and the retention squash (15.0,
/// [`crate::archive`]) both call it.
pub fn sweep_unreachable(conn: &Connection) -> Result<(usize, usize)> {
    let (trees, blobs) = unreachable_rows(conn)?;
    for h in &trees {
        conn.execute("DELETE FROM tree_nodes WHERE hash = ?1", params![h])?;
    }
    for h in &blobs {
        conn.execute("DELETE FROM blobs WHERE hash = ?1", params![h])?;
    }
    Ok((blobs.len(), trees.len()))
}

/// Mark-and-sweep, flag-gated (`enabled = false` is a no-op). In a store
/// that never archived nothing is unreachable — revisions are append-only;
/// after a retention squash (15.0) the squash has already swept, so it is a
/// no-op again unless a crash interrupted one. The same collection (§7 "The
/// `same` sweep", 14.2) deletes every `block_changes` and `dispositions` row
/// with `kind = 'same'` — what a store through 14.1 wrote for every untouched
/// block of every commit, and nothing reads. A sweep, not a migration: a
/// data-only change needs no `user_version`, and opening a database never
/// bulk-deletes. Rebuild is unchanged (`block_changes` stays the projection
/// of `dispositions`), so §8 I8 holds before and after. The feed prune of
/// §7.4 and the claims prune of §7.3 (17.0) are the core's and run after this
/// in the same transaction (`Store::gc_at`); `feed_pruned` and
/// `claims_released` are 0 here.
pub fn run_gc(conn: &Connection, enabled: bool) -> Result<GcResult> {
    if !enabled {
        return Ok(GcResult::default());
    }
    let tx = conn.unchecked_transaction()?;
    let result = run_gc_in(&tx)?;
    tx.commit()?;
    Ok(result)
}

/// [`run_gc`]'s body inside the caller's transaction: the sweep and the
/// `same` sweep, nothing committed here.
pub fn run_gc_in(tx: &Connection) -> Result<GcResult> {
    let (blobs_swept, tree_nodes_swept) = sweep_unreachable(tx)?;
    let same_dispositions_swept = count_same_dispositions(tx)?;
    if same_dispositions_swept > 0 {
        tx.execute("DELETE FROM block_changes WHERE kind = 'same'", [])?;
        tx.execute("DELETE FROM dispositions WHERE kind = 'same'", [])?;
    }
    Ok(GcResult {
        blobs_swept,
        tree_nodes_swept,
        same_dispositions_swept,
        claims_released: 0,
        feed_pruned: 0,
    })
}
