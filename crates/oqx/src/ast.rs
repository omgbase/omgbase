//! OQX query AST for the generic kernel. The parser produces this directly and
//! the interpreter walks it — there is no separate lowering/IR pass, because a
//! "relation" in the generic kernel is just an expression evaluated against the
//! current row (property navigation on the host object model), resolved at run
//! time rather than against a fixed schema.
//!
//! This is a one-to-one port of `packages/oqx/src/ast.ts`. Field names keep the
//! TypeScript spelling (snake_cased) so the engine port can read the two side
//! by side: a TS `orderBy` is `order_by`, `exclusiveEnd` is `exclusive_end`,
//! `countCmp` is `count_cmp`. `where` is a Rust keyword, so that field is the
//! raw identifier `r#where`. The TS stores operators as strings; here they are
//! the small enums [`BinaryOp`], [`UnaryOp`], [`LogicalOp`], and [`RelOp`],
//! each with an `as_str()` giving the TS spelling (which is what the
//! semantics module's `relate(op, a, b)` / `arith(op, a, b)` take).
//!
//! Where the TS uses an optional boolean (`distinct?`, `values?`) the parser
//! always sets it, so it is a plain `bool` here; `limit?`/`offset?` are
//! `Option<Expr>`. Recursion through `Where → OpNode → Subquery → Where` is
//! broken by boxing the `OpNode` inside [`Where::Op`] and
//! [`SelectItem::Collect`].

use crate::value::Value;

/// Query consumers — how a (sub)query's row set is shaped. `none` is the
/// zero-cardinality complement of `exists` (true iff the block yields no rows).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Consumer {
    Collect,
    Exists,
    None,
    Count,
    First,
    Single,
}

impl Consumer {
    /// The TS spelling: `"collect" | "exists" | "none" | "count" | "first" | "single"`.
    pub fn as_str(self) -> &'static str {
        match self {
            Consumer::Collect => "collect",
            Consumer::Exists => "exists",
            Consumer::None => "none",
            Consumer::Count => "count",
            Consumer::First => "first",
            Consumer::Single => "single",
        }
    }

    /// The inverse of [`Consumer::as_str`]: `None` when the word is not a consumer.
    pub fn from_word(word: &str) -> Option<Self> {
        Some(match word {
            "collect" => Consumer::Collect,
            "exists" => Consumer::Exists,
            "none" => Consumer::None,
            "count" => Consumer::Count,
            "first" => Consumer::First,
            "single" => Consumer::Single,
            _ => return Option::None,
        })
    }
}

/// Comparison operators usable in a `count { … } <op> <int>` test.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RelOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

impl RelOp {
    /// The TS spelling: `"==" | "!=" | "<" | "<=" | ">" | ">="`.
    pub fn as_str(self) -> &'static str {
        match self {
            RelOp::Eq => "==",
            RelOp::Ne => "!=",
            RelOp::Lt => "<",
            RelOp::Le => "<=",
            RelOp::Gt => ">",
            RelOp::Ge => ">=",
        }
    }

    pub fn from_word(word: &str) -> Option<Self> {
        Some(match word {
            "==" => RelOp::Eq,
            "!=" => RelOp::Ne,
            "<" => RelOp::Lt,
            "<=" => RelOp::Le,
            ">" => RelOp::Gt,
            ">=" => RelOp::Ge,
            _ => return None,
        })
    }
}

/// The `op` of a `binary` expression: arithmetic + comparison. The TS keeps
/// this as a string; `as_str()` is that string.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BinaryOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Add,
    Sub,
    Mul,
    Div,
    Mod,
}

