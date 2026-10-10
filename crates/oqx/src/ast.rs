//! The OQX AST — a first-class, language-level contract (`spec/oqx/AST.md`,
//! since language 0.16). The parser produces it directly and the interpreter
//! walks it — there is no separate lowering/IR pass, because a "relation" in
//! the generic kernel is just an expression evaluated against the current row
//! (property navigation on the host object model), resolved at run time rather
//! than against a fixed schema. Tools reflect on it without re-parsing: every
//! node carries a [`Span`], every optional field is materialized, and with the
//! `json` feature the tree serializes to the exact JSON shape the TypeScript
//! reference produces (`kind`-tagged nodes, camelCase fields, explicit nulls,
//! operators as their source words — `cases/ast.json` proves the two equal).
//!
//! This is a one-to-one port of `packages/oqx/src/ast.ts`. Field names keep
//! the TypeScript spelling (snake_cased): a TS `orderBy` is `order_by`,
//! `exclusiveEnd` is `exclusive_end`, `countCmp` is `count_cmp`. `where` is a
//! Rust keyword, so that field is the raw identifier `r#where`. The TS stores
//! operators as strings; here they are the small enums [`BinaryOp`],
//! [`UnaryOp`], [`LogicalOp`], and [`RelOp`], each with an `as_str()` giving
//! the TS spelling (which is what the semantics module's `relate(op, a, b)` /
//! `arith(op, a, b)` take). Recursion through `Where → OpNode → Subquery →
//! Where` is broken by boxing the `OpNode` inside [`Where::Op`] and
//! [`SelectItem::Collect`].
//!
//! `where` keeps its surface form: a `select` alias referenced in `where`
//! stays a bare identifier here; [`crate::resolve::resolve_aliases`] performs
//! the substitution before evaluation. Nodes built by a tool rather than the
//! parser carry [`Span::EMPTY`] (see [`crate::build`]).

use crate::value::Value;

#[cfg(feature = "json")]
use serde::{Deserialize, Serialize};

/// A half-open source range `[start, end)` in Unicode code points over the raw
/// source (`raw_source` for a template, where a binding occupies its `${n}`
/// marker). Serializes as `[start, end]`. [`Span::EMPTY`] marks a node that
/// did not come from source.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    /// The span of a node built by a tool rather than parsed: `[0, 0)`.
    pub const EMPTY: Span = Span { start: 0, end: 0 };

    pub const fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }
}

#[cfg(feature = "json")]
impl Serialize for Span {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        [self.start, self.end].serialize(serializer)
    }
}

#[cfg(feature = "json")]
impl<'de> Deserialize<'de> for Span {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let [start, end] = <[usize; 2]>::deserialize(deserializer)?;
        Ok(Span { start, end })
    }
}

/// Serialize an operator / consumer enum as its source word (`as_str`) and
/// read it back with `from_word`.
macro_rules! serde_as_word {
    ($ty:ident) => {
        #[cfg(feature = "json")]
        impl Serialize for $ty {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        #[cfg(feature = "json")]
        impl<'de> Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let word = String::deserialize(deserializer)?;
                $ty::from_word(&word)
                    .ok_or_else(|| serde::de::Error::unknown_variant(&word, <$ty>::WORDS))
            }
        }
    };
}

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
    const WORDS: &'static [&'static str] =
        &["collect", "exists", "none", "count", "first", "single"];

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
serde_as_word!(Consumer);

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
    const WORDS: &'static [&'static str] = &["==", "!=", "<", "<=", ">", ">="];

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
serde_as_word!(RelOp);

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
    const WORDS: &'static [&'static str] =
        &["==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "%"];

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
serde_as_word!(BinaryOp);

/// The `op` of a `unary` expression: `!` or `-`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UnaryOp {
    Not,
    Neg,
}

impl UnaryOp {
    const WORDS: &'static [&'static str] = &["!", "-"];

    pub fn as_str(self) -> &'static str {
        match self {
            UnaryOp::Not => "!",
            UnaryOp::Neg => "-",
        }
    }

    pub fn from_word(word: &str) -> Option<Self> {
        Some(match word {
            "!" => UnaryOp::Not,
            "-" => UnaryOp::Neg,
            _ => return None,
        })
    }
}
serde_as_word!(UnaryOp);

