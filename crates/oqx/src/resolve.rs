//! Select-alias resolution (SEMANTICS §14; port of `packages/oqx/src/resolve.ts`).
//! `where` may reference the same body's `select` aliases, and since 0.17 a
//! `select` item may reference the items to its left; the parser keeps the
//! surface form (so the tree can be printed back and reflected on) and only
//! VALIDATES the references, and this module performs the substitution — a
//! pure rewrite the entry points ([`crate::run_query`], [`crate::execute`])
//! apply once before evaluation, so the engine and any pushdown planner see an
//! ordinary `where` and `select` over row fields. Rules:
//!   • an alias shadows a same-named row field inside `where` and in the items
//!     after it;
//!   • an alias's own name inside its own expression is the row field
//!     (`name: name.upper()` is not recursive), but a chain of aliases that
//!     comes back to one being resolved (`a: b, b: a`) is a cycle → error;
//!   • a `select` item may name only the items to its LEFT; a reference to an
//!     item to its right is an error (a cycle when that item refers back);
//!   • an alias whose value is a `collect`/`first`/`single { … }` block may
//!     stand alone as a where leaf (a collection in predicate position means
//!     non-empty) but not appear inside a `where` expression; in a later
//!     `select` item it inlines as a value-position directive (`boss.name`);
//!   • nested blocks (consumer bodies, follow blocks, bracket lookups) are their
//!     own scopes and are not rewritten against this body's select — each body
//!     rewrites against its own.
//!
//! Resolution is NOT idempotent (`name: name.upper() … where name` resolves to
//! `name.upper()`, whose `name` would be substituted again), so it must run
//! exactly once: the entry points do it, `Engine::run` evaluates the query as
//! given.

use std::collections::HashMap;

use crate::ast::{
    Expr, Follow, FollowDestination, OpNode, OrderSpec, Query, SelectItem, Subquery, Where,
};
use crate::errors::{OqxError, Result};

/// Resolve every `where` and `select` of a query (its own and every nested
/// block's) against the `select` of the same body. Pure. Fails (stage `parse`)
/// for an alias cycle, a forward reference, or a block alias used inside a
/// `where` expression — the same conditions the parser rejects, so a parsed
/// query never fails here.
pub fn resolve_aliases(q: &Query) -> Result<Query> {
    // `where` is validated and substituted against the raw select first: its
    // cycle report follows the where's own path (`c → a → b → c`), as pinned.
    let r#where = match &q.r#where {
        None => None,
        Some(w) => Some(resolve_nested_where(
            resolve_where(&q.select, w.clone()).map_err(OqxError::parse)?,
        )?),
    };
    Ok(Query {
        source: resolve_expr(&q.source)?,
        from: q.from.iter().map(resolve_expr).collect::<Result<_>>()?,
        r#where,
        select: resolve_select(&q.select).map_err(OqxError::parse)?,
        order_by: resolve_order(q.order_by.as_deref())?,
        consumer: q.consumer,
        follow: q.follow.as_ref().map(resolve_follow).transpose()?,
        distinct: q.distinct,
        values: q.values,
        limit: q.limit.as_ref().map(resolve_expr).transpose()?,
        offset: q.offset.as_ref().map(resolve_expr).transpose()?,
        span: q.span,
    })
}

/// [`resolve_aliases`] for a block body.
pub fn resolve_subquery(s: &Subquery) -> Result<Subquery> {
    let r#where = match &s.r#where {
        None => None,
        Some(w) => Some(resolve_nested_where(
            resolve_where(&s.select, w.clone()).map_err(OqxError::parse)?,
        )?),
    };
    Ok(Subquery {
        from: s.from.iter().map(resolve_expr).collect::<Result<_>>()?,
        r#where,
        select: resolve_select(&s.select).map_err(OqxError::parse)?,
        order_by: resolve_order(s.order_by.as_deref())?,
        follow: s.follow.as_ref().map(resolve_follow).transpose()?,
        values: s.values,
        limit: s.limit.as_ref().map(resolve_expr).transpose()?,
        offset: s.offset.as_ref().map(resolve_expr).transpose()?,
        span: s.span,
    })
}

