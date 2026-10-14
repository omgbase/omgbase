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
//!     reference either;
//!   • a `select` alias is not a reference where the language resolves it
//!     (SEMANTICS §14): in the same body's `where`, and in the items to its
//!     right — a bare identifier naming such an alias, or a chain headed by it,
//!     is skipped; an alias's own name inside its own item is the row field and
//!     IS a reference; `order by`, `frontier`, `limit`/`offset`, `from` and
//!     `follow` are not rewritten against aliases, so a name there is a
//!     reference whatever the `select` says;
//!   • a name read at the ROOT scope — the head of the top-level `source`
//!     (`from people`: clause `source`), an outer reference with as many carets
//!     as there are enclosing scopes (`^docs` from a top-level row) — is
//!     reported with depth 0 and no steps: it names one of the host's roots,
//!     and the host decides what to make of it;
//!   • a `follow` destination that is a plain expression is a reference read
//!     on the frontier row (clause `follow.destination`), like a `from`.
//!
//! The scope: `{ depth, steps }`. `depth` is the scope depth the name is
//! evaluated at (`visit`'s depth; for an outer reference, that depth minus its
//! levels). `steps` are the expressions that produce the scope's rows, root
//! first, each with the depth of the rows it produces: the query's `source`
//! (depth 1), each `from` re-projection in turn (the same depth — a `from`
//! replaces the rows), a block's receiver (one deeper than where it is read),
//! then the block's own `from`s; a `follow` node is a step too — the walk's
//! frontier rows, at the body's depth, which the destinations are read on
//! (a destination block's receiver is then one deeper). A name read inside the
//! k-th `from` sees only the steps before it. For an outer reference the steps
//! are cut after the last step at its scope's depth. The empty list is the root
//! scope.

use std::collections::{HashMap, HashSet};

use crate::ast::{Expr, Follow, OpNode, Query, SelectItem, Span, Subquery, Where};
use crate::walk::{Clause, Node, VisitContext, Visitor, visit};

/// The expression of one scope step: an expression (a source, a `from`, a
/// block receiver, a plain destination) or a `follow` node (the walk's
/// frontier rows).
#[derive(Clone, Copy, Debug)]
pub enum StepExpr<'a> {
    Expr(&'a Expr),
    Follow(&'a Follow),
}

impl<'a> StepExpr<'a> {
    /// The step as a walk node (for [`crate::print::print`]).
    #[must_use]
    pub fn node(self) -> Node<'a> {
        match self {
            StepExpr::Expr(e) => Node::Expr(e),
            StepExpr::Follow(f) => Node::Follow(f),
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
            let (mut name, levels, is_ident) = match head {
                Head::Ident(n) => (n, 0, true),
                Head::Outer { levels, name } => (name, levels, false),
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
            if is_ident && is_resolved_alias(name, &ctx.path, clause) {
                return false;
            }
            // An outer reference past the root would be the language's own
            // error; the pass reports it at the root scope.
            let depth = ctx.depth.saturating_sub(levels);
            if self.is_lift_bound(name, depth, &ctx.path) {
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

/// Whether a bare `name` in this position is a `select` alias the language
/// substitutes (so the name is the alias, not a row property): in the body's
/// `where`, any alias; in a `select` item, an alias defined to its LEFT.
fn is_resolved_alias(name: &str, path: &[Node<'_>], clause: Clause) -> bool {
    if clause != Clause::Where && clause != Clause::Select {
        return false;
    }
    // The nearest body, and the item under it when we are inside its select.
    for i in (0..path.len()).rev() {
        let select: &[SelectItem] = match path[i] {
            Node::Query(q) => &q.select,
            Node::Subquery(s) => &s.select,
            _ => continue,
        };
        let mut index: HashMap<&str, usize> = HashMap::new();
        for (j, it) in select.iter().enumerate() {
            if let Some(n) = alias_name(it) {
                index.insert(n, j);
            }
        }
        let Some(&j) = index.get(name) else {
            return false;
        };
        if clause == Clause::Where {
            return true;
        }
        let at = match path.get(i + 1) {
            Some(Node::Select(item)) => select.iter().position(|x| std::ptr::eq(x, *item)),
            _ => None,
        };
        return at.is_some_and(|at| j < at);
    }
    false
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
            }
            Node::Subquery(s) => {
                // The receiver step was pushed by the enclosing `op`; this
                // body's rows are one deeper than where that receiver was read.
                push_froms(&mut steps, &s.from, next, depth);
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