/// The `op` of a `logical` expression: `&&` or `||`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LogicalOp {
    And,
    Or,
}

impl LogicalOp {
    const WORDS: &'static [&'static str] = &["&&", "||"];

    pub fn as_str(self) -> &'static str {
        match self {
            LogicalOp::And => "&&",
            LogicalOp::Or => "||",
        }
    }

    pub fn from_word(word: &str) -> Option<Self> {
        Some(match word {
            "&&" => LogicalOp::And,
            "||" => LogicalOp::Or,
            _ => return None,
        })
    }
}
serde_as_word!(LogicalOp);

/// Scalar value/predicate expression, evaluated against a row scope + bindings.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    feature = "json",
    derive(Serialize, Deserialize),
    serde(tag = "kind", rename_all = "camelCase")
)]
pub enum Expr {
    /// A literal: `string | number | boolean | null` in the TS, so the [`Value`]
    /// is always one of `Str`, `Number`, `Bool`, or `Null`.
    Lit {
        #[cfg_attr(feature = "json", serde(with = "json_lit"))]
        value: Value,
        span: Span,
    },
    /// Bare property of the CURRENT row/scope only (never climbs); `$it` is
    /// the row itself.
    Ident { name: String, span: Span },
    /// `^name` — read from exactly `levels` scopes out.
    Outer {
        levels: usize,
        name: String,
        span: Span,
    },
    /// A `${…}` interpolated host value.
    Binding { index: usize, span: Span },
    /// `.prop` navigation on the value to its left.
    Member {
        recv: Box<Expr>,
        name: String,
        span: Span,
    },
    /// fn / method: `recv` is `None` for a free function `name(args)`.
    Call {
        recv: Option<Box<Expr>>,
        name: String,
        args: Vec<Expr>,
        span: Span,
    },
    Unary {
        op: UnaryOp,
        expr: Box<Expr>,
        span: Span,
    },
    /// Arithmetic + comparison.
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
        span: Span,
    },
    Logical {
        op: LogicalOp,
        left: Box<Expr>,
        right: Box<Expr>,
        span: Span,
    },
    In {
        left: Box<Expr>,
        right: Box<Expr>,
        span: Span,
    },
    /// A Ruby-style range value. `lo`/`hi` are `None` for the open-ended forms
    /// (`..5` / `5..`); `exclusive_end` distinguishes `1...5` from `1..5`.
    /// Evaluates to a runtime range value (see `semantics::make_range`);
    /// primarily the RHS of `in`.
    #[cfg_attr(feature = "json", serde(rename_all = "camelCase"))]
    Range {
        lo: Option<Box<Expr>>,
        hi: Option<Box<Expr>>,
        exclusive_end: bool,
        span: Span,
    },
}

impl Expr {
    /// The node's span.
    pub fn span(&self) -> Span {
        match self {
            Expr::Lit { span, .. }
            | Expr::Ident { span, .. }
            | Expr::Outer { span, .. }
            | Expr::Binding { span, .. }
            | Expr::Member { span, .. }
            | Expr::Call { span, .. }
            | Expr::Unary { span, .. }
            | Expr::Binary { span, .. }
            | Expr::Logical { span, .. }
            | Expr::In { span, .. }
            | Expr::Range { span, .. } => *span,
        }
    }

    /// The same node with another span (a parenthesized operand takes the span
    /// of its parentheses).
    pub fn with_span(mut self, new: Span) -> Self {
        *self.span_mut() = new;
        self
    }

    pub(crate) fn span_mut(&mut self) -> &mut Span {
        match self {
            Expr::Lit { span, .. }
            | Expr::Ident { span, .. }
            | Expr::Outer { span, .. }
            | Expr::Binding { span, .. }
            | Expr::Member { span, .. }
            | Expr::Call { span, .. }
            | Expr::Unary { span, .. }
            | Expr::Binary { span, .. }
            | Expr::Logical { span, .. }
            | Expr::In { span, .. }
            | Expr::Range { span, .. } => span,
        }
    }