fn resolve_order(o: Option<&[OrderSpec]>) -> Result<Option<Vec<OrderSpec>>> {
    o.map(|specs| {
        specs
            .iter()
            .map(|s| {
                Ok(OrderSpec {
                    expr: resolve_expr(&s.expr)?,
                    desc: s.desc,
                    span: s.span,
                })
            })
            .collect::<Result<Vec<_>>>()
    })
    .transpose()
}

fn resolve_op(op: &OpNode) -> Result<OpNode> {
    Ok(OpNode {
        receiver: resolve_expr(&op.receiver)?,
        op: op.op,
        sub: resolve_subquery(&op.sub)?,
        count_cmp: op.count_cmp.clone(),
        distinct: op.distinct,
        span: op.span,
    })
}

fn resolve_follow(f: &Follow) -> Result<Follow> {
    Ok(Follow {
        destinations: f
            .destinations
            .iter()
            .map(|d| match d {
                FollowDestination::Block(op) => {
                    Ok(FollowDestination::Block(Box::new(resolve_op(op)?)))
                }
                FollowDestination::Relation(e) => Ok(FollowDestination::Relation(resolve_expr(e)?)),
            })
            .collect::<Result<_>>()?,
        distinct: f.distinct,
        r#where: f.r#where.as_ref().map(resolve_expr).transpose()?,
        frontier: f.frontier.as_ref().map(resolve_expr).transpose()?,
        depth: f.depth,
        by: f.by.as_ref().map(resolve_expr).transpose()?,
        span: f.span,
    })
}

// Nested blocks inside a where tree are their own scopes: resolve each against
// its own select (a scalar leaf may hold a value-position directive).
fn resolve_nested_where(w: Where) -> Result<Where> {
    Ok(match w {
        Where::And { parts, span } => Where::And {
            parts: parts
                .into_iter()
                .map(resolve_nested_where)
                .collect::<Result<_>>()?,
            span,
        },
        Where::Or { parts, span } => Where::Or {
            parts: parts
                .into_iter()
                .map(resolve_nested_where)
                .collect::<Result<_>>()?,
            span,
        },
        Where::Not { expr, span } => Where::Not {
            expr: Box::new(resolve_nested_where(*expr)?),
            span,
        },
        Where::Scalar { expr, span } => Where::Scalar {
            expr: resolve_expr(&expr)?,
            span,
        },
        Where::Op(op) => Where::Op(Box::new(resolve_op(&op)?)),
    })
}

/// The nested blocks (value-position directives) inside an expression, each
/// resolved against its own select; the expression's own idents are left alone.
fn resolve_expr(e: &Expr) -> Result<Expr> {
    map_expr(e.clone(), &mut |x| match x {
        Expr::Op(op) => Some(resolve_op(&op).map(|op| Expr::Op(Box::new(op)))),
        _ => None,
    })
}

