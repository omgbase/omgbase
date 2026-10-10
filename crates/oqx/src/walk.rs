//! Generic traversal over the AST (`spec/oqx/AST.md` §5; port of
//! `packages/oqx/src/walk.ts`): [`visit`] with a [`Visitor`] (enter/leave with
//! the path, the enclosing clause and the scope depth), [`transform`] (rebuild a
//! query with every expression mapped), [`strip_spans`]. One `children`
//! function per node kind is the single place a node's child slots are named;
//! `visit` and `transform` both read it.

use crate::ast::{
    Expr, Follow, FollowDestination, OpNode, OrderSpec, Query, SelectItem, Span, Subquery, Where,
};

/// A borrowed node of any kind.
#[derive(Clone, Copy, Debug)]
pub enum Node<'a> {
    Query(&'a Query),
    Subquery(&'a Subquery),
    Op(&'a OpNode),
    Follow(&'a Follow),
    Order(&'a OrderSpec),
    Select(&'a SelectItem),
    Where(&'a Where),
    Expr(&'a Expr),
}

impl Node<'_> {
    /// The node's span.
    pub fn span(&self) -> Span {
        match self {
            Node::Query(q) => q.span,
            Node::Subquery(s) => s.span,
            Node::Op(op) => op.span,
            Node::Follow(f) => f.span,
            Node::Order(o) => o.span,
            Node::Select(it) => it.span(),
            Node::Where(w) => w.span(),
            Node::Expr(e) => e.span(),
        }
    }

    /// The `kind` word of the JSON shape.
    pub fn kind(&self) -> &'static str {
        match self {
            Node::Query(_) => "query",
            Node::Subquery(_) => "subquery",
            Node::Op(_) => "op",
            Node::Follow(_) => "follow",
            Node::Order(_) => "order",
            Node::Select(SelectItem::Field { .. }) => "field",
            Node::Select(SelectItem::Collect { .. }) => "collect",
            Node::Where(w) => w.kind(),
            Node::Expr(e) => e.kind(),
        }
    }
}

/// The clause a node sits in. `Source` is the root collection (`from <source>`
/// or the directive receiver); `From` the further re-projections; `Follow` the
/// `Follow` node itself and `Follow*` its parts. The root node has no clause.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Clause {
    Source,
    From,
    Where,
    Select,
    OrderBy,
    Limit,
    Offset,
    Follow,
    FollowDestination,
    FollowWhere,
    FollowFrontier,
    FollowBy,
}

impl Clause {
    /// The reference's spelling (`"follow.destination"`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            Clause::Source => "source",
            Clause::From => "from",
            Clause::Where => "where",
            Clause::Select => "select",
            Clause::OrderBy => "orderBy",
            Clause::Limit => "limit",
            Clause::Offset => "offset",
            Clause::Follow => "follow",
            Clause::FollowDestination => "follow.destination",
            Clause::FollowWhere => "follow.where",
            Clause::FollowFrontier => "follow.frontier",
            Clause::FollowBy => "follow.by",
        }
    }
}

/// Where a visited node sits. `depth` is the scope depth at which the node is
/// evaluated (0 = the root scope: a top-level `source`, `limit`, `offset`; 1 =
/// a top-level row: its `where`, `select`, `order by`, `from` re-projections
/// and `follow`; a block's rows are one deeper than the block's receiver; a
/// follow `where` is one deeper than the frontier row it tests successors of).
#[derive(Clone, Debug)]
pub struct VisitContext<'a> {
    /// The ancestors of the node, root first (empty for the root).
    pub path: Vec<Node<'a>>,
    pub clause: Option<Clause>,
    pub depth: usize,
}

/// The callbacks of [`visit`].
pub trait Visitor {
    /// Called before a node's children; return `false` to skip the subtree
    /// (`leave` is still called for the node).
    fn enter(&mut self, node: Node<'_>, ctx: &VisitContext<'_>) -> bool {
        let _ = (node, ctx);
        true
    }
    /// Called after a node's children.
    fn leave(&mut self, node: Node<'_>, ctx: &VisitContext<'_>) {
        let _ = (node, ctx);
    }
}

/// One child slot: the node, the clause it opens (inherited when `None`) and how
/// much deeper its scope is.
struct Child<'a> {
    node: Node<'a>,
    clause: Option<Clause>,
    depth: usize,
}

fn child<'a>(node: Node<'a>, clause: Option<Clause>, depth: usize) -> Child<'a> {
    Child {
        node,
        clause,
        depth,
    }
}

