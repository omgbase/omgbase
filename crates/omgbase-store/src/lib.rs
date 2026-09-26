//! # omgbase-store
//!
//! The omgbase store, Rust implementation: the embedded SQLite database that
//! owns block **identity**, **history** and the **current state** of a
//! repository of authored files. Files stay the source of truth for content;
//! the store adds stable block ids, an append-only history of revisions and
//! commits, the dispositions the matcher recorded, and the derived indexes
//! the query surfaces read. The contract is `spec/store/README.md` in the
//! omgbase repository — `schema.sql` (embedded verbatim as [`SCHEMA_SQL`]) is
//! the DDL, `spec/store/cases/*.json` the executable fixtures — and this
//! crate opens the same databases the TypeScript reference writes.
//!
//! ```
//! use omgbase_reconcile::Config;
//! use omgbase_store::{BatchItem, Store};
//!
//! let mut store = Store::open_in_memory()?;
//! let repo = store.create_repo("notes")?;
//! let ts = "2026-09-26T10:00:00.000Z";
//! let items = [BatchItem::observed("a.md", "# Title\n\nFirst.\n")];
//! let outcomes = store.observe_batch(&repo, &items, ts, &Config::default())?;
//! let o = outcomes[0].as_observed().unwrap();
//! assert!(o.converged && !o.echo);
//! assert_eq!(o.dispositions["inserted"], 2);
//! assert_eq!(store.reconstruct(&o.doc_id)?.as_deref(), Some("# Title\n\nFirst.\n"));
//!
//! // Re-observing what the store holds is an echo: no commit, no mint.
//! let again = store.observe_batch(&repo, &items, ts, &Config::default())?;
//! assert!(again[0].as_observed().unwrap().echo);
//! # Ok::<(), omgbase_store::Error>(())
//! ```
//!
//! ## Layering
//!
//! [`schema`] (§1, §3: the opener and migrations), [`ids`] (§2.1–2.2),
//! [`time`] (§2.4), [`tree`] (§4.1 encodings), [`order_key`] (§4.3),
//! [`writers`] (blobs, tree nodes, commits, revisions), [`observe`] (§5),
//! [`properties`] (the `properties` rows of `spec/properties`, written in
//! §5.4), [`graph`] (the `nodes`, `external_nodes`, `edges` and `doc_edges`
//! rows of `spec/graph`, written in §5.4), [`read`] (§5.2, §6), [`derived`]
//! (§4.5 sections, FTS, §7 rebuild and GC).
//!
//! Minted ids are opaque; the store asks its [`IdMinter`] for each one. The
//! default is the CSPRNG-backed [`RandomMinter`]; a fixture runner installs a
//! [`SequentialMinter`] through [`Store::open_in_memory_with_minter`].

#![forbid(unsafe_code)]

pub mod derived;
pub mod error;
pub mod graph;
pub mod ids;
pub mod observe;
pub mod order_key;
pub mod properties;
pub mod read;
pub mod schema;
pub mod time;
pub mod tree;
pub mod writers;

use std::path::Path;

use rusqlite::functions::{Context, FunctionFlags};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, Transaction, params};

pub use derived::{GcResult, RebuildTarget};
pub use error::{Error, Result};
pub use graph::ResolvedEdge;
pub use ids::{IdMinter, RandomMinter, SequentialMinter, is_valid_id, prefix_of};
pub use observe::{BatchItem, BatchOutcome, DeleteOutcome, ObserveOutcome, has_conflict_markers};
pub use omgbase_graph::{EdgeDescriptor, ProjectedNode};
pub use omgbase_properties::PropertyRow;
pub use omgbase_reconcile::{Config, MatchBlock, PoolEntry};
pub use read::RevisionRead;
pub use schema::{SCHEMA_SQL, SCHEMA_VERSION};
pub use tree::{TreeEntry, canonical_attrs, canonical_json, serialize_tree_entries, tree_hash};
pub use writers::{NewCommit, NewRevision, Origin, TreeInputBlock};

/// The `spec/store/VERSION` this crate implements (`major.minor`); the major
/// is [`SCHEMA_VERSION`].
pub const SPEC_VERSION: &str = "13.2";

/// The one format this crate ingests (`docs.format`).
pub const FORMAT_MARKDOWN: &str = "markdown";

