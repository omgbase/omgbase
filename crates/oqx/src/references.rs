//! The `references` static pass (`spec/oqx/AST.md` §5b, language 0.23; port
//! of `packages/oqx/src/references.ts`): every NAME a query reads from a row —
//! a bare identifier, a dotted navigation headed by one, an outer reference —
//! with the clause it stands in and the SCOPE whose rows it is read from,
//! described as the chain of expressions that produce those rows (the source,
//! each `from` re-projection, each block receiver, each `follow` walk). The
//! pass knows no data: a host that knows what rows an expression yields maps
//! each scope to a row type and judges the name against it (omgbase: "is
//! `target` a field of links?"). Built on [`visit`], so a future node kind is
//! walked here the day it is added to the walk's child table.
//!
//! What is a reference and what is not (the rules, pinned by
//! `cases/references.json`):
//!   • a bare `ident` is a reference to the current row's property, with the
//!     name as written; a `member` chain headed by an `ident` or `outer` is ONE
//!     reference whose name is the full dotted path (`doc.layer`, `meta.owner`);
//!     a chain headed by anything else (a call, a block, a literal, a tuple) is
//!     not — its head is walked and the trailing `.name`s are ignored, since the
//!     head's value is not a row of any scope;
//!   • an `outer` (`^name`, `N^name`) is a reference read in the scope `levels`
//!     out; `$it` as a head is the row itself (`$it.title` ≡ `title`,
//!     `^$it.title` ≡ `^title`) and `$it` alone is no reference;
//!   • `$`-names (`$key`, `$depth`, `$stop`, …) are the language's values, never
//!     references; a `binding` is a host value; a function or method NAME is
//!     not a reference, its receiver and arguments are walked
//!     (`target.contains("x")` references `target`); a name a nested block
//!     LIFTS onto a scope (`^open: value`, SEMANTICS §19) is a binding of that
//!     scope, so reading it there (`select open`, `^open` from deeper) is not a
//!     reference either — and neither is a name a `flatten` bound (0.25,
//!     SEMANTICS §25) in the clauses after it: a later `flatten`, `group by`,
//!     `having`, the select, `order by`, or `^name` from a block under them; in
//!     its own expression and before the clause (`where`, `frontier`, `follow`)
//!     the name is still the row's property;
//!   • a `select` alias is not a reference where the language resolves it
//!     (SEMANTICS §14; since 0.27 every clause that reads the body's rows):
//!     in the same body's `where`, `having`, `frontier`, a `follow` destination
//!     (and a destination block's receiver), `flatten`, a `group by` key —
//!     unless the key names the unaliased item (`city: city`), a row read —
//!     `order by`, and in the items to its right; a nested block's `^name` that
//!     reaches an enclosing body's alias likewise — a bare identifier naming
//!     such an alias, a chain headed by it, or that outer reference is skipped;
//!     an alias's own name inside its own item is the row field and IS a
//!     reference; `from`, `limit`/`offset` and the source are not rewritten
//!     against aliases, so a name there (or a `^name` from a block under them)
//!     is a reference whatever the `select` says;
//!   • a name read at the ROOT scope — the head of the top-level `source`
//!     (`from people`: clause `source`), an outer reference with as many carets
//!     as there are enclosing scopes (`^docs` from a top-level row) — is
//!     reported with depth 0 and no steps: it names one of the host's roots,
//!     and the host decides what to make of it;
//!   • a `follow` destination that is a plain expression is a reference read
//!     on the frontier row (clause `follow.destination`), like a `from`;
//!   • at a GROUP scope (0.24, SEMANTICS §24) — a select item, `having` or
//!     `order by` of a grouped body, outside an aggregate's argument — a bare
//!     key name (or a chain headed by it, or `^key` from a nested block) is the
//!     key, an alias of the expression already reported in clause `groupBy`,
//!     and `rows` is the language's value: neither is a reference. Inside an
//!     aggregate's argument both are row reads again.
//!
//! The scope: `{ depth, steps }`. `depth` is the scope depth the name is
//! evaluated at (`visit`'s depth; for an outer reference, that depth minus its
//! levels). `steps` are the expressions that produce the scope's rows, root
//! first, each with the depth of the rows it produces: the query's `source`
//! (depth 1), each `from` re-projection in turn (the same depth — a `from`
//! replaces the rows), a block's receiver (one deeper than where it is read),
//! then the block's own `from`s; a `follow` node is a step too — the walk's
//! frontier rows, at the body's depth, which the destinations are read on
//! (a destination block's receiver is then one deeper); since 0.24 a `groupBy`
//! node is a step for a name read at the group scope — the body's groups, at
//! the same depth (the rows replaced by one key record per group), and `rows`
//! as a receiver there is a step like any receiver. A name read inside the
//! k-th `from` sees only the steps before it. For an outer reference the steps
//! are cut after the last step at its scope's depth. The empty list is the root
//! scope.

