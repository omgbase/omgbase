//! The tier-3 seam: a [`QueryPlanner`] delegates a query (or part of one) to an
//! underlying store or query system, returning the rows it produced plus a
//! RESIDUAL query for whatever it could not push down. [`PlannedEngine`] wires
//! this to the in-memory engine: it hands the query to the planner, then
//! finishes the residual over the produced rows — so a planner may be as
//! partial as it likes and correctness is always preserved by the in-memory
//! fallback. Port of `packages/oqx/src/planner.ts`.
//!
//! Shape differences from the reference, all forced by ownership:
//!
//! * A [`Plan`]'s rows are a materialized `Vec<Value>` rather than an
//!   `Iterable` thunk — the reference calls `Array.from(plan.rows())`
//!   unconditionally, so nothing is lost.
//! * `Plan::context` is `Option<Box<dyn DataContext>>`: an optional trait
//!   object has to be boxed to be owned, and a plan is produced once per run,
//!   so the allocation is negligible next to the query itself.
//! * The engine always answers [`ROWS_ROOT`] with the plan's rows, layering
//!   that over the plan's context when one is given (the reference leaves the
//!   custom context responsible for serving the rows root itself). A context
//!   that does serve it is still correct — the overlay wins with the same rows.
//! * The fallback context is likewise a `Box<dyn DataContext>` so that
//!   [`PlannedEngine`] has a single type parameter, the planner.

use crate::Result;
use crate::ast::Query;
use crate::context::{DataContext, DefaultContext};
use crate::engine::{Engine, InMemoryEngine, OqxResult};
use crate::plan::ROWS_ROOT;
use crate::value::{Object, Value};

/// What a planner produced for a query: the rows the backend yielded (already
/// reduced by whatever it pushed) and the query to finish in-memory over them.
pub struct Plan {
    /// The rows the backend produced (already reduced by whatever it pushed).
    pub rows: Vec<Value>,
    /// The query to finish in-memory over `rows`; its source is the rows root
    /// (see [`crate::plan::residual_query`]).
    pub residual: Query,
    /// Optional context for evaluating the residual (to navigate relations of
    /// the produced rows). `None` = plain-value access over `rows`. The rows
    /// root itself is always served by the engine from `rows`; the context is
    /// consulted for every other root and for `get`/`to_rows`/`identity`/
    /// functions.
    pub context: Option<Box<dyn DataContext>>,
}

impl Plan {
    /// A plan whose residual runs with plain-value access over `rows`.
    pub fn new(rows: Vec<Value>, residual: Query) -> Self {
        Self {
            rows,
            residual,
            context: None,
        }
    }

    /// Attach a context for evaluating the residual.
    pub fn with_context(mut self, context: impl DataContext + 'static) -> Self {
        self.context = Some(Box::new(context));
        self
    }
}

impl std::fmt::Debug for Plan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Plan")
            .field("rows", &self.rows)
            .field("residual", &self.residual)
            .field("context", &self.context.as_ref().map(|_| "<DataContext>"))
            .finish()
    }
}

pub trait QueryPlanner {
    /// Plan a query, or return `None` to decline it entirely (full in-memory
    /// fallback over the engine's fallback context).
    fn plan(&self, query: &Query, params: &[Value]) -> Option<Plan>;
}

/// Runs a planner, finishing the residual on the in-memory engine.
pub struct PlannedEngine<P: QueryPlanner> {
    planner: P,
    fallback: Box<dyn DataContext>,
}

impl<P: QueryPlanner> PlannedEngine<P> {
    /// A planned engine whose fallback (for declined queries) is an empty
    /// [`DefaultContext`] — the reference's default.
    pub fn new(planner: P) -> Self {
        Self::with_fallback(planner, DefaultContext::default())
    }

    /// A planned engine that runs declined queries in-memory over `fallback`.
    pub fn with_fallback(planner: P, fallback: impl DataContext + 'static) -> Self {
        Self {
            planner,
            fallback: Box::new(fallback),
        }
    }

    pub fn planner(&self) -> &P {
        &self.planner
    }
}

impl<P: QueryPlanner> Engine for PlannedEngine<P> {
    fn run(&self, query: &Query, bindings: &[Value]) -> Result<OqxResult> {
        let Some(plan) = self.planner.plan(query, bindings) else {
            let ctx = Overlay {
                rows: None,
                inner: self.fallback.as_ref(),
            };
            return InMemoryEngine::new(ctx).run(query, bindings);
        };
        let Plan {
            rows,
            residual,
            context,
        } = plan;
        match context {
            None => {
                let mut roots = Object::with_capacity(1);
                roots.insert(ROWS_ROOT, Value::Array(rows));
                InMemoryEngine::new(DefaultContext::new(roots)).run(&residual, bindings)
            }
            Some(ctx) => {
                let ctx = Overlay {
                    rows: Some(Value::Array(rows)),
                    inner: ctx.as_ref(),
                };
                InMemoryEngine::new(ctx).run(&residual, bindings)
            }
        }
    }
}

/// A borrowed context, optionally with the plan's rows layered over its roots
/// as [`ROWS_ROOT`]. This is how a `&dyn DataContext` is handed to
/// [`InMemoryEngine`], which wants an owned `C: DataContext`.
struct Overlay<'a> {
    rows: Option<Value>,
    inner: &'a dyn DataContext,
}