/// The children of a node in canonical source order — the one table every walk
/// reads (`spec/oqx/AST.md` §5).
fn children<'a>(node: Node<'a>) -> Vec<Child<'a>> {
    let mut out = Vec::new();
    match node {
        Node::Query(q) => {
            out.extend(
                q.select
                    .iter()
                    .map(|it| child(Node::Select(it), Some(Clause::Select), 1)),
            );
            out.push(child(Node::Expr(&q.source), Some(Clause::Source), 0));
            out.extend(
                q.from
                    .iter()
                    .map(|e| child(Node::Expr(e), Some(Clause::From), 1)),
            );
            if let Some(w) = &q.r#where {
                out.push(child(Node::Where(w), Some(Clause::Where), 1));
            }
            if let Some(f) = &q.follow {
                out.push(child(Node::Follow(f), Some(Clause::Follow), 1));
            }
            if let Some(o) = &q.order_by {
                out.extend(
                    o.iter()
                        .map(|s| child(Node::Order(s), Some(Clause::OrderBy), 1)),
                );
            }
            if let Some(e) = &q.limit {
                out.push(child(Node::Expr(e), Some(Clause::Limit), 0));
            }
            if let Some(e) = &q.offset {
                out.push(child(Node::Expr(e), Some(Clause::Offset), 0));
            }
        }
        Node::Subquery(s) => {
            out.extend(
                s.select
                    .iter()
                    .map(|it| child(Node::Select(it), Some(Clause::Select), 0)),
            );
            out.extend(
                s.from
                    .iter()
                    .map(|e| child(Node::Expr(e), Some(Clause::From), 0)),
            );
            if let Some(w) = &s.r#where {
                out.push(child(Node::Where(w), Some(Clause::Where), 0));
            }
            if let Some(f) = &s.follow {
                out.push(child(Node::Follow(f), Some(Clause::Follow), 0));
            }
            if let Some(o) = &s.order_by {
                out.extend(
                    o.iter()
                        .map(|x| child(Node::Order(x), Some(Clause::OrderBy), 0)),
                );
            }
            if let Some(e) = &s.limit {
                out.push(child(Node::Expr(e), Some(Clause::Limit), 0));
            }
            if let Some(e) = &s.offset {
                out.push(child(Node::Expr(e), Some(Clause::Offset), 0));
            }
        }
        Node::Op(op) => {
            out.push(child(Node::Expr(&op.receiver), None, 0));
            out.push(child(Node::Subquery(&op.sub), None, 1));
        }
        Node::Follow(f) => {
            out.extend(f.destinations.iter().map(|d| {
                let n = match d {
                    FollowDestination::Relation(e) => Node::Expr(e),
                    FollowDestination::Block(op) => Node::Op(op),
                };
                child(n, Some(Clause::FollowDestination), 0)
            }));
            if let Some(e) = &f.r#where {
                out.push(child(Node::Expr(e), Some(Clause::FollowWhere), 1));
            }
            if let Some(e) = &f.frontier {
                out.push(child(Node::Expr(e), Some(Clause::FollowFrontier), 0));
            }
            if let Some(e) = &f.by {
                out.push(child(Node::Expr(e), Some(Clause::FollowBy), 0));
            }
        }
        Node::Order(o) => out.push(child(Node::Expr(&o.expr), None, 0)),
        Node::Select(SelectItem::Field { expr, .. }) => out.push(child(Node::Expr(expr), None, 0)),
        Node::Select(SelectItem::Collect { op, .. }) => out.push(child(Node::Op(op), None, 0)),
        Node::Where(w) => match w {
            Where::And { parts, .. } | Where::Or { parts, .. } => {
                out.extend(parts.iter().map(|p| child(where_node(p), None, 0)));
            }
            Where::Not { expr, .. } => out.push(child(where_node(expr), None, 0)),
            Where::Scalar { expr, .. } => out.push(child(Node::Expr(expr), None, 0)),
            Where::Op(op) => return children(Node::Op(op)),
        },
        Node::Expr(e) => match e {
            Expr::Lit { .. } | Expr::Ident { .. } | Expr::Outer { .. } | Expr::Binding { .. } => {}
            Expr::Member { recv, .. } => out.push(child(Node::Expr(recv), None, 0)),
            Expr::Call { recv, args, .. } => {
                if let Some(r) = recv {
                    out.push(child(Node::Expr(r), None, 0));
                }
                out.extend(args.iter().map(|a| child(Node::Expr(a), None, 0)));
            }
            Expr::Unary { expr, .. } => out.push(child(Node::Expr(expr), None, 0)),
            Expr::Binary { left, right, .. }
            | Expr::Logical { left, right, .. }
            | Expr::In { left, right, .. } => {
                out.push(child(Node::Expr(left), None, 0));
                out.push(child(Node::Expr(right), None, 0));
            }
            Expr::Range { lo, hi, .. } => {
                if let Some(l) = lo {
                    out.push(child(Node::Expr(l), None, 0));
                }
                if let Some(h) = hi {
                    out.push(child(Node::Expr(h), None, 0));
                }
            }
        },
    }
    out
}