use std::collections::{HashMap, HashSet};

use crate::ast::{
    Expr, Flatten, Follow, GroupBy, OpNode, OrderSpec, Query, SelectItem, Span, Subquery, Where,
};
use crate::walk::{Clause, Node, VisitContext, Visitor, visit};

/// The expression of one scope step: an expression (a source, a `from`, a
/// block receiver, a plain destination), a `follow` node (the walk's frontier
/// rows), or — since 0.24 — a `groupBy` node (the body's groups: the rows at
/// the same depth replaced by one key record per group).
#[derive(Clone, Copy, Debug)]
pub enum StepExpr<'a> {
    Expr(&'a Expr),
    Follow(&'a Follow),
    GroupBy(&'a GroupBy),
}

impl<'a> StepExpr<'a> {
    /// The step as a walk node (for [`crate::print::print`]).
    #[must_use]
    pub fn node(self) -> Node<'a> {
        match self {
            StepExpr::Expr(e) => Node::Expr(e),
            StepExpr::Follow(f) => Node::Follow(f),
            StepExpr::GroupBy(g) => Node::GroupBy(g),
        }
    }
}

/// One step of a scope's row chain, with the scope depth of the rows it
/// produces.
#[derive(Clone, Copy, Debug)]
pub struct ReferenceStep<'a> {
    pub expr: StepExpr<'a>,
    pub depth: usize,
}

#[derive(Clone, Debug)]
pub struct ReferenceScope<'a> {
    /// The scope depth the name is read at (SEMANTICS §2; 0 = the root scope).
    pub depth: usize,
    /// The row chain producing the scope's rows, root first.
    pub steps: Vec<ReferenceStep<'a>>,
}

#[derive(Clone, Debug)]
pub struct Reference<'a> {
    /// The name as written — the full dotted path for a navigation
    /// (`doc.layer`), without a `$it.` head.
    pub name: String,
    pub clause: Clause,
    pub scope: ReferenceScope<'a>,
    /// The span of the whole reference (the chain, for a navigation).
    pub span: Span,
}

/// The head of a dotted name: an `ident` or an `outer`.
enum Head<'a> {
    Ident(&'a str),
    Outer { levels: usize, name: &'a str },
}

/// A dotted name headed by an `ident` or `outer`: the head and the path after it.
fn dotted_name(e: &Expr) -> Option<(Head<'_>, Vec<&str>)> {
    match e {
        Expr::Ident { name, .. } => Some((Head::Ident(name), Vec::new())),
        Expr::Outer { levels, name, .. } => Some((
            Head::Outer {
                levels: *levels,
                name,
            },
            Vec::new(),
        )),
        Expr::Member { recv, name, .. } => {
            let (head, mut path) = dotted_name(recv)?;
            path.push(name);
            Some((head, path))
        }
        _ => None,
    }
}

/// The alias an item defines (SEMANTICS §14): a named `collect`, or a named
/// non-lift field.
fn alias_name(it: &SelectItem) -> Option<&str> {
    match it {
        SelectItem::Collect { name, .. } => (!name.is_empty()).then_some(name.as_str()),
        SelectItem::Field { name, lift, .. } => {
            (*lift == 0 && !name.is_empty()).then_some(name.as_str())
        }
    }
}

/// A block node wherever the walk shows it: an `op` (a `collect` item, a
/// destination block, a nested where-position test), an expression-position
/// op, or a body's own where-position test (`where nodes exists { … }`).
fn as_op<'a>(n: Node<'a>) -> Option<&'a OpNode> {
    match n {
        Node::Op(op) => Some(op),
        Node::Expr(Expr::Op(op)) | Node::Where(Where::Op(op)) => Some(op),
        _ => None,
    }
}

/// A body node (a `query` or `subquery`), by its address.
fn body_addr(n: Node<'_>) -> Option<usize> {
    match n {
        Node::Query(q) => Some(std::ptr::from_ref(q).addr()),
        Node::Subquery(s) => Some(std::ptr::from_ref(s).addr()),
        _ => None,
    }
}