impl BinaryOp {
    pub fn as_str(self) -> &'static str {
        match self {
            BinaryOp::Eq => "==",
            BinaryOp::Ne => "!=",
            BinaryOp::Lt => "<",
            BinaryOp::Le => "<=",
            BinaryOp::Gt => ">",
            BinaryOp::Ge => ">=",
            BinaryOp::Add => "+",
            BinaryOp::Sub => "-",
            BinaryOp::Mul => "*",
            BinaryOp::Div => "/",
            BinaryOp::Mod => "%",
        }
    }

    pub fn from_word(word: &str) -> Option<Self> {
        Some(match word {
            "==" => BinaryOp::Eq,
            "!=" => BinaryOp::Ne,
            "<" => BinaryOp::Lt,
            "<=" => BinaryOp::Le,
            ">" => BinaryOp::Gt,
            ">=" => BinaryOp::Ge,
            "+" => BinaryOp::Add,
            "-" => BinaryOp::Sub,
            "*" => BinaryOp::Mul,
            "/" => BinaryOp::Div,
            "%" => BinaryOp::Mod,
            _ => return None,
        })
    }

    /// True for the six comparison operators (the ones `relate` handles);
    /// false for the arithmetic ones (`arith`).
    pub fn is_comparison(self) -> bool {
        matches!(
            self,
            BinaryOp::Eq | BinaryOp::Ne | BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge
        )
    }
}

/// The `op` of a `unary` expression: `!` or `-`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UnaryOp {
    Not,
    Neg,
}

impl UnaryOp {
    pub fn as_str(self) -> &'static str {
        match self {
            UnaryOp::Not => "!",
            UnaryOp::Neg => "-",
        }
    }
}

/// The `op` of a `logical` expression: `&&` or `||`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LogicalOp {
    And,
    Or,
}

impl LogicalOp {
    pub fn as_str(self) -> &'static str {
        match self {
            LogicalOp::And => "&&",
            LogicalOp::Or => "||",
        }
    }
}

