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
    #[cfg_attr(not(feature = "json"), allow(dead_code))]
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
    #[cfg_attr(not(feature = "json"), allow(dead_code))]
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

/// The `op` of a `binary` expression: arithmetic, comparison, identity
/// (`is` / `is not`, SEMANTICS §5b, since 0.17), or a regex match (`~` `~*`
/// `!~` `!~*`, SEMANTICS §11, since 0.22 — sugar over `matches`, kept as
/// written so the canonical print is what the user wrote). The TS keeps this
/// as a string; `as_str()` is that string.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BinaryOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Is,
    IsNot,
    /// `a ~ b` ≡ `a.matches(b)`.
    Match,
    /// `a ~* b` ≡ `a.matches(b, "i")`.
    MatchI,
    /// `a !~ b` ≡ `!a.matches(b)`.
    NotMatch,
    /// `a !~* b` ≡ `!a.matches(b, "i")`.
    NotMatchI,
    Add,
    Sub,
    Mul,
    Div,
    Mod,
}

impl BinaryOp {
    #[cfg_attr(not(feature = "json"), allow(dead_code))]
    const WORDS: &'static [&'static str] = &[
        "==", "!=", "<", "<=", ">", ">=", "is", "is not", "~", "~*", "!~", "!~*", "+", "-", "*",
        "/", "%",
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            BinaryOp::Eq => "==",
            BinaryOp::Ne => "!=",
            BinaryOp::Lt => "<",
            BinaryOp::Le => "<=",
            BinaryOp::Gt => ">",
            BinaryOp::Ge => ">=",
            BinaryOp::Is => "is",
            BinaryOp::IsNot => "is not",
            BinaryOp::Match => "~",
            BinaryOp::MatchI => "~*",
            BinaryOp::NotMatch => "!~",
            BinaryOp::NotMatchI => "!~*",
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
            "is" => BinaryOp::Is,
            "is not" => BinaryOp::IsNot,
            "~" => BinaryOp::Match,
            "~*" => BinaryOp::MatchI,
            "!~" => BinaryOp::NotMatch,
            "!~*" => BinaryOp::NotMatchI,
            "+" => BinaryOp::Add,
            "-" => BinaryOp::Sub,
            "*" => BinaryOp::Mul,
            "/" => BinaryOp::Div,
            "%" => BinaryOp::Mod,
            _ => return None,
        })
    }

    /// For a regex operator (SEMANTICS §11, since 0.22), the `matches` call it
    /// stands for: `(negated, flags)` — `~` is `(false, None)`, `~*` is
    /// `(false, Some("i"))`, `!~` is `(true, None)`, `!~*` is `(true,
    /// Some("i"))`. `None` for every other operator.
    pub fn regex(self) -> Option<(bool, Option<&'static str>)> {
        match self {
            BinaryOp::Match => Some((false, None)),
            BinaryOp::MatchI => Some((false, Some("i"))),
            BinaryOp::NotMatch => Some((true, None)),
            BinaryOp::NotMatchI => Some((true, Some("i"))),
            _ => None,
        }
    }

    /// True for the four regex operators (`~` `~*` `!~` `!~*`).
    pub fn is_regex(self) -> bool {
        self.regex().is_some()
    }

    /// True for the six comparison operators (the ones `relate` handles);
    /// false for the identity and arithmetic ones.
    pub fn is_comparison(self) -> bool {
        matches!(
            self,
            BinaryOp::Eq | BinaryOp::Ne | BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge
        )
    }

    /// True for `is` / `is not` (SEMANTICS §5b: identity, never `relate`).
    pub fn is_identity(self) -> bool {
        matches!(self, BinaryOp::Is | BinaryOp::IsNot)
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
    #[cfg_attr(not(feature = "json"), allow(dead_code))]
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
    #[cfg_attr(not(feature = "json"), allow(dead_code))]
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

/// The aggregate functions (SEMANTICS §24, since 0.24): reserved free-function
/// names that reduce a group's rows. `count` takes zero or one argument, every
/// other exactly one; `any`/`all` take a predicate and admit no `distinct`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AggregateName {
    Count,
    Sum,
    Min,
    Max,
    Avg,
    Collect,
    First,
    Last,
    Any,
    All,
}