/// An open store: one connection, one id minter. All writes go through it.
pub struct Store {
    conn: Connection,
    minter: Box<dyn IdMinter>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store").finish_non_exhaustive()
    }
}

/// Cosine similarity of two little-endian float32 vector blobs (the
/// reference's `cosineFloat32`): products and sums in f64 over the shorter
/// length; `0.0` when either norm is zero.
#[must_use]
pub fn cosine_bytes(a: &[u8], b: &[u8]) -> f64 {
    let floats = |bytes: &[u8]| {
        bytes
            .chunks_exact(4)
            .map(|c| f64::from(f32::from_le_bytes([c[0], c[1], c[2], c[3]])))
            .collect::<Vec<f64>>()
    };
    let (a, b) = (floats(a), floats(b));
    let (mut dot, mut na, mut nb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(&b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

fn cosine_udf(ctx: &Context<'_>) -> rusqlite::Result<Option<f64>> {
    let blob = |i: usize| -> rusqlite::Result<Option<&[u8]>> {
        match ctx.get_raw(i) {
            ValueRef::Null => Ok(None),
            ValueRef::Blob(b) => Ok(Some(b)),
            other => Err(rusqlite::Error::InvalidFunctionParameterType(
                i,
                other.data_type(),
            )),
        }
    };
    match (blob(0)?, blob(1)?) {
        (Some(a), Some(b)) => Ok(Some(cosine_bytes(a, b))),
        _ => Ok(None),
    }
}

impl Store {
    /// Open (creating parent directories and the file as needed) with the
    /// production minter. `:memory:` is a valid path.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_minter(path, Box::new(RandomMinter))
    }

    /// [`Store::open`] with a replaceable minter (§2.2).
    pub fn open_with_minter(path: impl AsRef<Path>, minter: Box<dyn IdMinter>) -> Result<Self> {
        let path = path.as_ref();
        if path.as_os_str() != ":memory:" {
            if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
                std::fs::create_dir_all(dir)
                    .map_err(|e| Error::Other(format!("cannot create {}: {e}", dir.display())))?;
            }
        }
        Self::from_connection(Connection::open(path)?, minter)
    }

    /// A fresh in-memory store (tests, fixtures).
    pub fn open_in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?, Box::new(RandomMinter))
    }

    /// A fresh in-memory store with a replaceable minter.
    pub fn open_in_memory_with_minter(minter: Box<dyn IdMinter>) -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?, minter)
    }

    /// Adopt an existing connection: apply the §1 pragmas, register
    /// `cosine`, run the opener (fresh → `schema.sql`; older → migrations;
    /// newer → [`Error::SchemaTooNew`]).
    pub fn from_connection(conn: Connection, mut minter: Box<dyn IdMinter>) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.create_scalar_function(
            "cosine",
            2,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            cosine_udf,
        )?;
        schema::migrate(&conn, &mut *minter)?;
        Ok(Self { conn, minter })
    }

    /// The underlying connection.
    #[must_use]
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// The store's minter.
    pub fn minter_mut(&mut self) -> &mut dyn IdMinter {
        &mut *self.minter
    }

    /// Mint an id with `prefix` (§2.1).
    pub fn mint(&mut self, prefix: &str) -> String {
        self.minter.mint(prefix)
    }

    /// Begin a write transaction (one per commit, §1); rolls back on drop.
    pub fn transaction(&self) -> Result<Transaction<'_>> {
        Ok(self.conn.unchecked_transaction()?)
    }

    /// Create a repo with `slug` (**mints `rp`**); returns its id.
    pub fn create_repo(&mut self, slug: &str) -> Result<String> {
        let repo_id = self.minter.mint("rp");
        self.conn.execute(
            "INSERT INTO repos (repo_id, slug) VALUES (?1, ?2)",
            params![repo_id, slug],
        )?;
        Ok(repo_id)
    }

    /// The repo id for `slug`, if any.
    pub fn repo_by_slug(&self, slug: &str) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        Ok(self
            .conn
            .query_row(
                "SELECT repo_id FROM repos WHERE slug = ?1",
                params![slug],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// `PRAGMA user_version`.
    pub fn user_version(&self) -> Result<i64> {
        schema::user_version(&self.conn)
    }

    // ---- writers ------------------------------------------------------------------

    /// [`writers::put_blob`].
    pub fn put_blob(&self, text: &str) -> Result<String> {
        writers::put_blob(&self.conn, text)
    }

    /// [`writers::put_tree_node`].
    pub fn put_tree_node(&self, entries: &[TreeEntry]) -> Result<String> {
        writers::put_tree_node(&self.conn, entries)
    }

    /// [`writers::write_block_tree`].
    pub fn write_block_tree(&self, blocks: &[TreeInputBlock]) -> Result<String> {
        writers::write_block_tree(&self.conn, blocks)
    }

    /// [`writers::new_commit`]; returns `(commit_id, seq)`.
    pub fn new_commit(&mut self, input: &NewCommit<'_>) -> Result<(String, i64)> {
        writers::new_commit(&self.conn, &mut *self.minter, input)
    }

    /// [`writers::write_revision`]; returns `(rev_id, seq)`.
    pub fn write_revision(&mut self, input: &NewRevision<'_>) -> Result<(String, i64)> {
        writers::write_revision(&self.conn, &mut *self.minter, input)
    }

    // ---- reads --------------------------------------------------------------------

    /// §6.1: the current bytes of a live doc; `None` when tombstoned or unknown.
    pub fn reconstruct(&self, doc_id: &str) -> Result<Option<String>> {
        read::reconstruct(&self.conn, doc_id)
    }

    /// §6.2: the bytes at a revision, from its Merkle root.
    pub fn read_at_revision(&self, doc_id: &str, rev_id: &str) -> Result<Option<RevisionRead>> {
        read::read_at_revision(&self.conn, doc_id, rev_id)
    }

    /// §5.2: the matcher's old side for a doc, from the live `blocks` rows.
    pub fn load_old_match_blocks(&self, doc_id: &str) -> Result<Vec<MatchBlock>> {
        read::load_old_match_blocks(&self.conn, doc_id)
    }

    /// §5.1: the repo's unexpired pool at `ts`.
    pub fn load_pool(&self, repo_id: &str, ts: &str) -> Result<Vec<PoolEntry>> {
        read::load_pool(&self.conn, repo_id, ts)
    }

    /// The document's live `properties` rows (`spec/properties` §1), in
    /// write order.
    pub fn properties(&self, doc_id: &str) -> Result<Vec<PropertyRow>> {
        properties::read_doc_properties(&self.conn, doc_id)
    }

    /// `spec/properties` §5 **grouped**: `{frontmatter, inline, computed}`
    /// (the `docs_read.properties` shape).
    pub fn properties_grouped(&self, doc_id: &str) -> Result<serde_json::Value> {
        Ok(omgbase_properties::grouped(&self.properties(doc_id)?))
    }

    /// `spec/properties` §5 **merged**: `{key: shape}` over every row.
    pub fn properties_merged(&self, doc_id: &str) -> Result<serde_json::Value> {
        Ok(omgbase_properties::merged(&self.properties(doc_id)?))
    }

    // ---- graph (spec/graph) -----------------------------------------------------------

    /// `spec/graph` §3.4: recompute one document's `doc_edges` from its open
    /// edges.
    pub fn rebuild_doc_edges(&self, doc_id: &str) -> Result<()> {
        graph::rebuild_doc_edges(&self.conn, doc_id)
    }

    // ---- derived ------------------------------------------------------------------

    /// §4.5: rebuild `sections` for one document.
    pub fn rebuild_sections(&self, doc_id: &str) -> Result<()> {
        derived::rebuild_sections(&self.conn, doc_id)
    }

    /// §7: recompute derived tables.
    pub fn rebuild_index(&self, target: RebuildTarget) -> Result<()> {
        derived::rebuild_index(&self.conn, target)
    }

    /// §7: mark-and-sweep garbage collection, flag-gated (off → no-op).
    pub fn gc(&self, enabled: bool) -> Result<GcResult> {
        derived::run_gc(&self.conn, enabled)
    }

    /// What [`Store::gc`] would sweep, without deleting (§8 I5).
    pub fn gc_dry_run(&self) -> Result<GcResult> {
        derived::gc_dry_run(&self.conn)
    }

    /// §5.5: delete expired pool rows; returns how many.
    pub fn sweep_pool(&self, ts: &str) -> Result<usize> {
        derived::sweep_pool(&self.conn, ts)
    }

    /// Close the connection.
    pub fn close(self) -> Result<()> {
        self.conn.close().map_err(|(_, e)| Error::Sqlite(e))
    }
}

#[cfg(test)]
mod tests;