/// Rebuild `e` top-down, letting `f` replace a node (`None` keeps it and
/// descends; a replaced node's children are not visited — `f` owns them).
fn map_expr<F>(e: Expr, f: &mut F) -> Result<Expr>
where
    F: FnMut(Expr) -> Option<Result<Expr>>,
{
    // `f` takes the node by value; give it a clone to inspect and keep ours when
    // it declines (the common case keeps allocations to the replaced nodes).
    if let Some(hit) = f(e.clone()) {
        return hit;
    }
    let mut go = |x: Box<Expr>| -> Result<Box<Expr>> { map_expr(*x, f).map(Box::new) };
    Ok(match e {
        Expr::Member { recv, name, span } => Expr::Member {
            recv: go(recv)?,
            name,
            span,
        },
        Expr::Call {
            recv,
            name,
            args,
            span,
        } => {
            let recv = match recv {
                Some(r) => Some(go(r)?),
                None => None,
            };
            let mut mapped = Vec::with_capacity(args.len());
            for a in args {
                mapped.push(*go(Box::new(a))?);
            }
            Expr::Call {
                recv,
                name,
                args: mapped,
                span,
            }
        }
        Expr::Unary { op, expr, span } => Expr::Unary {
            op,
            expr: go(expr)?,
            span,
        },
        Expr::Required { expr, span } => Expr::Required {
            expr: go(expr)?,
            span,
        },
        Expr::Binary {
            op,
            left,
            right,
            span,
        } => Expr::Binary {
            op,
            left: go(left)?,
            right: go(right)?,
            span,
        },
        Expr::Logical {
            op,
            left,
            right,
            span,
        } => Expr::Logical {
            op,
            left: go(left)?,
            right: go(right)?,
            span,
        },
        Expr::In { left, right, span } => Expr::In {
            left: go(left)?,
            right: go(right)?,
            span,
        },
        Expr::Range {
            lo,
            hi,
            exclusive_end,
            span,
        } => Expr::Range {
            lo: match lo {
                Some(b) => Some(go(b)?),
                None => None,
            },
            hi: match hi {
                Some(b) => Some(go(b)?),
                None => None,
            },
            exclusive_end,
            span,
        },
        // The receiver is read in this scope; the block is its own scope.
        Expr::Op(mut op) => {
            op.receiver = *go(Box::new(op.receiver))?;
            Expr::Op(op)
        }
        other @ (Expr::Lit { .. }
        | Expr::Ident { .. }
        | Expr::Binding { .. }
        | Expr::Outer { .. }) => other,
    })
}

// An item other items may name: a `collect` item, or a named non-lift field.
fn alias_name(it: &SelectItem) -> Option<&str> {
    match it {
        SelectItem::Collect { name, .. } if !name.is_empty() => Some(name),
        SelectItem::Field { name, lift: 0, .. } if !name.is_empty() => Some(name),
        _ => None,
    }
}

// The alias names an item's own expression (the receiver, for a block) mentions
// as bare identifiers, excluding its own name (the row field).
fn alias_refs(it: &SelectItem, index: &HashMap<&str, usize>) -> Vec<String> {
    let own = alias_name(it);
    let mut out: Vec<String> = Vec::new();
    fn visit(e: &Expr, own: Option<&str>, index: &HashMap<&str, usize>, out: &mut Vec<String>) {
        match e {
            Expr::Ident { name, .. } => {
                if Some(name.as_str()) != own
                    && index.contains_key(name.as_str())
                    && !out.iter().any(|n| n == name)
                {
                    out.push(name.clone());
                }
            }
            Expr::Lit { .. } | Expr::Outer { .. } | Expr::Binding { .. } => {}
            Expr::Member { recv, .. } => visit(recv, own, index, out),
            Expr::Call { recv, args, .. } => {
                if let Some(r) = recv {
                    visit(r, own, index, out);
                }
                args.iter().for_each(|a| visit(a, own, index, out));
            }
            Expr::Unary { expr, .. } | Expr::Required { expr, .. } => visit(expr, own, index, out),
            Expr::Binary { left, right, .. }
            | Expr::Logical { left, right, .. }
            | Expr::In { left, right, .. } => {
                visit(left, own, index, out);
                visit(right, own, index, out);
            }
            Expr::Range { lo, hi, .. } => {
                for b in [lo, hi].into_iter().flatten() {
                    visit(b, own, index, out);
                }
            }
            Expr::Op(op) => visit(&op.receiver, own, index, out),
        }
    }
    match it {
        SelectItem::Collect { op, .. } => visit(&op.receiver, own, index, &mut out),
        SelectItem::Field { expr, .. } => visit(expr, own, index, &mut out),
    }
    out
}

