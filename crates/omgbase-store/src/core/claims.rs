//! The mint oracle of `spec/store` §2.1 as the core's default
//! [`IdentityClaims`]: an id is claimed when it names a row of its prefix's
//! table(s). Phase 3 (M3, D5) replaces the table union with an `id_claims`
//! table written at mint; until then the probe reaches the history tables
//! `block_changes`, `commits`, `revisions`, `archives` by name — and, since
//! 17.0 (D1), a head token is in use while a `docs` row names it as `head`
//! or a captured revision as `rev_id`.
//!
//! seam: IdentityClaims::is_claimed (Phase 3) — inventory-rust.md §2.1
//! `mint.rs:28-46 ID_TABLES`, `:61-71 id_in_use`; README §2.8 row 2, §3 M3.

use rusqlite::{Connection, params};

use crate::core::capabilities::IdentityClaims;
use crate::error::Result;

/// §2.1: the table(s) and id column a minted id of each prefix must not
/// already name a row of. A block id lives on in history after its `blocks`
/// row is gone, hence `block_changes` and `resurrection_pool`. `col` and `v`
/// have no table and no check.
pub(crate) const ID_TABLES: &[(&str, &[(&str, &str)])] = &[
    ("d", &[("docs", "doc_id")]),
    (
        "b",
        &[
            ("blocks", "block_id"),
            ("block_changes", "block_id"),
            ("resurrection_pool", "block_id"),
        ],
    ),
    ("c", &[("commits", "commit_id")]),
    ("r", &[("revisions", "rev_id"), ("docs", "head")]),
    ("x", &[("external_nodes", "node_id")]),
    ("e", &[("edges", "edge_id")]),
    ("cp", &[("checkpoints", "id")]),
    ("rp", &[("repos", "repo_id")]),
    ("src", &[("sources", "source_id")]),
    ("s", &[("archives", "segment_id")]),
];

/// The tables an id with `prefix` is checked against (empty for `col`, `v`
/// and any prefix the store does not know).
#[must_use]
pub fn tables_for(prefix: &str) -> &'static [(&'static str, &'static str)] {
    ID_TABLES
        .iter()
        .find(|(p, _)| *p == prefix)
        .map_or(&[], |(_, tables)| tables)
}

/// §2.1: does `id` name a row of the prefix's table(s) on `conn`? The
/// statements are cached on the connection, so a check is one indexed probe
/// per table.
pub fn id_in_use(conn: &Connection, prefix: &str, id: &str) -> Result<bool> {
    for (table, column) in tables_for(prefix) {
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT 1 FROM {table} WHERE {column} = ?1 LIMIT 1"
        ))?;
        if stmt.exists(params![id])? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The §2.1 oracle: the union of each prefix's tables ([`tables_for`]).
/// Claims nothing on its own — the row the writer inserts is the claim.
#[derive(Clone, Copy, Debug, Default)]
pub struct TableUnionClaims;

impl IdentityClaims for TableUnionClaims {
    fn is_claimed(&self, conn: &Connection, prefix: &str, id: &str) -> Result<bool> {
        id_in_use(conn, prefix, id)
    }

    fn claim(&self, _conn: &Connection, _prefix: &str, _id: &str) -> Result<()> {
        Ok(())
    }
}
