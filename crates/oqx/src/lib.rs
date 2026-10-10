//! OQX (omgbase Query eXpressions) — Rust implementation.
//!
//! This crate is the second implementation of the OQX language. The reference
//! implementation is the TypeScript package `@omgbase/oqx` at `packages/oqx`
//! in the same repository. Both conform to the language-neutral fixtures under
//! `spec/oqx/` (see `spec/oqx/README.md`), which are the specification.
//!
//! Layering mirrors the reference: a lexer and parser produce the [`ast`] — a
//! first-class contract (`spec/oqx/AST.md`): spans on every node, [`walk`] to
//! traverse or transform it, [`print`] to write it back, [`build`] to
//! construct it, serde under the `json` feature; the in-memory engine evaluates
//! it against a `DataContext` over [`Value`]s; the planner seam lets a store
//! push work down and finish the residual in memory. `where` keeps its surface
//! form: [`resolve_aliases`] substitutes a body's `select` aliases, and the
//! entry points ([`run_query`], [`execute`]) apply it exactly once before the
//! engine sees the query — an `Engine` evaluates the query it is given.

pub mod adapters;
pub mod ast;
pub mod build;
pub mod context;
pub mod engine;
pub mod errors;
#[cfg(feature = "json")]
pub mod json;
pub mod lexer;
pub mod optimize;
pub mod parser;
pub mod plan;
pub mod planner;
pub mod print;
pub mod regex_dialect;
pub mod resolve;
pub mod semantics;
pub mod value;
pub mod walk;

pub use adapters::IndexedCollection;
#[cfg(feature = "sqlite")]
pub use adapters::SqliteTable;
pub use ast::{
    BinaryOp, Consumer, CountCmp, Expr, Follow, FollowDestination, LogicalOp, OpNode, OrderSpec,
    Query, RelOp, SelectItem, Span, Subquery, UnaryOp, Where,
};
/// The OQX language version this crate conforms to (`spec/oqx/VERSION`). It is
/// also this crate's `major.minor`: the patch digit is the crate's own.
pub const LANGUAGE_VERSION: &str = "0.16";

/// This crate's own version (`Cargo.toml`).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub use context::{DataContext, DefaultContext};
pub use engine::{Engine, InMemoryEngine, OqxResult};
pub use errors::{OqxError, Result, Stage};
#[cfg(feature = "json")]
pub use json::{ast_to_json, query_from_json};
pub use lexer::{TokType, Token, lex_string, lex_template, raw_source};
pub use optimize::{BlockPlan, Correlation, DEFAULT_RULES, HashIndex, RowIndex, Rule, RuleContext};
pub use parser::{parse_string, parse_template};
pub use plan::{
    Equality, ROWS_ROOT, as_equality, const_value, is_const, partition_pushable, residual_query,
};
pub use planner::{Plan, PlannedEngine, QueryPlanner};
pub use print::{Template, print, print_query, print_template};
pub use regex_dialect::{CompiledRegex, RegexDialect, RegexFlags, compile_regex};
pub use resolve::{resolve_aliases, resolve_subquery};
pub use value::{Object, Range, Value};
pub use walk::{Clause, Node, VisitContext, Visitor, strip_spans, transform, visit};

/// Resolve the query's `select` aliases and run it in-memory over plain-value
/// named roots (the default context). The Rust counterpart of the reference's
/// `runQuery`; an `Engine::run` evaluates the query as given, so this is where
/// `where` aliases are substituted (exactly once).
pub fn run_query(query: &Query, bindings: &[Value], roots: Object) -> Result<OqxResult> {
    let resolved = resolve_aliases(query)?;
    InMemoryEngine::new(DefaultContext::new(roots)).run(&resolved, bindings)
}

/// Parse and run a query string against plain-value named roots (so
/// `from people` resolves), returning the consumer-shaped result. The Rust
/// counterpart of the reference's `execute(source, roots)`.
pub fn execute(source: &str, roots: Object) -> Result<Value> {
    let query = parser::parse_string(source)?;
    Ok(run_query(&query, &[], roots)?.into_value())
}
