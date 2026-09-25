//! OQX (omgbase Query eXpressions) — Rust implementation.
//!
//! This crate is the second implementation of the OQX language. The reference
//! implementation is the TypeScript package `@omgbase/oqx` at `packages/oqx`
//! in the same repository. Both conform to the language-neutral fixtures under
//! `spec/oqx/` (see `spec/oqx/README.md`), which are the specification.
//!
//! Layering mirrors the reference: a lexer and parser produce the [`ast`]; the
//! in-memory engine evaluates it against a `DataContext` over [`Value`]s; the
//! planner seam lets a store push work down and finish the residual in memory.

pub mod ast;
pub mod errors;
pub mod lexer;
pub mod parser;
pub mod semantics;
pub mod value;

pub use ast::{
    BinaryOp, Consumer, CountCmp, Expr, Follow, LogicalOp, OpNode, OrderSpec, Query, RelOp,
    SelectItem, Subquery, UnaryOp, Where,
};
pub use errors::{OqxError, Result, Stage};
pub use lexer::{TokType, Token, lex_string, lex_template, raw_source};
pub use parser::{parse_string, parse_template};
pub use value::{Object, Range, Value};