/// A where-position consumer test is the `OpNode` itself (`kind: "op"`).
fn where_node(w: &Where) -> Node<'_> {
    match w {
        Where::Op(op) => Node::Op(op),
        other => Node::Where(other),
    }
}

/// Walk a tree depth-first in canonical source order.
pub fn visit<'a, V: Visitor>(root: Node<'a>, visitor: &mut V) {
    let mut path: Vec<Node<'a>> = Vec::new();
    go(root, None, 0, &mut path, visitor);
}

fn go<'a, V: Visitor>(
    node: Node<'a>,
    clause: Option<Clause>,
    depth: usize,
    path: &mut Vec<Node<'a>>,
    visitor: &mut V,
) {
    let ctx = VisitContext {
        path: path.clone(),
        clause,
        depth,
    };
    if visitor.enter(node, &ctx) {
        path.push(node);
        for c in children(node) {
            go(c.node, c.clause.or(clause), depth + c.depth, path, visitor);
        }
        path.pop();
    }
    visitor.leave(node, &ctx);
}

/// The query's root as a [`Node`].
pub fn node(q: &Query) -> Node<'_> {
    Node::Query(q)
}

// ---- transform -----------------------------------------------------------------

/// Rebuild a query with every expression mapped through `f`, children first (so
/// `f` sees an expression whose operands are already mapped). Spans of nodes
/// `f` returns unchanged are preserved (they are the same values).
pub fn transform<F>(q: &Query, f: &mut F) -> Query
where
    F: FnMut(Expr, &VisitContext<'_>) -> Expr,
{
    let mut t = Transformer {
        f,
        path: Vec::new(),
    };
    t.path.push(Node::Query(q));
    let out = Query {
        select: t.items(&q.select, Clause::Select, 1),
        source: t.expr(&q.source, Clause::Source, 0),
        from: q.from.iter().map(|e| t.expr(e, Clause::From, 1)).collect(),
        r#where: q.r#where.as_ref().map(|w| t.r#where(w, Clause::Where, 1)),
        follow: q.follow.as_ref().map(|fl| t.follow(fl, 1)),
        order_by: q
            .order_by
            .as_ref()
            .map(|o| o.iter().map(|s| t.order(s, 1)).collect()),
        limit: q.limit.as_ref().map(|e| t.expr(e, Clause::Limit, 0)),
        offset: q.offset.as_ref().map(|e| t.expr(e, Clause::Offset, 0)),
        consumer: q.consumer,
        distinct: q.distinct,
        values: q.values,
        span: q.span,
    };
    t.path.pop();
    out
}

/// [`transform`] for a block body (evaluated at scope `depth`).
pub fn transform_subquery<F>(s: &Subquery, depth: usize, f: &mut F) -> Subquery
where
    F: FnMut(Expr, &VisitContext<'_>) -> Expr,
{
    let mut t = Transformer {
        f,
        path: Vec::new(),
    };
    t.subquery(s, depth, None)
}

struct Transformer<'a, 'f, F> {
    f: &'f mut F,
    path: Vec<Node<'a>>,
}

impl<'a, F> Transformer<'a, '_, F>
where
    F: FnMut(Expr, &VisitContext<'_>) -> Expr,
{
    fn ctx(&self, clause: Option<Clause>, depth: usize) -> VisitContext<'a> {
        VisitContext {
            path: self.path.clone(),
            clause,
            depth,
        }
    }

    fn items(&mut self, items: &'a [SelectItem], clause: Clause, depth: usize) -> Vec<SelectItem> {
        items
            .iter()
            .map(|it| self.item(it, clause, depth))
            .collect()
    }

    fn item(&mut self, it: &'a SelectItem, clause: Clause, depth: usize) -> SelectItem {
        self.path.push(Node::Select(it));
        let out = match it {
            SelectItem::Field {
                name,
                expr,
                lift,
                span,
            } => SelectItem::Field {
                name: name.clone(),
                expr: self.expr(expr, clause, depth),
                lift: *lift,
                span: *span,
            },
            SelectItem::Collect { name, op, span } => SelectItem::Collect {
                name: name.clone(),
                op: Box::new(self.op(op, clause, depth)),
                span: *span,
            },
        };
        self.path.pop();
        out
    }

    fn op(&mut self, op: &'a OpNode, clause: Clause, depth: usize) -> OpNode {
        self.path.push(Node::Op(op));
        let out = OpNode {
            receiver: self.expr(&op.receiver, clause, depth),
            op: op.op,
            sub: self.subquery(&op.sub, depth + 1, Some(clause)),
            count_cmp: op.count_cmp.clone(),
            distinct: op.distinct,
            span: op.span,
        };
        self.path.pop();
        out
    }

    fn subquery(&mut self, s: &'a Subquery, depth: usize, _outer: Option<Clause>) -> Subquery {
        self.path.push(Node::Subquery(s));
        let out = Subquery {
            select: self.items(&s.select, Clause::Select, depth),
            from: s
                .from
                .iter()
                .map(|e| self.expr(e, Clause::From, depth))
                .collect(),
            r#where: s
                .r#where
                .as_ref()
                .map(|w| self.r#where(w, Clause::Where, depth)),
            follow: s.follow.as_ref().map(|fl| self.follow(fl, depth)),
            order_by: s
                .order_by
                .as_ref()
                .map(|o| o.iter().map(|x| self.order(x, depth)).collect()),
            limit: s.limit.as_ref().map(|e| self.expr(e, Clause::Limit, depth)),
            offset: s
                .offset
                .as_ref()
                .map(|e| self.expr(e, Clause::Offset, depth)),
            values: s.values,
            span: s.span,
        };
        self.path.pop();
        out
    }

    fn follow(&mut self, f: &'a Follow, depth: usize) -> Follow {
        self.path.push(Node::Follow(f));
        let out = Follow {
            destinations: f
                .destinations
                .iter()
                .map(|d| match d {
                    FollowDestination::Relation(e) => {
                        FollowDestination::Relation(self.expr(e, Clause::FollowDestination, depth))
                    }
                    FollowDestination::Block(op) => FollowDestination::Block(Box::new(self.op(
                        op,
                        Clause::FollowDestination,
                        depth,
                    ))),
                })
                .collect(),
            distinct: f.distinct,
            r#where: f
                .r#where
                .as_ref()
                .map(|e| self.expr(e, Clause::FollowWhere, depth + 1)),
            frontier: f
                .frontier
                .as_ref()
                .map(|e| self.expr(e, Clause::FollowFrontier, depth)),
            depth: f.depth,
            by: f.by.as_ref().map(|e| self.expr(e, Clause::FollowBy, depth)),
            span: f.span,
        };
        self.path.pop();
        out
    }

    fn order(&mut self, o: &'a OrderSpec, depth: usize) -> OrderSpec {
        self.path.push(Node::Order(o));
        let out = OrderSpec {
            expr: self.expr(&o.expr, Clause::OrderBy, depth),
            desc: o.desc,
            span: o.span,
        };
        self.path.pop();
        out
    }

    fn r#where(&mut self, w: &'a Where, clause: Clause, depth: usize) -> Where {
        if let Where::Op(op) = w {
            return Where::Op(Box::new(self.op(op, clause, depth)));
        }
        self.path.push(Node::Where(w));
        let out = match w {
            Where::And { parts, span } => Where::And {
                parts: parts
                    .iter()
                    .map(|p| self.r#where(p, clause, depth))
                    .collect(),
                span: *span,
            },
            Where::Or { parts, span } => Where::Or {
                parts: parts
                    .iter()
                    .map(|p| self.r#where(p, clause, depth))
                    .collect(),
                span: *span,
            },
            Where::Not { expr, span } => Where::Not {
                expr: Box::new(self.r#where(expr, clause, depth)),
                span: *span,
            },
            Where::Scalar { expr, span } => Where::Scalar {
                expr: self.expr(expr, clause, depth),
                span: *span,
            },
            Where::Op(_) => unreachable!("handled above"),
        };
        self.path.pop();
        out
    }

    fn expr(&mut self, e: &'a Expr, clause: Clause, depth: usize) -> Expr {
        self.path.push(Node::Expr(e));
        let rebuilt = match e {
            Expr::Lit { .. } | Expr::Ident { .. } | Expr::Outer { .. } | Expr::Binding { .. } => {
                e.clone()
            }
            Expr::Member { recv, name, span } => Expr::Member {
                recv: Box::new(self.expr(recv, clause, depth)),
                name: name.clone(),
                span: *span,
            },
            Expr::Call {
                recv,
                name,
                args,
                span,
            } => Expr::Call {
                recv: recv
                    .as_deref()
                    .map(|r| Box::new(self.expr(r, clause, depth))),
                name: name.clone(),
                args: args.iter().map(|a| self.expr(a, clause, depth)).collect(),
                span: *span,
            },
            Expr::Unary { op, expr, span } => Expr::Unary {
                op: *op,
                expr: Box::new(self.expr(expr, clause, depth)),
                span: *span,
            },
            Expr::Binary {
                op,
                left,
                right,
                span,
            } => Expr::Binary {
                op: *op,
                left: Box::new(self.expr(left, clause, depth)),
                right: Box::new(self.expr(right, clause, depth)),
                span: *span,
            },
            Expr::Logical {
                op,
                left,
                right,
                span,
            } => Expr::Logical {
                op: *op,
                left: Box::new(self.expr(left, clause, depth)),
                right: Box::new(self.expr(right, clause, depth)),
                span: *span,
            },
            Expr::In { left, right, span } => Expr::In {
                left: Box::new(self.expr(left, clause, depth)),
                right: Box::new(self.expr(right, clause, depth)),
                span: *span,
            },
            Expr::Range {
                lo,
                hi,
                exclusive_end,
                span,
            } => Expr::Range {
                lo: lo.as_deref().map(|x| Box::new(self.expr(x, clause, depth))),
                hi: hi.as_deref().map(|x| Box::new(self.expr(x, clause, depth))),
                exclusive_end: *exclusive_end,
                span: *span,
            },
        };
        self.path.pop();
        let ctx = self.ctx(Some(clause), depth);
        (self.f)(rebuilt, &ctx)
    }
}

// ---- strip_spans ----------------------------------------------------------------

/// The tree with every span set to [`Span::EMPTY`], for shape comparisons (the
/// fixtures and the round-trip law compare stripped trees; a tree from
/// [`crate::build`] is already stripped).
pub fn strip_spans(q: &Query) -> Query {
    let mut q = transform(q, &mut |mut e, _| {
        *e.span_mut() = Span::EMPTY;
        e
    });
    strip_query_spans(&mut q);
    q
}

fn strip_query_spans(q: &mut Query) {
    q.span = Span::EMPTY;
    q.select.iter_mut().for_each(strip_item_spans);
    if let Some(w) = &mut q.r#where {
        strip_where_spans(w);
    }
    if let Some(f) = &mut q.follow {
        strip_follow_spans(f);
    }
    if let Some(o) = &mut q.order_by {
        o.iter_mut().for_each(|s| s.span = Span::EMPTY);
    }
}

fn strip_sub_spans(s: &mut Subquery) {
    s.span = Span::EMPTY;
    s.select.iter_mut().for_each(strip_item_spans);
    if let Some(w) = &mut s.r#where {
        strip_where_spans(w);
    }
    if let Some(f) = &mut s.follow {
        strip_follow_spans(f);
    }
    if let Some(o) = &mut s.order_by {
        o.iter_mut().for_each(|x| x.span = Span::EMPTY);
    }
}

fn strip_op_spans(op: &mut OpNode) {
    op.span = Span::EMPTY;
    strip_sub_spans(&mut op.sub);
}

fn strip_item_spans(it: &mut SelectItem) {
    match it {
        SelectItem::Field { span, .. } => *span = Span::EMPTY,
        SelectItem::Collect { op, span, .. } => {
            *span = Span::EMPTY;
            strip_op_spans(op);
        }
    }
}

fn strip_follow_spans(f: &mut Follow) {
    f.span = Span::EMPTY;
    for d in &mut f.destinations {
        if let FollowDestination::Block(op) = d {
            strip_op_spans(op);
        }
    }
}

fn strip_where_spans(w: &mut Where) {
    match w {
        Where::And { parts, span } | Where::Or { parts, span } => {
            *span = Span::EMPTY;
            parts.iter_mut().for_each(strip_where_spans);
        }
        Where::Not { expr, span } => {
            *span = Span::EMPTY;
            strip_where_spans(expr);
        }
        Where::Scalar { span, .. } => *span = Span::EMPTY,
        Where::Op(op) => strip_op_spans(op),
    }
}
