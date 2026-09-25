//! Planner adapters: concrete [`crate::planner::QueryPlanner`]s over particular
//! stores. Port of `packages/oqx/src/adapters/`.
//!
//! Only the in-memory [`indexed::IndexedCollection`] is ported so far; the
//! reference's SQLite adapter is a later, feature-gated step.

pub mod indexed;

pub use indexed::{IndexedCollection, index_key};