// The alias path from item `from` back to the alias `to`, if the raw reference
// graph has one (`[b, a]` for `a: b, b: a` from `b` back to `a`).
fn cycle_path(
    select: &[SelectItem],
    index: &HashMap<&str, usize>,
    from: usize,
    to: &str,
) -> Option<Vec<String>> {
    fn go(
        select: &[SelectItem],
        index: &HashMap<&str, usize>,
        i: usize,
        to: &str,
        seen: &mut Vec<usize>,
        path: Vec<String>,
    ) -> Option<Vec<String>> {
        if seen.contains(&i) {
            return None;
        }
        seen.push(i);
        let it = &select[i];
        let name = alias_name(it)
            .expect("indexed items are aliasable")
            .to_string();
        for r in alias_refs(it, index) {
            let mut next = path.clone();
            next.push(name.clone());
            if r == to {
                next.push(to.to_string());
                return Some(next);
            }
            if let Some(hit) = go(select, index, index[r.as_str()], to, seen, next) {
                return Some(hit);
            }
        }
        None
    }
    go(select, index, from, to, &mut Vec::new(), Vec::new())
}

/// Resolve one body's `select` items left to right (this body only; each
/// item's nested blocks are resolved against their own select). An item's bare
/// identifier that names an item to its left is replaced by that item's
/// resolved value — a block alias inlines as a value-position directive — and
/// the item's own name is the row field. A reference to an item to its right
/// fails: as a cycle when that item refers back, else as a forward reference.
/// The error is the bare message; the parser adds its offset,
/// [`resolve_aliases`] wraps it as a parse error.
pub fn resolve_select(select: &[SelectItem]) -> std::result::Result<Vec<SelectItem>, String> {
    let mut index: HashMap<&str, usize> = HashMap::new();
    for (i, it) in select.iter().enumerate() {
        if let Some(n) = alias_name(it) {
            index.insert(n, i);
        }
    }
    let wrap = |r: Result<Expr>| r.map_err(|e| e.message);
    let mut resolved: HashMap<String, Expr> = HashMap::new();
    let mut out = Vec::with_capacity(select.len());
    for (i, it) in select.iter().enumerate() {
        let own = alias_name(it);
        let mut failure: Option<String> = None;
        let mut subst = |e: Expr| -> Option<Result<Expr>> {
            let Expr::Ident { name, .. } = &e else {
                return None;
            };
            if Some(name.as_str()) == own {
                return Some(Ok(e));
            }
            if let Some(r) = resolved.get(name.as_str()) {
                return Some(Ok(r.clone()));
            }
            let j = *index.get(name.as_str())?;
            if j <= i {
                return None;
            }
            let msg = match own.and_then(|o| cycle_path(select, &index, j, o)) {
                Some(back) => format!(
                    "select aliases form a cycle: {} — an alias cannot depend on itself",
                    std::iter::once(own.expect("a cycle has an owner").to_string())
                        .chain(back)
                        .collect::<Vec<_>>()
                        .join(" → ")
                ),
                None => format!(
                    "select alias '{name}' is used before it is defined — a select item may reference only the items to its left"
                ),
            };
            failure.get_or_insert(msg);
            Some(Ok(e))
        };
        let item = match it {
            SelectItem::Collect { name, op, span } => {
                let receiver = map_expr(op.receiver.clone(), &mut subst).map_err(|e| e.message)?;
                if let Some(msg) = failure {
                    return Err(msg);
                }
                let op = resolve_op(&OpNode {
                    receiver,
                    op: op.op,
                    sub: op.sub.clone(),
                    count_cmp: op.count_cmp.clone(),
                    distinct: op.distinct,
                    span: op.span,
                })
                .map_err(|e| e.message)?;
                if let Some(o) = own {
                    resolved.insert(o.to_string(), Expr::Op(Box::new(op.clone())));
                }
                SelectItem::Collect {
                    name: name.clone(),
                    op: Box::new(op),
                    span: *span,
                }
            }
            SelectItem::Field {
                name,
                expr,
                lift,
                span,
            } => {
                let substituted = map_expr(expr.clone(), &mut subst).map_err(|e| e.message)?;
                if let Some(msg) = failure {
                    return Err(msg);
                }
                let expr = wrap(resolve_expr(&substituted))?;
                if let Some(o) = own {
                    resolved.insert(o.to_string(), expr.clone());
                }
                match expr {
                    Expr::Op(op) => SelectItem::Collect {
                        name: name.clone(),
                        op,
                        span: *span,
                    },
                    expr => SelectItem::Field {
                        name: name.clone(),
                        expr,
                        lift: *lift,
                        span: *span,
                    },
                }
            }
        };
        out.push(item);
    }
    Ok(out)
}

