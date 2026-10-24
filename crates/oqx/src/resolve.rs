//! Select-alias resolution (SEMANTICS §14; port of `packages/oqx/src/resolve.ts`).
//! A body's `select` names are names of that body's rows for every clause that
//! reads the rows and for the nested blocks under it (since 0.27; through 0.26
//! only `where`, `having` and the items to an item's right saw them): the
//! parser keeps the surface form (so the tree can be printed back and reflected
//! on) and only VALIDATES the references, and this module performs the
//! substitution — a pure rewrite the entry points ([`crate::run_query`],
//! [`crate::execute`]) apply once before evaluation, so the engine and any
//! pushdown planner see ordinary clauses over row fields. Rules:
//!   • an alias shadows a same-named row field in `where`, `having`, `frontier`,
//!     `follow` destinations (a receiver, or the head of a navigation), `flatten`,
//!     `group by` keys, `order by`, and in the items after it; `$it.name` reads
//!     the row's property regardless;
//!   • a nested block reads an enclosing body's alias through an outer reference
//!     (`^name` one scope out, `^^name` two, `N^name` by depth): the alias's
//!     expression is inlined SHIFTED by that many scopes, so what it read on the
//!     enclosing row it still reads there (`^k` with `k: kind` is `^kind`; with
//!     `k: kids { where ok }` it is `^kids { where ok }`);
//!   • an alias's own name inside its own expression is the row field
//!     (`name: name.upper()` is not recursive), but a chain of aliases that
//!     comes back to one being resolved (`a: b, b: a`) is a cycle → error;
//!   • a `select` item — its expression and its nested blocks — may name only the
//!     items to its LEFT; a reference to an item to its right (bare, or `^name`
//!     from a block) is an error (a cycle when that item refers back);
//!   • an alias whose value is a `collect`/`first`/`single`/`count { … }` block
//!     inlines as a value-position directive wherever it is read (`kids.size()`,
//!     `follow kids`, `^kids exists { }`); alone as a `where` leaf it means
//!     "non-empty";
//!   • in a grouped body a `group by` key that is a bare alias name takes the
//!     alias's expression as its key (named by the alias), and that alias's item
//!     then reads the key — so `select kk: kind, n: count() … group by kk` groups
//!     by `kind` and projects it as `kk`;
//!   • `from` (it produces the rows the select reads), `limit`/`offset` (bounds of
//!     the scope, not of a row) and the source are never rewritten.
//!
//! Resolution is NOT idempotent (`name: name.upper() … where name` resolves to
//! `name.upper()`, whose `name` would be substituted again), so it must run
//! exactly once: the entry points do it, `Engine::run` evaluates the query as
//! given.

use std::collections::{HashMap, HashSet};

use crate::ast::{
    Consumer, Expr, Flatten, Follow, FollowDestination, GroupBy, GroupKey, OpNode, OrderSpec,
    Query, SelectItem, Span, Subquery, TemplatePart, Where,
};
use crate::errors::{OqxError, Result};
use crate::value::Value;
use crate::walk::{template_exprs, transform};

/// A resolution failure is the bare message; the parser adds its offset,
/// [`resolve_aliases`] wraps it as a parse error.
type R<T> = std::result::Result<T, String>;

/// One alias's value: the resolved expression (a `collect` item's op), or a
/// marker for an item to the right of the one being resolved — naming it is an
/// error.
#[derive(Clone, Debug)]
pub enum AliasValue {
    Forward,
    Expr(Expr),
}

/// One body's aliases, by name.
pub type AliasEnv = HashMap<String, AliasValue>;
/// The enclosing bodies' aliases, innermost first (`^name` reads `env[0]`).
pub type Scopes<'a> = [&'a AliasEnv];

const EMPTY: &Scopes<'static> = &[];

/// `env` without its innermost scope (what a receiver read one scope out sees).
fn outer_of<'a, 'e>(env: &'e Scopes<'a>) -> &'e Scopes<'a> {
    env.get(1..).unwrap_or(EMPTY)
}