    /// The `kind` word of the JSON shape.
    pub fn kind(&self) -> &'static str {
        match self {
            Expr::Lit { .. } => "lit",
            Expr::Ident { .. } => "ident",
            Expr::Outer { .. } => "outer",
            Expr::Binding { .. } => "binding",
            Expr::Member { .. } => "member",
            Expr::Call { .. } => "call",
            Expr::Unary { .. } => "unary",
            Expr::Binary { .. } => "binary",
            Expr::Logical { .. } => "logical",
            Expr::In { .. } => "in",
            Expr::Range { .. } => "range",
        }
    }
}

/// One `order by` term.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    feature = "json",
    derive(Serialize, Deserialize),
    serde(tag = "kind", rename = "order")
)]
pub struct OrderSpec {
    pub expr: Expr,
    pub desc: bool,
    pub span: Span,
}

/// One projection item: a named scalar/navigation value, or a named nested
/// collection consumer. `lift` marks a `^name` lift.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    feature = "json",
    derive(Serialize, Deserialize),
    serde(tag = "kind", rename_all = "camelCase")
)]
pub enum SelectItem {
    /// `lift` is the number of `^` carets: 0 = an ordinary projection, N = a
    /// lift that binds this value N scopes out (see the engine's
    /// flatten-append). `name` is `""` for an unaliased non-navigation item,
    /// which the parser only admits under `values`.
    Field {
        name: String,
        expr: Expr,
        lift: usize,
        span: Span,
    },
    Collect {
        name: String,
        op: Box<OpNode>,
        span: Span,
    },
}

impl SelectItem {
    pub fn name(&self) -> &str {
        match self {
            SelectItem::Field { name, .. } | SelectItem::Collect { name, .. } => name,
        }
    }

    pub fn span(&self) -> Span {
        match self {
            SelectItem::Field { span, .. } | SelectItem::Collect { span, .. } => *span,
        }
    }
}

/// The `count { … } <op> <int>` test attached to an [`OpNode`] — an attribute
/// of the directive, not a node. `value` is a number (the TS `number`),
/// validated by the parser to be an integer.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "json", derive(Serialize, Deserialize))]
pub struct CountCmp {
    pub op: RelOp,
    #[cfg_attr(feature = "json", serde(with = "json_number"))]
    pub value: f64,
}

/// A postfix consumer directive over a receiver collection:
/// `<receiver> <op> { <sub> }`, optionally `count { … } <relop> <int>`.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    feature = "json",
    derive(Serialize, Deserialize),
    serde(tag = "kind", rename = "op", rename_all = "camelCase")
)]
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
    pub span: Span,
}

/// One `follow` destination: a relation of the current row, or a destination
/// block — a select-position directive (`collect`/`first`/`single`)
/// re-evaluated per frontier row, inside which `^` is that row. Serializes as
/// the bare node (an `Expr` or an `OpNode` with `kind: "op"`).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "json", derive(Serialize, Deserialize), serde(untagged))]
pub enum FollowDestination {
    Relation(Expr),
    Block(Box<OpNode>),
}

impl FollowDestination {
    pub fn span(&self) -> Span {
        match self {
            FollowDestination::Relation(e) => e.span(),
            FollowDestination::Block(op) => op.span,
        }
    }
}

/// The recursive `follow` clause.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    feature = "json",
    derive(Serialize, Deserialize),
    serde(tag = "kind", rename = "follow")
)]
pub struct Follow {
    /// ≥ 1, in source order; the walk is their union.
    pub destinations: Vec<FollowDestination>,
    pub distinct: bool,
    /// Successor predicate: which successors keep participating.
    #[cfg_attr(feature = "json", serde(rename = "where"))]
    pub r#where: Option<Expr>,
    /// Boundary predicate: cut a relation that could continue.
    pub frontier: Option<Expr>,
    /// 1..8 cap; `None` = the hard cap.
    pub depth: Option<u32>,
    /// Identity expression for cycle detection / dedup.
    pub by: Option<Expr>,
    pub span: Span,
}

/// A nested (sub)query body — the `{ … }` of a directive.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    feature = "json",
    derive(Serialize, Deserialize),
    serde(tag = "kind", rename = "subquery", rename_all = "camelCase")
)]
pub struct Subquery {
    /// Body-level `from E` re-projections (flatMap chain).
    pub from: Vec<Expr>,
    #[cfg_attr(feature = "json", serde(rename = "where"))]
    pub r#where: Option<Where>,
    pub select: Vec<SelectItem>,
    pub order_by: Option<Vec<OrderSpec>>,
    pub follow: Option<Follow>,
    /// `values` — scalar projection mode: the (single) projected expression is
    /// the row's result itself rather than being wrapped in a `{ name: value }`
    /// record, so `name values` yields `["Bob", …]` and `$it values` yields
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
    pub span: Span,
}

