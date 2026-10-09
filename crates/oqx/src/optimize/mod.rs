//! The optimizer for nested blocks. Port of `packages/oqx/src/optimize/`.
//!
//! A nested block (an [`OpNode`]: `R first { … }`, `R exists { … }`, …) is
//! evaluated once per enclosing row, so a correlated predicate such as
//! `where id == ^customer_id` over a stable receiver makes a query quadratic.
//! The optimizer gives each block a logical [`BlockPlan`] — where its rows come
//! from, which predicates correlate them with the enclosing rows, what remains
//! to be checked per row — and applies [`Rule`]s that move work from the
//! per-row path into the per-run path only when the semantics argument on the
//! rule holds (same rows in the same order, same lifts, same error at the same
//! point). The engine executes the plan and falls back to the plain scan
//! wherever a probe is unavailable at run time.
//!
//! Each rule's precondition and argument are documented on the rule.
//!
//! One difference from the reference: a [`Value`] has no identity, so a
//! receiver is indexed only when it is *statically* stable — it reads nothing
//! from any enclosing row (`^customers` from a top-level block, a `${…}`
//! binding) — whereas the reference also indexes a receiver that happens to
//! evaluate to the same JavaScript object twice.

pub mod hash_index;

use std::rc::Rc;

use crate::ast::{
    BinaryOp, Consumer, Expr, Follow, FollowDestination, OpNode, SelectItem, Subquery, Where,
};
pub use hash_index::{HashIndex, RowIndex, index_key, intersect_positions};

// ---- IR ----------------------------------------------------------------------

/// One hoisted equality `local == outer` from the block's top-level `&&`
/// conjunction: `local` reads only the block's row (an identifier or member
/// chain; `path` is its property path, empty for `$value`), `outer` reads
/// nothing from the block's row and cannot raise.
#[derive(Clone, Debug)]
pub struct Correlation {
    pub local: Expr,
    pub outer: Expr,
    pub path: Vec<String>,
}

/// The plan for one block: the AST node (an owned copy, so a plan has no
/// lifetime and the engine can cache it for a run), its static depth, the
/// split of its `where` into correlated equalities and a residual, and the
/// annotations the rules add.
#[derive(Clone, Debug)]
pub struct BlockPlan {
    pub node: Rc<OpNode>,
    /// Scope depth of the ENCLOSING scope (root = 0): the receiver is read
    /// there; the block's rows are scopes at `depth + 1`.
    pub depth: usize,
    /// Equalities answered by an index probe on the receiver (in conjunct order).
    pub correlated: Vec<Correlation>,
    /// The conjuncts still evaluated per row once the probe has selected its
    /// bucket; equals the block's `where` when nothing is correlated.
    pub residual: Option<Where>,
    /// The receiver reads nothing from any enclosing row, so its rows are the
    /// same for every enclosing row: materialized and indexed once per run.
    pub receiver_stable: bool,
    /// The whole block reads nothing from any enclosing row and has no side
    /// effects on one (no lifts): its value is computed once per run.
    pub invariant: bool,
    /// `exists`/`none`/`count` may be answered from the cardinality of the
    /// accessed rows when no residual predicate remains.
    pub from_cardinality: bool,
}

/// What a rule may consult besides the plan.
#[derive(Clone, Copy, Debug)]
pub struct RuleContext {
    /// How many positional bindings this run has (a `${i}` at or past it
    /// raises when evaluated, so it is not raise-free).
    pub binding_count: usize,
}

/// A rewrite: `Some(improved plan)`, or `None` when the rule does not apply
/// (or has already been applied). Rules are idempotent on their own output.
pub type Rule = fn(&BlockPlan, &RuleContext) -> Option<BlockPlan>;

/// The faithful transcription of a block: a scan with every predicate residual.
pub fn logical_block(node: &OpNode, depth: usize) -> BlockPlan {
    BlockPlan {
        residual: node.sub.r#where.clone(),
        node: Rc::new(node.clone()),
        depth,
        correlated: Vec::new(),
        receiver_stable: false,
        invariant: false,
        from_cardinality: false,
    }
}

/// Rebuild a conjunction from its remaining parts.
fn conjunction(mut parts: Vec<Where>) -> Option<Where> {
    match parts.len() {
        0 => None,
        1 => parts.pop(),
        _ => Some(Where::And { parts }),
    }
}

