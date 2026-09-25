//! The tier-1 in-memory engine: evaluates a parsed [`Query`] against a
//! [`DataContext`]. Port of `packages/oqx/src/engine.ts`.
//!
//! PORT PENDING — this file currently fixes the public surface so the planner
//! and the conformance runner can be written against it; `InMemoryEngine::run`
//! is `todo!()` until the engine port lands.

use crate::Result;
use crate::ast::{Consumer, Query};
use crate::context::{DataContext, DefaultContext};
use crate::value::{Object, Value};

/// A query's result, shaped by its consumer. [`OqxResult::into_value`] gives
/// the consumer-shaped plain value the tagged-template API and the spec
/// fixtures observe.
#[derive(Clone, Debug, PartialEq)]
pub enum OqxResult {
    Collect(Vec<Value>),
    Exists(bool),
    None(bool),
    Count(f64),
    First(Option<Value>),
    Single(Option<Value>),
}

impl OqxResult {
    pub fn consumer(&self) -> Consumer {
        match self {
            OqxResult::Collect(_) => Consumer::Collect,
            OqxResult::Exists(_) => Consumer::Exists,
            OqxResult::None(_) => Consumer::None,
            OqxResult::Count(_) => Consumer::Count,
            OqxResult::First(_) => Consumer::First,
            OqxResult::Single(_) => Consumer::Single,
        }
    }

    /// The consumer-shaped result: an array for `collect`, a boolean for
    /// `exists`/`none`, a number for `count`, the row or `Null` for
    /// `first`/`single`.
    pub fn into_value(self) -> Value {
        match self {
            OqxResult::Collect(rows) => Value::Array(rows),
            OqxResult::Exists(b) | OqxResult::None(b) => Value::Bool(b),
            OqxResult::Count(n) => Value::Number(n),
            OqxResult::First(row) | OqxResult::Single(row) => row.unwrap_or(Value::Null),
        }
    }
}

/// Anything that can run a query with bindings: the in-memory engine, or a
/// planned engine over a store.
pub trait Engine {
    fn run(&self, query: &Query, bindings: &[Value]) -> Result<OqxResult>;
}

/// The in-memory engine over a [`DataContext`].
pub struct InMemoryEngine<C: DataContext> {
    ctx: C,
}

impl<C: DataContext> InMemoryEngine<C> {
    pub fn new(ctx: C) -> Self {
        Self { ctx }
    }

    pub fn context(&self) -> &C {
        &self.ctx
    }
}

impl<C: DataContext> Engine for InMemoryEngine<C> {
    fn run(&self, query: &Query, bindings: &[Value]) -> Result<OqxResult> {
        let _ = (query, bindings);
        todo!("engine port pending")
    }
}

/// Run a parsed query with bindings over plain-value named roots.
pub fn run_query(query: &Query, bindings: &[Value], roots: Object) -> Result<OqxResult> {
    InMemoryEngine::new(DefaultContext::new(roots)).run(query, bindings)
}
