//! Select-alias resolution (SEMANTICS §14; port of `packages/oqx/src/resolve.ts`).
//! `where` may reference the same body's `select` aliases; the parser keeps the
//! surface form (so the tree can be printed back and reflected on) and only
//! VALIDATES the references, and this module performs the substitution — a
//! pure rewrite the entry points ([`crate::run_query`], [`crate::execute`])
//! apply once before evaluation, so the engine and any pushdown planner see an
//! ordinary `where` over row fields. Rules:
//!   • an alias shadows a same-named row field inside `where`;
//!   • an alias's own name inside its own expression is the row field
//!     (`name: name.upper()` is not recursive), but a chain of aliases that
//!     comes back to one being resolved (`a: b, b: a`) is a cycle → error;
//!   • an alias whose value is a `collect`/`first`/`single { … }` block may
//!     stand alone as a where leaf (a collection in predicate position means
//!     non-empty) but not appear inside an expression;
//!   • nested blocks (consumer bodies, follow blocks) are their own scopes and
//!     are not rewritten against this body's select — each body rewrites
//!     against its own.
//!
//! Resolution is NOT idempotent (`name: name.upper() … where name` resolves to
//! `name.upper()`, whose `name` would be substituted again), so it must run
//! exactly once: the entry points do it, `Engine::run` evaluates the query as
//! given.

use std::collections::HashMap;

use crate::ast::{Expr, Follow, FollowDestination, OpNode, Query, SelectItem, Subquery, Where};
use crate::errors::{OqxError, Result};

/// Resolve every `where` of a query (its own and every nested block's) against
/// the `select` of the same body. Pure. Fails (stage `parse`) for an alias
/// cycle or a block alias used inside an expression — the same conditions the
/// parser rejects, so a parsed query never fails here.
pub fn resolve_aliases(q: &Query) -> Result<Query> {
    let r#where = match &q.r#where {
        None => None,
        Some(w) => Some(resolve_nested_where(
            resolve_where(&q.select, w.clone()).map_err(OqxError::parse)?,
        )?),
    };
    Ok(Query {
        source: q.source.clone(),
        from: q.from.clone(),
        r#where,
        select: resolve_items(&q.select)?,
        order_by: q.order_by.clone(),
        consumer: q.consumer,
        follow: q.follow.as_ref().map(resolve_follow).transpose()?,
        distinct: q.distinct,
        values: q.values,
        limit: q.limit.clone(),
        offset: q.offset.clone(),
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
        from: s.from.clone(),
        r#where,
        select: resolve_items(&s.select)?,
        order_by: s.order_by.clone(),
        follow: s.follow.as_ref().map(resolve_follow).transpose()?,
        values: s.values,
        limit: s.limit.clone(),
        offset: s.offset.clone(),
        span: s.span,
    })
}

fn resolve_op(op: &OpNode) -> Result<OpNode> {
    Ok(OpNode {
        receiver: op.receiver.clone(),
        op: op.op,
        sub: resolve_subquery(&op.sub)?,
        count_cmp: op.count_cmp.clone(),
        distinct: op.distinct,
        span: op.span,
    })
}

fn resolve_items(items: &[SelectItem]) -> Result<Vec<SelectItem>> {
    items
        .iter()
        .map(|it| match it {
            SelectItem::Collect { name, op, span } => Ok(SelectItem::Collect {
                name: name.clone(),
                op: Box::new(resolve_op(op)?),
                span: *span,
            }),
            other => Ok(other.clone()),
        })
        .collect()
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
                other => Ok(other.clone()),
            })
            .collect::<Result<_>>()?,
        distinct: f.distinct,
        r#where: f.r#where.clone(),
        frontier: f.frontier.clone(),
        depth: f.depth,
        by: f.by.clone(),
        span: f.span,
    })
}

// Nested blocks inside a where tree are their own scopes: resolve each against
// its own select.
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
        Where::Scalar { .. } => w,
        Where::Op(op) => Where::Op(Box::new(resolve_op(&op)?)),
    })
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
        match it {
            SelectItem::Collect { name, .. } => {
                aliases.insert(name, it);
            }
            SelectItem::Field { name, lift: 0, .. } if !name.is_empty() => {
                aliases.insert(name, it);
            }
            SelectItem::Field { .. } => {}
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
    let subst_box =
        |resolving: &mut Vec<String>, b: Box<Expr>| -> std::result::Result<Box<Expr>, String> {
            subst(aliases, resolving, *b).map(Box::new)
        };
    Ok(match e {
        Expr::Ident { name, span } => {
            let Some(a) = aliases.get(name.as_str()) else {
                return Ok(Expr::Ident { name, span });
            };
            if resolving.last() == Some(&name) {
                // its own name inside its own expression: the row field
                return Ok(Expr::Ident { name, span });
            }
            if let Some(i) = resolving.iter().position(|r| *r == name) {
                let cycle = resolving[i..]
                    .iter()
                    .map(String::as_str)
                    .chain(std::iter::once(name.as_str()))
                    .collect::<Vec<_>>()
                    .join(" → ");
                return Err(format!(
                    "select aliases form a cycle: {cycle} — an alias used in `where` cannot depend on itself"
                ));
            }
            match a {
                SelectItem::Collect { op, .. } => {
                    return Err(format!(
                        "select alias '{name}' is a {} {{ … }} block — in `where` it can only stand alone as a non-empty test, not inside an expression",
                        op.op.as_str()
                    ));
                }
                SelectItem::Field { expr, .. } => {
                    resolving.push(name);
                    let out = subst(aliases, resolving, expr.clone())?;
                    resolving.pop();
                    out
                }
            }
        }
        Expr::Member { recv, name, span } => Expr::Member {
            recv: subst_box(resolving, recv)?,
            name,
            span,
        },
        Expr::Call {
            recv,
            name,
            args,
            span,
        } => Expr::Call {
            recv: match recv {
                Some(r) => Some(subst_box(resolving, r)?),
                None => None,
            },
            name,
            args: args
                .into_iter()
                .map(|a| subst(aliases, resolving, a))
                .collect::<std::result::Result<_, _>>()?,
            span,
        },
        Expr::Unary { op, expr, span } => Expr::Unary {
            op,
            expr: subst_box(resolving, expr)?,
            span,
        },
        Expr::Binary {
            op,
            left,
            right,
            span,
        } => Expr::Binary {
            op,
            left: subst_box(resolving, left)?,
            right: subst_box(resolving, right)?,
            span,
        },
        Expr::Logical {
            op,
            left,
            right,
            span,
        } => Expr::Logical {
            op,
            left: subst_box(resolving, left)?,
            right: subst_box(resolving, right)?,
            span,
        },
        Expr::In { left, right, span } => Expr::In {
            left: subst_box(resolving, left)?,
            right: subst_box(resolving, right)?,
            span,
        },
        Expr::Range {
            lo,
            hi,
            exclusive_end,
            span,
        } => Expr::Range {
            lo: match lo {
                Some(b) => Some(subst_box(resolving, b)?),
                None => None,
            },
            hi: match hi {
                Some(b) => Some(subst_box(resolving, b)?),
                None => None,
            },
            exclusive_end,
            span,
        },
        // lit, binding, outer (`^name` reads an enclosing row, never an alias)
        other @ (Expr::Lit { .. } | Expr::Binding { .. } | Expr::Outer { .. }) => other,
    })
}