fn same_expr(n: Node<'_>, e: &Expr) -> bool {
    matches!(n, Node::Expr(x) if std::ptr::eq(x, e))
}

/// Every name a query reads from a row, in canonical source order.
#[must_use]
pub fn references(root: &Query) -> Vec<Reference<'_>> {
    references_in(Node::Query(root))
}

/// [`references`] over a block body on its own (the body's rows are the root
/// scope's).
#[must_use]
pub fn references_in_subquery(root: &Subquery) -> Vec<Reference<'_>> {
    references_in(Node::Subquery(root))
}

fn references_in<'a>(root: Node<'a>) -> Vec<Reference<'a>> {
    struct Pass<'a> {
        out: Vec<Reference<'a>>,
        /// The names each body's nested blocks lift onto it, by the body's address.
        lifts: HashMap<usize, HashSet<String>>,
    }
    impl<'a> Visitor<'a> for Pass<'a> {
        fn enter(&mut self, node: Node<'a>, ctx: &VisitContext<'a>) -> bool {
            let Node::Expr(e) = node else { return true };
            let Some((head, path)) = dotted_name(e) else {
                return true;
            };
            // The head of a navigation is handled here, once, with the chain's full name.
            let (mut name, levels) = match head {
                Head::Ident(n) => (n, 0),
                Head::Outer { levels, name } => (name, levels),
            };
            let mut path = path.as_slice();
            if name == "$it" {
                let Some((first, rest)) = path.split_first() else {
                    return false; // the row itself
                };
                name = first;
                path = rest;
            } else if name.starts_with('$') {
                return false; // a language value
            }
            let Some(clause) = ctx.clause else {
                return false; // unreachable: the root node is never a name
            };
            if is_resolved_alias(name, levels, &ctx.path, clause) {
                return false;
            }
            // An outer reference past the root would be the language's own
            // error; the pass reports it at the root scope.
            let depth = ctx.depth.saturating_sub(levels);
            if self.is_lift_bound(name, depth, &ctx.path) {
                return false;
            }
            // A name a `flatten` bound (0.25) is an alias of the expression
            // already reported in clause `flatten`, read in the clauses after it.
            if is_flatten_bound(name, depth, &ctx.path, node) {
                return false;
            }
            // At a group scope (0.24) a bare key name is the key — an alias of
            // the expression reported in clause `groupBy` — and `rows` is the
            // language's value; neither reads a row.
            if is_group_value(name, depth, &ctx.path, node) {
                return false;
            }
            let full = std::iter::once(name)
                .chain(path.iter().copied())
                .collect::<Vec<_>>()
                .join(".");
            let steps = scope_steps(&ctx.path, node);
            let steps = if levels == 0 {
                steps
            } else {
                cut_at(steps, depth)
            };
            self.out.push(Reference {
                name: full,
                clause,
                scope: ReferenceScope { depth, steps },
                span: e.span(),
            });
            false
        }
    }
    impl Pass<'_> {
        /// Whether `name`, read at scope `depth`, is bound there by a lift
        /// (`^name: expr` in a nested block, SEMANTICS §19): the lifted value is
        /// appended to that scope's row record, so the name is a binding, not a
        /// row property. The body whose rows are at `depth` is the depth-th body
        /// on the path (every nested body is one scope deeper than the one
        /// around it).
        fn is_lift_bound(&mut self, name: &str, depth: usize, path: &[Node<'_>]) -> bool {
            if depth < 1 {
                return false;
            }
            let Some(body) = path
                .iter()
                .copied()
                .filter(|n| body_addr(*n).is_some())
                .nth(depth - 1)
            else {
                return false;
            };
            let key = body_addr(body).expect("a body");
            let names = self
                .lifts
                .entry(key)
                .or_insert_with(|| lifts_landing_on(body));
            names.contains(name)
        }
    }

    let mut pass = Pass {
        out: Vec::new(),
        lifts: HashMap::new(),
    };
    visit(root, &mut pass);
    pass.out
}