/// The top-level `&&` conjuncts of a where tree (a non-`and` tree is one).
fn conjuncts(w: &Where) -> Vec<&Where> {
    match w {
        Where::And { parts } => parts.iter().collect(),
        other => vec![other],
    }
}

// ---- driver ------------------------------------------------------------------

const MAX_PASSES: usize = 8;

/// Rewrite [`logical_block`] to a fixpoint of `rules`.
pub fn optimize_block(node: &OpNode, depth: usize, ctx: &RuleContext, rules: &[Rule]) -> BlockPlan {
    let mut plan = logical_block(node, depth);
    for _ in 0..MAX_PASSES {
        let mut changed = false;
        for rule in rules {
            if let Some(next) = rule(&plan, ctx) {
                plan = next;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    plan
}

/// The rules the engine applies by default, in order.
pub const DEFAULT_RULES: &[Rule] = &[
    correlated_equality_probe,
    stable_receiver,
    invariant_block,
    cardinality_only,
];

// ---- rule 1: correlated equality → hash probe ------------------------------------
//
// Precondition. The block has no `from` re-projection (its rows ARE the
// receiver's rows) and no `follow`; its `where` has no lift anywhere (a lift
// into an enclosing scope by one row could change what the outer side reads
// for the next row); some top-level conjunct k is `local == outer` (either
// side) with `local` an identifier/member chain on the block's row and `outer`
// a raise-free expression reading nothing from the block's row; and every
// conjunct left of k is raise-free (no call, no `single`, no lift, no bound, no
// binding past the run's count).
//
// Argument. The scan evaluates, per receiver row r in order, c1(r) && … &&
// ck(r) && …, short-circuiting. The probe selects exactly the rows with
// local(r) == outer (the index reproduces §5 equality, `outer` is evaluated
// once because nothing in the block can change what it reads) and evaluates
// the residual conjunction over them, in receiver order. For a selected row
// every conjunct is evaluated as the scan would (ck is dropped: true by
// construction and, being two reads, unable to raise or bind). For a row the
// probe rejects, the scan would have evaluated c1..c(k-1) — which cannot raise
// or bind — then ck, false, and stopped: no result, no error, no lift. So the
// two paths keep the same rows, raise the same first error, and bind the same
// lifts. A probe that cannot be built at run time (an index whose
// construction fails) falls back to the scan itself.

/// Rule 1 — see the module source for the precondition and argument.
pub fn correlated_equality_probe(plan: &BlockPlan, ctx: &RuleContext) -> Option<BlockPlan> {
    let sub = &plan.node.sub;
    if !plan.correlated.is_empty() || !sub.from.is_empty() || sub.follow.is_some() {
        return None;
    }
    let w = sub.r#where.as_ref()?;
    if where_has_lifts(w) {
        return None;
    }
    let mut correlated = Vec::new();
    let mut residual = Vec::new();
    let mut prefix_raise_free = true;
    for part in conjuncts(w) {
        let eq = if prefix_raise_free {
            as_correlation(part, ctx)
        } else {
            None
        };
        match eq {
            Some(c) => correlated.push(c),
            None => {
                residual.push(part.clone());
                prefix_raise_free = prefix_raise_free && where_raise_free(part, ctx);
            }
        }
    }
    if correlated.is_empty() {
        return None;
    }
    Some(BlockPlan {
        correlated,
        residual: conjunction(residual),
        ..plan.clone()
    })
}

fn as_correlation(w: &Where, ctx: &RuleContext) -> Option<Correlation> {
    let Where::Scalar {
        expr:
            Expr::Binary {
                op: BinaryOp::Eq,
                left,
                right,
            },
    } = w
    else {
        return None;
    };
    pair(left, right, ctx).or_else(|| pair(right, left, ctx))
}

fn pair(local: &Expr, outer: &Expr, ctx: &RuleContext) -> Option<Correlation> {
    let path = local_path(local)?;
    if expr_reads_current_scope(outer) || !expr_raise_free(outer, ctx) {
        return None;
    }
    Some(Correlation {
        local: local.clone(),
        outer: outer.clone(),
        path,
    })
}

// ---- rule 1b: a receiver stable across enclosing rows ----------------------------
//
// Precondition. The receiver expression, read in the enclosing scope (depth
// `plan.depth`), reads no scope at depth 1..=depth: only the root (named
// roots, `^…^name` reaching it, or past it) and bindings.
//
// Argument. Such an expression yields the same value for every enclosing row
// (evaluation is pure; the root and the bindings do not change within a run),
// so its rows can be materialized once per run and indexed once per path.

/// Rule 1b — see the module source.
pub fn stable_receiver(plan: &BlockPlan, _ctx: &RuleContext) -> Option<BlockPlan> {
    if plan.receiver_stable || expr_reads_scope_in(&plan.node.receiver, plan.depth, plan.depth) {
        return None;
    }
    Some(BlockPlan {
        receiver_stable: true,
        ..plan.clone()
    })
}

// ---- rule 2: invariant nested block → evaluate once per run ----------------------
//
// Precondition. Nothing in the block — receiver, `from`, `where`, `select`,
// `order by`, bound, `follow` — reads a scope at depth 1..=depth (an enclosing
// row), and the block lifts nothing (a lift is a side effect on an enclosing
// scope that must recur per row).
//
// Argument. The block's value is a function of the root scope, the bindings
// and its own rows only, all constant within a run, so every evaluation yields
// the same value or raises the same error. The engine evaluates it the first
// time the scan would (so an error surfaces at the same point) and returns the
// memoized value afterwards; a run that raised never reaches a second
// evaluation.

/// Rule 2 — see the module source.
pub fn invariant_block(plan: &BlockPlan, _ctx: &RuleContext) -> Option<BlockPlan> {
    if plan.invariant
        || op_has_lifts(&plan.node)
        || op_reads_scope_in(&plan.node, plan.depth, plan.depth)
    {
        return None;
    }
    Some(BlockPlan {
        invariant: true,
        ..plan.clone()
    })
}

// ---- rule 3: exists / none / count from cardinality -------------------------------
//
// Precondition. A where-position `exists`, `none` or `count` without
// `distinct` (dedup projects every row), without `order by` (`count` evaluates
// the keys), without `follow`, and with nothing left to evaluate per row:
// either the block has no `where`, or every conjunct is correlated.
//
// Argument. With no residual predicate the matched rows are exactly the
// accessed rows (§13), entering a row as a scope cannot raise, and the
// consumers only need the count after the bound (§18). When the probe is
// unavailable at run time the residual is the whole `where` and the engine
// takes the per-row path.

/// Rule 3 — see the module source.
pub fn cardinality_only(plan: &BlockPlan, _ctx: &RuleContext) -> Option<BlockPlan> {
    let node = &plan.node;
    if plan.from_cardinality
        || !matches!(node.op, Consumer::Exists | Consumer::None | Consumer::Count)
        || node.distinct
        || node.sub.order_by.is_some()
        || node.sub.follow.is_some()
        || (node.sub.r#where.is_some() && plan.residual.is_some())
    {
        return None;
    }
    Some(BlockPlan {
        from_cardinality: true,
        ..plan.clone()
    })
}

// ---- analyses ------------------------------------------------------------------
//
// Static (syntactic) answers to three questions about an AST fragment: which
// scopes it READS, by depth (a bare name reads the current scope, `^name`
// exactly `levels` out — §2); whether evaluating it can RAISE (the eval errors
// §23 enumerates: a call, `single` over several rows, an invalid bound,
// `follow` in a where op, a range in a result, a binding out of range —
// property reads are total; a `DataContext::get` that fails is outside this
// model and is caught where the engine relies on it); and whether it has SIDE
// EFFECTS on scopes (a `^name:` lift, §19).

/// Does `e`, evaluated in a scope at depth `at` (root = 0), read any scope
/// whose depth lies in `1..=up_to`? Reads of the root and of scopes deeper
/// than `up_to` (the fragment's own rows) do not count.
pub fn expr_reads_scope_in(e: &Expr, at: usize, up_to: usize) -> bool {
    match e {
        Expr::Lit(_) | Expr::Binding { .. } => false,
        Expr::Ident { .. } => at >= 1 && at <= up_to,
        Expr::Outer { levels, .. } => {
            let d = at.saturating_sub(*levels);
            *levels <= at && d >= 1 && d <= up_to
        }
        Expr::Member { recv, .. } => expr_reads_scope_in(recv, at, up_to),
        Expr::Index { recv, index } => {
            expr_reads_scope_in(recv, at, up_to) || expr_reads_scope_in(index, at, up_to)
        }
        Expr::Call { recv, args, .. } => {
            recv.as_deref()
                .is_some_and(|r| expr_reads_scope_in(r, at, up_to))
                || args.iter().any(|a| expr_reads_scope_in(a, at, up_to))
        }
        Expr::Unary { expr, .. } => expr_reads_scope_in(expr, at, up_to),
        Expr::Binary { left, right, .. }
        | Expr::Logical { left, right, .. }
        | Expr::In { left, right } => {
            expr_reads_scope_in(left, at, up_to) || expr_reads_scope_in(right, at, up_to)
        }
        Expr::Range { lo, hi, .. } => {
            lo.as_deref()
                .is_some_and(|x| expr_reads_scope_in(x, at, up_to))
                || hi
                    .as_deref()
                    .is_some_and(|x| expr_reads_scope_in(x, at, up_to))
        }
    }
}

pub fn where_reads_scope_in(w: &Where, at: usize, up_to: usize) -> bool {
    match w {
        Where::And { parts } | Where::Or { parts } => {
            parts.iter().any(|p| where_reads_scope_in(p, at, up_to))
        }
        Where::Not { expr } => where_reads_scope_in(expr, at, up_to),
        Where::Scalar { expr } => expr_reads_scope_in(expr, at, up_to),
        Where::Op(op) => op_reads_scope_in(op, at, up_to),
    }
}

/// A directive evaluated in a scope at depth `at`: its receiver is read there;
/// its rows are scopes at `at + 1`.
pub fn op_reads_scope_in(op: &OpNode, at: usize, up_to: usize) -> bool {
    expr_reads_scope_in(&op.receiver, at, up_to) || sub_reads_scope_in(&op.sub, at + 1, up_to)
}

fn sub_reads_scope_in(sub: &Subquery, at: usize, up_to: usize) -> bool {
    sub.from.iter().any(|e| expr_reads_scope_in(e, at, up_to))
        || sub
            .r#where
            .as_ref()
            .is_some_and(|w| where_reads_scope_in(w, at, up_to))
        || sub.select.iter().any(|item| match item {
            SelectItem::Field { expr, .. } => expr_reads_scope_in(expr, at, up_to),
            SelectItem::Collect { op, .. } => op_reads_scope_in(op, at, up_to),
        })
        || sub.order_by.as_ref().is_some_and(|specs| {
            specs
                .iter()
                .any(|o| expr_reads_scope_in(&o.expr, at, up_to))
        })
        || sub
            .limit
            .as_ref()
            .is_some_and(|e| expr_reads_scope_in(e, at, up_to))
        || sub
            .offset
            .as_ref()
            .is_some_and(|e| expr_reads_scope_in(e, at, up_to))
        || sub
            .follow
            .as_ref()
            .is_some_and(|f| follow_reads_scope_in(f, at, up_to))
}

fn follow_reads_scope_in(f: &Follow, at: usize, up_to: usize) -> bool {
    f.destinations.iter().any(|d| match d {
        FollowDestination::Relation(e) => expr_reads_scope_in(e, at, up_to),
        FollowDestination::Block(op) => op_reads_scope_in(op, at, up_to),
    }) || f
        .r#where
        .as_ref()
        .is_some_and(|e| expr_reads_scope_in(e, at + 1, up_to))
        || f.frontier
            .as_ref()
            .is_some_and(|e| expr_reads_scope_in(e, at, up_to))
        || f.by
            .as_ref()
            .is_some_and(|e| expr_reads_scope_in(e, at, up_to))
}

/// Does `e` read the scope it is evaluated in (a bare identifier anywhere)?
pub fn expr_reads_current_scope(e: &Expr) -> bool {
    expr_reads_scope_in(e, 1, 1)
}

/// Can evaluating `e` raise? Calls can; a binding at or past the run's count
/// does; nothing else in a scalar expression can (§23).
pub fn expr_raise_free(e: &Expr, ctx: &RuleContext) -> bool {
    match e {
        Expr::Lit(_) | Expr::Ident { .. } | Expr::Outer { .. } => true,
        Expr::Binding { index } => *index < ctx.binding_count,
        Expr::Call { .. } => false,
        Expr::Member { recv, .. } => expr_raise_free(recv, ctx),
        Expr::Index { recv, index } => expr_raise_free(recv, ctx) && expr_raise_free(index, ctx),
        Expr::Unary { expr, .. } => expr_raise_free(expr, ctx),
        Expr::Binary { left, right, .. }
        | Expr::Logical { left, right, .. }
        | Expr::In { left, right } => expr_raise_free(left, ctx) && expr_raise_free(right, ctx),
        Expr::Range { lo, hi, .. } => {
            lo.as_deref().is_none_or(|x| expr_raise_free(x, ctx))
                && hi.as_deref().is_none_or(|x| expr_raise_free(x, ctx))
        }
    }
}

/// Can evaluating `w` raise, or bind a lift?
pub fn where_raise_free(w: &Where, ctx: &RuleContext) -> bool {
    match w {
        Where::And { parts } | Where::Or { parts } => {
            parts.iter().all(|p| where_raise_free(p, ctx))
        }
        Where::Not { expr } => where_raise_free(expr, ctx),
        Where::Scalar { expr } => expr_raise_free(expr, ctx),
        Where::Op(op) => op_raise_free(op, ctx),
    }
}

/// A where-position directive that can neither raise nor bind: `exists`,
/// `none` or `count` (never `single`, which raises on several rows; `collect`
/// binds lifts), without `follow`, bound or `distinct`, whose receiver,
/// `from`, `where` and `order by` are raise-free and which lifts nothing.
pub fn op_raise_free(op: &OpNode, ctx: &RuleContext) -> bool {
    let sub = &op.sub;
    matches!(op.op, Consumer::Exists | Consumer::None | Consumer::Count)
        && sub.follow.is_none()
        && sub.limit.is_none()
        && sub.offset.is_none()
        && !op.distinct
        && expr_raise_free(&op.receiver, ctx)
        && sub.from.iter().all(|e| expr_raise_free(e, ctx))
        && sub
            .r#where
            .as_ref()
            .is_none_or(|w| where_raise_free(w, ctx))
        && sub
            .order_by
            .as_ref()
            .is_none_or(|specs| specs.iter().all(|o| expr_raise_free(&o.expr, ctx)))
        && !op_has_lifts(op)
}

/// Does any `^name:` item occur anywhere inside the directive?
pub fn op_has_lifts(op: &OpNode) -> bool {
    sub_has_lifts(&op.sub)
}

fn sub_has_lifts(sub: &Subquery) -> bool {
    sub.select.iter().any(|item| match item {
        SelectItem::Field { lift, .. } => *lift > 0,
        SelectItem::Collect { op, .. } => op_has_lifts(op),
    }) || sub.r#where.as_ref().is_some_and(where_has_lifts)
        || sub.follow.as_ref().is_some_and(|f| {
            f.destinations
                .iter()
                .any(|d| matches!(d, FollowDestination::Block(op) if op_has_lifts(op)))
        })
}

/// Does any `^name:` item occur inside a directive of this where tree?
pub fn where_has_lifts(w: &Where) -> bool {
    match w {
        Where::And { parts } | Where::Or { parts } => parts.iter().any(where_has_lifts),
        Where::Not { expr } => where_has_lifts(expr),
        Where::Scalar { .. } => false,
        Where::Op(op) => op_has_lifts(op),
    }
}


/// The scope-metadata intrinsics: `$key` (an entry's key) and the `follow`
/// occurrence fields. In a block's row scope these read scope metadata when it
/// is present and fall through to the context otherwise; every other `$`-name
/// (`$id`, `$path`, a context's own intrinsics) is always a plain `get` on the
/// row, so it is a local path like any other property.
pub const SCOPE_INTRINSICS: &[&str] = &["$key", "$depth", "$stop", "$leaf", "$frontier", "$ordinal"];

/// The property path a bare identifier or member chain reads off the current
/// row — `customer_id` → `["customer_id"]`, `meta.id` → `["meta", "id"]`,
/// `$value` → `[]` — or `None` when `e` is not such a chain or starts from a
/// scope intrinsic (`$key`, `$depth`, …).
pub fn local_path(e: &Expr) -> Option<Vec<String>> {
    match e {
        Expr::Ident { name } if name == "$value" => Some(Vec::new()),
        Expr::Ident { name } if SCOPE_INTRINSICS.contains(&name.as_str()) => None,
        Expr::Ident { name } => Some(vec![name.clone()]),
        Expr::Member { recv, name } => {
            let mut path = local_path(recv)?;
            path.push(name.clone());
            Some(path)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse_string;

    fn block(src: &str) -> OpNode {
        // the first select item is the block under test
        let q = parse_string(src).expect("parses");
        match q.select.into_iter().next() {
            Some(SelectItem::Collect { op, .. }) => *op,
            _ => match q.r#where {
                Some(Where::Op(op)) => *op,
                other => panic!("no block in {src}: {other:?}"),
            },
        }
    }

    fn plan(src: &str) -> BlockPlan {
        optimize_block(
            &block(src),
            1,
            &RuleContext { binding_count: 0 },
            DEFAULT_RULES,
        )
    }

    #[test]
    fn hoists_a_correlated_equality_and_keeps_the_residual_in_order() {
        let p = plan("select c: ^cs first { where total > 1 && id == ^cid && !closed } from os");
        assert_eq!(p.correlated.len(), 1);
        assert_eq!(p.correlated[0].path, ["id"]);
        assert!(p.receiver_stable);
        assert!(!p.invariant, "reads ^cid");
        match p.residual {
            Some(Where::And { parts }) => assert_eq!(parts.len(), 2),
            other => panic!("residual should keep two conjuncts: {other:?}"),
        }
    }

    #[test]
    fn a_raising_conjunct_left_of_the_equality_blocks_it() {
        let p = plan("select c: ^cs first { where f(x) && id == ^cid } from os");
        assert!(p.correlated.is_empty());
        let p = plan("select c: ^cs first { where ^^ys exists { limit 1 } && id == ^cid } from os");
        assert!(p.correlated.is_empty(), "a bound can raise");
        let p = plan("select c: ^cs first { where id == ^cid && f(x) } from os");
        assert_eq!(p.correlated.len(), 1, "right of the equality is fine");
    }

    #[test]
    fn the_outer_side_must_not_read_the_row_nor_raise() {
        assert!(
            plan("select c: ^cs first { where a == b } from os")
                .correlated
                .is_empty()
        );
        assert!(
            plan("select c: ^cs first { where id == f(^cid) } from os")
                .correlated
                .is_empty()
        );
        assert_eq!(
            plan("select c: ^cs first { where ^cid == meta.id } from os").correlated[0].path,
            ["meta", "id"]
        );
        assert!(
            plan("select c: ^cs first { where $key == ^cid } from os")
                .correlated
                .is_empty()
        );
        assert_eq!(
            plan("select c: ^cs first { where $value == ^cid } from os").correlated[0].path,
            Vec::<String>::new()
        );
    }

    #[test]
    fn lifts_and_from_and_per_row_receivers_are_respected() {
        assert!(
            plan("select c: ^cs first { where ^^zs collect { ^^^t: x } && id == ^cid } from os")
                .correlated
                .is_empty()
        );
        assert!(
            plan("select c: ^cs first { from lines where id == ^cid } from os")
                .correlated
                .is_empty()
        );
        let p = plan("select c: lines first { where id == ^cid } from os");
        assert_eq!(p.correlated.len(), 1);
        assert!(!p.receiver_stable, "`lines` is the enclosing row's");
    }

    #[test]
    fn invariant_and_cardinality_annotations() {
        let p = plan("select c: ^cs collect { name values } from os");
        assert!(p.invariant && p.receiver_stable);
        assert!(
            !plan("from os where ^cs collect { ^n: name }").invariant,
            "lifts"
        );
        let p = plan("from os where ^cs exists { where id == ^cid }");
        assert!(p.from_cardinality && p.residual.is_none());
        assert!(!plan("from os where ^cs exists { where id == ^cid && !closed }").from_cardinality);
        assert!(plan("from os where ^cs count { } > 2").from_cardinality);
        assert!(!plan("from os where ^cs count distinct { name } > 2").from_cardinality);
    }
}