impl AggregateName {
    /// The TS `AGGREGATE_NAMES`, in the order the error messages list them.
    pub const WORDS: &'static [&'static str] = &[
        "count", "sum", "min", "max", "avg", "collect", "first", "last", "any", "all",
    ];

    /// The TS spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            AggregateName::Count => "count",
            AggregateName::Sum => "sum",
            AggregateName::Min => "min",
            AggregateName::Max => "max",
            AggregateName::Avg => "avg",
            AggregateName::Collect => "collect",
            AggregateName::First => "first",
            AggregateName::Last => "last",
            AggregateName::Any => "any",
            AggregateName::All => "all",
        }
    }

    /// The inverse of [`AggregateName::as_str`] (the TS `isAggregateName`):
    /// `None` when the word is not an aggregate's.
    pub fn from_word(word: &str) -> Option<Self> {
        Some(match word {
            "count" => AggregateName::Count,
            "sum" => AggregateName::Sum,
            "min" => AggregateName::Min,
            "max" => AggregateName::Max,
            "avg" => AggregateName::Avg,
            "collect" => AggregateName::Collect,
            "first" => AggregateName::First,
            "last" => AggregateName::Last,
            "any" => AggregateName::Any,
            "all" => AggregateName::All,
            _ => return None,
        })
    }

    /// `any` / `all`: a predicate aggregate (truthiness over the rows, no `distinct`).
    pub fn is_predicate(self) -> bool {
        matches!(self, AggregateName::Any | AggregateName::All)
    }
}
serde_as_word!(AggregateName);

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
    /// `x!` — the value of `expr`, or an eval error when it is absent (since 0.17).
    Required { expr: Box<Expr>, span: Span },
    /// Arithmetic, comparison, identity.
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
    /// A tuple `(e1, e2, …)` (since 0.20): two or more expressions whose values
    /// concatenate with one level of flattening (SEMANTICS §3b) — a value and a
    /// receiver (`(a, b) { … }`, `follow (a, b) { depth 2 }`). One expression in
    /// parentheses is grouping and leaves no node.
    Tuple { items: Vec<Expr>, span: Span },
    /// A template literal `` `text ${expr} text` `` (since 0.21): `parts`
    /// alternates strictly — text, interpolation, text, … — so it always has an
    /// odd length and begins and ends with a (possibly empty) text part; the
    /// text is decoded (the GRAMMAR §1 escapes resolved). Evaluates to the
    /// concatenation of the text and the interpolated values' string forms
    /// (SEMANTICS §7b): absent anywhere makes it absent; a list, a record or a
    /// range is an eval error.
    Template {
        parts: Vec<TemplatePart>,
        span: Span,
    },
    /// An aggregate call `sum(e)`, `count()`, `collect(distinct e)` (since
    /// 0.24): reduces the rows of the group it is read in (SEMANTICS §24).
    /// `arg` is `None` only for the bare `count()`; `distinct` is the
    /// `(distinct e)` modifier. A free call by an aggregate name parses to this
    /// node wherever it is written, never to a [`Expr::Call`]; it is legal only
    /// in the post-group clauses of a body with `group by`.
    Aggregate {
        name: AggregateName,
        arg: Option<Box<Expr>>,
        distinct: bool,
        span: Span,
    },
    /// A value-position directive (since 0.17): `recv first { … }.pay`, and
    /// what a bracket lookup `x[…]` desugars to. Serializes as the bare
    /// `OpNode` (`kind: "op"`): an op is an expression only by position.
    #[cfg_attr(feature = "json", serde(untagged))]
    Op(Box<OpNode>),
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
            | Expr::Required { span, .. }
            | Expr::Binary { span, .. }
            | Expr::Logical { span, .. }
            | Expr::In { span, .. }
            | Expr::Range { span, .. }
            | Expr::Tuple { span, .. }
            | Expr::Template { span, .. }
            | Expr::Aggregate { span, .. } => *span,
            Expr::Op(op) => op.span,
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
            | Expr::Required { span, .. }
            | Expr::Binary { span, .. }
            | Expr::Logical { span, .. }
            | Expr::In { span, .. }
            | Expr::Range { span, .. }
            | Expr::Tuple { span, .. }
            | Expr::Template { span, .. }
            | Expr::Aggregate { span, .. } => span,
            Expr::Op(op) => &mut op.span,
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
            Expr::Required { .. } => "required",
            Expr::Op(_) => "op",
            Expr::Binary { .. } => "binary",
            Expr::Logical { .. } => "logical",
            Expr::In { .. } => "in",
            Expr::Range { .. } => "range",
            Expr::Tuple { .. } => "tuple",
            Expr::Template { .. } => "template",
            Expr::Aggregate { .. } => "aggregate",
        }
    }
}