/// Whether `name`, read `levels` scopes out from this position, is a `select`
/// alias the language substitutes (SEMANTICS §14, 0.27) — so the name is the
/// alias, not a row property. A body's aliases are visible to every clause that
/// reads its rows (`where`, `having`, `frontier`, a `follow` destination and a
/// destination block's receiver, `flatten`, a `group by` key, `order by`) and to
/// the items after the one that defines them; a nested block reads them through
/// `^name` (`levels` carets reach `levels` bodies out). Not visible in `from`,
/// the bounds or the source. Inside a select item, only the items to its LEFT.
fn is_resolved_alias(name: &str, levels: usize, path: &[Node<'_>], clause: Clause) -> bool {
    if name.starts_with('$') {
        return false;
    }
    if matches!(
        clause,
        Clause::From | Clause::Source | Clause::Limit | Clause::Offset
    ) {
        return false;
    }
    // The bodies on the path, innermost first, with the child of each that the
    // position sits under (an item of its select, or a clause).
    let mut bodies: Vec<(Node<'_>, Option<Node<'_>>)> = Vec::new();
    for i in (0..path.len()).rev() {
        if body_addr(path[i]).is_some() {
            bodies.push((path[i], path.get(i + 1).copied()));
        }
    }
    let Some(&(body, child)) = bodies.get(levels) else {
        return false;
    };
    let Some(body) = AliasBody::of(body) else {
        return false;
    };
    let select = body.select;
    let mut index: HashMap<&str, usize> = HashMap::new();
    for (j, it) in select.iter().enumerate() {
        if let Some(n) = alias_name(it) {
            index.insert(n, j);
        }
    }
    let Some(&j) = index.get(name) else {
        return false;
    };
    // A `group by` key that is a bare alias name takes the alias's expression —
    // unless the alias is the row field itself (`city: city`, the unaliased
    // item), where the key stays the row read it was written as.
    if clause == Clause::GroupBy
        && levels == 0
        && matches!(child, Some(Node::GroupBy(_)))
        && let SelectItem::Field {
            expr: Expr::Ident { name: n, .. },
            ..
        } = &select[j]
        && n == name
    {
        return false;
    }
    // Under one of the body's own select items (directly, or through nested
    // blocks): only the items to its left — and an item's own name is the row field.
    if let Some(Node::Select(item)) = child
        && let Some(at) = select.iter().position(|x| std::ptr::eq(x, item))
    {
        return j < at;
    }
    // A nested block hanging off `from`, a bound or the source is not read on the rows.
    if levels > 0
        && let Some(child) = child
    {
        let under = |e: Option<&Expr>| e.is_some_and(|e| same_expr(child, e));
        if body.from.iter().any(|f| same_expr(child, f))
            || under(body.limit)
            || under(body.offset)
            || under(body.source)
        {
            return false;
        }
    }
    true
}

/// The clauses of a body `is_resolved_alias` reads: its select, and the clauses
/// never rewritten against it (`from`, the bounds, a query's source).
struct AliasBody<'a> {
    select: &'a [SelectItem],
    from: &'a [Expr],
    limit: Option<&'a Expr>,
    offset: Option<&'a Expr>,
    source: Option<&'a Expr>,
}

impl<'a> AliasBody<'a> {
    fn of(body: Node<'a>) -> Option<Self> {
        match body {
            Node::Query(q) => Some(AliasBody {
                select: &q.select,
                from: &q.from,
                limit: q.limit.as_ref(),
                offset: q.offset.as_ref(),
                source: Some(&q.source),
            }),
            Node::Subquery(s) => Some(AliasBody {
                select: &s.select,
                from: &s.from,
                limit: s.limit.as_ref(),
                offset: s.offset.as_ref(),
                source: None,
            }),
            _ => None,
        }
    }
}

/// The names the nested blocks of `body` lift onto it: a `field` item with
/// `lift` L in a block L scopes below it.
fn lifts_landing_on(body: Node<'_>) -> HashSet<String> {
    struct Lifts {
        own: usize,
        names: HashSet<String>,
    }
    impl Visitor<'_> for Lifts {
        fn enter(&mut self, node: Node<'_>, ctx: &VisitContext<'_>) -> bool {
            if let Node::Select(SelectItem::Field { name, lift, .. }) = node
                && *lift != 0
            {
                let below = ctx
                    .path
                    .iter()
                    .filter(|a| matches!(a, Node::Subquery(_)))
                    .count()
                    - self.own;
                if *lift == below {
                    self.names.insert(name.clone());
                }
            }
            true
        }
    }
    let mut l = Lifts {
        own: usize::from(matches!(body, Node::Subquery(_))),
        names: HashSet::new(),
    };
    visit(body, &mut l);
    l.names
}