/// The where-clause boolean tree: OQX owns &&/||/!/grouping so consumer ops
/// (invisible to the scalar evaluator) compose with scalar predicates. A
/// consumer test in where position is the [`OpNode`] itself (`kind: "op"`).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    feature = "json",
    derive(Serialize, Deserialize),
    serde(tag = "kind", rename_all = "camelCase")
)]
pub enum Where {
    And {
        parts: Vec<Where>,
        span: Span,
    },
    Or {
        parts: Vec<Where>,
        span: Span,
    },
    Not {
        expr: Box<Where>,
        span: Span,
    },
    Scalar {
        expr: Expr,
        span: Span,
    },
    #[cfg_attr(feature = "json", serde(untagged))]
    Op(Box<OpNode>),
}

impl Where {
    pub fn span(&self) -> Span {
        match self {
            Where::And { span, .. }
            | Where::Or { span, .. }
            | Where::Not { span, .. }
            | Where::Scalar { span, .. } => *span,
            Where::Op(op) => op.span,
        }
    }

    pub(crate) fn with_span(mut self, new: Span) -> Self {
        match &mut self {
            Where::And { span, .. }
            | Where::Or { span, .. }
            | Where::Not { span, .. }
            | Where::Scalar { span, .. } => *span = new,
            Where::Op(op) => op.span = new,
        }
        self
    }

    /// The `kind` word of the JSON shape.
    pub fn kind(&self) -> &'static str {
        match self {
            Where::And { .. } => "and",
            Where::Or { .. } => "or",
            Where::Not { .. } => "not",
            Where::Scalar { .. } => "scalar",
            Where::Op(_) => "op",
        }
    }
}

/// A top-level OQX query.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    feature = "json",
    derive(Serialize, Deserialize),
    serde(tag = "kind", rename = "query", rename_all = "camelCase")
)]
pub struct Query {
    /// The root collection (`from <source>` or the directive receiver).
    pub source: Expr,
    /// Further top-level `from E` re-projections.
    pub from: Vec<Expr>,
    #[cfg_attr(feature = "json", serde(rename = "where"))]
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
    pub span: Span,
}

/// `serde(with)` for a literal's value: the JSON scalar itself (`"s"`, `1`,
/// `2.5`, `true`, `null`), integral numbers without a fraction.
#[cfg(feature = "json")]
mod json_lit {
    use super::Value;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &Value, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Value::Str(x) => s.serialize_str(x),
            Value::Number(n) => super::json_number::serialize(n, s),
            Value::Bool(b) => s.serialize_bool(*b),
            Value::Null | Value::Undefined => s.serialize_unit(),
            other => Err(serde::ser::Error::custom(format!(
                "a literal is a string, number, boolean or null, not {other:?}"
            ))),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Value, D::Error> {
        let j = serde_json::Value::deserialize(d)?;
        match j {
            serde_json::Value::Null => Ok(Value::Null),
            serde_json::Value::Bool(b) => Ok(Value::Bool(b)),
            serde_json::Value::Number(n) => Ok(Value::Number(n.as_f64().unwrap_or(f64::NAN))),
            serde_json::Value::String(s) => Ok(Value::Str(s)),
            other => Err(serde::de::Error::custom(format!(
                "a literal is a string, number, boolean or null, not {other}"
            ))),
        }
    }
}

/// `serde(with)` for a number attribute: integral values (`2`, not `2.0`) as
/// JSON integers, as `JSON.stringify` writes them.
#[cfg(feature = "json")]
mod json_number {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(n: &f64, s: S) -> Result<S::Ok, S::Error> {
        const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_992.0; // 2^53
        if n.fract() == 0.0 && n.abs() < MAX_SAFE_INTEGER {
            s.serialize_i64(*n as i64)
        } else {
            s.serialize_f64(*n)
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        f64::deserialize(d)
    }
}
