//! Planner adapters: concrete [`crate::planner::QueryPlanner`]s over particular
//! stores. Port of `packages/oqx/src/adapters/`.
//!
//! The in-memory [`indexed::IndexedCollection`] is always available; the
//! reference's SQLite adapter, [`sqlite::SqliteTable`], is behind the `sqlite`
//! feature so plain consumers never build SQLite.

pub mod indexed;
#[cfg(feature = "sqlite")]
pub mod sqlite;

pub use indexed::{IndexedCollection, index_key};
#[cfg(feature = "sqlite")]
pub use sqlite::SqliteTable;