/// Whether `name`, read at scope `depth`, is bound there by a `flatten` of the
/// body whose rows are at `depth` (SEMANTICS §25) — the position lies in a
/// clause evaluated after that flatten: a later `flatten`, `group by`, `having`,
/// the select, or `order by` (`where`, `frontier`, `follow` and the body's
/// sources run before any flatten, and a flatten's own expression before itself).
fn is_flatten_bound(name: &str, depth: usize, path: &[Node<'_>], node: Node<'_>) -> bool {
    let Some(i) = body_index_at(path, depth) else {
        return false;
    };
    let Some(body) = PostFlatten::of(path[i]) else {
        return false;
    };
    if body.flatten.is_empty() {
        return false;
    }
    let child = path.get(i + 1).copied().unwrap_or(node);
    let upto = if body.is_post(child) {
        body.flatten.len()
    } else {
        let Node::Flatten(f) = child else {
            return false;
        };
        match body.flatten.iter().position(|x| std::ptr::eq(x, f)) {
            Some(k) => k,
            None => return false,
        }
    };
    body.flatten[..upto].iter().any(|f| f.name == name)
}

/// The clauses of a body a `flatten` binding is visible to (SEMANTICS §25):
/// the flattens themselves and the clauses evaluated after them.
struct PostFlatten<'a> {
    flatten: &'a [Flatten],
    select: &'a [SelectItem],
    group_by: Option<&'a GroupBy>,
    having: Option<&'a Where>,
    order_by: Option<&'a [OrderSpec]>,
}

impl<'a> PostFlatten<'a> {
    fn of(body: Node<'a>) -> Option<Self> {
        match body {
            Node::Query(q) => Some(PostFlatten {
                flatten: &q.flatten,
                select: &q.select,
                group_by: q.group_by.as_ref(),
                having: q.having.as_ref(),
                order_by: q.order_by.as_deref(),
            }),
            Node::Subquery(s) => Some(PostFlatten {
                flatten: &s.flatten,
                select: &s.select,
                group_by: s.group_by.as_ref(),
                having: s.having.as_ref(),
                order_by: s.order_by.as_deref(),
            }),
            _ => None,
        }
    }

    /// Whether `child` (a direct child of the body) is a clause evaluated
    /// after every flatten: a select item, the `group by`, `having`, an
    /// `order by` term.
    fn is_post(&self, child: Node<'_>) -> bool {
        match child {
            Node::Select(it) => self.select.iter().any(|x| std::ptr::eq(x, it)),
            Node::GroupBy(g) => self.group_by.is_some_and(|x| std::ptr::eq(x, g)),
            // `having` is visited as its where tree (an op test as the op itself).
            Node::Where(w) => self.having.is_some_and(|h| std::ptr::eq(h, w)),
            Node::Op(op) => self
                .having
                .is_some_and(|h| matches!(h, Where::Op(b) if std::ptr::eq(&**b, op))),
            Node::Order(o) => self
                .order_by
                .is_some_and(|os| os.iter().any(|x| std::ptr::eq(x, o))),
            _ => false,
        }
    }
}