/// Resolve every clause of a query (its own and every nested block's) against
/// the `select` of the same body and of the bodies around it. Pure. Fails
/// (stage `parse`) for an alias cycle, a forward reference, or an outer
/// reference to an alias not yet defined — the same conditions the parser
/// rejects, so a parsed query never fails here.
pub fn resolve_aliases(q: &Query) -> Result<Query> {
    resolve_query(q, EMPTY).map_err(OqxError::parse)
}

/// [`resolve_aliases`] for a block body on its own (no enclosing scopes).
pub fn resolve_subquery(s: &Subquery) -> Result<Subquery> {
    resolve_sub(s, EMPTY).map_err(OqxError::parse)
}

fn resolve_query(q: &Query, env: &Scopes<'_>) -> R<Query> {
    let body = resolve_body(
        BodyRef {
            r#where: q.r#where.as_ref(),
            select: &q.select,
            group_by: q.group_by.as_ref(),
            having: q.having.as_ref(),
            follow: q.follow.as_ref(),
            flatten: &q.flatten,
            from: &q.from,
            order_by: q.order_by.as_deref(),
            limit: q.limit.as_ref(),
            offset: q.offset.as_ref(),
            frontier: q.frontier.as_ref(),
        },
        env,
    )?;
    // The source is read at the enclosing scope: a block over it reads that scope's `^`.
    let source = resolve_nested(&q.source, outer_of(env), env)?;
    Ok(Query {
        source,
        from: body.from,
        r#where: body.r#where,
        select: body.select,
        order_by: body.order_by,
        consumer: q.consumer,
        follow: body.follow,
        frontier: body.frontier,
        flatten: body.flatten,
        group_by: body.group_by,
        having: body.having,
        distinct: q.distinct,
        values: q.values,
        limit: body.limit,
        offset: body.offset,
        span: q.span,
    })
}

fn resolve_sub(s: &Subquery, env: &Scopes<'_>) -> R<Subquery> {
    let body = resolve_body(
        BodyRef {
            r#where: s.r#where.as_ref(),
            select: &s.select,
            group_by: s.group_by.as_ref(),
            having: s.having.as_ref(),
            follow: s.follow.as_ref(),
            flatten: &s.flatten,
            from: &s.from,
            order_by: s.order_by.as_deref(),
            limit: s.limit.as_ref(),
            offset: s.offset.as_ref(),
            frontier: s.frontier.as_ref(),
        },
        env,
    )?;
    Ok(Subquery {
        from: body.from,
        r#where: body.r#where,
        select: body.select,
        order_by: body.order_by,
        follow: body.follow,
        frontier: body.frontier,
        depth: s.depth,
        flatten: body.flatten,
        group_by: body.group_by,
        having: body.having,
        values: s.values,
        limit: body.limit,
        offset: body.offset,
        span: s.span,
    })
}

/// The clauses a `Query` and a `Subquery` share, borrowed.
struct BodyRef<'a> {
    r#where: Option<&'a Where>,
    select: &'a [SelectItem],
    group_by: Option<&'a GroupBy>,
    having: Option<&'a Where>,
    follow: Option<&'a Follow>,
    flatten: &'a [Flatten],
    from: &'a [Expr],
    order_by: Option<&'a [OrderSpec]>,
    limit: Option<&'a Expr>,
    offset: Option<&'a Expr>,
    frontier: Option<&'a Expr>,
}

/// The same clauses, resolved.
struct Body {
    r#where: Option<Where>,
    select: Vec<SelectItem>,
    group_by: Option<GroupBy>,
    having: Option<Where>,
    follow: Option<Follow>,
    flatten: Vec<Flatten>,
    from: Vec<Expr>,
    order_by: Option<Vec<OrderSpec>>,
    limit: Option<Expr>,
    offset: Option<Expr>,
    frontier: Option<Expr>,
}