/// Scalar value/predicate expression, evaluated against a row scope + bindings.
#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    /// A literal: `string | number | boolean | null` in the TS, so the [`Value`]
    /// is always one of `Str`, `Number`, `Bool`, or `Null`.
    Lit(Value),
    /// Bare property of the CURRENT row/scope only (never climbs); `$value` is
    /// the row itself.
    Ident {
        name: String,
    },
    /// `^name` — read from exactly `levels` scopes out.
    Outer {
        levels: usize,
        name: String,
    },
    /// A `${…}` interpolated host value.
    Binding {
        index: usize,
    },
    /// `.prop` navigation on the value to its left.
    Member {
        recv: Box<Expr>,
        name: String,
    },
    /// `[expr]` navigation. Declared in the TS AST but never produced by the TS
    /// parser (its lexer has no bracket token); kept for one-to-one shape.
    Index {
        recv: Box<Expr>,
        index: Box<Expr>,
    },
    /// fn / method: `recv` is `None` for a free function `name(args)`.
    Call {
        recv: Option<Box<Expr>>,
        name: String,
        args: Vec<Expr>,
    },
    Unary {
        op: UnaryOp,
        expr: Box<Expr>,
    },
    /// Arithmetic + comparison.
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Logical {
        op: LogicalOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    In {
        left: Box<Expr>,
        right: Box<Expr>,
    },
    /// A Ruby-style range value. `lo`/`hi` are `None` for the open-ended forms
    /// (`..5` / `5..`); `exclusive_end` distinguishes `1...5` from `1..5`.
    /// Evaluates to a runtime range value (see `semantics::make_range`);
    /// primarily the RHS of `in`.
    Range {
        lo: Option<Box<Expr>>,
        hi: Option<Box<Expr>>,
        exclusive_end: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct OrderSpec {
    pub expr: Expr,
    pub desc: bool,
}

/// One projection item: a named scalar/navigation value, or a named nested
/// collection consumer. `lift` marks a `^name` one-scope lift.
#[derive(Clone, Debug, PartialEq)]
pub enum SelectItem {
    /// `lift` is the number of `^` carets: 0 = an ordinary projection, N = a
    /// lift that binds this value N scopes out (see the engine's
    /// flatten-append). `name` is `""` for an unaliased non-navigation item,
    /// which the parser only admits under `values`.
    Field {
        name: String,
        expr: Expr,
        lift: usize,
    },
    Collect {
        name: String,
        op: Box<OpNode>,
    },
}

impl SelectItem {
    pub fn name(&self) -> &str {
        match self {
            SelectItem::Field { name, .. } | SelectItem::Collect { name, .. } => name,
        }
    }
}

/// The `count { … } <op> <int>` test attached to an [`OpNode`]. `value` is a
/// number (the TS `number`), validated by the parser to be an integer.
#[derive(Clone, Debug, PartialEq)]
pub struct CountCmp {
    pub op: RelOp,
    pub value: f64,
}

/// A postfix consumer directive over a receiver collection:
/// `<receiver> <op> { <sub> }`, optionally `count { … } <relop> <int>`.
#[derive(Clone, Debug, PartialEq)]
pub struct OpNode {
    pub receiver: Expr,
    pub op: Consumer,
    pub sub: Subquery,
    pub count_cmp: Option<CountCmp>,
    /// `distinct` — dedup the rows this directive consumes by their projected
    /// value (the `select`), so `count distinct { … }` counts distinct
    /// projections and `collect distinct { … }` yields distinct rows. Empty
    /// select ⇒ dedup by row identity. Spellable as `<op> distinct { … }` or
    /// `{ select distinct … }`.
    pub distinct: bool,
}

/// The recursive `follow` clause.
#[derive(Clone, Debug, PartialEq)]
pub struct Follow {
    /// The type-preserving successor relation (a nav expression).
    pub receiver: Expr,
    pub distinct: bool,
    /// Successor predicate: which successors keep participating.
    pub r#where: Option<Expr>,
    /// Boundary predicate: cut a relation that could continue.
    pub frontier: Option<Expr>,
    /// 1..8 cap; `None` = the hard cap.
    pub depth: Option<u32>,
    /// Identity expression for cycle detection / dedup.
    pub by: Option<Expr>,
}

/// A nested (sub)query body.
#[derive(Clone, Debug, PartialEq)]
pub struct Subquery {
    /// Body-level `from E` re-projections (flatMap chain).
    pub from: Vec<Expr>,
    pub r#where: Option<Where>,
    pub select: Vec<SelectItem>,
    pub order_by: Option<Vec<OrderSpec>>,
    pub follow: Option<Follow>,
    /// `values` — scalar projection mode: the (single) projected expression is
    /// the row's result itself rather than being wrapped in a `{ name: value }`
    /// record, so `name values` yields `["Bob", …]` and `$value values` yields
    /// the rows.
    pub values: bool,
    /// `limit N` / `offset N` — bound the row set AFTER where/order/distinct and
    /// BEFORE the consumer reduces it, so `count { … limit 5 }` is at most 5 and
    /// `first { … offset 1 }` is the second row. Each is a value expression
    /// (a literal, a `${…}` binding, or an outer reference) read as part of the
    /// block — `^n` is the enclosing row's field, as everywhere inside `{ … }` —
    /// and must yield a non-negative integer.
    pub limit: Option<Expr>,
    pub offset: Option<Expr>,
}

/// The where-clause boolean tree: OQX owns &&/||/!/grouping so consumer ops
/// (invisible to the scalar evaluator) compose with scalar predicates.
#[derive(Clone, Debug, PartialEq)]
pub enum Where {
    And { parts: Vec<Where> },
    Or { parts: Vec<Where> },
    Not { expr: Box<Where> },
    Scalar { expr: Expr },
    Op(Box<OpNode>),
}

/// A top-level OQX query.
#[derive(Clone, Debug, PartialEq)]
pub struct Query {
    /// The root collection (`from <source>` or the directive receiver).
    pub source: Expr,
    /// Further top-level `from E` re-projections.
    pub from: Vec<Expr>,
    pub r#where: Option<Where>,
    pub select: Vec<SelectItem>,
    pub order_by: Option<Vec<OrderSpec>>,
    pub consumer: Consumer,
    pub follow: Option<Follow>,
    /// `distinct` — dedup the result rows by their projected value (see [`OpNode`]).
    pub distinct: bool,
    /// `values` — scalar projection mode (see [`Subquery`]).
    pub values: bool,
    /// `limit N` / `offset N` (see [`Subquery`]); evaluated at the root scope.
    pub limit: Option<Expr>,
    pub offset: Option<Expr>,
}
