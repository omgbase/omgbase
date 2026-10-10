//! Builders for AST nodes a tool constructs itself (`spec/oqx/AST.md` §7; port
//! of `packages/oqx/src/build.ts`). Every node they make carries
//! [`Span::EMPTY`] — "not from source" — and the materialized defaults
//! (`distinct: false`, `limit: None`, …), so a hand-built tree has the same
//! shape as a parsed one and prints with [`crate::print`].

use crate::ast::{
    BinaryOp, Consumer, CountCmp, Expr, Follow, FollowDestination, LogicalOp, OpNode, OrderSpec,
    Query, SelectItem, Span, Subquery, UnaryOp, Where,
};
use crate::value::Value;

pub fn lit(value: impl Into<Value>) -> Expr {
    Expr::Lit {
        value: value.into(),
        span: Span::EMPTY,
    }
}
pub fn ident(name: &str) -> Expr {
    Expr::Ident {
        name: name.to_owned(),
        span: Span::EMPTY,
    }
}
pub fn outer(levels: usize, name: &str) -> Expr {
    Expr::Outer {
        levels,
        name: name.to_owned(),
        span: Span::EMPTY,
    }
}
pub fn binding(index: usize) -> Expr {
    Expr::Binding {
        index,
        span: Span::EMPTY,
    }
}
pub fn member(recv: Expr, name: &str) -> Expr {
    Expr::Member {
        recv: Box::new(recv),
        name: name.to_owned(),
        span: Span::EMPTY,
    }
}
/// `a.b.c` from a dotted path (`path(&["a", "b", "c"])`).
pub fn path(segments: &[&str]) -> Expr {
    let (first, rest) = segments
        .split_first()
        .expect("a path has at least one segment");
    rest.iter().fold(ident(first), |e, n| member(e, n))
}
pub fn call(recv: Option<Expr>, name: &str, args: Vec<Expr>) -> Expr {
    Expr::Call {
        recv: recv.map(Box::new),
        name: name.to_owned(),
        args,
        span: Span::EMPTY,
    }
}
/// `expr!` — the required value (SEMANTICS §5b).
pub fn required(expr: Expr) -> Expr {
    Expr::Required {
        expr: Box::new(expr),
        span: Span::EMPTY,
    }
}

pub fn unary(op: UnaryOp, expr: Expr) -> Expr {
    Expr::Unary {
        op,
        expr: Box::new(expr),
        span: Span::EMPTY,
    }
}
pub fn binary(op: BinaryOp, left: Expr, right: Expr) -> Expr {
    Expr::Binary {
        op,
        left: Box::new(left),
        right: Box::new(right),
        span: Span::EMPTY,
    }
}
pub fn logical(op: LogicalOp, left: Expr, right: Expr) -> Expr {
    Expr::Logical {
        op,
        left: Box::new(left),
        right: Box::new(right),
        span: Span::EMPTY,
    }
}
pub fn in_op(left: Expr, right: Expr) -> Expr {
    Expr::In {
        left: Box::new(left),
        right: Box::new(right),
        span: Span::EMPTY,
    }
}
pub fn range(lo: Option<Expr>, hi: Option<Expr>, exclusive_end: bool) -> Expr {
    Expr::Range {
        lo: lo.map(Box::new),
        hi: hi.map(Box::new),
        exclusive_end,
        span: Span::EMPTY,
    }
}

pub fn scalar(expr: Expr) -> Where {
    Where::Scalar {
        expr,
        span: Span::EMPTY,
    }
}
pub fn and(parts: Vec<Where>) -> Where {
    Where::And {
        parts,
        span: Span::EMPTY,
    }
}
pub fn or(parts: Vec<Where>) -> Where {
    Where::Or {
        parts,
        span: Span::EMPTY,
    }
}
pub fn not(expr: Where) -> Where {
    Where::Not {
        expr: Box::new(expr),
        span: Span::EMPTY,
    }
}
/// A where-position consumer test.
pub fn where_op(op: OpNode) -> Where {
    Where::Op(Box::new(op))
}

pub fn field(name: &str, expr: Expr) -> SelectItem {
    SelectItem::Field {
        name: name.to_owned(),
        expr,
        lift: 0,
        span: Span::EMPTY,
    }
}
pub fn lifted(lift: usize, name: &str, expr: Expr) -> SelectItem {
    SelectItem::Field {
        name: name.to_owned(),
        expr,
        lift,
        span: Span::EMPTY,
    }
}
pub fn collect(name: &str, op: OpNode) -> SelectItem {
    SelectItem::Collect {
        name: name.to_owned(),
        op: Box::new(op),
        span: Span::EMPTY,
    }
}
pub fn order(expr: Expr, desc: bool) -> OrderSpec {
    OrderSpec {
        expr,
        desc,
        span: Span::EMPTY,
    }
}

/// An empty block body; set the clauses you need.
pub fn subquery() -> Subquery {
    Subquery {
        from: Vec::new(),
        r#where: None,
        select: Vec::new(),
        order_by: None,
        follow: None,
        values: false,
        limit: None,
        offset: None,
        span: Span::EMPTY,
    }
}

/// `<receiver> <op> { sub }` (not distinct, no count comparison).
pub fn op(receiver: Expr, consumer: Consumer, sub: Subquery) -> OpNode {
    OpNode {
        receiver,
        op: consumer,
        sub,
        count_cmp: None,
        distinct: false,
        span: Span::EMPTY,
    }
}

/// `<receiver> count { sub } <relop> <n>`.
pub fn count_cmp(receiver: Expr, sub: Subquery, cmp: CountCmp) -> OpNode {
    OpNode {
        receiver,
        op: Consumer::Count,
        sub,
        count_cmp: Some(cmp),
        distinct: false,
        span: Span::EMPTY,
    }
}

/// `follow <destinations>`; set the options you need.
pub fn follow(destinations: Vec<FollowDestination>) -> Follow {
    Follow {
        destinations,
        distinct: false,
        r#where: None,
        frontier: None,
        depth: None,
        by: None,
        span: Span::EMPTY,
    }
}

/// A top-level `collect` query over `source`; set the clauses you need.
pub fn query(source: Expr) -> Query {
    Query {
        source,
        from: Vec::new(),
        r#where: None,
        select: Vec::new(),
        order_by: None,
        consumer: Consumer::Collect,
        follow: None,
        distinct: false,
        values: false,
        limit: None,
        offset: None,
        span: Span::EMPTY,
    }
}