/// Whether `name`, read at scope `depth`, is a value of a GROUP scope there
/// (SEMANTICS §24): the body whose rows are at `depth` has a `group by`, the
/// position is one of its post-group clauses — a select item, `having`, `order
/// by` — not inside an aggregate's argument (which reads the group's rows), and
/// the name is a key or `rows`.
fn is_group_value(name: &str, depth: usize, path: &[Node<'_>], node: Node<'_>) -> bool {
    let Some(i) = body_index_at(path, depth) else {
        return false;
    };
    let body = path[i];
    if !at_group_scope(body, path, i, node) {
        return false;
    }
    let keys = match body {
        Node::Query(q) => q.group_by.as_ref(),
        Node::Subquery(s) => s.group_by.as_ref(),
        _ => None,
    };
    name == "rows" || keys.is_some_and(|g| g.keys.iter().any(|k| k.name == name))
}

/// The index in `path` of the body whose rows are at scope `depth` (every
/// nested body is one scope deeper), or `None`.
fn body_index_at(path: &[Node<'_>], depth: usize) -> Option<usize> {
    if depth < 1 {
        return None;
    }
    path.iter()
        .enumerate()
        .filter(|(_, n)| body_addr(**n).is_some())
        .map(|(i, _)| i)
        .nth(depth - 1)
}

/// Whether a position under `body` (at `path[i]`) reads the body's GROUP scope:
/// the body is grouped, the position lies in a select item, `having` or `order
/// by`, and no aggregate stands between the body and the position (an
/// aggregate's argument reads the group's rows; a nested body is its own scope
/// and ends the search).
fn at_group_scope(body: Node<'_>, path: &[Node<'_>], i: usize, node: Node<'_>) -> bool {
    let (group_by, select, having, order_by) = match body {
        Node::Query(q) => (
            q.group_by.as_ref(),
            &q.select,
            q.having.as_ref(),
            q.order_by.as_deref(),
        ),
        Node::Subquery(s) => (
            s.group_by.as_ref(),
            &s.select,
            s.having.as_ref(),
            s.order_by.as_deref(),
        ),
        _ => return false,
    };
    if group_by.is_none() {
        return false;
    }
    let child = path.get(i + 1).copied().unwrap_or(node);
    let post = match child {
        Node::Select(it) => select.iter().any(|x| std::ptr::eq(x, it)),
        Node::Order(o) => order_by.is_some_and(|os| os.iter().any(|x| std::ptr::eq(x, o))),
        // `having` is visited as its where tree (an op test as the op itself).
        Node::Where(w) => having.is_some_and(|h| std::ptr::eq(h, w)),
        Node::Op(op) => having.is_some_and(|h| matches!(h, Where::Op(b) if std::ptr::eq(&**b, op))),
        _ => false,
    };
    if !post {
        return false;
    }
    for a in &path[i + 1..] {
        match a {
            Node::Query(_) | Node::Subquery(_) => break,
            Node::Expr(Expr::Aggregate { .. }) => return false,
            _ => {}
        }
    }
    true
}

/// The row chain of the scope a node is evaluated in, from its ancestors.
fn scope_steps<'a>(path: &[Node<'a>], node: Node<'a>) -> Vec<ReferenceStep<'a>> {
    let mut steps = Vec::new();
    let mut depth = 0usize;
    for (i, a) in path.iter().enumerate() {
        let next = path.get(i + 1).copied().unwrap_or(node);
        match *a {
            Node::Query(q) => {
                let root_read = same_expr(next, &q.source)
                    || q.limit.as_ref().is_some_and(|l| same_expr(next, l))
                    || q.offset.as_ref().is_some_and(|o| same_expr(next, o));
                if root_read {
                    continue; // read at the root scope
                }
                depth = 1;
                steps.push(ReferenceStep {
                    expr: StepExpr::Expr(&q.source),
                    depth,
                });
                push_froms(&mut steps, &q.from, next, depth);
                // A grouped body's post-group clauses read its groups (0.24):
                // the rows at this depth replaced by one key record per group.
                if let Some(g) = &q.group_by
                    && at_group_scope(*a, path, i, node)
                {
                    steps.push(ReferenceStep {
                        expr: StepExpr::GroupBy(g),
                        depth,
                    });
                }
            }
            Node::Subquery(s) => {
                // The receiver step was pushed by the enclosing `op`; this
                // body's rows are one deeper than where that receiver was read.
                push_froms(&mut steps, &s.from, next, depth);
                if let Some(g) = &s.group_by
                    && at_group_scope(*a, path, i, node)
                {
                    steps.push(ReferenceStep {
                        expr: StepExpr::GroupBy(g),
                        depth,
                    });
                }
            }
            Node::Follow(f) => {
                // The destinations are read on the walk's frontier rows, at the body's depth.
                steps.push(ReferenceStep {
                    expr: StepExpr::Follow(f),
                    depth,
                });
            }
            other => {
                if let Some(op) = as_op(other) {
                    // Inside the receiver: read where the block is read.
                    if !matches!(next, Node::Subquery(s) if std::ptr::eq(s, &op.sub)) {
                        continue;
                    }
                    depth += 1;
                    steps.push(ReferenceStep {
                        expr: StepExpr::Expr(&op.receiver),
                        depth,
                    });
                }
            }
        }
    }
    steps
}

/// The `from` re-projections that apply at `next`: all of them unless `next`
/// is one of them, in which case those before it.
fn push_froms<'a>(
    steps: &mut Vec<ReferenceStep<'a>>,
    from: &'a [Expr],
    next: Node<'a>,
    depth: usize,
) {
    let upto = from
        .iter()
        .position(|f| same_expr(next, f))
        .unwrap_or(from.len());
    for f in &from[..upto] {
        steps.push(ReferenceStep {
            expr: StepExpr::Expr(f),
            depth,
        });
    }
}

/// The steps up to and including the last one producing rows at `depth`
/// (none for the root scope).
fn cut_at<'a>(mut steps: Vec<ReferenceStep<'a>>, depth: usize) -> Vec<ReferenceStep<'a>> {
    let end = steps
        .iter()
        .rposition(|s| s.depth == depth)
        .map_or(0, |i| i + 1);
    steps.truncate(end);
    steps
}