// The clauses are resolved in the reference's order, so the first failure
// reported is the same one.
fn resolve_body(b: BodyRef<'_>, env: &Scopes<'_>) -> R<Body> {
    // `where` is validated and substituted against the raw select first: its
    // cycle report follows the where's own path (`c → a → b → c`), as pinned.
    let where0 = match b.r#where {
        None => None,
        Some(w) => Some(resolve_where(b.select, w.clone())?),
    };
    let select0 = resolve_select(b.select, env)?;
    // This body's aliases (the resolved values), for its other clauses and for
    // the blocks under it.
    let own = alias_env(&select0);
    let inner = with_inner(&own, env);
    let r#where = match where0 {
        None => None,
        Some(w) => Some(resolve_nested_where(w, env, &inner)?),
    };
    // A grouped body (0.27): a key that is a bare alias name takes the alias's
    // expression, and the alias's item then reads the key — so do the post-group
    // clauses (`having`, `order by`), where that name is the key, not the alias.
    let mut select = select0;
    let mut group_by = b.group_by.cloned();
    let mut having_select: Vec<SelectItem> = b.select.to_vec();
    let mut own_post = own.clone();
    if let Some(g) = b.group_by {
        let (keyed, aliased) = resolve_group_keys(g, &own, env, &inner)?;
        group_by = Some(keyed);
        if !aliased.is_empty() {
            select = read_keys(&select, &aliased);
            having_select = read_keys(b.select, &aliased);
            own_post = without_keys(&own, &aliased);
        }
    }
    let having = match b.having {
        None => None,
        Some(h) => Some(resolve_nested_where(
            resolve_where(&having_select, h.clone())?,
            env,
            &inner,
        )?),
    };
    let follow = match b.follow {
        None => None,
        Some(f) => Some(resolve_follow(f, &own, env, &inner)?),
    };
    let flatten = b
        .flatten
        .iter()
        .map(|f| {
            Ok(Flatten {
                expr: resolve_row_expr(&f.expr, &own, env, &inner)?,
                name: f.name.clone(),
                span: f.span,
            })
        })
        .collect::<R<Vec<_>>>()?;
    // `from` produces the rows the select reads: not rewritten against it (its
    // nested blocks resolve against their own select, outer references included).
    let from = b
        .from
        .iter()
        .map(|e| resolve_nested(e, env, &inner))
        .collect::<R<Vec<_>>>()?;
    let order_by = match b.order_by {
        None => None,
        Some(specs) => Some(
            specs
                .iter()
                .map(|o| {
                    Ok(OrderSpec {
                        expr: resolve_row_expr(&o.expr, &own_post, env, &inner)?,
                        desc: o.desc,
                        span: o.span,
                    })
                })
                .collect::<R<Vec<_>>>()?,
        ),
    };
    // Bounds are the scope's, not a row's: never rewritten against the select.
    let limit = match b.limit {
        None => None,
        Some(e) => Some(resolve_nested(e, env, &inner)?),
    };
    let offset = match b.offset {
        None => None,
        Some(e) => Some(resolve_nested(e, env, &inner)?),
    };
    let frontier = match b.frontier {
        None => None,
        Some(e) => Some(resolve_row_expr(e, &own, env, &inner)?),
    };
    Ok(Body {
        r#where,
        select,
        group_by,
        having,
        follow,
        flatten,
        from,
        order_by,
        limit,
        offset,
        frontier,
    })
}

/// `[own, ...env]`: the scopes a body's nested blocks see.
fn with_inner<'a>(own: &'a AliasEnv, env: &Scopes<'a>) -> Vec<&'a AliasEnv> {
    let mut inner = Vec::with_capacity(env.len() + 1);
    inner.push(own);
    inner.extend_from_slice(env);
    inner
}

/// The items whose names are aliased `group by` keys, rewritten to read the key
/// (`kk: kind` → `kk: kk`); the rest as they are. Exported for the parser: the
/// raw select so rewritten is what `having` resolves against.
pub fn read_keys(items: &[SelectItem], aliased: &HashSet<String>) -> Vec<SelectItem> {
    items
        .iter()
        .map(|it| match it {
            SelectItem::Field {
                name,
                expr,
                lift: 0,
                span,
            } if aliased.contains(name)
                && !matches!(expr, Expr::Ident { name: n, .. } if n == name) =>
            {
                SelectItem::Field {
                    name: name.clone(),
                    expr: Expr::Ident {
                        name: name.clone(),
                        span: expr.span(),
                    },
                    lift: 0,
                    span: *span,
                }
            }
            other => other.clone(),
        })
        .collect()
}