/// One part of a template literal (`Expr::Template`): a decoded text run, or an
/// interpolated expression. The strings are not nodes (no `kind`, no span):
/// a part serializes as the bare string or the expression node.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "json", derive(Serialize, Deserialize), serde(untagged))]
pub enum TemplatePart {
    Text(String),
    Expr(Expr),
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

/// One `group by` key (since 0.24): `name: expr`, or an unaliased navigation
/// keyed by its last segment, exactly as a `select` item is.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    feature = "json",
    derive(Serialize, Deserialize),
    serde(tag = "kind", rename = "key")
)]
pub struct GroupKey {
    pub name: String,
    pub expr: Expr,
    pub span: Span,
}

/// The `group by` clause (since 0.24): one row per distinct key tuple
/// (SEMANTICS §24).
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    feature = "json",
    derive(Serialize, Deserialize),
    serde(tag = "kind", rename = "groupBy")
)]
pub struct GroupBy {
    /// ≥ 1, in source order.
    pub keys: Vec<GroupKey>,
    pub span: Span,
}

/// One `flatten` clause (since 0.25): `flatten <expr> [{ … }] [as <name>]` —
/// the value of `expr`, read on each row, is split into one row per element
/// (SEMANTICS §25), each the parent row with `name` bound at the same scope
/// depth. A written block is the implicit `collect` directive over the value
/// (GRAMMAR §2), so `expr` is then an [`Expr::Op`]; `name` is always filled —
/// the alias, or the last segment of a plain navigation when `as` was omitted.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    feature = "json",
    derive(Serialize, Deserialize),
    serde(tag = "kind", rename = "flatten")
)]
pub struct Flatten {
    pub expr: Expr,
    pub name: String,
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

/// The recursive `follow` clause (since 0.20 just the destinations: a
/// destination's `where`, `frontier` and `depth` live in its own block).
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
    /// `frontier P` / `depth n` (since 0.20). In a `follow` destination block
    /// `frontier` marks the occurrences reached through this destination for
    /// which `P` holds (not expanded; `P` read one level out, under the walk's
    /// enclosing scope), and `depth n` makes the destination expand a frontier
    /// row only while that row's `$depth < n` (1..8; `None` = the hard cap 8).
    /// In any other block `frontier` is legal only with a `follow` and marks
    /// the walk's SEEDS, read in the seed's scope like `where` (as on
    /// [`Query`]); `depth` is destination-only. Both `None` when absent.
    pub frontier: Option<Expr>,
    pub depth: Option<u32>,
    /// `flatten` clauses (since 0.25), in writing order; empty when there is
    /// none. Each fans the rows the previous produced out, after `follow` and
    /// before `group by` (SEMANTICS §25).
    pub flatten: Vec<Flatten>,
    /// `group by` / `having` (since 0.24): the block's rows become one row per
    /// distinct key tuple (SEMANTICS §24); `having` filters the groups. Both
    /// `None` when absent; `having` is set only together with `group_by`.
    pub group_by: Option<GroupBy>,
    pub having: Option<Where>,
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
    /// `frontier P` (since 0.20) — legal only when the body has a `follow`: a
    /// seed for which `P` holds (read in the seed's own scope, `^` the
    /// enclosing scope, like `where`) is a frontier (`$stop == "frontier"`,
    /// not expanded). `None` without one.
    pub frontier: Option<Expr>,
    /// `flatten` clauses (since 0.25; see [`Subquery`]).
    pub flatten: Vec<Flatten>,
    /// `group by` / `having` (since 0.24; see [`Subquery`]).
    pub group_by: Option<GroupBy>,
    pub having: Option<Where>,
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