/// Resolve one body's `where` against its `select` (this body only; nested
/// blocks are left as they are). The error is the bare message; the parser
/// adds its offset, [`resolve_aliases`] wraps it as a parse error.
pub fn resolve_where(select: &[SelectItem], r#where: Where) -> std::result::Result<Where, String> {
    if select.is_empty() {
        return Ok(r#where);
    }
    let mut aliases: HashMap<&str, &SelectItem> = HashMap::new();
    for it in select {
        if let Some(n) = alias_name(it) {
            aliases.insert(n, it);
        }
    }
    if aliases.is_empty() {
        return Ok(r#where);
    }
    let mut resolving: Vec<String> = Vec::new();
    walk_where(&aliases, &mut resolving, r#where)
}

fn walk_where(
    aliases: &HashMap<&str, &SelectItem>,
    resolving: &mut Vec<String>,
    w: Where,
) -> std::result::Result<Where, String> {
    Ok(match w {
        Where::And { parts, span } => Where::And {
            parts: parts
                .into_iter()
                .map(|p| walk_where(aliases, resolving, p))
                .collect::<std::result::Result<_, _>>()?,
            span,
        },
        Where::Or { parts, span } => Where::Or {
            parts: parts
                .into_iter()
                .map(|p| walk_where(aliases, resolving, p))
                .collect::<std::result::Result<_, _>>()?,
            span,
        },
        Where::Not { expr, span } => Where::Not {
            expr: Box::new(walk_where(aliases, resolving, *expr)?),
            span,
        },
        Where::Scalar { expr, span } => {
            if let Expr::Ident { name, .. } = &expr {
                if let Some(SelectItem::Collect { op, .. }) = aliases.get(name.as_str()) {
                    // a collection in predicate position: non-empty
                    return Ok(Where::Op(op.clone()));
                }
            }
            Where::Scalar {
                expr: subst(aliases, resolving, expr)?,
                span,
            }
        }
        Where::Op(op) => {
            // the receiver is read in this scope; the block is its own scope
            let mut op = *op;
            op.receiver = subst(aliases, resolving, op.receiver)?;
            Where::Op(Box::new(op))
        }
    })
}

fn subst(
    aliases: &HashMap<&str, &SelectItem>,
    resolving: &mut Vec<String>,
    e: Expr,
) -> std::result::Result<Expr, String> {
    let mut failure: Option<String> = None;
    let out = map_expr(e, &mut |x| {
        let Expr::Ident { name, .. } = &x else {
            return None;
        };
        let a = *aliases.get(name.as_str())?;
        if resolving.last() == Some(name) {
            // its own name inside its own expression: the row field
            return Some(Ok(x));
        }
        if let Some(i) = resolving.iter().position(|r| r == name) {
            let cycle = resolving[i..]
                .iter()
                .map(String::as_str)
                .chain(std::iter::once(name.as_str()))
                .collect::<Vec<_>>()
                .join(" → ");
            failure.get_or_insert(format!(
                "select aliases form a cycle: {cycle} — an alias used in `where` cannot depend on itself"
            ));
            return Some(Ok(x));
        }
        match a {
            SelectItem::Collect { op, .. } => {
                failure.get_or_insert(format!(
                    "select alias '{name}' is a {} {{ … }} block — in `where` it can only stand alone as a non-empty test, not inside an expression",
                    op.op.as_str()
                ));
                Some(Ok(x))
            }
            SelectItem::Field { expr, .. } => {
                resolving.push(name.clone());
                let r = subst(aliases, resolving, expr.clone());
                resolving.pop();
                match r {
                    Ok(e) => Some(Ok(e)),
                    Err(msg) => {
                        failure.get_or_insert(msg);
                        Some(Ok(x))
                    }
                }
            }
        }
    })
    .map_err(|e| e.message)?;
    match failure {
        Some(msg) => Err(msg),
        None => Ok(out),
    }
}