fn without_keys(own: &AliasEnv, aliased: &HashSet<String>) -> AliasEnv {
    own.iter()
        .filter(|(k, _)| !aliased.contains(*k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// The names a body's (resolved) select defines, with their values. A `$`-name
/// is the language's and never an alias here (`$key: id` keys rows, SEMANTICS §16).
fn alias_env(select: &[SelectItem]) -> AliasEnv {
    let mut env = AliasEnv::new();
    for it in select {
        let Some(n) = alias_name(it) else { continue };
        if n.starts_with('$') {
            continue;
        }
        let value = match it {
            SelectItem::Collect { op, .. } => Expr::Op(op.clone()),
            SelectItem::Field { expr, .. } => expr.clone(),
        };
        env.insert(n.to_string(), AliasValue::Expr(value));
    }
    env
}

// `group by` keys read the rows (0.24) — and a key that is a bare alias name is
// that alias (0.27): its expression becomes the key's, named by the alias.
fn resolve_group_keys(
    g: &GroupBy,
    own: &AliasEnv,
    outer: &Scopes<'_>,
    inner: &Scopes<'_>,
) -> R<(GroupBy, HashSet<String>)> {
    let mut aliased: HashSet<String> = HashSet::new();
    let mut keys = Vec::with_capacity(g.keys.len());
    for k in &g.keys {
        if let Expr::Ident { name, .. } = &k.expr
            && k.name == *name
            && let Some(AliasValue::Expr(a)) = own.get(name.as_str())
            && !matches!(a, Expr::Ident { name: n, .. } if *n == k.name)
        {
            aliased.insert(k.name.clone());
            keys.push(GroupKey {
                name: k.name.clone(),
                expr: a.clone(),
                span: k.span,
            });
            continue;
        }
        keys.push(GroupKey {
            name: k.name.clone(),
            expr: resolve_row_expr(&k.expr, own, outer, inner)?,
            span: k.span,
        });
    }
    Ok((GroupBy { keys, span: g.span }, aliased))
}

// `env` is what the op's body sees one scope out (`env[0]` = the body the op is
// written in); the receiver is read in that body, so its own outer references
// reach one scope further.
fn resolve_op(op: &OpNode, env: &Scopes<'_>) -> R<OpNode> {
    Ok(OpNode {
        receiver: resolve_nested(&op.receiver, outer_of(env), env)?,
        op: op.op,
        sub: resolve_sub(&op.sub, env)?,
        count_cmp: op.count_cmp.clone(),
        distinct: op.distinct,
        span: op.span,
    })
}

// A destination is read on the frontier row: a bare alias (or a navigation
// headed by one) is that alias (0.27); a destination block's receiver likewise,
// and its body reads the enclosing aliases through `^`.
fn resolve_follow(f: &Follow, own: &AliasEnv, outer: &Scopes<'_>, inner: &Scopes<'_>) -> R<Follow> {
    Ok(Follow {
        destinations: f
            .destinations
            .iter()
            .map(|d| match d {
                FollowDestination::Block(op) => Ok(FollowDestination::Block(Box::new(OpNode {
                    receiver: resolve_row_expr(&op.receiver, own, outer, inner)?,
                    op: op.op,
                    sub: resolve_sub(&op.sub, inner)?,
                    count_cmp: op.count_cmp.clone(),
                    distinct: op.distinct,
                    span: op.span,
                }))),
                FollowDestination::Relation(e) => Ok(FollowDestination::Relation(
                    resolve_row_expr(e, own, outer, inner)?,
                )),
            })
            .collect::<R<_>>()?,
        distinct: f.distinct,
        span: f.span,
    })
}

// Nested blocks inside a where tree are their own scopes: resolve each against
// its own select (a scalar leaf may hold a value-position directive); an outer
// reference in a leaf reads an enclosing body's alias.
fn resolve_nested_where(w: Where, outer: &Scopes<'_>, inner: &Scopes<'_>) -> R<Where> {
    Ok(match w {
        Where::And { parts, span } => Where::And {
            parts: parts
                .into_iter()
                .map(|p| resolve_nested_where(p, outer, inner))
                .collect::<R<_>>()?,
            span,
        },
        Where::Or { parts, span } => Where::Or {
            parts: parts
                .into_iter()
                .map(|p| resolve_nested_where(p, outer, inner))
                .collect::<R<_>>()?,
            span,
        },
        Where::Not { expr, span } => Where::Not {
            expr: Box::new(resolve_nested_where(*expr, outer, inner)?),
            span,
        },
        Where::Scalar { expr, span } => Where::Scalar {
            expr: resolve_nested(&expr, outer, inner)?,
            span,
        },
        Where::Op(op) => Where::Op(Box::new(resolve_op(&op, inner)?)),
    })
}

const FORWARD_BARE: &str =
    "is used before it is defined — a select item may reference only the items to its left";
const FORWARD_NESTED: &str = "is used before it is defined — a select item (its nested blocks included) may reference only the items to its left";

/// An expression read on this body's rows (`frontier`, `order by`, `flatten`, a
/// key, a destination): a bare identifier naming one of `own` is that alias; then
/// the nested blocks and outer references as [`resolve_nested`].
fn resolve_row_expr(e: &Expr, own: &AliasEnv, outer: &Scopes<'_>, inner: &Scopes<'_>) -> R<Expr> {
    if own.is_empty() {
        return resolve_nested(e, outer, inner);
    }
    // One pass: an alias's value is already resolved, so it is inlined as is
    // (resolution is not idempotent) and the rest resolves as `resolve_nested`.
    map_expr(e.clone(), &mut |x| {
        let Expr::Ident { name, .. } = &x else {
            return nested_hit(&x, outer, inner);
        };
        match own.get(name.as_str())? {
            AliasValue::Forward => Some(Err(format!("select alias '{name}' {FORWARD_BARE}"))),
            AliasValue::Expr(a) => Some(Ok(a.clone())),
        }
    })
}

/// Resolve the nested blocks (value-position directives) inside an expression,
/// each against its own select (their `^` reads `blocks[0]`, the body the
/// expression belongs to), and replace an outer reference at the expression's own
/// level that names an enclosing body's alias (`outer[0]` is one scope out) by
/// that alias's expression, shifted out to where it is read (0.27). The
/// expression's own bare idents are left alone.
fn resolve_nested(e: &Expr, outer: &Scopes<'_>, blocks: &Scopes<'_>) -> R<Expr> {
    map_expr(e.clone(), &mut |x| nested_hit(&x, outer, blocks))
}

// The `map_expr` step of `resolve_nested`: a nested block, or an outer reference
// that names an enclosing body's alias; `None` for anything else.
fn nested_hit(x: &Expr, outer: &Scopes<'_>, blocks: &Scopes<'_>) -> Option<R<Expr>> {
    match x {
        Expr::Op(op) => Some(resolve_op(op, blocks).map(|op| Expr::Op(Box::new(op)))),
        Expr::Outer { levels, name, .. } => {
            let scope = outer.get(levels.checked_sub(1)?)?;
            match scope.get(name.as_str())? {
                AliasValue::Forward => Some(Err(format!("select alias '{name}' {FORWARD_NESTED}"))),
                AliasValue::Expr(a) => Some(Ok(shift_outer(a, *levels))),
            }
        }
        _ => None,
    }
}

/// `expr`, read `levels` scopes further in than where it was written: every
/// reference to the expression's own scope (a bare name — `$it` included — or an
/// outer reference reaching that scope or beyond) gains `levels` carets, while
/// the rows of the blocks inside the expression keep their own names.
pub fn shift_outer(expr: &Expr, levels: usize) -> Expr {
    // A synthetic query around the expression gives the walk the depths: a
    // query's select is read at depth 1 (the expression's own scope), a block
    // under it at depth 2, … (a subquery's select would sit at depth 0 — the op
    // around it supplies the step).
    let zero = Span::new(0, 0);
    let wrapper = Query {
        source: Expr::Lit {
            value: Value::Null,
            span: zero,
        },
        from: Vec::new(),
        r#where: None,
        select: vec![SelectItem::Field {
            name: "x".to_string(),
            expr: expr.clone(),
            lift: 0,
            span: zero,
        }],
        order_by: None,
        consumer: Consumer::Collect,
        follow: None,
        frontier: None,
        flatten: Vec::new(),
        group_by: None,
        having: None,
        distinct: false,
        values: false,
        limit: None,
        offset: None,
        span: zero,
    };
    let mut shifted = transform(&wrapper, &mut |e, ctx| match e {
        Expr::Ident { name, span } if ctx.depth == 1 => Expr::Outer { levels, name, span },
        // An outer reference whose target scope is the expression's scope (depth 1)
        // or outside it: `ctx.depth - e.levels <= 1`.
        Expr::Outer {
            levels: l,
            name,
            span,
        } if ctx.depth <= l + 1 => Expr::Outer {
            levels: l + levels,
            name,
            span,
        },
        other => other,
    });
    match shifted.select.swap_remove(0) {
        SelectItem::Field { expr, .. } => expr,
        SelectItem::Collect { op, .. } => Expr::Op(op),
    }
}

/// Rebuild `e` top-down, letting `f` replace a node (`None` keeps it and
/// descends; a replaced node's children are not visited — `f` owns them).
fn map_expr<F>(e: Expr, f: &mut F) -> R<Expr>
where
    F: FnMut(Expr) -> Option<R<Expr>>,
{
    // `f` takes the node by value; give it a clone to inspect and keep ours when
    // it declines (the common case keeps allocations to the replaced nodes).
    if let Some(hit) = f(e.clone()) {
        return hit;
    }
    let mut go = |x: Box<Expr>| -> R<Box<Expr>> { map_expr(*x, f).map(Box::new) };
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
        Expr::Tuple { items, span } => {
            let mut mapped = Vec::with_capacity(items.len());
            for x in items {
                mapped.push(*go(Box::new(x))?);
            }
            Expr::Tuple {
                items: mapped,
                span,
            }
        }
        Expr::Template { parts, span } => {
            let mut mapped = Vec::with_capacity(parts.len());
            for p in parts {
                mapped.push(match p {
                    TemplatePart::Text(t) => TemplatePart::Text(t),
                    TemplatePart::Expr(x) => TemplatePart::Expr(*go(Box::new(x))?),
                });
            }
            Expr::Template {
                parts: mapped,
                span,
            }
        }
        // An aggregate's argument is read on the group's rows (0.24).
        Expr::Aggregate {
            name,
            arg,
            distinct,
            span,
        } => Expr::Aggregate {
            name,
            arg: match arg {
                Some(a) => Some(go(a)?),
                None => None,
            },
            distinct,
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
            Expr::Tuple { items, .. } => items.iter().for_each(|x| visit(x, own, index, out)),
            Expr::Template { parts, .. } => {
                template_exprs(parts).for_each(|x| visit(x, own, index, out))
            }
            Expr::Aggregate { arg, .. } => {
                if let Some(a) = arg {
                    visit(a, own, index, out);
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

/// Resolve one body's `select` items left to right. An item's bare identifier
/// that names an item to its left is replaced by that item's resolved value — a
/// block alias inlines as a value-position directive — and the item's own name
/// is the row field; the item's nested blocks read the items to its left through
/// `^name` (0.27) and the bodies around through deeper carets (`env`). A
/// reference to an item to its right fails: as a cycle when that item refers
/// back, else as a forward reference. Exported for the parser's validation pass
/// (which passes no enclosing scopes). The error is the bare message; the parser
/// adds its offset, [`resolve_aliases`] wraps it as a parse error.
pub fn resolve_select(select: &[SelectItem], env: &Scopes<'_>) -> R<Vec<SelectItem>> {
    let mut index: HashMap<&str, usize> = HashMap::new();
    for (i, it) in select.iter().enumerate() {
        if let Some(n) = alias_name(it) {
            index.insert(n, i);
        }
    }
    // The items to the right are FORWARD until resolved, so a nested block naming
    // one through `^` is the forward-reference error, not a silent row read.
    let mut resolved = AliasEnv::new();
    for n in index.keys() {
        if !n.starts_with('$') {
            resolved.insert((*n).to_string(), AliasValue::Forward);
        }
    }
    let mut out = Vec::with_capacity(select.len());
    for (i, it) in select.iter().enumerate() {
        let own = alias_name(it);
        // Inside this item's own blocks, its own name is the row field (no entry).
        let mut left = resolved.clone();
        if let Some(o) = own {
            left.remove(o);
        }
        let blocks = with_inner(&left, env);
        // A bare identifier naming a resolved item inlines its (already
        // resolved) value as is; the rest resolves as `resolve_nested`.
        let subst = |e: Expr, resolved: &AliasEnv| -> R<Expr> {
            map_expr(e, &mut |x| {
                let Expr::Ident { name, .. } = &x else {
                    return nested_hit(&x, env, &blocks);
                };
                if Some(name.as_str()) == own {
                    return Some(Ok(x));
                }
                if let Some(AliasValue::Expr(r)) = resolved.get(name.as_str()) {
                    return Some(Ok(r.clone()));
                }
                let j = *index.get(name.as_str())?;
                if j <= i {
                    return None;
                }
                let back = own.and_then(|o| cycle_path(select, &index, j, o));
                Some(Err(match back {
                    Some(back) => format!(
                        "select aliases form a cycle: {} — an alias cannot depend on itself",
                        std::iter::once(own.expect("a cycle has an owner").to_string())
                            .chain(back)
                            .collect::<Vec<_>>()
                            .join(" → ")
                    ),
                    None => format!("select alias '{name}' {FORWARD_BARE}"),
                }))
            })
        };
        let (item, value) = match it {
            SelectItem::Collect { name, op, span } => {
                let receiver = subst(op.receiver.clone(), &resolved)?;
                let op = OpNode {
                    receiver,
                    op: op.op,
                    sub: resolve_sub(&op.sub, &blocks)?,
                    count_cmp: op.count_cmp.clone(),
                    distinct: op.distinct,
                    span: op.span,
                };
                let value = Expr::Op(Box::new(op.clone()));
                (
                    SelectItem::Collect {
                        name: name.clone(),
                        op: Box::new(op),
                        span: *span,
                    },
                    value,
                )
            }
            SelectItem::Field {
                name,
                expr,
                lift,
                span,
            } => {
                let expr = subst(expr.clone(), &resolved)?;
                let value = expr.clone();
                let item = match expr {
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
                };
                (item, value)
            }
        };
        if let Some(o) = own
            && !o.starts_with('$')
        {
            resolved.insert(o.to_string(), AliasValue::Expr(value));
        }
        out.push(item);
    }
    Ok(out)
}

/// Resolve one body's `where` against its `select` (this body only; nested
/// blocks are left as they are). A block alias alone as a leaf is the non-empty
/// test; inside an expression it inlines as a value-position directive (0.27).
/// Exported for the parser's validation pass. The error is the bare message;
/// the parser adds its offset, [`resolve_aliases`] wraps it as a parse error.
pub fn resolve_where(select: &[SelectItem], r#where: Where) -> R<Where> {
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
) -> R<Where> {
    Ok(match w {
        Where::And { parts, span } => Where::And {
            parts: parts
                .into_iter()
                .map(|p| walk_where(aliases, resolving, p))
                .collect::<R<_>>()?,
            span,
        },
        Where::Or { parts, span } => Where::Or {
            parts: parts
                .into_iter()
                .map(|p| walk_where(aliases, resolving, p))
                .collect::<R<_>>()?,
            span,
        },
        Where::Not { expr, span } => Where::Not {
            expr: Box::new(walk_where(aliases, resolving, *expr)?),
            span,
        },
        Where::Scalar { expr, span } => {
            if let Expr::Ident { name, .. } = &expr
                && let Some(SelectItem::Collect { op, .. }) = aliases.get(name.as_str())
            {
                // a collection in predicate position: non-empty
                return Ok(Where::Op(op.clone()));
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

fn subst(aliases: &HashMap<&str, &SelectItem>, resolving: &mut Vec<String>, e: Expr) -> R<Expr> {
    map_expr(e, &mut |x| {
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
            return Some(Err(format!(
                "select aliases form a cycle: {cycle} — an alias used in `where` cannot depend on itself"
            )));
        }
        match a {
            SelectItem::Collect { op, .. } => {
                // The block's receiver may itself name aliases; its body is its own scope.
                resolving.push(name.clone());
                let receiver = subst(aliases, resolving, op.receiver.clone());
                resolving.pop();
                Some(receiver.map(|receiver| {
                    let mut op = op.clone();
                    op.receiver = receiver;
                    Expr::Op(op)
                }))
            }
            SelectItem::Field { expr, .. } => {
                resolving.push(name.clone());
                let r = subst(aliases, resolving, expr.clone());
                resolving.pop();
                Some(r)
            }
        }
    })
}

/// The row-reading clauses of one body resolved against its (resolved) select —
/// what the parser validates aggregates and group reads over (0.27).
pub struct RowClauses {
    pub frontier: Option<Expr>,
    pub flatten: Vec<Flatten>,
    pub group_by: Option<GroupBy>,
    pub order_by: Option<Vec<OrderSpec>>,
    /// The select with the items naming aliased keys reading the key (`kk: kk`).
    pub select: Vec<SelectItem>,
    /// The `group by` keys that took an alias's expression.
    pub aliased_keys: HashSet<String>,
}

/// [`RowClauses`] for a body's `frontier`, `flatten`, `group by` and `order by`
/// (`select` is the body's resolved select). Exported for the parser's
/// validation pass; the error is the bare message.
pub fn resolve_row_clauses(
    select: &[SelectItem],
    frontier: Option<&Expr>,
    flatten: &[Flatten],
    group_by: Option<&GroupBy>,
    order_by: Option<&[OrderSpec]>,
) -> R<RowClauses> {
    let own = alias_env(select);
    let outer: &Scopes<'_> = EMPTY;
    let inner: Vec<&AliasEnv> = vec![&own];
    let frontier = match frontier {
        None => None,
        Some(e) => Some(resolve_row_expr(e, &own, outer, &inner)?),
    };
    let flatten = flatten
        .iter()
        .map(|f| {
            Ok(Flatten {
                expr: resolve_row_expr(&f.expr, &own, outer, &inner)?,
                name: f.name.clone(),
                span: f.span,
            })
        })
        .collect::<R<Vec<_>>>()?;
    let mut keyed = None;
    let mut aliased_keys: HashSet<String> = HashSet::new();
    let mut items = select.to_vec();
    let mut own_post = own.clone();
    if let Some(g) = group_by {
        let (g, aliased) = resolve_group_keys(g, &own, outer, &inner)?;
        keyed = Some(g);
        if !aliased.is_empty() {
            items = read_keys(&items, &aliased);
            own_post = without_keys(&own, &aliased);
        }
        aliased_keys = aliased;
    }
    // `order by` of a grouped body reads the group: an aliased key's name is the key.
    let order_by = match order_by {
        None => None,
        Some(specs) => Some(
            specs
                .iter()
                .map(|o| {
                    Ok(OrderSpec {
                        expr: resolve_row_expr(&o.expr, &own_post, outer, &inner)?,
                        desc: o.desc,
                        span: o.span,
                    })
                })
                .collect::<R<Vec<_>>>()?,
        ),
    };
    Ok(RowClauses {
        frontier,
        flatten,
        group_by: keyed,
        order_by,
        select: items,
        aliased_keys,
    })
}