impl DataContext for Overlay<'_> {
    fn root(&self, name: &str) -> Value {
        match &self.rows {
            Some(rows) if name == ROWS_ROOT => rows.clone(),
            _ => self.inner.root(name),
        }
    }

    fn get(&self, row: &Value, key: &str) -> Value {
        self.inner.get(row, key)
    }

    fn to_rows(&self, value: &Value) -> Vec<Value> {
        self.inner.to_rows(value)
    }

    fn identity(&self, row: &Value) -> Value {
        self.inner.identity(row)
    }

    fn call_function(&self, name: &str, args: &[Value]) -> Option<Result<Value>> {
        self.inner.call_function(name, args)
    }

    fn call_method(&self, name: &str, recv: &Value, args: &[Value]) -> Option<Result<Value>> {
        self.inner.call_method(name, recv, args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse_string;
    use crate::plan::residual_query;
    use std::cell::Cell;

    fn num(n: f64) -> Value {
        Value::Number(n)
    }

    fn obj(pairs: &[(&str, Value)]) -> Value {
        Value::Object(
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        )
    }

    /// A planner that records how often it was asked and answers a fixed way.
    struct Scripted {
        calls: Cell<usize>,
        answer: fn(&Query) -> Option<Plan>,
    }

    impl QueryPlanner for Scripted {
        fn plan(&self, query: &Query, _params: &[Value]) -> Option<Plan> {
            self.calls.set(self.calls.get() + 1);
            (self.answer)(query)
        }
    }

    /// A context whose only root is `things`, with a computed `double` property.
    struct Things;

    impl DataContext for Things {
        fn root(&self, name: &str) -> Value {
            if name == "things" {
                Value::Array(vec![obj(&[("n", num(1.0))]), obj(&[("n", num(2.0))])])
            } else {
                Value::Undefined
            }
        }
        fn get(&self, row: &Value, key: &str) -> Value {
            if key == "double" {
                return match row.as_object().and_then(|o| o.get("n")) {
                    Some(Value::Number(n)) => num(n * 2.0),
                    _ => Value::Undefined,
                };
            }
            DefaultContext::default().get(row, key)
        }
        fn to_rows(&self, value: &Value) -> Vec<Value> {
            DefaultContext::default().to_rows(value)
        }
        fn identity(&self, row: &Value) -> Value {
            DefaultContext::default().identity(row)
        }
    }

    #[test]
    fn overlay_serves_the_rows_root_and_forwards_everything_else() {
        let rows = Value::Array(vec![obj(&[("n", num(7.0))])]);
        let with_rows = Overlay {
            rows: Some(rows.clone()),
            inner: &Things,
        };
        assert_eq!(with_rows.root(ROWS_ROOT), rows);
        assert_eq!(with_rows.root("things"), Things.root("things"));
        assert_eq!(with_rows.get(&obj(&[("n", num(3.0))]), "double"), num(6.0));
        assert_eq!(
            with_rows.to_rows(&Value::Array(vec![num(1.0)])),
            vec![num(1.0)]
        );
        assert_eq!(
            with_rows.identity(&obj(&[("id", num(9.0)), ("n", num(1.0))])),
            num(9.0)
        );
        assert!(with_rows.call_function("size", &[]).is_none());
        assert!(with_rows.call_method("lower", &Value::Null, &[]).is_none());

        let without = Overlay {
            rows: None,
            inner: &Things,
        };
        assert_eq!(without.root(ROWS_ROOT), Value::Undefined);
    }

    #[test]
    fn plan_debug_does_not_require_a_debug_context() {
        let q = parse_string("n from things").unwrap();
        let plan = Plan::new(vec![num(1.0)], residual_query(&q, None)).with_context(Things);
        let text = format!("{plan:?}");
        assert!(text.contains("<DataContext>"), "{text}");
        assert!(plan.context.is_some());
        assert!(Plan::new(Vec::new(), q).context.is_none());
    }

    #[test]
    fn declined_plan_runs_the_query_over_the_fallback_context() {
        let planner = Scripted {
            calls: Cell::new(0),
            answer: |_| None,
        };
        let engine = PlannedEngine::with_fallback(planner, Things);
        let q = parse_string("d: double from things where n == 2").unwrap();
        let res = engine.run(&q, &[]).unwrap();
        assert_eq!(res, OqxResult::Collect(vec![obj(&[("d", num(4.0))])]));
        assert_eq!(engine.planner().calls.get(), 1);
    }

    #[test]
    fn a_plan_without_context_runs_the_residual_over_plain_rows() {
        let planner = Scripted {
            calls: Cell::new(0),
            answer: |q| {
                Some(Plan::new(
                    vec![obj(&[("n", num(5.0))]), obj(&[("n", num(6.0))])],
                    residual_query(q, None),
                ))
            },
        };
        let engine = PlannedEngine::new(planner);
        // `from nowhere` is never resolved: the residual scans the plan's rows.
        let q = parse_string("n from nowhere where n > 100 order by n desc").unwrap();
        let res = engine.run(&q, &[]).unwrap();
        assert_eq!(
            res,
            OqxResult::Collect(vec![obj(&[("n", num(6.0))]), obj(&[("n", num(5.0))])])
        );
    }

    #[test]
    fn a_plan_with_context_navigates_the_rows_through_it() {
        let planner = Scripted {
            calls: Cell::new(0),
            answer: |q| {
                Some(
                    Plan::new(vec![obj(&[("n", num(5.0))])], residual_query(q, None))
                        .with_context(Things),
                )
            },
        };
        let engine = PlannedEngine::new(planner);
        let q = parse_string("d: double from things").unwrap();
        let res = engine.run(&q, &[]).unwrap();
        assert_eq!(res, OqxResult::Collect(vec![obj(&[("d", num(10.0))])]));
    }
}
